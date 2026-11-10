/**
 * The Reports tables that a person arranges (Overview › By cluster, Capacity › Storage plan):
 * drawn from the column layout (lib/columns.js), with an optional group band over the
 * headers, and written to CSV in exactly the columns on screen (docs/REPORTS.md: "CSV
 * follows the columns on screen").
 *
 * A def: `{ key, label, num?, locked?, hidden?, group?, title?, cell(row) → Node|string,
 * csv(row) → string|number|null, csvLabel?, sortType?, sortValue(row)?, sort? }`.
 *
 * Sorting (lib/table-sort.js): pass `sort` (a tableSort()) and the rows already in its order —
 * `sort.apply(rows, layoutSortCols(defs))`, after any filter — so the CSV, written from the
 * same rows, comes out in the order on screen. A column sorts on `sortValue(row)` when it has
 * one, else on its CSV value (the figure, not the text drawn), as `sortType` (default `number`
 * for a numeric column, `text` otherwise); `sort: false` leaves a column unsortable.
 */

import { h } from '../lib/dom.js';
import { visibleColumns, groupBand } from '../lib/columns.js';
import { sortTh } from '../lib/table-sort.js';

/** The sort columns of a layout table, for tableSort().apply — every def, shown or not. */
export function layoutSortCols(defs) {
  const out = {};
  for (const d of defs) {
    if (d.sort === false || (!d.sortValue && !d.csv)) continue;
    out[d.key] = { type: d.sortType || (d.num ? 'number' : 'text'), value: d.sortValue || d.csv, start: d.sortStart || 1 };
  }
  return out;
}

export function layoutTable({ defs, layout, rows, band = false, rowAttrs = null, emptyText = 'Nothing to show', cls = '', sort = null }) {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const cols = visibleColumns(defs, layout).map((c) => ({ ...c, def: byKey.get(c.key) }));
  const runs = band ? groupBand(defs, layout) : null;
  // A divider where a group starts, down every row, so the band reads as a heading of its columns.
  const starts = new Set();
  if (runs) runs.reduce((at, r) => { if (r.group && at > 0) starts.add(at); return at + r.span; }, 0);
  const head = [];
  if (runs && runs.some((r) => r.group)) {
    let at = 0;
    head.push(h('tr.rp-band', ...runs.map((r) => {
      const th = h(`th${r.group ? '.rp-grp' : ''}${starts.has(at) ? '.rp-gl' : ''}`, { colspan: r.span, scope: 'colgroup' }, r.group || '');
      at += r.span;
      return th;
    })));
  }
  const sortable = sort ? layoutSortCols(defs) : {};
  head.push(h('tr', ...cols.map((c, i) => (sortable[c.key]
    ? sortTh(sort, c.key, c.name, { num: !!c.num, cls: starts.has(i) ? 'rp-gl' : null, attrs: { dataset: { col: c.key }, scope: 'col' }, title: c.def.title ? `${c.def.title} — click to sort` : null })
    : h(`th${c.num ? '.num' : ''}${starts.has(i) ? '.rp-gl' : ''}`,
      { dataset: { col: c.key }, title: c.def.title || c.name, scope: 'col' }, c.name)))));
  const body = h('tbody', ...rows.map((r) => h('tr', rowAttrs ? rowAttrs(r) : null,
    ...cols.map((c, i) => {
      const v = c.def.cell(r);
      return h(`td${c.num ? '.num' : ''}${starts.has(i) ? '.rp-gl' : ''}`, { dataset: { col: c.key } }, v === null || v === undefined ? '' : v);
    }))));
  if (!rows.length) body.append(h('tr', h('td', { colspan: cols.length }, h('div.tbl-empty', emptyText))));
  return h(`div.tbl-wrap.rp-tbl${cls ? `.${cls}` : ''}`, h('table.tbl', h('thead', ...head), body));
}

/** The table as CSV rows: the columns on screen, in their order, under the names on screen. */
export function layoutCsv(defs, layout, rows) {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const cols = visibleColumns(defs, layout).map((c) => ({ ...c, def: byKey.get(c.key) }));
  const label = (c) => (c.def.csvLabel ? c.def.csvLabel(c.name) : c.name);
  const headers = cols.map(label);
  return {
    headers,
    rows: rows.map((r) => {
      const o = {};
      cols.forEach((c, i) => {
        const v = c.def.csv ? c.def.csv(r) : null;
        o[headers[i]] = v === undefined ? null : v;
      });
      return o;
    }),
  };
}
