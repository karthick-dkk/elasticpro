/**
 * Query pressure: what a cluster is being asked to do per second, read from two `_nodes/stats`
 * readings of it (core/es.js nodesRates — indices, thread_pool and breaker, filtered to the
 * counters below). One definition for every card that shows it (Nodes & shards' Query
 * pressure card, the Clusters overview): `nodeRates(clusterId)`.
 *
 *   - a counter is cumulative since the node started, so a rate is the delta between the two
 *     most recent readings over the seconds between them, summed over the nodes;
 *   - a queue is a level, not a counter: the latest reading, as it is;
 *   - before two readings exist nothing is a rate — `measured: false`, the rate fields null,
 *     and the card says "measuring · next poll". Unknown is not zero. The same when a counter
 *     went backwards (a node restarted): the reading is a new baseline, not a negative rate;
 *   - a counter no node reported (a filtered answer, an older cluster) stays null, so a
 *     missing breaker section is "not known", never "0 trips".
 *
 * The arithmetic is `readingOf` + `ratesBetween`, pure and tested in tools/unit/node-rates.test.mjs.
 * The readings are kept here, per cluster, the last two only (`recordReading`), by whichever
 * page is polling the cluster.
 */

import { state } from './state.js';

/* ------------------------------------ tasks ------------------------------------ */

/**
 * Tasks that run for the life of the node. `geoip-downloader` and the monitor tasks are
 * always "running"; counting them as work in flight would bury the one search that is.
 */
export const PERPETUAL = /geoip-downloader|cluster:monitor\/tasks\/lists|health-node|persistent/i;

/**
 * How many tasks are in flight: the `_cat/tasks` rows the Nodes page already holds, less the
 * perpetual ones. null when the listing is not an array — not read, or refused.
 */
export function activeTaskCount(tasks) {
  if (!Array.isArray(tasks)) return null;
  return tasks.filter((t) => !PERPETUAL.test(`${(t && t.action) || ''} ${(t && t.type) || ''}`)).length;
}

/* ----------------------------------- readings ----------------------------------- */

/** The counters one reading sums, and where each sits in a node's `_nodes/stats` entry. */
const COUNTERS = {
  query: (n) => n.indices && n.indices.search && n.indices.search.query_total,
  queryMs: (n) => n.indices && n.indices.search && n.indices.search.query_time_in_millis,
  index: (n) => n.indices && n.indices.indexing && n.indices.indexing.index_total,
  deletes: (n) => n.indices && n.indices.indexing && n.indices.indexing.delete_total,
  searchRejected: (n) => n.thread_pool && n.thread_pool.search && n.thread_pool.search.rejected,
  writeRejected: (n) => n.thread_pool && n.thread_pool.write && n.thread_pool.write.rejected,
  searchQueue: (n) => n.thread_pool && n.thread_pool.search && n.thread_pool.search.queue,
  writeQueue: (n) => n.thread_pool && n.thread_pool.write && n.thread_pool.write.queue,
  trips: (n) => {
    const b = n.breakers;
    if (!b || typeof b !== 'object') return undefined;
    let sum = 0, any = false;
    for (const x of Object.values(b)) {
      const t = x && Number(x.tripped);
      if (Number.isFinite(t)) { sum += t; any = true; }
    }
    return any ? sum : undefined;
  },
};

/**
 * One `_nodes/stats` answer as a reading: every counter summed over the nodes, `at` when it
 * was read. A counter no node reported is null (unknown is not zero). null when the answer
 * is not a nodes answer at all.
 */
export function readingOf(answer, at = Date.now()) {
  if (!answer || typeof answer !== 'object' || !answer.nodes || typeof answer.nodes !== 'object') return null;
  const out = { at: Number(at) };
  for (const [key, pick] of Object.entries(COUNTERS)) {
    let sum = 0, any = false;
    for (const n of Object.values(answer.nodes)) {
      if (!n || typeof n !== 'object') continue;
      const v = Number(pick(n));
      if (Number.isFinite(v)) { sum += v; any = true; }
    }
    out[key] = any ? sum : null;
  }
  return out;
}

/** The result shape when there is nothing to divide yet. Queues come from the latest reading. */
function unmeasured(latest) {
  return {
    measured: false, sinceMs: null,
    searchPerSec: null, searchLatencyMs: null, indexPerSec: null, deletesPerSec: null,
    rejected: null, breakerTrips: null,
    searchQueue: latest ? latest.searchQueue : null,
    writeQueue: latest ? latest.writeQueue : null,
  };
}

/** b − a for one counter: null when either side is unknown or the counter went backwards. */
function delta(a, b, key) {
  if (a[key] === null || b[key] === null || a[key] === undefined || b[key] === undefined) return null;
  const d = b[key] - a[key];
  return d < 0 ? null : d;
}

/**
 * The rates between two readings, `a` the older and `b` the newer (`readingOf`). Not a
 * measurement until the readings are at least a second apart. Per field: null when either
 * reading lacks the counter or it went backwards; the latency is the search time over the
 * searches between the readings, and null when there were none (no searches, no latency —
 * not 0 ms). `rejected` and `breakerTrips` are counts between the two readings.
 */
export function ratesBetween(a, b) {
  if (!a || !b) return unmeasured(b || a || null);
  const sec = (b.at - a.at) / 1000;
  if (!(sec >= 1)) return unmeasured(b);
  const dq = delta(a, b, 'query'), dqMs = delta(a, b, 'queryMs');
  const di = delta(a, b, 'index'), dd = delta(a, b, 'deletes');
  const rs = delta(a, b, 'searchRejected'), rw = delta(a, b, 'writeRejected');
  const trips = delta(a, b, 'trips');
  return {
    measured: true,
    sinceMs: b.at - a.at,
    searchPerSec: dq === null ? null : dq / sec,
    searchLatencyMs: dq === null || dqMs === null ? null : dq > 0 ? dqMs / dq : null,
    indexPerSec: di === null ? null : di / sec,
    deletesPerSec: dd === null ? null : dd / sec,
    rejected: rs === null && rw === null ? null : (rs || 0) + (rw || 0),
    breakerTrips: trips,
    searchQueue: b.searchQueue,
    writeQueue: b.writeQueue,
  };
}

/* --------------------------------- the data layer --------------------------------- */

/** cluster id → the last two readings, oldest first. */
const readings = new Map();

/**
 * Keep one `_nodes/stats` answer for `clusterId`, read at `at`. Only the two most recent
 * readings are kept; a reading older than the one already held is ignored (answers can land
 * out of order). Returns the reading, or null when the answer was not one.
 */
export function recordReading(clusterId, answer, at = Date.now()) {
  const r = readingOf(answer, at);
  if (!r) return null;
  const kept = readings.get(clusterId) || [];
  if (kept.length && r.at <= kept[kept.length - 1].at) return r;
  readings.set(clusterId, [...kept, r].slice(-2));
  return r;
}

/** Drop what is held for a cluster (it was removed, or its counters are known to have reset). */
export function forgetReadings(clusterId) { readings.delete(clusterId); }

/** When the latest reading of a cluster was taken (ms), or 0 when there is none. */
export function latestReadingAt(clusterId) {
  const kept = readings.get(clusterId);
  return kept && kept.length ? kept[kept.length - 1].at : 0;
}

/** How many readings are held for a cluster (0, 1 or 2) — two make a measurement. */
export function readingCount(clusterId) { return (readings.get(clusterId) || []).length; }

/**
 * The query pressure of one cluster, from its two most recent readings, plus the tasks in
 * flight from the shard dataset the page already holds (state.shards `tasks`; null when not
 * read). `measured: false` with null rates until two readings exist.
 */
export function nodeRates(clusterId) {
  const kept = readings.get(clusterId) || [];
  const rates = ratesBetween(kept.length > 1 ? kept[0] : null, kept[kept.length - 1] || null);
  const got = state.shards.get(clusterId);
  return { ...rates, activeTasks: activeTaskCount(got && got.tasks) };
}
