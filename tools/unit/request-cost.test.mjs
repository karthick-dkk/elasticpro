/**
 * Jobs › Requests › Cost, the pure half (ui/js/core/request-cost.js, docs/JOBS.md "Query cost"):
 * a figure the core did not send stays unknown — "—" or "not reported", never 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const C = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/request-cost.js')).href);

test('times, bytes and requests per hour read as words; unknown stays unknown', () => {
  assert.deepEqual([C.msText(85), C.msText(1234), C.msText(30000), C.msText(65000), C.msText(null)], ['85 ms', '1.2 s', '30 s', '1m 05s', '—']);
  assert.deepEqual([C.bytesText(812), C.bytesText(4200), C.bytesText(null)], ['812 B', '4.1 KB', 'not reported']);
  assert.deepEqual([C.perHourText(12.4), C.perHourText(0.44), C.perHourText(null)], ['12', '0.4', '—']);
});

test('rows keep the core\'s figures, add names, and the totals add up', () => {
  const answer = { ok: true, keepHours: 24, hours: 24, rows: [
    { cluster: 'a', kind: 'poller:health', label: 'Poller · health', requests: 20, perHour: 0.8, avgMs: 120, p95Ms: 200, bytes: 1000, timeouts: 1, deferrals: 0 },
    { cluster: 'b', kind: 'job:hosts.collect', label: 'Hosts collection', requests: 0, perHour: 0, avgMs: null, p95Ms: null, bytes: null, timeouts: 0, deferrals: 2 },
  ], top: [{ at: 1, cluster: 'a', kind: 'poller:health', method: 'GET', path: '/_cluster/health', ms: 30000, bytes: null }] };
  const rows = C.costRows(answer, (id) => id.toUpperCase());
  assert.deepEqual(rows.map((r) => [r.name, r.avgMs, r.bytes]), [['A', 120, 1000], ['B', null, null]]);
  assert.deepEqual(C.costTotals(rows), { requests: 20, timeouts: 1, deferrals: 2, clusters: 2 });
  assert.equal(C.windowText(answer), 'over the last 24 h');
  assert.equal(C.windowText({ keepHours: 24, hours: 2.5, since: 0 }, () => '09:14'), 'since 09:14 (2.5 h)');
  assert.equal(C.topRows(answer, (id) => `n-${id}`)[0].name, 'n-a');
  assert.deepEqual(C.costRows(null), []);
});

test('a partial row says since when; the shared overflow row is "several clusters" and no cluster in the count', () => {
  const answer = { ok: true, rows: [
    { cluster: 'a', kind: 'job:hosts.collect', requests: 5000, partialSince: 1000 },
    { cluster: 'a', kind: 'poller:health', requests: 10, partialSince: null },
    { cluster: '', kind: 'other', requests: 3 },
  ] };
  const rows = C.costRows(answer, (id) => `name-${id}`);
  assert.equal(C.partialText(rows[0], () => '14:05'), 'partial — worker kept requests since 14:05');
  assert.equal(C.partialText(rows[1]), '', 'a row that covers the window says nothing');
  assert.equal(rows[2].name, C.OVERFLOW_NAME);
  assert.equal(C.costTotals(rows).clusters, 1, 'the overflow row is not a cluster');
});
