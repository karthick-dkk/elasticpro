/**
 * Jobs › Jobs, the pure half of a job row's result, its expanded details (JOB_RUN_DETAIL) and the
 * *Slow searches now* card (SLOW_SEARCHES) — ui/js/core/job-detail.js, docs/JOBS.md "Run
 * details" and "Slow searches". The totals add up, a deferral is a warning and never an
 * "Error:", and a cluster that was not read is not counted as having no slow search.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/job-detail.js')).href);

const counts = (o) => ({ succeeded: 0, partial: 0, failed: 0, deferred: 0, skipped: 0, ...o });

test('the result names how many clusters did not succeed, of how many', () => {
  assert.deepEqual(D.resultOf({ status: 'completed', parts: counts({ succeeded: 67, partial: 1, failed: 3 }) }),
    { text: 'Partial · 4 of 71 clusters', tone: 'orange', warn: true });
  assert.equal(D.resultOf({ status: 'completed', parts: counts({ succeeded: 71 }) }).text, 'Succeeded · 71 clusters');
  assert.equal(D.resultOf({ status: 'failed', parts: counts({ failed: 3 }) }).text, 'Failed · 3 clusters');
  assert.equal(D.resultOf({ status: 'failed', parts: counts({ failed: 3 }) }).tone, 'red');
  // A busy cluster's deferral: amber, a warning — not red.
  const d = D.resultOf({ status: 'deferred', parts: counts({ deferred: 1 }) });
  assert.deepEqual(d, { text: 'Deferred · 1 cluster', tone: 'orange', warn: true });
  // A run that reported no parts: its status, said plainly.
  assert.equal(D.resultOf({ status: 'completed' }).text, 'Succeeded');
  assert.equal(D.resultOf({ status: 'deferred' }).tone, 'orange');
  assert.equal(D.resultOf({ status: 'running' }).text, 'Running');
  assert.equal(D.resultOf(null).text, '—');
});

test('a deferral under the row is amber words, never "Error:"', () => {
  const run = { status: 'deferred', error: 'ussc is busy: response time 15.7 s exceeded the 8 s threshold; tried again when it eases',
    deferred: { cluster: 'c-ussc', reason: 'response time 15.7 s exceeded the 8 s threshold' }, clusters: ['c-ussc'] };
  const t = D.troubleOf(run, (id) => id.replace('c-', ''));
  assert.equal(t.level, 'warn');
  assert.equal(t.text, 'ussc deferred — response time 15.7 s exceeded the 8 s threshold; retried automatically when it eases (a warning, not a failure)');
  assert.ok(!/Error/.test(t.text));
  const f = D.troubleOf({ status: 'failed', error: 'boom' });
  assert.deepEqual(f, { level: 'err', text: 'Error: boom', title: 'boom' });
  assert.equal(D.troubleOf({ status: 'completed', error: null }), null);
});

test('the summary grid adds up and says what is not known as —', () => {
  const run = { id: 'be9229a1', trigger: 'timer', status: 'completed', startedAt: Date.UTC(2026, 10, 19, 22, 26, 3), endedAt: Date.UTC(2026, 10, 19, 22, 27, 34), records: 16238 };
  const detail = { counts: counts({ succeeded: 67, partial: 1, failed: 3 }), window: [Date.UTC(2026, 10, 19, 20, 26), Date.UTC(2026, 10, 19, 22, 26)] };
  const g = Object.fromEntries(D.summaryCells(run, detail, { tz: 'UTC' }).map(([k, v]) => [k, v]));
  assert.equal(g['Run ID'], 'be9229a1');
  assert.equal(g.Trigger, 'Scheduled');
  assert.equal(g['Start → end'], '22:26:03 → 22:27:34');
  assert.equal(g.Duration, '1m 31s');
  assert.equal(g['Query window'], '20:26 – 22:26');
  assert.equal(Number(g.Clusters), Number(g.Succeeded) + Number(g.Partial) + Number(g.Failed), 'the totals add up');
  assert.equal(g.Clusters, '71');
  assert.equal(g['Records collected'], '16,238');
  assert.equal(g['Success rate'], '94.4 %');
  // No parts, no records: not known, never 0.
  const bare = Object.fromEntries(D.summaryCells({ id: 'x', status: 'completed', startedAt: 1, endedAt: 2 }, null).map(([k, v]) => [k, v]));
  assert.equal(bare['Records collected'], '—');
  assert.equal(bare.Clusters, undefined);
  assert.deepEqual(D.detailTabs(detail).map((t) => t.label), ['Summary', 'Exceptions (4)', 'All clusters (71)', 'Log', 'Run history']);
  assert.deepEqual(D.detailTabs(null).map((t) => t.label), ['Summary', 'Exceptions (—)', 'All clusters (—)', 'Log', 'Run history']);
});

test('exceptions, elapsed and exact times', () => {
  const detail = { parts: [{ cluster: 'a', status: 'failed' }, { cluster: 'b', status: 'succeeded' }, { cluster: 'c', status: 'deferred' }] };
  assert.deepEqual(D.exceptionsOf(detail).map((p) => p.cluster), ['a', 'c']);
  assert.equal(D.partTone('deferred'), 'orange');
  assert.equal(D.partTone('failed'), 'red');
  assert.equal(D.elapsedText(400), '0.4 s');
  assert.equal(D.elapsedText(30000), '30.0 s');
  assert.equal(D.elapsedText(91000), '1m 31s');
  assert.equal(D.elapsedText(null), '—');
  const at = Date.UTC(2026, 10, 19, 22, 26, 3);
  assert.equal(D.exactTime(at, { tz: 'UTC' }), '19 Nov 22:26:03');
  assert.equal(D.exactTime(at, { tz: 'UTC', seconds: false }), '19 Nov 22:26');
  assert.equal(D.exactTime(null), '—');
});

test('the log as text: each line stamped to the millisecond, the gap said', () => {
  const t0 = Date.UTC(2026, 10, 19, 22, 26, 3, 112);
  const detail = { lines: [{ at: t0, level: 'INFO', text: 'run.start' }, { at: t0 + 1395, level: 'ERROR', text: 'demo INDEX_NOT_FOUND' }], linesDropped: 0 };
  assert.equal(D.logText(detail, { tz: 'UTC', runId: 'be9229a1' }),
    '# ElasticPro run be9229a1\n22:26:03.112  INFO   run.start\n22:26:04.507  ERROR  demo INDEX_NOT_FOUND\n');
  const many = { lines: Array.from({ length: 500 }, (_, i) => ({ at: t0 + i, level: 'INFO', text: `l${i}` })), linesDropped: 77 };
  const lines = D.logText(many, { tz: 'UTC' }).trim().split('\n');
  assert.equal(lines.length, 501);
  assert.match(lines[D.LOG_HEAD], /77 lines not kept/);
  assert.equal(D.logFileName('be9229a1'), 'elasticpro-run-be9229a1.txt');
  assert.equal(D.logFileName('../x'), 'elasticpro-run-x.txt');
});

test('slow searches: the tiles, our own labelled, unread clusters never counted as none', () => {
  const answer = { count: 3, searches: [
    { cluster: 'mh', name: 'mswipe-ho', node: 'es-data-3', runningMs: 372_000, taskId: 'n:1', by: 'ElasticPro', opaqueId: 'elasticpro/a/b/mh/1' },
    { cluster: 'mh', name: 'mswipe-ho', node: 'es-data-1', runningMs: 61_000, taskId: 'n:2', opaqueId: 'kibana-7f' },
    { cluster: 'sisa', name: 'sisa', node: 'node-1', runningMs: 160_000, taskId: 'n:3' },
  ], notRead: [{ cluster: 'ussc', why: 'not read: busy: answers over 8 s' }] };
  const t = D.slowTiles(answer, (id) => id);
  assert.deepEqual(t.count, { value: '3', sub: 'on 2 clusters · 1 not read' });
  assert.deepEqual(t.longest, { value: '6m 12s', tone: 'bad', sub: 'mswipe-ho · node es-data-3' });
  assert.equal(t.slowest.value, 'mh');
  assert.equal(t.slowest.sub, '2 long searches · longest 6m 12s');
  const none = D.slowTiles({ count: 0, searches: [], notRead: [{ cluster: 'x', why: 'not read: unreachable' }] });
  assert.equal(none.longest.value, '—');
  assert.equal(none.slowest.sub, 'some clusters not read', 'unknown, not "no cluster is slow"');
  assert.equal(D.slowTiles(null), null);
  assert.equal(D.whoRan(answer.searches[0]), 'ElasticPro');
  assert.equal(D.whoRan(answer.searches[1]), 'kibana-7f');
  assert.equal(D.whoRan(answer.searches[2]), null);
  assert.equal(D.runningText(58_000), '58s');
  assert.equal(D.runningText(160_000), '2m 40s');
  assert.equal(D.runningTone(58_000), '');
  assert.equal(D.runningTone(160_000), 'warn');
  assert.deepEqual(D.SLOW_THRESHOLDS.map(([ms]) => ms), [10_000, 30_000, 60_000, 300_000]);
  assert.equal(D.SLOW_POLL_MS, 30_000);
  const txt = D.searchText({ ...answer.searches[1], query: '{"size":0}', indices: 'logstash-*', action: 'indices:data/read/search' });
  assert.match(txt, /Task: n:2/);
  assert.match(txt, /X-Opaque-Id: kibana-7f/);
  assert.match(txt, /\{"size":0\}$/);
});
