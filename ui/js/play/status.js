/**
 * A cluster's status line on Play, composed once from existing pieces (docs/PLAY.md, "Fleet
 * wall"): the health word (core/state.js healthState), the worst reason (the fullest node
 * past its high watermark, from core/disk-balance.js diskBalance, else the open alert of
 * highest severity) and where — "Red · disk 91 % on es-hot-03".
 *
 * Also the spotlight's "critical problem" test, here beside it, because both read the same
 * pieces and must agree about what is wrong with a cluster.
 */

import { healthState } from '../core/state.js';
import { diskBalance } from '../core/disk-balance.js';
import { unreachableReason } from '../core/alert-groups.js';
import { ilmErrorsOf } from '../core/lifecycle-errors.js';
import { slmExempt } from '../core/cluster-kind.js';
import { backedUpWithin } from './snapshots.js';

export const HEALTH_WORD = { green: 'Green', yellow: 'Yellow', red: 'Red', unreachable: 'Not answering', loading: 'No data' };
/** Worst first: a tile's place on the wall. */
const HEALTH_RANK = { unreachable: 50, red: 40, yellow: 20, loading: 10, green: 0 };
const LEVEL_RANK = { critical: 2, warning: 1 };

/** The fullest data node against the cluster's watermarks, or null when the disk was not read. */
export function fullestOf(d) {
  if (!d || !d.disk) return null;
  const b = diskBalance(d, d.clusterSettings);
  const n = b.fullest || b.nodes[0] || null;
  if (!n) return null;
  return { name: n.name, pct: n.pct, low: b.watermarks.low, high: b.watermarks.high, nodes: b.nodes };
}

/** The open alert to name: highest severity, then the oldest. */
export function worstAlert(open) {
  return [...(open || [])].sort((a, b) => (LEVEL_RANK[b.level] || 0) - (LEVEL_RANK[a.level] || 0) || a.since - b.since)[0] || null;
}

/**
 * `{state, word, reason, where, line, tone, rank, fullest, left}` for one cluster.
 * `open` are the cluster's open merged alerts; `nodes` its PLAY_STATE node entry (or null).
 */
export function clusterStatus(c, d, { open = [], nodes = null, client = null } = {}) {
  const st = healthState(d);
  const word = HEALTH_WORD[st] || st;
  const fullest = st === 'unreachable' || st === 'loading' ? null : fullestOf(d);
  const left = nodes && Array.isArray(nodes.left) ? nodes.left : [];
  let reason = '', where = '';
  if (st === 'unreachable') {
    reason = unreachableReason(client).label.toLowerCase();
  } else if (st !== 'loading') {
    const top = worstAlert(open);
    if (fullest && fullest.pct >= fullest.high) {
      reason = `disk ${Math.round(fullest.pct)} %`; where = fullest.name;
    } else if (left.length) {
      reason = `${left.length === 1 ? 'node' : `${left.length} nodes`} left`; where = left.map((x) => x.node).join(', ');
    } else if (top) {
      reason = top.family === 'health' ? `${(d.health && d.health.unassigned_shards) || 0} unassigned shards` : String(top.title || '');
      const it = top.items && top.items[0];
      where = it && it.label && it.label !== c.name ? it.label : '';
    } else if (st === 'red' || st === 'yellow') {
      reason = `${(d.health && d.health.unassigned_shards) || 0} unassigned shards`;
    }
  }
  const line = [word, reason ? `${reason}${where ? ` on ${where}` : ''}` : ''].filter(Boolean).join(' · ');
  const crit = open.filter((a) => a.level === 'critical').length;
  const tone = st === 'unreachable' || st === 'red' || crit || (fullest && fullest.pct >= fullest.high) ? 'red'
    : st === 'yellow' || open.length || left.length || (fullest && fullest.pct >= fullest.low) ? 'yellow'
      : st === 'loading' ? 'grey' : 'green';
  const rank = (HEALTH_RANK[st] || 0) + (left.length ? 30 : 0) + crit * 3 + (open.length - crit)
    + (fullest && fullest.pct >= fullest.high ? 25 : 0);
  return { state: st, word, reason, where, line, tone, rank, fullest, left };
}

/** The spotlight's tests, by the name Config › Play ticks them under (docs/PLAY.md). */
export const SPOTLIGHT_TESTS = ['red', 'nodeLeft', 'slmFailed', 'storage', 'unreachable', 'criticalAlert', 'ilmError', 'yellow'];
export const SPOTLIGHT_WHY = {
  red: 'red health', nodeLeft: 'node left', slmFailed: 'no good backup', storage: 'disk past high watermark',
  unreachable: 'not answering', criticalAlert: 'critical alert', ilmError: 'ILM error', yellow: 'yellow health',
};

/**
 * Why this cluster is in the spotlight now, as the names of the tests that hold — only the
 * ones `when` turns on. `staleMs` is "no good snapshot within" (snapshotStaleHours, 26 h).
 */
export function spotlightReasons(c, d, { open = [], nodes = null, when = [], staleMs, now, logPattern } = {}) {
  const on = new Set(when);
  const st = healthState(d);
  const out = [];
  if (on.has('unreachable') && st === 'unreachable') out.push('unreachable');
  if (st === 'unreachable' || st === 'loading') return out;
  if (on.has('red') && st === 'red') out.push('red');
  if (on.has('yellow') && st === 'yellow') out.push('yellow');
  if (on.has('nodeLeft') && nodes && Array.isArray(nodes.left) && nodes.left.length) out.push('nodeLeft');
  if (on.has('storage')) {
    const f = fullestOf(d);
    if (f && f.nodes.some((n) => n.pct >= f.high)) out.push('storage');
  }
  if (on.has('slmFailed') && !slmExempt(c)) {
    const failed = open.some((a) => a.family === 'slm-fail');
    if (failed || backedUpWithin(d, staleMs, now) === false) out.push('slmFailed');
  }
  if (on.has('criticalAlert') && open.some((a) => a.level === 'critical')) out.push('criticalAlert');
  if (on.has('ilmError') && ilmErrorsOf(d, logPattern).count) out.push('ilmError');
  return out;
}
