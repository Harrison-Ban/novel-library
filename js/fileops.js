// 실제 OneDrive 파일·폴더를 바꾸는 작업 (F10~F13)
// 원칙: 확인 후 실행, 덮어쓰기 없음(같은 이름이면 (1) 붙이기 또는 건너뛰기), 삭제는 휴지통으로만.
import { listChildren, moveItem, renameItem, createFolder, deleteItem, getFolderInfo, isNameConflict } from './graph.js';
import { update } from './library.js';
import { saveCache } from './scan.js';
import { ops } from './model.js';
import { state, toast, sheet, errorMessage } from './state.js';
import { h, formatSize } from './ui.js';

// ---------- 공통 ----------

export function showProgress(text) {
  const el = document.getElementById('progress');
  el.textContent = text;
  el.hidden = !text;
}

function logEntries(entries) {
  if (entries.length) update(ops.log(entries.map((e) => ({ at: new Date().toISOString(), ...e }))));
}

function commitScan() {
  if (state.scan) saveCache(state.scan);
}

const lower = (s) => s.toLocaleLowerCase();

// "이름 (1).txt", "이름 (2).txt" … 중 비어 있는 이름
export function uniqueName(name, taken) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(lower(candidate))) return candidate;
  }
}

// 폴더 ID → 보드의 칸 키 (루트=null, 1단계 하위 폴더=ID, 그 밖=undefined)
function scanFolderKey(folderId) {
  if (folderId === state.root.id) return null;
  if (state.scan?.folders.some((f) => f.id === folderId)) return folderId;
  return undefined;
}

export function folderNameOf(folderId) {
  if (folderId === state.root.id) return `${state.root.name} (루트)`;
  return state.scan?.folders.find((f) => f.id === folderId)?.name ?? '폴더';
}

const parentOf = (f) => f.folderId ?? state.root.id;

// 같은 이름이 있을 때 어떻게 할지 묻는다. 결과: { choice: 'number' | 'skip', all }
async function askConflict(name, remaining) {
  const all = h('input', { type: 'checkbox' });
  const body = h('div', {},
    h('p', {}, `'${name}'과(와) 같은 이름의 항목이 이미 있습니다. 덮어쓰지 않습니다.`),
    remaining > 0 && h('label', { class: 'check' }, all, `남은 ${remaining}개에도 같은 선택 적용`),
  );
  const choice = await sheet('같은 이름이 있습니다', body, [
    { label: '뒤에 (1) 붙이기', class: 'primary', value: () => 'number' },
    { label: '건너뛰기', value: () => 'skip' },
  ]);
  return { choice: choice ?? 'skip', all: all.checked };
}

function summary(verb, done, skipped, failed) {
  const parts = [`${done}개 ${verb}`];
  if (skipped) parts.push(`${skipped}개 건너뜀`);
  if (failed.length) parts.push(`${failed.length}개 실패`);
  toast(parts.join(' · '));
  if (failed.length) console.warn('실패한 항목', failed);
}

// ---------- 이동 (F10·F12) ----------

// items: [{ id, name, folderId? }] — folderId가 없으면 parentId로 원래 위치를 받는다
export async function moveItems(items, target, { confirmFirst = true } = {}) {
  const moving = items.filter((f) => (f.parentId ?? parentOf(f)) !== target.id);
  if (!moving.length) {
    toast('이미 그 폴더에 있습니다');
    return 0;
  }
  if (confirmFirst) {
    const size = moving.reduce((s, f) => s + (f.size ?? 0), 0);
    const ok = await sheet('파일 이동', h('div', {},
      h('p', {}, `${moving.length}개 항목을 '${target.name}'(으)로 옮깁니다.${size ? ` (${formatSize(size)})` : ''}`),
      fileList(moving),
    ), [{ label: '이동', class: 'primary', value: () => true }, { label: '취소' }]);
    if (!ok) return 0;
  }

  showProgress('대상 폴더 확인 중…');
  let taken;
  try {
    taken = new Set((await listChildren(target.id)).map((c) => lower(c.name)));
  } catch (e) {
    showProgress('');
    toast(`이동하지 못했습니다: ${errorMessage(e)}`);
    return 0;
  }

  let policy = null;
  let done = 0;
  let skipped = 0;
  const failed = [];
  const log = [];
  const targetKey = scanFolderKey(target.id);
  for (const [i, f] of moving.entries()) {
    showProgress(`이동 중 ${i + 1}/${moving.length}`);
    let name = f.name;
    if (taken.has(lower(name))) {
      let decision = policy;
      if (!decision) {
        showProgress('');
        const answer = await askConflict(name, moving.length - i - 1);
        decision = answer.choice;
        if (answer.all) policy = decision;
      }
      if (decision === 'skip') {
        skipped++;
        continue;
      }
      name = uniqueName(name, taken);
    }
    try {
      await moveItem(f.id, target.id, name !== f.name ? name : undefined);
      taken.add(lower(name));
      done++;
      log.push({ action: 'move', name, detail: `${f.fromName ?? folderNameOf(f.parentId ?? parentOf(f))} → ${target.name}` });
      const file = state.scan?.files.find((x) => x.id === f.id);
      if (file) {
        if (targetKey === undefined) state.scan.files = state.scan.files.filter((x) => x.id !== f.id);
        else Object.assign(file, { folderId: targetKey, name });
      }
    } catch (e) {
      failed.push({ name: f.name, error: isNameConflict(e) ? '같은 이름' : errorMessage(e) });
    }
  }
  showProgress('');
  commitScan();
  logEntries(log);
  summary('이동', done, skipped, failed);
  return done;
}

function fileList(files) {
  return h('ul', { class: 'confirm-list' }, ...files.map((f) => h('li', {}, f.name, f.size != null && h('span', { class: 'muted small' }, ` ${formatSize(f.size)}`))));
}

// ---------- 이름 변경 (F12) ----------

export async function renameFile(f) {
  const name = prompt('새 파일 이름', f.name)?.trim();
  if (!name || name === f.name) return false;
  if (/[\\/:*?"<>|]/.test(name)) {
    toast('이름에 \\ / : * ? " < > | 는 쓸 수 없습니다');
    return false;
  }
  showProgress('이름 바꾸는 중…');
  try {
    const taken = new Set((await listChildren(parentOf(f))).filter((c) => c.id !== f.id).map((c) => lower(c.name)));
    let finalName = name;
    if (taken.has(lower(name))) {
      showProgress('');
      const { choice } = await askConflict(name, 0);
      if (choice === 'skip') return false;
      finalName = uniqueName(name, taken);
      showProgress('이름 바꾸는 중…');
    }
    await renameItem(f.id, finalName);
    logEntries([{ action: 'rename', name: finalName, detail: `${f.name} → ${finalName}` }]);
    const file = state.scan?.files.find((x) => x.id === f.id);
    if (file) file.name = finalName;
    commitScan();
    toast('이름을 바꿨습니다');
    return true;
  } catch (e) {
    toast(`이름을 바꾸지 못했습니다: ${isNameConflict(e) ? '같은 이름이 있습니다' : errorMessage(e)}`);
    return false;
  } finally {
    showProgress('');
  }
}

// ---------- 삭제: 휴지통으로 (F12·F13) ----------

export async function trashFiles(files, title = '휴지통으로 보내기') {
  if (!files.length) return 0;
  const size = files.reduce((s, f) => s + f.size, 0);
  const ok = await sheet(title, h('div', {},
    h('p', {}, `${files.length}개 · ${formatSize(size)}을(를) OneDrive 휴지통으로 보냅니다. 휴지통에서 복원할 수 있습니다.`),
    fileList(files),
  ), [{ label: `${files.length}개 휴지통으로`, class: 'primary danger-fill', value: () => true }, { label: '취소' }]);
  if (!ok) return 0;

  const removed = [];
  const failed = [];
  for (const [i, f] of files.entries()) {
    showProgress(`휴지통으로 보내는 중 ${i + 1}/${files.length}`);
    try {
      await deleteItem(f.id);
      removed.push(f);
    } catch (e) {
      if (e.status === 404) removed.push(f); // 이미 없음
      else failed.push({ name: f.name, error: errorMessage(e) });
    }
  }
  showProgress('');
  const ids = new Set(removed.map((f) => f.id));
  if (state.scan) state.scan.files = state.scan.files.filter((f) => !ids.has(f.id));
  commitScan();
  update(ops.forgetFiles([...ids]));
  logEntries(removed.map((f) => ({ action: 'delete', name: f.name, detail: `${folderNameOf(parentOf(f))}에서 휴지통으로` })));
  summary('휴지통으로 보냄', removed.length, 0, failed);
  return removed.length;
}

// ---------- 폴더 관리 (F11) ----------

const validFolderName = (name) => name && !/[\\/:*?"<>|]/.test(name) && !/^\.+$/.test(name);

export async function addFolder() {
  const name = prompt('새 폴더(장르) 이름')?.trim();
  if (!name) return false;
  if (!validFolderName(name)) {
    toast('이름에 \\ / : * ? " < > | 는 쓸 수 없습니다');
    return false;
  }
  showProgress('폴더 만드는 중…');
  try {
    const folder = await createFolder(state.root.id, name);
    state.scan?.folders.push({ id: folder.id, name: folder.name });
    state.scan?.folders.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    commitScan();
    logEntries([{ action: 'mkdir', name: folder.name, detail: `${state.root.name}에 폴더 생성` }]);
    toast(`'${folder.name}' 폴더를 만들었습니다`);
    return true;
  } catch (e) {
    toast(isNameConflict(e) ? '같은 이름의 폴더나 파일이 이미 있습니다' : `폴더를 만들지 못했습니다: ${errorMessage(e)}`);
    return false;
  } finally {
    showProgress('');
  }
}

export async function renameFolder(folder, name) {
  name = name.trim();
  if (!name || name === folder.name) return false;
  if (!validFolderName(name)) {
    toast('이름에 \\ / : * ? " < > | 는 쓸 수 없습니다');
    return false;
  }
  if (!confirm(`OneDrive 폴더 '${folder.name}'의 이름을 '${name}'(으)로 바꿀까요?`)) return false;
  showProgress('폴더 이름 바꾸는 중…');
  try {
    await renameItem(folder.key, name);
    const f = state.scan?.folders.find((x) => x.id === folder.key);
    if (f) f.name = name;
    commitScan();
    logEntries([{ action: 'rename', name, detail: `폴더 ${folder.name} → ${name}` }]);
    toast('폴더 이름을 바꿨습니다');
    return true;
  } catch (e) {
    toast(isNameConflict(e) ? '같은 이름의 폴더나 파일이 이미 있습니다' : `이름을 바꾸지 못했습니다: ${errorMessage(e)}`);
    return false;
  } finally {
    showProgress('');
  }
}

// 빈 폴더만 휴지통으로. 비어 있지 않으면 안의 항목을 옮길 칸을 먼저 고른다.
export async function removeFolder(folder) {
  showProgress('폴더 확인 중…');
  let children;
  try {
    children = await listChildren(folder.key);
  } catch (e) {
    showProgress('');
    toast(`폴더를 확인하지 못했습니다: ${errorMessage(e)}`);
    return false;
  }
  showProgress('');

  if (children.length) {
    const targets = [
      { id: state.root.id, name: `${state.root.name} (루트, 미분류)` },
      ...(state.scan?.folders ?? []).filter((f) => f.id !== folder.key).map((f) => ({ id: f.id, name: f.name })),
    ];
    const target = await sheet(`'${folder.name}' 폴더가 비어 있지 않습니다`, h('p', {},
      `안에 항목 ${children.length}개가 있습니다. 어느 칸으로 옮긴 뒤 폴더를 삭제할까요?`,
    ), [...targets.map((t) => ({ label: t.name, value: () => t })), { label: '취소' }]);
    if (!target) return false;
    const items = children.map((c) => ({ id: c.id, name: c.name, size: c.size, parentId: folder.key, fromName: folder.name }));
    await moveItems(items, target);
  }

  let info;
  try {
    info = await getFolderInfo(folder.key);
  } catch (e) {
    toast(`폴더를 확인하지 못했습니다: ${errorMessage(e)}`);
    return false;
  }
  if ((info.folder?.childCount ?? 0) > 0) {
    toast('폴더가 아직 비어 있지 않아 삭제하지 않았습니다');
    return false;
  }
  if (!children.length && !confirm(`빈 폴더 '${folder.name}'을(를) OneDrive 휴지통으로 보낼까요?`)) return false;
  showProgress('폴더 삭제 중…');
  try {
    await deleteItem(folder.key);
    if (state.scan) state.scan.folders = state.scan.folders.filter((f) => f.id !== folder.key);
    commitScan();
    logEntries([{ action: 'rmdir', name: folder.name, detail: '빈 폴더를 휴지통으로' }]);
    toast(`'${folder.name}' 폴더를 휴지통으로 보냈습니다`);
    return true;
  } catch (e) {
    toast(`폴더를 삭제하지 못했습니다: ${errorMessage(e)}`);
    return false;
  } finally {
    showProgress('');
  }
}

// ---------- 아무 폴더 고르기 (다른 폴더로 이동) ----------

export function pickFolder(title) {
  return new Promise((resolve) => {
    let stack = [{ id: 'root', name: '내 파일' }, { id: state.root.id, name: state.root.name }];
    let result = null;
    const body = h('div', { class: 'picker-body' });
    const chooseBtn = h('button', { type: 'button', class: 'primary', onclick: () => {
      const cur = stack[stack.length - 1];
      result = cur;
      dlg.close();
    } }, '이 폴더로');
    const dlg = h('dialog', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', {}, title)),
      h('div', { class: 'sheet-body' }, body),
      h('div', { class: 'sheet-actions' }, chooseBtn, h('button', { type: 'button', onclick: () => dlg.close() }, '취소')),
    );
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });

    async function show() {
      const cur = stack[stack.length - 1];
      body.replaceChildren(h('p', { class: 'muted' }, '불러오는 중…'));
      chooseBtn.disabled = true;
      let folders;
      try {
        folders = (await listChildren(cur.id)).filter((c) => c.folder).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
      } catch (e) {
        body.replaceChildren(h('p', {}, errorMessage(e)));
        return;
      }
      chooseBtn.disabled = cur.id === 'root';
      chooseBtn.textContent = cur.id === 'root' ? '폴더를 고르세요' : `'${cur.name}'(으)로`;
      body.replaceChildren(
        h('nav', { class: 'crumbs' }, ...stack.flatMap((s, i) => {
          const node = i === stack.length - 1
            ? h('span', {}, s.name)
            : h('button', { type: 'button', class: 'link', onclick: () => { stack = stack.slice(0, i + 1); show(); } }, s.name);
          return i ? [h('span', { class: 'sep' }, '›'), node] : [node];
        })),
        h('ul', { class: 'folder-list' },
          ...folders.map((f) => h('li', {}, h('button', { type: 'button', class: 'folder', onclick: () => { stack = [...stack, { id: f.id, name: f.name }]; show(); } },
            h('span', {}, '📁'), h('span', { class: 'grow' }, f.name), h('span', { class: 'muted' }, '›')))),
          !folders.length && h('li', { class: 'muted' }, '하위 폴더가 없습니다.'),
        ),
      );
    }
    document.body.append(dlg);
    dlg.showModal();
    show();
  });
}
