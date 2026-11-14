/**
 * The Log Delay page's boards (0.3.57, on their own page since 0.3.60): the messages, the
 * routes, and the arithmetic the pages draw with. docs/LOGDELAY.md is the contract; this file is
 * the one place the UI reads its field names, and it touches no DOM, so tools/unit tests every
 * figure here.
 *
 *   #/log-delay                           the fleet (Main board)
 *   #/log-delay/cluster/<id>              one cluster (Cluster board)
 *   #/log-delay/device/<cluster>/<dev>    one device (Device board)
 *   #/log-delay/fixes[/<cluster>]         recommended fixes (Fix board)
 *   #/log-delay/watch                     Live Watch: every cluster measured now, from the browser
 *   #/log-delay/live[/<cluster>[/<dev>]]  Live logs, optionally narrowed to one device
 *
 * The old addresses still open the same views (reports/route.js movedPath): the mail's "Open the
 * full report" link, <url>/#/reports/log-delay[/…], and #/logs (Live logs).
 */

import { bridge } from './transport.js';
import { STATE_LABEL, isLate, levelState } from './delay-levels.js';
import { parseHash } from '../reports/route.js';
import { zonedParts } from './log-range.js';

/** The page's id, and the Reports section id the mail's link still names. */
export const LD_PAGE = 'log-delay';
export const LD_SECTION = 'log-delay';

/** Chart colours (owner's rule): light green, blue, pink, orange — never red with yellow. */
export const LD_COLOURS = Object.freeze({ green: '#bfe6bf', blue: '#a9c8f0', pink: '#f2a7c3', orange: '#f5b77a', line: '#f07c1b' });

/* --------------------------------- the messages --------------------------------- */

/** A LOGDELAY_* reply that says the core does not know the message: an older core. */
export function ldUnsupported(res) {
  return !!res && res.ok === false && (res.kind === 'bad_message' || /unknown message type/i.test(String(res.message || '')));
}

/**
 * One message to the core. `signal` lets a view that is left go of what it asked (the answer is
 * then `{ok: false, kind: 'aborted'}`, which no page draws).
 */
async function send(msg, signal) {
  let res;
  try { res = await bridge(msg, signal ? { signal } : undefined); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (!res) return { ok: false, kind: 'worker_error', message: 'the core did not answer' };
  if (ldUnsupported(res)) return { ...res, unsupported: true, message: 'This server has no log delay report yet (needs ElasticPro 0.3.57).' };
  return res;
}

/** Only the inputs the contract names, and only those given. */
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
const ids = (o) => (Array.isArray(o.clusterIds) && o.clusterIds.length ? { clusterIds: o.clusterIds } : {});

export const ldSummary = (o = {}) => send({ type: 'LOGDELAY_SUMMARY', ...pick(o, ['from', 'to', 'days', 'maxDevices']), ...ids(o) }, o.signal);
export const ldCluster = (o) => send({ type: 'LOGDELAY_CLUSTER', clusterId: o.clusterId, ...pick(o, ['from', 'to', 'days']) }, o.signal);
export const ldDevice = (o) => send({ type: 'LOGDELAY_DEVICE', clusterId: o.clusterId, device: o.device, ...pick(o, ['from', 'to', 'days']) }, o.signal);
export const ldSearch = (o = {}) => send({ type: 'LOGDELAY_SEARCH', ...pick(o, ['name', 'field', 'value', 'from', 'to', 'max']), ...ids(o) }, o.signal);
export const ldFixes = (o = {}) => send({ type: 'LOGDELAY_FIXES', ...pick(o, ['from', 'to']), ...ids(o) }, o.signal);
export const ldSettingsGet = () => send({ type: 'LOGDELAY_SETTINGS_GET' });
export const ldSettingsSet = (settings) => send({ type: 'LOGDELAY_SETTINGS_SET', settings });

/** The log_delay report kind (docs/LOGDELAY.md "Report kind log_delay"). */
export const LD_KIND = 'log_delay';
export const ldReportRun = ({ clusterIds, period, mail = false, options }) =>
  send({ type: 'REPORT_RUN', kind: LD_KIND, clusterIds: clusterIds || [], ...(period ? { period } : {}), mail: !!mail, ...(options ? { options } : {}) });
export const ldScheduleGet = () => send({ type: 'REPORT_SCHEDULE_GET', kind: LD_KIND });
export const ldScheduleSet = (s) => send({ type: 'REPORT_SCHEDULE_SET', kind: LD_KIND, ...s });
export const ldSendNow = () => send({ type: 'REPORT_SEND_NOW', kind: LD_KIND });

/* ---------------------------------- the routes ---------------------------------- */

/** The page's views, in the order its tabs show them; the boards' views are below. */
export const LD_VIEWS = Object.freeze(['fleet', 'cluster', 'device', 'fixes', 'watch', 'live']);

/**
 * Which view of the Log Delay page a hash names: `{view, clusterId, device}`. Anything else
 * (another page, an unknown view) is the fleet. The old addresses are read through
 * reports/route.js parseHash, the one definition of where they moved.
 */
export function ldRoute(hash) {
  const fleet = { view: 'fleet', clusterId: null, device: null };
  const { page, rest } = parseHash(hash);
  if (page !== LD_PAGE) return fleet;
  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch (_) { return s || ''; } };
  const [kind, a, ...more] = rest ? rest.split('/') : [];
  if (kind === 'cluster' && a) return { view: 'cluster', clusterId: dec(a), device: null };
  if (kind === 'device' && a && more.length) return { view: 'device', clusterId: dec(a), device: dec(more.join('/')) };
  if (kind === 'fixes') return { view: 'fixes', clusterId: a ? dec(a) : null, device: null };
  if (kind === 'watch') return { view: 'watch', clusterId: null, device: null };
  if (kind === 'live') return { view: 'live', clusterId: a ? dec(a) : null, device: a && more.length ? dec(more.join('/')) : null };
  return fleet;
}

const enc = encodeURIComponent;
/** The hash for a view. */
export function ldHash(view, clusterId, device) {
  const base = `#/${LD_PAGE}`;
  if (view === 'cluster' && clusterId) return `${base}/cluster/${enc(clusterId)}`;
  if (view === 'device' && clusterId && device) return `${base}/device/${enc(clusterId)}/${enc(device)}`;
  if (view === 'fixes') return clusterId ? `${base}/fixes/${enc(clusterId)}` : `${base}/fixes`;
  if (view === 'watch') return `${base}/watch`;
  if (view === 'live') return clusterId ? `${base}/live/${enc(clusterId)}${device ? `/${enc(device)}` : ''}` : `${base}/live`;
  return base;
}

/** The tab a view is shown under: the boards are one tab, Fixes, Live Watch and Live logs their own. */
export function ldTab(view) {
  if (view === 'fixes' || view === 'watch' || view === 'live') return view;
  return 'fleet';
}

/* ----------------------------------- Fetch Now ----------------------------------- */

/** The scheduled measurement's job (docs/JOBS.md): what Fetch Now asks to run. */
export const LD_JOB = 'logdelay.measure';
/** How often Fetch Now asks how its run is going. */
export const FETCH_POLL_MS = 2000;
/** The statuses a run ends in (docs/JOBS.md "Statuses"). */
export const RUN_ENDED = Object.freeze(new Set(['completed', 'failed', 'cancelled', 'deferred', 'skipped']));

/**
 * `JOB_RUN` for the measurement, scoped to what is on screen: the clusters, and one device when
 * a device is open. A core that does not take the scope yet runs what it runs; the scope is sent
 * anyway, so the page needs no change when it does.
 */
export function fetchNowMessage({ clusterIds, device, devices } = {}) {
  // One cluster at a time (docs/LOGDELAY.md "Fetch now"): `devices` is `late` (the core's default:
  // the devices 15 min or more behind at the start) or `all`; a named device needs neither.
  return {
    type: 'JOB_RUN', jobId: LD_JOB,
    ...(Array.isArray(clusterIds) && clusterIds.length ? { clusterIds: clusterIds.slice(0, 1).map(String) } : {}),
    ...(device ? { device: String(device) } : devices ? { devices: devices === 'all' ? 'all' : 'late' } : {}),
  };
}

/** Whether a Fetch now scope can run at all: exactly one cluster (the fleet has no Fetch now). */
export const fetchNowAllowed = (scope) => !!(scope && Array.isArray(scope.clusterIds) && scope.clusterIds.length === 1);
export const ldFetchNow = (scope, signal) => send(fetchNowMessage(scope), signal);
export const ldJobRuns = (signal) => send({ type: 'JOBS_LIST', jobId: LD_JOB, limit: 50 }, signal);

/** The run `runId` in a JOBS_LIST answer: from its runs, or the job's current or last run. Null when absent. */
export function runOf(list, runId) {
  if (!list || !runId) return null;
  const hit = (list.runs || []).find((r) => r && r.id === runId);
  if (hit) return hit;
  const job = (list.jobs || []).find((j) => j && j.id === LD_JOB);
  const st = (job && job.state) || {};
  for (const r of [st.current, st.lastRun]) if (r && r.id === runId) return r;
  return null;
}

/**
 * A run in words: "running · 3 of 8 clusters (37 %) · 1,240 devices measured". A count the run
 * does not keep is left out, never 0; progress the job cannot count says so.
 */
export function runText(run) {
  if (!run) return 'waiting for the run to be listed';
  const parts = [];
  const status = String(run.status || 'unknown');
  parts.push(status === 'running' ? 'running' : status === 'queued' ? 'queued' : status === 'completed' ? 'done' : status);
  // A person's run is one cluster and counts devices (docs/LOGDELAY.md "Fetch now"); the timer's counts clusters.
  const unit = run.scope && Array.isArray(run.scope.clusterIds) && run.scope.clusterIds.length === 1 ? 'device' : 'cluster';
  if (finite(run.done) && finite(run.total)) parts.push(`${countText(run.done)} of ${countText(run.total)} ${unit}${run.total === 1 ? '' : 's'}${finite(run.progress) ? ` (${Math.round(run.progress)} %)` : ''}`);
  else if (!RUN_ENDED.has(status)) parts.push('progress not known yet');
  if (finite(run.records)) parts.push(`${countText(run.records)} device${run.records === 1 ? '' : 's'} ${status === 'running' ? 'read so far' : 'measured'}`);
  if (run.error && status !== 'completed') parts.push(String(run.error));
  return parts.join(' · ');
}

/** A refused or failed Fetch Now in plain words; null when it started. */
export function fetchRefusalText(res) {
  if (!res) return 'The server did not answer.';
  if (res.ok) return null;
  if (res.kind === 'already_running') return `A measurement is already running${res.runId ? ` (run ${res.runId})` : ''}. Following it instead of starting another.`;
  if (res.kind === 'blocked_readonly') return 'Not started: the measurement writes to its sink cluster and the configuration is read-only. Set readOnly to false in the config to let it write.';
  if (res.kind === 'forbidden') return 'Not started: only an administrator can start the measurement.';
  if (res.unsupported || res.kind === 'bad_message' || res.kind === 'not_found') return 'Not started: this server cannot run the measurement on demand (needs the hosted edition with the scheduled log delay measurement).';
  return `Not started: ${res.message || res.kind || 'no reason given'}`;
}

/* ------------------------------- zone, tag1 and the rest ------------------------------- */

/**
 * The value of a context field on a row: its `extras` (the boards) or `meta` (Live Watch),
 * matched without regard to case, and the names the pipelines use for the same thing
 * (`fwdtag` for `fwd_tag`). Null when the row does not carry it — unknown, never ''.
 */
const SAME = { fwd_tag: ['fwd_tag', 'fwdtag'], zone: ['zone', 'Zone'] };
export function extraOf(row, name) {
  const bag = (row && (row.extras || row.meta)) || null;
  if (!bag) return null;
  const want = (SAME[name] || [name]).map((n) => n.toLowerCase());
  for (const [k, v] of Object.entries(bag)) {
    if (want.includes(String(k).replace(/\.keyword$/, '').toLowerCase()) && v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * A device Live Watch measured (core/log-delay.js recordFrom), as a board's device row
 * (docs/LOGDELAY.md DeviceRow), so both are drawn by the same row (ui/js/logdelay/rows.js).
 * The state is the contract's (delay-levels.js levelState on the cluster's levels); levels the
 * core has not said are `unknown`, never on time. What one measurement cannot know — the delays
 * before it, time spent late, logs a day — is null: drawn as unknown, not 0.
 */
export function liveDeviceRow(rec, cluster, levels) {
  const st = levelState(rec ? rec.delayMinutes : null, levels);
  return {
    device: rec.device, cluster: cluster.id, clusterName: cluster.name,
    state: st || 'unknown', nowMinutes: finite(rec.delayMinutes) ? rec.delayMinutes : null,
    // The zone step as the browser applied it (core/log-tz.js): the gap as measured, what was
    // taken out (the cluster's offset; null = no zone), the offset the gap itself sits at.
    rawGapMinutes: finite(rec.rawGapMinutes) ? rec.rawGapMinutes : null,
    tzOffsetMinutes: finite(rec.tzOffsetMinutes) ? rec.tzOffsetMinutes : null,
    clusterTzOffset: finite(rec.clusterTzOffset) ? rec.clusterTzOffset : (finite(rec.tzOffsetMinutes) ? rec.tzOffsetMinutes : null),
    deviceTzOffset: finite(rec.deviceTzOffset) ? rec.deviceTzOffset : null,
    medianMinutes: null, maxMinutes: null, episodes: null, lateMs: null, lastStarted: null, lastSolved: null, lateSince: null,
    docsPerDay: null, docs: finite(rec.docs) ? rec.docs : null,
    lastArrival: rec.arrival ?? null, lastEvent: rec.event ?? null, silentSince: null,
    pattern: rec.pattern && rec.pattern !== '-' ? rec.pattern : null, patternNote: rec.patternNote || '',
    extras: rec.meta || {}, live: true,
  };
}

/** The distinct values of `name` over rows, for a cluster line ("dc1, dc2 +1"); '—' when none is known. */
export function valuesText(rows, name, max = 3) {
  const seen = [...new Set((rows || []).map((r) => extraOf(r, name)).filter((v) => v !== null).map(String))].sort();
  if (!seen.length) return '—';
  return seen.length > max ? `${seen.slice(0, max).join(', ')} +${seen.length - max}` : seen.join(', ');
}

/* ---------------------------------- the periods ---------------------------------- */

export const PERIODS = Object.freeze([
  ['last30', 'Last 30 days'], ['last7', 'Last 7 days'], ['thisMonth', 'This month'], ['lastMonth', 'Last month'],
]);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A period id as the messages take it: `{days}` or `{from, to}` in local days. */
export function periodQuery(id, now = Date.now()) {
  const t = new Date(now);
  if (id === 'last7') return { days: 7 };
  if (id === 'thisMonth') return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: ymd(t) };
  if (id === 'lastMonth') return { from: ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: ymd(new Date(t.getFullYear(), t.getMonth(), 0)) };
  return { days: 30 };
}

/** The number of days a period covers (for "previous 30 days" in a header). */
export function periodDays(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`); const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 86400000) + 1 : null;
}

/* ---------------------------------- the words ---------------------------------- */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** "94 min", "3.8 min" under 10; null → the `unknown` text. Never 0 for unknown. */
export function minutesText(m, unknown = '—') {
  if (!finite(m)) return unknown;
  const a = Math.abs(m);
  return `${a < 10 && a !== Math.round(a) ? m.toFixed(1) : Math.round(m)} min`;
}

/** "18 h 40 min", "45 min", "0 min"; null → unknown. */
export function durationText(ms, unknown = '—') {
  if (!finite(ms) || ms < 0) return unknown;
  const mins = Math.round(ms / 60000);
  const hh = Math.floor(mins / 60); const mm = mins % 60;
  return hh ? `${hh} h ${String(mm).padStart(2, '0')} min` : `${mm} min`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * The zone the page writes times in: the server's, once the page has said it (setDisplayZone);
 * until then the browser's own. One setting, so every board and table agree.
 */
let displayZone = null;
export function setDisplayZone(tz) { displayZone = tz || null; }
export const displayZoneName = () => displayZone;

/** Wall-clock parts of `ms` in the display zone. */
const wall = (ms) => {
  if (displayZone) { const p = zonedParts(ms, displayZone); return { y: p.year, mo: p.month - 1, d: p.day, h: p.hour, mi: p.minute, s: p.second }; }
  const d = new Date(ms);
  return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
};
const two = (n) => String(n).padStart(2, '0');

/** "today 11:15" or "3 Nov 22:00"; `seconds` adds :ss. Unknown → '—'. In the display zone. */
export function whenText(ms, now = Date.now(), { seconds = false } = {}) {
  if (!finite(ms) || ms <= 0) return '—';
  const d = wall(ms); const n = wall(now);
  const t = `${two(d.h)}:${two(d.mi)}${seconds ? `:${two(d.s)}` : ''}`;
  return d.y === n.y && d.mo === n.mo && d.d === n.d ? `today ${t}` : `${d.d} ${MONTHS[d.mo]} ${t}`;
}

/** "6 Oct" from a YYYY-MM-DD day. */
export function dayText(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : String(day || '');
}

/** "41k", "1.2M", "850"; null → "unknown". */
export function docsText(n) {
  if (!finite(n)) return 'unknown';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export const pctText = (p, digits = 1) => (finite(p) ? `${p.toFixed(digits)} %` : '—');
export const countText = (n) => (finite(n) ? n.toLocaleString('en') : '—');

/** A device's state in words: "can't measure" and "silent" as such, never "on time". */
export const stateText = (s) => STATE_LABEL[s] || (s === 'unknown' ? 'levels unknown' : s ? String(s) : 'unknown');

/** The pill tone per state: pink critical, blue delayed and other time zone, green on time, orange clock ahead, grey unknown. */
export const STATE_TONE = Object.freeze({
  critical: 'ld-pink', delay: 'ld-blue', little: 'ld-green', no_delay: 'ld-green', clock_ahead: 'ld-orange', other_tz: 'ld-blue', silent: 'grey', unmeasured: 'grey',
});
export const stateTone = (s) => STATE_TONE[s] || 'grey';

/** "Delay now" for a row: minutes, or "—" (silent) / "can't measure" — never 0. */
export function nowText(row) {
  if (!row) return '—';
  if (finite(row.nowMinutes)) return minutesText(row.nowMinutes);
  return row.state === 'unmeasured' ? "can't measure" : '—';
}

/**
 * "Last delay: started → solved" (docs/LOGDELAY.md DeviceRow): "today 11:15 → still late",
 * "3 Nov 22:00 → 4 Nov 01:15", "no logs since 12:40", or "never late in this period".
 */
export function startedSolvedText(row, now = Date.now()) {
  if (!row) return '—';
  if (row.state === 'silent' && finite(row.silentSince)) return `no logs since ${whenText(row.silentSince, now).replace(/^today /, '')}`;
  if (finite(row.lateSince)) return `${whenText(row.lateSince, now)} → still late`;
  if (finite(row.lastStarted)) return `${whenText(row.lastStarted, now)} → ${finite(row.lastSolved) ? whenText(row.lastSolved, now) : 'still late'}`;
  return 'never late in this period';
}

/* ------------------------------ tables: order, filter ------------------------------ */

/** Devices sorted by time spent late, then delay now (unknown last), then name. */
export function byTimeLate(rows) {
  const n = (v) => (finite(v) ? v : -Infinity);
  return [...(rows || [])].sort((a, b) => n(b.lateMs) - n(a.lateMs) || n(b.nowMinutes) - n(a.nowMinutes) || String(a.device).localeCompare(String(b.device)));
}

/** Rows whose device, cluster or an extra value contains `q` (case-insensitive). */
export function filterRows(rows, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return rows || [];
  return (rows || []).filter((r) => [r.device, r.clusterName, r.cluster, ...Object.values(r.extras || {})]
    .some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(s)));
}

/** Worst first for the Delayed-devices rings: highest late share, then most late. */
export function ringsOrder(byCluster) {
  return [...(byCluster || [])].sort((a, b) => (finite(b.latePct) ? b.latePct : -1) - (finite(a.latePct) ? a.latePct : -1) || (b.lateNow || 0) - (a.lateNow || 0));
}

/* ------------------------------------ geometry ------------------------------------ */

/**
 * A ring's arc for `late` of `devices` (circumference 100): `{dash, share}`. A cluster with no
 * device measured has no share (null) — drawn as an empty ring with "—", never 0 %.
 */
export function ringDash(late, devices) {
  if (!finite(devices) || devices <= 0 || !finite(late)) return { dash: '0 100', share: null };
  const share = late / devices;
  const arc = late > 0 ? Math.max(share * 100, 2) : 0;
  return { dash: `${arc.toFixed(2)} ${(100 - arc).toFixed(2)}`, share };
}

/**
 * Day-by-day stacked bars, scaled to the tallest day: each `{day, gap, ok, del, crit, unk}` in
 * pixels. A day without totals is a gap (drawn as nothing, labelled "no measurement"), not 0.
 * `ok` is on time (onTimeAll), `unk` is silent + can't measure. `withOk:false` draws late only.
 */
export function dayBars(days, height, { withOk = true } = {}) {
  const list = days || [];
  const total = (d) => (withOk ? (d.onTimeAll || 0) : 0) + (d.delayed || 0) + (d.critical || 0) + (withOk ? (d.silent || 0) + (d.unmeasured || 0) : 0);
  const max = Math.max(1, ...list.filter((d) => d && finite(d.devices) && d.devices > 0).map(total));
  const px = (v) => (finite(v) && v > 0 ? Math.max(1, Math.round((v / max) * height)) : 0);
  return list.map((d) => {
    if (!d || !finite(d.devices) || d.devices <= 0) return { day: d && d.day, gap: true, ok: 0, del: 0, crit: 0, unk: 0 };
    return {
      day: d.day, gap: false,
      ok: withOk ? px(d.onTimeAll) : 0, del: px(d.delayed), crit: px(d.critical),
      unk: withOk ? px((d.silent || 0) + (d.unmeasured || 0)) : 0,
    };
  });
}

/** One day's bar in words, for its title. */
export function dayTitle(d) {
  if (!d || !finite(d.devices) || d.devices <= 0) return `${dayText(d && d.day)} · no measurement`;
  const unk = (d.silent || 0) + (d.unmeasured || 0);
  return `${dayText(d.day)} · ${d.delayed || 0} at 30–60 min, ${d.critical || 0} above 60 min, ${d.onTimeAll ?? '?'} on time`
    + (unk ? `, ${unk} silent or can't measure` : '') + (d.complete === false ? ' · day not over' : '');
}

/**
 * A sparkline's polylines in a `w`×`h` box: one points string per run of known values, so a
 * day without totals (null) is a gap in the line, never a drop to zero.
 */
export function sparkSegments(values, w = 120, h = 24, pad = 2) {
  const v = values || [];
  const known = v.filter(finite);
  if (!known.length) return [];
  const max = Math.max(...known); const min = Math.min(0, ...known);
  const span = max - min || 1;
  const x = (i) => (v.length > 1 ? (i * w) / (v.length - 1) : w / 2);
  const y = (n) => h - pad - ((n - min) / span) * (h - 2 * pad);
  const out = []; let cur = [];
  v.forEach((n, i) => {
    if (finite(n)) cur.push(`${x(i).toFixed(1)},${y(n).toFixed(1)}`);
    else if (cur.length) { out.push(cur.join(' ')); cur = []; }
  });
  if (cur.length) out.push(cur.join(' '));
  return out;
}

/** The "Delay reduced" bars: `{hours, n, label, px}`; an absent entry is unknown, not 0. */
export function reducedBars(reduced, height = 44) {
  const list = Array.isArray(reduced) ? reduced : [];
  const max = Math.max(1, ...list.map((r) => (finite(r.n) ? r.n : 0)));
  return [2, 4, 6, 12, 24].map((hours) => {
    const r = list.find((x) => x && x.hours === hours);
    const n = r && finite(r.n) ? r.n : null;
    return { hours, n, label: `${hours} h`, px: n === null ? 0 : Math.max(3, Math.round((n / max) * height)) };
  });
}

/**
 * The device graph: points → x in [0,1000] over [from,to], y in [0,height] with a scale that
 * holds the worst point and the critical line. Unknown points (m null) are breaks, not dots.
 */
export function deviceGraph(points, { fromMs, toMs, height = 240, levels } = {}) {
  const pts = (points || []).filter((p) => p && finite(p.t));
  const lo = finite(fromMs) ? fromMs : Math.min(...pts.map((p) => p.t));
  const hi = finite(toMs) ? toMs : Math.max(...pts.map((p) => p.t));
  const span = hi - lo || 1;
  const crit = levels && finite(levels.criticalOver) ? levels.criticalOver : null;
  const top = Math.max(crit ? crit * 1.5 : 0, ...pts.map((p) => (finite(p.m) ? p.m : 0)), 1);
  const scaleMax = niceCeil(top);
  const X = (t) => Math.max(0, Math.min(1000, ((t - lo) / span) * 1000));
  const Y = (m) => height - (Math.max(0, Math.min(m, scaleMax)) / scaleMax) * height;
  const segments = []; let cur = [];
  for (const p of pts) {
    if (finite(p.m)) cur.push(`${X(p.t).toFixed(1)},${Y(p.m).toFixed(1)}`);
    else if (cur.length) { segments.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) segments.push(cur.join(' '));
  return { segments, scaleMax, X, Y, lo, hi };
}

function niceCeil(v) {
  const steps = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880];
  return steps.find((s) => s >= v) || Math.ceil(v / 1440) * 1440;
}

/** The band for a delay period on the graph: left/width in % of [lo,hi], pink when it went critical. */
export function periodBand(p, lo, hi, now = Date.now()) {
  const span = hi - lo || 1;
  const a = Math.max(lo, finite(p.started) ? p.started : lo);
  const b = Math.min(hi, finite(p.solved) ? p.solved : now);
  if (b < lo || a > hi) return null;
  return { left: ((a - lo) / span) * 100, width: Math.max(((b - a) / span) * 100, 0.6), critical: p.worstState === 'critical' };
}

/** Late now of a list, for a sub line ("25 at 30–60 min, 12 above 60 min"). */
export function lateSplitText(t) {
  if (!t) return '';
  return `${countText(t.delay)} at 30–60 min, ${countText(t.critical)} above 60 min`;
}

/** Is this row late now (for colouring)? */
export const rowLate = (r) => !!r && isLate(r.state);

/** The finding step's pill tone (Fix board): Elasticsearch pink, forwarder blue, parser orange, clock green, link blue, unknown grey. */
export const STEP_TONE = Object.freeze({ elasticsearch: 'ld-pink', forwarder: 'ld-blue', parser: 'ld-orange', device_clock: 'ld-green', device_time_zone: 'ld-blue', device_link: 'ld-blue', cluster: 'ld-blue', unknown: 'grey' });
export const STEP_LABEL = Object.freeze({ elasticsearch: 'Elasticsearch', forwarder: 'Forwarder', parser: 'Parser', device_clock: 'Device clock', device_time_zone: 'Device clock / parser', device_link: 'Device', cluster: 'Cluster', unknown: 'Not enough evidence' });
export const stepLabel = (f) => (f && (f.stepLabel || STEP_LABEL[f.step])) || 'Not known yet';

/** A finding's evidence object in words ("devices 41 · windows 5 · forwarders 3"). Unknown values say so. */
export function evidenceText(ev) {
  if (!ev || typeof ev !== 'object') return '';
  return Object.entries(ev).map(([k, v]) => {
    const words = k.replace(/([A-Z])/g, ' $1').toLowerCase();
    if (v === null || v === undefined) return `${words} not known`;
    if (Array.isArray(v)) return `${words} ${v.join(', ') || 'none'}`;
    if (typeof v === 'object') return `${words} ${JSON.stringify(v)}`;
    return `${words} ${typeof v === 'number' ? v.toLocaleString('en') : v}`;
  }).join(' · ');
}
