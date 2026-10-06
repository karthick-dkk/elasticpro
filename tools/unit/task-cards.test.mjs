/**
 * A task card: started (blue, stays), then the same card turns green or red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'customElements', 'localStorage']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { trackTask, restoredNames, elapsed } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/tasks.js')).href);
const { notifications, clearNotifications } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/menu.js')).href);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cards = () => [...document.querySelectorAll('.toast-wrap > .toast')];
/** Wait for a condition rather than a fixed time: timers on a loaded machine run late. */
async function waitFor(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail(`timed out after ${ms} ms waiting for: ${what}`);
    await wait(5);
  }
}

test('started, then completed — one card, one history entry', async () => {
  clearNotifications();
  let n = 0;
  trackTask({ title: 'Restore started', cluster: { name: 'lab' }, detail: ['from daily / s1'], everyMs: 10,
    poll: async () => (++n < 3 ? { detail: `${n} of 2 shards` } : { done: true, ok: true, title: 'Restore completed', detail: '2 shards recovered' }) });
  const started = cards().at(-1);
  assert.ok(started.classList.contains('run'), 'a running task is blue');
  await waitFor(() => n >= 3 && cards().at(-1).classList.contains('ok'), 'the card to turn green');
  const c = cards().at(-1);
  assert.equal(c, started, 'the same card, not a second one');
  assert.ok(c.classList.contains('ok'), 'the same card turned green');
  assert.equal(c.querySelector('.toast-msg').textContent, 'Restore completed');
  assert.match(c.textContent, /from daily \/ s1/);
  assert.match(c.textContent, /took/);
  const h = notifications();
  assert.equal(h.length, 1, 'progress ticks do not add history entries');
  assert.equal(h[0].message, 'Restore completed');
});

test('a task that ends badly turns red', async () => {
  trackTask({ title: 'Snapshot started', everyMs: 5, poll: async () => ({ done: true, ok: false, title: 'Snapshot finished PARTIAL' }) });
  await waitFor(() => cards().at(-1).classList.contains('err'), 'the card to turn red');
  assert.ok(cards().at(-1).classList.contains('err'));
});

test('rename is applied the way Elasticsearch applies it', () => {
  assert.deepEqual(restoredNames(['logs-1', 'logs-2'], '(.+)', 'restored-$1'), ['restored-logs-1', 'restored-logs-2']);
  assert.deepEqual(restoredNames(['a'], '', ''), ['a']);
  assert.equal(elapsed(42000), '42 s');
  assert.equal(elapsed(125000), '2 min 5 s');
});

test('closed while running: progress stays in the bell, the finish shows the card again', async () => {
  clearNotifications();
  let n = 0;
  trackTask({ title: 'Snapshot started', cluster: { name: 'lab' }, everyMs: 10,
    poll: async () => (++n < 4 ? { detail: `tick ${n}` } : { done: true, ok: true, title: 'Snapshot completed' }) });
  const running = cards().at(-1);
  running.querySelector('.toast-x').click();          // the × on the card
  await wait(25);
  assert.ok(!cards().some((c) => c.classList.contains('run') && !c.classList.contains('out')), 'a progress tick does not bring the card back');
  assert.equal(notifications()[0].kind, 'run', 'the bell still shows it running');
  await waitFor(() => n >= 4 && cards().at(-1).classList.contains('ok'), 'the finished card to show again');
  const done = cards().at(-1);
  assert.ok(done && done.classList.contains('ok'), 'finishing shows the card again, green');
  assert.equal(done.querySelector('.toast-msg').textContent, 'Snapshot completed');
});
