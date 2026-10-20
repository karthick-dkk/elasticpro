/**
 * The live tail's one rule, pure so it can be tested: a tick while the previous search is
 * still out is skipped, not stacked. A slow cluster under a short refresh interval used to
 * collect a search per tick, each one holding a slot at the core's gate.
 *
 * Returns whether the tick ran.
 */
export function tailTick(busy, run) {
  if (busy()) return false;
  run();
  return true;
}
