// library.json: Google Drive 앱 전용 숨김 공간(appDataFolder)에 두는 분류·설정 파일 (F8)
//
// 변경은 "op" 함수(data => void)로 표현한다. 화면에는 바로 반영하고, 잠시 모았다가 저장한다.
// 저장할 때 다른 기기가 먼저 바꿨으면(버전 불일치) 다시 불러와 같은 op를 적용해 합친 뒤 저장한다.
// (아래 eTag 변수에는 Drive 파일의 version을 담는다)
import { findAppFile, readAppFile, createAppFile, updateAppFile, DriveError } from './drive.js';

const FILE_NAME = 'library.json';
const SAVE_DELAY = 800;
const MAX_SAVE_ATTEMPTS = 3;

function emptyLibrary() {
  return { version: 1, rootFolderId: null, groups: [], files: {}, updatedAt: null };
}

let server = emptyLibrary(); // Google Drive에 저장된 내용
let eTag = null;
let local = emptyLibrary(); // server + 아직 저장되지 않은 변경
const pending = [];
let timer = null;
let saving = null;
let status = 'saved'; // saved | pending | saving | error
let lastError = null;
const listeners = new Set();

// kind: 'status'(저장 상태 변화) | 'data'(다른 기기 변경이 반영됨)
export function onLibraryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind) {
  for (const fn of listeners) fn(kind);
}

export function getLibrary() {
  return local;
}

export function getSyncStatus() {
  return { status, error: lastError };
}

function setStatus(next, error = null) {
  status = next;
  lastError = error;
  emit('status');
}

function applyOps(data, ops) {
  for (const op of ops) {
    try {
      op(data);
    } catch (e) {
      console.error('분류 변경 적용 실패', e);
    }
  }
}

// 마지막으로 받은 library.json을 기기에 저장해 두고, 다음에 앱을 열 때 바로 쓴다
const CACHE_KEY = 'nl.g.library';

function setServer(data, tag) {
  server = data;
  eTag = tag;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ data, eTag: tag }));
  } catch {
    // 저장 공간이 부족하면 저장본 없이 동작한다
  }
}

// 기기에 저장해 둔 library.json으로 바로 시작한다. 있으면 true
export function loadCachedLibrary() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!cached?.data) return false;
    server = { ...emptyLibrary(), ...cached.data };
    eTag = cached.eTag ?? null;
    rebuildLocal();
    return true;
  } catch {
    return false;
  }
}

export function clearLibraryCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

function rebuildLocal() {
  local = structuredClone(server);
  applyOps(local, pending);
}

// Google Drive의 최신 library.json. 내가 가진 것과 같으면 null
async function fetchRemote() {
  const meta = await findAppFile(FILE_NAME);
  if (!meta) return eTag === null ? { data: emptyLibrary(), eTag: null } : null;
  if (meta.version === eTag) return null;
  // 내용이 깨져 있으면 덮어쓰지 않도록 여기서 멈춘다
  const data = { ...emptyLibrary(), ...JSON.parse(await readAppFile(meta.id)) };
  return { data, eTag: meta.version };
}

export async function loadLibrary() {
  const remote = await fetchRemote();
  if (remote) setServer(remote.data, remote.eTag);
  rebuildLocal();
  return local;
}

// 저장본으로 시작한 뒤 최신 내용을 받아 바뀌었으면 반영한다 (아직 저장 안 된 변경은 그 위에 다시 얹는다)
export async function refreshLibrary() {
  if (saving) await saving;
  const remote = await fetchRemote();
  if (!remote) return false;
  setServer(remote.data, remote.eTag);
  rebuildLocal();
  emit('data');
  return true;
}

// 다른 기기에서 바뀐 내용이 있으면 반영한다. 반영했으면 true
export async function checkRemote() {
  if (pending.length || saving) return false;
  const remote = await fetchRemote();
  if (!remote || pending.length || saving) return false;
  setServer(remote.data, remote.eTag);
  rebuildLocal();
  emit('data');
  return true;
}

export function update(op) {
  op(local);
  pending.push(op);
  setStatus('pending');
  clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY);
}

// 바로 저장까지 기다려야 할 때
export async function commit(op) {
  update(op);
  await flush();
  if (status === 'error') throw lastError;
}

export async function flush() {
  clearTimeout(timer);
  if (saving) await saving;
  if (!pending.length) return;
  const ops = pending.splice(0);
  saving = (async () => {
    setStatus('saving');
    try {
      await persist(ops);
      setStatus(pending.length ? 'pending' : 'saved');
    } catch (e) {
      console.error(e);
      pending.unshift(...ops);
      setStatus('error', e);
    }
  })();
  await saving;
  saving = null;
  if (pending.length && status !== 'error') return flush();
}

const versionMismatch = () => new DriveError(412, '', '다른 기기가 먼저 저장했습니다');

async function persist(ops) {
  let merged = false;
  for (let attempt = 1; ; attempt++) {
    const next = structuredClone(server);
    applyOps(next, ops);
    next.updatedAt = new Date().toISOString();
    const text = JSON.stringify(next, null, 2);
    try {
      // 저장 직전에 버전을 비교한다 (파일이 아직 없으면 새로 만든다)
      const current = await findAppFile(FILE_NAME);
      if (current && current.version !== eTag) throw versionMismatch();
      const saved = current ? await updateAppFile(current.id, text) : await createAppFile(FILE_NAME, text);
      setServer(next, saved.version);
      rebuildLocal();
      if (merged) emit('data');
      return;
    } catch (e) {
      if (e.status !== 412 || attempt >= MAX_SAVE_ATTEMPTS) throw e;
      const remote = await fetchRemote();
      if (remote) setServer(remote.data, remote.eTag);
      merged = true;
    }
  }
}
