// Per-student state in localStorage. Every action is saved immediately.
// Several windows / tabs may be open at once: every write first re-reads what the
// other windows saved, then applies only this window's change (read-modify-write),
// so no window overwrites another's progress.
const PREFIX = 'loglabel:v1:';
export const SCHEMA = 1;

export const TAB_ID = Math.random().toString(36).slice(2, 8);

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

function fresh(name, dataVersion) {
  const now = Date.now();
  return {
    schema: SCHEMA, name, dataVersion, createdAt: now, updatedAt: now,
    examples: {}, tasks: {}, sessions: [], samples: [], log: [],
    backup: { lastAt: null, groupsSince: 0 },
  };
}

export function uid(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

export class Store {
  constructor(name, dataVersion) {
    this.name = name;
    this.key = PREFIX + 'user:' + name;
    this.listeners = new Set();
    this.externalListeners = new Set();
    this.hooks = new Set();      // run on every write with the fresh state (timer deltas)
    this.pendingLog = [];
    this.saveError = null;
    this.wiped = false;
    this.raw = localStorage.getItem(this.key);
    this.state = this.raw ? JSON.parse(this.raw) : fresh(name, dataVersion);
    this.versionMismatch = !!this.raw && this.state.dataVersion !== dataVersion;
    if (!this.raw) { this.pendingLog.push([Date.now(), 'create', {}]); this.write(); }
    this._onStorage = (e) => {
      if (e.key !== this.key) return;
      if (e.newValue === null) { this.wiped = true; for (const f of this.externalListeners) f('wiped'); return; }
      this.reload();
      for (const f of this.externalListeners) f('changed');
    };
    window.addEventListener('storage', this._onStorage);
  }

  close() { window.removeEventListener('storage', this._onStorage); this.hooks.clear(); }

  // pick up what other windows saved
  reload() {
    const raw = localStorage.getItem(this.key);
    if (raw === null) { if (this.raw !== null) this.wiped = true; return false; }
    if (raw === this.raw) return false;
    this.raw = raw;
    this.state = JSON.parse(raw);
    return true;
  }

  write() {
    if (this.wiped) return;
    for (const f of this.hooks) f(this.state);
    if (this.pendingLog.length) { this.state.log.push(...this.pendingLog); this.pendingLog = []; }
    this.state.updatedAt = Date.now();
    const s = JSON.stringify(this.state);
    try {
      localStorage.setItem(this.key, s);
      this.raw = s;
      this.saveError = null;
    } catch (e) {
      this.saveError = e;
    }
    for (const f of this.listeners) f();
  }

  // flush pending log entries / timer deltas
  save() { this.reload(); this.write(); }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  onExternal(f) { this.externalListeners.add(f); return () => this.externalListeners.delete(f); }

  // log entry saved with the next write
  log(type, data) { this.pendingLog.push([Date.now(), type, data || {}]); }

  /**
   * Apply one action to the freshest state and save it.
   * mutate(state) must look objects up from `state` (or via this.task / this.group) — never
   * use objects fetched before the call. Returning false cancels the action (nothing is saved).
   */
  act(type, data, mutate) {
    this.reload();
    if (mutate) {
      const r = mutate(this.state);
      if (r === false) { this.reload(); for (const f of this.listeners) f(); return false; }
    }
    this.pendingLog.push([Date.now(), type, data || {}]);
    this.write();
    return true;
  }

  task(ref) { return this.state.tasks[ref]; }

  ensureTask(ref, order) {
    if (!this.state.tasks[ref]) {
      this.act('task-start', { ref }, (s) => {
        if (!s.tasks[ref]) s.tasks[ref] = { startedAt: Date.now(), order, groups: {}, reviewMs: 0 };
      });
    }
    return this.state.tasks[ref];
  }

  group(ref, g) {
    const t = this.state.tasks[ref];
    if (!t.groups[g]) t.groups[g] = { status: 'open', judgments: [], activeMs: 0, opens: 0, defers: 0, instanceFields: [] };
    return t.groups[g];
  }

  backupPayload() {
    this.save();
    return { kind: 'labeling-backup', schema: SCHEMA, name: this.name, dataVersion: this.state.dataVersion, exportedAt: Date.now(), state: this.state };
  }

  markBackup() {
    this.act('backup-export', {}, (s) => { s.backup = { lastAt: Date.now(), groupsSince: 0 }; });
  }

  // returns error string or null
  importBackup(obj, dataVersion) {
    if (!obj || obj.kind !== 'labeling-backup' || !obj.state) return 'This file is not a labeling backup.';
    if (obj.name !== this.name) return `This backup belongs to “${obj.name}”, not to ${this.name}. Import refused.`;
    if (obj.dataVersion !== dataVersion || obj.state.dataVersion !== dataVersion) return `This backup was made for data version ${obj.dataVersion}; the site now serves ${dataVersion}. Import refused — contact the PI.`;
    this.state = obj.state;
    this.pendingLog.push([Date.now(), 'backup-import', { exportedAt: obj.exportedAt }]);
    this.wiped = false;
    this.write();
    return null;
  }

  wipe() {
    this.wiped = true;
    localStorage.removeItem(this.key);
  }
}
