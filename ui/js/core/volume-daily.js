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
 *                  cards.monthSoFar {month, value, asOf}   cards.eventBytes30 {value|null}
 *                  totals {indices, docs, priBytes, totalBytes, eventBytes, subBytes} (the
 *                  table's totals row; no row when absent). A card's figure may also be
 *                  named `basis` or `bytes`.
 *   MonthRow       {month, partial, daysWithData, liveDays, keptDays, priBytes, totalBytes,
 *                  docs, eventBytes, subBytes, avgPerDay, peakDay:{day, basis}, top:{…},
 *                  basis (the size-basis NAME), basisBytes, avgPriPerDay, peakPrimary:{day, bytes}}   VOLUME_MONTHLY may add avgPerMonth (the dashed line).
 *   VOLUME_BREAKDOWN rows [{value, docs, eventBytes|null, estPriBytes, sharePct, daysSeen,
 *                  kind?: 'missing'|'other'}], resolved, error?
 *   top.<row>      {value, share} with share a fraction (0.41 is "41 %").
 */

import { bridge } from './transport.js';
import { workerStatus } from './es.js';
import { state } from './state.js';
import { slug } from './config.js';
import { desktopVolume } from './volume-config.js';

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
 * The `volume` object for a desktop message: volume-config.js desktopVolume(), the one
 * definition (the precedence, built-in < defaults < override < config.txt, is the core's).
 * No ids, or `[null]`, means every cluster.
 */
export function volumeSettingsFor(clusterIds) {
  const raw = state.config && state.config.raw;
  const ids = (Array.isArray(clusterIds) ? clusterIds : [clusterIds]).filter(Boolean);
  const all = ((state.config && state.config.clusters) || []).map((c) => c.id);
  return desktopVolume(raw, { cluster: ids.length === 1 ? ids[0] : null, ids: ids.length ? ids : all }, slug);
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

/**
 * What a reply's `configError` means to the reader: the server's config file could not be
 * read, so the core answered from the record it already holds and collects nothing new.
 * `config_unreadable` refusals (VOLUME_RUN, VOLUME_FIELDS_CHECK) carry the same error as
 * their message and are shown as they are.
 */
export function configErrorText(err) {
  return `The server's config file could not be read: ${err}. Figures shown are the last ones recorded; nothing new is collected until it is fixed.`;
}

/** The configError of a reply, if it has one. */
export const configErrorOf = (res) => (res && res.ok !== false && res.configError ? String(res.configError) : '');

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

/** The card value the core sent, under whichever name it used for it. Picked, not computed. */
export const cardValue = (x) => (x && typeof x === 'object' ? [x.value, x.basis, x.bytes].find((v) => typeof v === 'number') ?? null
  : typeof x === 'number' ? x : null);

/** A DailyRow's figure on the basis: the core's `basis`, else the basis's own field. Picked, not computed. */
export const dayBasis = (d, basis) => (typeof d.basis === 'number' ? d.basis : (typeof d[BASIS_KEY[basis]] === 'number' ? d[BASIS_KEY[basis]] : null));

/**
 * Days to plot, oldest first: only today is left out (it is still filling up and would read
 * as a drop). A past day the core could not finish is plotted when it has a figure. One
 * definition for Indices › Summary and Play's spotlight chart.
 */
export function finishedDays(reply, today = utcDay()) {
  const basis = basisOf(reply && reply.settings);
  return ((reply && reply.days) || [])
    .filter((d) => d.day < today && (d.final !== false || dayBasis(d, basis) !== null))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** "2026-10-07" → "7 Oct". */
export const shortDay = (ymd) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${Number(m[2])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[1]) - 1]}` : String(ymd || '');
};

/** The daily chart's points (lib/charts.js lineChart), oldest first: the core's figures, picked. */
export function dailyPoints(reply, today = utcDay()) {
  const basis = basisOf(reply && reply.settings);
  return finishedDays(reply, today).map((d) => ({
    key: d.day, label: shortDay(d.day), value: dayBasis(d, basis),
    avg: typeof d.avg === 'number' ? d.avg : null, changePct: typeof d.changeVsAvgPct === 'number' ? d.changeVsAvgPct : null,
  }));
}

/**
 * A month row's value on the basis: the core's `basisBytes` (its `basis` is the basis NAME).
 * Picked, not computed; null when the core sent none.
 */
export function monthValue(m) {
  return m && typeof m.basisBytes === 'number' ? m.basisBytes : null;
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

/** The primary-size peak of a month row: the core's `peakPrimary` `{day, bytes}`; null when absent. */
export function peakOf(m) {
  const p = m && m.peakPrimary;
  if (!p || typeof p !== 'object') return null;
  return { day: p.day || null, bytes: typeof p.bytes === 'number' ? p.bytes : null };
}

export function monthlyCsvRows(clusterName, months) {
  return (months || []).map((m) => {
    const p = peakOf(m);
    return {
      cluster: clusterName, month: m.month, days_with_data: v(m.daysWithData),
      primary_bytes: m.daysWithData > 0 ? v(m.priBytes) : null,
      avg_primary_bytes_per_day: v(m.avgPriPerDay),
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

/* ------------------------- event_logsize: the one size on Reports ------------------------- */
// docs/REPORTS.md, "One size: event_logsize". Every size the Reports page shows, and every
// file it writes, is the record's `eventBytes` (the sum of the Event size field). These are
// the only functions that turn the record's days into a per-day rate, a day against its
// average, a month so far or a peak, so the tiles, tables, charts and CSVs cannot disagree.
// A day the record did not measure (`eventBytes: null`) is left out and counted as left
// out; it is never a 0.

const DAY_MS = 86400000;
/** "2026-11-03" moved by `n` days, UTC. */
export function addDays(ymd, n) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}
/** A day row's event_logsize, or null when the record did not measure it. */
export const eventBytesOf = (d) => (d && typeof d.eventBytes === 'number' && Number.isFinite(d.eventBytes) ? d.eventBytes : null);
const rowsOf = (record) => ((record && Array.isArray(record.days)) ? record.days : []).filter((d) => d && typeof d.day === 'string');

/**
 * The `days` calendar days before `before` (default: today, UTC), and the mean event_logsize
 * of those that measured it. `{value|null, measured, of, from, to}`: `measured` of `of` days
 * carried a figure. Today is never counted (it is still filling up).
 */
export function eventWindow(record, days = 7, { today = utcDay(), before = null } = {}) {
  const n = Math.max(1, Math.floor(Number(days) || 7));
  const to = addDays(before || today, -1);
  const from = addDays(to, -(n - 1));
  const vals = rowsOf(record)
    .filter((d) => d.day >= from && d.day <= to && d.day < today)
    .map(eventBytesOf).filter((v) => v !== null);
  return { value: vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null, measured: vals.length, of: n, from, to };
}

/**
 * THE per-day rate (docs/REPORTS.md): mean event_logsize over the last `days` finished days,
 * in bytes; null when none of them measured it. Overview, Capacity, Measure, Planning and
 * their CSVs all read this.
 */
export function perDayEventBytes(record, days = 7, opts = {}) {
  return eventWindow(record, days, opts).value;
}

/**
 * A day's event_logsize against the `days` days before it, in percent (the core's row rule,
 * docs/VOLUME.md "Average over N days for day d", on event_logsize). Null when the day or its
 * average is not measured, or the average is 0.
 */
export function eventVsAvgPct(record, day, days = 7, { today = utcDay() } = {}) {
  const row = rowsOf(record).find((d) => d.day === day);
  const v = eventBytesOf(row);
  if (v === null) return null;
  const avg = perDayEventBytes(record, days, { today, before: day });
  return avg ? ((v - avg) / avg) * 100 : null;
}

/** Yesterday's row: `{day, value|null, docs|null, row|null}`. */
export function eventYesterday(record, { today = utcDay() } = {}) {
  const day = addDays(today, -1);
  const row = rowsOf(record).find((d) => d.day === day) || null;
  return { day, value: eventBytesOf(row), docs: row && typeof row.docs === 'number' ? row.docs : null, row };
}

/**
 * The current month's finished days (today left out): `{value|null, docs|null, from, to,
 * days, measured}`. `days` is how many calendar days have finished this month; `measured`
 * how many of them carried event_logsize. On the 1st there is no finished day: value null.
 */
export function eventMonthSoFar(record, { today = utcDay() } = {}) {
  const from = `${today.slice(0, 7)}-01`;
  const to = addDays(today, -1);
  const days = Number(today.slice(8, 10)) - 1;
  const rows = days ? rowsOf(record).filter((d) => d.day >= from && d.day <= to) : [];
  const vals = rows.map(eventBytesOf).filter((v) => v !== null);
  const docs = rows.map((d) => (typeof d.docs === 'number' ? d.docs : null)).filter((v) => v !== null);
  return { value: vals.length ? vals.reduce((a, v) => a + v, 0) : null, docs: docs.length ? docs.reduce((a, v) => a + v, 0) : null,
    from, to, days, measured: vals.length };
}

/** The heaviest finished day in the record (or in `[from, to]`): `{day, value}` or null. */
export function eventPeak(record, { today = utcDay(), from = null, to = null } = {}) {
  let best = null;
  for (const d of rowsOf(record)) {
    if (d.day >= today || (from && d.day < from) || (to && d.day > to)) continue;
    const v = eventBytesOf(d);
    if (v !== null && (!best || v > best.value)) best = { day: d.day, value: v };
  }
  return best;
}

/**
 * The fleet's totals for the Overview tiles, from one record per cluster: Σ of each figure
 * above over the clusters that measured it, and how many did not. `vsAvgPct` is yesterday
 * against the 7 days before it, over the clusters that have both (the row rule).
 */
export function fleetEventTotals(records, { today = utcDay(), days = 7 } = {}) {
  const out = { yesterday: null, yesterdayN: 0, vsAvgPct: null, avg: null, avgN: 0,
    month: null, monthN: 0, monthFrom: `${today.slice(0, 7)}-01`, monthTo: addDays(today, -1),
    monthDays: Number(today.slice(8, 10)) - 1, notMeasured: 0, of: 0 };
  let y = 0, yBoth = 0, base = 0, a = 0, m = 0;
  for (const r of records || []) {
    out.of++;
    const yy = eventYesterday(r, { today });
    const av = perDayEventBytes(r, days, { today });
    const before = perDayEventBytes(r, days, { today, before: yy.day });
    const ms = eventMonthSoFar(r, { today });
    if (yy.value === null && av === null) out.notMeasured++;
    if (yy.value !== null) { y += yy.value; out.yesterdayN++; }
    if (yy.value !== null && before) { yBoth += yy.value; base += before; }
    if (av !== null) { a += av; out.avgN++; }
    if (ms.value !== null) { m += ms.value; out.monthN++; }
  }
  if (out.yesterdayN) out.yesterday = y;
  if (base) out.vsAvgPct = ((yBoth - base) / base) * 100;
  if (out.avgN) out.avg = a;
  if (out.monthN) out.month = m;
  return out;
}

/** Index size against event_logsize: signed difference and ratio. Null when either is unknown. */
export function sizeDifference(indexBytes, eventBytes) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(indexBytes) || !ok(eventBytes)) return { diff: null, ratio: null };
  return { diff: indexBytes - eventBytes, ratio: eventBytes > 0 ? indexBytes / eventBytes : null };
}

/** The Measure size periods (docs/REPORTS.md, board 9). */
export const MEASURE_PERIODS = [
  { id: 'last7', label: 'Last 7 days', days: 7 },
  { id: 'last30', label: 'Last 30 days', days: 30 },
  { id: 'yesterday', label: 'Yesterday', days: 1 },
];

/**
 * Measure size for one cluster's record over the last `days` finished days:
 * index size per day = mean `priBytes` of the days that report it; event_logsize per day =
 * perDayEventBytes (the one rate). `rows` is day by day, newest first. `eventField: false`
 * when no day in the period measured event_logsize (the field is not in the mapping).
 */
export function measureSize(record, days = 7, { today = utcDay() } = {}) {
  const to = addDays(today, -1);
  const from = addDays(to, -(Math.max(1, days) - 1));
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const inPeriod = rowsOf(record).filter((d) => d.day >= from && d.day <= to).sort((a, b) => (a.day < b.day ? 1 : -1));
  const pri = inPeriod.map((d) => finite(d.priBytes)).filter((v) => v !== null);
  const indexPerDay = pri.length ? pri.reduce((a, v) => a + v, 0) / pri.length : null;
  const eventPerDay = perDayEventBytes(record, days, { today });
  const rows = inPeriod.map((d) => {
    const index = finite(d.priBytes);
    const event = eventBytesOf(d);
    return { day: d.day, indices: finite(d.indices), index, event, ...sizeDifference(index, event) };
  });
  return { from, to, days: inPeriod.length, indexPerDay, eventPerDay, ...sizeDifference(indexPerDay, eventPerDay),
    eventField: rows.some((r) => r.event !== null), rows };
}

/**
 * A day row's status, as the Day by day table says it: final / today so far / "N of M shards
 * failed · asked again" / not aggregated / not measured. `kind`: ok | today | warn | na.
 */
export function dayStatus(d, { today = utcDay() } = {}) {
  if (!d) return { text: 'not measured', kind: 'na' };
  if (d.day === today) return { text: 'today so far', kind: 'today' };
  const err = d.error ? String(d.error) : '';
  if (d.final === false) {
    const m = /(\d+) of (\d+) shards failed/.exec(err);
    if (m) return { text: `${m[1]} of ${m[2]} shards failed · asked again`, kind: 'warn', title: err };
    if (/went before/.test(err)) return { text: 'indices went before final', kind: 'warn', title: err };
    if (err) return { text: `${err.split(/[:;]/)[0]}${/asked again/.test(err) ? ' · asked again' : ''}`, kind: 'warn', title: err };
    return { text: 'not aggregated yet', kind: 'warn' };
  }
  if (eventBytesOf(d) === null) return { text: 'not measured', kind: 'na', title: 'No event_logsize for this day: the field is not in the mapping.' };
  return { text: 'final', kind: 'ok' };
}

/** A month's heaviest finished day, from a record that reaches back that far: `{day, value}` or null. */
export function monthEventPeak(record, ym, { today = utcDay() } = {}) {
  return eventPeak(record, { today, from: `${ym}-01`, to: `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}` });
}

/**
 * Each breakdown row's event_logsize as a share of the sum over every row the core listed
 * (named values, "all others" and "not set"). Shares are null when nothing was measured.
 */
export function breakdownEventShares(reply) {
  const rows = (reply && reply.rows) || [];
  const total = rows.reduce((a, r) => a + (eventBytesOf(r) || 0), 0);
  return rows.map((r) => {
    const v = eventBytesOf(r);
    return { row: r, value: v, share: total > 0 && v !== null ? (v / total) * 100 : null };
  });
}

/**
 * A month's event_logsize against the month before it, in percent. `null` for the current
 * month (so far), for a month or a previous month with days missing (partial), and when
 * either side is not measured: comparing a part of a month with a whole one is not a change.
 */
export function monthVsPrevious(m, prev) {
  const full = (x) => x && x.daysWithData > 0 && x.daysWithData >= daysInMonth(x.month) && !x.partial
    && typeof x.eventBytes === 'number';
  if (!m || m.partial) return { pct: null, why: 'so far' };
  if (!full(m)) return { pct: null, why: m.daysWithData > 0 ? 'partial' : '' };
  if (!full(prev) || !prev.eventBytes) return { pct: null, why: '' };
  return { pct: ((m.eventBytes - prev.eventBytes) / prev.eventBytes) * 100, why: '' };
}

/** Calendar days in "YYYY-MM". */
export function daysInMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() : 31;
}

/* Reports' own files: every size is event_logsize (docs/REPORTS.md), the columns as on screen. */
export const REPORT_DAILY_CSV = ['cluster', 'day', 'indices', 'docs', 'event_bytes', 'event_bytes_measured',
  'change_vs_avg_pct', 'avg_days', 'status'];
export const REPORT_MONTHLY_CSV = ['cluster', 'month', 'days_with_data', 'days_in_month', 'docs', 'event_bytes',
  'peak_day', 'peak_event_bytes', 'vs_previous_pct'];

const round1 = (x) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

/** One row per day of the record, newest first, as the Day by day table shows it. */
export function reportDailyCsvRows(clusterName, record, avgDays = 7, { today = utcDay() } = {}) {
  return rowsOf(record).slice().sort((a, b) => (a.day < b.day ? 1 : -1)).map((d) => ({
    cluster: clusterName, day: d.day, indices: v(d.indices), docs: v(d.docs),
    event_bytes: eventBytesOf(d), event_bytes_measured: eventBytesOf(d) === null ? 'false' : 'true',
    change_vs_avg_pct: round1(eventVsAvgPct(record, d.day, avgDays, { today })), avg_days: avgDays,
    status: dayStatus(d, { today }).text,
  }));
}

/**
 * One row per month, newest first, as Month by month shows it. `peaks` is a record that
 * reaches back over the months (VOLUME_DAILY with enough days); without it the peak is empty.
 */
export function reportMonthlyCsvRows(clusterName, months, peaks = null, { today = utcDay() } = {}) {
  const list = (months || []).slice().sort((a, b) => (a.month < b.month ? -1 : 1));
  return list.map((m, i) => {
    const has = m.daysWithData > 0;
    const p = has && peaks ? monthEventPeak(peaks, m.month, { today }) : null;
    return {
      cluster: clusterName, month: m.month, days_with_data: v(m.daysWithData) ?? 0, days_in_month: daysInMonth(m.month),
      docs: has ? v(m.docs) : null, event_bytes: has && typeof m.eventBytes === 'number' ? m.eventBytes : null,
      peak_day: p ? p.day : null, peak_event_bytes: p ? p.value : null,
      vs_previous_pct: round1(monthVsPrevious(m, list[i - 1]).pct),
    };
  }).reverse();
}

/** The all-cluster monthly CSV on event_logsize: one row per cluster, a column per month. */
export function monthlyAllEventCsvRows(reply) {
  const clusters = (reply && reply.clusters) || [];
  const months = monthsAcross(clusters);
  return {
    headers: ['cluster', ...months],
    rows: clusters.map((c) => {
      const o = { cluster: c.name || c.clusterId };
      const by = new Map((c.months || []).map((m) => [m.month, m]));
      for (const ym of months) {
        const m = by.get(ym);
        o[ym] = m && m.daysWithData > 0 && typeof m.eventBytes === 'number' ? m.eventBytes : null;
      }
      return o;
    }),
  };
}
