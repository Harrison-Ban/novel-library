import { CONFIG } from './config.js';
import { initAuth, getAccount, login, logout, redirectUri } from './auth.js';
import { listChildren, getItem, onThrottle } from './graph.js';
import { loadLibrary, getLibrary, update, commit, flush, checkRemote, onLibraryChange, getSyncStatus } from './library.js';
import { clearCache, isDoc } from './scan.js';
import { ops } from './model.js';
import { state, render, toast, renderError, isDialogOpen, writePref } from './state.js';
import { showBoard, renderBoard, refreshScan } from './board.js';
import { renderManage } from './manage.js';
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
  if (!CONFIG.clientId) return renderNeedsConfig();
  try {
    await initAuth();
  } catch (e) {
    return renderError(e, () => location.reload());
  }
  if (!getAccount()) return renderLogin();

  nav.hidden = false;
  onThrottle((sec) => toast(`OneDrive 요청이 많아 ${sec}초 기다렸다 다시 시도합니다…`));
  startSync();
  await openLibrary();
}

async function openLibrary() {
  render(h('p', { class: 'muted center' }, '설정을 불러오는 중…'));
  try {
    await loadLibrary();
  } catch (e) {
    return renderError(e, openLibrary);
  }
  if (!getLibrary().groups.length) update(ops.initDefaults());
  const rootId = getLibrary().rootFolderId;
  if (!rootId) return renderPicker();
  try {
    const item = await getItem(rootId);
    state.root = { id: item.id, name: item.name, path: rootPath(item) };
  } catch (e) {
    if (e.status === 404) {
      toast('지정했던 소설 루트 폴더를 찾을 수 없습니다. 다시 골라 주세요.');
      return renderPicker();
    }
    return renderError(e, openLibrary);
  }
  showBoard();
}

function rootPath(item) {
  const raw = item.parentReference?.path;
  if (!raw) return '/';
  let parent = raw.replace(/^\/drive\/root:?/, '');
  try {
    parent = decodeURIComponent(parent);
  } catch {}
  return `${parent}/${item.name}`;
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
  if (isDialogOpen()) return;
  if (state.view === 'board') renderBoard();
  if (state.view === 'manage') renderManage();
}

// ---------- 설정 필요 / 로그인 ----------

function renderNeedsConfig() {
  render(
    h('section', { class: 'panel' },
      h('h2', {}, 'Azure 앱 등록이 필요합니다'),
      h('p', {}, '아직 클라이언트 ID가 설정되지 않았습니다. docs/SETUP.md의 순서대로 Azure 앱을 등록한 뒤, 클라이언트 ID를 Claude에게 알려 주세요.'),
      h('p', { class: 'muted' }, '이 주소를 리디렉션 URI로 등록해야 합니다:'),
      h('code', { class: 'block' }, redirectUri),
    ),
  );
}

function renderLogin() {
  render(
    h('section', { class: 'panel center' },
      h('h2', {}, 'OneDrive 소설 서재'),
      h('p', { class: 'muted' }, 'Microsoft 개인 계정으로 로그인하면 OneDrive의 소설 파일 목록을 볼 수 있습니다.'),
      h('button', { class: 'primary', onclick: () => login().catch((e) => renderError(e)) }, 'Microsoft 계정으로 로그인'),
    ),
  );
}

// ---------- F2: 루트 폴더 지정 ----------

async function renderPicker(stack = [{ id: 'root', name: '내 파일' }]) {
  state.view = 'picker';
  const current = stack[stack.length - 1];
  render(h('p', { class: 'muted center' }, `${current.name} 여는 중…`));
  let children;
  try {
    children = await listChildren(current.id);
  } catch (e) {
    return renderError(e, () => renderPicker(stack));
  }
  const folders = children.filter((i) => i.folder).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const docCount = children.filter(isDoc).length;

  const crumbs = stack.map((s, i) =>
    i === stack.length - 1
      ? h('span', {}, s.name)
      : h('button', { class: 'link', onclick: () => renderPicker(stack.slice(0, i + 1)) }, s.name),
  );

  render(
    h('section', { class: 'panel' },
      h('h2', {}, '소설 루트 폴더 고르기'),
      h('p', { class: 'muted' }, '소설이 들어 있는 폴더로 들어간 뒤 아래 버튼을 누르세요. 이 폴더 바로 아래의 하위 폴더가 장르 칸이 됩니다.'),
      h('nav', { class: 'crumbs' }, ...crumbs.flatMap((c, i) => (i ? [h('span', { class: 'sep' }, '›'), c] : [c]))),
      h('ul', { class: 'folder-list' },
        folders.length
          ? folders.map((f) =>
              h('li', {},
                h('button', { class: 'folder', onclick: () => renderPicker([...stack, { id: f.id, name: f.name }]) },
                  h('span', { class: 'icon' }, '📁'),
                  h('span', { class: 'grow' }, f.name),
                  h('span', { class: 'muted' }, `${f.folder.childCount ?? 0}개 ›`),
                ),
              ),
            )
          : h('li', { class: 'muted' }, '하위 폴더가 없습니다.'),
      ),
      h('p', { class: 'muted' }, `이 폴더에 바로 있는 txt·doc·docx 파일: ${docCount}개`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => chooseRoot(current) }, `'${current.name}'을(를) 소설 루트로 지정`),
        state.root && h('button', { onclick: showBoard }, '취소'),
      ),
    ),
  );
}

async function chooseRoot(folder) {
  render(h('p', { class: 'muted center' }, '저장하는 중…'));
  try {
    const id = folder.id === 'root' ? (await getItem('root')).id : folder.id;
    await commit(ops.setRoot(id));
    clearCache();
    state.scan = null;
    await openLibrary();
  } catch (e) {
    renderError(e, () => renderPicker());
  }
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
      h('p', { class: 'muted small' }, account?.username || ''),
      h('h3', {}, '소설 루트 폴더'),
      h('p', {}, state.root ? state.root.path : '지정되지 않음'),
      h('div', { class: 'row' },
        h('button', { onclick: () => renderPicker() }, '루트 폴더 바꾸기'),
        h('button', { onclick: renderLog }, '작업 기록'),
        h('button', { class: 'danger', onclick: () => flush().finally(logout) }, '로그아웃'),
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
      h('p', { class: 'muted small' }, '최근 파일·폴더 변경 300개까지 보관합니다. 휴지통으로 보낸 항목은 OneDrive 휴지통에서 복원할 수 있습니다.'),
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
