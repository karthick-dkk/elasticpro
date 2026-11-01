/**
 * Reading Play's core replies (ui/js/play/api.js) and the small helpers beside it: the
 * settings shape PLAY_STATE sends (with defaults for an older core), the shared cache and
 * ACK_LIST in either shape, the display secret in the address, cluster kind defaults, the
 * snapshot filters and the shared delay record's 24 h peak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const A = await import(url('ui/js/play/api.js'));
const K = await import(url('ui/js/core/cluster-kind.js'));
const S = await import(url('ui/js/play/snapshots.js'));
const M = await import(url('ui/js/play/measure.js'));

test('PLAY_STATE: the documented shape is read, and an empty reply is the defaults', () => {
  const d = A.defaultPlayState();
  assert.equal(d.watch.delayYellowFromMin, 30);
  assert.equal(d.watch.delayRedAboveMin, 60);
  assert.deepEqual(d.watch.spotlight.when, ['red', 'nodeLeft', 'slmFailed', 'storage', 'unreachable', 'criticalAlert']);
  assert.deepEqual(d.display.slides, ['fleet', 'alerts', 'spotlight', 'delay', 'backups', 'volume']);
  assert.equal(d.display.criticalTakesScreen, true);
  assert.equal(d.excluded.size, 0);

  const r = A.readPlayState({ ok: true, now: 1793000000000,
    settings: {
      watch: { delayYellowFromMin: 20, delayRedAboveMin: 45, nodeBlink: 'off', spotlight: { when: ['red', 'yellow'], perClusterSec: 10, leaveAfterMin: 5, whenEmpty: 'everyCluster' } },
      display: { slides: [{ id: 'alerts', show: true, dwellSec: 30 }, { id: 'fleet', show: false }, { id: 'delay', show: true }, { id: 'nope' }],
        criticalTakesScreen: false, spotlightAll: true, zoom: null, sound: 'off' },
    },
    // The core's PLAY_STATE: `zoom` at the top is what this display shows at (its TV's last − / +).
    zoom: 1.25,
    excluded: ['c9', { clusterId: 'c8', reason: 'lab' }], nodes: { c1: { expected: ['a', 'b'], present: ['a'], left: [{ node: 'b', since: 1 }] } },
    openSince: { 'c1:disk': 5 } });
  assert.equal(r.watch.delayYellowFromMin, 20);
  assert.equal(r.watch.nodeBlink, 'off');
  assert.equal(r.watch.spotlight.whenEmpty, 'everyCluster');
  assert.deepEqual(r.display.slides, ['alerts', 'delay'], 'hidden and unknown slides are left out, in the display’s order');
  assert.equal(r.display.slideDwell.alerts, 30);
  assert.equal(r.display.slideDwell.delay, 20);
  assert.equal(r.display.criticalTakesScreen, false);
  assert.equal(r.display.spotlightAll, true);
  assert.equal(r.display.zoom, null);
  assert.equal(r.display.lastZoom, 1.25);
  assert.equal(r.display.zoomFixed, false);
  assert.deepEqual([...r.excluded].sort(), ['c8', 'c9']);
  assert.equal(r.nodes.c1.left[0].node, 'b');
  assert.equal(r.openSince['c1:disk'], 5);
  assert.equal(r.now, 1793000000000);
  assert.equal(A.readPlayState({ settings: { display: { zoom: 1.1 } } }).display.zoomFixed, true);
  assert.equal(r.display.sound, 'off', 'the core says "off": no chime (a non-empty string is not "on")');
  assert.equal(A.readPlayState({ settings: { display: { sound: 'chime' } } }).display.sound, 'chime');
});

test('shared cache and ACK_LIST are read as a list or a map; the newest record per cluster wins', () => {
  const list = A.readShare({ ok: true, records: [
    { clusterId: 'a', measuredAt: 10, data: { x: 1 } }, { clusterId: 'a', measuredAt: 20, data: { x: 2 } }, { clusterId: 'b', measuredAt: 'nonsense' }] });
  assert.equal(list.get('a').data.x, 2);
  assert.ok(!list.has('b'), 'a record with no time is not a measurement');
  const map = A.readShare({ ok: true, byCluster: { c: { measuredAt: 5, data: { bytes: 7 } } } });
  assert.equal(map.get('c').data.bytes, 7);
  assert.equal(A.readShare({ ok: false }).size, 0);
  assert.equal(A.readAcks, undefined, 'Play keeps no reading of ACK_LIST of its own: acks.js is the one definition');
});

test('the display secret comes out of #/play?display=…, and the page id never carries a query', () => {
  assert.equal(A.displaySecretOf('#/play?display=abc.DEF-123'), 'abc.DEF-123');
  assert.equal(A.displaySecretOf('#/play'), '');
  assert.equal(A.displaySecretOf('#/alerts?display=x'), '');
  assert.equal(A.pageOfHash('#/play?display=x'), 'play');
  assert.equal(A.pageOfHash('#/overview'), 'overview');
  assert.equal(A.pageOfHash(''), '');
});

test('cluster kind: CI / DI → ULM on, SLM none; On-Prem and unset → SLM expected', () => {
  // The fields Play reads (cluster-kind.js returns more: label, set, source).
  const ci = K.clusterKind({ type: 'CI' });
  assert.deepEqual([ci.type, ci.label, ci.ulm.enabled, ci.slmExpected], ['ci', 'CI', true, false]);
  assert.ok(!ci.ulm.bucket, 'no bucket set reads as empty, never as a name');
  const unset = K.clusterKind({});
  assert.deepEqual([unset.type, unset.label, unset.ulm.enabled, unset.slmExpected], ['onprem', 'On-Prem', false, true]);
  assert.equal(K.clusterKind({ type: 'di', ulm: { enabled: true, bucket: 'logs-di' } }).ulm.bucket, 'logs-di');
  assert.equal(K.slmExempt({ type: 'DI' }), true);
  assert.equal(K.slmExempt({ type: 'DI', slm: 'expected' }), false);
  assert.equal(K.slmExempt({ type: 'On-Prem', ulm: { enabled: true } }), false);
});

test('snapshot filters: last good, failures in a window, unknown is not "none"', () => {
  const now = 100 * 3600000;
  const d = { repos: [{ name: 'r' }], reachable: true, snapshots: { r: [
    { id: 's3', status: 'PARTIAL', start: now - 3600000, end: now - 3000000, failed: 2, total: 10 },
    { id: 's2', status: 'SUCCESS', start: now - 30 * 3600000, end: now - 29 * 3600000 },
    { id: 's1', status: 'FAILED', start: now - 50 * 3600000, end: now - 49 * 3600000 }] } };
  assert.equal(S.lastGood(d).id, 's2');
  assert.deepEqual(S.failuresSince(d, now - 86400000).map((s) => s.id), ['s3']);
  assert.equal(S.backedUpWithin(d, 26 * 3600000, now), false);
  assert.equal(S.backedUpWithin(d, 30 * 3600000, now), true);
  assert.equal(S.backedUpWithin({ repos: [{ name: 'r' }], snapshots: {} }, 1, now), null, 'a listing not read is unknown');
  assert.equal(S.listingState(null), 'unknown');
  assert.equal(S.listingState({ repos: [], reachable: true }), 'none');
});

test('a shared delay record carries each device’s peak over 24 h', () => {
  const day = 86400000;
  const prev = { records: [{ device: 'fw1', peak24: { value: 90, at: 1000 } }, { device: 'fw2', peak24: { value: 50, at: 0 } }] };
  const out = M.withPeaks([
    { device: 'fw1', delayMinutes: 10 }, { device: 'fw2', delayMinutes: 20 }, { device: 'fw3', delayMinutes: null }], prev, day + 500);
  assert.deepEqual(out[0].peak24, { value: 90, at: 1000 }, 'a higher peak inside 24 h stays');
  assert.deepEqual(out[1].peak24, { value: 20, at: day + 500 }, 'a peak older than a day is forgotten');
  assert.equal(out[2].peak24, null, 'no delay read, no peak — never 0');
  assert.equal(M.withPeaks(Array.from({ length: 2500 }, (_, i) => ({ device: `d${i}`, delayMinutes: 1 })), null, 0).length, M.MAX_RECORDS);
});

test('a shared delay measurement goes as {devices, truncated} (the core\'s shape) and reads back with the server\'s time', () => {
  const recs = [{ device: 'fw-1', delayMinutes: 55 }, { device: 'fw-2', delayMinutes: 2 }];
  const data = M.shareData({ measuredAt: 1, records: recs, truncated: 3 });
  assert.deepEqual(Object.keys(data).sort(), ['devices', 'truncated'], 'never `records`: the core refuses that');
  assert.equal(data.devices.length, 2);
  // what PLAY_SHARE_GET hands back: the record's measuredAt is the server's; one inside data never wins
  const back = M.fromShare({ measuredAt: 500, data: { ...data, measuredAt: 999999 } });
  assert.equal(back.measuredAt, 500);
  assert.equal(back.records[0].device, 'fw-1');
  assert.equal(back.truncated, 3);
  assert.equal(M.fromShare({ measuredAt: 7, data: recs }).records.length, 2, 'a bare list is a measurement too');
  assert.equal(M.fromShare({ measuredAt: 7, data: { records: recs } }), null, 'the old {records} shape is not the contract');
});
