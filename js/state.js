// 화면 상태와 공통 도우미
import { h } from './ui.js';

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export const state = {
  root: null, // { id, name, path }
  scan: null,
  scanning: false,
  progress: null,
  view: 'board',
  groupId: readPref('nl.group', null),
  sort: readPref('nl.sort', 'name'),
  query: '',
  collapsed: new Set(), // 접어 둔 칸
  filters: new Map(), // groupId → Set(칸 키)
  showFilters: false,
  selectMode: false,
  selected: new Set(),
};

const app = document.getElementById('app');

export function render(...nodes) {
  app.replaceChildren(...nodes.filter((n) => n != null && n !== false));
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

export function errorMessage(e) {
  if (e?.status === 401 || e?.status === 403) return '권한이 없습니다. 로그아웃 후 다시 로그인해 보세요.';
  if (e?.status === 404) return '항목을 찾을 수 없습니다.';
  if (e instanceof TypeError) return '네트워크에 연결할 수 없습니다.';
  return e?.message || String(e);
}

export function renderError(e, retry) {
  console.error(e);
  render(
    h('section', { class: 'panel' },
      h('h2', {}, '문제가 생겼습니다'),
      h('p', {}, errorMessage(e)),
      retry && h('button', { class: 'primary', onclick: retry }, '다시 시도'),
    ),
  );
}

// 아래에서 올라오는 확인 창. buttons: [{ label, class, value }] — value()가 false를 돌려주면 닫지 않는다
export function sheet(title, body, buttons = [{ label: '닫기' }]) {
  return new Promise((resolve) => {
    let result = null;
    const dlg = h('dialog', { class: 'sheet' },
      h('div', { class: 'sheet-head' }, h('h3', {}, title)),
      h('div', { class: 'sheet-body' }, body),
      h('div', { class: 'sheet-actions' },
        ...buttons.map((b) =>
          h('button', {
            type: 'button',
            class: b.class,
            onclick: () => {
              const v = b.value ? b.value() : null;
              if (v === false) return;
              result = v;
              dlg.close();
            },
          }, b.label),
        ),
      ),
    );
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve(result);
    });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export const isDialogOpen = () => !!document.querySelector('dialog[open]');
