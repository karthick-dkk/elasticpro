/**
 * Reports › Volume by host (0.3.54, docs/REPORT-TYPES.md "View in ElasticPro"): one cluster,
 * a day or a month, the kept per-day host rows as the workbook has them. The server pages
 * (HOSTS_QUERY, 200 a page) and sorts and searches; this holds none of it.
 *
 * Event size is event_logsize, Forwarded size the forwarded one. A figure Elasticsearch did
 * not report is amber "not measured", never 0. The section keeps its own DOM between the
 * page's redraws so a search box keeps its focus while the table under it changes.
 */

import { h, mount } from '../lib/dom.js';
import { markupSig, objId } from '../lib/keyed.js';
import { bytes, num, plural } from '../lib/fmt.js';
import { empty } from '../pages/common.js';
import { utcDay, monthName } from '../core/volume-daily.js';
import { HOSTS_PAGE, hostsQuery, hostsOf, monthRange, sortKey } from '../core/report-types.js';
import { amber } from './cells.js';
import { tableSort, sortTh } from '../lib/table-sort.js';

const FIXED = [
  { col: 'day', label: 'Day' }, { col: 'index', label: 'Index' }, { col: 'source', label: 'Source' }, { col: 'host', label: 'Host' },
  { col: 'docs', label: 'Documents', num: true }, { col: 'eventBytes', label: 'Event size', num: true, title: 'event_logsize' },
  { col: 'subBytes', label: 'Forwarded size', num: true, title: 'the forwarded size' },
];

/**
 * The order is the server's (it pages there), so only the header is shared (lib/table-sort.js
 * sortTh) and the choice remembered — for the fixed columns, which every cluster has.
 */
const HOST_SORT = tableSort('reports.hosts', { initial: { key: 'day', dir: 1 } });
const initialSort = () => {
  const s = HOST_SORT.sort;
  return s && FIXED.some((c) => c.col === s.key) ? { col: s.key, dir: s.dir === -1 ? 'desc' : 'asc' } : { col: 'day', dir: 'asc' };
};

const v = {
  clusterId: null, mode: 'month', month: null, day: null, q: '', sort: initialSort(), offset: 0,
  state: 'idle', data: null, error: '', seq: 0,
};
let root = null;
let table = null;
let pickerSlot = null;
let timer = null;

export function hostsReset() {
  clearTimeout(timer);
  Object.assign(v, { clusterId: null, mode: 'month', month: null, day: null, q: '', sort: initialSort(), offset: 0, state: 'idle', data: null, error: '', seq: 0 });
  root = null; table = null; pickerSlot = null; paintedSig = '';
}

const months = (n = 13) => {
  const d = new Date();
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
};

const periodOf = () => (v.mode === 'day' ? { from: v.day, to: v.day } : monthRange(v.month, utcDay()));

async function fetchRows() {
  const seq = ++v.seq;
  v.state = 'loading';
  paintTable();
  const res = await hostsQuery({ clusterId: v.clusterId, period: periodOf(), q: v.q, sort: sortKey(v.sort.col, v.sort.dir), offset: v.offset, limit: HOSTS_PAGE });
  if (seq !== v.seq) return;                       // a newer ask is on its way
  if (res.unsupported) { v.state = 'unsupported'; v.data = null; }
  else if (!res.ok) { v.state = 'error'; v.error = res.message || res.kind || 'no answer'; v.data = null; }
  else { v.state = 'ok'; v.data = hostsOf(res); }
  paintTable();
}

const cellOf = (val, fmtFn) => (val === null || val === undefined ? amber('not measured', 'Elasticsearch did not report this figure') : fmtFn(val));

/** The server's sort as the shared header reads it: a press asks the server again from the first row. */
const serverSort = {
  id: 'hosts',
  get key() { return v.sort.col; },
  get dir() { return v.sort.dir === 'desc' ? -1 : 1; },
  on(col) {
    v.sort = { col, dir: v.sort.col === col && v.sort.dir === 'asc' ? 'desc' : 'asc' };
    HOST_SORT.set({ key: v.sort.col, dir: v.sort.dir === 'desc' ? -1 : 1 });
    v.offset = 0;
    fetchRows();
  },
};

function headCell(c) {
  return sortTh(serverSort, c.col, c.label, { num: !!c.num, attrs: { scope: 'col', dataset: { col: c.col } }, title: c.title ? `${c.title} — click to sort` : null });
}

/** What the table was last drawn from: the page redraws on every push from the core, and the table changes only with these. */
let paintedSig = '';

function paintTable() {
  if (!table) return;
  // While the next page or sort is read the rows on screen stay, as they are: same table, same rows.
  const sig = [v.state === 'loading' && v.data ? 'ok' : v.state, objId(v.data), v.error, v.q, v.sort.col, v.sort.dir, v.offset].join('|');
  if (sig === paintedSig && table.firstChild) return;
  paintedSig = sig;
  if (v.state === 'unsupported') { mount(table, empty('This server does not keep volume by host yet (needs ElasticPro 0.3.54).')); return; }
  if (v.state === 'error') { mount(table, empty('Volume by host could not be read.', { detail: h('span.mono', v.error) })); return; }
  if (!v.data) { mount(table, h('div.tbl-empty', 'Reading volume by host…')); return; }
  const d = v.data;
  // The ClientID and branch columns are the core's filled values (rows[].clientId/branch, as the
  // workbook fills them) and sort on the filled value (`clientId`/`branch`), not the raw field.
  const metaCol = (f) => (f === d.clientIdField ? { col: 'clientId', label: f, fill: 'clientId' }
    : f === d.branchField ? { col: 'branch', label: f, fill: 'branch' } : { col: `meta.${f}`, label: f, meta: f });
  const cols = [...FIXED, ...d.fields.map(metaCol)];
  const metaCell = (r, c) => {
    const val = c.fill ? (r[c.fill] ?? r.meta[c.label]) : r.meta[c.meta];
    return h('td', val === undefined || val === null || val === '' ? h('span.muted', '—') : String(val));
  };
  // Event size: the documents that had no event size are said on hover, never folded into the sum silently.
  const eventCell = (r) => {
    const cell = cellOf(r.eventBytes, (x) => bytes(x));
    return r.eventMissingDocs ? h('span', { title: `${num(r.eventMissingDocs)} document(s) had no event size` }, cell, h('span.hv-inc', `${num(r.eventMissingDocs)} without`)) : cell;
  };
  const row = (r) => h(`tr${r.incomplete ? '.hv-row-inc' : ''}`,
    h('td.mono', r.day, r.incomplete ? h('span.hv-inc', { title: 'The collection hit its page bound on this day: the rows are a lower bound' }, 'incomplete') : null),
    h('td.mono', r.index), h('td', r.source ?? ''), h('td.mono', r.host ?? h('span.muted', 'no host')),
    h('td.num', cellOf(r.docs, num)), h('td.num', eventCell(r)), h('td.num', cellOf(r.subBytes, (x) => bytes(x))),
    ...cols.slice(FIXED.length).map((c) => metaCell(r, c)));
  const totals = h('tr.hv-totals', h('th', { scope: 'row', colspan: 4 }, `Total · ${plural(d.total, 'row')}`),
    h('td.num', cellOf(d.totals.docs, num)), h('td.num', cellOf(d.totals.eventBytes, (x) => bytes(x))), h('td.num', cellOf(d.totals.subBytes, (x) => bytes(x))),
    ...d.fields.map(() => h('td')));
  const from = d.total ? v.offset + 1 : 0;
  const to = Math.min(d.total, v.offset + d.rows.length);
  const page = h('div.hv-pager',
    h('span.muted', `${num(from)}–${num(to)} of ${num(d.total)}`),
    h('button#hv-prev.btn.sm', { type: 'button', disabled: v.offset <= 0, onclick: () => { v.offset = Math.max(0, v.offset - HOSTS_PAGE); fetchRows(); } }, 'Previous'),
    h('button#hv-next.btn.sm', { type: 'button', disabled: v.offset + HOSTS_PAGE >= d.total, onclick: () => { v.offset += HOSTS_PAGE; fetchRows(); } }, 'Next'));
  mount(table,
    d.incompleteDays.length ? h('div.banner.warn.hv-incomplete', { style: { margin: '0 0 6px', fontSize: '12px' } },
      `Incomplete: ${d.incompleteDays.join(', ')}. The collection hit its page bound on ${d.incompleteDays.length === 1 ? 'that day' : 'those days'}, so its rows are a lower bound.`) : null,
    d.failedDays.length ? h('div.banner.warn.hv-days.hv-failed',
      `Not held: ${d.failedDays.map((x) => `${x.day} (${x.failed})`).join(', ')}. The collection is tried again on the next ticks; Run now with Collect again asks at once.`) : null,
    d.collectingDays.length ? h('div.muted.hv-days.hv-collecting',
      `Being collected: ${d.collectingDays.map((x) => x.day).join(', ')}. Their rows appear when the day is complete.`) : null,
    d.notInMapping.length ? h('div.muted.hv-nomap', { style: { margin: '0 0 6px', fontSize: '12px' } },
      `Not in this cluster's mapping, so they have no column: ${d.notInMapping.join(', ')}.`) : null,
    h('div.tbl-wrap.rp-tbl', h('table.tbl.hv-tbl',
      h('thead', h('tr', ...cols.map(headCell))),
      h('tbody', ...(d.rows.length ? d.rows.map(row) : [h('tr', h('td', { colspan: cols.length }, h('div.tbl-empty', v.q ? 'No row matches the search.' : 'No rows held for this period.')))]),
        totals))),
    page);
}

function search(e) {
  clearTimeout(timer);
  const val = e.target.value;
  timer = setTimeout(() => { v.q = val.trim(); v.offset = 0; fetchRows(); }, 300);
}

function build() {
  const ms = months();
  if (!v.month) v.month = ms[0];
  if (!v.day) v.day = utcDay();
  pickerSlot = h('span.hv-picker');
  table = h('div#hv-table.hv-table');
  paintedSig = '';
  const mode = (id, label) => h('button.btn.sm', { type: 'button', 'aria-pressed': String(v.mode === id), onclick: () => { v.mode = id; v.offset = 0; rebuild(); fetchRows(); } }, label);
  const monthSel = h('select#hv-month', { 'aria-label': 'Month', onchange: (e) => { v.month = e.target.value; v.offset = 0; fetchRows(); } },
    ...ms.map((m, i) => h('option', { value: m }, i === 0 ? `${monthName(m)} (so far)` : monthName(m))));
  monthSel.value = v.month;
  const daySel = h('input#hv-day', { type: 'date', 'aria-label': 'Day', value: v.day, onchange: (e) => { if (e.target.value) { v.day = e.target.value; v.offset = 0; fetchRows(); } } });
  const bar = h('div.hv-bar',
    pickerSlot,
    h('div.seg', { role: 'group', 'aria-label': 'Day or month' }, mode('month', 'Month'), mode('day', 'Day')),
    v.mode === 'month' ? monthSel : daySel,
    h('input#hv-q', { type: 'search', placeholder: 'Search host, index or ClientID', 'aria-label': 'Search host, index or ClientID', value: v.q, oninput: search }));
  root = h('div.rp-section.hv', { dataset: { cluster: v.clusterId } },
    h('div.muted.hv-note', { style: { fontSize: '12px' } },
      'One row per day, index and source host, as in the Volume by host workbook. Event size is event_logsize; a figure Elasticsearch did not report reads "not measured".'),
    bar, table);
  return root;
}

/** The toolbar again (mode switch swaps the day/month control); the table and the search stay. */
function rebuild() {
  const old = root;
  const keep = table;
  const kids = pickerSlot ? [...pickerSlot.childNodes] : [];
  const node = build();
  if (kids.length) mount(pickerSlot, ...kids);
  table = keep;
  node.replaceChild(keep, node.querySelector('#hv-table'));
  if (old && old.parentNode) old.replaceWith(node);
  const q = node.querySelector('#hv-q');
  if (q) q.value = v.q;
}

/** @param ctx {cluster, picker} — the page's one cluster, and its chooser when there are several. */
export function hostsSection({ cluster, picker }) {
  if (!root || v.clusterId !== cluster.id) {
    clearTimeout(timer);
    v.clusterId = cluster.id; v.offset = 0; v.data = null; v.state = 'idle'; v.seq++;
    build();
  }
  // The page builds its cluster chooser afresh each redraw; put in only when it reads differently,
  // so an open chooser is not closed by a push from the core.
  const pick = picker || h('b.hv-cl', cluster.name);
  if (pickerSlot && (pickerSlot.childNodes.length !== 1 || markupSig(pickerSlot.firstChild) !== markupSig(pick))) mount(pickerSlot, pick);
  if (v.state === 'idle') { v.state = 'loading'; setTimeout(fetchRows, 0); }
  paintTable();
  return root;
}
