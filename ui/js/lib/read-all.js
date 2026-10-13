/**
 * "Read all (one at a time)": every dataset of every cluster, asked strictly in turn.
 *
 * Under the hybrid and on-demand request policies opening a fleet page reads nothing —
 * reading is a decision. When somebody makes it, it must still not become a burst: each
 * ask can be a fetch the core makes through an SSH tunnel to a cluster, and a page that
 * fanned out a hundred of them is exactly the load the policy exists to prevent. So this
 * is a plain loop with one ask in flight, never a pool (fleet.js's runBounded batches),
 * cancellable between asks, and it says where it is so the page can show it happening.
 *
 * No DOM: the bar that shows it is lib/freshness.js's coverageBar.
 */

/**
 * @param clusterIds  in the order to read them
 * @param datasets    read for each cluster, in this order
 * @param ask         (clusterId, dataset) → Promise; a throw or an `{ok:false}` answer is a
 *                    failure, recorded and passed over — one dead cluster does not stop
 *                    the other thirty-one
 * @param onProgress  ({done, total, clusterId, dataset, clusterIndex, clusters}) before each
 *                    ask, and once more at the end with clusterId/dataset null
 * @param signal      an AbortSignal; checked before each ask. The ask already in flight is
 *                    left to finish (its answer is still applied), nothing after it starts.
 * @returns {Promise<{done, total, failed: {clusterId, dataset, error}[], aborted}>}
 */
export async function readAll({ clusterIds = [], datasets = [], ask, onProgress = null, signal = null } = {}) {
  const total = clusterIds.length * datasets.length;
  const failed = [];
  let done = 0;
  let aborted = false;
  const report = (p) => { if (onProgress) { try { onProgress(p); } catch (_) { /* a display error is not a read error */ } } };
  outer:
  for (let ci = 0; ci < clusterIds.length; ci++) {
    const clusterId = clusterIds[ci];
    for (const dataset of datasets) {
      if (signal && signal.aborted) { aborted = true; break outer; }
      report({ done, total, clusterId, dataset, clusterIndex: ci, clusters: clusterIds.length });
      try {
        const r = await ask(clusterId, dataset);
        if (r && r.ok === false) failed.push({ clusterId, dataset, error: r.message || r.kind || 'failed' });
      } catch (e) {
        failed.push({ clusterId, dataset, error: (e && e.message) || String(e) });
      }
      done++;
    }
  }
  if (!aborted && signal && signal.aborted && done < total) aborted = true;
  report({ done, total, clusterId: null, dataset: null, clusterIndex: clusterIds.length, clusters: clusterIds.length });
  return { done, total, failed, aborted };
}

/** The bar's run state, kept by the page across redraws (see coverageBar). */
export function readAllState() {
  return { running: false, done: 0, total: 0, current: null, controller: null, last: null, el: null };
}

/**
 * Start a run on `st`, unless one is already going. `onChange` is called on every step so
 * the page can repaint the bar alone — the page itself may be holding redraws (quiet UI).
 */
export function startReadAll(st, { clusterIds, datasets, ask, onChange = () => {} }) {
  if (st.running) return Promise.resolve(null);
  const controller = new AbortController();
  Object.assign(st, { running: true, done: 0, total: clusterIds.length * datasets.length,
    current: null, controller, last: null });
  onChange();
  return readAll({
    clusterIds, datasets, ask, signal: controller.signal,
    onProgress: (p) => {
      st.done = p.done;
      st.current = p.clusterId ? { clusterId: p.clusterId, dataset: p.dataset, clusterIndex: p.clusterIndex, clusters: p.clusters } : null;
      onChange();
    },
  }).then((res) => {
    Object.assign(st, { running: false, current: null, controller: null, last: res });
    onChange();
    return res;
  });
}
