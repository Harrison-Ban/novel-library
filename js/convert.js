// doc·docx → UTF-8 txt 변환 (F14)
// docx: 브라우저에서 바로 텍스트 추출(mammoth.js)
// doc: OneDrive에서 PDF로 변환해 받은 뒤 텍스트 추출(pdf.js) — 서식은 사라지고 글자만 남는다
import { downloadFile, downloadAsPdf, uploadText, deleteItem, listChildren, isNameConflict } from './graph.js';
import { getLibrary, update } from './library.js';
import { ops, fileTags } from './model.js';
import { showProgress, askConflict, uniqueName, logEntries, commitScan, folderNameOf } from './fileops.js';
import { state, toast, sheet, errorMessage } from './state.js';
import { h, formatSize } from './ui.js';

export const isConvertible = (f) => /\.docx?$/i.test(f.name);

let mammothLoading = null;
function loadMammoth() {
  mammothLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mammoth.browser.min.js';
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => {
      mammothLoading = null;
      reject(new Error('docx 변환기를 불러오지 못했습니다'));
    };
    document.head.append(s);
  });
  return mammothLoading;
}

let pdfLoading = null;
function loadPdfJs() {
  pdfLoading ??= import('../vendor/pdfjs/pdf.min.js').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
    return pdfjs;
  }).catch((e) => {
    pdfLoading = null;
    throw e;
  });
  return pdfLoading;
}

async function docxToText(file) {
  const [mammoth, blob] = await Promise.all([loadMammoth(), downloadFile(file.id)]);
  const result = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return result.value;
}

async function docToText(file) {
  const [pdfjs, data] = await Promise.all([loadPdfJs(), downloadAsPdf(file.id)]);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join(''));
  }
  await pdf.destroy();
  return pages.join('\n\n');
}

const toTxtName = (name) => name.replace(/\.docx?$/i, '.txt');

export async function convertFiles(files) {
  const docs = files.filter(isConvertible);
  if (!docs.length) {
    toast('변환할 doc·docx 파일이 없습니다');
    return 0;
  }
  const size = docs.reduce((s, f) => s + f.size, 0);
  const mode = await sheet(`${docs.length}개를 txt로 변환`, h('div', {},
    h('p', {}, `같은 폴더에 같은 이름의 .txt(UTF-8)로 저장합니다. 서식은 사라지고 글자만 남습니다. (${formatSize(size)})`),
    h('p', { class: 'muted small' }, '원본에 붙은 분류는 새 txt로 넘어갑니다. 구형 doc은 OneDrive에서 PDF로 바꾼 뒤 글자를 뽑습니다.'),
    h('ul', { class: 'confirm-list' }, ...docs.map((f) => h('li', {}, f.name))),
  ), [
    { label: '변환 (원본 유지)', class: 'primary', value: () => 'keep' },
    { label: '변환 후 원본은 휴지통으로', value: () => 'trash' },
    { label: '취소' },
  ]);
  if (!mode) return 0;

  const takenByFolder = new Map();
  async function takenIn(parentId) {
    if (!takenByFolder.has(parentId)) {
      takenByFolder.set(parentId, new Set((await listChildren(parentId)).map((c) => c.name.toLocaleLowerCase())));
    }
    return takenByFolder.get(parentId);
  }

  let policy = null;
  let done = 0;
  let skipped = 0;
  const failed = [];
  const log = [];
  for (const [i, f] of docs.entries()) {
    showProgress(`변환 중 ${i + 1}/${docs.length}`);
    const parentId = f.folderId ?? state.root.id;
    try {
      const taken = await takenIn(parentId);
      let name = toTxtName(f.name);
      if (taken.has(name.toLocaleLowerCase())) {
        let decision = policy;
        if (!decision) {
          showProgress('');
          const answer = await askConflict(name, docs.length - i - 1);
          decision = answer.choice;
          if (answer.all) policy = decision;
          showProgress(`변환 중 ${i + 1}/${docs.length}`);
        }
        if (decision === 'skip') {
          skipped++;
          continue;
        }
        name = uniqueName(name, taken);
      }

      const text = /\.docx$/i.test(f.name) ? await docxToText(f) : await docToText(f);
      if (!text.trim()) {
        failed.push({ name: f.name, error: '뽑아낼 글자가 없습니다' });
        continue;
      }
      const item = await uploadText(parentId, name, new Blob(['﻿', text.replace(/\r?\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' }));
      taken.add(item.name.toLocaleLowerCase());
      state.scan?.files.push({ id: item.id, name: item.name, size: item.size ?? 0, modified: item.lastModifiedDateTime ?? new Date().toISOString(), folderId: f.folderId });

      const tags = fileTags(getLibrary(), f.id);
      if (tags.length) update(ops.tag([item.id], tags));
      log.push({ action: 'convert', name: item.name, detail: `${f.name} → txt (${folderNameOf(parentId)})` });

      if (mode === 'trash') {
        await deleteItem(f.id);
        if (state.scan) state.scan.files = state.scan.files.filter((x) => x.id !== f.id);
        update(ops.forgetFiles([f.id]));
        log.push({ action: 'delete', name: f.name, detail: '변환 후 원본을 휴지통으로' });
      }
      done++;
    } catch (e) {
      failed.push({ name: f.name, error: isNameConflict(e) ? '같은 이름' : errorMessage(e) });
    }
  }
  showProgress('');
  commitScan();
  logEntries(log);
  const parts = [`${done}개 변환`];
  if (skipped) parts.push(`${skipped}개 건너뜀`);
  if (failed.length) parts.push(`${failed.length}개 실패 (${failed.map((x) => `${x.name}: ${x.error}`).join(', ')})`);
  toast(parts.join(' · '));
  return done;
}
