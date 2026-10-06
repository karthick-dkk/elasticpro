/**
 * "Did we already do this recently enough to skip it" — one place for the arithmetic
 * elasticpro-scrape.mjs uses to throttle re-fetching a cluster's index list (--indices-every)
 * against what a --memory file remembered from the last run.
 *
 * Pulled out on its own because elasticpro-scrape.mjs is a CLI entry point: importing it to
 * unit-test one comparison would run the whole script, argv parsing and all. This has no
 * side effects, so it can be asserted on directly.
 */

/**
 * @param {{at?: number}|null|undefined} remembered — the last run's record for whatever
 *   is being throttled, or none (nothing has ever been fetched, or --memory is unset).
 * @param {number} now — this run's clock.
 * @param {number} intervalMs — how often the work is allowed to actually happen.
 * @returns {boolean} true when `remembered` is recent enough that doing the work again
 *   now would just repeat it for no new information.
 */
export function isFreshEnough(remembered, now, intervalMs) {
  return !!(remembered && now - (remembered.at || 0) < intervalMs);
}
