/**
 * Reports › Overview (docs/REPORTS.md, board 1): the fleet, one line per cluster.
 *
 * Sizes: event_logsize from each cluster's daily record (core/volume-daily.js —
 * fleetEventTotals for the tiles, eventYesterday / perDayEventBytes / eventVsAvgPct /
 * eventMonthSoFar per row). Disk: data nodes only (core/volume.js dataNodeDisk). Fits /
 * short by: core/volume.js storagePlanRow, the same row the Storage plan draws.
 */

import { h } from '../lib/dom.js';
import { bytes, num, toCsv, download, downloadBytes, plural } from '../lib/fmt.js';
import { card, statTile, empty } from '../pages/common.js';
import { utcDay, addDays, shortDay, eventBytesOf, eventYesterday, eventVsAvgPct, eventMonthSoFar, fleetEventTotals, recordEmptyWhy, NEEDS_VERSION } from '../core/volume-daily.js';
import { workbook, XLSX_MIME } from '../lib/xlsx.js';
import { clusterFigures, recordEntry, recordState, RATE_DAYS } from './record.js';
import { layoutOf, setLocalLayout, layoutNote, canShare, shareWhy, shareLayout } from './layouts.js';
import { layoutTable, layoutCsv, layoutSortCols } from './table.js';
import { tableSort } from '../lib/table-sort.js';
import { columnsMenu } from '../lib/columns.js';
import { amber, muted, tag, loading, sizeOr, change, changeText, daysText, runwayLevel, gbCell } from './cells.js';

const TABLE = 'overview';
const PILL = { red: 'red', yellow: 'yellow', green: 'green' };

/** One line per cluster: the figures every column reads. */
function rowOf(c) {
  const f = clusterFigures(c);
  const ent = recordEntry(c.id);
  const today = utcDay();
  const y = f.record ? eventYesterday(f.record, { today }) : null;
  return {
    ...f,
    waiting: !f.record && (!ent || ent.loading),
    recordError: ent && ent.error ? ent.error : null,
    // Why there is no event_logsize to show for it (unknown is not zero): one definition with Daily.
    why: f.record ? recordEmptyWhy(f.record, { event: true }) : null,
    yesterday: y ? y.value : null,
    vsAvg: f.record ? eventVsAvgPct(f.record, y.day, RATE_DAYS, { today }) : null,
    month: f.record ? eventMonthSoFar(f.record, { today }) : null,
  };
}

/** Why a cluster's line has no figure, in one sentence: what the record says, else what it could be. */
const whyText = (r) => (r.recordError ? `The daily record could not be read: ${r.recordError}`
  : r.why ? `${r.why.reason} ${r.why.detail}` : 'No event_logsize in the record: the field is not in the mapping, or nothing was collected yet.');
const unknownSize = (r) => (r.waiting ? loading() : amber('not measured', whyText(r)));
const size = (r, v) => (typeof v === 'number' ? bytes(v) : unknownSize(r));

function liveFit(r) {
  const p = r.plan;
  if (p.liveWhy === 'not set') return { text: 'not set', node: amber('not set', 'Set liveRetention on the cluster (Edit cluster › Live retention)') };
  if (p.liveShortfall === null) return { text: 'not measured', node: r.waiting ? loading() : amber('not measured', p.liveWhy === 'disk not measured' ? r.disk.reason : 'No event_logsize per day yet') };
  if (p.liveShortfall > 0) return { text: `short by ${bytes(p.liveShortfall)}`, node: tag(`short by ${bytes(p.liveShortfall)}`, 'red') };
  return { text: 'fits', node: tag('fits', 'green') };
}

function backupFit(r) {
  const p = r.plan;
  if (p.ulm) return { text: 'ULM · S3', node: tag('ULM · S3', 'grey', r.kind.ulm.bucket ? `Archived to S3 by ULM (bucket ${r.kind.ulm.bucket})` : 'Archived to S3 by ULM') };
  if (p.backupWhy === 'not set') return { text: 'not set', node: amber('not set', 'Set snapshotRetention on the cluster') };
  if (p.backupWhy === 'no capacity') return { text: 'not measured', node: amber('not measured', 'Set backupCapacity on the cluster: Elasticsearch cannot say how big a repository is') };
  if (p.backupShortfall === null) return { text: 'not measured', node: r.waiting ? loading() : amber('not measured') };
  if (p.backupShortfall > 0) return { text: 'does not fit', node: tag('does not fit', 'red', `short by ${bytes(p.backupShortfall)}`) };
  return { text: 'fits', node: tag('fits', 'green') };
}

/** The By cluster columns. Keys are what the shared layout (VOLUME_LAYOUT_SET table `overview`) stores. */
export function overviewDefs(openDaily) {
  return [
    { key: 'cluster', label: 'Cluster', locked: true, cell: (r) => h('b', r.cluster.name), csv: (r) => r.cluster.name },
    { key: 'type', label: 'Type', cell: (r) => tag(r.kind.label), csv: (r) => r.kind.label },
    { key: 'yesterday', label: 'Yesterday', num: true, title: 'event_logsize yesterday', cell: (r) => size(r, r.yesterday), csv: (r) => gbCell(r.yesterday), csvLabel: (n) => `${n} (GB)` },
    { key: 'avg7', label: `${RATE_DAYS}-day avg`, num: true, title: `event_logsize per day, mean of the last ${RATE_DAYS} finished days`, cell: (r) => size(r, r.perDay), csv: (r) => gbCell(r.perDay), csvLabel: (n) => `${n} (GB)` },
    { key: 'vsAvg', label: 'vs avg', num: true, title: `Yesterday against the ${RATE_DAYS} days before it`, cell: (r) => change(r.vsAvg), csv: (r) => changeText(r.vsAvg), csvLabel: (n) => `${n} (%)` },
    { key: 'monthSoFar', label: 'Month so far', num: true, title: 'event_logsize of this month\'s finished days',
      cell: (r) => (r.month && r.month.days === 0 ? muted('—', 'No finished day this month yet') : size(r, r.month ? r.month.value : null)),
      csv: (r) => gbCell(r.month ? r.month.value : null), csvLabel: (n) => `${n} (GB)` },
    { key: 'diskUsed', label: 'Data-node disk used', num: true, title: 'Disk on data nodes only, used of total',
      cell: (r) => (r.disk.measured ? h('span', { title: `${bytes(r.disk.used)} of ${bytes(r.disk.total)} on ${plural(r.disk.nodes, 'data node')}` }, `${r.disk.percent.toFixed(1)} %`) : amber('not measured', r.disk.reason)),
      csv: (r) => (r.disk.measured ? Math.round(r.disk.percent * 10) / 10 : null), csvLabel: (n) => `${n} (%)` },
    { key: 'diskLasts', label: 'Disk lasts', num: true, title: `Free data-node disk ÷ event_logsize per day (${RATE_DAYS}-day average)`,
      cell: (r) => (r.lasts === null ? (r.waiting ? loading() : amber('not measured', !r.disk.measured ? r.disk.reason : 'No event_logsize per day yet'))
        : tag(daysText(r.lasts), PILL[runwayLevel(r.lasts)])),
      csv: (r) => (r.lasts === null ? null : Math.floor(r.lasts)), csvLabel: (n) => `${n} (days)` },
    { key: 'liveRetention', label: 'Live retention', cell: (r) => liveFit(r).node, csv: (r) => liveFit(r).text },
    { key: 'backups', label: 'Backups', cell: (r) => backupFit(r).node, csv: (r) => backupFit(r).text },
    { key: 'daily', label: 'Daily record', title: 'Open this cluster\'s daily record',
      cell: (r) => h('button.linkish', { type: 'button', onclick: () => openDaily(r.cluster.id), 'aria-label': `Daily record of ${r.cluster.name}` }, 'Daily ›'),
      csv: () => null, sort: false },
  ];
}

/** Keys of the By cluster table, in their default order: what the core must accept for `overview`. */
export const OVERVIEW_KEYS = overviewDefs(() => {}).map((d) => d.key);

/* ------------------------------------- tiles ------------------------------------- */

function tiles(rows) {
  const t = fleetEventTotals(rows.map((r) => r.record).filter(Boolean));
  const within6 = rows.filter((r) => r.lasts !== null && r.lasts < 42);
  const within2 = within6.filter((r) => r.lasts < 14);
  const noFit = rows.filter((r) => !r.plan.ulm && r.plan.backupShortfall > 0);
  const noCap = rows.filter((r) => !r.plan.ulm && r.plan.backupWhy === 'no capacity');
  const v = (x) => (x === null ? amber('not measured', 'No cluster has event_logsize in its record for these days') : bytes(x));
  const range = t.monthDays ? `${t.monthDays === 1 ? shortDay(t.monthFrom) : `${Number(t.monthFrom.slice(8, 10))}–${shortDay(t.monthTo)}`} · ${plural(t.monthDays, 'day')}` : 'no finished day this month yet';
  return h('div.grid.c5.rp-tiles',
    statTile('Ingested yesterday', v(t.yesterday),
      t.vsAvgPct === null ? `event_logsize · ${plural(t.yesterdayN, 'cluster')}` : h('span', change(t.vsAvgPct), ` vs ${RATE_DAYS}-day average`)),
    statTile(`${RATE_DAYS}-day daily average`, v(t.avg), `event_logsize, ${t.avgN === rows.length ? 'all clusters' : `${t.avgN} of ${plural(rows.length, 'cluster')}`}`),
    statTile('Month so far', t.monthDays ? v(t.month) : muted('—'), range),
    h(`div.stat${within2.length ? '.bad' : ''}`, h('div.k', 'Disk runs out within 6 weeks'),
      h(`div.v${within6.length && !within2.length ? '.rp-warn' : ''}`, plural(within6.length, 'cluster')),
      h('div.d', `data-node disk · ${num(within2.length)} within 2 weeks`)),
    statTile('Backups that do not fit', num(noFit.length),
      noCap.length ? h('span', amber(`${num(noCap.length)} not measured`), ' · set backupCapacity') : 'every repository with a capacity'));
}

/* ------------------------------------- charts ------------------------------------- */

const STACK = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
const DAYS = 30;

/** Stacked bars of event_logsize per day, the five biggest clusters and the rest. */
function dailyVolume(rows) {
  const today = utcDay();
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, -(DAYS - i)));
  const per = rows.filter((r) => r.record).map((r) => {
    const by = new Map((r.record.days || []).map((d) => [d.day, eventBytesOf(d)]));
    const vals = days.map((d) => by.get(d) ?? null);
    return { name: r.cluster.name, vals, sum: vals.reduce((a, x) => a + (x || 0), 0) };
  }).filter((s) => s.sum > 0).sort((a, b) => b.sum - a.sum);
  if (!per.length) return noVolume(rows);
  const top = per.slice(0, 5);
  const rest = per.slice(5);
  const series = [...top.map((s, i) => ({ ...s, color: STACK[i] })),
    ...(rest.length ? [{ name: `${plural(rest.length, 'other')}`, color: 'var(--border-strong)', vals: days.map((_, i) => rest.reduce((a, s) => a + (s.vals[i] || 0), 0)) }] : [])];
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.vals[i] || 0), 0));
  const max = Math.max(1, ...totals);
  const cols = days.map((d, i) => h('div.rp-col', { title: `${shortDay(d)} · ${series.some((s) => s.vals[i] !== null && s.vals[i] !== undefined) ? bytes(totals[i]) : 'not measured'}` },
    ...series.map((s) => (s.vals[i] ? h('i', { style: { height: `${(s.vals[i] / max) * 100}%`, background: s.color }, title: `${s.name} · ${shortDay(d)} · ${bytes(s.vals[i])}` }) : null))));
  const ticks = [0, 7, 14, 21, DAYS - 1].map((i) => h('span', shortDay(days[i])));
  return h('div',
    h('div.rp-cols', { role: 'img', 'aria-label': `Stacked event_logsize per day for the last ${DAYS} days; highest day ${bytes(max)}` }, ...cols),
    h('div.rp-axis', ...ticks),
    h('div.legend', ...series.map((s) => h('span', h('i', { style: { background: s.color } }), s.name))));
}

/**
 * No event_logsize in the last 30 days: why, per cluster (core/volume-daily.js recordEmptyWhy),
 * not a bare "nothing". One cluster shown: its reason. Several: the first three, by name.
 */
function noVolume(rows) {
  const generic = 'The daily record fills this in once a day; Collect now on Daily & monthly asks for it at once.';
  if (rows.some((r) => r.waiting)) return empty('Reading the daily record…');
  const said = rows.map((r) => ({ name: r.cluster.name, text: r.recordError ? `the daily record could not be read: ${r.recordError}` : r.why ? r.why.reason : null, why: r.why }))
    .filter((x) => x.text);
  if (rows.length === 1 && said.length === 1) {
    return empty(said[0].why ? said[0].why.reason : 'The daily record could not be read.', { detail: said[0].why ? said[0].why.detail : said[0].text });
  }
  if (!said.length) return empty(`No ${rows.length === 1 ? '' : 'cluster has '}event_logsize recorded for the last 30 days.`, { detail: generic });
  const shown = said.slice(0, 3).map((x) => `${x.name}: ${x.text}`).join(' · ');
  return empty('No event_logsize recorded for the last 30 days.', { detail: `${shown}${said.length > 3 ? ` · and ${plural(said.length - 3, 'more cluster')}` : ''}` });
}

/** Free data-node disk at each cluster's 7-day rate, soonest first. */
function runway(rows) {
  const sorted = [...rows].sort((a, b) => (a.lasts === null) - (b.lasts === null) || (a.lasts ?? 0) - (b.lasts ?? 0));
  const shown = sorted.slice(0, 12);
  // Chart colours (owner rule: never red with yellow): pink, orange, light green.
  const color = { red: 'var(--chart-bad)', yellow: 'var(--chart-warn)', green: 'var(--chart-good)', na: 'var(--border-strong)' };
  const items = shown.map((r) => {
    const lvl = runwayLevel(r.lasts);
    const w = r.lasts === null ? 100 : Math.max(2, Math.min(100, (r.lasts / 140) * 100));
    return h('div.rp-hb',
      h('span.nm', { title: r.cluster.name }, r.cluster.name),
      h('span.rp-hbt', h('i', { style: { width: `${w}%`, background: color[lvl] } })),
      h('span.n', r.lasts === null ? amber('not measured', !r.disk.measured ? r.disk.reason : 'No event_logsize per day yet') : daysText(r.lasts)));
  });
  return h('div',
    ...items,
    sorted.length > shown.length ? h('div.muted.rp-more', `and ${plural(sorted.length - shown.length, 'more cluster')}, further out`) : null,
    h('div.legend',
      h('span', h('i', { style: { background: color.red } }), 'under 2 weeks'),
      h('span', h('i', { style: { background: color.yellow } }), 'under 6 weeks'),
      h('span', h('i', { style: { background: color.green } }), 'comfortable'),
      h('span', h('i', { style: { background: color.na } }), 'not measured')));
}

/* ------------------------------------- section ------------------------------------- */

let menuState = null;
let menuBtn = null;

/**
 * @param ctx { clusters, redraw, openDaily(id), goSection(id) }
 */
export function overviewSection(ctx) {
  const defs = overviewDefs(ctx.openDaily);
  // The clusters in the order the header asks for (none: the order they are picked in).
  const rows = tableSort('reports.overview', { onChange: ctx.redraw }).apply(ctx.clusters.map(rowOf), layoutSortCols(defs));
  const layout = layoutOf(TABLE);
  if (!menuState) {
    menuState = { defs, layout, id: 'rp-cols-overview',
      onChange: (next) => setLocalLayout(TABLE, menuState.defs, next),
      onSave: (l) => shareLayout(TABLE, menuState.defs, l) };
  }
  Object.assign(menuState, { defs, layout, note: layoutNote(TABLE), canSave: canShare(TABLE), saveWhy: shareWhy(TABLE) });
  const banner = recordState.unsupported
    ? h('div.banner.warn', h('div', h('div.ttl', 'This server does not keep a daily volume record yet'),
      h('div', `Sizes need ElasticPro ${NEEDS_VERSION} or later on the server; they read "not measured" until then.`)))
    : recordState.noStore
      ? h('div.banner.warn', h('div', h('div.ttl', 'This server keeps no daily volume record'),
        h('div', 'It was started without a data directory. Set ELASTICPRO_DATA_DIR (the hosted image sets /app/data) and restart it.')))
      : null;
  return h('div.rp-section',
    banner,
    tiles(rows),
    h('div.grid.c2',
      card('Daily volume', `event_logsize per day · top 5 clusters + the rest`, dailyVolume(rows),
        [h('button.linkish', { type: 'button', onclick: () => ctx.goSection('daily') }, 'Open daily ›')]),
      card('How long the free disk lasts', `data nodes only · at each cluster's ${RATE_DAYS}-day rate`, runway(rows),
        [h('button.linkish', { type: 'button', onclick: () => ctx.goSection('capacity') }, 'Capacity ›')])),
    card('By cluster', `${plural(rows.length, 'cluster')} · one line each`,
      layoutTable({ defs, layout, rows, emptyText: 'No cluster is selected', sort: tableSort('reports.overview') }),
      [menuBtn || (menuBtn = columnsMenu(menuState)),
        h('button#rp-overview-csv.btn.sm', { type: 'button', onclick: () => exportOverview(defs, layout, rows) }, 'Export CSV')]));
}

export function overviewCsv(ctx) {
  const rows = ctx.clusters.map(rowOf);
  const defs = overviewDefs(() => {});
  return layoutCsv(defs, layoutOf(TABLE), rows);
}

function exportOverview(defs, layout, rows) {
  const { headers, rows: out } = layoutCsv(defs, layout, rows);
  download(`reports-overview-${utcDay()}.csv`, toCsv(out, headers), 'text/csv');
}

/** The same lines as an .xlsx (Exports › Fleet overview). */
export function exportOverviewXlsx(ctx) {
  const { headers, rows } = overviewCsv(ctx);
  const bytesOut = workbook([{ name: 'Fleet overview', rows: [headers, ...rows.map((o) => headers.map((k) => o[k]))] }]);
  downloadBytes(`reports-overview-${utcDay()}.xlsx`, bytesOut, XLSX_MIME);
}

export function exportOverviewCsv(ctx) {
  const { headers, rows } = overviewCsv(ctx);
  download(`reports-overview-${utcDay()}.csv`, toCsv(rows, headers), 'text/csv');
}
