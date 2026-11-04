// Coverage resolution and per-judgment comparison with the answers. Pure functions (no DOM).
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

// Per-judgment comparison used in the answer view.
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
