// F3: 소설 루트 폴더와 그 아래 모든 하위 폴더(맨 아래까지)의 txt·doc·docx 목록
// (이름·용량·수정일·위치만 다루고, 본문은 읽지 않음)
import { listChildren } from './graph.js';

const DOC_EXT = /\.(txt|doc|docx)$/i;
const CACHE_KEY = 'nl.scan';
const CONCURRENCY = 6;
const MAX_FOLDERS = 5000; // 너무 깊거나 많은 폴더에서 끝없이 돌지 않게

export const isDoc = (item) => item.file && DOC_EXT.test(item.name);

// folderId: 보드의 칸(루트 바로 아래 폴더, 루트면 null), parentId: 실제로 들어 있는 폴더,
// path: 루트 기준 폴더 경로 (예: '무협/작가A', 루트면 '')
function toFile(item, folderId, parentId, path) {
  return {
    id: item.id,
    name: item.name,
    size: item.size ?? 0,
    modified: item.lastModifiedDateTime,
    folderId,
    parentId,
    path,
  };
}

// 파일이 실제로 들어 있는 폴더 (예전 저장본에는 parentId가 없어 칸 폴더로 대신한다)
export const parentFolderOf = (f, rootId) => f.parentId ?? f.folderId ?? rootId;

// 동시에 n개씩 처리하되, 처리 중에 큐에 새로 들어온 항목도 계속 처리한다
function runPool(queue, n, handle) {
  let active = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (!queue.length && !active) return resolve();
      while (active < n && queue.length) {
        const item = queue.shift();
        active++;
        handle(item).then(() => {
          active--;
          next();
        }, reject);
      }
    };
    next();
  });
}

export async function scanRoot(rootId, onProgress) {
  const rootChildren = await listChildren(rootId);
  const folders = rootChildren
    .filter((i) => i.folder)
    .map((f) => ({ id: f.id, name: f.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const files = rootChildren.filter(isDoc).map((f) => toFile(f, null, rootId, ''));
  // 모든 하위 폴더: { id, name, parentId, topId(칸 폴더), path }
  const allFolders = [];
  const queue = folders.map((f) => ({ id: f.id, name: f.name, parentId: rootId, topId: f.id, path: f.name }));
  let found = queue.length;
  let done = 0;
  let truncated = false;
  onProgress?.(done, found);

  await runPool(queue, CONCURRENCY, async (folder) => {
    allFolders.push(folder);
    const kids = await listChildren(folder.id);
    for (const k of kids) {
      if (isDoc(k)) files.push(toFile(k, folder.topId, folder.id, folder.path));
      else if (k.folder) {
        if (found >= MAX_FOLDERS) {
          truncated = true;
          continue;
        }
        queue.push({ id: k.id, name: k.name, parentId: folder.id, topId: folder.topId, path: `${folder.path}/${k.name}` });
        found++;
      }
    }
    onProgress?.(++done, found);
  });

  const result = { rootId, folders, allFolders, files, truncated, scannedAt: new Date().toISOString() };
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
