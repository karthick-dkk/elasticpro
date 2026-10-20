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

test('IDLE_MS is three seconds', () => { assert.equal(Q.IDLE_MS, 3000); });

test('pending: works with no onChange at all (there is no pill to feed)', () => {
  const T = fakeTime(); const applied = [];
  const g = Q.createRedrawGate({ apply: () => applied.push(T.now()), policy: 'pending', now: T.now, setTimer: T.setTimer, clearTimer: T.clearTimer });
  g.interact(); g.notify(); T.advance(3_000); assert.equal(applied.length, 1);
});

test('pending: applies by itself 3 s after the last touch, never during interaction', () => {
  const { g, T, applied } = gate('pending');
  T.advance(10_000); g.interact();          // reading, touched the page at t=10s
  T.advance(1_000); g.notify();             // t=11s: held, due at t=13s
  T.advance(1_500); assert.equal(applied.length, 0, 'applied 1.5 s after a touch');   // t=12.5s
  g.interact();                              // t=12.5s: scrolled — the window starts again
  T.advance(1_000); assert.equal(applied.length, 0, 'applied at the first deadline despite the touch');  // t=13.5s
  g.notify(); g.interact();                  // still busy: more data, more touches
  T.advance(2_900); assert.equal(applied.length, 0, 'applied while the person was still interacting');
  T.advance(200); assert.equal(applied.length, 1, 'three seconds after the last touch it applies');
  assert.equal(g.pending(), 0);
});

test('pending: a page idle for longer than the window applies the first event at once', () => {
  const { g, T, applied } = gate('pending');
  T.advance(300_000);                        // five minutes, no touch
  g.notify(); T.advance(0);
  assert.equal(applied.length, 1);
});

test('pending: Refresh and navigating apply or drop what is held at once', () => {
  const { g, T, applied } = gate('pending');
  g.interact(); g.notify(); g.apply();
  assert.equal(applied.length, 1); assert.equal(T.armed(), 0);
  g.notify(); g.reset(); T.advance(10_000);
  assert.equal(applied.length, 1, 'reset (navigation) draws afresh itself and must not apply again');
});

test('manual: held forever; only Apply (Refresh) redraws', () => {
  const { g, T, applied } = gate('manual');
  g.notify(); g.notify(); g.interact(); T.advance(3_600_000);
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

test('the topbar no longer carries an updates pill', async () => {
  const fs = await import('node:fs');
  for (const f of ['ui/js/app.js', 'ui/js/lib/quiet-ui.js', 'ui/css/app.css'])
    assert.ok(!/pending-updates|renderPendingPill|updates? — Apply/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
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

/* `refreshed` is emitted for a person's Refresh and for the core's push; only the first applies at once. */

test('a push-driven refreshed during interaction does not redraw; it draws 3 s after the last touch', () => {
  const { g, T, applied } = gate('pending');
  g.interact(); g.notify();                                   // a change lands
  for (let i = 0; i < 10; i++) {                              // typing every 400 ms
    T.advance(400); g.interact();
    if (i === 2) assert.equal(Q.onRefreshed(g, { byPerson: false }), 'left', 'the 5 s push announcement');
  }
  assert.equal(applied.length, 0, 'nothing may draw while keys are still being pressed');
  T.advance(2_900); assert.equal(applied.length, 0, 'not before 3 s idle');
  T.advance(100); assert.equal(applied.length, 1, 'drawn once, 3 s after the last touch');
  assert.equal(applied[0] - 4_000 >= 3_000, true);
});

test('a person\'s Refresh applies at once; so does a refreshed with no payload', () => {
  const { g, applied } = gate('pending');
  g.interact(); g.notify();
  assert.equal(Q.onRefreshed(g, { byPerson: true }), 'applied'); assert.equal(applied.length, 1);
  g.notify(); assert.equal(Q.onRefreshed(g), 'applied'); assert.equal(applied.length, 2);
  assert.equal(g.pending(), 0);
});

test('the core\'s push announcement says it was not a person; the Refresh path says it was', async () => {
  const fs = await import('node:fs');
  const st = fs.readFileSync(path.join(ROOT, 'ui/js/core/state.js'), 'utf8');
  assert.match(st, /function announceRefreshed\(\)[\s\S]*?bus\.emit\('refreshed', \{ byPerson: false \}\)/);
  assert.match(st, /bus\.emit\('refreshed', \{ byPerson: !!force \}\)/);
  const app = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  assert.ok(/onRefreshed\(redrawGate, ev\)/.test(app), 'app.js must go through onRefreshed, not redrawGate.apply() directly');
  assert.ok(!/bus\.on\('refreshed'[\s\S]{0,1500}redrawGate\.apply\(\)/.test(app));
});
