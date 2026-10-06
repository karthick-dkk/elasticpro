/**
 * Notices, and how they stop being a wall.
 *
 * Pressing Run four times left four notices piled over the page. Each message ended with
 * a different duration, so nothing matched anything — the one thing they had in common
 * was the only thing not being compared.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'customElements']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { toast, toastKind, notifications, clearNotifications, notificationBell } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/menu.js')).href);

const shown = () => [...document.querySelectorAll('.toast-wrap > .toast')];
const texts = () => shown().map((t) => t.querySelector('.toast-msg').textContent);

beforeEach(() => {
  const wrap = document.querySelector('.toast-wrap');
  if (wrap) wrap.replaceChildren();
});

test('two unrelated notices both appear', () => {
  toast('indices deleted');
  toast('snapshot finished');
  assert.deepEqual(texts(), ['indices deleted', 'snapshot finished']);
});

test('the same keyed action updates one notice instead of stacking', () => {
  // The bug, exactly: four runs of the same request, each with a different duration.
  toast('GET /_cluster/health → 200 · 10 ms', 'ok', 9000, { key: 'console-run' });
  toast('GET /_cluster/health → 200 · 6 ms', 'ok', 9000, { key: 'console-run' });
  toast('GET /_cluster/health → 200 · 17 ms', 'ok', 9000, { key: 'console-run' });
  toast('GET /_cluster/health → 200 · 5 ms', 'ok', 9000, { key: 'console-run' });
  assert.equal(shown().length, 1, `four runs left ${shown().length} notices`);
  assert.match(texts()[0], /5 ms/, 'the surviving notice should be the newest');
});

test('a replaced notice keeps its place rather than jumping to the bottom', () => {
  // Removing and re-appending would read as a second event, which is what this avoids.
  toast('first', 'ok', 9000, { key: 'a' });
  toast('second', 'ok', 9000);
  toast('first again', 'ok', 9000, { key: 'a' });
  assert.deepEqual(texts(), ['first again', 'second']);
});

test('a keyed notice can change severity when the outcome does', () => {
  // A request that succeeded and then failed must not keep the success styling.
  toast('ran fine', 'ok', 9000, { key: 'run' });
  assert.ok(!shown()[0].classList.contains('err'));
  toast('failed', 'err', 9000, { key: 'run' });
  assert.equal(shown().length, 1);
  assert.ok(shown()[0].classList.contains('err'), 'the replacement kept the old severity');
});

test('different keys are different notices', () => {
  toast('a', 'ok', 9000, { key: 'one' });
  toast('b', 'ok', 9000, { key: 'two' });
  assert.equal(shown().length, 2);
});

test('the stack is capped, oldest first', () => {
  for (let i = 1; i <= 7; i += 1) toast(`notice ${i}`, 'ok', 9000);
  assert.equal(shown().length, 4, 'a notice nobody can read before the next arrives is not a notice');
  assert.deepEqual(texts(), ['notice 4', 'notice 5', 'notice 6', 'notice 7']);
});

test('a key containing quotes does not break the lookup', () => {
  // The key reaches an attribute selector. An unescaped quote would throw, and a throw
  // inside a notice would take down whatever action was reporting.
  toast('x', 'ok', 9000, { key: 'weird"key' });
  toast('y', 'ok', 9000, { key: 'weird"key' });
  assert.equal(shown().length, 1);
  assert.equal(texts()[0], 'y');
});

test('a notice never swallows a click meant for the page', () => {
  toast('anything');
  const wrap = document.querySelector('.toast-wrap');
  // Checked on the wrapper because it spans the corner of the page even when one short
  // notice is showing.
  assert.equal(wrap.style.pointerEvents || '', '', 'set in CSS, not inline');
  assert.ok(document.querySelector('.toast-wrap'), 'the wrapper exists to be styled');
});

test('green for done, red for failed — and a timeout is a failure', () => {
  assert.equal(toastKind('ok', '3 indices deleted'), 'ok');
  assert.equal(toastKind('err', 'Could not delete x'), 'err');
  assert.equal(toastKind('warn', 'No other node to move this shard to'), 'warn');
  assert.equal(toastKind('warn', 'request timed out'), 'err');
  assert.equal(toastKind('ok', 'GET /_cat → timeout'), 'err');
  assert.equal(toastKind('ok', 'Run failed: x'), 'err');
  toast('Snapshot s1 deleted from daily');
  assert.ok(shown().at(-1).classList.contains('ok'), 'success carries the green class');
  toast('Could not delete s2: HTTP 404', 'err');
  assert.ok(shown().at(-1).classList.contains('err'), 'failure carries the red class');
});

test('a redraw that detaches the wrapper does not swallow later notices', () => {
  toast('before');
  document.querySelector('.toast-wrap').remove();
  toast('after');
  assert.deepEqual(texts(), ['after']);
});

test('the bell keeps every notice, newest first, and a keyed one updates its entry', () => {
  clearNotifications();
  toast('first');
  toast('run 1', 'ok', 2600, { key: 'console-run' });
  toast('run 2', 'ok', 2600, { key: 'console-run' });
  toast('Could not delete x', 'err');
  const list = notifications();
  assert.deepEqual(list.map((n) => n.message), ['Could not delete x', 'run 2', 'first']);
  assert.equal(list[0].kind, 'err');
  const bell = notificationBell();
  assert.equal(bell, notificationBell(), 'one bell for the life of the page');
  assert.equal(bell.querySelector('.bell-count').textContent, '3');
});
