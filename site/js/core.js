// Coverage checking and accuracy metrics. Pure functions (no DOM) shared by the
// student site and the PI summary page, so both compute identical numbers.
import { b64ToBits, bitsHas } from './util.js';

export const LABELS = ['normal', 'anomaly', 'unknown'];
export const MODES = ['propagate', 'split', 'items', 'merge'];
export const MODE_NAMES = { propagate: 'Whole group', split: 'Split by field', items: 'Selected items', merge: 'Merged groups' };
export const LABEL_NAMES = { normal: 'Normal', anomaly: 'Anomalous', unknown: "Can't tell" };

// answers.groups[g][j] -> [normal members, anomalous members] of item j
export function itemCounts(answers, g, j) {
  const a = answers.groups[g][j];
  return answers.kind === 'blocks' ? (a ? [0, 1] : [1, 0]) : a;
}
export function nItems(answers, g) { return answers.groups[g].length; }

// Resolve which label covers each item of a submitted group.
// Returns { labels: Array(nItems) of {label, jidx, mode} | null, errors: [] }
export function resolveGroup(groupRec, nItemsInGroup, lookupMerge) {
  const res = new Array(nItemsInGroup).fill(null);
  const errors = [];
  if (groupRec.mergedInto) {
    const j = lookupMerge(groupRec.mergedInto);
    if (!j) { errors.push(`group ${groupRec.g}: merge origin not found`); return { labels: res, errors }; }
    for (let i = 0; i < nItemsInGroup; i++) res[i] = { label: j.label, mode: 'merge', merged: true };
    return { labels: res, errors };
  }
  (groupRec.judgments || []).forEach((j, jidx) => {
    const bits = b64ToBits(j.bits);
    for (let i = 0; i < nItemsInGroup; i++) {
      if (bitsHas(bits, i)) {
        if (res[i]) errors.push(`group ${groupRec.g}: item ${i} covered twice`);
        else res[i] = { label: j.label, jidx, mode: j.mode };
      }
    }
    for (let i = nItemsInGroup; i < bits.length * 8; i++) if (bitsHas(bits, i)) { errors.push(`group ${groupRec.g}: item ${i} out of range`); break; }
  });
  if (groupRec.status === 'submitted' && res.some((x) => !x)) errors.push(`group ${groupRec.g}: submitted but not fully covered`);
  return { labels: res, errors };
}

function emptyCounts() {
  return {
    groupsAssigned: 0, groupsSubmitted: 0, groupsCorrect: 0,
    members: 0, normalMembers: 0, anomalyMembers: 0, unknownMembers: 0,
    correct: 0, tp: 0, fp: 0, fn: 0, answerAnomalies: 0,
    judgments: { propagate: 0, split: 0, items: 0, merge: 0 },
    coverage: { propagate: 0, split: 0, items: 0, merge: 0 },
  };
}

/**
 * Metrics over the locked (submitted) groups of one task assignment.
 * groups: [{ g, status, judgments, mergedInto }] for the assigned groups only (examples never included).
 * answers: decrypted answers object, or null to compute only counts.
 */
export function computeMetrics(groups, answers) {
  const c = emptyCounts();
  const errors = [];
  const byG = new Map(groups.map((r) => [r.g, r]));
  const lookupMerge = (m) => {
    const o = byG.get(m.g);
    return o && (o.judgments || []).find((j) => j.id === m.jid);
  };
  c.groupsAssigned = groups.length;
  for (const r of groups) {
    if (r.status !== 'submitted') continue;
    c.groupsSubmitted++;
    for (const j of r.judgments || []) c.judgments[j.mode] = (c.judgments[j.mode] || 0) + 1;
    if (!answers) continue;
    const n = nItems(answers, r.g);
    const { labels, errors: e } = resolveGroup(r, n, lookupMerge);
    errors.push(...e);
    let allRight = true;
    for (let i = 0; i < n; i++) {
      const [nn, na] = itemCounts(answers, r.g, i);
      const w = nn + na;
      c.members += w;
      c.answerAnomalies += na;
      const L = labels[i];
      if (!L) { allRight = false; continue; }
      c.coverage[L.mode] = (c.coverage[L.mode] || 0) + w;
      if (L.label === 'normal') { c.normalMembers += w; c.correct += nn; c.fn += na; if (na) allRight = false; }
      else if (L.label === 'anomaly') { c.anomalyMembers += w; c.correct += na; c.tp += na; c.fp += nn; if (nn) allRight = false; }
      else { c.unknownMembers += w; c.fn += na; allRight = false; }
    }
    if (allRight) c.groupsCorrect++;
  }
  return { ...c, ...rates(c), errors };
}

export function rates(c) {
  const judged = c.normalMembers + c.anomalyMembers;
  const covered = judged + c.unknownMembers;
  const div = (a, b) => (b > 0 ? a / b : null);
  const precision = div(c.tp, c.tp + c.fp);
  const recall = div(c.tp, c.tp + c.fn);
  const f1 = precision != null && recall != null ? (precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0) : null;
  return {
    memberAccuracy: div(c.correct, judged),
    groupAccuracy: div(c.groupsCorrect, c.groupsSubmitted),
    precision, recall, f1,
    unknownRate: div(c.unknownMembers, covered),
    conservativeAccuracy: div(c.correct, covered),
  };
}

// Coverage counts (members per mode) without answers: needs item weights per group.
// weights(g) -> array of member counts per item
export function coverageCounts(groups, weights) {
  const cov = { propagate: 0, split: 0, items: 0, merge: 0 };
  const jud = { propagate: 0, split: 0, items: 0, merge: 0 };
  const byG = new Map(groups.map((r) => [r.g, r]));
  for (const r of groups) {
    if (r.status !== 'submitted') continue;
    for (const j of r.judgments || []) jud[j.mode]++;
    const w = weights(r.g);
    if (!w) continue;
    const { labels } = resolveGroup(r, w.length, (m) => (byG.get(m.g)?.judgments || []).find((j) => j.id === m.jid));
    labels.forEach((L, i) => { if (L) cov[L.mode] += w[i]; });
  }
  return { coverage: cov, judgments: jud };
}

// Per-judgment comparison used on the review page.
export function judgmentAgreement(answers, g, bits, label, nItemsInGroup) {
  let nn = 0, na = 0, items = 0;
  const wrongItems = [];
  for (let i = 0; i < nItemsInGroup; i++) {
    if (!bitsHas(bits, i)) continue;
    items++;
    const [a, b] = itemCounts(answers, g, i);
    nn += a; na += b;
    if ((label === 'normal' && b) || (label === 'anomaly' && a) || label === 'unknown') wrongItems.push(i);
  }
  const agree = label === 'normal' ? nn : label === 'anomaly' ? na : 0;
  return { items, members: nn + na, normal: nn, anomaly: na, agree, wrongItems };
}
