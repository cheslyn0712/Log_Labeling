// Task page, labeling page (with the answer shown right after submitting), worked examples.
import { h, clear, fmtDur, fmtTime, fmtNum, seededShuffle, digitKey, pct, b64ToBits } from './util.js';
import { loadGroup, loadGroupAnswer, loadAnswers } from './data.js';
import { JudgePanel } from './judge.js';
import { mountLineGroup } from './group-lines.js';
import { mountHdfsGroup } from './group-hdfs.js';
import { judgmentAgreement, itemCounts, resolveGroup, LABEL_NAMES, MODE_NAMES } from './core.js';
import { App, entryByRef, taskJson, refTime, taskProgress, DATASET_NAMES, exportBackup } from './app.js';
import { taskRef, assignedGroups } from './report.js';

function loading(main, text = 'Loading…') { const el = h('div', { class: 'loading' }, h('span', { class: 'spinner' }), text); main.appendChild(el); return el; }

async function ctxFor(ref) {
  const e = entryByRef(ref);
  if (!e) throw new Error('This task is not assigned to you.');
  const tj = await taskJson(e.key);
  const assigned = assignedGroups(e, tj, App.exampleIds);
  return { e, tj, assigned, ref };
}

function ensureTaskState(ref, assigned) {
  return App.store.ensureTask(ref, seededShuffle(assigned, `${App.name}|${ref}`));
}

function groupTitle(tj, g) {
  const m = tj.groups[g];
  if (tj.dataset === 'hdfs') return m.ecv.map(([e, c]) => `T${e}×${c}`).join(' ');
  return m.template === '<EMPTY>' ? '(empty message)' : m.template;
}

function statusOf(t, g) {
  const s = t?.groups[g];
  if (!s) return 'todo';
  if (s.status === 'submitted') return 'done';
  if (s.status === 'merged-pending') return 'merge-pending';
  if (s.judgments?.length) return 'started';
  if (s.defers) return 'deferred';
  return 'todo';
}
const STATUS_TEXT = { todo: 'To do', started: 'In progress', deferred: 'Later', done: 'Done', 'merge-pending': 'In a merge' };

export function nextGroup(t, after) {
  const order = t.order;
  const isOpen = (g) => { const s = t.groups[g]; return !s || s.status === 'open'; };
  const start = after == null ? 0 : order.indexOf(after) + 1;
  for (let k = 0; k < order.length; k++) {
    const g = order[(start + k) % order.length];
    if (g !== after && isOpen(g)) return g;
  }
  return null;
}

function blocked(ref) {
  if (App.store.incompatible.has(ref)) return 'The data of this task changed after you started it, so your earlier progress in it cannot be used here. Please contact the PI.';
  return null;
}

// re-render the current page when another window changes something it shows
export function watchExternal(sig) {
  let last = sig();
  App.onExternal = () => { const s = sig(); if (s !== last) { last = s; App.route(); } };
}

// ------------------------------------------------------------------ results (answer agreement)
// label covering each item of a submitted group
function itemLabels(t, g, n) {
  const rec = t.groups[g];
  const lookup = (mi) => (t.groups[mi.g]?.judgments || []).find((j) => j.id === mi.jid);
  return resolveGroup({ g, status: 'submitted', judgments: rec.judgments || [], mergedInto: rec.mergedInto }, n, lookup).labels;
}

export function groupResult(ans, labels, kind) {
  let members = 0, agree = 0, anomalies = 0, unknown = 0;
  labels.forEach((L, i) => {
    const [nn, na] = kind === 'blocks' ? (ans[i] ? [0, 1] : [1, 0]) : ans[i];
    members += nn + na; anomalies += na;
    if (!L) return;
    if (L.label === 'normal') agree += nn;
    else if (L.label === 'anomaly') agree += na;
    else unknown += nn + na;
  });
  return { members, agree, anomalies, unknown };
}

// make sure every submitted group has a stored result (answers are fetched only for submitted groups)
export async function ensureResults(ref, tj) {
  const t = App.store.task(ref);
  if (!t) return;
  const missing = Object.entries(t.groups).filter(([, s]) => s.status === 'submitted' && !s.result).map(([g]) => +g);
  if (!missing.length) return;
  const ans = await loadAnswers(tj, missing);
  const kind = ans.kind;
  App.store.act('results', { ref, groups: missing }, (s) => {
    const tk = s.tasks[ref];
    for (const g of missing) {
      if (!tk.groups[g] || tk.groups[g].status !== 'submitted') continue;
      tk.groups[g].result = groupResult(ans.groups[g], itemLabels(tk, g, ans.groups[g].length), kind);
    }
  });
}

export function agreementSoFar(t) {
  let members = 0, agree = 0, groups = 0;
  for (const s of Object.values(t?.groups || {})) if (s.status === 'submitted' && s.result) { members += s.result.members; agree += s.result.agree; groups++; }
  return { members, agree, groups, rate: members ? agree / members : null };
}

// ------------------------------------------------------------------ timer clock
function clockText(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (x) => String(x).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function timerClock({ ref, label }) {
  const el = h('div', { class: 'clock' });
  const draw = () => {
    const tm = App.timer;
    const s = tm.status();
    const cur = tm.displayMs();
    let total = null;
    if (ref) {
      const t = App.store.task(ref);
      total = Object.values(t?.groups || {}).reduce((a, x) => a + (x.activeMs || 0), 0) + (tm.ctx?.type === 'label' ? tm.pending.get(tm.ctxKey()) || 0 : 0);
    }
    clear(el);
    el.className = 'clock st-' + s;
    el.title = 'Counts only while this page is visible, the window is in front, and you used the keyboard, mouse or scrolled within the last 60 seconds.';
    el.appendChild(h('span', { class: 'dot' }));
    el.appendChild(h('span', { class: 'clock-main num' }, clockText(cur)));
    el.appendChild(h('span', { class: 'clock-label small' }, `${label} · ${{ timing: 'timing', paused: 'paused', idle: 'idle — move the mouse to resume', off: 'stopped' }[s]}`));
    if (total != null) el.appendChild(h('span', { class: 'clock-total small muted' }, `task total ${fmtDur(total)}`));
    if (tm.ctx) el.appendChild(s === 'paused'
      ? h('button', { class: 'btn tiny', onclick: () => tm.resume() }, 'Resume')
      : h('button', { class: 'btn tiny ghost', onclick: () => tm.pause() }, 'Pause'));
  };
  const off = App.timer.onChange(draw);
  draw();
  return { el, off };
}

// ------------------------------------------------------------------ task page
export async function renderTask(main, ref) {
  const { e, tj, assigned } = await ctxFor(ref);
  const blk = blocked(ref);
  if (!blk) { ensureTaskState(ref, assigned); await ensureResults(ref, tj); }
  const p = taskProgress(e, tj);
  const t = App.store.task(ref);
  const rt = refTime(e.display);
  const exSeen = App.store.state.examples[tj.dataset]?.seenAt;
  const unitName = tj.unit === 'block' ? 'blocks' : 'lines';
  const ng = t ? nextGroup(t, null) : null;
  const ex = App.examples.examples.find((x) => x.dataset === tj.dataset);
  const agr = agreementSoFar(t);

  main.appendChild(h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', e.display));
  let primary;
  if (blk) primary = null;
  else if (ng != null) primary = h('a', { class: 'btn primary big', href: `#/task/${ref}/g/${ng}` }, p.done || Object.keys(t.groups).length ? 'Continue labeling →' : 'Start labeling →');
  else primary = h('button', { class: 'btn big', onclick: exportBackup }, 'All done — export a backup');
  main.appendChild(h('div', { class: 'task-head' },
    h('div', null,
      h('h1', null, e.display),
      h('div', { class: 'task-stats' },
        h('span', null, h('strong', null, `${fmtNum(p.done)} / ${fmtNum(assigned.length)}`), ' groups done'),
        h('span', null, h('strong', null, fmtDur(p.ms)), ' labeling time'),
        h('span', null, h('strong', null, agr.rate == null ? '—' : pct(agr.rate)), ` agreement with the answers${agr.members ? ` (${fmtNum(agr.agree)} / ${fmtNum(agr.members)} ${unitName})` : ''}`),
        p.remaining && p.est != null ? h('span', null, h('strong', null, `≈ ${fmtDur(p.est)}`), ' left at your pace') : null),
      h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * p.done / Math.max(1, assigned.length)) + '%' } })),
      h('div', { class: 'small muted' }, `${fmtNum(p.members)} ${unitName} in ${fmtNum(assigned.length)} groups.` + (rt ? ` Reference effective time ${rt[0]} (range ${rt[1]}).` : ''))),
    primary));
  if (blk) main.appendChild(h('div', { class: 'notice err' }, blk));

  main.appendChild(h('a', { class: 'example-strip' + (exSeen ? ' seen' : ''), href: `#/example/${tj.dataset}` },
    h('span', { class: 'ex-step' }, exSeen ? '✓' : '1'),
    h('span', { class: 'ex-body' },
      h('strong', null, `${DATASET_NAMES[tj.dataset]} worked example`),
      h('span', { class: 'small muted' }, exSeen ? ' — read; open it again any time' : ' — read it once before your first group (a few minutes, not labeling time)'),
      ex ? h('div', { class: 'small mono ex-sum' }, ex.summary) : null),
    h('span', { class: 'btn small' + (exSeen ? ' ghost' : ' primary') }, exSeen ? 'Open' : 'Read example')));

  const order = t ? t.order : seededShuffle(assigned, `${App.name}|${ref}`);
  const q = h('div', { class: 'queue' });
  order.forEach((g, k) => {
    const s = statusOf(t, g);
    const r = t?.groups[g]?.result;
    const res = s === 'done' && r ? (r.agree === r.members ? h('span', { class: 'qres ok' }, '✓') : h('span', { class: 'qres bad' }, `✗ ${pct(r.agree / Math.max(1, r.members))}`)) : null;
    q.appendChild(h('a', { class: 'qrow st-' + s + (g === ng ? ' next' : ''), href: `#/task/${ref}/g/${g}` },
      h('span', { class: 'qpos num' }, String(k + 1)),
      h('span', { class: 'qstat' }, g === ng ? 'Next' : STATUS_TEXT[s], res ? ' ' : null, res),
      h('span', { class: 'qtpl mono' }, groupTitle(tj, g))));
  });
  main.appendChild(h('section', { class: 'sec' }, h('h2', null, `Groups (${fmtNum(order.length)})`, h('span', { class: 'muted small' }, ' — click any group; done groups show their answer')), q));
  watchExternal(() => JSON.stringify([App.store.task(ref)?.order, Object.entries(App.store.task(ref)?.groups || {}).map(([g, s]) => [g, s.status, (s.judgments || []).length, !!s.result]), App.store.state.examples[tj.dataset]?.seenAt]));
}

// ------------------------------------------------------------------ labeling page
export async function renderGroup(main, ref, g) {
  const { e, tj, assigned } = await ctxFor(ref);
  if (!assigned.includes(g)) throw new Error('This group is not part of your task.');
  if (!App.store.state.examples[tj.dataset]?.seenAt) {
    App.afterExample[tj.dataset] = `#/task/${ref}/g/${g}`;
    App.go(`#/example/${tj.dataset}`);
    return;
  }
  const blk = blocked(ref);
  if (blk) { main.appendChild(h('div', { class: 'notice err' }, blk)); return; }
  ensureTaskState(ref, assigned);
  const T = () => App.store.task(ref);
  const G = () => App.store.group(ref, g);
  const t = T();
  const gs = G();
  const submitted = gs.status === 'submitted';
  const editable = gs.status === 'open' && !gs.mergedInto;
  const meta = tj.groups[g];
  const st = App.store;

  main.className = 'main full';
  const pos = t.order.indexOf(g);
  const ng = nextGroup(t, g);
  const nextHref = ng != null ? `#/task/${ref}/g/${ng}` : `#/task/${ref}`;
  const clock = timerClock({ ref, label: submitted ? 'answer review (not labeling time)' : 'this group' });
  const bar = h('div', { class: 'gbar' },
    h('a', { class: 'btn ghost small', href: `#/task/${ref}` }, '← ', e.display),
    h('span', { class: 'gpos' }, `Group ${pos + 1} of ${t.order.length}`),
    clock.el,
    h('span', { class: 'grow' }));
  if (editable) {
    bar.appendChild(h('button', { class: 'btn small', title: 'Move this group to the end of the queue', onclick: () => {
      st.act('defer', { ref, g }, (s) => { const tk = s.tasks[ref]; tk.order = tk.order.filter((x) => x !== g).concat([g]); const o = st.group(ref, g); o.defers = (o.defers || 0) + 1; });
      const n = nextGroup(T(), g);
      App.go(n != null && n !== g ? `#/task/${ref}/g/${n}` : `#/task/${ref}`);
    } }, 'Do later'));
  }
  bar.appendChild(h('a', { class: 'btn small' + (submitted ? ' primary' : ' ghost'), href: nextHref }, ng != null ? 'Next group →' : 'Back to task'));
  main.appendChild(bar);
  const ws = h('div', { class: 'ws' });
  main.appendChild(ws);
  const ld = loading(ws, 'Loading group…');
  const [data, ans] = await Promise.all([loadGroup(e.key, g), submitted ? loadGroupAnswer(tj, g) : null]);
  ld.remove();

  let ctl;
  if (submitted) {
    // ---------------- answer view
    App.timer.setContext({ type: 'review', ref });
    const kind = tj.unit === 'block' ? 'blocks' : 'lines';
    const n = ans.length;
    const labels = itemLabels(T(), g, n);
    const res = groupResult(ans, labels, kind);
    if (!gs.result || gs.result.agree !== res.agree || gs.result.members !== res.members) st.act('result', { ref, g }, () => { G().result = res; });
    const labList = [];
    const cov = new Int32Array(n);
    labels.forEach((L, i) => { if (L) { let k = labList.indexOf(L.label); if (k < 0) { labList.push(L.label); k = labList.length - 1; } cov[i] = k + 1; } });
    const cnt = (i) => (kind === 'blocks' ? (ans[i] ? [0, 1] : [1, 0]) : ans[i]);
    const opts = {
      task: tj, meta, data, dataset: tj.dataset, instanceFields: gs.instanceFields || [], selectable: false,
      labelOf: (c) => labList[c - 1],
      answerBadge: (js) => {
        let a = 0, b = 0, wrong = false;
        for (const j of js) { const [x, y] = cnt(j); a += x; b += y; const L = labels[j]?.label; if (L && ((L === 'normal' && y) || (L === 'anomaly' && x) || L === 'unknown')) wrong = true; }
        const txt = kind === 'blocks' ? (b ? 'anomalous' : 'normal') : b ? (a ? `${fmtNum(a)} normal · ${fmtNum(b)} anom.` : 'anomalous') : 'normal';
        return h('span', { class: 'ansb ' + (wrong ? 'bad' : 'good'), title: 'True label' }, (wrong ? '✗ ' : '✓ ') + txt);
      },
      rightPane: () => answerPane({ tj, g, ans, kind, labels, res, n, nextHref, ng, rec: G(), T, filter: (is) => ctl.filterTo(is) }),
    };
    ctl = tj.dataset === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
    setTimeout(() => ctl.model.onCoverage(cov), 0);
  } else {
    // ---------------- labeling
    if (editable) {
      st.act('open', { ref, g }, () => { const o = G(); o.opens = (o.opens || 0) + 1; });
      App.timer.setContext({ type: 'label', ref, g });
    }
    const mergeCandidates = tj.dataset === 'hdfs' ? null : () => {
      const asg = new Set(assigned);
      const mk = digitKey(meta.template);
      const tk = T();
      return tj.groups.filter((m) => m.g !== g && asg.has(m.g) && !App.exampleIds.has(m.id)
        && (m.tid === meta.tid || digitKey(m.template) === mk)
        && (() => { const s = tk.groups[m.g]; return !s || (s.status === 'open' && !(s.judgments || []).length && !s.mergedInto); })())
        .map((m) => ({ g: m.g, template: m.template, label: `Group ${tk.order.indexOf(m.g) + 1}` + (tj.dataset === 'bgl' ? ` · ${m.key.join(' ')}` : ` · ${m.key[0]}`) }));
    };
    const opts = {
      task: tj, meta, data, dataset: tj.dataset,
      instanceFields: gs.instanceFields || [],
      onInstanceFields: editable ? (f) => st.act('instance-fields', { ref, g, fields: f }, () => { G().instanceFields = f; }) : null,
      onView: editable ? (ev) => { if (ev.type !== 'tab') st.log('v', { g, ...ev }); } : null,
      labelOf: (c) => G().judgments[c - 1]?.label,
      selectable: editable,
      rightPane: (model) => {
        if (gs.mergedInto) {
          return h('div', { class: 'judge' }, h('div', { class: 'jhead' }, 'Your judgment'),
            h('div', { class: 'notice' }, `This group is included in a merge judgment made in group ${T().order.indexOf(gs.mergedInto.g) + 1}. It is submitted together with that group.`),
            h('a', { class: 'btn', href: `#/task/${ref}/g/${gs.mergedInto.g}` }, 'Open that group'));
        }
        const panel = new JudgePanel({
          store: st, ref, g, dataset: tj.dataset, rules: App.rules, editable,
          mergeCandidates, groupTitle: (x) => `group ${T().order.indexOf(x) + 1}`,
          onConflict: () => App.route(),
          onSubmitted: () => { App.timer.endSession('submit'); App.route(); },
        }, model);
        model.onChange(() => panel.refresh());
        return panel.el;
      },
    };
    ctl = tj.dataset === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
    if (gs.mergedInto) {
      ctl.model.onCoverage(new Int32Array(ctl.model.nItems).fill(1));
      opts.labelOf = () => { const o = G(); return o.mergedInto ? (T().groups[o.mergedInto.g]?.judgments || []).find((j) => j.id === o.mergedInto.jid)?.label : null; };
    }
  }
  App.cleanup = () => { clock.off(); ctl.destroy(); };
  watchExternal(() => { const o = G(); return JSON.stringify([o.status, (o.judgments || []).map((j) => j.id), o.mergedInto]); });
}

function answerPane({ tj, g, ans, kind, labels, res, n, nextHref, ng, rec, T, filter }) {
  const unit = kind === 'blocks' ? 'blocks' : 'lines';
  const all = res.agree === res.members;
  const pane = h('div', { class: 'judge answer' });
  pane.appendChild(h('div', { class: 'verdict ' + (all ? 'good' : 'bad') },
    h('div', { class: 'verdict-big' }, all ? '✓ Correct' : `✗ ${fmtNum(res.members - res.agree)} of ${fmtNum(res.members)} ${unit} differ`),
    h('div', { class: 'small' }, `Agreement ${pct(res.agree / Math.max(1, res.members))} · true label: ${fmtNum(res.members - res.anomalies)} normal, ${fmtNum(res.anomalies)} anomalous ${unit}`)));
  const t = T();
  const judgs = rec.mergedInto
    ? [{ ...((t.groups[rec.mergedInto.g]?.judgments || []).find((j) => j.id === rec.mergedInto.jid) || {}), merged: true }]
    : rec.judgments;
  pane.appendChild(h('div', { class: 'jhead' }, 'Your judgments'));
  for (const j of judgs) {
    if (!j || !j.label) continue;
    const bits = j.merged ? new Uint8Array(Math.ceil(n / 8)).fill(255) : b64ToBits(j.bits);
    const ag = judgmentAgreement({ kind, groups: { [g]: ans } }, g, bits, j.label, n);
    pane.appendChild(h('div', { class: 'jitem' },
      h('div', { class: 'jitem-head' }, h('span', { class: 'pill lab-' + j.label }, LABEL_NAMES[j.label]),
        h('span', { class: 'small' }, j.merged ? 'Merged from another group' : `${MODE_NAMES[j.mode]} · ${fmtNum(j.items)} ${j.items === 1 ? (kind === 'blocks' ? 'block' : 'message') : (kind === 'blocks' ? 'blocks' : 'messages')}`),
        h('span', { class: 'rule-id' }, (j.rules || []).join(', '))),
      h('div', { class: 'small' }, `${fmtNum(ag.members)} ${unit}: ${fmtNum(ag.normal)} normal / ${fmtNum(ag.anomaly)} anomalous → `, h('strong', { class: ag.agree === ag.members ? 'ok-text' : 'err-text' }, `${fmtNum(ag.agree)} agree`)),
      ag.wrongItems.length ? h('button', { class: 'btn tiny', onclick: () => filter(ag.wrongItems) }, `Show the ${ag.wrongItems.length} differing ${kind === 'blocks' ? 'block(s)' : 'message(s)'}`) : null));
  }
  pane.appendChild(h('a', { class: 'btn primary wide big', href: nextHref }, ng != null ? 'Next group →' : 'Back to task'));
  return pane;
}

// ------------------------------------------------------------------ worked example
export async function renderExample(main, ds) {
  const ex = App.examples.examples.find((x) => x.dataset === ds);
  if (!ex) throw new Error('Unknown example.');
  const cands = App.manifest.tasks.filter((t) => t.dataset === ds);
  let best = null;
  for (const t of cands) {
    const tj = await taskJson(t.key);
    const m = tj.groups.find((x) => x.id === ex.id);
    if (m && (!best || m.n > best.meta.n)) best = { tj, meta: m };
  }
  if (!best) throw new Error('Example group not found in the data.');
  const { tj, meta } = best;
  main.className = 'main full';
  const seen = App.store.state.examples[ds]?.seenAt;
  const myTask = App.entries.find((x) => App.manifest.tasks.find((t) => t.key === x.key)?.dataset === ds);
  const back = myTask ? `#/task/${taskRef(myTask)}` : '#/';
  const next = App.afterExample[ds] || back;
  const clock = timerClock({ label: 'example (not labeling time)' });
  main.appendChild(h('div', { class: 'gbar' }, h('a', { class: 'btn ghost small', href: back }, myTask ? `← ${myTask.display}` : '← Home'), h('span', { class: 'gpos' }, ex.title), clock.el, h('span', { class: 'grow' })));
  if (!seen) main.appendChild(h('div', { class: 'notice ex-intro' }, `Read this worked example once before your first ${DATASET_NAMES[ds]} group: follow the steps on the right, then click “I understand”${App.afterExample[ds] ? ' — you will continue straight to the group you opened.' : '.'}`));
  const ws = h('div', { class: 'ws' });
  main.appendChild(ws);
  const ld = loading(ws);
  const data = await loadGroup(tj.key, meta.g);
  ld.remove();
  App.timer.setContext({ type: 'example', ds });
  const opts = {
    task: tj, meta, data, dataset: ds, instanceFields: [], labelOf: () => null, selectable: false,
    rightPane: (model) => {
      const reqs = h('ul', { class: 'reqs' });
      const upd = () => { clear(reqs); for (const r of model.reqPropagate()) reqs.appendChild(h('li', { class: r.ok ? 'ok' : 'miss' }, r.text)); };
      model.onChange(upd);
      upd();
      const d = ex.decision;
      return h('div', { class: 'judge example-pane' },
        h('div', { class: 'jhead' }, 'Worked example'),
        h('p', { class: 'small' }, ex.summary),
        ex.sample ? h('pre', { class: 'sample mono' }, ex.sample) : null,
        h('h4', null, 'Try it'),
        h('ol', { class: 'steps' }, ex.steps.map((s) => h('li', null, s))),
        h('h4', null, 'Checks before a whole-group judgment'),
        reqs,
        h('details', { class: 'decision-box' },
          h('summary', null, 'Show the answer and why'),
          h('div', { class: 'jitem' }, h('div', { class: 'jitem-head' }, h('span', { class: 'pill lab-' + d.label }, LABEL_NAMES[d.label]), h('span', { class: 'small' }, MODE_NAMES[d.mode]), h('span', { class: 'rule-id' }, d.rules.join(', '))),
            d.note ? h('div', { class: 'small' }, 'Note: ', d.note) : null),
          h('p', { class: 'small' }, ex.explanation)),
        h('button', { class: 'btn primary wide big', onclick: () => {
          App.store.act('example-understood', { ds }, (s) => { s.examples[ds] = s.examples[ds] || {}; s.examples[ds].seenAt = s.examples[ds].seenAt || Date.now(); });
          delete App.afterExample[ds];
          App.go(next);
        } }, seen ? 'Done' : 'I understand — start labeling'));
    },
  };
  const ctl = ds === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
  App.cleanup = () => { clock.off(); ctl.destroy(); };
}

export { itemCounts, fmtTime };
