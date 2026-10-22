// Microsoft Graph 호출. 429/503이면 기다렸다 재시도한다.
import { getToken } from './auth.js';

const BASE = 'https://graph.microsoft.com/v1.0';
const MAX_RETRIES = 5;

export class GraphError extends Error {
  constructor(status, body) {
    super(`Graph 오류 ${status}`);
    this.status = status;
    this.body = body;
  }
}

// 재시도 대기 중일 때 화면에 알리기 위한 콜백
let throttleListener = null;
export function onThrottle(fn) {
  throttleListener = fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function graphFetch(path, options = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt;
      throttleListener?.(wait);
      await sleep(wait * 1000);
      continue;
    }
    if (!res.ok) throw new GraphError(res.status, await res.text().catch(() => ''));
    return res;
  }
}

export async function graphJson(path, options) {
  const res = await graphFetch(path, options);
  return res.status === 204 ? null : res.json();
}

const CHILD_FIELDS = 'id,name,size,lastModifiedDateTime,file,folder';

// 폴더 안의 항목 전체. 목록이 길면 나눠서 받아온다.
export async function listChildren(folderId) {
  const base = folderId === 'root' ? '/me/drive/root' : `/me/drive/items/${encodeURIComponent(folderId)}`;
  let next = `${base}/children?$select=${CHILD_FIELDS}&$top=200`;
  const items = [];
  while (next) {
    const page = await graphJson(next);
    items.push(...page.value);
    next = page['@odata.nextLink'] ?? null;
  }
  return items;
}

// 폴더 아래 모든 항목(맨 아래까지)을 페이지 단위로 한꺼번에 받는다 (폴더마다 따로 묻지 않아 빠름)
export async function listAllBelow(folderId, onPage) {
  let next = `/me/drive/items/${encodeURIComponent(folderId)}/delta?$select=${CHILD_FIELDS},parentReference,deleted`;
  const items = [];
  while (next) {
    const page = await graphJson(next);
    items.push(...page.value);
    onPage?.(items.length);
    next = page['@odata.nextLink'] ?? null;
  }
  return items;
}

export function getItem(itemId) {
  return graphJson(`/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,folder,parentReference`);
}

// 파일 내용을 받는다. 받은 내용은 이 기기와 OneDrive 사이에서만 오간다.
// meta.eTag는 편집 저장 때 "그사이 다른 곳에서 바뀌지 않았는지" 확인하는 데 쓴다
export async function openDownloadWithMeta(itemId) {
  const meta = await graphJson(`/me/drive/items/${encodeURIComponent(itemId)}`);
  const url = meta['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('다운로드 주소를 받지 못했습니다');
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new GraphError(res.status, '');
  return { res, meta };
}

export async function openDownload(itemId) {
  return (await openDownloadWithMeta(itemId)).res;
}

export async function downloadFile(itemId) {
  return (await openDownload(itemId)).blob();
}

// 구형 doc을 OneDrive에서 PDF로 변환해 받는다
export async function downloadAsPdf(itemId) {
  const res = await graphFetch(`/me/drive/items/${encodeURIComponent(itemId)}/content?format=pdf`);
  return res.arrayBuffer();
}

// ---------- 파일·폴더 변경 (3단계) ----------
// 같은 이름이 있으면 덮어쓰지 않고 실패(409)하게 한다.
const FAIL_ON_CONFLICT = '@microsoft.graph.conflictBehavior=fail';
const itemPath = (id) => `/me/drive/items/${encodeURIComponent(id)}`;

export const isNameConflict = (e) => e?.status === 409;

// 이동(과 함께 이름 변경)
export function moveItem(itemId, parentId, newName) {
  return graphJson(`${itemPath(itemId)}?${FAIL_ON_CONFLICT}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentReference: { id: parentId }, ...(newName ? { name: newName } : {}) }),
  });
}

export function renameItem(itemId, newName) {
  return graphJson(`${itemPath(itemId)}?${FAIL_ON_CONFLICT}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
}

export function createFolder(parentId, name) {
  return graphJson(`${itemPath(parentId)}/children`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
  });
}

// OneDrive 휴지통으로 보낸다 (영구 삭제 아님)
export function deleteItem(itemId) {
  return graphFetch(itemPath(itemId), { method: 'DELETE' });
}

export function getFolderInfo(folderId) {
  return graphJson(`${itemPath(folderId)}?$select=id,name,folder`);
}

// 새 txt 파일 올리기. 같은 이름이 있으면 실패(409)한다.
export function uploadText(parentId, name, blob) {
  return graphJson(`${itemPath(parentId)}:/${encodeURIComponent(name)}:/content?${FAIL_ON_CONFLICT}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: blob,
  });
}

// 편집한 txt를 원본에 덮어쓴다. 연 뒤에 다른 곳에서 바뀌었으면(eTag 불일치) 412로 실패한다.
// 이전 내용은 OneDrive 버전 기록에 남는다.
export function overwriteText(itemId, blob, eTag) {
  return graphJson(`${itemPath(itemId)}/content`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(eTag ? { 'If-Match': eTag } : {}) },
    body: blob,
  });
}
