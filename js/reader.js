// txt 리더 (F16 + 뷰어 추가 기능): 인코딩 자동 판별, 나눠 불러오기, 보기 설정, 읽던 위치·책갈피 동기화, 단어 찾기
// 본문은 이 기기 화면에만 표시하며 다른 곳으로 보내지 않는다. 읽기 전용(복사만 허용).
import { getLibrary, update, flush, onLibraryChange } from './library.js';
import { ops, fileTags } from './model.js';
import { openDownload } from './graph.js';
import { detectEncoding, decodeAll, ENCODINGS } from './encoding.js';
import { sheet, toast, errorMessage, writePref } from './state.js';
import { createFind } from './reader-find.js';
import { openBookmarks, snippetAt } from './reader-bookmarks.js';
import { h } from './ui.js';

// 글자 크기·여백은 화면 크기에 따라 다르므로 기기별, 나머지는 library.json으로 기기끼리 공유
const DEVICE_PREF_KEY = 'nl.reader';
const DEVICE_DEFAULTS = { fontSize: 18, margin: 20 };
const SHARED_DEFAULTS = { lineHeight: 1.8, theme: 'auto', mode: 'scroll' };
const SHARED_KEYS = Object.keys(SHARED_DEFAULTS);
const DETECT_BYTES = 64 * 1024;
const BLOCK_CHARS = 32 * 1024;
const SAVE_POS_DELAY = 1500;
const TEXT_PADDING_TOP = 16;

function readDevicePrefs() {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function loadPrefs() {
  const local = readDevicePrefs();
  const shared = getLibrary().readerPrefs;
  if (!shared) {
    // 처음 한 번: 이 기기에 있던 설정을 공유 설정으로 옮긴다
    const migrate = Object.fromEntries(SHARED_KEYS.filter((k) => local[k] != null).map((k) => [k, local[k]]));
    if (Object.keys(migrate).length) update(ops.setReaderPrefs(migrate));
  }
  return {
    ...SHARED_DEFAULTS,
    ...Object.fromEntries(SHARED_KEYS.filter((k) => local[k] != null).map((k) => [k, local[k]])),
    ...(shared ?? {}),
    ...DEVICE_DEFAULTS,
    fontSize: local.fontSize ?? DEVICE_DEFAULTS.fontSize,
    margin: local.margin ?? DEVICE_DEFAULTS.margin,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function isReadable(file) {
  return /\.txt$/i.test(file.name);
}

// onTag(fileId, done): 분류 지정 대화상자 열기, onClose(): 리더를 닫은 뒤
export function openReader(file, { onTag, onClose } = {}) {
  const prefs = loadPrefs();
  let closed = false;
  let loaded = false;
  let restored = false;
  let chunks = [];
  let encoding = null;
  let saveTimer = null;
  let pending = '';
  let decoder = null;
  let pageWidth = 0;
  let totalChars = 0;
  let blocks = []; // { el, start, text }
  let fullText = null;
  let lastChar = 0; // 마지막으로 잰 화면 맨 위 글자 (대화상자가 본문을 덮고 있을 때 쓴다)

  const textEl = h('div', { class: 'reader-text', translate: 'no' });
  const scroller = h('div', { class: 'reader-scroll' }, textEl);
  const statusEl = h('span', { class: 'reader-status' }, '불러오는 중…');
  const posEl = h('span', { class: 'reader-pos' });
  const tagsEl = h('span', { class: 'reader-tags' });
  const themeBtn = h('button', { type: 'button', class: 'reader-btn', onclick: toggleTheme });

  const find = createFind({
    getText,
    rangeFor,
    reveal,
    currentChar,
  });

  const root = h('div', { class: 'reader', role: 'dialog', 'aria-label': file.name },
    h('header', { class: 'reader-bar' },
      h('button', { type: 'button', class: 'reader-btn reader-back', onclick: close }, '← 서재'),
      h('div', { class: 'reader-title' }, file.name),
      h('div', { class: 'reader-tools' },
        h('button', { type: 'button', class: 'reader-btn', 'aria-label': '글자 작게', onclick: () => stepFont(-1) }, 'A−'),
        h('button', { type: 'button', class: 'reader-btn', 'aria-label': '글자 크게', onclick: () => stepFont(1) }, 'A+'),
        themeBtn,
        h('button', { type: 'button', class: 'reader-btn', 'aria-label': '찾기', onclick: () => find.open() }, '🔍'),
        h('button', { type: 'button', class: 'reader-btn', 'aria-label': '책갈피', onclick: showBookmarks }, '🔖'),
        h('button', { type: 'button', class: 'reader-btn', onclick: () => onTag?.(file.id, renderTags) }, '분류'),
        h('button', { type: 'button', class: 'reader-btn', 'aria-label': '보기 설정', onclick: openSettings }, 'Aa'),
      ),
    ),
    find.el,
    scroller,
    h('footer', { class: 'reader-foot' }, tagsEl, statusEl, posEl),
  );

  // ---------- 보기 설정 ----------

  function isDark() {
    return prefs.theme === 'dark' || (prefs.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyPrefs() {
    root.style.setProperty('--r-fs', `${prefs.fontSize}px`);
    root.style.setProperty('--r-lh', prefs.lineHeight);
    root.style.setProperty('--r-margin', `${prefs.margin}px`);
    root.dataset.theme = prefs.theme;
    root.dataset.mode = prefs.mode;
    themeBtn.textContent = isDark() ? '☀' : '☾';
    themeBtn.setAttribute('aria-label', isDark() ? '밝게 보기' : '어둡게 보기');
    layoutPages();
  }

  function setPref(key, value) {
    const pos = currentPos();
    prefs[key] = value;
    if (SHARED_KEYS.includes(key)) update(ops.setReaderPrefs({ [key]: value }));
    else writePref(DEVICE_PREF_KEY, JSON.stringify({ ...readDevicePrefs(), [key]: value }));
    applyPrefs();
    if (restored) nextFrame().then(() => goToPos(pos));
  }

  function stepFont(dir) {
    setPref('fontSize', clamp(prefs.fontSize + dir, 12, 32));
    toast(`글자 크기 ${prefs.fontSize}px`);
  }

  function toggleTheme() {
    setPref('theme', isDark() ? 'light' : 'dark');
  }

  // 다른 기기에서 공유 설정이 바뀌면 반영한다
  const unsubscribe = onLibraryChange((kind) => {
    if (kind !== 'data' || closed) return;
    const shared = getLibrary().readerPrefs ?? {};
    const changed = SHARED_KEYS.filter((k) => shared[k] != null && shared[k] !== prefs[k]);
    if (!changed.length) return;
    const pos = currentPos();
    for (const k of changed) prefs[k] = shared[k];
    applyPrefs();
    if (restored) nextFrame().then(() => goToPos(pos));
  });

  function stepper(label, key, step, lo, hi, fmt = (v) => v) {
    const value = h('span', { class: 'stepper-value' }, fmt(prefs[key]));
    const change = (dir) => {
      const next = clamp(Math.round((prefs[key] + dir * step) * 100) / 100, lo, hi);
      setPref(key, next);
      value.textContent = fmt(next);
    };
    return h('div', { class: 'setting-row' },
      h('span', { class: 'grow' }, label),
      h('button', { type: 'button', onclick: () => change(-1) }, '−'),
      value,
      h('button', { type: 'button', onclick: () => change(1) }, '+'),
    );
  }

  function choice(label, key, options) {
    const buttons = options.map(([v, text]) =>
      h('button', {
        type: 'button',
        class: prefs[key] === v ? 'on' : '',
        onclick: (e) => {
          setPref(key, v);
          for (const b of buttons) b.classList.toggle('on', b === e.currentTarget);
        },
      }, text),
    );
    return h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, label), h('div', { class: 'segmented' }, ...buttons));
  }

  function openSettings() {
    const encSelect = h('select', {
      disabled: !loaded,
      onchange: (e) => redecode(e.target.value),
    }, ...ENCODINGS.map((o) => h('option', { value: o.value, selected: o.value === encoding }, o.label)));
    sheet('보기 설정', h('div', { class: 'reader-settings' },
      stepper('글자 크기 (이 기기)', 'fontSize', 1, 12, 32, (v) => `${v}px`),
      stepper('여백 (이 기기)', 'margin', 4, 4, 64, (v) => `${v}px`),
      stepper('줄 간격', 'lineHeight', 0.1, 1.2, 2.6, (v) => v.toFixed(1)),
      choice('테마', 'theme', [['auto', '자동'], ['light', '밝게'], ['sepia', '세피아'], ['dark', '어둡게']]),
      choice('넘기기', 'mode', [['scroll', '스크롤'], ['page', '페이지']]),
      h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, '인코딩'), encSelect),
      h('p', { class: 'muted small' }, '줄 간격·테마·넘기기는 PC와 휴대폰이 함께 씁니다.'),
      !loaded && h('p', { class: 'muted small' }, '인코딩은 다 불러온 뒤 바꿀 수 있습니다.'),
    ), [{ label: '닫기' }]);
  }

  // ---------- 글자 위치 ↔ 화면 ----------
  // 위치는 "전체 글자 중 화면 맨 위 글자의 순번" 비율(0~1)로 다룬다. 화면 크기·글꼴이 달라도 같은 곳을 가리킨다.

  const paged = () => prefs.mode === 'page';
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function getText() {
    fullText ??= blocks.map((b) => b.text).join('');
    return fullText;
  }

  function blockIndexAt(charIndex) {
    let lo = 0;
    let hi = blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (blocks[mid].start <= charIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function rangeFor(start, length) {
    if (!blocks.length) return null;
    const b = blocks[blockIndexAt(start)];
    const node = b.el.firstChild;
    const from = start - b.start;
    if (!node || from < 0 || from + length > b.text.length) return null;
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, from + length);
    return range;
  }

  // 화면 좌표의 글자 순번
  function charAtPoint(x, y) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) ({ offsetNode: node, offset } = p);
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) ({ startContainer: node, startOffset: offset } = r);
    }
    const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : null;
    if (!el?.classList.contains('reader-block')) return null;
    return Number(el.dataset.start) + offset;
  }

  function currentChar() {
    if (!totalChars) return 0;
    if (document.querySelector('dialog[open]')) return lastChar;
    lastChar = measureChar();
    return lastChar;
  }

  function measureChar() {
    const box = scroller.getBoundingClientRect();
    if (paged()) {
      const c = charAtPoint(box.left + prefs.margin + 2, box.top + TEXT_PADDING_TOP + prefs.fontSize * 0.6);
      if (c != null) return c;
      const max = scroller.scrollWidth - pageWidth;
      return Math.round((max > 0 ? scroller.scrollLeft / max : 0) * totalChars);
    }
    // 화면 맨 위 줄의 글자를 직접 짚고, 안 되면(여백 등) 블록 높이 비율로 어림한다
    if (scroller.scrollTop > TEXT_PADDING_TOP) {
      const textLeft = textEl.getBoundingClientRect().left + prefs.margin + 2;
      const c = charAtPoint(textLeft, box.top + prefs.fontSize * prefs.lineHeight * 0.5);
      if (c != null) return c;
    }
    for (const b of blocks) {
      const r = b.el.getBoundingClientRect();
      if (r.bottom > box.top + 1) {
        const within = r.height > 0 ? clamp((box.top - r.top) / r.height, 0, 1) : 0;
        return Math.round(b.start + within * b.text.length);
      }
    }
    return totalChars;
  }

  function currentPos() {
    return totalChars ? clamp(currentChar() / totalChars, 0, 1) : 0;
  }

  // 글자가 실제로 그려진 사각형 (줄바꿈 글자면 다음 글자로)
  function charRect(c) {
    for (let i = c; i < Math.min(totalChars, c + 200); i++) {
      const r = rangeFor(i, 1)?.getBoundingClientRect();
      if (r && (r.width || r.height)) return r;
    }
    return null;
  }

  async function goToChar(c) {
    c = clamp(Math.round(c), 0, Math.max(0, totalChars - 1));
    if (!blocks.length) return;
    if (paged()) {
      const r = charRect(c);
      if (r) {
        const x = r.left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
        scroller.scrollLeft = Math.floor(x / pageWidth) * pageWidth;
      }
    } else {
      const b = blocks[blockIndexAt(c)];
      // 화면 밖 블록은 높이가 어림값이라, 그려진 뒤의 실제 높이로 몇 번 다시 맞춘다
      for (let i = 0; i < 4; i++) {
        const within = (c - b.start) / Math.max(1, b.text.length);
        const r = b.el.getBoundingClientRect();
        scroller.scrollTop += r.top - scroller.getBoundingClientRect().top + within * r.height;
        await nextFrame();
      }
    }
    showPos();
  }

  const goToPos = (pos) => goToChar(pos * totalChars);

  // 찾은 단어가 화면 위쪽 1/3쯤에 오도록
  async function reveal(start, length) {
    await goToChar(start);
    if (!paged()) {
      const r = rangeFor(start, length)?.getBoundingClientRect();
      if (r) scroller.scrollTop += r.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
    }
    onMoved();
  }

  function layoutPages() {
    if (!paged()) {
      for (const prop of ['height', 'column-width', 'column-gap']) textEl.style.removeProperty(prop);
      return;
    }
    pageWidth = scroller.clientWidth;
    textEl.style.height = `${scroller.clientHeight}px`;
    textEl.style.columnWidth = `${pageWidth - prefs.margin * 2}px`;
    textEl.style.columnGap = `${prefs.margin * 2}px`;
  }

  function pageCount() {
    return Math.max(1, Math.round(scroller.scrollWidth / Math.max(1, pageWidth)));
  }

  function showPos() {
    const pct = `${Math.round(currentPos() * 100)}%`;
    posEl.textContent = paged() ? `${pct} · ${Math.round(scroller.scrollLeft / Math.max(1, pageWidth)) + 1}/${pageCount()}` : pct;
  }

  function flip(dir) {
    if (paged()) scroller.scrollLeft = Math.round(scroller.scrollLeft / pageWidth + dir) * pageWidth;
    else scroller.scrollBy({ top: dir * scroller.clientHeight * 0.9 });
    onMoved();
  }

  let posTimer = null;
  function onMoved() {
    showPos();
    clearTimeout(posTimer);
    posTimer = setTimeout(showPos, 250);
    if (!restored) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePos, SAVE_POS_DELAY);
  }

  function savePos() {
    clearTimeout(saveTimer);
    if (!restored) return;
    // 큰 파일에서도 몇 글자 안으로 맞도록 소수 여섯째 자리까지, 20글자 넘게 움직였을 때만 저장
    const pos = Math.round(currentPos() * 1e6) / 1e6;
    const prev = getLibrary().files[file.id]?.lastPos;
    if (prev == null || Math.abs(prev - pos) * totalChars > 20) update(ops.setPos(file.id, pos));
  }

  async function restorePos() {
    const pos = getLibrary().files[file.id]?.lastPos;
    if (pos > 0) {
      await goToPos(pos);
      toast(`읽던 위치(${Math.round(pos * 100)}%)부터 이어 읽습니다`);
    }
    restored = true;
    showPos();
  }

  function showBookmarks() {
    if (!loaded) {
      toast('다 불러온 뒤 책갈피를 쓸 수 있습니다');
      return;
    }
    openBookmarks(file.id, {
      currentPos,
      snippet: (pos) => snippetAt(getText(), Math.round(pos * totalChars)),
      goToPos: async (pos) => {
        await goToPos(pos);
        onMoved();
      },
    });
  }

  // ---------- 불러오기 ----------

  function clearText() {
    textEl.replaceChildren();
    blocks = [];
    fullText = null;
    totalChars = 0;
    pending = '';
  }

  function appendBlock(text) {
    const el = h('div', { class: 'reader-block', 'data-start': totalChars }, text);
    textEl.append(el);
    blocks.push({ el, start: totalChars, text });
    totalChars += text.length;
  }

  function pushText(text, final) {
    pending += text;
    while (pending.length > BLOCK_CHARS) {
      let cut = pending.lastIndexOf('\n', BLOCK_CHARS);
      if (cut < BLOCK_CHARS / 2) cut = BLOCK_CHARS;
      appendBlock(pending.slice(0, cut + 1));
      pending = pending.slice(cut + 1);
    }
    if (final && pending) {
      appendBlock(pending);
      pending = '';
    }
  }

  function startDecoding(enc, bom) {
    encoding = enc;
    // BOM 없이 UTF-8로 짐작했으면, 깨진 바이트가 나오는 순간 EUC-KR로 바꾼다
    const strictUtf8 = enc === 'utf-8' && bom === 0;
    decoder = new TextDecoder(enc, { fatal: strictUtf8 });
    clearText();
    const all = concat(chunks);
    feed(bom ? all.subarray(bom) : all);
  }

  function feed(bytes) {
    try {
      pushText(decoder.decode(bytes, { stream: true }), false);
    } catch {
      startDecoding('euc-kr', 0);
    }
  }

  async function load() {
    try {
      const res = await openDownload(file.id);
      const total = Number(res.headers.get('content-length')) || file.size || 0;
      const reader = res.body.getReader();
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) {
          reader.cancel();
          return;
        }
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (decoder) feed(value);
        else if (received >= DETECT_BYTES) {
          const { encoding: enc, bomLength: bom } = detectEncoding(concat(chunks));
          startDecoding(enc, bom);
        }
        if (total) statusEl.textContent = `불러오는 중 ${Math.min(99, Math.round((received / total) * 100))}%`;
      }
      if (!decoder) {
        const { encoding: enc, bomLength: bom } = detectEncoding(concat(chunks));
        startDecoding(enc, bom);
      }
      try {
        pushText(decoder.decode(), true);
      } catch {
        startDecoding('euc-kr', 0);
        pushText(decoder.decode(), true);
      }
      loaded = true;
      statusEl.textContent = ENCODINGS.find((e) => e.value === encoding)?.label ?? encoding;
      layoutPages();
      requestAnimationFrame(restorePos);
    } catch (e) {
      if (closed) return;
      statusEl.textContent = '불러오지 못했습니다';
      toast(`파일을 열지 못했습니다: ${errorMessage(e)}`);
    }
  }

  function redecode(enc) {
    const pos = currentPos();
    const sniffed = detectEncoding(chunks[0] ?? new Uint8Array());
    encoding = enc;
    clearText();
    find.reset();
    pushText(decodeAll(chunks, enc, sniffed.encoding === enc ? sniffed.bomLength : 0), true);
    statusEl.textContent = ENCODINGS.find((e) => e.value === enc)?.label ?? enc;
    layoutPages();
    requestAnimationFrame(() => goToPos(pos));
  }

  // ---------- 조작 ----------

  function renderTags() {
    const lib = getLibrary();
    const names = new Map(lib.groups.flatMap((g) => (g.type === 'virtual' ? g.items.map((i) => [i.id, i]) : [])));
    tagsEl.replaceChildren(
      ...fileTags(lib, file.id).map((t) => names.get(t)).filter(Boolean)
        .map((i) => h('span', { class: 'badge', style: `--c:${i.color}` }, i.name)),
    );
  }

  scroller.addEventListener('scroll', onMoved, { passive: true });
  // 탭: 왼쪽 30% 이전, 오른쪽 30% 다음, 가운데 위아래 막대 숨기기/보이기
  scroller.addEventListener('click', (e) => {
    if (window.getSelection()?.toString()) return;
    const x = e.clientX / window.innerWidth;
    if (x < 0.3) flip(-1);
    else if (x > 0.7) flip(1);
    else root.classList.toggle('bars-hidden');
  });
  // 페이지 모드: 좌우로 밀어 넘기기 (스크롤 모드는 위아래로 밀면 그대로 스크롤된다)
  let touchX = null;
  scroller.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
  scroller.addEventListener('touchend', (e) => {
    if (!paged() || touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) flip(dx < 0 ? 1 : -1);
  });

  // 읽기 전용: 끌어다 놓기·붙여넣기·입력을 막는다 (복사는 허용)
  const isFindInput = (t) => t instanceof Element && !!t.closest('.find-bar');
  textEl.addEventListener('dragstart', (e) => e.preventDefault());
  for (const type of ['paste', 'drop', 'beforeinput', 'cut']) {
    root.addEventListener(type, (e) => {
      if (!isFindInput(e.target)) e.preventDefault();
    });
  }
  root.addEventListener('dragover', (e) => e.preventDefault());

  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      find.open();
      return;
    }
    if (e.key === 'Escape') {
      if (find.isOpen()) find.close();
      else close();
      return;
    }
    if (isFindInput(e.target) || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const line = prefs.fontSize * prefs.lineHeight * 2;
    if (['ArrowRight', 'PageDown'].includes(e.key) || (e.key === ' ' && !e.shiftKey)) {
      e.preventDefault();
      flip(1);
    } else if (['ArrowLeft', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey)) {
      e.preventDefault();
      flip(-1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      if (paged()) flip(dir);
      else {
        scroller.scrollBy({ top: dir * line });
        onMoved();
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      goToPos(e.key === 'Home' ? 0 : 1).then(onMoved);
    }
  }
  document.addEventListener('keydown', onKey);
  const resizeObserver = new ResizeObserver(() => {
    if (!paged()) return;
    const pos = currentPos();
    layoutPages();
    if (restored) goToPos(pos);
  });
  resizeObserver.observe(scroller);

  function close() {
    if (closed) return;
    closed = true;
    savePos();
    flush();
    find.close();
    unsubscribe();
    document.removeEventListener('keydown', onKey);
    resizeObserver.disconnect();
    root.remove();
    document.body.classList.remove('reading');
    chunks = [];
    blocks = [];
    fullText = null;
    onClose?.();
  }

  document.body.append(root);
  document.body.classList.add('reading');
  applyPrefs();
  renderTags();
  load();
  return { close };
}
