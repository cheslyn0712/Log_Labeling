// Minimal fixed-row-height virtual list.
import { h } from './util.js';

export class VList {
  constructor({ rowHeight = 30, render, className = '', overscan = 8 }) {
    this.rowHeight = rowHeight;
    this.render = render;
    this.overscan = overscan;
    this.count = 0;
    this.el = h('div', { class: 'vlist ' + className, tabindex: '0' });
    this.spacer = h('div', { class: 'vlist-spacer' });
    this.el.appendChild(this.spacer);
    this.rows = new Map();
    this.raf = 0;
    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.schedule()).observe(this.el);
  }

  setCount(n) {
    this.count = n;
    this.spacer.style.height = n * this.rowHeight + 'px';
    this.refresh();
  }

  refresh() {
    for (const r of this.rows.values()) r.remove();
    this.rows.clear();
    this.paint();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const top = this.el.scrollTop;
    const height = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / this.rowHeight) - this.overscan);
    const last = Math.min(this.count, Math.ceil((top + height) / this.rowHeight) + this.overscan);
    for (const [i, r] of this.rows) if (i < first || i >= last) { r.remove(); this.rows.delete(i); }
    for (let i = first; i < last; i++) {
      if (this.rows.has(i)) continue;
      const r = this.render(i);
      r.classList.add('vrow');
      r.style.top = i * this.rowHeight + 'px';
      r.style.height = this.rowHeight + 'px';
      this.spacer.appendChild(r);
      this.rows.set(i, r);
    }
  }

  repaintRow(i) {
    const old = this.rows.get(i);
    if (!old) return;
    const r = this.render(i);
    r.classList.add('vrow');
    r.style.top = i * this.rowHeight + 'px';
    r.style.height = this.rowHeight + 'px';
    old.replaceWith(r);
    this.rows.set(i, r);
  }

  scrollToRow(i) {
    const y = i * this.rowHeight;
    if (y < this.el.scrollTop || y > this.el.scrollTop + this.el.clientHeight - this.rowHeight) this.el.scrollTop = Math.max(0, y - this.rowHeight * 2);
  }
}
