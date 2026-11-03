// Small shared helpers. No dependencies.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- deterministic randomness
export function hashStr(str, seed = 0) { // cyrb53
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function rng(seedStr) { // mulberry32
  let a = hashStr(seedStr) >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(arr, seedStr) {
  const a = arr.slice();
  const r = rng(seedStr);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- bitsets (coverage of messages / blocks), stored as base64
export function bitsNew(n) { return new Uint8Array(Math.ceil(n / 8)); }
export function bitsSet(b, i) { b[i >> 3] |= 1 << (i & 7); }
export function bitsHas(b, i) { return (b[i >> 3] >> (i & 7)) & 1; }
export function bitsFromList(n, list) { const b = bitsNew(n); for (const i of list) bitsSet(b, i); return b; }
export function bitsToB64(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBits(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
export function bitsIndices(b, n) { const out = []; for (let i = 0; i < n; i++) if (bitsHas(b, i)) out.push(i); return out; }

// ---- formatting
export function fmtDur(ms) {
  if (!ms || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  if (hh) return `${hh} h ${String(mm).padStart(2, '0')} min`;
  if (mm) return `${mm} min ${String(ss).padStart(2, '0')} s`;
  return `${ss} s`;
}
export function fmtHours(ms) { return (ms / 3600000).toFixed(2); }
export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function fmtNum(n) { return (n ?? 0).toLocaleString('en-US'); }
export function pct(x) { return x == null || Number.isNaN(x) ? '—' : (100 * x).toFixed(1) + '%'; }

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

export function readFileText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsText(file);
  });
}

export function csvRow(cells) {
  return cells.map((c) => {
    const s = c == null ? '' : String(c);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function dateStamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// template text with digits normalised (for "templates that differ only in numbers")
export function digitKey(tpl) { return String(tpl).replace(/\d+/g, '#'); }

export function upperBound(arr, x, key = (v) => v) { // first index with key(arr[i]) > x
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) <= x) lo = m + 1; else hi = m; }
  return lo;
}
