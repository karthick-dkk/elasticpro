/**
 * The report kinds' adapter (core/report-types.js, docs/REPORT-TYPES.md): schedule defaults
 * per kind, the 5-cluster cap, month ranges, and a HOSTS_QUERY reply where an absent figure
 * stays null (not measured), never 0. Pure; jsdom only because core/reports.js sits beside DOM code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'customElements', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/report-types.js')).href);

test('defaults per kind: Indices daily 08:00, Volume by host daily 06:00, both month so far, off', () => {
  const i = T.scheduleOf('indices', { ok: true });
  assert.deepEqual([i.schedule, i.at, i.period, i.enabled], ['daily', '08:00', 'monthSoFar', false]);
  const hs = T.scheduleOf('hosts', { ok: true });
  assert.deepEqual([hs.schedule, hs.at, hs.period, hs.enabled], ['daily', '06:00', 'monthSoFar', false]);
  assert.equal(T.scheduleOf('volume', { ok: true }).period, 'cadence');
});

test('a locked field is read from field names and config.txt keys', () => {
  const s = T.scheduleOf('hosts', { ok: true, managed: ['UI_REPORT_HOSTS_TO', 'UI_REPORT_HOSTS_AT', 'schedule', 'UI_REPORT_TO'] });
  assert.deepEqual([...s.managed].sort(), ['at', 'schedule', 'to']);
});

test('Volume by host takes at most 5 clusters', () => {
  assert.equal(T.runProblem('hosts', ['a', 'b', 'c', 'd', 'e']), '');
  assert.match(T.runProblem('hosts', ['a', 'b', 'c', 'd', 'e', 'f']), /at most 5/);
  assert.equal(T.runProblem('indices', ['a', 'b', 'c', 'd', 'e', 'f']), '');
  assert.match(T.runProblem('indices', []), /at least one/);
  assert.match(T.runFailText({ kind: 'too_many_clusters' }), /at most 5/);
});

test('month so far ends yesterday; a past month is whole; the 1st shows its own day', () => {
  assert.deepEqual(T.monthRange('2026-11', '2026-11-04'), { from: '2026-11-01', to: '2026-11-03' });
  assert.deepEqual(T.monthRange('2026-10', '2026-11-04'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(T.monthRange('2026-02', '2026-11-04'), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(T.monthRange('2026-11', '2026-11-01'), { from: '2026-11-01', to: '2026-11-01' });
});

test('HOSTS_QUERY: a missing figure is null, not 0; fields and incomplete days pass through', () => {
  const r = T.hostsOf({ ok: true, rows: [{ day: '2026-11-01', index: 'a-2026.11.01', host: 'h1', docs: 5, eventBytes: null, meta: { zone: 'x' } }],
    total: 1, totals: { docs: 5 }, incompleteDays: ['2026-11-02'], fields: ['zone'], notInMapping: ['tag1'] });
  assert.equal(r.rows[0].eventBytes, null);
  assert.equal(r.rows[0].subBytes, null);
  assert.equal(r.totals.eventBytes, null);
  assert.deepEqual([r.incompleteDays, r.fields, r.notInMapping], [['2026-11-02'], ['zone'], ['tag1']]);
  assert.equal(T.hostsOf(null).total, 0);
  assert.equal(T.sortKey('docs', 'desc'), 'docs:desc');
});

test('config.txt hosts keys: not reported stays unknown, locked ones are marked', () => {
  assert.equal(T.configOf(undefined), null);
  const rows = T.configOf({ fields: ['zone', 'tag1'], keepMonths: 3, managed: ['UI_REPORT_HOSTS_KEEP_MONTHS'] });
  const by = Object.fromEntries(rows.map((x) => [x.key, x]));
  assert.equal(by.fields.value, 'zone, tag1');
  assert.equal(by.keepMonths.locked, true);
  assert.equal(by.branchDefault.known, false);
});

test('HOSTS_QUERY as the core answers it: filled ClientID/branch, days, fill, and the fields the core fills', () => {
  const r = T.hostsOf({ ok: true, fields: ['zone', 'ClientID', 'branch'], fill: { clientId: 'C-1', branchDefault: 'DC' },
    rows: [{ day: '2026-11-01', index: 'a', host: 'h', docs: 3, eventBytes: 10, subBytes: null, eventMissingDocs: 2, clientId: 'C-1', branch: 'DC', incomplete: true, meta: { ClientID: 'C-1' } }],
    total: 1, totals: { docs: 3, eventBytes: 10, subBytes: null },
    days: [{ day: '2026-11-01', held: true, incomplete: true, rows: 1, notes: [], failed: null },
      { day: '2026-11-02', held: false, incomplete: false, rows: null, notes: [], failed: 'HTTP 503', collecting: false },
      { day: '2026-11-03', held: false, incomplete: false, rows: null, notes: [], failed: null, collecting: true }] });
  const row = r.rows[0];
  assert.deepEqual([row.clientId, row.branch, row.eventMissingDocs, row.incomplete], ['C-1', 'DC', 2, true]);
  assert.deepEqual(r.incompleteDays, ['2026-11-01'], 'from days[] when incompleteDays is absent');
  assert.deepEqual(r.failedDays.map((d) => [d.day, d.failed]), [['2026-11-02', 'HTTP 503']]);
  assert.deepEqual(r.collectingDays.map((d) => d.day), ['2026-11-03']);
  assert.equal(r.days[1].rows, null, 'a day not held has no row count, not 0');
  assert.deepEqual([r.clientIdField, r.branchField], ['ClientID', 'branch']);
  assert.deepEqual(r.fill, { clientId: 'C-1', branchDefault: 'DC' });
  assert.equal(T.hostsOf({ ok: true, fields: ['zone', 'cid'], clientIdField: 'cid' }).clientIdField, 'cid', 'the reply names its field when it does');
  assert.equal(T.hostsOf({ ok: true, fields: ['zone'] }).clientIdField, null);
});

test('an indices/hosts job: a line per cluster, failed clusters with why, concurrency only while reading', () => {
  const job = { reportKind: 'hosts', clusterIds: ['a', 'b', 'c'], status: 'running',
    progress: { done: 1, total: 3, clusters: {
      a: { state: 'collecting', day: '2026-11-03', pages: 40, rows: 900, retries: 1, concurrency: 3, partitions: { done: 1, total: 3 }, halvings: 1, lastReason: 'HTTP 429', days: { done: 2, total: 3 } },
      b: { state: 'waiting', day: null, pages: 0, rows: 0, retries: 0, concurrency: 0, partitions: { done: 0, total: 0 }, halvings: 0, lastReason: null, days: { done: 0, total: 0 } } } },
    failedClusters: [{ clusterId: 'c', reason: 'connection refused' }] };
  const lines = T.jobClusterLines(job, (id) => id.toUpperCase());
  assert.deepEqual(lines.map((l) => [l.id, l.name, l.state]), [['a', 'A', 'collecting'], ['b', 'B', 'waiting'], ['c', 'C', 'failed']]);
  assert.equal(lines[1].concurrency, null, 'a waiting cluster has no concurrency to show');
  assert.equal(T.clusterLineText(lines[0]), 'collecting · day 2026-11-03 · 2 of 3 days · 1/3 partitions · 40 pages · 3 at once · halved 1× (HTTP 429) · 1 retry');
  assert.equal(T.clusterLineText(lines[1]), 'waiting');
  assert.equal(T.clusterLineText(lines[2]), 'failed: connection refused');
  assert.deepEqual(T.jobClusterLines({ progress: { done: 1, total: 2 } }), [], 'a volume job has no cluster lines');
  assert.equal(T.jobKindLabel(job), 'Volume by host');
  assert.equal(T.jobKindLabel({}), 'Volume report');
});

test("the worker's refusals are said as the core says them, and are amber", () => {
  const down = { ok: false, kind: 'worker_unavailable', message: 'the report worker is not running' };
  assert.equal(T.isWorkerRefusal(down), true);
  assert.equal(T.runFailText(down), 'the report worker is not running');
  assert.match(T.workerRefusalText({ ok: false, kind: 'worker_version' }), /different ElasticPro version/);
  assert.equal(T.isWorkerRefusal({ ok: false, kind: 'bad_request' }), false);
  assert.equal(T.workerOf(undefined), null);
  assert.deepEqual(T.workerOf({ state: 'down', heartbeatAt: 5, text: 'not running' }), { state: 'down', heartbeatAt: 5, text: 'not running', ok: false });
  assert.equal(T.scheduleOf('hosts', { ok: true, worker: { state: 'up', heartbeatAt: 1 } }).worker.ok, true);
});
