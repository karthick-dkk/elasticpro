/**
 * The Zabbix role map on the Accounts page (hosted only): the three user types and every
 * Zabbix role by name, each with what it becomes here; Save sends ZABBIX_ROLEMAP_SET in
 * the core's shape — a name left "by user type" is not written. Nothing here touches a core.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'https://ep.test/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'KeyboardEvent', 'Event', 'CustomEvent', 'localStorage', 'sessionStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const sent = [];
const ROLES = [{ roleid: '1', name: 'User role', type: 1 }, { roleid: '2', name: 'Admin role', type: 2 }, { roleid: '3', name: 'Super admin role', type: 3 }];
let map = { names: { 'ES owners': 'admin' }, types: { 1: 'user', 2: 'operator', 3: 'admin' } };
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  const reply = msg.type === 'WHOAMI' ? { ok: true, caller: { name: 'Admin', role: 'admin' }, apiTokens: true }
    : msg.type === 'USER_LIST' ? { ok: true, users: [] }
    : msg.type === 'USER_LOGINS' ? { ok: true, logins: [] }
    : msg.type === 'ACTIVITY_LIST' ? { ok: true, events: [] }
    : msg.type === 'TOKEN_LIST' ? { ok: true, tokens: [] }
    : msg.type === 'ZABBIX_ROLEMAP_GET' ? { ok: true, roleMap: map, defaults: { names: {}, types: { 1: 'user', 2: 'operator', 3: 'admin' } }, file: true, zabbixRoles: ROLES, zabbixError: null }
    : msg.type === 'ZABBIX_ROLEMAP_SET' ? ((map = msg.roleMap), { ok: true, roleMap: msg.roleMap })
    : { ok: true };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
};
const A = await import(pathToFileURL(path.join(ROOT, 'ui/js/pages/accounts.js')).href);
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const host = document.getElementById('host');
const cardOf = (title) => [...host.querySelectorAll('section.card')].find((c) => c.querySelector('h2') && c.querySelector('h2').textContent === title);

test('the pure parts: the names listed, and the message Save sends', () => {
  assert.deepEqual(A.roleMapNames({ names: { 'ES owners': 'admin', 'Admin role': 'user' } }, ROLES).map((z) => [z.name, z.type]),
    [['Admin role', 2], ['ES owners', 0], ['Super admin role', 3], ['User role', 1]]);
  assert.deepEqual(A.roleMapMessage({ 1: 'user', 2: 'admin', 3: 'admin' }, { 'ES owners': 'admin', 'User role': '' }),
    { names: { 'ES owners': 'admin' }, types: { 1: 'user', 2: 'admin', 3: 'admin' } });
  assert.deepEqual(A.ROLE_TARGETS.map(([v]) => v), ['admin', 'operator', 'user', 'guest', 'none']);
});

test('the note when Zabbix would not list its roles names the remedy only for the known case', () => {
  assert.match(A.roleListNote('Zabbix role.get: No permissions to call "role.get".'), /pair again with Zabbix modules 2\.1\.14 or newer, or add role\.get to the ElasticPro sync role/);
  assert.equal(A.roleListNote('Zabbix: connection refused'), 'Zabbix’s role names could not be listed (hover for why) — type them. ');
  assert.equal(A.roleListNote(''), 'Zabbix’s role names could not be listed (hover for why) — type them. ');
});

test('the card lists the three user types and every Zabbix role by name, with what each becomes', async () => {
  A.render(host);
  await tick(120);
  const card = cardOf('Zabbix role map');
  assert.ok(card, `the card is on the page (cards: ${[...host.querySelectorAll('section.card h2')].map((h) => h.textContent).join(' | ')})`);
  const rows = [...card.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td').textContent);
  assert.match(rows[0], /^Zabbix Useruser type 1/);
  assert.match(rows[1], /^Zabbix Adminuser type 2/);
  assert.match(rows[2], /^Zabbix Super adminuser type 3/);
  assert.deepEqual(rows.slice(3, 7).map((r) => r.replace(/a .* role$/, '').trim()), ['Admin role', 'ES owners', 'Super admin role', 'User role']);
  assert.equal(card.querySelector('#rm-type-2').value, 'operator');
  assert.equal(card.querySelector('#rm-name-1').value, 'admin', 'ES owners → admin, from the map');
  assert.equal(card.querySelector('#rm-name-0').value, '', 'Admin role goes by user type');
  assert.match(card.querySelector('#rm-name-0').options[0].textContent, /by user type \(operator\)/);
  assert.match(card.textContent, /Shipped: Zabbix User → user, Zabbix Admin → operator, Zabbix Super admin → admin/);
});

test('Save sends ZABBIX_ROLEMAP_SET with the types, and only the names that have a role', async () => {
  const card = cardOf('Zabbix role map');
  const set = (sel, v) => { const el = card.querySelector(sel); el.value = v; el.dispatchEvent(new window.Event('change', { bubbles: true })); };
  set('#rm-type-2', 'admin');
  set('#rm-name-0', 'user');      // Admin role → user
  set('#rm-name-1', '');          // ES owners → by user type
  sent.length = 0;
  [...card.querySelectorAll('button')].find((b) => b.textContent === 'Save role map').click();
  await tick(120);
  const msg = sent.find((m) => m.type === 'ZABBIX_ROLEMAP_SET');
  assert.ok(msg, `ZABBIX_ROLEMAP_SET sent (sent: ${sent.map((m) => m.type).join(', ')})`);
  assert.deepEqual(msg.roleMap, { names: { 'Admin role': 'user' }, types: { 1: 'user', 2: 'admin', 3: 'admin' } });
  assert.ok(sent.some((m) => m.type === 'ZABBIX_ROLEMAP_GET'), 'the map is read back after saving');
  const again = cardOf('Zabbix role map');
  assert.equal(again.querySelector('#rm-type-2').value, 'admin');
  assert.equal(again.querySelector('#rm-name-0').value, 'user');
});

test('a role name Zabbix does not list can be typed in', async () => {
  const card = cardOf('Zabbix role map');
  card.querySelector('#rm-new-name').value = 'ES on-call';
  card.querySelector('#rm-new-target').value = 'operator';
  [...card.querySelectorAll('button')].find((b) => b.textContent === 'Add').click();
  await tick();
  const again = cardOf('Zabbix role map');
  const names = [...again.querySelectorAll('tr[data-role-name]')].map((tr) => tr.getAttribute('data-role-name'));
  assert.ok(names.includes('ES on-call'), names.join(', '));
  const i = names.indexOf('ES on-call');
  assert.equal(again.querySelector(`#rm-name-${i}`).value, 'operator');
  assert.ok(again.querySelector(`tr[data-role-name="ES on-call"] button`), 'a typed name can be forgotten again; a listed one cannot');
  assert.equal(again.querySelector('tr[data-role-name="Admin role"] button'), null);
});
