// Metrics and the Excel export.
//
// Each participant gives every group of a task ONE label: normal, anomaly (Anomalous) or unknown (Can't tell).
// Truth of a group = anomalous if any of its members (lines; HDFS: blocks) is anomalous, else normal.
// Group-level metrics use one item per labeled group; member-level metrics apply the group's label to
// every member. "Can't tell" items are excluded from accuracy and precision and count as misses in recall.
// Labels can be changed at any time. If a group's answer was checked, the label held at that moment is
// the scored one (records from before this rule have no labelAtCheck: their label was locked, so it is
// the same); the current label is exported as final_label.

export const LABEL_NAMES = { normal: 'Normal', anomaly: 'Anomalous', unknown: "Can't tell" };
export const LABEL_CODES = { normal: 0, anomaly: 1, unknown: 'U' };

export function scoredLabel(x) {
  return x?.revealed && x.labelAtCheck !== undefined ? x.labelAtCheck : x?.label;
}

export function taskRef(entry) { return entry.part ? `${entry.key}~${entry.part.split('/')[0]}` : entry.key; }

export function assignedGroups(entry, taskJson, exampleIds) {
  if (entry.groups) return entry.groups.slice();
  return taskJson.groups.filter((m) => !exampleIds.has(m.id)).map((m) => m.g);
}

// answer array of one group -> { normal, anomalous, truth }
export function groupTruth(ans, kind) {
  let normal = 0, anomalous = 0;
  for (const a of ans) {
    if (kind === 'blocks') { if (a) anomalous++; else normal++; }
    else { normal += a[0]; anomalous += a[1]; }
  }
  return { normal, anomalous, truth: anomalous > 0 ? 'anomaly' : 'normal' };
}

// rows: [{ label, normal, anomalous }] (counts of truly normal / anomalous items behind each label)
export function metrics(rows) {
  let tp = 0, fp = 0, tn = 0, fn = 0, unk = 0, unkAnom = 0;
  for (const r of rows) {
    if (r.label === 'normal') { tn += r.normal; fn += r.anomalous; }
    else if (r.label === 'anomaly') { tp += r.anomalous; fp += r.normal; }
    else if (r.label === 'unknown') { unk += r.normal + r.anomalous; unkAnom += r.anomalous; }
  }
  const judged = tp + fp + tn + fn;
  const div = (a, b) => (b > 0 ? a / b : null);
  const pos = tp + fn + unkAnom;
  return {
    items: judged + unk, judged, tp, fp, tn, fn, unknown: unk,
    accuracy: div(tp + tn, judged),
    precision: div(tp, tp + fp),
    recall: div(tp, pos),
    f1: pos > 0 ? (2 * tp) / (2 * tp + fp + fn + unkAnom) : null,
    cantTell: div(unk, judged + unk),
  };
}

export function taskTime(t) {
  const auto = Object.values(t?.groups || {}).reduce((a, x) => a + (x.activeMs || 0), 0);
  const adjust = t?.timeAdjustMs || 0;
  return { auto, adjust, total: Math.max(0, auto + adjust) };
}

// summary of one assignment; truths: Map g -> groupTruth (may be partial; metrics use labeled groups with known truth)
export function taskSummary(t, assigned, truths) {
  const s = { groups: assigned.length, labeled: 0, normal: 0, anomaly: 0, unknown: 0, checked: 0, changedAfterAnswer: 0 };
  const gRows = [], mRows = [];
  for (const g of assigned) {
    const x = t?.groups?.[g];
    const label = scoredLabel(x);
    if (!label) continue;
    s.labeled++; s[label]++;
    if (x.revealed) s.checked++;
    if (x.label !== label) s.changedAfterAnswer++;
    const tr = truths?.get(g);
    if (!tr) continue;
    gRows.push({ label, normal: tr.truth === 'normal' ? 1 : 0, anomalous: tr.truth === 'anomaly' ? 1 : 0 });
    mRows.push({ label, normal: tr.normal, anomalous: tr.anomalous });
  }
  return { ...s, time: taskTime(t), group: metrics(gRows), member: metrics(mRows) };
}

export const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%');
export const f1s = (x) => (x == null ? 'n/a' : x.toFixed(3));
export function hm(ms) {
  const m = Math.round((ms || 0) / 60000);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
const num = (x, d = 4) => (x == null ? '' : +x.toFixed(d));
const iso = (ts) => (ts ? new Date(ts).toISOString() : '');

/**
 * Workbook for one participant.
 * items: [{ entry, tj, t, assigned, truths, unit }]
 */
export function workbook(participant, dataVersion, items) {
  const summary = [[
    'participant', 'task', 'dataset', 'unit', 'groups_total', 'groups_labeled', 'labeled_normal', 'labeled_anomalous', 'labeled_cant_tell', 'answers_checked',
    'changed_after_answer', 'time_hours', 'time_auto_hours', 'time_adjust_hours',
    'group_accuracy', 'group_precision', 'group_recall', 'group_f1', 'group_cant_tell_rate', 'group_tp', 'group_fp', 'group_tn', 'group_fn',
    'member_accuracy', 'member_precision', 'member_recall', 'member_f1', 'member_cant_tell_rate', 'members_labeled', 'data_version',
  ]];
  const groups = [[
    'participant', 'task', 'dataset', 'group_id', 'group_index', 'queue_position', 'label', 'label_code', 'rule', 'note',
    'labeled_at', 'label_changes', 'answer_checked', 'final_label', 'changes_after_answer', 'time_seconds', 'members', 'true_normal', 'true_anomalous', 'true_group_label', 'group_correct', 'members_correct',
  ]];
  const timeLog = [['participant', 'task', 'time', 'event', 'detail']];
  for (const it of items) {
    const { entry, tj, t, assigned, truths, unit } = it;
    const s = taskSummary(t, assigned, truths);
    summary.push([participant, entry.display, tj.dataset, unit, s.groups, s.labeled, s.normal, s.anomaly, s.unknown, s.checked,
      s.changedAfterAnswer, num(s.time.total / 3600000), num(s.time.auto / 3600000), num(s.time.adjust / 3600000),
      num(s.group.accuracy), num(s.group.precision), num(s.group.recall), num(s.group.f1), num(s.group.cantTell), s.group.tp, s.group.fp, s.group.tn, s.group.fn,
      num(s.member.accuracy), num(s.member.precision), num(s.member.recall), num(s.member.f1), num(s.member.cantTell), s.member.items, dataVersion]);
    const order = t?.order || assigned;
    order.forEach((g, k) => {
      const x = t?.groups?.[g] || {};
      const tr = truths?.get(g);
      const label = scoredLabel(x) || '';
      let gc = '', mc = '';
      if (tr && (label === 'normal' || label === 'anomaly')) {
        gc = label === tr.truth ? 1 : 0;
        mc = label === 'normal' ? tr.normal : tr.anomalous;
      }
      groups.push([participant, entry.display, tj.dataset, tj.groups[g].id, g, k + 1, label ? LABEL_NAMES[label] : '', label ? LABEL_CODES[label] : '',
        x.rule || '', x.note || '', iso(x.at), x.edits || 0, x.revealed ? 1 : 0,
        x.label ? LABEL_NAMES[x.label] : '', x.editsAfterAnswer || 0, num((x.activeMs || 0) / 1000, 1),
        tr ? tr.normal + tr.anomalous : tj.groups[g].n, tr ? tr.normal : '', tr ? tr.anomalous : '', tr ? LABEL_NAMES[tr.truth] : '', gc, mc]);
    });
    for (const e of t?.timeLog || []) timeLog.push([participant, entry.display, iso(e.at), e.type, e.detail || '']);
  }
  return [
    { name: 'Summary', rows: summary },
    { name: 'Groups', rows: groups },
    { name: 'Time log', rows: timeLog },
  ];
}
