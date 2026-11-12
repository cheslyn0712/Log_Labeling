// Task page, labeling page, worked examples.
import { h, clear, fmtNum, seededShuffle, debounce } from './util.js';
import { loadGroup, loadGroupAnswer } from './data.js';
import { mountLineGroup } from './group-lines.js';
import { mountHdfsGroup } from './group-hdfs.js';
import { App, entryByRef, taskJson, DATASET_NAMES, refText } from './app.js';
import { assignedGroups, taskRef, groupTruth, taskTime, hm, LABEL_NAMES, scoredLabel } from './report.js';

function loading(el, text = 'Loading…') { const x = h('div', { class: 'loading' }, h('span', { class: 'spinner' }), text); el.appendChild(x); return x; }

async function ctxFor(ref) {
  const e = entryByRef(ref);
  if (!e) throw new Error('This task is not assigned to you.');
  const tj = await taskJson(e.key);
  return { e, tj, assigned: assignedGroups(e, tj, App.exampleIds), ref };
}

function ensureTaskState(ref, assigned) {
  return App.store.ensureTask(ref, seededShuffle(assigned, `${App.name}|${ref}`));
}

function groupTitle(tj, g) {
  const m = tj.groups[g];
  if (tj.dataset === 'hdfs') return m.ecv.map(([e, c]) => `T${e}×${c}`).join(' ');
  return m.template === '<EMPTY>' ? '(empty message)' : m.template;
}

export function firstUnlabeled(t) { return t.order.find((g) => !t.groups[g]?.label) ?? null; }

// re-render the current page when another window changes something it shows
export function watchExternal(sig) {
  let last = sig();
  App.onExternal = () => { const s = sig(); if (s !== last) { last = s; App.route(); } };
}

// ------------------------------------------------------------------ task timer (pause / resume / adjust)
function clockText(ms) {
  const s = Math.floor((ms || 0) / 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function taskClock(ref, { compact = false } = {}) {
  const el = h('div', { class: 'clock' + (compact ? ' compact' : '') });
  const draw = () => {
    const tm = App.timer;
    const t = App.store.task(ref);
    if (!t) return;
    const pend = tm.ctx?.type === 'label' && tm.ctx.ref === ref ? tm.pending.get(tm.ctxKey()) || 0 : 0;
    const total = taskTime(t).total + pend;
    const paused = !!t.paused;
    const here = tm.ctx?.type === 'label' && tm.ctx.ref === ref;
    const review = tm.ctx?.type === 'review' && tm.ctx.ref === ref;
    const st = paused ? 'paused' : here ? tm.status() : review ? 'review' : 'off';
    clear(el);
    el.className = 'clock st-' + st + (compact ? ' compact' : '');
    el.title = 'Task time. It runs while you are on a group of this task, the page is in front and you were active in the last minute.';
    el.appendChild(h('span', { class: 'dot' }));
    el.appendChild(h('span', { class: 'clock-main num' }, clockText(total)));
    el.appendChild(h('span', { class: 'clock-label small' }, { timing: 'running', idle: 'idle', paused: 'paused', review: 'not timed (answer checked)', off: 'stopped' }[st]));
    el.appendChild(paused
      ? h('button', { class: 'btn tiny primary', onclick: () => App.timer.setPaused(ref, false) }, 'Resume')
      : h('button', { class: 'btn tiny', onclick: () => App.timer.setPaused(ref, true) }, 'Pause'));
    el.appendChild(h('button', { class: 'btn tiny ghost', title: 'Correct the recorded time', onclick: () => adjustTime(ref) }, 'Adjust'));
  };
  const off = App.timer.onChange(draw);
  const off2 = App.store.onChange(draw);
  draw();
  return { el, off: () => { off(); off2(); } };
}

function adjustTime(ref) {
  App.timer.tick(); App.timer.flush();
  const t = App.store.task(ref);
  const cur = taskTime(t);
  const curMin = Math.round(cur.total / 60000);
  const ans = prompt(`Set the labeling time of this task.\nCurrently ${Math.floor(curMin / 60)} h ${curMin % 60} min. Enter hours:minutes (e.g. 1:45):`, `${Math.floor(curMin / 60)}:${String(curMin % 60).padStart(2, '0')}`);
  if (ans == null) return;
  const m = /^\s*(\d+)\s*[:h]\s*(\d{1,2})\s*(min)?\s*$/.exec(ans) || /^\s*(\d+)\s*$/.exec(ans);
  if (!m) { alert('Please enter hours:minutes, for example 1:45.'); return; }
  const target = (m[2] != null ? +m[1] * 60 + +m[2] : +m[1]) * 60000;
  App.store.act('time-adjust', { ref, to: target }, (s) => {
    const tk = s.tasks[ref];
    const now = taskTime(tk);
    tk.timeAdjustMs = (tk.timeAdjustMs || 0) + (target - now.total);
    (tk.timeLog = tk.timeLog || []).push({ at: Date.now(), type: 'adjust', detail: `${hm(now.total)} -> ${hm(target)}` });
  });
}

// ------------------------------------------------------------------ task page
export async function renderTask(main, ref) {
  const { e, tj, assigned } = await ctxFor(ref);
  const t = ensureTaskState(ref, assigned);
  const done = assigned.filter((g) => t.groups[g]?.label).length;
  const next = firstUnlabeled(t);
  const unit = tj.unit === 'block' ? 'blocks' : 'lines';
  const members = assigned.reduce((a, g) => a + tj.groups[g].n, 0);
  const clock = taskClock(ref);
  App.cleanup = clock.off;

  main.appendChild(h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Home'), ' / ', e.display));
  main.appendChild(h('div', { class: 'task-head' },
    h('div', null,
      h('h1', null, e.display),
      h('div', { class: 'task-stats' },
        h('span', null, h('strong', null, `${fmtNum(done)} / ${fmtNum(assigned.length)}`), ' groups labeled'),
        h('span', null, `${fmtNum(members)} ${unit}`)),
      h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * done / Math.max(1, assigned.length)) + '%' } })),
      h('div', { class: 'small muted' }, refText(e.display))),
    h('div', { class: 'task-actions' },
      h('a', { class: 'btn primary big', href: `#/task/${ref}/g/${next ?? t.order[0]}` }, done === 0 ? 'Start labeling →' : next != null ? 'Continue →' : 'Review labels'),
      exampleLinks(tj.dataset))));
  main.appendChild(h('div', { class: 'row gap clock-row' }, h('span', { class: 'small muted' }, 'Task time'), clock.el));

  const q = h('div', { class: 'queue' });
  t.order.forEach((g, k) => {
    const x = t.groups[g];
    const lab = x?.label;
    q.appendChild(h('a', { class: 'qrow' + (g === next ? ' next' : ''), href: `#/task/${ref}/g/${g}` },
      h('span', { class: 'qpos num' }, String(k + 1)),
      h('span', { class: 'qstat' }, lab ? h('span', { class: 'pill lab-' + lab }, LABEL_NAMES[lab]) : h('span', { class: 'muted' }, g === next ? 'Next' : '—'),
        x?.revealed ? h('span', { class: 'small muted' }, ' · checked') : null),
      h('span', { class: 'qtpl mono' }, groupTitle(tj, g))));
  });
  main.appendChild(h('section', { class: 'sec' }, h('h2', null, `Groups (${fmtNum(t.order.length)})`, h('span', { class: 'muted small' }, ' — click any group; labels can always be changed')), q));
  watchExternal(() => JSON.stringify(Object.entries(App.store.task(ref)?.groups || {}).map(([g, s]) => [g, s.label, s.revealed])));
}

// ------------------------------------------------------------------ labeling page
export async function renderGroup(main, ref, g) {
  const { e, tj, assigned } = await ctxFor(ref);
  if (!assigned.includes(g)) throw new Error('This group is not part of your task.');
  ensureTaskState(ref, assigned);
  const st = App.store;
  const T = () => st.task(ref);
  const G = () => st.group(ref, g);
  const t = T();
  const meta = tj.groups[g];
  const pos = t.order.indexOf(g);
  const prevG = pos > 0 ? t.order[pos - 1] : null;
  const nextG = pos < t.order.length - 1 ? t.order[pos + 1] : null;
  const go = (x) => App.go(x == null ? `#/task/${ref}` : `#/task/${ref}/g/${x}`);

  main.className = 'main full';
  const clock = taskClock(ref, { compact: true });
  main.appendChild(h('div', { class: 'gbar' },
    h('a', { class: 'btn ghost small', href: `#/task/${ref}` }, '← ', e.display),
    h('span', { class: 'gpos' }, `Group ${pos + 1} of ${t.order.length}`),
    clock.el,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn small', disabled: prevG == null, onclick: () => go(prevG) }, '← Prev'),
    h('button', { class: 'btn small primary', onclick: () => go(nextG) }, nextG == null ? 'Back to task' : 'Next →')));
  const ws = h('div', { class: 'ws' });
  main.appendChild(ws);
  const ld = loading(ws, 'Loading group…');
  const data = await loadGroup(e.key, g);
  ld.remove();

  st.act('open', { ref, g }, () => { G().opens = (G().opens || 0) + 1; });
  const kind = tj.unit === 'block' ? 'blocks' : 'lines';
  const unit = kind === 'blocks' ? 'blocks' : 'lines';
  const showAnswers = App.config.showAnswers !== false;
  let ans = null;
  let ctl = null;

  // ---------------- label panel
  const panel = h('div', { class: 'judge' });
  const labelBtns = {};
  const status = h('div', { class: 'small muted label-status' });
  const ruleSel = h('select', { class: 'inp' });
  const noteInp = h('input', { class: 'inp note-inp', placeholder: 'Note (optional)' });
  const answerBox = h('div', { class: 'answer-box' });

  const rules = App.rules.rules.filter((r) => r.dataset === tj.dataset || r.dataset === '*');
  ruleSel.appendChild(h('option', { value: '' }, 'Rule (optional)'));
  for (const L of ['anomaly', 'normal', 'unknown']) {
    const rs = rules.filter((r) => r.label === L || (L === 'unknown' && r.label === '*'));
    if (rs.length) ruleSel.appendChild(h('optgroup', { label: LABEL_NAMES[L] }, rs.map((r) => h('option', { value: r.id }, `${r.id} — ${r.title}`))));
  }

  // A label can always be changed. After the answer was checked, the label held at that moment
  // stays the scored one (labelAtCheck); the change is saved and counted as a correction.
  function setLabel(L) {
    const x = G();
    if (x.label === L) return;
    if (x.revealed && !confirm(`You have already checked the answer for this group.\n\nChange your label from ${LABEL_NAMES[x.label]} to ${LABEL_NAMES[L]}?\n\nThe new label is saved. Your label from before the answer stays in your results as the scored label.`)) return;
    st.act('label', { ref, g, label: L, from: x.label, afterAnswer: !!x.revealed }, () => {
      const y = G();
      if (y.revealed) {
        if (y.labelAtCheck === undefined) y.labelAtCheck = y.label;
        y.editsAfterAnswer = (y.editsAfterAnswer || 0) + 1;
      }
      if (y.label && y.label !== L) y.edits = (y.edits || 0) + 1;
      y.label = L; y.at = Date.now();
    });
    refreshPanel();
  }
  const saveRule = () => st.act('rule', { ref, g, rule: ruleSel.value }, () => { G().rule = ruleSel.value; });
  const saveNote = debounce(() => st.act('note', { ref, g }, () => { G().note = noteInp.value.trim(); }), 400);
  ruleSel.addEventListener('change', saveRule);
  noteInp.addEventListener('input', saveNote);

  const seg = h('div', { class: 'seg seg-label big-labels' });
  for (const [L, key] of [['normal', '1'], ['anomaly', '2'], ['unknown', '3']]) {
    labelBtns[L] = h('button', { type: 'button', class: `seg-btn lab-${L}`, title: `Key ${key}`, onclick: () => setLabel(L) }, LABEL_NAMES[L]);
    seg.appendChild(labelBtns[L]);
  }
  panel.append(
    h('div', { class: 'jhead' }, 'Label this group'),
    h('div', { class: 'small muted' }, `One label for the whole group (${fmtNum(meta.n)} ${unit}).`),
    seg, status, ruleSel, noteInp, answerBox,
    h('div', { class: 'nav-row' },
      h('button', { class: 'btn', disabled: prevG == null, onclick: () => go(prevG) }, '← Prev'),
      h('button', { class: 'btn primary', onclick: () => go(nextG) }, nextG == null ? 'Back to task' : 'Next →')),
    h('div', { class: 'small muted keys' }, 'Keys: 1 Normal · 2 Anomalous · 3 Can\'t tell · ← → previous / next'));

  async function refreshPanel() {
    const x = G();
    for (const [L, b] of Object.entries(labelBtns)) b.classList.toggle('on', x.label === L);
    ruleSel.value = x.rule || '';
    if (document.activeElement !== noteInp) noteInp.value = x.note || '';
    const scored = scoredLabel(x);
    status.textContent = !x.label ? 'Not labeled yet.'
      : x.revealed && scored !== x.label ? `Saved: ${LABEL_NAMES[x.label]} · changed after the answer (scored: ${LABEL_NAMES[scored]})`
      : `Saved: ${LABEL_NAMES[x.label]}${x.edits ? ` · changed ${x.edits}×` : ''}${x.revealed ? ' · answer checked' : ''} · click another label to change it`;
    clear(answerBox);
    if (!showAnswers) return;
    if (!x.revealed) {
      answerBox.appendChild(h('button', { class: 'btn wide', disabled: !x.label, onclick: checkAnswer, title: 'Your label at this moment is the one that is scored.' },
        x.label ? `Check answer (your label: ${LABEL_NAMES[x.label]})` : 'Check answer — label first'));
      return;
    }
    if (!ans) { ans = await loadGroupAnswer(tj, g); ctl?.refresh(); }
    const tr = groupTruth(ans, kind);
    const ok = x.label === tr.truth;
    const wrong = ans.map((a, i) => [a, i]).filter(([a]) => {
      const an = kind === 'blocks' ? a : a[1], no = kind === 'blocks' ? 1 - a : a[0];
      return x.label === 'normal' ? an > 0 : x.label === 'anomaly' ? no > 0 : true;
    }).map(([, i]) => i);
    answerBox.appendChild(h('div', { class: 'verdict ' + (x.label === 'unknown' ? 'unsure' : ok ? 'good' : 'bad') },
      h('div', { class: 'verdict-big' }, x.label === 'unknown' ? `True label: ${LABEL_NAMES[tr.truth]}` : ok ? '✓ Correct' : `✗ True label: ${LABEL_NAMES[tr.truth]}`),
      h('div', { class: 'small' }, `${fmtNum(tr.normal)} normal and ${fmtNum(tr.anomalous)} anomalous ${unit} in this group.`)));
    if (wrong.length && x.label !== 'unknown' && wrong.length < ans.length) {
      answerBox.appendChild(h('button', { class: 'btn tiny', onclick: () => ctl.showOnly(wrong) }, `Show the ${wrong.length} ${kind === 'blocks' ? 'block(s)' : 'message(s)'} that differ`));
    }
  }

  async function checkAnswer() {
    if (!G().label) return;
    App.timer.endSession('check-answer');
    st.act('check-answer', { ref, g }, () => { const y = G(); y.revealed = true; y.revealedAt = Date.now(); y.labelAtCheck = y.label; });
    App.timer.setContext({ type: 'review', ref });
    await refreshPanel();
  }

  const answerBadge = (i) => {
    if (!ans || !G().revealed) return null;
    const a = ans[i];
    const an = kind === 'blocks' ? a : a[1], no = kind === 'blocks' ? 1 - a : a[0];
    const L = G().label;
    const bad = (L === 'normal' && an > 0) || (L === 'anomaly' && no > 0);
    const txt = kind === 'blocks' ? (an ? 'anomalous' : 'normal') : an ? (no ? `${fmtNum(no)} normal · ${fmtNum(an)} anom.` : 'anomalous') : 'normal';
    return h('span', { class: 'ansb ' + (bad ? 'bad' : 'good'), title: 'True label' }, txt);
  };

  if (G().revealed) { ans = await loadGroupAnswer(tj, g); App.timer.setContext({ type: 'review', ref }); }
  else App.timer.setContext({ type: 'label', ref, g });

  const opts = { task: tj, meta, data, dataset: tj.dataset, rightPane: panel, answerBadge };
  ctl = tj.dataset === 'hdfs' ? mountHdfsGroup(ws, opts) : mountLineGroup(ws, opts);
  await refreshPanel();

  const onKey = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (ev.key === '1') setLabel('normal');
    else if (ev.key === '2') setLabel('anomaly');
    else if (ev.key === '3') setLabel('unknown');
    else if (ev.key === 'ArrowRight') go(nextG);
    else if (ev.key === 'ArrowLeft' && prevG != null) go(prevG);
    else return;
    ev.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  App.cleanup = () => { window.removeEventListener('keydown', onKey); clock.off(); ctl.destroy(); };
  watchExternal(() => { const x = G(); return JSON.stringify([x.label, x.revealed, x.rule, x.note]); });
}

// ------------------------------------------------------------------ worked example
// links to a dataset's two worked examples (Normal, Anomalous)
export function exampleLinks(ds, cls = 'small') {
  const exs = App.examples.examples.filter((x) => x.dataset === ds);
  const out = [h('span', { class: cls + ' muted' }, `${DATASET_NAMES[ds]} examples: `)];
  exs.forEach((x, i) => {
    if (i) out.push(h('span', { class: cls + ' muted' }, ' · '));
    out.push(h('a', { class: cls, href: `#/example/${ds}/${x.decision.label}` }, LABEL_NAMES[x.decision.label]));
  });
  return h('span', { class: 'ex-links' }, out);
}

export async function renderExample(main, ds, kind) {
  const exs = App.examples.examples.filter((x) => x.dataset === ds);
  const ex = exs.find((x) => x.decision.label === kind) || exs[0];
  if (!ex) throw new Error('Unknown example.');
  let best = null;
  for (const t of App.manifest.tasks.filter((x) => x.dataset === ds)) {
    const tj = await taskJson(t.key);
    const m = tj.groups.find((x) => x.id === ex.id);
    if (m && (!best || m.n > best.meta.n)) best = { tj, meta: m };
  }
  if (!best) throw new Error('Example group not found in the data.');
  const { tj, meta } = best;
  const myTask = App.entries.find((x) => App.manifest.tasks.find((t) => t.key === x.key)?.dataset === ds);
  const back = myTask ? `#/task/${taskRef(myTask)}` : '#/';
  main.className = 'main full';
  const tabs = h('span', { class: 'seg' }, exs.map((x) => h('a', {
    class: 'seg-btn lab-' + x.decision.label + (x === ex ? ' on' : ''), href: `#/example/${ds}/${x.decision.label}`,
  }, LABEL_NAMES[x.decision.label] + ' example')));
  main.appendChild(h('div', { class: 'gbar' }, h('a', { class: 'btn ghost small', href: back }, myTask ? `← ${myTask.display}` : '← Home'), h('span', { class: 'gpos' }, ex.title), tabs, h('span', { class: 'muted small' }, 'Example only — not part of any task, not timed')));
  const ws = h('div', { class: 'ws' });
  main.appendChild(ws);
  const ld = loading(ws);
  const data = await loadGroup(tj.key, meta.g);
  ld.remove();
  const d = ex.decision;
  const pane = h('div', { class: 'judge example-pane' },
    h('div', { class: 'jhead' }, 'Worked example'),
    h('p', { class: 'small' }, ex.summary),
    ex.sample ? h('pre', { class: 'sample mono' }, ex.sample) : null,
    h('ol', { class: 'steps' }, ex.steps.map((s) => h('li', null, s))),
    h('details', { class: 'decision-box' },
      h('summary', null, 'Show the label'),
      h('div', { class: 'jitem' }, h('span', { class: 'pill lab-' + d.label }, LABEL_NAMES[d.label]), ' ', h('span', { class: 'rule-id' }, d.rules.join(', '))),
      h('p', { class: 'small' }, ex.explanation)),
    h('a', { class: 'btn primary wide', href: back }, myTask ? `Go to ${myTask.display}` : 'Home'));
  const ctl = ds === 'hdfs' ? mountHdfsGroup(ws, { task: tj, meta, data, dataset: ds, rightPane: pane }) : mountLineGroup(ws, { task: tj, meta, data, dataset: ds, rightPane: pane });
  App.cleanup = () => ctl.destroy();
}
