// Per-student state in localStorage. Every action is saved immediately.
const PREFIX = 'loglabel:v1:';
export const SCHEMA = 1;

export function storageAvailable() {
  try {
    const k = PREFIX + '__probe';
    localStorage.setItem(k, '1');
    const ok = localStorage.getItem(k) === '1';
    localStorage.removeItem(k);
    return ok;
  } catch { return false; }
}

export function canonicalName(input, names) {
  const s = String(input || '').trim().toLowerCase();
  return names.find((n) => n.toLowerCase() === s) || null;
}

export function getCurrentName() { try { return localStorage.getItem(PREFIX + 'current'); } catch { return null; } }
export function setCurrentName(n) {
  if (n) localStorage.setItem(PREFIX + 'current', n); else localStorage.removeItem(PREFIX + 'current');
}
export function hasData(name) { try { return !!localStorage.getItem(PREFIX + 'user:' + name); } catch { return false; } }

function fresh(name, dataVersion) {
  const now = Date.now();
  return {
    schema: SCHEMA, name, dataVersion, createdAt: now, updatedAt: now,
    examples: {}, tasks: {}, sessions: [], samples: [], log: [],
    backup: { lastAt: null, groupsSince: 0 },
  };
}

export class Store {
  constructor(name, dataVersion) {
    this.name = name;
    this.key = PREFIX + 'user:' + name;
    this.listeners = new Set();
    this.saveError = null;
    const raw = localStorage.getItem(this.key);
    this.state = raw ? JSON.parse(raw) : fresh(name, dataVersion);
    this.versionMismatch = !!raw && this.state.dataVersion !== dataVersion;
    if (!raw) { this.log('create', {}); this.save(); }
  }

  save() {
    this.state.updatedAt = Date.now();
    try {
      localStorage.setItem(this.key, JSON.stringify(this.state));
      this.saveError = null;
    } catch (e) {
      this.saveError = e;
    }
    for (const f of this.listeners) f();
  }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }

  log(type, data) { this.state.log.push([Date.now(), type, data || {}]); }

  act(type, data, mutate) {
    if (mutate) mutate(this.state);
    this.log(type, data);
    this.save();
  }

  task(ref) { return this.state.tasks[ref]; }

  ensureTask(ref, order) {
    if (!this.state.tasks[ref]) {
      this.state.tasks[ref] = { startedAt: Date.now(), order, groups: {}, unlocked: null, reviewMs: 0, seq: 0 };
      this.log('task-start', { ref });
      this.save();
    }
    return this.state.tasks[ref];
  }

  group(ref, g) {
    const t = this.state.tasks[ref];
    if (!t.groups[g]) t.groups[g] = { status: 'open', judgments: [], activeMs: 0, opens: 0, defers: 0, instanceFields: [] };
    return t.groups[g];
  }

  backupPayload() {
    return { kind: 'labeling-backup', schema: SCHEMA, name: this.name, dataVersion: this.state.dataVersion, exportedAt: Date.now(), state: this.state };
  }

  markBackup() {
    this.state.backup = { lastAt: Date.now(), groupsSince: 0 };
    this.log('backup-export', {});
    this.save();
  }

  // returns error string or null
  importBackup(obj, dataVersion) {
    if (!obj || obj.kind !== 'labeling-backup' || !obj.state) return 'This file is not a labeling backup.';
    if (obj.name !== this.name) return `This backup belongs to “${obj.name}”, not to ${this.name}. Import refused.`;
    if (obj.dataVersion !== dataVersion || obj.state.dataVersion !== dataVersion) return `This backup was made for data version ${obj.dataVersion}; the site now serves ${dataVersion}. Import refused — contact the PI.`;
    this.state = obj.state;
    this.state.log.push([Date.now(), 'backup-import', { exportedAt: obj.exportedAt }]);
    this.save();
    return null;
  }

  wipe() {
    localStorage.removeItem(this.key);
  }
}

// One open tab per browser, so two tabs cannot overwrite each other's progress.
const TAB_KEY = PREFIX + 'tab';
const tabId = Math.random().toString(36).slice(2);
export function claimTab(force) {
  try {
    const cur = JSON.parse(localStorage.getItem(TAB_KEY) || 'null');
    if (!force && cur && cur.id !== tabId && Date.now() - cur.t < 8000) return false;
    localStorage.setItem(TAB_KEY, JSON.stringify({ id: tabId, t: Date.now() }));
    return true;
  } catch { return true; }
}
export function heartbeatTab(onLost) {
  setInterval(() => {
    try {
      const cur = JSON.parse(localStorage.getItem(TAB_KEY) || 'null');
      if (cur && cur.id !== tabId) { onLost(); return; }
      localStorage.setItem(TAB_KEY, JSON.stringify({ id: tabId, t: Date.now() }));
    } catch { /* ignore */ }
  }, 3000);
  window.addEventListener('pagehide', () => {
    try { const cur = JSON.parse(localStorage.getItem(TAB_KEY) || 'null'); if (cur && cur.id === tabId) localStorage.removeItem(TAB_KEY); } catch { /* ignore */ }
  });
}
