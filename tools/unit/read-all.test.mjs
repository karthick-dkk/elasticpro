/**
 * "Read all (one at a time)" and the coverage sentence above it.
 *
 * The point of Read all is that reading a whole fleet never becomes a burst: one ask in
 * flight, ever, whatever the asks take. And the sentence is held to the same rule as the
 * freshness line: a cluster nothing was read for is "never read", never a zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { readAll, readAllState, startReadAll } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/read-all.js')).href);
const { coverageSentence } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/freshness.js')).href);

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('readAll is strictly serial, cluster by cluster, dataset by dataset', async () => {
  let inFlight = 0, peak = 0;
  const order = [];
  const ask = async (id, ds) => {
    inFlight++; peak = Math.max(peak, inFlight);
    order.push(`${id}/${ds}`);
    await tick(ds === 'a' ? 3 : 1);   // uneven, so a parallel run would overlap
    inFlight--;
    return { ok: true };
  };
  const res = await readAll({ clusterIds: ['c1', 'c2', 'c3'], datasets: ['a', 'b'], ask });
  assert.equal(peak, 1, 'never two asks in flight');
  assert.deepEqual(order, ['c1/a', 'c1/b', 'c2/a', 'c2/b', 'c3/a', 'c3/b']);
  assert.deepEqual(res, { done: 6, total: 6, failed: [], aborted: false });
});

test('readAll reports progress before each ask and once at the end', async () => {
  const seen = [];
  await readAll({ clusterIds: ['x', 'y'], datasets: ['h'], ask: async () => ({ ok: true }),
    onProgress: (p) => seen.push([p.done, p.total, p.clusterId, p.dataset, p.clusterIndex]) });
  assert.deepEqual(seen, [[0, 2, 'x', 'h', 0], [1, 2, 'y', 'h', 1], [2, 2, null, null, 2]]);
});

test('readAll stops on abort and says it did', async () => {
  const ctl = new AbortController();
  const asked = [];
  const res = await readAll({ clusterIds: ['c1', 'c2', 'c3'], datasets: ['a', 'b'], signal: ctl.signal,
    ask: async (id, ds) => { asked.push(`${id}/${ds}`); if (asked.length === 3) ctl.abort(); await tick(1); return { ok: true }; } });
  assert.equal(asked.length, 3, 'the ask in flight finishes; nothing after it starts');
  assert.equal(res.done, 3);
  assert.equal(res.total, 6);
  assert.equal(res.aborted, true);
});

test('readAll records failures and carries on', async () => {
  const res = await readAll({ clusterIds: ['up', 'down', 'up2'], datasets: ['h'],
    ask: async (id) => {
      if (id === 'down') return { ok: false, kind: 'unreachable', message: 'tunnel closed' };
      if (id === 'up2') throw new Error('boom');
      return { ok: true };
    } });
  assert.equal(res.done, 3);
  assert.deepEqual(res.failed, [
    { clusterId: 'down', dataset: 'h', error: 'tunnel closed' },
    { clusterId: 'up2', dataset: 'h', error: 'boom' },
  ]);
  assert.equal(res.aborted, false);
});

test('startReadAll keeps the run on its state and will not start a second one', async () => {
  const st = readAllState();
  let calls = 0;
  const ask = async () => { calls++; await tick(1); return { ok: true }; };
  const p = startReadAll(st, { clusterIds: ['a', 'b'], datasets: ['h'], ask });
  assert.equal(st.running, true);
  assert.equal(st.total, 2);
  assert.equal(await startReadAll(st, { clusterIds: ['a'], datasets: ['h'], ask }), null);
  await p;
  assert.equal(calls, 2);
  assert.equal(st.running, false);
  assert.equal(st.last.done, 2);
});

const cov = (o) => ({ clusters: 0, read: 0, never: 0, stale: 0, unreachable: 0, oldestMs: null, perCluster: [], ...o });

test('coverageSentence: zero parts are left out', () => {
  assert.equal(coverageSentence(cov({ clusters: 32, read: 22, never: 5, stale: 3, unreachable: 2, oldestMs: 14 * 60000 })),
    'Showing cached data for 32 clusters · oldest 14 m · 5 never read · 3 stale · 2 unreachable');
  const s = coverageSentence(cov({ clusters: 10, read: 7, stale: 3, oldestMs: 20 * 60000 }));
  assert.equal(s, 'Showing cached data for 10 clusters · oldest 20 m · 3 stale');
  assert.ok(!/\b0\b/.test(s), 'no "0 never read"');
});

test('coverageSentence: everything fresh says so', () => {
  assert.equal(coverageSentence(cov({ clusters: 1, read: 1, oldestMs: 2 * 60000 })),
    'Showing cached data for 1 cluster · oldest 2 m · all current');
});

test('coverageSentence: nothing read is "never read", not zero and not an age', () => {
  const s = coverageSentence(cov({ clusters: 32, never: 32 }));
  assert.equal(s, 'No data read yet for 32 clusters');
  assert.ok(!/oldest/.test(s));
  assert.equal(coverageSentence(cov({ clusters: 4, never: 3, unreachable: 1 })),
    'No data read yet for 4 clusters · 1 unreachable');
});

test('coverageSentence: no clusters', () => {
  assert.equal(coverageSentence(cov({})), 'No clusters selected');
  assert.equal(coverageSentence(null), 'No clusters selected');
});
