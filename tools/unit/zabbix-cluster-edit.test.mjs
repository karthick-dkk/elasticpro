/**
 * The Edit dialog of a cluster that comes from Zabbix (config-editor.js editZabbixCluster):
 * the URL is read-only and never sent; only what changed is sent, as ZABBIX_CLUSTER_SAVE; a
 * field set in ElasticPro says so and "Use Zabbix's value" resets just that one; below admin
 * there is no credential, no `insecure`, and the route of a cluster whose credential is its own
 * is locked; an admin's typed credential goes to CREDENTIAL_SET, never into the overlay.
 * Nothing here touches a real core.
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

const VIEW = { version: 2, jump_hosts: { jumpa: { host: 'jump-a', user: 'ops' } }, clusters: [] };
const ROW = {
  _id: 'zbx-es-dev', name: 'Dev EU', url: 'http://10.0.0.2:9200', via: null, source: 'zabbix', zabbixHost: 'es-dev', zabbixHostId: '102',
  client: 'acme', zabbixGroups: [], username: 'svc', credential: 'plain-macro', credentialOk: true, notes: [],
  tags: ['eu'], note: 'team A', liveRetention: null, snapshotRetention: null, backupCapacity: null, tls: null, enabled: true,
  volumeWindowDays: null, volumeTopDays: null, volumeHeadroomPercent: null,
  overridden: ['name', 'note', 'tags'], zabbixValues: { name: 'es-dev', via: null, tags: ['acme'] }, overriddenBy: 'otto', overriddenAt: 1,
  ownCredential: false, ownCredentialMoved: false, credentialIsOwn: false,
};
let row = { ...ROW };
const sent = [];
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  const reply = msg.type === 'CONFIG_VIEW' ? { ok: true, text: JSON.stringify(VIEW), scoped: false, clusters: 0 }
    : msg.type === 'ZABBIX_CLUSTERS' ? { ok: true, clusters: [row] }
    : msg.type === 'CREDENTIAL_STATUS' ? { ok: true, default: null, clusters: [], promotable: [] }
    : { ok: true };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
};

const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config.js')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/config-editor.js')).href);
const K = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/server-credentials.js')).href);
K.setHostedEdition(true);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const dialog = () => document.querySelector('.modal-overlay .modal');
const press = (label) => { const b = [...dialog().querySelectorAll('button')].find((x) => x.textContent === label); assert.ok(b, `a "${label}" button`); b.click(); };
const $ = (s) => document.querySelector(s);

async function as(role, r = ROW) {
  row = { ...r };
  S.state.caller = { name: 'x', role };
  const view = await C.loadServerView();
  await S.setConfig(view.config, view.path);
  sent.length = 0;
  return S.state.config.clusters.find((c) => c.id === 'zbx-es-dev');
}

test('an operator: URL read-only, marks per field, only the change and the reset are sent', async () => {
  const c = await as('operator');
  const done = E.editZabbixCluster(c);
  await tick();
  assert.ok(dialog(), 'the dialog opened');
  assert.equal($('#ce-url').readOnly, true, 'the URL is Zabbix\'s');
  assert.match(dialog().textContent, /From Zabbix\. Change it on the host es-dev/);
  assert.match(dialog().textContent, /Set in ElasticPro · Zabbix: es-dev/, 'the name says it is set here, beside Zabbix\'s');
  assert.equal($('#ce-cp'), null, 'no credential below admin');
  assert.ok(![...$('#ce-tls').options].some((o) => o.value === 'insecure'), 'certificates off is an admin\'s');
  assert.equal($('#ce-via').disabled, false, 'no credential of its own: the operator may route it');
  // Use Zabbix's value for the note only; change the retention.
  $('#ce-z-reset-note').click();
  $('#ce-live').value = '30d';
  press('Save');
  await tick(80);
  const save = sent.find((m) => m.type === 'ZABBIX_CLUSTER_SAVE');
  assert.ok(save, `sent: ${sent.map((m) => m.type).join(', ')}`);
  assert.equal(save.hostId, '102');
  assert.deepEqual(save.set, { liveRetention: '30d' });
  assert.deepEqual(save.reset, ['note']);
  assert.ok(!('url' in save.set), 'never the address');
  assert.ok(!sent.some((m) => m.type === 'CREDENTIAL_SET' || m.type === 'CLUSTER_META_SET'));
  assert.equal(await done, true);
});

test('an operator on a cluster whose credential is its own: route and certificates locked', async () => {
  const c = await as('operator', { ...ROW, credentialIsOwn: true });
  const done = E.editZabbixCluster(c);
  await tick();
  assert.equal($('#ce-via').disabled, true);
  assert.equal($('#ce-tls').disabled, true);
  assert.match(dialog().textContent, /an administrator’s — it signs in with a credential of its own/);
  press('Cancel');
  assert.equal(await done, false);
});

test('an admin types its own credential: CREDENTIAL_SET, not the overlay; nothing else changed is not sent', async () => {
  const c = await as('admin');
  const done = E.editZabbixCluster(c);
  await tick();
  assert.ok([...$('#ce-tls').options].some((o) => o.value === 'insecure'));
  $('#ce-cred-own').checked = true;
  $('#ce-cu').value = 'svc-own';
  $('#ce-cp').value = 'own-pw';
  press('Save');
  await tick(80);
  assert.ok(!sent.some((m) => m.type === 'ZABBIX_CLUSTER_SAVE'), 'no field changed');
  const cred = sent.find((m) => m.type === 'CREDENTIAL_SET');
  assert.ok(cred, `sent: ${sent.map((m) => m.type).join(', ')}`);
  assert.deepEqual([cred.cluster, cred.username, cred.password], ['zbx-es-dev', 'svc-own', 'own-pw']);
  assert.equal(await done, true);
});
