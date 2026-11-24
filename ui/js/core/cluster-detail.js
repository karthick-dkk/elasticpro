/**
 * What a cluster's open row on the Clusters page is drawn from — pure, so the page and
 * its unit test read one definition of each figure:
 *
 * - a node's roles and its data tier, from the `node.role` letters `_cat/nodes` answers;
 * - the shard allocation gauge (how much of the cluster's shard count is active);
 * - the task count and the search/index rate from two readings of `_nodes/stats`;
 * - which SLM policy writes to a repository, and what it last produced;
 * - a repository's size from the snapshot-size cache, when every snapshot in it has been
 *   measured — a partial sum is not a size, so it stays unknown;
 * - the minutes-since-refresh badge every Refresh button carries.
 */

/**
 * `_cat/nodes` `node.role` is a string of letters, one per role. The letters are
 * Elasticsearch's own (cat nodes docs); `-` alone is a coordinating-only node.
 */
export const ROLE_LETTERS = {
  m: 'master', d: 'data', h: 'data_hot', w: 'data_warm', c: 'data_cold', f: 'data_frozen',
  s: 'data_content', i: 'ingest', l: 'ml', r: 'remote_cluster_client', t: 'transform', v: 'voting_only',
};

/** The roles a node has, in Elasticsearch's own names. Coordinating-only: an empty list. */
export function nodeRoles(code) {
  const s = String(code || '').trim();
  if (!s || s === '-') return [];
  const out = [];
  for (const ch of s) {
    const r = ROLE_LETTERS[ch];
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/** The tier names, in the order ILM moves data through them. */
export const TIERS = ['hot', 'warm', 'cold', 'frozen'];

/**
 * A node's data tier from its roles: the hottest `data_*` tier it holds. A plain `data`
 * role (every tier at once) and `data_content` are "data" with no tier; a node with no
 * data role at all has none.
 */
export function nodeTier(roles) {
  const r = new Set(roles || []);
  for (const t of TIERS) if (r.has(`data_${t}`)) return t;
  if (r.has('data') || r.has('data_content')) return 'data';
  return null;
}

/** The chip colour a role takes; `other` is the quiet default. */
export function roleKind(role) {
  if (role === 'master') return 'master';
  if (role === 'data_hot' || role === 'data') return 'hot';
  if (role === 'data_warm') return 'warm';
  if (role === 'data_cold' || role === 'data_frozen') return 'cold';
  if (role === 'ingest') return 'ingest';
  return 'other';
}

/**
 * The shard allocation gauge from `_cluster/health`. `pct` is Elasticsearch's own
 * `active_shards_percent_as_number`; unknown (no health yet) is null, never 0.
 */
export function shardAllocation(health) {
  if (!health || !isFinite(Number(health.active_shards))) return null;
  const n = (k) => Number(health[k]) || 0;
  const active = n('active_shards'), relocating = n('relocating_shards'), initializing = n('initializing_shards'), unassigned = n('unassigned_shards');
  const pct = isFinite(Number(health.active_shards_percent_as_number)) ? Number(health.active_shards_percent_as_number) : null;
  return { active, relocating, initializing, unassigned, total: active + relocating + initializing + unassigned, pct,
    level: unassigned > 0 && String(health.status) === 'red' ? 'bad' : (pct !== null && pct < 100) ? 'warn' : 'ok' };
}

/**
 * The task count from a `_tasks` answer (`{nodes: {id: {tasks: {...}}}}`): how many are
 * running, and how many have run longer than `slowMs`.
 */
export function taskSummary(res, { slowMs = 60000 } = {}) {
  if (!res || typeof res !== 'object') return null;
  let running = 0, slow = 0;
  for (const node of Object.values(res.nodes || {})) {
    for (const t of Object.values((node && node.tasks) || {})) {
      running += 1;
      const ms = typeof t.running_time_in_nanos === 'number' ? t.running_time_in_nanos / 1e6 : 0;
      if (ms > slowMs) slow += 1;
    }
  }
  return { running, slow };
}

/** The cluster-wide search and indexing counters out of one `_nodes/stats` answer. */
export function statsCounters(res, at = Date.now()) {
  if (!res || !res.nodes) return null;
  let query = 0, index = 0;
  for (const n of Object.values(res.nodes)) {
    const i = (n && n.indices) || {};
    query += Number(i.search && i.search.query_total) || 0;
    index += Number(i.indexing && i.indexing.index_total) || 0;
  }
  return { query, index, at };
}

/**
 * Searches and documents per second between two readings. Not a rate until there are
 * two readings some seconds apart; a counter that went backwards (a node restarted) is a
 * new baseline, not a negative rate. `query_total` counts once per shard, so the figure
 * is shard-level, which the page says.
 */
export function rateBetween(prev, now) {
  if (!prev || !now) return null;
  const sec = (now.at - prev.at) / 1000;
  if (!(sec >= 1)) return null;
  const dq = now.query - prev.query, di = now.index - prev.index;
  if (dq < 0 || di < 0) return null;
  return { qps: dq / sec, dps: di / sec, seconds: sec };
}

/** The SLM policies that write to `repoName`, each with what it last produced. */
export function slmForRepo(slm, repoName) {
  return (slm || []).filter((p) => p && p.policy && p.policy.repository === repoName).map((p) => ({
    id: p.id, pattern: (p.policy && p.policy.name) || '', schedule: (p.policy && p.policy.schedule) || '',
    lastSnapshot: (p.last_success && p.last_success.snapshot_name) || null,
    lastAt: (p.last_success && p.last_success.time) || null,
    lastFailed: (p.last_failure && p.last_failure.snapshot_name) || null,
  }));
}

/**
 * A repository's size from the per-snapshot cache the Volume report and the Snapshots
 * page fill (lib/idb.js repoSizeCache, keyed `${repo}/${snapshotId}`): the sum when every
 * finished snapshot has an entry, otherwise null — unknown is not a smaller number.
 */
export function repoSizeFromCache(repoName, snaps, cacheMap) {
  const list = (snaps || []).filter((s) => String(s.status || '').toUpperCase() !== 'IN_PROGRESS');
  if (!list.length || !cacheMap) return null;
  let total = 0;
  for (const s of list) {
    const v = cacheMap.get ? cacheMap.get(`${repoName}/${s.id}`) : cacheMap[`${repoName}/${s.id}`];
    const n = v && typeof v === 'object' ? Number(v.bytes) : Number(v);
    if (!isFinite(n)) return null;
    total += n;
  }
  return total;
}

/**
 * The age badge on a Refresh button: whole minutes since the last refresh ("0m" under a
 * minute, "19m", then "1h 5m"); nothing before the first refresh.
 */
export function refreshAge(lastMs, nowMs = Date.now()) {
  if (!lastMs) return '';
  const m = Math.max(0, Math.floor((nowMs - Number(lastMs)) / 60000));
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  return hr < 48 ? `${hr}h ${m % 60}m` : `${Math.floor(hr / 24)}d`;
}

/** The header counts the Health filter offers, from the page's health classifier. */
export function healthCounts(rows, healthOf) {
  const out = { all: rows.length, green: 0, yellow: 0, red: 0, unreachable: 0, loading: 0 };
  for (const r of rows) {
    const s = healthOf(r);
    if (s in out) out[s] += 1; else out.loading += 1;
  }
  return out;
}
