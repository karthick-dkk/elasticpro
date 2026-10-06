/**
 * Running one piece of work across the whole fleet, without knocking it over.
 *
 * A page that asks eight clusters something at once is eight simultaneous aggregations,
 * and the clusters people run this against are the ones already under load — that is why
 * they are being watched. So the fan-out is bounded, and it is bounded here rather than
 * in each page, because a second copy of this would drift from the first.
 *
 * Three things this owes its callers, all of which exist because of how the delay
 * analysis behaves when it goes wrong:
 *
 *   * **Progressive.** Results are handed back as they land, not in one batch at the end.
 *     Eight clusters at four at a time is two round trips; a page that shows nothing for
 *     the duration looks broken.
 *   * **Cancellable.** Somebody who started a fleet-wide query and changed their mind
 *     must be able to stop it, and stopping it must stop *launching* work, not just stop
 *     listening to it.
 *   * **Honest about what it did not do.** A cancelled or failed run reports exactly
 *     which items never ran. This is the whole reason the result is a shape rather than
 *     an array: a caller that cannot tell "eight clusters, all fine" from "four
 *     clusters, and four we never asked" will draw the second as if it were the first,
 *     and that is a wrong number on a screen somebody makes decisions from.
 */

/** A stop button. Passed in so the caller can hold it and press it later. */
export function cancellation() {
  let cancelled = false;
  return {
    cancel() { cancelled = true; },
    get cancelled() { return cancelled; },
  };
}

/**
 * Run `worker(item, index)` over `items`, at most `limit` at a time.
 *
 * Never rejects: a worker that throws produces an `error` entry, because one unreachable
 * cluster must not cost you the other seven.
 *
 * @returns {Promise<{results: Array, skipped: Array, cancelled: boolean}>}
 *   `results` holds `{item, index, value}` or `{item, index, error}`, in completion
 *   order. `skipped` holds the `{item, index}` entries that were never started.
 */
export async function runBounded(items, worker, { limit = 3, onSettled = null, token = null } = {}) {
  const list = [...items];
  const size = Math.max(1, Math.floor(limit) || 1);
  const results = [];
  const started = new Set();
  let next = 0;

  const pump = async () => {
    for (;;) {
      if (token && token.cancelled) return;
      const i = next;
      if (i >= list.length) return;
      next += 1;
      started.add(i);
      let settled;
      try {
        settled = { item: list[i], index: i, value: await worker(list[i], i) };
      } catch (e) {
        settled = { item: list[i], index: i, error: e };
      }
      // A cancel that lands while this was in flight still keeps the answer: the work is
      // already done and paid for, and throwing it away would be a second kind of lie.
      results.push(settled);
      if (onSettled) {
        try { onSettled(settled, { done: results.length, total: list.length }); } catch (_) { /* a listener must not stop the fan-out */ }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(size, list.length) }, pump));

  const skipped = list
    .map((item, index) => ({ item, index }))
    .filter(({ index }) => !started.has(index));
  return { results, skipped, cancelled: !!(token && token.cancelled) };
}

/**
 * How to describe a fan-out that did not finish, in one line, or `null` when it did.
 *
 * Kept next to the runner so every page says it the same way. "6 of 9" is the number
 * that stops a partial answer being read as a whole one.
 */
export function partialNote({ total, ok, failed, skipped, cancelled }) {
  if (!skipped && !failed) return null;
  const bits = [];
  if (failed) bits.push(`${failed} could not be reached`);
  if (skipped) bits.push(cancelled ? `${skipped} never asked (stopped)` : `${skipped} never asked`);
  return `${ok} of ${total} cluster(s) answered — ${bits.join(', ')}. `
    + 'The totals below cover only the ones that answered.';
}
