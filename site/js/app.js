// Student site: boot, name gate, routing, dashboard, guide, rules, backup, report.
import { h, clear, fmtDur, fmtTime, fmtNum, download, readFileText, dateStamp, pct } from './util.js';
import { loadManifest, loadTask, loadRules, loadExamples, loadGuide } from './data.js';
import { Store, storageAvailable, canonicalName, getCurrentName, setCurrentName } from './store.js';
import { Timer } from './timer.js';
import { renderMarkdown } from './md.js';
import { taskRef, assignedGroups, taskSummary, summaryText, summaryCsv, hours, pct as pctR } from './report.js';
import { renderTask, renderGroup, renderExample, watchExternal, ensureResults } from './pages.js';

// Reference effective times (instructions §9)
export const REF_TIMES = {
  'BGL Task A': ['about 3.5 h', '2–6.5 h'],
  'BGL Task B': ['about 8 h', '4.5–14.5 h'],
  'Thunderbird Task B': ['about 5.5 h', '3.5–9.5 h'],
  'Thunderbird Task A': ['about 9 h', '5.5–15.5 h'],
  'HDFS Task A': ['about 2 h', '1–3.5 h'],
  'HDFS Task B': ['about 3.5 h', '2–5.5 h'],
};
const STUDENT_TIMES = { Kaiyi: ['about 14.5 h', '8–25 h'], Ruiheng: ['about 12.5 h', '7–21 h'], Qinyang: ['about 13.5 h', '7.5–24 h'] };
export const DATASET_NAMES = { bgl: 'BGL', tb: 'Thunderbird', hdfs: 'HDFS' };
const BACKUP_MINUTES = 30;
const BACKUP_GROUPS = 20;

export const App = {
  manifest: null, rules: null, examples: null, exampleIds: new Set(),
  store: null, timer: null, name: null, entries: [], tasks: {}, answers: {},
  afterExample: {},   // dataset -> page to open after its worked example
  onExternal: null,   // current page's reaction to changes saved by another window
  go(hash) { if (location.hash === hash) route(); else location.hash = hash; },
};

export function refTime(display) {
  const base = display.replace(/\s*\(.*\)$/, '');
  return REF_TIMES[base] || null;
}
export function entryByRef(ref) { return App.entries.find((e) => taskRef(e) === ref); }
export async function taskJson(key) { if (!App.tasks[key]) App.tasks[key] = await loadTask(key); return App.tasks[key]; }

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
    fatal('Local storage is not available', 'This site keeps your progress in your browser’s local storage, which is blocked or unavailable here (for example in a private / incognito window, or with site data disabled). Open the site in a normal window of Chrome, Edge, Firefox or Safari with site data allowed.');
    return;
  }
  try {
    [App.manifest, App.rules, App.examples] = await Promise.all([loadManifest(), loadRules(), loadExamples()]);
  } catch (e) {
    fatal('Could not load the site data', String(e.message || e));
    return;
  }
  App.exampleIds = new Set(App.examples.examples.map((x) => x.id));
  App.timer = new Timer();
  clear(root);
  root.appendChild(topbar);
  root.appendChild(banner);
  root.appendChild(main);
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
  App.answers = {};
  setCurrentName(name);
  App.timer.attach(App.store);
  App.store.onChange(() => renderBanners());
  // other windows of the same browser may save progress at any time
  App.store.onExternal((kind) => {
    if (kind === 'wiped') {
      App.timer.setContext(null);
      App.timer.attach(null);
      fatal('Local data cleared', `${name}’s progress was deleted in another window. Reload this page.`);
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
    nav.appendChild(h('a', { href: '#/backup' }, 'Results & backup'));
  }
  topbar.appendChild(nav);
  topbar.appendChild(h('span', { class: 'grow' }));
  if (App.name) topbar.appendChild(h('span', { class: 'who' }, App.name));
}


function renderBanners() {
  clear(banner);
  const st = App.store;
  if (!st) return;
  if (st.saveError) banner.appendChild(h('div', { class: 'banner err' }, 'Your browser refused to save progress (storage full?). Export a backup now from “Results & backup” and contact the PI.'));
  const b = st.state.backup;
  const anyWork = Object.values(st.state.tasks).some((t) => Object.values(t.groups).some((g) => g.judgments?.length || g.status === 'submitted'));
  if (!anyWork) return;
  let firstWork = Infinity;
  for (const t of Object.values(st.state.tasks)) for (const g of Object.values(t.groups)) if (g.submittedAt) firstWork = Math.min(firstWork, g.submittedAt);
  const since = (Date.now() - (b.lastAt || firstWork)) / 60000;
  const changedSince = !b.lastAt || st.state.updatedAt > b.lastAt + 1000;
  if ((since > BACKUP_MINUTES && changedSince) || (b.groupsSince || 0) >= BACKUP_GROUPS) {
    banner.appendChild(h('div', { class: 'banner warn' },
      b.lastAt ? `Last backup ${fmtTime(b.lastAt)}${b.groupsSince ? ` · ${b.groupsSince} group(s) submitted since` : ''}. ` : 'You have not exported a backup yet. ',
      h('button', { class: 'btn tiny', onclick: exportBackup }, 'Export backup now')));
  }
}
setInterval(() => { if (App.store) renderBanners(); }, 60000);

export function exportBackup() {
  const st = App.store;
  App.timer.tick();
  st.markBackup();
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
    else if (a === 'backup') await renderBackup();
    else if (a === 'example') await renderExample(main, b);
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
  const inp = h('input', { class: 'inp big', placeholder: 'Your first name', autocomplete: 'off', autofocus: true });
  const err = h('div', { class: 'form-err' });
  const form = h('form', { class: 'center-card login' },
    h('h1', null, 'Log Labeling Study'),
    h('p', null, 'Enter your name to open your tasks.'),
    inp, err,
    h('button', { class: 'btn primary big', type: 'submit' }, 'Continue'),
    h('p', { class: 'small muted' }, 'Your name only keeps your work separate from other students’ in this browser; it is not a password. Always use your own name.'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = canonicalName(inp.value, Object.keys(App.manifest.students));
    if (!n) { err.textContent = 'No such name found. Check the spelling or contact the PI.'; return; }
    await login(n);
    route();
  });
  main.appendChild(form);
  setTimeout(() => inp.focus(), 0);
}

function taskProgress(e, tj) {
  const ref = taskRef(e);
  const t = App.store.task(ref);
  const assigned = assignedGroups(e, tj, App.exampleIds);
  let done = 0, ms = 0, timedDone = 0, timedMs = 0;
  for (const g of assigned) {
    const s = t?.groups[g];
    if (!s) continue;
    ms += s.activeMs || 0;
    if (s.status === 'submitted') {
      done++;
      if (!s.mergedInto) { timedDone++; timedMs += s.activeMs || 0; }
    }
  }
  const members = assigned.reduce((a, g) => a + tj.groups[g].n, 0);
  const remaining = assigned.length - done;
  const est = timedDone >= 3 ? (timedMs / timedDone) * remaining : null;
  return { ref, t, assigned, done, ms, members, remaining, est, timedDone };
}
export { taskProgress };

async function renderHome() {
  const st = App.store;
  const tjs = await Promise.all(App.entries.map((e) => taskJson(e.key)));
  await Promise.all(App.entries.map((e, k) => ensureResults(taskRef(e), tjs[k]).catch(() => {})));
  main.appendChild(h('div', { class: 'hello' }, h('h1', null, `Hello, ${App.name}`),
    h('button', { class: 'btn ghost small', onclick: () => {
      if (!confirm('Switch to another name? Nothing is deleted: each name’s progress stays in this browser.')) return;
      st.act('logout', {}); logout(); route();
    } }, 'Not you? Switch name')));

  // one card per task; the dataset's worked example sits under its task
  const tasksBox = h('div', { class: 'task-list' });
  let totalEst = 0, estKnown = true, totalMs = 0;
  App.entries.forEach((e, k) => {
    const tj = tjs[k];
    const p = taskProgress(e, tj);
    totalMs += p.ms;
    if (p.remaining) { if (p.est != null) totalEst += p.est; else estKnown = false; }
    const rt = refTime(e.display);
    const exSeen = st.state.examples[tj.dataset]?.seenAt;
    const label = p.done ? (p.remaining ? 'Continue →' : 'Open') : 'Start →';
    const sum = taskSummary(p.t, p.assigned);
    tasksBox.appendChild(h('div', { class: 'task-card' },
      h('div', { class: 'task-num' }, String(k + 1)),
      h('div', { class: 'task-main' },
        h('div', { class: 'task-title' }, h('a', { href: `#/task/${p.ref}` }, e.display)),
        h('div', { class: 'small muted' }, `${fmtNum(p.assigned.length)} groups · ${fmtNum(p.members)} ${tj.unit === 'block' ? 'blocks' : 'lines'}` + (rt ? ` · reference time ${rt[0]} (${rt[1]})` : '')),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * p.done / Math.max(1, p.assigned.length)) + '%' } })),
        h('div', { class: 'small' }, `${fmtNum(p.done)} / ${fmtNum(p.assigned.length)} groups done · labeling time ${fmtDur(p.ms)}` + (sum.accuracy != null ? ` · accuracy ${pctR(sum.accuracy)} · can't tell ${pctR(sum.cantTell)}` : ''),
          p.remaining && p.est != null ? h('span', { class: 'muted' }, ` · at your current pace, about ${fmtDur(p.est)} still needed`) : null),
        h('a', { class: 'task-example' + (exSeen ? ' seen' : ''), href: `#/example/${tj.dataset}` },
          exSeen ? `✓ ${DATASET_NAMES[tj.dataset]} worked example read` : `Worked example: read the ${DATASET_NAMES[tj.dataset]} example before your first group →`)),
      h('div', { class: 'task-act' }, h('a', { class: 'btn primary', href: `#/task/${p.ref}` }, label))));
  });

  const sref = STUDENT_TIMES[App.name];
  main.appendChild(h('section', { class: 'sec' },
    h('h2', null, 'Your tasks', h('span', { class: 'muted small' }, ' — suggested order (not enforced)')),
    tasksBox,
    h('p', { class: 'small muted' }, `Total effective labeling time so far: ${fmtDur(totalMs)}.`,
      sref ? ` Reference for your whole assignment: ${sref[0]} (range ${sref[1]}), plus about 1–1.5 h for examples and the guide.` : '',
      totalEst && estKnown ? ` At your current pace about ${fmtDur(totalEst)} remain.` : '')));

  main.appendChild(h('section', { class: 'sec' },
    h('div', { class: 'card' },
      h('h3', null, 'Before you start'),
      h('ul', { class: 'tight' },
        h('li', null, 'Read the ', h('a', { href: '#/guide' }, 'labeling guide'), ' and the ', h('a', { href: '#/rules' }, 'rule list'), '.'),
        h('li', null, 'Each task starts with its dataset’s worked example (a few minutes, not counted as labeling time).'),
        h('li', null, 'Label at most 2–3 effective hours a day and no more than 90 minutes in one sitting.'),
        h('li', null, 'After 20–30 groups, check the “at your current pace” estimate again.'),
        h('li', null, 'When you finish, send your results from ', h('a', { href: '#/backup' }, 'Results & backup'), '; export a backup there now and then.')))));
  watchHome();

  main.appendChild(h('section', { class: 'sec' }, h('h2', null, 'How time is counted'),
    h('p', { class: 'small' }, 'Effective time counts only while the page is visible, the window is in front, and you used the keyboard, mouse or scrolled within the last 60 seconds. It is recorded per group, from opening a group until you submit it, leave it, pause, or close the page. Time spent on examples and on reviewing answers is recorded separately and never counts as labeling time.'),
    h('p', { class: 'small muted' }, 'Reference effective time per group: about 1 min if it has a single message, about 2 min with a few real differences, about 4 min with many variations, about 1 extra min if you need to look up rules; HDFS groups about 1.5–3.5 min depending on the number of event orders.')));
}

function watchHome() {
  watchExternal(() => JSON.stringify([
    Object.entries(App.store.state.tasks).map(([r, t]) => [r, Object.values(t.groups).filter((g) => g.status === 'submitted').length, Object.values(t.groups).filter((g) => g.result).length]),
    Object.entries(App.store.state.examples).map(([d, x]) => [d, !!x.seenAt]),
  ]));
}

async function renderGuide() {
  const md = await loadGuide();
  main.appendChild(h('article', { class: 'prose', html: renderMarkdown(md) }));
}

function renderRules() {
  const box = h('article', { class: 'prose wide' }, h('h1', null, 'Rules'), h('p', { class: 'muted' }, `Rule list version ${App.rules.version}. Every judgment cites at least one rule; rules marked “note” require a note.`));
  for (const ds of ['bgl', 'tb', 'hdfs', '*']) {
    const rs = App.rules.rules.filter((r) => r.dataset === ds);
    if (!rs.length) continue;
    box.appendChild(h('h2', null, ds === '*' ? 'All datasets' : DATASET_NAMES[ds]));
    box.appendChild(h('table', { class: 'rules-table' }, h('thead', null, h('tr', null, h('th', null, 'Id'), h('th', null, 'Supports'), h('th', null, 'Rule'))),
      h('tbody', null, rs.map((r) => h('tr', null, h('td', null, h('code', null, r.id)), h('td', null, h('span', { class: 'pill lab-' + (r.label === '*' ? 'any' : r.label) }, r.label === '*' ? 'any' : r.label)),
        h('td', null, h('strong', null, r.title), r.note_required ? h('span', { class: 'rule-note-flag' }, 'note') : null, h('div', { class: 'small' }, r.text)))))));
  }
  main.appendChild(box);
}

async function renderBackup() {
  const st = App.store;
  await Promise.all(App.entries.map(async (e) => ensureResults(taskRef(e), await taskJson(e.key))));
  const b = st.state.backup;
  const fileInp = h('input', { type: 'file', accept: '.json,application/json', class: 'inp' });
  const msg = h('div', { class: 'small' });
  fileInp.addEventListener('change', async () => {
    const f = fileInp.files[0];
    if (!f) return;
    let obj;
    try { obj = JSON.parse(await readFileText(f)); } catch { msg.textContent = 'This file is not valid JSON.'; msg.className = 'form-err'; return; }
    if (obj?.name === st.name && !confirm(`Replace ${st.name}’s progress in this browser with the backup from ${fmtTime(obj.exportedAt)}?`)) return;
    App.timer.setContext(null);
    const err = st.importBackup(obj);
    if (err) { msg.textContent = err; msg.className = 'form-err'; return; }
    App.timer.attach(st);
    msg.textContent = 'Backup restored.'; msg.className = 'ok-text';
    renderBanners();
  });

  // results: the three numbers students send to the PI
  const rows = App.entries.map((e) => {
    const tj = App.tasks[e.key];
    return { display: e.display, unit: tj.unit === 'block' ? 'blocks' : 'lines', s: taskSummary(st.task(taskRef(e)), assignedGroups(e, tj, App.exampleIds)) };
  });
  const copyMsg = h('span', { class: 'small ok-text' });
  const results = h('section', { class: 'card' },
    h('h3', null, 'Your results'),
    h('table', { class: 'tbl results' },
      h('thead', null, h('tr', null, ['Task', 'Groups done', 'Labeling time', 'Accuracy', "Can't tell"].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map(({ display, s }) => h('tr', null,
        h('td', null, display), h('td', { class: 'num' }, `${fmtNum(s.done)} / ${fmtNum(s.groups)}`), h('td', { class: 'num' }, hours(s.ms)),
        h('td', { class: 'num' }, pctR(s.accuracy)), h('td', { class: 'num' }, pctR(s.cantTell)))))),
    h('p', { class: 'small muted' }, 'Labeling time is effective time only (answer review and examples are not included). Accuracy counts the lines (HDFS: blocks) you labeled Normal or Anomalous; “Can’t tell” is the share you labeled Can’t tell.'),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn primary', onclick: async () => {
        const txt = summaryText(st.name, rows);
        try { await navigator.clipboard.writeText(txt); copyMsg.textContent = 'Copied — paste it into your message to the PI.'; } catch { prompt('Copy this text:', txt); }
        st.act('results-copied', {});
      } }, 'Copy results as text'),
      h('button', { class: 'btn', onclick: () => { download(`labeling-results-${st.name}-${dateStamp()}.csv`, summaryCsv(st.name, rows), 'text/csv'); st.act('results-csv', {}); } }, 'Download CSV'),
      copyMsg));

  const wipeInp = h('input', { class: 'inp', placeholder: `Type ${st.name} to confirm` });
  main.appendChild(h('div', { class: 'prose wide' },
    h('h1', null, 'Results & backup'),
    results,
    h('section', { class: 'card' },
      h('h3', null, 'Backup'),
      h('p', null, `Last backup: ${b.lastAt ? fmtTime(b.lastAt) : 'never'}. A backup holds your name, every action and judgment, all time records and the data version.`),
      h('button', { class: 'btn primary', onclick: () => { exportBackup(); renderBackupSoon(); } }, 'Export backup'),
      h('h4', null, 'Restore from a backup'),
      h('p', { class: 'small muted' }, `Only a backup of ${st.name} can be restored here. It replaces ${st.name}’s progress in this browser.`),
      fileInp, msg),
    h('section', { class: 'card danger' },
      h('h3', null, 'Clear this browser'),
      h('p', { class: 'small' }, `Deletes ${st.name}’s progress from this browser only (for example after moving to another computer). Export a backup first — this cannot be undone.`),
      h('div', { class: 'row gap' }, wipeInp, h('button', { class: 'btn danger', onclick: () => {
        if (wipeInp.value.trim() !== st.name) { alert(`Type ${st.name} to confirm.`); return; }
        App.timer.setContext(null);
        App.timer.store = null;
        st.wipe(); logout(); location.hash = '#/'; location.reload();
      } }, 'Delete local data')))));
  function renderBackupSoon() { setTimeout(() => { if (location.hash === '#/backup') route(); }, 300); }
}

export function examplesSeen(ds) { return !!App.store.state.examples[ds]?.seenAt; }
export { pct };

boot();
