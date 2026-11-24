/**
 * Before a live index is deleted: is it in a snapshot, and did that snapshot succeed?
 *
 * "It is in a snapshot" is not enough. A snapshot in state PARTIAL or FAILED may hold a
 * broken copy, and a snapshot that is still IN_PROGRESS has not finished writing it. Only
 * SUCCESS counts, and the newest successful snapshot is the one reported so the operator
 * knows how recent the copy is. What such a snapshot can give back is restorableIndices
 * (core/snapshot-restorable.js), the one definition; a PARTIAL one is not enough to delete on.
 *
 * One listing per repository, with the index list attached to each snapshot — not one
 * call per snapshot, which on a repository with hundreds would take minutes.
 *
 * Reused, not refetched: state.js's own refresh (fetchSnapshots) already lists every
 * repository once per run, for the Snapshots page and the alert rules, and stores it at
 * `state.data.get(clusterId).snapshots[repoName]`. A retention check run straight after
 * that — the automation rule, on every cluster, every time it evaluates — would otherwise
 * double the snapshot listing calls for no new information. Only when nothing has been
 * fetched yet for a repository (a rule run on its own, or a headless run that never called
 * fetchSnapshots) does this ask Elasticsearch itself.
 */

import { client, state, ensureFullSnapshots, snapshotRowsVerbose, totalsOf } from './state.js';
import { restorableIndices, snapStatus, listingCut, repoListing, cutText, reposRead } from './snapshot-restorable.js';
import { indexQuery } from './index-match.js';

const SNAPSHOT_LIST_SIZE = 1000;

/** A fresh listing with whether it is the whole repository (a page of 1000 may not be). */
function listingOf(rows, j) {
  const t = totalsOf(j);
  return { rows, ...listingCut(rows.length, t.total === null && t.remaining === null && rows.length < SNAPSHOT_LIST_SIZE ? { whole: true } : t) };
}

/**
 * @returns {Promise<Map<string, {covered:boolean, best:object|null, all:Array, unverified:string[]}>>}
 *   keyed by index name. `unverified` names repositories that could not be read (or whose
 *   cached listing does not carry index names — see below), so a missing copy is never
 *   reported as fact when the answer is really "unknown".
 */
export async function verifyIndicesInSnapshots(cluster, names) {
  const cl = client(cluster.id);
  // With the core's fleet cache the listing in state.data may be the light _cat one, which
  // names no indices. Ask for the verbose one first (answered from the core's cache when it
  // is fresh); a row still without names afterwards is reported unverified below, never as
  // "not covered". No-op on the direct path, whose listing is already the verbose one.
  try { await ensureFullSnapshots(cluster.id); } catch (_) { /* the rows say what they lack */ }
  const d = state.data.get(cluster.id) || {};
  const repos = (d.repos || []).map((r) => r.name);
  const wanted = new Set(names);

  // index -> every snapshot holding it, across every repository
  const holders = new Map();
  for (const n of names) holders.set(n, []);
  const unverified = [];

  // A repository list nobody has read is not "no repository".
  if (!reposRead(d)) unverified.push('the snapshot repositories have not been read');

  for (const repo of repos) {
    const known = repoListing(d, (d.repos || []).find((r) => r.name === repo));
    let rows = known.rows, cut = known;
    if (rows) {
      // _cat/snapshots (fetchSnapshots' own fallback) does not name indices. A listing
      // built from it cannot say what any snapshot holds — unknown, not "not covered".
      if (rows.some((s) => s.indexNames == null)) {
        unverified.push(`${repo}: the cached snapshot listing has no index names (it came `
          + 'from _cat, not the verbose listing) — coverage there is unknown');
      }
    } else if (known.why !== 'not read yet') {
      // Known to be unreadable (or switched off): said, not asked again.
      unverified.push(`${repo}: ${known.why}`);
      continue;
    } else {
      try {
        const j = await cl.snapshots(repo, SNAPSHOT_LIST_SIZE);
        rows = snapshotRowsVerbose(j, cluster.indexNameRegex);
        cut = listingOf(rows, j);
      } catch (e) {
        unverified.push(`${repo}: ${e.message || e}`);
        continue;
      }
    }
    if (cut.cut) unverified.push(`${repo}: only the ${cutText(cut)} snapshots were read`);

    for (const s of rows) {
      if (s.indexNames == null) continue;   // can't say which indices this one holds
      const state_ = snapStatus(s);
      const held = s.indexNames.filter((idx) => wanted.has(idx));
      if (!held.length) continue;
      // A copy counts only when the whole snapshot succeeded AND had no failure on this index.
      const safe = new Set(state_ === 'SUCCESS' ? restorableIndices(s) || [] : []);
      for (const idx of held) {
        holders.get(idx).push({ repo, snapshot: s.id, state: state_, start: s.start || 0, end: s.end || 0, good: safe.has(idx) });
      }
    }
  }

  const out = new Map();
  for (const n of names) {
    const all = holders.get(n).sort((a, b) => b.start - a.start);
    const good = all.filter((s) => s.good);
    out.set(n, {
      covered: good.length > 0,
      best: good[0] || null,
      all,
      unverified,
      repos: repos.length,
    });
  }
  return out;
}

/** One-line verdict per index, for a table or a confirmation. */
export function coverageLabel(v) {
  if (!v) return { text: 'not checked', cls: 'grey' };
  if (v.covered) return { text: `in ${v.best.snapshot}`, cls: 'green' };
  if (v.unverified.length && !v.all.length) return { text: 'could not verify', cls: 'yellow' };
  if (v.all.length) {
    const st = v.all[0].state;
    if (v.unverified.length) return { text: `only seen in a ${st} snapshot, not all read`, cls: 'yellow' };
    return { text: `only in a ${st} snapshot`, cls: st === 'IN_PROGRESS' ? 'yellow' : 'red' };
  }
  if (!v.repos) return { text: 'no repository', cls: 'red' };
  return { text: 'NOT in any snapshot', cls: 'red' };
}

/**
 * Find an index by name across what is live and what is held in snapshots — the search
 * that answers "does this still exist anywhere" without opening two pages. `term` is read as
 * the Indices search box reads it (core/index-match.js: contains, globs, commas, `!`), and
 * `not` is that page's "Not matching" toggle.
 */
export async function findIndexEverywhere(cluster, term, { max = 200, not = false } = {}) {
  const q = indexQuery(term, { not });
  // Whose answer this is travels with it: a page that has moved to another cluster drops it.
  if (!q.active) return { clusterId: cluster.id, live: [], snapshotted: [], unverified: [], liveRead: state.indices.has(cluster.id), truncated: false };

  const live = (state.indices.get(cluster.id) || [])
    .filter((r) => q.test(r.index))
    .map((r) => ({ index: r.index, size: r.size, docs: r.docs, day: r.day, status: r.status, health: r.health }));

  const cl = client(cluster.id);
  const d = state.data.get(cluster.id) || {};
  const repos = (d.repos || []).map((r) => r.name);
  const found = new Map();   // index -> { snapshots: [...] }
  const unverified = [];
  let truncated = false;     // more than `max` names matched: the rest were not looked at
  if (!reposRead(d)) unverified.push('the snapshot repositories have not been read');
  for (const repo of repos) {
    let list;
    // The listing is read like any page's (held by the gap and shared); the term is matched here.
    try {
      const j = await cl.snapshots(repo, SNAPSHOT_LIST_SIZE);
      list = j.snapshots || [];
      const cut = listingOf(list, j);
      if (cut.cut) unverified.push(`${repo}: only the ${cutText(cut)} snapshots were read`);
    } catch (e) { unverified.push(`${repo}: ${e.message || e}`); continue; }
    for (const s of snapshotRowsVerbose({ snapshots: list }, cluster.indexNameRegex)) {
      const ok = new Set(restorableIndices(s) || []);
      for (const idx of s.indexNames) {
        if (!q.test(idx)) continue;
        if (!found.has(idx)) {
          if (found.size >= max) { truncated = true; continue; }
          found.set(idx, { index: idx, snapshots: [] });
        }
        found.get(idx).snapshots.push({ repo, snapshot: s.id, state: snapStatus(s), start: s.start || 0,
          good: snapStatus(s) === 'SUCCESS' && ok.has(idx) });
      }
    }
  }
  const liveSet = new Set(live.map((r) => r.index));
  const snapshotted = [...found.values()].map((f) => ({
    ...f,
    snapshots: f.snapshots.sort((a, b) => b.start - a.start),
    alsoLive: liveSet.has(f.index),
    successful: f.snapshots.filter((s) => s.good).length,
  }));
  return { clusterId: cluster.id, live, snapshotted, unverified, truncated, max, liveRead: state.indices.has(cluster.id) };
}
