/**
 * Clusters › Overview — one cluster on one screen (pages/cluster-overview.js draws it). What the
 * board is drawn from, as plain data: the route (`#/clusters/overview[/<cluster>]`), which node
 * is highest on each gauge, the shard figures, the order of the two tables, this cluster's open
 * alerts. Pure — no DOM, no state — so tools/unit/cluster-overview.test.mjs holds the rules and
 * the page, the shell and the tests read ONE definition of each.
 *
 * Unknown is not zero: a node that did not report a figure is left out of "highest", a cluster
 * whose node list was never read has no highest node at all (null, and the card says so), and a
 * figure `_cat` left blank is NaN, never 0.
 *
 * Thresholds are core/nodes-shards.js USAGE_THRESHOLDS (heap 75/85, disk and CPU 80/90) — the
 * same lines the Nodes & shards page colours its bars by.
 */

import { parseHash } from '../reports/route.js';
import { shardAllocation, nodeRoles } from './cluster-detail.js';
import { isDataNode, slmCard, ilmCard } from './cluster-boxes.js';
import { staleIndices } from './nodes-shards.js';
import { byLevel, worstOf } from './alert-levels.js';
import { lifecycleView, ilmErrorsOf, logPatternOf } from './lifecycle-errors.js';
import { sumKnown, notCounted } from './index-figures.js';
import { clusterKind } from './cluster-kind.js';
import { durationMs } from './snapshot-list.js';
import { bands, noDelayOf, LD_NEVER_MEASURED, LD_SCHEDULE_OFF, LD_NO_SCHEDULER } from './logdelay-report.js';

/* ------------------------------------ the route ------------------------------------ */

/** The Clusters page's path in the address (`#/clusters`; `#/overview` still opens it — reports/route.js PAGE_ALIAS). */
export const CLUSTERS_PATH = 'clusters';
/** The Overview section's id: `#/clusters/overview`, and the tab's and the menu sub-item's data-section. */
export const OVERVIEW = 'overview';
export const LIST = 'list';

/** 'overview' or 'list' from a hash of the Clusters page (`#/clusters/overview`, `#/overview/overview`, `#/clusters`, `#/overview`). */
export function clustersSection(hash) {
  const { page, rest } = parseHash(hash);
  if (page !== 'overview') return LIST;
  return rest.split('/')[0] === OVERVIEW ? OVERVIEW : LIST;
}

/** The cluster an Overview address names (`#/clusters/overview/<id>`), or null. */
export function overviewClusterOf(hash) {
  const { page, rest } = parseHash(hash);
  if (page !== 'overview') return null;
  const [section, id] = rest.split('/');
  if (section !== OVERVIEW || !id) return null;
  try { return decodeURIComponent(id); } catch (_) { return id; }
}

/** The Overview's address, for a cluster when one is named. */
export const overviewHash = (clusterId) => `#/${CLUSTERS_PATH}/${OVERVIEW}${clusterId ? `/${encodeURIComponent(clusterId)}` : ''}`;
/** The List's address. */
export const listHash = () => `#/${CLUSTERS_PATH}`;

/* ------------------------------------ figures ------------------------------------ */

/** A _cat figure as a number: blank, missing or non-numeric is NaN (never 0). */
export const fig = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

/**
 * The node with the highest `field` (a `_cat/nodes` percentage column: `cpu`, `heap.percent`,
 * `disk.used_percent`): { name, value, node }. Nodes that did not report the figure are left out;
 * null when none did, or when there is no node list.
 */
export function highestNode(nodes, field) {
  let best = null;
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const v = fig(n && n[field]);
    if (!Number.isFinite(v)) continue;
    if (!best || v > best.value) best = { name: n.name || '', value: v, node: n };
  }
  return best;
}

/** A node's heap: { percent, current, max } in bytes; a figure not reported is null. */
export function heapFigures(node) {
  const n = node || {};
  const p = fig(n['heap.percent']), cur = fig(n['heap.current']), max = fig(n['heap.max']);
  return { percent: Number.isFinite(p) ? p : null, current: Number.isFinite(cur) ? cur : null, max: Number.isFinite(max) ? max : null };
}

/**
 * The nodes, busiest first: by CPU (highest first, nodes that did not report it last), then by
 * heap, then A–Z. A copy; the list given is not reordered.
 */
export function busiestFirst(nodes) {
  const key = (n, f) => { const v = fig(n && n[f]); return Number.isFinite(v) ? v : -1; };
  return [...(Array.isArray(nodes) ? nodes : [])].sort((a, b) => key(b, 'cpu') - key(a, 'cpu')
    || key(b, 'heap.percent') - key(a, 'heap.percent') || String(a.name || '').localeCompare(String(b.name || '')));
}

/**
 * The Nodes card: how many, how many hold data, how many are master-eligible, which is the
 * elected master and how long it has been up (its `_cat/nodes` uptime, as the cluster said it).
 * null when the node list has not been read.
 */
export function nodeCounts(nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lists = nodes.map((n) => nodeRoles(n['node.role']));
  const master = nodes.find((n) => String(n.master || '').trim() === '*') || null;
  return {
    total: nodes.length,
    data: lists.filter(isDataNode).length,
    masterEligible: lists.filter((r) => r.includes('master')).length,
    masterName: master ? master.name || null : null,
    uptime: master && master.uptime ? String(master.uptime) : null,
  };
}

/**
 * The Shards card from `_cluster/health` (cluster-detail.js shardAllocation is the one reading of
 * it): primaries, the total, and the split into assigned / moving (relocating + initializing) /
 * unassigned, with the assigned share in per cent. null when health was not read.
 */
export function shardFigures(health) {
  const a = shardAllocation(health);
  if (!a) return null;
  const primary = fig(health.active_primary_shards);
  return {
    primary: Number.isFinite(primary) ? primary : null,
    total: a.total,
    assigned: a.active,
    moving: (a.relocating || 0) + (a.initializing || 0),
    unassigned: a.unassigned,
    pct: a.total > 0 ? (a.active / a.total) * 100 : null,
  };
}

/** "68 of 69 shards placed"; '' when the figures are not known. */
export function placedText(f) {
  if (!f || f.total === null || f.total === undefined) return '';
  return `${f.assigned} of ${f.total} shard${f.total === 1 ? '' : 's'} placed`;
}

/* ------------------------------------ indices ------------------------------------ */

const HEALTH_ORDER = { red: 0, yellow: 1, green: 2 };

/**
 * The indices, unhealthy first (red, then yellow, then green and unknown), then by size (largest
 * first), then A–Z. `rows` are state.indices entries (parseIndexName's shape). A copy.
 */
export function unhealthyFirst(rows) {
  const rank = (r) => HEALTH_ORDER[String(r.health || '').toLowerCase()] ?? 3;
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => rank(a) - rank(b) || (b.size || 0) - (a.size || 0)
    || String(a.index || '').localeCompare(String(b.index || '')));
}

/** How many indices are red, yellow and green, and how many in all. */
export function indexHealthCounts(rows) {
  const out = { red: 0, yellow: 0, green: 0, total: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    out.total++;
    const k = String(r.health || '').toLowerCase();
    if (k in out) out[k]++;
  }
  return out;
}

/**
 * Documents and store size over the listed indices: { docs, size, note }. `note` is what the two
 * figures do not hold (closed and red indices report none, hidden ones are not listed).
 */
export function indexTotals(rows) {
  const docs = sumKnown(rows, 'docs'), size = sumKnown(rows, 'size');
  return { docs: docs.sum, size: size.sum, note: notCounted(docs.missing >= size.missing ? docs : size) };
}

/** An index's shard count: primaries × (1 + replicas); null when the row has no primary count. */
export function indexShards(r) {
  const pri = fig(r && r.pri), rep = fig(r && r.rep);
  if (!Number.isFinite(pri) || pri <= 0) return null;
  return pri * (1 + (Number.isFinite(rep) ? rep : 0));
}

/* ------------------------------------ alerts ------------------------------------ */

/**
 * The open alerts for one cluster: how many, the worst level, and the titles of the two worst
 * (critical before high before warning). `alerts` is openAlertsNow()'s list.
 */
export function clusterAlerts(alerts, clusterId) {
  const mine = (Array.isArray(alerts) ? alerts : []).filter((a) => a && a.cluster && a.cluster.id === clusterId).sort(byLevel);
  return { count: mine.length, worst: mine.length ? worstOf(mine) : null, titles: mine.slice(0, 2).map((a) => a.title || '') };
}

/* ------------------------------------ rates ------------------------------------ */

/**
 * A rate for a card: `null` (not measured) is '–'; small rates keep one decimal, large ones are
 * whole with grouping — "0.3", "14.2", "1,840".
 */
export function rateText(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '–';
  const n = Number(v);
  if (n < 100) return n.toFixed(1).replace(/\.0$/, n < 10 ? '.0' : '');
  return Math.round(n).toLocaleString();
}

/* ------------------------------- devices and log delay ------------------------------- */

/**
 * The Devices & log delay card from one cluster's LOGDELAY_SUMMARY (`ldSummary({clusterIds: [id],
 * days: 1})` — the Log Delay Dashboard's own answer, read once per refresh): the devices in the
 * last scheduled run (the Dashboard's `devicesInLastRun`), how many of them are late by the
 * CONFIGURED levels (`totals.delay` in the delay band, `totals.critical` over the critical line —
 * the tiles' quantities), when the cluster was last measured and when the next run is due, and
 * the words for a measurement that is not there (the boards' own, one wording each).
 * → { state: 'ok'|'never'|'off'|'unsupported'|'error'|'none', message, inLastRun, delay, critical,
 *     late, bands, lastRunAt, nextDueAt }
 */
export function devicesDelay(res, clusterId) {
  const out = { state: 'none', message: null, inLastRun: null, delay: null, critical: null, late: null, bands: bands(null), lastRunAt: null, nextDueAt: null, noDelay: null };
  if (!res) return out;
  if (res.unsupported) return { ...out, state: 'unsupported', message: res.message || 'This server has no log delay report yet.' };
  if (res.ok === false) return { ...out, state: 'error', message: res.message || 'the log delay summary could not be read' };
  const sch = res.schedule || null;
  const mine = (res.byCluster || []).find((c) => c && c.id === clusterId) || null;
  const lv = (mine && mine.levels) || null;
  out.bands = bands(lv);
  out.lastRunAt = mine && Number.isFinite(mine.lastRunAt) ? mine.lastRunAt : null;
  out.nextDueAt = sch && sch.state && Number.isFinite(sch.state.nextDueAt) ? sch.state.nextDueAt : null;
  if (!sch || sch.supported === false) return { ...out, state: 'unsupported', message: LD_NO_SCHEDULER };
  if (out.lastRunAt === null) return { ...out, state: 'never', message: LD_NEVER_MEASURED };
  const t = res.totals || {};
  const n = (v) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
  out.inLastRun = n(res.devicesInLastRun);
  out.delay = n(t.delay);
  out.critical = n(t.critical);
  // The Log Delay page's No delay (one definition), and why there is no percentage.
  out.noDelay = noDelayOf(t, { why: (mine && mine.notMeasured) || '' });
  out.late = out.delay === null && out.critical === null ? null : (out.delay || 0) + (out.critical || 0);
  out.state = sch.enabled === false ? 'off' : 'ok';
  out.message = sch.enabled === false ? LD_SCHEDULE_OFF : null;
  return out;
}

/* ------------------------------- long-running searches ------------------------------- */

/** A search is long-running from here (the owner: "more than 1 min"). */
export const LONG_SEARCH_MS = 60000;

/**
 * The searches running longer than `minMs`, longest first, from the `_cat/tasks?detailed` rows
 * the Tasks panel reads (core/es.js tasks(): action, node, running_time_ns, description):
 * [{ description, node, ms }]. null when the rows are not a list — not read, or refused — so
 * the card says "not readable" rather than "none".
 */
export function longRunningSearches(rows, { minMs = LONG_SEARCH_MS } = {}) {
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const t of rows) {
    if (!t || !/search/i.test(String(t.action || ''))) continue;
    const ns = fig(t.running_time_ns);
    const ms = Number.isFinite(ns) ? ns / 1e6 : durationMs(t.running_time);
    if (ms === null || !(ms > minMs)) continue;
    out.push({ description: String(t.description || '').replace(/\s+/g, ' ').trim(), node: String(t.node || ''), ms });
  }
  return out.sort((a, b) => b.ms - a.ms);
}

/* ------------------------------------ SLM and ILM ------------------------------------ */

/** The operation pill of SLM or ILM: { tone, word } — 'running' green, anything else red, not read grey. */
export function operationPill(mode) {
  if (!mode) return { tone: 'grey', word: 'not read' };
  const m = String(mode).toLowerCase();
  return { tone: m === 'running' ? 'green' : 'red', word: m };
}

/**
 * The SLM card's one line, from what the Clusters page's expanded row already has (cluster-boxes.js
 * slmCard — the one definition of "no policy" / "not used" / "not known"): the operation pill, the
 * policy that takes the log indices, and its last run — result, when, how long, how many indices
 * (the snapshot's own figures from the listing the app holds; null where it has none).
 * → { pill, kind, policy, status: 'Success'|'Failed'|null, at, durationMs, indices, why, note }
 */
export function slmSummary(d, c, defaults) {
  const pattern = logPatternOf(c, defaults);
  const view = lifecycleView('SLM', d, pattern, c);
  const card = slmCard(d, view, pattern, clusterKind(c).ulm);
  const out = { pill: operationPill(d && d.slmStatus && d.slmStatus.operation_mode), kind: card.kind, policy: card.policy || null,
    status: card.status || null, headline: card.headline || null, takes: card.takes || null, part: !!card.part, failed: card.failed || [],
    at: card.at || null, durationMs: null, indices: null, why: card.why || null, note: card.note || null };
  if (card.kind === 'unused') out.pill = { tone: 'grey', word: 'not used' };
  if (card.kind !== 'ok' || !out.policy) return out;
  const p = (d.slm || []).find((x) => x.id === out.policy);
  const run = p && (out.status === 'Failed' ? p.last_failure : p.last_success);
  const name = run && run.snapshot_name;
  if (name) {
    for (const list of Object.values((d && d.snapshots) || {})) {
      const s = (list || []).find((x) => x.id === name);
      if (s) { out.durationMs = durationMs(s.duration); out.indices = Number.isFinite(Number(s.indices)) ? Number(s.indices) : null; break; }
    }
  }
  return out;
}

/**
 * The ILM card's one line (cluster-boxes.js ilmCard and lifecycle-errors.js ilmErrorsOf are the
 * definitions; nodes-shards.js staleIndices the past-retention figure): the operation pill, how
 * many log indices are managed, how many are past the cluster's retention and their size, how
 * many are in an ILM error step.
 * → { pill, known, state, managed, total, stale: { count, bytes, policy }, errors, errorsKnown, why }
 */
export function ilmSummary(d, c, defaults, indices, now = Date.now()) {
  const pattern = logPatternOf(c, defaults);
  const card = ilmCard(d, pattern);
  const errs = ilmErrorsOf(d, pattern);
  const st = staleIndices(c && c.liveRetention, indices, now);
  return {
    pill: operationPill(d && d.ilm && d.ilm.operation_mode),
    known: card.known, state: card.state,
    managed: card.known ? card.managed : null, total: card.known ? card.total : null,
    stale: { count: st.list.length, bytes: st.bytes, policy: st.policy, known: Array.isArray(indices) && !!st.policy },
    errors: errs.known ? errs.count : null, errorsKnown: errs.known,
    why: card.why || null,
  };
}
