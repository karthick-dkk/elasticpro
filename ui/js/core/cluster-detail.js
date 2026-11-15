/**
 * Small readings the cluster pages share — pure, so the pages and their unit test read one
 * definition of each figure:
 *
 * - a node's roles, from the `node.role` letters `_cat/nodes` answers;
 * - the shard allocation gauge (how much of the cluster's shard count is active);
 * - the minutes-since-refresh badge every Refresh button carries, and the health counts.
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
