// F3: 소설 폴더 아래 폴더 구조 전체와, 폴더 설정에서 고른 폴더의 txt·doc·docx 목록
// (이름·용량·수정일만 다루고, 본문은 읽지 않음)
import { listAllFolders, listFilesIn } from './drive.js';

const DOC_EXT = /\.(txt|doc|docx)$/i;
const CACHE_KEY = 'nl.g.scan';

export const isDoc = (item) => item.file && DOC_EXT.test(item.name);

const byPath = (a, b) => a.path.localeCompare(b.path, 'ko', { numeric: true });

// 소설 폴더 아래 모든 폴더: [{ id, name, parentId, path, depth }] (위에서 아래 순서)
export function buildTree(allFolders, rootId) {
  const children = new Map();
  for (const f of allFolders) {
    for (const p of f.parents) {
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(f);
    }
  }
  const out = [];
  const seen = new Set([rootId]);
  const walk = (parentId, prefix, depth) => {
    const kids = (children.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
    for (const k of kids) {
      if (seen.has(k.id)) continue;
      seen.add(k.id);
      const path = prefix ? `${prefix}/${k.name}` : k.name;
      out.push({ id: k.id, name: k.name, parentId, path, depth });
      walk(k.id, path, depth + 1);
    }
  };
  walk(rootId, '', 0);
  return out;
}

export async function loadFolderTree(rootId) {
  return buildTree(await listAllFolders(), rootId);
}

// selected: 고른 폴더 ID 목록 (소설 폴더 자신의 ID가 있으면 바로 안의 파일을 미분류 칸에 보인다)
// onProgress(done, total): total이 null이면 폴더 구조를 받는 중
export async function scanRoot(rootId, selected, onProgress) {
  onProgress?.(0, null);
  const allFolders = await loadFolderTree(rootId);
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  // 칸 이름은 소설 폴더 기준 경로 (깊은 폴더도 어디 있는지 알 수 있게)
  const folders = selected.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).path, path: byId.get(id).path })).sort(byPath);
  const includeRoot = selected.includes(rootId);
  const listed = [...(includeRoot ? [rootId] : []), ...folders.map((f) => f.id)];
  const listedSet = new Set(listed);
  onProgress?.(0, listed.length);
  const items = await listFilesIn(listed, onProgress);
  const files = [];
  const seen = new Set();
  for (const it of items) {
    if (!isDoc(it) || seen.has(it.id)) continue;
    const parent = it.parents.find((p) => listedSet.has(p));
    if (!parent) continue;
    seen.add(it.id);
    files.push({
      id: it.id,
      name: it.name,
      size: it.size,
      modified: it.lastModifiedDateTime,
      folderId: parent === rootId ? null : parent, // null = 소설 폴더 바로 아래(미분류)
    });
  }
  const result = { rootId, folders, allFolders, files, selected: [...selected], scannedAt: new Date().toISOString() };
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
