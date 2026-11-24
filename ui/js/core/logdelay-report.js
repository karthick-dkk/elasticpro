/**
 * The Log Delay page's boards (0.3.57, on their own page since 0.3.60): the messages, the
 * routes, and the arithmetic the pages draw with. docs/LOGDELAY.md is the contract; this file is
 * the one place the UI reads its field names, and it touches no DOM, so tools/unit tests every
 * figure here.
 *
 *   #/log-delay                           Dashboard: the fleet (Main board)
 *   #/log-delay/cluster/<id>              one cluster (Cluster board), under the Dashboard tab
 *   #/log-delay/summary[/<cluster>]       Summary: the fleet view of Reports › Log delay before 0.3.60
 *                                         (tiles, delay reduced, day by day, a ring per cluster)
 *   #/log-delay/devices[/<cluster>]       Devices: every device, searched and filtered by state
 *   #/log-delay/device/<cluster>/<dev>    one device (Device board), under the Devices tab
 *   #/log-delay/watch                     Live Watch: every cluster measured now, from the browser
 *   #/log-delay/live[/<cluster>[/<dev>]]  Live logs, optionally narrowed to one device
 *
 * The old addresses still open the same views (reports/route.js movedPath): the mail's "Open the
 * full report" link, <url>/#/reports/log-delay[/…], and #/logs (Live logs). The Recommended
 * fixes tab went in 0.3.62 (every row has an "i" with its fix instead): #/log-delay/fixes[/<c>]
 * opens Devices.
 */

import { bridge } from './transport.js';
import { pct } from '../lib/fmt.js';
import { STATE_LABEL, isLate, levelState } from './delay-levels.js';
import { parseHash } from '../reports/route.js';
import { zonedParts } from './log-range.js';

/** The page's id, and the Reports section id the mail's link still names. */
export const LD_PAGE = 'log-delay';
export const LD_SECTION = 'log-delay';

/**
 * The colours of the levels (the owner, 2026-11-24): No delay green, the delay band yellow, above the
 * critical line red — the states' tokens every page uses (ui/css/app.css --state-*) — violet for
 * another time zone, grey for silent and can't measure. `delayLine` / `critLine`: a level's line, the
 * same hue a step stronger, so a thin line shows on a light page.
 */
export const LD_COLOURS = Object.freeze({
  ok: 'var(--state-ok)', delay: 'var(--state-late)', crit: 'var(--state-crit)', tz: 'var(--ld-tz)', silent: 'var(--ld-silent)', line: 'var(--accent)',
  delayLine: 'color-mix(in srgb, var(--state-late) 72%, var(--state-late-ink))', critLine: 'color-mix(in srgb, var(--state-crit) 72%, var(--state-crit-ink))',
});

/**
 * What the boards and the Clusters › Overview card say about the scheduled measurement — one
 * wording each, so the two pages cannot drift.
 */
export const LD_NEVER_MEASURED = 'never measured: not in the scheduled measurement yet';
export const LD_SCHEDULE_OFF = 'The scheduled measurement is switched off; the figures stop at its last run.';
export const LD_NO_SCHEDULER = 'This server does not run the scheduled measurement (hosted edition only): nothing new is measured.';

/**
 * The band names on a cluster's levels: "Below 30 min", "30–60 min", "Above 60 min" — the three
 * configured levels, and nothing else. Levels the core has not said read as words. The boards'
 * tiles and the Clusters › Overview card read the same names.
 */
/**
 * A cluster's change in its last run (By cluster's "Change", 0.3.81): devices that became late
 * (`up`) and that came back below the delay line (`down`) in the window of today that holds the
 * last run, `net` = up − down. null when the last run is not today or there are no windows —
 * unknown, never "no change".
 */
export function lastRunChange(c) {
  // null / undefined is "never measured", not the epoch (Number(null) is 0).
  if (!c || c.lastRunAt === null || c.lastRunAt === undefined || !Array.isArray(c.windows)) return null;
  const at = Number(c.lastRunAt);
  if (!Number.isFinite(at)) return null;
  const w = c.windows.find((x) => x && at >= x.from && at < x.to);
  if (!w) return null;
  const up = Number(w.newlyLate) || 0; const down = Number(w.solved) || 0;
  return { up, down, net: up - down, label: w.label || '' };
}

export function bands(levels) {
  const l = levels || {};
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const a = fin(l.delayFrom) ? l.delayFrom : null; const b = fin(l.criticalOver) ? l.criticalOver : null;
  return {
    below: a === null ? 'Below the delay line' : `Below ${a} min`,
    mid: a === null || b === null ? 'Delay' : `${a}–${b} min`,
    high: b === null ? 'Critical' : `Above ${b} min`,
    late: a === null ? 'at the delay level or more' : `${a} min or more`,
    lateShort: a === null ? 'late' : `${a}+ min`,
    backShort: a === null ? 'Back below the line' : `Back below ${a}`,
  };
}

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
export const LD_VIEWS = Object.freeze(['fleet', 'cluster', 'summary', 'devices', 'device', 'live']);

/**
 * Which view of the Log Delay page a hash names: `{view, clusterId, device}`. Anything else
 * (another page, an unknown view) is the fleet. The old addresses are read through
 * reports/route.js parseHash, the one definition of where they moved.
 */
export function ldRoute(hash) {
  const tz = tzOfHash(hash);
  const fleet = { view: 'fleet', clusterId: null, device: null, tz };
  const { page, rest } = parseHash(hash);
  if (page !== LD_PAGE) return fleet;
  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch (_) { return s || ''; } };
  const [kind, a, ...more] = rest ? rest.split('/') : [];
  if (kind === 'cluster' && a) return { view: 'cluster', clusterId: dec(a), device: null, tz };
  if (kind === 'device' && a && more.length) return { view: 'device', clusterId: dec(a), device: dec(more.join('/')), tz };
  if (kind === 'summary') return { view: 'summary', clusterId: a ? dec(a) : null, device: null, tz };
  // `fixes` is the old Recommended fixes address: its devices, with their fixes, are on Devices.
  if (kind === 'devices' || kind === 'fixes') return { view: 'devices', clusterId: a ? dec(a) : null, device: null, tz };
  // `watch` is the old Live Watch address: Live Watch and Live logs are one tab, Live, since the merge.
  if (kind === 'watch') return { view: 'live', clusterId: null, device: null, tz };
  if (kind === 'live') return { view: 'live', clusterId: a ? dec(a) : null, device: a && more.length ? dec(more.join('/')) : null, tz };
  return fleet;
}

/**
 * The time-zone filter a hash carries (`?tz=480`, `?tz=none`): the UTC offset in minutes the
 * devices in view sit at, `'none'` for the devices of a cluster whose zone is not detected, or
 * null (every zone). It is a filter like the others, so it lives in the address.
 */
export function tzOfHash(hash) {
  const q = String(hash || '').split('?')[1];
  if (!q) return null;
  const v = new URLSearchParams(q).get('tz');
  if (v === null || v === '') return null;
  if (v === 'none') return 'none';
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const enc = encodeURIComponent;
/** The hash for a view; `o.tz` (an offset in minutes, 'none') keeps the time-zone filter in it. */
export function ldHash(view, clusterId, device, o) {
  const base = `#/${LD_PAGE}`;
  const q = o && o.tz !== null && o.tz !== undefined ? `?tz=${enc(String(o.tz))}` : '';
  if (view === 'cluster' && clusterId) return `${base}/cluster/${enc(clusterId)}${q}`;
  if (view === 'device' && clusterId && device) return `${base}/device/${enc(clusterId)}/${enc(device)}${q}`;
  if (view === 'summary') return `${clusterId ? `${base}/summary/${enc(clusterId)}` : `${base}/summary`}${q}`;
  if (view === 'devices' || view === 'fixes') return `${clusterId ? `${base}/devices/${enc(clusterId)}` : `${base}/devices`}${q}`;
  if (view === 'live' || view === 'watch') return `${clusterId ? `${base}/live/${enc(clusterId)}${device ? `/${enc(device)}` : ''}` : `${base}/live`}${q}`;
  return `${base}${q}`;
}

/** The tab a view is shown under: Dashboard (the fleet, a cluster), Summary, Devices (the list, one device), Live. */
export function ldTab(view) {
  if (view === 'watch' || view === 'live') return 'live';
  if (view === 'summary') return view;
  if (view === 'devices' || view === 'device' || view === 'fixes') return 'devices';
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
  // the devices delayed or critical at the start, by the cluster's levels) or `all`; a named
  // device needs neither.
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

/**
 * A device the browser did not see in the range but did see before it (Live › Fetch all devices
 * in cluster: the lookback's newest arrival, core/log-delay.js measureSeenIn), as a board's
 * device row: silent, no delay figure (unknown, never 0), `silentSince` its last arrival.
 */
export function silentDeviceRow(name, lastArrival, cluster) {
  return {
    ...liveDeviceRow({ device: name, delayMinutes: null, arrival: finite(lastArrival) ? lastArrival : null, meta: {} }, cluster, null),
    state: 'silent', silentSince: finite(lastArrival) ? lastArrival : null,
  };
}

/**
 * The scheduled measurement as a LOGDELAY_SUMMARY answer says it — the one reading the boards'
 * Fetch now note and Live's All-clusters warning both use: `{supported, enabled, everyHours,
 * lastRunAt, nextDueAt}`, each null when the answer does not say (never a figure of ours).
 */
export function scheduleOf(res) {
  const sch = (res && res.schedule) || null;
  const st = (sch && sch.state) || {};
  const lastRun = (res && res.byCluster || []).reduce((m, c) => (finite(c.lastRunAt) && (m === null || c.lastRunAt > m) ? c.lastRunAt : m), null);
  return {
    supported: sch ? sch.supported !== false : res ? false : null,
    enabled: sch ? sch.enabled !== false : null,
    everyHours: sch && finite(sch.everyHours) ? sch.everyHours : res && finite(res.everyHours) ? res.everyHours : null,
    lastRunAt: sch && finite(sch.lastRunAt) ? sch.lastRunAt : lastRun,
    nextDueAt: finite(st.nextDueAt) ? st.nextDueAt : null,
  };
}

/** The distinct values of `name` over rows, for a cluster line ("dc1, dc2 +1"); '—' when none is known. */
export function valuesText(rows, name, max = 3) {
  const seen = [...new Set((rows || []).map((r) => extraOf(r, name)).filter((v) => v !== null).map(String))].sort();
  if (!seen.length) return '—';
  return seen.length > max ? `${seen.slice(0, max).join(', ')} +${seen.length - max}` : seen.join(', ');
}

/* ---------------------------------- the periods ---------------------------------- */

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A period id as the messages take it: `{days}` or `{from, to}` in local days. */
export function periodQuery(id, now = Date.now()) {
  const t = new Date(now);
  if (id === 'today') return { days: 1 };
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

/** The levels every cluster in a summary shares, or null when they differ (then each cluster's own). */
export function sharedLevels(byCluster) {
  const ls = (byCluster || []).map((c) => c && c.levels).filter(Boolean);
  if (!ls.length) return null;
  const k = (l) => `${l.delayFrom}|${l.criticalOver}`;
  return ls.every((l) => k(l) === k(ls[0])) ? ls[0] : null;
}

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

export const pctText = (p, digits = 1) => (finite(p) ? pct(p, digits, ' ') : '—');
export const countText = (n) => (finite(n) ? n.toLocaleString('en') : '—');

/* ------------------------------------ no delay ------------------------------------ */

/**
 * Shares in tenths of a percent that add up to exactly 100.0 % (largest remainder); null of nothing.
 * The core's own rounding (logdelay/summary.rs `tenths`), so a figure computed here agrees with it:
 * a part that has any is at least 0.1 %, taken from the largest, so nothing reads 0 % or 100 % that is not.
 */
export function shareTenths(parts) {
  const all = parts.reduce((n, p) => n + p, 0);
  if (!(all > 0)) return null;
  const out = parts.map((p) => Math.floor((p * 1000) / all));
  const rest = parts.map((p, i) => [(p * 1000) % all, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let left = 1000 - out.reduce((n, p) => n + p, 0);
  for (const [, i] of rest) { if (left <= 0) break; out[i] += 1; left -= 1; }
  parts.forEach((p, i) => { if (p > 0 && out[i] === 0) { out[out.indexOf(Math.max(...out))] -= 1; out[i] = 1; } });
  return out;
}

/**
 * The owner's "No delay" (2026-11-24), the ONE definition for every tile, percentage, bar, ring and
 * sentence: on time + silent + can't measure (a clock ahead is can't measure) — every device not
 * shown to be late — always with its split. Another time zone stays apart. `t` is the core's
 * `totals`, a `byCluster` row or a day; the core's own `noDelay` / `pct…` are used when it sends
 * them, else the same sum is made here. `why` (or the row's `notMeasured`): no percentage, and the
 * reason — never measured, its last run failed, no device.
 */
export function noDelayOf(t, { why = '' } = {}) {
  const x = t || {};
  const n = (v) => (finite(v) ? v : 0);
  const first = (...vs) => { const v = vs.find(finite); return v === undefined ? null : v; };
  // A core before 0.3.89 sends `noDelay` as the count strictly on time, and counts a clock ahead on time.
  const fresh = finite(x.cantMeasure) || x.pctNoDelay !== undefined;
  const said = first(x.onTimeAll, x.onTime, x.below);
  const onTime = fresh || said === null ? said : Math.max(0, said - n(x.clockAhead));
  const silent = n(x.silent); const cant = finite(x.cantMeasure) ? x.cantMeasure : n(x.unmeasured) + n(x.clockAhead);
  const late = first(x.late, x.lateNow, finite(x.critical) && finite(first(x.delay, x.delayed)) ? n(first(x.delay, x.delayed)) + x.critical : null);
  const count = fresh && finite(x.noDelay) ? x.noDelay : onTime === null ? null : onTime + silent + cant;
  const devices = first(x.devices);
  const reason = why || (typeof x.notMeasured === 'string' ? x.notMeasured : '') || (neverRan(x) ? 'never measured' : '') || (devices === 0 || count === null ? 'no device measured' : '');
  const of = x.pctOf && finite(x.pctOf.clusters) && x.pctOf.clusters < x.pctOf.ofClusters ? x.pctOf : null;
  let p = null;
  if (!reason && x.pctNoDelay !== undefined) {
    if (finite(x.pctNoDelay)) p = { noDelay: x.pctNoDelay, onTime: x.pctOnTime, silent: x.pctSilent, cant: x.pctCantMeasure, late: x.pctLate, tz: x.pctOtherTz };
  } else if (!reason) {
    const parts = shareTenths([n(onTime), silent, cant, n(late), n(x.otherTz)]);
    if (parts) p = { noDelay: (parts[0] + parts[1] + parts[2]) / 10, onTime: parts[0] / 10, silent: parts[1] / 10, cant: parts[2] / 10, late: parts[3] / 10, tz: parts[4] / 10 };
  }
  return { count, devices, onTime, silent, cant, late, lateBeforeSilent: n(x.lateBeforeSilent), pct: p,
    of, why: p ? '' : reason || (of && of.clusters === 0 ? 'no cluster was measured in its last run' : 'not measured') };
}
const neverRan = (x) => 'lastRunAt' in x && !finite(x.lastRunAt);

/** noDelayOf for a browser measurement (core/log-delay.js summarise: `devices`, `by` status): the same sum. */
export function noDelayOfStatuses(s) {
  const by = (s && s.by) || {};
  const n = (k) => Number(by[k]) || 0;
  return noDelayOf({ devices: Number(s && s.devices) || 0, onTime: n('OK'), silent: n('NO_DATA'), cantMeasure: n('ERROR') + n('CLOCK_AHEAD'), late: n('DELAYED') + n('CRITICAL'), otherTz: n('OTHER_TZ') },
    { why: n('UNKNOWN') ? 'the levels of some devices are not known' : '' });
}

/** A share as it is written: "95 %", "94.7 %"; unknown "—". */
export const shareText = (p) => (finite(p) ? pct(p, Number.isInteger(p) ? 0 : 1, ' ') : '—');

/** The split beside "No delay": "on time 89 % · silent 6 % · can't measure 0 %", counts when there is no percentage. */
export function noDelaySplit(nd, { counts = false } = {}) {
  if (!nd || nd.count === null) return nd ? nd.why : '';
  const v = (p, n) => (counts || !nd.pct ? countText(n) : shareText(p));
  const p = nd.pct || {};
  const l = nd.lateBeforeSilent;
  return `on time ${v(p.onTime, nd.onTime)} · silent ${v(p.silent, nd.silent)} · can't measure ${v(p.cant, nd.cant)}`
    + (l > 0 ? ` · ${countText(l)} of them ${l === 1 ? 'was' : 'were'} late before ${l === 1 ? 'it' : 'they'} went silent` : '');
}
/** "of 30 of 32 clusters": how much of the fleet a percentage speaks for; '' when all of it. */
export const noDelayOfText = (nd) => (nd && nd.of ? `of ${countText(nd.of.clusters)} of ${countText(nd.of.ofClusters)} clusters` : '');

/** A device's state in words: "can't measure" and "silent" as such, never "on time". */
export const stateText = (s) => STATE_LABEL[s] || (s === 'unknown' ? 'levels unknown' : s ? String(s) : 'unknown');

/**
 * The pill tone per state (the three configured levels and the two states apart): green below
 * the delay line, light blue in the delay band, blue
 * above the critical line, violet for another time zone, grey for silent and can't measure (a clock ahead is one: how late
 * its logs are cannot be told from it).
 * `little` is what a core before 0.3.62 stored: below the line, so green.
 */
export const STATE_TONE = Object.freeze({
  critical: 'ld-crit', delay: 'ld-delay', little: 'ld-ok', no_delay: 'ld-ok', clock_ahead: 'grey', other_tz: 'ld-tz', silent: 'grey', unmeasured: 'grey',
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
  // Not measured since: what is known of it ends at the last measurement.
  const open = row.stale === true && finite(row.lastMeasuredMs) ? `not solved · last measured ${whenText(row.lastMeasuredMs, now).replace(/^today /, '')}` : 'still late';
  if (finite(row.lateSince)) return `${whenText(row.lateSince, now)} → ${open}`;
  if (finite(row.lastStarted)) return `${whenText(row.lastStarted, now)} → ${finite(row.lastSolved) ? whenText(row.lastSolved, now) : open}`;
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

/**
 * The Devices tab's state filters (the KPI tiles open the list on one of them): `all`, `late`
 * (the delay band and above), the three configured levels (`ok` below the delay line; `delay`;
 * `critical`), `tz` (another time zone), `silent` (silent or can't measure, a clock ahead among
 * them — none has a figure) and `noDelay` (noDelayOf: ok and silent together). `little` is a core-before-0.3.62 state: below the line.
 */
export const DEVICE_FILTERS = Object.freeze(['all', 'late', 'critical', 'delay', 'noDelay', 'ok', 'tz', 'silent']);
const FILTER_STATES = Object.freeze({
  late: ['delay', 'critical'], critical: ['critical'], delay: ['delay'], ok: ['no_delay', 'little'], tz: ['other_tz'], silent: ['silent', 'unmeasured', 'clock_ahead'],
  noDelay: ['no_delay', 'little', 'silent', 'unmeasured', 'clock_ahead'],
});
export function matchesFilter(row, filter) {
  if (!filter || filter === 'all') return true;
  const states = FILTER_STATES[filter];
  return !!states && !!row && states.includes(row.state);
}
/** How many rows each filter would keep: the chips' counts. */
export function filterCounts(rows) {
  return Object.fromEntries(DEVICE_FILTERS.map((f) => [f, (rows || []).filter((r) => matchesFilter(r, f)).length]));
}

/* ------------------------------------ the Summary tab ------------------------------------ */

/**
 * The Summary tab (the fleet view of Reports › Log delay before 0.3.60, back on the owner's word):
 * four tiles, Delay reduced, Day by day and a ring per cluster — all the core's LOGDELAY_SUMMARY
 * figures (`totals`, `reduced`, `days`, `byCluster`), nothing counted here.
 */

/** "116 at 30–60 min, 440 above 60 min": the late now of `totals`, on the levels' own names (bands). */
export function lateSplitText(t, b = bands(null)) {
  if (!t) return '';
  return `${countText(t.delay)} at ${b.mid}, ${countText(t.critical)} ${b.high.toLowerCase()}`;
}

/** The "Delay reduced" bars, 2 h to 24 h: `{hours, n, label, px}`. An entry the core did not send is unknown (n null, no bar), not 0. */
export function reducedBars(reduced, height = 44) {
  const list = Array.isArray(reduced) ? reduced : [];
  const max = Math.max(1, ...list.map((r) => (r && finite(r.n) ? r.n : 0)));
  return [2, 4, 6, 12, 24].map((hours) => {
    const r = list.find((x) => x && x.hours === hours);
    const n = r && finite(r.n) ? r.n : null;
    return { hours, n, label: `${hours} h`, px: n === null ? 0 : n === 0 ? 0 : Math.max(3, Math.round((n / max) * height)) };
  });
}

const never = (c) => !c || c.lastRunAt === null || c.lastRunAt === undefined;

/**
 * The rings, worst first: the highest late share (`latePct`, the core's), then the most late now,
 * then the name. A cluster never measured, or with no late share, has no place in the order: last.
 */
export function ringsOrder(byCluster) {
  const unknown = (c) => never(c) || !finite(c.latePct);
  return [...(byCluster || [])].filter(Boolean).sort((a, b) => {
    const ua = unknown(a); const ub = unknown(b);
    if (ua !== ub) return ua ? 1 : -1;
    return (ua ? 0 : b.latePct - a.latePct) || (b.lateNow || 0) - (a.lateNow || 0) || String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
}

/**
 * A ring's arcs on a circumference of 100 — above the critical line first, then the delay band, then
 * No delay (`noDelay`, when known): `[{kind, dash, offset}]`, a sliver at least for a count above 0.
 * What is left is another time zone. Null when the share is not known (no device, a figure missing):
 * drawn as an empty ring with "—", never 0 %.
 */
export function ringArcs(delay, critical, devices, noDelay = null) {
  if (!finite(devices) || devices <= 0 || !finite(delay) || !finite(critical)) return null;
  const len = (n) => (n > 0 ? Math.max((n / devices) * 100, 1.5) : 0);
  const c = Math.min(100, len(critical)); const d = Math.min(100 - c, len(delay));
  const o = finite(noDelay) ? Math.min(100 - c - d, len(noDelay)) : 0;
  const arc = (kind, l, at) => ({ kind, dash: `${l.toFixed(2)} ${(100 - l).toFixed(2)}`, offset: (-at).toFixed(2) });
  return [c ? arc('critical', c, 0) : null, d ? arc('delay', d, c) : null, o ? arc('ok', o, c + d) : null].filter(Boolean);
}

/** A grid cell's hue: red when a device was above the critical line at that measurement, yellow when one was late, '' for none. */
export const gridHue = (w, v) => (!(v > 0) ? '' : finite(w && w.criticalAt) && w.criticalAt > 0 ? 'crit' : 'late');

/**
 * The documents the last runs read with no device name, summed over the clusters that said a
 * count above 0: `{docs, clusters}`, or null when none did (a cluster that did not report is not
 * counted as 0 — it is left out). `items` are `byCluster` rows, or `{lastRead}`.
 */
export function noDeviceTotal(items) {
  let docs = 0; let n = 0;
  for (const x of items || []) {
    const v = x && x.lastRead && x.lastRead.noDevice;
    if (finite(v) && v > 0) { docs += v; n += 1; }
  }
  return n ? { docs, clusters: n } : null;
}
/** That sum in one line: "12,404 documents in 9 clusters have no device name …"; one cluster needs no "in 1 cluster". */
export function noDeviceLine(sum) {
  if (!sum) return '';
  const one = sum.docs === 1;
  return `${countText(sum.docs)} document${one ? '' : 's'}${sum.clusters > 1 ? ` in ${countText(sum.clusters)} clusters` : ''} ${one ? 'has' : 'have'} no device name and ${one ? 'is' : 'are'} in no device’s figures`;
}

/**
 * Day by day, stacked and scaled to the tallest day: each `{day, gap, ok, delay, critical, tz}`
 * in pixels — no delay (noDelayOf: on time, silent, can't measure), the delay band, above the
 * critical line, another time zone. A day without totals is a gap (drawn hatched,
 * "no measurement"), never 0.
 */
export function dayBars(days, height) {
  const list = days || [];
  const gap = (d) => !d || !finite(d.devices) || d.devices <= 0;
  const n = (v) => (finite(v) ? v : 0);
  const free = (d) => n(noDelayOf(d).count);
  const total = (d) => free(d) + n(d.delayed) + n(d.critical) + n(d.otherTz);
  const max = Math.max(1, ...list.filter((d) => !gap(d)).map(total));
  const px = (v) => (finite(v) && v > 0 ? Math.max(1, Math.round((v / max) * height)) : 0);
  return list.map((d) => (gap(d)
    ? { day: d && d.day, gap: true, ok: 0, delay: 0, critical: 0, tz: 0 }
    : { day: d.day, gap: false, ok: px(free(d)), delay: px(d.delayed), critical: px(d.critical), tz: px(d.otherTz) }));
}

/** One day's bar in words, for its title, on the levels' own names. */
export function dayTitle(d, b = bands(null)) {
  if (!d || !finite(d.devices) || d.devices <= 0) return `${dayText(d && d.day)} · no measurement`;
  const nd = noDelayOf(d);
  return `${dayText(d.day)} · No delay ${countText(nd.count)} (${noDelaySplit(nd, { counts: true })}), ${countText(d.delayed)} at ${b.mid}, ${countText(d.critical)} ${b.high.toLowerCase()}`
    + (finite(d.otherTz) && d.otherTz ? `, ${countText(d.otherTz)} in another time zone` : '')
    + (d.complete === false ? ' · day not over' : '');
}

/**
 * The x labels under Day by day, one per bar ('' where none is written): each its own day — the
 * old board wrote five ticks picked by rounding, so a short period read "10 Nov" five times. As
 * many as labelEvery allows; the month once, then again only where it changes ("30 Oct", "31",
 * "1 Nov", "2").
 */
export function dayTicks(days) {
  const list = days || [];
  const every = labelEvery(list.length);
  let month = '';
  return list.map((d, i) => {
    if (i % every) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String((d && d.day) || ''));
    if (!m) return '';
    const mo = `${m[1]}-${m[2]}`;
    const text = mo === month ? String(Number(m[3])) : dayText(d.day);
    month = mo;
    return text;
  });
}

/** The fewest days Day by day covers (the owner's screenshot is the old board at "Last 7 days"). */
export const DAY_CHART_MIN_DAYS = 7;

/**
 * The days Summary's Day by day covers — the one definition: the page window's own local days
 * (`{from, to}` YYYY-MM-DD) when they are at least DAY_CHART_MIN_DAYS, else the last
 * DAY_CHART_MIN_DAYS days ending `today` (YYYY-MM-DD in the page's zone). Only this card widens;
 * the tiles and the rings stay on the page's window. `{from, to, days, widened}`.
 */
export function dayChartDays(win, today, min = DAY_CHART_MIN_DAYS) {
  const n = periodDays(win && win.from, win && win.to);
  if (n !== null && n >= min) return { from: win.from, to: win.to, days: n, widened: false };
  const t = Date.parse(`${today}T00:00:00Z`);
  return { from: new Date(t - (min - 1) * 86400000).toISOString().slice(0, 10), to: today, days: min, widened: true };
}

/** Day by day's header: "Last 7 days · 11 Nov – 17 Nov", or a longer range's "30 days · 19 Oct – 17 Nov". */
export function dayChartWords(w) {
  if (!w) return '';
  const span = w.from === w.to ? dayText(w.from) : `${dayText(w.from)} – ${dayText(w.to)}`;
  return `${w.widened ? `Last ${w.days} days` : `${w.days} day${w.days === 1 ? '' : 's'}`} · ${span}`;
}

/* ------------------------------------ the dashboard's charts ------------------------------------ */

/**
 * The Dashboard's three panels over the period — devices in the delay band, devices above the
 * critical line, and the delays solved (devices back below the line) — one bucket per day
 * (`days[]`: `delayed`, `critical`, `solved`) or, for Today, one per measurement window
 * (`windows[]`: `delay`, `critical` by each device's last state at the window's end, `solved`;
 * a core before 0.3.62 sends no split, then `delay`/`critical` are null — unknown, not 0). A day
 * without totals is a gap (`gap: true`), not zero; a window not yet over says `complete: false`.
 */
export function behindSeries(res, period) {
  if (!res) return [];
  if (period === 'today') {
    return (res.windows || []).map((w) => ({
      // Not measured (the core says so): a gap, never an earlier reading carried on or a 0.
      t: w.from, label: String(w.label || '').split(/[–-]/)[0].trim(), gap: w.measured === false, split: finite(w.delay) && finite(w.critical),
      behind: w.measured === false ? null : finite(w.stillLate) ? w.stillLate : finite(w.delay) && finite(w.critical) ? w.delay + w.critical : null,
      delay: w.measured !== false && finite(w.delay) ? w.delay : null, critical: w.measured !== false && finite(w.critical) ? w.critical : null,
      back: w.measured !== false && finite(w.solved) ? w.solved : null, complete: w.complete !== false,
    }));
  }
  return (res.days || []).map((d) => {
    const gap = !d || !finite(d.devices) || d.devices <= 0;
    return {
      t: d ? Date.parse(`${d.day}T00:00:00`) : NaN, label: dayText(d && d.day), gap, split: true,
      behind: gap ? null : (d.delayed || 0) + (d.critical || 0), delay: gap ? null : d.delayed || 0, critical: gap ? null : d.critical || 0,
      back: gap ? null : (finite(d.solved) ? d.solved : null), complete: !d || d.complete !== false,
    };
  });
}

/** A quiet y axis: about three steps, at 1 / 2 / 2.5 / 5 × a power of ten. */
export function niceStep(max) {
  const raw = Math.max(1, max) / 3;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}

/** Which x labels to write so they never crowd: every 4th of 24+ buckets, every 2nd past 10, else all. */
export const labelEvery = (n) => (n >= 24 ? Math.ceil(n / 6) : n > 10 ? 2 : 1);

/* ------------------------------ Late devices over the day ------------------------------ */

/**
 * The two counts Late devices over the day offers (the toggle): devices late — the delay band
 * and above the critical line, as By cluster's Late now and Change count them (`isLate`) — or
 * above the critical line only.
 */
export const LATE_MODES = Object.freeze(['late', 'critical']);
/** The clusters the grid shows before "All N", worst first. */
export const GRID_WORST = 10;

/** How many measurement windows a day has at the log-delay interval (12 at 2 h); null when not known. */
export function windowsPerDay(everyHours) {
  return finite(everyHours) && everyHours > 0 ? Math.ceil(24 / Math.min(24, everyHours)) : null;
}

/**
 * Devices late at a window's own measurement (`lateAt`, `criticalAt` of the core's windows,
 * 0.3.82): null when the window was not measured — never an earlier reading carried forward —
 * or when the core is older and does not say (`measured` absent): unknown, not 0.
 */
export function lateAtWindow(w, mode = 'late') {
  if (!w || w.measured !== true) return null;
  const v = mode === 'critical' ? w.criticalAt : w.lateAt;
  return finite(v) ? v : null;
}

/** A cluster's late count now on the toggle's terms: Late now (delay + critical) or Above the critical line; null never measured. */
export function lateNowOf(c, mode = 'late') {
  if (!c || c.lastRunAt === null || c.lastRunAt === undefined) return null;
  const v = mode === 'critical' ? c.critical : c.lateNow;
  return finite(v) ? v : null;
}

/**
 * "vs yesterday": the late count now less the count at yesterday's measurement of the same
 * window as the last run (`yesterdayWindow`); null when either is not known (yesterday's window
 * not measured, a core before 0.3.82) — never shown as "=".
 */
export function vsYesterday(c, mode = 'late') {
  const now = lateNowOf(c, mode);
  const then = lateAtWindow(c && c.yesterdayWindow, mode);
  return now === null || then === null ? null : now - then;
}

/** "▲ 18", "▼ 2", "=" — or '' when not known. */
export const vsText = (d) => (!finite(d) ? '' : d > 0 ? `▲ ${countText(d)}` : d < 0 ? `▼ ${countText(-d)}` : '=');

/**
 * A cell's shade on its own cluster's scale (the owner's rule: the cluster's worst window is
 * darkest, so a quiet cluster's rise still shows): 0 for none, else 1–4 by the share of the
 * worst; −1 unknown.
 */
export function gridShade(v, worst) {
  if (!finite(v)) return -1;
  if (v <= 0 || !finite(worst) || worst <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil((v / worst) * 4)));
}

/**
 * The grid's rows: one per cluster, a cell per window of today (`windowsPerDay`), each the
 * devices late at that window's measurement (`lateAtWindow`); `state` 'measured', 'missing'
 * (ended, not measured: hatched), 'pending' (the window in progress, `complete: false`, with no
 * reading yet — runs are not aligned to windows, so this is not a miss) or 'future' (not begun).
 * `measured` of `done` (the windows that ended, plus one in progress that already has a
 * reading: a pending window is not in the denominator), the worst cell, Late now and vs
 * yesterday on the same terms. Late now is the cluster's last measurement (its last run): when
 * that was before today's first window (`lastBeforeToday`, from midnight until the first run)
 * it is yesterday's last, and the board says so. `nextAt`: when the next measurement is due
 * (the last run plus the interval), null when not known. Worst first: Late now, then the worst
 * window, then the name; a cluster never measured last.
 */
export function lateGridRows(byCluster, everyHours, mode = 'late') {
  const n = windowsPerDay(everyHours) || 0;
  const rows = (byCluster || []).map((c) => {
    const ws = Array.isArray(c.windows) ? c.windows : [];
    const cells = Array.from({ length: n }, (_, i) => {
      const w = ws[i];
      if (!w) return { i, state: 'future', v: null, w: null };
      const v = lateAtWindow(w, mode);
      return { i, state: v !== null ? 'measured' : w.complete === false ? 'pending' : 'missing', v, w };
    });
    const vals = cells.filter((x) => x.state === 'measured').map((x) => x.v);
    const never = c.lastRunAt === null || c.lastRunAt === undefined;
    const dayStart = ws[0] && finite(ws[0].from) ? ws[0].from : null;
    const next = !never && finite(c.lastRunAt) && finite(everyHours) && everyHours > 0 ? c.lastRunAt + everyHours * 3600000 : null;
    return {
      id: c.id, name: c.name || c.id, never,
      lateNow: lateNowOf(c, mode), vs: vsYesterday(c, mode), cells,
      measured: vals.length, begun: cells.filter((x) => x.state !== 'future').length,
      done: cells.filter((x) => x.state === 'measured' || x.state === 'missing').length,
      lastBeforeToday: !never && dayStart !== null && finite(c.lastRunAt) && c.lastRunAt < dayStart,
      nextAt: next,
      worst: vals.length ? Math.max(...vals) : null,
    };
  });
  return rows.sort((a, b) => (a.never - b.never) || ((b.lateNow ?? -1) - (a.lateNow ?? -1)) || ((b.worst ?? -1) - (a.worst ?? -1))
    || String(a.name).localeCompare(String(b.name)));
}

/** The grid's column heads: the hour each window starts ("00", "02", … at 2 h). */
export function windowHeads(everyHours) {
  const n = windowsPerDay(everyHours) || 0;
  return Array.from({ length: n }, (_, i) => String((i * everyHours) % 24).padStart(2, '0'));
}

/**
 * A device's time zone: its own steady offset when it sits in another zone (`deviceTzOffset` of
 * an `other_tz` row), else its cluster's detected or set offset (`clusterTzOffset`); null for a
 * device of a cluster whose zone is not detected (no 60 % majority: nothing is corrected).
 */
export function zoneOfRow(r) {
  if (!r) return null;
  if (r.state === 'other_tz' && finite(r.deviceTzOffset)) return r.deviceTzOffset;
  return finite(r.clusterTzOffset) ? r.clusterTzOffset : null;
}
/** Whether a row is in the time-zone filter `tz` (an offset, 'none', or null for every zone). */
export function matchesZone(r, tz) {
  if (tz === null || tz === undefined) return true;
  const z = zoneOfRow(r);
  return tz === 'none' ? z === null : z === tz;
}

/**
 * Devices by time zone (the Expand panel beside the chip): one entry per zone,
 * `{key, offsetMinutes|null, devices}`, most devices first, "not detected" (key 'none') last.
 * The rows are the answer's `devices[]` in view, so the counts follow the filters.
 */
export function devicesByZone(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const own = zoneOfRow(r);
    const key = own === null ? 'none' : String(own);
    const e = by.get(key) || { key, offsetMinutes: own, devices: 0 };
    e.devices += 1;
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => (a.offsetMinutes === null) - (b.offsetMinutes === null) || b.devices - a.devices || a.offsetMinutes - b.offsetMinutes);
}

/**
 * The chip's text: the zone alone (the owner's rule: no counts in the chip, no chooser) —
 * "+05:30", the majority zone of the devices in view, or "not detected"; with a filter on,
 * "+08:00 · only these devices".
 */
/**
 * Whether the boards draw the time-zone chip at all (0.3.77): only when it can say something —
 * a device in view sits in a set or detected zone, or the zone filter is on. "not detected" is
 * what every cluster says whose logs are stamped in UTC with more than 3 min of lag, or whose
 * devices do not agree (docs/LOGDELAY.md "Time zones"): nothing is corrected, so nothing to show.
 * The zone stays in By cluster's Time zone column and Config › Edit cluster › Log time zone.
 */
export function zoneChipShown(zones, tz) {
  return (tz !== null && tz !== undefined) || (zones || []).some((z) => z && z.offsetMinutes !== null && z.offsetMinutes !== undefined);
}

export function timeZoneChipText(zones, tz, offsetText) {
  if (tz !== null && tz !== undefined) return `${tz === 'none' ? 'not detected' : offsetText(tz)} · only these devices`;
  const top = (zones || []).find((z) => z.offsetMinutes !== null);
  return top ? offsetText(top.offsetMinutes) : 'not detected';
}

/**
 * The counts the tiles show for a list of rows (the time-zone filter on): the same figures as
 * the core's `totals` — on time = under the delay line (an old `little` too), the delay band, above
 * the critical line, another time zone, silent, can't measure (a clock ahead among them).
 */
export function tileCounts(rows) {
  const t = { devices: 0, onTime: 0, delay: 0, critical: 0, otherTz: 0, silent: 0, unmeasured: 0, clockAhead: 0, cantMeasure: 0, lateBeforeSilent: 0 };
  for (const r of rows || []) {
    t.devices += 1;
    const s = r && r.state;
    if (s === 'no_delay' || s === 'little') t.onTime += 1;
    else if (s === 'delay') t.delay += 1;
    else if (s === 'critical') t.critical += 1;
    else if (s === 'other_tz') t.otherTz += 1;
    else if (s === 'silent') { t.silent += 1; if (finite(r.lateSince)) t.lateBeforeSilent += 1; }
    else if (s === 'unmeasured') t.unmeasured += 1;
    else if (s === 'clock_ahead') t.clockAhead += 1;
  }
  t.cantMeasure = t.unmeasured + t.clockAhead;
  return t;
}

/** The By cluster column: "+05:30 · 12 of 13 devices", "+00:00 · set", or "not detected · 41 % agree". Unknown says so. */
export function timeZoneCell(tz, offsetText) {
  if (!tz || typeof tz !== 'object') return '—';
  if (tz.mode === 'set') return `${tz.offset || offsetText(tz.offsetMinutes)} · set`;
  if (tz.mode === 'detected') return `${tz.offset || offsetText(tz.offsetMinutes)}${finite(tz.agree) && finite(tz.of) ? ` · ${countText(tz.agree)} of ${countText(tz.of)} devices` : ''}`;
  if (tz.mode === 'none') return `not detected${finite(tz.pct) ? ` · ${Math.round(tz.pct)} % agree` : ''}`;
  return '—';
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
  // Every measured point has its dot: a device measured once is a dot, not an empty graph.
  const dots = pts.filter((p) => finite(p.m)).map((p) => ({ x: X(p.t), y: Y(p.m), t: p.t, m: p.m }));
  return { segments, dots, scaleMax, X, Y, lo, hi };
}

/**
 * When a device was last measured, and whether that is too old to be "now": `{at, stale}`. The
 * core's `lastMeasuredMs` and `stale`; a core that does not say them: its last point, stale when
 * older than one measurement interval.
 */
export function measuredAge(res, now = Date.now(), everyHours = null) {
  const points = ((res && res.points) || []).filter((p) => p && finite(p.t) && finite(p.m)).map((p) => p.t);
  const at = res && finite(res.lastMeasuredMs) ? res.lastMeasuredMs : points.length ? Math.max(...points) : null;
  const stale = res && typeof res.stale === 'boolean' ? res.stale : at !== null && finite(everyHours) && now - at > everyHours * 3600000;
  return { at, stale };
}
/** What an open delay of a device not measured since says: never "still late". */
export const staleText = (at, now) => `late when last measured ${whenText(at, now).replace(/^today /, '')}, not measured since`;

/**
 * The time a device spent late, and what share of what: `{ms, pct, of}`. A core that says how long
 * it was measured (`measuredMs`): late of that. An older one counted an open delay up to now: with
 * the last measurement old, the periods are counted to it and no share is given.
 */
export function lateTime(res, age) {
  if (res && finite(res.measuredMs)) return { ms: finite(res.lateMeasuredMs) ? res.lateMeasuredMs : res.lateMs, pct: res.latePct, of: res.measuredMs > 0 ? `of the ${durationText(res.measuredMs)} measured` : 'measured once: no stretch of time' };
  if (age && age.stale && age.at !== null) {
    const ms = ((res && res.periods) || []).reduce((n, p) => n + Math.max(0, Math.min(finite(p.solved) ? p.solved : age.at, age.at) - p.started), 0);
    return { ms, pct: null, of: `up to ${whenText(age.at, res.now)}` };
  }
  return { ms: res && res.lateMs, pct: res && res.latePct, of: 'of the period' };
}

/**
 * The x labels under the device graph, five of them, each its own: hours on a range up to two days
 * (the day with it when it changes), the day and hour up to seven, else the day.
 */
export function axisTicks(lo, hi) {
  const H = 3600000;
  const days = (hi - lo) / (24 * H);
  let last = '';
  return [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo)).map((ms) => {
    const [, day, hm] = /^(.*) (\d\d:\d\d)$/.exec(whenText(ms, 0)) || [null, '', ''];
    const changed = day !== last; const first = last === '';
    last = day;
    if (days <= 2) return changed && !first ? `${day} ${hm}` : hm;
    return days <= 7 ? `${day} ${hm}` : day;
  });
}

/** Logs a day with what it rests on: `{text, label}`; less than a day counted is a count, not a rate. */
export function logsADay(res) {
  if (finite(res.docsPerDay)) return { text: docsText(res.docsPerDay), label: `logs a day${finite(res.docsCountedHours) ? ` · from ${Math.round(res.docsCountedHours)} h counted` : ''}` };
  if (finite(res.docsCounted) && finite(res.docsCountedHours)) return { text: countText(res.docsCounted), label: `logs in the ${Math.round(res.docsCountedHours * 10) / 10} h counted: less than a day` };
  return { text: 'unknown', label: 'logs a day' };
}

/** The fields the rows' event times came from, as the core says per row (`eventField`); else the ones configured. */
export function eventFieldsText(rows, configured) {
  const used = new Map();
  let unsaid = 0;
  for (const r of rows || []) { if (r && r.eventField) used.set(r.eventField, (used.get(r.eventField) || 0) + 1); else if (r) unsaid += 1; }
  if (used.size) {
    const list = [...used.entries()].sort((a, b) => b[1] - a[1]);
    return (list.length === 1 && !unsaid ? list[0][0] : list.map(([k, n]) => `${k} (${countText(n)} device${n === 1 ? '' : 's'})`).join(', ')) + (unsaid ? `, not said (${countText(unsaid)})` : '');
  }
  const c = Array.isArray(configured) ? configured.filter(Boolean) : [];
  return !c.length ? 'field not known' : c.length === 1 ? c[0] : `the first of ${c.join(', ')} a device’s log has`;
}

function niceCeil(v) {
  const steps = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880];
  return steps.find((s) => s >= v) || Math.ceil(v / 1440) * 1440;
}

/**
 * The band for a delay period on the graph: left/width in % of [lo,hi]. One that is not over ends at
 * `until`, the last measurement — nothing was measured after it, so nothing is shaded after it.
 */
export function periodBand(p, lo, hi, until = Date.now()) {
  const span = hi - lo || 1;
  const a = Math.max(lo, finite(p.started) ? p.started : lo);
  const b = Math.min(hi, finite(p.solved) ? p.solved : finite(p.ended) ? Math.min(p.ended, finite(p.lastMeasuredMs) ? p.lastMeasuredMs : p.ended) : finite(p.measuredUntilMs) ? p.measuredUntilMs : until);
  if (b < lo || a > hi) return null;
  return { left: ((a - lo) / span) * 100, width: Math.max(((b - a) / span) * 100, 0.6), critical: p.worstState === 'critical' };
}

/** Is this row late now (for colouring)? */
export const rowLate = (r) => !!r && isLate(r.state);

/** The finding step's pill tone: a time-zone step violet, a fix on the path blue (where to look, not a level), unknown grey. */
export const STEP_TONE = Object.freeze({ elasticsearch: 'blue', forwarder: 'blue', parser: 'blue', device_clock: 'blue', device_time_zone: 'ld-tz', device_link: 'blue', cluster: 'ld-tz', unknown: 'grey' });
export const STEP_LABEL = Object.freeze({ elasticsearch: 'Elasticsearch', forwarder: 'Forwarder', parser: 'Parser', device_clock: 'Device clock', device_time_zone: 'Device clock / parser', device_link: 'Device', cluster: 'Cluster', unknown: 'Not enough evidence' });
export const stepLabel = (f) => (f && (f.stepLabel || STEP_LABEL[f.step])) || 'Not known yet';

/**
 * A finding as the "i" popover takes it (ui/js/logdelay/fix-popover.js items): `{title, cause,
 * fix, where, count}`. One definition for a device's `fix`, a cluster's `fixes[]` and the device
 * board's `finding`. Null in, null out: no finding is "no recommendation", never a guess.
 */
export function fixItem(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    title: stepLabel(f), cause: f.why || '—', fix: f.fix || '', where: f.step || 'unknown',
    count: Array.isArray(f.devices) ? f.devices.length : undefined,
    group: Array.isArray(f.group) && f.group.length === 2 ? `${f.group[0]} ${f.group[1]}` : null,
    missing: Array.isArray(f.missing) ? f.missing : [],
  };
}
/** What a cluster's "i" says when the core has no finding for it (a device's is fix-popover.js NO_FINDING). */
export const NO_CLUSTER_FIX_TEXT = 'Nothing to fix: no finding for this cluster in the stored delay periods of the last 7 days.';

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
