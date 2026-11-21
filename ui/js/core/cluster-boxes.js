/**
 * Figures the Clusters › Overview cards and the Nodes & shards page read, as plain data — pure,
 * so the pages and tools/unit/cluster-boxes.test.mjs read ONE definition of each figure:
 *
 * - (disk levels are NOT defined here: the Size cell, the Disk usage cell and the nodes table all
 *   ask core/disk-balance.js diskAgainstWatermarks, the cluster's own watermarks);
 * - whether a node is a data node;
 * - the unassigned shards of each index and the reason ElasticPro can honestly give for each;
 * - the ILM card's pill and its figures;
 * - the Backups (SLM) card: which policy, its last run, or why there is nothing to show.
 *
 * Unknown is not zero: every function answers null / `known: false` when the cluster did not
 * say, and the page writes what would fix it.
 */

import { offText } from './collection.js';
import { ilmPolicyState, ilmErrorsOf, slmCoverage, logsOf, NOT_KNOWN } from './lifecycle-errors.js';

/* ----------------------------------- nodes ----------------------------------- */

/** A node that holds shards: the plain `data` role or any `data_*` tier / content role. */
export const isDataNode = (roles) => (roles || []).some((r) => r === 'data' || String(r).startsWith('data_'));

/* ------------------------------- cluster health -------------------------------- */

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

/** Elasticsearch's `unassigned.reason` codes in words. */
const REASON_WORDS = {
  INDEX_CREATED: 'index just created', CLUSTER_RECOVERED: 'cluster recovered', INDEX_REOPENED: 'index reopened',
  DANGLING_INDEX_IMPORTED: 'dangling index imported', NEW_INDEX_RESTORED: 'restoring a snapshot', EXISTING_INDEX_RESTORED: 'restoring a snapshot',
  REPLICA_ADDED: 'replica added', ALLOCATION_FAILED: 'allocation failed', NODE_LEFT: 'a node left the cluster',
  REROUTE_CANCELLED: 'reroute cancelled', REINITIALIZED: 'shard re-initialised', REALLOCATED_REPLICA: 'replica being moved',
  PRIMARY_FAILED: 'primary failed', FORCED_EMPTY_PRIMARY: 'primary forced empty', MANUAL_ALLOCATION: 'manual allocation',
};
export const reasonWords = (code) => REASON_WORDS[String(code || '').toUpperCase()] || String(code || '').toLowerCase().replace(/_/g, ' ');

/* ---------------------------------- the donuts ---------------------------------- */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The ILM card for the cluster's log indices (`pattern`). "Not known" and "No policy" come from
 * ONE definition, lifecycle-errors.js ilmPolicyState, which the summary's ILM cell reads too:
 * an answer that could not be read is never shown as "No policy" (unknown is not zero).
 * → { known: false, state: 'unknown', pill, headline: 'Not known', why } when ILM's mode or which
 *     policy each log index has could not be read, the latest ask failed, or no log index was
 *     listed (possibly a missing privilege) — `why` goes in a tooltip, not on the card;
 *   { known: true, state: 'none', pill: No policy (red), headline: 'No policy for <logs>', logs, … }
 *     when Elasticsearch confirms no open log index has a policy;
 *   { known: true, state, pill, managed, total, parts, noPolicy: [names], errors: n, link: bool } else.
 * `managed` counts every log index under a policy (as the board's "42/42 managed" does); the
 * donut splits those into without-error and in-error. The Indices link is only offered when
 * some log index has no policy and none is in error (the owner's call, 2026-11-05).
 */
export function ilmCard(d, pattern) {
  const notKnown = (why) => ({ tone: 'grey', text: NOT_KNOWN, title: why });
  // Switched off for the cluster (Edit cluster › Collection): never asked; the card says so and where.
  if (d && d.switchedOff && d.switchedOff.ilm) {
    const why = `${offText('ilm')}.`;
    return { known: false, state: 'off', pill: { tone: 'grey', text: 'Off', title: why }, headline: 'Switched off', why };
  }
  const mode = d && d.ilm && d.ilm.operation_mode;
  if (!mode) return { known: false, state: 'unknown', pill: notKnown('ILM status has not been read.'), headline: NOT_KNOWN, why: 'ILM status has not been read.' };
  const running = String(mode).toUpperCase() === 'RUNNING';
  const st = ilmPolicyState(d, pattern);
  const cov = st.cov;
  const errs = ilmErrorsOf(d, pattern);
  if (st.state === 'unknown') {
    const why = `${st.unread.charAt(0).toUpperCase()}${st.unread.slice(1)}.`;
    return { known: false, state: 'unknown', pill: running ? notKnown(why) : { tone: 'red', text: 'Stopped' }, headline: NOT_KNOWN, why };
  }
  const withoutError = Math.max(0, cov.managed - errs.count);
  const parts = [{ key: 'ok', label: 'Managed', n: withoutError }, { key: 'err', label: 'ILM error', n: errs.count },
    { key: 'none', label: 'No policy', n: cov.unmanaged.length }];
  let pill;
  if (!running) pill = { tone: 'red', text: 'Stopped' };
  else if (errs.count) pill = { tone: 'yellow', text: plural(errs.count, 'error', 'errors') };
  else if (st.state === 'none') pill = { tone: 'red', text: 'No policy' };
  else if (st.state === 'some') pill = { tone: 'red', text: 'Logs not covered' };
  else pill = { tone: 'green', text: 'Healthy' };
  const out = { known: true, state: st.state, pill, managed: cov.managed, total: cov.total, parts, noPolicy: cov.unmanaged, errors: errs.count,
    link: cov.unmanaged.length > 0 && errs.count === 0 };
  if (st.state === 'none') { out.logs = logsOf(pattern); out.headline = `No policy for ${out.logs}`; }
  return out;
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
    return { kind: 'unknown', pill: { tone: 'grey', text: d && d.slmSupported === false ? 'n/a' : NOT_KNOWN },
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
