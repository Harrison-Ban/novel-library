// 리더 책갈피: 현재 위치에 여러 개 추가, 목록에서 이동·삭제. library.json에 저장해 기기끼리 공유한다.
import { getLibrary, update } from './library.js';
import { ops, newId } from './model.js';
import { sheet, toast } from './state.js';
import { h, formatDateTime } from './ui.js';

const SNIPPET_CHARS = 24;

export function getBookmarks(fileId) {
  return getLibrary().files[fileId]?.bookmarks ?? [];
}

// 책갈피 구분용 앞부분 글자: 그 위치가 들어 있는 줄의 처음부터 보여준다
export function snippetAt(text, charIndex) {
  const lineStart = text.lastIndexOf('\n', charIndex - 1) + 1;
  const from = charIndex - lineStart <= 80 ? lineStart : charIndex;
  return text.slice(from, from + SNIPPET_CHARS * 3).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS);
}

// reader: { currentPos(), snippet(pos), goToPos(pos) }
export function openBookmarks(fileId, reader) {
  const body = h('div', { class: 'bookmarks' });

  function render() {
    const list = getBookmarks(fileId);
    body.replaceChildren(
      h('button', {
        type: 'button',
        class: 'primary bookmark-add',
        onclick: () => {
          const pos = Math.round(reader.currentPos() * 1e6) / 1e6;
          update(ops.addBookmark(fileId, { id: newId('b'), pos, snippet: reader.snippet(pos), at: new Date().toISOString() }));
          toast(`책갈피를 추가했습니다 (${Math.round(pos * 100)}%)`);
          render();
        },
      }, '＋ 현재 위치에 책갈피'),
      list.length
        ? h('ul', { class: 'bookmark-list' },
            ...list.map((b) =>
              h('li', {},
                h('button', {
                  type: 'button',
                  class: 'bookmark-go',
                  onclick: () => {
                    dlg()?.close();
                    reader.goToPos(b.pos);
                  },
                },
                  h('span', { class: 'bookmark-pct' }, `${Math.round(b.pos * 100)}%`),
                  h('span', { class: 'bookmark-snippet' }, b.snippet ? `${b.snippet}…` : '(빈 줄)'),
                  h('span', { class: 'bookmark-date muted small' }, formatDateTime(b.at)),
                ),
                h('button', {
                  type: 'button',
                  class: 'reader-btn danger',
                  'aria-label': `${Math.round(b.pos * 100)}% 책갈피 삭제`,
                  onclick: () => {
                    update(ops.removeBookmark(fileId, b.id));
                    render();
                  },
                }, '🗑'),
              ),
            ),
          )
        : h('p', { class: 'muted small' }, '아직 책갈피가 없습니다.'),
    );
  }

  const dlg = () => body.closest('dialog');
  render();
  return sheet('책갈피', body, [{ label: '닫기' }]);
}
