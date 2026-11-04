// Student report: JSON (complete, recomputable by the PI page) and CSV (one row per group).
import { csvRow } from './util.js';
import { computeMetrics, MODES } from './core.js';

export const APP_VERSION = '1.0.0';

export function taskRef(entry) { return entry.part ? `${entry.key}~${entry.part.split('/')[0]}` : entry.key; }

export function assignedGroups(entry, taskJson, exampleIds) {
  if (entry.groups) return entry.groups.slice();
  return taskJson.groups.filter((m) => !exampleIds.has(m.id)).map((m) => m.g);
}

// group records for one assignment (only assigned, non-example groups)
export function groupRecords(store, ref, assigned, taskJson) {
  const t = store.task(ref);
  const order = t ? t.order : assigned;
  const pos = new Map(order.map((g, k) => [g, k]));
  return assigned.map((g) => {
    const s = t && t.groups[g];
    return {
      g, id: taskJson.groups[g].id, queuePos: pos.has(g) ? pos.get(g) + 1 : null,
      status: s ? (s.status === 'merged-pending' ? 'open' : s.status) : 'untouched',
      submittedAt: s?.submittedAt ?? null,
      activeMs: Math.round(s?.activeMs || 0), opens: s?.opens || 0, defers: s?.defers || 0,
      instanceFields: s?.instanceFields || [],
      judgments: s?.judgments || [],
      mergedInto: s?.mergedInto || null,
      result: s?.result || null,
    };
  });
}

// coverage (members per mode) without answers, from stored judgment sizes
export function coverageFromRecords(recs, taskJson) {
  const cov = Object.fromEntries(MODES.map((m) => [m, 0]));
  const jud = Object.fromEntries(MODES.map((m) => [m, 0]));
  for (const r of recs) {
    if (r.status !== 'submitted') continue;
    if (r.mergedInto) { cov.merge += taskJson.groups[r.g].n; continue; }
    for (const j of r.judgments) { cov[j.mode] += j.members; jud[j.mode]++; }
  }
  return { coverage: cov, judgments: jud };
}

export function buildReport({ store, manifest, entries, tasks, exampleIds, answersByRef }) {
  const st = store.state;
  const out = {
    kind: 'labeling-report', schema: 1, app: APP_VERSION,
    name: store.name, dataVersion: manifest.version, generatedAt: new Date().toISOString(),
    examples: st.examples,
    tasks: [],
    sessions: st.sessions,
    samples: st.samples,
    sampleFields: ['t', 'context(L=label,R=review,E=example,-=none)', 'task-or-dataset', 'group', 'visible', 'focused', 'secondsSinceInput', 'paused', 'activeMsInInterval', 'inputsInInterval'],
    log: st.log,
    lastBackup: st.backup.lastAt,
  };
  for (const e of entries) {
    const ref = taskRef(e);
    const tj = tasks[e.key];
    const assigned = assignedGroups(e, tj, exampleIds);
    const recs = groupRecords(store, ref, assigned, tj);
    const t = store.task(ref);
    const { coverage, judgments } = coverageFromRecords(recs, tj);
    const item = {
      ref, key: e.key, part: e.part || null, display: e.display, dataset: tj.dataset, unit: tj.unit,
      groupsAssigned: assigned.length,
      groupsSubmitted: recs.filter((r) => r.status === 'submitted').length,
      membersAssigned: assigned.reduce((a, g) => a + tj.groups[g].n, 0),
      labelMs: recs.reduce((a, r) => a + r.activeMs, 0),
      reviewMs: Math.round(t?.reviewMs || 0),
      startedAt: t?.startedAt ?? null,
      judgmentCounts: judgments, coverage,
      groups: recs,
      metrics: null,
    };
    const ans = answersByRef?.[ref];
    if (ans) { const m = computeMetrics(recs, ans); item.metrics = m; }
    out.tasks.push(item);
  }
  return out;
}

export function reportCsv(rep) {
  const rows = [csvRow(['name', 'task', 'part', 'group_index', 'group_id', 'queue_pos', 'status', 'effective_seconds', 'opens', 'defers',
    'n_judgments', 'modes', 'labels', 'rules', 'members_covered', 'merged_into_group', 'submitted_at', 'answer_members', 'answer_anomalous', 'agree'])];
  for (const t of rep.tasks) {
    for (const r of t.groups) {
      rows.push(csvRow([rep.name, t.display, t.part || '', r.g, r.id, r.queuePos ?? '', r.status, (r.activeMs / 1000).toFixed(0), r.opens, r.defers,
        r.judgments.length, r.judgments.map((j) => j.mode).join('|'), r.judgments.map((j) => j.label).join('|'),
        r.judgments.map((j) => j.rules.join('+')).join('|'), r.judgments.reduce((a, j) => a + j.members, 0),
        r.mergedInto ? r.mergedInto.g : '', r.submittedAt ? new Date(r.submittedAt).toISOString() : '',
        r.result ? r.result.members : '', r.result ? r.result.anomalies : '', r.result ? r.result.agree : '']));
    }
  }
  return rows.join('\r\n') + '\r\n';
}
