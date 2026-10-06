/**
 * Which clusters to ask the core to fetch a dataset for, when a page needs it for many.
 *
 * A page that shows every cluster's snapshot listing or index list used to ask the core
 * once per cluster and hold each request open until that cluster answered. A browser has
 * six connections to a host and the event stream takes one of them, so a hundred and
 * twenty held requests queued behind each other for over a minute, and every other request
 * the page made — a tab switch, a click — queued behind them. The page now reads what the
 * core already holds, asks it in ONE message to fetch the rest, and lets the answers arrive
 * the way every other change does.
 *
 * This decides "the rest". Pure, so the rules can be tested without a core:
 *
 *   * nothing held, or never fetched → ask;
 *   * held, but older than the dataset's own interval → ask (the core would, if watched);
 *   * the cluster is unreachable → do not ask: its health probe answers for all of it, and
 *     the core would refuse the request anyway;
 *   * asked by this page within `askGapMs` → do not ask again: the answer is on its way,
 *     and asking twice is how a page ends up re-requesting on every redraw;
 *   * `force` (somebody pressed Refresh) → ask, but still not twice inside `minGapMs`,
 *     which is the core's own per-person rate limit.
 *
 * @param {Array<{id: string, entry?: object|null, reach?: object|null, askedAt?: number}>} items
 *   `entry` in OUR clock: `{status, fetchedAt, attemptedAt}` (ms), as the page holds it.
 * @returns {string[]} the ids to name in one REFRESH.
 */
export function clustersToAsk(items, { now, intervalMs, force = false, askGapMs = 30000, minGapMs = 10000 } = {}) {
  const out = [];
  for (const it of items || []) {
    if (!it || !it.id) continue;
    if (it.reach && it.reach.state === 'unreachable') continue;
    const asked = Number(it.askedAt) || 0;
    if (asked && now - asked < (force ? minGapMs : askGapMs)) continue;
    if (force) { out.push(it.id); continue; }
    const e = it.entry;
    if (!e || e.status === 'never' || (!e.fetchedAt && !e.attemptedAt)) { out.push(it.id); continue; }
    // A failed fetch counts from when it was tried, so a cluster that keeps failing is not
    // asked again on every redraw; a good one from when it was fetched.
    const last = Math.max(Number(e.fetchedAt) || 0, e.status === 'ok' ? 0 : Number(e.attemptedAt) || 0);
    if (!intervalMs || now - last > intervalMs) out.push(it.id);
  }
  return out;
}
