/**
 * A Zabbix account's role on the Accounts page: the editor says whether Zabbix still sets it
 * or an admin pinned it here, the origin cell carries a "pinned" pill, and "Follow Zabbix
 * again" sends USER_UNPIN_ROLE. Nothing about it is kept in the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'KeyboardEvent', 'Event', 'CustomEvent', 'localStorage', 'sessionStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const sent = [];
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  const reply = msg.type === 'USER_LIST' ? { ok: true, users: [] } : { ok: true };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
};
const A = await import(pathToFileURL(path.join(ROOT, 'ui/js/pages/accounts.js')).href);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const zbx = (extra = {}) => ({ name: 'adam@zabbix', role: 'admin', source: 'zabbix', scope: null, ...extra });

test('a local account has no Zabbix note', () => {
  assert.equal(A.zabbixRoleNote({ name: 'bob', role: 'user' }), null);
  assert.equal(A.zabbixRoleNote(null), null);
});

test('not pinned: it follows Zabbix, and changing it here pins it', () => {
  const n = A.zabbixRoleNote(zbx({ rolePinned: false }));
  assert.equal(n.pinned, false);
  assert.equal(n.text, 'Follows Zabbix at each sign-in (Zabbix Admin → Operator, Super admin → Admin). Changing it here pins it.');
});

test('pinned: Zabbix sign-ins no longer change it', () => {
  const n = A.zabbixRoleNote(zbx({ rolePinned: true }));
  assert.equal(n.pinned, true);
  assert.equal(n.text, 'Pinned here. Zabbix sign-ins no longer change it.');
});

test('the origin cell shows a pinned pill only when pinned', () => {
  const on = A.originCell(zbx({ rolePinned: true }));
  const off = A.originCell(zbx({ rolePinned: false }));
  assert.match(on.textContent, /pinned/);
  assert.doesNotMatch(off.textContent, /pinned/);
  assert.match(on.getAttribute('title'), /Pinned here/);
  assert.equal(A.originCell({ name: 'bob', role: 'user' }).textContent, 'local');
});

test('the editor offers "Follow Zabbix again" for a pinned account, and it sends USER_UNPIN_ROLE', async () => {
  A.editUser(zbx({ rolePinned: true }));
  const dialog = document.querySelector('.modal');
  assert.ok(dialog, 'the dialog opened');
  assert.match(dialog.textContent, /Pinned here\. Zabbix sign-ins no longer change it\./);
  const btn = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Follow Zabbix again');
  assert.ok(btn, 'the button is there');
  btn.click();
  await tick();
  const unpin = sent.find((m) => m.type === 'USER_UNPIN_ROLE');
  assert.ok(unpin, `USER_UNPIN_ROLE was not sent: ${JSON.stringify(sent.map((m) => m.type))}`);
  assert.equal(unpin.name, 'adam@zabbix');
  assert.equal(document.querySelector('.modal'), null, 'the dialog closes once it is done');
});

test('the editor for an account that follows Zabbix offers no unpin button', () => {
  A.editUser(zbx({ rolePinned: false, role: 'operator' }));
  const dialog = document.querySelector('.modal');
  assert.match(dialog.textContent, /Changing it here pins it\./);
  assert.ok(![...dialog.querySelectorAll('button')].some((b) => b.textContent === 'Follow Zabbix again'));
  dialog.closest('.modal-overlay').remove();
});

test('none of it is kept in browser storage', () => {
  // The toast history (elasticpro.notifications) is the bell's, not this page's; anything
  // else, or any key about pinning, would be this page keeping state the account owns.
  const keys = (st) => Array.from({ length: st.length }, (_, i) => st.key(i));
  const mine = [...keys(localStorage), ...keys(sessionStorage)].filter((k) => k !== 'elasticpro.notifications');
  assert.deepEqual(mine, []);
  assert.ok(![...keys(localStorage), ...keys(sessionStorage)].some((k) => /pin|role/i.test(k)));
});
