/**
 * The fleet wall's order (docs/PLAY.md "Fleet wall order"): each key largest first, a cluster
 * with no figure after every cluster that has one (never 0), the name as the last tie-break,
 * and the default when a display has nothing usable saved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator', 'matchMedia']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const F = await import(url('ui/js/play/fleet.js'));
const P = await import(url('ui/js/core/play-config.js'));
const A = await import(url('ui/js/play/api.js'));

/** One cluster's inputs: rank, fullest disk %, worst delay (min), yesterday's bytes, open alerts. */
const mk = (rows) => {
  const clusters = rows.map((r) => ({ id: r.id, name: r.name || r.id }));
  const ctx = {
    st: new Map(rows.map((r) => [r.id, { rank: r.rank ?? 0, fullest: r.disk === undefined ? null : { pct: r.disk } }])),
    delay: new Map(rows.filter((r) => r.delay !== undefined).map((r) => [r.id, { summary: { worst: r.delay === null ? null : { delayMinutes: r.delay } } }])),
    volume: new Map(rows.filter((r) => r.vol !== undefined).map((r) => [r.id, { reply: r.vol === null ? null : { cards: { yesterday: { bytes: r.vol } } } }])),
    openBy: new Map(rows.map((r) => [r.id, Array.from({ length: r.alerts || 0 }, () => ({ level: 'warning' }))])),
  };
  return { clusters, ctx };
};
const ids = (rows, order) => { const { clusters, ctx } = mk(rows); return F.orderFleet(ctx, clusters, order).map((c) => c.id); };

test('each key sorts largest first; name sorts A to Z', () => {
  const rows = [{ id: 'a', rank: 1, disk: 50, delay: 5, vol: 300, alerts: 0 }, { id: 'b', rank: 40, disk: 80, delay: 90, vol: 100, alerts: 2 }, { id: 'c', rank: 20, disk: 65, delay: 30, vol: 900, alerts: 1 }];
  assert.deepEqual(ids(rows, ['critical']), ['b', 'c', 'a']);
  assert.deepEqual(ids(rows, ['logDelay']), ['b', 'c', 'a']);
  assert.deepEqual(ids(rows, ['volume']), ['c', 'a', 'b']);
  assert.deepEqual(ids(rows, ['disk']), ['b', 'c', 'a']);
  assert.deepEqual(ids(rows, ['alerts']), ['b', 'c', 'a']);
  assert.deepEqual(ids(rows, ['name']), ['a', 'b', 'c']);
});

test('the next key breaks a tie, and the name breaks the last one', () => {
  const rows = [{ id: 'x', name: 'zeta', rank: 40, delay: 10 }, { id: 'y', name: 'alpha', rank: 40, delay: 10 }, { id: 'z', name: 'mid', rank: 40, delay: 70 }, { id: 'w', name: 'low', rank: 0, delay: 500 }];
  assert.deepEqual(ids(rows, ['critical', 'logDelay']), ['z', 'y', 'x', 'w'], 'rank, then delay, then name');
  assert.deepEqual(ids(rows, ['logDelay', 'critical']), ['w', 'z', 'y', 'x']);
});

test('a cluster whose figure is unknown goes after every one that has it, never as 0', () => {
  const rows = [{ id: 'none', name: 'aaa' }, { id: 'zero', name: 'bbb', delay: 0, vol: 0 }, { id: 'big', name: 'ccc', delay: 40, vol: 5 }, { id: 'nul', name: 'ddd', delay: null, vol: null }];
  assert.deepEqual(ids(rows, ['logDelay']), ['big', 'zero', 'none', 'nul'], 'a measured 0 min beats not measured');
  assert.deepEqual(ids(rows, ['volume']), ['big', 'zero', 'none', 'nul']);
  assert.deepEqual(ids(rows, ['disk']), ['none', 'zero', 'big', 'nul'], 'no disk read for any: all unknown, so by name');
  // unknown on the first key still sorts by the second among themselves
  assert.deepEqual(ids([{ id: 'u1', name: 'b', alerts: 1 }, { id: 'u2', name: 'a', alerts: 3 }, { id: 'k', name: 'z', disk: 10 }], ['disk', 'alerts']), ['k', 'u2', 'u1']);
});

test('the default is critical, log delay, volume; anything unusable falls back to it', () => {
  const d = ['critical', 'logDelay', 'volume'];
  assert.deepEqual(P.readFleetOrder(undefined), d);
  assert.deepEqual(P.readFleetOrder([]), d);
  assert.deepEqual(P.readFleetOrder(['nope']), d);
  assert.deepEqual(P.readFleetOrder(['disk', 'disk', 'bogus', 'name', 'alerts', 'volume']), ['disk', 'name', 'alerts']);
  assert.deepEqual(P.displaySettings({}).fleetOrder, d);
  assert.deepEqual(P.settingsPayload({ fleetOrder: ['name'] }).fleetOrder, ['name']);
  assert.deepEqual(A.defaultPlayState().display.fleetOrder, d);
  assert.deepEqual(A.readPlayState({ settings: { display: { fleetOrder: ['alerts', 'name'] } } }).display.fleetOrder, ['alerts', 'name']);
  const rows = [{ id: 'a', rank: 1 }, { id: 'b', rank: 9 }];
  assert.deepEqual(ids(rows, undefined), ['b', 'a'], 'a person without a display link');
  assert.equal(F.orderText(['critical', 'logDelay']), 'Critical problems › Log delay');
});
