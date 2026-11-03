// 폴더 설정: 소설 폴더 아래 폴더 구조 전체를 보여 주고, 서재에 올릴 폴더를 고른다.
// 고른 폴더 하나가 장르 탭의 칸 하나가 되고, 칸에는 그 폴더 바로 안의 txt·doc·docx가 보인다.
// 고른 목록은 library.json에 저장되어 다른 기기에서도 같다.
import { state, render, toast, renderError } from './state.js';
import { getLibrary, update } from './library.js';
import { ops } from './model.js';
import { loadFolderTree } from './scan.js';
import { showBoard } from './board.js';
import { h } from './ui.js';

const MAX_SEARCH_ROWS = 300;

export async function renderFolderSettings({ first = false } = {}) {
  state.view = 'folders';
  render(h('p', { class: 'muted center' }, '폴더 구조를 불러오는 중…'));
  let tree;
  try {
    tree = await loadFolderTree(state.root.id);
  } catch (e) {
    return renderError(e, () => renderFolderSettings({ first }));
  }
  if (state.view !== 'folders') return;
  if (state.scan) state.scan.allFolders = tree;

  const rootId = state.root.id;
  const byId = new Map(tree.map((f) => [f.id, f]));
  const kids = new Map();
  for (const f of tree) {
    if (!kids.has(f.parentId)) kids.set(f.parentId, []);
    kids.get(f.parentId).push(f);
  }
  const saved = getLibrary().selectedFolders;
  const chosen = new Set((saved ?? [rootId]).filter((id) => id === rootId || byId.has(id)));

  // 고른 폴더가 보이도록 그 윗 폴더들은 펼쳐 둔다
  const expanded = new Set([rootId]);
  for (const id of chosen) {
    for (let f = byId.get(id); f; f = byId.get(f.parentId)) expanded.add(f.parentId);
  }
  let search = '';

  const descendants = (id) => (kids.get(id) ?? []).flatMap((k) => [k.id, ...descendants(k.id)]);

  // 접힌 폴더 안에 고른 폴더가 몇 개 있는지 (한 번에 계산)
  function chosenBelowCounts() {
    const counts = new Map();
    const count = (id) => {
      let n = 0;
      for (const k of kids.get(id) ?? []) n += (chosen.has(k.id) ? 1 : 0) + count(k.id);
      counts.set(id, n);
      return n;
    };
    count(rootId);
    return counts;
  }

  const list = h('ul', { class: 'folder-tree' });
  // 지금 보이는 줄의 체크 상자와 "(안에 n개 선택)" 표시 — 전체를 다시 그리지 않고 고친다
  const boxes = new Map();
  const hints = new Map();
  function refreshMarks() {
    const counts = chosenBelowCounts();
    for (const [id, box] of boxes) box.checked = chosen.has(id);
    for (const [id, hint] of hints) {
      const n = counts.get(id) ?? 0;
      hint.textContent = !expanded.has(id) && n > 0 ? ` (안에 ${n}개 선택)` : '';
    }
    updateCount();
  }
  const countEl = h('span', { class: 'muted small' });
  const updateCount = () => {
    const n = [...chosen].filter((id) => id !== rootId).length;
    countEl.textContent = `폴더 ${n}개 선택${chosen.has(rootId) ? ' + 소설 폴더 바로 안의 파일' : ''} · 전체 폴더 ${tree.length}개`;
  };

  function checkbox(id) {
    const box = h('input', {
      type: 'checkbox',
      checked: chosen.has(id),
      onchange: (e) => {
        if (e.target.checked) chosen.add(id);
        else chosen.delete(id);
        refreshMarks();
      },
    });
    boxes.set(id, box);
    return box;
  }

  function row(f) {
    const hasKids = kids.has(f.id);
    const open = expanded.has(f.id);
    const hint = h('span', { class: 'muted small' });
    if (hasKids) hints.set(f.id, hint);
    return h('li', { class: 'ft-row', style: `--depth:${search ? 0 : f.depth}` },
      h('button', {
        type: 'button',
        class: 'ft-caret',
        disabled: !hasKids || !!search,
        'aria-label': open ? '접기' : '펼치기',
        onclick: () => {
          if (open) expanded.delete(f.id);
          else expanded.add(f.id);
          draw();
        },
      }, hasKids && !search ? (open ? '▾' : '▸') : ''),
      h('label', { class: 'ft-label' },
        checkbox(f.id),
        h('span', { class: 'ft-name' }, `📁 ${search ? f.path : f.name}`),
        hint,
      ),
      hasKids && h('button', {
        type: 'button',
        class: 'link small ft-all',
        title: '이 폴더와 그 아래 모든 폴더를 선택하거나 해제합니다',
        onclick: () => {
          const ids = [f.id, ...descendants(f.id)];
          const all = ids.every((id) => chosen.has(id));
          for (const id of ids) {
            if (all) chosen.delete(id);
            else chosen.add(id);
          }
          refreshMarks();
        },
      }, '하위 모두'),
    );
  }

  function visibleRows() {
    if (search) return tree.filter((f) => f.name.toLocaleLowerCase().includes(search)).slice(0, MAX_SEARCH_ROWS);
    const out = [];
    const walk = (pid) => {
      for (const f of kids.get(pid) ?? []) {
        out.push(f);
        if (expanded.has(f.id)) walk(f.id);
      }
    };
    walk(rootId);
    return out;
  }

  function draw() {
    boxes.clear();
    hints.clear();
    const rows = visibleRows();
    list.replaceChildren(...[
      !search && h('li', { class: 'ft-row ft-root', style: '--depth:0' },
        h('span', { class: 'ft-caret' }),
        h('label', { class: 'ft-label' }, checkbox(rootId), h('span', { class: 'ft-name' }, `📂 ${state.root.name} 폴더 바로 안의 파일 (미분류 칸)`)),
      ),
      ...rows.map(row),
      !rows.length && h('li', { class: 'muted' }, search ? '찾는 폴더가 없습니다.' : '소설 폴더 안에 하위 폴더가 없습니다.'),
      search && rows.length === MAX_SEARCH_ROWS && h('li', { class: 'muted small' }, `처음 ${MAX_SEARCH_ROWS}개만 보입니다. 검색어를 더 자세히 넣어 주세요.`),
    ].filter(Boolean));
    refreshMarks();
  }

  function save() {
    update(ops.setSelectedFolders([...chosen]));
    toast('폴더 설정을 저장했습니다. 목록을 새로 불러옵니다.');
    showBoard();
  }

  render(
    h('section', { class: 'panel folder-settings' },
      h('h2', {}, '📁 폴더 설정'),
      h('p', { class: 'muted' }, `'${state.root.path}' 아래 폴더 구조입니다. 서재에 올릴 폴더를 체크하세요. 체크한 폴더 하나가 장르 탭의 칸 하나가 되고, 칸에는 그 폴더 바로 안의 파일이 보입니다.`),
      first && h('p', {}, '처음 사용하시네요. 올릴 폴더를 고른 뒤 아래 "저장"을 눌러 주세요.'),
      h('div', { class: 'toolbar' },
        h('input', {
          type: 'search',
          placeholder: '폴더 이름 검색',
          oninput: (e) => {
            search = e.target.value.trim().toLocaleLowerCase();
            draw();
          },
        }),
        h('button', { type: 'button', onclick: () => { for (const f of tree) if (kids.has(f.id)) expanded.add(f.id); draw(); } }, '모두 펼치기'),
        h('button', { type: 'button', onclick: () => { expanded.clear(); expanded.add(rootId); draw(); } }, '모두 접기'),
      ),
      list,
    ),
    h('div', { class: 'ft-actions' },
      countEl,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: save }, '저장'),
        !first && h('button', { type: 'button', onclick: showBoard }, '취소'),
      ),
    ),
  );
  draw();
}
