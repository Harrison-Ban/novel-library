import { CONFIG } from './config.js';
import { initAuth, getAccount, login, logout, redirectUri } from './auth.js';
import { listChildren, getItem, downloadFile, onThrottle } from './graph.js';
import { loadLibrary, getLibrary, saveLibrary } from './library.js';
import { scanRoot, loadCache, clearCache, isDoc } from './scan.js';
import { h, formatSize, formatDate, formatDateTime } from './ui.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');

const state = {
  root: null, // { id, name, path }
  scan: null,
  scanning: false,
  progress: null,
  sort: 'name',
  query: '',
  collapsed: new Set(), // 접어 둔 칸 (폴더 ID, 미분류는 'root')
  view: 'list',
};

function render(...nodes) {
  app.replaceChildren(...nodes);
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

function errorMessage(e) {
  if (e?.status === 401 || e?.status === 403) return '권한이 없습니다. 로그아웃 후 다시 로그인해 보세요.';
  if (e?.status === 404) return '항목을 찾을 수 없습니다.';
  if (e instanceof TypeError) return '네트워크에 연결할 수 없습니다.';
  return e?.message || String(e);
}

function renderError(e, retry) {
  console.error(e);
  render(
    h('section', { class: 'panel' },
      h('h2', {}, '문제가 생겼습니다'),
      h('p', {}, errorMessage(e)),
      retry && h('button', { class: 'primary', onclick: retry }, '다시 시도'),
    ),
  );
}

// ---------- 시작 ----------

async function start() {
  if (!CONFIG.clientId) return renderNeedsConfig();
  try {
    await initAuth();
  } catch (e) {
    return renderError(e, () => location.reload());
  }
  if (!getAccount()) return renderLogin();

  nav.hidden = false;
  onThrottle((sec) => toast(`OneDrive 요청이 많아 ${sec}초 기다렸다 다시 시도합니다…`));
  await openLibrary();
}

async function openLibrary() {
  render(h('p', { class: 'muted center' }, '설정을 불러오는 중…'));
  try {
    await loadLibrary();
  } catch (e) {
    return renderError(e, openLibrary);
  }
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
  showList();
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
        state.root && h('button', { onclick: showList }, '취소'),
      ),
    ),
  );
}

async function chooseRoot(folder) {
  render(h('p', { class: 'muted center' }, '저장하는 중…'));
  try {
    const id = folder.id === 'root' ? (await getItem('root')).id : folder.id;
    await saveLibrary((d) => {
      d.rootFolderId = id;
    });
    clearCache();
    state.scan = null;
    await openLibrary();
  } catch (e) {
    renderError(e, () => renderPicker());
  }
}

// ---------- F3: 파일 목록 ----------

function showList() {
  state.view = 'list';
  if (!state.scan || state.scan.rootId !== state.root.id) state.scan = loadCache(state.root.id);
  renderList();
  refreshScan();
}

async function refreshScan() {
  if (state.scanning) return;
  state.scanning = true;
  state.progress = null;
  updateStatus();
  try {
    state.scan = await scanRoot(state.root.id, (done, total) => {
      state.progress = { done, total };
      updateStatus();
    });
  } catch (e) {
    toast(`목록을 새로 불러오지 못했습니다: ${errorMessage(e)}`);
  } finally {
    state.scanning = false;
    updateStatus();
    renderSections();
  }
}

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }),
  size: (a, b) => b.size - a.size,
  modified: (a, b) => b.modified.localeCompare(a.modified),
};

function updateStatus() {
  const el = document.getElementById('scan-status');
  if (!el) return;
  el.textContent = state.scanning
    ? state.progress
      ? `폴더 확인 중 ${state.progress.done}/${state.progress.total}`
      : '목록 확인 중…'
    : state.scan
      ? `마지막 확인 ${formatDateTime(state.scan.scannedAt)}`
      : '';
}

function renderList() {
  const toolbar = h('div', { class: 'toolbar' },
    h('input', {
      type: 'search',
      placeholder: '파일명 검색',
      value: state.query,
      oninput: (e) => {
        state.query = e.target.value;
        renderSections();
      },
    }),
    h('select', {
      onchange: (e) => {
        state.sort = e.target.value;
        renderSections();
      },
    },
      ...[['name', '이름순'], ['size', '용량순'], ['modified', '수정일순']].map(([v, label]) =>
        h('option', { value: v, selected: state.sort === v }, label),
      ),
    ),
  );

  const header = h('div', { class: 'list-head' },
    h('div', {},
      h('div', { class: 'root-name' }, state.root.name),
      h('div', { class: 'muted small' }, state.root.path),
    ),
    h('div', { class: 'muted small', id: 'scan-status' }),
  );

  const sections = h('div', { id: 'sections' });
  render(header, toolbar, sections);
  updateStatus();
  renderSections();
}

function renderSections() {
  const container = document.getElementById('sections');
  const scan = state.scan;
  if (!container) return;
  if (!scan) {
    container.replaceChildren(h('p', { class: 'muted center' }, '파일 목록을 불러오는 중…'));
    return;
  }
  const q = state.query.trim().toLowerCase();
  const files = (q ? scan.files.filter((f) => f.name.toLowerCase().includes(q)) : scan.files)
    .slice()
    .sort(SORTERS[state.sort]);

  const total = files.reduce((s, f) => s + f.size, 0);
  const groups = [{ id: null, name: '미분류 (루트)' }, ...scan.folders].map((folder) => ({
    folder,
    files: files.filter((f) => f.folderId === folder.id),
  }));

  container.replaceChildren(
    h('p', { class: 'summary' }, `전체 ${files.length}개 · ${formatSize(total)}`),
    ...groups
      .filter((g) => g.folder.id !== null || g.files.length || !q)
      .map(({ folder, files }) => {
        const key = folder.id ?? 'root';
        return h('details', {
          class: 'section',
          open: !state.collapsed.has(key),
          ontoggle: (e) => (e.target.open ? state.collapsed.delete(key) : state.collapsed.add(key)),
        },
          h('summary', {},
            h('span', { class: 'grow' }, folder.name),
            h('span', { class: 'muted small' }, `${files.length}개 · ${formatSize(files.reduce((s, f) => s + f.size, 0))}`),
          ),
          files.length
            ? h('ul', { class: 'files' }, ...files.map(fileRow))
            : h('p', { class: 'muted small empty' }, '파일 없음'),
        );
      }),
    scan.nestedFolderCount
      ? h('p', { class: 'muted small' }, `하위 폴더 안에 있는 폴더 ${scan.nestedFolderCount}개는 표시하지 않습니다 (1단계 깊이만).`)
      : null,
  );
}

function fileRow(f) {
  return h('li', { class: 'file' },
    h('div', { class: 'file-name' }, f.name),
    h('div', { class: 'file-meta muted small' },
      h('span', {}, formatSize(f.size)),
      h('span', {}, formatDate(f.modified)),
      h('button', { class: 'link', onclick: (e) => openFile(f, e.currentTarget) }, '열기'),
    ),
  );
}

// 웹앱은 기기의 앱을 직접 실행할 수 없으므로, 파일을 내려받아 기기의 기본 앱으로 열게 한다
async function openFile(f, button) {
  button.disabled = true;
  button.textContent = '받는 중…';
  try {
    const blob = await downloadFile(f.id);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: f.name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`'${f.name}'을(를) 받았습니다. 다운로드 알림에서 열면 기본 앱으로 열립니다.`);
  } catch (e) {
    toast(`파일을 열지 못했습니다: ${errorMessage(e)}`);
  } finally {
    button.disabled = false;
    button.textContent = '열기';
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
        h('button', { class: 'danger', onclick: () => logout() }, '로그아웃'),
      ),
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

// ---------- 상단 버튼 ----------

document.getElementById('nav-list').onclick = () => {
  if (!state.root) return openLibrary();
  state.view = 'list';
  if (state.scan) renderList();
  else showList();
};
document.getElementById('nav-refresh').onclick = () => (state.root ? showList() : openLibrary());
document.getElementById('nav-settings').onclick = renderSettings;

start();
