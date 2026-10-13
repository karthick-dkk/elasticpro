/** The redraw gate (live / pending / manual) and the opening scope — lib/quiet-ui.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const Q = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/quiet-ui.js')).href);

/** A clock and timer the test advances by hand. */
function fakeTime() {
  let t = 0; const timers = new Map(); let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => timers.delete(h),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      t = end;
    },
    armed: () => timers.size,
  };
}
function gate(policy, extra = {}) {
  const T = fakeTime(); const applied = []; const counts = [];
  const g = Q.createRedrawGate({ apply: () => applied.push(T.now()), policy, onChange: (n) => counts.push(n),
    now: T.now, setTimer: T.setTimer, clearTimer: T.clearTimer, ...extra });
  return { g, T, applied, counts };
}

test('live: every event redraws, nothing is held', () => {
  const { g, applied, counts } = gate('live');
  assert.equal(g.notify(), 'applied'); g.notify();
  assert.equal(applied.length, 2); assert.equal(g.pending(), 0); assert.deepEqual(counts, []);
});

test('pending: events are held and counted; Apply redraws once and clears the count', () => {
  const { g, applied, counts } = gate('pending');
  assert.equal(g.notify(), 'held'); g.notify(); g.notify();
  assert.equal(applied.length, 0, 'the page must not repaint under the reader');
  assert.equal(g.pending(), 3); assert.deepEqual(counts, [1, 2, 3]);
  g.apply();
  assert.equal(applied.length, 1); assert.equal(g.pending(), 0); assert.equal(counts.at(-1), 0);
});

test('pending: applies by itself after a minute without a touch, and a touch postpones it', () => {
  const { g, T, applied } = gate('pending');
  T.advance(10_000); g.interact();          // reading, touched the page at t=10s
  T.advance(5_000); g.notify();             // t=15s: held, due at t=70s
  T.advance(30_000); assert.equal(applied.length, 0);
  g.interact();                              // t=45s: scrolled — the window starts again
  T.advance(30_000); assert.equal(applied.length, 0, 'applied at the first deadline despite the touch');  // t=75s
  T.advance(30_000); assert.equal(applied.length, 1, 'a minute after the last touch it applies');          // t=105s
  assert.equal(g.pending(), 0);
});

test('pending: a page idle for longer than the window already applies the first event at once', () => {
  const { g, T, applied } = gate('pending');
  T.advance(300_000);                        // five minutes, no touch
  g.notify(); T.advance(0);
  assert.equal(applied.length, 1);
});

test('manual: held forever; only Apply redraws', () => {
  const { g, T, applied } = gate('manual');
  g.notify(); g.notify(); T.advance(3_600_000);
  assert.equal(applied.length, 0); assert.equal(g.pending(), 2); assert.equal(T.armed(), 0, 'no timer in manual');
  g.apply(); assert.equal(applied.length, 1);
});

test('a live page passes through whatever the policy says', () => {
  const { g, applied } = gate('manual');
  assert.equal(g.notify({ live: true }), 'applied'); assert.equal(applied.length, 1); assert.equal(g.pending(), 0);
});

test('the policy is read when an event lands, so a Config change takes effect at once', () => {
  let p = 'pending';
  const { g, applied } = gate(() => p);
  g.notify(); assert.equal(applied.length, 0);
  p = 'live'; g.notify(); assert.equal(applied.length, 1, 'switched to live: applied, held ones included'); assert.equal(g.pending(), 0);
});

test('reset forgets what is held without redrawing (the page is being drawn afresh)', () => {
  const { g, T, applied, counts } = gate('pending');
  g.notify(); g.reset();
  assert.equal(g.pending(), 0); assert.equal(counts.at(-1), 0); assert.equal(T.armed(), 0);
  T.advance(120_000); assert.equal(applied.length, 0);
});

test('unknown policy and scope words fall back to the defaults', () => {
  assert.equal(Q.normalisePolicy('sometimes'), 'pending'); assert.equal(Q.normalisePolicy(undefined), 'pending');
  assert.equal(Q.normalisePolicy('manual'), 'manual');
  assert.equal(Q.normaliseScope('fleet'), 'last-selected'); assert.equal(Q.normaliseScope('all'), 'all');
});

test('opening scope: last chosen cluster, else the first, else the fleet; "all" only on request', () => {
  const clusters = [{ id: 'a' }, { id: 'b' }];
  assert.equal(Q.openingSelection({ last: 'b', clusters }), 'b');
  assert.equal(Q.openingSelection({ last: 'gone', clusters }), 'a', 'a remembered cluster no longer in the config');
  assert.equal(Q.openingSelection({ clusters }), 'a');
  assert.equal(Q.openingSelection({ clusters: [] }), 'all');
  assert.equal(Q.openingSelection({ scope: 'all', last: 'b', clusters }), 'all');
});
