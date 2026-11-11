// Read-only view of one HDFS group (blocks sharing an event-count vector).
import { h, clear, fmtNum } from './util.js';
import { VList } from './vlist.js';
import { loadTrace } from './data.js';

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
 * opts: { task, meta, data, rightPane: HTMLElement, answerBadge(i)? -> HTMLElement }
 */
export function mountHdfsGroup(root, opts) {
  const { task, meta, data } = opts;
  const blocks = data.blocks;
  const N = blocks.length;
  const types = new Map(task.event_types.map((e) => [e.id, e.template]));
  let active = null, compare = null;
  let fOrder = '', fClass = '';
  let onlyRows = null;
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
    h('span', { class: 'muted small' }, 'Hover an event for its template.')));

  const orders = [...new Set(blocks.map((b) => b.o))].sort((a, b) => a - b);
  const oSel = h('select', { class: 'inp' }, h('option', { value: '' }, 'All orders'), orders.map((o) => h('option', { value: String(o) }, `Order ${orderTag(o)} (${blocks.filter((b) => b.o === o).length})`)));
  const cSel = h('select', { class: 'inp grow' }, h('option', { value: '' }, 'All file classes'), classes.map((c) => h('option', { value: c }, c)));
  oSel.addEventListener('change', () => { fOrder = oSel.value; applyFilter(); });
  cSel.addEventListener('change', () => { fClass = cSel.value; applyFilter(); });
  const info = h('div', { class: 'list-info small muted' });
  const list = new VList({ rowHeight: 30, render: renderRow, className: 'msg-list' });
  left.appendChild(h('div', { class: 'tabs' }, h('span', { class: 'tab on' }, 'Blocks')));
  left.appendChild(h('div', { class: 'pane-body' },
    h('div', { class: 'list-bar' }, oSel, cSel),
    h('div', { class: 'blk-head small muted' }, h('span', { class: 'bh-o' }, 'Order'), h('span', { class: 'bh-e num' }, 'Events'), h('span', { class: 'bh-d num' }, 'Duration'), h('span', { class: 'bh-ip num' }, 'Nodes'), h('span', { class: 'bh-c' }, 'File class')),
    info, list.el));

  function applyFilter() {
    shown = [];
    for (let i = 0; i < N; i++) {
      const b = blocks[i];
      if (onlyRows && !onlyRows.has(i)) continue;
      if (fOrder !== '' && String(b.o) !== fOrder) continue;
      if (fClass && b.c !== fClass) continue;
      shown.push(i);
    }
    info.textContent = `${fmtNum(N)} blocks${shown.length !== N ? ` · ${fmtNum(shown.length)} shown` : ''} · same letter = same event order · click a block to read its log`;
    list.setCount(shown.length);
  }

  function renderRow(k) {
    const i = shown[k];
    const b = blocks[i];
    const row = h('div', { class: 'mrow brow' + (active === i ? ' active' : '') + (compare === i ? ' compare' : '') + (k % 2 ? ' odd' : '') });
    row.appendChild(h('span', { class: 'bh-o' }, h('span', { class: 'otag', style: { background: tagColor(b.o) } }, orderTag(b.o))));
    row.appendChild(h('span', { class: 'bh-e num' }, b.e));
    row.appendChild(h('span', { class: 'bh-d num' }, fmtSec(b.d)));
    row.appendChild(h('span', { class: 'bh-ip num' }, b.ip));
    row.appendChild(h('span', { class: 'bh-c mono small', title: b.c }, b.c));
    const badge = opts.answerBadge?.(i);
    if (badge) row.appendChild(badge);
    row.appendChild(h('button', { type: 'button', class: 'btn tiny ghost cmp', title: 'Show next to the open block', onclick: (e) => { e.stopPropagation(); openBlock(i, true); } }, '⇆'));
    row.addEventListener('click', () => openBlock(i, false));
    return row;
  }

  const logs = h('div', { class: 'blk-logs' });
  mid.appendChild(logs);

  function openBlock(i, asCompare) {
    if (asCompare && active != null && active !== i) compare = i;
    else { active = i; if (compare === i) compare = null; }
    list.refresh();
    renderLogs();
  }

  async function renderLogs() {
    clear(logs);
    if (active == null) {
      logs.appendChild(h('div', { class: 'pane-title' }, 'Block log', h('span', { class: 'muted small' }, ' — click a block; ⇆ opens a second block side by side')));
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
        h('span', { class: 'muted small' }, `${b.e} events · ${fmtSec(b.d)}`),
        n === 1 ? h('button', { type: 'button', class: 'btn tiny ghost', onclick: () => { compare = null; list.refresh(); renderLogs(); } }, 'Close') : null));
      const body = h('div', { class: 'ctx-lines mono' });
      for (const [, ev, text] of traces[n]) body.appendChild(h('div', { class: 'ctx-line tline' }, h('span', { class: 'ev', title: types.get(ev) || '' }, 'T' + ev), ' ', text));
      col.appendChild(body);
      cols.appendChild(col);
    });
  }

  applyFilter();
  renderLogs();
  if (opts.rightPane) right.appendChild(opts.rightPane);
  return {
    showOnly(is) { onlyRows = is ? new Set(is) : null; fOrder = ''; fClass = ''; oSel.value = ''; cSel.value = ''; applyFilter(); },
    refresh() { list.refresh(); },
    destroy() {},
  };
}
