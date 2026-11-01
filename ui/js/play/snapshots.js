/**
 * Small readers over a cluster's snapshot rows (`state.data.get(id).snapshots`, built by
 * core/state.js snapshotRowsVerbose / snapshotRowsCat): the last good one, the failures in
 * a window. Filters only — status and end time — nothing is worked out again.
 *
 * Unknown is not zero: a cluster whose repositories or listings have not been read is
 * `unknown`, never "no snapshots".
 */

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
  if (!d.repos.length) return d.reachable ? 'none' : 'unknown';
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
