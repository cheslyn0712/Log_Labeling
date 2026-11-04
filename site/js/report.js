// What students report: per task, effective labeling time, accuracy and the "can't tell" share. Computed from the per-group results stored when a group's answer is shown.
import { csvRow } from './util.js';

export function taskRef(entry) { return entry.part ? `${entry.key}~${entry.part.split('/')[0]}` : entry.key; }

export function assignedGroups(entry, taskJson, exampleIds) {
  if (entry.groups) return entry.groups.slice();
  return taskJson.groups.filter((m) => !exampleIds.has(m.id)).map((m) => m.g);
}

/**
 * Definitions (members = lines for BGL / Thunderbird, blocks for HDFS; submitted groups only):
 *   accuracy   = correct / judged, judged = members labeled Normal or Anomalous
 *   can't tell = members labeled "Can't tell" / all members of submitted groups
 *   time       = effective labeling time of all the task's groups (answer review not included)
 */
export function taskSummary(t, assigned) {
  const s = { groups: assigned.length, done: 0, ms: 0, members: 0, judged: 0, correct: 0, unknown: 0 };
  for (const g of assigned) {
    const x = t?.groups[g];
    if (!x) continue;
    s.ms += x.activeMs || 0;
    if (x.status !== 'submitted') continue;
    s.done++;
    const r = x.result;
    if (r) for (const k of ['members', 'judged', 'correct', 'unknown']) s[k] += r[k] || 0;
  }
  s.accuracy = s.judged ? s.correct / s.judged : null;
  s.cantTell = s.members ? s.unknown / s.members : null;
  return s;
}

export const pct = (x) => (x == null ? '—' : (100 * x).toFixed(1) + '%');
export function hours(ms) {
  const m = Math.round((ms || 0) / 60000);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function summaryText(name, rows) {
  const lines = [`Log labeling results — ${name}`];
  for (const { display, s } of rows) {
    lines.push(`${display}: ${s.done}/${s.groups} groups · labeling time ${hours(s.ms)} · accuracy ${pct(s.accuracy)} · can't tell ${pct(s.cantTell)}`);
  }
  return lines.join('\n');
}

export function summaryCsv(name, rows) {
  const out = [csvRow(['name', 'task', 'groups_done', 'groups_total', 'labeling_hours', 'accuracy', 'cant_tell_rate', 'members_done', 'unit'])];
  for (const { display, s, unit } of rows) {
    out.push(csvRow([name, display, s.done, s.groups, (s.ms / 3600000).toFixed(2),
      s.accuracy == null ? '' : s.accuracy.toFixed(4), s.cantTell == null ? '' : s.cantTell.toFixed(4), s.members, unit]));
  }
  return out.join('\r\n') + '\r\n';
}
