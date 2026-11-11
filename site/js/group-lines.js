// Read-only view of one BGL / Thunderbird group: messages, field values, raw lines, context.
import { h, clear, fmtNum, debounce } from './util.js';
import { VList } from './vlist.js';
import { loadLine, lineCached, windowOf } from './data.js';

const CTX_INITIAL = 8;
const CTX_STEP = 20;

/**
 * opts: { task, meta, data, dataset, rightPane: HTMLElement, answerBadge(j)? -> HTMLElement }
 */
export function mountLineGroup(root, opts) {
  const { task, meta, data } = opts;
  const msgs = data.messages;
  const M = msgs.length;
  const F = meta.f;
  const tplParts = (meta.template === '<EMPTY>' ? '' : meta.template).split('<*>');

  let tab = 'messages';
  let filterText = '';
  let fieldFilter = null; // {i, v}
  let onlyRows = null;    // Set of message indices to show (answer view: differing messages)
  let active = null;      // message index
  let shown = [];
  let searchCache = null;

  const fieldSorted = [];
  for (let i = 0; i < F; i++) {
    const mp = new Map();
    for (const m of msgs) { const v = m.v[i] ?? ''; mp.set(v, (mp.get(v) || 0) + m.n); }
    fieldSorted.push([...mp.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  }

  function msgParts(v) {
    const out = [];
    for (let i = 0; i < tplParts.length; i++) {
      if (tplParts[i]) out.push(tplParts[i]);
      if (i < tplParts.length - 1) out.push({ i, v: v[i] ?? '' });
    }
    return out;
  }
  const plainText = (v) => msgParts(v).map((p) => (typeof p === 'string' ? p : p.v)).join('');

  // ---------------------------------------------------------------- layout
  clear(root);
  const head = h('div', { class: 'ws-head' });
  const left = h('section', { class: 'pane pane-left' });
  const mid = h('section', { class: 'pane pane-mid' });
  const right = h('section', { class: 'pane pane-right' });
  root.appendChild(head);
  root.appendChild(h('div', { class: 'ws-grid' }, left, mid, right));

  const tplEl = h('div', { class: 'tpl-big mono' });
  tplParts.forEach((p, i) => {
    if (p) tplEl.appendChild(document.createTextNode(p));
    if (i < tplParts.length - 1) tplEl.appendChild(h('button', { type: 'button', class: 'field-chip', title: `Field ${i + 1}: show its values`, onclick: () => { setTab('fields'); setTimeout(() => left.querySelector(`#fcard-${i}`)?.scrollIntoView({ block: 'start' }), 30); } }, `<*>${i + 1}`));
  });
  if (!tplParts.join('')) tplEl.appendChild(h('span', { class: 'muted' }, '(empty message)'));
  const badges = opts.dataset === 'bgl'
    ? [h('span', { class: 'badge' }, 'Component ', h('b', null, meta.key[0])), h('span', { class: 'badge lvl-' + String(meta.key[1]).toLowerCase() }, 'Level ', h('b', null, meta.key[1]))]
    : [h('span', { class: 'badge' }, 'Service ', h('b', null, meta.key[0]))];
  head.appendChild(h('div', { class: 'tpl-row' }, h('span', { class: 'tpl-label' }, 'Template'), tplEl));
  head.appendChild(h('div', { class: 'badge-row' }, badges, h('span', { class: 'badge' }, h('b', null, fmtNum(M)), M === 1 ? ' distinct message' : ' distinct messages'), h('span', { class: 'badge' }, h('b', null, fmtNum(meta.n)), ' lines')));

  // ---------------------------------------------------------------- left: messages / fields
  const tabs = h('div', { class: 'tabs' });
  const leftBody = h('div', { class: 'pane-body' });
  left.appendChild(tabs);
  left.appendChild(leftBody);

  function setTab(t) { tab = t; renderLeft(); }

  const list = new VList({ rowHeight: 30, render: renderRow, className: 'msg-list' });
  const listInfo = h('div', { class: 'list-info small muted' });
  const filterInp = h('input', { type: 'search', class: 'inp grow', placeholder: 'Filter messages…' });
  filterInp.addEventListener('input', debounce(() => { filterText = filterInp.value; applyFilter(); }, 150));
  const chips = h('span');
  const msgBar = h('div', { class: 'list-bar' }, filterInp, chips);

  function applyFilter() {
    const f = filterText.trim().toLowerCase();
    if (f && !searchCache) searchCache = msgs.map((m) => plainText(m.v).toLowerCase());
    shown = [];
    for (let j = 0; j < M; j++) {
      if (onlyRows && !onlyRows.has(j)) continue;
      if (fieldFilter && (msgs[j].v[fieldFilter.i] ?? '') !== fieldFilter.v) continue;
      if (f && !searchCache[j].includes(f)) continue;
      shown.push(j);
    }
    clear(chips);
    if (fieldFilter) chips.appendChild(h('span', { class: 'chip' }, `F${fieldFilter.i + 1} = ${fieldFilter.v === '' ? '(empty)' : fieldFilter.v}`, h('button', { type: 'button', class: 'chip-x', onclick: () => { fieldFilter = null; applyFilter(); } }, '×')));
    if (onlyRows) chips.appendChild(h('span', { class: 'chip' }, 'differing messages only', h('button', { type: 'button', class: 'chip-x', onclick: () => { onlyRows = null; applyFilter(); } }, '×')));
    listInfo.textContent = `${fmtNum(M)} message${M === 1 ? '' : 's'}${shown.length !== M ? ` · ${fmtNum(shown.length)} shown` : ''} · most frequent first · click one to read its raw lines`;
    list.setCount(shown.length);
  }

  function renderRow(k) {
    const j = shown[k];
    const row = h('div', { class: 'mrow' + (active === j ? ' active' : '') + (k % 2 ? ' odd' : '') });
    row.appendChild(h('span', { class: 'mcount num' }, fmtNum(msgs[j].n)));
    const txt = h('span', { class: 'mtext mono' });
    for (const p of msgParts(msgs[j].v)) txt.appendChild(typeof p === 'string' ? document.createTextNode(p) : h('span', { class: 'fv' }, p.v));
    row.appendChild(txt);
    const badge = opts.answerBadge?.(j);
    if (badge) row.appendChild(badge);
    row.addEventListener('click', () => openRow(j));
    return row;
  }

  function openRow(j) { active = j; list.refresh(); renderRaw(); }

  function renderFields() {
    const box = h('div', { class: 'fields' });
    if (!F) box.appendChild(h('p', { class: 'muted' }, 'This template has no variable fields: every message is identical.'));
    for (let i = 0; i < F; i++) {
      const vals = fieldSorted[i];
      let limit = 15;
      const tbl = h('div', { class: 'ftable' });
      const draw = () => {
        clear(tbl);
        for (const [v, c] of vals.slice(0, limit)) {
          tbl.appendChild(h('div', { class: 'frow', title: 'Show messages with this value', onclick: () => { fieldFilter = { i, v }; setTab('messages'); } },
            h('code', { class: 'fval' }, v === '' ? '(empty)' : v),
            h('span', { class: 'fbar' }, h('span', { style: { width: Math.max(1, 100 * c / meta.n) + '%' } })),
            h('span', { class: 'num small' }, fmtNum(c))));
        }
        if (vals.length > limit) tbl.appendChild(h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { limit += 50; draw(); } }, `Show more (${fmtNum(vals.length - limit)} left)`));
      };
      draw();
      box.appendChild(h('div', { class: 'fcard', id: `fcard-${i}` },
        h('div', { class: 'fcard-head' }, h('strong', null, `Field ${i + 1}`), h('span', { class: 'muted small' }, `${fmtNum(vals.length)} distinct value${vals.length === 1 ? '' : 's'} · click a value to filter`)),
        tbl));
    }
    return box;
  }

  function renderLeft() {
    clear(tabs);
    for (const [k, t] of [['messages', 'Messages'], ['fields', 'Fields']]) tabs.appendChild(h('button', { type: 'button', class: 'tab' + (tab === k ? ' on' : ''), onclick: () => setTab(k) }, t));
    clear(leftBody);
    if (tab === 'messages') { leftBody.appendChild(msgBar); leftBody.appendChild(listInfo); leftBody.appendChild(list.el); applyFilter(); }
    else leftBody.appendChild(renderFields());
  }

  // ---------------------------------------------------------------- middle: raw lines + context
  const rawHead = h('div', { class: 'pane-title' });
  const RAW_PAGE = 100;
  let rawShown = 0;
  let occ = [];
  let ctxState = null;
  const rawListEl = h('div', { class: 'raw-list mono' });
  const ctxBox = h('div', { class: 'ctx-box' });
  mid.appendChild(h('div', { class: 'raw-box' }, rawHead, rawListEl));
  mid.appendChild(ctxBox);

  function moreRaw() {
    rawListEl.querySelector('.raw-more')?.remove();
    const end = Math.min(occ.length, rawShown + RAW_PAGE);
    for (let k = rawShown; k < end; k++) rawListEl.appendChild(renderRawRow(occ[k]));
    rawShown = end;
    if (rawShown < occ.length) rawListEl.appendChild(h('button', { type: 'button', class: 'btn tiny ghost raw-more', onclick: moreRaw }, `Show ${Math.min(RAW_PAGE, occ.length - rawShown)} more (${fmtNum(occ.length - rawShown)} left)`));
  }

  function renderRaw() {
    clear(rawHead); clear(rawListEl); rawShown = 0;
    if (active == null) {
      occ = [];
      rawHead.append('Raw lines', h('span', { class: 'muted small' }, ' — click a message on the left'));
      return;
    }
    occ = msgs[active].occ;
    rawHead.append(`Raw lines · ${fmtNum(occ.length)}`, h('span', { class: 'muted small' }, ' · click a line to see its context'));
    moreRaw();
    rawListEl.scrollTop = 0;
  }

  function renderRawRow(i) {
    const L = lineCached(task, i);
    const row = h('div', { class: 'rawrow' + (ctxState && ctxState.target === i ? ' active' : ''), 'data-i': String(i), onclick: () => openContext(i) }, L ? L[3] : '…');
    if (!L) loadLine(task, i).then((x) => { row.textContent = x[3]; }).catch(() => { row.textContent = '(could not load)'; });
    return row;
  }

  function openContext(i) {
    const [ws, we] = windowOf(task, i);
    ctxState = { target: i, ws, we, lo: Math.max(ws, i - CTX_INITIAL), hi: Math.min(we, i + CTX_INITIAL + 1) };
    for (const r of rawListEl.querySelectorAll('.rawrow')) r.classList.toggle('active', +r.dataset.i === i);
    renderContext();
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
    ctxBox.appendChild(h('div', { class: 'pane-title' }, 'Context', h('span', { class: 'grow' }), earlier, later));
    const body = h('div', { class: 'ctx-lines mono' });
    ctxBox.appendChild(body);
    const lines = await Promise.all(Array.from({ length: s.hi - s.lo }, (_, k) => loadLine(task, s.lo + k)));
    if (ctxState !== s) return;
    let targetEl = null;
    lines.forEach((L, k) => {
      const i = s.lo + k;
      const el = h('div', { class: 'ctx-line' + (i === s.target ? ' target' : '') + (L[1] === meta.g ? ' same' : '') }, L[3]);
      if (i === s.target) targetEl = el;
      body.appendChild(el);
    });
    if (s.lo === s.ws) body.insertBefore(h('div', { class: 'ctx-edge small muted' }, '— start of context —'), body.firstChild);
    if (s.hi === s.we) body.appendChild(h('div', { class: 'ctx-edge small muted' }, '— end of context —'));
    if (targetEl && !s.scrolled) { s.scrolled = true; targetEl.scrollIntoView({ block: 'center' }); }
  }

  renderLeft();
  renderRaw();
  renderContext();
  if (opts.rightPane) right.appendChild(opts.rightPane);

  return {
    showOnly(js) { onlyRows = js ? new Set(js) : null; setTab('messages'); },
    refresh() { list.refresh(); },
    destroy() {},
  };
}
