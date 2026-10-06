/**
 * At most `n` of something at once; the rest wait their turn, in order.
 *
 * For requests that are held open by the far end — a CLUSTER_DATASET that waits for the
 * cluster to answer. The browser gives a page six connections to a host and the event
 * stream already holds one; a handful of held requests is enough to leave nothing for a
 * click. `run(fn)` resolves or rejects as `fn()` does.
 */
export function limiter(n) {
  const size = Math.max(1, Math.floor(n) || 1);
  let busy = 0;
  const queue = [];
  const next = () => {
    if (busy >= size || !queue.length) return;
    const { fn, resolve, reject } = queue.shift();
    busy++;
    let p;
    try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
    p.then(resolve, reject).finally(() => { busy--; next(); });
  };
  const run = (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  run.active = () => busy;
  run.waiting = () => queue.length;
  return run;
}
