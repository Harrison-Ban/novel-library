// library.json: OneDrive 앱 전용 폴더(Apps 아래)에 두는 분류·설정 파일
import { graphFetch, graphJson } from './graph.js';

const ITEM_PATH = '/me/drive/special/approot:/library.json';
const MAX_SAVE_ATTEMPTS = 3;

function emptyLibrary() {
  return { version: 1, rootFolderId: null, groups: [], files: {}, updatedAt: null };
}

let data = emptyLibrary();
let eTag = null;

export function getLibrary() {
  return data;
}

export async function loadLibrary() {
  let meta;
  try {
    meta = await graphJson(ITEM_PATH);
  } catch (e) {
    if (e.status !== 404) throw e;
    data = emptyLibrary();
    eTag = null;
    return data;
  }
  const res = await fetch(meta['@microsoft.graph.downloadUrl'], { cache: 'no-store' });
  if (!res.ok) throw new Error(`library.json을 받지 못했습니다 (${res.status})`);
  // 내용이 깨져 있으면 덮어쓰지 않도록 여기서 멈춘다
  data = { ...emptyLibrary(), ...JSON.parse(await res.text()) };
  eTag = meta.eTag;
  return data;
}

// mutate(data)로 바꾼 뒤 저장한다. 다른 기기가 먼저 저장했으면(eTag 불일치)
// 다시 불러와 같은 변경을 적용하고 저장한다.
export async function saveLibrary(mutate) {
  for (let attempt = 1; ; attempt++) {
    const next = structuredClone(data);
    mutate(next);
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
      data = next;
      eTag = saved.eTag;
      return data;
    } catch (e) {
      if (e.status !== 412 || attempt >= MAX_SAVE_ATTEMPTS) throw e;
      await loadLibrary();
    }
  }
}
