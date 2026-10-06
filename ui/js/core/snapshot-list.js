/**
 * The snapshot list on the Snapshots page: which rows a search keeps, which page of them
 * is on screen, and what the CSV says. Pure, so the paging and the export are tested
 * without a DOM — and so the page and its export cannot filter differently.
 */

import { pageSlice } from '../lib/pager.js';

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

/** Newest first — the order the listing arrives in, restated so the page never depends on it. */
export function newestFirst(snaps) {
  return [...(snaps || [])].sort((a, b) => (Number(b.start) || 0) - (Number(a.start) || 0));
}

/** The page on screen: filtered, newest first, sliced (pageSlice clamps a stale page). */
export function snapshotPage(snaps, { text = '', page = 0, perPage = SNAPSHOT_PAGE_SIZES[0] } = {}) {
  const rows = newestFirst(filterSnapshots(snaps, text));
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
