// Workspace for one HDFS group (blocks sharing an event-count vector).
import { h, clear, fmtNum } from './util.js';
import { VList } from './vlist.js';
import { loadTrace } from './data.js';
import { LABEL_NAMES } from './core.js';

export function orderTag(o) {
  let s = '';
  o = o + 1;
  while (o > 0) { const r = (o - 1) % 26; s = String.fromCharCode(65 + r) + s; o = Math.floor((o - 1) / 26); }
  return s;
}
function tagColor(o) { return `hsl(${Math.round((o * 137.508 + 210) % 360)}, 55%, 42%)`; }
function fmtSec(s) {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/**
 * opts: { task, meta, data, rightPane(model), labelOf(c), onView(evt), answerBadge(js), selectable }
 */
export function mountHdfsGroup(root, opts) {
  const { task, meta, data } = opts;
  const blocks = data.blocks;
  const N = blocks.length;
  const types = new Map(task.event_types.map((e) => [e.id, e.template]));
  const sess = { viewed: new Set() };
  let selected = new Set();
  let cov = new Int32Array(N);
  let active = null, compare = null;
  let fOrder = '', fClass = '';
  let shown = [];

  clear(root);
  const head = h('div', { class: 'ws-head' });
  const left = h('section', { class: 'pane pane-left' });
  const mid = h('section', { class: 'pane pane-mid' });
  const right = h('section', { class: 'pane pane-right' });
  root.appendChild(head);
  root.appendChild(h('div', { class: 'ws-grid' }, left, mid, right));

  const ecv = h('div', { class: 'ecv' });
  for (const [e, c] of meta.ecv) ecv.appendChild(h('span', { class: 'ecv-chip', title: types.get(e) || '' }, h('b', null, 'T' + e), ` ×${c}`, h('span', { class: 'ecv-tpl' }, (types.get(e) || '').replace(/<\*>/g, ' … ').trim())));
  head.appendChild(h('div', { class: 'tpl-row' }, h('span', { class: 'tpl-label' }, 'Count vector'), ecv));
  const classes = [...new Set(blocks.map((b) => b.c))];
  head.appendChild(h('div', { class: 'badge-row' },
    h('span', { class: 'badge' }, h('b', null, fmtNum(N)), ' blocks'),
    h('span', { class: 'badge' }, h('b', null, fmtNum(meta.o)), ' event orders'),
    h('span', { class: 'badge' }, h('b', null, fmtNum(classes.length)), ' file classes'),
    h('span', { class: 'muted small' }, 'Hover an event for its template.')));

  // ---------------------------------------------------------------- block list
  const orders = [...new Set(blocks.map((b) => b.o))].sort((a, b) => a - b);
  const oSel = h('select', { class: 'inp' }, h('option', { value: '' }, 'All orders'), orders.map((o) => h('option', { value: String(o) }, `Order ${orderTag(o)} (${blocks.filter((b) => b.o === o).length})`)));
  const cSel = h('select', { class: 'inp grow' }, h('option', { value: '' }, 'All file classes'), classes.map((c) => h('option', { value: c }, c)));
  oSel.addEventListener('change', () => { fOrder = oSel.value; applyFilter(); });
  cSel.addEventListener('change', () => { fClass = cSel.value; applyFilter(); });
  const selAll = h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { for (const i of shown) if (!cov[i]) selected.add(i); list.refresh(); changed(); } }, 'Select shown');
  const info = h('div', { class: 'list-info small muted' });
  const list = new VList({ rowHeight: 30, render: renderRow, className: 'msg-list' });
  left.appendChild(h('div', { class: 'tabs' }, h('span', { class: 'tab on' }, 'Blocks')));
  left.appendChild(h('div', { class: 'pane-body' },
    h('div', { class: 'list-bar' }, oSel, cSel, opts.selectable !== false ? selAll : null),
    h('div', { class: 'blk-head small muted' }, opts.selectable !== false ? h('span', { class: 'bh-cb' }) : null, h('span', { class: 'bh-dot' }), h('span', { class: 'bh-o' }, 'Order'), h('span', { class: 'bh-e num' }, 'Events'), h('span', { class: 'bh-d num' }, 'Duration'), h('span', { class: 'bh-ip num' }, 'Nodes'), h('span', { class: 'bh-c' }, 'File class')),
    info, list.el));

  function applyFilter() {
    shown = [];
    for (let i = 0; i < N; i++) {
      const b = blocks[i];
      if (fOrder !== '' && String(b.o) !== fOrder) continue;
      if (fClass && b.c !== fClass) continue;
      shown.push(i);
    }
    info.textContent = `${fmtNum(N)} blocks${shown.length !== N ? ` · ${fmtNum(shown.length)} shown` : ''} · same letter = same event order`;
    list.setCount(shown.length);
  }

  function renderRow(k) {
    const i = shown[k];
    const b = blocks[i];
    const row = h('div', { class: 'mrow brow' + (active === i ? ' active' : '') + (compare === i ? ' compare' : '') + (k % 2 ? ' odd' : '') });
    if (opts.selectable !== false) {
      const cb = h('input', { type: 'checkbox', class: 'msel', disabled: !!cov[i], checked: !cov[i] && selected.has(i) });
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => { if (cb.checked) selected.add(i); else selected.delete(i); changed(); });
      row.appendChild(cb);
    }
    const lab = cov[i] ? opts.labelOf(cov[i]) : null;
    row.appendChild(h('span', { class: 'cov-dot ' + (lab ? 'lab-' + lab : 'none'), title: lab ? 'Covered: ' + LABEL_NAMES[lab] : 'Not covered' }));
    row.appendChild(h('span', { class: 'bh-o' }, h('span', { class: 'otag', style: { background: tagColor(b.o) } }, orderTag(b.o))));
    row.appendChild(h('span', { class: 'bh-e num' }, b.e));
    row.appendChild(h('span', { class: 'bh-d num' }, fmtSec(b.d)));
    row.appendChild(h('span', { class: 'bh-ip num' }, b.ip));
    row.appendChild(h('span', { class: 'bh-c mono small', title: b.c }, b.c));
    if (opts.answerBadge) row.appendChild(opts.answerBadge([i]));
    if (sess.viewed.has(i)) row.appendChild(h('span', { class: 'seen', title: 'Log viewed' }, '●'));
    row.appendChild(h('button', { type: 'button', class: 'btn tiny ghost cmp', title: 'Show next to the open block', onclick: (e) => { e.stopPropagation(); openBlock(i, true); } }, '⇆'));
    row.addEventListener('click', () => openBlock(i, false));
    return row;
  }

  // ---------------------------------------------------------------- block logs
  const logs = h('div', { class: 'blk-logs' });
  mid.appendChild(logs);

  function openBlock(i, asCompare) {
    if (asCompare && active != null && active !== i) compare = i;
    else { active = i; if (compare === i) compare = null; }
    sess.viewed.add(i);
    opts.onView?.({ type: 'block', i });
    list.refresh();
    renderLogs();
    changed();
  }

  async function renderLogs() {
    clear(logs);
    if (active == null) {
      logs.appendChild(h('div', { class: 'pane-title' }, 'Block log', h('span', { class: 'muted small' }, ' — click a block to read its full log; ⇆ opens a second block side by side')));
      return;
    }
    const ids = compare != null ? [active, compare] : [active];
    const cols = h('div', { class: 'blk-cols' + (ids.length > 1 ? ' two' : '') });
    logs.appendChild(cols);
    const traces = await Promise.all(ids.map((i) => loadTrace(task.key, blocks[i].t)));
    ids.forEach((i, n) => {
      const b = blocks[i];
      const col = h('div', { class: 'blk-col' });
      col.appendChild(h('div', { class: 'pane-title' },
        h('span', { class: 'otag', style: { background: tagColor(b.o) } }, orderTag(b.o)),
        h('span', { class: 'mono small' }, ` ${b.b}`), h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, `${b.e} events · ${fmtSec(b.d)} · ${b.ip} nodes`),
        n === 1 ? h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { compare = null; list.refresh(); renderLogs(); } }, 'Close') : null));
      const body = h('div', { class: 'ctx-lines mono' });
      for (const [, ev, text] of traces[n]) {
        body.appendChild(h('div', { class: 'ctx-line tline' }, h('span', { class: 'ev', title: types.get(ev) || '' }, 'T' + ev), ' ', text));
      }
      col.appendChild(body);
      cols.appendChild(col);
    });
  }

  // ---------------------------------------------------------------- model
  const listeners = new Set();
  function changed() { for (const f of listeners) f(); }
  const model = {
    kind: 'blocks',
    nItems: N,
    totalMembers: N,
    itemName: 'block',
    itemPlural: 'blocks',
    weight: () => 1,
    selection: () => [...selected],
    clearSelection: (silent) => { selected = new Set(); list.refresh(); if (!silent) changed(); },
    splitFields: () => [{ id: 'c', name: 'File class' }, { id: 'o', name: 'Event order' }],
    splitValue: (f, i) => (f === 'o' ? 'Order ' + orderTag(blocks[i].o) : blocks[i].c),
    reqPropagate() { return hdfsReqs(); },
    reqItems(list) { return [{ ok: list.some((i) => sess.viewed.has(i)), text: 'read the log of at least one of the selected blocks' }]; },
    reqSplit() { return hdfsReqs(); },
    onCoverage(c) { cov = c; for (const i of selected) if (cov[i]) selected.delete(i); list.refresh(); },
    onChange(f) { listeners.add(f); },
    session: sess,
  };
  function hdfsReqs() {
    const needB = Math.min(3, N);
    const needO = Math.min(3, meta.o);
    const vo = new Set([...sess.viewed].map((i) => blocks[i].o));
    return [
      { ok: sess.viewed.size >= needB, text: `read the logs of ${needB} block${needB === 1 ? '' : 's'} (${Math.min(sess.viewed.size, needB)}/${needB})` },
      { ok: vo.size >= needO, text: `covering ${needO} different event order${needO === 1 ? '' : 's'} (${Math.min(vo.size, needO)}/${needO})` },
    ];
  }

  applyFilter();
  renderLogs();
  const rp = opts.rightPane(model);
  if (rp) right.appendChild(rp);
  return {
    model,
    destroy() { listeners.clear(); },
    focusMessage(i) { const k = shown.indexOf(i); if (k >= 0) list.scrollToRow(k); openBlock(i, false); },
    filterTo(is) { const set = new Set(is); fOrder = ''; fClass = ''; oSel.value = ''; cSel.value = ''; shown = []; for (let i = 0; i < N; i++) if (set.has(i)) shown.push(i); list.setCount(shown.length); info.textContent = `${fmtNum(shown.length)} blocks with disagreements`; },
  };
}
