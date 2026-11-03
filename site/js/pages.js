// Task overview, labeling page, worked examples, answer review.
import { h, clear, fmtDur, fmtTime, fmtNum, seededShuffle, digitKey, pct, b64ToBits } from './util.js';
import { loadGroup, loadAnswersEnc } from './data.js';
import { decryptAnswers } from './crypto.js';
import { JudgePanel } from './judge.js';
import { mountLineGroup } from './group-lines.js';
import { mountHdfsGroup } from './group-hdfs.js';
import { computeMetrics, judgmentAgreement, itemCounts, resolveGroup, LABEL_NAMES, MODE_NAMES, MODES } from './core.js';
import { App, entryByRef, taskJson, refTime, taskProgress, answersFor, DATASET_NAMES, exportBackup } from './app.js';
import { taskRef, assignedGroups, groupRecords } from './report.js';

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
  if (s.status === 'submitted') return s.mergedInto ? 'merged' : 'done';
  if (s.status === 'merged-pending') return 'merge-pending';
  if (s.judgments?.length) return 'started';
  if (s.defers) return 'deferred';
  if (s.opens) return 'opened';
  return 'todo';
}
const STATUS_TEXT = { todo: 'To do', opened: 'Opened', started: 'In progress', deferred: 'Deferred', done: 'Submitted', merged: 'Merged', 'merge-pending': 'In a pending merge' };

function nextGroup(t, after) {
  const order = t.order;
  const isOpen = (g) => { const s = t.groups[g]; return !s || s.status === 'open'; };
  const start = after == null ? 0 : order.indexOf(after) + 1;
  for (let k = 0; k < order.length; k++) {
    const g = order[(start + k) % order.length];
    if (g !== after && isOpen(g)) return g;
  }
  return null;
}

function blocked() {
  if (App.store.versionMismatch) return 'Your saved progress belongs to another data version. Contact the PI before labeling.';
  return null;
}

// ------------------------------------------------------------------ task overview
export async function renderTask(main, ref) {
  const { e, tj, assigned } = await ctxFor(ref);
  const p = taskProgress(e, tj);
  const t = App.store.task(ref);
  const rt = refTime(e.display);
  const exSeen = App.store.state.examples[tj.dataset]?.seenAt;
  const unitName = tj.unit === 'block' ? 'blocks' : 'lines';

  main.appendChild(h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', e.display));
  main.appendChild(h('h1', null, e.display));
  main.appendChild(h('div', { class: 'cards four' },
    stat('Groups submitted', `${fmtNum(p.done)} / ${fmtNum(assigned.length)}`),
    stat(`Size`, `${fmtNum(p.members)} ${unitName}`),
    stat('Effective labeling time', fmtDur(p.ms)),
    stat('Estimate', p.remaining ? (p.est != null ? `about ${fmtDur(p.est)} left` : 'after 3 groups') : 'done', p.remaining && p.est != null ? 'at your current pace (average per submitted group × groups left)' : '')));
  if (rt) main.appendChild(h('p', { class: 'small muted' }, `Reference effective time for this task: ${rt[0]} (range ${rt[1]}), excluding breaks, examples and the guide. Re-check the estimate after 20–30 groups.`));

  const blk = blocked();
  const act = h('div', { class: 'row gap' });
  if (blk) act.appendChild(h('div', { class: 'notice err' }, blk));
  else if (!exSeen) act.appendChild(h('div', { class: 'notice' }, `Before starting, read the ${DATASET_NAMES[tj.dataset]} worked example. `, h('a', { class: 'btn primary', href: `#/example/${tj.dataset}` }, 'Open the example')));
  else if (t?.unlocked) act.appendChild(h('a', { class: 'btn primary', href: `#/task/${ref}/review` }, 'Review answers'));
  else {
    const tt = ensureTaskState(ref, assigned);
    const ng = nextGroup(tt, null);
    if (ng != null) act.appendChild(h('a', { class: 'btn primary big', href: `#/task/${ref}/g/${ng}` }, p.done || Object.keys(tt.groups).length ? 'Continue labeling' : 'Start labeling'));
    else act.appendChild(h('div', { class: 'notice ok' }, 'All groups of this task are submitted. ', h('button', { class: 'btn', onclick: exportBackup }, 'Export a backup')));
  }
  main.appendChild(act);

  // queue
  const tt = App.store.task(ref);
  const order = tt ? tt.order : seededShuffle(assigned, `${App.name}|${ref}`);
  const q = h('div', { class: 'queue' });
  order.forEach((g, k) => {
    const s = statusOf(tt, g);
    const can = exSeen && !blk && (s !== 'done' && s !== 'merged' ? !tt?.unlocked : true);
    const href = tt?.unlocked ? `#/task/${ref}/review/${g}` : `#/task/${ref}/g/${g}`;
    q.appendChild(h(can ? 'a' : 'div', { class: 'qrow st-' + s, href: can ? href : null },
      h('span', { class: 'qpos num' }, String(k + 1)),
      h('span', { class: 'qstat' }, STATUS_TEXT[s]),
      h('span', { class: 'qtpl mono' }, groupTitle(tj, g))));
  });
  main.appendChild(h('section', { class: 'sec' }, h('h2', null, 'Queue', h('span', { class: 'muted small' }, ' — fixed random order; “Do later” moves a group to the end')), q));

  // unlock
  main.appendChild(unlockSection(ref, e, tj, p));
}

function stat(label, value, sub) {
  return h('div', { class: 'card stat' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), sub ? h('div', { class: 'small muted' }, sub) : null);
}

function unlockSection(ref, e, tj, p) {
  const t = App.store.task(ref);
  const sec = h('section', { class: 'sec card' }, h('h2', null, 'Answers'));
  if (t?.unlocked) {
    sec.appendChild(h('p', null, `Unlocked ${fmtTime(t.unlocked.at)}. Every judgment of this task is locked; you can still write review notes.`));
    sec.appendChild(h('a', { class: 'btn primary', href: `#/task/${ref}/review` }, 'Review answers'));
    return sec;
  }
  const inp = h('input', { class: 'inp', type: 'password', placeholder: 'Passphrase from the PI', autocomplete: 'off' });
  const msg = h('div', { class: 'small' });
  const btn = h('button', { class: 'btn' }, 'Unlock answers');
  btn.addEventListener('click', async () => {
    const pass = inp.value.trim();
    if (!pass) return;
    btn.disabled = true; msg.textContent = 'Checking…'; msg.className = 'small';
    let ans;
    try { ans = await decryptAnswers(await loadAnswersEnc(e.key), pass); } catch { ans = null; }
    btn.disabled = false;
    if (!ans || ans.task !== e.key) { msg.textContent = 'Wrong passphrase.'; msg.className = 'form-err'; App.store.act('unlock-failed', { ref }); return; }
    const open = p.assigned.length - p.done;
    const warn = open ? `\n\n${open} group(s) are not submitted yet. They will be locked as they are and left out of the accuracy.` : '';
    if (!confirm(`Unlock the answers of ${e.display}?\n\nAfter unlocking, no judgment of this task can be changed.${warn}`)) { msg.textContent = ''; return; }
    const tt = ensureTaskState(ref, p.assigned);
    App.store.act('unlock', { ref, openGroups: open }, () => { tt.unlocked = { at: Date.now(), passphrase: pass }; });
    App.answers[ref] = ans;
    App.go(`#/task/${ref}/review`);
  });
  sec.appendChild(h('p', { class: 'small' }, 'The PI gives you the passphrase after you have finished all of your tasks. Checking answers earlier would make later labeling faster and more accurate, so the time and accuracy would no longer reflect real labeling. Unlocking locks every judgment of this task.'));
  sec.appendChild(h('div', { class: 'row gap' }, inp, btn));
  sec.appendChild(msg);
  return sec;
}

// ------------------------------------------------------------------ labeling page
export async function renderGroup(main, ref, g) {
  const { e, tj, assigned } = await ctxFor(ref);
  if (!assigned.includes(g)) throw new Error('This group is not part of your task.');
  if (!App.store.state.examples[tj.dataset]?.seenAt) { App.go(`#/example/${tj.dataset}`); return; }
  const blk = blocked();
  if (blk) { main.appendChild(h('div', { class: 'notice err' }, blk)); return; }
  const t = ensureTaskState(ref, assigned);
  const gs = App.store.group(ref, g);
  const editable = gs.status === 'open' && !t.unlocked && !gs.mergedInto;
  const meta = tj.groups[g];

  main.className = 'main full';
  const pos = t.order.indexOf(g);
  const doneCount = t.order.filter((x) => t.groups[x]?.status === 'submitted').length;
  const bar = h('div', { class: 'gbar' },
    h('a', { class: 'btn ghost small', href: `#/task/${ref}` }, '← ', e.display),
    h('span', { class: 'gpos' }, `Group ${pos + 1} of ${t.order.length}`),
    h('span', { class: 'muted small' }, `${doneCount} submitted`),
    h('span', { class: 'grow' }));
  if (editable) {
    bar.appendChild(h('button', { class: 'btn small', title: 'Move this group to the end of the queue', onclick: () => {
      App.store.act('defer', { ref, g }, () => { t.order = t.order.filter((x) => x !== g).concat([g]); gs.defers = (gs.defers || 0) + 1; });
      const n = nextGroup(t, g);
      App.go(n != null && n !== g ? `#/task/${ref}/g/${n}` : `#/task/${ref}`);
    } }, 'Do later'));
  }
  const ng = nextGroup(t, g);
  bar.appendChild(h('a', { class: 'btn small' + (editable ? ' ghost' : ' primary'), href: ng != null ? `#/task/${ref}/g/${ng}` : `#/task/${ref}` }, ng != null ? 'Next group →' : 'Back to task'));
  main.appendChild(bar);
  const ws = h('div', { class: 'ws' });
  main.appendChild(ws);
  const ld = loading(ws, 'Loading group…');
  const data = await loadGroup(e.key, g);
  ld.remove();

  if (editable) {
    App.store.act('open', { ref, g }, () => { gs.opens = (gs.opens || 0) + 1; });
    App.timer.setContext({ type: 'label', ref, g });
  }
  const st = App.store;
  let panel;
  const mergeCandidates = tj.dataset === 'hdfs' ? null : () => {
    const asg = new Set(assigned);
    const mk = digitKey(meta.template);
    return tj.groups.filter((m) => m.g !== g && asg.has(m.g) && !App.exampleIds.has(m.id)
      && (m.tid === meta.tid || digitKey(m.template) === mk)
      && (() => { const s = t.groups[m.g]; return !s || (s.status === 'open' && !(s.judgments || []).length && !s.mergedInto); })())
      .map((m) => ({ g: m.g, template: m.template, label: `Group ${t.order.indexOf(m.g) + 1}` + (tj.dataset === 'bgl' ? ` · ${m.key.join(' ')}` : ` · ${m.key[0]}`) }));
  };
  const opts = {
    task: tj, meta, data, dataset: tj.dataset,
    instanceFields: gs.instanceFields || [],
    onInstanceFields: editable ? (f) => st.act('instance-fields', { ref, g, fields: f }, () => { gs.instanceFields = f; }) : null,
    onView: editable ? (ev) => { if (ev.type !== 'tab') st.log('v', { g, ...ev }); } : null,
    labelOf: (c) => gs.judgments[c - 1]?.label,
    selectable: editable,
    rightPane: (model) => {
      panel = new JudgePanel({
        store: st, ref, g, dataset: tj.dataset, rules: App.rules, editable,
        mergeCandidates, groupTitle: (x) => `group ${t.order.indexOf(x) + 1}`,
        onSubmitted: () => {
          App.timer.endSession('submit');
          App.timer.setContext(null);
          const n = nextGroup(t, g);
          setTimeout(() => App.go(n != null ? `#/task/${ref}/g/${n}` : `#/task/${ref}`), 250);
        },
      }, model);
      model.onChange(() => panel.refresh());
      return panel.el;
    },
  };
  const ctl = tj.dataset === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
  if (gs.mergedInto) {
    // coverage comes from the merge origin
    ctl.model.onCoverage(new Int32Array(ctl.model.nItems).fill(1));
    opts.labelOf = () => (t.groups[gs.mergedInto.g]?.judgments || []).find((j) => j.id === gs.mergedInto.jid)?.label;
  }
  App.cleanup = () => ctl.destroy();
}

// ------------------------------------------------------------------ worked example
export async function renderExample(main, ds) {
  const ex = App.examples.examples.find((x) => x.dataset === ds);
  if (!ex) throw new Error('Unknown example.');
  // use the task in which the example group is largest
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
  main.appendChild(h('div', { class: 'gbar' }, h('a', { class: 'btn ghost small', href: '#/' }, '← Home'), h('span', { class: 'gpos' }, ex.title), h('span', { class: 'muted small' }, 'Not timed as labeling · nothing you do here is recorded'), h('span', { class: 'grow' })));
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
      const pane = h('div', { class: 'judge example-pane' },
        h('div', { class: 'jform-title' }, 'Worked example'),
        h('p', { class: 'small' }, ex.summary),
        ex.sample ? h('pre', { class: 'sample mono' }, ex.sample) : null,
        h('h4', null, 'Try it'),
        h('ol', { class: 'steps' }, ex.steps.map((s) => h('li', null, s))),
        h('h4', null, 'Minimum checks before a whole-group judgment'),
        h('p', { class: 'small muted' }, 'The labeling page checks these before you can propagate one label to the whole group. They update as you work here.'),
        reqs,
        h('details', { class: 'decision-box' },
          h('summary', null, 'Show the decision and explanation'),
          h('div', { class: 'jitem' }, h('div', { class: 'jitem-head' }, h('span', { class: 'pill lab-' + d.label }, LABEL_NAMES[d.label]), h('span', { class: 'jmode' }, MODE_NAMES[d.mode]), h('span', { class: 'rule-id' }, d.rules.join(', '))),
            d.note ? h('div', { class: 'small' }, 'Note: ', d.note) : null),
          h('p', { class: 'small' }, ex.explanation)),
        h('button', { class: 'btn primary wide', onclick: () => {
          App.store.act('example-understood', { ds }, (s) => { s.examples[ds] = s.examples[ds] || {}; s.examples[ds].seenAt = s.examples[ds].seenAt || Date.now(); });
          App.go('#/');
        } }, seen ? 'Done' : 'I understand'));
      return pane;
    },
  };
  const ctl = ds === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
  App.cleanup = () => ctl.destroy();
}

// ------------------------------------------------------------------ review (after unlock)
export async function renderReview(main, ref) {
  const { e, tj, assigned } = await ctxFor(ref);
  const t = App.store.task(ref);
  if (!t?.unlocked) { App.go(`#/task/${ref}`); return; }
  const ld = loading(main, 'Decrypting answers…');
  const ans = await answersFor(ref);
  ld.remove();
  App.timer.setContext({ type: 'review', ref });
  const recs = groupRecords(App.store, ref, assigned, tj);
  const m = computeMetrics(recs, ans);
  const p = taskProgress(e, tj);
  const unit = tj.unit === 'block' ? 'blocks' : 'lines';

  main.appendChild(h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', h('a', { href: `#/task/${ref}` }, e.display), ' / Review'));
  main.appendChild(h('h1', null, `Answers — ${e.display}`));
  main.appendChild(h('p', { class: 'small muted' }, `Unlocked ${fmtTime(t.unlocked.at)} · computed over the ${m.groupsSubmitted} submitted group(s) only · labeling time ${fmtDur(p.ms)} · review time ${fmtDur(t.reviewMs)} (recorded separately)`));
  main.appendChild(metricsCards(m, unit));
  if (m.errors.length) main.appendChild(h('div', { class: 'notice err' }, 'Coverage problems: ' + m.errors.slice(0, 5).join('; ')));

  const tbl = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['#', 'Group', 'Judgments', unit, 'Answer: normal / anomalous', 'Agree', ''].map((x) => h('th', null, x)))));
  const tb = h('tbody');
  const byG = new Map(recs.map((r) => [r.g, r]));
  for (const g of t.order) {
    const r = byG.get(g);
    if (!r) continue;
    const n = ans.groups[g].length;
    let nn = 0, na = 0, agree = 0, covered = 0;
    const { labels } = r.status === 'submitted' ? resolveGroup(r, n, (mi) => (byG.get(mi.g)?.judgments || []).find((j) => j.id === mi.jid)) : { labels: new Array(n).fill(null) };
    for (let i = 0; i < n; i++) {
      const [a, b] = itemCounts(ans, g, i);
      nn += a; na += b;
      const L = labels[i];
      if (L) { covered += a + b; agree += L.label === 'normal' ? a : L.label === 'anomaly' ? b : 0; }
    }
    const labs = r.mergedInto ? [labels[0]?.label].filter(Boolean) : r.judgments.map((j) => j.label);
    const ok = r.status === 'submitted' && agree === nn + na;
    tb.appendChild(h('tr', { class: r.status !== 'submitted' ? 'dim' : '' },
      h('td', { class: 'num' }, String(t.order.indexOf(g) + 1)),
      h('td', { class: 'mono small tplcell' }, groupTitle(tj, g)),
      h('td', null, r.status !== 'submitted' ? h('span', { class: 'muted small' }, 'not submitted') : [...new Set(labs)].map((L) => h('span', { class: 'pill lab-' + L }, LABEL_NAMES[L])), r.mergedInto ? h('span', { class: 'small muted' }, ' (merged)') : null),
      h('td', { class: 'num' }, fmtNum(nn + na)),
      h('td', { class: 'num' }, `${fmtNum(nn)} / ${fmtNum(na)}`),
      h('td', { class: 'num ' + (r.status === 'submitted' ? (ok ? 'ok-text' : 'err-text') : '') }, r.status === 'submitted' ? `${fmtNum(agree)} / ${fmtNum(covered)}` : '—'),
      h('td', null, h('a', { href: `#/task/${ref}/review/${g}` }, 'Open'))));
  }
  tbl.appendChild(tb);
  main.appendChild(h('section', { class: 'sec' }, h('h2', null, 'Per group'), tbl));
}

export function metricsCards(m, unit) {
  return h('div', { class: 'cards four' },
    stat('Accuracy (per member)', pct(m.memberAccuracy), `${fmtNum(m.correct)} of ${fmtNum(m.normalMembers + m.anomalyMembers)} judged ${unit}`),
    stat('Accuracy (per group)', pct(m.groupAccuracy), `${m.groupsCorrect} of ${m.groupsSubmitted} groups fully right`),
    stat('Anomaly precision / recall', `${pct(m.precision)} / ${pct(m.recall)}`, `F1 ${pct(m.f1)} · ${fmtNum(m.answerAnomalies)} anomalous ${unit} in answers`),
    stat("Can't tell", pct(m.unknownRate), `conservative accuracy ${pct(m.conservativeAccuracy)}`),
    stat('Judgments', String(MODES.reduce((a, k) => a + (m.judgments[k] || 0), 0)), MODES.map((k) => `${MODE_NAMES[k]} ${m.judgments[k] || 0}`).join(' · ')),
    stat('Coverage by mode', '', MODES.map((k) => `${MODE_NAMES[k]} ${fmtNum(m.coverage[k] || 0)}`).join(' · ')));
}

export async function renderReviewGroup(main, ref, g) {
  const { e, tj, assigned } = await ctxFor(ref);
  const t = App.store.task(ref);
  if (!t?.unlocked) { App.go(`#/task/${ref}`); return; }
  if (!assigned.includes(g)) throw new Error('This group is not part of your task.');
  const ans = await answersFor(ref);
  App.timer.setContext({ type: 'review', ref });
  const gs = App.store.group(ref, g);
  const meta = tj.groups[g];
  main.className = 'main full';
  const pos = t.order.indexOf(g);
  const nextG = t.order[pos + 1];
  main.appendChild(h('div', { class: 'gbar' },
    h('a', { class: 'btn ghost small', href: `#/task/${ref}/review` }, '← Review of ', e.display),
    h('span', { class: 'gpos' }, `Group ${pos + 1} of ${t.order.length}`), h('span', { class: 'grow' }),
    nextG != null ? h('a', { class: 'btn small', href: `#/task/${ref}/review/${nextG}` }, 'Next →') : null));
  const ws = h('div', { class: 'ws' });
  main.appendChild(ws);
  const data = await loadGroup(e.key, g);
  const n = ans.groups[g].length;
  const recs = groupRecords(App.store, ref, assigned, tj);
  const byG = new Map(recs.map((r) => [r.g, r]));
  const rec = byG.get(g);
  const { labels } = resolveGroup(rec, n, (mi) => (byG.get(mi.g)?.judgments || []).find((j) => j.id === mi.jid));
  const cov = new Int32Array(n);
  const labList = [];
  labels.forEach((L, i) => { if (L) { let k = labList.indexOf(L.label); if (k < 0) { labList.push(L.label); k = labList.length - 1; } cov[i] = k + 1; } });
  let ctl;
  const opts = {
    task: tj, meta, data, dataset: tj.dataset, instanceFields: gs.instanceFields || [], selectable: false,
    labelOf: (c) => labList[c - 1],
    answerBadge: (js) => {
      let a = 0, b = 0, wrong = false;
      for (const j of js) { const [x, y] = itemCounts(ans, g, j); a += x; b += y; const L = labels[j]?.label; if (L && ((L === 'normal' && y) || (L === 'anomaly' && x) || L === 'unknown')) wrong = true; }
      const txt = tj.dataset === 'hdfs' ? (b ? 'anomalous' : 'normal') : `${fmtNum(a)} n / ${fmtNum(b)} a`;
      return h('span', { class: 'ansb ' + (wrong ? 'bad' : 'good'), title: 'Answer: normal / anomalous' }, txt);
    },
    rightPane: (model) => {
      const pane = h('div', { class: 'judge' }, h('div', { class: 'jform-title' }, 'Your judgments vs. answers'));
      const judgs = rec.mergedInto
        ? [{ ...(byG.get(rec.mergedInto.g)?.judgments || []).find((j) => j.id === rec.mergedInto.jid), bits: null, merged: true }]
        : rec.judgments;
      if (!judgs.length || rec.status !== 'submitted') pane.appendChild(h('p', { class: 'muted small' }, rec.status === 'submitted' ? 'No judgments.' : 'This group was not submitted; it is not counted.'));
      for (const j of judgs) {
        if (!j || !j.label) continue;
        const bits = j.merged ? null : b64ToBits(j.bits);
        const all = new Uint8Array(Math.ceil(n / 8)).fill(255);
        const ag = judgmentAgreement(ans, g, bits || all, j.label, n);
        pane.appendChild(h('div', { class: 'jitem' },
          h('div', { class: 'jitem-head' }, h('span', { class: 'pill lab-' + j.label }, LABEL_NAMES[j.label]), h('span', { class: 'jmode' }, j.merged ? 'Merged (from another group)' : MODE_NAMES[j.mode]), h('span', { class: 'rule-id' }, (j.rules || []).join(', '))),
          j.note ? h('div', { class: 'small muted' }, j.note) : null,
          h('div', { class: 'small' }, `${fmtNum(ag.members)} ${tj.unit === 'block' ? 'blocks' : 'lines'} · answer ${fmtNum(ag.normal)} normal / ${fmtNum(ag.anomaly)} anomalous · agree ${fmtNum(ag.agree)}`),
          ag.wrongItems.length ? h('button', { class: 'btn tiny', onclick: () => ctl.filterTo(ag.wrongItems) }, `Show ${ag.wrongItems.length} disagreeing ${tj.unit === 'block' ? 'block(s)' : 'message(s)'}`) : h('div', { class: 'small ok-text' }, 'All agree.')));
      }
      const ta = h('textarea', { class: 'note', rows: '5', placeholder: 'Review notes (what you missed, what to remember)…' });
      ta.value = gs.reviewNote || '';
      let tmr;
      ta.addEventListener('input', () => { clearTimeout(tmr); tmr = setTimeout(() => App.store.act('review-note', { ref, g }, () => { gs.reviewNote = ta.value; }), 500); });
      pane.appendChild(h('h4', null, 'Review notes'));
      pane.appendChild(ta);
      setTimeout(() => model.onCoverage(cov), 0);
      return pane;
    },
  };
  ctl = tj.dataset === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
  App.cleanup = () => ctl.destroy();
}
