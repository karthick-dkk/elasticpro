/**
 * Collapse a burst of calls into one, at most once per animation frame.
 *
 * A fleet refresh fires the app's `data` bus event once per cluster — twice, once for the
 * overview fetch and once for the snapshot listing — and rendering the nav and the whole
 * page on every single one of those was 88 full redraws and a multi-second stall on a
 * hundred-cluster fleet (see SPEC.md, "Measured problem"). The events themselves are not
 * the problem; re-drawing on each one is. This makes many calls to `schedule()` behave as
 * one call to `fn`, run with whatever the world looked like at the last of them.
 *
 * `requestAnimationFrame` alone is not enough: it never fires while the tab is hidden, and
 * a coalesced redraw must not wait indefinitely for someone to look at the tab again. So a
 * plain timer runs alongside it as an upper bound — whichever fires first wins, and the
 * other is cancelled. `maxWaitMs` is that bound, not the common case: on a visible tab the
 * frame callback runs first, well under it.
 */
export function coalesce(fn, opts = {}) {
  const {
    maxWaitMs = 250,
    raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null,
    caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null,
    // How long to leave the main thread alone after a run that took `costMs`. A redraw of
    // a hundred-cluster page costs a few hundred milliseconds; running it again on every
    // frame a push arrives in leaves the page no time to answer a click, which is how a
    // refresh on a large fleet turned into seconds of a frozen window. 0 by default.
    gapAfter = null,
    now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  } = opts;

  let pending = false;
  let rafId = 0;
  let timer = null;
  let hold = null;
  let nextAllowed = 0;

  function clearWaiters() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (hold) { clearTimeout(hold); hold = null; }
    if (rafId && caf) { caf(rafId); rafId = 0; }
  }

  function flush() {
    // Whichever of the two callbacks arrives first must disarm the other, or the loser
    // fires a second, redundant redraw later instead of a no-op.
    if (!pending) return;
    pending = false;
    clearWaiters();
    const t0 = now();
    try {
      fn();
    } finally {
      if (gapAfter) {
        const end = now();
        nextAllowed = end + Math.max(0, Number(gapAfter(end - t0)) || 0);
      }
    }
  }

  function arm() {
    hold = null;
    if (raf) rafId = raf(flush);
    timer = setTimeout(flush, maxWaitMs);
  }

  function schedule(...args) {
    // A burst collapses to the LAST state, not the first: nothing here remembers `args`
    // for replay, `fn` just reads whatever is live when it finally runs.
    void args;
    if (pending) return;
    pending = true;
    const wait = nextAllowed - now();
    if (wait > 0) hold = setTimeout(arm, wait);
    else arm();
  }

  /** Run now if one is waiting; otherwise a no-op. For tests, and shutdown paths. */
  schedule.flush = flush;
  /** Drop a pending call outright — nothing scheduled runs. */
  schedule.cancel = () => { pending = false; clearWaiters(); };
  /** Whether a call is waiting to run. */
  schedule.pending = () => pending;
  return schedule;
}
