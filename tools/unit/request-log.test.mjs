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
  assert.deepEqual([csv[0].cluster, csv[0].origin, csv[0].method], ['a', 'page:indices', 'GET']);
  assert.equal(csv[0].outcome, 'in flight'); assert.equal(csv[2].via, 'jump');
  assert.deepEqual(Object.keys(csv[0]), M.CSV_HEADER, 'the row keys are the header, so toCsv finds every column');
});

test('the gate: queued and refused rows, shared and cached answers', () => {
  const g = {
    inflight: [
      { id: 20, cluster: 'a', origin: 'page:logs', class: 'interactive', state: 'queued', method: 'POST', path: '/x/_search', startedAt: now - 3000 },
      { id: 21, cluster: 'a', origin: 'page:logs', class: 'interactive', state: 'shared', leader: 19, method: 'GET', path: '/', startedAt: now - 1000 },
    ],
    recent: [
      { id: 18, cluster: 'b', origin: 'page:indices', class: 'interactive', state: 'done', method: 'GET', path: '/_cat/indices', startedAt: now - 9000, ms: 0, ok: false, status: 'overloaded' },
      { id: 17, cluster: 'b', origin: 'page:indices', class: 'interactive', state: 'done', method: 'GET', path: '/_cat/indices', startedAt: now - 9500, ms: 0, ok: true, status: '200', cached: true, ageMs: 2100 },
      { id: 16, cluster: 'b', origin: 'page:indices', class: 'interactive', state: 'done', method: 'GET', path: '/', startedAt: now - 9600, ms: 20000, ok: false, status: 'queue_timeout', queuedMs: 20000 },
    ],
  };
  const rows = M.requestRows(g, M.NO_FILTER, now);
  assert.match(rows[0].outcome, /^queued · 3000 ms so far/);
  assert.match(rows[1].outcome, /^waiting on #19/);
  assert.deepEqual(M.requestRows(g, { ...M.NO_FILTER, outcome: 'queued' }, now).map((r) => r.id), [20]);
  assert.deepEqual(M.requestRows(g, { ...M.NO_FILTER, outcome: 'refused' }, now).map((r) => r.id), [18, 16]);
  assert.deepEqual(M.requestRows(g, { ...M.NO_FILTER, outcome: 'inflight' }, now).map((r) => r.id), [20, 21], 'in flight includes the queued');
  assert.equal(rows.find((r) => r.id === 17).answeredBy, 'cached 2.1 s old');
  const pc = M.perCluster(g);
  assert.deepEqual(pc.map((c) => [c.cluster, c.queued, c.refused, c.failed]), [['b', 0, 2, 0], ['a', 1, 0, 0]]);
  const csv = M.requestCsvRows(rows);
  assert.equal(csv[0].outcome, 'queued');
  assert.equal(csv.find((r) => r.id === '16').queuedMs, '20000');
});

test('gate figures: from the core when it sends them, unknown (not zero) when it does not', () => {
  const none = M.gateFigures({ inflight: [], recent: [] });
  assert.equal(none.known, false);
  assert.equal(none.queued, null); assert.equal(none.waitP95Ms, null); assert.equal(none.refused, null); assert.equal(none.sharedOrCached, null);
  const f = M.gateFigures({ gate: { queued: { total: 3 }, oldestWaitMs: 1200, waits: { interactive: { count: 40, p95Ms: 850 } },
    refused: { total: 2, overloaded: 1, queueTimeout: 1 }, shared: 5, cacheHits: 7, limits: { global: 24 } } });
  assert.deepEqual([f.queued, f.waitP95Ms, f.refused, f.sharedOrCached, f.oldestWaitMs], [3, 850, 2, 12, 1200]);
  const quiet = M.gateFigures({ gate: { queued: { total: 0 }, waits: { interactive: { count: 0, p95Ms: null } }, refused: { total: 0 }, shared: 0, cacheHits: 0 } });
  assert.equal(quiet.waitP95Ms, null, 'no request from a person: no p95, not a p95 of 0');
  assert.equal(quiet.refused, 0, 'measured and none: that is a real 0');
});

// Regression: spreadsheet formula injection through an export — a path or index name that
// starts with = + - @ is written as text; a negative number is still a number.
const { csvEscape, toCsv } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/fmt.js')).href);
test('an export never hands a spreadsheet a formula', () => {
  assert.equal(csvEscape('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvEscape('+1 (555) 1234'), "'+1 (555) 1234");
  assert.equal(csvEscape('@cmd'), "'@cmd");
  assert.equal(csvEscape('-5'), '-5'); assert.equal(csvEscape(-5.5), '-5.5');
  assert.equal(csvEscape('/_search?q=x'), '/_search?q=x');
  const out = toCsv([{ path: '=1+1', ms: '-3' }], ['path', 'ms']);
  assert.equal(out.split('\n')[1], "'=1+1,-3");
});
