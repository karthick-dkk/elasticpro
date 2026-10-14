/**
 * Alert tuning: what `alerts()` found, made fit to be read on a fleet of a hundred clusters.
 *
 * `alerts()` stays one description of what is true — every rule raises what it sees. This
 * stage decides what is shown and counted, and only ever by removing a row that repeats
 * another or by saying more about one; it never hides the only signal of a problem.
 * Measured on a live 32-cluster fleet: 88 open alerts, most of them the same faults seen
 * by two or three rules at once.
 *
 *  1. One disk problem, one row. A node at the flood stage was raised by the node-level
 *     balance rule (critical) and by the cluster-average disk rule; the average is folded
 *     into the node-level row, which is the more precise of the two.
 *  2. Unassigned shards once. The balance rule also fired on "N shards unassigned", which
 *     the health rule already says; dropped when that is all the balance rule had to say.
 *  3. A failing backup once. A repository that is failing or stale was raised again per
 *     SLM policy writing to it (last run failed / no recent success); and SLM switched off
 *     raised "no recent success" for every policy, which is its consequence, not news.
 *  4. Many field-volume spikes on one cluster are one row with the count.
 *  5. A value read long ago says so. A row built from data older than its dataset's
 *     staleness limit keeps its level — a disk at 95% three hours ago is not fine now —
 *     and its detail says how old the reading is.
 *
 * Plus `diskLevel`, the disk rule's hysteresis: raised at the threshold, cleared only two
 * points below it, so a disk sitting at 79.9–80.0% stops opening and closing an alert on
 * every refresh. And `openAlerts` / `alertCounts`, the one definition of "open" (neither
 * acknowledged nor silenced) and of how many are critical — the Clusters page, the nav
 * badge and the top bar all said "open" while counting acknowledged ones.
 */

/** Points below a threshold before a raised disk alert clears. */
export const DISK_HYSTERESIS = 2;

/**
 * The disk rule's level for `pct`, given the level it was raised at last time (`prev`:
 * 'critical' | 'warning' | null). Pure, so the flapping case is testable.
 */
export function diskLevel(pct, prev, warn, crit, band = DISK_HYSTERESIS) {
  if (!Number.isFinite(pct)) return null;
  if (pct >= crit || (prev === 'critical' && pct >= crit - band)) return 'critical';
  if (pct >= warn || (prev && pct >= warn - band)) return 'warning';
  return null;
}

const familyOf = (a) => String(a.key || '').split(':')[1] || '';
const clusterOf = (a) => (a.cluster && a.cluster.id) || String(a.key || '').split(':')[0];

/** Which fleet dataset each rule reads from, for the staleness note. */
export const RULE_DATASET = {
  health: 'health', disk: 'nodes', 'disk-balance': 'nodes', 'disk-unaccounted': 'nodes',
  capacity: 'nodes', 'no-master': 'nodes', 'master-changed': 'nodes',
  ilm: 'ilm_errors', 'slm-mode': 'policies', 'slm-fail': 'policies', 'slm-stale': 'policies', repo: 'snapshots',
};

/**
 * @param {Array} list  what alerts() raised
 * @param {object} ctx
 *   ageOf(clusterId, dataset) → { ageMs, staleAfterMs } | null   (fleet mode; null = unknown/direct)
 *   ago(ms) → "3 h"                                              (wording for the staleness note)
 */
export function tuneAlerts(list, ctx = {}) {
  const byCluster = new Map();
  for (const a of list) {
    const id = clusterOf(a);
    if (!byCluster.has(id)) byCluster.set(id, []);
    byCluster.get(id).push(a);
  }
  const out = [];
  for (const [, rows] of byCluster) {
    const fam = (f) => rows.filter((a) => familyOf(a) === f);
    const drop = new Set();
    // 1. the node-level flood/high-watermark row carries the cluster average
    const bal = fam('disk-balance')[0];
    const disk = fam('disk')[0];
    if (bal && disk && (bal.balanceCauses || []).some((c) => c === 'flood' || c === 'high')) {
      drop.add(disk);
      bal.level = bal.level === 'critical' || disk.level === 'critical' ? 'critical' : 'warning';
      bal.detail = `${bal.detail}  Cluster average ${disk.diskPercent != null ? `${disk.diskPercent.toFixed(1)}%` : 'above its threshold'}.`;
    }
    // 2. unassigned shards: the health row says it
    if (bal && fam('health').length && (bal.balanceCauses || []).length && bal.balanceCauses.every((c) => c === 'unassigned')) drop.add(bal);
    // 3. a failing or stale repository, once; SLM stopped, once
    const repoBad = new Set(fam('repo').filter((a) => /:(failing|stale)$/.test(a.key)).map((a) => a.repo));
    const slmStopped = fam('slm-mode').length > 0;
    for (const a of [...fam('slm-fail'), ...fam('slm-stale')]) {
      if (a.repo && repoBad.has(a.repo)) drop.add(a);
      else if (slmStopped && familyOf(a) === 'slm-stale') drop.add(a);
    }
    // 4. field-volume spikes: one row per cluster
    const spikes = fam('volume');
    if (spikes.length > 1) {
      for (const s of spikes) drop.add(s);
      const c = spikes[0].cluster;
      out.push({ key: `${clusterOf(spikes[0])}:volume`, level: 'warning', cluster: c,
        title: `${c ? c.name : clusterOf(spikes[0])}: ${spikes.length} field-volume spikes`,
        detail: spikes.slice(0, 3).map((s) => s.title.replace(/^[^:]*:\s*/, '')).join('; ') + (spikes.length > 3 ? `; +${spikes.length - 3} more` : ''),
        grouped: spikes.length });
    }
    for (const a of rows) if (!drop.has(a)) out.push(a);
  }
  // 5. say how old a reading is when it is older than its dataset allows
  if (ctx.ageOf) {
    for (const a of out) {
      const ds = RULE_DATASET[familyOf(a)];
      const f = ds ? ctx.ageOf(clusterOf(a), ds) : null;
      if (f && Number.isFinite(f.ageMs) && f.staleAfterMs && f.ageMs > f.staleAfterMs) {
        a.stale = true;
        a.detail = `${a.detail || ''} (Read ${ctx.ago ? ctx.ago(f.ageMs) : `${Math.round(f.ageMs / 60000)} min`} ago — the cluster has not been read since.)`.trim();
      }
    }
  }
  return out;
}

/** Neither acknowledged nor silenced: what "open" means everywhere a count is shown. */
export function openAlerts(list, { isAcked = () => false, isSilenced = () => false } = {}) {
  return (list || []).filter((a) => !isAcked(a.key) && !isSilenced(a));
}

/** The one count of alerts by level. */
export function alertCounts(list) {
  const total = (list || []).length;
  const critical = (list || []).filter((a) => a.level === 'critical').length;
  return { total, critical, warning: total - critical };
}
