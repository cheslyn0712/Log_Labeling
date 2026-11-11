// Effective-time tracking.
// Active = page visible AND window focused AND a keyboard/mouse/scroll event in the last 60 s AND not paused.
// Time is attributed to the current context: labeling a group, reviewing answers, or viewing an example.
// A raw sample is stored every 15 s so time can be recomputed later with other thresholds.
// Time is kept as pending deltas and added to the freshest saved state on each write,
// so several open windows never overwrite each other's time (only the focused one counts).
import { TAB_ID, newGroup } from './store.js';

export const IDLE_MS = 60_000;
export const SAMPLE_MS = 15_000;
const TICK_MS = 1000;
const SAVE_MS = 5000;
const STALE_SESSION_MS = 60_000;

export class Timer {
  constructor() {
    this.store = null;
    this.ctx = null;
    this.session = null;       // in-memory copy, merged into state.sessions by id
    this.idleMs = IDLE_MS;
    this.lastInput = Date.now();
    this.lastTick = Date.now();
    this.lastSample = Date.now();
    this.sampleActive = 0;
    this.sampleInputs = 0;
    this.pending = new Map();  // target key -> ms not yet saved
    this.pendingSamples = [];
    this.dirty = false;
    this.seq = 0;
    this.listeners = new Set();
    this._status = 'off';
    this._hook = (st) => this.applyPending(st);
    // overridable for tests
    this.now = () => Date.now();
    this.isVisible = () => document.visibilityState === 'visible';
    this.hasFocus = () => document.hasFocus();

    const onInput = () => { this.lastInput = this.now(); this.sampleInputs++; };
    let lastMove = 0;
    for (const ev of ['keydown', 'mousedown', 'wheel', 'touchstart', 'pointerdown']) window.addEventListener(ev, onInput, { capture: true, passive: true });
    window.addEventListener('scroll', onInput, { capture: true, passive: true });
    window.addEventListener('mousemove', () => { const t = this.now(); if (t - lastMove > 1000) { lastMove = t; onInput(); } }, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { this.tick(); if (document.visibilityState === 'hidden') this.flush(); });
    window.addEventListener('pagehide', () => { this.endSession('close'); this.flush(); });
    this._iv = setInterval(() => this.tick(), TICK_MS);
    this._sv = setInterval(() => this.flush(), SAVE_MS);
  }

  attach(store) {
    this.endSession('switch-user');
    this.flush();
    if (this.store) this.store.hooks.delete(this._hook);
    this.pending.clear();
    this.pendingSamples = [];
    this.store = store;
    if (!store) return;
    store.hooks.add(this._hook);
    // close sessions left open by a crashed or closed window (other open windows keep theirs fresh)
    const t = this.now();
    if (store.state.sessions.some((s) => !s.end && t - (s.last || s.start) > STALE_SESSION_MS)) {
      store.act('recover-sessions', {}, (st) => {
        for (const s of st.sessions) if (!s.end && t - (s.last || s.start) > STALE_SESSION_MS) { s.end = s.last || s.start; s.reason = 'recovered'; }
      });
    }
  }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) f(this._status); }
  status() { return this._status; }

  computeStatus() {
    if (!this.ctx) return 'off';
    if (this.isPaused()) return 'paused';
    const t = this.now();
    if (!this.isVisible() || !this.hasFocus() || t - this.lastInput > this.idleMs) return 'idle';
    return 'timing';
  }

  ctxKey(c = this.ctx) {
    if (!c) return null;
    return c.type === 'label' ? `L|${c.ref}|${c.g}` : c.type === 'review' ? `R|${c.ref}` : `E|${c.ds}`;
  }

  setContext(ctx) {
    const same = ctx && this.ctx && this.ctxKey(ctx) === this.ctxKey();
    if (same) return;
    this.tick();
    this.endSession('leave');
    this.ctx = ctx;
    if (ctx) this.startSession();
    this.updateStatus();
  }

  startSession() {
    if (!this.store || !this.ctx) return;
    const t = this.now();
    this.session = { id: `${TAB_ID}-${++this.seq}`, tab: TAB_ID, ctx: this.ctx.type, ref: this.ctx.ref ?? null, g: this.ctx.g ?? null, ds: this.ctx.ds ?? null, start: t, last: t, end: null, activeMs: 0, reason: null };
    this.dirty = true;
  }

  endSession(reason) {
    if (!this.session) return;
    this.tick();
    this.session.end = this.now();
    this.session.reason = reason;
    this.dirty = true;
    this.flush();
    this.session = null;
  }

  // the pause switch belongs to a task and is saved, so it survives page changes and reloads
  isPaused(ref = this.ctx?.type === 'label' ? this.ctx.ref : null) { return !!(ref && this.store?.task(ref)?.paused); }
  setPaused(ref, paused) {
    if (!this.store?.task(ref) || this.isPaused(ref) === paused) return;
    this.tick();
    this.store.act(paused ? 'timer-pause' : 'timer-resume', { ref }, (s) => {
      const t = s.tasks[ref];
      t.paused = paused;
      (t.timeLog = t.timeLog || []).push({ at: Date.now(), type: paused ? 'pause' : 'resume' });
    });
    this.lastInput = this.now(); this.lastTick = this.now();
    this.updateStatus();
  }

  // effective ms of the current context (saved + not yet saved)
  displayMs() {
    const st = this.store?.state;
    const c = this.ctx;
    if (!st || !c) return 0;
    const pend = this.pending.get(this.ctxKey()) || 0;
    if (c.type === 'label') return (st.tasks[c.ref]?.groups[c.g]?.activeMs || 0) + pend;
    if (c.type === 'review') return (st.tasks[c.ref]?.reviewMs || 0) + pend;
    return (st.examples[c.ds]?.ms || 0) + pend;
  }

  tick() {
    const t = this.now();
    const dt = Math.min(Math.max(0, t - this.lastTick), 2 * TICK_MS);
    this.lastTick = t;
    const status = this.computeStatus();
    if (status === 'timing' && this.store) {
      const k = this.ctxKey();
      this.pending.set(k, (this.pending.get(k) || 0) + dt);
      if (this.session) { this.session.activeMs += dt; this.session.last = t; }
      this.sampleActive += dt;
      this.dirty = true;
    }
    if (t - this.lastSample >= SAMPLE_MS) this.sample(t);
    if (status !== this._status) { this._status = status; this.emit(); }
    else if (status === 'timing') this.emit();
  }

  sample(t) {
    if (this.store && (this.ctx || this.isVisible())) {
      const c = this.ctx;
      this.pendingSamples.push([
        t, c ? c.type[0].toUpperCase() : '-', c?.ref ?? c?.ds ?? null, c?.g ?? null,
        this.isVisible() ? 1 : 0, this.hasFocus() ? 1 : 0, Math.round((t - this.lastInput) / 1000),
        this.isPaused() ? 1 : 0, Math.round(this.sampleActive), this.sampleInputs, TAB_ID,
      ]);
      if (this.session) this.session.last = t;
      this.dirty = true;
    }
    this.lastSample = t;
    this.sampleActive = 0;
    this.sampleInputs = 0;
  }

  // store hook: add unsaved time to the freshest state
  applyPending(st) {
    for (const [k, ms] of this.pending) {
      const [type, a, b] = k.split('|');
      if (type === 'L') {
        const t = st.tasks[a];
        if (!t) continue;
        if (!t.groups[b]) t.groups[b] = newGroup();
        t.groups[b].activeMs = (t.groups[b].activeMs || 0) + ms;
      } else if (type === 'R') {
        if (st.tasks[a]) st.tasks[a].reviewMs = (st.tasks[a].reviewMs || 0) + ms;
      } else {
        st.examples[a] = st.examples[a] || {};
        st.examples[a].ms = (st.examples[a].ms || 0) + ms;
      }
    }
    this.pending.clear();
    if (this.pendingSamples.length) { st.samples.push(...this.pendingSamples); this.pendingSamples = []; }
    if (this.session) {
      const i = st.sessions.findIndex((s) => s.id === this.session.id);
      if (i >= 0) st.sessions[i] = { ...this.session };
      else st.sessions.push({ ...this.session });
    }
  }

  updateStatus() { this._status = this.computeStatus(); this.emit(); }

  flush() {
    if (this.dirty && this.store && !this.store.wiped) { this.dirty = false; this.store.save(); }
  }
}
