/**
 * What the Nodes & shards page decides before it draws anything — pure, so the rules are
 * tested on their own (tools/unit/nodes-shards.test.mjs) and defined once for every caller
 * (pages/shards.js draws them; nothing else computes these figures).
 *
 *   - how a shard population splits (assigned / moving / unassigned);
 *   - which indices are hidden (a name starting with ".") and when they are shown anyway;
 *   - the one set of thresholds a node's usage bars are coloured by, and how a load
 *     average becomes a bar: load over the node's processors, or no bar at all.
 */

/* --------------------------------- shards --------------------------------- */

/** The states in which a shard is assigned but not settled. */
const MOVING = new Set(['RELOCATING', 'INITIALIZING']);

/**
 * One population divided. `rows` are normalised shards (state upper-case); the counts add up
 * to `total` only when every state is one of the three — a shard in some other state is in
 * the total and in none of the parts, which is what the bar then shows as a gap.
 */
export function shardSplit(rows) {
  const out = { started: 0, moving: 0, unassigned: 0, total: 0 };
  for (const x of rows || []) {
    const st = String(x.state || '').toUpperCase();
    out.total++;
    if (st === 'STARTED') out.started++;
    else if (MOVING.has(st)) out.moving++;
    else if (st === 'UNASSIGNED') out.unassigned++;
  }
  return out;
}

/**
 * How many shards each node holds, by node name, from the shard rows (the listing is the truth;
 * `_cat/allocation`'s count is the fallback when the listing was refused). Unassigned shards
 * have no node and are not counted here.
 */
export function shardsPerNode(rows) {
  const out = new Map();
  for (const x of rows || []) if (x && x.node) out.set(x.node, (out.get(x.node) || 0) + 1);
  return out;
}

/**
 * The unassigned shards by the reason Elasticsearch recorded (`unassigned.reason`), most
 * frequent first; a shard with no reason is counted under "not recorded".
 */
export function unassignedByReason(rows) {
  const out = new Map();
  for (const x of rows || []) {
    if (String((x && x.state) || '').toUpperCase() !== 'UNASSIGNED') continue;
    const r = (x.reason || '').trim() || 'not recorded';
    out.set(r, (out.get(r) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count }));
}

/** The values `cluster.routing.allocation.enable` takes, in the order the menu offers them. */
export const ALLOCATION_VALUES = Object.freeze(['all', 'primaries', 'new_primaries', 'none']);

/** What each value means, in the words the confirm dialog uses — the consequence, not the name. */
export const ALLOCATION_MEANING = Object.freeze({
  all: 'every shard may be placed and moved — the normal state',
  primaries: 'only primary shards are placed; replicas stay where they are or unassigned',
  new_primaries: 'only the primaries of newly created indices are placed; nothing else moves',
  none: 'no shard will be placed or moved until it is switched back',
});

/**
 * `cluster.routing.allocation.enable` out of `GET _cluster/settings?include_defaults=true`:
 * a transient setting over a persistent one over the default. `{value, source}` with source
 * 'transient' | 'persistent' | 'default', or null when the answer carries none of the three —
 * "not known", never a guess.
 */
export function allocationSetting(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const KEY = 'cluster.routing.allocation.enable';
  const pick = (block) => {
    if (!block || typeof block !== 'object') return undefined;
    if (typeof block[KEY] === 'string') return block[KEY];                     // flat_settings
    const v = block.cluster && block.cluster.routing && block.cluster.routing.allocation && block.cluster.routing.allocation.enable;
    return typeof v === 'string' ? v : undefined;
  };
  for (const source of ['transient', 'persistent', 'defaults']) {
    const v = pick(answer[source]);
    if (v !== undefined) return { value: v.toLowerCase(), source: source === 'defaults' ? 'default' : source };
  }
  return null;
}

/**
 * The search and write pools' queue sizes out of `GET _nodes/_all/os,thread_pool` (the same call
 * that brings the processor counts): `{search: {size, nodes}, write: {size, nodes}}` where `size`
 * is the one size every node reported, or null when they differ or none did, and `nodes` how
 * many reported one. -1 (unbounded) is kept as -1.
 */
export function queueSizes(answer) {
  const out = {};
  const nodes = answer && answer.nodes && typeof answer.nodes === 'object' ? Object.values(answer.nodes) : [];
  for (const pool of ['search', 'write']) {
    const seen = new Set(); let n = 0;
    for (const node of nodes) {
      const v = node && node.thread_pool && node.thread_pool[pool] ? node.thread_pool[pool].queue_size : undefined;
      const num = typeof v === 'string' ? Number(v.replace(/k$/i, '000')) : Number(v);
      if (v !== undefined && v !== null && Number.isFinite(num)) { seen.add(num); n++; }
    }
    out[pool] = { size: seen.size === 1 ? [...seen][0] : null, nodes: n };
  }
  return out;
}

/** A node id as the table shows it: the first eight characters; the whole id is the tooltip. */
export function shortNodeId(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) : s;
}

/** Elasticsearch's own convention: an index whose name starts with "." is hidden/system. */
export function isHiddenIndex(name) {
  return String(name || '').startsWith('.');
}

/**
 * Whether hidden indices belong in the table: the box is ticked, or the name filter itself
 * starts with "." — typing ".kibana" is asking for them, whatever the box says.
 */
export function wantsHidden(showHidden, indexFilter) {
  return !!showHidden || String(indexFilter || '').trim().startsWith('.');
}

/**
 * The shard rows the table works from, and how many were kept out of it because their
 * index is hidden — the head says so, so nothing disappears silently.
 */
export function visibleShards(rows, showHidden, indexFilter) {
  const all = rows || [];
  if (wantsHidden(showHidden, indexFilter)) return { rows: all, hidden: 0 };
  const kept = all.filter((s) => !isHiddenIndex(s.index));
  return { rows: kept, hidden: all.length - kept.length };
}

/* ---------------------------------- nodes ---------------------------------- */

/**
 * Where a usage figure turns amber, then red, in per cent. `heap` is where the JVM starts
 * collecting hard (the thresholds the heap cell has always used); `disk` is the shape of
 * Elasticsearch's own watermarks and is what RAM, CPU and load are read against too, there
 * being no Elasticsearch-defined line for those.
 */
export const USAGE_THRESHOLDS = Object.freeze({
  heap: Object.freeze({ warn: 75, crit: 85 }),
  disk: Object.freeze({ warn: 80, crit: 90 }),
});

/** A figure _cat left blank, or nothing at all: not a number, and never 0 (Number('') is). */
const blank = (v) => v === '' || v === null || v === undefined || (typeof v === 'string' && !v.trim());

/** 'ok' | 'warn' | 'crit' for a percentage, or null when it is not a number (unknown is not zero). */
export function usageLevel(p, kind = 'disk') {
  const n = blank(p) ? NaN : Number(p);
  if (!Number.isFinite(n)) return null;
  const t = USAGE_THRESHOLDS[kind] || USAGE_THRESHOLDS.disk;
  return n >= t.crit ? 'crit' : n >= t.warn ? 'warn' : 'ok';
}

/**
 * A load average as a percentage of the node's processors, capped at 100 — a load of 2.0
 * on 4 cores is half busy. null when either figure is not known: a bar drawn against a
 * guessed core count would be a measurement nobody took.
 */
export function loadPercent(load, cores) {
  const l = blank(load) ? NaN : Number(load), c = blank(cores) ? NaN : Number(cores);
  if (!Number.isFinite(l) || l < 0 || !Number.isFinite(c) || c <= 0) return null;
  return Math.min(100, (l / c) * 100);
}

/**
 * Each node's processor count by node name, from `GET _nodes/_all/os` (`os.allocated_processors`,
 * what Elasticsearch sizes its thread pools by). A node that did not report one is absent.
 */
export function coresByNode(answer) {
  const out = new Map();
  const nodes = answer && answer.nodes && typeof answer.nodes === 'object' ? answer.nodes : {};
  for (const n of Object.values(nodes)) {
    const cores = n && n.os ? Number(n.os.allocated_processors) : NaN;
    if (n && n.name && Number.isFinite(cores) && cores > 0) out.set(n.name, cores);
  }
  return out;
}
