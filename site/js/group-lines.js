// Workspace for one BGL / Thunderbird group.
import { h, clear, fmtNum, debounce } from './util.js';
import { VList } from './vlist.js';
import { loadLine, lineCached, windowOf } from './data.js';
import { LABEL_NAMES } from './core.js';

const CTX_INITIAL = 8;
const CTX_STEP = 20;

/**
 * opts: {
 *   task, meta, data, dataset,
 *   instanceFields: number[]           initial instance fields
 *   onInstanceFields(fields)           persist (label mode)
 *   onView(evt)                        session events for logging (optional)
 *   rightPane(model) -> HTMLElement    judgment / example / review pane
 *   answers: per-message [normal, anomaly] (review mode only)
 *   judgedLabel(j) -> label|null       label covering message j (review mode)
 * }
 */
export function mountLineGroup(root, opts) {
  const { task, meta, data } = opts;
  const msgs = data.messages;
  const M = msgs.length;
  const F = meta.f;
  const tplParts = (meta.template === '<EMPTY>' ? '' : meta.template).split('<*>');

  const sess = { sawList: true, viewed: new Set(), contextOpened: false };
  let instance = new Set(opts.instanceFields || []);
  let tab = 'messages';
  let filterText = '';
  let fieldFilter = null; // {i, v}
  let selected = new Set();
  let active = null;      // {type:'msg'|'kind', idx}
  let cov = new Int32Array(M);
  let kinds, msgKind;
  let shown = [];         // rows currently listed: message index or kind index
  let searchCache = null;

  // ---------------------------------------------------------------- derived data
  const fieldStats = [];
  for (let i = 0; i < F; i++) fieldStats.push(new Map());
  for (const m of msgs) for (let i = 0; i < F; i++) { const v = m.v[i] ?? ''; fieldStats[i].set(v, (fieldStats[i].get(v) || 0) + m.n); }
  const fieldSorted = fieldStats.map((mp) => [...mp.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));

  function computeKinds() {
    const map = new Map();
    msgKind = new Int32Array(M);
    for (let j = 0; j < M; j++) {
      const key = instance.size ? msgs[j].v.map((x, i) => (instance.has(i) ? '\u0000' : x)).join('\u0001') : String(j);
      let k = map.get(key);
      if (!k) { k = { msgs: [], n: 0, key }; map.set(key, k); }
      k.msgs.push(j); k.n += msgs[j].n;
    }
    kinds = [...map.values()].sort((a, b) => b.n - a.n || a.msgs[0] - b.msgs[0]);
    kinds.forEach((k, idx) => { for (const j of k.msgs) msgKind[j] = idx; });
  }
  computeKinds();
  const byKind = () => instance.size > 0;

  function msgText(v, mask) {
    const out = [];
    for (let i = 0; i < tplParts.length; i++) {
      if (tplParts[i]) out.push(tplParts[i]);
      if (i < tplParts.length - 1) out.push({ i, v: mask && instance.has(i) ? null : (v[i] ?? '') });
    }
    return out;
  }
  function renderMsgInto(el, v, mask) {
    for (const p of msgText(v, mask)) {
      if (typeof p === 'string') el.appendChild(document.createTextNode(p));
      else el.appendChild(h('span', { class: 'fv' + (p.v === null ? ' fv-inst' : instance.has(p.i) ? ' fv-dim' : '') }, p.v === null ? `‹F${p.i + 1}›` : p.v));
    }
    return el;
  }
  function plainText(v) { return msgText(v, false).map((p) => (typeof p === 'string' ? p : p.v)).join(''); }

  // ---------------------------------------------------------------- layout
  clear(root);
  const head = h('div', { class: 'ws-head' });
  const left = h('section', { class: 'pane pane-left' });
  const mid = h('section', { class: 'pane pane-mid' });
  const right = h('section', { class: 'pane pane-right' });
  root.appendChild(head);
  root.appendChild(h('div', { class: 'ws-grid' }, left, mid, right));

  // header: template with clickable fields
  const tplEl = h('div', { class: 'tpl-big mono' });
  tplParts.forEach((p, i) => {
    if (p) tplEl.appendChild(document.createTextNode(p));
    if (i < tplParts.length - 1) tplEl.appendChild(h('button', { type: 'button', class: 'field-chip', title: `Field ${i + 1}: show value distribution`, onclick: () => { setTab('fields'); setTimeout(() => left.querySelector(`#fcard-${i}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 30); } }, `<*>${i + 1}`));
  });
  if (!tplParts.join('')) tplEl.appendChild(h('span', { class: 'muted' }, '(empty message)'));
  const badges = opts.dataset === 'bgl'
    ? [h('span', { class: 'badge' }, 'Component ', h('b', null, meta.key[0])), h('span', { class: 'badge lvl-' + String(meta.key[1]).toLowerCase() }, 'Level ', h('b', null, meta.key[1]))]
    : [h('span', { class: 'badge' }, 'Service ', h('b', null, meta.key[0]))];
  head.appendChild(h('div', { class: 'tpl-row' }, h('span', { class: 'tpl-label' }, 'Template'), tplEl));
  head.appendChild(h('div', { class: 'badge-row' }, badges, h('span', { class: 'badge' }, h('b', null, fmtNum(M)), ' distinct messages'), h('span', { class: 'badge' }, h('b', null, fmtNum(meta.n)), ' lines'), h('span', { class: 'badge' }, h('b', null, F), ' fields')));

  // ---------------------------------------------------------------- left pane
  const tabs = h('div', { class: 'tabs' });
  const leftBody = h('div', { class: 'pane-body' });
  left.appendChild(tabs);
  left.appendChild(leftBody);

  function setTab(t) {
    tab = t;
    sess.sawList = true;
    opts.onView?.({ type: 'tab', tab: t });
    renderLeft();
    changed();
  }

  const list = new VList({ rowHeight: 30, render: renderRow, className: 'msg-list' });
  const listInfo = h('div', { class: 'list-info small muted' });
  const filterInp = h('input', { type: 'search', class: 'inp grow', placeholder: 'Filter messages…' });
  filterInp.addEventListener('input', debounce(() => { filterText = filterInp.value; applyFilter(); }, 150));
  const fieldFilterChip = h('span');
  const selAllBtn = h('button', { type: 'button', class: 'btn tiny ghost', title: 'Select every uncovered message currently listed', onclick: () => { for (const r of shown) for (const j of rowMsgs(r)) if (!cov[j]) selected.add(j); list.refresh(); changed(); } }, 'Select shown');
  const kindToggle = h('span', { class: 'small muted' });
  const msgBar = h('div', { class: 'list-bar' }, filterInp, fieldFilterChip, opts.selectable !== false ? selAllBtn : null);

  function rowMsgs(r) { return byKind() ? kinds[r].msgs : [r]; }

  function applyFilter() {
    const f = filterText.trim().toLowerCase();
    if (f && !searchCache) searchCache = msgs.map((m) => plainText(m.v).toLowerCase());
    const N = byKind() ? kinds.length : M;
    shown = [];
    for (let r = 0; r < N; r++) {
      const js = rowMsgs(r);
      let ok = true;
      if (fieldFilter) ok = js.some((j) => (msgs[j].v[fieldFilter.i] ?? '') === fieldFilter.v);
      if (ok && f) ok = js.some((j) => searchCache[j].includes(f));
      if (ok) shown.push(r);
    }
    clear(fieldFilterChip);
    if (fieldFilter) fieldFilterChip.appendChild(h('span', { class: 'chip' }, `F${fieldFilter.i + 1} = ${fieldFilter.v === '' ? '(empty)' : fieldFilter.v}`, h('button', { type: 'button', class: 'chip-x', onclick: () => { fieldFilter = null; applyFilter(); } }, '×')));
    listInfo.textContent = `${byKind() ? `${fmtNum(kinds.length)} kinds after merging instance fields (${fmtNum(M)} messages)` : `${fmtNum(M)} messages`}${shown.length !== N ? ` · ${fmtNum(shown.length)} shown` : ''} · sorted by line count`;
    list.setCount(shown.length);
  }

  function rowLabel(r) {
    const js = rowMsgs(r);
    let lab = null, mixed = false, any = 0;
    for (const j of js) {
      const c = cov[j];
      if (c) { any++; const L = opts.labelOf(c); if (lab && lab !== L) mixed = true; lab = L; }
    }
    if (!any) return null;
    return mixed || any < js.length ? 'partial' : lab;
  }

  function renderRow(k) {
    const r = shown[k];
    const js = rowMsgs(r);
    const n = byKind() ? kinds[r].n : msgs[r].n;
    const isActive = active && ((active.type === 'kind' && byKind() && active.idx === r) || (active.type === 'msg' && !byKind() && active.idx === r));
    const viewed = js.some((j) => sess.viewed.has(j));
    const lab = rowLabel(r);
    const row = h('div', { class: 'mrow' + (isActive ? ' active' : '') + (k % 2 ? ' odd' : '') });
    if (opts.selectable !== false) {
      const allCovered = js.every((j) => cov[j]);
      const cb = h('input', { type: 'checkbox', class: 'msel', disabled: allCovered, checked: !allCovered && js.every((j) => cov[j] || selected.has(j)), title: allCovered ? 'Already covered' : 'Select for a judgment' });
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { for (const j of js) { if (cov[j]) continue; if (cb.checked) selected.add(j); else selected.delete(j); } changed(); });
      row.appendChild(cb);
    }
    row.appendChild(h('span', { class: 'cov-dot ' + (lab ? 'lab-' + lab : 'none'), title: lab ? (lab === 'partial' ? 'Partly covered' : 'Covered: ' + LABEL_NAMES[lab]) : 'Not covered' }));
    row.appendChild(h('span', { class: 'mcount num' }, fmtNum(n)));
    if (byKind()) row.appendChild(h('span', { class: 'mkinds small muted', title: 'messages merged into this kind' }, `×${js.length}`));
    const txt = h('span', { class: 'mtext mono' });
    renderMsgInto(txt, msgs[js[0]].v, byKind());
    row.appendChild(txt);
    if (opts.answerBadge) row.appendChild(opts.answerBadge(js));
    if (viewed) row.appendChild(h('span', { class: 'seen', title: 'Raw lines viewed' }, '●'));
    row.addEventListener('click', () => openRow(r));
    return row;
  }

  function openRow(r) {
    active = { type: byKind() ? 'kind' : 'msg', idx: r };
    for (const j of rowMsgs(r)) sess.viewed.add(j);
    opts.onView?.({ type: 'raw', m: rowMsgs(r)[0], k: rowMsgs(r).length });
    list.refresh();
    renderRaw();
    changed();
  }

  // fields tab
  function renderFields() {
    const box = h('div', { class: 'fields' });
    if (!F) box.appendChild(h('p', { class: 'muted' }, 'This template has no variable fields: every message is identical.'));
    for (let i = 0; i < F; i++) {
      const vals = fieldSorted[i];
      const total = meta.n;
      let limit = 15;
      const tbl = h('div', { class: 'ftable' });
      const draw = () => {
        clear(tbl);
        for (const [v, c] of vals.slice(0, limit)) {
          tbl.appendChild(h('div', { class: 'frow', title: 'Show messages with this value', onclick: () => { fieldFilter = { i, v }; setTab('messages'); } },
            h('code', { class: 'fval' }, v === '' ? '(empty)' : v),
            h('span', { class: 'fbar' }, h('span', { style: { width: Math.max(1, 100 * c / total) + '%' } })),
            h('span', { class: 'num small' }, fmtNum(c))));
        }
        if (vals.length > limit) tbl.appendChild(h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { limit += 50; draw(); } }, `Show more (${fmtNum(vals.length - limit)} left)`));
      };
      draw();
      const cb = h('input', { type: 'checkbox', checked: instance.has(i), disabled: opts.lockInstance });
      cb.addEventListener('change', () => {
        if (cb.checked) instance.add(i); else instance.delete(i);
        computeKinds();
        active = null;
        opts.onInstanceFields?.([...instance].sort((a, b) => a - b));
        renderFields2();
        applyFilter();
        renderRaw();
        changed();
      });
      box.appendChild(h('div', { class: 'fcard', id: `fcard-${i}` },
        h('div', { class: 'fcard-head' }, h('strong', null, `Field ${i + 1}`), h('span', { class: 'muted small' }, `${fmtNum(vals.length)} distinct value${vals.length === 1 ? '' : 's'}`),
          h('label', { class: 'inst', title: 'The field only identifies an instance (counter, address, node, PID …). Messages that differ only in instance fields are merged into one kind.' }, cb, ' Instance info')),
        tbl));
    }
    return box;
  }
  let fieldsBox = null;
  function renderFields2() { if (tab === 'fields' && fieldsBox) { const n = renderFields(); fieldsBox.replaceWith(n); fieldsBox = n; } }

  function renderLeft() {
    clear(tabs);
    for (const [k, t] of [['messages', 'Messages'], ['fields', 'Fields']]) tabs.appendChild(h('button', { type: 'button', class: 'tab' + (tab === k ? ' on' : ''), onclick: () => setTab(k) }, t));
    tabs.appendChild(h('span', { class: 'grow' }));
    tabs.appendChild(kindToggle);
    kindToggle.textContent = instance.size ? `Instance fields: ${[...instance].sort((a, b) => a - b).map((i) => 'F' + (i + 1)).join(', ')}` : '';
    clear(leftBody);
    if (tab === 'messages') {
      leftBody.appendChild(msgBar);
      leftBody.appendChild(listInfo);
      leftBody.appendChild(list.el);
      applyFilter();
    } else {
      fieldsBox = renderFields();
      leftBody.appendChild(fieldsBox);
    }
  }

  // ---------------------------------------------------------------- middle pane: raw lines + context
  const rawHead = h('div', { class: 'pane-title' });
  const RAW_PAGE = 100;
  let rawShown = 0;
  const rawListEl = h('div', { class: 'raw-list mono' });
  const rawList = { // paged, wrapped list (full text of every line)
    el: rawListEl,
    setCount() { clear(rawListEl); rawShown = 0; this.more(); },
    more() {
      rawListEl.querySelector('.raw-more')?.remove();
      const end = Math.min(occ.length, rawShown + RAW_PAGE);
      for (let k = rawShown; k < end; k++) rawListEl.appendChild(renderRawRow(k));
      rawShown = end;
      if (rawShown < occ.length) rawListEl.appendChild(h('button', { type: 'button', class: 'btn tiny ghost raw-more', onclick: () => this.more() }, `Show ${Math.min(RAW_PAGE, occ.length - rawShown)} more (${fmtNum(occ.length - rawShown)} left)`));
    },
    refresh() { for (const r of rawListEl.querySelectorAll('.rawrow')) r.classList.toggle('active', ctxState && +r.dataset.i === ctxState.target); },
  };
  const rawBox = h('div', { class: 'raw-box' }, rawHead, rawListEl);
  const ctxBox = h('div', { class: 'ctx-box' });
  mid.appendChild(rawBox);
  mid.appendChild(ctxBox);
  let occ = [];
  let ctxState = null;

  function renderRaw() {
    clear(rawHead);
    if (!active) {
      occ = [];
      rawHead.appendChild(h('span', null, 'Raw lines'));
      rawHead.appendChild(h('span', { class: 'muted small' }, ' — click a message on the left to read its raw lines'));
      rawList.setCount(0);
      return;
    }
    const js = active.type === 'kind' ? kinds[active.idx].msgs : [active.idx];
    if (js.length === 1) occ = msgs[js[0]].occ;
    else { occ = js.flatMap((j) => msgs[j].occ); occ.sort((a, b) => a - b); }
    rawHead.appendChild(h('span', null, `Raw lines · ${fmtNum(occ.length)} occurrence${occ.length === 1 ? '' : 's'}`));
    if (js.length > 1) rawHead.appendChild(h('span', { class: 'muted small' }, ` of ${fmtNum(js.length)} messages`));
    rawHead.appendChild(h('span', { class: 'muted small' }, ' · click a line to see its context'));
    rawList.setCount(occ.length);
    rawListEl.scrollTop = 0;
  }

  function renderRawRow(k) {
    const i = occ[k];
    const L = lineCached(task, i);
    const isCtx = ctxState && ctxState.target === i;
    const row = h('div', { class: 'rawrow' + (isCtx ? ' active' : ''), 'data-i': String(i), title: 'Show context', onclick: () => openContext(i) }, L ? L[3] : '…');
    if (!L) loadLine(task, i).then((x) => { row.textContent = x[3]; }).catch(() => { row.textContent = '(could not load)'; });
    return row;
  }

  function openContext(i) {
    const [ws, we] = windowOf(task, i);
    ctxState = { target: i, ws, we, lo: Math.max(ws, i - CTX_INITIAL), hi: Math.min(we, i + CTX_INITIAL + 1) };
    sess.contextOpened = true;
    opts.onView?.({ type: 'context', i });
    rawList.refresh();
    renderContext();
    changed();
  }

  async function renderContext() {
    clear(ctxBox);
    if (!ctxState) {
      ctxBox.appendChild(h('div', { class: 'pane-title' }, 'Context', h('span', { class: 'muted small' }, ' — click a raw line to see the lines around it')));
      return;
    }
    const s = ctxState;
    const earlier = h('button', { type: 'button', class: 'btn tiny', disabled: s.lo <= s.ws, onclick: () => { s.lo = Math.max(s.ws, s.lo - CTX_STEP); renderContext(); } }, '▲ Earlier');
    const later = h('button', { type: 'button', class: 'btn tiny', disabled: s.hi >= s.we, onclick: () => { s.hi = Math.min(s.we, s.hi + CTX_STEP); renderContext(); } }, '▼ Later');
    const close = h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { ctxState = null; rawList.refresh(); renderContext(); } }, 'Close');
    ctxBox.appendChild(h('div', { class: 'pane-title' }, 'Context', h('span', { class: 'grow' }), earlier, later, close));
    const body = h('div', { class: 'ctx-lines mono' });
    ctxBox.appendChild(body);
    const lines = await Promise.all(Array.from({ length: s.hi - s.lo }, (_, k) => loadLine(task, s.lo + k)));
    if (ctxState !== s) return;
    let targetEl = null;
    lines.forEach((L, k) => {
      const i = s.lo + k;
      const same = L[1] === meta.g;
      const el = h('div', { class: 'ctx-line' + (i === s.target ? ' target' : '') + (same ? ' same' : ''), title: same ? 'Line of this group' : '' }, L[3]);
      if (i === s.target) targetEl = el;
      body.appendChild(el);
    });
    if (s.lo === s.ws) body.insertBefore(h('div', { class: 'ctx-edge small muted' }, '— start of context —'), body.firstChild);
    if (s.hi === s.we) body.appendChild(h('div', { class: 'ctx-edge small muted' }, '— end of context —'));
    if (targetEl && !s.scrolled) { s.scrolled = true; targetEl.scrollIntoView({ block: 'center' }); }
  }

  // ---------------------------------------------------------------- model for the judgment panel
  const listeners = new Set();
  function changed() { for (const f of listeners) f(); }

  function viewedKindsInfo() {
    const k = kinds.length;
    const vk = new Set();
    for (const j of sess.viewed) vk.add(msgKind[j]);
    return { k, vk };
  }

  const model = {
    kind: 'lines',
    nItems: M,
    totalMembers: meta.n,
    itemName: 'message',
    itemPlural: 'messages',
    weight: (j) => msgs[j].n,
    selection: () => [...selected],
    clearSelection: (silent) => { selected = new Set(); list.refresh(); if (!silent) changed(); },
    splitFields: () => Array.from({ length: F }, (_, i) => ({ id: i, name: `Field ${i + 1}` })),
    splitValue: (i, j) => msgs[j].v[i] ?? '',
    reqPropagate() {
      const { k, vk } = viewedKindsInfo();
      const need = Math.min(3, k);
      const R = [
        { ok: sess.sawList, text: 'look at Messages or Fields' },
        { ok: vk.size >= need, text: `read the raw lines of ${need} kind${need === 1 ? '' : 's'} of message (${Math.min(vk.size, need)}/${need}${instance.size ? ', after merging instance fields' : ''})` },
        { ok: vk.has(0), text: 'including the most frequent kind (top of the list)' },
      ];
      if (k >= 5) {
        const half = Math.ceil(k / 2);
        R.push({ ok: [...vk].some((x) => x >= half), text: `including a less common kind (lower half of the ${k} kinds)` });
      }
      R.push({ ok: sess.contextOpened, text: 'open at least one context' });
      return R;
    },
    reqItems(list) {
      return [{ ok: list.some((j) => sess.viewed.has(j)), text: 'read the raw lines of at least one of the selected messages' }];
    },
    reqSplit(parts) {
      return parts.map((p, n) => ({ ok: p.some((j) => sess.viewed.has(j)), text: `each part has a message whose raw lines you read (${n + 1}/${parts.length})` }));
    },
    onCoverage(c) { cov = c; for (const j of selected) if (cov[j]) selected.delete(j); list.refresh(); },
    onChange(f) { listeners.add(f); },
    session: sess,
  };

  renderLeft();
  renderRaw();
  renderContext();
  const rp = opts.rightPane(model);
  if (rp) right.appendChild(rp);

  return {
    model,
    destroy() { listeners.clear(); },
    focusMessage(j) { setTab('messages'); const r = byKind() ? msgKind[j] : j; const k = shown.indexOf(r); if (k >= 0) list.scrollToRow(k); openRow(r); },
    filterTo(js) { /* review: show only these messages */ const set = new Set(js); fieldFilter = null; filterText = ''; filterInp.value = ''; setTab('messages'); shown = shown.filter((r) => rowMsgs(r).some((j) => set.has(j))); list.setCount(shown.length); listInfo.textContent = `${fmtNum(shown.length)} rows with disagreements`; },
    selectAllKinds() {},
  };
}
