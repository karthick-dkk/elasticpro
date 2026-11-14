/**
 * Log Delay › Live Watch: every cluster measured now, from the browser, over the page's time
 * range — the delayed devices listed with the same row as the boards (logdelay/rows.js), and one
 * device watched live. Until 0.3.60 this was the "Log delay" view of the Logs & Delay page.
 *
 * Delay is arrival time minus the time the event happened, per device (core/log-delay.js): a
 * preflight per cluster says whether it can be measured at all, then one aggregation per cluster
 * measures it. Both only ever start from a press; nothing this expensive starts because a page
 * drew or a timer fired. The close-up of one device is the only thing that repeats, and only
 * while it is on screen.
 *
 * Drawn card by card (lib/keyed.js): a cluster answering, a poll of the close-up or a push from
 * the core rebuilds only the card it changed. Leaving the view stops the close-up, stops the
 * fan-out and lets go of the requests still out.
 */

import { h, mount } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { num, ago, download, downloadBytes, toCsv } from '../lib/fmt.js';
import { tableSort } from '../lib/table-sort.js';
import { activeClusters, client, setDelaySummary } from '../core/state.js';
import { card, keptCard, empty, pill, table } from '../pages/common.js';
import { preflight, measureDelayIn, summarise, delayCoverage, buildDeviceQuery, documentDelays, deviceSnapshot, looksLikeIp } from '../core/log-delay.js';
import { levelsOf, loadLevels, levelState, isLate } from '../core/delay-levels.js';
import { runBounded, cancellation, partialNote } from '../core/fleet.js';
import { reportSheets, reportFilename } from '../core/delay-report.js';
import { liveDeviceRow, minutesText, stateText, extraOf, whenText, countText } from '../core/logdelay-report.js';
import { rangeBounds, rangeMinutes, rangeText } from '../core/log-range.js';
import { workbook, XLSX_MIME } from '../lib/xlsx.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { deviceTable, sortCols, statePill } from './rows.js';

/**
 * How many clusters are asked at once. Three, not "all of them": the clusters people point this
 * at are the ones already under load, and the delay query is a terms aggregation with a top_hits
 * per bucket.
 */
const FAN_OUT = 3;
/**
 * How often the close-up asks again. Fifteen seconds, not one: a device that is forty minutes
 * behind does not become interesting a second sooner for being asked four times as often.
 */
const WATCH_SECONDS = 15;

/** Live Watch's state, fleet-wide: every cluster is asked, so every cluster needs its own answer. */
const delay = {
  running: false,          // the preflight is in flight
  fetching: false,         // the measurement fan-out is in flight
  token: null,             // the stop button for whichever of those is running
  cancelled: false,
  progress: { done: 0, total: 0 },
  byCluster: new Map(),    // cluster id -> { state, pre, records, truncated, error, fetchError }
  records: null,           // every cluster's devices, merged
  summary: null,
  at: 0,
  window: null,            // the range the last measurement covered: {from, to, text}
  show: 'late',            // 'late' (delayed and critical) or 'all'
  ver: 0,                  // bumped whenever any of the above changed: what the cards are keyed on
  /** One device, watched live: { clusterId, device, pre, docs, snap, error, at, running, live }. */
  watch: null,
};

let watchTimer = null;
/** Lets go of the requests the view still has out (the fan-out, a poll). */
let ctl = null;
let ctx = { repaint: () => {}, range: () => ({ id: '1h' }), zone: () => null };
const W = nodeCache();
const bump = () => { delay.ver += 1; ctx.repaint(); };
const sortLate = tableSort('logdelay.watch', { onChange: () => bump() });

/** The view is shown: keep the page's hooks. */
export function watchEnter(c) {
  ctx = { ...ctx, ...c };
  if (!ctl && typeof AbortController !== 'undefined') ctl = new AbortController();
}

/** The view is left: the close-up stops, the fan-out stops, and the requests still out are let go of. */
export function watchLeave() {
  stopWatch();
  if (delay.watch) delay.watch.live = false;
  if (delay.token) delay.token.cancel();
  if (ctl) ctl.abort();
  ctl = null;
}

/** Whether something is being asked (the page's loading line). */
export function watchBusy() { return delay.running || delay.fetching || !!(delay.watch && delay.watch.running); }

/** Clusters on screen, each with what Live Watch knows about it. */
function delayRows() {
  return activeClusters().map((c) => ({ c, d: delay.byCluster.get(c.id) || { state: 'idle' } }));
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

/**
 * Ask every cluster whether it can be measured. One call per cluster, drawn as each answers.
 * Kept separate from the measurement so a cluster missing a field is a named refusal, not an
 * empty table that reads as "nothing is late".
 */
async function runPreflight() {
  const list = activeClusters();
  if (!list.length || delay.running || delay.fetching) return;
  const token = cancellation();
  delay.token = token; delay.running = true; delay.cancelled = false;
  delay.progress = { done: 0, total: list.length };
  // A watched device keeps the preflight it was opened with: a re-check must not turn its
  // next poll into "this cluster is no longer available".
  delay.byCluster = new Map(list.map((c) => [c.id, { state: 'waiting' }]));
  delay.records = null; delay.summary = null; delay.at = 0;
  bump();
  const out = await runBounded(list, (c) => preflight(client(c.id), c), {
    limit: FAN_OUT, token,
    onSettled: (s, p) => {
      setEntry(s.item.id, s.error ? { state: 'error', error: s.error.message || String(s.error) } : { state: 'checked', pre: s.value });
      delay.progress = { done: p.done, total: p.total };
      bump();
    },
  });
  for (const { item } of out.skipped) setEntry(item.id, { state: 'skipped' });
  delay.running = false; delay.cancelled = out.cancelled; delay.token = null;
  bump();
}

/** The clusters the preflight said can be measured. */
function analysable() {
  return delayRows().filter(({ d }) => d.pre && d.pre.ok && !d.pre.unknown).map(({ c, d }) => ({ c, pre: d.pre }));
}

/**
 * zone and tag1 ride along in the measurement's _source (not aggregated, so a cluster without
 * them simply has none): every Live Watch table shows them.
 */
function withContext(pre) {
  const meta = [...(pre.resolved.metadata || [])];
  const has = (n) => meta.some((m) => String(m).replace(/\.keyword$/, '').toLowerCase() === n);
  for (const n of ['zone', 'tag1']) if (!has(n)) meta.push(n);
  return { ...pre, resolved: { ...pre.resolved, metadata: meta } };
}

/** Measure every cluster that can be measured, over the page's range. Only from a press. */
async function fetchDelay() {
  if (delay.fetching || delay.running) return;
  if (!delay.byCluster.size) { await runPreflight(); if (delay.cancelled) return; }
  const targets = analysable();
  if (!targets.length) return;
  const win = windowOf();
  if (!win) { toast('Set both ends of the custom range first', 'warn'); return; }
  // What late means is the core's (LOGDELAY_SETTINGS_GET / _SUMMARY levels), asked before the
  // records are classified. Unanswered, a device reads "levels unknown".
  await loadLevels();
  const token = cancellation();
  delay.token = token; delay.fetching = true; delay.cancelled = false;
  delay.progress = { done: 0, total: targets.length };
  delay.window = win;
  for (const { c } of targets) setEntry(c.id, { state: 'fetching', records: null, fetchError: null });
  bump();
  const out = await runBounded(targets, ({ c, pre }) => measureDelayIn(client(c.id), c, withContext(pre), win, levelsOf(c.id), { signal: signal() }), {
    limit: FAN_OUT, token,
    onSettled: (s, p) => {
      const id = s.item.c.id;
      if (s.error) {
        const es = s.error.res && s.error.res.json && s.error.res.json.error;
        const aborted = s.error.res && s.error.res.kind === 'aborted';
        setEntry(id, aborted ? { state: 'not-asked' } : { state: 'failed', fetchError: (es && (es.reason || es.type)) || s.error.message || String(s.error) });
      } else {
        setEntry(id, { state: 'done', records: s.value.records, truncated: s.value.truncated });
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
  maybeScheduledReport();
}

/** One fleet-wide list of devices; `summarise` is the one definition of what it adds up to. */
function mergeDelay() {
  const done = delayRows().filter(({ d }) => d.records);
  if (!done.length) { delay.records = null; delay.summary = null; return; }
  const all = [];
  for (const { c, d } of done) for (const r of d.records) all.push({ ...r, cluster: c.name, clusterId: c.id });
  delay.records = all;
  delay.summary = summarise(all);
  delay.summary.truncated = done.reduce((n, { d }) => n + (d.truncated || 0), 0);
}

/** What the fan-out did not cover, in one line (delayCoverage is the one count). */
function coverageNote(phase) {
  return partialNote({ ...delayCoverage(delayRows().map(({ d }) => d), phase), cancelled: delay.cancelled });
}

/* --------------------------------- the toolbar --------------------------------- */

function toolbar() {
  const list = activeClusters();
  const can = analysable();
  const busy = delay.running || delay.fetching;
  const sched = delaySchedule();
  return W.get('w:bar', `${list.length}|${can.length}|${busy}|${delay.progress.done}/${delay.progress.total}|${delay.byCluster.size}|${!!delay.records}|${delay.show}|${sched ? sched.everyHours : 0}`, () => {
    const show = h('select#delay-show', { 'aria-label': 'Show', onchange: (e) => { delay.show = e.target.value; bump(); } },
      h('option', { value: 'late' }, 'Delayed devices'), h('option', { value: 'all' }, 'Every device'));
    show.value = delay.show;
    return h('div.toolbar.ld-watch-bar',
      h('span.muted.ld-hint', 'Delay is arrival time minus the time the event happened, per device, over the time range above, measured now from every cluster.'),
      h('label.field', 'Show', show),
      h('div.ld-bar-right',
        busy ? h('span.muted.ld-progress', h('span.spin'), ` ${delay.progress.done} of ${delay.progress.total}…`) : null,
        busy ? h('button.btn.sm#delay-stop', { type: 'button', onclick: () => delay.token && delay.token.cancel() }, 'Stop')
          : h('button.btn.sm#delay-check', { type: 'button', onclick: runPreflight }, delay.byCluster.size ? '↻ Re-check the fleet' : `Check ${list.length} cluster(s)`),
        h('button.btn.sm.primary#delay-fetch', { type: 'button', disabled: busy || (delay.byCluster.size > 0 && !can.length),
          title: delay.byCluster.size && !can.length ? 'No cluster has reported that it can be analysed' : '', onclick: fetchDelay },
        delay.records ? '↻ Measure again' : delay.byCluster.size ? `Fetch details (${can.length})` : `Check and measure ${list.length} cluster(s)`),
        h('button.btn.sm#delay-report', { type: 'button', disabled: !delay.byCluster.size,
          title: 'A spreadsheet: every device measured, the summary, and every cluster that was not', onclick: exportDelayReport }, '⤓ Report (xlsx)'),
        h('button.btn.sm.ghost#delay-schedule', { type: 'button', title: 'Produce this report on a timer while the app is open', onclick: scheduleReport },
          sched ? `⏱ ${sched.everyHours}h` : '⏱ Schedule…')));
  });
}

/* --------------------------------- the coverage --------------------------------- */

function coverageCard() {
  return W.get('w:coverage', `${delay.ver}`, () => {
    const rows = delayRows();
    const note = coverageNote('preflight');
    const yes = rows.filter(({ d }) => d.pre && d.pre.ok && !d.pre.unknown).length;
    const stateCell = ({ d }) => {
      if (d.state === 'waiting') return h('span.muted', 'Loading…');
      if (d.state === 'skipped' || d.state === 'not-asked') return pill('never asked', 'grey');
      if (d.state === 'error') return pill('could not ask', 'orange');
      if (!d.pre) return h('span.muted', '—');
      if (d.pre.unknown) return pill('unknown', 'orange');
      return d.pre.ok ? pill('can be analysed', 'green') : pill('cannot be analysed', 'red');
    };
    const why = ({ c, d }) => {
      if (d.state === 'error') return h('span.mono', d.error);
      if (d.state === 'skipped' || d.state === 'not-asked') return h('span.muted', 'The check was stopped before this cluster was reached — unknown, not empty.');
      if (!d.pre) return h('span.muted', '—');
      if (d.pre.unknown) return h('span', h('span.mono', d.pre.error || 'no answer'), h('span.muted', ' — the fields may be there; the question did not get through.'));
      if (d.pre.ok) {
        const m = (d.pre.metadataMissing || []).length;
        return h('span.muted', `group by ${d.pre.resolved.device}, event ${d.pre.resolved.eventTime}, arrival ${d.pre.resolved.arrival}` + (m ? ` · ${m} context field(s) absent` : ''));
      }
      return h('span', h('span.muted', 'not mapped in '), h('code.inline', c.logIndexPattern || 'logstash-*'), h('span.muted', ': '),
        h('span.mono', { style: { wordBreak: 'break-all' } }, (d.pre.missing || []).join(', ')));
    };
    const fetchCell = ({ d }) => {
      if (d.state === 'fetching') return h('span.muted', 'Loading…');
      if (d.state === 'failed') return h('span', { title: d.fetchError }, pill('query failed', 'red'));
      if (d.records) return h('span.num', num(d.records.length));
      return h('span.muted', '—');
    };
    const trs = rows.map((r) => h('tr', { dataset: { cluster: r.c.id } },
      h('td', h('div.ld-strong', r.c.name), h('div.muted.mono.ld-tiny', r.c.url)),
      h('td', stateCell(r)), h('td.num', fetchCell(r)), h('td.ld-wrap', why(r))));
    return card('Log delay coverage', `${yes} of ${rows.length} cluster(s) can be analysed`,
      h('div.ld-stack',
        h('div.muted.ld-note#ld-live-label', 'Live check from this browser, seconds fresh: it reads at most 500 devices per cluster (the display link’s limit). The Dashboard shows every device from the core’s store.'),
      note ? h('div.banner.warn.ld-flat', note) : null,
        rows.some(({ d }) => d.pre && !d.pre.ok && !d.pre.unknown)
          ? h('div.muted.ld-note', 'Set ', h('code.inline', 'delayFields'), ' on a cluster to the names its parser produces. Nothing is reported as zero — the analysis simply cannot run there.')
          : null,
        table(['Cluster', 'Preflight', { label: 'Devices', num: true }, 'Detail'], trs)));
  });
}

/* --------------------------------- the devices --------------------------------- */

const LIVE_COLS = ['device', 'cluster', 'zone', 'tag1', 'state', 'now', 'pattern', 'docsIn', 'arrival', 'event'];

/** Every device measured, as board rows; the delayed ones only unless "Every device" is chosen. */
function liveRows() {
  const byId = new Map(activeClusters().map((c) => [c.id, c]));
  const rows = (delay.records || []).map((r) => liveDeviceRow(r, byId.get(r.clusterId) || { id: r.clusterId, name: r.cluster }, levelsOf(r.clusterId)));
  return delay.show === 'all' ? rows : rows.filter((r) => isLate(r.state));
}

function devicesCard() {
  const s = delay.summary;
  const rows = liveRows();
  // Worst first by default: a critical device at the bottom of an alphabetical list is a device nobody sees.
  const rank = (st) => ({ critical: 0, delay: 1, clock_ahead: 2, unmeasured: 3, unknown: 4, little: 5, no_delay: 6 }[st] ?? 7);
  const base = [...rows].sort((a, b) => rank(a.state) - rank(b.state) || ((b.nowMinutes ?? -1e9) - (a.nowMinutes ?? -1e9)));
  const ordered = sortLate.apply(base, sortCols(LIVE_COLS));
  const late = (delay.records || []).filter((r) => isLate(levelState(r.delayMinutes, levelsOf(r.clusterId)))).length;
  const body = W.get('w:dev:body', `${delay.ver}|${delay.show}|${sortLate.sort ? `${sortLate.sort.key}${sortLate.sort.dir}` : '-'}`, () => {
    const note = coverageNote('fetch');
    const by = s ? Object.entries(s.by).filter(([, n]) => n > 0) : [];
    return [
      note ? h('div.banner.warn.ld-flat', note) : null,
      s && s.truncated ? h('div.muted.ld-note', `${num(s.truncated)} document(s) fall outside the top 500 devices per cluster — this list is not every device.`) : null,
      by.length ? h('div.ld-tally', ...by.map(([k, n]) => h('span', h('b', num(n)), ` ${k.toLowerCase().replace('_', ' ')}`))) : null,
      deviceTable({ id: 'ld-watch-devices', sort: sortLate, rows: ordered, keys: LIVE_COLS, ctx: { now: delay.at || Date.now(), watch: (r) => watchDevice(r.cluster, r.device) },
        labels: { arrival: 'Last arrival', event: 'Event time' },
        emptyText: delay.fetching ? 'Measuring…' : delay.show === 'late' ? 'No device is delayed in this range.' : 'No device sent logs in this range.' }),
      h('div.ld-foot', h('button.btn.sm#delay-csv', { type: 'button', onclick: exportDelayCsv }, 'Export CSV')),
    ];
  });
  const measured = delayRows().filter(({ d }) => d.records).length;
  const sub = `${delay.show === 'late' ? `${countText(late)} delayed of ${countText(s ? s.devices : 0)}` : `${countText(s ? s.devices : 0)} device(s)`} in ${measured} cluster(s)`
    + ` · ${s && s.median !== null ? `median ${minutesText(s.median)}` : 'no measurable delay'}`
    + ` · ${delay.window ? delay.window.text : ''}`
    + (delay.at ? ` · measured ${ago(delay.at)}` : ' · still measuring');
  return keptCard(W, 'w:dev', delay.show === 'late' ? 'Delayed devices' : 'Every device', sub, body);
}

/* --------------------------- one device, watched live --------------------------- */

function stopWatch() { if (watchTimer) clearInterval(watchTimer); watchTimer = null; }

function closeWatch() { stopWatch(); delay.watch = null; bump(); }

/**
 * Open the live view of one device. Its cluster's preflight is copied into the watch, so a
 * re-check of the fleet or another cluster picked in the top bar does not take it away.
 */
function watchDevice(clusterId, device) {
  const entry = delay.byCluster.get(clusterId);
  const c = activeClusters().find((x) => x.id === clusterId);
  if (!entry || !entry.pre || !entry.pre.ok || !c) return;
  stopWatch();
  delay.watch = { clusterId, cluster: c, device, pre: withContext(entry.pre), docs: null, snap: null, error: null, at: 0, running: false, live: true, total: null };
  bump();
  pollWatch();
  watchTimer = setInterval(() => {
    if (!delay.watch || !delay.watch.live) { stopWatch(); return; }
    pollWatch();
  }, WATCH_SECONDS * 1000);
}

function toggleWatchLive() {
  if (!delay.watch) return;
  delay.watch.live = !delay.watch.live;
  if (delay.watch.live) {
    pollWatch();
    stopWatch();
    watchTimer = setInterval(() => { if (!delay.watch || !delay.watch.live) { stopWatch(); return; } pollWatch(); }, WATCH_SECONDS * 1000);
  } else stopWatch();
  bump();
}

/** One round trip: the newest documents of this device in the page's range, and what they add up to. */
async function pollWatch() {
  const w = delay.watch;
  if (!w || w.running) return;
  const win = windowOf();
  if (!win) { w.error = 'Set both ends of the custom range first.'; bump(); return; }
  w.running = true;
  bump();
  try {
    const body = buildDeviceQuery(w.pre.resolved, { device: w.device, size: 15, fields: w.pre.fields || null, from: win.from, to: win.to });
    const cl = client(w.clusterId);
    if (!cl) throw new Error('This cluster is not connected.');
    const res = await cl.search(w.cluster.logIndexPattern || 'logstash-*', body,
      { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 30000, signal: signal() });
    if (delay.watch !== w) return;
    const docs = documentDelays(((res.hits || {}).hits) || [], w.pre.resolved, levelsOf(w.clusterId));
    w.docs = docs;
    w.snap = deviceSnapshot(docs, levelsOf(w.clusterId));
    const t = (res.hits || {}).total;
    w.total = t && typeof t === 'object' ? { value: t.value, more: t.relation === 'gte' } : typeof t === 'number' ? { value: t, more: false } : null;
    w.error = null;
    w.at = Date.now();
    w.window = win.text;
  } catch (e) {
    if (e && e.res && e.res.kind === 'aborted') return;
    const es = e.res && e.res.json && e.res.json.error;
    // The previous documents stay on screen: they were true when they were fetched, and
    // blanking them would turn one failed poll into "this device has no data".
    w.error = (es && (es.reason || es.type)) || e.message || String(e);
  } finally {
    w.running = false;
    if (delay.watch === w) bump();
  }
}

/**
 * The close-up: what this one device is doing, document by document. When it is open, it is
 * all Live Watch shows — the other devices and the per-cluster coverage come back with "Every
 * device ›".
 */
function watchCard() {
  const w = delay.watch;
  const s = w.snap;
  const levels = levelsOf(w.clusterId);
  const st = s ? levelState(s.latest, levels) || 'unknown' : null;
  const docsId = w.docs ? `${w.at}` : '-';
  // In pieces: the head changes on every poll (its "updated …"), the documents only when they
  // did — a poll that brought the same documents leaves the table under the mouse alone.
  const head = W.get('w:watch:head', `${w.clusterId}|${w.device}|${w.running}|${w.at}|${w.live}|${st}|${s ? `${s.latest}|${s.trend}` : '-'}`, () => h('div.ld-watch-head',
    s ? statePill(st) : h('span.muted', 'Loading…'),
    s && s.latest !== null ? h('b.ld-big', minutesText(s.latest)) : h('span.muted', 'no measurable delay'),
    s && s.trend !== 'NO_TREND' ? h('span.muted', s.trend === 'WORSENING' ? 'getting worse' : 'improving') : null,
    h('div.ld-bar-right',
      h('span.muted.ld-tiny', w.running ? 'Loading…' : w.at ? `updated ${whenText(w.at, Date.now(), { seconds: true })}` : ''),
      h('button.btn.sm#watch-live', { type: 'button', onclick: toggleWatchLive }, w.live ? `\u23F8 Pause (every ${WATCH_SECONDS}s)` : '\u25B6 Resume'),
      h('button.btn.sm#watch-now', { type: 'button', disabled: w.running, onclick: pollWatch }, '\u21BB Now'),
      h('a.btn.sm#watch-logs', { href: `#/log-delay/live/${encodeURIComponent(w.clusterId)}/${encodeURIComponent(w.device)}` }, 'Open in logs \u203A'),
      h('button.btn.sm.ghost#watch-close', { type: 'button', onclick: closeWatch }, 'Every device \u203A'))));
  const error = W.get('w:watch:err', `${w.error}|${!!w.docs}`, () => (w.error ? h('div.banner.err.ld-flat', h('div', h('div.ttl', 'The last poll failed'), h('div.mono', w.error),
    w.docs ? h('div.muted', 'The documents below are from the last poll that worked, not from now.') : null)) : null));
  const figures = W.get('w:watch:fig', `${docsId}|${w.window}`, () => (s ? table([], [
    h('tr', h('td.muted', 'Newest document'), h('td.mono', s.latest === null ? 'unknown' : minutesText(s.latest))),
    h('tr', h('td.muted', `Median of the last ${s.measurable}`), h('td.mono', s.median === null ? 'unknown' : minutesText(s.median))),
    h('tr', h('td.muted', 'Range'), h('td.mono', s.min === null ? 'unknown' : `${minutesText(s.min)} \u2026 ${minutesText(s.max)}`)),
    h('tr', h('td.muted', 'Documents matched'), h('td.mono', !w.total ? 'unknown' : `${num(w.total.value)}${w.total.more ? '+' : ''} in ${w.window || 'the range'}`)),
  ]) : null));
  const docs = W.get('w:watch:docs', `${(w.docs || []).map((d) => `${d.id}:${d.arrival}:${d.delayMinutes}`).join(',')}|${w.running && !w.docs}`, () => {
    const rows = (w.docs || []).map((d) => {
      const ds = levelState(d.delayMinutes, levels) || 'unknown';
      const zone = extraOf(d, 'zone'); const tag1 = extraOf(d, 'tag1');
      return h('tr',
        h('td.mono', d.event ? whenText(d.event, Date.now(), { seconds: true }) : h('span.muted', 'unreadable')),
        h('td.mono', d.arrival ? whenText(d.arrival, Date.now(), { seconds: true }) : h('span.muted', 'unreadable')),
        h('td.num', d.delayMinutes === null ? h('span.muted', 'unknown') : h('b', minutesText(d.delayMinutes))),
        h('td', statePill(ds)),
        h('td', zone === null ? h('span.muted', '\u2014') : String(zone)),
        h('td', tag1 === null ? h('span.muted', '\u2014') : String(tag1)),
        h('td.mono.muted.ld-tiny', d.index));
    });
    return table(['Event time', 'Arrival', { label: 'Delay', num: true }, 'Status', 'zone', 'tag1', 'Index'], rows,
      { emptyText: w.running ? 'Loading\u2026' : 'No document matched this device in the time range.' });
  });
  return keptCard(W, 'w:watch', `${w.device} \u2014 live`,
    `${w.cluster.name} \u00B7 ${looksLikeIp(w.device) ? 'matched as an address' : 'matched as a hostname'}`
    + (s && s.unreadable ? ` \u00B7 ${s.unreadable} of ${s.documents} document(s) unreadable` : ''),
    [head, error, figures, docs].filter(Boolean));
}

/* ------------------------------------ the view ------------------------------------ */

/** Live Watch's nodes for the page to mount. */
export function watchNodes() {
  W.begin();
  try {
    const list = activeClusters();
    const bar = toolbar();
    const wrap = W.get('w:wrap', '', () => h('div.rp-section.ld', { dataset: { ld: 'watch' } }));
    let kids;
    if (delay.watch) kids = [watchCard()];
    else if (!list.length) kids = [W.get('w:none', '', () => card('Live Watch', '', empty('No cluster selected')))];
    else if (!delay.byCluster.size) {
      kids = [W.get('w:start', `${list.length}`, () => card('Live Watch', `${list.length} cluster(s)`,
        empty('Press Check and measure to see every delayed device in the time range, measured now from each cluster.')))];
    } else kids = [delay.records ? devicesCard() : null, coverageCard()];
    mount(wrap, bar, ...kids.filter(Boolean));
    return wrap;
  } finally { W.end(); }
}

/** For the "logs arriving late" alert: open on the measurement, checking the fleet first. */
export function watchStart() { if (!delay.byCluster.size) runPreflight(); }

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
    measured, notMeasured: missing.length, missing,
  }));
}

function exportDelayReport() {
  // No records is not a reason to refuse: the Not measured sheet is the whole answer then.
  if (!delay.byCluster.size) { toast('Check the fleet first — nothing has been looked at yet', 'warn'); return; }
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
 * so a schedule here means the app produces one when it is open and the interval has passed.
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
        'A browser cannot save a file while nobody is looking at it. The report is built '
        + 'when this page is open and the interval has passed, and the download starts then. '
        + 'For something that runs unattended, use the scheduled log delay measurement and its mailed report '
        + '(Config-Management › Data › Scheduled log delay) — the core’s scheduler, which does not need a tab.'),
      cur ? h('div.muted', `Currently ${cur.everyHours}h. Last produced ${cur.lastAt ? ago(cur.lastAt) : 'never'}.`) : null),
    { yes: cur ? 'Update' : 'Schedule', no: cur ? 'Stop scheduling' : 'Cancel' });
  if (!ok) { if (cur) { saveSchedule(null); toast('Schedule stopped'); bump(); } return; }
  saveSchedule({ everyHours: Number(hours.value) || 24, lastAt: (cur && cur.lastAt) || 0 });
  toast(`Report scheduled — every ${hours.value}h while this page is open`);
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
 * The fleet's devices as a file, with zone and tag1, and the clusters that were not measured: a
 * partial export that does not say it is partial becomes a number in somebody's report.
 */
function exportDelayCsv() {
  if (!delay.records) return;
  const rows = delay.records.map((x) => {
    const st = levelState(x.delayMinutes, levelsOf(x.clusterId));
    return {
      cluster: x.cluster, device: x.device, zone: extraOf(x, 'zone') ?? '', tag1: extraOf(x, 'tag1') ?? '',
      state: st ? stateText(st) : 'levels unknown',
      delay_minutes: x.delayMinutes === null ? '' : x.delayMinutes.toFixed(2),
      pattern: x.pattern === '-' ? '' : x.pattern, docs: x.docs,
      last_seen: x.arrival ? new Date(x.arrival).toISOString() : '', detail: x.patternNote || x.reason || '',
    };
  });
  const missed = delayRows().filter(({ d }) => !d.records).map(({ c, d }) => `${c.name} (${d.state})`);
  if (missed.length) rows.push({ cluster: '', device: '', zone: '', tag1: '', state: '', delay_minutes: '', pattern: '', docs: '', last_seen: '', detail: `not measured: ${missed.join('; ')}` });
  download(`log-delay-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(rows));
}

/** For a test or a new config: forget everything measured. */
export function watchReset() {
  watchLeave();
  delay.byCluster = new Map(); delay.records = null; delay.summary = null; delay.at = 0; delay.watch = null; delay.window = null; delay.ver += 1;
  W.clear();
}
