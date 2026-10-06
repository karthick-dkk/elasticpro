/**
 * Which clusters a page asks the core to fetch, when it needs one dataset for many.
 * See ui/js/lib/demand.js: one REFRESH for the ones that need it, never one held request
 * per cluster, and never the same ask twice while the answer is on its way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { clustersToAsk } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/demand.js')).href);
const { limiter } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/limit.js')).href);

const now = 1_000_000;
const opts = { now, intervalMs: 60_000 };

test('nothing held, or never fetched: ask', () => {
  assert.deepEqual(clustersToAsk([{ id: 'a' }, { id: 'b', entry: { status: 'never' } }], opts), ['a', 'b']);
});

test('fresh is left alone; older than the interval is asked for', () => {
  const items = [
    { id: 'fresh', entry: { status: 'ok', fetchedAt: now - 5_000 } },
    { id: 'old', entry: { status: 'ok', fetchedAt: now - 120_000 } },
    { id: 'restored-old', entry: { status: 'restored', fetchedAt: now - 120_000 } },
  ];
  assert.deepEqual(clustersToAsk(items, opts), ['old', 'restored-old']);
});

test('an unreachable cluster is never asked: its health probe answers for it', () => {
  const items = [{ id: 'down', reach: { state: 'unreachable' } }, { id: 'up', reach: { state: 'reachable' } }];
  assert.deepEqual(clustersToAsk(items, opts), ['up']);
  assert.deepEqual(clustersToAsk(items, { ...opts, force: true }), ['up']);
});

test('asked recently: not again, even though nothing has arrived yet', () => {
  const items = [{ id: 'a', askedAt: now - 5_000 }, { id: 'b', askedAt: now - 45_000 }];
  assert.deepEqual(clustersToAsk(items, opts), ['b']);
});

test('force asks for fresh ones too, but not inside the core rate limit', () => {
  const items = [
    { id: 'fresh', entry: { status: 'ok', fetchedAt: now - 1_000 } },
    { id: 'just-asked', askedAt: now - 3_000 },
    { id: 'asked-a-while-ago', askedAt: now - 15_000 },
  ];
  assert.deepEqual(clustersToAsk(items, { ...opts, force: true }), ['fresh', 'asked-a-while-ago']);
});

test('a failed fetch counts from when it was tried, not from the last good one', () => {
  const items = [
    { id: 'failed-now', entry: { status: 'error', fetchedAt: now - 600_000, attemptedAt: now - 2_000 } },
    { id: 'failed-long-ago', entry: { status: 'error', fetchedAt: now - 600_000, attemptedAt: now - 300_000 } },
  ];
  assert.deepEqual(clustersToAsk(items, opts), ['failed-long-ago']);
});

test('limiter: never more than n at once, and every one runs', async () => {
  const run = limiter(2);
  let active = 0, peak = 0;
  const job = (ms, v) => async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, ms)); active--; return v; };
  const out = await Promise.all([run(job(10, 1)), run(job(5, 2)), run(job(1, 3)), run(job(1, 4)), run(job(1, 5))]);
  assert.deepEqual(out, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
});

test('limiter: a failure frees its slot and reaches its caller', async () => {
  const run = limiter(1);
  const bad = run(() => { throw new Error('nope'); });
  await assert.rejects(bad, /nope/);
  assert.equal(await run(async () => 'next'), 'next');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(run.active(), 0);
});
