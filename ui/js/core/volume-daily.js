/**
 * The daily volume record (0.3.45): the core's messages, and the files made from them.
 *
 * docs/VOLUME.md is the contract. The core collects every day's figures and works out
 * every derived one — day totals, averages, change against the average, the cards, the
 * months, the breakdown estimates. This module asks for them and turns the answers into
 * CSV rows; it never works a figure out again (CLAUDE.md, "one definition per quantity").
 * Anything the reply does not carry is left empty here, not rebuilt.
 *
 * Desktop has no server config file, so each message carries the `volume` settings the
 * UI read from the clusters file. Hosted reads its own file and gets nothing extra.
 *
 * An older core does not know these messages. That is reported as `unsupported`, which
 * the pages show as "this server does not keep a daily record yet (needs 0.3.45)": never
 * a crash, and never a page of zeros.
 *
 * The reply fields the UI reads, where docs/VOLUME.md leaves the name open (anything not
 * sent is shown as unknown, never filled in here):
 *
 *   VOLUME_DAILY   cards.yesterday {day, value, changeVsAvgPct}   cards.average {days, value}
 *                  cards.monthSoFar {month, value, days}   cards.eventBytes30 {value|null}
 *                  totals {indices, docs, priBytes, totalBytes, eventBytes, subBytes} (the
 *                  table's totals row; no row when absent). A card's figure may also be
 *                  named `basis` or `bytes`.
 *   MonthRow       {month, partial, daysWithData, liveDays, keptDays, priBytes, totalBytes,
 *                  docs, eventBytes, subBytes, avgPerDay, peakDay:{day, basis}, top:{…},
 *                  basis?}   VOLUME_MONTHLY may add avgPerMonth (the dashed line).
 *   VOLUME_BREAKDOWN rows [{value, docs, eventBytes|null, estPriBytes, sharePct, daysSeen,
 *                  kind?: 'missing'|'other'}], resolved, error?
 *   top.<row>      {value, share} with share a fraction (0.41 is "41 %").
 */

import { bridge } from './transport.js';
import { workerStatus } from './es.js';
import { state } from './state.js';
import { slug } from './config.js';

/* ------------------------------- the transport ------------------------------- */

/** The version that first keeps a daily record, for the "needs" line. */
export const NEEDS_VERSION = '0.3.45';

/**
 * Whether a reply says the core does not have this message at all.
 *
 * Two shapes: `bad_message` ("Unknown message type") from any core that knows nothing of
 * it, and, on an older hosted core, `forbidden` for anybody below admin — there an unknown
 * type needs admin, so a user asking for VOLUME_DAILY is told the user role cannot. A
 * guest refused is a real refusal and stays one.
 */
export function isUnsupported(res, type) {
  if (!res || res.ok) return false;
  if (res.kind === 'bad_message' && /unknown message/i.test(String(res.message || ''))) return true;
  return res.kind === 'forbidden' && res.role && res.role !== 'guest' && type !== 'VOLUME_LAYOUT_SET'
    && String(res.message || '').startsWith(`${type} is not available`);
}

/** Which edition the core is, asked once: `volume` settings go with desktop messages only. */
let edition = null;
export async function coreEdition() {
  if (edition) return edition;
  try {
    const st = await workerStatus();
    edition = (st && st.edition) || 'portable';
  } catch (_) { return 'portable'; }
  return edition;
}
/** Hosted is the one edition with a timer and a config file of its own. */
export const isHosted = async () => (await coreEdition()) === 'hosted';

/**
 * The clusters-file entry behind a cluster id, by the same id rule config.js normalize()
 * uses (`_id`, else the name's slug, with a position suffix on a collision).
 */
function rawCluster(raw, clusterId) {
  const list = (raw && (raw.clusters || raw.hosts)) || [];
  const seen = new Set();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || !c.url) continue;
    let name = c.name;
    if (!name) { try { name = new URL(c.url).host; } catch (_) { name = String(c.url); } }
    let id = c._id ? String(c._id) : slug(name);
    const pos = Number.isInteger(c._index) ? c._index : i;
    while (seen.has(id) && !c._id) id = `${id}-${pos}`;
    seen.add(id);
    if (id === clusterId) return c;
  }
  return null;
}

/**
 * The `volume` object for a desktop message: `{defaults, cluster}` straight from the file,
 * unmerged — the precedence (built-in < defaults < override < config.txt) is the core's.
 * For a message about several clusters, `clusters` maps each id to its own override.
 */
export function volumeSettingsFor(clusterIds) {
  const raw = state.config && state.config.raw;
  if (!raw) return null;
  const defaults = (raw.defaults && raw.defaults.volume) || null;
  const ids = Array.isArray(clusterIds) ? clusterIds : [clusterIds];
  const own = (id) => { const rc = rawCluster(raw, id); return (rc && rc.volume) || null; };
  if (ids.length === 1 && ids[0]) return { defaults, cluster: own(ids[0]) };
  const clusters = {};
  for (const id of (ids[0] ? ids : (state.config.clusters || []).map((c) => c.id))) {
    const o = own(id);
    if (o) clusters[id] = o;
  }
  return { defaults, cluster: null, clusters };
}

async function send(msg, clusterIds) {
  const out = { ...msg };
  if (!(await isHosted())) {
    const v = volumeSettingsFor(clusterIds);
    if (v) out.volume = v;
  }
  const res = await bridge(out);
  if (isUnsupported(res, msg.type)) return { ok: false, unsupported: true, kind: 'unsupported', message: res.message };
  return res || { ok: false, kind: 'worker_error', message: 'no answer' };
}

/** `{settings, status, cards, days:[DailyRow], sources, skipped}` */
export const volumeDaily = (clusterId, { days, avgDays, source } = {}) =>
  send({ type: 'VOLUME_DAILY', clusterId, days, avgDays, source: source || undefined }, clusterId);
/** `{status, months:[MonthRow]}` */
export const volumeMonthly = (clusterId, { months } = {}) =>
  send({ type: 'VOLUME_MONTHLY', clusterId, months }, clusterId);
/** `{field, resolved, rows, totals}` */
export const volumeBreakdown = (clusterId, { field, from, to, top }) =>
  send({ type: 'VOLUME_BREAKDOWN', clusterId, field, from, to, top }, clusterId);
/** `{clusters:[{clusterId, name, months:[MonthRow]}]}` */
export const volumeMonthlyAll = ({ months } = {}) =>
  send({ type: 'VOLUME_MONTHLY_ALL', months }, null);
/** `{started, already, tooSoon}`: ids, each. */
export const volumeRun = (clusterIds) =>
  send({ type: 'VOLUME_RUN', clusterIds }, clusterIds);
/** `{layouts:{daily, monthly}}` — the column layout everyone shares. */
export const volumeLayoutGet = () => send({ type: 'VOLUME_LAYOUT_GET' }, null);
/** Operator and up. `table`: 'daily' | 'monthly'. */
export const volumeLayoutSet = (table, layout) => send({ type: 'VOLUME_LAYOUT_SET', table, layout }, null);

/* ------------------------------ reading a reply ------------------------------ */

/** A time the core sent, as ms: epoch ms or an ISO string. null when there is none. */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(n) ? n : null;
}

/** "14:02", local time, for "as of". */
export function hhmm(v) {
  const ms = toMs(v);
  if (ms === null) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Today's date as the core counts days: UTC, `YYYY-MM-DD`. */
export function utcDay(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

/**
 * Whether the desktop should ask for a run on opening Summary: the last run is older than
 * the most recent `collectAt` that has passed (today's once it is past, else yesterday's),
 * or there has never been one. Local time, as the core's `collectAt` is.
 */
export function collectDue(status, now = Date.now()) {
  if (!status || status.running) return false;
  const last = toMs(status.lastRunAt);
  if (last === null) return true;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(status.collectAt || '06:00').trim());
  const d = new Date(now);
  d.setHours(m ? Number(m[1]) : 6, m ? Number(m[2]) : 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return last < d.getTime();
}

/** The figure the graph and the cards plot, as the core named it (`settings.sizeBasis`). */
export const BASIS_LABEL = { primary: 'Primary size', total: 'Total size', eventSize: 'Event bytes' };
export const BASIS_KEY = { primary: 'priBytes', total: 'totalBytes', eventSize: 'eventBytes' };
export const basisOf = (settings) => (settings && BASIS_LABEL[settings.sizeBasis] ? settings.sizeBasis : 'primary');

/**
 * A month row's value on the basis: the core's own `basis` when it sends one, else the
 * sum it sends for that basis. Picked, not computed.
 */
export function monthValue(m, basis) {
  if (!m) return null;
  if (typeof m.basis === 'number') return m.basis;
  const v = m[BASIS_KEY[basis] || 'priBytes'];
  return typeof v === 'number' && (m.daysWithData || 0) > 0 ? v : null;
}

/**
 * Where a month's days came from, in words. `first` is the earliest month that has any
 * record, so an empty month before it reads differently from a gap after it.
 */
export function fromText(m, first) {
  if (!m || !(m.daysWithData > 0)) return first && m && m.month < first ? 'before the record began' : 'no record';
  const kept = Number(m.keptDays) || 0, live = Number(m.liveDays) || 0;
  if (kept && live) return `${kept} days kept record, ${live} live`;
  return kept ? 'kept record' : 'live indices';
}

/** "2026-10" → "Oct 2026". */
export function monthName(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return String(ym || '');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1]} ${m[1]}`;
}

/** The last `n` calendar months ending with the current one (UTC), oldest first: "YYYY-MM". */
export function lastMonths(n, now = Date.now()) {
  const d = new Date(now);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(x.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * The periods a breakdown can cover, as day ranges (UTC dates, inclusive). Calendar only:
 * which days, not what they hold.
 */
export function breakdownPeriods(now = Date.now(), previous = 12) {
  const day = (ms) => utcDay(ms);
  const DAY = 86400000;
  const today = day(now);
  const out = [
    { id: 'month', label: 'Current month so far', from: `${today.slice(0, 7)}-01`, to: today },
    { id: 'yesterday', label: 'Yesterday', from: day(now - DAY), to: day(now - DAY) },
    { id: 'last7', label: 'Last 7 days', from: day(now - 7 * DAY), to: day(now - DAY) },
  ];
  const d = new Date(now);
  for (let i = 1; i <= previous; i++) {
    const a = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    const b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 0));
    const ym = a.toISOString().slice(0, 7);
    out.push({ id: `m:${ym}`, label: monthName(ym), from: day(a.getTime()), to: day(b.getTime()) });
  }
  return out;
}

/* ----------------------------------- CSV ------------------------------------ */
// Column names exactly as docs/VOLUME.md lists them. A null stays empty: "not measured"
// is not a 0 in a spreadsheet either.

export const DAILY_CSV = ['cluster', 'day', 'indices', 'docs', 'primary_bytes', 'total_bytes', 'event_bytes',
  'event_bytes_measured', 'sub_bytes', 'change_vs_avg_pct', 'avg_days'];
export const MONTHLY_CSV = ['cluster', 'month', 'days_with_data', 'primary_bytes', 'avg_primary_bytes_per_day',
  'peak_day', 'peak_primary_bytes', 'docs', 'event_bytes', 'from_kept_record_days'];
export const BREAKDOWN_CSV = ['cluster', 'field', 'field_resolved', 'value', 'period_from', 'period_to', 'docs',
  'event_bytes', 'primary_bytes_estimated', 'share_pct', 'days_seen'];

const v = (x) => (x === null || x === undefined ? null : x);

/** One row per day, as the reply has them (the core's order). */
export function dailyCsvRows(clusterName, reply, avgDays) {
  return ((reply && reply.days) || []).map((d) => ({
    cluster: clusterName, day: d.day, indices: v(d.indices), docs: v(d.docs),
    primary_bytes: v(d.priBytes), total_bytes: v(d.totalBytes), event_bytes: v(d.eventBytes),
    event_bytes_measured: d.eventBytes === null || d.eventBytes === undefined ? 'false' : 'true',
    sub_bytes: v(d.subBytes),
    change_vs_avg_pct: typeof d.changeVsAvgPct === 'number' ? Math.round(d.changeVsAvgPct * 10) / 10 : null,
    avg_days: avgDays,
  }));
}

/** The peak day of a month row: `{day, basis}` (or the bytes under `bytes`/`priBytes`). */
export function peakOf(m) {
  const p = m && m.peakDay;
  if (!p) return null;
  if (typeof p === 'string') return { day: p, bytes: typeof m.peakBytes === 'number' ? m.peakBytes : null };
  const bytes = [p.basis, p.bytes, p.priBytes].find((x) => typeof x === 'number');
  return { day: p.day || null, bytes: bytes === undefined ? null : bytes };
}

export function monthlyCsvRows(clusterName, months) {
  return (months || []).map((m) => {
    const p = peakOf(m);
    return {
      cluster: clusterName, month: m.month, days_with_data: v(m.daysWithData),
      primary_bytes: m.daysWithData > 0 ? v(m.priBytes) : null,
      avg_primary_bytes_per_day: v(m.avgPerDay),
      peak_day: p ? p.day : null, peak_primary_bytes: p ? p.bytes : null,
      docs: v(m.docs), event_bytes: v(m.eventBytes), from_kept_record_days: v(m.keptDays),
    };
  });
}

/** The label a breakdown row is shown with: the value, or what its kind means. */
export function breakdownLabel(r) {
  if (r && (r.kind === 'missing' || r.missing)) return '(not set)';
  if (r && (r.kind === 'other' || r.other)) return 'all others';
  return r ? String(r.value ?? '') : '';
}

export function breakdownCsvRows(clusterName, reply, period) {
  return ((reply && reply.rows) || []).map((r) => ({
    cluster: clusterName, field: reply.field, field_resolved: reply.resolved || null, value: breakdownLabel(r),
    period_from: period.from, period_to: period.to, docs: v(r.docs), event_bytes: v(r.eventBytes),
    primary_bytes_estimated: v(r.estPriBytes), share_pct: typeof r.sharePct === 'number' ? Math.round(r.sharePct * 10) / 10 : null,
    days_seen: v(r.daysSeen),
  }));
}

/** Every month any cluster has, oldest first: the columns of the all-cluster view. */
export function monthsAcross(clusters) {
  const set = new Set();
  for (const c of clusters || []) for (const m of c.months || []) if (m && m.month) set.add(m.month);
  return [...set].sort();
}

/** One row per cluster, a column per month of primary bytes; empty where there is no record. */
export function monthlyAllCsvRows(reply) {
  const clusters = (reply && reply.clusters) || [];
  const months = monthsAcross(clusters);
  return {
    headers: ['cluster', ...months],
    rows: clusters.map((c) => {
      const o = { cluster: c.name || c.clusterId };
      const by = new Map((c.months || []).map((m) => [m.month, m]));
      for (const ym of months) {
        const m = by.get(ym);
        o[ym] = m && m.daysWithData > 0 && typeof m.priBytes === 'number' ? m.priBytes : null;
      }
      return o;
    }),
  };
}
