// library.json: OneDrive 앱 전용 폴더(Apps 아래)에 두는 분류·설정 파일 (F8)
//
// 변경은 "op" 함수(data => void)로 표현한다. 화면에는 바로 반영하고, 잠시 모았다가 저장한다.
// 저장할 때 다른 기기가 먼저 바꿨으면(eTag 불일치) 다시 불러와 같은 op를 적용해 합친 뒤 저장한다.
import { graphFetch, graphJson } from './graph.js';

const ITEM_PATH = '/me/drive/special/approot:/library.json';
const SAVE_DELAY = 800;
const MAX_SAVE_ATTEMPTS = 3;

function emptyLibrary() {
  return { version: 1, rootFolderId: null, groups: [], files: {}, updatedAt: null };
}

let server = emptyLibrary(); // OneDrive에 저장된 내용
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

function rebuildLocal() {
  local = structuredClone(server);
  applyOps(local, pending);
}

// OneDrive의 최신 library.json. 내가 가진 것과 같으면 null
async function fetchRemote() {
  let meta;
  try {
    meta = await graphJson(ITEM_PATH);
  } catch (e) {
    if (e.status !== 404) throw e;
    return eTag === null ? { data: emptyLibrary(), eTag: null } : null;
  }
  if (meta.eTag === eTag) return null;
  const res = await fetch(meta['@microsoft.graph.downloadUrl'], { cache: 'no-store' });
  if (!res.ok) throw new Error(`library.json을 받지 못했습니다 (${res.status})`);
  // 내용이 깨져 있으면 덮어쓰지 않도록 여기서 멈춘다
  const data = { ...emptyLibrary(), ...JSON.parse(await res.text()) };
  return { data, eTag: meta.eTag };
}

export async function loadLibrary() {
  const remote = await fetchRemote();
  if (remote) {
    server = remote.data;
    eTag = remote.eTag;
  }
  rebuildLocal();
  return local;
}

// 다른 기기에서 바뀐 내용이 있으면 반영한다. 반영했으면 true
export async function checkRemote() {
  if (pending.length || saving) return false;
  const remote = await fetchRemote();
  if (!remote || pending.length || saving) return false;
  server = remote.data;
  eTag = remote.eTag;
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

async function persist(ops) {
  let merged = false;
  for (let attempt = 1; ; attempt++) {
    const next = structuredClone(server);
    applyOps(next, ops);
    next.updatedAt = new Date().toISOString();
    try {
      const res = await graphFetch(`${ITEM_PATH}:/content`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(eTag ? { 'If-Match': eTag } : { 'If-None-Match': '*' }),
        },
        body: JSON.stringify(next, null, 2),
      });
      const saved = await res.json();
      server = next;
      eTag = saved.eTag;
      rebuildLocal();
      if (merged) emit('data');
      return;
    } catch (e) {
      if (e.status !== 412 || attempt >= MAX_SAVE_ATTEMPTS) throw e;
      const remote = await fetchRemote();
      if (remote) {
        server = remote.data;
        eTag = remote.eTag;
      }
      merged = true;
    }
  }
}
