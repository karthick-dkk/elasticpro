/**
 * New alerts, announced as they appear.
 *
 * The Alerts page is where alerts are read; nothing makes you look at it. A cluster can
 * go red while you are in the REST console and the only sign is a number on a tab. This
 * puts the first sighting of an alert in front of whoever is using the app, once.
 *
 * Three rules keep it from becoming noise, which is how a notifier stops working:
 *
 * The first pass after start-up announces nothing. Everything already wrong when you open
 * the app is a state, not news, and eleven toasts on launch teaches people to dismiss
 * them without reading.
 *
 * An alert is announced once. `alerts()` is recomputed from scratch every refresh, so the
 * same red cluster reappears in the list every thirty seconds — it is announced on the
 * refresh it first appears in and then only again if it clears for good and comes back.
 *
 * Acknowledged alerts are never announced. Acknowledging is how somebody says they have
 * seen it; repeating it back to them is the opposite of what that means.
 */

import { alerts } from './state.js';
import { isAcked } from './acks.js';
import { toast } from '../ui/menu.js';

/**
 * Alert key → passes it has been absent. null until the first pass, which establishes
 * what was already true rather than what is new.
 */
let seen = null;

/**
 * An alert that vanishes is forgotten only after being gone this many passes in a row.
 * A cluster that fails one refresh and answers the next (a busy node, a tunnel redialling)
 * made "unreachable" appear, clear and appear again, and each reappearance was announced
 * as new. Real recovery lasts longer than two passes; a blip does not.
 */
const GRACE_PASSES = 2;

/** Beyond this many at once, one line saying how many beats a wall of them. */
const MAX_INDIVIDUAL = 3;
const MS_CRITICAL = 9000;
const MS_WARNING = 5000;

/**
 * Compare the current alerts with the last pass and announce what is new.
 * @returns {Array} the alerts announced, for tests and callers that want to know.
 */
export function announceNewAlerts({ notify = toast } = {}) {
  let open;
  try { open = alerts().filter((a) => !isAcked(a.key)); }
  catch (_) { return []; }          // a notifier must never break a refresh

  const keys = new Set(open.map((a) => a.key));
  if (seen === null) { seen = new Map([...keys].map((k) => [k, 0])); return []; }

  const fresh = open.filter((a) => !seen.has(a.key));
  // Present now: remembered with a clean slate. Absent: counted, and dropped past the grace.
  const next = new Map([...keys].map((k) => [k, 0]));
  for (const [k, gone] of seen) {
    if (!keys.has(k) && gone + 1 <= GRACE_PASSES) next.set(k, gone + 1);
  }
  seen = next;
  if (!fresh.length) return [];

  // Critical first: if only some of them get their own line, they should be those.
  const ordered = [...fresh].sort((a, b) =>
    (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));

  // Keyed by the alert, so the same one coming back after a real clear updates its toast
  // and its bell entry instead of stacking a second copy of both.
  if (ordered.length <= MAX_INDIVIDUAL) {
    for (const a of ordered) {
      notify(a.title, a.level === 'critical' ? 'err' : 'warn',
        a.level === 'critical' ? MS_CRITICAL : MS_WARNING, { key: `alert:${a.key}` });
    }
  } else {
    const crit = ordered.filter((a) => a.level === 'critical').length;
    notify(`${ordered.length} new alerts${crit ? `, ${crit} critical` : ''}`,
      crit ? 'err' : 'warn', MS_CRITICAL, { key: 'alerts-batch' });
  }
  return ordered;
}

/** Forget what has been announced — after a config change, the fleet is a different one. */
export function resetAnnounced() { seen = null; }

/* --------------------------- snapshots finishing --------------------------- */

/**
 * A snapshot that was running and now is not.
 *
 * Creating a snapshot returns as soon as the cluster accepts it — the copy happens
 * afterwards, and can take minutes on a large index and still come back PARTIAL or
 * FAILED. Until now the only way to learn how it went was to be looking at the Snapshots
 * page when it landed, which for anything slow means not learning at all.
 *
 * One rule does the work: only a transition *out of* a running state is announced. That
 * gives the rest for free — the first pass says nothing, because nothing was seen
 * running before it; a snapshot already SUCCESS when the app opened says nothing, for
 * the same reason; and each outcome is announced once, because the state is recorded
 * immediately after.
 *
 * There was an explicit first-pass guard here as well. A mutation test removed it and
 * every test still passed, which was correct: the transition rule had already made it
 * unreachable. A second mechanism that cannot be observed is not caution, it is
 * something for a later reader to wonder about.
 */

/** What each snapshot's state was last time. Empty until the first pass. */
let seenSnapshots = new Map();

/** The states Elasticsearch uses for a snapshot that is still being written. */
const RUNNING = new Set(['IN_PROGRESS', 'STARTED']);

/**
 * @param byCluster [{ cluster, snapshots: [{ repo, id, status }] }]
 * @returns the transitions announced, for tests
 */
export function announceSnapshotOutcomes(byCluster, { notify = toast } = {}) {
  const now = new Map();
  for (const { cluster, snapshots } of byCluster || []) {
    for (const s of snapshots || []) {
      now.set(`${cluster.id}|${s.repo}|${s.id}`, { cluster, ...s });
    }
  }

  const done = [];
  for (const [key, cur] of now) {
    const was = seenSnapshots.get(key);
    if (!RUNNING.has(String(was || '').toUpperCase())) continue;
    const status = String(cur.status || '').toUpperCase();
    if (RUNNING.has(status)) continue;
    done.push(cur);
  }
  seenSnapshots = new Map([...now].map(([k, v]) => [k, v.status]));

  for (const s of done) {
    const status = String(s.status || '').toUpperCase();
    const where = `${s.id} in ${s.repo} on ${s.cluster.name}`;
    // Keyed by the snapshot: one outcome per snapshot, so a repeat (a listing that flaps
    // between states) updates its line instead of adding another to the bell.
    const opts = { key: `snapshot:${s.cluster.id}|${s.repo}|${s.id}` };
    if (status === 'SUCCESS') notify(`Snapshot finished — ${where}`, 'ok', 6000, opts);
    else if (status === 'PARTIAL') {
      // PARTIAL is the one people misread as success. It is a snapshot with shards
      // missing, which is not something to restore from without knowing which.
      notify(`Snapshot finished PARTIAL — ${where}. Some shards are not in it.`, 'err', 10000, opts);
    } else notify(`Snapshot ${status || 'failed'} — ${where}`, 'err', 10000, opts);
  }
  return done;
}

/** Tests only: forget what was seen, so the next pass is a first pass again. */
export function resetSnapshotMemory() { seenSnapshots = new Map(); }
