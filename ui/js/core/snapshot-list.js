/**
 * The snapshot list on the Snapshots page: which rows a search keeps, which page of them
 * is on screen, and what the CSV says. Pure, so the paging and the export are tested
 * without a DOM — and so the page and its export cannot filter differently.
 */

import { pageSlice } from '../lib/pager.js';
import { compareNullLast } from '../lib/sort-order.js';

/** Rows per page the picker offers; the first is what the page opens with. */
export const SNAPSHOT_PAGE_SIZES = [10, 25, 50, 100];

/**
 * Snapshots whose name or status contains the text, or that hold an index whose name does
 * — "which snapshot has logstash-2026.09.23" is the question most searches here ask.
 * A row from the _cat listing names no indices, so it can match only on name and status.
 */
export function filterSnapshots(snaps, text) {
  const q = String(text || '').trim().toLowerCase();
  const all = snaps || [];
  if (!q) return all;
  return all.filter((s) => String(s.id || '').toLowerCase().includes(q)
    || String(s.status || '').toLowerCase().includes(q)
    || (Array.isArray(s.indexNames) && s.indexNames.some((n) => String(n).toLowerCase().includes(q))));
}

/**
 * The orders the list offers (lib/sort-order.js shape): the Sort select and the column
 * headers are the same control, so both read this. The list opens on taken, newest first.
 */
export const SNAPSHOT_SORTS = {
  taken: { label: 'taken', dirs: { '-1': 'newest first', '1': 'oldest first' }, start: -1 },
  name: { label: 'snapshot name', dirs: { '1': 'A → Z', '-1': 'Z → A' }, start: 1 },
  status: { label: 'status', dirs: { '-1': 'failures first', '1': 'successes first' }, start: -1 },
  indices: { label: 'indices', dirs: { '-1': 'most first', '1': 'fewest first' }, start: -1 },
  duration: { label: 'duration', dirs: { '-1': 'longest first', '1': 'shortest first' }, start: -1 },
  cover: { label: 'data inside', dirs: { '1': 'oldest covered day first', '-1': 'newest covered day first' }, start: 1 },
};
export const DEFAULT_SNAPSHOT_SORT = { key: 'taken', dir: -1 };

/** How much a status needs looking at: failures first means this, descending. */
const STATUS_RANK = { FAILED: 3, PARTIAL: 2, IN_PROGRESS: 1, SUCCESS: 0 };

/**
 * A snapshot's duration in milliseconds. The verbose listing gives a number; `_cat` gives
 * Elasticsearch's time string ("5.2m", "350ms", "1.1h"). Anything else is unknown (null),
 * which sorts last — never 0, which would read as "instant".
 */
export function durationMs(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|micros|nanos)?\s*$/.exec(String(v == null ? '' : v));
  if (!m) return null;
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, micros: 0.001, nanos: 0.000001 }[m[2] || 'ms'];
  return Number(m[1]) * unit;
}

/**
 * The rows in one of the orders above. Unknowns (a `_cat` row's covered days, an unreadable
 * duration) sort last either way; ties fall back to newest first, so the order is stable.
 */
export function sortSnapshots(snaps, sort = DEFAULT_SNAPSHOT_SORT) {
  const dir = sort.dir === 1 ? 1 : -1;
  const start = (s) => (Number(s.start) || 0);
  const by = {
    taken: (a, b) => compareNullLast(start(a), start(b), dir),
    name: (a, b) => compareNullLast(String(a.id || ''), String(b.id || ''), dir),
    status: (a, b) => compareNullLast(STATUS_RANK[String(a.status || '').toUpperCase()] ?? 1,
      STATUS_RANK[String(b.status || '').toUpperCase()] ?? 1, dir),
    indices: (a, b) => compareNullLast(a.indices == null ? null : Number(a.indices), b.indices == null ? null : Number(b.indices), dir),
    duration: (a, b) => compareNullLast(durationMs(a.duration), durationMs(b.duration), dir),
    cover: (a, b) => compareNullLast(a.coverFrom || null, b.coverFrom || null, dir),
  }[sort.key] || (() => 0);
  return [...(snaps || [])].sort((a, b) => by(a, b) || (start(b) - start(a)));
}

/** Newest first — the order the listing arrives in, restated so the page never depends on it. */
export function newestFirst(snaps) {
  return sortSnapshots(snaps, DEFAULT_SNAPSHOT_SORT);
}

/**
 * The list's columns, in order. `fixed` columns cannot be hidden: a row that does not
 * name its snapshot is not a row. `sort` names the order a click on the header gives.
 */
export const SNAPSHOT_COLUMNS = [
  { key: 'snapshot', label: 'Snapshot', fixed: true, sort: 'name' },
  { key: 'status', label: 'Status', sort: 'status' },
  { key: 'taken', label: 'Taken', sort: 'taken' },
  { key: 'ended', label: 'Ended' },
  { key: 'duration', label: 'Duration', sort: 'duration', num: true },
  { key: 'indices', label: 'Indices', sort: 'indices' },
  { key: 'cover', label: 'Data inside covers', sort: 'cover' },
  { key: 'shards', label: 'Shards ok', num: true },
  { key: 'failed', label: 'Failed', num: true },
];

/** The columns on screen: every one not in `hidden`, fixed ones regardless. */
export function shownColumns(hidden) {
  const off = new Set(hidden || []);
  return SNAPSHOT_COLUMNS.filter((c) => c.fixed || !off.has(c.key));
}

/** The page on screen: filtered, in the chosen order, sliced (pageSlice clamps a stale page). */
export function snapshotPage(snaps, { text = '', page = 0, perPage = SNAPSHOT_PAGE_SIZES[0], sort = DEFAULT_SNAPSHOT_SORT } = {}) {
  const rows = sortSnapshots(filterSnapshots(snaps, text), sort);
  return { rows, slice: pageSlice(rows, page, perPage) };
}

/**
 * CSV rows for every snapshot given — never just the page. Carries the days of data
 * inside as well as when it ran: the two are different questions, and a backup export
 * that only says when the job ran answers the wrong one. Unknown stays blank-and-said,
 * not a guessed date.
 */
export function snapshotCsvRows(snaps) {
  const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : '');
  return (snaps || []).map((s) => ({
    snapshot: s.id, status: s.status, start: iso(s.start), end: iso(s.end),
    duration: s.duration, indices: s.indices,
    data_from: s.indexNames == null ? 'unknown' : (s.coverFrom || ''),
    data_to: s.indexNames == null ? 'unknown' : (s.coverTo || ''),
    data_days: s.indexNames == null ? '' : (s.coverDays || 0),
    successful_shards: s.successful, failed_shards: s.failed, total_shards: s.total,
  }));
}
