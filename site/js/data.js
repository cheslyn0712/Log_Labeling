// Lazy data loading with caching. Everything comes from data/ produced by the build script.
import { upperBound } from './util.js';
import { decryptGroupAnswer } from './crypto.js';

const BASE = new URL('../data/', import.meta.url).href;
const cache = new Map();          // path -> promise (promise.value set once resolved)
const LRU_MAX = 80;

function sticky(path) { return path === 'manifest.json' || path.endsWith('/task.json'); }

export function getJSON(path) {
  if (cache.has(path)) {
    const p = cache.get(path);
    cache.delete(path); cache.set(path, p);
    return p;
  }
  const p = fetch(BASE + path, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`Could not load ${path} (HTTP ${r.status})`);
    return r.json();
  }).then((v) => { p.value = v; return v; });
  p.catch(() => cache.delete(path));
  cache.set(path, p);
  let extra = cache.size - LRU_MAX;
  if (extra > 0) {
    for (const k of cache.keys()) {
      if (extra <= 0) break;
      if (!sticky(k) && k !== path) { cache.delete(k); extra--; }
    }
  }
  return p;
}

export const loadManifest = () => getJSON('manifest.json');
export const loadTask = (key) => getJSON(`tasks/${key}/task.json`);
export const loadGroup = (key, g) => getJSON(`tasks/${key}/groups/${g}.json`);
// answer of one group: lines -> [[normal, anomalous] per message]; blocks -> [0|1 per block]
const answerCache = new Map();
export function loadGroupAnswer(task, g) {
  const k = `${task.key}/${g}`;
  if (!answerCache.has(k)) {
    const p = fetch(BASE + `answers/${task.key}/${g}.json`, { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(`Could not load the answer (HTTP ${r.status})`); return r.json(); })
      .then((enc) => decryptGroupAnswer(enc, task.ak));
    p.catch(() => answerCache.delete(k));
    answerCache.set(k, p);
  }
  return answerCache.get(k);
}
// answers object for several groups, in the shape core.js expects
export async function loadAnswers(task, gs) {
  const out = { kind: task.unit === 'block' ? 'blocks' : 'lines', groups: {} };
  const list = [...gs];
  let i = 0;
  const worker = async () => { while (i < list.length) { const g = list[i++]; out.groups[g] = await loadGroupAnswer(task, g); } };
  await Promise.all(Array.from({ length: Math.min(12, list.length) }, worker));
  return out;
}

function linePath(task, i) {
  const per = task.lines_per_file || 2000;
  return `tasks/${task.key}/lines/${Math.floor(i / per)}.json`;
}
// [line_no, g, m, text]
export async function loadLine(task, i) {
  const f = await getJSON(linePath(task, i));
  return f.lines[i - f.start];
}
// synchronous lookup if the file is already loaded, else undefined
export function lineCached(task, i) {
  const p = cache.get(linePath(task, i));
  return p && p.value ? p.value.lines[i - p.value.start] : undefined;
}

export async function loadTrace(key, t) {
  const f = await getJSON(`tasks/${key}/traces/${t[0]}.json`);
  return f[t[1]];
}

// window containing global index i -> [start, end) (end is exclusive; never shown to the user)
export function windowOf(task, i) {
  const w = task.windows;
  const k = upperBound(w, i, (x) => x[0]) - 1;
  const [s, len] = w[Math.max(0, k)];
  return [s, s + len];
}

const statics = {};
function staticFile(name, kind) {
  if (!statics[name]) {
    statics[name] = fetch(new URL('../' + name, import.meta.url), { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${name}`);
      return kind === 'text' ? r.text() : r.json();
    });
  }
  return statics[name];
}
export const loadRules = () => staticFile('rules.json');
export const loadExamples = () => staticFile('examples.json');
export const loadGuide = () => staticFile('guide.md', 'text');
