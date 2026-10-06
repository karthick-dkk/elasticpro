/**
 * "Fetched N ago" plus a Refresh button, as one component.
 *
 * Pages serve cached data — navigating to one does not re-query Elasticsearch. That is
 * the right behaviour, and it is only safe while the age of what you are looking at is
 * on screen: a five-minute-old index list and a five-second-old one render identically,
 * and the difference is whether an index someone just deleted is still listed.
 *
 * One component rather than a line of markup per page, because the three pages that had
 * their own version already disagreed about whether "updated" meant this dataset or the
 * last global refresh.
 */

import { h } from './dom.js';
import { dur } from './fmt.js';

/** Past this, the data is old enough that it is worth saying so rather than implying it.
 *  The default only: a dataset from the core's fleet cache carries its own
 *  `staleAfterMs` (two intervals, three for policies), and that one wins. */
export const STALE_AFTER_MS = 5 * 60 * 1000;

/** How often the core probes a cluster it cannot reach (docs/HANDBOOK.md, "Reach"). */
export const UNREACHABLE_RETRY_MS = 120 * 1000;

export function isStale(ts, now = Date.now(), staleAfterMs = STALE_AFTER_MS) {
  return !!ts && now - ts > (staleAfterMs || STALE_AFTER_MS);
}

/** `ago`, against a given clock, so the wording can be tested without waiting. */
function agoAt(ts, now) {
  const d = now - Number(ts);
  if (d < 0) return 'just now';          // a server clock a little ahead is not "in 3 s"
  if (d < 45000) return 'just now';
  return `${dur(d)} ago`;
}

const hhmm = (ts) => {
  const d = new Date(Number(ts));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const every = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * What to say about one dataset's age — the words, not the markup, so they can be tested.
 *
 * `f` is what state.js's datasetFreshness() returns: `{ts, status, staleAfterMs, reach,
 * error, retryMs}`. A bare timestamp (the direct path, or an older core) has no status and
 * reads exactly as it always did. The statuses come from the core's cache:
 *
 *   ok        "health fetched 2 m ago"
 *   error     unknown, and why — "health unknown — unreachable since 10:04, retrying every
 *             2 min" when the cluster is down; the last good value is still on screen, so
 *             its age is named rather than implied to be current
 *   restored  "restored from cache (before restart), refreshing…" — read back from disk at
 *             start-up, not yet re-verified
 *   never     "never fetched" — unknown, not empty, and not "just now"
 *
 * @returns {{text: string, stale: boolean, unknown: boolean, title: string}}
 */
export function freshnessText(label, f = {}, now = Date.now()) {
  const { ts = 0, status = null, staleAfterMs = STALE_AFTER_MS, reach = null, error = null,
          retryMs = UNREACHABLE_RETRY_MS } = f || {};
  const title = ts ? new Date(ts).toLocaleString() : '';
  if (status === 'restored') {
    return { text: `${label} restored from cache (before restart), refreshing…`, stale: true, unknown: false, title };
  }
  if (status === 'error' || (reach && reach.state === 'unreachable' && status !== 'never')) {
    const why = reach && reach.state === 'unreachable'
      ? `unreachable since ${reach.since ? hhmm(reach.since) : 'the last check'}, retrying every ${every(retryMs)}`
      : `last fetch failed${error && error.message ? `: ${error.message}` : ''}`;
    const kept = ts ? ` (showing what was fetched ${agoAt(ts, now)})` : '';
    return { text: `${label} unknown — ${why}${kept}`, stale: true, unknown: true,
      title: error && error.message ? `${error.kind || 'error'}: ${error.message}` : title };
  }
  if (status === 'never' || !ts) {
    return { text: status === 'never' ? `${label} never fetched` : `${label} not fetched yet`,
      stale: false, unknown: true, title: '' };
  }
  return { text: `${label} fetched ${agoAt(ts, now)}`, stale: isStale(ts, now, staleAfterMs), unknown: false, title };
}

/**
 * @param ts       epoch ms this dataset was fetched, 0 when never — or the object
 *                 state.js's datasetFreshness() returns, which also carries the core's
 *                 status for it, its reach and its own staleness threshold
 * @param onRefresh  called when the operator asks for current data
 * @param opts.label what was fetched ("indices", "shards") — named, because a page can
 *                   show more than one dataset and "updated 4 min ago" would not say which
 * @param opts.busy  a refresh is in flight
 */
export function freshnessBar(ts, onRefresh, opts = {}) {
  const { label = 'data', busy = false, dense = false } = opts;
  const f = ts && typeof ts === 'object' ? ts : { ts: ts || 0 };
  const w = freshnessText(label, f);
  return h('div.freshness', { class: dense ? 'freshness sm' : 'freshness' },
    busy
      ? h('span.muted', h('span.spin'), ' Fetching…')
      // Named and timestamped: "this list, at this moment", not "something happened".
      : h('span', { class: w.stale || (w.unknown && f.status) ? 'muted stale' : 'muted', title: w.title }, w.text),
    h('button.btn.sm', {
      disabled: busy,
      title: `Ask the cluster for current ${label} now`,
      onclick: onRefresh,
    }, busy ? '…' : '↻ Refresh'));
}
