/**
 * When a problem opened, the browser's half (docs/PLAY.md "Since when"): what this display tells
 * the server is open, and of which problems it is sure — it was reading the data they come from
 * all along, so one that appears has just opened. Pure: play.js owns the state and the clock.
 */

import { RULE_READS } from '../core/alert-tuning.js';

/** How long a dataset must have been read without a break before what it shows first is new. */
export const SURE_MS = 10 * 60000;
/** A dataset not read for longer than this has had a break (the server's own gap rule, play/mod.rs). */
export const GAP_MS = 3 * 60000;

/** The datasets a problem comes from; a rule not listed there (the operator's own) may read any of `all`. */
export const readsOf = (family, all) => (family === 'unreachable' ? [] : RULE_READS[family] || (family === 'log-delay' ? ['log-delay'] : all));

/** `<alert key>|<level>`: a problem that got worse opened anew at its new level. */
export const openKey = (p) => `${p.key}|${p.level}`;

/**
 * Since when each dataset of each cluster has been read without a break, one look later: `since`
 * is a Map `<cluster> <dataset>` → `{from, last}` (ms), changed in place. `isRead(clusterId,
 * dataset)` says whether it is read and not stale now; not read for over GAP_MS is a break, and
 * it starts again.
 */
export function noteReads(since, clusterIds, datasets, isRead, now) {
  for (const id of clusterIds) {
    for (const ds of datasets) {
      const k = `${id} ${ds}`;
      const cur = since.get(k);
      if (isRead(id, ds)) {
        if (cur && now - cur.last <= GAP_MS) cur.last = now;
        else since.set(k, { from: now, last: now });
      } else if (cur && now - cur.last > GAP_MS) since.delete(k);
    }
  }
}

/** Whether `<cluster> <dataset>` has been read without a break for SURE_MS, and is read now. */
const readLong = (since, k, now) => {
  const r = since.get(k);
  return !!r && now - r.last <= GAP_MS && now - r.from >= SURE_MS;
};

/**
 * `{open, sure}` for PLAY_STATE: every Critical and High problem on the display, acknowledged,
 * silenced and held ones too (they are still open), and the facts Fleet shows with no alert.
 * `alerts` are merged alerts, `status` the Map of clusterStatus(), `since` noteReads()' map.
 */
export function openReport(alerts, status, since, datasets, now) {
  const open = new Set(), sure = new Set();
  const add = (clusterId, p) => {
    if (p.level !== 'critical' && p.level !== 'high') return;
    open.add(openKey(p));
    if (readsOf(p.family, datasets).every((ds) => readLong(since, `${clusterId} ${ds}`, now))) sure.add(openKey(p));
  };
  for (const m of alerts) add(m.clusterId, m);
  for (const [id, s] of status) for (const p of s.problems) if (!p.alert && !p.since) add(id, p);
  return { open: [...open], sure: [...sure] };
}

/** The alert's own start, when the members at its level say since when they have been failing. */
export function ownStart(m) {
  const at = (m.members || []).filter((x) => x.level === m.level && x.failingSince > 0).map((x) => x.failingSince);
  return at.length ? Math.min(...at) : null;
}
