/**
 * A device whose log types the last run did not read is never drawn or written as on time, and the
 * browser reads a bucket's log types as the core does (0.3.90 review).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const R = await import(url('ui/js/core/logdelay-report.js'));
const L = await import(url('ui/js/core/log-delay.js'));
const S = await import(url('ui/js/core/state.js'));
const D = await import(url('ui/js/core/delay-levels.js'));

test('not read by log types, or not since: the core’s words, never "on time"', () => {
  const unread = { state: 'no_delay', typesUnread: 3, stateText: 'on time; log types not read in this run (3 devices over the limit)' };
  assert.equal(R.rowStateText(unread), unread.stateText);
  assert.equal(R.typesNotRead(unread), true);
  assert.equal(R.typesNotRead({ ...unread, state: 'critical' }), false, 'known late stays late');
  assert.equal(R.rowStateText({ state: 'no_delay', stale: true, stateText: 'on time when last measured 10:00, not measured since' }), 'on time when last measured 10:00, not measured since');
  assert.equal(R.rowStateText({ state: 'part_delay', stateText: 'part delayed — 1 of 3 log types late: threat' }), 'part delayed');
  assert.equal(R.typesNotRead({ state: 'no_delay', typesUnread: null }), false);
});

const src = (min, type) => ({ '@timestamp': '2026-11-24T12:00:00Z', event_created: new Date(Date.parse('2026-11-24T12:00:00Z') - min * 60000).toISOString(), ...(type === undefined ? {} : { log_type: type }) });
const latest = (min, type) => ({ hits: { hits: [{ _source: src(min, type) }] } });
const resolved = { device: 'd', arrival: '@timestamp', eventCandidates: ['event_created'], event: 'event_created', logType: 'log_type', metadata: [] };
const levels = { delayFrom: 30, criticalOver: 60 };
const bucket = (types, none) => ({ key: 'fw', doc_count: 9, latest: latest(1, 'traffic'), types: { sum_other_doc_count: 0, buckets: types }, no_type: none });

test('a blank log type is no log type, and one outside the aggregation is the type its document names', () => {
  const b = L.recordFrom(bucket([{ key: 'traffic', doc_count: 4, latest: latest(1, 'traffic') }, { key: ' ', doc_count: 1, latest: latest(1, ' ') }], { doc_count: 2, latest: latest(1) }), resolved, levels);
  assert.deepEqual(b.types.map((t) => [t.label, t.docs]).sort(), [['(no log type)', 3], ['traffic', 4]]);
  assert.equal(b.typesTruncated, false);
  const stray = L.recordFrom(bucket([{ key: 'traffic', doc_count: 4, latest: latest(1, 'traffic') }], { doc_count: 2, latest: latest(1, 'traffic') }), resolved, levels);
  assert.deepEqual(stray.types.map((t) => [t.label, t.docs]), [['traffic', 6]]);
  assert.equal(stray.typesTruncated, true, 'the list may not be whole');
});

test('Play’s reading without log types does not replace the server’s by log types', async () => {
  S.state.config = { clusters: [{ id: 'c1', name: 'vm-1', enabled: true }] };
  S.state.data.set('c1', { reachable: true });
  D.forgetLevels();
  const at = Date.now() - 10 * 60000;
  const answer = (logTypes) => ({ ok: true, everyHours: 2, byCluster: [{ id: 'c1', lastRunAt: at, delay: 0, critical: 0, devices: 10, partDelayed: 3, logTypes, levels }] });
  await D.loadServerRuns({ send: async () => answer({ total: 30, late: 3, above: 0 }) });
  const alerts = () => S.alerts().filter((a) => a.key === 'c1:log-delay');
  assert.match(alerts()[0].title, /3 .*part/i);
  S.setDelaySummary('c1', L.summarise([{ device: 'a', status: 'CRITICAL', delayMinutes: 95 }]));
  assert.match(alerts()[0].title, /3 .*part/i, 'the newest documents cannot say part delayed');
  S.setDelaySummary('c1', L.summarise([{ device: 'a', status: 'CRITICAL', delayMinutes: 95, types: [{ label: 'x', status: 'CRITICAL', state: 'critical', delayMinutes: 95 }] }]));
  assert.doesNotMatch(alerts()[0].title, /part/i, 'a newer reading by log types does');
  D.forgetLevels();
  await D.loadServerRuns({ send: async () => answer(null) });
  S.setDelaySummary('c1', L.summarise([{ device: 'a', status: 'CRITICAL', delayMinutes: 95 }]));
  assert.match(alerts()[0].title, /over 60 min/, 'a cluster without log types: the newer reading, as before');
});

test('only what was measured is shaded, drawn and counted (0.3.91)', () => {
  const H = 3600000;
  const p = { started: 0, solved: null, ended: 10 * H, lastedMs: 10 * H, measuredMs: 3 * H, worstState: 'critical', spans: [[0, 2 * H], [9 * H, 10 * H]] };
  assert.deepEqual(R.periodBands(p, 0, 10 * H).map((b) => [b.left, b.width, b.critical]), [[0, 20, true], [90, 10, true]]);
  assert.equal(R.periodBands({ ...p, spans: undefined }, 0, 10 * H).length, 1, 'a core before: the period whole');
  assert.deepEqual(R.periodBands({ ...p, spans: [] }, 0, 10 * H), []);
  assert.equal(R.lastedText(10 * H, 3 * H), '10 h 00 min · 3 h 00 min measured');
  assert.equal(R.lastedText(10 * H, 10 * H), '10 h 00 min');
  assert.equal(R.lastedText(10 * H, undefined), '10 h 00 min');
  const pts = [{ t: 0, m: 40 }, { t: H, m: 41 }, { t: 8 * H, m: 42 }, { t: 9 * H, m: 43 }];
  assert.equal(R.deviceGraph(pts, { fromMs: 0, toMs: 9 * H, gapMs: 1.5 * H }).segments.length, 2, 'no line over 1 h–8 h');
  assert.equal(R.deviceGraph(pts, { fromMs: 0, toMs: 9 * H }).segments.length, 1);
});
