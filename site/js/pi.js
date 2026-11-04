// PI summary: load students' reports and recompute every metric from the raw judgments.
import { h, clear, fmtNum, pct, download, readFileText, csvRow, dateStamp } from './util.js';
import { loadManifest, loadTask, loadExamples, loadAnswers } from './data.js';
import { computeMetrics, MODES, MODE_NAMES } from './core.js';
import { assignedGroups } from './report.js';

const main = document.getElementById('pi');
const state = { manifest: null, exampleIds: null, reports: [], tasks: {}, rows: [] };

async function init() {
  state.manifest = await loadManifest();
  const ex = await loadExamples();
  state.exampleIds = new Set(ex.examples.map((x) => x.id));
  render();
}

function render() {
  clear(main);
  main.appendChild(h('h1', null, 'Labeling summary'));
  main.appendChild(h('p', { class: 'muted small' }, `Data version ${state.manifest.version}. Every number is recomputed here from the judgments in the reports and the answer files; figures stored inside the reports are ignored. Nothing leaves this browser.`));

  const fileInp = h('input', { type: 'file', multiple: true, accept: '.json,application/json', class: 'inp' });
  const msg = h('div', { class: 'small' });
  fileInp.addEventListener('change', async () => {
    for (const f of fileInp.files) {
      try {
        const obj = JSON.parse(await readFileText(f));
        if (obj.kind !== 'labeling-report') { alert(`${f.name}: not a labeling report.`); continue; }
        state.reports = state.reports.filter((r) => r.name !== obj.name);
        state.reports.push(obj);
      } catch { alert(`${f.name}: not valid JSON.`); }
    }
    msg.textContent = 'Computing…';
    try { await compute(); } catch (e) { msg.textContent = String(e.message || e); msg.className = 'form-err'; return; }
    render();
  });
  main.appendChild(h('section', { class: 'card' }, h('h3', null, 'Students’ reports (JSON)'),
    h('p', { class: 'small muted' }, 'Select one or more report files; the summary updates immediately.'), fileInp, msg,
    state.reports.length ? h('ul', { class: 'tight small' }, state.reports.map((r) => h('li', null, `${r.name} — generated ${r.generatedAt}, data version ${r.dataVersion}`,
      r.dataVersion !== state.manifest.version ? h('span', { class: 'err-text' }, ' (different data version!)') : null,
      ' ', h('button', { class: 'btn tiny ghost', onclick: async () => { state.reports = state.reports.filter((x) => x !== r); await compute(); render(); } }, 'remove')))) : null));

  if (state.rows.length) main.appendChild(summaryTable());
}

async function taskJson(key) { if (!state.tasks[key]) state.tasks[key] = await loadTask(key); return state.tasks[key]; }

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
      const ans = await loadAnswers(tj, recs.filter((x) => x.status === 'submitted').map((x) => x.g));
      const m = computeMetrics(recs, ans);
      const labelMs = recs.reduce((a, x) => a + (x.activeMs || 0), 0);
      if (m.errors.length) notes.push(...m.errors.slice(0, 3));
      rows.push({ name: r.name, display: t.display, labelMs, reviewMs: t.reviewMs || 0, m, notes });
    }
  }
  state.rows = rows;
}

const COLS = [
  ['Student', (r) => r.name],
  ['Task', (r) => r.display],
  ['Groups submitted', (r) => `${r.m.groupsSubmitted} / ${r.m.groupsAssigned}`],
  ['Effective hours', (r) => (r.labelMs / 3600000).toFixed(2)],
  ['Answer-review hours', (r) => (r.reviewMs / 3600000).toFixed(2)],
  ...MODES.map((k) => [`Judgments: ${MODE_NAMES[k]}`, (r) => r.m.judgments[k] || 0]),
  ...MODES.map((k) => [`Coverage: ${MODE_NAMES[k]}`, (r) => r.m.coverage[k] || 0]),
  ['Accuracy (member)', (r) => pct(r.m.memberAccuracy)],
  ['Accuracy (group)', (r) => pct(r.m.groupAccuracy)],
  ['Anomaly precision', (r) => pct(r.m.precision)],
  ['Anomaly recall', (r) => pct(r.m.recall)],
  ['Anomaly F1', (r) => pct(r.m.f1)],
  ["Can't-tell rate", (r) => pct(r.m.unknownRate)],
  ['Conservative accuracy', (r) => pct(r.m.conservativeAccuracy)],
  ['Members judged', (r) => r.m.members],
  ['Answer anomalies', (r) => r.m.answerAnomalies],
  ['Notes', (r) => r.notes.join('; ')],
];

function summaryTable() {
  const wrap = h('section', { class: 'sec', style: { overflowX: 'auto' } }, h('h2', null, 'Summary (student × task)'),
    h('p', { class: 'small muted' }, 'Each task excludes its one worked-example group. Metrics use submitted (locked) groups only. Coverage counts lines for BGL / Thunderbird and blocks for HDFS.'),
    h('button', { class: 'btn', onclick: exportCsv }, 'Export CSV'));
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
