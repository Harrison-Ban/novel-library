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

const CHILD_FIELDS = 'id,name,size,lastModifiedDateTime,file,folder,webUrl';

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

export function getItem(itemId) {
  return graphJson(`/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,folder,parentReference,webUrl`);
}
