/** REST console tabs — core/console-tabs.js: up to 10, remembered, never a secret stored. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/console-tabs.js')).href);

test('up to ten tabs; the eleventh is refused', () => {
  let st = T.initialState();
  for (let i = 0; i < 9; i++) st = T.addTab(st, { method: 'GET', path: `/_cat/x${i}` }).st;
  assert.equal(st.tabs.length, 10); assert.equal(st.tabs.length, T.MAX_TABS);
  const r = T.addTab(st); assert.equal(r.added, false); assert.equal(r.st.tabs.length, 10);
  assert.equal(T.activeTab(st).path, '/_cat/x8', 'a new tab becomes the active one');
});

test('closing moves to the neighbour; the last tab is emptied, never removed', () => {
  let st = T.initialState({ path: '/a' });
  st = T.addTab(st, { path: '/b' }).st; st = T.addTab(st, { path: '/c' }).st;
  const b = st.tabs[1].id;
  st = { ...st, active: b }; st = T.closeTab(st, b);
  assert.deepEqual(st.tabs.map((t) => t.path), ['/a', '/c']); assert.equal(T.activeTab(st).path, '/a');
  st = T.closeTab(T.closeTab(st, st.tabs[1].id), st.tabs[0].id);
  assert.equal(st.tabs.length, 1); assert.equal(T.activeTab(st).path, '/_cluster/health');
});

test('titles follow the request unless named', () => {
  assert.equal(T.tabTitle({ method: 'POST', path: '/logs-*/_search?size=0', name: '' }), 'POST logs-*/_search');
  assert.equal(T.tabTitle({ method: 'GET', path: '/', name: '' }), 'GET /');
  assert.equal(T.tabTitle({ method: 'GET', path: '/x', name: ' disk check ' }), 'disk check');
});

test('stored without secrets or responses, and read back', () => {
  let st = T.initialState({ method: 'PUT', path: '/_security/user/ops', body: '{"password":"hunter2-really","roles":["superuser"]}' });
  st = T.updateTab(st, st.active, { name: 'make user', res: { body: 'big response' } });
  const stored = T.toStored(st);
  const text = JSON.stringify(stored);
  assert.ok(!text.includes('hunter2-really'), 'the password is not stored');
  assert.ok(!text.includes('big response'), 'a response is not stored');
  assert.ok(text.includes('superuser'));
  const back = T.fromStored(JSON.parse(text));
  assert.equal(back.tabs[0].name, 'make user'); assert.equal(back.tabs[0].method, 'PUT'); assert.equal(back.active, st.active);
  assert.equal(T.fromStored(null), null); assert.equal(T.fromStored({ v: 1, tabs: [] }), null); assert.equal(T.fromStored({ v: 2, tabs: [{ id: 'x' }] }), null);
  const many = T.fromStored({ v: 1, active: 'nope', tabs: Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, method: 'BREW', path: '/p' })) });
  assert.equal(many.tabs.length, 10); assert.equal(many.tabs[0].method, 'GET', 'an unknown method falls back'); assert.equal(many.active, 't0');
});
