/**
 * The bell's history on the core: one entry per key on both sides, the server's copy
 * winning, and a task's progress ticks sent only when they change what kind of notice it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const lib = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/notify-history.js')).href);
const { mergeNotifications, sendRule, serverId, toPut, fromServer } = lib;

/* ------------------------------- merge / dedupe ------------------------------- */

test('the same key on both sides is one notice, and the server copy wins', () => {
  const local = [{ message: 'Restore started', kind: 'run', at: 100, key: 'task-1', id: 'task-1', read: false }];
  const server = [{ id: 'task-1', message: 'Restore completed', kind: 'ok', at: 200, updatedAt: 210, detail: ['2 shards'], meta: 'lab · took 9 s' }];
  const out = mergeNotifications(local, server);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'ok');
  assert.equal(out[0].message, 'Restore completed');
  assert.deepEqual(out[0].detail, ['2 shards']);
  assert.equal(out[0].read, false, 'unread here stays unread');
});

test('an unkeyed local notice matches its server record by the id it was sent with', () => {
  const local = [{ message: 'indices deleted', kind: 'ok', at: 50, id: 'n-50-abc', read: true }];
  const server = [{ id: 'n-50-abc', message: 'indices deleted', kind: 'ok', at: 50 }];
  const out = mergeNotifications(local, server);
  assert.equal(out.length, 1);
  assert.equal(out[0].read, true);
});

test('server records with no local twin are added, read, newest first', () => {
  const local = [{ message: 'here', kind: 'ok', at: 300, id: 'n-1', read: false }];
  const server = [{ id: 'elsewhere-new', message: 'another browser', kind: 'err', at: 400 },
                  { id: 'elsewhere-old', message: 'last week', kind: 'warn', at: 10 }];
  const out = mergeNotifications(local, server);
  assert.deepEqual(out.map((n) => n.message), ['another browser', 'here', 'last week']);
  assert.equal(out.find((n) => n.message === 'last week').read, true, 'history is not new');
  assert.equal(out.find((n) => n.message === 'here').read, false);
});

test('merging does not change the local list it was given', () => {
  const local = [{ message: 'a', kind: 'run', at: 1, key: 'k', id: 'k', read: false }];
  mergeNotifications(local, [{ id: 'k', message: 'b', kind: 'ok', at: 2 }]);
  assert.equal(local[0].message, 'a');
  assert.equal(local[0].kind, 'run');
});

test('duplicate keys locally collapse to the first, newest entry', () => {
  const out = mergeNotifications([
    { message: 'new', kind: 'ok', at: 2, key: 'k', read: false },
    { message: 'old', kind: 'ok', at: 1, key: 'k', read: false },
  ], []);
  assert.deepEqual(out.map((n) => n.message), ['new']);
});

test('the server copy wins even where it has less to say', () => {
  const out = mergeNotifications(
    [{ message: 'x', kind: 'run', at: 1, key: 'k', detail: ['tick 9'], meta: 'running 30 s', read: true }],
    [{ id: 'k', message: 'x done', kind: 'ok', at: 2, detail: [], meta: '' }]);
  assert.equal(out[0].detail, undefined);
  assert.equal(out[0].meta, undefined);
});

test('ids the core would refuse are made acceptable, the same way every time', () => {
  assert.equal(serverId({ key: 'console-run' }), 'console-run');
  assert.equal(serverId({ key: 'a b/c' }), 'a_b_c');
  assert.equal(serverId({ id: 'x'.repeat(200) }).length, 128);
  assert.equal(serverId({}), null);
  const put = toPut({ message: 'm', kind: 'ok', at: 5, key: 'a b', detail: ['d'], cluster: 'lab' });
  assert.deepEqual(put, { type: 'NOTIFY_PUT', id: 'a_b', message: 'm', kind: 'ok', at: 5, detail: ['d'], meta: '', cluster: 'lab' });
  assert.equal(fromServer({ id: 'q', message: 'm', kind: 'ok', at: 1 }).key, 'q');
});

/* ------------------------------- send on kind change ------------------------------- */

test('every shown notice is sent; a tick only when its kind changes', () => {
  const send = sendRule();
  assert.equal(send('t1', 'run', false), true, 'the start is shown, so it is sent');
  assert.equal(send('t1', 'run', true), false, 'a tick of the same kind is not');
  assert.equal(send('t1', 'run', true), false);
  assert.equal(send('t1', 'warn', true), true, 'a tick that changes the kind is');
  assert.equal(send('t1', 'warn', true), false);
  assert.equal(send('t1', 'ok', false), true, 'the finish is shown, so it is sent');
  assert.equal(send('console-run', 'ok', false), true);
  assert.equal(send('console-run', 'ok', false), true, 'a repeated shown notice is still a new notice');
  assert.equal(send(null, 'ok', false), true);
  assert.equal(send(null, 'ok', true), false, 'a tick with no key has nothing to update');
});

test('the rule forgets old keys rather than growing for ever', () => {
  const send = sendRule(3);
  for (const k of ['a', 'b', 'c', 'd']) send(k, 'run', false);
  assert.equal(send('a', 'run', true), true, 'a was forgotten, so its tick counts as a change');
  assert.equal(send('d', 'run', true), false);
});

/* ------------------------------- in the bell ------------------------------- */

const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'customElements', 'localStorage']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const menu = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/menu.js')).href);
const { toast, setNotificationSink, clearNotifications, notificationBell, notifications } = menu;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('without a store nothing is sent and the bell is as it was', () => {
  setNotificationSink(null);
  clearNotifications();
  toast('local only', 'ok');
  assert.equal(notifications().length, 1);
});

test('with a store: shown notices and kind changes go out, ticks do not', async () => {
  const sent = [];
  setNotificationSink({ send: async (m) => { sent.push(m); return { ok: true, items: [], more: false }; } });
  clearNotifications();
  sent.length = 0;
  toast('Restore started', 'run', 0, { key: 'task-9', meta: 'lab', cluster: 'lab' });
  toast('Restore started', 'run', 0, { key: 'task-9', silent: true, meta: 'running 3 s' });
  toast('Restore started', 'run', 0, { key: 'task-9', silent: true, meta: 'running 6 s' });
  toast('Restore completed', 'ok', 100, { key: 'task-9', meta: 'took 9 s' });
  const puts = sent.filter((m) => m.type === 'NOTIFY_PUT');
  assert.deepEqual(puts.map((m) => [m.id, m.kind]), [['task-9', 'run'], ['task-9', 'ok']]);
  assert.equal(puts[0].cluster, 'lab');
  toast('unkeyed', 'warn');
  const last = sent.at(-1);
  assert.equal(last.type, 'NOTIFY_PUT');
  assert.equal(last.id, notifications()[0].id, 'an unkeyed notice is sent under the id it is kept by');
});

test('a store that throws or rejects never reaches the caller', async () => {
  setNotificationSink({ send: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => toast('still shown', 'ok'));
  setNotificationSink({ send: () => Promise.reject(new Error('down')) });
  assert.doesNotThrow(() => toast('still shown too', 'ok'));
  await tick();
  assert.equal(notifications()[0].message, 'still shown too');
});

test('the open bell merges the core copy, loads more, and Clear all clears both', async () => {
  const sent = [];
  const page1 = [{ id: 'srv-2', message: 'from the server, newer', kind: 'ok', at: Date.now() - 1000 },
                 { id: 'srv-1', message: 'from the server', kind: 'err', at: Date.now() - 5000 }];
  const page2 = [{ id: 'srv-0', message: 'older still', kind: 'warn', at: Date.now() - 9000 }];
  setNotificationSink({ days: 30, send: async (m) => {
    sent.push(m);
    if (m.type === 'NOTIFY_LIST') return m.before ? { ok: true, items: page2, more: false } : { ok: true, items: page1, more: true };
    return { ok: true };
  } });
  clearNotifications();
  toast('here', 'ok');
  const bell = notificationBell();
  document.body.append(bell);
  bell.click();
  await tick(); await tick();
  const pop = () => document.querySelector('.pop');
  const msgs = () => [...pop().querySelectorAll('.notif-msg')].map((x) => x.textContent);
  assert.match(pop().textContent, /last 30 days/);
  assert.deepEqual(msgs(), ['here', 'from the server, newer', 'from the server']);
  const more = [...pop().querySelectorAll('button')].find((b) => b.textContent === 'Load more');
  assert.ok(more, 'more on the server offers Load more');
  more.click();
  await tick(); await tick();
  assert.deepEqual(msgs(), ['here', 'from the server, newer', 'from the server', 'older still']);
  const listAsks = sent.filter((m) => m.type === 'NOTIFY_LIST');
  assert.equal(listAsks[1].before, page1[1].at, 'Load more continues from the oldest shown');
  assert.ok(![...pop().querySelectorAll('button')].some((b) => b.textContent === 'Load more'), 'nothing more to load');
  [...pop().querySelectorAll('button')].find((b) => b.textContent === 'Clear all').click();
  assert.ok(sent.some((m) => m.type === 'NOTIFY_CLEAR'));
  assert.match(pop().textContent, /No notifications yet/);
});
