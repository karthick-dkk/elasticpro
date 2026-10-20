/**
 * "Open this page with the problem in view" — the hint a link hands to the page it opens.
 *
 * Navigating selects a cluster (core/intent.js navigateTo). Many links want one thing more:
 * the Nodes page showing the unassigned shards, the Indices page filtered to the ones in an
 * ILM error step, the Log delay view rather than the live tail. The page being left sets a
 * hint here; the page being opened takes it once, in its own render(), and decides what it
 * means. A page that has no use for a hint simply never asks, and the hint expires on its
 * own, so a stale one cannot surprise the next visit.
 *
 * Kept apart from `intent` on purpose: that object is one slot per page for payloads a page
 * defines; this is one shape for every page, and nothing here needs a page to be imported.
 */

/** A hint older than this was left by a navigation that never arrived. */
export const FOCUS_TTL_MS = 8000;

let pending = null;

/** Leave a hint for `page`. Replaces any earlier one — only the latest navigation counts. */
export function setFocus(page, hint, now = Date.now()) {
  pending = page && hint ? { page, hint, at: now } : null;
}

/** The hint for `page`, once. Null when there is none, it was for another page, or it expired. */
export function takeFocus(page, now = Date.now()) {
  const f = pending;
  if (!f || f.page !== page) return null;
  pending = null;
  return now - f.at <= FOCUS_TTL_MS ? f.hint : null;
}

/**
 * Bring the element a hint is about into view and flash it, once.
 *
 * Done after the page has drawn, because a hint is about something the draw makes. Both
 * calls are guarded: jsdom has no scrollIntoView, and a page that is already gone has
 * nothing to scroll.
 */
export function revealFocus(root, selector) {
  const el = root && root.isConnected ? root.querySelector(selector) : null;
  if (!el) return false;
  try { if (el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'auto' }); } catch (_) { /* ignore */ }
  el.classList.add('focus-flash');
  setTimeout(() => el.classList.remove('focus-flash'), 2600);
  return true;
}
