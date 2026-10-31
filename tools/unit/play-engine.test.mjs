/**
 * Play's slide engine (ui/js/play/engine.js): zoom steps, dwell, skipping empty slides
 * (never Alerts), pause, the critical takeover and how it lets go, spotlight membership,
 * the stale "as of", the burn-in shift and the spotlight's 7 → 15 → 30 day chart cycle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const E = await import(pathToFileURL(path.join(ROOT, 'ui/js/play/engine.js')).href);

test('zoom moves in the documented steps and stays inside 80 %…150 %', () => {
  assert.deepEqual([...E.ZOOM_STEPS], [0.8, 0.9, 1, 1.1, 1.25, 1.5]);
  assert.equal(E.zoomStep(1, 1), 1.1);
  assert.equal(E.zoomStep(1.1, 1), 1.25);
  assert.equal(E.zoomStep(1.5, 1), 1.5);
  assert.equal(E.zoomStep(0.8, -1), 0.8);
  assert.equal(E.zoomStep(1.2, 0), 1.25);         // snaps to the nearest step
  assert.equal(E.zoomStep(NaN, 0), 1);
});

test('dwell: dwellSec, per slide when set, and the spotlight per cluster', () => {
  assert.equal(E.dwellMs('fleet', { dwellSec: 20 }), 20000);
  assert.equal(E.dwellMs('fleet', { dwellSec: 20, slideDwell: { fleet: 45 } }), 45000);
  assert.equal(E.dwellMs('spotlight', { dwellSec: 20, perClusterSec: 13, spotlightCount: 3 }), 39000);
  assert.equal(E.dwellMs('spotlight', { dwellSec: 20, perClusterSec: 13, spotlightCount: 0 }), 20000);
});

test('an empty slide is skipped, Alerts never is, and all empty lands on Alerts', () => {
  const order = ['fleet', 'alerts', 'spotlight', 'delay'];
  const empty = new Set(['spotlight']);
  assert.equal(E.nextSlide(order, 1, 1, (id) => empty.has(id)), 3);
  assert.equal(E.nextSlide(order, 3, -1, (id) => empty.has(id)), 1);
  assert.equal(E.nextSlide(order, 0, 1, () => true), 1);
  assert.equal(E.nextSlide(['fleet', 'delay'], 0, 1, () => true), 0);
});

test('the engine turns after the dwell, holds while paused, and the keys move it', () => {
  const empty = new Set();
  const en = E.createEngine({ order: ['fleet', 'alerts', 'delay'], now: 0, isEmpty: (id) => empty.has(id), dwellFor: () => 20000 });
  assert.equal(en.current, 'fleet');
  assert.equal(en.tick(19000), false);
  assert.equal(en.tick(20000), true);
  assert.equal(en.current, 'alerts');
  en.togglePause(21000);
  assert.equal(en.tick(90000), false);
  assert.equal(en.current, 'alerts');
  en.togglePause(100000);                 // 1 s used before the pause; 19 s left
  assert.equal(en.tick(118000), false);
  assert.equal(en.tick(119000), true);
  assert.equal(en.current, 'delay');
  en.next(120000); assert.equal(en.current, 'fleet');
  en.prev(121000); assert.equal(en.current, 'delay');
  empty.add('delay');
  assert.equal(en.tick(121500), true, 'a slide that emptied is left at once');
  assert.equal(en.current, 'fleet');
});

test('critical takeover: not for what was open already; holds until acknowledged, cleared or 5 min', () => {
  let t = E.takeover(null, { open: ['a'], now: 0 });
  assert.equal(t.active, null, 'the first look only learns');
  t = E.takeover(t, { open: ['a', 'b'], now: 1000 });
  assert.deepEqual(t.active, { key: 'b', since: 1000 });
  t = E.takeover(t, { open: ['a', 'b'], now: 1000 + E.TAKEOVER_MS - 1 });
  assert.equal(t.active.key, 'b');
  t = E.takeover(t, { open: ['a', 'b'], now: 1000 + E.TAKEOVER_MS });
  assert.equal(t.active, null, 'five minutes and it lets go');
  t = E.takeover(t, { open: ['a', 'b', 'c'], now: 400000 });
  assert.equal(t.active.key, 'c');
  t = E.takeover(t, { open: ['a', 'b', 'c'], now: 401000, acked: (k) => k === 'c' });
  assert.equal(t.active, null, 'acknowledged lets go');
  t = E.takeover(t, { open: ['a'], now: 402000 });
  t = E.takeover(t, { open: ['a', 'c'], now: 403000 });
  assert.equal(t.active.key, 'c', 'a problem that cleared and came back is new');
  const off = E.takeover(E.takeover(null, { open: [], now: 0 }), { open: ['x'], now: 1, enabled: false });
  assert.equal(off.active, null, 'criticalTakesScreen off');
});

test('spotlight: joins with a reason, stays until 10 min after the last one cleared', () => {
  const ten = 600000;
  let m = E.spotlightMembers(new Map(), new Map([['c1', ['red']], ['c2', []]]), 0, ten);
  assert.deepEqual([...m.keys()], ['c1']);
  m = E.spotlightMembers(m, new Map([['c1', ['red']]]), 60000, ten);   // still red a minute later
  assert.equal(m.get('c1').since, 0);
  m = E.spotlightMembers(m, new Map([['c1', []]]), 65000, ten);        // cleared
  assert.equal(m.get('c1').clearing, true);
  m = E.spotlightMembers(m, new Map(), 60000 + ten - 1, ten);
  assert.ok(m.has('c1'));
  m = E.spotlightMembers(m, new Map(), 60000 + ten, ten);
  assert.ok(!m.has('c1'));
});

test('stale "as of" is older than two refreshes; nothing at all is "none"', () => {
  assert.equal(E.staleness(0, 1000), 'none');
  assert.equal(E.staleness(1000, 1000 + 120000, { refreshMs: 60000 }), 'fresh');
  assert.equal(E.staleness(1000, 1000 + 120001, { refreshMs: 60000 }), 'stale');
  assert.equal(E.staleness(1000, 1000 + 5000, { staleAfterMs: 4000 }), 'stale');
});

test('burn-in moves a few pixels every 10 minutes', () => {
  assert.deepEqual(E.burnShift(0), { x: 0, y: 0 });
  const a = E.burnShift(E.BURN_IN_MS);
  assert.ok(Math.abs(a.x) <= 4 && Math.abs(a.y) <= 4 && (a.x || a.y));
  assert.deepEqual(E.burnShift(E.BURN_IN_MS + 1000), a);
});

test('spotlight phase: a cluster per perClusterSec, chart 7 d (3 s) → 15 d (5 s) → 30 d (5 s)', () => {
  const per = 13000;
  assert.deepEqual(E.spotlightPhase(0, 2, per), { index: 0, days: 7 });
  assert.deepEqual(E.spotlightPhase(2999, 2, per), { index: 0, days: 7 });
  assert.deepEqual(E.spotlightPhase(3000, 2, per), { index: 0, days: 15 });
  assert.deepEqual(E.spotlightPhase(8000, 2, per), { index: 0, days: 30 });
  assert.deepEqual(E.spotlightPhase(13000, 2, per), { index: 1, days: 7 });
  assert.deepEqual(E.spotlightPhase(26000, 2, per), { index: 0, days: 7 });
});
