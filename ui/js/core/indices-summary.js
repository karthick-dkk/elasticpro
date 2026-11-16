/**
 * Indices › Summary (0.3.71), the arithmetic: which days a choice shows, the averages the tiles,
 * the line and the CSV read, a tag1 value's share of a day, and how the chart's dates are
 * labelled. Pure — no DOM, no request — so tools/unit holds every rule.
 *
 * The figures come from the daily volume record the core already keeps (docs/VOLUME.md):
 * a day's size is the core's own `basis` (the configured `sizeBasis`, primary size by default:
 * core/volume-daily.js dayBasis), and a day's documents per tag1 value come from the core's
 * breakdown of that one day (VOLUME_BREAKDOWN, from = to = the day). Nothing here measures
 * anything again; a day the record does not have is unknown, never a 0.
 */

import { dayBasis, basisOf, addDays, utcDay, dayStatus } from './volume-daily.js';

/** The day buttons, each a window that always ends today. */
export const DAY_CHOICES = [15, 30, 60, 90];
export const DEFAULT_DAYS = 15;
/** The averaging tiles, in days. */
export const AVG_TILES = [7, 30, 60];
/** The chart's average line: each day against the 7 days before it. */
export const LINE_AVG_DAYS = 7;
/** Named tag1 values shown as chips and table columns before "+ N more". */
export const TOP_VALUES = 6;
/**
 * Days of record asked for: the widest window (90 days, today included), and the line's
 * 7 days before its first bar. The 60-day tile fits inside.
 */
export const RECORD_DAYS = 100;

/** The `days` calendar days ending today (UTC, as the core counts days), oldest first. */
export function dayWindow(days, today = utcDay()) {
  const n = DAY_CHOICES.includes(Number(days)) ? Number(days) : DEFAULT_DAYS;
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

/** `{day → value}` from points `[{day, value}]`; a null value is "not recorded". */
const byDay = (points) => {
  const m = new Map();
  for (const p of points || []) if (p && typeof p.day === 'string') m.set(p.day, typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : null);
  return m;
};

/**
 * THE average per day: the mean of the `days` calendar days before `before` (default today;
 * `before` itself left out, today never counted: it is still filling up) that carry a figure.
 * A day missing from the record, or one whose size is not measured, is left out and counted
 * as left out: `{value|null, measured, of, from, to}` says `measured` of `of` days. The tiles
 * (7, 30, 60 days), the chart's line, its tooltip and the CSV all read this; it is the core's
 * own rule (docs/VOLUME.md "Average over N days for day d", "Cards").
 */
export function avgPerDay(points, days, { today = utcDay(), before = null } = {}) {
  const n = Math.max(1, Math.floor(Number(days) || 1));
  const to = addDays(before || today, -1);
  const from = addDays(to, -(n - 1));
  const m = byDay(points);
  const vals = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = d < today && m.has(d) ? m.get(d) : null;
    if (v !== null) vals.push(v);
  }
  return { value: vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null, measured: vals.length, of: n, from, to };
}

/** The record's days as points on the size basis, oldest first: `[{day, value|null, row}]`. */
export function basisPoints(record) {
  const basis = basisOf(record && record.settings);
  return ((record && record.days) || []).filter((d) => d && typeof d.day === 'string')
    .map((d) => ({ day: d.day, value: dayBasis(d, basis), row: d }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * A tag1 value's size on one day: its share of the day's documents × the day's size
 * (docs/VOLUME.md "Primary size per value", the core's breakdown rule, for one day and on the
 * size basis — on primary size it is the core's `estPriBytes` for that day). Null when any
 * part is unknown or the day has no documents: never a 0 made up from a gap.
 */
export function tagShareBytes(valueDocs, dayDocs, daySize) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!ok(valueDocs) || !ok(dayDocs) || !ok(daySize) || dayDocs <= 0) return null;
  return (valueDocs / dayDocs) * daySize;
}

/**
 * A value's documents in one day's breakdown (VOLUME_BREAKDOWN, from = to = the day): its row's
 * `docs`; 0 when the day lists no such value and its "all others" is empty (the day kept every
 * value it had); null when it may be folded into "all others" (the record keeps the top values
 * per day only) or the day has no breakdown — unknown, not zero.
 */
export function valueDocsOn(reply, value) {
  if (!reply || reply.error || !Array.isArray(reply.rows)) return null;
  const row = reply.rows.find((r) => r && (r.kind === 'value' || !r.kind) && String(r.value) === String(value));
  if (row) return typeof row.docs === 'number' ? row.docs : null;
  const other = reply.rows.find((r) => r && r.kind === 'other');
  return other && Number(other.docs) === 0 ? 0 : null;
}

/** The documents of every value a day's breakdown does not name among `named`: the rest of its rows. */
export function restDocsOn(reply, named) {
  if (!reply || reply.error || !Array.isArray(reply.rows)) return null;
  const set = new Set((named || []).map(String));
  let sum = 0;
  for (const r of reply.rows) {
    if (!r || typeof r.docs !== 'number') continue;
    if ((r.kind === 'value' || !r.kind) && set.has(String(r.value))) continue;
    sum += r.docs;
  }
  return sum;
}

/**
 * The tag1 values of the window, most documents first, from the core's breakdown of the whole
 * window (its ranking, not one made here): `{values:[name], error|null}`. "(not set)" and
 * "all others" are not values one can choose.
 */
export function rankedValues(reply) {
  if (!reply) return { values: [], error: null };
  if (reply.error) return { values: [], error: String(reply.error) };
  const values = (reply.rows || []).filter((r) => r && (r.kind === 'value' || !r.kind) && r.value !== null && r.value !== undefined && Number(r.docs) > 0)
    .map((r) => String(r.value));
  return { values, error: null };
}

/**
 * The status of a day on the size basis: final / today so far / not measured, or what the
 * record says went wrong with a day that is not final (core/volume-daily.js dayStatus words).
 * `kind`: ok | today | warn | na.
 */
export function sizeDayStatus(row, basis, { today = utcDay() } = {}) {
  if (!row) return { text: 'not measured', kind: 'na', title: 'The record has no figure for this day.' };
  if (row.day === today) return { text: 'today so far', kind: 'today' };
  if (row.final === false) {
    const s = dayStatus(row, { today });
    if (s.kind === 'warn') return s;
  }
  if (dayBasis(row, basis) === null) return { text: 'not measured', kind: 'na', title: 'Index size is not measured for this day: its indices are split into days by the time field, and Elasticsearch reports size per index.' };
  return { text: 'final', kind: 'ok' };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11-03" → "03 Nov", the chart's date. */
export function dayMonth(ymd) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${m[2]} ${MON[Number(m[1]) - 1]}` : String(ymd || '');
}

/**
 * The months under the axis, once each: `[{ym, label: "November 2026", first, last}]` with the
 * first and last index of the days that fall in it. Two months when the range spans two.
 */
export function monthSpans(days) {
  const out = [];
  (days || []).forEach((d, i) => {
    const ym = String(d).slice(0, 7);
    const cur = out[out.length - 1];
    if (cur && cur.ym === ym) cur.last = i;
    else out.push({ ym, label: `${MONTH[Number(ym.slice(5, 7)) - 1] || ym} ${ym.slice(0, 4)}`, first: i, last: i });
  });
  return out;
}

/**
 * Every how-many-th bar gets its date so no two collide: `n` bars across `plotWidth`, a date
 * taking `labelWidth` (both in the same units). 1 when every bar has room for its own.
 */
export function labelStep(n, plotWidth, labelWidth = 46) {
  if (!(n > 0) || !(plotWidth > 0)) return 1;
  return Math.max(1, Math.ceil((n * labelWidth) / plotWidth));
}

/**
 * Which bars carry a date: every `step`-th counted back from the newest, so today (the last
 * bar) always has its own. Indices, oldest first.
 */
export function labelledBars(n, step) {
  const s = Math.max(1, Math.floor(step) || 1);
  const out = [];
  for (let i = 0; i < n; i++) if ((n - 1 - i) % s === 0) out.push(i);
  return out;
}

/**
 * The y axis for byte sizes: four even steps of a round size in the unit the top reads in
 * (1024-based, as lib/fmt.js bytes() writes them): `{max, step}` with max = 4 × step ≥ `top`.
 * 3.53 TB → steps of 1 TB up to 4 TB, not 902 GB, 1.76 TB …
 */
export function niceScale(top) {
  const t = typeof top === 'number' && Number.isFinite(top) && top > 0 ? top : 1;
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(t) / Math.log(1024)));
  const v = t / unit;
  const mag = 10 ** Math.floor(Math.log10(v / 4));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s * 4 >= v) * unit;
  return { max: step * 4, step };
}

/** The CSV's columns before the tag1 ones. */
export const SUMMARY_CSV = ['cluster', 'day', 'status', 'indices', 'docs', 'size_basis', 'size_bytes', 'avg_7d_bytes'];
