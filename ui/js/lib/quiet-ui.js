/**
 * Quiet UI: the two decisions that stop a page moving while somebody is reading it.
 *
 * 1. The redraw gate. The core pushes an /events stream; every dataset that lands emits a
 *    `data` event and, until now, the open page repainted on each one. On a 32-cluster
 *    install something lands every few seconds, so Clusters and Alerts re-rendered all
 *    day — which is what "the UI is overloaded" looked like from a chair. The gate sits
 *    between the event and the redraw:
 *      live     — repaint on every event (how it used to be);
 *      pending  — keep what is on screen, count what arrived, show "N updates — Apply",
 *                 and apply by itself once the page has gone `idleMs` without a touch
 *                 (the default);
 *      manual   — never repaint on an event; only Apply, Refresh or navigating does.
 *    Pages that are live by nature (a log tail, the console, the Request Centre) pass
 *    straight through whatever the policy says — their content IS the stream.
 *
 * 2. The opening scope. The top-bar selector used to start on "All clusters": with a
 *    fleet that is the most expensive view there is, and the one a person who looks
 *    after a single cluster never asked for. `openingSelection` picks the cluster last
 *    chosen in this browser, or the first one, unless the policy says to open on the
 *    fleet.
 *
 * Pure: the clock and the timers are injected so the state machine runs under node.
 */
export const REDRAW_POLICIES = ['live', 'pending', 'manual'];
export const SCOPE_DEFAULTS = ['last-selected', 'all'];
/** How long a page has to go untouched before pending updates apply themselves. */
export const IDLE_MS = 60_000;

export function normalisePolicy(v, fallback = 'pending') {
  return REDRAW_POLICIES.includes(v) ? v : fallback;
}
export function normaliseScope(v, fallback = 'last-selected') {
  return SCOPE_DEFAULTS.includes(v) ? v : fallback;
}

/**
 * @param {object} o
 * @param {() => void} o.apply        redraw the page now (the caller's coalesced redraw)
 * @param {string|() => string} o.policy  the policy, or a function that reads the current one
 * @param {(n: number) => void} [o.onChange]  the number of held updates changed (0 = none)
 */
export function createRedrawGate({ apply, policy = 'pending', onChange = () => {}, idleMs = IDLE_MS,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let count = 0;
  let timer = null;
  let lastInteraction = now();
  const current = () => normalisePolicy(typeof policy === 'function' ? policy() : policy);

  function disarm() { if (timer) { clearTimer(timer); timer = null; } }
  function clearCount() { if (count) { count = 0; onChange(0); } }
  function doApply() { disarm(); clearCount(); apply(); }
  function arm() {
    if (timer) return;
    // Armed for the rest of the idle window, not a fresh one: somebody who stopped
    // touching the page five minutes ago has been idle long enough already.
    const due = Math.max(0, idleMs - (now() - lastInteraction));
    timer = setTimer(() => {
      timer = null;
      if (!count || current() !== 'pending') return;      // nothing held, or manual by now
      if (now() - lastInteraction >= idleMs) doApply(); else arm();
    }, due);
  }

  return {
    /** A `data` event. `live` is the open page's nature, not the policy. Returns what happened. */
    notify({ live = false } = {}) {
      const p = current();
      if (live || p === 'live') { disarm(); clearCount(); apply(); return 'applied'; }
      count += 1;
      onChange(count);
      if (p === 'pending') arm(); else disarm();
      return 'held';
    },
    /** The person touched the page: the idle window starts again. */
    interact() { lastInteraction = now(); },
    /** Apply what is held and redraw — the pill, Refresh, or a page that asks. */
    apply: doApply,
    /** Forget what is held without redrawing — the page is being drawn afresh anyway. */
    reset() { disarm(); clearCount(); },
    pending: () => count,
    policy: current,
  };
}

/** Which cluster the app opens on. 'all' only when the policy asks for the fleet. */
export function openingSelection({ scope = 'last-selected', last = null, clusters = [] } = {}) {
  if (normaliseScope(scope) === 'all') return 'all';
  if (last && clusters.some((c) => c.id === last)) return last;
  return clusters[0] ? clusters[0].id : 'all';
}
