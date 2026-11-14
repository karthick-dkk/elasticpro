/**
 * The Log Delay page's boards (0.3.57 as Reports › Log delay; on the Log Delay page since 0.3.60;
 * redesigned in 0.3.62, docs/LOGDELAY.md "The Log Delay page"):
 *
 *   Dashboard  five count tiles (the three configured levels, another time zone, silent), the
 *              "Devices behind" chart over the period, the cluster × time heat map, By cluster
 *              with an "i" per cluster; the same for one cluster
 *   Devices    every device, searched and filtered by level, zone and tag1, each row with its
 *              fix ("i") and its logs; one device's board beside the list
 *
 * Everything shown is the core's built-in store, read with LOGDELAY_*; the arithmetic and the
 * routes are core/logdelay-report.js, the device row logdelay/rows.js, the "i" popover
 * logdelay/fix-popover.js. The level names ("Below 30 min", "30–60 min", "Above 60 min") are the
 * cluster's own levels as the core says them: nothing here knows a figure.
 *
 * Drawn card by card (lib/keyed.js): each card is kept until what it shows changed, so an answer
 * arriving, a push from the core or a press elsewhere never rebuilds the card under the mouse.
 * Each view's questions carry an AbortController; leaving the view lets go of them, and an
 * answer for a view no longer shown redraws nothing.
 *
 * Unknown is not zero: a device that is silent or whose delay cannot be read says so, a day
 * without totals is a gap in a chart, a cluster never measured says "never measured", and no
 * median, percentile or average is drawn anywhere.
 */

import { h, svg, mount } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { card, keptCard, empty } from '../pages/common.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { clusters } from '../core/state.js';
import { navigateTo } from '../core/intent.js';
import { refreshReports } from '../core/reports.js';
import { rememberLevels } from '../core/delay-levels.js';
import { download, toCsv } from '../lib/fmt.js';
import {
  LD_COLOURS as C, ldSummary, ldCluster, ldDevice, ldSearch, ldReportRun, ldHash,
  PERIODS, periodQuery, minutesText, durationText, whenText, docsText, pctText, countText,
  stateText, byTimeLate, filterRows, deviceGraph, periodBand, STEP_TONE, stepLabel, evidenceText, extraOf, valuesText,
  DEVICE_FILTERS, matchesFilter, filterCounts, behindSeries, niceStep, labelEvery, heatRows, heatStep, HEAT_LEGEND,
  fixItem, NO_CLUSTER_FIX_TEXT, devicesByZone, timeZoneCell,
} from '../core/logdelay-report.js';
import { deviceTable, sortCols, extraCols, statePill, stateRank } from './rows.js';
import { fixButton, fixesFor, NO_FINDING } from './fix-popover.js';
import { fetchNowPress } from './fetch-now.js';
import { timeZoneText, timeZoneShort, offsetLabel } from '../core/log-tz.js';

const PAGE_ROWS = 50;

/** What the boards keep between draws: the choices made and the answers read. */
const S = {
  period: 'last30',
  reportPeriod: 'shown',
  clusterPick: 'all',
  devFilter: '', devAll: false, devState: 'all', devZone: '', devTag: '',
  cdFilter: '', cdAll: false,
  q: { name: '', field: '', value: '', cluster: '', from: '', to: '' },
  qFor: '',
  range: null,           // {from, to} the device page was narrowed to by Show
  search: null,          // {state, res}
  cache: new Map(),      // key → {state: 'loading'|'ok'|'error', res, seq}
};
let seq = 0;
/** The page's redraw: every answer and every choice goes through it. */
let repaint = () => {};
/** The current view's questions: aborted when the view is left. */
let ctl = null;
let ctlFor = '';

/** The built cards, kept between draws (lib/keyed.js). */
const B = nodeCache();

/** A new visit: everything read before is read again. */
export function boardsReset() {
  boardsLeave();
  S.cache.clear(); S.search = null; S.range = null; S.devFilter = ''; S.cdFilter = '';
  S.devAll = false; S.cdAll = false; S.devState = 'all'; S.devZone = ''; S.devTag = '';
  for (const el of inputs.values()) el.value = '';
  B.clear();
}

/** The boards are left (another tab, another page): what they still wait for is let go of. */
export function boardsLeave() {
  if (ctl) ctl.abort();
  ctl = null; ctlFor = '';
  // An answer that was cut off is asked again next time, not kept as an error.
  for (const [k, e] of S.cache) if (e.state === 'loading') S.cache.delete(k);
}

/** Forget every answer (a Fetch Now finished: the store has a new measurement). */
export function boardsForget() {
  if (ctl) ctl.abort();
  ctl = null; ctlFor = '';
  S.cache.clear();
}

/** Whether the view on screen is still waiting for an answer (the page's loading line). */
export function boardsLoading() {
  for (const e of S.cache.values()) if (e.state === 'loading') return true;
  return false;
}

/* ------------------------------ what the page's tools row reads and sets ------------------------------ */

export const boardsPick = () => S.clusterPick;
export function boardsSetPick(id) { S.clusterPick = id || 'all'; S.devAll = false; }
export const boardsPeriod = () => S.period;
export function boardsSetPeriod(v) { if (PERIODS.some(([id]) => id === v)) { S.period = v; S.range = null; } }

/** The one cluster a route or the pick names; null for every cluster. */
export function boardsScopeId(r) {
  if (r && (r.view === 'cluster' || r.view === 'device') && r.clusterId) return r.clusterId;
  if (r && r.view === 'devices' && r.clusterId) return r.clusterId;
  return S.clusterPick !== 'all' ? S.clusterPick : null;
}

/**
 * What Fetch now measures: the one cluster on screen, its late devices by default (docs/LOGDELAY.md
 * "Fetch now" `devices: late`; the whole cluster is the ▾ menu's choice). No cluster: no run.
 */
export function boardsScope(r) {
  const id = boardsScopeId(r);
  if (id) return { clusterIds: [id], devices: 'late', label: nameOf(id) };
  return { clusterIds: [], label: 'every cluster' };
}

/** The last summary read, whatever its period: the schedule and the shared levels for the Fetch now menu's note. */
export function boardsInfo() {
  let res = null;
  for (const [k, e] of S.cache) if (k.startsWith('sum|') && e.state === 'ok' && e.res) res = e.res;
  const lv = res ? sharedLevels(res.byCluster) : null;
  const sch = (res && res.schedule) || null;
  const st = (sch && sch.state) || {};
  return {
    schedule: sch, levels: lv, delayFrom: lv ? lv.delayFrom : null,
    everyHours: sch && finite(sch.everyHours) ? sch.everyHours : res && finite(res.everyHours) ? res.everyHours : null,
    lastRunAt: sch && finite(sch.lastRunAt) ? sch.lastRunAt : null, nextDueAt: finite(st.nextDueAt) ? st.nextDueAt : null,
    sig: res ? `${objId(res)}` : '-',
  };
}

/**
 * Every cluster the boards have read, with its time zone (`byCluster` of the last summary, a
 * cluster's own answer over it): what the tools row's time-zone line is written from.
 */
export function boardsByCluster() {
  let list = [];
  for (const [k, e] of S.cache) if (k.startsWith('sum|') && e.state === 'ok' && e.res) list = (e.res.byCluster || []).slice();
  for (const [k, e] of S.cache) {
    if (!k.startsWith('cl|') || e.state !== 'ok' || !e.res || !e.res.timeZone) continue;
    const own = { id: e.res.cluster, name: e.res.name, timeZone: e.res.timeZone, lastRunAt: e.res.lastRunAt };
    const i = list.findIndex((c) => c.id === own.id);
    if (i >= 0) list[i] = { ...list[i], ...own }; else list.push(own);
  }
  return list;
}

/* ------------------------------ the tables' column sort ------------------------------ */

/** A head row from `[key | null, label, num]`: a key sorts with `sort` (lib/table-sort.js). */
const sortHead = (sort, cols) => h('thead', h('tr', ...cols.map(([key, label, num]) => (key ? sortTh(sort, key, label, { num: !!num }) : h(num ? 'th.num' : 'th', label)))));
const sorted = () => repaint();
/** Each table's order: none remembered, the order the page gives (worst first, newest first). */
const sorts = {
  clusters: tableSort('logdelay.clusters', { onChange: sorted }),
  devices: tableSort('logdelay.devices', { onChange: sorted }),
  clusterDevices: tableSort('logdelay.cluster-devices', { onChange: sorted }),
  periods: tableSort('logdelay.periods', { onChange: sorted }),
};
const sortSig = (s) => (s.sort ? `${s.sort.key}:${s.sort.dir}` : '-');

/**
 * Read `key` once with `fn(signal)`. The answer redraws the page; one for a view that has been
 * left (aborted) is dropped and asked again on the next visit.
 */
function need(key, fn) {
  const hit = S.cache.get(key);
  if (hit) return hit;
  const ent = { state: 'loading', res: null, seq: ++seq };
  S.cache.set(key, ent);
  const signal = ctl ? ctl.signal : undefined;
  Promise.resolve().then(() => fn(signal)).then((res) => {
    if (res && res.kind === 'aborted') { if (S.cache.get(key) === ent) S.cache.delete(key); return; }
    ent.res = res;
    ent.state = res && res.ok ? 'ok' : 'error';
    ent.seq = ++seq;
    if (res && res.ok) rememberLevels(res);
    if (S.cache.get(key) === ent) repaint();
  }, (e) => { ent.state = 'error'; ent.res = { ok: false, message: e.message || String(e) }; ent.seq = ++seq; repaint(); });
  return ent;
}
const entSig = (ent) => `${ent.state}:${ent.seq}`;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nameOf = (id) => { const c = clusters().find((x) => x.id === id); return c ? c.name : id; };

/* --------------------------------- small pieces --------------------------------- */

const link = (href, text, o = {}) => h('a', { href, title: o.title || null, class: o.cls || null }, text);
const clusterHref = (id) => ldHash('cluster', id);
const crumbs = (...parts) => h('div.ld-crumbs', ...parts.filter(Boolean).flatMap((p, i) => (i ? [' › ', p] : [p])));
const key = (colour, text, o = {}) => h('span.ld-key', h(`i${o.line ? '.ld-ln' : ''}${o.dash ? '.ld-dash' : ''}`, { style: o.dash ? { borderTopColor: colour } : { background: colour } }), text);
const legend = (...k) => h('span.ld-legend', ...k);
const footer = (...kids) => h('div.ld-foot', ...kids);
const sw = (colour) => h('i.ld-sw', { style: { background: colour } });

/** The filter boxes: one element each for the whole visit, so typing never loses its box. */
const inputs = new Map();
function filterBox(id, get, set, placeholder = 'Filter devices') {
  let el = inputs.get(id);
  if (!el) {
    el = h(`input#${id}`, { type: 'search', placeholder, 'aria-label': placeholder,
      oninput: (e) => { set(e.target.value); repaint(); } });
    inputs.set(id, el);
  }
  if (el.value !== get()) el.value = get();
  return el;
}

function problem(ent, what) {
  if (ent.state === 'loading') return h('div.tbl-empty.ld-loading', h('span.spin'), ` Reading ${what}…`);
  const r = ent.res || {};
  if (r.unsupported) return h('div.banner.warn', r.message);
  if (r.kind === 'no_store') return h('div.banner.warn', 'The log delay report needs ElasticPro’s data directory, and this server has none.');
  if (r.kind === 'not_found') return empty(`${what} is not in the store.`, { detail: r.message || 'A device not seen for 7 days is forgotten.' });
  return h('div.banner.err', `${what} could not be read: ${r.message || r.kind || 'no answer'}`);
}

/**
 * The band names on the cluster's levels: "Below 30 min", "30–60 min", "Above 60 min" — the
 * three configured levels, and nothing else. Levels the core has not said read as words.
 */
function bands(levels) {
  const l = levels || {};
  const a = finite(l.delayFrom) ? l.delayFrom : null; const b = finite(l.criticalOver) ? l.criticalOver : null;
  return {
    below: a === null ? 'Below the delay line' : `Below ${a} min`,
    mid: a === null || b === null ? 'Delay' : `${a}–${b} min`,
    high: b === null ? 'Critical' : `Above ${b} min`,
    late: a === null ? 'at the delay level or more' : `${a} min or more`,
    lateShort: a === null ? 'late' : `${a}+ min`,
    backShort: a === null ? 'Back below the line' : `Back below ${a}`,
  };
}

/** The levels every cluster in a summary shares, or null when they differ (then each cluster's own). */
function sharedLevels(byCluster) {
  const ls = (byCluster || []).map((c) => c.levels).filter(Boolean);
  if (!ls.length) return null;
  const k = (l) => `${l.delayFrom}|${l.criticalOver}`;
  return ls.every((l) => k(l) === k(ls[0])) ? ls[0] : null;
}

/** "Build report" and "Send now" cover the period shown, or the whole hour before now (docs/LOGDELAY.md `lastHour`). */
function reportPeriodSelect() {
  const s = h('select#ld-report-period', { 'aria-label': 'Report covers', onchange: (e) => { S.reportPeriod = e.target.value; } },
    h('option', { value: 'shown' }, 'Period shown'), h('option', { value: 'lastHour' }, 'Last hour'));
  s.value = S.reportPeriod;
  return h('label.ld-inline', { title: 'What Build report and Send now cover: the period shown above, or the whole hour before now' }, 'Report covers', s);
}
const reportPeriod = (res, fallback) => (S.reportPeriod === 'lastHour' ? 'lastHour' : res && res.from ? { from: res.from, to: res.to } : fallback);

async function exportXlsx(btn, clusterIds, res) {
  btn.disabled = true;
  const r = await ldReportRun({ clusterIds, period: reportPeriod(res, 'last7'), mail: false });
  btn.disabled = false;
  if (r && r.ok) { toast('The log delay report is building: Reports › Exports & schedules has it when it is done.', 'ok', 6000); refreshReports(); }
  else toast(`Not started: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 6000);
}

async function mailNow(btn, clusterIds, res) {
  const yes = await confirmDialog('Mail the log delay report now?',
    `It goes to the log delay schedule’s recipients, covering ${S.reportPeriod === 'lastHour' ? 'the whole hour before now' : (res && res.label) || 'the period shown'}, with its .xlsx and .csv.`, { yes: 'Mail now' });
  if (!yes) return;
  btn.disabled = true;
  const r = await ldReportRun({ clusterIds, period: reportPeriod(res, 'yesterday'), mail: true });
  btn.disabled = false;
  if (r && r.ok) { toast('The log delay report is being built and mailed.', 'ok', 6000); refreshReports(); }
  else toast(`Not sent: ${(r && (r.message || r.kind)) || 'no answer'}`, 'err', 6000);
}

/* --------------------------- which devices, and how the run read them --------------------------- */

const COUNT_HINT = 'last run = devices that sent a document in the last run’s window (what a live check sees) · '
  + 'now = every device the tracker holds, silent ones included · in range = devices measured at any time in the period shown';
const capSetting = 'Config-Management › Scheduled log delay › Max devices per run';

/** How the last run read one cluster, in words; unknown is said, not 0. */
function lastReadText(lr) {
  if (!lr) return 'not read yet';
  const parts = [`${countText(lr.pages)} page${lr.pages === 1 ? '' : 's'}`, lr.complete ? 'complete' : 'incomplete'];
  if (lr.truncated) parts.push(`stopped at the device cap${finite(lr.maxDevices) ? ` (${countText(lr.maxDevices)})` : ''}`);
  if (lr.error) parts.push(String(lr.error));
  return parts.join(' · ');
}
const noDeviceText = (lr) => (!lr ? '—' : finite(lr.noDevice) ? countText(lr.noDevice) : 'not reported');

/** A cluster whose last run was cut or failed, or whose documents had no device name: said above the figures. */
function readNotes(items) {
  const bad = items.filter((x) => x.lastRead && (x.lastRead.truncated || x.lastRead.complete === false || x.lastRead.error));
  const lost = items.filter((x) => x.lastRead && finite(x.lastRead.noDevice) && x.lastRead.noDevice > 0);
  if (!bad.length && !lost.length) return null;
  return h('div.banner.warn.ld-flat',
    bad.map((x) => h('div', `${x.name}: the last run ${x.lastRead.truncated ? 'stopped at the device cap, so the devices after it are not in the figures; raise ' : 'did not read every device'}`,
      x.lastRead.truncated ? [h('b', capSetting), '.'] : '.')),
    lost.map((x) => h('div', `${x.name}: ${countText(x.lastRead.noDevice)} document${x.lastRead.noDevice === 1 ? ' has' : 's have'} no device name and ${x.lastRead.noDevice === 1 ? 'is' : 'are'} in no device’s figures.`)));
}

/** One cluster's three counts, one line, with what each means. */
function countsLine(counts) {
  if (!counts) return null;
  return h('div.muted.ld-note#ld-counts', { title: COUNT_HINT },
    h('span', h('b', countText(counts.inLastRun)), ' in the last run'), ' · ',
    h('span', h('b', countText(counts.now)), ' now'), ' · ',
    h('span', h('b', countText(counts.inRange)), ' in range'), ` — ${COUNT_HINT}`);
}

/** The note on a board for the period before the zone was known: history is not rewritten. */
function tzSinceNote(items) {
  const since = (items || []).filter((x) => x.tz && (x.tz.mode === 'detected' || x.tz.mode === 'set'));
  if (!since.length) return null;
  const parts = since.filter((x) => x.tz.mode === 'detected' && finite(x.tz.since)).map((x) => `${x.name} before ${whenText(x.tz.since, Date.now())}`);
  return h('div.muted.ld-note.ld-tz-note', 'Delays are shown after each cluster’s log time zone is taken out (arrival − event − time zone). ',
    'Measurements from before a zone was set or detected stay as they were measured',
    parts.length ? `: ${parts.join(', ')}.` : '.');
}

/* ------------------------------------ the fixes ("i") ------------------------------------ */

/**
 * A cluster's "i": its findings grouped by cause with counts (fix-popover.js fixesFor; the
 * cluster's time-zone finding among them), or that there is nothing to fix.
 */
function clusterFixItems(c) {
  const items = fixesFor(c, 'cluster');
  return items.length ? items : [{ title: 'Nothing to fix', cause: NO_CLUSTER_FIX_TEXT, fix: '', where: '', count: null }];
}

/* ------------------------------------ the tiles ------------------------------------ */

/**
 * Devices by time zone, under the tiles: one chip per zone with its device count (a device's own
 * offset when it sits in another zone, else its cluster's; "not detected" for a cluster without
 * a majority). From the answer's rows, so it follows the cluster picked; a cut list says so.
 */
function zoneChips(res) {
  const zones = devicesByZone(res.devices);
  if (!zones.length) return null;
  return h('div.ld-zones#ld-zones', h('span.muted.ld-zones-l', 'Devices by time zone'),
    ...zones.map((z) => h('span.ld-chip.ld-zone-chip', { dataset: { zone: z.key }, title: z.offsetMinutes === null ? 'devices of a cluster whose zone is not detected: nothing is corrected' : `devices whose logs are stamped at ${offsetLabel(z.offsetMinutes)}` },
      z.offsetMinutes === null ? 'not detected' : offsetLabel(z.offsetMinutes), ' ', h('b', countText(z.devices)))),
    res.devicesTruncated ? h('span.muted.ld-tiny', `the first ${countText((res.devices || []).length)} of ${countText(res.devicesTotal)} devices`) : null);
}

/**
 * The five count tiles: the three configured levels, another time zone, silent. Each opens the
 * Devices tab on that filter. A figure the core did not give reads "—", never 0; can't-measure
 * devices are said under Silent (they have no figure either).
 */
function tiles(t, b, scopeId, keyPrefix) {
  const tile = (k, filter, label, value, colour, detail) => h('button.ld-kpi.ld-kpi-btn', {
    type: 'button', dataset: { kpi: k }, title: `Open Devices: ${label.toLowerCase()}`,
    onclick: () => { S.devState = filter; S.devAll = false; location.hash = ldHash('devices', scopeId); },
  }, h('span.ld-kpi-l', colour ? sw(colour) : null, label), h('b', value), h('span', detail));
  return h(`div.ld-kpis.ld-5#${keyPrefix}-tiles`,
    tile('below', 'ok', b.below, countText(t.onTime), C.ok, 'devices under the delay line'),
    tile('delay', 'delay', b.mid, countText(t.delay), C.delay, 'delay'),
    tile('critical', 'critical', b.high, countText(t.critical), C.crit, 'critical'),
    tile('tz', 'tz', 'Other time zone', countText(t.otherTz), C.tz, 'not counted as late'),
    tile('silent', 'silent', 'Silent', countText(t.silent), C.silent, finite(t.unmeasured) && t.unmeasured ? `no logs · ${countText(t.unmeasured)} can’t measure` : 'no logs for the silence limit'));
}

/* ------------------------------------ charts ------------------------------------ */

/**
 * "Devices behind" over the period: slim stacked bars (the delay band in light blue, then above
 * the critical line in blue) with a thin green line for the delays solved — back below the line.
 * Today's buckets are the measurement windows, which the core counts as one "still late" figure,
 * so Today draws one series and the legend says so. A day without totals is a hatched gap. Each
 * bucket carries its words as a title; the chart has no number of its own.
 */
function behindChart(res, period, b, id) {
  const data = behindSeries(res, period);
  const n = data.length;
  const W = 1100, H = 230, L = 36, R = 8, T = 10, Bm = 24;
  const split = period !== 'today';
  const max = Math.max(1, ...data.map((d) => Math.max(d.behind || 0, d.back || 0)));
  const step = niceStep(max); const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - Bm) * (1 - v / top);
  const slot = n ? (W - L - R) / n : W - L - R;
  const bw = Math.max(3, Math.min(14, slot * 0.58));
  const cx = (i) => L + i * slot + slot / 2;
  const kids = [];
  for (let v = 0; v <= top; v += step) {
    kids.push(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v ? 'ld-grid' : 'ld-axis' }));
    kids.push(svg('text', { x: L - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, String(v)));
  }
  const every = labelEvery(n);
  data.forEach((d, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const words = d.gap ? `${d.label} · no measurement`
      : split ? `${d.label} · ${countText(d.delay)} at ${b.mid}, ${countText(d.critical)} ${b.high.toLowerCase()}, ${countText(d.back)} back below the line${d.complete ? '' : ' · not over'}`
        : `${d.label} · ${countText(d.behind)} ${b.late} when the window ended, ${countText(d.back)} back below the line${d.complete ? '' : ' · window not over'}`;
    const g = svg('g', { class: `ld-bar${d.gap ? ' ld-bar-gap' : ''}`, dataset: null });
    g.append(svg('title', {}, words));
    if (d.gap) {
      g.append(svg('rect', { x, y: T, width: bw, height: H - T - Bm, class: 'ld-gap-fill' }));
    } else {
      const parts = split ? [[d.delay, C.delay], [d.critical, C.crit]] : [[d.behind, C.delay]];
      let base = 0;
      parts.filter(([v]) => v > 0).forEach(([v, fill], j, arr) => {
        const y0 = y(base), y1 = y(base + v); const hgt = Math.max(0.5, y0 - y1 - (j ? 1 : 0));
        const lastSeg = j === arr.length - 1; const r = lastSeg ? Math.min(3, hgt, bw / 2) : 0;
        g.append(lastSeg
          ? svg('path', { d: `M${x},${y1 + hgt} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y1 + hgt} Z`, fill })
          : svg('rect', { x, y: y1, width: bw, height: hgt, fill }));
        base += v;
      });
    }
    g.append(svg('rect', { x: L + i * slot, y: T, width: slot, height: H - T - Bm, fill: 'transparent' }));
    kids.push(g);
    if (i % every === 0) kids.push(svg('text', { x: cx(i), y: H - 6, 'text-anchor': 'middle' }, d.label));
  });
  const known = data.map((d, i) => ({ i, v: d.back })).filter((p) => finite(p.v));
  if (known.length) {
    const segs = []; let cur = [];
    data.forEach((d, i) => { if (finite(d.back)) cur.push(`${cx(i).toFixed(1)},${y(d.back).toFixed(1)}`); else if (cur.length) { segs.push(cur); cur = []; } });
    if (cur.length) segs.push(cur);
    for (const s of segs) kids.push(svg('polyline', { points: s.join(' '), fill: 'none', stroke: C.ok, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none' }));
    const last = known[known.length - 1];
    kids.push(svg('circle', { cx: cx(last.i), cy: y(last.v), r: 3.5, fill: C.ok, class: 'ld-line-end', 'pointer-events': 'none' }));
  }
  const aria = n ? `Devices behind per ${period === 'today' ? 'window' : 'day'}: at most ${max}` : 'Devices behind: nothing measured in this period';
  return h('div.ld-chartbox',
    n ? svg('svg', { class: 'ld-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria, id }, ...kids)
      : h('div.tbl-empty', 'Nothing measured in this period.'));
}

/**
 * The cluster × time heat map: one row per cluster, one cell per bucket, the ramp by devices
 * behind; a cell the core has no total for is hatched (unknown), a cluster never measured says
 * so. A cell opens its cluster.
 */
function heatMap(res, period, b, id) {
  const rows = heatRows(res.byCluster, period);
  const series = behindSeries(res, period);
  const n = Math.max(series.length, ...rows.map((r) => r.cells.length));
  if (!rows.length || !n) return h('div.tbl-empty', 'No cluster measured in this period.');
  const W = 1100, hL = 150, hT = 4, ch = 28, cw = (W - hL - 6) / n;
  const every = labelEvery(n);
  const kids = [];
  rows.forEach((r, ri) => {
    const yy = hT + ri * ch;
    const lab = svg('text', { x: hL - 8, y: yy + ch / 2 + 3.5, 'text-anchor': 'end', class: 'ld-heat-name' }, r.name.length > 22 ? `${r.name.slice(0, 21)}…` : r.name);
    lab.append(svg('title', {}, r.name));
    kids.push(lab);
    if (r.never) {
      kids.push(svg('text', { x: hL + 6, y: yy + ch / 2 + 3.5, class: 'ld-heat-never' }, 'never measured: not in the scheduled measurement yet'));
      return;
    }
    for (let i = 0; i < n; i++) {
      const v = r.cells[i]; const s = heatStep(v);
      const label = series[i] ? series[i].label : `#${i + 1}`;
      const cell = svg('rect', { x: hL + i * cw + 1, y: yy + 1, width: Math.max(1, cw - 2), height: ch - 2, rx: 3,
        class: `ld-heat ld-heat-${s < 0 ? 'unknown' : s}`, dataset: null, role: 'link', tabindex: -1,
        onclick: () => { location.hash = clusterHref(r.id); } });
      cell.append(svg('title', {}, `${r.name} · ${label} · ${s < 0 ? 'not measured' : `${countText(v)} ${b.late} (devices behind)`} · opens the cluster`));
      kids.push(cell);
    }
  });
  for (let i = 0; i < n; i += every) kids.push(svg('text', { x: hL + i * cw + cw / 2, y: hT + rows.length * ch + 14, 'text-anchor': 'middle' }, series[i] ? series[i].label : ''));
  return h('div.ld-chartbox', svg('svg', { class: 'ld-chart ld-heatmap', viewBox: `0 0 ${W} ${hT + rows.length * ch + 22}`, role: 'img', id,
    'aria-label': `Devices behind per cluster and ${period === 'today' ? 'window' : 'day'}` }, ...kids));
}

/** The mini stacked bar of a cluster's states, in the By cluster table. */
function stateBar(c, b) {
  const parts = [[c.below, C.ok, b.below], [c.delay, C.delay, b.mid], [c.critical, C.crit, b.high], [c.otherTz, C.tz, 'Other time zone'], [c.silent, C.silent, 'Silent'], [c.unmeasured, 'var(--surface-3)', 'Can’t measure']]
    .filter(([v]) => finite(v) && v > 0);
  if (!parts.length) return h('span.muted', '—');
  return h('div.ld-mini', { role: 'img', 'aria-label': parts.map(([v, , t]) => `${t} ${v}`).join(', ') },
    ...parts.map(([v, colour, t]) => h('i', { style: { flex: `${v} 0 0`, background: colour }, title: `${t}: ${countText(v)}` })));
}

/* ------------------------------------ the dashboard ------------------------------------ */

function chartLegend(period, b) {
  return period === 'today'
    ? legend(key(C.delay, `${b.late} when the window ended`), key(C.ok, 'Back below the line (solved in the window)', { line: true }))
    : legend(key(C.delay, b.mid), key(C.crit, b.high), key(C.ok, b.backShort, { line: true }));
}
const periodWords = (period, res) => `${period === 'today' ? 'by measurement window' : 'by day'} · ${(res && res.label) || (PERIODS.find((p) => p[0] === period) || ['', ''])[1].toLowerCase()}`;

function fleetView() {
  const ids = S.clusterPick === 'all' ? [] : [S.clusterPick];
  const q = periodQuery(S.period);
  const ent = need(`sum|${S.period}|${ids.join(',')}`, (signal) => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const head = B.get('fleet:head', `${S.period}|${S.clusterPick}|${entSig(ent)}`, () => {
    const lv = res ? sharedLevels(res.byCluster) : null;
    const b = bands(lv);
    const every = res && finite(res.everyHours) ? res.everyHours : null;
    const exportBtn = h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, ids, res) }, 'Build report (.xlsx)');
    const mailBtn = h('button.btn.primary#ld-mail', { type: 'button', disabled: !res, onclick: (e) => mailNow(e.currentTarget, ids, res) }, 'Send now…');
    return h('div.ld-head',
      h('div.ld-title',
        h('h2', S.clusterPick === 'all' ? 'Every cluster' : nameOf(S.clusterPick)),
        h('p.sub', 'Every device that sends logs, by the configured levels. ',
          every ? `Measured on the server every ${every} hour${every === 1 ? '' : 's'}; ` : 'Measured on the server on a timer; ',
          lv ? `late means ${b.late}.` : 'late means each cluster’s own delay level.')),
      h('div.ld-actions', reportPeriodSelect(), exportBtn, mailBtn));
  });
  if (!res) return [head, B.get('fleet:problem', entSig(ent), () => problem(ent, 'The log delay summary'))];

  const lv = sharedLevels(res.byCluster);
  const b = bands(lv);
  const rid = objId(res);
  const t = res.totals || {};
  const scopeId = S.clusterPick === 'all' ? null : S.clusterPick;

  const notice = B.get('fleet:notice', rid, () => (!res.schedule || res.schedule.supported === false
    ? h('div.banner.warn', 'This server does not run the scheduled measurement (hosted edition only): nothing new is measured.')
    : res.schedule.enabled === false
      ? h('div.banner.warn', 'The scheduled measurement is switched off; the figures stop at its last run. ',
        h('button.linkish', { type: 'button', onclick: () => navigateTo('settings', { section: 'schedule' }) }, 'Config-Management › Data › Scheduled log delay'))
      : null));
  const readNote = B.get('fleet:readnote', rid, () => readNotes((res.byCluster || []).map((c) => ({ name: c.name || nameOf(c.id), lastRead: c.lastRead }))));
  const tileRow = B.get('fleet:tiles', `${rid}|${scopeId}`, () => tiles(t, b, scopeId, 'ld-fleet'));
  const zones = B.get('fleet:zones', rid, () => zoneChips(res));
  const totalsLine = B.get('fleet:counts', rid, () => h('div.muted.ld-note#ld-fleet-counts', { title: COUNT_HINT },
    h('b', countText(res.devicesInLastRun)), ' devices in the last run · ', h('b', countText(res.devicesTotal)), ' now · ',
    h('b', countText(res.devicesInRange)), ` in the period shown — ${COUNT_HINT}`));
  const behind = B.get('fleet:behind', `${rid}|${S.period}`, () => card('Devices behind', periodWords(S.period, res),
    behindChart(res, S.period, b, 'ld-behind'), [chartLegend(S.period, b)]));
  const heat = B.get('fleet:heat', `${rid}|${S.period}`, () => card('When and where devices run late', `devices behind per cluster, ${periodWords(S.period, res)} · a cell opens the cluster`,
    heatMap(res, S.period, b, 'ld-heat'),
    [legend(...HEAT_LEGEND.map((tx, i) => h('span.ld-key', h(`i.ld-heat-key.ld-heat-${i}`), tx)), h('span.ld-key', h('i.ld-heat-key.ld-heat-unknown'), 'not measured'))]));

  const clusterCard = B.get('fleet:clusters', `${rid}|${sortSig(sorts.clusters)}`, () => {
    // A cluster never measured has no figures: unknown, so it sorts last either way.
    const seen = (f) => (c) => (c.lastRunAt === null || c.lastRunAt === undefined ? null : f(c));
    const devsOf = (id) => (res.devices || []).filter((d) => d.cluster === id);
    const cl = sorts.clusters.apply(res.byCluster || [], {
      name: { type: 'text', value: (c) => c.name || nameOf(c.id) },
      timeZone: { type: 'text', value: seen((c) => timeZoneShort(c.timeZone)) },
      zone: { type: 'text', value: (c) => valuesText(devsOf(c.id), 'zone') },
      tag1: { type: 'text', value: (c) => valuesText(devsOf(c.id), 'tag1') },
      devices: { type: 'number', value: (c) => c.devices },
      lastRun: { type: 'number', value: seen((c) => (c.counts ? c.counts.inLastRun : null)) },
      below: { type: 'number', value: seen((c) => c.below) },
      delay: { type: 'number', value: seen((c) => c.delay) },
      critical: { type: 'number', value: seen((c) => c.critical) },
      otherTz: { type: 'number', value: seen((c) => (c.timeZone && c.timeZone.mode !== 'none' ? c.otherTz : null)) },
      silent: { type: 'number', value: seen((c) => c.silent) },
      worst: { type: 'number', value: seen((c) => (c.worst && c.worst.device ? c.worst.minutes : null)) },
    }).map((c) => {
      const cb = bands(c.levels);
      const neverRun = c.lastRunAt === null || c.lastRunAt === undefined;
      const devs = devsOf(c.id);
      return h('tr', { dataset: { cluster: c.id } },
        h('td', link(clusterHref(c.id), c.name || nameOf(c.id), { title: `${c.name} · log delay details` })),
        h('td.ld-tz-cell', { title: c.timeZone ? timeZoneText(c.timeZone) : 'not measured' }, neverRun ? h('span.muted', '—')
          : c.timeZone && c.timeZone.mode === 'none' ? h('span.muted', timeZoneCell(c.timeZone, offsetLabel)) : timeZoneCell(c.timeZone, offsetLabel)),
        h('td', { title: 'zones of the devices listed on Devices' }, valuesText(devs, 'zone')),
        h('td', { title: 'tag1 of the devices listed on Devices' }, valuesText(devs, 'tag1')),
        neverRun ? h('td', { colspan: 9 }, h('span.muted', 'never measured: not in the scheduled measurement yet'))
          : [h('td', stateBar(c, cb)),
            h('td.num', countText(c.devices)),
            h('td.num', { title: COUNT_HINT }, countText(c.counts && c.counts.inLastRun)),
            h('td.num', { title: `devices under ${cb.late} now` }, countText(c.below)),
            h(`td.num${c.delay ? '.ld-delay' : ''}`, countText(c.delay)),
            h(`td.num${c.critical ? '.ld-crit' : ''}`, countText(c.critical)),
            h('td.num', { title: 'devices whose logs are stamped in another time zone than the cluster’s: not late, counted apart (— when the cluster has no zone)' },
              c.timeZone && c.timeZone.mode !== 'none' ? countText(c.otherTz) : h('span.muted', '—')),
            h('td.mono', c.worst && c.worst.device
              ? [link(ldHash('device', c.id, c.worst.device), c.worst.device, { title: `${c.worst.device} · delay details` }), h('span.muted', ` ${minutesText(c.worst.minutes)}`)]
              : h('span.muted', '—')),
            h('td.ld-acts', fixButton({ kind: 'cluster', id: c.name || c.id, items: () => clusterFixItems(c) }))]);
    });
    return card('By cluster', `${b.below.toLowerCase()} = devices under ${b.late} of delay now · ${COUNT_HINT} · a cluster name opens the cluster, its “i” the recommended fixes`,
      h('div.tbl-wrap', h('table.tbl.ld-ctr#ld-by-cluster',
        sortHead(sorts.clusters, [['name', 'Cluster'], ['timeZone', 'Time zone'], ['zone', 'zone'], ['tag1', 'tag1'], [null, 'States'], ['devices', 'Devices', 1], ['lastRun', 'In last run', 1],
          ['below', b.below, 1], ['delay', b.mid, 1], ['critical', b.high, 1], ['otherTz', 'Other time zone', 1], ['worst', 'Worst device'], [null, '']]),
        h('tbody', ...(cl.length ? cl : [h('tr', h('td', { colspan: 13 }, empty('No cluster you can see is measured.')))])))));
  });
  const tzNote = B.get('fleet:tznote', rid, () => tzSinceNote((res.byCluster || []).map((c) => ({ name: c.name || nameOf(c.id), tz: c.timeZone }))));
  const readCard = B.get('fleet:read', rid, () => card('How the last run read each cluster', 'pages asked, whether the list is complete, and documents with no device name',
    h('div.tbl-wrap', h('table.tbl.ld-ctr#ld-last-read',
      h('thead', h('tr', h('th', 'Cluster'), h('th', 'Read'), h('th.num', 'Devices read'), h('th.num', 'Without a device name'))),
      h('tbody', ...(res.byCluster || []).filter((c) => c.lastRunAt !== null && c.lastRunAt !== undefined).map((c) => h('tr', { dataset: { cluster: c.id } },
        h('td', link(clusterHref(c.id), c.name || nameOf(c.id))),
        h('td', { class: c.lastRead && (c.lastRead.truncated || !c.lastRead.complete) ? 'ld-crit' : null }, lastReadText(c.lastRead)),
        h('td.num', c.lastRead ? countText(c.lastRead.devices) : '—'),
        h('td.num', { title: 'documents in the last run’s window with no device name: in no device’s figures' }, noDeviceText(c.lastRead)))))))));
  const never = (res.byCluster || []).filter((c) => c.lastRunAt === null || c.lastRunAt === undefined);
  const neverNote = B.get('fleet:never', rid, () => (never.length && never.length < (res.byCluster || []).length
    ? h('div.muted.ld-note', `${never.length} cluster${never.length === 1 ? ' is' : 's are'} not measured yet: ${never.map((c) => c.name).join(', ')}.`) : null));
  return [head, notice, readNote, tileRow, zones, totalsLine, behind, heat, clusterCard, tzNote, readCard, neverNote];
}

/* ------------------------------------ one cluster ------------------------------------ */

function clusterKey(id, q) { return `cl|${id}|${JSON.stringify(q)}`; }

function clusterView(id) {
  const q = periodQuery(S.period);
  const ent = need(clusterKey(id, q), (signal) => ldCluster({ clusterId: id, ...q, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const name = (res && res.name) || nameOf(id);
  const lv = res && res.levels; const b = bands(lv);
  const head = B.get('cl:head', `${id}|${S.period}|${entSig(ent)}`, () => {
    const exportBtn = h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, [id], res) }, 'Build report (.xlsx)');
    const tz = res && res.timeZone;
    return h('div.ld-head',
      h('div.ld-title',
        crumbs(link(ldHash('fleet'), 'Log Delay'), 'cluster'),
        h('h2.ld-h-row', name, h('span.ld-h-sub', ` · ${(res && res.label) || (PERIODS.find((p) => p[0] === S.period) || ['', ''])[1].toLowerCase()}`),
          res ? fixButton({ kind: 'cluster', id: name, items: () => clusterFixItems(res) }) : null),
        h('p.sub', `Every device in this cluster that sends logs. Late means ${b.late}.`),
        tz ? h('div.ld-chips', tz.mode === 'none' ? h('span.ld-chip', 'Delay shown as measured: no time zone to take out') : h('span.ld-chip', `Delay shown after the time zone (${timeZoneShort(tz)}) is taken out`)) : null),
      h('div.ld-actions', link(ldHash('devices', id), 'Devices ›', { cls: 'btn' }), reportPeriodSelect(), exportBtn));
  });
  if (!res) return [head, B.get('cl:problem', entSig(ent), () => problem(ent, `${name}’s log delay`))];
  const rid = objId(res);
  const t = res.totals || {};
  const tileRow = B.get('cl:tiles', rid, () => tiles(t, b, id, 'ld-cl'));
  const zones = B.get('cl:zones', rid, () => zoneChips(res));
  const never = res.lastRunAt === null || res.lastRunAt === undefined;
  const lr = res.lastRead || (res.counts && res.counts.lastRead);
  const readNote = B.get('cl:readnote', rid, () => readNotes([{ name, lastRead: lr }]));
  const countsNote = B.get('cl:counts', rid, () => h('div.ld-note', countsLine(res.counts),
    h('div.muted#ld-last-read-line', `Last run read: ${lastReadText(lr)} · documents with no device name: ${noDeviceText(lr)} · ${countText(res.started)} delays started, ${countText(res.solved)} solved in the period`)));
  const neverNote = B.get('cl:never', rid, () => (never ? h('div.banner.warn', `${name} has never been measured: it is not in the scheduled measurement yet.`) : null));
  const behind = B.get('cl:behind', `${rid}|${S.period}`, () => card('Devices behind', `${name} · ${periodWords(S.period, res)}`,
    behindChart(res, S.period, b, 'ld-behind'), [chartLegend(S.period, b)]));

  const f = res.fields || {};
  const extras = Array.isArray(f.extras) ? f.extras : [];
  const arrival = f.arrival || 'arrival';
  const event = (Array.isArray(f.eventTime) && f.eventTime[0]) || 'event time';
  const xc = extraCols(extras);
  const keys = ['device', 'zone', 'tag1', 'state', 'now', 'rawGap', 'deviceTz', 'max', 'episodes', 'lateMs', 'last', ...Object.keys(xc), 'arrival', 'event'];
  const ordered = sorts.clusterDevices.apply(byTimeLate(filterRows(res.devices, S.cdFilter)), sortCols(keys, xc));
  const shown = S.cdAll ? ordered : ordered.slice(0, PAGE_ROWS);
  const body = B.get('cl:dev:body', `${rid}|${S.cdFilter}|${S.cdAll}|${sortSig(sorts.clusterDevices)}`, () => [
    deviceTable({ id: 'ld-cluster-devices', sort: sorts.clusterDevices, rows: shown.map((r) => ({ ...r, cluster: r.cluster || id })), keys, extra: xc,
      labels: { arrival, event }, ctx: { now: res.now }, emptyText: S.cdFilter ? 'No device matches the filter.' : 'No device measured in this period.' }),
    footer(`ECS fields from the device’s latest log: ${[...extras, `${arrival} (arrival)`, `${event} (event time)`].join(', ')} · delay = ${arrival} − ${event}`
      + (res.timeZone && res.timeZone.mode !== 'none' ? ` − time zone (${res.timeZone.offset || offsetLabel(res.timeZone.offsetMinutes)})` : '')
      + (f.device ? ` · device field ${f.device}` : '') + (f.pattern ? ` · indices ${f.pattern}` : ''),
      ` · Showing ${countText(shown.length)} of ${countText(ordered.length)}`,
      ordered.length > shown.length ? [' · ', h('button.linkish#ld-cd-all', { type: 'button', onclick: () => { S.cdAll = true; repaint(); } }, 'Show all')] : null)]);
  const devCard = keptCard(B, 'cl:dev', 'Devices in this cluster',
    `${countText((res.devices || []).length)} · ${sorts.clusterDevices.sort ? 'sorted by the marked column' : 'sorted by time spent late'} · a device name opens its details`,
    body, [filterBox('ld-cd-filter', () => S.cdFilter, (v) => { S.cdFilter = v; S.cdAll = false; })]);
  const tzNote = B.get('cl:tznote', rid, () => tzSinceNote([{ name, tz: res.timeZone }]));
  return [head, neverNote, readNote, tileRow, zones, countsNote, behind, devCard, tzNote];
}

/* ------------------------------------ the devices ------------------------------------ */

/** The device columns of the Devices tab (no median: nothing averaged is shown). */
const FLEET_COLS = ['device', 'cluster', 'zone', 'tag1', 'state', 'now', 'rawGap', 'deviceTz', 'max', 'episodes', 'lateMs', 'last', 'docs'];

/** The distinct values of a context field over the rows, for the Zone and tag1 selects. */
const valuesOf = (rows, name) => [...new Set((rows || []).map((r) => extraOf(r, name)).filter((v) => v !== null).map(String))].sort();

/** Every filter the Devices tab applies: the search box, the level chip, zone and tag1. */
function devicesFiltered(rows) {
  return filterRows(rows, S.devFilter).filter((r) => matchesFilter(r, S.devState)
    && (!S.devZone || String(extraOf(r, 'zone')) === S.devZone) && (!S.devTag || String(extraOf(r, 'tag1')) === S.devTag));
}

/** The rows as a file, as filtered, with zone and tag1 and the time zone step; unknown stays blank, never 0. */
function exportDevicesCsv(rows) {
  const out = rows.map((r) => ({
    device: r.device, cluster: r.clusterName || r.cluster, zone: extraOf(r, 'zone') ?? '', tag1: extraOf(r, 'tag1') ?? '',
    state: stateText(r.state), delay_minutes: finite(r.nowMinutes) ? r.nowMinutes.toFixed(2) : '',
    raw_gap_minutes: finite(r.rawGapMinutes) ? r.rawGapMinutes.toFixed(2) : '', time_zone_offset: finite(r.tzOffsetMinutes) ? offsetLabel(r.tzOffsetMinutes) : '',
    max_minutes: finite(r.maxMinutes) ? r.maxMinutes.toFixed(2) : '', delays: finite(r.episodes) ? r.episodes : '', late_ms: finite(r.lateMs) ? r.lateMs : '',
    late_since: finite(r.lateSince) ? new Date(r.lateSince).toISOString() : '', docs_per_day: finite(r.docsPerDay) ? r.docsPerDay : '',
    fix: r.fix ? `${stepLabel(r.fix)}: ${r.fix.fix || r.fix.why || ''}` : '',
  }));
  download(`log-delay-devices-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(out));
}

/**
 * The Devices tab: the fleet's (or one cluster's) devices from the summary, searched, filtered by
 * level (the chips carry counts), zone and tag1; each row with its "i" and its logs (rows.js).
 * `narrow` draws the short list beside an open device board.
 */
function devicesView(clusterId, narrow = false) {
  const ids = clusterId ? [clusterId] : [];
  const q = periodQuery(S.period);
  const ent = need(`sum|${S.period}|${ids.join(',')}`, (signal) => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const lv = res ? sharedLevels(res.byCluster) : null; const b = bands(lv);
  const head = narrow ? null : B.get('dev:head', `${clusterId}|${S.period}|${entSig(ent)}`, () => h('div.ld-head',
    h('div.ld-title',
      h('h2', clusterId ? `Devices · ${nameOf(clusterId)}` : 'Devices'),
      h('p.sub', `Every device measured in the period, worst first. Late means ${b.late}; a device name opens its details, “i” its recommended fix, Open in logs its documents.`)),
    h('div.ld-actions',
      h('button.btn#ld-dev-csv', { type: 'button', disabled: !res, title: 'The rows as filtered, with zone and tag1', onclick: () => exportDevicesCsv(devicesFiltered(res.devices)) }, 'Export CSV'),
      h('button.btn#ld-export', { type: 'button', disabled: !res, onclick: (e) => exportXlsx(e.currentTarget, ids, res) }, 'Build report (.xlsx)'))));
  if (!res) return [head, B.get('dev:problem', entSig(ent), () => problem(ent, 'The devices'))].filter(Boolean);
  const rid = objId(res);
  const rows = res.devices || [];
  const counts = filterCounts(filterRows(rows, S.devFilter));
  const chipLabel = { all: 'All', late: b.lateShort, critical: b.high, delay: b.mid, ok: b.below, tz: 'Other time zone', silent: 'Silent' };
  const zones = valuesOf(rows, 'zone'); const tags = valuesOf(rows, 'tag1');
  // The bar is one element for the visit (its counts, the pressed chip and the selects change in
  // place): the search box inside it is never moved, so typing never loses the focus or the caret.
  const bar = B.get('dev:bar', `${rid}|${narrow}|${b.mid}|${zones.join(',')}|${tags.join(',')}`, () => {
    const sel = (id, label, vals, set) => {
      const s = h(`select#${id}`, { 'aria-label': label, onchange: (e) => { set(e.target.value); S.devAll = false; repaint(); } },
        h('option', { value: '' }, `All ${label.toLowerCase()}s`), ...vals.map((v) => h('option', { value: v }, v)));
      return h('label.field.ld-tool', label, s);
    };
    return h('div.toolbar.ld-dev-bar',
      filterBox('ld-dev-filter', () => S.devFilter, (v) => { S.devFilter = v; S.devAll = false; }, 'Search device, cluster, zone or tag1'),
      h('div.ld-chips#ld-dev-chips', ...DEVICE_FILTERS.map((f) => h('button.ld-chip.ld-chip-btn', {
        type: 'button', dataset: { filter: f }, 'aria-pressed': 'false',
        onclick: () => { S.devState = f; S.devAll = false; repaint(); },
      }, chipLabel[f], ' ', h('b')))),
      narrow ? null : sel('ld-dev-zone', 'Zone', zones, (v) => { S.devZone = v; }),
      narrow ? null : sel('ld-dev-tag', 'tag1', tags, (v) => { S.devTag = v; }));
  });
  for (const btn of bar.querySelectorAll('.ld-chip-btn')) {
    const f = btn.dataset.filter; const n = btn.querySelector('b'); const txt = countText(counts[f]); const on = String(S.devState === f);
    if (n.textContent !== txt) n.textContent = txt;
    if (btn.getAttribute('aria-pressed') !== on) btn.setAttribute('aria-pressed', on);
  }
  for (const [id, cur, vals] of [['#ld-dev-zone', S.devZone, zones], ['#ld-dev-tag', S.devTag, tags]]) {
    const el = bar.querySelector(id); const want = vals.includes(cur) ? cur : '';
    if (el && el.value !== want) el.value = want;
  }
  const ordered = sorts.devices.apply(byTimeLate(devicesFiltered(rows)), sortCols(FLEET_COLS));
  const shown = S.devAll ? ordered : ordered.slice(0, PAGE_ROWS);
  const keys = narrow ? ['device', 'zone', 'tag1', 'state', 'now'] : FLEET_COLS;
  const body = B.get('dev:body', `${rid}|${S.devFilter}|${S.devState}|${S.devZone}|${S.devTag}|${S.devAll}|${sortSig(sorts.devices)}|${narrow}`, () => [
    deviceTable({ id: 'ld-devices', sort: sorts.devices, rows: shown, keys, ctx: { now: res.now },
      emptyText: S.devFilter || S.devState !== 'all' || S.devZone || S.devTag ? 'No device matches. Clear the search or pick another level.' : 'No device measured in this period.' }),
    footer(`Showing ${countText(shown.length)} of ${countText(ordered.length)}`,
      ordered.length > shown.length ? [' · ', h('button.linkish#ld-dev-all', { type: 'button', onclick: () => { S.devAll = true; repaint(); } }, 'Show all')] : null,
      res.devicesTruncated ? ` · the server sent the first ${countText(rows.length)} of ${countText(res.devicesTotal)}` : null)]);
  const list = keptCard(B, 'dev:list', narrow ? 'Devices' : `${countText(res.devicesTotal ?? rows.length)} devices`,
    sorts.devices.sort ? 'sorted by the marked column' : 'sorted by time spent late', [bar, body]);
  return [head, list].filter(Boolean);
}

/* ------------------------------------ one device ------------------------------------ */

function deviceQuery() {
  return S.range ? { from: S.range.from, to: S.range.to } : periodQuery(S.period);
}

/**
 * One device, and only that device: its figures, its recommendation (the core's finding, the
 * same words as its row's "i"), its graph and its delays, beside the short device list.
 */
function deviceView(clusterId, device) {
  const q = deviceQuery();
  const ent = need(`dev|${clusterId}|${device}|${JSON.stringify(q)}`, (signal) => ldDevice({ clusterId, device, ...q, signal }));
  const cent = need(clusterKey(clusterId, periodQuery(S.period)), (signal) => ldCluster({ clusterId, ...periodQuery(S.period), signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const cres = cent.state === 'ok' ? cent.res : null;
  const f = (cres && cres.fields) || {};
  const devField = String(f.device || 'src_hostname').replace(/\.keyword$/, '');
  const every = res && finite(res.everyHours) ? res.everyHours : null;
  const cname = (res && res.clusterName) || nameOf(clusterId);
  const late = res && (res.state === 'delay' || res.state === 'critical');
  const head = B.get('dev1:head', `${clusterId}|${device}|${S.period}|${JSON.stringify(S.range)}|${entSig(ent)}|${entSig(cent)}`, () => h('div.ld-head',
    h('div.ld-title',
      crumbs(link(ldHash('devices'), 'Devices'), link(clusterHref(clusterId), cname)),
      h('h2.ld-dev-h', h('span.mono', device),
        res ? statePill(res.state, late && finite(res.lateSince) ? `${stateText(res.state)} · late since ${whenText(res.lateSince, res.now).replace(/^today /, '')}`
          : res.state === 'silent' && finite(res.silentSince) ? `silent · no logs since ${whenText(res.silentSince, res.now)}` : stateText(res.state)) : null,
        res ? fixButton({ kind: 'device', id: device, items: () => fixesFor(res, 'device') }) : null),
      h('p.sub', [`Device field ${devField}`, `arrival ${f.arrival || '@timestamp'}`,
        `event time ${Array.isArray(f.eventTime) && f.eventTime.length ? f.eventTime.join(' / ') : 'not known'}`,
        res && extraOf(res, 'zone') !== null ? `zone ${extraOf(res, 'zone')}` : 'zone not known',
        res && extraOf(res, 'tag1') !== null ? `tag1 ${extraOf(res, 'tag1')}` : 'tag1 not known',
        res && res.timeZone ? `cluster time zone ${timeZoneShort(res.timeZone)}` : null,
        res && res.state === 'other_tz' ? `this device ${offsetLabel(res.tzOffsetMinutes)} (other time zone)` : null,
        res && finite(res.rawGapMinutes) && finite(res.tzOffsetMinutes) ? `raw gap ${minutesText(res.rawGapMinutes)} − ${offsetLabel(res.tzOffsetMinutes)}` : null,
        every ? `measured every ${every} hour${every === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '))),
    h('div.ld-actions', S.range ? h('span.muted.ld-range', `${S.range.from} → ${S.range.to}`) : null,
      // The same run as Fetch now, narrowed to this device (docs/LOGDELAY.md "Fetch now" `device`).
      h('button.btn#ld-fetch-device', { type: 'button', title: `Re-measure ${device} now, by the scheduled measurement's own query`,
        onclick: () => fetchNowPress({ clusterIds: [clusterId], device, label: device }) }, 'Fetch this device'),
      h('a.btn#ld-open-logs', { href: ldHash('live', clusterId, device), title: `${device}: its logs over the page's time range` }, 'Open in logs ›'))));

  const bar = searchBar(clusterId, device, devField, f.extras || [], res);
  if (!res) return [head, bar, B.get('dev1:problem', entSig(ent), () => problem(ent, device))];
  const rid = objId(res);
  const lv = res.levels || {};
  // Facts, not statistics: no median, no average (the owner's rule).
  const tiles5 = B.get('dev1:tiles', rid, () => h('div.ld-kpis.ld-5',
    h('div.ld-kpi', { dataset: { kpi: 'now' } }, h(`b${late ? (res.state === 'critical' ? '.ld-crit' : '.ld-delay') : ''}`, res.state === 'unmeasured' ? 'can’t measure' : res.state === 'silent' ? 'silent' : minutesText(res.nowMinutes)), h('span', 'delay now')),
    h('div.ld-kpi', { dataset: { kpi: 'worst' } }, h('b', minutesText(res.worst && res.worst.minutes)), h('span', `worst · ${res.worst && finite(res.worst.at) ? whenText(res.worst.at, res.now) : 'not known'}`)),
    h('div.ld-kpi', { dataset: { kpi: 'episodes' } }, h('b', countText(res.episodes)), h('span', `delays · ${countText(res.solved)} solved`)),
    h('div.ld-kpi', { dataset: { kpi: 'lateMs' } }, h('b', durationText(res.lateMs)), h('span', `time late · ${pctText(res.latePct)} of the period`)),
    h('div.ld-kpi', { dataset: { kpi: 'docs' } }, h('b', docsText(res.docsPerDay)), h('span', `logs a day · ${finite(res.lastSilence) ? `${whenText(res.lastSilence, res.now)} last silence` : 'no silence'}`))));

  const rec = B.get('dev1:rec', rid, () => {
    const fnd = res.finding; const it = fixItem(fnd);
    return h('section.card.ld-rec#ld-recommendation',
      h('header', h('h2', 'Recommendation'),
        it ? h(`span.pill.ld-pill.${STEP_TONE[fnd.step] || 'grey'}`, h('i.dot'), it.title) : null,
        h('span.sub', it ? 'likely · from the delay pattern · the same words as the row’s “i”' : 'nothing matched')),
      h('div.body.ld-rec-body', it
        ? [h('div', h('b', fnd.step === 'unknown' ? 'Not known yet: ' : 'Why: '), it.cause),
          it.fix ? h('div', h('b', 'Fix: '), it.fix) : null,
          it.group ? h('div.muted', `Group: ${it.group}`) : null,
          evidenceText(fnd.evidence) ? h('div.muted', `Evidence: ${evidenceText(fnd.evidence)}`) : null,
          it.missing.length ? h('div.muted', `Would decide it: ${it.missing.join(', ')}`) : null]
        : h('div.muted', NO_FINDING)));
  });

  return [head, bar, tiles5, rec, B.get('dev1:graph', rid, () => graphCard(res, lv, every)), periodsCard(res, every)];
}

function searchBar(clusterId, device, devField, extras, res) {
  if (S.qFor !== `${clusterId}|${device}`) {
    S.qFor = `${clusterId}|${device}`;
    S.q = { name: device, field: devField, value: '', cluster: clusterId,
      from: (S.range && S.range.from) || (res && res.from) || '', to: (S.range && S.range.to) || (res && res.to) || '' };
    S.search = null;
  }
  if (!S.q.from && res) { S.q.from = res.from; S.q.to = res.to; }
  // Built once per device and kept: the answer arriving (which fills From and To) or a search
  // finishing changes the fields' values and the matches line in place, never the box being typed in.
  const form = B.get('dev1:search', `${S.qFor}|${devField}|${(extras || []).join(',')}|${clusters().length}`, () => {
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
      repaint();
      const r = await ldSearch({ name: q.name || undefined, field: q.value ? q.field : undefined, value: q.value || undefined,
        clusterIds: q.cluster ? [q.cluster] : [], from: q.from || undefined, to: q.to || undefined, max: 50, signal: ctl ? ctl.signal : undefined });
      if (r && r.kind === 'aborted') return;
      S.search = { state: r && r.ok ? 'ok' : 'error', res: r };
      const m = r && r.ok ? r.devices || [] : [];
      if (m.length === 1 && (m[0].device !== device || m[0].cluster !== clusterId)) location.hash = ldHash('device', m[0].cluster, m[0].device);
      repaint();
    };
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
        h('span.ld-q-found')));
  });
  for (const [sel, k] of [['#ld-q-from', 'from'], ['#ld-q-to', 'to']]) {
    const el = form.querySelector(sel);
    if (el && el !== document.activeElement && el.value !== (S.q[k] || '')) el.value = S.q[k] || '';
  }
  const found = form.querySelector('.ld-q-found');
  const searchSig = S.search ? `${S.search.state}:${objId(S.search.res)}` : '-';
  if (found && found.dataset.sig !== searchSig) {
    found.dataset.sig = searchSig;
    const r = S.search && S.search.res;
    mount(found, !S.search ? null
      : S.search.state === 'loading' ? h('span.muted', 'Searching…')
        : S.search.state === 'error' ? h('span.ld-crit', `Search failed: ${(r && (r.message || r.kind)) || 'no answer'}`)
          : h('span.muted#ld-matches', `Matches ${countText(r.matches ?? (r.devices || []).length)} device${(r.matches ?? (r.devices || []).length) === 1 ? '' : 's'}`,
            ...(r.devices || []).slice(0, 12).flatMap((d) => [' · ', link(ldHash('device', d.cluster, d.device), d.device, { title: `${d.device} on ${d.clusterName || d.cluster}` })]),
            r.truncated ? ' · more not shown: narrow the search' : ''));
  }
  return form;
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
    return h(`div.ld-band${b.critical ? '.ld-band-crit' : ''}`, { title: `${whenText(p.started, res.now)} → ${p.solved ? whenText(p.solved, res.now) : 'still late'}, worst ${minutesText(p.worstMinutes)}`,
      style: { left: `${b.left}%`, width: `${b.width}%` } });
  });
  const unknown = (res.points || []).filter((p) => p && !finite(p.m) && finite(p.t));
  const pic = svg('svg', { viewBox: `0 0 1000 ${H}`, preserveAspectRatio: 'none', role: 'img', class: 'ld-graph-svg',
    'aria-label': `Delay of ${res.device} over the period: ${(res.points || []).length} measurements, ${(res.periods || []).length} delays, worst ${minutesText(res.worst && res.worst.minutes)}` },
  ...g.segments.map((p) => svg('polyline', { points: p, fill: 'none', stroke: C.line, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' })),
  ...unknown.map((p) => svg('rect', { x: g.X(p.t) - 2, y: H - 6, width: 4, height: 6, fill: C.silent })));
  const marks = [];
  for (const p of res.periods || []) {
    if (finite(p.started) && p.started >= g.lo) marks.push(h('span.ld-mark.ld-mark-start', { title: `delay started ${whenText(p.started, res.now)}`, style: { left: `calc(${((p.started - g.lo) / (g.hi - g.lo || 1)) * 100}% - 5px)` } }, '▲'));
    if (finite(p.solved)) marks.push(h('span.ld-mark.ld-mark-solved', { title: `solved ${whenText(p.solved, res.now)}`, style: { left: `calc(${((p.solved - g.lo) / (g.hi - g.lo || 1)) * 100}% - 4px)` } }, '●'));
    else marks.push(h('span.ld-mark.ld-mark-open', { title: 'still late', style: { left: 'calc(100% - 10px)' } }, '◆'));
  }
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => g.lo + f * (g.hi - g.lo)).map((ms) => whenText(ms, 0).replace(/ \d\d:\d\d$/, ''));
  const ins = res.insights || {};
  const cell = (label, value, sub) => h('div.ld-ins', h('div.muted', label), h('b', value), sub ? h('span', ` ${sub}`) : null);
  const scale = [[g.scaleMax, `${g.scaleMax} min`], [lv.criticalOver, String(lv.criticalOver)], [lv.delayFrom, String(lv.delayFrom)], [0, '0']]
    .filter(([m]) => finite(m) && m <= g.scaleMax);
  return card('Delay over time', `each point is one ${every ? `${every}-hour ` : ''}measurement · shaded bands are delays, from start to solve`,
    [h('div.ld-graph',
      h('div.ld-yaxis', { style: { height: `${H}px` } }, ...scale.map(([m, t]) => h('span', { style: { top: `${y(m) - 7}px` } }, t))),
      h('div.ld-plot#ld-graph', { style: { height: `${H}px` } }, ...bandsEls, line(lv.criticalOver, C.crit), line(lv.delayFrom, C.delay), pic)),
    h('div.ld-marks', { 'aria-label': 'Delay starts and solves' }, ...marks),
    h('div.ld-ticks.ld-indent', ...ticks.map((t) => h('span', t))),
    h('div.muted.ld-indent.ld-tiny', '▲ delay started · ● solved · ◆ still late · ', h('i.ld-sq', { style: { background: C.silent } }), ' silent or can’t measure (no dot, never 0 min)'),
    // Facts about the period: the peak, the longest delay, when delays begin. No average.
    h('div.ld-insights.ld-3',
      cell('Peak', minutesText(ins.peak && ins.peak.minutes, 'not known'), ins.peak && finite(ins.peak.at) ? whenText(ins.peak.at, res.now) : null),
      cell('Longest delay', ins.longest ? durationText(ins.longest.lastedMs) : 'not known', ins.longest && finite(ins.longest.started) ? `${whenText(ins.longest.started, res.now)} → ${finite(ins.longest.solved) ? whenText(ins.longest.solved, res.now) : 'still late'}` : null),
      cell('Late most often', ins.lateMostOften ? ins.lateMostOften.label : 'not known', ins.lateMostOften ? `${ins.lateMostOften.count} of ${ins.lateMostOften.of} delays began then` : null))],
    [legend(key(C.line, 'Delay', { line: true }), key(C.delay, `${lv.delayFrom ?? '?'} min`, { dash: true }), key(C.crit, `${lv.criticalOver ?? '?'} min`, { dash: true }))]);
}

function periodsCard(res, every) {
  return B.get('dev1:periods', `${objId(res)}|${sortSig(sorts.periods)}`, () => {
    const rows = sorts.periods.apply((res.periods || []).slice().sort((a, b) => (b.started || 0) - (a.started || 0)), {
      started: { type: 'date', value: (p) => p.started },
      solved: { type: 'date', value: (p) => p.solved },
      lasted: { type: 'duration', value: (p) => p.lastedMs },
      worst: { type: 'number', value: (p) => p.worstMinutes },
      state: { type: 'number', value: (p) => stateRank(p.worstState), start: -1 },
      pattern: { type: 'text', value: (p) => p.pattern },
      zone: { type: 'text', value: (p) => extraOf(p, 'zone') ?? extraOf(res, 'zone') },
      tag1: { type: 'text', value: (p) => extraOf(p, 'tag1') ?? extraOf(res, 'tag1') },
      measurements: { type: 'number', value: (p) => p.measurements },
    }).map((p) => {
      const zone = extraOf(p, 'zone') ?? extraOf(res, 'zone'); const tag1 = extraOf(p, 'tag1') ?? extraOf(res, 'tag1');
      return h(`tr${p.solved ? '' : '.ld-open'}`,
        h('td', whenText(p.started, res.now)),
        h('td', p.solved ? whenText(p.solved, res.now) : statePill('critical', 'still late')),
        h('td.num', `${durationText(p.lastedMs)}${p.solved ? '' : ' so far'}`),
        h('td.num', minutesText(p.worstMinutes)), h('td', stateText(p.worstState)),
        h('td', p.pattern ? p.pattern : h('span.muted', '—')),
        h('td', zone === null ? h('span.muted', '—') : String(zone)), h('td', tag1 === null ? h('span.muted', '—') : String(tag1)),
        h('td.num', countText(p.measurements)));
    });
    const sil = (res.silences || []).map((s) => `${whenText(s.from, res.now)} → ${finite(s.to) ? whenText(s.to, res.now) : 'still silent'}${finite(s.burstDocs) ? ` (then ${countText(s.burstDocs)} logs${finite(s.burstMinutes) ? `, ${minutesText(s.burstMinutes)} late` : ''})` : ''}`);
    return card('Every delay', 'started = first measurement at the delay level or later · solved = first measurement back under it',
      [h('div.tbl-wrap', h('table.tbl#ld-periods',
        sortHead(sorts.periods, [['started', 'Started'], ['solved', 'Solved'], ['lasted', 'Lasted', 1], ['worst', 'Worst delay', 1], ['state', 'Worst state'], ['pattern', 'Looks like'],
          ['zone', 'zone'], ['tag1', 'tag1'], ['measurements', 'Measurements', 1]]),
        h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: 9 }, empty('No delay in this period.')))])))),
      footer(`A start or solve time is accurate to the ${every ? `${every}-hour ` : ''}measurement. `,
        sil.length ? `Silences (no logs at all) are listed separately: ${sil.join('; ')}.` : 'No silence in this period.',
        Array.isArray(res.olderMeasurements) && res.olderMeasurements.length ? ` ${countText(res.olderMeasurements.length)} older measurements read from the day files${res.olderTruncated ? ' (the first 20,000)' : ''}.` : '')]);
  });
}

/* ------------------------------------ the boards ------------------------------------ */

/**
 * The board a route names, as the nodes of its section: kept between draws, rebuilt card by
 * card. `ctx.repaint` redraws the page. Leaving a view (another route) lets go of its questions.
 * A device board sits beside the short device list of its cluster (the Devices tab's split).
 */
export function boardsNode(r, ctx) {
  repaint = ctx.repaint || repaint;
  const vk = `${r.view}|${r.clusterId}|${r.device}`;
  if (vk !== ctlFor) {
    boardsLeave();
    ctl = typeof AbortController === 'undefined' ? null : new AbortController();
    ctlFor = vk;
  }
  B.begin();
  try {
    const wrap = B.get(`wrap:${r.view}`, r.view, () => h('div.rp-section.ld', { dataset: { ld: r.view } }));
    if (r.view === 'device') {
      const split = B.get('split', '', () => h('div.ld-split', h('div.ld-split-list'), h('div.ld-split-board')));
      mount(split.firstChild, ...devicesView(r.clusterId, true).flat().filter(Boolean));
      mount(split.lastChild, ...deviceView(r.clusterId, r.device).flat().filter(Boolean));
      for (const tr of split.firstChild.querySelectorAll('tr[data-device]')) tr.classList.toggle('ld-sel', tr.dataset.device === r.device && tr.dataset.cluster === r.clusterId);
      mount(wrap, split);
      return wrap;
    }
    const kids = r.view === 'cluster' ? clusterView(r.clusterId)
      : r.view === 'devices' ? devicesView(r.clusterId)
        : fleetView();
    mount(wrap, ...kids.flat().filter(Boolean));
    return wrap;
  } finally { B.end(); }
}
