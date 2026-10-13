// 분류 관리: 그룹·항목 추가, 이름 변경, 삭제, 순서, 색상 (F4)
import { state, render } from './state.js';
import { getLibrary, update } from './library.js';
import { ops, sortedGroups, groupItems, newId, PALETTE } from './model.js';
import { h } from './ui.js';
import { addFolder, renameFolder, removeFolder } from './fileops.js';

function move(list, index, dir) {
  const next = [...list];
  const j = index + dir;
  if (j < 0 || j >= next.length) return next;
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}

function apply(op) {
  update(op);
  renderManage();
}

function filesWithTag(lib, itemIds) {
  const ids = new Set(itemIds);
  return Object.values(lib.files).filter((f) => (f.tags ?? []).some((t) => ids.has(t))).length;
}

export function renderManage() {
  state.view = 'manage';
  const lib = getLibrary();
  const groups = sortedGroups(lib);

  render(
    h('h2', { class: 'page-title' }, '분류 관리'),
    ...groups.map((g, gi) => groupPanel(lib, g, gi, groups)),
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => {
          const name = prompt('새 그룹 이름 (예: 작가, 완결 여부)')?.trim();
          if (name) apply(ops.addGroup(newId('g'), name));
        },
      }, '+ 그룹 추가'),
    ),
  );
}

function groupPanel(lib, g, gi, groups) {
  const items = groupItems(g, state.scan);
  const isFolder = g.type === 'folder';
  const layout = (list) => list.map((i) => ({ key: i.key, color: i.color }));

  return h('section', { class: 'panel manage-group' },
    h('div', { class: 'manage-row' },
      h('input', {
        class: 'grow name-input',
        value: g.name,
        'aria-label': '그룹 이름',
        onchange: (e) => {
          const name = e.target.value.trim();
          if (name) update(ops.renameGroup(g.id, name));
          else e.target.value = g.name;
        },
      }),
      h('span', { class: 'type-badge' }, isFolder ? '폴더 연결' : '앱 내'),
      h('button', { type: 'button', title: '위로', disabled: gi === 0, onclick: () => apply(ops.reorderGroups(move(groups, gi, -1).map((x) => x.id))) }, '↑'),
      h('button', { type: 'button', title: '아래로', disabled: gi === groups.length - 1, onclick: () => apply(ops.reorderGroups(move(groups, gi, 1).map((x) => x.id))) }, '↓'),
      !isFolder &&
        h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            const n = filesWithTag(lib, g.items.map((i) => i.id));
            if (confirm(`'${g.name}' 그룹을 삭제할까요?\n항목 ${g.items.length}개가 사라지고, 파일 ${n}개에서 이 그룹 분류가 떼어집니다. OneDrive 파일은 그대로입니다.`)) {
              apply(ops.deleteGroup(g.id));
            }
          },
        }, '삭제'),
    ),
    isFolder &&
      h('p', { class: 'muted small' }, '소설 루트 폴더 바로 아래의 하위 폴더가 항목입니다. 항목 추가·이름 변경·삭제는 OneDrive 폴더에 그대로 적용됩니다 (삭제는 빈 폴더만, 휴지통으로).'),
    h('ul', { class: 'manage-items' },
      ...items.map((item, i) =>
        h('li', { class: 'manage-row' },
          h('input', {
            type: 'color',
            value: item.color,
            'aria-label': `${item.name} 색상`,
            onchange: (e) => {
              const next = layout(items);
              next[i].color = e.target.value;
              apply(ops.setItemsLayout(g.id, next));
            },
          }),
          isFolder
            ? h('input', {
                class: 'grow name-input',
                value: item.name,
                'aria-label': '폴더 이름',
                onchange: async (e) => {
                  if (!(await renameFolder(item, e.target.value))) e.target.value = item.name;
                  renderManage();
                },
              })
            : h('input', {
                class: 'grow name-input',
                value: item.name,
                'aria-label': '항목 이름',
                onchange: (e) => {
                  const name = e.target.value.trim();
                  if (name) update(ops.renameItem(g.id, item.key, name));
                  else e.target.value = item.name;
                },
              }),
          h('button', { type: 'button', title: '위로', disabled: i === 0, onclick: () => apply(ops.setItemsLayout(g.id, layout(move(items, i, -1)))) }, '↑'),
          h('button', { type: 'button', title: '아래로', disabled: i === items.length - 1, onclick: () => apply(ops.setItemsLayout(g.id, layout(move(items, i, 1)))) }, '↓'),
          isFolder &&
            h('button', {
              type: 'button',
              class: 'danger',
              onclick: async () => {
                if (await removeFolder(item)) renderManage();
              },
            }, '삭제'),
          !isFolder &&
            h('button', {
              type: 'button',
              class: 'danger',
              onclick: () => {
                const n = filesWithTag(lib, [item.key]);
                if (confirm(`'${item.name}' 항목을 삭제할까요?\n이 항목이 붙은 파일 ${n}개에서 분류만 떼어집니다. OneDrive 파일은 그대로입니다.`)) {
                  apply(ops.deleteItem(g.id, item.key));
                }
              },
            }, '삭제'),
        ),
      ),
      !items.length &&
        h('li', { class: 'muted small' }, isFolder ? (state.scan ? '하위 폴더가 없습니다.' : '파일 목록을 먼저 불러와 주세요.') : '항목이 없습니다.'),
    ),
    isFolder &&
      h('button', {
        type: 'button',
        disabled: !state.scan,
        onclick: async () => {
          if (await addFolder()) renderManage();
        },
      }, '+ 폴더 추가'),
    !isFolder &&
      h('button', {
        type: 'button',
        onclick: () => {
          const name = prompt(`'${g.name}'에 추가할 항목 이름`)?.trim();
          if (name) apply(ops.addItem(g.id, newId('i'), name, PALETTE[g.items.length % PALETTE.length]));
        },
      }, '+ 항목 추가'),
  );
}
