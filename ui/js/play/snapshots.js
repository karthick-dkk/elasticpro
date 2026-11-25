/**
 * Small readers over a cluster's snapshot rows (`state.data.get(id).snapshots`, built by
 * core/state.js snapshotRowsVerbose / snapshotRowsCat): the last good one, the failures in
 * a window. Filters only — status and end time — nothing is worked out again.
 *
 * Unknown is not zero: a cluster whose repositories or listings have not been read is
 * `unknown`, never "no snapshots".
 */

import { availability, listingsKnown, noRepository, repoListing } from '../core/snapshot-restorable.js';

const BAD = new Set(['FAILED', 'PARTIAL']);
const statusOf = (s) => String((s && s.status) || '').toUpperCase();
/** When a snapshot finished, else when it started (a _cat row with no end). */
export const endOf = (s) => (s && (Number(s.end) || Number(s.start))) || 0;

/**
 * Whether the listing can be read from: 'unknown' (repositories or a listing not read yet, or
 * the cluster is not answering — what it had is not current),
 * 'none' (no repository registered), 'read'.
 */
export function listingState(d) {
  if (!d || !Array.isArray(d.repos) || d.reachable === false) return 'unknown';
  if (!d.repos.length) return d.reachable && noRepository(d) ? 'none' : 'unknown';
  const snaps = d.snapshots || {};
  const readable = d.repos.filter((r) => Array.isArray(snaps[r.name]));
  return readable.length ? 'read' : 'unknown';
}

/** Every snapshot row with its repository, newest finished first. */
export function allSnapshots(d) {
  const out = [];
  for (const [repo, list] of Object.entries((d && d.snapshots) || {})) for (const s of list || []) out.push({ ...s, repo });
  return out.sort((a, b) => endOf(b) - endOf(a));
}

/** The newest SUCCESS snapshot, or null (none, or not read — see listingState). */
export function lastGood(d) {
  return allSnapshots(d).find((s) => statusOf(s) === 'SUCCESS') || null;
}

/** FAILED and PARTIAL snapshots that finished at or after `from`, newest first. */
export function failuresSince(d, from) {
  return allSnapshots(d).filter((s) => BAD.has(statusOf(s)) && endOf(s) >= from);
}

/** true / false, or null when the listing is not known. */
export function backedUpWithin(d, ms, now) {
  if (listingState(d) !== 'read') return null;
  const g = lastGood(d);
  return !!g && now - endOf(g) <= ms;
}

/** The newest snapshot that finished (good or not), or null. A run in progress is not one. */
export function lastFinished(d) {
  return allSnapshots(d).find((s) => statusOf(s) === 'SUCCESS' || BAD.has(statusOf(s))) || null;
}

/**
 * The one state the Backups slide counts a cluster under, with why:
 * 'failed' (the newest finished run FAILED or PARTIAL), 'late' (no good snapshot inside `staleMs`),
 * 'good', 'norepo' (no repository registered) or 'unread'. A cluster with a repository that could
 * not be read is 'unread' unless what was read already settles it: the missing good snapshot may
 * be in the repository nobody read.
 */
export function backupState(d, staleMs, now) {
  const st = listingState(d);
  if (st === 'none') return { state: 'norepo', why: 'no repository set up' };
  if (st !== 'read') return { state: 'unread', why: 'not read' };
  const last = lastFinished(d);
  if (last && BAD.has(statusOf(last))) return { state: 'failed', why: statusOf(last) === 'PARTIAL' ? 'partial' : 'failed', last };
  if (backedUpWithin(d, staleMs, now)) return { state: 'good', why: '' };
  const known = listingsKnown(d);
  if (known.unread.length) return { state: 'unread', why: `${known.unread.length} of ${known.total} repositories not read` };
  return { state: 'late', why: lastGood(d) ? 'late' : 'no good snapshot' };
}

/**
 * The last `days` days of a cluster, oldest first, as `availability()` gives them (the same days
 * the Snapshots page draws), over every repository that was read; null when none was.
 */
export function backupDays(d, { days = 14, tz = 'UTC', now = Date.now() } = {}) {
  if (listingState(d) !== 'read') return null;
  const lists = d.repos.map((r) => repoListing(d, r));
  const read = lists.filter((l) => l.rows);
  if (!read.length) return null;
  const each = read.map((l) => availability(l.rows, { days, tz, now, cut: l.cut }).days);
  const part = read.length < lists.length;
  // Good in any repository is good. Else: not read beats a failure beats none, so a day that
  // may be good in a listing nobody read is never drawn as missed.
  return each[0].map((x, i) => {
    const at = each.map((e) => e[i].state);
    const state = at.includes('ok') ? 'ok' : at.includes('today') ? 'today'
      : at.includes('notread') || part ? 'notread' : at.includes('bad') ? 'bad' : 'none';
    return { date: x.date, state };
  });
}
