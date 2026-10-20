/**
 * New alerts, announced as they appear.
 *
 * The Alerts page is where alerts are read; nothing makes you look at it. A cluster can
 * go red while you are in the REST console and the only sign is a number on a tab. This
 * puts the first sighting of an alert in front of whoever is using the app, once.
 *
 * One notification per cluster, not one per alert: a disk filling raises disk, health and
 * ILM within a refresh or two of each other, and those arrive as "<cluster>: 3 new alerts"
 * with a line each, and links to that cluster's alerts and to the page for its worst one.
 * Alerts raised for a cluster within BURST_WINDOW_MS of its first join the same entry.
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

import { openAlertsNow, clusters, mergedAlerts, invalidateAlerts } from './state.js';
import { isOpen, toObservations } from './alert-groups.js';
import { alertHistory } from './alert-history.js';
import { gotoFor, openGoto, openClusterAlerts } from './alert-goto.js';
import { pageLabel } from './page-labels.js';
import { toast, setNotificationActions } from '../ui/menu.js';

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

/** Beyond this many clusters at once, one line saying how many beats a wall of them. */
const MAX_INDIVIDUAL = 3;
const MS_CRITICAL = 9000;
const MS_WARNING = 5000;

/**
 * Alerts raised for the same cluster within this long of the first are ONE notification.
 * A disk filling raises disk, health and ILM within a refresh or two of each other; three
 * bell entries and three toasts about one cluster read as three problems.
 */
export const BURST_WINDOW_MS = 2 * 60000;

/**
 * Clusters' open bursts: cluster id → { start, key, alerts: Map<mergedKey, alert> }. A burst
 * is open for BURST_WINDOW_MS from its first alert; alerts that first appear in that time
 * join it (same bell key, so the entry is updated in place rather than added to).
 */
let bursts = new Map();

/** One line about an alert in a notice; for an existing alert that gained members, what is new on it. */
function alertLine(m, fresh) {
  const all = !fresh || fresh.size >= m.keys.length;
  if (all) return `${m.title}${m.count ? ` ${m.count}` : ''}`;
  const names = m.items.filter((i) => fresh.has(i.alertKey)).map((i) => i.label);
  return `${m.title}: ${fresh.size} new — ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
}

/**
 * The notification for one burst: "<cluster>: N new alerts", one line per alert.
 * The key carries the cluster and when the burst began, so a burst is one bell entry for
 * life and a later burst on the same cluster is another.
 */
export function burstNotice(b, clusterName) {
  const list = [...b.alerts.values()];
  const crit = list.filter((m) => m.level === 'critical').length;
  return {
    message: `${clusterName}: ${list.length} new alert${list.length === 1 ? '' : 's'}`,
    kind: crit ? 'err' : 'warn',
    detail: list.map((m) => alertLine(m, b.fresh && b.fresh.get(m.key))),
    key: b.key,
    cluster: b.clusterId,
    critical: crit,
  };
}

/**
 * Add this pass's new alerts to the open bursts, starting one per cluster where none is open.
 * `freshKeys` (optional): merged key → the member alert keys that are new on it.
 */
export function groupIntoBursts(fresh, now, open = bursts, freshKeys = null) {
  for (const [id, b] of open) if (now - b.start > BURST_WINDOW_MS) open.delete(id);
  const touched = new Set();
  for (const m of fresh) {
    let b = open.get(m.clusterId);
    if (!b) {
      b = { start: now, key: `alerts:${m.clusterId}:${now}`, clusterId: m.clusterId, alerts: new Map(), fresh: new Map() };
      open.set(m.clusterId, b);
    }
    b.alerts.set(m.key, m);
    if (freshKeys && freshKeys.has(m.key)) {
      const set = b.fresh.get(m.key) || new Set();
      freshKeys.get(m.key).forEach((k) => set.add(k));
      b.fresh.set(m.key, set);
    }
    touched.add(m.clusterId);
  }
  return [...touched].map((id) => open.get(id));
}

/**
 * Compare the current alerts with the last pass and announce what is new — one notification
 * per cluster per burst, not one per alert.
 *
 * "New" is a raised alert (core/state.js alerts(), one per policy, repository, field value…)
 * that was not there before, as it always was; the notice is about the merged alert it joins
 * (core/alert-groups.js), so a second broken repository on a cluster that already has one
 * says "1 new", not nothing and not a second entry.
 * @returns {Array} the merged alerts announced, for tests and callers that want to know.
 */
export function announceNewAlerts({ notify = toast, now = Date.now(), list = null } = {}) {
  let open;
  try {
    // Every merged alert, recorded for age and history; the open ones are what is news.
    const all = list || mergedAlerts({ fresh: true });
    try {
      if (alertHistory.observe(toObservations(all), now)) invalidateAlerts();
    } catch (_) { /* the log is a convenience; never let it stop a notice */ }
    open = all.filter((m) => isOpen(m));
  } catch (_) { return []; }          // a notifier must never break a refresh

  const keys = new Set(open.flatMap((m) => m.keys));
  if (seen === null) { seen = new Map([...keys].map((k) => [k, 0])); return []; }

  const freshKeys = new Map();
  for (const m of open) {
    const fresh = m.keys.filter((k) => !seen.has(k));
    if (fresh.length) freshKeys.set(m.key, new Set(fresh));
  }
  const fresh = open.filter((m) => freshKeys.has(m.key));
  // Present now: remembered with a clean slate. Absent: counted, and dropped past the grace.
  const next = new Map([...keys].map((k) => [k, 0]));
  for (const [k, gone] of seen) {
    if (!keys.has(k) && gone + 1 <= GRACE_PASSES) next.set(k, gone + 1);
  }
  seen = next;
  if (!fresh.length) { for (const [id, b] of bursts) if (now - b.start > BURST_WINDOW_MS) bursts.delete(id); return []; }

  const touched = groupIntoBursts(fresh, now, bursts, freshKeys);
  const nameOf = (id) => ((clusters().find((c) => c.id === id)) || {}).name || id;
  const notices = touched.map((b) => burstNotice(b, nameOf(b.clusterId)));
  // Critical clusters first: if only some of them get a card, they should be those.
  notices.sort((a, b) => b.critical - a.critical);

  const opts = (n) => ({ key: n.key, detail: n.detail, cluster: n.cluster });
  if (notices.length <= MAX_INDIVIDUAL) {
    for (const n of notices) notify(n.message, n.kind, n.critical ? MS_CRITICAL : MS_WARNING, opts(n));
  } else {
    // Every cluster still gets its own bell entry; the screen gets one line.
    for (const n of notices) notify(n.message, n.kind, 0, { ...opts(n), bellOnly: true });
    const total = notices.reduce((s2, n) => s2 + n.detail.length, 0);
    const crit = notices.reduce((s2, n) => s2 + n.critical, 0);
    notify(`${total} new alerts on ${notices.length} clusters${crit ? `, ${crit} critical` : ''}`,
      crit ? 'err' : 'warn', MS_CRITICAL, { key: 'alerts-batch', noHistory: true,
        detail: ['Each cluster has its own entry in the bell.'] });
  }
  return fresh;
}

/**
 * The links under a bell entry for a burst of alerts: the cluster's alerts, and the page that
 * answers its worst one. Resolved when the bell opens, from what is open then — an alert
 * that has cleared since has no page to send you to, and the entry just says what it said.
 */
export function burstActions(entry) {
  const key = String((entry && entry.key) || '');
  if (!key.startsWith('alerts:')) return [];
  const id = entry.cluster || key.split(':')[1];
  if (!id) return [];
  const name = ((clusters().find((c) => c.id === id)) || {}).name || id;
  const out = [{ label: `Open ${name} alerts →`, page: 'alerts', run: () => openClusterAlerts(id) }];
  let worst = null;
  try {
    worst = openAlertsNow().filter((m) => m.clusterId === id)
      .sort((a, b) => (b.level === 'critical') - (a.level === 'critical') || a.since - b.since)[0] || null;
  } catch (_) { /* nothing to point at */ }
  if (worst) {
    const g = gotoFor(worst);
    if (g.page) out.push({ label: `Go to ${pageLabel(g.page)}`, page: g.page, run: () => openGoto(g) });
  }
  return out;
}
setNotificationActions(burstActions);

/** Forget what has been announced — after a config change, the fleet is a different one. */
export function resetAnnounced() { seen = null; bursts = new Map(); }

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
