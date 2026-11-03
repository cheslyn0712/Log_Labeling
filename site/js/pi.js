// PI summary: load students' reports, enter passphrases, recompute every metric from the raw judgments.
import { h, clear, fmtNum, pct, download, readFileText, csvRow, dateStamp } from './util.js';
import { loadManifest, loadTask, loadAnswersEnc, loadExamples } from './data.js';
import { decryptAnswers } from './crypto.js';
import { computeMetrics, MODES, MODE_NAMES } from './core.js';
import { assignedGroups } from './report.js';

const main = document.getElementById('pi');
const state = { manifest: null, exampleIds: null, reports: [], pass: {}, answers: {}, tasks: {}, rows: [] };

async function init() {
  state.manifest = await loadManifest();
  const ex = await loadExamples();
  state.exampleIds = new Set(ex.examples.map((x) => x.id));
  render();
}

function render() {
  clear(main);
  main.appendChild(h('h1', null, 'Labeling summary'));
  main.appendChild(h('p', { class: 'muted small' }, `Data version ${state.manifest.version}. Everything is recomputed here from the judgments in the reports; the accuracy figures inside the reports are ignored. Nothing leaves this browser.`));

  // reports
  const fileInp = h('input', { type: 'file', multiple: true, accept: '.json,application/json', class: 'inp' });
  fileInp.addEventListener('change', async () => {
    for (const f of fileInp.files) {
      try {
        const obj = JSON.parse(await readFileText(f));
        if (obj.kind !== 'labeling-report') { alert(`${f.name}: not a labeling report.`); continue; }
        state.reports = state.reports.filter((r) => r.name !== obj.name);
        state.reports.push(obj);
      } catch { alert(`${f.name}: not valid JSON.`); }
    }
    render();
  });
  main.appendChild(h('section', { class: 'card' }, h('h3', null, '1. Students’ reports (JSON)'), fileInp,
    state.reports.length ? h('ul', { class: 'tight small' }, state.reports.map((r) => h('li', null, `${r.name} — generated ${r.generatedAt}, data version ${r.dataVersion}`,
      r.dataVersion !== state.manifest.version ? h('span', { class: 'err-text' }, ' (different data version!)') : null,
      ' ', h('button', { class: 'btn tiny ghost', onclick: () => { state.reports = state.reports.filter((x) => x !== r); render(); } }, 'remove')))) : h('p', { class: 'muted small' }, 'No reports loaded yet.')));

  // passphrases
  const needed = new Map();
  for (const r of state.reports) for (const t of r.tasks) needed.set(t.key, state.manifest.tasks.find((x) => x.key === t.key)?.display || t.display);
  const passBox = h('div', { class: 'pass-grid' });
  for (const [key, disp] of needed) {
    const inp = h('input', { class: 'inp', type: 'text', value: state.pass[key] || '', placeholder: 'passphrase', autocomplete: 'off' });
    inp.addEventListener('change', () => { state.pass[key] = inp.value.trim(); delete state.answers[key]; });
    passBox.appendChild(h('label', { class: 'row gap' }, h('span', { style: { width: '220px' } }, disp), inp, state.answers[key] ? h('span', { class: 'ok-text small' }, '✓ unlocked') : null));
  }
  const paste = h('textarea', { class: 'note', rows: '3', placeholder: 'Or paste the content of pi_private/passphrases.json here' });
  paste.addEventListener('change', () => {
    try {
      const obj = JSON.parse(paste.value);
      for (const v of Object.values(obj)) if (v && v.key && v.passphrase) { state.pass[v.key] = v.passphrase; delete state.answers[v.key]; }
      render();
    } catch { alert('Could not read that as passphrases.json.'); }
  });
  main.appendChild(h('section', { class: 'card' }, h('h3', null, '2. Passphrases'),
    needed.size ? passBox : h('p', { class: 'muted small' }, 'Load reports first.'), paste));

  const msg = h('div', { class: 'small' });
  main.appendChild(h('section', { class: 'card' }, h('h3', null, '3. Compute'),
    h('div', { class: 'row gap' }, h('button', { class: 'btn primary', disabled: !state.reports.length, onclick: async () => { msg.textContent = 'Computing…'; try { await compute(); msg.textContent = ''; render(); } catch (e) { msg.textContent = String(e.message || e); msg.className = 'form-err'; } } }, 'Compute summary'),
      state.rows.length ? h('button', { class: 'btn', onclick: exportCsv }, 'Export CSV') : null), msg));

  if (state.rows.length) main.appendChild(summaryTable());
}

async function taskJson(key) { if (!state.tasks[key]) state.tasks[key] = await loadTask(key); return state.tasks[key]; }

async function answers(key) {
  if (state.answers[key]) return state.answers[key];
  const p = state.pass[key];
  if (!p) return null;
  try {
    const a = await decryptAnswers(await loadAnswersEnc(key), p);
    if (a.task !== key) throw new Error('mismatch');
    state.answers[key] = a;
    return a;
  } catch { throw new Error(`Wrong passphrase for ${state.manifest.tasks.find((x) => x.key === key)?.display}.`); }
}

async function compute() {
  const rows = [];
  for (const r of state.reports) {
    const entries = state.manifest.students[r.name] || [];
    for (const t of r.tasks) {
      const notes = [];
      if (r.dataVersion !== state.manifest.version) notes.push('data version differs');
      const tj = await taskJson(t.key);
      const entry = entries.find((e) => e.key === t.key && (e.part || null) === (t.part || null));
      if (!entry) notes.push('task not assigned to this student');
      const assigned = entry ? assignedGroups(entry, tj, state.exampleIds) : t.groups.map((x) => x.g);
      const aset = new Set(assigned);
      const recs = t.groups.filter((x) => aset.has(x.g) && !state.exampleIds.has(tj.groups[x.g].id));
      if (recs.length !== assigned.length) notes.push(`report lists ${recs.length} of ${assigned.length} assigned groups`);
      for (const x of recs) if (x.status === 'submitted' && !t.unlockedAt) { /* fine */ }
      const ans = await answers(t.key);
      const m = computeMetrics(recs.map((x) => ({ ...x, groupsAssigned: undefined })), ans);
      // effective time: recomputed from the per-group records (never from the report's totals)
      const labelMs = recs.reduce((a, x) => a + (x.activeMs || 0), 0);
      if (m.errors.length) notes.push(...m.errors.slice(0, 3));
      rows.push({ name: r.name, display: t.display, unlocked: !!t.unlockedAt, hasAnswers: !!ans, labelMs, reviewMs: t.reviewMs || 0, m, notes });
    }
  }
  state.rows = rows;
}

const COLS = [
  ['Student', (r) => r.name],
  ['Task', (r) => r.display],
  ['Groups submitted', (r) => `${r.m.groupsSubmitted} / ${r.m.groupsAssigned}`],
  ['Effective hours', (r) => (r.labelMs / 3600000).toFixed(2)],
  ['Review hours', (r) => (r.reviewMs / 3600000).toFixed(2)],
  ...MODES.map((k) => [`Judgments: ${MODE_NAMES[k]}`, (r) => r.m.judgments[k] || 0]),
  ...MODES.map((k) => [`Coverage: ${MODE_NAMES[k]}`, (r) => (r.hasAnswers ? r.m.coverage[k] || 0 : '')]),
  ['Accuracy (member)', (r) => (r.hasAnswers ? pct(r.m.memberAccuracy) : '')],
  ['Accuracy (group)', (r) => (r.hasAnswers ? pct(r.m.groupAccuracy) : '')],
  ['Anomaly precision', (r) => (r.hasAnswers ? pct(r.m.precision) : '')],
  ['Anomaly recall', (r) => (r.hasAnswers ? pct(r.m.recall) : '')],
  ['Anomaly F1', (r) => (r.hasAnswers ? pct(r.m.f1) : '')],
  ["Can't-tell rate", (r) => (r.hasAnswers ? pct(r.m.unknownRate) : '')],
  ['Conservative accuracy', (r) => (r.hasAnswers ? pct(r.m.conservativeAccuracy) : '')],
  ['Members judged', (r) => (r.hasAnswers ? r.m.members : '')],
  ['Answer anomalies', (r) => (r.hasAnswers ? r.m.answerAnomalies : '')],
  ['Student unlocked', (r) => (r.unlocked ? 'yes' : 'no')],
  ['Notes', (r) => r.notes.join('; ')],
];

function summaryTable() {
  const wrap = h('section', { class: 'sec', style: { overflowX: 'auto' } }, h('h2', null, 'Summary (student × task)'),
    h('p', { class: 'small muted' }, 'Each task excludes its one worked-example group. Metrics use submitted (locked) groups only. Coverage counts lines for BGL / Thunderbird and blocks for HDFS.'));
  const tbl = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, COLS.map(([c]) => h('th', null, c)))),
    h('tbody', null, state.rows.map((r) => h('tr', null, COLS.map(([, f]) => { const v = f(r); return h('td', { class: typeof v === 'number' ? 'num' : '' }, typeof v === 'number' ? fmtNum(v) : v); })))));
  wrap.appendChild(tbl);
  return wrap;
}

function exportCsv() {
  const lines = [csvRow(COLS.map(([c]) => c))];
  for (const r of state.rows) lines.push(csvRow(COLS.map(([, f]) => f(r))));
  download(`labeling-summary-${dateStamp()}.csv`, lines.join('\r\n') + '\r\n', 'text/csv');
}

init().catch((e) => { main.appendChild(h('div', { class: 'notice err' }, String(e.message || e))); });
