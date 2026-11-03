// Effective-time tracking.
// Active = page visible AND window focused AND a keyboard/mouse/scroll event in the last 60 s AND not paused.
// Time is attributed to the current context: labeling a group, reviewing answers, or viewing an example.
// A raw sample is stored every 15 s so time can be recomputed later with other thresholds.
export const IDLE_MS = 60_000;
export const SAMPLE_MS = 15_000;
const TICK_MS = 1000;
const SAVE_MS = 5000;

export class Timer {
  constructor() {
    this.store = null;
    this.ctx = null;
    this.session = null;
    this.paused = false;
    this.lastInput = Date.now();
    this.lastTick = Date.now();
    this.lastSample = Date.now();
    this.sampleActive = 0;
    this.sampleInputs = 0;
    this.dirty = false;
    this.listeners = new Set();
    this._status = 'off';
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
    this.store = store;
    // close sessions left open by a crash or a closed tab
    for (const s of store.state.sessions) if (!s.end) { s.end = s.last || s.start; s.reason = 'recovered'; }
    store.save();
  }

  onChange(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
  emit() { for (const f of this.listeners) f(this._status); }

  status() { return this._status; }

  computeStatus() {
    if (!this.ctx) return 'off';
    if (this.paused) return 'paused';
    const t = this.now();
    if (!this.isVisible() || !this.hasFocus() || t - this.lastInput > IDLE_MS) return 'idle';
    return 'timing';
  }

  setContext(ctx) {
    const same = ctx && this.ctx && ctx.type === this.ctx.type && ctx.ref === this.ctx.ref && ctx.g === this.ctx.g && ctx.ds === this.ctx.ds;
    if (same) return;
    this.tick();
    this.endSession('leave');
    this.ctx = ctx;
    this.paused = false;
    if (ctx) this.startSession();
    this.updateStatus();
  }

  startSession() {
    if (!this.store || !this.ctx) return;
    const t = this.now();
    this.session = { ctx: this.ctx.type, ref: this.ctx.ref ?? null, g: this.ctx.g ?? null, ds: this.ctx.ds ?? null, start: t, last: t, end: null, activeMs: 0, reason: null };
    this.store.state.sessions.push(this.session);
    this.dirty = true;
  }

  endSession(reason) {
    if (!this.session) return;
    this.tick();
    this.session.end = this.now();
    this.session.reason = reason;
    this.session = null;
    this.dirty = true;
    this.flush();
  }

  pause() { if (!this.ctx || this.paused) return; this.tick(); this.endSession('pause'); this.paused = true; this.store?.log('pause', {}); this.updateStatus(); }
  resume() { if (!this.paused) return; this.paused = false; this.lastInput = this.now(); this.lastTick = this.now(); this.startSession(); this.store?.log('resume', {}); this.updateStatus(); }

  target() {
    const st = this.store?.state;
    if (!st || !this.ctx) return null;
    const c = this.ctx;
    if (c.type === 'label') { const t = st.tasks[c.ref]; return t && t.groups[c.g]; }
    if (c.type === 'review') return st.tasks[c.ref];
    if (c.type === 'example') { st.examples[c.ds] = st.examples[c.ds] || {}; return st.examples[c.ds]; }
    return null;
  }

  tick() {
    const t = this.now();
    const dt = Math.min(Math.max(0, t - this.lastTick), 2 * TICK_MS);
    this.lastTick = t;
    const status = this.computeStatus();
    if (status === 'timing' && this.store) {
      const tg = this.target();
      if (tg) {
        const field = this.ctx.type === 'review' ? 'reviewMs' : this.ctx.type === 'example' ? 'ms' : 'activeMs';
        tg[field] = (tg[field] || 0) + dt;
      }
      if (this.session) this.session.activeMs += dt;
      this.sampleActive += dt;
      this.dirty = true;
    }
    if (this.session) this.session.last = t;
    if (t - this.lastSample >= SAMPLE_MS) this.sample(t);
    if (status !== this._status) { this._status = status; this.emit(); }
    else if (status === 'timing') this.emit();
  }

  sample(t) {
    if (this.store) {
      const c = this.ctx;
      this.store.state.samples.push([
        t, c ? c.type[0].toUpperCase() : '-', c?.ref ?? c?.ds ?? null, c?.g ?? null,
        this.isVisible() ? 1 : 0, this.hasFocus() ? 1 : 0, Math.round((t - this.lastInput) / 1000),
        this.paused ? 1 : 0, Math.round(this.sampleActive), this.sampleInputs,
      ]);
      this.dirty = true;
    }
    this.lastSample = t;
    this.sampleActive = 0;
    this.sampleInputs = 0;
  }

  updateStatus() { this._status = this.computeStatus(); this.emit(); }

  flush() {
    if (this.dirty && this.store) { this.dirty = false; this.store.save(); }
  }
}
