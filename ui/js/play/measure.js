/**
 * Device-delay measurement while Play is open (docs/PLAY.md: "The one new cluster load").
 *
 * Two tiers, per cluster, only while a Play display is open:
 *
 *   * a FULL check — the Logs page's own question, preflight (_field_caps) then measureDelay
 *     (a 24 h terms aggregation on the device field, up to 500 devices) — every 2 h;
 *   * the LATE LIST — the devices of that check at or past the yellow line (log-delay.js
 *     `lateList`, on `classify`) — re-checked every 15 min with ONE request naming only those
 *     devices (`measureLate`). A device that has caught up leaves the list; one that goes
 *     quiet between full checks shows up at the next full check (accepted, docs/PLAY.md).
 *
 * The intervals are the request policy's "While Play runs" (Config › Requests: `play.
 * delayFullSec`, `play.delayLateSec`), read from FLEET_STATE. At most once per interval per
 * cluster across every display: the shared record (PLAY_SHARE_GET) is read first and carries
 * both times — `fullAt` and `lateAt` — and a cluster is measured only when one of them is
 * due; what is measured is shared (PLAY_SHARE_PUT). No more than two clusters are measured at
 * once. On an older core there is no shared record and each display measures for itself, on
 * the same schedule.
 *
 * What a measurement is worth to the rest of the app is what the Logs page makes of it: the
 * cluster's log-delay alert (core/state.js setDelaySummary), from `summarise` on the
 * cluster's own thresholds.
 */

import { preflight, measureDelay, measureLate, lateList, summarise, classify, thresholds } from '../core/log-delay.js';
import { setDelaySummary, fleetPolicy } from '../core/state.js';
import { runBounded, cancellation } from '../core/fleet.js';
import { shareGet, sharePut } from './api.js';

/** The shipped schedule (fleet/policy.rs PlaySchedule): a full check every 2 h, the late list every 15 min. */
export const FULL_EVERY_MS = 2 * 60 * 60 * 1000;
export const LATE_EVERY_MS = 15 * 60 * 1000;
/** How long one full check is good for — what the slide's freshness reads (pages/play.js). */
export const MEASURE_EVERY_MS = FULL_EVERY_MS;
/** A preflight answer is good for this long: mappings change, but not by the minute. */
const PREFLIGHT_MS = 60 * 60 * 1000;
export const MAX_AT_ONCE = 2;
/** What the shared record keeps per cluster (docs/PLAY.md: ≤ 2,000). */
export const MAX_RECORDS = 2000;
const DAY_MS = 86400000;

/**
 * The two intervals from FLEET_STATE's policy (`play.delayFullSec`, `play.delayLateSec`), or the
 * shipped ones from a core that does not say. The late list is never re-checked less often
 * than a full check runs.
 */
export function scheduleFrom(policy) {
  const p = (policy && policy.play) || {};
  const sec = (v) => (Number.isFinite(v) && v > 0 ? v * 1000 : null);
  const fullMs = sec(p.delayFullSec) || FULL_EVERY_MS;
  const lateMs = Math.min(sec(p.delayLateSec) || LATE_EVERY_MS, fullMs);
  return { fullMs, lateMs };
}

/**
 * What is due for one cluster's record at `now`: 'full', 'late' or null. A record with no
 * full check, or one older than `fullMs`, wants a full check; else a late list that has not
 * been re-checked for `lateMs` (since the full check, or since its last re-check) wants
 * that. An attempt that failed is not repeated sooner than `lateMs` (`triedAt`).
 */
export function dueKind(rec, now, { fullMs, lateMs }, triedAt = 0) {
  if (triedAt && now - triedAt < lateMs) return null;
  if (!rec || !rec.records || !rec.fullAt || now - rec.fullAt >= fullMs) return 'full';
  const late = rec.late || [];
  if (late.length && now - Math.max(rec.fullAt, rec.lateAt || 0) >= lateMs) return 'late';
  return null;
}

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
 * A full check, as the record every display reads: measured at `now`, its late list from
 * `classify` on `t`, no re-check yet.
 */
export function fullRecord(records, truncated, prev, now, t) {
  const recs = withPeaks(records, prev, now);
  return { measuredAt: now, fullAt: now, lateAt: 0, late: lateList(recs, t), records: recs, truncated: truncated || 0 };
}

/**
 * The late list re-checked: each device that answered takes its fresh delay (and peak); one
 * that sent nothing in the window keeps what the full check found. The list is what is still
 * late — a device that has caught up leaves it. The full check's time and cap stay.
 */
export function lateRecord(prev, fresh, now, t) {
  const got = new Map(withPeaks(fresh || [], prev, now).map((r) => [String(r.device), r]));
  const records = (prev.records || []).map((r) => got.get(String(r.device)) || r);
  const asked = new Set((prev.late || []).map(String));
  const late = lateList(records, t).filter((d) => asked.has(d));
  return { ...prev, measuredAt: now, lateAt: now, late, records };
}

/**
 * What PLAY_SHARE_PUT carries for a delay measurement (docs/HANDBOOK.md: a list of device
 * records or `{devices: [...]}`): `{devices, truncated, fullAt, lateAt, late}`. One
 * definition, read back by fromShare; the core checks the two times (play/share.rs).
 */
export function shareData(rec) {
  const out = { devices: (rec && Array.isArray(rec.records) ? rec.records : []).slice(0, MAX_RECORDS), truncated: (rec && rec.truncated) || 0 };
  if (rec && rec.fullAt) out.fullAt = rec.fullAt;
  if (rec && rec.lateAt) out.lateAt = rec.lateAt;
  if (rec && Array.isArray(rec.late)) out.late = rec.late.map(String);
  return out;
}

/**
 * A shared record (PLAY_SHARE_GET, one cluster's `{measuredAt, data}`) as a measurement:
 * `{measuredAt, fullAt, lateAt, late, records, truncated}`. `data` is `{devices}` or the bare
 * list; the record's own `measuredAt` (the server's) wins over anything inside `data`. A record
 * from before the two tiers was a full check at its own time, with no late list kept (null:
 * worked out from the records when it is needed).
 */
export function fromShare(r) {
  if (!r || !r.data) return null;
  const d = r.data;
  const devices = Array.isArray(d) ? d : Array.isArray(d.devices) ? d.devices : null;
  if (!devices) return null;
  const num = (v) => (typeof v === 'number' && v > 0 && v <= r.measuredAt ? v : 0);
  const obj = Array.isArray(d) ? {} : d;
  return {
    truncated: obj.truncated || 0, records: devices, measuredAt: r.measuredAt,
    fullAt: num(obj.fullAt) || r.measuredAt, lateAt: num(obj.lateAt),
    late: Array.isArray(obj.late) ? obj.late.map(String) : null,
  };
}

/**
 * "last full check 14:00 · late devices re-checked 14:45" for the clusters on a display —
 * the oldest of each, so the line never reads fresher than its stalest cluster. `clock(ms)`
 * formats a time. null when nothing has been measured.
 */
export function tierLine(recs, clock) {
  const list = (recs || []).filter((r) => r && r.fullAt);
  if (!list.length) return null;
  const full = Math.min(...list.map((r) => r.fullAt));
  const withLate = list.filter((r) => (r.late || []).length);
  let late;
  if (!withLate.length) late = 'no device late';
  else {
    const times = withLate.map((r) => r.lateAt || 0);
    late = times.some((x) => !x) ? 'late devices not re-checked yet' : `late devices re-checked ${clock(Math.min(...times))}`;
  }
  return `last full check ${clock(full)} · ${late}`;
}

/**
 * @param o.clusters    () → the clusters on this display (with their config entries)
 * @param o.client      (id) → the EsClient for a cluster
 * @param o.reachable   (id) → whether to try it now
 * @param o.now         () → the server's clock
 * @param o.onChange    () → something new to draw
 * @param o.thresholds  (cluster) → the yellow and red lines the late list is decided on
 *                       (Play's watch rules); the cluster's own when not given
 * @param o.schedule    () → {fullMs, lateMs}; the request policy's (scheduleFrom) when not given
 */
export function createMeasurer(o) {
  const byCluster = new Map();       // id → {measuredAt, fullAt, lateAt, late, records, truncated, error, source}
  const pre = new Map();             // id → {at, value}
  const tried = new Map();           // id → last attempt (ms)
  const busy = new Set();
  let share = null;                  // null: not asked yet; false: this core has no shared cache
  let putProblem = '';               // the last offer the core refused (kept here only), '' when it took it
  let token = null;
  let running = false;
  const sched = () => (o.schedule ? o.schedule() : scheduleFrom(fleetPolicy()));
  const lateT = (c) => (o.thresholds ? o.thresholds(c) : thresholds(c));

  /** A record set as the rest of the app reads it, and the cluster's alert from it. */
  function adopt(c, rec, source) {
    const cur = byCluster.get(c.id);
    if (cur && cur.measuredAt >= rec.measuredAt && cur.records) return false;
    const records = Array.isArray(rec.records) ? rec.records : [];
    const late = Array.isArray(rec.late) ? rec.late : lateList(records, lateT(c));
    byCluster.set(c.id, { measuredAt: rec.measuredAt, fullAt: rec.fullAt || rec.measuredAt, lateAt: rec.lateAt || 0, late,
      records, truncated: rec.truncated || 0, error: null, source });
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
      const rec = fromShare(res.byCluster.get(c.id));
      if (rec) changed = adopt(c, rec, 'shared') || changed;
    }
    if (changed) o.onChange();
  }

  async function offer(c, rec) {
    if (share === false) return;
    const put = await sharePut('delay', c.id, rec.measuredAt, shareData(rec));
    if (!put.ok && put.unsupported) share = false;
    else putProblem = put.ok ? '' : (put.message || put.kind || 'refused');
  }

  async function measureOne(c, kind, tk) {
    const cl = o.client(c.id);
    if (!cl) throw new Error('not connected');
    const now = o.now();
    let p = pre.get(c.id);
    // Asked again with a full check, not between: the late list's re-check is one request.
    const stale = !p || (p.value && p.value.unknown) || (kind !== 'late' && now - p.at > PREFLIGHT_MS);
    if (stale) {
      p = { at: now, value: await preflight(cl, c) };
      pre.set(c.id, p);
    }
    if (tk.cancelled) return;
    if (!p.value.ok) {
      const why = p.value.unknown ? `could not ask: ${p.value.error || 'no answer'}` : `missing ${p.value.missing.join(', ')}`;
      byCluster.set(c.id, { ...(byCluster.get(c.id) || {}), error: why, measuredAt: (byCluster.get(c.id) || {}).measuredAt || 0 });
      return;
    }
    const prev = byCluster.get(c.id);
    let rec;
    if (kind === 'late' && prev && prev.records) {
      const res = await measureLate(cl, c, p.value, prev.late || [], 24);
      rec = lateRecord(prev, res.records, o.now(), lateT(c));
    } else {
      const res = await measureDelay(cl, c, p.value, 24);
      rec = fullRecord(res.records, res.truncated, prev, o.now(), lateT(c));
    }
    adopt(c, rec, 'local');
    await offer(c, rec);
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
      const s = sched();
      const due = list.map((c) => ({ c, kind: busy.has(c.id) ? null : dueKind(byCluster.get(c.id), now, s, tried.get(c.id)) }))
        .filter((x) => x.kind);
      await runBounded(due, async ({ c, kind }) => {
        busy.add(c.id);
        tried.set(c.id, o.now());
        o.onChange();
        try { await measureOne(c, kind, tk); } catch (e) {
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
    /** The schedule this measurer keeps: {fullMs, lateMs}. */
    schedule: sched,
    /** null until asked, then whether this core keeps the shared cache. */
    shared: () => share,
    /** Why the last measurement was not shared ('' when it was): kept on this screen only. */
    putProblem: () => putProblem,
    stop() { if (token) token.cancel(); },
  };
}
