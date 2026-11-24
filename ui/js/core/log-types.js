/**
 * Log types (0.3.90; docs/LOGDELAY.md): the words and the arithmetic of a device's log types — one
 * definition for the boards, the device graph, Live, the exports and the alert. No DOM.
 *
 * A log type is the value of one ECS field, `log_type`, the same on every cluster (the owner,
 * 2026-11-24): no setting. A document without it is the type "(no log type)" (`noType`); a real
 * value that reads exactly that is another type, so the two are told apart by `typeKey`, never by
 * the text. Log types come from documents: untrusted text, always drawn as text nodes.
 *
 * A series is one device's one log type. `series[]` is LOGDELAY_DEVICE's, worst first.
 */

import { isLate, isOnTime } from './delay-levels.js';
import { minutesText, whenText, stateText, deviceGraph } from './logdelay-report.js';

export const LOG_TYPE_FIELD = 'log_type';
export const NO_LOG_TYPE = '(no log type)';
/** The most lines the device graph draws at once; the rest wait behind "+N". */
export const LINES_MAX = 6;
/**
 * The lines' colours: the categorical chart tokens (blue, orange, pink, green, teal, a deep blue) —
 * what a series is, never how bad it is: red and yellow are the states'. A line keeps its slot while
 * it is drawn. The last two are dashed too, so six lines never rest on the hue alone.
 */
export const LINE_COLOURS = Object.freeze(['var(--series-1)', 'var(--series-2)', 'var(--series-4)', 'var(--series-3)', 'var(--series-6)', 'color-mix(in srgb, var(--series-1) 45%, var(--text-primary))']);
export const LINE_DASHES = Object.freeze(['', '', '', '', '6 3', '2 3']);
export const lineColour = (slot) => LINE_COLOURS[slot % LINE_COLOURS.length];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** What tells two log types apart: the documents without the field are never a value of the same text. */
export const typeKey = (s) => `${s && s.noType ? 'none' : 'type'}:${s && s.logType !== undefined && s.logType !== null ? s.logType : ''}`;
/** A log type as it is written: "(no log type)", or its value — quoted when the value itself reads "(no log type)" or is blank. */
export function typeLabel(s) {
  if (s && s.noType) return NO_LOG_TYPE;
  const v = String(s && s.logType !== undefined && s.logType !== null ? s.logType : '');
  return v === NO_LOG_TYPE || v.trim() === '' ? `“${v}”` : v;
}

/** "threat", "threat, audit", "threat, audit +2". */
export function namesText(names, max = 3) {
  const list = (names || []).map(String);
  return list.length > max ? `${list.slice(0, max).join(', ')} +${list.length - max}` : list.join(', ');
}

/* -------------------------------- a device row's `types` -------------------------------- */

/** Whether a core that measures log types wrote this row (its `types` may still be null: not measured). */
export const saysTypes = (row) => !!row && row.types !== undefined;
export const hasTypes = (row) => !!row && !!row.types && finite(row.types.total);
const totalText = (t) => `${t.total}${t.truncated ? '+' : ''}`;

/** The LOG TYPES cell: "1 of 3 late: threat", "0 of 3 late", "3, none measured"; "—" when not measured with log types. */
export function typesText(t) {
  if (!t || !finite(t.total)) return '—';
  if (!t.total) return 'none read';
  if (t.measured === 0) return `${totalText(t)}, none measured`;
  const late = t.late || 0;
  const part = !late && finite(t.measured) && t.measured < t.total ? ` · ${t.measured} measured` : '';
  return `${late} of ${totalText(t)} late${late ? `: ${namesText(t.lateNames, 2)}` : ''}${part}`;
}
/** The cell's title: the rest — every late name, how many were measured, that more were not read. */
export function typesTitle(t) {
  if (!t || !finite(t.total)) return 'not measured with log types: log_type is not in the mapping, or not read yet';
  return [t.late ? `late: ${(t.lateNames || []).join(', ')}` : '', finite(t.measured) && t.measured < t.total ? `${t.measured} of ${totalText(t)} log types measured in the last run` : '',
    t.truncated ? `${t.total} log types read; the device has more, not read` : ''].filter(Boolean).join(' · ') || `${totalText(t)} log types`;
}

/* -------------------------------- one device's series -------------------------------- */

/** A series late now: measured in the last run and late. One not measured since is "late when last measured", not late. */
export const seriesLate = (s) => !!s && isLate(s.state) && !s.stale;
/** A series' delay now for its chip: "46 min", "46 min at 10:05", "no logs since 12:40", "can't measure". Never 0 for unknown. */
export function seriesNow(s, now = Date.now()) {
  if (!s) return '—';
  const at = (ms) => whenText(ms, now).replace(/^today /, '');
  if (s.state === 'silent') return finite(s.lastArrival) ? `no logs since ${at(s.lastArrival)}` : 'no logs';
  if (!finite(s.delayMinutes)) return s.state === 'unmeasured' ? "can't measure" : '—';
  return s.stale && finite(s.lastMeasuredMs) ? `${minutesText(s.delayMinutes)} at ${at(s.lastMeasuredMs)}` : minutesText(s.delayMinutes);
}
/** A series' state in words: the core's when it says it; one not measured since says when it last was, never "late". */
export function seriesStateText(s, now = Date.now()) {
  if (!s) return '—';
  if (s.stale && finite(s.lastMeasuredMs)) return `${stateText(s.state)} when last measured ${whenText(s.lastMeasuredMs, now).replace(/^today /, '')}, not measured since`;
  if (s.state === 'silent') return seriesNow(s, now);
  return stateText(s.state);
}

/** The log types that are not late, in words: "the other 2 are on time", or each kind with its count. */
function othersText(list, now) {
  if (!list.length) return '';
  const on = list.filter((s) => isOnTime(s.state) && !s.stale);
  if (on.length === list.length) return list.length === 1 ? 'the other 1 is on time' : `the other ${list.length} are on time`;
  const part = (n, words) => (n ? `${n} ${words}` : '');
  const stale = list.filter((s) => s.stale); const fresh = list.filter((s) => !s.stale);
  const count = (f) => fresh.filter(f).length;
  return `the other ${list.length}: ${[part(on.length, 'on time'),
    part(count((s) => s.state === 'silent'), 'no logs'), part(count((s) => s.state === 'other_tz'), 'in another time zone'),
    part(count((s) => s.state === 'unmeasured' || s.state === 'clock_ahead'), "can't measure"),
    part(stale.length, stale.length === 1 && finite(stale[0].lastMeasuredMs) ? `not measured since ${whenText(stale[0].lastMeasuredMs, now).replace(/^today /, '')}` : 'not measured since an earlier run')].filter(Boolean).join(' · ')}`;
}

/**
 * The sentence above a device's tiles: "1 of 3 log types late: threat — the other 2 are on time".
 * '' when the device has no series (the field off, an older core).
 */
export function typesHeadline(series, { now = Date.now(), truncated = false } = {}) {
  const list = Array.isArray(series) ? series : [];
  const n = list.length;
  if (!n) return '';
  const late = list.filter(seriesLate);
  const rest = list.filter((s) => !seriesLate(s));
  const what = truncated ? `${n} log types read` : `${n} log types`;
  const more = truncated ? ' · the device has more, not read' : '';
  if (n === 1) return `Its only log type, ${typeLabel(list[0])}: ${seriesStateText(list[0], now)}${more}`;
  if (late.length === n) return `All ${what} late: ${namesText(late.map(typeLabel))}${more}`;
  if (late.length) return `${late.length} of ${what} late: ${namesText(late.map(typeLabel))} — ${othersText(rest, now)}${more}`;
  if (rest.every((s) => isOnTime(s.state) && !s.stale)) return `All ${what} on time${more}`;
  return `None of ${what} late — ${othersText(rest, now).replace(/^the other \d+: /, '')}${more}`;
}

/** The newest delay of a series, `{started → …}`, or null. */
export const lastEpisode = (s) => (s && Array.isArray(s.episodes) ? s.episodes : []).reduce((m, p) => (p && finite(p.started) && (!m || p.started > m.started) ? p : m), null);

/**
 * The slots of the lines to draw: a Map of series key → slot (0…LINES_MAX-1). `chosen` is the
 * viewer's earlier choice (kept for the series that are still there) or null: the first LINES_MAX,
 * worst first.
 */
export function lineSlots(series, chosen = null) {
  const keys = (series || []).map(typeKey);
  if (!chosen) return new Map(keys.slice(0, LINES_MAX).map((k, i) => [k, i]));
  return new Map([...chosen].filter(([k]) => keys.includes(k)));
}
/** The choice after pressing a log type: drawn → not drawn; not drawn → the lowest free slot (unchanged when LINES_MAX are drawn). */
export function toggleLine(slots, key) {
  const out = new Map(slots);
  if (out.has(key)) { out.delete(key); return out; }
  const used = new Set(out.values());
  for (let i = 0; i < LINES_MAX; i++) if (!used.has(i)) { out.set(key, i); break; }
  return out;
}

/**
 * The graph of several series on one scale: `{scaleMax, X, Y, lo, hi, lines: [{key, label, segments,
 * dots}], times}`; `times` are the measurements' instants (the hover stops at each). An unreadable
 * point breaks its line (deviceGraph), it is never a 0.
 */
export function seriesGraph(list, opts = {}) {
  const all = (list || []).flatMap((s) => s.points || []);
  const base = deviceGraph(all, opts);
  const lines = (list || []).map((s) => {
    const g = deviceGraph(s.points, { ...opts, fromMs: base.lo, toMs: base.hi, scaleMax: base.scaleMax });
    return { key: typeKey(s), label: typeLabel(s), segments: g.segments, dots: g.dots };
  });
  const times = [];
  for (const t of all.filter((p) => p && finite(p.t) && p.t >= base.lo && p.t <= base.hi).map((p) => p.t).sort((a, b) => a - b)) if (!times.length || t - times[times.length - 1] > SAME_RUN_MS) times.push(t);
  return { scaleMax: base.scaleMax, X: base.X, Y: base.Y, lo: base.lo, hi: base.hi, lines, times };
}

/** Points this close are one measurement's. */
export const SAME_RUN_MS = 60000;
/** One point in words: "46 min", "no logs", "can't measure"; no point at that measurement: "not measured". */
export function pointText(p) {
  if (!p) return 'not measured';
  if (finite(p.m)) return minutesText(p.m);
  return p.s === 'silent' ? 'no logs' : p.s === 'unmeasured' ? "can't measure" : 'not known';
}
/** Every drawn log type's delay at measurement `t`, in the legend's order: `[{key, label, text}]`. */
export function delaysAt(list, t) {
  return (list || []).map((s) => ({ key: typeKey(s), label: typeLabel(s), text: pointText((s.points || []).find((p) => p && Math.abs(p.t - t) <= SAME_RUN_MS)) }));
}
/** The hover's line: "threat 46 min · traffic 2 min · system 1 min". */
export const delaysAtText = (list, t) => delaysAt(list, t).map((x) => `${x.label} ${x.text}`).join(' · ');
