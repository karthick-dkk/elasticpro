/**
 * Reports › Log delay (0.3.57, docs/LOGDELAY.md): the fleet, one cluster, one device and the
 * recommended fixes — boards Main, Cluster, Device and Fix. Everything shown is the core's
 * built-in store, read with LOGDELAY_*; the arithmetic and the routes are core/logdelay-report.js.
 *
 * Unknown is not zero: a device that is silent or whose delay cannot be read says so, a day
 * without totals is a gap in a chart, and a cluster never measured says "never measured".
 * Charts use light green, blue, pink and orange only.
 */

import { h, svg } from '../lib/dom.js';
import { card, empty } from '../pages/common.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { clusters } from '../core/state.js';
import { navigateTo } from '../core/intent.js';
import { refreshReports } from '../core/reports.js';
import { rememberLevels } from '../core/delay-levels.js';
import {
  LD_COLOURS as C, ldSummary, ldCluster, ldDevice, ldSearch, ldFixes, ldReportRun, ldRoute, ldHash,
  PERIODS, periodQuery, periodDays, minutesText, durationText, whenText, dayText, docsText, pctText, countText,
  stateText, stateTone, nowText, startedSolvedText, byTimeLate, filterRows, ringsOrder, ringDash, dayBars, dayTitle,
  sparkSegments, reducedBars, deviceGraph, periodBand, lateSplitText, STEP_TONE, stepLabel, evidenceText,
} from '../core/logdelay-report.js';

const PAGE_ROWS = 50;

/** What the section keeps between draws: the choices made and the answers read. */
const S = {
  ver: 0,
  period: 'last30',
  clusterPick: 'all',
  devFilter: '', devAll: false,
  cdFilter: '', cdAll: false,
  fixFilter: '', fixAll: false,
  q: { name: '', field: '', value: '', cluster: '', from: '', to: '' },
  qFor: '',
  range: null,           // {from, to} the device page was narrowed to by Show
  search: null,          // {state, res}
  cache: new Map(),      // key → {state: 'loading'|'ok'|'error', res}
};
let redraw = () => {};
let last = { key: '', node: null };

export function logDelayReset() {
  S.cache.clear(); S.search = null; S.range = null; S.devFilter = ''; S.cdFilter = ''; S.fixFilter = '';
  S.devAll = false; S.cdAll = false; S.fixAll = false; S.ver += 1; last = { key: '', node: null };
}

const bump = () => { S.ver += 1; redraw(); };

/* ------------------------------ the tables' column sort ------------------------------ */

/** A head row from `[key | null, label, num]`: a key sorts with `sort` (lib/table-sort.js). */
const sortHead = (sort, cols) => h('thead', h('tr', ...cols.map(([key, label, num]) => (key ? sortTh(sort, key, label, { num: !!num }) : h(num ? 'th.num' : 'th', label)))));
/** Each table's order: none remembered, the order the page gives (worst first, newest first). */
const sorts = {
  clusters: tableSort('logdelay.clusters', { onChange: bump }),
  devices: tableSort('logdelay.devices', { onChange: bump }),
  clusterDevices: tableSort('logdelay.cluster-devices', { onChange: bump }),
  periods: tableSort('logdelay.periods', { onChange: bump }),
  fixDevices: tableSort('logdelay.fix-devices', { onChange: bump }),
  rules: tableSort('logdelay.rules', { onChange: bump }),
};
/** How bad a state is, for sorting "Now": worst highest; can't measure is unknown. */
const STATE_RANK = { critical: 5, delay: 4, clock_ahead: 3, silent: 2, little: 1, no_delay: 0 };
const stateRank = (s) => (s in STATE_RANK ? STATE_RANK[s] : null);
/** When the last delay (or silence) began: what "Last delay: started → solved" sorts on. */
const lastDelayAt = (r) => (r.state === 'silent' && finite(r.silentSince) ? r.silentSince : finite(r.lateSince) ? r.lateSince : finite(r.lastStarted) ? r.lastStarted : null);
/** The device tables' columns (core/sort.js), on the figures rather than the text. */
const deviceCols = (extras = []) => ({
  device: { type: 'text', value: (r) => r.device },
  cluster: { type: 'text', value: (r) => r.clusterName || nameOf(r.cluster) },
  state: { type: 'number', value: (r) => stateRank(r.state), start: -1 },
  now: { type: 'number', value: (r) => r.nowMinutes },
  median: { type: 'number', value: (r) => r.medianMinutes },
  max: { type: 'number', value: (r) => r.maxMinutes },
  episodes: { type: 'number', value: (r) => r.episodes },
  lateMs: { type: 'duration', value: (r) => r.lateMs },
  last: { type: 'date', value: lastDelayAt },
  docs: { type: 'number', value: (r) => r.docsPerDay },
  arrival: { type: 'date', value: (r) => r.lastArrival },
  event: { type: 'date', value: (r) => r.lastEvent },
  ...Object.fromEntries(extras.map((x) => [`x:${x}`, { type: 'text', value: (r) => (r.extras ? r.extras[x] : null) }])),
});

/** Read `key` once with `fn`; the answer redraws the section. */
function need(key, fn) {
  const hit = S.cache.get(key);
  if (hit) return hit;
  const ent = { state: 'loading', res: null };
  S.cache.set(key, ent);
  Promise.resolve().then(fn).then((res) => {
    ent.res = res;
    ent.state = res && res.ok ? 'ok' : 'error';
    if (res && res.ok) rememberLevels(res);
    bump();
  }, (e) => { ent.state = 'error'; ent.res = { ok: false, message: e.message || String(e) }; bump(); });
  return ent;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nameOf = (id) => { const c = clusters().find((x) => x.id === id); return c ? c.name : id; };

/* --------------------------------- small pieces --------------------------------- */

const pillOf = (state, text) => h(`span.pill.ld-pill.${stateTone(state)}`, h('i.dot'), text || stateText(state));
const link = (href, text, o = {}) => h('a', { href, title: o.title || null, class: o.cls || null }, text);
const deviceHref = (r) => ldHash('device', r.cluster, r.device);
const clusterHref = (id) => ldHash('cluster', id);
const crumbs = (...parts) => h('div.ld-crumbs', ...parts.filter(Boolean).flatMap((p, i) => (i ? [' › ', p] : [p])));
const kpi = (value, label, o = {}) => h(`div.ld-kpi${o.wide ? '.ld-wide' : ''}`, { dataset: o.key ? { kpi: o.key } : null },
  h(`b${o.tone ? `.ld-${o.tone}` : ''}`, value), ...(Array.isArray(label) ? label : [h('span', label)]));
const key = (colour, text) => h('span.ld-key', h('i', { style: { background: colour } }), text);
const legend = (...k) => h('span.ld-legend', ...k);
const footer = (...kids) => h('div.ld-foot', ...kids);

function problem(ent, what) {
  if (ent.state === 'loading') return h('div.tbl-empty', `Reading ${what}…`);
  const r = ent.res || {};
  if (r.unsupported) return h('div.banner.warn', r.message);
  if (r.kind === 'no_store') return h('div.banner.warn', 'The log delay report needs ElasticPro’s data directory, and this server has none.');
  if (r.kind === 'not_found') return empty(`${what} is not in the store.`, { detail: r.message || 'A device not seen for 7 days is forgotten.' });
  return h('div.banner.err', `${what} could not be read: ${r.message || r.kind || 'no answer'}`);
}

/** The band names on the cluster's levels: "Below 30 min", "30–60 min", "Above 60 min". */
function bands(levels) {
  const l = levels || {};
  const a = finite(l.delayFrom) ? l.delayFrom : null; const b = finite(l.criticalOver) ? l.criticalOver : null;
  return {
    below: a === null ? 'On time' : `Below ${a} min`,
    mid: a === null || b === null ? 'Delayed' : `${a}–${b} min`,
    high: b === null ? 'Critical' : `Above ${b} min`,
    late: a === null ? 'late' : `${a} minutes or more`,
  };
}

/** The levels every cluster in a summary shares, or null when they differ (then each cluster's own). */
function sharedLevels(byCluster) {
  const ls = (byCluster || []).map((c) => c.levels).filter(Boolean);
  if (!ls.length) return null;
  const k = (l) => `${l.noDelayUnder}|${l.delayFrom}|${l.criticalOver}`;
  return ls.every((l) => k(l) === k(ls[0])) ? ls[0] : null;
}

function periodSelect(id) {
  const s = h(`select#${id}`, { 'aria-label': 'Period', onchange: (e) => { S.period = e.target.value; S.range = null; bump(); } },
    ...PERIODS.map(([v, label]) => h('option', { value: v }, label)));
  s.value = S.period;
  return h('label.ld-inline', 'Period', s);
}

async function exportXlsx(btn, clusterIds, res) {
  btn.disabled = true;
  const r = await ldReportRun({ clusterIds, period: res && res.from ? { from: res.from, to: res.to } : 'last7', mail: false });
  btn.disabled = false;
  if (r && r.ok) { toast('The log delay report is building: Reports › Exports & schedules has it when it is done.', 'ok', 6000); refreshReports(); }
  else toast(`Not started: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 6000);
}

async function mailNow(btn, clusterIds, res) {
  const yes = await confirmDialog('Mail the log delay report now?',
    `It goes to the log delay schedule’s recipients, covering ${(res && res.label) || 'the period shown'}, with its .xlsx and .csv.`, { yes: 'Mail now' });
  if (!yes) return;
  btn.disabled = true;
  const r = await ldReportRun({ clusterIds, period: res && res.from ? { from: res.from, to: res.to } : 'yesterday', mail: true });
  btn.disabled = false;
  if (r && r.ok) { toast('The log delay report is being built and mailed.', 'ok', 6000); refreshReports(); }
  else toast(`Not sent: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 6000);
}

/* ------------------------------------ charts ------------------------------------ */

/** Day-by-day stacked bars with five date labels. `withOk` adds on time and silent/can't measure. */
function dayChart(days, { height = 160, withOk = true, label = 'Devices per day' } = {}) {
  const list = days || [];
  const bars = dayBars(list, height, { withOk });
  const seg = (px, colour, kind) => (px ? h('i', { dataset: { seg: kind }, style: { height: `${px}px`, background: colour } }) : null);
  const late = list.filter((d) => d && finite(d.devices) && d.devices > 0).map((d) => (d.delayed || 0) + (d.critical || 0));
  const aria = late.length ? `${label}: between ${Math.min(...late)} and ${Math.max(...late)} late` : `${label}: no day measured`;
  const ticks = list.length ? [0, 0.25, 0.5, 0.75, 1].map((f) => list[Math.round(f * (list.length - 1))]).map((d) => dayText(d && d.day)) : [];
  return h('div.ld-chart',
    h('div.ld-days', { role: 'img', 'aria-label': aria, style: { height: `${height}px` } },
      ...bars.map((b, i) => h(`span.ld-day${b.gap ? '.ld-gap' : ''}`, { title: dayTitle(list[i]) },
        seg(b.ok, C.green, 'ok'), seg(b.unk, C.orange, 'unknown'), seg(b.del, C.blue, 'delayed'), seg(b.crit, C.pink, 'critical')))),
    h('div.ld-ticks', ...ticks.map((t) => h('span', t))));
}

function sparkline(values, title, href) {
  const segs = sparkSegments(values, 120, 24);
  const pic = svg('svg', { width: 120, height: 24, viewBox: '0 0 120 24', role: 'img', 'aria-label': title },
    ...segs.map((p) => svg('polyline', { points: p, fill: 'none', stroke: C.line, 'stroke-width': 1.6 })));
  return segs.length ? h('a.ld-spark', { href, title }, pic) : h('span.muted', { title: 'no day measured' }, 'not measured');
}

function ring(late, devices, { title, href, name, all = false }) {
  const { dash, share } = ringDash(late, devices);
  const circle = (stroke, extra = {}) => svg('circle', { cx: 21, cy: 21, r: 15.915, fill: 'none', stroke, 'stroke-width': 5, ...extra });
  return h(`a.ld-ring${all ? '.ld-all' : ''}`, { href, title },
    h('span.ld-ring-pic',
      svg('svg', { width: 104, height: 104, viewBox: '0 0 42 42', role: 'img', 'aria-label': title },
        circle(share === null ? 'var(--surface-3)' : C.green),
        share ? circle(C.pink, { 'stroke-dasharray': dash, 'stroke-linecap': 'round' }) : null),
      h('span.ld-ring-mid', h('b', share === null ? '—' : pctText(share * 100)), h('span', share === null ? 'not measured' : 'delayed'))),
    h('span.ld-ring-name', name),
    h('span.ld-ring-sub', finite(late) && finite(devices) ? [h('b', countText(late)), ` of ${countText(devices)} devices`] : 'never measured'));
}

/* ------------------------------------ the fleet ------------------------------------ */

function fleetView() {
  const ids = S.clusterPick === 'all' ? [] : [S.clusterPick];
  const q = periodQuery(S.period);
  const ent = need(`sum|${S.period}|${ids.join(',')}`, () => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000 }));
  const res = ent.state === 'ok' ? ent.res : null;
  const all = clusters();
  const pick = h('select#ld-clusters', { 'aria-label': 'Clusters', onchange: (e) => { S.clusterPick = e.target.value; S.devAll = false; bump(); } },
    h('option', { value: 'all' }, `All ${all.length}`), ...all.map((c) => h('option', { value: c.id }, c.name)));
  pick.value = S.clusterPick;
  const lv = res ? sharedLevels(res.byCluster) : null;
  const b = bands(lv);
  const every = res && finite(res.everyHours) ? res.everyHours : null;
  const exportBtn = h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, ids, res) }, 'Export .xlsx');
  const mailBtn = h('button.btn.primary#ld-mail', { type: 'button', disabled: !res, onclick: (e) => mailNow(e.currentTarget, ids, res) }, 'Mail now…');
  const head = h('div.ld-head',
    h('div.ld-title',
      h('h2', 'Log delay'),
      h('p.sub', 'Every device that sends logs: how late it is, when each delay started and when it was solved. ',
        every ? `Measured on the server every ${every} hour${every === 1 ? '' : 's'}; ` : 'Measured on the server on a timer; ',
        lv ? `late means ${b.late}.` : 'late means each cluster’s own delay level.')),
    h('div.ld-actions', periodSelect('ld-period'), h('label.ld-inline', 'Clusters', pick),
      link(ldHash('fixes', S.clusterPick === 'all' ? null : S.clusterPick), 'Recommended fixes ›', { cls: 'btn' }), exportBtn, mailBtn));
  if (!res) return h('div.rp-section.ld', { dataset: { ld: 'fleet' } }, head, problem(ent, 'The log delay summary'));

  const t = res.totals || {};
  const red = reducedBars(res.reduced, 44);
  const reducedTitle = red.map((r) => `${r.n === null ? 'unknown' : r.n} in the last ${r.label}`).join(', ');
  const tiles = h('div.ld-kpis.ld-6',
    kpi(countText(t.devices), 'total devices', { key: 'devices' }),
    kpi(countText(t.late), `devices with delay now · ${lateSplitText(t)}`, { tone: t.late ? 'pink' : null, key: 'late' }),
    kpi(countText(t.onTime), `devices with no delay · ${pctText(t.pctOnTime)} on time`, { tone: 'green', key: 'onTime' }),
    kpi(pctText(t.pctOnTime), [h('span', 'without delay'),
      h('span.ld-small', h('span.ld-pink', `${pctText(t.pctLate)} delayed`), ` · ${pctText(t.pctSilent)} silent`,
        finite(t.unmeasured) && t.unmeasured ? ` · ${pctText(t.pctUnmeasured)} can’t measure` : '')], { tone: 'green', key: 'pct' }),
    h('div.ld-kpi.ld-wide', { dataset: { kpi: 'reduced' } },
      h('span', `Delay reduced · devices back under ${lv ? `${lv.delayFrom} min` : 'their delay level'} in the last`),
      h('div.ld-reduced', { role: 'img', 'aria-label': `Devices back on time: ${reducedTitle}` },
        ...red.map((r) => h('span.ld-red', { title: `${r.n === null ? 'not known' : r.n} devices back under the delay level in the last ${r.label}` },
          h('b', r.n === null ? '—' : String(r.n)), h('i', { style: { height: `${r.px}px`, background: C.green } })))),
      h('div.ld-red-labels', ...red.map((r) => h('span', r.label)))));

  const never = (res.byCluster || []).filter((c) => c.lastRunAt === null || c.lastRunAt === undefined);
  const notice = !res.schedule || res.schedule.supported === false
    ? h('div.banner.warn', 'This server does not run the scheduled measurement (hosted edition only): nothing new is measured.')
    : res.schedule.enabled === false
      ? h('div.banner.warn', 'The scheduled measurement is switched off; the figures stop at its last run. ',
        h('button.linkish', { type: 'button', onclick: () => navigateTo('settings', { section: 'schedule' }) }, 'Config-Management › Data › Scheduled log delay'))
      : null;

  const dayCard = card('Day by day', null, dayChart(res.days, { height: 160, label: 'Devices per day' }),
    [legend(key(C.green, 'On time'), key(C.blue, b.mid), key(C.pink, b.high), key(C.orange, 'Silent or can’t measure'))]);

  const rings = ringsOrder(res.byCluster);
  const ringCard = card('Delayed devices by cluster', `share of each cluster’s devices delayed ${b.late}, now · worst first · a cluster opens its details`,
    h('div.ld-rings',
      ring(t.late, t.devices, { all: true, name: 'All clusters', href: ldHash('fleet'),
        title: `All clusters: ${t.late ?? '?'} of ${t.devices ?? '?'} devices delayed` }),
      ...rings.map((c) => ring(c.lateNow, c.lastRunAt === null ? null : c.devices, {
        name: c.name || nameOf(c.id), href: clusterHref(c.id),
        title: c.lastRunAt === null ? `${c.name}: never measured` : `${c.name}: ${c.lateNow} of ${c.devices} devices delayed (${pctText(c.latePct)})`,
      }))),
    [legend(key(C.pink, `Delayed (${b.late})`), key(C.green, b.below))]);

  const n = periodDays(res.from, res.to) || 30;
  // A cluster never measured has no figures: unknown, so it sorts last either way.
  const seen = (f) => (c) => (c.lastRunAt === null || c.lastRunAt === undefined ? null : f(c));
  const cl = sorts.clusters.apply(res.byCluster || [], {
    name: { type: 'text', value: (c) => c.name || nameOf(c.id) },
    devices: { type: 'number', value: (c) => c.devices },
    lateNow: { type: 'number', value: seen((c) => c.lateNow) },
    newToday: { type: 'number', value: seen((c) => c.newToday) },
    below: { type: 'number', value: seen((c) => c.below) },
    delay: { type: 'number', value: seen((c) => c.delay) },
    critical: { type: 'number', value: seen((c) => c.critical) },
    previous: { type: 'percent', value: seen((c) => c.belowPctPrevious) },
    worst: { type: 'number', value: seen((c) => (c.worst && c.worst.device ? c.worst.minutes : null)) },
  }).map((c) => {
    const cb = bands(c.levels);
    const neverRun = c.lastRunAt === null || c.lastRunAt === undefined;
    return h('tr', { dataset: { cluster: c.id } },
      h('td', link(clusterHref(c.id), c.name || nameOf(c.id), { title: `${c.name} · log delay details` })),
      h('td.num', countText(c.devices)),
      neverRun ? h('td', { colspan: 8 }, h('span.muted', 'never measured: not in the scheduled measurement yet'))
        : [h(`td.num${c.lateNow ? '.ld-pink' : ''}`, countText(c.lateNow)),
          h(`td.num${c.newToday ? '.ld-pink' : ''}`, { title: `devices that reached ${cb.late} today and were not late before` }, countText(c.newToday)),
          h('td.num', { title: `devices under ${cb.late} now` }, `${countText(c.below)} · ${pctText(c.belowPct)}`),
          h(`td.num${c.delay ? '.ld-blue' : ''}`, countText(c.delay)),
          h(`td.num${c.critical ? '.ld-pink' : ''}`, countText(c.critical)),
          h('td.num', pctText(c.belowPctPrevious)),
          h('td', sparkline(c.sparkline, `${c.name}: late devices per day over ${n} days`, clusterHref(c.id))),
          h('td.mono', c.worst && c.worst.device
            ? [link(ldHash('device', c.id, c.worst.device), c.worst.device, { title: `${c.worst.device} · delay details` }), h('span.muted', ` ${minutesText(c.worst.minutes)}`)]
            : h('span.muted', '—'))]);
  });
  const clusterCard = card('By cluster', `${b.below.toLowerCase()} = devices under ${b.late} of delay now, and their share in the ${n} days before · a cluster name or its line opens the cluster`,
    h('div.tbl-wrap', h('table.tbl.ld-ctr#ld-by-cluster',
      sortHead(sorts.clusters, [['name', 'Cluster'], ['devices', 'Devices', 1], ['lateNow', 'Late now', 1], ['newToday', 'Today', 1], ['below', b.below, 1],
        ['delay', b.mid, 1], ['critical', b.high, 1], ['previous', `${b.below}, previous ${n} days`, 1], [null, `Last ${n} days`], ['worst', 'Worst device']]),
      h('tbody', ...(cl.length ? cl : [h('tr', h('td', { colspan: 10 }, empty('No cluster you can see is measured.')))])))));

  const devCard = devicesCard(res.devices, { total: res.devicesTotal, truncated: res.devicesTruncated, now: res.now });
  return h('div.rp-section.ld', { dataset: { ld: 'fleet' } }, head, notice, tiles, dayCard, ringCard, clusterCard, devCard,
    never.length && never.length < (res.byCluster || []).length ? h('div.muted.ld-note', `${never.length} cluster${never.length === 1 ? ' is' : 's are'} not measured yet: ${never.map((c) => c.name).join(', ')}.`) : null);
}

function devicesCard(rows, { total, truncated, now }) {
  // Filter, then the header's order (time spent late until one is chosen), then the page.
  const sorted = sorts.devices.apply(byTimeLate(filterRows(rows, S.devFilter)), deviceCols());
  const shown = S.devAll ? sorted : sorted.slice(0, PAGE_ROWS);
  const filter = h('input#ld-dev-filter', { type: 'search', placeholder: 'Filter devices', 'aria-label': 'Filter devices', value: S.devFilter,
    oninput: (e) => { S.devFilter = e.target.value; bump(); } });
  const body = shown.map((r) => h('tr', { dataset: { device: r.device, cluster: r.cluster } },
    h('td.mono', link(deviceHref(r), r.device, { title: `${r.device} · delay over time and every delay` })),
    h('td', link(clusterHref(r.cluster), r.clusterName || nameOf(r.cluster), { title: `${r.clusterName || r.cluster} · log delay details` })),
    h('td', pillOf(r.state)),
    h('td.num', nowText(r)), h('td.num', minutesText(r.maxMinutes)), h('td.num', countText(r.episodes)),
    h('td.num', durationText(r.lateMs)), h('td', startedSolvedText(r, now)), h('td.num', docsText(r.docsPerDay)),
    h('td', link(deviceHref(r), 'Graph ›'))));
  return card('Devices', `${countText(total ?? (rows || []).length)} · ${sorts.devices.sort ? 'sorted by the marked column' : 'sorted by time spent late'}`,
    [h('div.tbl-wrap', h('table.tbl#ld-devices',
      sortHead(sorts.devices, [['device', 'Device'], ['cluster', 'Cluster'], ['state', 'Now'], ['now', 'Delay now', 1], ['max', 'Max', 1], ['episodes', 'Delays', 1],
        ['lateMs', 'Time late', 1], ['last', 'Last delay: started → solved'], ['docs', 'Logs a day', 1], [null, 'Graph']]),
      h('tbody', ...(body.length ? body : [h('tr', h('td', { colspan: 10 }, empty(S.devFilter ? 'No device matches the filter.' : 'No device measured in this period.')))])))),
    footer(`Showing ${countText(shown.length)} of ${countText(sorted.length)}`,
      sorted.length > shown.length ? [' · ', h('button.linkish#ld-dev-all', { type: 'button', onclick: () => { S.devAll = true; bump(); } }, 'Show all')] : null,
      truncated ? ` · the server sent the first ${countText((rows || []).length)} of ${countText(total)}` : null)],
    [filter]);
}

/* ------------------------------------ one cluster ------------------------------------ */

function clusterKey(id, q) { return `cl|${id}|${JSON.stringify(q)}`; }

function clusterView(id) {
  const q = periodQuery(S.period);
  const ent = need(clusterKey(id, q), () => ldCluster({ clusterId: id, ...q }));
  const res = ent.state === 'ok' ? ent.res : null;
  const name = (res && res.name) || nameOf(id);
  const exportBtn = h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, [id], res) }, 'Export .xlsx');
  const lv = res && res.levels; const b = bands(lv);
  const head = h('div.ld-head',
    h('div.ld-title',
      crumbs(link(ldHash('fleet'), 'Reports › Log delay'), 'cluster'),
      h('h2', name, h('span.ld-h-sub', ` · ${(res && res.label) || PERIODS.find((p) => p[0] === S.period)[1].toLowerCase()}`)),
      h('p.sub', `Every device in this cluster that sends logs, day by day. Late means ${b.late}.`)),
    h('div.ld-actions', periodSelect('ld-period'), link(ldHash('fixes', id), 'Recommended fixes ›', { cls: 'btn' }), exportBtn));
  if (!res) return h('div.rp-section.ld', { dataset: { ld: 'cluster' } }, head, problem(ent, `${name}’s log delay`));
  const t = res.totals || {};
  const n = periodDays(res.from, res.to) || 30;
  const tiles = h('div.ld-kpis.ld-5',
    kpi(countText(t.devices), 'devices measured', { key: 'devices' }),
    kpi(countText(t.late), `late now · ${countText(t.delay)} delayed, ${countText(t.critical)} critical`, { tone: t.late ? 'pink' : null, key: 'late' }),
    kpi(pctText(t.pctOnTime), 'on time now', { tone: 'green', key: 'pct' }),
    kpi(countText(res.started), `delays started · ${countText(res.solved)} solved`, { key: 'started' }),
    kpi(minutesText(res.medianNow, 'not measured'), `median delay · ${minutesText(res.medianPrevious, 'not measured')} in the previous ${n} days`, { key: 'median' }));
  const never = res.lastRunAt === null || res.lastRunAt === undefined;
  const dayCard = card('Day by day', 'late devices at the end of each day', dayChart(res.days, { height: 150, withOk: false, label: `Late devices per day in ${name}` }),
    [legend(key(C.blue, b.mid), key(C.pink, b.high))]);

  const f = res.fields || {};
  const extras = Array.isArray(f.extras) ? f.extras : [];
  const arrival = f.arrival || 'arrival';
  const event = (Array.isArray(f.eventTime) && f.eventTime[0]) || 'event time';
  const sorted = sorts.clusterDevices.apply(byTimeLate(filterRows(res.devices, S.cdFilter)), deviceCols(extras));
  const shown = S.cdAll ? sorted : sorted.slice(0, PAGE_ROWS);
  const rows = shown.map((r) => h('tr', { dataset: { device: r.device } },
    h('td.mono', link(deviceHref({ ...r, cluster: r.cluster || id }), r.device)),
    h('td', pillOf(r.state)), h('td.num', nowText(r)), h('td.num', minutesText(r.medianMinutes)), h('td.num', minutesText(r.maxMinutes)),
    h('td.num', countText(r.episodes)), h('td.num', durationText(r.lateMs)), h('td', startedSolvedText(r, res.now)),
    ...extras.map((x) => { const v = r.extras ? r.extras[x] : null; return h('td', v === null || v === undefined || v === '' ? h('span.muted', '—') : String(v)); }),
    h('td.mono', whenText(r.lastArrival, res.now, { seconds: true })), h('td.mono', whenText(r.lastEvent, res.now, { seconds: true }))));
  const heads = [['device', 'Device'], ['state', 'Now'], ['now', 'Delay now', 1], ['median', 'Median', 1], ['max', 'Max', 1], ['episodes', 'Delays', 1], ['lateMs', 'Time late', 1],
    ['last', 'Last delay: started → solved'], ...extras.map((x) => [`x:${x}`, x]), ['arrival', arrival], ['event', event]];
  const filter = h('input#ld-cd-filter', { type: 'search', placeholder: 'Filter devices', 'aria-label': 'Filter devices', value: S.cdFilter,
    oninput: (e) => { S.cdFilter = e.target.value; bump(); } });
  const devCard = card('Devices in this cluster', `${countText((res.devices || []).length)} · ${sorts.clusterDevices.sort ? 'sorted by the marked column' : 'sorted by time spent late'} · a device opens its delay details`,
    [h('div.tbl-wrap', h('table.tbl#ld-cluster-devices',
      sortHead(sorts.clusterDevices, heads),
      h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: heads.length }, empty(S.cdFilter ? 'No device matches the filter.' : 'No device measured in this period.')))])))),
    footer(`ECS fields from the device’s latest log: ${[...extras, `${arrival} (arrival)`, `${event} (event time)`].join(', ')} · delay = ${arrival} − ${event}`
      + (f.device ? ` · device field ${f.device}` : '') + (f.pattern ? ` · indices ${f.pattern}` : ''),
      ` · Showing ${countText(shown.length)} of ${countText(sorted.length)}`,
      sorted.length > shown.length ? [' · ', h('button.linkish#ld-cd-all', { type: 'button', onclick: () => { S.cdAll = true; bump(); } }, 'Show all')] : null)],
    [filter]);
  return h('div.rp-section.ld', { dataset: { ld: 'cluster' } }, head,
    never ? h('div.banner.warn', `${name} has never been measured: it is not in the scheduled measurement yet.`) : null,
    tiles, dayCard, devCard);
}

/* ------------------------------------ one device ------------------------------------ */

function deviceQuery() {
  return S.range ? { from: S.range.from, to: S.range.to } : periodQuery(S.period);
}

function deviceView(clusterId, device) {
  const q = deviceQuery();
  const ent = need(`dev|${clusterId}|${device}|${JSON.stringify(q)}`, () => ldDevice({ clusterId, device, ...q }));
  const cent = need(clusterKey(clusterId, periodQuery(S.period)), () => ldCluster({ clusterId, ...periodQuery(S.period) }));
  const res = ent.state === 'ok' ? ent.res : null;
  const cres = cent.state === 'ok' ? cent.res : null;
  const f = (cres && cres.fields) || {};
  const devField = String(f.device || 'src_hostname').replace(/\.keyword$/, '');
  const every = res && finite(res.everyHours) ? res.everyHours : null;
  const cname = (res && res.clusterName) || nameOf(clusterId);
  const late = res && (res.state === 'delay' || res.state === 'critical');
  const head = h('div.ld-head',
    h('div.ld-title',
      crumbs(link(ldHash('fleet'), 'Reports › Log delay'), link(clusterHref(clusterId), cname)),
      h('h2.ld-dev-h', h('span.mono', device),
        res ? pillOf(res.state, late && finite(res.lateSince) ? `${stateText(res.state)} · late since ${whenText(res.lateSince, res.now).replace(/^today /, '')}`
          : res.state === 'silent' && finite(res.silentSince) ? `silent · no logs since ${whenText(res.silentSince, res.now)}` : stateText(res.state)) : null),
      h('p.sub', [`Device field ${devField}`, `arrival ${f.arrival || '@timestamp'}`,
        `event time ${Array.isArray(f.eventTime) && f.eventTime.length ? f.eventTime.join(' / ') : 'not known'}`,
        every ? `measured every ${every} hour${every === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))),
    h('div.ld-actions', S.range ? h('span.muted.ld-range', `${S.range.from} → ${S.range.to}`) : periodSelect('ld-period'),
      h('button.btn#ld-open-logs', { type: 'button', onclick: () => navigateTo('logs', null, { cluster: clusterId }) }, 'Open its logs ›')));

  const bar = searchBar(clusterId, device, devField, f.extras || [], res);
  if (!res) return h('div.rp-section.ld', { dataset: { ld: 'device' } }, head, bar, problem(ent, device));

  const lv = res.levels || {};
  const tiles = h('div.ld-kpis.ld-6',
    kpi(res.state === 'unmeasured' ? 'can’t measure' : res.state === 'silent' ? 'silent' : minutesText(res.nowMinutes), 'delay now', { tone: late ? 'pink' : null, key: 'now' }),
    kpi(minutesText(res.medianMinutes), 'median', { key: 'median' }),
    kpi(minutesText(res.worst && res.worst.minutes), `worst · ${res.worst && finite(res.worst.at) ? whenText(res.worst.at, res.now) : 'not known'}`, { key: 'worst' }),
    kpi(countText(res.episodes), `delays · ${countText(res.solved)} solved`, { key: 'episodes' }),
    kpi(durationText(res.lateMs), `time late · ${pctText(res.latePct)} of the period`, { key: 'lateMs' }),
    kpi(docsText(res.docsPerDay), `logs a day · ${finite(res.lastSilence) ? `${whenText(res.lastSilence, res.now)} last silence` : 'no silence'}`, { key: 'docs' }));

  const fnd = res.finding;
  const rec = h('section.card.ld-rec#ld-recommendation',
    h('header', h('h2', 'Recommendation'),
      fnd ? h(`span.pill.ld-pill.${STEP_TONE[fnd.step] || 'grey'}`, h('i.dot'), stepLabel(fnd)) : null,
      h('span.sub', fnd ? 'likely · from the delay pattern' : 'nothing matched'),
      h('div', { style: { marginLeft: 'auto' } }, link(ldHash('fixes', clusterId), 'All recommendations ›'))),
    h('div.body.ld-rec-body', fnd
      ? [h('div', h('b', fnd.step === 'unknown' ? 'Not known yet: ' : 'Why: '), fnd.why || '—'),
        fnd.fix ? h('div', h('b', 'Fix: '), fnd.fix) : null,
        fnd.group ? h('div.muted', `Group: ${fnd.group[0]} ${fnd.group[1]}${Array.isArray(fnd.devices) && fnd.devices.length > 1 ? ` · ${fnd.devices.length} devices` : ''}`) : null,
        evidenceText(fnd.evidence) ? h('div.muted', `Evidence: ${evidenceText(fnd.evidence)}`) : null,
        Array.isArray(fnd.missing) && fnd.missing.length ? h('div.muted', `Would decide it: ${fnd.missing.join(', ')}`) : null]
      : h('div.muted', 'No recommendation: this device was not late in the stored delay periods of the last 7 days, or no rule matched yet.')));

  return h('div.rp-section.ld', { dataset: { ld: 'device' } }, head, bar, tiles, rec,
    graphCard(res, lv, every), clustersCard(res), periodsCard(res, every));
}

function searchBar(clusterId, device, devField, extras, res) {
  if (S.qFor !== `${clusterId}|${device}`) {
    S.qFor = `${clusterId}|${device}`;
    S.q = { name: device, field: devField, value: '', cluster: clusterId,
      from: (S.range && S.range.from) || (res && res.from) || '', to: (S.range && S.range.to) || (res && res.to) || '' };
    S.search = null;
  }
  if (!S.q.from && res) { S.q.from = res.from; S.q.to = res.to; }
  const set = (k) => (e) => { S.q[k] = e.target.value; };
  const inp = (id, k, o = {}) => h(`input#${id}`, { type: o.type || 'search', value: S.q[k] || '', placeholder: o.ph || null, oninput: set(k), onchange: set(k), dataset: { untracked: '' } });
  const fields = [...new Set([devField, 'src_hostname', 'src_device', ...extras].filter(Boolean))];
  const fieldSel = h('select#ld-q-field', { onchange: set('field') }, ...fields.map((x) => h('option', { value: x }, x)));
  fieldSel.value = S.q.field || devField;
  const all = clusters();
  const clSel = h('select#ld-q-cluster', { onchange: set('cluster') }, h('option', { value: '' }, 'All clusters'), ...all.map((c) => h('option', { value: c.id }, c.name)));
  clSel.value = S.q.cluster || '';
  const show = async () => {
    const q = { ...S.q };
    if (q.from && q.to && q.from > q.to) { toast('From must be on or before To', 'warn'); return; }
    if (q.from && q.to) S.range = { from: q.from, to: q.to };
    S.search = { state: 'loading', res: null };
    bump();
    const r = await ldSearch({ name: q.name || undefined, field: q.value ? q.field : undefined, value: q.value || undefined,
      clusterIds: q.cluster ? [q.cluster] : [], from: q.from || undefined, to: q.to || undefined, max: 50 });
    S.search = { state: r && r.ok ? 'ok' : 'error', res: r };
    const m = r && r.ok ? r.devices || [] : [];
    if (m.length === 1 && (m[0].device !== device || m[0].cluster !== clusterId)) location.hash = deviceHref(m[0]);
    bump();
  };
  let found = null;
  if (S.search) {
    const r = S.search.res;
    found = S.search.state === 'loading' ? h('span.muted', 'Searching…')
      : S.search.state === 'error' ? h('span.ld-pink', `Search failed: ${(r && (r.message || r.kind)) || 'no answer'}`)
        : h('span.muted#ld-matches', `Matches ${countText(r.matches ?? (r.devices || []).length)} device${(r.matches ?? (r.devices || []).length) === 1 ? '' : 's'}`,
          ...(r.devices || []).slice(0, 12).flatMap((d) => [' · ', link(deviceHref(d), d.device, { title: `${d.device} on ${d.clusterName || d.cluster}` })]),
          r.truncated ? ' · more not shown: narrow the search' : '');
  }
  const lab = (text, node) => h('label.ld-q', text, node);
  return h('section.card.ld-search', { 'aria-label': 'Find a device', dataset: { untracked: '' } },
    h('form.ld-q-row', { onsubmit: (e) => { e.preventDefault(); show(); } },
      lab('Device name', inp('ld-q-name', 'name')),
      lab('Search by', fieldSel),
      lab('Value', inp('ld-q-value', 'value', { ph: 'e.g. fw-dc1-*' })),
      lab('Cluster', clSel),
      lab('From', inp('ld-q-from', 'from', { type: 'date' })),
      lab('To', inp('ld-q-to', 'to', { type: 'date' })),
      h('button.btn.primary#ld-q-show', { type: 'submit' }, 'Show'),
      found));
}

function graphCard(res, lv, every) {
  const lo = Date.parse(`${res.from}T00:00:00`); const hi = Math.min(Date.parse(`${res.to}T23:59:59`), res.now || Date.now());
  const H = 220;
  const g = deviceGraph(res.points, { fromMs: lo, toMs: hi, height: H, levels: lv });
  const y = (m) => g.Y(m);
  const line = (m, colour) => (finite(m) && m <= g.scaleMax ? h('div.ld-hline', { style: { top: `${y(m)}px`, borderTopColor: colour } }) : null);
  const bandsEls = (res.periods || []).map((p) => {
    const b = periodBand(p, g.lo, g.hi, res.now);
    if (!b) return null;
    return h('div.ld-band', { title: `${whenText(p.started, res.now)} → ${p.solved ? whenText(p.solved, res.now) : 'still late'}, worst ${minutesText(p.worstMinutes)}`,
      style: { left: `${b.left}%`, width: `${b.width}%`, background: b.critical ? 'rgba(242,167,195,.38)' : 'rgba(169,200,240,.38)' } });
  });
  const unknown = (res.points || []).filter((p) => p && !finite(p.m) && finite(p.t));
  const pic = svg('svg', { viewBox: `0 0 1000 ${H}`, preserveAspectRatio: 'none', role: 'img', class: 'ld-graph-svg',
    'aria-label': `Delay of ${res.device} over the period: ${(res.points || []).length} measurements, ${(res.periods || []).length} delays, worst ${minutesText(res.worst && res.worst.minutes)}` },
  ...g.segments.map((p) => svg('polyline', { points: p, fill: 'none', stroke: C.line, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' })),
  ...unknown.map((p) => svg('rect', { x: g.X(p.t) - 2, y: H - 6, width: 4, height: 6, fill: C.orange })));
  const marks = [];
  for (const p of res.periods || []) {
    if (finite(p.started) && p.started >= g.lo) marks.push(h('span.ld-mark', { title: `delay started ${whenText(p.started, res.now)}`, style: { left: `calc(${((p.started - g.lo) / (g.hi - g.lo || 1)) * 100}% - 5px)`, color: '#6f9fe0' } }, '▲'));
    if (finite(p.solved)) marks.push(h('span.ld-mark', { title: `solved ${whenText(p.solved, res.now)}`, style: { left: `calc(${((p.solved - g.lo) / (g.hi - g.lo || 1)) * 100}% - 4px)`, color: '#5fae5f' } }, '●'));
    else marks.push(h('span.ld-mark', { title: 'still late', style: { left: 'calc(100% - 10px)', color: '#e17aa3' } }, '◆'));
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => new Date(g.lo + f * (g.hi - g.lo))).map((d) => `${d.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]}`);
  const ins = res.insights || {};
  const cell = (label, value, sub) => h('div.ld-ins', h('div.muted', label), h('b', value), sub ? h('span', ` ${sub}`) : null);
  const scale = [[g.scaleMax, `${g.scaleMax} min`], [lv.criticalOver, String(lv.criticalOver)], [lv.delayFrom, String(lv.delayFrom)], [0, '0']]
    .filter(([m]) => finite(m) && m <= g.scaleMax);
  return card('Delay over time', `each point is one ${every ? `${every}-hour ` : ''}measurement · shaded bands are delays, from start to solve`,
    [h('div.ld-graph',
      h('div.ld-yaxis', { style: { height: `${H}px` } }, ...scale.map(([m, t]) => h('span', { style: { top: `${y(m) - 7}px` } }, t))),
      h('div.ld-plot#ld-graph', { style: { height: `${H}px` } }, ...bandsEls, line(lv.criticalOver, C.pink), line(lv.delayFrom, C.blue), pic)),
    h('div.ld-marks', { 'aria-label': 'Delay starts and solves' }, ...marks),
    h('div.ld-ticks.ld-indent', ...ticks.map((t) => h('span', t))),
    h('div.muted.ld-indent.ld-tiny', '▲ delay started · ● solved · ◆ still late · ', h('i.ld-sq', { style: { background: C.orange } }), ' silent or can’t measure (no dot, never 0 min)'),
    h('div.ld-insights',
      cell('Peak', minutesText(ins.peak && ins.peak.minutes, 'not known'), ins.peak && finite(ins.peak.at) ? whenText(ins.peak.at, res.now) : null),
      cell('Average delay', minutesText(ins.average && ins.average.minutes, 'not known'), ins.average ? `over ${countText(ins.average.measurements)} measurements` : null),
      cell('Longest delay', ins.longest ? durationText(ins.longest.lastedMs) : 'not known', ins.longest && finite(ins.longest.started) ? `${whenText(ins.longest.started, res.now)} → ${finite(ins.longest.solved) ? whenText(ins.longest.solved, res.now) : 'still late'}` : null),
      cell('Solved in, on average', ins.solvedIn ? durationText(ins.solvedIn.averageMs) : 'not known', ins.solvedIn ? `${countText(ins.solvedIn.solved)} delays solved` : 'no delay solved yet'),
      cell('Late most often', ins.lateMostOften ? ins.lateMostOften.label : 'not known', ins.lateMostOften ? `${ins.lateMostOften.count} of ${ins.lateMostOften.of} delays began then` : null))],
    [legend(key(C.line, 'Delay'), key(C.blue, `${lv.delayFrom ?? '?'} min`), key(C.pink, `${lv.criticalOver ?? '?'} min`))]);
}

function clustersCard(res) {
  const list = res.clusters || [];
  if (!list.length) return null;
  const max = Math.max(1, ...list.flatMap((c) => (c.sparkline || []).filter(finite)));
  return card('Delay by cluster', 'late devices per day · same scale for every cluster · a cluster opens its details',
    h('div.ld-minis', ...list.map((c) => h('a.ld-mini', { href: clusterHref(c.id), title: `${c.name}: late devices per day, peak ${c.peak ?? '?'}` },
      h('span.ld-mini-h', h('b', c.name || nameOf(c.id)), h('span', `${countText(c.lateNow)} late now`)),
      h('span.ld-mini-bars', ...(c.sparkline || []).map((v, i) => h(`i${finite(v) ? '' : '.ld-gap'}`,
        { title: `${dayText((c.days || [])[i])}: ${finite(v) ? `${v} late` : 'no measurement'}`, style: { height: `${finite(v) ? Math.max(v ? 2 : 0, Math.round((v / max) * 56)) : 0}px`, background: C.pink } }))),
      h('span.muted', c.peak ? `peak ${c.peak} on ${dayText(c.peakDay)}` : 'no late day')))),
    [legend(key(C.pink, 'late devices'))]);
}

function periodsCard(res, every) {
  const rows = sorts.periods.apply((res.periods || []).slice().sort((a, b) => (b.started || 0) - (a.started || 0)), {
    started: { type: 'date', value: (p) => p.started },
    solved: { type: 'date', value: (p) => p.solved },
    lasted: { type: 'duration', value: (p) => p.lastedMs },
    worst: { type: 'number', value: (p) => p.worstMinutes },
    state: { type: 'number', value: (p) => stateRank(p.worstState), start: -1 },
    pattern: { type: 'text', value: (p) => p.pattern },
    measurements: { type: 'number', value: (p) => p.measurements },
  }).map((p) => h(`tr${p.solved ? '' : '.ld-open'}`,
    h('td', whenText(p.started, res.now)),
    h('td', p.solved ? whenText(p.solved, res.now) : pillOf('critical', 'still late')),
    h('td.num', `${durationText(p.lastedMs)}${p.solved ? '' : ' so far'}`),
    h('td.num', minutesText(p.worstMinutes)), h('td', stateText(p.worstState)),
    h('td', p.pattern ? p.pattern : h('span.muted', '—')), h('td.num', countText(p.measurements))));
  const sil = (res.silences || []).map((s) => `${whenText(s.from, res.now)} → ${finite(s.to) ? whenText(s.to, res.now) : 'still silent'}${finite(s.burstDocs) ? ` (then ${countText(s.burstDocs)} logs${finite(s.burstMinutes) ? `, ${minutesText(s.burstMinutes)} late` : ''})` : ''}`);
  return card('Every delay', 'started = first measurement at the delay level or later · solved = first measurement back under it',
    [h('div.tbl-wrap', h('table.tbl#ld-periods',
      sortHead(sorts.periods, [['started', 'Started'], ['solved', 'Solved'], ['lasted', 'Lasted', 1], ['worst', 'Worst delay', 1], ['state', 'Worst state'], ['pattern', 'Looks like'], ['measurements', 'Measurements', 1]]),
      h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: 7 }, empty('No delay in this period.')))])))),
    footer(`A start or solve time is accurate to the ${every ? `${every}-hour ` : ''}measurement. `,
      sil.length ? `Silences (no logs at all) are listed separately: ${sil.join('; ')}.` : 'No silence in this period.',
      Array.isArray(res.olderMeasurements) && res.olderMeasurements.length ? ` ${countText(res.olderMeasurements.length)} older measurements read from the day files${res.olderTruncated ? ' (the first 20,000)' : ''}.` : '')]);
}

/* ------------------------------------ the fixes ------------------------------------ */

function fixesView(clusterId) {
  const ids = clusterId ? [clusterId] : [];
  const ent = need(`fix|${ids.join(',')}`, () => ldFixes({ clusterIds: ids }));
  const res = ent.state === 'ok' ? ent.res : null;
  const all = clusters();
  const pick = h('select#ld-fix-cluster', { 'aria-label': 'Cluster', onchange: (e) => { location.hash = ldHash('fixes', e.target.value || null); } },
    h('option', { value: '' }, 'All clusters'), ...all.map((c) => h('option', { value: c.id }, c.name)));
  pick.value = clusterId || '';
  const head = h('div.ld-head',
    h('div.ld-title',
      crumbs(link(ldHash('fleet'), 'Reports › Log delay'), clusterId ? link(clusterHref(clusterId), nameOf(clusterId)) : null, 'Recommended fixes'),
      h('h2', 'Why it was late, and how to fix it'),
      h('p.sub.ld-wide-p', 'After each measurement the core looks at the delay periods it stored and matches them against the patterns below. '
        + 'Each match becomes one short recommendation: why, where on the path, what to do, and the evidence. It says “likely” because it is read '
        + 'from timings, not seen; when the evidence is not enough it says so instead of guessing.')),
    h('div.ld-actions', h('label.ld-inline', 'Cluster', pick)));
  const step = (n, title, sub) => h('span.ld-step', h('b', `${n} · ${title}`), h('span', sub));
  const path = card('Where a log can be delayed', 'the path every log takes; each fix names the step',
    h('div.ld-path', step(1, 'Device', 'clock, buffering, export settings'), h('span.ld-arrow', '→'),
      step(2, 'Forwarder', 'syslog / collector, queue, link (fwd_tag, Zone)'), h('span.ld-arrow', '→'),
      step(3, 'Parser', 'Logstash pipeline and filters (parser_tag)'), h('span.ld-arrow', '→'),
      step(4, 'Elasticsearch', 'indexing, write queue, disk, read-only index')));
  if (!res) return h('div.rp-section.ld', { dataset: { ld: 'fixes' } }, head, path, problem(ent, 'The recommended fixes'));

  const findings = (res.findings || []).map((f) => {
    const n = Array.isArray(f.devices) ? f.devices.length : 0;
    const what = f.group ? h('span.muted', h('span.mono', f.group[0]), ` ${f.group[1]}`)
      : h('span.muted', (f.devices || []).slice(0, 3).join(', ') + (n > 3 ? ` +${n - 3}` : ''));
    return h('div.ld-fix', { dataset: { step: f.step } },
      h('div.ld-fix-l', h(`span.pill.ld-pill.${STEP_TONE[f.step] || 'grey'}`, h('i.dot'), stepLabel(f)),
        h('b', `${n} device${n === 1 ? '' : 's'}`), what, f.clusterName && !clusterId ? h('span.muted', f.clusterName) : null),
      h('div.ld-fix-r',
        h('div', h('b', f.step === 'unknown' ? 'Not known yet: ' : 'Likely why: '), f.why || '—'),
        f.fix ? h('div', h('b', 'Fix: '), f.fix) : null,
        evidenceText(f.evidence) ? h('div.muted', `Evidence: ${evidenceText(f.evidence)}`) : null,
        Array.isArray(f.missing) && f.missing.length ? h('div.muted', `Would let the next run decide: ${f.missing.join(', ')}`) : null));
  });
  const scope = clusterId ? nameOf(clusterId) : 'all clusters';
  const fixCard = card(`Recommended fixes · ${scope} · ${res.from} → ${res.to}`, 'most devices affected first',
    findings.length ? h('div.ld-fixes', ...findings) : empty('No recommendation: nothing was late in the stored delay periods of this range.'));

  const devs = sorts.fixDevices.apply(filterRows(res.devices, S.fixFilter), {
    ...deviceCols(),
    step: { type: 'text', value: (d) => stepLabel(d) },
    why: { type: 'text', value: (d) => d.why },
    fix: { type: 'text', value: (d) => d.fix },
  });
  const shown = S.fixAll ? devs : devs.slice(0, PAGE_ROWS);
  const filter = h('input#ld-fix-filter', { type: 'search', placeholder: 'Filter devices', 'aria-label': 'Filter devices', value: S.fixFilter,
    oninput: (e) => { S.fixFilter = e.target.value; bump(); } });
  const devCard = card('Each device', 'every late device with its own recommendation · worst first · a device opens its page',
    [h('div.tbl-wrap', h('table.tbl#ld-fix-devices',
      sortHead(sorts.fixDevices, [['device', 'Device'], ['cluster', 'Cluster'], ['now', 'Delay now', 1], ['step', 'Step'], ['why', 'Likely why'], ['fix', 'Fix']]),
      h('tbody', ...(shown.length ? shown.map((d) => h('tr', { dataset: { device: d.device } },
        h('td.mono', link(deviceHref(d), d.device)), h('td', link(clusterHref(d.cluster), d.clusterName || nameOf(d.cluster))),
        h('td.num', nowText(d)), h('td', h(`span.pill.ld-pill.${STEP_TONE[d.step] || 'grey'}`, h('i.dot'), stepLabel(d))),
        h('td.ld-wrap', d.why || '—'), h('td.ld-wrap', d.fix || h('span.muted', '—'))))
        : [h('tr', h('td', { colspan: 6 }, empty(S.fixFilter ? 'No device matches the filter.' : 'No late device in this range.')))])))),
    footer(`Showing ${countText(shown.length)} of ${countText(devs.length)} late devices`,
      devs.length > shown.length ? [' · ', h('button.linkish#ld-fix-all', { type: 'button', onclick: () => { S.fixAll = true; bump(); } }, 'Show all')] : null,
      ' · the same column is in the .xlsx (Devices sheet: Step, Likely why, Fix)')],
    [filter]);

  const rules = card('How a pattern is matched', 'plain rules on stored data; each one names its step on the path',
    h('div.tbl-wrap', h('table.tbl#ld-rules',
      sortHead(sorts.rules, [['pattern', 'Pattern in the delays'], ['step', 'Step'], ['readFrom', 'Read from'], ['recommendation', 'Recommendation']]),
      h('tbody', ...sorts.rules.apply(res.rules || [], {
        pattern: { type: 'text', value: (r) => r.pattern },
        step: { type: 'text', value: (r) => stepLabel(r) },
        readFrom: { type: 'text', value: (r) => r.readFrom },
        recommendation: { type: 'text', value: (r) => r.recommendation },
      }).map((r) => h('tr', h('td.ld-wrap', r.pattern), h('td', stepLabel(r)), h('td.ld-wrap', r.readFrom), h('td.ld-wrap', r.recommendation)))))));
  return h('div.rp-section.ld', { dataset: { ld: 'fixes' } }, head, path, fixCard, devCard, rules);
}

/* ------------------------------------ the section ------------------------------------ */

/** Reports › Log delay: whichever view the hash names. Kept between redraws until something it shows changes. */
export function logDelaySection(ctx) {
  redraw = ctx.redraw || redraw;
  const r = ldRoute(typeof location === 'undefined' ? '' : location.hash);
  const k = `${S.ver}|${r.view}|${r.clusterId}|${r.device}`;
  if (last.node && last.key === k) return last.node;
  const node = r.view === 'cluster' ? clusterView(r.clusterId)
    : r.view === 'device' ? deviceView(r.clusterId, r.device)
      : r.view === 'fixes' ? fixesView(r.clusterId)
        : fleetView();
  last = { key: `${S.ver}|${r.view}|${r.clusterId}|${r.device}`, node };
  return node;
}
