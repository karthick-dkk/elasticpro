/**
 * The app's one "idle" (ui/js/core/activity.js, 0.3.77): the menu rail's fold and Live's tail stop
 * share IDLE_MS, and a browser check shortens it through a window seam, never the figure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/activity.js')).href);

test('idle: three minutes, a seam shortens it, nothing else does', () => {
  assert.equal(A.IDLE_MS, 3 * 60 * 1000);
  assert.equal(A.idleWords(), '3 min');
  assert.equal(A.idleMs('__EP_TAIL_IDLE_MS'), A.IDLE_MS, 'no window, no seam: the figure');
  globalThis.window = { __EP_TAIL_IDLE_MS: 300, __EP_RAIL_IDLE_MS: 'x', __EP_ZERO: 0 };
  try {
    assert.equal(A.idleMs('__EP_TAIL_IDLE_MS'), 300);
    assert.equal(A.idleMs('__EP_RAIL_IDLE_MS'), A.IDLE_MS, 'a seam that is not a number is ignored');
    assert.equal(A.idleMs('__EP_ZERO'), A.IDLE_MS, '0 is not a time: the figure');
    assert.equal(A.idleMs(), A.IDLE_MS);
  } finally { delete globalThis.window; }
  assert.deepEqual([...A.ACTIVITY_EVENTS], ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']);
});
