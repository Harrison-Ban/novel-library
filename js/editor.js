// txt 편집: 쓰기, 찾아 바꾸기(모두 바꾸기), 빈 줄 제거, 저장(원본 덮어쓰기)
// 10MB 파일도 매끄럽도록 보이는 줄만 그리는 CodeMirror 6를 쓰고, 편집할 때만 불러온다.
// 저장은 UTF-8(BOM)로 원본에 덮어쓰며, 이전 내용은 OneDrive 버전 기록으로 되돌릴 수 있다.
// 연 뒤 다른 곳에서 파일이 바뀌었으면 덮어쓰지 않고 새 파일로 저장할지 묻는다.
import { overwriteText, uploadText, listChildren, isNameConflict } from './graph.js';
import { getLibrary, update } from './library.js';
import { ops, fileTags } from './model.js';
import { state, toast, sheet, errorMessage } from './state.js';
import { parentFolderOf } from './scan.js';
import { showProgress, logEntries, commitScan, uniqueName, folderNameOf } from './fileops.js';
import { h } from './ui.js';

let cmLoading = null;
function loadCodeMirror() {
  cmLoading ??= import('../vendor/codemirror.min.js').catch((e) => {
    cmLoading = null;
    throw e;
  });
  return cmLoading;
}

// 빈 줄: 아무것도 없거나 공백만 있는 줄. JS의 \s는 일반 공백·탭·전각 공백(U+3000)·
// 줄바꿈 없는 공백(U+00A0)·BOM(U+FEFF)·\r까지 포함한다.
const BLANK_LINE = /^\s*$/;

export function removeBlankLines(text) {
  const endsWithNewline = text.endsWith('\n');
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const kept = lines.filter((line) => !BLANK_LINE.test(line));
  return {
    text: kept.join('\n') + (endsWithNewline && kept.length ? '\n' : ''),
    removed: lines.length - kept.length,
  };
}

export function countMatches(text, query) {
  if (!query) return 0;
  let n = 0;
  for (let i = text.indexOf(query); i !== -1; i = text.indexOf(query, i + query.length)) n++;
  return n;
}

// file: 서재의 파일 정보, text: 불러온 본문, eTag: 열 때의 파일 버전,
// look: { fontSize, lineHeight, dark }, onSaved(newText): 저장 뒤 뷰어 갱신
export async function openEditor({ file, text, eTag, look, onSaved, onClose }) {
  showProgress('편집기를 여는 중…');
  let cm;
  try {
    cm = await loadCodeMirror();
  } catch (e) {
    toast(`편집기를 불러오지 못했습니다: ${errorMessage(e)}`);
    return;
  } finally {
    showProgress('');
  }
  const { EditorView, EditorState, EditorSelection, keymap, defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth } = cm;

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let dirty = false;
  let closed = false;
  let currentETag = eTag;

  const undoBtn = h('button', { type: 'button', class: 'reader-btn', 'aria-label': '되돌리기', onclick: () => run(undo) }, '↶');
  const redoBtn = h('button', { type: 'button', class: 'reader-btn', 'aria-label': '다시하기', onclick: () => run(redo) }, '↷');
  const saveBtn = h('button', { type: 'button', class: 'reader-btn editor-save', onclick: save }, '저장');

  const findInput = h('input', { type: 'search', class: 'find-input', placeholder: '찾을 말', 'aria-label': '찾을 말', oninput: refreshCount,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(); } } });
  const replaceInput = h('input', { type: 'text', class: 'find-input', placeholder: '바꿀 말', 'aria-label': '바꿀 말',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceAll(); } } });
  const countEl = h('span', { class: 'find-count' });
  const replaceBar = h('div', { class: 'find-bar replace-bar', hidden: true },
    h('div', { class: 'replace-fields' }, findInput, replaceInput),
    countEl,
    h('button', { type: 'button', class: 'reader-btn', onclick: findNext }, '다음'),
    h('button', { type: 'button', class: 'reader-btn editor-strong', onclick: replaceAll }, '모두 바꾸기'),
    h('button', { type: 'button', class: 'reader-btn', 'aria-label': '바꾸기 닫기', onclick: () => toggleReplace(false) }, '✕'),
  );
  const host = h('div', { class: 'editor-host' });
  const root = h('div', { class: 'editor', role: 'dialog', 'aria-label': `${file.name} 편집`, 'data-theme': look.dark ? 'dark' : 'light' },
    h('header', { class: 'reader-bar' },
      h('button', { type: 'button', class: 'reader-btn reader-back', onclick: close }, '✕ 닫기'),
      h('div', { class: 'reader-title' }, `✏ ${file.name}`),
      h('div', { class: 'reader-tools' },
        undoBtn,
        redoBtn,
        h('button', { type: 'button', class: 'reader-btn', onclick: () => toggleReplace() }, '바꾸기'),
        h('button', { type: 'button', class: 'reader-btn', onclick: blankLines }, '빈 줄 제거'),
        saveBtn,
      ),
    ),
    replaceBar,
    host,
  );

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        keymap.of([
          { key: 'Mod-s', run: () => (save(), true) },
          { key: 'Mod-f', run: () => (toggleReplace(true), true) },
          { key: 'Mod-h', run: () => (toggleReplace(true), true) },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', lang: 'ko' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            dirty = true;
            if (!replaceBar.hidden) scheduleCount();
          }
          if (u.docChanged || u.transactions.length) refreshButtons();
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: `${look.fontSize}px` },
          '.cm-scroller': { overflow: 'auto', lineHeight: String(look.lineHeight), fontFamily: 'inherit' },
          '.cm-content': { padding: '16px 0 40vh' },
          '.cm-line': { padding: '0 20px' },
        }, { dark: look.dark }),
      ],
    }),
  });

  function run(command) {
    command(view);
    view.focus();
  }

  function refreshButtons() {
    undoBtn.disabled = undoDepth(view.state) === 0;
    redoBtn.disabled = redoDepth(view.state) === 0;
    saveBtn.classList.toggle('dirty', dirty);
  }

  const docText = () => view.state.doc.toString();

  // 전체 글을 한 번에 바꾼다 (되돌리기 한 번으로 취소된다)
  function replaceDoc(next) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, scrollIntoView: false });
  }

  // ---------- 찾아 바꾸기 ----------

  function toggleReplace(open = replaceBar.hidden) {
    replaceBar.hidden = !open;
    if (open) {
      const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
      if (sel && !sel.includes('\n') && sel.length < 100) findInput.value = sel;
      findInput.focus();
      findInput.select();
      refreshCount();
    } else view.focus();
  }

  let countTimer = null;
  function scheduleCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(refreshCount, 300);
  }

  function refreshCount() {
    const q = findInput.value;
    countEl.textContent = q ? `${countMatches(docText(), q)}건` : '';
  }

  function findNext() {
    const q = findInput.value;
    if (!q) return;
    const text = docText();
    let at = text.indexOf(q, view.state.selection.main.to);
    if (at === -1) at = text.indexOf(q);
    if (at === -1) {
      toast(`'${q}'을(를) 찾지 못했습니다`);
      return;
    }
    view.dispatch({ selection: EditorSelection.single(at, at + q.length), scrollIntoView: true });
  }

  async function replaceAll() {
    const q = findInput.value;
    const r = replaceInput.value;
    if (!q) {
      toast('찾을 말을 입력하세요');
      return;
    }
    const text = docText();
    const n = countMatches(text, q);
    if (!n) {
      toast(`'${q}'이(가) 없습니다`);
      return;
    }
    const ok = await sheet('모두 바꾸기', h('p', {},
      `'${q}' ${n.toLocaleString()}건을 ${r ? `'${r}'(으)로` : '지움(빈 칸)으로'} 바꿉니다. 저장하기 전까지 ↶로 되돌릴 수 있습니다.`,
    ), [{ label: `${n.toLocaleString()}건 바꾸기`, class: 'primary', value: () => true }, { label: '취소' }]);
    if (!ok) return;
    replaceDoc(text.replaceAll(q, r));
    refreshCount();
    toast(`${n.toLocaleString()}건을 바꿨습니다`);
  }

  // ---------- 빈 줄 제거 ----------

  async function blankLines() {
    const result = removeBlankLines(docText());
    if (!result.removed) {
      toast('지울 빈 줄이 없습니다');
      return;
    }
    const ok = await sheet('빈 줄 제거', h('p', {},
      `아무것도 없거나 공백(스페이스·탭·전각 공백)만 있는 줄 ${result.removed.toLocaleString()}개를 지웁니다. 저장하기 전까지 ↶로 되돌릴 수 있습니다.`,
    ), [{ label: `${result.removed.toLocaleString()}줄 지우기`, class: 'primary', value: () => true }, { label: '취소' }]);
    if (!ok) return;
    replaceDoc(result.text);
    toast(`빈 줄 ${result.removed.toLocaleString()}개를 지웠습니다`);
  }

  // ---------- 저장 ----------

  function encode(content) {
    return new Blob(['﻿', eol === '\n' ? content : content.replace(/\n/g, eol)], { type: 'text/plain;charset=utf-8' });
  }

  function afterSaved(content, item) {
    Object.assign(file, { size: item.size ?? file.size, modified: item.lastModifiedDateTime ?? new Date().toISOString() });
    commitScan();
    dirty = false;
    refreshButtons();
    onSaved?.(content);
  }

  async function save() {
    if (!dirty) {
      toast('바뀐 내용이 없습니다');
      return;
    }
    const ok = await sheet('저장 (원본에 덮어쓰기)', h('div', {},
      h('p', {}, `'${file.name}'에 덮어씁니다. 글자는 UTF-8로 저장됩니다.`),
      h('p', { class: 'muted small' }, '이전 내용은 OneDrive 웹에서 파일의 "버전 기록"으로 되돌릴 수 있습니다.'),
    ), [{ label: '저장', class: 'primary', value: () => true }, { label: '취소' }]);
    if (!ok) return;
    const content = docText();
    showProgress('저장 중…');
    try {
      const item = await overwriteText(file.id, encode(content), currentETag);
      currentETag = item.eTag ?? currentETag;
      logEntries([{ action: 'edit', name: file.name, detail: `편집 내용 저장 (${folderNameOf(parentFolderOf(file, state.root.id))})` }]);
      afterSaved(content, item);
      toast('저장했습니다');
    } catch (e) {
      showProgress('');
      if (e.status === 412) await saveAsNewFile(content);
      else toast(`저장하지 못했습니다: ${errorMessage(e)}`);
    } finally {
      showProgress('');
    }
  }

  // 연 뒤에 다른 기기 등에서 원본이 바뀐 경우: 덮어쓰지 않고 새 파일로
  async function saveAsNewFile(content) {
    const choice = await sheet('원본이 그사이 바뀌었습니다', h('p', {},
      '다른 기기나 OneDrive에서 이 파일이 바뀌어 덮어쓰지 않았습니다. 편집한 내용을 새 파일로 저장할까요?',
    ), [{ label: '새 파일로 저장', class: 'primary', value: () => true }, { label: '취소 (계속 편집)' }]);
    if (!choice) return;
    const parentId = parentFolderOf(file, state.root.id);
    showProgress('새 파일로 저장 중…');
    try {
      const taken = new Set((await listChildren(parentId)).map((c) => c.name.toLocaleLowerCase()));
      const base = file.name.replace(/\.txt$/i, '');
      let name = `${base} (수정).txt`;
      if (taken.has(name.toLocaleLowerCase())) name = uniqueName(name, taken);
      const item = await uploadText(parentId, name, encode(content));
      state.scan?.files.push({ id: item.id, name: item.name, size: item.size ?? 0, modified: item.lastModifiedDateTime ?? new Date().toISOString(), folderId: file.folderId, parentId, path: file.path ?? '' });
      commitScan();
      const tags = fileTags(getLibrary(), file.id);
      if (tags.length) update(ops.tag([item.id], tags));
      logEntries([{ action: 'edit', name: item.name, detail: `'${file.name}' 편집 내용을 새 파일로 저장` }]);
      dirty = false;
      refreshButtons();
      toast(`'${item.name}'(으)로 저장했습니다`);
    } catch (e) {
      toast(`저장하지 못했습니다: ${isNameConflict(e) ? '같은 이름이 있습니다' : errorMessage(e)}`);
    } finally {
      showProgress('');
    }
  }

  // ---------- 닫기 ----------

  async function close() {
    if (closed) return;
    if (dirty) {
      const discard = await sheet('저장하지 않은 변경이 있습니다', h('p', {}, '닫으면 편집한 내용이 사라집니다.'), [
        { label: '저장하고 닫기', class: 'primary', value: () => 'save' },
        { label: '버리고 닫기', class: 'danger', value: () => 'discard' },
        { label: '계속 편집' },
      ]);
      if (discard === 'save') {
        await save();
        if (dirty) return;
      } else if (discard !== 'discard') return;
    }
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    view.destroy();
    root.remove();
    onClose?.();
  }

  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!replaceBar.hidden) toggleReplace(false);
      else close();
    }
  }
  document.addEventListener('keydown', onKey, true);

  document.body.append(root);
  refreshButtons();
  view.focus();
  return { close };
}
