// 보드: 선택한 그룹의 항목마다 칸을 만들고 파일 카드를 놓는다 (F5·F6·F7·F9)
import { state, render, toast, errorMessage, sheet, writePref } from './state.js';
import { getLibrary, update } from './library.js';
import { scanRoot, loadCache } from './scan.js';
import { downloadFile } from './graph.js';
import { moveItems, renameFile, trashFiles, pickFolder } from './fileops.js';
import { ops, sortedGroups, findGroup, groupItems, fileTags, fileKeysInGroup, NONE } from './model.js';
import { h, formatSize, formatDate, formatDateTime } from './ui.js';

const canDrag = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }),
  size: (a, b) => b.size - a.size,
  modified: (a, b) => b.modified.localeCompare(a.modified),
};

// ---------- 목록 불러오기 ----------

export function showBoard() {
  state.view = 'board';
  if (!state.scan || state.scan.rootId !== state.root.id) state.scan = loadCache(state.root.id);
  renderBoard();
  refreshScan();
}

export async function refreshScan() {
  if (state.scanning) return;
  state.scanning = true;
  state.progress = null;
  updateStatus();
  try {
    state.scan = await scanRoot(state.root.id, (done, total) => {
      state.progress = { done, total };
      updateStatus();
    });
    forgetMissingFiles(state.scan);
  } catch (e) {
    toast(`목록을 새로 불러오지 못했습니다: ${errorMessage(e)}`);
  } finally {
    state.scanning = false;
    if (state.view === 'board') renderBoard();
  }
}

// OneDrive에서 사라진 파일의 분류 정보를 정리한다.
// 한꺼번에 절반 넘게 사라졌다면 루트 폴더를 바꾼 경우일 수 있어 지우지 않는다.
function forgetMissingFiles(scan) {
  const lib = getLibrary();
  if (lib.rootFolderId !== scan.rootId) return;
  const present = new Set(scan.files.map((f) => f.id));
  const known = Object.keys(lib.files);
  const missing = known.filter((id) => !present.has(id));
  if (missing.length && missing.length <= Math.max(5, known.length / 2)) update(ops.forgetFiles(missing));
}

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

// ---------- 화면 ----------

function currentGroup(lib) {
  const groups = sortedGroups(lib);
  const group = findGroup(lib, state.groupId) ?? groups[0];
  state.groupId = group?.id ?? null;
  return group;
}

export function renderBoard() {
  const lib = getLibrary();
  const groups = sortedGroups(lib);
  const group = currentGroup(lib);
  const activeFilters = [...state.filters.entries()].filter(([gid, set]) => set.size && findGroup(lib, gid));

  render(
    h('div', { class: 'list-head' },
      h('div', {},
        h('div', { class: 'root-name' }, state.root.name),
        h('div', { class: 'muted small' }, state.root.path),
      ),
      h('div', { class: 'muted small', id: 'scan-status' }),
    ),
    h('nav', { class: 'tabs' },
      ...groups.map((g) =>
        h('button', {
          type: 'button',
          class: g.id === group?.id ? 'tab active' : 'tab',
          onclick: () => {
            state.groupId = g.id;
            writePref('nl.group', g.id);
            state.collapsed.clear();
            renderBoard();
          },
        }, g.name),
      ),
    ),
    h('div', { class: 'toolbar' },
      h('input', {
        type: 'search',
        placeholder: '파일명 검색',
        value: state.query,
        oninput: (e) => {
          state.query = e.target.value;
          renderColumns();
        },
      }),
      h('select', {
        'aria-label': '정렬',
        onchange: (e) => {
          state.sort = e.target.value;
          writePref('nl.sort', state.sort);
          renderColumns();
        },
      },
        ...[['name', '이름순'], ['size', '용량순'], ['modified', '수정일순']].map(([v, label]) =>
          h('option', { value: v, selected: state.sort === v }, label),
        ),
      ),
      h('button', {
        type: 'button',
        class: activeFilters.length ? 'on' : '',
        onclick: () => {
          state.showFilters = !state.showFilters;
          renderBoard();
        },
      }, activeFilters.length ? `필터 ${activeFilters.length}` : '필터'),
      h('button', {
        type: 'button',
        class: state.selectMode ? 'on' : '',
        onclick: () => setSelectMode(!state.selectMode),
      }, '선택'),
    ),
    state.showFilters && filterPanel(lib, group),
    group?.type === 'folder' &&
      h('p', { class: 'muted small note' }, '폴더 연결 그룹: 칸을 옮기면 OneDrive에서 실제 파일이 그 폴더로 이동합니다 (확인 후 실행).'),
    h('p', { class: 'summary', id: 'summary' }),
    h('div', { class: 'board', id: 'board' }),
    h('div', { id: 'selection-bar' }),
  );
  updateStatus();
  renderColumns();
}

function filterPanel(lib, current) {
  return h('div', { class: 'filters' },
    ...sortedGroups(lib)
      .filter((g) => g.id !== current?.id)
      .map((g) => {
        const set = state.filters.get(g.id) ?? new Set();
        const chips = [...groupItems(g, state.scan), { key: NONE, name: '미분류', color: null }];
        return h('div', { class: 'filter-row' },
          h('span', { class: 'filter-label' }, g.name),
          ...chips.map((c) =>
            h('button', {
              type: 'button',
              class: set.has(c.key) ? 'chip on' : 'chip',
              onclick: () => {
                if (set.has(c.key)) set.delete(c.key);
                else set.add(c.key);
                state.filters.set(g.id, set);
                renderBoard();
              },
            }, c.color && h('span', { class: 'dot', style: `background:${c.color}` }), c.name),
          ),
        );
      }),
    state.filters.size > 0 &&
      h('button', {
        type: 'button',
        class: 'link',
        onclick: () => {
          state.filters.clear();
          renderBoard();
        },
      }, '필터 모두 해제'),
  );
}

function visibleFiles(lib) {
  const q = state.query.trim().toLowerCase();
  const filters = [...state.filters.entries()]
    .map(([gid, set]) => [findGroup(lib, gid), set])
    .filter(([g, set]) => g && set.size);
  return state.scan.files
    .filter((f) => !q || f.name.toLowerCase().includes(q))
    .filter((f) => filters.every(([g, set]) => fileKeysInGroup(lib, g, f).some((k) => set.has(k))))
    .sort(SORTERS[state.sort]);
}

// 카드에 붙일 다른 그룹의 배지
function badgeIndex(lib) {
  const index = new Map();
  for (const g of lib.groups) for (const item of groupItems(g, state.scan)) index.set(item.key, { ...item, groupId: g.id });
  return index;
}

export function renderColumns() {
  const board = document.getElementById('board');
  if (!board) return;
  const lib = getLibrary();
  const group = currentGroup(lib);
  if (!state.scan || !group) {
    board.replaceChildren(h('p', { class: 'muted center' }, '파일 목록을 불러오는 중…'));
    return;
  }

  const files = visibleFiles(lib);
  const total = files.reduce((s, f) => s + f.size, 0);
  document.getElementById('summary').textContent = `전체 ${files.length}개 · ${formatSize(total)}`;

  const badges = badgeIndex(lib);
  const columns = [{ key: NONE, name: '미분류', color: null }, ...groupItems(group, state.scan)];
  const byColumn = new Map(columns.map((c) => [c.key, []]));
  for (const f of files) for (const k of fileKeysInGroup(lib, group, f)) byColumn.get(k)?.push(f);

  board.replaceChildren(
    ...columns.map((col) => {
      const colFiles = byColumn.get(col.key);
      const collapsed = state.collapsed.has(col.key);
      return h('section', { class: collapsed ? 'column collapsed' : 'column' },
        h('button', {
          type: 'button',
          class: 'column-head',
          onclick: () => {
            if (collapsed) state.collapsed.delete(col.key);
            else state.collapsed.add(col.key);
            renderColumns();
          },
        },
          col.color && h('span', { class: 'dot', style: `background:${col.color}` }),
          h('span', { class: 'grow' }, col.name),
          h('span', { class: 'muted small' }, `${colFiles.length}개 · ${formatSize(colFiles.reduce((s, f) => s + f.size, 0))}`),
        ),
        (col.key === TRASH_ITEM || col.name === '삭제예정') && group.type === 'virtual' && colFiles.length > 0 && !collapsed &&
          h('div', { class: 'column-action' },
            h('button', { type: 'button', class: 'danger', onclick: () => trashAndRefresh(colFiles, '삭제예정 파일 휴지통으로') }, `${colFiles.length}개 휴지통으로`),
          ),
        h('ul', { class: 'cards', 'data-col': col.key },
          ...colFiles.map((f) => card(lib, group, f, badges)),
        ),
      );
    }),
  );

  if (canDrag() && !state.selectMode && window.Sortable) {
    for (const list of board.querySelectorAll('.cards')) {
      window.Sortable.create(list, {
        group: 'board',
        sort: false,
        animation: 150,
        onEnd: async (evt) => {
          if (evt.from === evt.to) return;
          const fileId = evt.item.dataset.id;
          if (group.type === 'folder') {
            // 폴더 연결: 실제 파일 이동 (확인 후)
            const file = state.scan.files.find((f) => f.id === fileId);
            if (file) await moveItems([file], folderTarget(evt.to.dataset.col));
          } else {
            update(ops.moveInGroup([fileId], group.id, evt.from.dataset.col, evt.to.dataset.col));
          }
          renderColumns();
        },
      });
    }
  }
  renderSelectionBar();
}

function card(lib, group, f, badges) {
  const otherBadges = [
    ...(group.type !== 'folder' && f.folderId ? [badges.get(f.folderId)] : []),
    ...fileTags(lib, f.id).map((t) => badges.get(t)).filter((b) => b && b.groupId !== group.id),
  ].filter(Boolean);

  const el = h('li', {
    class: state.selected.has(f.id) ? 'card selected' : 'card',
    'data-id': f.id,
    onclick: (e) => {
      if (e.target.closest('button') || Date.now() < suppressClickUntil) return;
      if (state.selectMode) toggleSelected(f.id);
      else cardMenu(f);
    },
  },
    h('div', { class: 'card-name' }, f.name),
    h('div', { class: 'card-meta muted small' },
      h('span', {}, formatSize(f.size)),
      h('span', {}, formatDate(f.modified)),
      h('button', { type: 'button', class: 'link', onclick: (e) => openFile(f, e.currentTarget) }, '열기'),
    ),
    otherBadges.length > 0 &&
      h('div', { class: 'badges' },
        ...otherBadges.map((b) => h('span', { class: 'badge', style: `--c:${b.color}` }, b.name)),
      ),
  );
  addLongPress(el, () => {
    if (!state.selectMode) setSelectMode(true);
    if (!state.selected.has(f.id)) toggleSelected(f.id);
  });
  return el;
}

// 휴대폰: 길게 누르면 선택 모드. 손을 뗄 때 따라오는 클릭이 선택을 다시 풀지 않게 막는다.
let suppressClickUntil = 0;

function addLongPress(el, fn) {
  let timer = null;
  let fired = false;
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', () => {
    cancel();
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      suppressClickUntil = Date.now() + 800;
      fn();
    }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchend', (e) => {
    cancel();
    if (fired) e.preventDefault();
  });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('contextmenu', (e) => {
    if (e.pointerType !== 'mouse' && matchMedia('(pointer: coarse)').matches) e.preventDefault();
  });
}

// ---------- 선택 모드 ----------

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  renderBoard();
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  for (const el of document.querySelectorAll(`.card[data-id="${CSS.escape(id)}"]`)) el.classList.toggle('selected', state.selected.has(id));
  renderSelectionBar();
}

function renderSelectionBar() {
  const bar = document.getElementById('selection-bar');
  const selectedFiles = () => state.scan?.files.filter((f) => state.selected.has(f.id)) ?? [];
  if (!bar) return;
  if (!state.selectMode) {
    bar.replaceChildren();
    bar.className = '';
    return;
  }
  const lib = getLibrary();
  const group = currentGroup(lib);
  const ids = [...state.selected];
  const size = state.scan?.files.filter((f) => state.selected.has(f.id)).reduce((s, f) => s + f.size, 0) ?? 0;
  bar.className = 'selection-bar';
  bar.replaceChildren(
    h('span', { class: 'grow' }, `${ids.length}개 선택 · ${formatSize(size)}`),
    h('button', { type: 'button', disabled: !ids.length, onclick: () => moveDialog(ids) }, '칸 이동'),
    h('button', { type: 'button', disabled: !ids.length, onclick: () => tagDialog(ids) }, '분류 지정'),
    h('button', {
      type: 'button',
      onclick: async () => {
        const choice = await sheet(`${ids.length}개 선택`, null, [
          { label: '보이는 파일 모두 선택', value: () => 'all' },
          ...(ids.length ? [
            { label: '다른 폴더로 이동', value: () => 'folder' },
            { label: '휴지통으로 삭제', class: 'danger', value: () => 'trash' },
          ] : []),
          { label: '닫기' },
        ]);
        if (choice === 'all') {
          for (const f of visibleFiles(getLibrary())) state.selected.add(f.id);
          renderColumns();
        }
        if (choice === 'folder') moveToPickedFolder(selectedFiles());
        if (choice === 'trash') trashAndRefresh(selectedFiles());
      },
    }, '더보기'),
    h('button', { type: 'button', onclick: () => setSelectMode(false) }, '취소'),
  );
}

function afterBulkChange() {
  if (state.selectMode) {
    state.selected.clear();
    state.selectMode = false;
    renderBoard();
  } else {
    renderColumns();
  }
}

// ---------- 카드 메뉴와 대화상자 ----------

async function cardMenu(f) {
  const choice = await sheet(f.name, h('p', { class: 'muted small' }, `${formatSize(f.size)} · ${formatDate(f.modified)}`), [
    { label: '열기 (기본 앱)', value: () => 'open' },
    { label: '분류 지정', value: () => 'tag' },
    { label: '칸으로 이동', value: () => 'move' },
    { label: '다른 폴더로 이동', value: () => 'folder' },
    { label: '이름 변경', value: () => 'rename' },
    { label: '선택', value: () => 'select' },
    { label: '휴지통으로 삭제', class: 'danger', value: () => 'trash' },
    { label: '닫기' },
  ]);
  if (choice === 'open') openFile(f);
  if (choice === 'tag') tagDialog([f.id]);
  if (choice === 'move') moveDialog([f.id]);
  if (choice === 'folder') moveToPickedFolder([f]);
  if (choice === 'rename' && (await renameFile(f))) renderColumns();
  if (choice === 'trash') trashAndRefresh([f]);
  if (choice === 'select') {
    state.selectMode = true;
    state.selected.add(f.id);
    renderBoard();
  }
}

async function moveDialog(ids) {
  const lib = getLibrary();
  const group = currentGroup(lib);
  if (!group) return;
  const columns = [...groupItems(group, state.scan), { key: NONE, name: group.type === 'folder' ? '미분류 (루트)' : '미분류', color: null }];
  const target = await sheet(`${group.name}: ${ids.length}개를 어느 칸으로?`,
    group.type === 'folder' && h('p', { class: 'muted small' }, '폴더 연결 그룹이라 OneDrive에서 실제 파일이 이동합니다.'), [
    ...columns.map((c) => ({ label: c.name, value: () => c.key })),
    { label: '취소' },
  ]);
  if (!target) return;
  if (group.type === 'folder') {
    const files = state.scan.files.filter((f) => ids.includes(f.id));
    await moveItems(files, folderTarget(target));
  } else {
    update(ops.moveInGroup(ids, group.id, null, target));
  }
  afterBulkChange();
}

const TRASH_ITEM = 'i-del'; // 상태 그룹의 '삭제예정'

// 장르(폴더 연결) 칸 키 → 실제 OneDrive 폴더
function folderTarget(key) {
  if (key === NONE) return { id: state.root.id, name: `${state.root.name} (루트)` };
  const folder = state.scan.folders.find((f) => f.id === key);
  return { id: key, name: folder?.name ?? '폴더' };
}

async function moveToPickedFolder(files) {
  const target = await pickFolder(`${files.length}개를 옮길 폴더`);
  if (!target) return;
  await moveItems(files, target);
  afterBulkChange();
}

async function trashAndRefresh(files, title) {
  const n = await trashFiles(files, title);
  if (n) afterBulkChange();
}

// 앱 내 그룹 항목을 체크박스로 붙이고 뗀다. 일부 파일에만 붙은 항목은 '-' 상태로 두면 그대로 유지된다.
async function tagDialog(ids) {
  const lib = getLibrary();
  const groups = sortedGroups(lib).filter((g) => g.type === 'virtual');
  const boxes = [];
  const body = h('div', { class: 'tag-groups' },
    ...groups.map((g) =>
      h('fieldset', {},
        h('legend', {}, g.name),
        ...groupItems(g, state.scan).map((item) => {
          const count = ids.filter((id) => fileTags(lib, id).includes(item.key)).length;
          const box = h('input', { type: 'checkbox', checked: count === ids.length && count > 0 });
          box.indeterminate = count > 0 && count < ids.length;
          boxes.push({ key: item.key, box, initial: box.checked, mixed: box.indeterminate });
          return h('label', { class: 'check' }, box, h('span', { class: 'dot', style: `background:${item.color}` }), item.name);
        }),
        !g.items.length && h('p', { class: 'muted small' }, '항목이 없습니다'),
      ),
    ),
    !groups.length && h('p', { class: 'muted' }, '앱 내 그룹이 없습니다. 분류 관리에서 만들 수 있습니다.'),
  );
  const ok = await sheet(ids.length > 1 ? `${ids.length}개 파일 분류 지정` : '분류 지정', body, [
    { label: '저장', class: 'primary', value: () => true },
    { label: '취소' },
  ]);
  if (!ok) return;
  const add = [];
  const remove = [];
  for (const b of boxes) {
    if (b.box.indeterminate) continue;
    if (b.box.checked && (!b.initial || b.mixed)) add.push(b.key);
    if (!b.box.checked && (b.initial || b.mixed)) remove.push(b.key);
  }
  if (!add.length && !remove.length) return;
  update(ops.tag(ids, add, remove));
  afterBulkChange();
}

// 웹앱은 기기의 앱을 직접 실행할 수 없으므로, 파일을 내려받아 기기의 기본 앱으로 열게 한다
async function openFile(f, button) {
  if (button) {
    button.disabled = true;
    button.textContent = '받는 중…';
  } else {
    toast(`'${f.name}' 받는 중…`);
  }
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
    if (button) {
      button.disabled = false;
      button.textContent = '열기';
    }
  }
}
