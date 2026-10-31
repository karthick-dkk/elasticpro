/**
 * Device-delay measurement while Play is open (docs/PLAY.md: "The one new cluster load").
 *
 * The Logs page's own question — preflight (_field_caps) then measureDelay (a 24 h terms
 * aggregation on the device field) — asked per cluster every 15 minutes, only while a Play
 * display is open, and at most once per 15 minutes per cluster across every display: the
 * shared value (PLAY_SHARE_GET) is read first, and a cluster is measured only when it is
 * older than that; what is measured is shared (PLAY_SHARE_PUT). No more than two clusters
 * are measured at once. On an older core there is no shared value and each display measures
 * for itself, on the same schedule.
 *
 * What a measurement is worth to the rest of the app is what the Logs page makes of it: the
 * cluster's log-delay alert (core/state.js setDelaySummary), from `summarise` on the
 * cluster's own thresholds.
 */

import { preflight, measureDelay, summarise, classify, thresholds } from '../core/log-delay.js';
import { setDelaySummary } from '../core/state.js';
import { runBounded, cancellation } from '../core/fleet.js';
import { shareGet, sharePut } from './api.js';

export const MEASURE_EVERY_MS = 15 * 60 * 1000;
/** A preflight answer is good for this long: mappings change, but not by the minute. */
const PREFLIGHT_MS = 60 * 60 * 1000;
export const MAX_AT_ONCE = 2;
/** What the shared record keeps per cluster (docs/PLAY.md: ≤ 2,000). */
export const MAX_RECORDS = 2000;
const DAY_MS = 86400000;

/**
 * The records a measurement shares, each with its peak over the last 24 h: the higher of
 * this delay and the peak the previous record carried, when that peak is not older than a
 * day. `prev` is the cluster's previous record set (shared or local), or null.
 */
export function withPeaks(records, prev, now) {
  const before = new Map(((prev && prev.records) || []).map((r) => [r.device, r.peak24]));
  return records.slice(0, MAX_RECORDS).map((r) => {
    const p = before.get(r.device);
    const live = p && p.value !== null && p.value !== undefined && now - p.at < DAY_MS ? p : null;
    const cur = r.delayMinutes !== null && r.delayMinutes !== undefined ? { value: r.delayMinutes, at: now } : null;
    const peak24 = !live ? cur : !cur ? live : cur.value >= live.value ? cur : live;
    return { device: r.device, delayMinutes: r.delayMinutes, arrival: r.arrival, event: r.event, docs: r.docs, peak24 };
  });
}

/**
 * @param o.clusters   () → the clusters on this display (with their config entries)
 * @param o.client     (id) → the EsClient for a cluster
 * @param o.reachable  (id) → whether to try it now
 * @param o.now        () → the server's clock
 * @param o.onChange   () → something new to draw
 */
export function createMeasurer(o) {
  const byCluster = new Map();       // id → {measuredAt, records, truncated, error, source}
  const pre = new Map();             // id → {at, value}
  const tried = new Map();           // id → last attempt (ms)
  const busy = new Set();
  let share = null;                  // null: not asked yet; false: this core has no shared cache
  let token = null;
  let running = false;

  /** A record set as the rest of the app reads it, and the cluster's alert from it. */
  function adopt(c, rec, source) {
    const cur = byCluster.get(c.id);
    if (cur && cur.measuredAt >= rec.measuredAt && cur.records) return false;
    const records = Array.isArray(rec.records) ? rec.records : [];
    byCluster.set(c.id, { measuredAt: rec.measuredAt, records, truncated: rec.truncated || 0, error: null, source });
    // As the Logs page does with its own: the cluster's thresholds decide its alert.
    const t = thresholds(c);
    setDelaySummary(c.id, summarise(records.map((r) => ({ ...r, status: classify(r.delayMinutes, t) }))), rec.measuredAt);
    return true;
  }

  async function readShared(list) {
    if (share === false) return;
    const res = await shareGet('delay', list.map((c) => c.id));
    if (!res.ok) { if (res.unsupported) share = false; return; }
    share = true;
    let changed = false;
    for (const c of list) {
      const r = res.byCluster.get(c.id);
      if (r && r.data) changed = adopt(c, { measuredAt: r.measuredAt, ...r.data }, 'shared') || changed;
    }
    if (changed) o.onChange();
  }

  async function measureOne(c, tk) {
    const cl = o.client(c.id);
    if (!cl) throw new Error('not connected');
    const now = o.now();
    let p = pre.get(c.id);
    if (!p || now - p.at > PREFLIGHT_MS || (p.value && p.value.unknown)) {
      p = { at: now, value: await preflight(cl, c) };
      pre.set(c.id, p);
    }
    if (tk.cancelled) return;
    if (!p.value.ok) {
      const why = p.value.unknown ? `could not ask: ${p.value.error || 'no answer'}` : `missing ${p.value.missing.join(', ')}`;
      byCluster.set(c.id, { ...(byCluster.get(c.id) || {}), error: why, measuredAt: (byCluster.get(c.id) || {}).measuredAt || 0 });
      return;
    }
    const res = await measureDelay(cl, c, p.value, 24);
    const at = o.now();
    const prev = byCluster.get(c.id);
    const rec = { measuredAt: at, records: withPeaks(res.records, prev, at), truncated: res.truncated || 0 };
    adopt(c, rec, 'local');
    if (share !== false) {
      const put = await sharePut('delay', c.id, at, { records: rec.records, truncated: rec.truncated });
      if (!put.ok && put.unsupported) share = false;
    }
  }

  /** One pass: read what is shared, then measure what is due, two at a time. */
  async function cycle() {
    if (running) return;
    running = true;
    const tk = cancellation();
    token = tk;
    try {
      const list = o.clusters().filter((c) => o.reachable(c.id));
      if (!list.length) return;
      await readShared(list);
      if (tk.cancelled) return;
      const now = o.now();
      const due = list.filter((c) => {
        const cur = byCluster.get(c.id);
        const fresh = cur && cur.records && now - cur.measuredAt < MEASURE_EVERY_MS;
        return !fresh && !busy.has(c.id) && now - (tried.get(c.id) || 0) >= MEASURE_EVERY_MS;
      });
      await runBounded(due, async (c) => {
        busy.add(c.id);
        tried.set(c.id, o.now());
        o.onChange();
        try { await measureOne(c, tk); } catch (e) {
          const es = e && e.res && e.res.json && e.res.json.error;
          byCluster.set(c.id, { ...(byCluster.get(c.id) || {}), error: (es && (es.reason || es.type)) || (e && e.message) || String(e) });
        } finally { busy.delete(c.id); o.onChange(); }
      }, { limit: MAX_AT_ONCE, token: tk });
    } finally {
      running = false;
      if (token === tk) token = null;
    }
  }

  return {
    cycle,
    get: (id) => byCluster.get(id) || null,
    measuring: () => [...busy],
    /** null until asked, then whether this core keeps the shared cache. */
    shared: () => share,
    stop() { if (token) token.cancel(); },
  };
}
