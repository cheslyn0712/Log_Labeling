// Judgment panel: lists the group's judgments, adds new ones, undo, submit.
import { h, clear, bitsNew, bitsSet, bitsHas, bitsToB64, b64ToBits, fmtNum } from './util.js';
import { LABEL_NAMES, MODE_NAMES } from './core.js';

export function rulesFor(rules, dataset) {
  return rules.rules.filter((r) => r.dataset === dataset || r.dataset === '*');
}

// ---------------------------------------------------------------- label / rule / note editor
export class DecisionEditor {
  constructor(rules, dataset, title) {
    this.rules = rulesFor(rules, dataset);
    this.label = null;
    this.chosen = new Set();
    this.note = '';
    this.filter = '';
    this.el = h('div', { class: 'decision' });
    this.title = title;
    this.render();
  }

  render() {
    const el = clear(this.el);
    if (this.title) el.appendChild(h('div', { class: 'decision-title' }, this.title));
    const lab = h('div', { class: 'seg seg-label', role: 'radiogroup' });
    for (const L of ['normal', 'anomaly', 'unknown']) {
      lab.appendChild(h('button', {
        type: 'button', class: `seg-btn lab-${L}` + (this.label === L ? ' on' : ''), role: 'radio', 'aria-checked': this.label === L ? 'true' : 'false',
        onclick: () => { this.label = L; this.render(); },
      }, LABEL_NAMES[L]));
    }
    el.appendChild(lab);

    const list = h('div', { class: 'rule-list' });
    const f = this.filter.toLowerCase();
    const sorted = this.rules.slice().sort((a, b) => rank(a, this.label) - rank(b, this.label));
    for (const r of sorted) {
      if (f && !(`${r.id} ${r.title} ${r.text}`.toLowerCase().includes(f))) continue;
      const fits = !this.label || r.label === this.label || r.label === '*';
      const cb = h('input', { type: 'checkbox', checked: this.chosen.has(r.id) });
      cb.addEventListener('change', () => { if (cb.checked) this.chosen.add(r.id); else this.chosen.delete(r.id); this.renderNoteHint(); this.onChange?.(); });
      list.appendChild(h('label', { class: 'rule' + (fits ? '' : ' dim'), title: r.text },
        cb, h('span', { class: 'rule-id' }, r.id), h('span', { class: 'rule-title' }, r.title),
        r.note_required ? h('span', { class: 'rule-note-flag', title: 'Note required' }, 'note') : null));
    }
    const search = h('input', { type: 'search', class: 'rule-search', placeholder: 'Filter rules…', value: this.filter });
    search.addEventListener('input', () => { this.filter = search.value; const pos = search.selectionStart; this.render(); const s = this.el.querySelector('.rule-search'); s.focus(); s.setSelectionRange(pos, pos); });
    el.appendChild(h('div', { class: 'rule-head' }, h('span', { class: 'muted small' }, 'Rules (at least one)'), search));
    el.appendChild(list);

    const ta = h('textarea', { class: 'note', rows: '2', placeholder: 'Note' });
    ta.value = this.note;
    ta.addEventListener('input', () => { this.note = ta.value; this.onChange?.(); });
    this.noteHint = h('div', { class: 'small muted' });
    el.appendChild(ta);
    el.appendChild(this.noteHint);
    this.renderNoteHint();
    this.onChange?.();
  }

  renderNoteHint() {
    const need = this.noteRequired();
    this.noteHint.textContent = need ? `A note is required by ${need.join(', ')}.` : 'Note (optional).';
  }

  noteRequired() {
    const ids = [...this.chosen].filter((id) => this.rules.find((r) => r.id === id)?.note_required);
    return ids.length ? ids : null;
  }

  problems() {
    const p = [];
    if (!this.label) p.push('choose a label');
    if (!this.chosen.size) p.push('choose at least one rule');
    if (this.noteRequired() && !this.note.trim()) p.push('write the note required by the chosen rule');
    return p;
  }

  value() { return { label: this.label, rules: [...this.chosen], note: this.note.trim() }; }
}

function rank(r, label) { return !label ? 0 : r.label === label ? 0 : r.label === '*' ? 1 : 2; }

// ---------------------------------------------------------------- panel
export class JudgePanel {
  /**
   * ctx: { store, ref, g, dataset, rules, editable, onSubmitted(), mergeCandidates() (lines only), groupTitle(g) }
   * model: workspace adapter (see group-lines.js / group-hdfs.js)
   */
  constructor(ctx, model) {
    this.ctx = ctx;
    this.model = model;
    this.mode = 'propagate';
    this.el = h('div', { class: 'judge' });
    this.editors = {};
    this.split = null;
    this.mergeSel = new Set();
    this.computeCoverage();
    this.render();
  }

  get gs() { return this.ctx.store.group(this.ctx.ref, this.ctx.g); }
  get task() { return this.ctx.store.task(this.ctx.ref); }
  get editable() { return this.ctx.editable && this.gs.status === 'open' && !this.task.unlocked && !this.gs.mergedInto; }

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

  render() {
    const el = clear(this.el);
    const m = this.model;
    const full = this.covItems === m.nItems;
    el.appendChild(h('div', { class: 'cov' },
      h('div', { class: 'cov-text' },
        h('strong', null, `${fmtNum(this.covItems)} / ${fmtNum(m.nItems)}`), ` ${m.itemPlural} covered`,
        m.kind === 'lines' ? h('span', { class: 'muted' }, ` · ${fmtNum(this.covMembers)} / ${fmtNum(m.totalMembers)} lines`) : null),
      h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: (100 * this.covItems / Math.max(1, m.nItems)) + '%' } }))));

    el.appendChild(this.renderList());

    if (this.gs.mergedInto) {
      el.appendChild(h('div', { class: 'notice' }, `This group is covered by a merge judgment made in ${this.ctx.groupTitle(this.gs.mergedInto.g)}.`));
      return;
    }
    if (this.gs.status === 'submitted' || this.task.unlocked) {
      el.appendChild(h('div', { class: 'notice' }, this.task.unlocked ? 'Answers are unlocked for this task: all judgments are locked.' : 'Submitted — this group is locked.'));
      return;
    }
    if (!this.ctx.editable) return;

    if (!full) el.appendChild(this.renderForm());
    const sub = h('button', { type: 'button', class: 'btn primary wide', disabled: !full, onclick: () => this.submit() },
      full ? 'Submit group' : `Submit group (cover all ${m.itemPlural} first)`);
    el.appendChild(h('div', { class: 'submit-row' }, sub));
  }

  renderList() {
    const js = this.gs.judgments;
    const box = h('div', { class: 'jlist' });
    if (!js.length) { box.appendChild(h('div', { class: 'muted small' }, 'No judgments yet.')); return box; }
    const seenSplit = new Set();
    js.forEach((j) => {
      const undo = this.editable && (!j.split || !seenSplit.has(j.split.sid))
        ? h('button', { type: 'button', class: 'btn tiny ghost', title: j.split ? 'Undo the whole split' : 'Undo', onclick: () => this.undo(j) }, 'Undo') : null;
      if (j.split) seenSplit.add(j.split.sid);
      const scope = j.mode === 'split'
        ? `${j.split.fieldName} ${j.split.rest ? '= all other values' : '∈ {' + j.split.values.slice(0, 6).join(', ') + (j.split.values.length > 6 ? ', …' : '') + '}'}`
        : j.mode === 'merge' ? `this group + ${j.merge.groups.length} other group(s)` : '';
      box.appendChild(h('div', { class: 'jitem' },
        h('div', { class: 'jitem-head' },
          h('span', { class: `pill lab-${j.label}` }, LABEL_NAMES[j.label]),
          h('span', { class: 'jmode' }, MODE_NAMES[j.mode]),
          h('span', { class: 'muted small' }, `${fmtNum(j.items)} ${j.items === 1 ? this.model.itemName : this.model.itemPlural}` + (this.model.kind === 'lines' ? ` · ${fmtNum(j.members)} lines` : '')),
          undo),
        scope ? h('div', { class: 'small jscope' }, scope) : null,
        h('div', { class: 'small' }, h('span', { class: 'rule-id' }, j.rules.join(', ')), j.note ? h('span', { class: 'muted' }, ' — ' + j.note) : null)));
    });
    return box;
  }

  renderForm() {
    const m = this.model;
    const form = h('div', { class: 'jform' });
    const modes = [['propagate', 'Whole group'], ['split', 'Split by field'], ['items', 'Selected items']];
    if (m.kind === 'lines' && this.ctx.mergeCandidates) modes.push(['merge', 'Merge groups']);
    const seg = h('div', { class: 'seg seg-mode' });
    for (const [k, t] of modes) {
      seg.appendChild(h('button', { type: 'button', class: 'seg-btn' + (this.mode === k ? ' on' : ''), onclick: () => { this.mode = k; this.render(); } }, t));
    }
    form.appendChild(h('div', { class: 'jform-title' }, 'New judgment'));
    form.appendChild(seg);
    this.reqBox = h('ul', { class: 'reqs' });
    this.applyBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => this.apply() }, 'Apply');
    this.body = h('div', { class: 'jform-body' });
    form.appendChild(this.body);
    form.appendChild(this.reqBox);
    form.appendChild(h('div', { class: 'apply-row' }, this.applyBtn));
    this.renderBody();
    return form;
  }

  editor(key, title) {
    if (!this.editors[key]) {
      this.editors[key] = new DecisionEditor(this.ctx.rules, this.ctx.dataset, title);
    }
    const e = this.editors[key];
    e.title = title;
    e.onChange = () => this.updateLive();
    e.render();
    return e;
  }

  renderBody() {
    const b = clear(this.body);
    const m = this.model;
    if (this.mode === 'propagate') {
      if (this.covItems) b.appendChild(h('div', { class: 'notice warn' }, `Whole group covers every ${m.itemName}. Some are already covered — undo those judgments first, or use Split / Selected items for the rest.`));
      b.appendChild(h('p', { class: 'small muted' }, `One judgment for all ${fmtNum(m.nItems)} ${m.itemPlural} of this group.`));
      b.appendChild(this.editor('propagate').el);
    } else if (this.mode === 'items') {
      const sel = m.selection().filter((i) => !this.cov[i]);
      b.appendChild(h('p', { class: 'small' }, sel.length
        ? `${fmtNum(sel.length)} selected ${sel.length === 1 ? m.itemName : m.itemPlural}` + (m.kind === 'lines' ? ` (${fmtNum(sel.reduce((a, i) => a + m.weight(i), 0))} lines).` : '.')
        : `Tick ${m.itemPlural} in the list on the left to select them.`));
      if (sel.length) b.appendChild(h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => m.clearSelection() }, 'Clear selection'));
      b.appendChild(this.editor('items').el);
    } else if (this.mode === 'split') {
      this.renderSplit(b);
    } else if (this.mode === 'merge') {
      this.renderMerge(b);
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

    // values among uncovered items
    const unc = this.uncovered();
    const vals = new Map();
    for (const i of unc) {
      const v = m.splitValue(sp.field, i);
      const e = vals.get(v) || { v, items: 0, members: 0 };
      e.items++; e.members += m.weight(i);
      vals.set(v, e);
    }
    const list = [...vals.values()].sort((a, c) => c.members - a.members || (a.v < c.v ? -1 : 1));
    const filt = h('input', { type: 'search', class: 'inp', placeholder: `Filter ${list.length} values…`, value: sp.filter });
    const target = h('select', { class: 'inp' }, [...Array(sp.parts)].map((_, k) => h('option', { value: String(k + 1) }, `Part ${k + 1}`)), h('option', { value: '0' }, 'Other values'));
    const assignAll = h('button', { type: 'button', class: 'btn tiny' }, 'Assign matching');
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
      if (matched > shown) tbl.appendChild(h('div', { class: 'muted small' }, `${matched - shown} more values — narrow with the filter, or use “Assign matching”.`));
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
    this.splitVals = list;
    this.renderSplitEditors();
  }

  splitParts() {
    const m = this.model, sp = this.split;
    const parts = new Map(); // k -> items ; 0 = rest
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
      const vs = [...new Set(parts.get(k).map((i) => this.model.splitValue(this.split.field, i)))];
      const title = k ? `Part ${k}: ${vs.length} value(s)` : `Other values: ${vs.length} value(s)`;
      box.appendChild(this.editor('split' + k, title).el);
    }
    this.updateLive();
  }

  // ------------------------------------------------ merge
  renderMerge(b) {
    const cands = this.ctx.mergeCandidates();
    if (this.covItems) b.appendChild(h('div', { class: 'notice warn' }, 'Merge covers this whole group. Undo existing judgments first.'));
    if (!cands.length) { b.appendChild(h('p', { class: 'muted small' }, 'No other open group in this task has the same template id or a template that differs only in numbers.')); return; }
    b.appendChild(h('p', { class: 'small muted' }, 'Groups in this task with the same template id or a template that differs only in numbers. Ticked groups are covered entirely by this judgment and are locked together with this group when you submit it.'));
    const box = h('div', { class: 'merge-list' });
    for (const c of cands) {
      const cb = h('input', { type: 'checkbox', checked: this.mergeSel.has(c.g) });
      cb.addEventListener('change', () => { if (cb.checked) this.mergeSel.add(c.g); else this.mergeSel.delete(c.g); this.updateLive(); });
      box.appendChild(h('label', { class: 'merge-row' }, cb, h('span', { class: 'small' }, c.label), h('code', { class: 'small tpl' }, c.template)));
    }
    b.appendChild(box);
    b.appendChild(this.editor('merge').el);
  }

  // ------------------------------------------------ live requirements
  requirements() {
    const m = this.model;
    const R = [];
    if (this.mode === 'propagate' || this.mode === 'merge') {
      R.push({ ok: this.covItems === 0, text: 'nothing in this group is covered yet' });
      if (this.mode === 'merge') R.push({ ok: this.mergeSel.size > 0, text: 'tick at least one other group' });
      R.push(...m.reqPropagate());
      R.push(...this.editorReqs(this.editors[this.mode]));
    } else if (this.mode === 'items') {
      const sel = m.selection().filter((i) => !this.cov[i]);
      R.push({ ok: sel.length > 0, text: `select at least one uncovered ${m.itemName}` });
      if (sel.length) R.push(...m.reqItems(sel));
      R.push(...this.editorReqs(this.editors.items));
    } else if (this.mode === 'split') {
      if (!this.split) return [{ ok: false, text: 'no field to split on' }];
      const parts = this.splitParts();
      const named = [...parts.keys()].filter((k) => k);
      R.push({ ok: named.length >= 1 && parts.size >= 2, text: 'assign values to at least two parts (a part plus “other values” counts)' });
      R.push(...m.reqSplit([...parts.values()]));
      for (const k of parts.keys()) {
        for (const r of this.editorReqs(this.editors['split' + k])) R.push({ ok: r.ok, text: (k ? `Part ${k}: ` : 'Other values: ') + r.text });
      }
    }
    return R;
  }

  editorReqs(e) {
    if (!e) return [{ ok: false, text: 'choose a label and a rule' }];
    const p = e.problems();
    return p.length ? p.map((t) => ({ ok: false, text: t })) : [{ ok: true, text: 'label, rule and note complete' }];
  }

  updateLive() {
    if (!this.reqBox) return;
    const R = this.requirements();
    clear(this.reqBox);
    for (const r of R) this.reqBox.appendChild(h('li', { class: r.ok ? 'ok' : 'miss' }, r.text));
    this.applyBtn.disabled = !R.every((r) => r.ok);
    this.applyBtn.textContent = this.mode === 'split' && this.split ? `Apply ${this.splitParts().size} judgments` : 'Apply';
  }

  // called by the workspace when selection / viewed state changes
  refresh() {
    if (!this.editable) return;
    if (this.mode === 'items') this.renderBody();
    else this.updateLive();
  }

  // ------------------------------------------------ mutations
  makeJudgment(mode, items, dec, extra) {
    const n = this.model.nItems;
    const bits = bitsNew(n);
    let members = 0;
    for (const i of items) { bitsSet(bits, i); members += this.model.weight(i); }
    const t = this.task;
    t.seq = (t.seq || 0) + 1;
    return { id: 'j' + t.seq, mode, label: dec.label, rules: dec.rules, note: dec.note, bits: bitsToB64(bits), items: items.length, members, at: Date.now(), ...extra };
  }

  apply() {
    if (!this.requirements().every((r) => r.ok)) return;
    const st = this.ctx.store;
    const gs = this.gs;
    const m = this.model;
    const added = [];
    if (this.mode === 'propagate') {
      added.push(this.makeJudgment('propagate', [...Array(m.nItems).keys()], this.editors.propagate.value()));
    } else if (this.mode === 'items') {
      const sel = m.selection().filter((i) => !this.cov[i]);
      added.push(this.makeJudgment('items', sel, this.editors.items.value()));
      m.clearSelection(true);
    } else if (this.mode === 'split') {
      const parts = this.splitParts();
      const sid = 's' + Date.now().toString(36);
      const fname = m.splitFields().find((f) => f.id === this.split.field).name;
      for (const [k, items] of [...parts.entries()].sort((a, b) => (a[0] || 1e9) - (b[0] || 1e9))) {
        const values = [...new Set(items.map((i) => m.splitValue(this.split.field, i)))].sort();
        added.push(this.makeJudgment('split', items, this.editors['split' + k].value(),
          { split: { sid, field: this.split.field, fieldName: fname, part: k, rest: k === 0, values: k === 0 ? [] : values } }));
      }
      this.split = null;
    } else if (this.mode === 'merge') {
      const groups = [...this.mergeSel].sort((a, b) => a - b);
      const j = this.makeJudgment('merge', [...Array(m.nItems).keys()], this.editors.merge.value(), { merge: { groups } });
      added.push(j);
      for (const g2 of groups) {
        const o = st.group(this.ctx.ref, g2);
        o.mergedInto = { g: this.ctx.g, jid: j.id };
        o.status = 'merged-pending';
      }
      this.mergeSel.clear();
    }
    st.act('judgment', { ref: this.ctx.ref, g: this.ctx.g, mode: this.mode, ids: added.map((j) => j.id), labels: added.map((j) => j.label) }, () => { gs.judgments.push(...added); });
    for (const k of Object.keys(this.editors)) if (k !== 'propagate' && k !== 'items' && k !== 'merge') delete this.editors[k];
    this.computeCoverage();
    this.mode = this.covItems === m.nItems ? this.mode : (this.mode === 'propagate' || this.mode === 'merge' ? 'items' : this.mode);
    this.render();
    this.ctx.onChange?.();
  }

  undo(j) {
    if (!this.editable) return;
    const gs = this.gs;
    const st = this.ctx.store;
    const remove = j.split ? gs.judgments.filter((x) => x.split && x.split.sid === j.split.sid) : [j];
    if (!confirm(remove.length > 1 ? `Undo this split (${remove.length} judgments)?` : 'Undo this judgment?')) return;
    st.act('undo', { ref: this.ctx.ref, g: this.ctx.g, ids: remove.map((x) => x.id) }, () => {
      gs.judgments = gs.judgments.filter((x) => !remove.includes(x));
      for (const x of remove) {
        if (x.merge) for (const g2 of x.merge.groups) {
          const o = st.group(this.ctx.ref, g2);
          if (o.mergedInto && o.mergedInto.g === this.ctx.g && o.mergedInto.jid === x.id) { delete o.mergedInto; o.status = 'open'; }
        }
      }
    });
    this.computeCoverage();
    this.render();
    this.ctx.onChange?.();
  }

  submit() {
    if (this.covItems !== this.model.nItems) return;
    if (!confirm('Submit this group? It will be locked and cannot be changed.')) return;
    const st = this.ctx.store;
    const gs = this.gs;
    const now = Date.now();
    const merged = [];
    st.act('submit', { ref: this.ctx.ref, g: this.ctx.g }, (s) => {
      gs.status = 'submitted';
      gs.submittedAt = now;
      for (const j of gs.judgments) if (j.merge) for (const g2 of j.merge.groups) {
        const o = st.group(this.ctx.ref, g2);
        o.status = 'submitted'; o.submittedAt = now; merged.push(g2);
      }
      s.backup.groupsSince = (s.backup.groupsSince || 0) + 1 + merged.length;
    });
    this.render();
    this.ctx.onSubmitted?.();
  }
}
