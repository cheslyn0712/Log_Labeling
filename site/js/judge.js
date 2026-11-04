// Judgment panel: choose what the judgment applies to, the label and a rule, then submit.
import { h, clear, bitsNew, bitsSet, bitsHas, bitsToB64, b64ToBits, fmtNum } from './util.js';
import { LABEL_NAMES, MODE_NAMES } from './core.js';
import { uid } from './store.js';

export function rulesFor(rules, dataset) {
  return rules.rules.filter((r) => r.dataset === dataset || r.dataset === '*');
}

// ---------------------------------------------------------------- label / rule / note
export class DecisionEditor {
  constructor(rules, dataset, title) {
    this.rules = rulesFor(rules, dataset);
    this.label = null;
    this.chosen = new Set();
    this.note = '';
    this.title = title;
    this.el = h('div', { class: 'decision' });
    this.render();
  }

  render() {
    const el = clear(this.el);
    if (this.title) el.appendChild(h('div', { class: 'decision-title' }, this.title));
    const lab = h('div', { class: 'seg seg-label', role: 'radiogroup' });
    for (const L of ['normal', 'anomaly', 'unknown']) {
      lab.appendChild(h('button', {
        type: 'button', class: `seg-btn lab-${L}` + (this.label === L ? ' on' : ''), role: 'radio', 'aria-checked': this.label === L ? 'true' : 'false',
        onclick: () => {
          this.label = L;
          for (const id of [...this.chosen]) { const r = this.rules.find((x) => x.id === id); if (r && r.label !== L && r.label !== '*') this.chosen.delete(id); }
          this.render();
        },
      }, LABEL_NAMES[L]));
    }
    el.appendChild(lab);
    if (!this.label) {
      el.appendChild(h('div', { class: 'small muted' }, 'Pick a label, then the rule behind it.'));
    } else {
      const chips = h('div', { class: 'rule-chips' });
      for (const r of this.rules.filter((x) => x.label === this.label || x.label === '*')) {
        chips.appendChild(h('button', {
          type: 'button', class: 'rule-chip' + (this.chosen.has(r.id) ? ' on' : ''), title: r.text,
          onclick: () => { if (this.chosen.has(r.id)) this.chosen.delete(r.id); else this.chosen.add(r.id); this.render(); },
        }, h('span', { class: 'rule-id' }, r.id), ' ', r.title));
      }
      el.appendChild(chips);
      const need = this.noteRequired();
      const inp = h('input', { class: 'inp note-inp', placeholder: need ? `Note — required by ${need.join(', ')}` : 'Note (optional)', value: this.note });
      inp.addEventListener('input', () => { this.note = inp.value; this.onChange?.(); });
      el.appendChild(inp);
    }
    this.onChange?.();
  }

  noteRequired() {
    const ids = [...this.chosen].filter((id) => this.rules.find((r) => r.id === id)?.note_required);
    return ids.length ? ids : null;
  }

  problems() {
    const p = [];
    if (!this.label) p.push('pick a label');
    else if (!this.chosen.size) p.push('pick a rule');
    if (this.noteRequired() && !this.note.trim()) p.push('write the note');
    return p;
  }

  value() { return { label: this.label, rules: [...this.chosen], note: this.note.trim() }; }
}

// ---------------------------------------------------------------- panel
export class JudgePanel {
  /**
   * ctx: { store, ref, g, dataset, rules, editable, mergeCandidates() (lines only),
   *        groupTitle(g), onSubmitted(), onConflict() }
   * model: workspace adapter (group-lines.js / group-hdfs.js)
   */
  constructor(ctx, model) {
    this.ctx = ctx;
    this.model = model;
    this.scope = 'whole';
    this.el = h('div', { class: 'judge' });
    this.editors = {};
    this.split = null;
    this.mergeSel = new Set();
    this.computeCoverage();
    if (this.covItems) this.scope = 'items';
    this.render();
  }

  get gs() { return this.ctx.store.group(this.ctx.ref, this.ctx.g); }
  get editable() { return this.ctx.editable && this.gs.status === 'open' && !this.gs.mergedInto; }

  computeCoverage() {
    const n = this.model.nItems;
    const cov = new Int32Array(n);
    this.gs.judgments.forEach((j, k) => {
      const b = b64ToBits(j.bits);
      for (let i = 0; i < n; i++) if (bitsHas(b, i)) cov[i] = k + 1;
    });
    this.cov = cov;
    let items = 0, members = 0;
    for (let i = 0; i < n; i++) if (cov[i]) { items++; members += this.model.weight(i); }
    this.covItems = items;
    this.covMembers = members;
    this.model.onCoverage?.(cov);
  }

  uncovered() { const out = []; for (let i = 0; i < this.model.nItems; i++) if (!this.cov[i]) out.push(i); return out; }
  selected() { return this.model.selection().filter((i) => !this.cov[i]); }

  render() {
    const el = clear(this.el);
    const m = this.model;
    const full = this.covItems === m.nItems;
    el.appendChild(h('div', { class: 'jhead' }, 'Your judgment'));
    if (this.gs.judgments.length) {
      el.appendChild(h('div', { class: 'cov' },
        h('div', { class: 'cov-text small' }, `${fmtNum(this.covItems)} / ${fmtNum(m.nItems)} ${m.itemPlural} covered`,
          m.kind === 'lines' ? h('span', { class: 'muted' }, ` · ${fmtNum(this.covMembers)} / ${fmtNum(m.totalMembers)} lines`) : null),
        h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * this.covItems / Math.max(1, m.nItems)) + '%' } }))));
      el.appendChild(this.renderList());
    }
    if (!this.editable) return;
    if (full) {
      el.appendChild(h('button', { type: 'button', class: 'btn primary wide big', onclick: () => this.submit() }, 'Submit group & see answer'));
      return;
    }
    el.appendChild(this.renderForm());
  }

  renderList() {
    const box = h('div', { class: 'jlist' });
    const seenSplit = new Set();
    for (const j of this.gs.judgments) {
      const undo = this.editable && (!j.split || !seenSplit.has(j.split.sid))
        ? h('button', { type: 'button', class: 'btn tiny ghost', title: j.split ? 'Undo the whole split' : 'Undo', onclick: () => this.undo(j) }, 'Undo') : null;
      if (j.split) seenSplit.add(j.split.sid);
      const scope = j.mode === 'split'
        ? `${j.split.fieldName} ${j.split.rest ? '= other values' : '∈ {' + j.split.values.slice(0, 5).join(', ') + (j.split.values.length > 5 ? ', …' : '') + '}'}`
        : j.mode === 'merge' ? `+ ${j.merge.groups.length} similar group(s)` : '';
      box.appendChild(h('div', { class: 'jitem' },
        h('div', { class: 'jitem-head' },
          h('span', { class: `pill lab-${j.label}` }, LABEL_NAMES[j.label]),
          h('span', { class: 'small' }, `${MODE_NAMES[j.mode]} · ${fmtNum(j.items)} ${j.items === 1 ? this.model.itemName : this.model.itemPlural}`),
          undo),
        scope ? h('div', { class: 'small jscope' }, scope) : null,
        h('div', { class: 'small' }, h('span', { class: 'rule-id' }, j.rules.join(', ')), j.note ? h('span', { class: 'muted' }, ' — ' + j.note) : null)));
    }
    return box;
  }

  renderForm() {
    const m = this.model;
    const form = h('div', { class: 'jform' });
    const sel = this.selected();
    const cands = m.kind === 'lines' && this.ctx.mergeCandidates ? this.ctx.mergeCandidates() : [];
    if (this.scope === 'whole' && this.covItems) this.scope = 'items';
    if (this.scope === 'merge' && (!cands.length || this.covItems)) this.scope = this.covItems ? 'items' : 'whole';
    const opts = [
      ['whole', this.covItems ? 'Whole group (undo judgments first)' : `Whole group — all ${fmtNum(m.nItems)} ${m.itemPlural}`, !!this.covItems],
      ['items', sel.length ? `Ticked ${m.itemPlural} (${fmtNum(sel.length)})` : `Ticked ${m.itemPlural} — tick them in the list`, false],
      ['split', 'Split by a field', false],
    ];
    if (cands.length && !this.covItems) opts.push(['merge', `Whole group + similar groups (${cands.length})`, false]);
    const radios = h('div', { class: 'scope' }, h('div', { class: 'scope-title small muted' }, 'Applies to'));
    for (const [k, t, dis] of opts) {
      const r = h('input', { type: 'radio', name: 'scope', checked: this.scope === k, disabled: dis });
      r.addEventListener('change', () => { this.scope = k; this.render(); });
      radios.appendChild(h('label', { class: 'scope-opt' + (dis ? ' dim' : '') }, r, ' ', t));
    }
    form.appendChild(radios);
    this.body = h('div', { class: 'jform-body' });
    form.appendChild(this.body);
    this.reqBox = h('div', { class: 'reqline small' });
    this.applyBtn = h('button', { type: 'button', class: 'btn primary wide big', onclick: () => this.apply() });
    form.appendChild(this.reqBox);
    form.appendChild(this.applyBtn);
    this.renderBody();
    return form;
  }

  editor(key, title) {
    if (!this.editors[key]) this.editors[key] = new DecisionEditor(this.ctx.rules, this.ctx.dataset, title);
    const e = this.editors[key];
    e.title = title;
    e.onChange = () => this.updateLive();
    e.render();
    return e;
  }

  renderBody() {
    const b = clear(this.body);
    if (this.scope === 'split') this.renderSplit(b);
    else {
      if (this.scope === 'merge') this.renderMerge(b);
      b.appendChild(this.editor('main').el);
    }
    this.updateLive();
  }

  // ------------------------------------------------ split
  renderSplit(b) {
    const m = this.model;
    const fields = m.splitFields();
    if (!fields.length) { b.appendChild(h('p', { class: 'muted small' }, 'This group has no field to split on.')); return; }
    if (!this.split || !fields.find((f) => f.id === this.split.field)) this.split = { field: fields[0].id, assign: new Map(), parts: 2, filter: '' };
    const sp = this.split;
    const sel = h('select', { class: 'inp' }, fields.map((f) => h('option', { value: String(f.id), selected: String(f.id) === String(sp.field) }, f.name)));
    sel.addEventListener('change', () => { const f = fields.find((x) => String(x.id) === sel.value); this.split = { field: f.id, assign: new Map(), parts: 2, filter: '' }; this.renderBody(); });
    b.appendChild(h('div', { class: 'row gap' }, h('span', { class: 'small' }, 'Field'), sel,
      h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { sp.parts++; this.renderBody(); } }, '+ part')));

    const vals = new Map();
    for (const i of this.uncovered()) {
      const v = m.splitValue(sp.field, i);
      const e = vals.get(v) || { v, items: 0, members: 0 };
      e.items++; e.members += m.weight(i);
      vals.set(v, e);
    }
    const list = [...vals.values()].sort((a, c) => c.members - a.members || (a.v < c.v ? -1 : 1));
    const filt = h('input', { type: 'search', class: 'inp grow', placeholder: `Filter ${list.length} values…`, value: sp.filter });
    const target = h('select', { class: 'inp' }, [...Array(sp.parts)].map((_, k) => h('option', { value: String(k + 1) }, `Part ${k + 1}`)), h('option', { value: '0' }, 'Other values'));
    const assignAll = h('button', { type: 'button', class: 'btn tiny' }, 'Assign shown');
    b.appendChild(h('div', { class: 'row gap' }, filt, target, assignAll));
    const tbl = h('div', { class: 'split-vals' });
    const LIMIT = 300;
    const draw = () => {
      clear(tbl);
      const f = sp.filter.toLowerCase();
      let shown = 0, matched = 0;
      for (const e of list) {
        if (f && !e.v.toLowerCase().includes(f)) continue;
        matched++;
        if (shown >= LIMIT) continue;
        shown++;
        const s = h('select', { class: 'inp tiny' }, [...Array(sp.parts)].map((_, k) => h('option', { value: String(k + 1), selected: sp.assign.get(e.v) === k + 1 }, `Part ${k + 1}`)),
          h('option', { value: '0', selected: !sp.assign.get(e.v) }, 'Other'));
        s.addEventListener('change', () => { const k = +s.value; if (k) sp.assign.set(e.v, k); else sp.assign.delete(e.v); this.renderSplitEditors(); });
        tbl.appendChild(h('div', { class: 'split-row' }, h('code', { class: 'val', title: e.v }, e.v === '' ? '(empty)' : e.v),
          h('span', { class: 'muted small num' }, m.kind === 'lines' ? `${fmtNum(e.items)} msg · ${fmtNum(e.members)} lines` : `${fmtNum(e.items)} blocks`), s));
      }
      if (matched > shown) tbl.appendChild(h('div', { class: 'muted small' }, `${matched - shown} more values — narrow with the filter, or use “Assign shown”.`));
    };
    filt.addEventListener('input', () => { sp.filter = filt.value; draw(); });
    assignAll.addEventListener('click', () => {
      const f = sp.filter.toLowerCase();
      const k = +target.value;
      for (const e of list) if (!f || e.v.toLowerCase().includes(f)) { if (k) sp.assign.set(e.v, k); else sp.assign.delete(e.v); }
      draw(); this.renderSplitEditors();
    });
    draw();
    b.appendChild(tbl);
    this.splitEditorsBox = h('div', { class: 'split-editors' });
    b.appendChild(this.splitEditorsBox);
    this.renderSplitEditors();
  }

  splitParts() {
    const m = this.model, sp = this.split;
    const parts = new Map(); // k -> items ; 0 = other values
    for (const i of this.uncovered()) {
      const k = sp.assign.get(m.splitValue(sp.field, i)) || 0;
      if (!parts.has(k)) parts.set(k, []);
      parts.get(k).push(i);
    }
    return parts;
  }

  renderSplitEditors() {
    const box = clear(this.splitEditorsBox);
    const parts = this.splitParts();
    const keys = [...parts.keys()].sort((a, b) => (a || 1e9) - (b || 1e9));
    for (const k of keys) {
      const vs = new Set(parts.get(k).map((i) => this.model.splitValue(this.split.field, i)));
      box.appendChild(this.editor('split' + k, k ? `Part ${k} (${vs.size} value${vs.size === 1 ? '' : 's'})` : `Other values (${vs.size})`).el);
    }
    this.updateLive();
  }

  // ------------------------------------------------ merge
  renderMerge(b) {
    const cands = this.ctx.mergeCandidates();
    b.appendChild(h('p', { class: 'small muted' }, 'Groups with the same template id, or a template that differs only in numbers. Ticked groups get this same judgment and are submitted with this group.'));
    const box = h('div', { class: 'merge-list' });
    for (const c of cands) {
      const cb = h('input', { type: 'checkbox', checked: this.mergeSel.has(c.g) });
      cb.addEventListener('change', () => { if (cb.checked) this.mergeSel.add(c.g); else this.mergeSel.delete(c.g); this.updateLive(); });
      box.appendChild(h('label', { class: 'merge-row' }, cb, h('span', { class: 'small' }, c.label), h('code', { class: 'small tpl' }, c.template)));
    }
    b.appendChild(box);
  }

  // ------------------------------------------------ requirements
  requirements() {
    const m = this.model;
    const R = [];
    const ed = (e, prefix = '') => (e ? e.problems() : ['pick a label']).map((t) => ({ ok: false, text: prefix + t }));
    if (this.scope === 'whole' || this.scope === 'merge') {
      R.push({ ok: this.covItems === 0, text: 'undo the existing judgments' });
      if (this.scope === 'merge') R.push({ ok: this.mergeSel.size > 0, text: 'tick at least one similar group' });
      R.push(...m.reqPropagate());
      R.push(...ed(this.editors.main));
    } else if (this.scope === 'items') {
      const sel = this.selected();
      R.push({ ok: sel.length > 0, text: `tick ${m.itemPlural} in the list` });
      if (sel.length) R.push(...m.reqItems(sel));
      R.push(...ed(this.editors.main));
    } else if (this.scope === 'split') {
      if (!this.split) return [{ ok: false, text: 'no field to split on' }];
      const parts = this.splitParts();
      R.push({ ok: [...parts.keys()].some((k) => k) && parts.size >= 2, text: 'put some values into Part 1 (the rest go to “Other values”)' });
      R.push(...m.reqSplit([...parts.values()]));
      for (const k of parts.keys()) R.push(...ed(this.editors['split' + k], k ? `Part ${k}: ` : 'Other values: '));
    }
    return R;
  }

  completes() {
    if (this.scope === 'items') { const s = this.selected(); return s.length > 0 && s.length === this.model.nItems - this.covItems; }
    return true;
  }

  updateLive() {
    if (!this.reqBox) return;
    const miss = this.requirements().filter((r) => !r.ok);
    clear(this.reqBox);
    if (miss.length) this.reqBox.appendChild(h('span', { class: 'miss' }, 'Still needed: ', miss.map((r) => r.text).join(' · ')));
    this.applyBtn.disabled = miss.length > 0;
    this.applyBtn.textContent = this.completes() ? 'Submit group & see answer' : 'Add judgment';
  }

  refresh() {
    if (!this.editable || !this.reqBox) return;
    if (this.scope === 'items') { this.render(); return; }
    this.updateLive();
  }

  // ------------------------------------------------ mutations
  makeJudgment(mode, items, dec, extra) {
    const n = this.model.nItems;
    const bits = bitsNew(n);
    let members = 0;
    for (const i of items) { bitsSet(bits, i); members += this.model.weight(i); }
    return { id: uid('j'), mode, label: dec.label, rules: dec.rules, note: dec.note, bits: bitsToB64(bits), items: items.length, members, at: Date.now(), ...extra };
  }

  conflict() {
    alert('This group was changed in another window. Showing the saved state.');
    this.ctx.onConflict?.();
  }

  apply() {
    if (!this.requirements().every((r) => r.ok)) return;
    const st = this.ctx.store;
    const { ref, g } = this.ctx;
    const m = this.model;
    const added = [];
    const mergeGroups = [];
    const completes = this.completes();
    const all = [...Array(m.nItems).keys()];
    if (this.scope === 'whole') {
      added.push(this.makeJudgment('propagate', all, this.editors.main.value()));
    } else if (this.scope === 'items') {
      added.push(this.makeJudgment('items', this.selected(), this.editors.main.value()));
      m.clearSelection(true);
    } else if (this.scope === 'split') {
      const sid = uid('s');
      const fname = m.splitFields().find((f) => f.id === this.split.field).name;
      for (const [k, items] of [...this.splitParts().entries()].sort((a, b) => (a[0] || 1e9) - (b[0] || 1e9))) {
        const values = [...new Set(items.map((i) => m.splitValue(this.split.field, i)))].sort();
        added.push(this.makeJudgment('split', items, this.editors['split' + k].value(),
          { split: { sid, field: this.split.field, fieldName: fname, part: k, rest: k === 0, values: k === 0 ? [] : values } }));
      }
    } else if (this.scope === 'merge') {
      mergeGroups.push(...[...this.mergeSel].sort((a, b) => a - b));
      added.push(this.makeJudgment('merge', all, this.editors.main.value(), { merge: { groups: mergeGroups } }));
    }
    const ok = st.act('judgment', { ref, g, mode: added[0].mode, ids: added.map((j) => j.id), labels: added.map((j) => j.label) }, (s) => {
      const G = st.group(ref, g);
      if (G.status !== 'open' || G.mergedInto) return false;
      const taken = bitsNew(m.nItems);
      for (const j of G.judgments) { const b = b64ToBits(j.bits); for (let i = 0; i < b.length; i++) taken[i] |= b[i]; }
      for (const j of added) { const b = b64ToBits(j.bits); for (let i = 0; i < b.length; i++) if (taken[i] & b[i]) return false; }
      for (const g2 of mergeGroups) {
        const o = s.tasks[ref].groups[g2];
        if (o && (o.status !== 'open' || (o.judgments || []).length || o.mergedInto)) return false;
      }
      G.judgments.push(...added);
      for (const g2 of mergeGroups) { const o = st.group(ref, g2); o.mergedInto = { g, jid: added[0].id }; o.status = 'merged-pending'; }
    });
    if (!ok) { this.conflict(); return; }
    this.mergeSel.clear();
    this.split = null;
    this.editors = {};
    this.computeCoverage();
    if (completes && this.covItems === m.nItems) { this.submit(); return; }
    this.scope = 'items';
    this.render();
    this.ctx.onChange?.();
  }

  undo(j) {
    if (!this.editable) return;
    const st = this.ctx.store;
    const { ref, g } = this.ctx;
    const ids = new Set(j.split ? this.gs.judgments.filter((x) => x.split && x.split.sid === j.split.sid).map((x) => x.id) : [j.id]);
    const ok = st.act('undo', { ref, g, ids: [...ids] }, () => {
      const G = st.group(ref, g);
      if (G.status !== 'open') return false;
      const remove = G.judgments.filter((x) => ids.has(x.id));
      if (remove.length !== ids.size) return false;
      G.judgments = G.judgments.filter((x) => !ids.has(x.id));
      for (const x of remove) {
        if (x.merge) for (const g2 of x.merge.groups) {
          const o = st.group(ref, g2);
          if (o.mergedInto && o.mergedInto.g === g && o.mergedInto.jid === x.id) { delete o.mergedInto; o.status = 'open'; }
        }
      }
    });
    if (!ok) { this.conflict(); return; }
    this.computeCoverage();
    if (!this.covItems) this.scope = 'whole';
    this.render();
    this.ctx.onChange?.();
  }

  // locks the group (and groups merged into it); the page then shows the answer
  submit() {
    const st = this.ctx.store;
    const { ref, g } = this.ctx;
    const now = Date.now();
    const n = this.model.nItems;
    const ok = st.act('submit', { ref, g }, (s) => {
      const G = st.group(ref, g);
      if (G.status !== 'open' || G.mergedInto) return false;
      const cov = bitsNew(n);
      for (const j of G.judgments) { const b = b64ToBits(j.bits); for (let i = 0; i < b.length; i++) cov[i] |= b[i]; }
      for (let i = 0; i < n; i++) if (!bitsHas(cov, i)) return false;
      let merged = 0;
      G.status = 'submitted';
      G.submittedAt = now;
      for (const j of G.judgments) if (j.merge) for (const g2 of j.merge.groups) {
        const o = st.group(ref, g2);
        o.status = 'submitted'; o.submittedAt = now; merged++;
      }
      s.backup.groupsSince = (s.backup.groupsSince || 0) + 1 + merged;
    });
    if (!ok) { this.conflict(); return; }
    this.ctx.onSubmitted?.();
  }
}
