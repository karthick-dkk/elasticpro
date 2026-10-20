/**
 * "Related" on an alert: what else started around it, and whether it has happened before.
 *
 * Nothing here is inferred by a model or guessed from wording. Two facts feed it, both
 * ElasticPro's own: when each open alert started (core/alert-history.js, what this browser
 * saw) and the acknowledgements and notes people left (core/acks.js). The rules are below,
 * deterministic, and short enough to read.
 *
 * "Probably caused by this" is shown ONLY when all three hold:
 *   1. the two alerts are on the same cluster;
 *   2. the other alert's rule is listed in CAUSES as a known consequence of this one's;
 *   3. the other alert started after this one, and no more than WINDOW_MS later;
 *   4. both start times are known: an alert first seen when the page opened (`approxSince`)
 *      may have started long before, so two alerts first seen together say nothing about
 *      which came first.
 * The mirror image — an earlier alert whose rule is a known cause of this one — is marked
 * "a known cause of this alert". Anything else in the window is listed in time order with
 * no relation claimed. With no start time recorded for an alert, it is left out rather
 * than placed at a guessed time.
 */

import { ageShort } from './alert-groups.js';

/** Related alerts are those that started within this long before or after this one. */
export const WINDOW_MS = 60 * 60000;

/**
 * [cause rule, consequence rule, why] — the one table. Each pair is a consequence the
 * product documents: a node past the high watermark takes no shards (so replicas stay
 * unassigned), a full node refuses the shards a rollover needs, a failing repository is why
 * scheduled snapshots stop completing, and so on.
 */
export const CAUSES = [
  ['disk', 'health', 'a node past the high watermark takes no new shards, so replicas stay unassigned'],
  ['disk-balance', 'health', 'a node past the high watermark takes no new shards, so replicas stay unassigned'],
  ['disk', 'ilm', 'a full node refuses the shards a rollover or shrink needs, so the lifecycle step fails'],
  ['disk-balance', 'ilm', 'a full node refuses the shards a rollover or shrink needs, so the lifecycle step fails'],
  ['capacity', 'disk', 'the storage got smaller, so the same data is a larger share of it'],
  ['capacity', 'disk-balance', 'the storage got smaller, so the same data is a larger share of it'],
  ['no-master', 'health', 'without a master no shard can be allocated'],
  ['master-changed', 'health', 'shards are reallocated while a new master takes over'],
  ['repo', 'slm-fail', 'a policy cannot succeed while its repository is failing'],
  ['repo', 'slm-stale', 'no snapshot completes while its repository is failing'],
  ['slm-mode', 'slm-stale', 'stopped SLM takes no scheduled snapshots'],
];

/** Whether `cause` is a documented cause of `effect`. */
export function isKnownCause(cause, effect) {
  return CAUSES.some(([c, e]) => c === cause && e === effect);
}

const stamp = (ms, now) => {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const same = new Date(now).toDateString() === d.toDateString();
  return same ? hm : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${hm}`;
};

/**
 * The timeline: this alert and every other alert on the cluster that started within the
 * window, in time order.
 *
 * @param m        the merged alert
 * @param siblings the merged alerts on the same cluster (any state), `m` may be among them
 * @returns {Array<{ at:number, when:string, key:string, self:boolean, alert:object,
 *                   relation:null|'caused-by-this'|'cause-of-this', deltaText:string, why:string }>}
 */
export function relatedFor(m, siblings, now = Date.now()) {
  const rows = [{ at: m.since, key: m.key, self: true, alert: m, relation: null, deltaText: '', why: '' }];
  for (const s of siblings || []) {
    if (s.key === m.key || s.clusterId !== m.clusterId || !Number.isFinite(s.since)) continue;
    const delta = s.since - m.since;
    if (Math.abs(delta) > WINDOW_MS) continue;
    let relation = null, why = '';
    const known = !m.approxSince && !s.approxSince && delta !== 0;
    if (!known) { /* order unknown or simultaneous: listed, no relation claimed */ }
    else if (delta > 0) {
      const hit = CAUSES.find(([c, e]) => c === m.family && e === s.family);
      if (hit) { relation = 'caused-by-this'; why = hit[2]; }
    } else {
      const hit = CAUSES.find(([c, e]) => c === s.family && e === m.family);
      if (hit) { relation = 'cause-of-this'; why = hit[2]; }
    }
    rows.push({ at: s.since, key: s.key, self: false, alert: s, relation, why,
      deltaText: !known && (m.approxSince || s.approxSince) ? 'first seen at about the same time; the order is not known'
        : delta === 0 ? 'at the same time' : `${ageShort(Math.abs(delta))} ${delta > 0 ? 'later' : 'earlier'}` });
  }
  rows.sort((a, b) => a.at - b.at || (a.self ? -1 : 0) - (b.self ? -1 : 0) || a.key.localeCompare(b.key));
  return rows.map((r) => ({ ...r, when: stamp(r.at, now) }));
}

/**
 * Past occurrences of this alert on this cluster.
 *
 * @param m         the merged alert
 * @param episodes  closed episodes of m.key within retention, newest first (alertHistory.episodes)
 * @param notes     note records `[{ key, notes:[{text,by,ts}] }]` from the acknowledgement store
 * @param opts      { now, retentionDays, since (when the log began), clusterName }
 * @returns {{ empty:boolean, count:number, lines:string[], emptyText:string, note:null|{by,text,ts}, last:object|null }}
 */
export function historyFor(m, episodes, notes, opts = {}) {
  const { now = Date.now(), retentionDays = 30, since = null, clusterName = (m.cluster && m.cluster.name) || m.clusterId } = opts;
  const past = (episodes || []).filter((e) => e.key === m.key);
  if (!past.length) {
    return {
      empty: true, count: 0, last: null, note: null, lines: [],
      emptyText: `No history yet for this alert on ${clusterName}`,
      sinceText: since ? `ElasticPro has been watching from ${stamp(since, now)}; what happened before that is not known.` : '',
    };
  }
  const last = past[0];
  const day = (ms) => new Date(ms).toLocaleDateString('en', { day: 'numeric', month: 'short' });
  const lasted = ageShort(Math.max(0, last.end - last.start));
  const count = past.length + 1;
  const lines = [
    `Seen ${count} times in ${retentionDays} days on this cluster, including now.`,
    last.unsure
      ? `Last on ${day(last.start)}, last seen ${stamp(last.end, now)} — ElasticPro was closed when it cleared, so how long it lasted is not known.`
      : `Last on ${day(last.start)}, cleared after ${lasted}.`,
  ];
  // The note written during that episode (or shortly after it was handled), newest first.
  const lo = last.start, hi = last.end + 6 * 3600000;
  let note = null;
  for (const rec of notes || []) {
    if (rec.key !== m.key && !String(rec.key).startsWith(`${m.key}:`)) continue;
    for (const n of rec.notes || []) {
      if (n.ts >= lo && n.ts <= hi && (!note || n.ts > note.ts)) note = { by: n.by || 'operator', text: n.text, ts: n.ts };
    }
  }
  return { empty: false, count, last, note, lines, emptyText: '', sinceText: '' };
}
