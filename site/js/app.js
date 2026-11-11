// Labeling site: boot, participant login, routing, home, guide, rules, results & backup.
import { h, clear, fmtNum, fmtTime, download, readFileText, dateStamp } from './util.js';
import { loadManifest, loadTask, loadRules, loadExamples, loadGuide, loadConfig, loadAnswers } from './data.js';
import { Store, storageAvailable, canonicalName, getCurrentName, setCurrentName } from './store.js';
import { Timer } from './timer.js';
import { renderMarkdown } from './md.js';
import { renderTask, renderGroup, renderExample, exampleLinks, watchExternal, firstUnlabeled } from './pages.js';
import { taskRef, assignedGroups, groupTruth, taskSummary, taskTime, workbook, pct, f1s, hm, LABEL_NAMES } from './report.js';
import { makeXlsx } from './xlsx.js';

export const DATASET_NAMES = { bgl: 'BGL', tb: 'Thunderbird', hdfs: 'HDFS' };
const BACKUP_MINUTES = 30;
const BACKUP_GROUPS = 50;

export const App = {
  manifest: null, rules: null, examples: null, config: {}, exampleIds: new Set(),
  store: null, timer: null, name: null, entries: [], tasks: {},
  onExternal: null,
  go(hash) { if (location.hash === hash) route(); else location.hash = hash; },
};

export function entryByRef(ref) { return App.entries.find((e) => taskRef(e) === ref); }
export async function taskJson(key) { if (!App.tasks[key]) App.tasks[key] = await loadTask(key); return App.tasks[key]; }

export function refText(display) {
  const r = App.config.timeReference?.[display.replace(/\s*\(.*\)$/, '')];
  return r ? `Reference time: about ${r.typical} h (range ${r.low}–${r.high} h) of effective labeling.` : '';
}

const root = document.getElementById('app');
const topbar = h('header', { class: 'topbar' });
const banner = h('div', { class: 'banners' });
const main = h('main', { class: 'main' });

function fatal(title, msg) {
  clear(root);
  root.appendChild(h('div', { class: 'center-card' }, h('h1', null, title), h('p', null, msg)));
}

async function boot() {
  if (!storageAvailable()) {
    fatal('Local storage is not available', 'This site keeps your work in your browser’s local storage, which is blocked here (for example in a private / incognito window). Open the site in a normal browser window.');
    return;
  }
  try {
    [App.manifest, App.rules, App.examples, App.config] = await Promise.all([loadManifest(), loadRules(), loadExamples(), loadConfig().catch(() => ({}))]);
  } catch (e) {
    fatal('Could not load the site data', String(e.message || e));
    return;
  }
  App.exampleIds = new Set(App.examples.examples.map((x) => x.id));
  App.timer = new Timer();
  if (App.config.idleSeconds) App.timer.idleMs = App.config.idleSeconds * 1000;
  clear(root);
  root.append(topbar, banner, main);
  const cur = getCurrentName();
  if (cur && App.manifest.students[cur]) await login(cur, true);
  window.addEventListener('hashchange', route);
  route();
}

async function login(name, silent) {
  App.store?.close();
  App.name = name;
  App.store = new Store(name, App.manifest);
  App.entries = App.manifest.students[name];
  setCurrentName(name);
  App.timer.attach(App.store);
  App.store.onChange(() => renderBanners());
  App.store.onExternal((kind) => {
    if (kind === 'wiped') {
      App.timer.setContext(null);
      App.timer.attach(null);
      fatal('Local data cleared', `Participant ${name}’s data was deleted in another window. Reload this page.`);
      return;
    }
    renderBanners();
    App.onExternal?.();
  });
  if (!silent) App.store.act('login', {});
}

function logout() {
  App.timer.setContext(null);
  App.timer.attach(null);
  App.store?.close();
  App.name = null; App.store = null; App.entries = [];
  setCurrentName(null);
}

// ------------------------------------------------------------------ layout pieces
function renderTopbar() {
  clear(topbar);
  topbar.appendChild(h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, '▍'), 'Log Labeling Study'));
  const nav = h('nav', { class: 'nav' });
  if (App.name) {
    nav.appendChild(h('a', { href: '#/' }, 'Home'));
    nav.appendChild(h('a', { href: '#/guide' }, 'Guide'));
    nav.appendChild(h('a', { href: '#/rules' }, 'Rules'));
    nav.appendChild(h('a', { href: '#/results' }, 'Results'));
  }
  topbar.appendChild(nav);
  topbar.appendChild(h('span', { class: 'grow' }));
  if (App.name) topbar.appendChild(h('span', { class: 'who' }, `Participant ${App.name}`));
}

function labeledCount() {
  let n = 0;
  for (const t of Object.values(App.store.state.tasks)) for (const g of Object.values(t.groups)) if (g.label) n++;
  return n;
}

function renderBanners() {
  clear(banner);
  const st = App.store;
  if (!st) return;
  if (st.saveError) banner.appendChild(h('div', { class: 'banner err' }, 'Your browser refused to save (storage full?). Download a backup from Results now.'));
  const b = st.state.backup;
  const n = labeledCount();
  if (!n) return;
  let firstAt = Infinity;
  for (const t of Object.values(st.state.tasks)) for (const g of Object.values(t.groups)) if (g.at) firstAt = Math.min(firstAt, g.at);
  const since = (Date.now() - (b.lastAt || firstAt)) / 60000;
  const changed = !b.lastAt || st.state.updatedAt > b.lastAt + 1000;
  const newSince = n - (b.labeledAt || 0);
  if (changed && (since > BACKUP_MINUTES || newSince >= BACKUP_GROUPS)) {
    banner.appendChild(h('div', { class: 'banner warn' },
      b.lastAt ? `Last backup ${fmtTime(b.lastAt)}. ` : 'No backup yet. ',
      h('button', { class: 'btn tiny', onclick: exportBackup }, 'Download backup')));
  }
}
setInterval(() => { if (App.store) renderBanners(); }, 60000);

export function exportBackup() {
  const st = App.store;
  App.timer.tick(); App.timer.flush();
  st.act('backup-export', {}, (s) => { s.backup = { lastAt: Date.now(), labeledAt: labeledCount() }; });
  download(`labeling-backup-${st.name}-${dateStamp()}.json`, JSON.stringify(st.backupPayload()));
  renderBanners();
}

// ------------------------------------------------------------------ router
let routeSeq = 0;
async function route() {
  const seq = ++routeSeq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  App.timer?.setContext(null);
  App.cleanup?.();
  App.cleanup = null;
  App.onExternal = null;
  renderTopbar();
  renderBanners();
  clear(main);
  main.className = 'main';
  window.scrollTo(0, 0);
  if (!App.name) { renderLogin(); return; }
  try {
    const [a, b, c, d] = parts;
    if (!a) await renderHome();
    else if (a === 'guide') await renderGuide();
    else if (a === 'rules') renderRules();
    else if (a === 'results') await renderResults();
    else if (a === 'example') await renderExample(main, b, c);
    else if (a === 'task' && b && !c) await renderTask(main, b);
    else if (a === 'task' && c === 'g') await renderGroup(main, b, +d);
    else main.appendChild(h('p', null, 'Page not found. ', h('a', { href: '#/' }, 'Home')));
  } catch (e) {
    if (seq !== routeSeq) return;
    console.error(e);
    main.appendChild(h('div', { class: 'notice err' }, 'Something went wrong: ' + (e.message || e)));
  }
}
App.route = route;

// ------------------------------------------------------------------ pages
function renderLogin() {
  const codes = Object.keys(App.manifest.students);
  const inp = h('input', { class: 'inp big', placeholder: 'Participant code', autocomplete: 'off', autofocus: true });
  const err = h('div', { class: 'form-err' });
  const form = h('form', { class: 'center-card login' },
    h('h1', null, 'Log Labeling Study'),
    h('p', null, `Enter your participant code (${codes.join(', ')}).`),
    inp, err,
    h('button', { class: 'btn primary big', type: 'submit' }, 'Continue'),
    h('p', { class: 'small muted' }, 'Use only your own code. Your work is saved in this browser.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = canonicalName(inp.value, codes);
    if (!n) { err.textContent = `Unknown code. Use one of ${codes.join(', ')}.`; return; }
    await login(n);
    route();
  });
  main.appendChild(form);
  setTimeout(() => inp.focus(), 0);
}

async function renderHome() {
  const st = App.store;
  const tjs = await Promise.all(App.entries.map((e) => taskJson(e.key)));
  main.appendChild(h('div', { class: 'hello' }, h('h1', null, `Participant ${App.name}`),
    h('button', { class: 'btn ghost small', onclick: () => {
      if (!confirm('Switch to another participant code? Nothing is deleted.')) return;
      st.act('logout', {}); logout(); route();
    } }, 'Switch participant')));

  const box = h('div', { class: 'task-list' });
  let totalMs = 0;
  App.entries.forEach((e, k) => {
    const tj = tjs[k];
    const ref = taskRef(e);
    const assigned = assignedGroups(e, tj, App.exampleIds);
    const t = st.task(ref);
    const done = assigned.filter((g) => t?.groups[g]?.label).length;
    const ms = taskTime(t).total;
    totalMs += ms;
    const next = t ? firstUnlabeled(t) : null;
    box.appendChild(h('div', { class: 'task-card' },
      h('div', { class: 'task-num' }, String(k + 1)),
      h('div', { class: 'task-main' },
        h('div', { class: 'task-title' }, h('a', { href: `#/task/${ref}` }, e.display)),
        h('div', { class: 'small muted' }, `${fmtNum(assigned.length)} groups · ${DATASET_NAMES[tj.dataset]}`),
        h('div', { class: 'small ref' }, refText(e.display)),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * done / Math.max(1, assigned.length)) + '%' } })),
        h('div', { class: 'small' }, `${fmtNum(done)} / ${fmtNum(assigned.length)} labeled · time so far ${hm(ms)}`),
        h('div', null, exampleLinks(tj.dataset))),
      h('div', { class: 'task-act' }, h('a', { class: 'btn primary', href: t && next != null && done ? `#/task/${ref}/g/${next}` : `#/task/${ref}` }, done ? (done < assigned.length ? 'Continue →' : 'Open') : 'Start →'))));
  });
  main.appendChild(h('section', { class: 'sec' }, h('h2', null, 'Your tasks', h('span', { class: 'muted small' }, ' — any order')), box,
    h('p', { class: 'small muted' }, `Time so far: ${hm(totalMs)}. ${App.config.timeReferenceNote || ''}`)));

  main.appendChild(h('section', { class: 'sec card' },
    h('h3', null, 'How to label'),
    h('ol', { class: 'tight' },
      h('li', null, 'Open a task and a group. Read its messages (BGL / Thunderbird) or block logs (HDFS).'),
      h('li', null, 'Give the whole group one label: Normal, Anomalous or Can’t tell (keys 1 / 2 / 3). It is saved at once; you can change it.'),
      h('li', null, 'Rule and note are optional. The ', h('a', { href: '#/guide' }, 'Guide'), ' and ', h('a', { href: '#/rules' }, 'Rules'), ' say how to decide.'),
      h('li', null, 'The task timer runs while you work on a group; use Pause for breaks and Adjust to correct it.'),
      h('li', null, 'When done, download your Excel file from ', h('a', { href: '#/results' }, 'Results'), ' and send it to the PI.'))));
  watchExternal(() => JSON.stringify(Object.values(App.store.state.tasks).map((t) => Object.values(t.groups).filter((g) => g.label).length)));
}

async function renderGuide() {
  const md = await loadGuide();
  main.appendChild(h('article', { class: 'prose', html: renderMarkdown(md) }));
}

function renderRules() {
  const box = h('article', { class: 'prose wide' }, h('h1', null, 'Rules'), h('p', { class: 'muted' }, `Rule list version ${App.rules.version}. Citing a rule with a label is optional.`));
  for (const ds of ['bgl', 'tb', 'hdfs', '*']) {
    const rs = App.rules.rules.filter((r) => r.dataset === ds);
    if (!rs.length) continue;
    box.appendChild(h('h2', null, ds === '*' ? 'All datasets' : DATASET_NAMES[ds]));
    box.appendChild(h('table', { class: 'rules-table' }, h('thead', null, h('tr', null, h('th', null, 'Id'), h('th', null, 'Label'), h('th', null, 'Rule'))),
      h('tbody', null, rs.map((r) => h('tr', null, h('td', null, h('code', null, r.id)), h('td', null, h('span', { class: 'pill lab-' + r.label }, LABEL_NAMES[r.label] || r.label)),
        h('td', null, h('strong', null, r.title), h('div', { class: 'small' }, r.text)))))));
  }
  main.appendChild(box);
}

// truths of the labeled groups of every task (answers are fetched only here, for labeled groups)
async function collect() {
  const items = [];
  for (const e of App.entries) {
    const tj = await taskJson(e.key);
    const ref = taskRef(e);
    const assigned = assignedGroups(e, tj, App.exampleIds);
    const t = App.store.task(ref);
    const labeled = assigned.filter((g) => t?.groups[g]?.label);
    const ans = await loadAnswers(tj, labeled);
    const truths = new Map(labeled.map((g) => [g, groupTruth(ans.groups[g], ans.kind)]));
    items.push({ entry: e, tj, t, assigned, truths, unit: tj.unit === 'block' ? 'blocks' : 'lines' });
  }
  return items;
}

async function renderResults() {
  const st = App.store;
  App.timer.tick(); App.timer.flush();
  main.appendChild(h('h1', null, 'Results'));
  const ld = h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Computing…');
  main.appendChild(ld);
  const items = await collect();
  ld.remove();
  const tbl = h('table', { class: 'tbl results' },
    h('thead', null, h('tr', null, ['Task', 'Labeled', 'Time', 'Accuracy', 'F1 (anomalous)', 'Can’t tell'].map((x) => h('th', null, x)))),
    h('tbody', null, items.map((it) => {
      const s = taskSummary(it.t, it.assigned, it.truths);
      return h('tr', null, h('td', null, it.entry.display), h('td', { class: 'num' }, `${fmtNum(s.labeled)} / ${fmtNum(s.groups)}`), h('td', { class: 'num' }, hm(s.time.total)),
        h('td', { class: 'num' }, pct(s.group.accuracy)), h('td', { class: 'num' }, f1s(s.group.f1)), h('td', { class: 'num' }, pct(s.group.cantTell)));
    })));
  const msg = h('span', { class: 'small ok-text' });
  main.appendChild(h('section', { class: 'card' },
    h('h3', null, `Participant ${App.name}`),
    tbl,
    h('p', { class: 'small muted' }, 'Per group: accuracy and F1 compare your group labels with the true group label (Anomalous if any line or block of the group is anomalous). Can’t tell is left out of accuracy and counts as a miss for F1. F1 is n/a when a task has no anomalous group. The Excel file also has line / block level figures and every label.'),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn primary', onclick: async () => {
        msg.textContent = 'Preparing…';
        const its = await collect();
        const blob = makeXlsx(workbook(App.name, App.manifest.version, its));
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `labeling-${App.name}-${dateStamp()}.xlsx` });
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
        st.act('export-xlsx', {});
        msg.textContent = 'Downloaded.';
      } }, 'Download Excel'), msg)));

  // backup
  const fileInp = h('input', { type: 'file', accept: '.json,application/json', class: 'inp' });
  const bmsg = h('div', { class: 'small' });
  fileInp.addEventListener('change', async () => {
    const f = fileInp.files[0];
    if (!f) return;
    let obj;
    try { obj = JSON.parse(await readFileText(f)); } catch { bmsg.textContent = 'This file is not valid JSON.'; bmsg.className = 'form-err'; return; }
    if (obj?.name === st.name && !confirm(`Replace participant ${st.name}’s data in this browser with the backup from ${fmtTime(obj.exportedAt)}?`)) return;
    App.timer.setContext(null);
    const err = st.importBackup(obj);
    if (err) { bmsg.textContent = err; bmsg.className = 'form-err'; return; }
    App.timer.attach(st);
    bmsg.textContent = 'Backup restored.'; bmsg.className = 'ok-text';
    renderBanners();
  });
  const wipeInp = h('input', { class: 'inp', placeholder: `Type ${st.name} to confirm` });
  main.appendChild(h('section', { class: 'card' },
    h('h3', null, 'Backup'),
    h('p', { class: 'small' }, `Last backup: ${st.state.backup.lastAt ? fmtTime(st.state.backup.lastAt) : 'never'}. A backup keeps every label and time record; restore it here on any computer.`),
    h('div', { class: 'row gap' }, h('button', { class: 'btn', onclick: () => { exportBackup(); setTimeout(route, 300); } }, 'Download backup'), fileInp), bmsg));
  main.appendChild(h('section', { class: 'card danger' },
    h('h3', null, 'Clear this browser'),
    h('p', { class: 'small' }, `Deletes participant ${st.name}’s data from this browser only. Download a backup first.`),
    h('div', { class: 'row gap' }, wipeInp, h('button', { class: 'btn danger', onclick: () => {
      if (wipeInp.value.trim().toUpperCase() !== st.name.toUpperCase()) { alert(`Type ${st.name} to confirm.`); return; }
      App.timer.setContext(null);
      App.timer.store = null;
      st.wipe(); logout(); location.hash = '#/'; location.reload();
    } }, 'Delete local data'))));
}

boot();
