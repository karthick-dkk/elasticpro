/**
 * Log Delay › Live, its top card "Delayed now": the cluster chosen in the top bar measured now,
 * from this browser, over the Live range — the delayed devices first, with the boards' own row
 * (logdelay/rows.js) — and one device watched: its delay now, since when it is late, when it was
 * measured, and the Logs card below narrowed to it (logdelay/live-logs.js). Live Watch until the
 * merge (Live Watch and Live logs became one tab, Live; docs/LOGDELAY.md "Live").
 *
 * Nothing here starts on its own: no measurement, no re-measure, no timer. Fetch (a split button)
 * measures the chosen cluster — its delayed devices (the default), every device, or every device
 * in the cluster including the ones silent in the range — and Re-measure measures the watched
 * device again. With All clusters chosen, Fetch says first what it would cost (every cluster
 * searched from this browser) and that the server already measures every cluster on its schedule;
 * "Fetch N clusters anyway" is the one way to start it.
 *
 * Delay is arrival time minus the time the event happened, per device (core/log-delay.js): a
 * preflight per cluster says whether it can be measured at all, then one aggregation per cluster
 * measures it, FAN_OUT at a time — with its log types in the same search where the cluster maps
 * log_type (0.3.90), so a device with only some of them late is listed as part delayed. Leaving the tab stops the fan-out and lets go of what is still out.
 */

import { h, mount, svg } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { download, downloadBytes, toCsv } from '../lib/fmt.js';
import { tableSort } from '../lib/table-sort.js';
import { activeClusters, client, setDelaySummary, clusters } from '../core/state.js';
import { card, pill, table } from '../pages/common.js';
import {
  preflight, measureDelayIn, answerGaps, measureSeenIn, SEEN_LOOKBACK, summarise, delayCoverage, LATE_MAX, buildLateSearchBody, recordFrom, logFilterFields,
} from '../core/log-delay.js';
import { levelsOf, zoneOf, loadLevels, isLate, isPart, fleetLevels } from '../core/delay-levels.js';
import { hasTypes, saysTypes, typesText, typesTitle } from '../core/log-types.js';
import { offsetLabel } from '../core/log-tz.js';
import { runBounded, cancellation, partialNote } from '../core/fleet.js';
import { reportSheets, reportFilename } from '../core/delay-report.js';
import {
  liveDeviceRow, silentDeviceRow, stateText, extraOf, countText, matchesZone, ldFixes, ldDevice, ldSummary, ldHash, scheduleOf, minutesText, whenText,
} from '../core/logdelay-report.js';
import { rangeBounds, rangeMinutes, rangeText, rangeWords, zonedText } from '../core/log-range.js';
import { workbook, XLSX_MIME } from '../lib/xlsx.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { deviceTable, sortCols, withTypes } from './rows.js';
import { fixButton } from './fix-popover.js';
import { pickId } from './boards.js';
import { liveNarrow, liveUnnarrow } from './live-logs.js';

/**
 * How many clusters are asked at once. Three, not "all of them": the clusters people point this
 * at are the ones already under load, and the delay query is a terms aggregation with a top_hits
 * per bucket.
 */
const FAN_OUT = 3;

/** Fetch's three choices: what each measures and lists. `cluster` adds the devices silent in the range. */
export const FETCH_SCOPES = Object.freeze([
  ['delayed', 'Fetch delayed devices', (b) => `only devices ${b} · the list Fetch shows by default`],
  ['all', 'Fetch all devices', () => 'every device that sent logs in the range, with its delay'],
  ['cluster', 'Fetch all devices in cluster', () => 'also the devices silent in the range (seen in the 7 days before)'],
]);

const delay = {
  running: false,          // the preflight is in flight
  fetching: false,         // the measurement fan-out is in flight
  token: null,             // the stop button for whichever of those is running
  cancelled: false,
  progress: { done: 0, total: 0 },
  clusterIds: [],          // the clusters the last Fetch asked
  byCluster: new Map(),    // cluster id -> { state, pre, records, truncated, error, fetchError, seen }
  fixes: new Map(),        // "cluster|device" -> the core's finding (LOGDELAY_FIXES), after a measurement
  records: null,           // every asked cluster's devices, merged
  summary: null,
  at: 0,
  window: null,            // the range the last measurement covered: {from, to, text}
  scope: 'delayed',        // what Fetch measures and lists: FETCH_SCOPES
  ran: 'delayed',          // the scope the rows on screen were fetched with
  menu: false,             // Fetch's menu is open
  warn: null,              // All clusters chosen and Fetch pressed: the scope it would run, until answered
  sched: null,             // the scheduled measurement as the core said it (scheduleOf), for the warning
  watched: null,           // { clusterId, device, row, lateSince, silentSince, storeState, at, remeasuring, error }
  ver: 0,                  // bumped whenever any of the above changed: what the cards are keyed on
};

/** Lets go of the requests the view still has out (the fan-out, a re-measure). */
let ctl = null;
let ctx = { repaint: () => {}, range: () => ({ id: '1h' }), zone: () => null, tz: () => null };
const W = nodeCache();
const bump = () => { delay.ver += 1; ctx.repaint(); };
const sortLate = tableSort('logdelay.watch', { onChange: () => bump() });

/** The tab is shown: keep the page's hooks. Nothing is asked. */
export function watchEnter(c) {
  ctx = { ...ctx, ...c };
  if (!ctl && typeof AbortController !== 'undefined') ctl = new AbortController();
}

/** The tab is left: the fan-out stops, and the requests still out are let go of. */
export function watchLeave() {
  if (delay.token) delay.token.cancel();
  if (ctl) ctl.abort();
  ctl = null;
  delay.menu = false;
  if (delay.watched) delay.watched.remeasuring = false;
}

/** Whether something is being asked (the page's loading line). */
export function watchBusy() { return delay.running || delay.fetching || !!(delay.watched && delay.watched.remeasuring); }

const byId = (id) => clusters().find((c) => c.id === id) || null;
/** The cluster the top bar's chooser names; null for All clusters (several on screen). */
function chosen() {
  const id = pickId();
  if (id) return byId(id);
  const a = activeClusters();
  return a.length === 1 ? a[0] : null;
}
/** The clusters the last Fetch asked, each with what is known about it. */
function delayRows() {
  return delay.clusterIds.map((id) => byId(id)).filter(Boolean).map((c) => ({ c, d: delay.byCluster.get(c.id) || { state: 'idle' } }));
}
function setEntry(id, patch) { delay.byCluster.set(id, { ...(delay.byCluster.get(id) || {}), ...patch }); }
const signal = () => (ctl ? ctl.signal : undefined);

/** The window a measurement asks: Elasticsearch date math for a "Last …" range, the instants for a custom one. */
function windowOf() {
  const r = ctx.range();
  if (r.id !== 'custom') {
    const m = rangeMinutes(r);
    return { from: `now-${m}m`, to: 'now', text: rangeText(r, ctx.zone()) };
  }
  const b = rangeBounds(r);
  return b ? { from: new Date(b.from).toISOString(), to: new Date(b.to).toISOString(), text: rangeText(r, ctx.zone()) } : null;
}

/** The delay (minutes) a device counts as late from: the fleet's level, else the first measured cluster's; null when no one has said. */
function lateFrom() {
  const f = fleetLevels();
  if (f && Number.isFinite(f.delayFrom)) return f.delayFrom;
  for (const { c, d } of delayRows()) { const l = d.records && levelsOf(c.id); if (l && Number.isFinite(l.delayFrom)) return l.delayFrom; }
  return null;
}
const behind = () => { const f = lateFrom(); return f === null ? 'delayed or critical' : `${f} min or more behind`; };

/* --------------------------------- Fetch --------------------------------- */

/**
 * Fetch pressed, for `scope`. One cluster chosen: it is measured. All clusters: the warning,
 * nothing sent to Elasticsearch (the schedule's figures are the core's, read for the warning's words).
 */
function pressFetch(scope) {
  if (delay.running || delay.fetching) return;
  delay.scope = scope;
  delay.menu = false;
  const one = chosen();
  if (one) { delay.warn = null; fetchDelay([one], scope); return; }
  if (!activeClusters().length) { toast('No cluster selected', 'warn'); return; }
  delay.warn = scope;
  bump();
  loadSchedule();
}

/** The scheduled measurement for the warning: one small LOGDELAY_SUMMARY (the core's store, no search), read as scheduleOf reads it. */
async function loadSchedule() {
  delay.sched = null;
  try {
    const res = await ldSummary({ days: 1, maxDevices: 1, signal: signal() });
    delay.sched = res && res.ok !== false ? scheduleOf(res) : { supported: null, enabled: null, everyHours: null, lastRunAt: null, nextDueAt: null };
  } catch (_) { delay.sched = { supported: null, enabled: null, everyHours: null, lastRunAt: null, nextDueAt: null }; }
  bump();
}

/** The clusters the preflight said can be measured. */
function analysable() {
  return delayRows().filter(({ d }) => d.pre && d.pre.ok && !d.pre.unknown).map(({ c, d }) => ({ c, pre: d.pre }));
}

/**
 * zone, tag1 and the address field ride along in the measurement's _source (not aggregated, so a
 * cluster without them simply has none): the device rows show them.
 */
function withContext(pre, c) {
  const meta = [...(pre.resolved.metadata || [])];
  const has = (n) => meta.some((m) => String(m).replace(/\.keyword$/, '').toLowerCase() === String(n).toLowerCase());
  const ip = logFilterFields(c).ip;
  for (const n of ['zone', 'tag1', ...(ip ? [ip] : [])]) if (!has(n)) meta.push(n);
  return { ...pre, resolved: { ...pre.resolved, metadata: meta } };
}

/**
 * Measure `list` over the Live range: a preflight per cluster (a missing field is a named refusal,
 * never an empty table that reads as "nothing is late"), then the measurement, and for `cluster`
 * the devices seen in the lookback before the range. Only from a press.
 */
async function fetchDelay(list, scope) {
  if (delay.fetching || delay.running || !list.length) return;
  const win = windowOf();
  if (!win) { toast('Set both ends of the custom range first', 'warn'); return; }
  if (!ctl && typeof AbortController !== 'undefined') ctl = new AbortController();
  const token = cancellation();
  delay.token = token; delay.running = true; delay.cancelled = false; delay.warn = null;
  delay.clusterIds = list.map((c) => c.id);
  delay.byCluster = new Map(list.map((c) => [c.id, { state: 'waiting' }]));
  delay.records = null; delay.summary = null; delay.at = 0; delay.ran = scope;
  delay.progress = { done: 0, total: list.length };
  bump();
  const pre = await runBounded(list, (c) => preflight(client(c.id), c, { logType: true }), {
    limit: FAN_OUT, token,
    onSettled: (s, p) => {
      setEntry(s.item.id, s.error ? { state: 'error', error: s.error.message || String(s.error) } : { state: 'checked', pre: s.value });
      delay.progress = { done: p.done, total: p.total };
      bump();
    },
  });
  for (const { item } of pre.skipped) setEntry(item.id, { state: 'skipped' });
  delay.running = false;
  if (pre.cancelled) { delay.cancelled = true; delay.token = null; bump(); return; }
  const targets = analysable();
  if (!targets.length) { delay.token = null; delay.at = Date.now(); bump(); return; }
  // What late means is the core's (LOGDELAY_SETTINGS_GET / _SUMMARY levels), asked before the
  // records are classified. Unanswered, a device reads "levels unknown".
  await loadLevels();
  delay.fetching = true;
  delay.progress = { done: 0, total: targets.length };
  delay.window = win;
  for (const { c } of targets) setEntry(c.id, { state: 'fetching', records: null, fetchError: null, seen: null });
  bump();
  const out = await runBounded(targets, async ({ c, pre: p }) => {
    const m = await measureDelayIn(client(c.id), c, withContext(p, c), win, levelsOf(c.id), { signal: signal() }, zoneOf(c.id));
    const seen = scope === 'cluster' ? await measureSeenIn(client(c.id), c, p, { from: SEEN_LOOKBACK, to: win.from }, { signal: signal() }) : null;
    return { ...m, seen };
  }, {
    limit: FAN_OUT, token,
    onSettled: (s, p) => {
      const id = s.item.c.id;
      if (s.error) {
        const es = s.error.res && s.error.res.json && s.error.res.json.error;
        const aborted = s.error.res && s.error.res.kind === 'aborted';
        setEntry(id, aborted ? { state: 'not-asked' } : { state: 'failed', fetchError: (es && (es.reason || es.type)) || s.error.message || String(s.error) });
      } else {
        setEntry(id, { state: 'done', records: s.value.records, truncated: s.value.truncated, gaps: s.value.gaps || [], seen: s.value.seen });
        // What this run found becomes the cluster's log-delay alert, as the scraper's does in Zabbix.
        setDelaySummary(id, summarise(s.value.records));
      }
      delay.progress = { done: p.done, total: p.total };
      mergeDelay();
      bump();
    },
  });
  for (const { item } of out.skipped) setEntry(item.c.id, { state: 'not-asked' });
  delay.fetching = false; delay.cancelled = out.cancelled; delay.token = null; delay.at = Date.now();
  mergeDelay();
  bump();
  loadFixes(targets.map(({ c }) => c.id));
  maybeScheduledReport();
}

/**
 * The core's recommended fixes for the clusters just measured, asked once (LOGDELAY_FIXES) and
 * joined to the browser-measured rows by (cluster, device). The text is the core's; a device it
 * names no finding for is shown as exactly that.
 */
async function loadFixes(ids) {
  try {
    const res = await ldFixes({ clusterIds: ids, signal: signal() });
    if (!res || res.ok === false) return;
    delay.fixes = new Map((res.devices || []).map((d) => [`${d.cluster}|${d.device}`, d]));
    bump();
  } catch (_) { /* no fixes: the rows say none was sent */ }
}

/** One list of devices; `summarise` is the one definition of what it adds up to. */
function mergeDelay() {
  const done = delayRows().filter(({ d }) => d.records);
  if (!done.length) { delay.records = null; delay.summary = null; return; }
  const all = [];
  for (const { c, d } of done) for (const r of d.records) all.push({ ...r, cluster: c.name, clusterId: c.id });
  delay.records = all;
  delay.summary = summarise(all);
  delay.summary.gaps = gapLines();
  delay.summary.truncated = done.reduce((n, { d }) => n + (d.truncated || 0), 0);
}

/** Each cluster whose answer was cut, in words: "es-1: 3 of 10 shards failed; silent devices not listed". */
function gapLines() {
  return delayRows().filter(({ d }) => d.records && ((d.gaps || []).length || (d.seen && (d.seen.gaps || []).length))).map(({ c, d }) => {
    const own = d.gaps || []; const seen = (d.seen && d.seen.gaps) || [];
    return `${c.name}: ${[...own, ...seen.map((x) => `the 7 days before: ${x}`)].join('; ')}${own.length && d.seen ? ' — which devices are silent is not known' : ''}`;
  });
}

/** The measured clusters whose mapping has no log type, each with why: a device there is delayed or not, never part delayed. */
function noTypeLines() {
  return delayRows().filter(({ d }) => d.records && d.pre && d.pre.logTypeWhy).map(({ c, d }) => `${c.name}: ${d.pre.logTypeWhy}`);
}

/** What the fan-out did not cover, in one line (delayCoverage is the one count). */
function coverageNote(phase) {
  return partialNote({ ...delayCoverage(delayRows().map(({ d }) => d), phase), cancelled: delay.cancelled });
}

/* --------------------------------- one device watched --------------------------------- */

/**
 * Watch a row: the device strip (its delay now from the measurement, since when it is late from
 * the core's store, when it was measured) and the Logs card narrowed to it. No search is sent: Logs
 * waits for Search, the strip for Re-measure. The store's "late since" is one LOGDELAY_DEVICE read.
 */
function watch(r) {
  const same = delay.watched && delay.watched.clusterId === r.cluster && delay.watched.device === r.device;
  if (same) { stopWatching(); return; }
  delay.watched = { clusterId: r.cluster, device: r.device, row: r, lateSince: null, silentSince: null, storeState: 'loading', at: delay.at, remeasuring: false, error: null };
  liveNarrow({ clusterId: r.cluster, device: r.device });
  bump();
  const w = delay.watched;
  ldDevice({ clusterId: r.cluster, device: r.device, days: 1, signal: signal() }).then((res) => {
    if (delay.watched !== w) return;
    if (res && res.ok !== false) { w.lateSince = Number.isFinite(res.lateSince) ? res.lateSince : null; w.silentSince = Number.isFinite(res.silentSince) ? res.silentSince : null; w.storeState = 'ok'; }
    else w.storeState = res && res.kind === 'not_found' ? 'unknown-device' : 'no-store';
    bump();
  }).catch(() => { if (delay.watched === w) { w.storeState = 'no-store'; bump(); } });
}

function stopWatching() {
  delay.watched = null;
  liveUnnarrow();
  bump();
}

/** Re-measure the watched device over the Live range: the measurement's own search with one device named. Only from a press. */
async function remeasure() {
  const w = delay.watched;
  if (!w || w.remeasuring) return;
  const c = byId(w.clusterId);
  const d = delay.byCluster.get(w.clusterId);
  const win = windowOf();
  if (!c || !d || !d.pre || !win) return;
  if (!ctl && typeof AbortController !== 'undefined') ctl = new AbortController();
  w.remeasuring = true; w.error = null;
  bump();
  try {
    const p = withContext(d.pre, c);
    const body = buildLateSearchBody(p.resolved, [w.device], { from: win.from, to: win.to, size: 1 });
    const res = await client(c.id).search(c.logIndexPattern || 'logstash-*', body, { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 60000, signal: signal() });
    if (delay.watched !== w) return;
    const b = (((res.aggregations || {}).devices || {}).buckets || []).find((x) => String(x.key) === String(w.device));
    const gaps = answerGaps(res, 1);
    // Named alone: nothing is cut by the size, but a failed shard can hide its logs — not silent.
    const lost = (res._shards && res._shards.failed > 0) || res.timed_out;
    if (!b && lost) throw new Error(`not read in full: ${gaps.join('; ')}`);
    w.row = b ? { ...liveDeviceRow(recordFrom(b, p.resolved, levelsOf(c.id), zoneOf(c.id)), c, levelsOf(c.id)), fix: w.row.fix || null } : { ...w.row, state: 'silent', nowMinutes: null };
    w.at = Date.now();
  } catch (e) {
    if (delay.watched !== w || (e && e.res && e.res.kind === 'aborted')) return;
    const es = e.res && e.res.json && e.res.json.error;
    w.error = (es && (es.reason || es.type)) || e.message || String(e);
  }
  w.remeasuring = false;
  bump();
}

/* --------------------------------- the card --------------------------------- */

const icon = (paths, extra = {}) => svg('svg', { viewBox: '0 0 24 24', width: '14', height: '14', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra },
  ...paths.map((d) => svg('path', { d })));
export const ICON_FETCH = ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 4v5h-5'];
const ICON_WARN = ['M12 3l10 18H2z', 'M12 10v4', 'M12 17.5v.5'];
const ICON_DOWN = ['M12 4v12', 'M6 11l6 6 6-6', 'M5 20h14'];
const ICON_CLOCK = ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'];

let wired = false;
function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  document.addEventListener('click', (e) => { if (delay.menu && !(e.target.closest && e.target.closest('.ld-lsplit'))) { delay.menu = false; bump(); } }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !delay.menu) return;
    e.stopPropagation(); delay.menu = false; bump();
    const b = document.getElementById('delay-fetch-more'); if (b) b.focus();
  }, true);
}

/** Fetch as a split button: the main part runs the scope chosen, the arrow opens the three. */
function fetchControl() {
  wire();
  const busy = delay.running || delay.fetching;
  return W.get('w:fetch', `${busy}|${delay.progress.done}/${delay.progress.total}|${delay.scope}|${delay.menu}|${behind()}`, () => {
    const label = FETCH_SCOPES.find(([k]) => k === delay.scope)[1];
    const main = h('button.btn.primary.ld-lsplit-main#delay-fetch', { type: 'button', disabled: busy, onclick: () => pressFetch(delay.scope) },
      icon(ICON_FETCH), busy ? ` ${delay.running ? 'Checking' : 'Measuring'} ${delay.progress.done} of ${delay.progress.total}…` : ` ${label}`);
    const caret = h('button.btn.primary.ld-lsplit-caret#delay-fetch-more', { type: 'button', disabled: busy, 'aria-label': 'Fetch options', 'aria-haspopup': 'menu', 'aria-expanded': String(delay.menu), 'aria-controls': 'delay-fetch-menu',
      onclick: () => { delay.menu = !delay.menu; bump(); if (delay.menu) { const f = document.querySelector('#delay-fetch-menu [aria-checked="true"]'); if (f) f.focus(); } } }, '▾');
    const menu = h('div.ld-lsplit-menu#delay-fetch-menu', { role: 'menu', 'aria-label': 'What Fetch measures', hidden: !delay.menu },
      ...FETCH_SCOPES.map(([k, t, sub]) => h('button.ld-lsplit-item', { type: 'button', role: 'menuitemradio', 'aria-checked': String(delay.scope === k), dataset: { scope: k }, onclick: () => pressFetch(k) },
        h('b', t), h('span', sub(behind())))));
    return h('div.ld-lsplit', main, caret, menu,
      busy ? h('button.btn.sm#delay-stop', { type: 'button', onclick: () => delay.token && delay.token.cancel() }, 'Stop') : null);
  });
}

function headActions() {
  const sched = delaySchedule();
  return W.get('w:acts', `${delay.clusterIds.length}|${sched ? sched.everyHours : 0}|${delay.ver}`, () => [
    fixButton({ kind: 'about', id: 'Live', items: () => ABOUT }),
    fetchControl(),
    h('button.btn.sm#delay-report', { type: 'button', disabled: !delay.clusterIds.length,
      title: 'A spreadsheet: every device measured, the summary, and every cluster that was not', onclick: exportDelayReport }, icon(ICON_DOWN), ' Report (.xlsx)'),
    h('button.btn.sm#delay-schedule', { type: 'button', title: 'Produce this report on a timer while the app is open', onclick: scheduleReport },
      icon(ICON_CLOCK), sched ? ` Every ${sched.everyHours} h` : ' Schedule…'),
  ]);
}

/** What the "i" beside the card's title says. LATE_MAX is the real per-cluster limit (core/log-delay.js). */
const ABOUT = [
  { title: 'Measured now, from this browser', cause: 'Fetch reads Elasticsearch directly for the cluster chosen in the top bar; nothing runs until it is pressed.' },
  { title: `Up to ${LATE_MAX} devices per cluster`, cause: 'On a larger cluster a late device can be missing here; Dashboard and Summary count every device from the core’s store, as of its last scheduled run or Fetch now.' },
];

/** Every device measured, as board rows (and, for "all devices in cluster", the silent ones); the delayed and part delayed ones only for "delayed". */
function liveRows() {
  const tz = ctx.tz ? ctx.tz() : null;
  const rows = (delay.records || []).map((r) => ({
    ...liveDeviceRow(r, byId(r.clusterId) || { id: r.clusterId, name: r.cluster }, levelsOf(r.clusterId)),
    fix: delay.fixes.get(`${r.clusterId}|${r.device}`) || null,
  }));
  if (delay.ran === 'cluster') {
    for (const { c, d } of delayRows()) {
      // A cut answer: a device that is not in it may have sent logs, so it is not called silent.
      if (!d.seen || (d.gaps || []).length) continue;
      const inRange = new Set((d.records || []).map((r) => String(r.device)));
      for (const s of d.seen.devices) if (!inRange.has(s.device)) rows.push({ ...silentDeviceRow(s.device, s.lastArrival, c), fix: delay.fixes.get(`${c.id}|${s.device}`) || null });
    }
  }
  const shown = rows.filter((r) => matchesZone(r, tz));
  return delay.ran === 'delayed' ? shown.filter((r) => isLate(r.state) || isPart(r.state)) : shown;
}

/** The columns: the boards' row, the address field's own column, the delay as a bar. */
function liveKeys(several, rows) {
  const ips = [...new Set(delayRows().map(({ c }) => logFilterFields(c).ip).filter(Boolean))];
  const ipKey = ips.length === 1 ? `x:${ips[0]}` : null;
  return { keys: withTypes(['device', ...(several ? ['cluster'] : []), 'zone', 'tag1', ...(ipKey ? [ipKey] : []), 'nowBar', 'state'], rows), ipKey, ip: ips[0] || null };
}

function devicesBody() {
  const several = delay.clusterIds.length > 1;
  const rows = liveRows();
  // Worst first by default: a critical device at the bottom of an alphabetical list is a device nobody sees.
  const rank = (st) => ({ critical: 0, delay: 1, part_delay: 1.5, clock_ahead: 2, silent: 3, unmeasured: 4, unknown: 5, little: 6, no_delay: 7 }[st] ?? 8);
  const base = [...rows].sort((a, b) => rank(a.state) - rank(b.state) || ((b.nowMinutes ?? -1e9) - (a.nowMinutes ?? -1e9)));
  const { keys, ipKey, ip } = liveKeys(several, rows);
  const extra = ipKey ? { [ipKey]: [ip, false, (r) => { const v = extraOf(r, ip); return h('td.mono', v === null ? h('span.muted', '—') : String(v)); }, { type: 'text', value: (r) => extraOf(r, ip) }] } : {};
  const ordered = sortLate.apply(base, sortCols(keys, extra));
  const w = delay.watched;
  return W.get('w:dev:body', `${delay.ver}|${ctx.tz ? ctx.tz() : ''}|${sortLate.sort ? `${sortLate.sort.key}${sortLate.sort.dir}` : '-'}`, () => {
    const note = coverageNote('fetch');
    const gaps = gapLines();
    const noTypes = noTypeLines();
    const max = Math.max(0, ...ordered.map((r) => (Number.isFinite(r.nowMinutes) ? r.nowMinutes : 0)));
    return [
      note ? h('div.banner.warn.ld-flat', note) : null,
      gaps.length ? h('div.banner.warn.ld-flat#ld-live-gaps', 'Not the whole cluster: ', ...gaps.map((x) => h('div', x))) : null,
      deviceTable({ id: 'ld-watch-devices', sort: sortLate, rows: ordered, keys, extra,
        ctx: { now: delay.at || Date.now(), mode: 'live', barMax: max, onWatch: watch, watching: (r) => !!(w && w.clusterId === r.cluster && w.device === r.device) },
        labels: { state: 'Level' },
        emptyText: delay.fetching ? 'Measuring…' : delay.ran === 'delayed' ? `No device is ${behind()} in ${rangeWords(ctx.range())}.` : 'No device sent logs in this range.' }),
      noTypes.length ? h('div.muted.ld-note#ld-live-notypes', `Not measured per log type: ${noTypes.join('; ')}`) : null,
      h('div.ld-foot', h('button.btn.sm#delay-csv', { type: 'button', disabled: !delay.records, onclick: exportDelayCsv }, icon(ICON_DOWN), ' Export CSV')),
    ];
  });
}

/** The All clusters warning (board 3): what Fetch would cost, the server's own schedule, three ways on. */
function warningBody() {
  const n = activeClusters().length;
  const s = delay.sched;
  return W.get('w:warn', `${n}|${JSON.stringify(s)}|${ctx.zone()}`, () => {
    const tz = ctx.zone();
    const sched = !s ? 'Reading the server’s schedule…'
      : s.supported === false ? 'This server does not run the scheduled measurement, so nothing measures every cluster for you.'
        : s.enabled === false ? 'The server’s scheduled measurement is switched off (Config-Management › Data › Scheduled log delay).'
          : `The server already measures every cluster on its schedule (${Number.isFinite(s.everyHours) ? `every ${s.everyHours} h` : 'interval not known yet'}, last run ${Number.isFinite(s.lastRunAt) ? zonedText(s.lastRunAt, tz, { seconds: false }) : 'not known yet'}) — its results are on Dashboard and Summary.`;
    return h('div.banner.warn.ld-lwarn#ld-all-warning', { role: 'alert' },
      h('span.ld-lwarn-ico', icon(ICON_WARN, { width: '16', height: '16' })),
      h('div.ld-lwarn-body',
        h('b', 'All clusters is a heavy fetch from this browser'),
        h('span', `Every cluster (${n}) would be searched now, one aggregation each, from this browser. ${sched}`),
        h('span.ld-lwarn-acts',
          h('button.btn.sm#ld-warn-dashboard', { type: 'button', onclick: () => { delay.warn = null; location.hash = ldHash('fleet'); } }, 'Open Dashboard'),
          h('button.btn.sm#ld-warn-pick', { type: 'button', onclick: () => { delay.warn = null; bump(); const sel = document.getElementById('cluster-select'); if (sel) { sel.focus(); try { sel.showPicker && sel.showPicker(); } catch (_) { /* not offered */ } } } }, 'Pick one cluster'),
          h('button.btn.sm.ld-warn-anyway#ld-warn-anyway', { type: 'button', onclick: () => fetchDelay(activeClusters(), delay.warn || delay.scope) }, `Fetch ${n} clusters anyway`))));
  });
}

/** The empty state: what Fetch would do, and that nothing runs until it is pressed. */
function emptyBody() {
  const one = chosen();
  const words = rangeWords(ctx.range());
  return W.get('w:empty', `${one ? one.id : '-'}|${words}`, () => h('div.ld-lempty#ld-live-empty',
    h('span.ld-lempty-ico', icon(ICON_FETCH)),
    h('b', 'Nothing fetched yet'),
    h('span', one ? `Fetch measures ${one.name} now, from this browser, over ${words}. Nothing runs until you press it.`
      : `Fetch measures the cluster chosen in the top bar, from this browser, over ${words}. All clusters are chosen: Fetch asks first. Nothing runs until you press it.`)));
}

/** The watched device's strip: delay now, late since, measured; Re-measure, Device details, Stop watching. */
function stripBody() {
  const w = delay.watched;
  if (!w) return null;
  return W.get('w:strip', `${delay.ver}`, () => {
    const r = w.row;
    const late = w.storeState === 'loading' ? 'Loading…'
      : Number.isFinite(w.lateSince) ? `${zonedText(w.lateSince, ctx.zone(), { seconds: false }).slice(11)} · ${minutesText((Date.now() - w.lateSince) / 60000)}`
        : Number.isFinite(w.silentSince) ? `silent since ${zonedText(w.silentSince, ctx.zone(), { seconds: false })}`
          : w.storeState === 'ok' ? 'not late in the store' : 'not known';
    const lateTitle = w.storeState === 'ok' ? 'From the core’s store (its scheduled measurement and Fetch now): when this device’s current delay began.'
      : w.storeState === 'unknown-device' ? 'The core’s store has not seen this device: one measurement from the browser cannot say since when it is late.'
        : 'The core’s store did not answer: one measurement from the browser cannot say since when it is late.';
    return h('div.ld-strip#ld-watch-strip', { dataset: { device: w.device } },
      h('div.ld-strip-k', h('span', 'Device'), h('b.mono', w.device)),
      h('div.ld-strip-k', h('span', 'Delay now'), h('b', r && Number.isFinite(r.nowMinutes) ? minutesText(r.nowMinutes) : r && r.state === 'silent' ? 'no logs in range' : '—')),
      hasTypes(r) ? h('div.ld-strip-k', { title: typesTitle(r.types) }, h('span', 'Log types'), h('b', typesText(r.types))) : null,
      h('div.ld-strip-k', { title: lateTitle }, h('span', 'Late since'), h('b', late)),
      h('div.ld-strip-k', h('span', 'Measured'), h('b', w.at ? zonedText(w.at, ctx.zone()).slice(11) : '—')),
      w.error ? h('span.ld-strip-err', { title: w.error }, pill('re-measure failed', 'red')) : null,
      h('span.ld-strip-gap'),
      h('button.btn.sm#ld-watch-remeasure', { type: 'button', disabled: w.remeasuring, onclick: remeasure }, icon(ICON_FETCH), w.remeasuring ? ' Measuring…' : ' Re-measure'),
      h('button.btn.sm#ld-watch-details', { type: 'button', onclick: () => { location.hash = ldHash('device', w.clusterId, w.device); } }, 'Device details ›'),
      h('button.btn.sm.ghost#ld-watch-stop', { type: 'button', onclick: stopWatching }, 'Stop watching'));
  });
}

/** The card's subtitle: what is shown, of which cluster, fetched when, over which range. */
function subText() {
  const one = chosen();
  const target = one ? one.name : `All clusters (${activeClusters().length})`;
  if (delay.running || delay.fetching) return `${target} · ${delay.running ? 'checking' : 'measuring'}…`;
  if (!delay.clusterIds.length) return `${target} · not fetched`;
  const names = delayRows().map(({ c }) => c.name);
  const asked = names.length > 2 ? `${names.length} clusters` : names.join(', ');
  const all = liveRows();
  const s = delay.summary;
  const silent = all.filter((r) => r.state === 'silent').length;
  const count = delay.ran === 'delayed' ? `${countText(all.length)} of ${countText(s ? s.devices : 0)} devices`
    : `${countText(all.length)} device${all.length === 1 ? '' : 's'}${silent ? ` · ${countText(silent)} silent` : ''}`;
  const when = delay.at ? zonedText(delay.at, ctx.zone(), { seconds: false }).slice(11) : '';
  return `${count} · ${asked} fetched ${when} · ${delay.window ? delay.window.text.replace(/^Last/, 'last') : ''}`;
}

/** The "Delayed now" card for the page to mount. */
export function watchCard() {
  W.begin();
  try {
    let body;
    if (!activeClusters().length) body = W.get('w:none', '', () => h('div.ld-lempty', h('b', 'No cluster selected')));
    else if (delay.warn && !chosen()) body = warningBody();
    else if (!delay.clusterIds.length) body = emptyBody();
    else body = [delay.records ? devicesBody() : null, problemsCard()].filter(Boolean);
    const shell = W.get('w:card', '', () => h('section.card.ld-lcard#ld-delayed-now', h('header', h('h2', 'Delayed now'), h('span.sub'), h('div.ld-lcard-acts')), h('div.body')));
    const head = shell.firstChild;
    const sub = subText();
    if (head.children[1].textContent !== sub) head.children[1].textContent = sub;
    mount(head.children[2], ...headActions());
    mount(shell.lastChild, ...[].concat(body).filter(Boolean));
    return shell;
  } finally { W.end(); }
}

/** The watched device's strip, for the Logs card's top (null while no device is watched). */
export function watchStrip() {
  W.begin();
  try { return stripBody(); } finally { W.end(); }
}

/**
 * What did not go right in the last Fetch, per cluster: refused (a field the parser does not
 * produce), unknown (the question did not get through), failed or never asked. Drawn only when
 * there is something to say; a cluster that was measured needs no row.
 */
function problemsCard() {
  const rows = delayRows();
  const bad = rows.filter(({ d }) => !(d.pre && d.pre.ok && !d.pre.unknown) || d.state === 'failed' || d.state === 'not-asked');
  if (!bad.length || delay.running) return null;
  return W.get('w:coverage', `${delay.ver}`, () => {
    const note = coverageNote('preflight');
    const stateCell = ({ d }) => {
      if (d.state === 'waiting') return h('span.muted', 'Loading…');
      if (d.state === 'skipped' || d.state === 'not-asked') return pill('never asked', 'grey');
      if (d.state === 'error') return pill('could not ask', 'orange');
      if (d.state === 'failed') return h('span', { title: d.fetchError }, pill('query failed', 'red'));
      if (!d.pre) return h('span.muted', '—');
      if (d.pre.unknown) return pill('unknown', 'orange');
      return d.pre.ok ? pill('can be analysed', 'green') : pill('cannot be analysed', 'red');
    };
    const why = ({ c, d }) => {
      if (d.state === 'error') return h('span.mono', d.error);
      if (d.state === 'failed') return h('span.mono', d.fetchError);
      if (d.state === 'skipped' || d.state === 'not-asked') return h('span.muted', 'The fetch was stopped before this cluster was reached — unknown, not empty.');
      if (!d.pre) return h('span.muted', '—');
      if (d.pre.unknown) return h('span', h('span.mono', d.pre.error || 'no answer'), h('span.muted', ' — the fields may be there; the question did not get through.'));
      return h('span', h('span.muted', 'not mapped in '), h('code.inline', c.logIndexPattern || 'logstash-*'), h('span.muted', ': '),
        h('span.mono', { style: { wordBreak: 'break-all' } }, (d.pre.missing || []).join(', ')));
    };
    const trs = bad.map((r) => h('tr', { dataset: { cluster: r.c.id } },
      h('td', h('div.ld-strong', r.c.name), h('div.muted.mono.ld-tiny', r.c.url)), h('td', stateCell(r)), h('td.ld-wrap', why(r))));
    return card('Log delay coverage', `${bad.length} of ${rows.length} cluster(s) not measured`,
      h('div.ld-stack',
        note ? h('div.banner.warn.ld-flat', note) : null,
        bad.some(({ d }) => d.pre && !d.pre.ok && !d.pre.unknown)
          ? h('div.muted.ld-note', 'Set ', h('code.inline', 'delayFields'), ' on a cluster to the names its parser produces. Nothing is reported as zero — the analysis simply cannot run there.')
          : null,
        table(['Cluster', 'State', 'Detail'], trs)));
  });
}

/* ------------------------------- the report ------------------------------- */

/** What the fan-out did not cover, as rows for the report's own sheet. */
function missingClusters() {
  return delayRows().filter(({ d }) => !d.records).map(({ c, d }) => ({
    cluster: c.name,
    reason: d.state === 'failed' ? `query failed: ${d.fetchError || 'no reason given'}`
      : d.state === 'not-asked' ? 'never asked — the run was stopped'
        : d.state === 'error' ? `could not be checked: ${d.error || 'no reason given'}`
          : d.pre && !d.pre.ok && !d.pre.unknown ? `cannot be analysed: ${(d.pre.missing || []).join(', ')} not mapped`
            : d.pre && d.pre.unknown ? `unknown: ${d.pre.error || 'the cluster did not answer'}`
              : 'not measured',
  }));
}

function buildDelayReport() {
  const measured = delayRows().filter(({ d }) => d.records).length;
  const missing = missingClusters();
  return workbook(reportSheets(delay.records || [], delay.summary || {}, {
    generatedAt: delay.at || Date.now(),
    windowText: delay.window ? delay.window.text : rangeText(ctx.range(), ctx.zone()),
    measured, notMeasured: missing.length, missing, noLogTypes: noTypeLines(),
  }));
}

function exportDelayReport() {
  // No records is not a reason to refuse: the Not measured sheet is the whole answer then.
  if (!delay.clusterIds.length) { toast('Fetch first — nothing has been measured yet', 'warn'); return; }
  try {
    downloadBytes(reportFilename(delay.at || Date.now()), buildDelayReport(), XLSX_MIME);
    toast('Report saved');
  } catch (e) {
    toast(`Could not build the report: ${e.message}`, 'err', 6000);
  }
}

const SCHEDULE_KEY = 'elasticpro.delayReport.schedule';

/**
 * A saved report schedule, or null. A browser cannot write a file while nobody is looking at it,
 * so a schedule here means the app produces one when it is open, a Fetch was pressed and the
 * interval has passed — it never starts a measurement itself.
 */
function delaySchedule() {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.everyHours ? s : null;
  } catch (_) { return null; }
}

function saveSchedule(s) {
  try {
    if (s) localStorage.setItem(SCHEDULE_KEY, JSON.stringify(s));
    else localStorage.removeItem(SCHEDULE_KEY);
  } catch (_) { toast('This browser will not remember the schedule', 'warn'); }
}

async function scheduleReport() {
  const cur = delaySchedule();
  const hours = h('select#delay-schedule-every',
    ...[1, 6, 12, 24, 168].map((n) => h('option', { value: String(n) },
      n < 24 ? `every ${n} hour${n === 1 ? '' : 's'}` : n === 24 ? 'once a day' : 'once a week')));
  hours.value = String((cur && cur.everyHours) || 24);
  const ok = await confirmDialog('Schedule this report?',
    h('div.ld-stack',
      h('label.field', 'Produce it', hours),
      h('div.muted',
        'A browser cannot save a file while nobody is looking at it. The report is built after a Fetch '
        + 'on this page once the interval has passed, and the download starts then. '
        + 'For something that runs unattended, use the scheduled log delay measurement and its mailed report '
        + '(Config-Management › Data › Scheduled log delay) — the core’s scheduler, which does not need a tab.'),
      cur ? h('div.muted', `Currently every ${cur.everyHours} h. Last produced ${cur.lastAt ? whenText(cur.lastAt, Date.now()) : 'never'}.`) : null),
    { yes: cur ? 'Update' : 'Schedule', no: cur ? 'Stop scheduling' : 'Cancel' });
  if (!ok) { if (cur) { saveSchedule(null); toast('Schedule stopped'); bump(); } return; }
  saveSchedule({ everyHours: Number(hours.value) || 24, lastAt: (cur && cur.lastAt) || 0 });
  toast(`Report scheduled — every ${hours.value} h after a Fetch while this page is open`);
  bump();
}

/** After a measurement: produce the report if one is due. */
function maybeScheduledReport() {
  const s = delaySchedule();
  if (!s || !delay.records) return;
  const due = (s.lastAt || 0) + s.everyHours * 3600 * 1000;
  if (Date.now() < due) return;
  saveSchedule({ ...s, lastAt: Date.now() });
  exportDelayReport();
}

/**
 * The devices as a file, with zone and tag1, and the clusters that were not measured: a partial
 * export that does not say it is partial becomes a number in somebody's report.
 */
function exportDelayCsv() {
  if (!delay.records) return;
  // The rows on screen (the fetch's scope and the time-zone filter), the silent ones too.
  const live = liveRows();
  const withT = live.some(saysTypes);
  const typeCols = (x) => (withT ? { log_types: hasTypes(x) ? `${x.types.total}${x.types.truncated ? '+' : ''}` : '', log_types_measured: hasTypes(x) ? x.types.measured : '', log_types_late: hasTypes(x) && x.types.measured !== 0 ? x.types.late : '', late_log_types: hasTypes(x) ? x.types.lateNames.join('; ') : '' } : {});
  const rows = live.map((x) => ({
    cluster: x.clusterName, device: x.device, zone: extraOf(x, 'zone') ?? '', tag1: extraOf(x, 'tag1') ?? '',
    state: x.state === 'unknown' ? 'levels unknown' : stateText(x.state), ...typeCols(x),
    delay_minutes: Number.isFinite(x.nowMinutes) ? x.nowMinutes.toFixed(2) : '',
    raw_gap_minutes: Number.isFinite(x.rawGapMinutes) ? x.rawGapMinutes.toFixed(2) : '',
    time_zone_offset: Number.isFinite(x.tzOffsetMinutes) ? offsetLabel(x.tzOffsetMinutes) : '',
    pattern: x.pattern || '', docs: x.docs ?? '',
    last_seen: x.lastArrival ? new Date(x.lastArrival).toISOString() : '', detail: x.patternNote || '',
  }));
  const noteRow = (detail) => ({ cluster: '', device: '', zone: '', tag1: '', state: '', ...typeCols(null), delay_minutes: '', raw_gap_minutes: '', time_zone_offset: '', pattern: '', docs: '', last_seen: '', detail });
  const missed = delayRows().filter(({ d }) => !d.records).map(({ c, d }) => `${c.name} (${d.state})`);
  if (missed.length) rows.push(noteRow(`not measured: ${missed.join('; ')}`));
  for (const x of gapLines()) rows.push(noteRow(`read in part: ${x}`));
  for (const x of noTypeLines()) rows.push(noteRow(`not measured per log type: ${x}`));
  const scope = `rows: ${delay.ran === 'delayed' ? 'delayed devices only' : delay.ran === 'cluster' ? 'every device, the silent ones too' : 'the devices that sent logs'}${ctx.tz && ctx.tz() !== null && ctx.tz() !== undefined ? ', in the time-zone filter' : ''}${delay.window ? ` · ${delay.window.text}` : ''}`;
  rows.push(noteRow(scope));
  download(`log-delay-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(rows));
}

/** For a test or a new config: forget everything measured. */
export function watchReset() {
  watchLeave();
  Object.assign(delay, { clusterIds: [], byCluster: new Map(), records: null, summary: null, at: 0, window: null, fixes: new Map(), warn: null, sched: null, watched: null, menu: false });
  delay.ver += 1;
  W.clear();
}

