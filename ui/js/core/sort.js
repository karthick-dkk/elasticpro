/**
 * The one column sort every table uses: how a value of each kind compares, what counts as
 * unknown, and which order a header click goes to next. Pure — no DOM, no storage — so the
 * rules are tested on their own (tools/unit/sort.test.mjs); lib/table-sort.js draws the
 * headers and remembers each table's choice.
 *
 * Kinds (a column's `type`):
 *   - `text`     natural, case- and accent-insensitive: node2 before node10 (the cluster-name
 *                order, lib/cluster-order.js compareNames)
 *   - `number`   a number, or text that starts with one ("1,234", "12 docs")
 *   - `bytes`    a byte count, or a size as shown ("12.3 GB", "1 TB", "512 MiB"), 1024-based
 *   - `percent`  a number, or "45 %"
 *   - `duration` milliseconds, or a duration as shown ("350 ms", "1.5 s", "3m 20s", "2 d")
 *   - `date`     a Date, epoch milliseconds, or text Date.parse reads ("2026-11-10")
 *
 * An unknown value — null, NaN, empty, a dash, "not measured", "[set]", or text a numeric
 * kind cannot read — sorts after every known one in BOTH directions. Unknown is not zero
 * (CLAUDE.md): it must never float to the top when the order flips.
 */

import { compareNames } from '../lib/cluster-order.js';

export const SORT_TYPES = ['text', 'number', 'bytes', 'percent', 'duration', 'date'];

/** What a table writes where it has no figure; compared lower-case, trimmed. */
const UNKNOWN_WORDS = new Set([
  '', '—', '–', '-', '?', 'n/a', 'unknown', 'not known', 'not measured',
  'not read', 'not read yet', 'not reported', 'not set', 'never measured', '[set]',
]);

/** Whether `v` is an unknown, before any kind reads it. */
export function isUnknown(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number') return Number.isNaN(v);
  if (v instanceof Date) return Number.isNaN(v.getTime());
  if (typeof v === 'string') return UNKNOWN_WORDS.has(v.trim().toLowerCase());
  return false;
}

const NUM_RE = /^[-+]?(?:\d[\d,   ]*)?\.?\d+(?:e[-+]?\d+)?/i;

function leadingNumber(s) {
  const m = String(s).trim().match(NUM_RE);
  if (!m) return null;
  const n = Number(m[0].replace(/[,   ]/g, ''));
  return Number.isFinite(n) ? n : null;
}

const BYTE_UNITS = { b: 0, k: 1, kb: 1, kib: 1, m: 2, mb: 2, mib: 2, g: 3, gb: 3, gib: 3, t: 4, tb: 4, tib: 4, p: 5, pb: 5, pib: 5, e: 6, eb: 6, eib: 6 };

function parseBytes(s) {
  const m = String(s).trim().match(/^([-+]?[\d,.   ]*\d(?:\.\d+)?)\s*([a-z]*)$/i);
  if (!m) return null;
  const n = leadingNumber(m[1]);
  if (n === null) return null;
  const u = m[2].toLowerCase();
  if (!u) return n;
  if (!(u in BYTE_UNITS)) return null;
  return n * 1024 ** BYTE_UNITS[u];
}

const DUR_UNITS = [
  [/^(ms|msec|millis(?:econds?)?)$/, 1],
  [/^(s|sec|secs|seconds?)$/, 1e3],
  [/^(m|min|mins|minutes?)$/, 6e4],
  [/^(h|hr|hrs|hours?)$/, 36e5],
  [/^(d|days?)$/, 864e5],
  [/^(w|wk|wks|weeks?)$/, 6048e5],
];

function parseDuration(s) {
  const t = String(s).trim().toLowerCase();
  const clock = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) {
    const [a, b, c] = [clock[1], clock[2], clock[3]].map((x) => (x === undefined ? null : Number(x)));
    return c === null ? (a * 60 + b) * 1e3 : (a * 3600 + b * 60 + c) * 1e3;
  }
  const parts = [...t.matchAll(/([-+]?\d+(?:\.\d+)?)\s*([a-z]+)/g)];
  if (!parts.length) return leadingNumber(t);
  let total = 0;
  for (const [, n, u] of parts) {
    const unit = DUR_UNITS.find(([re]) => re.test(u));
    if (!unit) return null;
    total += Number(n) * unit[1];
  }
  return total;
}

/**
 * The comparable form of `v` read as `type`: a number for every numeric kind, the text for
 * `text`, null when it is unknown. Tables pass the underlying value where they have it; the
 * text parsing is for tables that only hold what they show.
 */
export function sortValue(v, type = 'text') {
  if (isUnknown(v)) return null;
  if (type === 'text') return typeof v === 'string' ? v : String(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (type === 'date') {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const t = Date.parse(String(v).trim());
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (type === 'bytes') return parseBytes(v);
  if (type === 'duration') return parseDuration(v);
  // number, percent: the figure at the front ("45 %", "1,234 docs")
  return leadingNumber(v);
}

/** Two comparable values (both known) in ascending order. */
function compareKnown(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number') return -1;     // a stray figure in a text column goes before words
  if (typeof b === 'number') return 1;
  return compareNames(a, b);
}

/**
 * Compare raw values `a` and `b` as `type` in direction `dir` (1 ascending, -1 descending),
 * an unknown after every known value whichever way it runs, two unknowns equal.
 */
export function compareValues(a, b, type = 'text', dir = 1) {
  return compareSortValues(sortValue(a, type), sortValue(b, type), dir);
}

/** compareValues for values already read by sortValue (null = unknown). */
export function compareSortValues(x, y, dir = 1) {
  const xn = x === null || x === undefined, yn = y === null || y === undefined;
  if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
  return compareKnown(x, y) * (dir < 0 ? -1 : 1);
}

/**
 * `rows` in `sort` order (`{ key, dir }`), each column read through `cols[key]`:
 * `{ type, value(row) }` (value defaults to `row[key]`). Stable: rows the column calls equal
 * keep the order they came in, so a table that redraws every second never shuffles its ties.
 * A missing sort or a key the table does not have leaves the rows in their own order (a copy).
 */
export function sortRows(rows, sort, cols) {
  const list = Array.isArray(rows) ? rows : [];
  const col = sort && cols && cols[sort.key];
  if (!col) return [...list];
  const type = col.type || 'text';
  const read = col.value || ((r) => (r == null ? null : r[sort.key]));
  const dir = sort.dir < 0 ? -1 : 1;
  return list.map((r, i) => ({ r, i, v: sortValue(read(r), type) }))
    .sort((a, b) => compareSortValues(a.v, b.v, dir) || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Where a header click goes from `sort`: a new column starts in its own first direction
 * (`start`, 1 unless the column says -1); the active column reverses. When the table has an
 * order of its own that is no column (`natural`), the click after the reverse goes back to it
 * (null) — so "in flight first, then newest" can be had again without clearing storage.
 */
export function nextSort(sort, key, { start = 1, natural = false } = {}) {
  const first = start < 0 ? -1 : 1;
  if (!sort || sort.key !== key) return { key, dir: first };
  if (natural && sort.dir !== first) return null;
  return { key, dir: -sort.dir };
}

/** aria-sort for a column: 'ascending', 'descending', or 'none'. */
export function ariaSort(sort, key) {
  if (!sort || sort.key !== key) return 'none';
  return sort.dir < 0 ? 'descending' : 'ascending';
}

/** The arrow after an active column's name: ▲ ascending, ▼ descending, '' otherwise. */
export function sortArrow(sort, key) {
  if (!sort || sort.key !== key) return '';
  return sort.dir < 0 ? '▼' : '▲';
}

/** A stored or handed-in order, checked: `{ key, dir }` with a key in `keys`, else null. */
export function validSort(s, keys) {
  if (!s || typeof s !== 'object') return null;
  const dir = Number(s.dir);
  if (typeof s.key !== 'string' || (dir !== 1 && dir !== -1)) return null;
  if (keys && !keys.includes(s.key)) return null;
  return { key: s.key, dir };
}
