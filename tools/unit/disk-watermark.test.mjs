/**
 * Where a cluster's disk use stands against ITS OWN watermarks (core/disk-balance.js
 * diskAgainstWatermarks) — the one answer the Clusters page's bar, its tick, its tooltip and
 * its CSV all read. The cases that matter are the ones where a guess would pass for a
 * measurement: settings never read, settings read and nothing set, and a watermark written
 * as free space ("50gb") that must never be taken for a percentage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { diskAgainstWatermarks: W, watermarks } = await imp('ui/js/core/disk-balance.js');
const { diskUseText } = await imp('ui/js/lib/fmt.js');

const GB = 1024 ** 3;
const disk = (percent, used = 0, total = 0) => ({ percent, used, total });
const K = (n) => `cluster.routing.allocation.disk.watermark.${n}`;
/** A `_cluster/settings?include_defaults=true&flat_settings=true` answer. */
const settings = ({ persistent = {}, transient = {}, defaults = { [K('low')]: '85%', [K('high')]: '90%', [K('flood_stage')]: '95%' } } = {}) =>
  ({ persistent, transient, defaults });

test('set as percentages on the cluster: those, and the level follows them', () => {
  const s = settings({ persistent: { [K('low')]: '70%', [K('high')]: '80%' } });
  const at = (p) => W(disk(p), s);
  assert.deepEqual([at(40).level, at(69.9).level, at(70).level, at(79.9).level, at(80).level, at(99).level], ['ok', 'ok', 'low', 'low', 'high', 'high']);
  const w = at(75);
  assert.deepEqual([w.known, w.low, w.high, w.source, w.label], [true, 70, 80, 'set', 'above low']);
  assert.equal(at(85).label, 'above high');
  assert.equal(at(10).label, 'below low');
});

test('a ratio is a percentage too', () => {
  const w = W(disk(50), settings({ persistent: { [K('low')]: '0.6', [K('high')]: '0.75' } }));
  assert.deepEqual([w.low, w.high, w.known], [60, 75, true]);
});

test('set as free space ("50gb") is unknown — never read as a percentage, never the default', () => {
  const s = settings({ persistent: { [K('low')]: '100gb', [K('high')]: '50gb', [K('flood_stage')]: '20gb' } });
  const w = W(disk(95, 95 * GB, 100 * GB), s);
  assert.equal(w.known, false);
  assert.equal(w.level, 'unknown');
  assert.equal(w.label, 'unknown');
  assert.equal(w.high, null);
  assert.match(w.why, /low watermark is set as free space \(100gb\), not a percentage/);
  // Only the high one in bytes: still unknown, and it is the high one that is named.
  const w2 = W(disk(50), settings({ persistent: { [K('high')]: '50gb' } }));
  assert.equal(w2.known, false);
  assert.match(w2.why, /high watermark is set as free space \(50gb\)/);
  // The weaker scope's "90%" does not stand in for it.
  assert.equal(w2.high, null);
  // The old reader fell through to the default for it; the figures it hands the alert text still do.
  assert.equal(watermarks(settings({ persistent: { [K('high')]: '50gb' } })).high, 90);
});

test('settings never read: unknown, no thresholds, and it says which data would give them', () => {
  for (const s of [null, undefined, 'x', 7]) {
    const w = W(disk(88), s);
    assert.deepEqual([w.known, w.level, w.low, w.high, w.flood], [false, 'unknown', null, null, null]);
    assert.match(w.why, /_cluster\/settings/);
    assert.match(w.why, /policies/);
    assert.match(w.why, /Read all/);
    assert.equal(w.percent, 88, 'the usage itself is still a measurement');
  }
});

test('read and set nowhere: Elasticsearch’s documented 85 / 90 / 95 %', () => {
  const w = W(disk(86), {});                                  // read, and the answer had nothing in it
  assert.deepEqual([w.known, w.low, w.high, w.flood, w.source, w.level], [true, 85, 90, 95, 'default', 'low']);
  const w2 = W(disk(50), { persistent: {}, transient: {} });
  assert.deepEqual([w2.known, w2.high, w2.source, w2.level], [true, 90, 'default', 'ok']);
});

test('read with include_defaults and not changed: the cluster’s own defaults, said as such', () => {
  const w = W(disk(91), settings());
  assert.deepEqual([w.known, w.low, w.high, w.source, w.level], [true, 85, 90, 'reported-default', 'high']);
  // A cluster whose defaults differ (they do, between versions) is believed over our table.
  const w2 = W(disk(91), settings({ defaults: { [K('low')]: '88%', [K('high')]: '95%' } }));
  assert.deepEqual([w2.low, w2.high, w2.level], [88, 95, 'low']);
});

test('transient beats persistent beats the defaults', () => {
  const s = settings({ persistent: { [K('high')]: '92%' }, transient: { [K('high')]: '96%' } });
  assert.equal(W(disk(50), s).high, 96);
  assert.equal(W(disk(50), settings({ persistent: { [K('high')]: '92%' } })).high, 92);
});

test('nested (non-flat) settings read the same', () => {
  const s = { persistent: { cluster: { routing: { allocation: { disk: { watermark: { low: '60%', high: '70%' } } } } } } };
  const w = W(disk(65), s);
  assert.deepEqual([w.low, w.high, w.level, w.source], [60, 70, 'low', 'set']);
});

test('a usage that is not known stays unknown even with known watermarks', () => {
  for (const d of [null, undefined, {}, { percent: NaN }, { percent: null }]) {
    const w = W(d, settings());
    assert.equal(w.percent, null);
    assert.equal(w.level, 'unknown');
    assert.equal(w.known, true, 'the thresholds are still known');
  }
});

test('disk use is written once: "56 % · 156 of 279 GB"', () => {
  assert.equal(diskUseText(disk(55.9, 156 * GB, 279 * GB)), '56 % · 156 of 279 GB');
  assert.equal(diskUseText(disk(5, 512 * 1024 ** 2, 100 * GB)), '5 % · 512 MB of 100 GB', 'units differ: both said');
  assert.equal(diskUseText(null), '');
  assert.equal(diskUseText({ percent: NaN }), '');
});
