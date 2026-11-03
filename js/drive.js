// Google Drive API 호출. 요청이 많다는 응답(429·403 rate limit·5xx)이면 기다렸다 재시도한다.
// 다른 모듈이 쓰기 쉽게 항목을 { id, name, size, lastModifiedDateTime, parents, eTag, file | folder } 꼴로 바꿔 돌려준다.
// (eTag 자리에는 파일 내용이 바뀔 때마다 달라지는 headRevisionId를 넣는다)
import { getToken, dropToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
const GDOC = 'application/vnd.google-apps.document';
const FIELDS = 'id,name,size,modifiedTime,mimeType,parents,headRevisionId,trashed';
const MAX_RETRIES = 5;

export class DriveError extends Error {
  constructor(status, body, message) {
    super(message ?? `Google Drive 오류 ${status}`);
    this.status = status;
    this.body = body;
  }
}

let throttleListener = null;
export function onThrottle(fn) {
  throttleListener = fn;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (status, body) => status === 429 || status >= 500 || (status === 403 && /rateLimitExceeded/i.test(body));

export async function driveFetch(url, options = {}) {
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    const token = await getToken();
    const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if (res.status === 401 && !renewed) {
      dropToken();
      renewed = true;
      continue;
    }
    if (isRateLimit(res.status, body) && attempt < MAX_RETRIES) {
      const wait = Number(res.headers.get('Retry-After')) || 2 ** attempt;
      throttleListener?.(wait);
      await sleep(wait * 1000);
      continue;
    }
    throw new DriveError(res.status, body);
  }
}

export async function driveJson(url, options) {
  const res = await driveFetch(url, options);
  return res.status === 204 ? null : res.json();
}

const jsonBody = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fileUrl = (id, params = '') => `${API}/files/${encodeURIComponent(id)}?fields=${FIELDS}${params}`;
// 검색어 안의 따옴표·역슬래시 처리
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function toItem(f) {
  return {
    id: f.id,
    name: f.name,
    size: Number(f.size ?? 0),
    lastModifiedDateTime: f.modifiedTime,
    parents: f.parents ?? [],
    eTag: f.headRevisionId ?? null,
    trashed: !!f.trashed,
    ...(f.mimeType === FOLDER ? { folder: {} } : { file: { mimeType: f.mimeType } }),
  };
}

// 조건에 맞는 항목 전체 (1000개씩 나눠 받는다)
async function query(q, { fields = FIELDS, spaces, orderBy } = {}) {
  const items = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000' });
    if (spaces) params.set('spaces', spaces);
    if (orderBy) params.set('orderBy', orderBy);
    if (pageToken) params.set('pageToken', pageToken);
    const page = await driveJson(`${API}/files?${params}`);
    items.push(...page.files);
    pageToken = page.nextPageToken ?? null;
  } while (pageToken);
  return items;
}

export async function getAbout() {
  const about = await driveJson(`${API}/about?fields=user(displayName,emailAddress)`);
  return { name: about.user?.displayName ?? '', email: about.user?.emailAddress ?? '' };
}

// 폴더 안의 항목 전체 (휴지통 제외)
export async function listChildren(folderId) {
  return (await query(`${quote(folderId)} in parents and trashed = false`)).map(toItem);
}

// 여러 폴더 안의 파일을 한꺼번에 (폴더 25개씩 묶어 묻는다)
export async function listFilesIn(folderIds, onBatch) {
  const items = [];
  for (let i = 0; i < folderIds.length; i += 25) {
    const ids = folderIds.slice(i, i + 25);
    const q = `(${ids.map((id) => `${quote(id)} in parents`).join(' or ')}) and mimeType != '${FOLDER}' and trashed = false`;
    items.push(...(await query(q)).map(toItem));
    onBatch?.(Math.min(i + 25, folderIds.length), folderIds.length);
  }
  return items;
}

// 내 드라이브의 폴더 전체 (이름·위치만). 폴더 수가 많아도 몇 번의 요청으로 끝난다
export async function listAllFolders() {
  return (await query(`mimeType = '${FOLDER}' and trashed = false`, { fields: 'id,name,parents' })).map(toItem);
}

export async function findFoldersNamed(name) {
  return (await query(`name = ${quote(name)} and mimeType = '${FOLDER}' and trashed = false`, { fields: 'id,name,parents' })).map(toItem);
}

export async function getItem(itemId) {
  return toItem(await driveJson(fileUrl(itemId)));
}

// 같은 폴더에 같은 이름이 있는지 (Google Drive는 같은 이름을 막지 않으므로 앱이 직접 확인한다)
async function nameTaken(parentId, name, exceptId) {
  const found = await query(`${quote(parentId)} in parents and name = ${quote(name)} and trashed = false`, { fields: 'id' });
  return found.some((f) => f.id !== exceptId);
}
const conflict = () => new DriveError(409, '', '같은 이름이 있습니다');
export const isNameConflict = (e) => e?.status === 409;

// 파일 내용을 받는다. 받은 내용은 이 기기와 Google Drive 사이에서만 오간다.
// meta.eTag는 편집 저장 때 "그사이 다른 곳에서 바뀌지 않았는지" 확인하는 데 쓴다
export async function openDownloadWithMeta(itemId) {
  const meta = await getItem(itemId);
  const res = await driveFetch(`${API}/files/${encodeURIComponent(itemId)}?alt=media`, { cache: 'no-store' });
  return { res, meta };
}

export async function openDownload(itemId) {
  return (await openDownloadWithMeta(itemId)).res;
}

export async function downloadFile(itemId) {
  return (await openDownload(itemId)).blob();
}

// 구형 doc: Google 문서로 복사(변환)해 글자만 받은 뒤, 임시 복사본은 휴지통으로 보낸다
export async function docToPlainText(itemId, name) {
  const copy = await driveJson(`${API}/files/${encodeURIComponent(itemId)}/copy?fields=id`, jsonBody('POST', { name: `~변환 중 ${name}`, mimeType: GDOC }));
  try {
    const res = await driveFetch(`${API}/files/${encodeURIComponent(copy.id)}/export?mimeType=text/plain`);
    return (await res.text()).replace(/^﻿/, '');
  } finally {
    await trashItem(copy.id).catch((e) => console.warn('임시 변환 파일을 휴지통으로 보내지 못했습니다', e));
  }
}

// ---------- 파일·폴더 변경 ----------
// 같은 이름이 있으면 덮어쓰거나 중복을 만들지 않고 409로 실패한다.

// 이동(과 함께 이름 변경)
export async function moveItem(itemId, parentId, newName) {
  const cur = await getItem(itemId);
  if (await nameTaken(parentId, newName ?? cur.name, itemId)) throw conflict();
  const params = `&addParents=${encodeURIComponent(parentId)}&removeParents=${encodeURIComponent(cur.parents.join(','))}`;
  return toItem(await driveJson(fileUrl(itemId, params), jsonBody('PATCH', newName ? { name: newName } : {})));
}

export async function renameItem(itemId, newName) {
  const cur = await getItem(itemId);
  for (const p of cur.parents) if (await nameTaken(p, newName, itemId)) throw conflict();
  return toItem(await driveJson(fileUrl(itemId), jsonBody('PATCH', { name: newName })));
}

export async function createFolder(parentId, name) {
  if (await nameTaken(parentId, name)) throw conflict();
  return toItem(await driveJson(`${API}/files?fields=${FIELDS}`, jsonBody('POST', { name, mimeType: FOLDER, parents: [parentId] })));
}

// Google Drive 휴지통으로 보낸다 (영구 삭제 아님, 30일 안에 복원 가능)
export async function trashItem(itemId) {
  return driveJson(fileUrl(itemId), jsonBody('PATCH', { trashed: true }));
}

export async function hasChildren(folderId) {
  const params = new URLSearchParams({ q: `${quote(folderId)} in parents and trashed = false`, fields: 'files(id)', pageSize: '1' });
  return (await driveJson(`${API}/files?${params}`)).files.length > 0;
}

function multipart(meta, blob) {
  const boundary = `nl${crypto.randomUUID().replace(/-/g, '')}`;
  return {
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]),
  };
}

// 새 파일 올리기. 같은 이름이 있으면 실패(409)한다.
export async function uploadText(parentId, name, blob) {
  if (await nameTaken(parentId, name)) throw conflict();
  const { headers, body } = multipart({ name, parents: [parentId], mimeType: 'text/plain' }, blob);
  return toItem(await driveJson(`${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', headers, body }));
}

// 편집한 txt를 원본에 덮어쓴다. 연 뒤에 다른 곳에서 바뀌었으면(내용 버전 불일치) 412로 실패한다.
// 이전 내용은 Google Drive의 "버전 관리"에 남는다.
export async function overwriteText(itemId, blob, eTag) {
  const cur = await getItem(itemId);
  if (eTag && cur.eTag !== eTag) throw new DriveError(412, '', '그사이 파일이 바뀌었습니다');
  return toItem(await driveJson(`${UPLOAD}/files/${encodeURIComponent(itemId)}?uploadType=media&fields=${FIELDS}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: blob,
  }));
}

// ---------- 앱 전용 숨김 공간(appDataFolder) ----------
// 버전(version)은 파일이 바뀔 때마다 커진다. 저장 전에 비교해 다른 기기의 변경을 덮어쓰지 않는다.

export async function findAppFile(name) {
  const found = await query(`name = ${quote(name)} and trashed = false`, { fields: 'id,version', spaces: 'appDataFolder', orderBy: 'createdTime' });
  return found[0] ?? null;
}

export async function readAppFile(id) {
  return (await driveFetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { cache: 'no-store' })).text();
}

export async function createAppFile(name, text) {
  const { headers, body } = multipart({ name, parents: ['appDataFolder'], mimeType: 'application/json' }, new Blob([text], { type: 'application/json' }));
  return driveJson(`${UPLOAD}/files?uploadType=multipart&fields=id,version`, { method: 'POST', headers, body });
}

export async function updateAppFile(id, text) {
  return driveJson(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,version`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
}
