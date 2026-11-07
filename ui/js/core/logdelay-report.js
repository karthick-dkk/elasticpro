/**
 * Reports › Log delay (0.3.57): the messages, the routes, and the arithmetic the pages draw
 * with. docs/LOGDELAY.md is the contract; this file is the one place the UI reads its field
 * names, and it touches no DOM, so tools/unit tests every figure here.
 *
 *   #/reports/log-delay                          the fleet (Main board)
 *   #/reports/log-delay/cluster/<id>             one cluster (Cluster board)
 *   #/reports/log-delay/device/<cluster>/<dev>   one device (Device board)
 *   #/reports/log-delay/fixes                    recommended fixes (Fix board)
 *
 * The mail's "Open the full report" link is <url>/#/reports/log-delay, so the section id is
 * `log-delay`.
 */

import { bridge } from './transport.js';
import { STATE_LABEL, isLate } from './delay-levels.js';

export const LD_SECTION = 'log-delay';

/** Chart colours (owner's rule): light green, blue, pink, orange — never red with yellow. */
export const LD_COLOURS = Object.freeze({ green: '#bfe6bf', blue: '#a9c8f0', pink: '#f2a7c3', orange: '#f5b77a', line: '#f07c1b' });

/* --------------------------------- the messages --------------------------------- */

/** A LOGDELAY_* reply that says the core does not know the message: an older core. */
export function ldUnsupported(res) {
  return !!res && res.ok === false && (res.kind === 'bad_message' || /unknown message type/i.test(String(res.message || '')));
}

async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (!res) return { ok: false, kind: 'worker_error', message: 'the core did not answer' };
  if (ldUnsupported(res)) return { ...res, unsupported: true, message: 'This server has no log delay report yet (needs ElasticPro 0.3.57).' };
  return res;
}

/** Only the inputs the contract names, and only those given. */
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '').map((k) => [k, o[k]]));
const ids = (o) => (Array.isArray(o.clusterIds) && o.clusterIds.length ? { clusterIds: o.clusterIds } : {});

export const ldSummary = (o = {}) => send({ type: 'LOGDELAY_SUMMARY', ...pick(o, ['from', 'to', 'days', 'maxDevices']), ...ids(o) });
export const ldCluster = (o) => send({ type: 'LOGDELAY_CLUSTER', clusterId: o.clusterId, ...pick(o, ['from', 'to', 'days']) });
export const ldDevice = (o) => send({ type: 'LOGDELAY_DEVICE', clusterId: o.clusterId, device: o.device, ...pick(o, ['from', 'to', 'days']) });
export const ldSearch = (o = {}) => send({ type: 'LOGDELAY_SEARCH', ...pick(o, ['name', 'field', 'value', 'from', 'to', 'max']), ...ids(o) });
export const ldFixes = (o = {}) => send({ type: 'LOGDELAY_FIXES', ...pick(o, ['from', 'to']), ...ids(o) });
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

/**
 * Which log delay view a hash names: `{view, clusterId, device}`. Anything else under the
 * section is the fleet.
 */
export function ldRoute(hash) {
  const path = String(hash || '').replace(/^#\/?/, '').split('?')[0];
  const parts = path.split('/');
  if (parts[0] !== 'reports' || parts[1] !== LD_SECTION) return { view: 'fleet', clusterId: null, device: null };
  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch (_) { return s || ''; } };
  const [, , kind, a, ...rest] = parts;
  if (kind === 'cluster' && a) return { view: 'cluster', clusterId: dec(a), device: null };
  if (kind === 'device' && a && rest.length) return { view: 'device', clusterId: dec(a), device: dec(rest.join('/')) };
  if (kind === 'fixes') return { view: 'fixes', clusterId: a ? dec(a) : null, device: null };
  return { view: 'fleet', clusterId: null, device: null };
}

const enc = encodeURIComponent;
/** The hash for a view. */
export function ldHash(view, clusterId, device) {
  const base = `#/reports/${LD_SECTION}`;
  if (view === 'cluster' && clusterId) return `${base}/cluster/${enc(clusterId)}`;
  if (view === 'device' && clusterId && device) return `${base}/device/${enc(clusterId)}/${enc(device)}`;
  if (view === 'fixes') return clusterId ? `${base}/fixes/${enc(clusterId)}` : `${base}/fixes`;
  return base;
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
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 11:15" or "3 Nov 22:00"; `seconds` adds :ss. Unknown → '—'. */
export function whenText(ms, now = Date.now(), { seconds = false } = {}) {
  if (!finite(ms) || ms <= 0) return '—';
  const d = new Date(ms); const n = new Date(now);
  const t = seconds ? `${hhmm(d)}:${String(d.getSeconds()).padStart(2, '0')}` : hhmm(d);
  return sameDay(d, n) ? `today ${t}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${t}`;
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
export const stateText = (s) => STATE_LABEL[s] || (s ? String(s) : 'unknown');

/** The pill tone per state: pink critical, blue delayed, green on time, orange clock ahead, grey unknown. */
export const STATE_TONE = Object.freeze({
  critical: 'ld-pink', delay: 'ld-blue', little: 'ld-green', no_delay: 'ld-green', clock_ahead: 'ld-orange', silent: 'grey', unmeasured: 'grey',
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
export const STEP_TONE = Object.freeze({ elasticsearch: 'ld-pink', forwarder: 'ld-blue', parser: 'ld-orange', device_clock: 'ld-green', device_link: 'ld-blue', unknown: 'grey' });
export const STEP_LABEL = Object.freeze({ elasticsearch: 'Elasticsearch', forwarder: 'Forwarder', parser: 'Parser', device_clock: 'Device clock', device_link: 'Device', unknown: 'Not enough evidence' });
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
