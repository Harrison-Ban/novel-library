// F3: 루트 폴더와 그 바로 아래 하위 폴더의 txt·doc·docx 목록 (이름·용량·수정일만, 본문은 읽지 않음)
import { listChildren } from './graph.js';

const DOC_EXT = /\.(txt|doc|docx)$/i;
const CACHE_KEY = 'nl.scan';
const CONCURRENCY = 4;

export const isDoc = (item) => item.file && DOC_EXT.test(item.name);

function toFile(item, folderId) {
  return {
    id: item.id,
    name: item.name,
    size: item.size ?? 0,
    modified: item.lastModifiedDateTime,
    folderId, // null = 루트 바로 아래(미분류)
  };
}

export async function scanRoot(rootId, onProgress) {
  const rootChildren = await listChildren(rootId);
  const folders = rootChildren
    .filter((i) => i.folder)
    .map((f) => ({ id: f.id, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const files = rootChildren.filter(isDoc).map((f) => toFile(f, null));
  let nestedFolderCount = 0;
  let done = 0;
  onProgress?.(done, folders.length);

  const queue = [...folders];
  async function worker() {
    while (queue.length) {
      const folder = queue.shift();
      const kids = await listChildren(folder.id);
      for (const k of kids) {
        if (isDoc(k)) files.push(toFile(k, folder.id));
        else if (k.folder) nestedFolderCount++;
      }
      onProgress?.(++done, folders.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const result = { rootId, folders, files, nestedFolderCount, scannedAt: new Date().toISOString() };
  saveCache(result);
  return result;
}

// 마지막 목록을 기기에 저장해 다음에 빠르게 연다
export function loadCache(rootId) {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    return cached?.rootId === rootId ? cached : null;
  } catch {
    return null;
  }
}

export function saveCache(result) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(result));
  } catch {
    // 저장 공간이 부족하면 캐시 없이 동작한다
  }
}

export function clearCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}
