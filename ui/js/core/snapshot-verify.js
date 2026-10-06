/**
 * Before a live index is deleted: is it in a snapshot, and did that snapshot succeed?
 *
 * "It is in a snapshot" is not enough. A snapshot in state PARTIAL or FAILED may hold a
 * broken copy, and a snapshot that is still IN_PROGRESS has not finished writing it. Only
 * SUCCESS counts, and the newest successful snapshot is the one reported so the operator
 * knows how recent the copy is.
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

import { client, state, ensureFullSnapshots } from './state.js';

const SNAPSHOT_LIST_SIZE = 1000;

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

  for (const repo of repos) {
    const cached = d.snapshots && d.snapshots[repo];
    let entries;

    if (Array.isArray(cached)) {
      // fetchSnapshots' own shape: {id, status, indexNames, start, end, failed, ...}.
      // It keeps only the snapshot-wide failed-shard COUNT, not which index a failure
      // belonged to (the raw ES response's `failures[]` does, but that is not worth
      // carrying through a cache every page reads). Treating any shard failure in the
      // snapshot as disqualifying is the conservative reading: it can only turn a
      // "covered" into a "blocked", never the other way, so reusing this listing never
      // reports a copy as safe when the fresher, per-index check below would not have.
      entries = cached.map((s) => ({
        snapshot: s.id,
        state: String(s.status || '').toUpperCase(),
        start: s.start || 0,
        end: s.end || 0,
        indexNames: s.indexNames,   // null when this listing came from the _cat fallback
        good: String(s.status || '').toUpperCase() === 'SUCCESS' && !(s.failed > 0),
      }));
      // _cat/snapshots (fetchSnapshots' own fallback) does not name indices. A listing
      // built from it cannot say what any snapshot holds — unknown, not "not covered".
      if (entries.some((e) => e.indexNames == null)) {
        unverified.push(`${repo}: the cached snapshot listing has no index names (it came `
          + 'from _cat, not the verbose listing) — coverage there is unknown');
      }
    } else {
      try {
        const j = await cl.snapshots(repo, SNAPSHOT_LIST_SIZE);
        entries = (j.snapshots || []).map((s) => ({
          snapshot: s.snapshot,
          state: String(s.state || '').toUpperCase(),
          start: s.start_time_in_millis || (s.start_time ? Date.parse(s.start_time) : 0),
          end: s.end_time_in_millis || (s.end_time ? Date.parse(s.end_time) : 0),
          indexNames: s.indices || [],
          // A fresh fetch keeps the raw per-index failure list, so "good" is computed
          // below, per index, with the same precision the original check had.
          rawFailures: s.failures || [],
        }));
      } catch (e) {
        unverified.push(`${repo}: ${e.message || e}`);
        continue;
      }
    }

    for (const s of entries) {
      if (s.indexNames == null) continue;   // can't say which indices this one holds
      for (const idx of s.indexNames) {
        if (!wanted.has(idx)) continue;
        const good = 'good' in s ? s.good
          : s.state === 'SUCCESS' && s.rawFailures.filter((f) => f.index === idx).length === 0;
        holders.get(idx).push({ repo, snapshot: s.snapshot, state: s.state, start: s.start, end: s.end, good });
      }
    }
  }

  const out = new Map();
  for (const n of names) {
    const all = holders.get(n).sort((a, b) => b.start - a.start);
    // A copy counts only when the whole snapshot succeeded AND had no failure on this index.
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
    return { text: `only in a ${st} snapshot`, cls: st === 'IN_PROGRESS' ? 'yellow' : 'red' };
  }
  if (!v.repos) return { text: 'no repository', cls: 'red' };
  return { text: 'NOT in any snapshot', cls: 'red' };
}

/**
 * Find an index by name across what is live and what is held in snapshots — the search
 * that answers "does this still exist anywhere" without opening two pages.
 */
export async function findIndexEverywhere(cluster, term, { max = 200 } = {}) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return { live: [], snapshotted: [], unverified: [] };

  const live = (state.indices.get(cluster.id) || [])
    .filter((r) => r.index.toLowerCase().includes(needle))
    .map((r) => ({ index: r.index, size: r.size, docs: r.docs, day: r.day, status: r.status, health: r.health }));

  const cl = client(cluster.id);
  const repos = ((state.data.get(cluster.id) || {}).repos || []).map((r) => r.name);
  const found = new Map();   // index -> { snapshots: [...] }
  const unverified = [];
  for (const repo of repos) {
    let list;
    try { list = (await cl.snapshots(repo, SNAPSHOT_LIST_SIZE)).snapshots || []; }
    catch (e) { unverified.push(`${repo}: ${e.message || e}`); continue; }
    for (const s of list) {
      for (const idx of s.indices || []) {
        if (!idx.toLowerCase().includes(needle)) continue;
        if (!found.has(idx)) found.set(idx, { index: idx, snapshots: [] });
        found.get(idx).snapshots.push({
          repo, snapshot: s.snapshot, state: String(s.state || '').toUpperCase(),
          start: s.start_time_in_millis || (s.start_time ? Date.parse(s.start_time) : 0),
        });
        if (found.size >= max) break;
      }
    }
  }
  const liveSet = new Set(live.map((r) => r.index));
  const snapshotted = [...found.values()].map((f) => ({
    ...f,
    snapshots: f.snapshots.sort((a, b) => b.start - a.start),
    alsoLive: liveSet.has(f.index),
    successful: f.snapshots.filter((s) => s.state === 'SUCCESS').length,
  }));
  return { live, snapshotted, unverified };
}
