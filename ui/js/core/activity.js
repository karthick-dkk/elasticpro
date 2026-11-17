/**
 * The person's activity in the app: one definition of "idle" and one set of listeners for it
 * (0.3.77). The left menu folds itself to its rail after IDLE_MS with no mouse, key, wheel or
 * touch (app.js), and Log Delay › Live's live tail stops itself after the same (logdelay/live-logs.js).
 *
 *   IDLE_MS              three minutes, for both
 *   idleMs(seam)         IDLE_MS, or a shorter time a browser check put on `window[seam]`
 *                        (`__EP_RAIL_IDLE_MS`, `__EP_TAIL_IDLE_MS`): nobody waits three minutes in a test
 *   onActivity(fn)       fn() on every mouse move, press, key, wheel or touch anywhere in the app;
 *                        returns the function that stops it
 *
 * The listeners are added once, on the first onActivity, in the capture phase and passive, so
 * nothing on a page can stop them seeing an event, and they never delay one.
 */

export const IDLE_MS = 3 * 60 * 1000;
export const ACTIVITY_EVENTS = Object.freeze(['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']);

/** IDLE_MS, or the shorter time a browser check set on `window[seam]`. */
export function idleMs(seam) {
  const v = typeof window !== 'undefined' && seam ? Number(window[seam]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : IDLE_MS;
}

/** "3 min": IDLE_MS in words, for what a page says when something stopped for it. */
export const idleWords = () => `${Math.round(IDLE_MS / 60000)} min`;

const subs = new Set();
let wired = false;

function wire() {
  if (wired || typeof document === 'undefined') return;
  wired = true;
  const fire = () => { for (const fn of [...subs]) { try { fn(); } catch (_) { /* one listener's fault is its own */ } } };
  for (const t of ACTIVITY_EVENTS) document.addEventListener(t, fire, { passive: true, capture: true });
}

/** `fn` on every activity; the returned function stops it. */
export function onActivity(fn) {
  wire();
  subs.add(fn);
  return () => { subs.delete(fn); };
}
