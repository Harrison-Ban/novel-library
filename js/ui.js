// 화면 요소를 만드는 작은 도우미. 글자는 항상 텍스트 노드로 넣어 HTML로 해석되지 않게 한다.
const PROPS = new Set(['value', 'checked', 'selected', 'open', 'disabled', 'hidden']);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val == null || val === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), val);
    else if (key === 'class') el.className = val;
    else if (PROPS.has(key)) el[key] = val;
    else el.setAttribute(key, val);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function formatSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024))} KB`;
}

export function formatDate(iso) {
  return iso ? new Date(iso).toLocaleDateString('ko-KR') : '';
}

export function formatDateTime(iso) {
  return iso
    ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
}
