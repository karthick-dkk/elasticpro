/**
 * What the expanded Clusters row (overview.js `detail`) is drawn from, as plain data — pure,
 * so the page and tools/unit/cluster-boxes.test.mjs read ONE definition of each figure:
 *
 * - (disk levels are NOT defined here: the Size cell, the Disk usage cell and the nodes table all
 *   ask core/disk-balance.js diskAgainstWatermarks, the cluster's own watermarks);
 * - a node's free size and whether it is a data node;
 * - which indices the Cluster health button lists (red cluster: red ones; yellow: yellow),
 *   their unassigned shards and the reason ElasticPro can honestly give for each;
 * - the donut segments of the Shard allocation and ILM cards and their pills;
 * - the Backups (SLM) card: which policy, its last run, or why there is nothing to show.
 *
 * Unknown is not zero: every function answers null / `known: false` when the cluster did not
 * say, and the page writes what would fix it.
 */

import { shardAllocation, nodeTier, TIERS } from './cluster-detail.js';
import { ilmCoverage, ilmErrorsOf, slmCoverage, logsOf } from './lifecycle-errors.js';

/* ----------------------------------- disks ----------------------------------- */

const fin = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * What is left on a node's disk, in bytes: `disk.total − disk.used` from `_cat/nodes`, else
 * its `disk.avail`; null when the node reported neither (unknown, not 0 B).
 */
export function nodeFreeBytes(n) {
  const total = fin(n && n['disk.total']), used = fin(n && n['disk.used']);
  if (isFinite(total) && isFinite(used) && total > 0) return Math.max(0, total - used);
  const avail = fin(n && n['disk.avail']);
  return isFinite(avail) ? Math.max(0, avail) : null;
}

/** A node that holds shards: the plain `data` role or any `data_*` tier / content role. */
export const isDataNode = (roles) => (roles || []).some((r) => r === 'data' || String(r).startsWith('data_'));

/**
 * The Nodes header's summary line from each node's role list: "6 · 3 master-eligible · 3 data
 * (2 hot, 1 warm) · ★ elected master". The tier breakdown is left out when no data node has a
 * tier role; the star clause only when a master was elected.
 */
export function nodesSummary(roleLists, hasElected) {
  const n = roleLists.length;
  const data = roleLists.filter(isDataNode);
  const tiers = TIERS.map((t) => [t, data.filter((r) => nodeTier(r) === t).length]).filter(([, k]) => k > 0);
  return [String(n), `${roleLists.filter((r) => r.includes('master')).length} master-eligible`,
    `${data.length} data${tiers.length ? ` (${tiers.map(([t, k]) => `${k} ${t}`).join(', ')})` : ''}`,
    hasElected ? '★ elected master' : null].filter(Boolean).join(' · ');
}

/* ---------------------------------- role chips ---------------------------------- */

/**
 * The chips a node's roles take in one table line. Every data role (`data`, `data_hot`,
 * `data_content`, …) is ONE plain `data` chip — no tier chip, no "data: hot·warm·…" label
 * (owner, 2026-11-07); which tiers it holds is in that chip's `title`. At most `max` chips are
 * drawn and the rest are counted ("+3"), their names in `more`. Coordinating-only (no roles)
 * is its own chip.
 * → { chips: [{ label, kind, roles, title }], more: [role names] }
 */
export function roleChips(roles, max = 3) {
  const list = roles || [];
  if (!list.length) return { chips: [{ label: 'coordinating', kind: 'other', roles: [], title: null }], more: [] };
  const dataRoles = list.filter((r) => r === 'data' || String(r).startsWith('data_'));
  const tiers = dataRoles.filter((r) => r !== 'data').map((r) => r.slice(5));
  const chips = [];
  let placed = false;
  for (const r of list) {
    if (dataRoles.includes(r)) {
      if (placed) continue;
      placed = true;
      chips.push({ label: 'data', kind: 'other', roles: dataRoles,
        title: tiers.length ? `Data tiers: ${tiers.join(', ')}${dataRoles.includes('data') ? ' (and the generic data role)' : ''}` : 'data (every tier)' });
    } else chips.push({ label: r, kind: null, roles: [r], title: null });
  }
  const shown = chips.slice(0, max), rest = chips.slice(max);
  return { chips: shown, more: rest.flatMap((c) => c.roles) };
}

/* ------------------------------- cluster health -------------------------------- */

/**
 * The indices the Cluster health button lists: the red ones when the cluster is red, the
 * yellow ones when yellow; null when green (or unknown) — there is nothing to open then.
 * `rows` is a `_cat/indices` answer ({ index, health, pri, rep }). → { health, rows } | null
 */
export function problemIndices(status, rows) {
  const s = String(status || '').toLowerCase();
  if (s !== 'red' && s !== 'yellow') return null;
  const list = (Array.isArray(rows) ? rows : []).filter((r) => String(r.health || '').toLowerCase() === s)
    .map((r) => ({ index: r.index, health: s, pri: fin(r.pri), rep: fin(r.rep) }))
    .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
  return { health: s, rows: list };
}

/** "2 yellow indices", "1 red index". */
export const problemButtonText = (health, n) => `${n} ${health} ${n === 1 ? 'index' : 'indices'}`;

/**
 * Unassigned shards per index from a `_cat/shards` answer
 * ({ index, shard, prirep, state, 'unassigned.reason' }), for the indices in `only` (an iterable of
 * names; all when omitted). → Map(index → { primaries, replicas, codes })
 */
export function unassignedByIndex(shards, only) {
  const out = new Map();
  const keep = only ? new Set(only) : null;
  for (const s of Array.isArray(shards) ? shards : []) {
    if (String(s.state || '').toUpperCase() !== 'UNASSIGNED') continue;
    if (keep && !keep.has(s.index)) continue;
    const e = out.get(s.index) || { primaries: 0, replicas: 0, codes: [] };
    if (s.prirep === 'p') e.primaries += 1; else e.replicas += 1;
    const code = String(s['unassigned.reason'] || '').toUpperCase();
    if (code && !e.codes.includes(code)) e.codes.push(code);
    out.set(s.index, e);
  }
  return out;
}

/** "1 replica", "2 replicas", "1 primary, 1 replica"; null when none are unassigned. */
export function unassignedText(u) {
  if (!u) return null;
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
  return [part(u.primaries, 'primary', 'primaries'), part(u.replicas, 'replica', 'replicas')].filter(Boolean).join(', ') || null;
}

/** Elasticsearch's `unassigned.reason` codes in words. */
const REASON_WORDS = {
  INDEX_CREATED: 'index just created', CLUSTER_RECOVERED: 'cluster recovered', INDEX_REOPENED: 'index reopened',
  DANGLING_INDEX_IMPORTED: 'dangling index imported', NEW_INDEX_RESTORED: 'restoring a snapshot', EXISTING_INDEX_RESTORED: 'restoring a snapshot',
  REPLICA_ADDED: 'replica added', ALLOCATION_FAILED: 'allocation failed', NODE_LEFT: 'a node left the cluster',
  REROUTE_CANCELLED: 'reroute cancelled', REINITIALIZED: 'shard re-initialised', REALLOCATED_REPLICA: 'replica being moved',
  PRIMARY_FAILED: 'primary failed', FORCED_EMPTY_PRIMARY: 'primary forced empty', MANUAL_ALLOCATION: 'manual allocation',
};
export const reasonWords = (code) => REASON_WORDS[String(code || '').toUpperCase()] || String(code || '').toLowerCase().replace(/_/g, ' ');

/**
 * One line from an allocation-explain answer: the first node that said NO and the decider's own
 * sentence, else the answer's overall explanation. → { index, text } | null (nothing to say).
 * `GET _cluster/allocation/explain` with no body explains ONE unassigned shard (the first the
 * cluster finds); the core refuses the POST that would pick the shard (guard.rs is_read), so
 * a per-index explanation is not available to a read-only session.
 */
export function explainLine(res) {
  if (!res || typeof res !== 'object' || !res.index) return null;
  let text = '';
  for (const nd of res.node_allocation_decisions || []) {
    const no = (nd.deciders || []).find((x) => String(x.decision).toUpperCase() === 'NO');
    if (no && no.explanation) { text = `${nd.node_name ? `${nd.node_name}: ` : ''}${no.explanation}`; break; }
  }
  if (!text) text = String(res.allocate_explanation || res.can_allocate || (res.unassigned_info && res.unassigned_info.details) || '');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return { index: res.index, text: text.length > 160 ? `${text.slice(0, 157)}…` : text };
}

/**
 * The Reason cell of one listed index: the allocation-explain sentence when that explained
 * this index, else the `unassigned.reason` code in words, else null (unknown: the page says so).
 * → { text, source: 'allocation explain' | 'unassigned.reason' } | null
 */
export function reasonFor(index, unassigned, explained) {
  if (explained && explained.index === index) return { text: explained.text, source: 'allocation explain' };
  const u = unassigned && unassigned.get && unassigned.get(index);
  if (u && u.codes.length) return { text: u.codes.map(reasonWords).join(', '), source: 'unassigned.reason' };
  return null;
}

/* ---------------------------------- the donuts ---------------------------------- */

/**
 * Stroke segments for a donut drawn as circles of circumference 100 (r = 15.915):
 * [{ key, len, dash: 'len rest', offset }]. Zero parts are skipped; an empty total gives none
 * (the ring is drawn empty, not full).
 */
export function donutSegments(parts) {
  const total = (parts || []).reduce((s, p) => s + Math.max(0, p.n), 0);
  if (!total) return [];
  let cum = 0;
  const out = [];
  for (const p of parts) {
    if (!(p.n > 0)) continue;
    const len = (p.n / total) * 100;
    out.push({ key: p.key, len, dash: `${len.toFixed(2)} ${(100 - len).toFixed(2)}`, offset: -cum });
    cum += len;
  }
  return out;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The Shard allocation card from `_cluster/health`. → null when health was not read;
 * else { pill: { tone, text }, figure: '99.6%' | null, parts: [{ key, label, n }], total }.
 * Relocating is its own part, listed only when some shard is moving.
 */
export function shardCard(health) {
  const a = shardAllocation(health);
  if (!a) return null;
  let pill;
  if (a.unassigned > 0) pill = { tone: String(health.status) === 'red' ? 'red' : 'yellow', text: `${a.unassigned} unassigned` };
  else if (a.initializing > 0) pill = { tone: 'yellow', text: `${a.initializing} initializing` };
  else if (a.relocating > 0) pill = { tone: 'yellow', text: `${a.relocating} relocating` };
  else pill = { tone: 'green', text: 'Healthy' };
  const parts = [{ key: 'active', label: 'Active', n: a.active }, { key: 'init', label: 'Initializing', n: a.initializing }];
  if (a.relocating > 0) parts.splice(1, 0, { key: 'reloc', label: 'Relocating', n: a.relocating });
  parts.push({ key: 'unas', label: 'Unassigned', n: a.unassigned });
  return { pill, figure: a.pct === null ? null : `${a.pct.toFixed(1)}%`, parts, total: a.total };
}

/**
 * The ILM card for the cluster's log indices (`pattern`).
 * → { known: false, pill } when what each index has could not be read, else
 *   { known: true, pill, managed, total, parts, noPolicy: [names], errors: n, link: bool }.
 * `managed` counts every log index under a policy (as the board's "42/42 managed" does); the
 * donut splits those into without-error and in-error. The Indices link is only offered when
 * some log index has no policy and none is in error (the owner's call, 2026-11-05).
 */
export function ilmCard(d, pattern) {
  const mode = d && d.ilm && d.ilm.operation_mode;
  if (!mode) return { known: false, pill: { tone: 'grey', text: 'Unknown' }, why: 'ILM status has not been read.' };
  const running = String(mode).toUpperCase() === 'RUNNING';
  const cov = ilmCoverage(d, pattern);
  const errs = ilmErrorsOf(d, pattern);
  if (!cov.known) {
    return { known: false, pill: running ? { tone: 'grey', text: 'Running ?' } : { tone: 'red', text: 'Stopped' },
      why: `Which policy each ${logsOf(pattern)} index has could not be read (it needs view_index_metadata on ${logsOf(pattern)}).` };
  }
  const withoutError = Math.max(0, cov.managed - errs.count);
  const parts = [{ key: 'ok', label: 'Managed', n: withoutError }, { key: 'err', label: 'ILM error', n: errs.count },
    { key: 'none', label: 'No policy', n: cov.unmanaged.length }];
  let pill;
  if (!running) pill = { tone: 'red', text: 'Stopped' };
  else if (errs.count) pill = { tone: 'yellow', text: plural(errs.count, 'error', 'errors') };
  else if (!cov.total) pill = { tone: 'red', text: 'No log index' };
  else if (cov.unmanaged.length) pill = { tone: 'red', text: 'Logs not covered' };
  else pill = { tone: 'green', text: 'Healthy' };
  return { known: true, pill, managed: cov.managed, total: cov.total, parts, noPolicy: cov.unmanaged, errors: errs.count,
    link: cov.unmanaged.length > 0 && errs.count === 0 };
}

/* --------------------------------- Backups (SLM) --------------------------------- */

/**
 * The newest run among the given SLM policies: { policy, status: 'Success'|'Failed'|null, at }.
 * A policy that never ran gives status null (and the first policy's name).
 */
export function lastSlmRun(slm, ids) {
  let best = null;
  for (const p of slm || []) {
    if (!p || !ids.includes(p.id)) continue;
    for (const [status, rec] of [['Success', p.last_success], ['Failed', p.last_failure]]) {
      const at = rec && Number(rec.time);
      if (isFinite(at) && at > 0 && (!best || at > best.at)) best = { policy: p.id, status, at };
    }
  }
  return best || { policy: ids[0] || null, status: null, at: null };
}

/**
 * The Backups (SLM) card. `view` is `lifecycleView('SLM', …)` — the one definition the
 * summary's SLM cell reads, so the card and the cell cannot disagree about "Not used".
 * → { kind, pill: { tone, text }, ... }:
 *   unused  — ULM archives the logs: grey, { note: bucket text }
 *   unknown — SLM status not read / not supported: { why }
 *   stopped — SLM is not RUNNING
 *   none    — running, but no scheduled policy takes the log pattern: { logs }
 *   ok      — { policy, status, at } of the policy that takes the pattern (its newest run)
 *   unread  — running, policies could not be read
 */
export function slmCard(d, view, pattern, ulm) {
  const logs = logsOf(pattern);
  if (view && view.word === 'Not used') {
    return { kind: 'unused', pill: { tone: 'grey', text: 'Not used' },
      note: ulm && ulm.bucket ? `Logs archived by ULM to ${ulm.bucket}` : 'Logs archived by ULM', bucket: (ulm && ulm.bucket) || '' };
  }
  if (!d || !d.slmStatus) {
    return { kind: 'unknown', pill: { tone: 'grey', text: d && d.slmSupported === false ? 'n/a' : 'Unknown' },
      why: d && d.slmSupported === false ? 'This cluster does not support SLM.' : 'SLM status has not been read.' };
  }
  const mode = d.slmStatus.operation_mode;
  const word = String(mode || '').charAt(0).toUpperCase() + String(mode || '').slice(1).toLowerCase();
  if (String(mode || '').toUpperCase() !== 'RUNNING') return { kind: 'stopped', pill: { tone: 'red', text: `SLM ${word}` } };
  const pill = { tone: 'green', text: 'SLM Running' };
  const cov = slmCoverage(d, pattern);
  if (!cov.known) return { kind: 'unread', pill: { tone: 'grey', text: 'SLM Running ?' } };
  if (!cov.ok) return { kind: 'none', pill, logs };
  return { kind: 'ok', pill, ...lastSlmRun(d.slm, cov.policies), others: cov.policies.length - 1 };
}
