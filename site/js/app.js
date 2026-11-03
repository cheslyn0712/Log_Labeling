// Student site: boot, name gate, routing, dashboard, guide, rules, backup, report.
import { h, clear, fmtDur, fmtTime, fmtNum, download, readFileText, dateStamp, pct } from './util.js';
import { loadManifest, loadTask, loadRules, loadExamples, loadGuide, loadAnswersEnc } from './data.js';
import { Store, storageAvailable, canonicalName, getCurrentName, setCurrentName, hasData, claimTab, heartbeatTab } from './store.js';
import { Timer } from './timer.js';
import { renderMarkdown } from './md.js';
import { buildReport, reportCsv, taskRef, assignedGroups } from './report.js';
import { decryptAnswers } from './crypto.js';
import { renderTask, renderGroup, renderExample, renderReview, renderReviewGroup } from './pages.js';

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
  go(hash) { if (location.hash === hash) route(); else location.hash = hash; },
};

export function refTime(display) {
  const base = display.replace(/\s*\(.*\)$/, '');
  return REF_TIMES[base] || null;
}
export function entryByRef(ref) { return App.entries.find((e) => taskRef(e) === ref); }
export async function taskJson(key) { if (!App.tasks[key]) App.tasks[key] = await loadTask(key); return App.tasks[key]; }

// answers of an unlocked task (decrypted with the stored passphrase, kept in memory)
export async function answersFor(ref) {
  if (App.answers[ref]) return App.answers[ref];
  const t = App.store.task(ref);
  if (!t?.unlocked) return null;
  const e = entryByRef(ref);
  const enc = await loadAnswersEnc(e.key);
  App.answers[ref] = await decryptAnswers(enc, t.unlocked.passphrase);
  return App.answers[ref];
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
    fatal('Local storage is not available', 'This site keeps your progress in your browser’s local storage, which is blocked or unavailable here (for example in a private / incognito window, or with site data disabled). Open the site in a normal window of Chrome, Edge, Firefox or Safari with site data allowed.');
    return;
  }
  if (!claimTab(false)) {
    clear(root);
    root.appendChild(h('div', { class: 'center-card' }, h('h1', null, 'Already open in another tab'),
      h('p', null, 'The labeling site is open in another tab or window of this browser. Use that one, so that two tabs do not overwrite each other’s progress.'),
      h('button', { class: 'btn primary', onclick: () => { claimTab(true); location.reload(); } }, 'Use this tab instead')));
    return;
  }
  heartbeatTab(() => {
    App.timer?.setContext(null);
    App.timer?.flush();
    fatal('Opened in another tab', 'The site was opened in another tab, so this tab stopped to protect your progress. Close this tab and continue in the other one.');
  });
  try {
    [App.manifest, App.rules, App.examples] = await Promise.all([loadManifest(), loadRules(), loadExamples()]);
  } catch (e) {
    fatal('Could not load the site data', String(e.message || e));
    return;
  }
  App.exampleIds = new Set(App.examples.examples.map((x) => x.id));
  App.timer = new Timer();
  App.timer.onChange(() => renderTimerPill());
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
  App.name = name;
  App.store = new Store(name, App.manifest.version);
  App.entries = App.manifest.students[name];
  App.answers = {};
  setCurrentName(name);
  App.timer.attach(App.store);
  App.store.onChange(() => renderBanners());
  if (!silent) App.store.act('login', {});
}

function logout() {
  App.timer.setContext(null);
  App.timer.flush();
  App.name = null; App.store = null; App.entries = [];
  setCurrentName(null);
}

// ------------------------------------------------------------------ layout pieces
let pillEl = null;
function renderTopbar() {
  clear(topbar);
  topbar.appendChild(h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark' }, '▍'), 'Log Labeling Study'));
  const nav = h('nav', { class: 'nav' });
  if (App.name) {
    nav.appendChild(h('a', { href: '#/' }, 'Home'));
    nav.appendChild(h('a', { href: '#/guide' }, 'Guide'));
    nav.appendChild(h('a', { href: '#/rules' }, 'Rules'));
    nav.appendChild(h('a', { href: '#/backup' }, 'Backup & report'));
  }
  topbar.appendChild(nav);
  topbar.appendChild(h('span', { class: 'grow' }));
  if (App.name) {
    pillEl = h('div', { class: 'timer-pill' });
    topbar.appendChild(pillEl);
    renderTimerPill();
    topbar.appendChild(h('span', { class: 'who' }, App.name));
  }
}

function renderTimerPill() {
  if (!pillEl || !App.timer) return;
  const s = App.timer.status();
  const c = App.timer.ctx;
  clear(pillEl);
  pillEl.className = 'timer-pill st-' + s;
  const label = { timing: 'Timing', paused: 'Paused', idle: 'Idle', off: 'Not timing' }[s];
  let acc = '';
  if (c && App.store) {
    const tg = App.timer.target();
    const ms = c.type === 'label' ? tg?.activeMs : c.type === 'review' ? tg?.reviewMs : tg?.ms;
    acc = fmtDur(ms || 0);
  }
  pillEl.appendChild(h('span', { class: 'dot' }));
  pillEl.appendChild(h('span', null, label));
  if (c) {
    pillEl.appendChild(h('span', { class: 'muted' }, ` · ${c.type === 'label' ? 'this group' : c.type === 'review' ? 'answer review' : 'example'} ${acc}`));
    pillEl.appendChild(s === 'paused'
      ? h('button', { class: 'btn tiny', onclick: () => App.timer.resume() }, 'Resume')
      : h('button', { class: 'btn tiny ghost', onclick: () => App.timer.pause() }, 'Pause'));
  }
  pillEl.title = 'Effective time counts only while this page is visible, the window is focused, and you used the keyboard, mouse or scrolled within the last 60 seconds.';
}

function renderBanners() {
  clear(banner);
  const st = App.store;
  if (!st) return;
  if (st.saveError) banner.appendChild(h('div', { class: 'banner err' }, 'Your browser refused to save progress (storage full?). Export a backup now from “Backup & report” and contact the PI.'));
  if (st.versionMismatch) banner.appendChild(h('div', { class: 'banner err' }, `Your saved progress was made with data version ${st.state.dataVersion}, but the site now serves ${App.manifest.version}. Labeling is blocked; contact the PI.`));
  const b = st.state.backup;
  const anyWork = Object.values(st.state.tasks).some((t) => Object.values(t.groups).some((g) => g.judgments?.length || g.status === 'submitted'));
  if (!anyWork) return;
  const since = b.lastAt ? (Date.now() - b.lastAt) / 60000 : Infinity;
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
    else if (a === 'backup') renderBackup();
    else if (a === 'example') await renderExample(main, b);
    else if (a === 'task' && b && !c) await renderTask(main, b);
    else if (a === 'task' && c === 'g') await renderGroup(main, b, +d);
    else if (a === 'task' && c === 'review' && d == null) await renderReview(main, b);
    else if (a === 'task' && c === 'review') await renderReviewGroup(main, b, +d);
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
  main.appendChild(h('div', { class: 'hello' }, h('h1', null, `Hello, ${App.name}`),
    h('button', { class: 'btn ghost small', onclick: () => {
      if (!confirm('Switch to another name? Nothing is deleted: each name’s progress stays in this browser.')) return;
      st.act('logout', {}); logout(); route();
    } }, 'Not you? Switch name')));

  // examples first if any unseen
  const dsNeeded = [...new Set(tjs.map((t) => t.dataset))];
  const exBox = h('div', { class: 'cards three' });
  for (const ex of App.examples.examples) {
    const seen = st.state.examples[ex.dataset]?.seenAt;
    exBox.appendChild(h('a', { class: 'card link' + (seen ? '' : ' attention'), href: `#/example/${ex.dataset}` },
      h('div', { class: 'card-kicker' }, 'Worked example'),
      h('div', { class: 'card-title' }, DATASET_NAMES[ex.dataset]),
      h('div', { class: 'small ' + (seen ? 'ok-text' : 'muted') }, seen ? `Understood ${fmtTime(seen)}` : dsNeeded.includes(ex.dataset) ? 'Required before your first ' + DATASET_NAMES[ex.dataset] + ' task' : 'Optional')));
  }

  const tasksBox = h('div', { class: 'task-list' });
  let totalEst = 0, estKnown = true, totalMs = 0;
  App.entries.forEach((e, k) => {
    const tj = tjs[k];
    const p = taskProgress(e, tj);
    totalMs += p.ms;
    if (p.remaining) { if (p.est != null) totalEst += p.est; else estKnown = false; }
    const rt = refTime(e.display);
    const exSeen = st.state.examples[tj.dataset]?.seenAt;
    tasksBox.appendChild(h('div', { class: 'task-card' },
      h('div', { class: 'task-num' }, String(k + 1)),
      h('div', { class: 'task-main' },
        h('div', { class: 'task-title' }, h('a', { href: `#/task/${p.ref}` }, e.display), p.t?.unlocked ? h('span', { class: 'pill' }, 'Answers unlocked') : null),
        h('div', { class: 'small muted' }, `${fmtNum(p.assigned.length)} groups · ${fmtNum(p.members)} ${tj.unit === 'block' ? 'blocks' : 'lines'}` + (rt ? ` · reference time ${rt[0]} (${rt[1]})` : '')),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * p.done / Math.max(1, p.assigned.length)) + '%' } })),
        h('div', { class: 'small' }, `${fmtNum(p.done)} / ${fmtNum(p.assigned.length)} groups submitted · effective time ${fmtDur(p.ms)}`,
          p.remaining && p.est != null ? h('span', { class: 'muted' }, ` · at your current pace, about ${fmtDur(p.est)} still needed`) : null)),
      h('div', { class: 'task-act' },
        !exSeen ? h('a', { class: 'btn', href: `#/example/${tj.dataset}` }, 'Read example first')
          : h('a', { class: 'btn primary', href: `#/task/${p.ref}` }, p.done ? (p.remaining ? 'Continue' : 'Open') : 'Start'))));
  });

  const sref = STUDENT_TIMES[App.name];
  main.appendChild(h('section', { class: 'sec' },
    h('h2', null, 'Your tasks', h('span', { class: 'muted small' }, ' — suggested order (not enforced)')),
    tasksBox,
    h('p', { class: 'small muted' }, `Total effective labeling time so far: ${fmtDur(totalMs)}.`,
      sref ? ` Reference for your whole assignment: ${sref[0]} (range ${sref[1]}), plus about 1–1.5 h for examples and the guide.` : '',
      totalEst && estKnown ? ` At your current pace about ${fmtDur(totalEst)} remain.` : '')));
  main.appendChild(h('section', { class: 'sec' }, h('h2', null, 'Worked examples'), exBox));

  main.appendChild(h('section', { class: 'sec cols2' },
    h('div', { class: 'card' },
      h('h3', null, 'Before you start'),
      h('ul', { class: 'tight' },
        h('li', null, 'Read the ', h('a', { href: '#/guide' }, 'labeling guide'), ' and the ', h('a', { href: '#/rules' }, 'rule list'), '.'),
        h('li', null, 'Work through the worked example of each dataset; a task can start only after its example.'),
        h('li', null, 'Label at most 2–3 effective hours a day and no more than 90 minutes in one sitting.'),
        h('li', null, 'After 20–30 groups, check the “at your current pace” estimate again.'))),
    h('div', { class: 'card' },
      h('h3', null, 'Your data and honesty'),
      h('ul', { class: 'tight' },
        h('li', null, 'Progress and time are saved only in this browser. Do not use a private / incognito window and do not clear browsing data.'),
        h('li', null, 'Export a backup regularly (', h('a', { href: '#/backup' }, 'Backup & report'), '); you can restore it on another computer.'),
        h('li', null, 'Time and progress records are an honor system; your report includes the raw records so they can be checked.'),
        h('li', null, 'These datasets and their labels are public online. The answers here are encrypted only to prevent accidental viewing — you promise not to look up external labels.'),
        h('li', null, 'Answers for a task are unlocked with a passphrase the PI gives you after you finish all your tasks. Unlocking locks every judgment of that task.')))));

  main.appendChild(h('section', { class: 'sec' }, h('h2', null, 'How time is counted'),
    h('p', { class: 'small' }, 'Effective time counts only while the page is visible, the window is in front, and you used the keyboard, mouse or scrolled within the last 60 seconds. It is recorded per group, from opening a group until you submit it, leave it, pause, or close the page. Time spent on examples and on reviewing answers is recorded separately and never counts as labeling time.'),
    h('p', { class: 'small muted' }, 'Reference effective time per group: about 1 min if it has a single message, about 2 min with a few real differences, about 4 min with many variations, about 1 extra min if you need to look up rules; HDFS groups about 1.5–3.5 min depending on the number of event orders.')));
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

function renderBackup() {
  const st = App.store;
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
    const err = st.importBackup(obj, App.manifest.version);
    if (err) { msg.textContent = err; msg.className = 'form-err'; return; }
    App.timer.attach(st);
    msg.textContent = 'Backup restored.'; msg.className = 'ok-text';
    renderBanners();
  });

  const repMsg = h('div', { class: 'small' });
  const report = async (kind) => {
    repMsg.textContent = 'Preparing…';
    App.timer.tick(); App.timer.flush();
    const tasks = {};
    for (const e of App.entries) tasks[e.key] = await taskJson(e.key);
    const answersByRef = {};
    for (const e of App.entries) { const ref = taskRef(e); try { const a = await answersFor(ref); if (a) answersByRef[ref] = a; } catch { /* ignore */ } }
    const rep = buildReport({ store: st, manifest: App.manifest, entries: App.entries, tasks, exampleIds: App.exampleIds, answersByRef });
    st.act('report', { kind });
    if (kind === 'json') download(`labeling-report-${st.name}-${dateStamp()}.json`, JSON.stringify(rep));
    else download(`labeling-report-${st.name}-${dateStamp()}.csv`, reportCsv(rep), 'text/csv');
    repMsg.textContent = 'Downloaded.';
  };

  const wipeInp = h('input', { class: 'inp', placeholder: `Type ${st.name} to confirm` });
  main.appendChild(h('div', { class: 'prose wide' },
    h('h1', null, 'Backup & report'),
    h('section', { class: 'card' },
      h('h3', null, 'Backup'),
      h('p', null, `Last backup: ${b.lastAt ? fmtTime(b.lastAt) : 'never'}. A backup holds your name, every action and judgment, all time records and the data version.`),
      h('button', { class: 'btn primary', onclick: () => { exportBackup(); renderBackupSoon(); } }, 'Export backup'),
      h('h4', null, 'Restore from a backup'),
      h('p', { class: 'small muted' }, `Only a backup of ${st.name} made for data version ${App.manifest.version} can be restored here. It replaces ${st.name}’s progress in this browser.`),
      fileInp, msg),
    h('section', { class: 'card' },
      h('h3', null, 'Report for the PI'),
      h('p', null, 'The report contains your judgments, per-group effective time and view counts, unlock times, the raw time samples and, for unlocked tasks, your accuracy. Send both files to the PI when you are done.'),
      h('div', { class: 'row gap' }, h('button', { class: 'btn primary', onclick: () => report('json') }, 'Download report (JSON)'), h('button', { class: 'btn', onclick: () => report('csv') }, 'Download report (CSV)')),
      repMsg),
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
