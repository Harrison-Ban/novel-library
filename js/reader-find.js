// 리더 단어 찾기: 일치 항목 강조, "3/15" 건수, 이전·다음 이동
// 불러온 전체 글에서 찾으므로 아직 화면에 그려지지 않은 부분까지 센다.
// 강조는 CSS Custom Highlight API로 본문을 고치지 않고 색만 칠한다.
import { h } from './ui.js';

const MAX_HIGHLIGHTS = 2000; // 이보다 많으면 지금 항목 근처만 칠한다
const SEARCH_DELAY = 200;

const supportsHighlight = () => typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';

// reader: { getText(), rangeFor(start, length), reveal(start), currentChar() }
export function createFind(reader) {
  let matches = [];
  let index = -1;
  let query = '';
  let timer = null;

  const input = h('input', {
    type: 'search',
    class: 'find-input',
    placeholder: '본문에서 찾기',
    enterkeyhint: 'search',
    'aria-label': '찾을 단어',
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(input.value), SEARCH_DELAY);
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        if (input.value !== query) search(input.value);
        else move(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
  });
  const countEl = h('span', { class: 'find-count', 'aria-live': 'polite' }, '');
  const el = h('div', { class: 'find-bar', hidden: true },
    input,
    countEl,
    h('button', { type: 'button', class: 'reader-btn', 'aria-label': '이전 찾기', onclick: () => move(-1) }, '▲'),
    h('button', { type: 'button', class: 'reader-btn', 'aria-label': '다음 찾기', onclick: () => move(1) }, '▼'),
    h('button', { type: 'button', class: 'reader-btn', 'aria-label': '찾기 닫기', onclick: close }, '✕'),
  );

  function search(q) {
    query = q;
    matches = [];
    index = -1;
    if (q) {
      const text = reader.getText();
      // 영문은 대소문자를 가리지 않는다 (길이가 바뀌는 특수 문자가 있으면 그대로 비교)
      const fold = /[A-Za-z]/.test(q) && text.toLowerCase().length === text.length;
      const hay = fold ? text.toLowerCase() : text;
      const needle = fold ? q.toLowerCase() : q;
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) matches.push(i);
      // 지금 읽는 곳 다음의 첫 항목부터
      const here = reader.currentChar();
      index = matches.length ? Math.max(0, matches.findIndex((m) => m >= here)) : -1;
    }
    paint();
    if (index >= 0) reader.reveal(matches[index], query.length);
  }

  function move(dir) {
    if (!matches.length) return;
    index = (index + dir + matches.length) % matches.length;
    paint();
    reader.reveal(matches[index], query.length);
  }

  function paint() {
    countEl.textContent = query ? (matches.length ? `${index + 1}/${matches.length}` : '0건') : '';
    if (!supportsHighlight()) return;
    CSS.highlights.delete('nl-find');
    CSS.highlights.delete('nl-find-current');
    if (!matches.length) return;
    let from = 0;
    let to = matches.length;
    if (matches.length > MAX_HIGHLIGHTS) {
      from = Math.max(0, index - MAX_HIGHLIGHTS / 2);
      to = Math.min(matches.length, from + MAX_HIGHLIGHTS);
    }
    const all = [];
    for (let i = from; i < to; i++) {
      const r = reader.rangeFor(matches[i], query.length);
      if (r) all.push(r);
    }
    CSS.highlights.set('nl-find', new Highlight(...all));
    const current = reader.rangeFor(matches[index], query.length);
    if (current) CSS.highlights.set('nl-find-current', new Highlight(current));
  }

  function open() {
    el.hidden = false;
    input.focus();
    input.select();
  }

  function close() {
    el.hidden = true;
    clearTimeout(timer);
    if (supportsHighlight()) {
      CSS.highlights.delete('nl-find');
      CSS.highlights.delete('nl-find-current');
    }
    input.blur();
  }

  // 본문을 다시 그리면(인코딩 변경) 찾기 결과를 지운다
  function reset() {
    matches = [];
    index = -1;
    query = '';
    input.value = '';
    paint();
  }

  return { el, open, close, reset, isOpen: () => !el.hidden, hasFocus: () => document.activeElement === input };
}
