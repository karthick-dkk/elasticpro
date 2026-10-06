/**
 * Coalescing a burst of calls into one.
 *
 * This exists because a fleet refresh used to fire the app's 'data' bus event once per
 * cluster (twice, counting the snapshot listing) and redraw the whole page on every single
 * one — 88 redraws and a multi-second stall on a hundred-cluster fleet. Every case here is
 * about the two promises that fix makes: a burst collapses to ONE call, and that call never
 * waits longer than it has to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { coalesce } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/coalesce.js')).href);

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake requestAnimationFrame that never fires — the hidden-tab case. */
function noFrames() {
  return { raf: () => 0, caf: () => {} };
}

/** A fake requestAnimationFrame that fires on the next microtask/macrotask, like a real one. */
function fastFrames() {
  const pending = new Map();
  let id = 0;
  return {
    raf: (fn) => { const my = ++id; pending.set(my, setTimeout(fn, 0)); return my; },
    caf: (id2) => { const h = pending.get(id2); if (h) clearTimeout(h); pending.delete(id2); },
  };
}

test('a burst of calls before the frame runs produces exactly one', async () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, fastFrames());
  schedule(); schedule(); schedule(); schedule();
  await tick(20);
  assert.equal(calls, 1);
});

test('after it runs, the next call schedules a fresh one', async () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, fastFrames());
  schedule();
  await tick(20);
  assert.equal(calls, 1);
  schedule();
  await tick(20);
  assert.equal(calls, 2);
});

test('with no animation frame at all, the timer still fires it', async () => {
  // The hidden-tab case: requestAnimationFrame never calls back, so this must not wait
  // forever for a tab nobody is looking at.
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, { ...noFrames(), maxWaitMs: 15 });
  schedule();
  await tick(5);
  assert.equal(calls, 0, 'fired before its own upper bound');
  await tick(20);
  assert.equal(calls, 1);
});

test('the frame winning does not leave a second, redundant call behind', async () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, { ...fastFrames(), maxWaitMs: 30 });
  schedule();
  await tick(50);       // well past both the frame and the timer's deadline
  assert.equal(calls, 1, `expected exactly one call, got ${calls}`);
});

test('cancel drops a pending call outright', async () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, fastFrames());
  schedule();
  schedule.cancel();
  await tick(20);
  assert.equal(calls, 0);
});

test('flush runs a pending call immediately and only once', async () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, fastFrames());
  schedule();
  schedule.flush();
  assert.equal(calls, 1);
  await tick(20);
  assert.equal(calls, 1, 'the frame still fired after flush already ran it');
});

test('flush with nothing pending is a no-op', () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, fastFrames());
  schedule.flush();
  assert.equal(calls, 0);
});

test('fn sees the state as of the LAST call in the burst, not the first', async () => {
  let seen = null;
  let state = 'a';
  const schedule = coalesce(() => { seen = state; }, fastFrames());
  schedule(); state = 'b'; schedule(); state = 'c'; schedule();
  await tick(20);
  assert.equal(seen, 'c');
});

/* ---- gapAfter: a slow run earns the main thread a rest before the next one ---- */

test('gapAfter holds the next run back by what the last one cost', async () => {
  let clock = 0;
  const times = [];
  const schedule = coalesce(() => { times.push(clock); clock += 40; }, {
    ...fastFrames(), maxWaitMs: 5, now: () => clock, gapAfter: (cost) => cost * 2,
  });
  schedule();
  await tick(15);
  assert.equal(times.length, 1);
  // The run "took" 40 ms of fake clock, so the next is not allowed before clock 120.
  schedule();
  await tick(15);
  assert.equal(times.length, 1, 'ran again inside the gap');
  clock = 200;          // time has passed; the held call fires on its own timer
  await tick(120);
  assert.equal(times.length, 2);
});

test('a burst inside the gap is still one run, not one per call', async () => {
  let clock = 0;
  let calls = 0;
  const schedule = coalesce(() => { calls++; clock += 10; }, {
    ...fastFrames(), maxWaitMs: 5, now: () => clock, gapAfter: () => 30,
  });
  schedule();
  await tick(15);
  schedule(); schedule(); schedule();
  clock += 100;
  await tick(60);
  assert.equal(calls, 2);
});

test('without gapAfter nothing is held back (the old behaviour)', async () => {
  let calls = 0;
  const schedule = coalesce(() => { calls++; }, fastFrames());
  schedule(); await tick(10);
  schedule(); await tick(10);
  assert.equal(calls, 2);
});

test('cancel also drops a call held back by the gap', async () => {
  let clock = 0;
  let calls = 0;
  const schedule = coalesce(() => { calls++; clock += 50; }, {
    ...fastFrames(), maxWaitMs: 5, now: () => clock, gapAfter: () => 1000,
  });
  schedule(); await tick(15);
  schedule();
  assert.equal(schedule.pending(), true);
  schedule.cancel();
  clock += 5000;
  await tick(40);
  assert.equal(calls, 1);
});
