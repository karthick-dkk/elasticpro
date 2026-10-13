/** The Request Centre's model: rows, filters, labels and the CSV agree. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const M = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/request-log.js')).href);
const now = 1_800_000_000_000;
const log = {
  inflight: [{ id: 9, cluster: 'a', origin: 'page:indices', method: 'GET', path: '/_cat/indices', startedAt: now - 4000 }],
  recent: [
    { id: 7, cluster: 'a', origin: 'poller:health', method: 'GET', path: '/_cluster/health', startedAt: now - 60000, ms: 120, ok: true, status: '200' },
    { id: 8, cluster: 'b', origin: 'console', method: 'DELETE', path: '/x', startedAt: now - 30000, ms: 5, ok: false, status: '403', via: 'jump' },
    { id: 6, cluster: 'b', origin: 'poller:nodes', method: 'GET', path: '/_nodes', startedAt: now - 90000, ms: 31000, ok: false, status: 'timeout' },
  ],
};

test('in flight first, then newest first; elapsed is measured for in-flight rows', () => {
  const rows = M.requestRows(log, M.NO_FILTER, now);
  assert.deepEqual(rows.map((r) => r.id), [9, 7, 8, 6]);
  assert.equal(rows[0].inflight, true); assert.equal(rows[0].elapsedMs, 4000);
  assert.match(rows[0].outcome, /in flight · 4000 ms so far/);
  assert.equal(rows[1].outcome, '200'); assert.equal(rows[3].outcome, 'timeout');
});

test('filters: cluster, origin (pollers as one), outcome buckets, slower-than', () => {
  assert.deepEqual(M.requestRows(log, { ...M.NO_FILTER, cluster: 'b' }, now).map((r) => r.id), [8, 6]);
  assert.deepEqual(M.requestRows(log, { ...M.NO_FILTER, origin: 'poller' }, now).map((r) => r.id), [7, 6]);
  assert.deepEqual(M.requestRows(log, { ...M.NO_FILTER, outcome: 'http-error' }, now).map((r) => r.id), [8]);
  assert.deepEqual(M.requestRows(log, { ...M.NO_FILTER, outcome: 'failed' }, now).map((r) => r.id), [6]);
  assert.deepEqual(M.requestRows(log, { ...M.NO_FILTER, outcome: 'inflight' }, now).map((r) => r.id), [9]);
  assert.deepEqual(M.requestRows(log, { ...M.NO_FILTER, slowerThanMs: 2000 }, now).map((r) => r.id), [9, 6], 'an in-flight row counts by elapsed');
});

test('labels name the asker in words', () => {
  assert.equal(M.originLabel('page:indices'), 'Indices page');
  assert.equal(M.originLabel('poller:health'), 'poller · health');
  assert.equal(M.originLabel('console'), 'REST console');
  assert.equal(M.originLabel(undefined), 'core');
  assert.deepEqual(M.originChoices(log), ['console', 'page:indices', 'poller']);
});

test('per-cluster totals and the CSV follow the same rows', () => {
  const pc = M.perCluster(log);
  // equal counts keep first-seen order: 'a' holds the in-flight row, listed first
  assert.deepEqual(pc.map((c) => [c.cluster, c.count, c.inflight, c.failed, c.slowestMs]), [['a', 2, 1, 0, 120], ['b', 2, 0, 2, 31000]]);
  const csv = M.requestCsvRows(M.requestRows(log, M.NO_FILTER, now));
  assert.equal(csv.length, 4);
  assert.deepEqual(csv[0].slice(1, 4), ['a', 'page:indices', 'GET']);
  assert.equal(csv[0][6], 'in flight'); assert.equal(csv[2][7], 'jump');
  assert.equal(M.CSV_HEADER.length, csv[0].length);
});
