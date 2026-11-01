/**
 * Play's slide engine (docs/PLAY.md, "Slide engine"): which slide is on, for how long, and
 * what takes the screen. Pure — the clock comes in as `now` — so tools/unit covers it
 * without a DOM. pages/play.js owns the timers and the drawing.
 */

/** Zoom steps, 80 %…150 %. */
export const ZOOM_STEPS = Object.freeze([0.8, 0.9, 1, 1.1, 1.25, 1.5]);

/** The nearest step to `z`, moved `dir` steps (−1, 0, +1), kept inside the range. */
export function zoomStep(z, dir = 0) {
  const v = typeof z === 'number' && isFinite(z) ? z : 1;
  let i = 0;
  for (let k = 1; k < ZOOM_STEPS.length; k++) if (Math.abs(ZOOM_STEPS[k] - v) < Math.abs(ZOOM_STEPS[i] - v)) i = k;
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + Math.sign(dir || 0)))];
}

/** How long a critical alert holds the screen when nobody acknowledges it. */
export const TAKEOVER_MS = 5 * 60 * 1000;
/** How often the picture moves a few pixels, and the offsets it walks through. */
export const BURN_IN_MS = 10 * 60 * 1000;
const BURN_IN = [[0, 0], [3, 2], [-2, 3], [2, -3], [-3, -2], [1, 3]];

export function burnShift(now) {
  const [x, y] = BURN_IN[Math.floor(now / BURN_IN_MS) % BURN_IN.length];
  return { x, y };
}

/**
 * How long a slide stays: `dwellSec`, except the spotlight, which stays `perClusterSec` per
 * cluster in it.
 */
export function dwellMs(slideId, { dwellSec = 20, slideDwell = {}, perClusterSec = 13, spotlightCount = 0 } = {}) {
  if (slideId === 'spotlight' && spotlightCount > 0) return perClusterSec * spotlightCount * 1000;
  return (slideDwell[slideId] || dwellSec) * 1000;
}

/**
 * The next slide to show from `from`, stepping `dir`, over `order`. A slide `isEmpty` says
 * has nothing is skipped — except Alerts, which always shows ("All clear"). When every
 * slide is empty, Alerts; when there is no Alerts in the order either, `from` stays.
 */
export function nextSlide(order, from, dir, isEmpty) {
  const n = order.length;
  if (!n) return -1;
  const step = dir < 0 ? -1 : 1;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (order[i] === 'alerts' || !isEmpty(order[i])) return i;
  }
  const a = order.indexOf('alerts');
  return a >= 0 ? a : Math.max(0, Math.min(from, n - 1));
}

/**
 * The engine's state, advanced by `tick(now)` and the keys. `isEmpty(id)` and `dwellFor(id)`
 * are asked fresh each time, so a slide that fills or empties is noticed on the next turn.
 */
export function createEngine({ order, now = 0, isEmpty = () => false, dwellFor = () => 20000 }) {
  const st = { order: [...order], index: 0, startedAt: now, paused: false, pausedAt: 0 };
  if (st.order.length && st.order[0] !== 'alerts' && isEmpty(st.order[0])) st.index = nextSlide(st.order, 0, 1, isEmpty);
  const go = (i, t) => { st.index = i; st.startedAt = t; if (st.paused) st.pausedAt = t; };
  return {
    get current() { return st.order[st.index]; },
    get index() { return st.index; },
    get paused() { return st.paused; },
    get order() { return st.order; },
    /** Milliseconds this slide has been on (paused time not counted). */
    elapsed(t) { return Math.max(0, (st.paused ? st.pausedAt : t) - st.startedAt); },
    remaining(t) { return Math.max(0, dwellFor(st.order[st.index]) - this.elapsed(t)); },
    setOrder(next, t) {
      const cur = st.order[st.index];
      st.order = [...next];
      const i = st.order.indexOf(cur);
      if (i >= 0) st.index = i; else go(Math.max(0, nextSlide(st.order, -1, 1, isEmpty)), t);
    },
    next(t) { go(nextSlide(st.order, st.index, 1, isEmpty), t); },
    prev(t) { go(nextSlide(st.order, st.index, -1, isEmpty), t); },
    show(id, t) { const i = st.order.indexOf(id); if (i >= 0 && i !== st.index) go(i, t); },
    togglePause(t) {
      if (st.paused) { st.startedAt += t - st.pausedAt; st.paused = false; }
      else { st.paused = true; st.pausedAt = t; }
      return st.paused;
    },
    /** Moves on when the slide's time is up, or when it emptied. Returns whether it moved. */
    tick(t) {
      if (st.paused || !st.order.length) return false;
      const cur = st.order[st.index];
      if ((cur !== 'alerts' && isEmpty(cur)) || this.elapsed(t) >= dwellFor(cur)) {
        go(nextSlide(st.order, st.index, 1, isEmpty), t);
        return true;
      }
      return false;
    },
  };
}

/**
 * Critical takeover. `prev` is the last answer (null at first); `open` the critical alerts
 * open now (merged keys); `acked(key)` whether that one is acknowledged (shared, or local
 * on an older core).
 *
 * The first look only learns what is already open: a display switched on during an incident
 * is not taken over by every alert that was already there. After that a key not seen before
 * takes the screen and holds it until it is acknowledged, it clears, or TAKEOVER_MS pass.
 * Returns `{seen:Set, active: {key, since}|null}`.
 *
 * `held`: alerts held on a cluster that is down (alert-groups.js holdUnreachable). They never
 * take the screen. One this display already saw open before the outage stays remembered while
 * held, so if it is still true and critical when the cluster answers it does not take over a
 * second time. A held key is never ADDED to what was seen (the first look included): a display
 * switched on mid-outage, or an alert that appeared only while held, takes over when it
 * becomes current — nobody was shown it.
 */
export function takeover(prev, { open = [], held = [], acked = () => false, now, enabled = true }) {
  const keyOf = (a) => (typeof a === 'string' ? a : a.key);
  const keys = open.map(keyOf);
  const heldKeys = new Set(held.map(keyOf));
  if (!prev) return { seen: new Set(keys), active: null };
  const seen = new Set(prev.seen);
  let active = prev.active;
  if (active && (!keys.includes(active.key) || acked(active.key) || now - active.since >= TAKEOVER_MS)) active = null;
  for (const k of keys) {
    if (seen.has(k)) continue;
    seen.add(k);
    if (enabled && !active && !acked(k)) active = { key: k, since: now };
  }
  // Forget what cleared, so the same problem coming back later counts as new.
  for (const k of [...seen]) if (!keys.includes(k) && !heldKeys.has(k)) seen.delete(k);
  return { seen, active };
}

/**
 * Spotlight membership, per display. `reasons` is clusterId → [why…] for every cluster with
 * a critical problem now. A cluster joins when it has one and leaves `leaveAfterMs` after its
 * last one cleared. Returns a new Map clusterId → {since, lastBad, why:[…]}.
 */
export function spotlightMembers(prev, reasons, now, leaveAfterMs) {
  const out = new Map();
  const cur = reasons instanceof Map ? reasons : new Map(Object.entries(reasons || {}));
  for (const [id, why] of cur) {
    if (!why || !why.length) continue;
    const p = prev && prev.get(id);
    out.set(id, { since: p ? p.since : now, lastBad: now, why: [...why] });
  }
  for (const [id, p] of prev || []) {
    if (out.has(id)) continue;
    if (now - p.lastBad < leaveAfterMs) out.set(id, { ...p, why: p.why, clearing: true });
  }
  return out;
}

/**
 * "As of" for a figure: fresh, stale (older than its stale time — two refreshes) or none
 * (no answer at all). `staleAfterMs` defaults to twice `refreshMs`.
 */
export function staleness(asOf, now, { refreshMs = 60000, staleAfterMs = 0 } = {}) {
  if (!asOf) return 'none';
  return now - asOf > (staleAfterMs || 2 * refreshMs) ? 'stale' : 'fresh';
}

/** Which spotlight cluster is on and which chart window, from the time on the slide. */
export const CHART_WINDOWS = Object.freeze([{ days: 7, ms: 3000 }, { days: 15, ms: 5000 }, { days: 30, ms: 5000 }]);
export function spotlightPhase(elapsedMs, count, perClusterMs) {
  const n = Math.max(1, count);
  const per = Math.max(1000, perClusterMs);
  const idx = Math.floor(elapsedMs / per) % n;
  const cycle = CHART_WINDOWS.reduce((s, w) => s + w.ms, 0);
  let t = (elapsedMs % per) % cycle;
  let w = 0;
  while (w < CHART_WINDOWS.length - 1 && t >= CHART_WINDOWS[w].ms) { t -= CHART_WINDOWS[w].ms; w++; }
  return { index: idx, days: CHART_WINDOWS[w].days };
}
