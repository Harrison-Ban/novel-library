import { CONFIG } from './config.js';
import { initAuth, getAccount, setAccount, login, logout } from './auth.js';
import { getItem, getAbout, findFoldersNamed, onThrottle } from './drive.js';
import { loadLibrary, getLibrary, update, flush, checkRemote, onLibraryChange, getSyncStatus, loadCachedLibrary, refreshLibrary, clearLibraryCache } from './library.js';
import { clearCache } from './scan.js';
import { ops } from './model.js';
import { state, render, toast, renderError, isDialogOpen, writePref, errorMessage } from './state.js';
import { showBoard, renderBoard, refreshScan } from './board.js';
import { renderManage } from './manage.js';
import { renderFolderSettings } from './folders.js';
import { h, formatDateTime } from './ui.js';
import { setupPwa, canInstall, promptInstall, isStandalone } from './pwa.js';

const nav = document.getElementById('nav');
const REMOTE_CHECK_MS = 60_000;

// ---------- 시작 ----------

async function start() {
  setupPwa({
    // 저장 대기 중인 변경, 열린 리더·대화상자가 있으면 바로 새로고침하지 않고 알림만 띄운다
    isBusy: () => getSyncStatus().status !== 'saved' || !!document.querySelector('.reader, dialog[open]'),
    beforeReload: () => flush(),
  });
  forgetOneDriveData();
  if (!CONFIG.clientId) return renderNeedsConfig();
  try {
    await initAuth();
  } catch (e) {
    return renderError(e, () => location.reload());
  }
  if (!getAccount()) return renderLogin();
  await enterApp();
}

let entered = false;
async function enterApp() {
  if (entered) return;
  entered = true;
  nav.hidden = false;
  onThrottle((sec) => toast(`Google Drive 요청이 많아 ${sec}초 기다렸다 다시 시도합니다…`));
  startSync();
  await openLibrary();
}

// OneDrive를 쓰던 때 이 기기에 남은 목록·설정·로그인 정보를 지운다 (한 번만)
function forgetOneDriveData() {
  try {
    if (localStorage.getItem('nl.g.migrated')) return;
    for (const key of Object.keys(localStorage)) {
      if (['nl.library', 'nl.scan', 'nl.root'].includes(key) || key.startsWith('msal.') || key.includes('login.windows.net') || key.includes('login.microsoftonline.com')) {
        localStorage.removeItem(key);
      }
    }
    localStorage.setItem('nl.g.migrated', '1');
  } catch {}
}

// 소설 폴더 정보도 기기에 저장해 두고 다음 시작 때 바로 쓴다
const ROOT_CACHE_KEY = 'nl.g.root';
function readRootCache() {
  try {
    return JSON.parse(localStorage.getItem(ROOT_CACHE_KEY));
  } catch {
    return null;
  }
}
function setRoot(root) {
  state.root = root;
  writePref(ROOT_CACHE_KEY, JSON.stringify(root));
}

// 고정된 소설 폴더: '문서' 폴더 안의 '소설' 폴더 (내 드라이브든 PC 백업 폴더든 찾는다)
async function findNovelRoot() {
  for (const folder of await findFoldersNamed(CONFIG.rootName)) {
    for (const parentId of folder.parents) {
      const parent = await getItem(parentId).catch(() => null);
      if (parent && !parent.trashed && CONFIG.rootParentNames.includes(parent.name)) {
        return { id: folder.id, name: folder.name, path: `${parent.name}/${folder.name}` };
      }
    }
  }
  return null;
}

// 저장본이 있으면 서재를 바로 보여주고, 최신 설정과 폴더 정보는 뒤에서 받아 반영한다
async function openLibrary() {
  const cachedRoot = readRootCache();
  if (!state.root && cachedRoot && loadCachedLibrary() && getLibrary().selectedFolders) {
    state.root = cachedRoot;
    showBoard();
    refreshInBackground(cachedRoot);
    return;
  }
  await openLibraryFresh();
}

async function refreshInBackground(root) {
  try {
    await refreshLibrary();
    if (!getLibrary().groups.length) update(ops.initDefaults());
    const item = await getItem(root.id);
    if (item.trashed) throw Object.assign(new Error('소설 폴더가 휴지통에 있습니다'), { status: 404 });
    if (getLibrary().rootFolderId !== root.id) update(ops.setRoot(root.id));
  } catch (e) {
    if (e.status === 404) {
      state.root = null;
      return openLibraryFresh();
    }
    console.warn('설정 새로 받기 실패', e);
  }
}

async function openLibraryFresh() {
  render(h('p', { class: 'muted center' }, '설정을 불러오는 중…'));
  try {
    await loadLibrary();
    if (!getLibrary().groups.length) update(ops.initDefaults());
    const root = await findNovelRoot();
    if (!root) return renderNoRoot();
    if (root.id !== state.root?.id) {
      clearCache();
      state.scan = null;
    }
    setRoot(root);
    if (getLibrary().rootFolderId !== root.id) update(ops.setRoot(root.id));
  } catch (e) {
    return renderError(e, openLibraryFresh);
  }
  if (!getLibrary().selectedFolders) return renderFolderSettings({ first: true });
  showBoard();
}

function renderNoRoot() {
  state.view = 'noroot';
  render(
    h('section', { class: 'panel' },
      h('h2', {}, '소설 폴더를 찾지 못했습니다'),
      h('p', {}, `Google Drive에서 '${CONFIG.rootParentNames[0]}' 폴더 안의 '${CONFIG.rootName}' 폴더를 찾지 못했습니다.`),
      h('p', { class: 'muted' }, `Google Drive에 '${CONFIG.rootParentNames[0]} › ${CONFIG.rootName}' 폴더가 있는지, 휴지통에 있지 않은지 확인한 뒤 다시 시도해 주세요. PC의 문서 폴더를 Google Drive로 백업했다면 백업(동기화)이 끝난 뒤에 보입니다.`),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: openLibraryFresh }, '다시 찾기')),
    ),
  );
}

// ---------- 동기화 (F8) ----------

function startSync() {
  const syncEl = document.getElementById('sync');
  const labels = { saved: ['✓', '저장됨'], pending: ['…', '저장 대기'], saving: ['…', '저장 중'], error: ['⚠', '저장 실패'] };
  syncEl.onclick = () => {
    if (getSyncStatus().status === 'error') flush();
  };
  onLibraryChange((kind) => {
    const { status, error } = getSyncStatus();
    syncEl.querySelector('.sync-icon').textContent = labels[status][0];
    syncEl.querySelector('.sync-label').textContent = labels[status][1];
    syncEl.setAttribute('aria-label', labels[status][1]);
    syncEl.className = `sync ${status}`;
    syncEl.title = status === 'error' ? `${error?.message ?? ''} — 눌러서 다시 시도` : '';
    if (kind === 'data') rerenderCurrent();
  });

  // 다른 기기의 변경: 앱으로 돌아올 때와 열려 있는 동안 주기적으로 확인
  const check = () => {
    if (document.visibilityState !== 'visible' || !state.root) return;
    checkRemote().catch((e) => console.warn('원격 확인 실패', e));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else check();
  });
  window.addEventListener('online', () => flush());
  setInterval(check, REMOTE_CHECK_MS);
}

function rerenderCurrent() {
  // 다른 기기에서 폴더 설정을 바꿨으면 목록을 새로 받는다
  const selected = getLibrary().selectedFolders ?? [];
  if (state.scan && state.root && String(selected) !== String(state.scan.selected ?? [])) refreshScan();
  if (isDialogOpen()) return;
  if (state.view === 'board') renderBoard();
  if (state.view === 'manage') renderManage();
}

// ---------- 설정 필요 / 로그인 ----------

function renderNeedsConfig() {
  render(
    h('section', { class: 'panel' },
      h('h2', {}, 'Google 로그인 설정이 필요합니다'),
      h('p', {}, '아직 Google 클라이언트 ID가 설정되지 않았습니다. docs/SETUP.md의 순서대로 Google Cloud에서 클라이언트 ID를 만든 뒤 Claude에게 알려 주세요.'),
      h('p', { class: 'muted' }, '"승인된 JavaScript 원본"에 이 주소를 등록해야 합니다:'),
      h('code', { class: 'block' }, location.origin),
    ),
  );
}

function renderLogin() {
  const error = h('p', { class: 'muted small' });
  render(
    h('section', { class: 'panel center' },
      h('h2', {}, '소설 서재'),
      h('p', { class: 'muted' }, 'Google 계정으로 로그인하면 Google Drive의 문서 › 소설 폴더에 있는 소설 파일 목록을 볼 수 있습니다.'),
      h('button', {
        class: 'primary',
        // 로그인 창은 버튼을 누른 순간에 열어야 막히지 않는다
        onclick: () => login()
          .then(async () => {
            setAccount(await getAbout());
            await enterApp();
          })
          .catch((e) => (error.textContent = errorMessage(e))),
      }, 'Google 계정으로 로그인'),
      error,
    ),
  );
}

// ---------- 설정 ----------

async function renderSettings() {
  state.view = 'settings';
  const account = getAccount();
  const versionEl = h('p', { class: 'muted small' }, '버전 확인 중…');
  render(
    h('section', { class: 'panel' },
      h('h2', {}, '설정'),
      h('h3', {}, '계정'),
      h('p', {}, account?.name || ''),
      h('p', { class: 'muted small' }, account?.email || ''),
      h('h3', {}, '소설 폴더 (고정)'),
      h('p', {}, state.root ? `Google Drive › ${state.root.path.replace(/\//g, ' › ')}` : '찾지 못함'),
      h('div', { class: 'row' },
        state.root && h('button', { class: 'primary', onclick: () => renderFolderSettings() }, '📁 폴더 설정'),
        h('button', { onclick: renderLog }, '작업 기록'),
        h('button', {
          class: 'danger',
          onclick: () => flush().finally(() => {
            // 이 기기에 저장해 둔 목록·설정도 지운다
            clearLibraryCache();
            clearCache();
            try {
              localStorage.removeItem(ROOT_CACHE_KEY);
            } catch {}
            logout();
            location.reload();
          }),
        }, '로그아웃'),
      ),
      h('h3', {}, '목록 보기'),
      h('div', { class: 'segmented density' },
        ...[['compact', '간단히 (한 줄)'], ['comfortable', '자세히 (카드)']].map(([v, label]) =>
          h('button', {
            type: 'button',
            class: state.density === v ? 'on' : '',
            onclick: () => {
              state.density = v;
              writePref('nl.density', v);
              renderSettings();
            },
          }, label),
        ),
      ),
      h('h3', {}, '앱 설치'),
      installSection(),
    ),
    h('footer', { class: 'version' }, versionEl),
  );
  try {
    const res = await fetch('version.json', { cache: 'no-store' });
    const v = await res.json();
    versionEl.textContent = v.builtAt
      ? `버전 ${v.version} · 배포 ${formatDateTime(v.builtAt)}${v.commit ? ` · ${v.commit}` : ''}`
      : `버전 ${v.version} (로컬 개발)`;
  } catch {
    versionEl.textContent = '버전 정보를 불러오지 못했습니다';
  }
}

function installSection() {
  if (isStandalone()) return h('p', { class: 'muted small' }, '설치된 앱으로 실행 중입니다. 새 버전은 앱을 열 때 자동으로 적용됩니다.');
  if (canInstall()) {
    return h('div', { class: 'row' },
      h('button', {
        class: 'primary',
        onclick: async () => {
          if (await promptInstall()) toast('홈 화면에 설치했습니다');
          renderSettings();
        },
      }, '홈 화면에 설치'),
    );
  }
  return h('p', { class: 'muted small' },
    '휴대폰: 브라우저 메뉴(⋮)에서 "홈 화면에 추가" 또는 "앱 설치". PC: 주소창 오른쪽의 설치 아이콘(⊕) 또는 메뉴의 "앱 설치". 아이폰: 공유 버튼 → "홈 화면에 추가".');
}

// ---------- 작업 기록 ----------

const ACTION_LABELS = { move: '이동', rename: '이름 변경', delete: '휴지통', mkdir: '폴더 생성', rmdir: '폴더 삭제', convert: 'txt 변환', edit: '편집 저장' };

function renderLog() {
  state.view = 'log';
  const log = getLibrary().log ?? [];
  render(
    h('section', { class: 'panel' },
      h('h2', {}, '작업 기록'),
      h('p', { class: 'muted small' }, '최근 파일·폴더 변경 300개까지 보관합니다. 휴지통으로 보낸 항목은 30일 안에 Google Drive 휴지통에서 복원할 수 있습니다.'),
      log.length
        ? h('ul', { class: 'log-list' },
            ...log.map((e) =>
              h('li', {},
                h('div', {}, h('span', { class: `log-action ${e.action}` }, ACTION_LABELS[e.action] ?? e.action), ' ', e.name),
                h('div', { class: 'muted small' }, `${formatDateTime(e.at)} · ${e.detail ?? ''}`),
              ),
            ),
          )
        : h('p', { class: 'muted' }, '아직 기록이 없습니다.'),
      h('div', { class: 'row' }, h('button', { onclick: renderSettings }, '설정으로')),
    ),
  );
}

// ---------- 상단 버튼 ----------

document.getElementById('nav-board').onclick = () => {
  if (!state.root) return openLibrary();
  if (state.scan) {
    state.view = 'board';
    renderBoard();
  } else showBoard();
};
document.getElementById('nav-manage').onclick = () => (state.root ? renderManage() : openLibrary());
document.getElementById('nav-refresh').onclick = async () => {
  if (!state.root) return openLibrary();
  await checkRemote().catch(() => {});
  if (state.view !== 'board') showBoard();
  else refreshScan();
};
document.getElementById('nav-settings').onclick = renderSettings;

start();
