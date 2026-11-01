/**
 * Held alerts: what was wrong with a cluster when it was last reachable.
 *
 * A cluster that cannot be reached is one problem (alert-groups.js holdUnreachable). Its
 * other alerts are HELD under its unreachable line — dimmed, "not current", counted nowhere.
 * That list used to be nearly always empty: the moment a cluster stopped answering,
 * alerts() stopped evaluating its rules, so only an alert raised by something outside the
 * per-cluster rules (an automation) was ever held.
 *
 * Now the same rules are evaluated for a down cluster against its newest CACHED datasets —
 * the fleet cache's last good answers (the core keeps them, with their own fetchedAt, when a
 * fetch fails), or, without the fleet cache, the last data this page read while the cluster
 * answered. Nothing is fetched: the cluster is down. Each result carries `asOf`, the time of
 * the data it was computed from, and is only ever shown as held.
 *
 * Unknown is not zero: a rule whose dataset was never read, or was read longer ago than
 * HELD_MAX_AGE_MS, shows nothing — not "clear", nothing. A rule with no dataset this page can
 * date (a field-volume spike from the Indices page) is not evaluated for a down cluster.
 *
 * Pure: state.js supplies the cached data and the dataset times; tools/unit covers this.
 */

import { RULE_READS } from './alert-tuning.js';

/**
 * The oldest reading a held alert may be computed from. The fleet cache keeps its last good
 * answers indefinitely (and on disk across restarts), so the limit is a decision, not the
 * cache's: a day. Past it, what a cluster said says too little about it to list — the
 * snapshot and SLM rules themselves look back about a day (snapshotStaleHours, 26 h).
 */
export const HELD_MAX_AGE_HOURS = 24;
export const HELD_MAX_AGE_MS = HELD_MAX_AGE_HOURS * 3600 * 1000;

/**
 * The background datasets a held evaluation reads from the fleet cache — every one RULE_READS
 * names except `indices`, which is the page's own on-demand list (state.indices) and is dated
 * by its own fetch (state.js heldSource).
 */
export const HELD_DATASETS = [...new Set(Object.values(RULE_READS).flat())].filter((n) => n !== 'indices');

const familyOf = (a) => String((a && a.key) || '').split(':')[1] || '';

/**
 * When the data a rule read was fetched — the OLDEST of everything it reads (RULE_READS) —
 * or null when any of it is not known. `at` is {dataset: ms}; `delayAt` the time of the last
 * log-delay measurement.
 */
export function readingTime(family, at = {}, delayAt = null) {
  if (family === 'log-delay') return Number.isFinite(delayAt) && delayAt > 0 ? delayAt : null;
  const reads = RULE_READS[family];
  if (!reads) return null;
  const ts = reads.map((ds) => Number(at[ds]));
  return ts.every((t) => Number.isFinite(t) && t > 0) ? Math.min(...ts) : null;
}

/**
 * The moment the rules are evaluated at: the newest reading — when the cluster was last read.
 * A rule about how long ago something happened ("no successful snapshot in 26 h") is then
 * about the cluster as it was, not about how long it has been down since.
 */
export function evaluatedAt(at = {}) {
  const ts = Object.values(at).map(Number).filter((t) => Number.isFinite(t) && t > 0);
  return ts.length ? Math.max(...ts) : null;
}

/**
 * The alerts raised from cached data that may be held: each stamped with `asOf` (the time of
 * the data it rests on) and `cached: true`; a rule whose data is unknown or older than
 * `maxAgeMs` is left out.
 */
export function stampHeld(list, { at = {}, delayAt = null, now = Date.now(), maxAgeMs = HELD_MAX_AGE_MS } = {}) {
  const out = [];
  for (const a of list || []) {
    const t = readingTime(familyOf(a), at, delayAt);
    if (t === null || now - t > maxAgeMs) continue;
    out.push({ ...a, cached: true, asOf: t });
  }
  return out;
}

/** The oldest data among held alerts — what the unreachable line says they are "as of". */
export function oldestAsOf(held) {
  const ts = (held || []).map((m) => m && m.asOf).filter((t) => Number.isFinite(t) && t > 0);
  return ts.length ? Math.min(...ts) : null;
}
