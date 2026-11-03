// F1: Google 계정 로그인 (Google Identity Services 토큰 방식)
// 클라이언트 비밀(secret)은 쓰지 않는다. 토큰은 이 브라우저에만 보관하고, 한 시간마다 버튼 한 번으로 새로 받는다.
import { CONFIG } from './config.js';
import { sheet } from './state.js';
import { h } from './ui.js';

const GIS_URL = 'https://accounts.google.com/gsi/client';
const TOKEN_KEY = 'nl.g.token';
const ACCOUNT_KEY = 'nl.g.account';
const EARLY_MS = 60_000; // 만료 1분 전부터는 새로 받는다

export class AuthNeeded extends Error {
  constructor() {
    super('Google 연결이 필요합니다. 다시 연결해 주세요.');
    this.status = 401;
  }
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeJson(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

let token = readJson(TOKEN_KEY); // { value, expiresAt }
let account = readJson(ACCOUNT_KEY); // { name, email }
let tokenClient = null;
let waiting = null; // { resolve, reject } — 팝업 응답 대기
let reconnecting = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GIS_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google 로그인 도구를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'));
    document.head.append(s);
  });
}

export async function initAuth() {
  await loadGis();
  const oauth2 = window.google.accounts.oauth2;
  tokenClient = oauth2.initTokenClient({
    client_id: CONFIG.clientId,
    scope: CONFIG.scopes.join(' '),
    callback: (resp) => {
      const w = waiting;
      waiting = null;
      if (!w) return;
      if (resp.error) return w.reject(new Error(`Google 로그인 실패: ${resp.error_description || resp.error}`));
      if (!oauth2.hasGrantedAllScopes(resp, ...CONFIG.scopes)) {
        return w.reject(new Error('Google Drive 권한을 모두 허용해야 합니다. 다시 로그인해서 체크 상자를 모두 선택해 주세요.'));
      }
      token = { value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in ?? 3600) * 1000 };
      writeJson(TOKEN_KEY, token);
      w.resolve(token.value);
    },
    error_callback: (err) => {
      const w = waiting;
      waiting = null;
      w?.reject(new Error(err?.type === 'popup_failed_to_open'
        ? '로그인 창이 차단되었습니다. 브라우저의 팝업 차단을 풀어 주세요.'
        : '로그인 창이 닫혔습니다.'));
    },
  });
  return account;
}

export function getAccount() {
  return account;
}

export function setAccount(next) {
  account = next;
  writeJson(ACCOUNT_KEY, next);
}

// 반드시 버튼을 누른 순간(사용자 동작 안)에 불러야 로그인 창이 막히지 않는다
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    waiting?.reject(new Error('로그인 창이 닫혔습니다.'));
    waiting = { resolve, reject };
    tokenClient.requestAccessToken({ prompt, ...(account?.email ? { login_hint: account.email } : {}) });
  });
}

export function login() {
  return requestToken(account ? '' : 'select_account');
}

export function logout() {
  token = null;
  writeJson(TOKEN_KEY, null);
  setAccount(null);
}

const hasValidToken = () => token && token.expiresAt - EARLY_MS > Date.now();

// 받은 토큰이 거절되면(401) 버리고 다시 받게 한다
export function dropToken() {
  token = null;
  writeJson(TOKEN_KEY, null);
}

export async function getToken() {
  if (hasValidToken()) return token.value;
  reconnecting ??= reconnect().finally(() => (reconnecting = null));
  return reconnecting;
}

// 토큰이 만료되면 작업을 잠시 멈추고 "다시 연결" 버튼을 보여 준다
async function reconnect() {
  let pending = null;
  await sheet('Google 연결 갱신', h('p', {}, '보안을 위해 한 시간마다 Google 연결을 새로 합니다. 아래 버튼을 누르면 하던 작업을 이어서 합니다.'), [
    { label: '다시 연결', class: 'primary', value: () => (pending = requestToken('')) && true },
    { label: '나중에' },
  ]);
  if (!pending) throw new AuthNeeded();
  return pending;
}
