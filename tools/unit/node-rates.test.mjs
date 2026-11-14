/**
 * Query pressure (core/node-rates.js): two `_nodes/stats` readings make the rates, one is a
 * baseline, a counter nobody reported stays unknown, and the queues are the latest level.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/node-rates.js')).href);

/** A two-node answer whose counters are the arguments, as the filtered `_nodes/stats` returns it. */
function answer({ q = 0, qMs = 0, ix = 0, del = 0, rej = 0, sq = 0, wq = 0, trips = 0 } = {}, extra = {}) {
  const node = (k) => ({
    name: `node-${k}`,
    indices: { search: { query_total: q * k, query_time_in_millis: qMs * k }, indexing: { index_total: ix * k, delete_total: del * k } },
    thread_pool: { search: { rejected: rej * k, queue: sq * k }, write: { rejected: 0, queue: wq * k } },
    breakers: { request: { tripped: trips * k }, fielddata: { tripped: 0 } },
    ...extra,
  });
  return { nodes: { a: node(1), b: node(2) } };
}

test('readingOf sums every counter over the nodes and stamps when it was read', () => {
  const r = R.readingOf(answer({ q: 10, qMs: 400, ix: 100, del: 5, rej: 1, sq: 2, wq: 3, trips: 1 }), 5000);
  assert.deepEqual(r, { at: 5000, query: 30, queryMs: 1200, index: 300, deletes: 15, searchRejected: 3, writeRejected: 0,
    searchQueue: 6, writeQueue: 9, trips: 3 });
  assert.equal(R.readingOf(null), null);
  assert.equal(R.readingOf({ acknowledged: true }), null, 'not a nodes answer');
});

test('a counter no node reported is null, not 0', () => {
  const a = { nodes: { a: { name: 'a', indices: { search: { query_total: 5 } } } } };
  const r = R.readingOf(a, 1000);
  assert.equal(r.query, 5);
  assert.equal(r.queryMs, null);
  assert.equal(r.trips, null, 'no breakers section: trips unknown');
  assert.equal(r.searchQueue, null);
});

test('ratesBetween divides the deltas by the seconds between the readings', () => {
  const a = R.readingOf(answer({ q: 100, qMs: 3000, ix: 1000, del: 10, rej: 0, sq: 0, wq: 1, trips: 0 }), 10000);
  const b = R.readingOf(answer({ q: 160, qMs: 4800, ix: 4000, del: 40, rej: 2, sq: 1, wq: 0, trips: 1 }), 20000);
  const r = R.ratesBetween(a, b);
  assert.equal(r.measured, true);
  assert.equal(r.sinceMs, 10000);
  // Σ over nodes: queries 300 → 480 (+180 in 10 s), time 9000 → 14400 ms (+5400 over 180 queries)
  assert.equal(r.searchPerSec, 18);
  assert.equal(r.searchLatencyMs, 30);
  assert.equal(r.indexPerSec, 900);
  assert.equal(r.deletesPerSec, 9);
  assert.equal(r.rejected, 6, 'rejections between the readings, search + write');
  assert.equal(r.breakerTrips, 3);
  assert.equal(r.searchQueue, 3, 'the queue is the latest level, not a delta');
  assert.equal(r.writeQueue, 0);
});

test('one reading, or two less than a second apart, is not a measurement', () => {
  const a = R.readingOf(answer({ q: 1, sq: 4 }), 1000);
  for (const r of [R.ratesBetween(null, a), R.ratesBetween(a, null), R.ratesBetween(a, { ...a, at: 1500 }), R.ratesBetween(null, null)]) {
    assert.equal(r.measured, false);
    assert.equal(r.sinceMs, null);
    for (const k of ['searchPerSec', 'searchLatencyMs', 'indexPerSec', 'deletesPerSec', 'rejected', 'breakerTrips']) assert.equal(r[k], null, k);
  }
  assert.equal(R.ratesBetween(null, a).searchQueue, 12, 'the queue is a level: known from one reading');
  assert.equal(R.ratesBetween(null, null).searchQueue, null);
});

test('a counter that went backwards is a new baseline, not a negative rate; no searches means no latency', () => {
  const a = R.readingOf(answer({ q: 100, qMs: 500, ix: 50 }), 0);
  const b = R.readingOf(answer({ q: 10, qMs: 20, ix: 80 }), 10000);
  const r = R.ratesBetween(a, b);
  assert.equal(r.measured, true);
  assert.equal(r.searchPerSec, null);
  assert.equal(r.searchLatencyMs, null);
  assert.equal(r.indexPerSec, 9);
  const idle = R.ratesBetween(R.readingOf(answer({ q: 7, qMs: 9 }), 0), R.readingOf(answer({ q: 7, qMs: 9 }), 5000));
  assert.equal(idle.searchPerSec, 0);
  assert.equal(idle.searchLatencyMs, null, 'nothing was searched, so there is no latency to report');
});

test('a counter unknown on either side yields an unknown rate, not a rate from zero', () => {
  const a = R.readingOf({ nodes: { a: { indices: { search: { query_total: 5 } } } } }, 0);
  const b = R.readingOf({ nodes: { a: { indices: { search: { query_total: 25 } }, breakers: { request: { tripped: 2 } } } } }, 10000);
  const r = R.ratesBetween(a, b);
  assert.equal(r.searchPerSec, 2);
  assert.equal(r.indexPerSec, null);
  assert.equal(r.breakerTrips, null, 'the older reading had no breakers');
  assert.equal(r.rejected, null);
});

test('recordReading keeps the last two readings per cluster and nodeRates measures from them', () => {
  R.forgetReadings('c1');
  assert.equal(R.readingCount('c1'), 0);
  assert.equal(R.nodeRates('c1').measured, false);
  R.recordReading('c1', answer({ q: 10 }), 1000);
  assert.equal(R.readingCount('c1'), 1);
  assert.equal(R.latestReadingAt('c1'), 1000);
  assert.equal(R.nodeRates('c1').measured, false, 'one reading is a baseline');
  R.recordReading('c1', answer({ q: 40 }), 11000);
  assert.equal(R.nodeRates('c1').measured, true);
  assert.equal(R.nodeRates('c1').searchPerSec, 9);
  // A third reading replaces the oldest; a stale answer landing late is ignored.
  R.recordReading('c1', answer({ q: 40 }), 21000);
  assert.equal(R.readingCount('c1'), 2);
  assert.equal(R.nodeRates('c1').searchPerSec, 0);
  assert.equal(R.nodeRates('c1').sinceMs, 10000);
  R.recordReading('c1', answer({ q: 999 }), 15000);
  assert.equal(R.latestReadingAt('c1'), 21000, 'an older answer does not replace a newer reading');
  assert.equal(R.recordReading('c1', { acknowledged: true }), null);
  assert.equal(R.nodeRates('c1').activeTasks, null, 'no shard dataset read: tasks unknown');
  R.forgetReadings('c1');
  assert.equal(R.nodeRates('other').measured, false);
});

test('activeTaskCount leaves out the perpetual tasks and is null without a listing', () => {
  assert.equal(R.activeTaskCount(null), null);
  assert.equal(R.activeTaskCount({}), null);
  assert.equal(R.activeTaskCount([]), 0);
  assert.equal(R.activeTaskCount([
    { action: 'indices:data/read/search', type: 'transport' },
    { action: 'cluster:monitor/tasks/lists', type: 'transport' },
    { action: 'geoip-downloader', type: 'persistent' },
    { action: 'indices:data/write/bulk', type: 'transport' },
  ]), 2);
});
