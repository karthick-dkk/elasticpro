/**
 * Reports › Measure size (docs/REPORTS.md, board 9): what the indices take on disk (index
 * store size, `priBytes`) against what the documents say they carry (event_logsize,
 * `eventBytes`), per cluster and day by day. The only place index store size appears on
 * Reports.
 *
 * Figures: core/volume-daily.js measureSize (index size averaged over the period's days;
 * event_logsize per day is perDayEventBytes, the one rate) and sizeDifference. The button
 * sends VOLUME_RUN for the clusters shown — the same request as Collect now; nothing new.
 */

import { h } from '../lib/dom.js';
import { bytes, num, ago, toCsv, download } from '../lib/fmt.js';
import { card } from '../pages/common.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { toast } from '../ui/menu.js';
import { measureSize, MEASURE_PERIODS, shortDay, utcDay } from '../core/volume-daily.js';
import { recordOf, recordEntry, recordState, runCollection, lastRunOf } from './record.js';
import { amber, muted, loading } from './cells.js';

const ui = { period: 'last7', picked: null };
let redraw = () => {};

const periodNow = () => MEASURE_PERIODS.find((p) => p.id === ui.period) || MEASURE_PERIODS[0];
const NOT_IN_MAPPING = 'not measured · field not in mapping';

/** "+12.0 GB" / "−3.1 GB": the sign carries the meaning (index bigger, or smaller). */
function signed(v) {
  if (v === null || v === undefined) return muted('—');
  return h(`span.${v >= 0 ? 'vs-up' : 'vs-dn'}`, `${v >= 0 ? '+' : '−'}${bytes(Math.abs(v))}`);
}
const ratioText = (r) => (r === null || r === undefined ? null : `${r.toFixed(2)} ×`);

/** Two thin bars, the larger of the two the full width: blue index size, orange event_logsize. */
function compared(index, event) {
  const top = Math.max(index || 0, event || 0);
  if (!(top > 0)) return muted('—');
  const w = (v) => `${v ? Math.max(1, Math.round((v / top) * 100)) : 0}%`;
  return h('span.rp-cmp', { role: 'img', 'aria-label': `index ${index === null ? 'not measured' : bytes(index)}, event_logsize ${event === null ? 'not measured' : bytes(event)}` },
    h('i.ix', { style: { width: w(index) } }), h('i.ev', { style: { width: w(event) } }));
}

function clusterRow(c, m, picked) {
  const ent = recordEntry(c.id);
  const waiting = !m && (!ent || ent.loading);
  const select = () => { ui.picked = c.id; redraw(); };
  if (!m) {
    return h('tr', { class: picked ? 'on' : null },
      h('td', h('button.linkish', { type: 'button', onclick: select }, h('b', c.name))),
      h('td.num', waiting ? loading() : amber('not measured', ent && ent.error ? `The daily record could not be read: ${ent.error}` : 'No daily record')),
      h('td.num', waiting ? loading() : muted('—')), h('td.num', muted('—')), h('td.num', muted('—')), h('td', ''));
  }
  return h('tr', { class: picked ? 'on' : null },
    h('td', h('button.linkish', { type: 'button', onclick: select, 'aria-pressed': picked ? 'true' : 'false' }, h('b', c.name))),
    h('td.num', m.indexPerDay === null ? amber('not measured', 'No day in the period reports an index size (days split by the time field have none)') : bytes(m.indexPerDay)),
    h('td.num', m.eventPerDay === null ? amber(m.eventField ? 'not measured' : NOT_IN_MAPPING) : bytes(m.eventPerDay)),
    h('td.num', signed(m.diff)),
    h('td.num', ratioText(m.ratio) || muted('—')),
    h('td', compared(m.indexPerDay, m.eventPerDay)));
}

function dayRows(m) {
  return DAY_SORT.apply(m.rows, DAY_COLS).map((d) => h('tr',
    h('td', shortDay(d.day)),
    h('td.num', d.indices === null ? muted('—') : num(d.indices)),
    h('td.num', d.index === null ? amber('not measured') : bytes(d.index)),
    h('td.num', d.event === null ? amber(NOT_IN_MAPPING) : bytes(d.event)),
    h('td.num', signed(d.diff)),
    h('td.num', ratioText(d.ratio) || muted('—')),
    h('td', compared(d.index, d.event))));
}

const TH = (label, num, title) => h(`th${num ? '.num' : ''}`, { title: title || null, scope: 'col' }, label);
/** A head that sorts (lib/table-sort.js): `sort` the table's tableSort(), `key` its column. */
const STH = (sort, key, label, num, title) => sortTh(sort, key, label, { num: !!num, attrs: { scope: 'col' }, title: title ? `${title} — click to sort` : null });

// Per cluster opens in the order the clusters are picked in; day by day oldest first, as the record lists it.
const CLUSTER_SORT = tableSort('reports.measure.clusters', { onChange: () => redraw() });
const DAY_SORT = tableSort('reports.measure.days', { onChange: () => redraw() });
const CLUSTER_COLS = {
  cluster: { type: 'text', value: (x) => x.c.name },
  index: { type: 'bytes', value: (x) => (x.m ? x.m.indexPerDay : null) },
  event: { type: 'bytes', value: (x) => (x.m ? x.m.eventPerDay : null) },
  diff: { type: 'number', value: (x) => (x.m ? x.m.diff : null) },
  ratio: { type: 'number', value: (x) => (x.m ? x.m.ratio : null) },
};
const DAY_COLS = {
  day: { type: 'date', value: (d) => d.day },
  indices: { type: 'number', value: (d) => d.indices },
  index: { type: 'bytes', value: (d) => d.index },
  event: { type: 'bytes', value: (d) => d.event },
  diff: { type: 'number', value: (d) => d.diff },
  ratio: { type: 'number', value: (d) => d.ratio },
};

/** The per cluster figures as CSV (the Measure size table). */
function exportMeasure(clusters, p) {
  const rows = clusters.map((c) => {
    const r = recordOf(c.id);
    const m = r ? measureSize(r, p.days) : null;
    const gb = (v) => (typeof v === 'number' ? Math.round((v / 1024 ** 3) * 100) / 100 : null);
    return { cluster: c.name, period: p.label, index_size_per_day_gb: m ? gb(m.indexPerDay) : null,
      event_logsize_per_day_gb: m ? gb(m.eventPerDay) : null, difference_gb: m ? gb(m.diff) : null,
      ratio: m && m.ratio !== null ? Math.round(m.ratio * 100) / 100 : null };
  });
  download(`reports-measure-size-${utcDay()}.csv`, toCsv(rows), 'text/csv');
}

/** @param ctx { clusters, redraw } */
export function measureSection(ctx) {
  redraw = ctx.redraw || redraw;
  const p = periodNow();
  const ids = ctx.clusters.map((c) => c.id);
  const figures = new Map(ctx.clusters.map((c) => {
    const r = recordOf(c.id);
    return [c.id, r ? measureSize(r, p.days) : null];
  }));
  if (!ui.picked || !ids.includes(ui.picked)) ui.picked = ids[0] || null;
  const picked = ctx.clusters.find((c) => c.id === ui.picked) || null;
  const pm = picked ? figures.get(picked.id) : null;
  const last = lastRunOf(ids);
  const running = !!recordState.polling;

  const sel = h('select#rp-measure-period', { onchange: (e) => { ui.period = e.target.value; redraw(); } },
    ...MEASURE_PERIODS.map((x) => h('option', { value: x.id }, x.label)));
  sel.value = p.id;

  const measure = h('button#rp-measure.btn.sm.primary', {
    type: 'button', disabled: running || !ids.length,
    title: 'Collect the daily record of the clusters shown now (the same as Collect now)',
    onclick: async () => {
      const res = await runCollection(ids);
      if (!res.ok) { toast(res.message, res.level || 'err', 6000); return; }
      // Too soon, unreachable, the stop, already collecting: said plainly (reports/collect.js runAnswer).
      const said = (res.lines || []).filter((l) => l.level === 'warn');
      if (said.length) toast(said.map((l) => l.text).join(' '), 'warn', 6000, { key: 'rp-collect' });
    },
  }, running ? 'Measuring…' : '↻ Measure size');

  return h('div.rp-section',
    h('div.toolbar.rp-bar',
      h('label.field', 'Period', sel),
      h('span.muted.rp-when', last ? `measured ${ago(last)}` : 'not measured yet'),
      h('div.vs-right',
        h('div.legend.rp-legend', h('span', h('i.ix'), 'index size'), h('span', h('i.ev'), 'event_logsize')),
        h('button.btn.sm', { type: 'button', onclick: () => exportMeasure(ctx.clusters, p) }, 'Export CSV'),
        measure)),
    card('Per cluster', `average per day over the period · ${p.label.toLowerCase()} · click a cluster for its days below`,
      h('div.tbl-wrap', h('table.tbl.rp-measure-tbl',
        h('thead', h('tr', STH(CLUSTER_SORT, 'cluster', 'Cluster'), STH(CLUSTER_SORT, 'index', 'Index size per day', true, 'Primary store size of each day\'s indices (_cat/indices), averaged'),
          STH(CLUSTER_SORT, 'event', 'event_logsize per day', true, 'Sum of event_logsize inside the same days\' documents, averaged'),
          STH(CLUSTER_SORT, 'diff', 'Difference', true, 'Index size minus event_logsize'), STH(CLUSTER_SORT, 'ratio', 'Ratio', true, 'Index size ÷ event_logsize'), TH('Compared'))),
        h('tbody', ...CLUSTER_SORT.apply(ctx.clusters.map((c) => ({ c, m: figures.get(c.id) })), CLUSTER_COLS)
          .map(({ c, m }) => clusterRow(c, m, c.id === ui.picked)))))),
    picked ? card(`${picked.name} · day by day`, p.label.toLowerCase(),
      pm && pm.rows.length
        ? h('div.tbl-wrap', h('table.tbl',
          h('thead', h('tr', STH(DAY_SORT, 'day', 'Day'), STH(DAY_SORT, 'indices', 'Indices', true), STH(DAY_SORT, 'index', 'Index size', true),
            STH(DAY_SORT, 'event', 'event_logsize', true), STH(DAY_SORT, 'diff', 'Difference', true), STH(DAY_SORT, 'ratio', 'Ratio', true), TH('Compared'))),
          h('tbody', ...dayRows(pm))))
        : h('div.tbl-empty', pm ? 'No day recorded in this period.' : 'Reading the daily record…')) : null);
}
