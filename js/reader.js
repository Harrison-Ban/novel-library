// txt 리더 (F16): 인코딩 자동 판별, 나눠 불러오기, 글꼴·테마·모드 설정, 읽던 위치 동기화
// 본문은 이 기기 화면에만 표시하며 다른 곳으로 보내지 않는다.
import { getLibrary, update, flush } from './library.js';
import { ops, fileTags } from './model.js';
import { openDownload } from './graph.js';
import { detectEncoding, decodeAll, ENCODINGS } from './encoding.js';
import { sheet, toast, errorMessage, writePref } from './state.js';
import { h } from './ui.js';

const PREF_KEY = 'nl.reader';
const DEFAULTS = { fontSize: 18, lineHeight: 1.8, margin: 20, theme: 'auto', mode: 'scroll' };
const DETECT_BYTES = 64 * 1024;
const BLOCK_CHARS = 32 * 1024;
const SAVE_POS_DELAY = 1500;

function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
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
  let bomLength = 0;
  let saveTimer = null;
  let pending = '';
  let decoder = null;
  let strictUtf8 = false;
  let pageWidth = 0;
  let totalChars = 0;

  const textEl = h('div', { class: 'reader-text' });
  const scroller = h('div', { class: 'reader-scroll' }, textEl);
  const statusEl = h('span', { class: 'reader-status' }, '불러오는 중…');
  const posEl = h('span', { class: 'reader-pos' });
  const tagsEl = h('span', { class: 'reader-tags' });
  const root = h('div', { class: 'reader', role: 'dialog', 'aria-label': file.name },
    h('header', { class: 'reader-bar' },
      h('button', { type: 'button', class: 'reader-btn', 'aria-label': '닫기', onclick: close }, '←'),
      h('div', { class: 'reader-title' }, file.name),
      h('button', { type: 'button', class: 'reader-btn', onclick: () => onTag?.(file.id, renderTags) }, '분류'),
      h('button', { type: 'button', class: 'reader-btn', 'aria-label': '보기 설정', onclick: openSettings }, 'Aa'),
    ),
    scroller,
    h('footer', { class: 'reader-foot' }, tagsEl, statusEl, posEl),
  );

  // ---------- 보기 설정 ----------

  function applyPrefs() {
    root.style.setProperty('--r-fs', `${prefs.fontSize}px`);
    root.style.setProperty('--r-lh', prefs.lineHeight);
    root.style.setProperty('--r-margin', `${prefs.margin}px`);
    root.dataset.theme = prefs.theme;
    root.dataset.mode = prefs.mode;
    layoutPages();
  }

  function setPref(key, value) {
    const pos = currentPos();
    prefs[key] = value;
    writePref(PREF_KEY, JSON.stringify(prefs));
    applyPrefs();
    if (restored) nextFrame().then(() => goToPos(pos));
  }

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
      stepper('글꼴 크기', 'fontSize', 1, 12, 32, (v) => `${v}px`),
      stepper('줄 간격', 'lineHeight', 0.1, 1.2, 2.6, (v) => v.toFixed(1)),
      stepper('여백', 'margin', 4, 4, 64, (v) => `${v}px`),
      choice('테마', 'theme', [['auto', '자동'], ['light', '밝게'], ['sepia', '세피아'], ['dark', '어둡게']]),
      choice('넘기기', 'mode', [['scroll', '스크롤'], ['page', '페이지']]),
      h('div', { class: 'setting-row' }, h('span', { class: 'grow' }, '인코딩'), encSelect),
      !loaded && h('p', { class: 'muted small' }, '인코딩은 다 불러온 뒤 바꿀 수 있습니다.'),
    ), [{ label: '닫기' }]);
  }

  // ---------- 위치 ----------

  const paged = () => prefs.mode === 'page';

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

  // 위치는 "전체 글자 중 몇 번째 글자가 화면 맨 위에 있는지"의 비율(0~1)로 다룬다.
  // 화면 크기·글꼴이 다른 기기에서도 같은 곳을 가리킨다.
  function currentPos() {
    if (paged()) {
      const max = scroller.scrollWidth - pageWidth;
      return max > 0 ? scroller.scrollLeft / max : 0;
    }
    if (!totalChars) return 0;
    const top = scroller.getBoundingClientRect().top;
    for (const block of textEl.children) {
      const r = block.getBoundingClientRect();
      if (r.bottom > top + 1) {
        const within = r.height > 0 ? clamp((top - r.top) / r.height, 0, 1) : 0;
        return clamp((Number(block.dataset.start) + within * block.textContent.length) / totalChars, 0, 1);
      }
    }
    return 1;
  }

  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  async function goToPos(pos) {
    if (paged()) {
      const page = Math.round(pos * (pageCount() - 1));
      scroller.scrollLeft = page * pageWidth;
    } else if (totalChars) {
      const target = pos * totalChars;
      const blocks = [...textEl.children];
      const block = blocks.findLast((b) => Number(b.dataset.start) <= target) ?? blocks[0];
      // 화면 밖 블록은 높이가 어림값이라, 그려진 뒤의 실제 높이로 몇 번 다시 맞춘다
      for (let i = 0; block && i < 4; i++) {
        const within = (target - Number(block.dataset.start)) / Math.max(1, block.textContent.length);
        const r = block.getBoundingClientRect();
        scroller.scrollTop += r.top - scroller.getBoundingClientRect().top + within * r.height;
        await nextFrame();
      }
    }
    showPos();
  }

  function showPos() {
    const pos = currentPos();
    posEl.textContent = paged() ? `${Math.round(scroller.scrollLeft / Math.max(1, pageWidth)) + 1} / ${pageCount()}` : `${Math.round(pos * 100)}%`;
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
    const pos = Math.round(currentPos() * 10000) / 10000;
    const prev = getLibrary().files[file.id]?.lastPos;
    if (prev == null || Math.abs(prev - pos) > 0.0005) update(ops.setPos(file.id, pos));
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

  // ---------- 불러오기 ----------

  function appendBlock(text) {
    textEl.append(h('div', { class: 'reader-block', 'data-start': totalChars }, text));
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
    bomLength = bom;
    // BOM 없이 UTF-8로 짐작했으면, 깨진 바이트가 나오는 순간 EUC-KR로 바꾼다
    strictUtf8 = enc === 'utf-8' && bom === 0;
    decoder = new TextDecoder(enc, { fatal: strictUtf8 });
    textEl.replaceChildren();
    totalChars = 0;
    pending = '';
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
    textEl.replaceChildren();
    totalChars = 0;
    pending = '';
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
  scroller.addEventListener('click', (e) => {
    if (window.getSelection()?.toString()) return;
    const x = e.clientX / window.innerWidth;
    if (paged() && x < 0.3) flip(-1);
    else if (paged() && x > 0.7) flip(1);
    else root.classList.toggle('bars-hidden');
  });
  let touchX = null;
  scroller.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
  scroller.addEventListener('touchend', (e) => {
    if (!paged() || touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) flip(dx < 0 ? 1 : -1);
  });
  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') close();
    else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) {
      e.preventDefault();
      flip(1);
    } else if (['ArrowLeft', 'PageUp'].includes(e.key)) {
      e.preventDefault();
      flip(-1);
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
    document.removeEventListener('keydown', onKey);
    resizeObserver.disconnect();
    root.remove();
    document.body.classList.remove('reading');
    chunks = [];
    onClose?.();
  }

  document.body.append(root);
  document.body.classList.add('reading');
  applyPrefs();
  renderTags();
  load();
  return { close };
}
