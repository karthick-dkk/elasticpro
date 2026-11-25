/**
 * The Log Delay page's boards (0.3.57 as Reports › Log delay; on the Log Delay page since 0.3.60;
 * redesigned in 0.3.62, docs/LOGDELAY.md "The Log Delay page"):
 *
 *   Dashboard  five count tiles (the three configured levels, another time zone, silent), the
 *              state bar, three chart panels over the period (the delay band, above the critical
 *              line, resolved delays — one y scale), By cluster with an "i" per cluster, Late
 *              devices over the day (a cluster × measurement-window grid), and one line naming
 *              the clusters the last run did not measure; the same for one cluster
 *   Summary    the fleet view of Reports › Log delay before 0.3.60: four tiles, Delay reduced, Day
 *              by day, a ring per cluster (drawn by logdelay/summary.js from the same answer)
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
 *
 * Log types (0.3.90, core/log-types.js): where the cluster's mapping has log_type, a device with only
 * some log types late reads "part delayed" — its own tile, chip, bar and share — and the device's
 * board has a line and a row per log type (logdelay/device-types.js). An older core sends none of it:
 * the boards are as they were.
 */

import { h, svg, mount } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { card, keptCard, empty } from '../pages/common.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { state, clusters } from '../core/state.js';
import { navigateTo, canOpenPage } from '../core/intent.js';
import { jobsList, jobRunDetail } from '../core/es.js';
import { LOGDELAY_JOB, lastFinishedRun, notMeasured } from '../core/job-detail.js';
import { refreshReports } from '../core/reports.js';
import { rememberLevels, logTypeFieldOf, isPart } from '../core/delay-levels.js';
import { download, toCsv } from '../lib/fmt.js';
import {
  LD_COLOURS as C, lastRunChange, ldSummary, ldCluster, ldDevice, ldSearch, ldReportRun, ldHash,
  minutesText, durationText, whenText, pctText, countText,
  stateText, rowStateText, typesNotRead, noDelayOf, noDelaySplit, noDelayOfText, shareText, eventFieldsText, measuredAge, staleText, lateTime, logsADay, axisTicks, byTimeLate, filterRows, deviceGraph, periodBands, lastedText, STEP_TONE, stepLabel, evidenceText, extraOf, valuesText,
  DEVICE_FILTERS, matchesFilter, filterCounts, behindSeries, niceStep, labelEvery,
  lateGridRows, lateAtWindow, windowHeads, windowsPerDay, gridShade, gridHue, vsText, GRID_WORST, dayText,
  scheduleOf, fixItem, NO_CLUSTER_FIX_TEXT, timeZoneCell, matchesZone, tileCounts, bands, sharedLevels, rowLate, dayChartDays,
  LD_NEVER_MEASURED, LD_SCHEDULE_OFF, LD_NO_SCHEDULER, noDeviceTotal, noDeviceLine, partOf, partText, partLateText,
  typesUnreadLine,
} from '../core/logdelay-report.js';
import { deviceTable, sortCols, extraCols, statePill, stateRank, withTypes } from './rows.js';
import { LOG_TYPE_FIELD, hasTypes, saysTypes, seriesLate, typeLabel, typesHeadline } from '../core/log-types.js';
import { typesGraphCard, typesTableCard, typeDelays, byLogTypeCard, partFill } from './device-types.js';
import { fixButton, fixesFor, NO_FINDING } from './fix-popover.js';
import { fetchNowPress } from './fetch-now.js';
import { measureAgainButton } from './measure-again.js';
import { summaryCards } from './summary.js';
import { normaliseRange, rangeBounds, rangeWords, zonedParts, zonedText, fromZonedInput, BOARD_RANGES } from '../core/log-range.js';
import { timeZoneText, timeZoneShort, offsetLabel } from '../core/log-tz.js';

const PAGE_ROWS = 50;
/** By cluster: the most delayed clusters shown by default, and a page of them once expanded (the owner's figures). */
const CLUSTER_TOP = 5;
const CLUSTER_PAGE = 30;

/** What the boards keep between draws: the choices made and the answers read. */
const S = {
  period: 'span',        // 'today' when the window is inside one local day (by measurement window), else 'span' (by day)
  win: { from: '', to: '' },   // the window's local days, as the messages take them
  pk: '',                // `${win.from}..${win.to}`: in every cache key
  rng: normaliseRange(null, BOARD_RANGES), zone: '',
  tz: null,             // the time-zone filter of the address (`?tz=`): an offset, 'none', or null
  clAll: false, clPage: 0,   // By cluster: every cluster (30 a page) instead of the 5 most delayed
  devFilter: '', devAll: false, devState: 'all', devZone: '', devTag: '',
  cdFilter: '', cdAll: false,
  // Which devices a list holds (the owner, 2026-11-17: "by default only delayed"): 'delayed' — the
  // delay band and above the critical line (delay-levels.js isLate) — or 'all'. Never remembered:
  // each visit starts on the delayed devices (boardsReset).
  devSet: 'delayed', cdSet: 'delayed',
  // Late devices over the day: late (the delay band and above) or above the critical line only;
  // the worst GRID_WORST clusters or every one; the window a cell opened a cluster at.
  gridMode: 'late', gridAll: false, focusWin: null,
  q: { name: '', field: '', value: '', cluster: '', from: '', to: '' },
  qFor: '',
  range: null,           // {from, to} the device page was narrowed to by Show
  search: null,          // {state, res}
  // The device graph's log types: which device, the lines drawn (series key → colour slot; null: the worst six), the rest shown.
  types: { for: '', slots: null, more: false }, byTypeAll: false,
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
  S.devSet = 'delayed'; S.cdSet = 'delayed';
  S.gridMode = 'late'; S.gridAll = false; S.focusWin = null;
  S.types = { for: '', slots: null, more: false }; S.byTypeAll = false;
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

/**
 * The cluster the app's chooser (the top bar's `#cluster-select`, state.selected) names; null for
 * every cluster. The page has no cluster select of its own since 0.3.63: one choice for the whole
 * app, and the Log Delay address follows it (pages/log-delay.js reconcile).
 */
export const pickId = () => (state.selected && state.selected !== 'all' && clusters().some((c) => c.id === state.selected) ? state.selected : null);
const ymdIn = (ms, tz) => { const p = zonedParts(ms, tz); return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`; };
/**
 * The window every board reads is the page's boards range (core/log-range.js BOARD_RANGES; Live
 * keeps its own): the store holds whole local days, so the summary is asked
 * for the days the window touches — a day range is exactly its days, 7d the 7 ending today (an
 * incomplete custom range asks for today). Where the window holds no scheduled run, windowNote says so.
 */
export function boardsSetWindow(range, tz, now = Date.now()) {
  const rng = normaliseRange(range, BOARD_RANGES);
  const b = rangeBounds(rng, now, tz) || { from: now, to: now };
  const win = { from: ymdIn(b.from, tz), to: ymdIn(b.to, tz) };
  const pk = `${win.from}..${win.to}`;
  if (pk !== S.pk) S.range = null;
  Object.assign(S, { win, pk, rng, zone: tz, period: win.from === win.to ? 'today' : 'span' });
}
const winQuery = () => ({ from: S.win.from, to: S.win.to });

/** "No scheduled measurement in the last 30 minutes — last run 11:40": said where the window is after the last run, never zeros. */
function windowNote(lastRunAt, nowMs) {
  const b = rangeBounds(S.rng, nowMs, S.zone);
  if (!b || (finite(lastRunAt) && lastRunAt >= b.from)) return null;
  const when = !finite(lastRunAt) ? 'no run yet'
    : (ymdIn(lastRunAt, S.zone) === ymdIn(nowMs, S.zone) ? zonedText(lastRunAt, S.zone, { seconds: false }).slice(11) : zonedText(lastRunAt, S.zone, { seconds: false }));
  return h('div.banner.warn#ld-window-note', `No scheduled measurement in ${rangeWords(S.rng)} — ${finite(lastRunAt) ? `last run ${when}` : when}. The figures below are the store’s for ${S.win.from === S.win.to ? S.win.from : `${S.win.from} – ${S.win.to}`}.`);
}
/**
 * What the figures are of, under the tiles: the state now is the last run's, so it says when that
 * was (the oldest and the newest when the clusters differ), and the days the period figures cover —
 * the store keeps whole days, so a range shorter than a day says what is really covered.
 */
function asOfLine(byCluster, nowMs, notMeasuredN = 0) {
  const runs = (byCluster || []).map((c) => c.lastRunAt).filter(finite);
  const lo = runs.length ? Math.min(...runs) : null; const hi = runs.length ? Math.max(...runs) : null;
  const short = { '30m': 1, '1h': 1, '2h': 1, '4h': 1, '8h': 1, '12h': 1 }[S.rng.id];
  const days = S.win.from === S.win.to ? dayText(S.win.from) : `${dayText(S.win.from)} – ${dayText(S.win.to)}`;
  return h('div.muted.ld-note#ld-as-of', [
    lo === null ? 'never measured' : whenText(lo, nowMs) === whenText(hi, nowMs) ? `“now” is as of the last run, ${whenText(hi, nowMs)}` : `“now” is as of each cluster’s last run, ${whenText(lo, nowMs)} to ${whenText(hi, nowMs)}`,
    notMeasuredN ? `${countText(notMeasuredN)} of ${countText((byCluster || []).length)} clusters never measured` : '',
    `figures over time cover ${days}${short ? ` whole, not only ${rangeWords(S.rng)}: the store keeps whole days` : ''}`].filter(Boolean).join(' · '));
}
const isNever = (c) => !c || c.lastRunAt === null || c.lastRunAt === undefined;
const allNever = (byCluster) => Array.isArray(byCluster) && byCluster.length > 0 && byCluster.every(isNever);
const lastRunOf = (byCluster) => (byCluster || []).reduce((m, c) => (finite(c.lastRunAt) && (m === null || c.lastRunAt > m) ? c.lastRunAt : m), null);

/** The one cluster a route or the pick names; null for every cluster. */
export function boardsScopeId(r) {
  if (r && (r.view === 'cluster' || r.view === 'device') && r.clusterId) return r.clusterId;
  if (r && (r.view === 'devices' || r.view === 'summary') && r.clusterId) return r.clusterId;
  return pickId();
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
  const o = scheduleOf(res);
  return {
    schedule: sch, levels: lv, delayFrom: lv ? lv.delayFrom : null,
    everyHours: o.everyHours,
    // The schedule's own last run only (not the clusters'), as this note always read it.
    lastRunAt: sch && finite(sch.lastRunAt) ? sch.lastRunAt : null, nextDueAt: o.nextDueAt,
    sig: res ? `${objId(res)}` : '-',
  };
}

/**
 * The device rows of the answer in view — one cluster's (a cluster or device address) or the
 * summary's for the cluster picked — before the time-zone filter: what the Expand panel counts.
 */
export function boardsZoneRows(r) {
  const id = r && (r.view === 'cluster' || r.view === 'device') ? r.clusterId : null;
  if (id) {
    for (const [k, e] of S.cache) if (k.startsWith(`cl|${id}|`) && e.state === 'ok' && e.res) return e.res.devices || [];
    return [];
  }
  const ids = r && r.view === 'devices' && r.clusterId ? [r.clusterId] : pickId() ? [pickId()] : [];
  const e = S.cache.get(`sum|${S.pk}|${ids.join(',')}`);
  return e && e.state === 'ok' && e.res ? e.res.devices || [] : [];
}

/** The share of devices a zone needs before it is detected, as the core says it (60 unless it says otherwise). */
export function boardsMajorityPercent() {
  for (const e of S.cache.values()) {
    if (e.state !== 'ok' || !e.res) continue;
    const tz = e.res.timeZone || ((e.res.byCluster || []).find((c) => c.timeZone) || {}).timeZone;
    if (tz && finite(tz.majorityPercent)) return tz.majorityPercent;
  }
  return 60;
}

/** The time-zone filter in words, for a head line; '' when none. */
const tzWords = () => (S.tz === null ? '' : S.tz === 'none' ? 'devices whose cluster zone is not detected only' : `devices at ${offsetLabel(S.tz)} only`);

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
  types: tableSort('logdelay.types', { onChange: sorted }),
  byType: tableSort('logdelay.by-type', { onChange: sorted }),
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

/**
 * Open Devices on a level (a tile, a chart bar): that level's devices are what was asked for, so a
 * level that is not delayed (below the line, another time zone, silent) shows every device's set.
 */
const LATE_FILTERS = ['late', 'delay', 'critical', 'part'];
function openDevicesOn(filter, scopeId) {
  S.devState = filter; S.devAll = false;
  if (!LATE_FILTERS.includes(filter)) S.devSet = 'all';
  location.hash = ldHash('devices', scopeId, null, { tz: S.tz });
}
/** Whether a row is in the set a list holds: every device, or the delayed and part delayed ones only. */
const inSet = (set) => (r) => set === 'all' || rowLate(r) || isPart(r.state);
/** "12 delayed", or "12 delayed · 3 part delayed" where log types are measured and some are. */
function lateWords(rows) {
  const part = rows.filter((r) => isPart(r.state)).length;
  return `${countText(rows.filter(rowLate).length)} delayed${part ? ` · ${countText(part)} part delayed` : ''}`;
}
/** The button that swaps a list's set: "Show all devices N" ⇄ "Show delayed only". Its words are set in place each draw. */
function setButton(id, onPress) {
  return h(`button.btn.sm.ld-set-btn#${id}`, { type: 'button', onclick: onPress }, h('span'), ' ', h('b'));
}
function setButtonWords(btn, set, total) {
  if (!btn) return;
  const words = set === 'all' ? 'Show delayed only' : 'Show all devices';
  const n = set === 'all' ? '' : countText(total);
  if (btn.firstChild.textContent !== words) btn.firstChild.textContent = words;
  if (btn.lastChild.textContent !== n) btn.lastChild.textContent = n;
  btn.setAttribute('aria-pressed', String(set === 'all'));
  btn.title = set === 'all' ? 'List the delayed devices only (30–60 min and above 60 min by the configured levels; part delayed ones too)' : 'List every device, on time, silent and in another time zone too';
}
/** What an empty list says while it holds the delayed devices only: none is delayed, or none matches; and the way to every device. */
function delayedEmpty(anyDelayed, narrowed, showAll) {
  return [anyDelayed || narrowed ? 'No delayed device matches. Clear the search or pick another level' : 'No delayed devices', ' · ',
    h('button.linkish.ld-show-all', { type: 'button', onclick: showAll }, 'Show all devices')];
}

function problem(ent, what) {
  if (ent.state === 'loading') return h('div.tbl-empty.ld-loading', h('span.spin'), ` Reading ${what}…`);
  const r = ent.res || {};
  if (r.unsupported) return h('div.banner.warn', r.message);
  if (r.kind === 'no_store') return h('div.banner.warn', 'The log delay report needs ElasticPro’s data directory, and this server has none.');
  if (r.kind === 'not_found') return empty(`${what} is not in the store.`, { detail: r.message || 'A device not seen for 7 days is forgotten.' });
  return h('div.banner.err', `${what} could not be read: ${r.message || r.kind || 'no answer'}`);
}

// The band names ("Below 30 min", "30–60 min", "Above 60 min") are core/logdelay-report.js bands(): the
// Clusters › Overview card reads the same names. The levels a summary's clusters share: sharedLevels() there.

/** Above the figures of a summary: the scheduled measurement is not run here, or is switched off. */
function scheduleNotice(res) {
  return !res.schedule || res.schedule.supported === false
    ? h('div.banner.warn', LD_NO_SCHEDULER)
    : res.schedule.enabled === false
      ? h('div.banner.warn', `${LD_SCHEDULE_OFF} `,
        h('button.linkish', { type: 'button', onclick: () => navigateTo('settings', { section: 'schedule' }) }, 'Config-Management › Data › Scheduled log delay'))
      : null;
}

/** "Send now" covers the period shown (the bar's time range). Building a report by hand is
 *  Config › Reports' Download now, with its own clusters and period (0.3.78: not on the boards). */
const reportPeriod = (res, fallback) => (res && res.from ? { from: res.from, to: res.to } : fallback);

async function mailNow(btn, clusterIds, res) {
  const yes = await confirmDialog('Mail the log delay report now?',
    `It goes to the log delay schedule’s recipients, covering ${(res && res.label) || 'the period shown'}, with its .xlsx and .csv.`, { yes: 'Mail now' });
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

/** A cluster whose last run was cut or failed: said above the figures. */
function readNotes(items) {
  const bad = items.filter((x) => x.lastRead && (x.lastRead.truncated || x.lastRead.complete === false || x.lastRead.error));
  if (!bad.length) return null;
  return h('div.banner.warn.ld-flat',
    bad.map((x) => h('div', `${x.name}: the last run ${x.lastRead.truncated ? 'stopped at the device cap, so the devices after it are not in the figures; raise ' : 'did not read every device'}`,
      x.lastRead.truncated ? [h('b', capSetting), '.'] : '.')));
}

/**
 * Documents without a device name (the owner, 0.3.77: not a note per cluster above the figures):
 * one quiet line, summed over the clusters in view (noDeviceTotal); `where` says where each
 * cluster's count is (the Dashboard's How the last run read each cluster). Null when none.
 */
function noDeviceNote(byCluster, where = '') {
  const sum = noDeviceTotal(byCluster);
  const unread = typesUnreadNote(byCluster);
  if (!sum) return unread;
  const note = h('div.muted.ld-note#ld-nodevice-note', { title: 'Documents in the last run’s window whose device field is empty: they are in no bucket, so no device’s delay or count includes them. Check the parser’s device field.' },
    `${noDeviceLine(sum)}.${where ? ` ${where}` : ''}`);
  return unread ? h('div', note, unread) : note;
}

/** The devices whose log types the last run did not come to: said wherever their counts are shown. */
function typesUnreadNote(items) {
  const line = typesUnreadLine(items);
  return line ? h('div.ld-note.ld-types-unread', line) : null;
}

/** One cluster's three counts, one line, with what each means. */
function countsLine(counts) {
  if (!counts) return null;
  return h('div.muted.ld-note#ld-counts', { title: COUNT_HINT },
    h('span', h('b', countText(counts.inLastRun)), ' in the last run'), ' · ',
    h('span', h('b', countText(counts.now)), ' now'), ' · ',
    h('span', h('b', countText(counts.inRange)), ' in range'));
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
 * The count tiles — five, six with Part delayed (0.3.90: partOf, where the core measures log types): No delay (noDelayOf: on time, silent and can't measure together, the split
 * under it), the delay band, above the critical line, another time zone, silent. Each opens the
 * Devices tab on that filter. A figure the core did not give reads "—", never 0; can't-measure
 * devices are said under Silent (they have no figure either).
 */
function tiles(t, b, scopeId, keyPrefix, unmeasured = false, everyHours = null, whyNone = '', clustersOf = []) {
  const part = partOf(t, clustersOf);
  if (unmeasured) { t = {}; }
  const nd = noDelayOf(t, { why: whyNone });
  const cnt = (v) => (unmeasured ? '—' : countText(v));
  const note = (d) => (unmeasured ? 'not measured yet' : d);
  // Not measured: a plain tile (no Devices link: nothing to list) carrying the ↻ Measure again button.
  const tile = (k, filter, label, value, colour, detail) => (unmeasured
    ? h('div.ld-kpi', { dataset: { kpi: k } }, h('span.ld-kpi-l', colour ? sw(colour) : null, label), h('b', value), h('span', detail),
      scopeId ? measureAgainButton({ clusterIds: [scopeId], devices: 'all', label: nameOf(scopeId) }, { zone: S.zone, everyHours }) : null)
    : h('button.ld-kpi.ld-kpi-btn', {
      type: 'button', dataset: { kpi: k }, title: `Open Devices: ${label.toLowerCase()}`,
      onclick: () => openDevicesOn(filter, scopeId),
    }, h('span.ld-kpi-l', colour ? sw(colour) : null, label), h('b', value), h('span', detail)));
  // No cluster has log_type: a plain tile with "—" and why (nothing to list).
  const partTile = !part ? null : !unmeasured && part.count === null
    ? h('div.ld-kpi', { dataset: { kpi: 'part' } }, h('span.ld-kpi-l', partFill('i.ld-sw'), 'Part delayed'), h('b', '—'), h('span', part.why))
    : tile('part', 'part', 'Part delayed', cnt(part.count), null, unmeasured ? 'not measured yet' : [part.pct === null ? '' : `${shareText(part.pct)} · `, partText(part)]);
  if (partTile && !unmeasured && part.count !== null) partTile.querySelector('.ld-kpi-l').prepend(partFill('i.ld-sw'));
  return h(`div.ld-kpis.${partTile ? 'ld-6' : 'ld-5'}#${keyPrefix}-tiles`,
    tile('below', 'noDelay', 'No delay', cnt(nd.count), C.ok, unmeasured ? 'not measured yet' : [h('b', nd.pct ? shareText(nd.pct.noDelay) : ''), nd.pct ? ' · ' : '', nd.pct ? noDelaySplit(nd) : `${noDelaySplit(nd, { counts: true })}${nd.why ? ` · no percentage: ${nd.why}` : ''}`, nd.pct && nd.of ? ` · ${noDelayOfText(nd)}` : '']),
    tile('delay', 'delay', b.mid, cnt(t.delay), C.delay, note('delay')),
    tile('critical', 'critical', b.high, cnt(t.critical), C.crit, note('critical')),
    partTile,
    tile('tz', 'tz', 'Other time zone', cnt(t.otherTz), C.tz, note('not counted as late')),
    tile('silent', 'silent', 'Silent', cnt(t.silent), C.silent, unmeasured ? 'not measured yet' : nd.cant ? `no logs · ${countText(nd.cant)} can’t measure` : 'no logs for the silence limit'));
}

/* ------------------------------------ charts ------------------------------------ */

/**
 * The three chart panels (the owner's rule, prototype v25): devices in the delay band, devices
 * above the critical line, and the delays solved (devices back below the line), one bucket per
 * day of the period or per measurement window for Today, on one shared y scale. No stacking, no
 * overlay line. Each bar carries its words as a title; a click opens Devices on that level. A
 * bucket the core has no figure for is a hatched gap, never 0.
 */
function chartPanels(res, period, b, scopeId) {
  const data = behindSeries(res, period);
  const n = data.length;
  const series = [
    ['delay', `${b.mid} behind`, C.delay, 'delay', (d) => d.delay],
    ['critical', `${b.high} behind`, C.crit, 'critical', (d) => d.critical],
    ['back', 'Resolved log delays', C.ok, 'ok', (d) => d.back],
  ];
  const max = Math.max(1, ...data.flatMap((d) => series.map(([, , , , v]) => v(d) || 0)));
  const step = niceStep(max); const top = Math.ceil(max / step) * step;
  const W = 420, H = 190, L = 34, R = 6, T = 10, Bm = 24;
  const y = (v) => T + (H - T - Bm) * (1 - v / top);
  const slot = n ? (W - L - R) / n : W - L - R;
  const bw = Math.max(2, Math.min(14, slot * 0.58));
  const every = labelEvery(n);
  const sub = `devices · ${period === 'today' ? 'by measurement window' : 'by day'} · ${(res && res.label) || ''}`;
  const panel = ([key, title, colour, filter, value]) => {
    const kids = [];
    for (let v = 0; v <= top; v += step) {
      kids.push(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v ? 'ld-grid' : 'ld-axis' }));
      kids.push(svg('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end' }, String(v)));
    }
    data.forEach((d, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const val = d.gap ? null : value(d);
      const unknown = val === null || val === undefined;
      const g = svg('g', { class: `ld-bar${unknown ? ' ld-bar-gap' : ''}`, role: unknown ? null : 'link', onclick: unknown ? null : () => openDevicesOn(filter, scopeId) });
      g.append(svg('title', {}, unknown ? `${d.label} · ${d.gap ? 'no measurement' : 'not counted by this core'}` : `${d.label} · ${countText(val)} device${val === 1 ? '' : 's'}${d.complete ? '' : ' · not over'} · opens Devices`));
      if (unknown) g.append(svg('rect', { x, y: T, width: bw, height: H - T - Bm, class: 'ld-gap-fill' }));
      else if (val > 0) {
        const y1 = y(val); const hgt = Math.max(0.5, y(0) - y1); const r = Math.min(3, hgt, bw / 2);
        g.append(svg('path', { d: `M${x},${y1 + hgt} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y1 + hgt} Z`, fill: colour }));
      }
      g.append(svg('rect', { x: L + i * slot, y: T, width: slot, height: H - T - Bm, fill: 'transparent' }));
      kids.push(g);
      if (i % every === 0) kids.push(svg('text', { x: L + i * slot + slot / 2, y: H - 6, 'text-anchor': 'middle' }, d.label));
    });
    return h('section.card.ld-chart-card', { dataset: { chart: key } },
      h('header', h('h2', sw(colour), ' ', title), h('span.sub', sub)),
      h('div.body', h('div.ld-chartbox', n
        ? svg('svg', { class: 'ld-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', id: `ld-chart-${key}`, 'aria-label': `${title}: at most ${max} ${period === 'today' ? 'per window' : 'per day'}` }, ...kids)
        : h('div.tbl-empty', 'Nothing measured in this period.'))));
  };
  return h('div.ld-charts3#ld-charts', ...series.map(panel));
}

/**
 * Late devices over the day (0.3.82, replaces the heat map): one row per cluster — the name
 * kept in view, Late now, vs yesterday — then a cell per measurement window of today with the
 * devices late at that window's measurement (lateGridRows). A window that ended with no
 * measurement is hatched "not measured", never an earlier reading carried forward; the window in
 * progress with no reading yet is "pending" (light dots, when the next run is due); one not
 * begun yet is blank. Before today's first run, Late now is yesterday's last measurement, labelled.
 * A cell is green at 0, yellow when devices were late, red when one of them was above the critical
 * line (gridHue), stronger on its own row's scale. A cell opens the cluster at that window.
 */
function lateGrid(res, b) {
  const every = finite(res.everyHours) ? res.everyHours : null;
  const n = windowsPerDay(every) || 0;
  const all = lateGridRows(res.byCluster, every, S.gridMode);
  const rows = S.gridAll ? all : all.slice(0, GRID_WORST);
  const heads = windowHeads(every);
  const what = S.gridMode === 'critical' ? b.high.toLowerCase() : b.late;
  if (!all.length || !n) return h('div.tbl-empty', !n ? 'The measurement interval is not known, so the day’s windows are not either.' : 'No cluster you can see is measured.');
  const hm = (ms) => zonedText(ms, S.zone, { seconds: false }).slice(11);
  const tr = (r) => {
    const kids = [h('th.ld-g-nm', { scope: 'row' }, link(clusterHref(r.id), r.name, { title: `${r.name} · log delay details` }))];
    if (r.never) {
      kids.push(h('td.ld-g-never', { colspan: n + 3 }, h('span.muted', LD_NEVER_MEASURED), ' ', measureAgainButton({ clusterIds: [r.id], devices: 'all', label: r.name }, { zone: S.zone, everyHours: res.everyHours })));
      return h('tr', { dataset: { cluster: r.id } }, ...kids);
    }
    // Late now is the last measurement; before today's first run that is yesterday's last, said so.
    const yday = r.lastBeforeToday;
    kids.push(h(`td.num.ld-g-now${yday ? '.ld-g-yday' : ''}`, {
      title: yday ? `devices ${what} at yesterday’s last measurement — no run yet today${finite(r.nextAt) ? ` (next due about ${hm(r.nextAt)})` : ''}` : `devices ${what} now (the last measurement)`,
    }, countText(r.lateNow), yday ? h('small.muted.ld-g-ytag', ' yday') : null));
    kids.push(h(`td.num.ld-g-vs${finite(r.vs) && r.vs > 0 ? '.ld-g-up' : finite(r.vs) && r.vs < 0 ? '.ld-g-dn' : ''}`,
      { title: finite(r.vs) ? (yday ? 'yesterday’s last measurement against the same window a day before it' : 'now against yesterday’s measurement of the same window as the last run') : 'the same window a day earlier was not measured: not known' },
      finite(r.vs) ? vsText(r.vs) : h('span.muted', '—')));
    for (const c of r.cells) {
      const label = c.w && c.w.label ? c.w.label : `${heads[c.i]}:00`;
      if (c.state === 'future') { kids.push(h('td.ld-gc.ld-g-fut', { title: `${label} · not begun yet` })); continue; }
      if (c.state === 'pending') { kids.push(h('td.ld-gc.ld-g-pend', { title: `${r.name} · ${label} · pending — this window has not ended and has no reading yet${finite(r.nextAt) && r.nextAt > Date.now() ? `; next measurement about ${hm(r.nextAt)}` : ''}` })); continue; }
      if (c.state === 'missing') { kids.push(h('td.ld-gc.ld-g-na', { title: `${r.name} · ${label} · not measured — no run, or no logs from any device, in this window (never a copy of an earlier one)` }, '·')); continue; }
      const shade = gridShade(c.v, r.worst);
      const hue = gridHue(c.w, c.v);
      const open = () => openAtWindow(r.id, c.w);
      kids.push(h(`td.ld-gc.ld-gs-${shade}${hue ? `.ld-gs-${hue}` : ''}`, {
        role: 'button', tabindex: 0, dataset: { win: String(c.i) },
        title: `${r.name} · ${label} · ${countText(c.v)} device${c.v === 1 ? '' : 's'} ${what} at that window’s measurement${hue === 'crit' && S.gridMode !== 'critical' ? `, ${countText(c.w.criticalAt)} ${b.high.toLowerCase()}` : ''} · opens the cluster`,
        onclick: open, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
      }, countText(c.v)));
    }
    kids.push(h('td.num.ld-g-meas', { title: r.done ? `windows of today measured, of the ${countText(r.done)} ended so far (the window in progress counts once it has a reading) · ${countText(n)} in the day` : 'no window of today has ended yet' },
      r.done ? `${r.measured}/${r.done}` : h('span.muted', '—')));
    return h('tr', { dataset: { cluster: r.id } }, ...kids);
  };
  return [
    h('div.ld-grid-wrap', h('table.ld-grid#ld-late-grid',
      h('thead', h('tr', h('th.ld-g-nm', 'Cluster'), h('th.num', 'Late now'), h('th.num', 'vs yesterday'), ...heads.map((x) => h('th', x)), h('th.num', 'Measured'))),
      h('tbody', ...rows.map(tr)))),
    h('div.ld-foot.ld-g-legend',
      h('span', 'Strength = this cluster’s own scale (its worst window is strongest), so a quiet cluster’s rise still shows'),
      h('span.ld-key', h('i.ld-g-key.ld-gs-0'), '0'), h('span.ld-key', h('i.ld-g-key.ld-gs-3.ld-gs-late'), b.late), h('span.ld-key', h('i.ld-g-key.ld-gs-3.ld-gs-crit'), `some ${b.high.toLowerCase()}`),
      h('span.ld-key', h('i.ld-g-key.ld-g-na'), 'not measured — no run, or no logs from any device'),
      h('span.ld-key', h('i.ld-g-key.ld-g-pend'), 'pending — the window in progress, no reading yet')),
  ];
}

/** A cell of Late devices over the day pressed: that cluster's board, opened at that window (clusterView says which). */
function openAtWindow(id, w) {
  S.focusWin = w ? { cluster: id, from: w.from, label: w.label || '', mode: S.gridMode } : null;
  location.hash = clusterHref(id);
}

/** The grid's two toggles: Late / Above the critical line, Worst 10 / All N. */
function gridToggles(b, total) {
  const seg = (id, items, cur, set) => h(`div.seg#${id}`, { role: 'group' }, ...items.map(([v, text]) => h('button.btn.sm', {
    type: 'button', dataset: { v: String(v) }, 'aria-pressed': String(cur === v), onclick: () => { set(v); repaint(); } }, text)));
  return [
    seg('ld-grid-mode', [['late', `Late (${b.lateShort})`], ['critical', b.high]], S.gridMode, (v) => { S.gridMode = v; }),
    seg('ld-grid-rows', [[false, `Worst ${GRID_WORST}`], [true, `All ${countText(total)}`]], S.gridAll, (v) => { S.gridAll = v; }),
  ];
}

/**
 * The line about the last run (0.3.82, replaces "How the last run read each cluster"): shown
 * only when it did not fully measure every cluster — "k of N clusters not measured in the last
 * run", then each cluster with why and its fix — from the same per-cluster results Jobs › run
 * details keep (JOB_RUN_DETAIL of the last finished log delay run), so the two never disagree.
 * Kept to the clusters this viewer may see. Nothing when every cluster was read, or when the
 * details cannot be read (a guest, a core before 0.3.81).
 */
function notMeasuredLine(ent) {
  if (!ent || ent.state !== 'ok' || !ent.res || ent.res.none) return null;
  const sees = (id) => clusters().some((c) => c.id === id);
  const nm = notMeasured(ent.res, sees, canOpenPage);
  if (!nm) return null;
  const item = (m) => h('span.ld-nm-item', { dataset: { cluster: m.cluster, status: m.status } },
    h('b', nameOf(m.cluster)), ` · ${m.reason}`,
    m.fix && m.fix.page ? [' · ', h('a', { href: '#', title: m.fix.text, onclick: (e) => { e.preventDefault(); navigateTo(m.fix.page, null, { cluster: m.fix.cluster }); } }, m.fix.label.toLowerCase())] : null);
  return h('div.ld-notmeasured#ld-not-measured', { role: 'status' },
    h('b.ld-nm-head', `${countText(nm.missed.length)} of ${countText(nm.total)} cluster${nm.total === 1 ? '' : 's'} not measured in the last run`),
    ...nm.missed.map(item),
    canOpenPage('jobs') ? h('a.ld-nm-jobs', { href: '#/jobs', title: 'Jobs › Log delay measurement: its last run’s details' }, 'Run details in Jobs ›') : null);
}

/** The last finished log delay run's details, read again whenever the clusters' last run changes. */
function lastRunDetail(lastRunAt) {
  return need(`ldrun|${lastRunAt}`, async () => {
    const list = await jobsList({ jobId: LOGDELAY_JOB, limit: 5 });
    if (!list || !list.ok) return list || { ok: false, message: 'no answer' };
    const run = lastFinishedRun(list);
    if (!run) return { ok: true, none: true };
    const d = await jobRunDetail(run.id);
    return d && d.ok ? d : (d || { ok: false, message: 'no answer' });
  });
}

/**
 * The fleet's state bar under the tiles: one stacked bar of every device, with a counted legend
 * (No delay with its split, the delay band, above the critical line, part delayed where counted, another time zone). Counts are the core's totals, or the devices in the time-zone filter.
 */
function fleetStateBar(t, b) {
  const nd = noDelayOf(t);
  const parts = [[nd.count, C.ok, 'No delay'], [t.delay, C.delay, b.mid], [t.critical, C.crit, b.high], ...(nd.part === undefined ? [] : [[nd.part, C.part, 'Part delayed']]), [t.otherTz, C.tz, 'Other time zone']];
  const drawn = parts.filter(([v]) => finite(v) && v > 0);
  return h('div.ld-statebar#ld-statebar',
    drawn.length ? h('div.ld-stack', { role: 'img', 'aria-label': drawn.map(([v, , tx]) => `${tx} ${v}`).join(', ') },
      ...drawn.map(([v, colour, tx]) => h(`i${colour === C.part ? '.ld-part-fill' : ''}`, { style: { flex: `${v} 0 0`, background: colour }, title: `${tx}: ${countText(v)}` }))) : h('div.muted.ld-note', 'No device measured.'),
    legend(...parts.map(([v, colour, tx]) => h('span.ld-key', h(`i${colour === C.part ? '.ld-part-fill' : ''}`, { style: { background: colour } }), `${tx} `, h('b', countText(v)), tx === 'No delay' && v !== null ? h('span.muted', ` (${noDelaySplit(nd, { counts: true })})`) : null))));
}

/** By cluster's "Change": "+12 −5" — became late, came back — in today's window holding the last run (it can cover several runs); — unknown. */
function changeCell(k, b) {
  if (!k) return h('td.num', { title: 'no run today: the change is not known' }, h('span.muted', '—'));
  const title = `in today's window holding the last run (${k.label}): ${countText(k.up)} became late (${b.late}), ${countText(k.down)} came back below the line · net ${k.net > 0 ? '+' : ''}${countText(k.net)}`;
  if (!k.up && !k.down) return h('td.num', { title }, h('span.muted', '0'));
  return h('td.num.ld-change', { title },
    k.up ? h('span.ld-chg-up', `+${countText(k.up)}`) : null,
    k.up && k.down ? ' ' : null,
    k.down ? h('span.ld-chg-dn', `−${countText(k.down)}`) : null);
}

/** The mini stacked bar of a cluster's states, in the By cluster table. */
function stateBar(c, b) {
  const nd = noDelayOf(c);
  const parts = [[nd.count, C.ok, `No delay (${noDelaySplit(nd, { counts: true })})`], [c.delay, C.delay, b.mid], [c.critical, C.crit, b.high], [nd.part, C.part, 'Part delayed'], [c.otherTz, C.tz, 'Other time zone']]
    .filter(([v]) => finite(v) && v > 0);
  if (!parts.length) return h('span.muted', '—');
  return h('div.ld-statemini', { role: 'img', 'aria-label': parts.map(([v, , t]) => `${t} ${v}`).join(', ') },
    ...parts.map(([v, colour, t]) => h(`i${colour === C.part ? '.ld-part-fill' : ''}`, { style: { flex: `${v} 0 0`, background: colour }, title: `${t}: ${countText(v)}` })));
}

/* ------------------------------------ the dashboard ------------------------------------ */

function fleetView() {
  const ids = pickId() ? [pickId()] : [];
  const q = winQuery();
  const ent = need(`sum|${S.pk}|${ids.join(',')}`, (signal) => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const head = B.get('fleet:head', `${S.pk}|${ids.join(',')}|${entSig(ent)}`, () => {
    const mailBtn = h('button.btn.primary#ld-mail', { type: 'button', disabled: !res, onclick: (e) => mailNow(e.currentTarget, ids, res) }, 'Send now…');
    return h('div.ld-head',
      h('div.ld-title',
        h('h2', S.clusterPick === 'all' ? 'Every cluster' : nameOf(S.clusterPick))),
      h('div.ld-actions', mailBtn));
  });
  if (!res) return [head, B.get('fleet:problem', entSig(ent), () => problem(ent, 'The log delay summary'))];

  const lv = sharedLevels(res.byCluster);
  const b = bands(lv);
  const rid = objId(res);
  const t = res.totals || {};
  const scopeId = S.clusterPick === 'all' ? null : S.clusterPick;
  // The time-zone filter: the rows in that zone; the tiles and By cluster are counted from them
  // (the core's totals are for every zone), and the charts, which are the core's day totals, say so.
  const inView = S.tz === null ? null : (res.devices || []).filter((r) => matchesZone(r, S.tz));

  // No cluster in view has ever been measured: no counts, no charts, nothing that reads as 0.
  const none = allNever(res.byCluster);
  const notice = B.get('fleet:notice', rid, () => scheduleNotice(res));
  const readNote = B.get('fleet:readnote', rid, () => readNotes((res.byCluster || []).map((c) => ({ name: c.name || nameOf(c.id), lastRead: c.lastRead }))));
  const noDevNote = B.get('fleet:nodevice', rid, () => noDeviceNote(res.byCluster, 'Each cluster’s count: its board’s “Last run read” line.'));
  const tileRow = B.get('fleet:tiles', `${rid}|${scopeId}|${S.tz}`, () => tiles(inView ? tileCounts(inView) : t, b, scopeId, 'ld-fleet', none, null, none ? 'never measured' : '', res.byCluster));
  const asOf = B.get('fleet:asof', `${rid}|${S.pk}|${S.rng.id}`, () => asOfLine(res.byCluster, res.now, (res.byCluster || []).filter(isNever).length));
  const tzFilterNote = B.get('fleet:tzfilter', `${rid}|${S.tz}`, () => (inView
    ? h('div.muted.ld-note#ld-tz-filter-note', `Time zone filter: ${tzWords()} — ${countText(inView.length)} of ${countText((res.devices || []).length)} devices in the answer${res.devicesTruncated ? ' (the server sent the first ' + countText((res.devices || []).length) + ')' : ''}. The tiles and By cluster count these devices; the charts and Late devices over the day are the core’s totals for every zone.`)
    : null));
  const winNote = B.get('fleet:window', `${rid}|${S.pk}|${JSON.stringify(S.rng)}`, () => windowNote(lastRunOf(res.byCluster), res.now));
  const charts = none ? null : B.get('fleet:charts', `${rid}|${S.pk}|${scopeId}|${S.tz}`, () => chartPanels(res, S.period, b, scopeId));
  const gridDay = finite(res.now) ? dayText(zonedText(res.now, S.zone, { seconds: false }).slice(0, 10)) : '';
  const grid = B.get('fleet:grid', `${rid}|${S.gridMode}|${S.gridAll}`, () => {
    const el = card('Late devices over the day',
      `today${gridDay ? ` ${gridDay}` : ''} · per ${finite(res.everyHours) ? `${res.everyHours}-hour` : 'measurement'} window · devices late at the window’s measurement · worst clusters first`,
      lateGrid(res, b), gridToggles(b, (res.byCluster || []).length));
    el.id = 'ld-grid-card';
    return el;
  });

  const clusterCard = B.get('fleet:clusters', `${rid}|${sortSig(sorts.clusters)}|${S.tz}|${S.clAll}|${S.clPage}`, () => {
    // A cluster never measured has no figures: unknown, so it sorts last either way.
    const seen = (f) => (c) => (c.lastRunAt === null || c.lastRunAt === undefined ? null : f(c));
    const devsOf = (id) => (inView || res.devices || []).filter((d) => d.cluster === id);
    // With the time-zone filter on, a cluster's counts are its devices in that zone.
    const fromRows = (c) => {
      const rows = devsOf(c.id); const k = tileCounts(rows);
      const worstRow = rows.filter((d) => finite(d.nowMinutes)).sort((x, y) => y.nowMinutes - x.nowMinutes)[0];
      return { ...c, devices: k.devices, below: k.onTime, onTime: k.onTime, noDelay: undefined, pctNoDelay: undefined, cantMeasure: k.cantMeasure, lateBeforeSilent: k.lateBeforeSilent, partDelayed: k.partDelayed, pctPartDelayed: undefined, delay: k.delay, critical: k.critical, otherTz: k.otherTz, silent: k.silent, unmeasured: k.unmeasured,
        lateNow: k.delay + k.critical, latePct: k.devices ? Math.round(((k.delay + k.critical) / k.devices) * 1000) / 10 : null,
        worst: worstRow ? { device: worstRow.device, minutes: worstRow.nowMinutes, state: worstRow.state } : null };
    };
    const list = (res.byCluster || []).map((c) => (inView && c.lastRunAt !== null && c.lastRunAt !== undefined ? fromRows(c) : c));
    // The owner's default: the most delayed clusters first (devices at the delay level or more, now); never measured last.
    const byLate = [...list].sort((x, y) => {
      const nx = x.lastRunAt === null || x.lastRunAt === undefined; const ny = y.lastRunAt === null || y.lastRunAt === undefined;
      if (nx !== ny) return nx ? 1 : -1;
      return (y.lateNow || 0) - (x.lateNow || 0) || (y.critical || 0) - (x.critical || 0) || String(x.name || x.id).localeCompare(String(y.name || y.id));
    });
    const sortedAll = sorts.clusters.apply(byLate, {
      name: { type: 'text', value: (c) => c.name || nameOf(c.id) },
      timeZone: { type: 'number', value: seen((c) => (c.timeZone && finite(c.timeZone.offsetMinutes) ? c.timeZone.offsetMinutes : null)) },
      zone: { type: 'text', value: (c) => valuesText(devsOf(c.id), 'zone') },
      tag1: { type: 'text', value: (c) => valuesText(devsOf(c.id), 'tag1') },
      lateNow: { type: 'number', value: seen((c) => c.lateNow), start: -1 },
      latePct: { type: 'percent', value: seen((c) => c.latePct), start: -1 },
      change: { type: 'number', value: seen((c) => { const k = lastRunChange(c); return k ? k.net : null; }), start: -1 },
      critical: { type: 'number', value: seen((c) => c.critical), start: -1 },
      otherTz: { type: 'number', value: seen((c) => (c.timeZone && c.timeZone.mode !== 'none' ? c.otherTz : null)), start: -1 },
      devices: { type: 'number', value: (c) => c.devices, start: -1 },
      lastRun: { type: 'number', value: seen((c) => (c.counts ? c.counts.inLastRun : null)), start: -1 },
      worst: { type: 'number', value: seen((c) => (c.worst && c.worst.device ? c.worst.minutes : null)), start: -1 },
    });
    // The 5 most delayed by default; every cluster 30 a page when asked.
    const total = sortedAll.length;
    const pages = Math.max(1, Math.ceil(total / CLUSTER_PAGE));
    const page = Math.min(S.clPage, pages - 1);
    const shown = S.clAll ? sortedAll.slice(page * CLUSTER_PAGE, (page + 1) * CLUSTER_PAGE) : sortedAll.slice(0, CLUSTER_TOP);
    // Other time zone only when some cluster has a zone set or detected: otherwise every cell reads
    // "—" and the table no longer fits (owner's window, 0.3.77). Time zone always stays: it says why.
    const anyZone = sortedAll.some((c) => c.timeZone && c.timeZone.mode && c.timeZone.mode !== 'none');
    const cl = shown.map((c) => {
      const cb = bands(c.levels);
      const neverRun = c.lastRunAt === null || c.lastRunAt === undefined;
      const devs = devsOf(c.id);
      return h('tr', { dataset: { cluster: c.id } },
        h('td', link(clusterHref(c.id), c.name || nameOf(c.id), { title: `${c.name} · log delay details` })),
        // Always drawn: "not detected · 40 % agree" is the reason, not a blank (unknown is not zero).
        h('td.ld-tz-cell', { title: c.timeZone ? timeZoneText(c.timeZone) : 'not measured' }, neverRun ? h('span.muted', '—')
          : c.timeZone && c.timeZone.mode === 'none' ? h('span.muted', timeZoneCell(c.timeZone, offsetLabel)) : timeZoneCell(c.timeZone, offsetLabel)),
        h('td', { title: 'zones of the devices listed on Devices' }, valuesText(devs, 'zone')),
        h('td', { title: 'tag1 of the devices listed on Devices' }, valuesText(devs, 'tag1')),
        neverRun ? h('td', { colspan: anyZone ? 9 : 8 }, h('span.muted', LD_NEVER_MEASURED), ' ',
          measureAgainButton({ clusterIds: [c.id], devices: 'all', label: c.name || nameOf(c.id) }, { zone: S.zone }))
          : [h('td', stateBar(c, cb)),
            // Late now and its share in one cell: "12 · 3 %".
            h(`td.num${c.lateNow ? '.ld-delay' : ''}`, { title: `devices ${cb.late} now · their share of the cluster's devices` },
              countText(c.lateNow), h('span.muted', { title: c.notMeasured ? `no percentage: ${c.notMeasured}` : null }, ` · ${pctText(c.latePct)}`),
              finite(c.partDelayed) && c.partDelayed ? h('span.muted.ld-cl-part', { title: 'part delayed: only some of the device’s log types are late — not in the count before it' }, ` · ${countText(c.partDelayed)} part`) : null),
            changeCell(lastRunChange(c), cb),
            h(`td.num${c.critical ? '.ld-crit' : ''}`, countText(c.critical)),
            anyZone ? h('td.num', { title: 'devices whose logs are stamped in another time zone than the cluster’s: not late, counted apart (— when the cluster has no zone)' },
              c.timeZone && c.timeZone.mode !== 'none' ? countText(c.otherTz) : h('span.muted', '—')) : null,
            h('td.num', countText(c.devices)),
            h('td.num', { title: COUNT_HINT }, countText(c.counts && c.counts.inLastRun)),
            h('td.mono.ld-worst', c.worst && c.worst.device
              ? [link(ldHash('device', c.id, c.worst.device), c.worst.device, { title: `${c.worst.device} · delay details` }), h('span.muted', { title: c.worst.logType ? `log type ${c.worst.logType}` : null }, ` ${minutesText(c.worst.minutes)}`)]
              : h('span.muted', '—')),
            h('td.ld-acts', fixButton({ kind: 'cluster', id: c.name || c.id, items: () => clusterFixItems(c) }))]);
    });
    const go = (p) => { S.clPage = p; repaint(); };
    const foot = !S.clAll
      ? footer(`Showing the ${countText(Math.min(CLUSTER_TOP, total))} most delayed of ${countText(total)} cluster${total === 1 ? '' : 's'}`,
        total > CLUSTER_TOP ? [' · ', h('button.linkish#ld-cl-all', { type: 'button', onclick: () => { S.clAll = true; S.clPage = 0; repaint(); } }, `Show all ${countText(total)}`), ` · ${CLUSTER_PAGE} per page`] : null)
      : footer(`Showing ${countText(page * CLUSTER_PAGE + 1)}–${countText(Math.min(total, (page + 1) * CLUSTER_PAGE))} of ${countText(total)} clusters`, ' · ',
        h('button.linkish#ld-cl-prev', { type: 'button', disabled: page === 0, onclick: () => go(page - 1) }, '‹ Previous'), ' ',
        h('button.linkish#ld-cl-next', { type: 'button', disabled: page >= pages - 1, onclick: () => go(page + 1) }, 'Next ›'), ' · ',
        h('button.linkish#ld-cl-top', { type: 'button', onclick: () => { S.clAll = false; S.clPage = 0; repaint(); } }, `Show the top ${CLUSTER_TOP} only`));
    return card('By cluster', '',
      [h('div.tbl-wrap', h('table.tbl.ld-ctr#ld-by-cluster',
        sortHead(sorts.clusters, [['name', 'Cluster'], ['timeZone', 'Time zone'], ['zone', 'zone'], ['tag1', 'tag1'], [null, 'States'], ['lateNow', `${b.lateShort} · share`, 1], ['change', 'Change', 1],
          ['critical', b.high, 1], anyZone ? ['otherTz', 'Other time zone', 1] : null, ['devices', 'Devices', 1], ['lastRun', 'In last run', 1], ['worst', 'Worst device'], [null, '']].filter(Boolean)),
        h('tbody', ...(cl.length ? cl : [h('tr', h('td', { colspan: anyZone ? 13 : 12 }, empty('No cluster you can see is measured.')))])))), foot]);
  });
  const runEnt = lastRunDetail(lastRunOf(res.byCluster));
  const nmLine = B.get('fleet:notmeasured', `${entSig(runEnt)}|${clusters().length}`, () => notMeasuredLine(runEnt));
  const never = (res.byCluster || []).filter((c) => c.lastRunAt === null || c.lastRunAt === undefined);
  const neverNote = B.get('fleet:never', rid, () => (never.length && never.length < (res.byCluster || []).length
    ? h('div.muted.ld-note', `${never.length} cluster${never.length === 1 ? ' is' : 's are'} not measured yet: ${never.map((c) => c.name).join(', ')}.`) : null));
  const stateRow = none ? null : B.get('fleet:statebar', `${rid}|${S.tz}`, () => fleetStateBar(inView ? tileCounts(inView) : t, b));
  // The owner's order (prototype v25): tiles, the state bar, the three charts, By cluster, then
  // Late devices over the day (0.3.82) and the line about clusters the last run did not measure.
  return [head, notice, readNote, tileRow, asOf, stateRow, tzFilterNote, winNote, charts, clusterCard, grid, nmLine, noDevNote, neverNote];
}

/* ------------------------------------ the summary ------------------------------------ */

/**
 * The Summary tab (logdelay/summary.js draws it): the LOGDELAY_SUMMARY answer the Dashboard and
 * Devices read for the same clusters and days (one cache key), so moving between the tabs asks
 * nothing again. Its figures are the core's totals for every time zone: with the time-zone filter
 * in the address, a note says so instead of counting the rows again.
 */
function summaryView(clusterId) {
  const ids = clusterId ? [clusterId] : [];
  const q = winQuery();
  const ent = need(`sum|${S.pk}|${ids.join(',')}`, (signal) => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  if (!res) return [B.get('sum:problem', entSig(ent), () => problem(ent, 'The log delay summary'))];
  const rid = objId(res);
  const notice = B.get('sum:notice', rid, () => scheduleNotice(res));
  const readNote = B.get('sum:readnote', rid, () => readNotes((res.byCluster || []).map((c) => ({ name: c.name || nameOf(c.id), lastRead: c.lastRead }))));
  // Documents without a device name: one line under the cards, summed (the owner, 0.3.77).
  const noDevNote = B.get('sum:nodevice', rid, () => noDeviceNote(res.byCluster, clusterId ? '' : 'Each cluster’s count: its board’s “Last run read” line.'));
  const winNote = B.get('sum:window', `${rid}|${S.pk}|${JSON.stringify(S.rng)}`, () => windowNote(lastRunOf(res.byCluster), res.now));
  const tzNote = B.get('sum:tz', `${S.tz}`, () => (S.tz === null ? null
    : h('div.muted.ld-note#ld-sum-tz-note', `Summary counts every time zone (the core’s totals): the time-zone filter — ${tzWords()} — applies to Dashboard and Devices.`)));
  // Day by day covers at least the last 7 days (dayChartDays): a shorter range asks for those days
  // once more, its own question (no device rows), and only that card reads it.
  const win = dayChartDays(S.win, ymdIn(Date.now(), S.zone));
  const own = !win.widened && win.from === S.win.from && win.to === S.win.to;
  const dent = own ? ent : need(`sumdays|${win.from}..${win.to}|${ids.join(',')}`, (signal) => ldSummary({ from: win.from, to: win.to, clusterIds: ids, maxDevices: 1, signal }));
  const daysRes = dent.state === 'ok' ? dent.res : null;
  const cards = B.get('sum:cards', `${rid}|${clusterId}|${win.from}..${win.to}|${entSig(dent)}`, () => summaryCards(res, {
    clusterId, nameOf, daysRes, win, daysPending: daysRes ? null : problem(dent, 'The days of the last week') }));
  const asOf = B.get('sum:asof', `${rid}|${S.pk}|${S.rng.id}`, () => asOfLine(res.byCluster, res.now, (res.byCluster || []).filter(isNever).length));
  return [notice, readNote, winNote, tzNote, asOf, ...cards, noDevNote];
}

/* ------------------------------------ one cluster ------------------------------------ */

function clusterKey(id, q) { return `cl|${id}|${JSON.stringify(q)}`; }

function clusterView(id) {
  const q = winQuery();
  const ent = need(clusterKey(id, q), (signal) => ldCluster({ clusterId: id, ...q, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const name = (res && res.name) || nameOf(id);
  const lv = res && res.levels; const b = bands(lv);
  const head = B.get('cl:head', `${id}|${S.pk}|${entSig(ent)}`, () => {
    const tz = res && res.timeZone;
    return h('div.ld-head',
      h('div.ld-title',
        crumbs(link(ldHash('fleet'), 'Log Delay'), 'cluster'),
        h('h2.ld-h-row', name, h('span.ld-h-sub', ` · ${(res && res.label) || ''}`),
          res ? fixButton({ kind: 'cluster', id: name, items: () => clusterFixItems(res) }) : null),
        h('p.sub', `Every device in this cluster that sends logs. Late means ${b.late}.`),
        tz ? h('div.ld-chips', tz.mode === 'none' ? h('span.ld-chip', 'Delay shown as measured: no time zone to take out') : h('span.ld-chip', `Delay shown after the time zone (${timeZoneShort(tz)}) is taken out`)) : null));
  });
  if (!res) return [head, B.get('cl:problem', entSig(ent), () => problem(ent, `${name}’s log delay`))];
  const rid = objId(res);
  const t = res.totals || {};
  const inView = S.tz === null ? null : (res.devices || []).filter((r) => matchesZone(r, S.tz));
  const never = res.lastRunAt === null || res.lastRunAt === undefined;
  const lr = res.lastRead || (res.counts && res.counts.lastRead);
  const tileRow = B.get('cl:tiles', `${rid}|${S.tz}`, () => tiles(inView ? tileCounts(inView) : t, b, id, 'ld-cl', never || (!lr && !(t.devices > 0)), res.everyHours, res.notMeasured || '', [res]));
  const asOf = B.get('cl:asof', `${rid}|${S.pk}|${S.rng.id}`, () => asOfLine([{ lastRunAt: res.lastRunAt }], res.now));
  const tzFilterNote = B.get('cl:tzfilter', `${rid}|${S.tz}`, () => (inView
    ? h('div.muted.ld-note#ld-tz-filter-note', `Time zone filter: ${tzWords()} — ${countText(inView.length)} of ${countText((res.devices || []).length)} devices. The tiles and the table count these devices; the charts are the core’s day totals for every zone.`)
    : null));
  const readNote = B.get('cl:readnote', rid, () => readNotes([{ name, lastRead: lr }]));
  const countsNote = never ? null : B.get('cl:counts', rid, () => h('div.ld-note', countsLine(res.counts),
    h('div.muted#ld-last-read-line', `Last run read: ${lastReadText(lr)} · documents with no device name: ${noDeviceText(lr)} · ${countText(res.started)} delays started, ${countText(res.solved)} solved in the period`), typesUnreadNote([t])));
  const neverNote = B.get('cl:never', rid, () => (never ? h('div.banner.warn', `${name} has never been measured: it is not in the scheduled measurement yet.`) : null));
  const winNote = B.get('cl:window', `${rid}|${S.pk}|${JSON.stringify(S.rng)}`, () => windowNote(res.lastRunAt, res.now));
  const charts = never ? null : B.get('cl:charts', `${rid}|${S.pk}|${S.tz}`, () => chartPanels(res, S.period, b, id));
  const fw = S.focusWin && S.focusWin.cluster === id ? S.focusWin : null;
  const focusNote = B.get('cl:focus', `${rid}|${fw ? `${fw.from}|${fw.mode}` : '-'}`, () => {
    if (!fw) return null;
    const w = (res.windows || []).find((x) => x && x.from === fw.from);
    const v = lateAtWindow(w, fw.mode);
    return h('div.ld-note.ld-focus#ld-focus-window',
      `Opened at ${fw.label || 'a window'} from Late devices over the day: `,
      h('b', v === null ? 'not measured' : `${countText(v)} device${v === 1 ? '' : 's'} ${fw.mode === 'critical' ? b.high.toLowerCase() : b.late}`),
      v === null ? ' — no run in that window.' : ' at that window’s measurement.', ' ',
      h('button.linkish', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { S.focusWin = null; repaint(); } }, '×'));
  });

  const f = res.fields || {};
  const cdRowsAll = res.devices || [];
  const extras = Array.isArray(f.extras) ? f.extras : [];
  const arrival = f.arrival || 'arrival';
  const event = 'Event time';
  const eventFrom = eventFieldsText(cdRowsAll, f.eventTime);
  const xc = extraCols(extras);
  // Delayed (and part delayed) devices only until "Show all devices" (the owner, 2026-11-17).
  const cdRows = inView || res.devices || [];
  const keys = withTypes(['device', 'zone', 'tag1', 'state', 'now', 'rawGap', 'deviceTz', 'max', 'episodes', 'lateMs', 'last', ...Object.keys(xc), 'arrival', 'event'], res.devices);
  const cdLate = cdRows.filter(inSet('delayed')).length;
  const ordered = sorts.clusterDevices.apply(byTimeLate(filterRows(cdRows, S.cdFilter).filter(inSet(S.cdSet))), sortCols(keys, xc));
  const shown = S.cdAll ? ordered : ordered.slice(0, PAGE_ROWS);
  const cdShowAll = () => { S.cdSet = 'all'; S.cdAll = false; repaint(); };
  const body = B.get('cl:dev:body', `${rid}|${S.cdFilter}|${S.cdAll}|${S.cdSet}|${S.tz}|${sortSig(sorts.clusterDevices)}`, () => [
    deviceTable({ id: 'ld-cluster-devices', sort: sorts.clusterDevices, rows: shown.map((r) => ({ ...r, cluster: r.cluster || id })), keys, extra: xc,
      labels: { arrival, event }, ctx: { now: res.now, zone: S.zone, everyHours: res.everyHours },
      emptyText: never ? 'Never measured: which devices are delayed is not known.' : S.cdSet === 'delayed' ? delayedEmpty(cdLate > 0, !!S.cdFilter, cdShowAll) : S.cdFilter ? 'No device matches the filter.' : 'No device measured in this period.' }),
    footer(`ECS fields from the device’s latest log: ${[...extras, `${arrival} (arrival)`, `event time: ${eventFrom}`].join(', ')} · delay = ${arrival} − event time`
      + (res.timeZone && res.timeZone.mode !== 'none' ? ` − time zone (${res.timeZone.offset || offsetLabel(res.timeZone.offsetMinutes)})` : '')
      + (f.device ? ` · device field ${f.device}` : '') + (f.pattern ? ` · indices ${f.pattern}` : ''),
      ` · Showing ${countText(shown.length)} of ${countText(ordered.length)}${S.cdSet === 'delayed' ? (cdRows.some((r) => isPart(r.state)) ? ' delayed or part delayed' : ' delayed') : ''}`,
      ordered.length > shown.length ? [' · ', h('button.linkish#ld-cd-all', { type: 'button', onclick: () => { S.cdAll = true; repaint(); } }, 'Show all')] : null)]);
  const cdBtn = B.get('cl:dev:set', '', () => setButton('ld-cd-showall', () => { S.cdSet = S.cdSet === 'all' ? 'delayed' : 'all'; S.cdAll = false; repaint(); }));
  setButtonWords(cdBtn, S.cdSet, cdRows.length);
  const devCard = keptCard(B, 'cl:dev', 'Devices in this cluster',
    never ? 'never measured' : `${S.cdSet === 'delayed' ? `${lateWords(cdRows)} of ${countText(cdRows.length)}` : countText(cdRows.length)} · ${sorts.clusterDevices.sort ? 'sorted by the marked column' : 'sorted by time spent late'} · a device name opens its details`,
    body, [cdBtn, filterBox('ld-cd-filter', () => S.cdFilter, (v) => { S.cdFilter = v; S.cdAll = false; })]);
  const byType = B.get('cl:bytype', `${rid}|${S.byTypeAll}|${sortSig(sorts.byType)}`, () => byLogTypeCard(res, { b, sort: sorts.byType, all: S.byTypeAll, onAll: () => { S.byTypeAll = !S.byTypeAll; repaint(); } }));
  return [head, focusNote, neverNote, readNote, tileRow, asOf, tzFilterNote, winNote, countsNote, charts, byType, devCard];
}

/* ------------------------------------ the devices ------------------------------------ */

/** The device columns of the Devices tab (no median: nothing averaged is shown). */
const FLEET_COLS = ['device', 'cluster', 'zone', 'tag1', 'state', 'now', 'rawGap', 'deviceTz', 'max', 'episodes', 'lateMs', 'last', 'docs'];

/** The distinct values of a context field over the rows, for the Zone and tag1 selects. */
const valuesOf = (rows, name) => [...new Set((rows || []).map((r) => extraOf(r, name)).filter((v) => v !== null).map(String))].sort();

/** Every filter the Devices tab applies: the set (delayed only, or every device), the search box, the level chip, zone and tag1. */
function devicesFiltered(rows) {
  return filterRows(rows, S.devFilter).filter((r) => inSet(S.devSet)(r) && matchesFilter(r, S.devState)
    && (!S.devZone || String(extraOf(r, 'zone')) === S.devZone) && (!S.devTag || String(extraOf(r, 'tag1')) === S.devTag));
}

/** The rows as a file, as filtered, with zone and tag1 and the time zone step; unknown stays blank, never 0. */
function exportDevicesCsv(rows, res) {
  // The server sends at most 2,000 device rows: a cut file says so on every row, never looks whole.
  const cut = res && res.devicesTruncated ? `the server sent the first ${(res.devices || []).length} of ${res.devicesTotal ?? 'more'} devices` : '';
  // Log types only where the core says them (0.3.90): blank is not measured, never 0.
  const withT = rows.some(saysTypes);
  const t = (r) => (hasTypes(r) ? r.types : null);
  const out = rows.map((r) => ({
    device: r.device, cluster: r.clusterName || r.cluster, zone: extraOf(r, 'zone') ?? '', tag1: extraOf(r, 'tag1') ?? '',
    state: rowStateText(r),
    ...(withT ? { log_types: t(r) ? `${t(r).total}${t(r).truncated ? '+' : ''}` : '', log_types_measured: t(r) && finite(t(r).measured) ? t(r).measured : '', log_types_late: t(r) && t(r).measured !== 0 ? t(r).late : '', late_log_types: t(r) ? (t(r).lateNames || []).join('; ') : '', delay_log_type: r.delayLogType || '', part_late_ms: finite(r.partLateMs) ? r.partLateMs : '' } : {}),
    delay_minutes: finite(r.nowMinutes) ? r.nowMinutes.toFixed(2) : '',
    raw_gap_minutes: finite(r.rawGapMinutes) ? r.rawGapMinutes.toFixed(2) : '', time_zone_offset: finite(r.tzOffsetMinutes) ? offsetLabel(r.tzOffsetMinutes) : '',
    max_minutes: finite(r.maxMinutes) ? r.maxMinutes.toFixed(2) : '', delays: finite(r.episodes) ? r.episodes : '', late_ms: finite(r.lateMs) ? r.lateMs : '',
    last_measured: finite(r.lastMeasuredMs) ? new Date(r.lastMeasuredMs).toISOString() : '',
    late_since: finite(r.lateSince) ? new Date(r.lateSince).toISOString() : '', docs_per_day: finite(r.docsPerDay) ? r.docsPerDay : '',
    event_field: r.eventField || '',
    fix: r.fix ? `${stepLabel(r.fix)}: ${r.fix.fix || r.fix.why || ''}` : '',
    note: cut,
  }));
  download(`log-delay-devices-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(out));
}

/**
 * The Devices tab: the fleet's (or one cluster's) devices from the summary — the delayed ones until
 * "Show all devices" — searched, filtered by level (the chips carry counts over every device),
 * zone and tag1; each row with its "i" and its logs (rows.js). `narrow` draws the short list
 * beside an open device board; `openDevice` is that device, listed even when it is not delayed.
 */
function devicesView(clusterId, narrow = false, openDevice = null) {
  const ids = clusterId ? [clusterId] : [];
  const q = winQuery();
  const ent = need(`sum|${S.pk}|${ids.join(',')}`, (signal) => ldSummary({ ...q, clusterIds: ids, maxDevices: 2000, signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const lv = res ? sharedLevels(res.byCluster) : null; const b = bands(lv);
  const head = narrow ? null : B.get('dev:head', `${clusterId}|${S.pk}|${entSig(ent)}`, () => h('div.ld-head',
    h('div.ld-title',
      h('h2', clusterId ? `Devices · ${nameOf(clusterId)}` : 'Devices'),
      h('p.sub', `The delayed devices of the period until Show all devices, worst first. Late means ${b.late}; a device name opens its details, “i” its recommended fix, Open in logs its documents.`)),
    h('div.ld-actions',
      h('button.btn#ld-dev-csv', { type: 'button', disabled: !res, title: 'The rows as filtered, with zone and tag1', onclick: () => exportDevicesCsv(devicesFiltered((res.devices || []).filter((r) => matchesZone(r, S.tz))), res) }, 'Export CSV'))));
  if (!res) return [head, B.get('dev:problem', entSig(ent), () => problem(ent, 'The devices'))].filter(Boolean);
  const rid = objId(res);
  const rows = (res.devices || []).filter((r) => matchesZone(r, S.tz));
  const counts = filterCounts(filterRows(rows, S.devFilter));
  const anyTypes = rows.some(saysTypes);
  if (!anyTypes && S.devState === 'part') S.devState = 'all';
  const chipLabel = { late: b.lateShort, critical: b.high, delay: b.mid, part: 'Part delayed', noDelay: 'No delay', ok: b.below, tz: 'Other time zone', silent: 'Silent' };
  const devShowAll = () => { S.devSet = 'all'; S.devAll = false; repaint(); };
  const zones = valuesOf(rows, 'zone'); const tags = valuesOf(rows, 'tag1');
  // The bar is one element for the visit (its counts, the pressed chip and the selects change in
  // place): the search box inside it is never moved, so typing never loses the focus or the caret.
  const bar = B.get('dev:bar', `${rid}|${narrow}|${b.mid}|${anyTypes}|${zones.join(',')}|${tags.join(',')}`, () => {
    const sel = (id, label, vals, set) => {
      const s = h(`select#${id}`, { 'aria-label': label, onchange: (e) => { set(e.target.value); S.devAll = false; repaint(); } },
        h('option', { value: '' }, `All ${label.toLowerCase()}s`), ...vals.map((v) => h('option', { value: v }, v)));
      return h('label.field.ld-tool', label, s);
    };
    // No "All" chip: the set button says which devices are listed, a chip narrows them, and a
    // pressed chip pressed again lets go. A level that is not delayed shows every device's set.
    return h('div.toolbar.ld-dev-bar',
      filterBox('ld-dev-filter', () => S.devFilter, (v) => { S.devFilter = v; S.devAll = false; }, anyTypes ? 'Search device, cluster, zone, tag1 or late log type' : 'Search device, cluster, zone or tag1'),
      setButton('ld-dev-showall', () => { S.devSet = S.devSet === 'all' ? 'delayed' : 'all'; S.devAll = false; if (S.devSet === 'delayed' && !LATE_FILTERS.includes(S.devState)) S.devState = 'all'; repaint(); }),
      h('div.ld-chips#ld-dev-chips', ...DEVICE_FILTERS.filter((f) => f !== 'all' && (f !== 'part' || anyTypes)).map((f) => h('button.ld-chip.ld-chip-btn', {
        type: 'button', dataset: { filter: f }, 'aria-pressed': 'false',
        onclick: () => { S.devState = S.devState === f ? 'all' : f; S.devAll = false; if (S.devState !== 'all' && !LATE_FILTERS.includes(S.devState)) S.devSet = 'all'; repaint(); },
      }, chipLabel[f], ' ', h('b')))),
      narrow ? null : sel('ld-dev-zone', 'Zone', zones, (v) => { S.devZone = v; }),
      narrow ? null : sel('ld-dev-tag', 'tag1', tags, (v) => { S.devTag = v; }));
  });
  for (const btn of bar.querySelectorAll('.ld-chip-btn')) {
    const f = btn.dataset.filter; const n = btn.querySelector('b'); const txt = countText(counts[f]); const on = String(S.devState === f);
    if (n.textContent !== txt) n.textContent = txt;
    if (btn.getAttribute('aria-pressed') !== on) btn.setAttribute('aria-pressed', on);
  }
  setButtonWords(bar.querySelector('#ld-dev-showall'), S.devSet, counts.all);
  for (const [id, cur, vals] of [['#ld-dev-zone', S.devZone, zones], ['#ld-dev-tag', S.devTag, tags]]) {
    const el = bar.querySelector(id); const want = vals.includes(cur) ? cur : '';
    if (el && el.value !== want) el.value = want;
  }
  const ordered = sorts.devices.apply(byTimeLate(devicesFiltered(rows)), sortCols([...FLEET_COLS, 'types']));
  let shown = S.devAll ? ordered : ordered.slice(0, PAGE_ROWS);
  // A device opened by a link (an alert, a device name) is listed beside its board even when it is not delayed.
  const pinned = narrow && openDevice && !shown.some((r) => r.device === openDevice && r.cluster === clusterId)
    ? rows.find((r) => r.device === openDevice && r.cluster === clusterId) : null;
  if (pinned) shown = [pinned, ...shown];
  // Beside a device board the state and its log types come first: the list is narrow.
  const keys = withTypes(!narrow ? FLEET_COLS : anyTypes ? ['device', 'state', 'now'] : ['device', 'zone', 'tag1', 'state', 'now'], res.devices);
  const narrowed = !!(S.devFilter || S.devState !== 'all' || S.devZone || S.devTag);
  const noneYet = allNever(res.byCluster);
  const body = B.get('dev:body', `${rid}|${S.devFilter}|${S.devState}|${S.devZone}|${S.devTag}|${S.devAll}|${S.devSet}|${S.tz}|${sortSig(sorts.devices)}|${narrow}|${pinned ? openDevice : ''}`, () => [
    deviceTable({ id: 'ld-devices', sort: sorts.devices, rows: shown, keys, ctx: { now: res.now, zone: S.zone, everyHours: res.everyHours },
      emptyText: noneYet ? 'Never measured: which devices are delayed is not known.' : S.devSet === 'delayed' ? delayedEmpty(counts.late > 0 || counts.part > 0, narrowed, devShowAll)
        : narrowed ? 'No device matches. Clear the search or pick another level.' : 'No device measured in this period.' }),
    pinned ? h('div.muted.ld-note#ld-dev-pinned', `${pinned.device} is listed because it is open; it is not delayed. The list holds the delayed devices only.`) : null,
    footer(`Showing ${countText(shown.length - (pinned ? 1 : 0))} of ${countText(ordered.length)}${S.devSet === 'delayed' ? (rows.some((r) => isPart(r.state)) ? ' delayed or part delayed' : ' delayed') : ''}`,
      ordered.length > shown.length ? [' · ', h('button.linkish#ld-dev-all', { type: 'button', onclick: () => { S.devAll = true; repaint(); } }, 'Show all')] : null,
      res.devicesTruncated ? ` · the server sent the first ${countText(rows.length)} of ${countText(res.devicesTotal)}` : null)]);
  const list = keptCard(B, 'dev:list', narrow ? (S.devSet === 'delayed' ? 'Delayed devices' : 'Devices')
    : noneYet ? 'Never measured' : S.devSet === 'delayed' ? `${lateWords(rows)} of ${countText(S.tz === null ? (res.devicesTotal ?? rows.length) : rows.length)} devices`
      : `${countText(S.tz === null ? (res.devicesTotal ?? rows.length) : rows.length)} devices`,
    noneYet ? 'no cluster in view has been measured' : `${sorts.devices.sort ? 'sorted by the marked column' : 'sorted by time spent late'}${S.tz === null ? '' : ` · ${tzWords()}`}`, [bar, body]);
  const winNote = narrow ? null : B.get('dev:window', `${rid}|${S.pk}|${JSON.stringify(S.rng)}`, () => windowNote(lastRunOf(res.byCluster), res.now));
  const asOf = narrow ? null : B.get('dev:asof', `${rid}|${S.pk}|${S.rng.id}`, () => asOfLine(res.byCluster, res.now, (res.byCluster || []).filter(isNever).length));
  return [head, winNote, asOf, list].filter(Boolean);
}

/* ------------------------------------ one device ------------------------------------ */

function deviceQuery() {
  return S.range ? { from: S.range.from, to: S.range.to } : winQuery();
}

/**
 * One device, and only that device: its figures, its recommendation (the core's finding, the
 * same words as its row's "i"), its graph and its delays, beside the short device list.
 */
function deviceView(clusterId, device) {
  const q = deviceQuery();
  const ent = need(`dev|${clusterId}|${device}|${JSON.stringify(q)}`, (signal) => ldDevice({ clusterId, device, ...q, signal }));
  const cent = need(clusterKey(clusterId, winQuery()), (signal) => ldCluster({ clusterId, ...winQuery(), signal }));
  const res = ent.state === 'ok' ? ent.res : null;
  const cres = cent.state === 'ok' ? cent.res : null;
  const f = (cres && cres.fields) || {};
  const devField = String(f.device || 'src_hostname').replace(/\.keyword$/, '');
  const every = res && finite(res.everyHours) ? res.everyHours : null;
  const cname = (res && res.clusterName) || nameOf(clusterId);
  const late = res && (res.state === 'delay' || res.state === 'critical');
  const age = measuredAge(res, res ? res.now : Date.now(), every);
  const head = B.get('dev1:head', `${clusterId}|${device}|${S.pk}|${JSON.stringify(S.range)}|${entSig(ent)}|${entSig(cent)}`, () => h('div.ld-head',
    h('div.ld-title',
      crumbs(link(ldHash('devices'), 'Devices'), link(clusterHref(clusterId), cname)),
      h('h2.ld-dev-h', h('span.mono', device),
        res ? res.typesUnread && res.stateText ? statePill(typesNotRead(res) ? 'unmeasured' : res.state, res.stateText) : statePill(res.state, late && age.stale && age.at !== null ? staleText(age.at, res.now) : late && finite(res.lateSince) ? `${stateText(res.state)} · late since ${whenText(res.lateSince, res.now).replace(/^today /, '')}`
          : isPart(res.state) ? (age.stale && age.at !== null ? `part delayed when last measured ${whenText(age.at, res.now).replace(/^today /, '')}, not measured since` : stateText(res.state))
          : res.state === 'silent' && finite(res.silentSince) ? `silent · no logs since ${whenText(res.silentSince, res.now)}` : stateText(res.state)) : null,
        res ? fixButton({ kind: 'device', id: device, items: () => fixesFor(res, 'device') }) : null),
      h('p.sub', [`Device field ${devField}`, `arrival ${f.arrival || '@timestamp'}`,
        `event time ${res && res.eventField ? res.eventField : Array.isArray(f.eventTime) && f.eventTime.length ? f.eventTime.join(' / ') : 'not known'}`,
        res && extraOf(res, 'zone') !== null ? `zone ${extraOf(res, 'zone')}` : 'zone not known',
        res && extraOf(res, 'tag1') !== null ? `tag1 ${extraOf(res, 'tag1')}` : 'tag1 not known',
        res && res.timeZone ? `cluster time zone ${timeZoneShort(res.timeZone)}` : null,
        res && res.state === 'other_tz' ? `this device ${offsetLabel(res.tzOffsetMinutes)} (other time zone)` : null,
        res && finite(res.rawGapMinutes) && finite(res.tzOffsetMinutes) ? `raw gap${res.delayLogType ? ` of ${res.delayLogType}` : ''} ${minutesText(res.rawGapMinutes)} − ${offsetLabel(res.tzOffsetMinutes)}` : null,
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
  const lt = lateTime(res, age);
  const perDay = logsADay(res);
  const series = Array.isArray(res.series) ? res.series : null;   // undefined: a core before 0.3.90, the board as it was
  // With two log types or more the newest document's delay decides nothing: the tile is the worst measured log type's.
  const fresh = (series || []).filter((x) => finite(x.delayMinutes) && !x.stale);
  const worstType = series && series.length > 1 && fresh.length ? fresh.reduce((m, x) => (x.delayMinutes > m.delayMinutes ? x : m)) : null;
  const typesHead = B.get('dev1:types-head', rid, () => (!series ? null
    : series.length ? h('div.ld-note.ld-types-headline#ld-types-headline', h('b', typesHeadline(series, { now: res.now, truncated: !!(res.types && res.types.truncated) })))
      : h('div.muted.ld-note#ld-types-headline', `Log types: ${res.seriesWhy || 'not measured'}.`)));
  // Facts, not statistics: no median, no average (the owner's rule).
  const tiles5 = B.get('dev1:tiles', rid, () => h('div.ld-kpis.ld-5',
    worstType ? h('div.ld-kpi', { dataset: { kpi: 'now' } }, h(`b${seriesLate(worstType) ? (worstType.state === 'critical' ? '.ld-crit' : '.ld-delay') : ''}`, minutesText(worstType.delayMinutes)),
      h('span', 'worst log type now: ', h('b', typeLabel(worstType)), finite(worstType.lastMeasuredMs) ? ` · measured ${whenText(worstType.lastMeasuredMs, res.now).replace(/^today /, '')}` : ''))
      : h('div.ld-kpi', { dataset: { kpi: 'now' } }, h(`b${late ? (res.state === 'critical' ? '.ld-crit' : '.ld-delay') : ''}`, res.state === 'unmeasured' ? 'can’t measure' : res.state === 'silent' ? 'silent' : minutesText(res.nowMinutes)), h('span', age.at === null ? 'delay now' : age.stale ? `last measured ${whenText(age.at, res.now).replace(/^today /, '')}` : `delay now · measured ${whenText(age.at, res.now).replace(/^today /, '')}`)),
    h('div.ld-kpi', { dataset: { kpi: 'worst' } }, h('b', minutesText(res.worst && res.worst.minutes)), h('span', `worst · ${res.worst && finite(res.worst.at) ? whenText(res.worst.at, res.now) : 'not known'}`)),
    h('div.ld-kpi', { dataset: { kpi: 'episodes' } }, h('b', countText(res.episodes)), h('span', `${series && series.length > 1 ? 'delays of the whole device' : 'delays'} · ${countText(res.solved)} solved`)),
    h('div.ld-kpi', { dataset: { kpi: 'lateMs' } }, h('b', durationText(lt.ms)), h('span', `time late · ${finite(lt.pct) ? `${pctText(lt.pct)} ` : ''}${lt.of}${partLateText(res) ? ` · ${partLateText(res)}` : ''}`)),
    h('div.ld-kpi', { dataset: { kpi: 'docs' } }, h('b', perDay.text), h('span', `${perDay.label} · ${finite(res.lastSilence) ? `${whenText(res.lastSilence, res.now)} last silence` : 'no silence'}`))));

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

  if (S.types.for !== `${clusterId}|${device}`) S.types = { for: `${clusterId}|${device}`, slots: null, more: false };
  const typed = series && series.some((x) => (x.points || []).length);
  const graph = typed
    ? B.get('dev1:graph', `${rid}|${S.types.more}|${S.types.slots ? [...S.types.slots].map(([k, v]) => `${k}=${v}`).join('|') : '-'}`, () => typesGraphCard(res, { lv, every, age, zone: S.zone, slots: S.types.slots, more: S.types.more,
      onSlots: (m) => { S.types.slots = m; repaint(); }, onMore: () => { S.types.more = !S.types.more; repaint(); }, insights: graphInsights }))
    : B.get('dev1:graph', rid, () => graphCard(res, lv, every, age));
  const typesTable = series && series.length ? B.get('dev1:types', `${rid}|${sortSig(sorts.types)}`, () => typesTableCard(res, { clusterId, device, sort: sorts.types })) : null;
  return [head, bar, typesHead, tiles5, rec, graph, typesTable, periodsCard(res, every, age)];
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
  const withType = !!logTypeFieldOf(clusterId) || !!(res && Array.isArray(res.series) && res.series.length);
  const form = B.get('dev1:search', `${S.qFor}|${devField}|${(extras || []).join(',')}|${clusters().length}|${withType}`, () => {
    const set = (k) => (e) => { S.q[k] = e.target.value; };
    const inp = (id, k, o = {}) => h(`input#${id}`, { type: o.type || 'search', value: S.q[k] || '', placeholder: o.ph || null, oninput: set(k), onchange: set(k), dataset: { untracked: '' } });
    const fields = [...new Set([devField, 'src_hostname', 'src_device', ...extras, withType ? LOG_TYPE_FIELD : ''].filter(Boolean))];
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

function graphCard(res, lv, every, age) {
  // The days are the server's: their midnights in the zone the page writes times in.
  const lo = fromZonedInput(`${res.from}T00:00`, S.zone); const hi = Math.min(fromZonedInput(`${res.to}T23:59:59`, S.zone), res.now || Date.now());
  const until = age.at !== null ? age.at : res.now;
  // Not solved: what is known of it ends at the last measurement.
  const openText = age.stale && age.at !== null ? staleText(age.at, res.now) : age.at !== null ? `still late at ${whenText(age.at, res.now)}` : 'still late';
  const H = 220;
  const g = deviceGraph(res.points, { fromMs: lo, toMs: hi, height: H, levels: lv, gapMs: res.staleAfterMs });
  const y = (m) => g.Y(m);
  const line = (m, colour) => (finite(m) && m <= g.scaleMax ? h('div.ld-hline', { style: { top: `${y(m)}px`, borderTopColor: colour } }) : null);
  const bandsEls = (res.periods || []).flatMap((p) => periodBands(p, g.lo, g.hi, until).map((b) => {
    return h(`div.ld-band${b.critical ? '.ld-band-crit' : ''}`, { title: `${whenText(p.started, res.now)} → ${p.solved ? whenText(p.solved, res.now) : finite(p.ended) ? `${whenText(p.ended, res.now)} (${p.endedWhy || 'ended'})` : openText}, worst ${minutesText(p.worstMinutes)}`,
      style: { left: `${b.left}%`, width: `${b.width}%` } });
  }));
  const tail = age.stale && age.at !== null && age.at < g.hi
    ? h('div.ld-tail', { title: `not measured after ${whenText(age.at, res.now)}`, style: { left: `${Math.max(0, ((age.at - g.lo) / (g.hi - g.lo || 1)) * 100)}%` } }) : null;
  const dotW = g.dots.length > 120 ? 3 : 6;
  const unknown = (res.points || []).filter((p) => p && !finite(p.m) && finite(p.t));
  const pic = svg('svg', { viewBox: `0 0 1000 ${H}`, preserveAspectRatio: 'none', role: 'img', class: 'ld-graph-svg',
    'aria-label': `Delay of ${res.device} over the period: ${(res.points || []).length} measurements, ${(res.periods || []).length} delays, worst ${minutesText(res.worst && res.worst.minutes)}` },
  ...g.segments.map((p) => svg('polyline', { points: p, fill: 'none', stroke: C.line, 'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke' })),
  ...g.dots.map((p) => svg('path', { d: `M${p.x.toFixed(1)},${p.y.toFixed(1)}h0.01`, class: 'ld-dot', fill: 'none', stroke: C.line, 'stroke-width': dotW, 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' })),
  ...unknown.map((p) => svg('rect', { x: g.X(p.t) - 2, y: H - 6, width: 4, height: 6, fill: C.silent })));
  const marks = [];
  for (const p of res.periods || []) {
    if (finite(p.started) && p.started >= g.lo) marks.push(h('span.ld-mark.ld-mark-start', { title: `delay started ${whenText(p.started, res.now)}`, style: { left: `calc(${((p.started - g.lo) / (g.hi - g.lo || 1)) * 100}% - 5px)` } }, '▲'));
    if (finite(p.solved)) marks.push(h('span.ld-mark.ld-mark-solved', { title: `solved ${whenText(p.solved, res.now)}`, style: { left: `calc(${((p.solved - g.lo) / (g.hi - g.lo || 1)) * 100}% - 4px)` } }, '●'));
    else if (!finite(p.ended)) marks.push(h('span.ld-mark.ld-mark-open', { title: openText, style: { left: `calc(${Math.min(100, Math.max(0, ((until - g.lo) / (g.hi - g.lo || 1)) * 100))}% - 5px)` } }, '◆'));
  }
  const ticks = axisTicks(g.lo, g.hi);
  const scale = [[g.scaleMax, `${g.scaleMax} min`], [lv.criticalOver, String(lv.criticalOver)], [lv.delayFrom, String(lv.delayFrom)], [0, '0']]
    .filter(([m]) => finite(m) && m <= g.scaleMax);
  return card('Delay over time', `each point is one ${every ? `${every}-hour ` : ''}measurement · shaded: late, where it was measured`,
    [h('div.ld-graph',
      h('div.ld-yaxis', { style: { height: `${H}px` } }, ...scale.map(([m, t]) => h('span', { style: { top: `${y(m) - 7}px` } }, t))),
      h('div.ld-plot#ld-graph', { style: { height: `${H}px` } }, ...bandsEls, tail, line(lv.criticalOver, C.critLine), line(lv.delayFrom, C.delayLine), pic)),
    h('div.ld-marks', { 'aria-label': 'Delay starts and solves' }, ...marks),
    h('div.ld-ticks.ld-indent', ...ticks.map((t) => h('span', t))),
    h('div.muted.ld-indent.ld-tiny', `▲ delay started · ● solved · ◆ late at the last measurement${tail ? ' · hatched: not measured' : ''} · `, h('i.ld-sq', { style: { background: C.silent } }), ' silent or can’t measure (no dot, never 0 min)'),
    graphInsights(res, age, openText)],
    [legend(key(C.line, 'Delay', { line: true }), key(C.delayLine, `${lv.delayFrom ?? '?'} min`, { dash: true }), key(C.critLine, `${lv.criticalOver ?? '?'} min`, { dash: true }))]);
}

/** Facts about the period, under the graph: the peak, the longest delay, when delays begin. No average. */
function graphInsights(res, age, openText) {
  const until = age.at !== null ? age.at : res.now;
  const ins = res.insights || {};
  const longestMs = !ins.longest ? null : !finite(ins.longest.solved) && !finite(ins.longest.ended) && age.stale && finite(ins.longest.started) ? Math.max(0, until - ins.longest.started) : ins.longest.lastedMs;
  const cell = (label, value, sub) => h('div.ld-ins', h('div.muted', label), h('b', value), sub ? h('span', ` ${sub}`) : null);
  return h('div.ld-insights.ld-3',
    cell('Peak', minutesText(ins.peak && ins.peak.minutes, 'not known'), ins.peak && finite(ins.peak.at) ? whenText(ins.peak.at, res.now) : null),
    cell('Longest delay', longestMs === null ? 'not known' : longestMs === 0 ? 'one measurement' : lastedText(longestMs, ins.longest.measuredMs), ins.longest && finite(ins.longest.started) ? `${whenText(ins.longest.started, res.now)} → ${finite(ins.longest.solved) ? whenText(ins.longest.solved, res.now) : finite(ins.longest.ended) ? `${whenText(ins.longest.ended, res.now)} (not solved: ${ins.longest.endedWhy || 'ended'})` : openText}` : null),
    cell('Late most often', ins.lateMostOften ? ins.lateMostOften.label : 'not known', ins.lateMostOften ? `${ins.lateMostOften.count} of ${ins.lateMostOften.of} delays began then` : null));
}

/**
 * Every delay: the device's own (every log type late) and, where its log types are measured, each
 * log type's beside them, with a Log type column (typeDelays, logdelay/device-types.js).
 */
function periodsCard(res, every, age) {
  return B.get('dev1:periods', `${objId(res)}|${sortSig(sorts.periods)}`, () => {
    const typed = Array.isArray(res.series) && res.series.length > 0;
    const all = typed ? typeDelays(res, age) : (res.periods || []);
    // The columns that say something: "Looks like" only where a delay has a pattern.
    const looks = all.some((p) => p.pattern);
    const cols = (typed ? 9 : 8) + (looks ? 1 : 0);
    const rows = sorts.periods.apply(all.slice().sort((a, b) => (b.started || 0) - (a.started || 0)), {
      logType: { type: 'text', value: (p) => p.typeLabel },
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
      const own = p.age || age;   // a log type's delay ends at that log type's last measurement
      return h(`tr${p.solved ? '' : '.ld-open'}`,
        typed ? h(`td.ld-type-name${p.whole ? '.muted' : ''}`, { title: p.typeLabel }, p.typeLabel) : null,
        h('td', whenText(p.started, res.now)),
        h('td', p.solved ? whenText(p.solved, res.now) : finite(p.ended) ? h('span.muted.ld-ended', `${whenText(p.ended, res.now)} · ${p.endedWhy || 'ended, not solved'}`)
          : statePill(p.lastState || p.worstState || 'critical', own.stale && own.at !== null ? `not solved · last measured ${whenText(own.at, res.now).replace(/^today /, '')}` : 'still late')),
        h('td.num', p.solved || finite(p.ended) ? lastedText(p.lastedMs, p.measuredMs) : own.stale && own.at !== null ? `${durationText(Math.max(0, own.at - p.started))} to the last measurement` : `${lastedText(p.lastedMs, p.measuredMs)} so far`),
        h('td.num', minutesText(p.worstMinutes)), h('td', stateText(p.worstState)),
        looks ? h('td', p.pattern ? p.pattern : h('span.muted', '—')) : null,
        h('td', zone === null ? h('span.muted', '—') : String(zone)), h('td', tag1 === null ? h('span.muted', '—') : String(tag1)),
        h('td.num', countText(p.measurements)));
    });
    const sil = (res.silences || []).map((s) => `${whenText(s.from, res.now)} → ${finite(s.to) ? whenText(s.to, res.now) : 'still silent'}${finite(s.burstDocs) ? ` (then ${countText(s.burstDocs)} logs${finite(s.burstMinutes) ? `, ${minutesText(s.burstMinutes)} late` : ''})` : ''}`);
    return card('Every delay', typed ? 'each log type’s delays, and the whole device’s (every log type late at once) · started = first measurement at the delay level or later · solved = first measurement back under it'
      : 'started = first measurement at the delay level or later · solved = first measurement back under it',
      [h('div.tbl-wrap', h('table.tbl#ld-periods',
        sortHead(sorts.periods, [...(typed ? [['logType', 'Log type']] : []), ['started', 'Started'], ['solved', 'Solved'], ['lasted', 'Lasted', 1], ['worst', 'Worst delay', 1], ['state', 'Worst state'], ...(looks ? [['pattern', 'Looks like']] : []),
          ['zone', 'zone'], ['tag1', 'tag1'], ['measurements', 'Runs', 1]]),
        h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: cols }, empty('No delay in this period.')))])))),
      footer(`A start or solve time is accurate to the ${every ? `${every}-hour ` : ''}measurement. `,
        typed && finite(res.seriesPeriodsFromMs) ? `Delays of single log types that started up to ${whenText(res.seriesPeriodsFromMs, res.now)} are not all kept. ` : '',
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
  S.tz = r.tz === undefined ? null : r.tz;
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
      mount(split.firstChild, ...devicesView(r.clusterId, true, r.device).flat().filter(Boolean));
      mount(split.lastChild, ...deviceView(r.clusterId, r.device).flat().filter(Boolean));
      for (const tr of split.firstChild.querySelectorAll('tr[data-device]')) tr.classList.toggle('ld-sel', tr.dataset.device === r.device && tr.dataset.cluster === r.clusterId);
      mount(wrap, split);
      return wrap;
    }
    const kids = r.view === 'cluster' ? clusterView(r.clusterId)
      : r.view === 'summary' ? summaryView(r.clusterId)
        : r.view === 'devices' ? devicesView(r.clusterId)
          : fleetView();
    mount(wrap, ...kids.flat().filter(Boolean));
    return wrap;
  } finally { B.end(); }
}
