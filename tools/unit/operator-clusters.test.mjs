/**
 * An operator adds and edits clusters through the core's door, not the file.
 *
 * `roleMayManageClusters()` opens the Clusters page's Edit and "+ Add cluster" to operators;
 * the cluster dialog then shows no Remove and no credential fields, and Save sends
 * `CLUSTER_SAVE` with the one entry (no credential, no `_index`) and the name it replaces,
 * then reads the server's view back. An admin's dialog is unchanged: Remove, the credential
 * block, and the whole file through `CONFIG_WRITE`. Nothing here touches a real core.
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

/** The server's credential-free view of two clusters, as CONFIG_VIEW hands it over. */
const VIEW = {
  version: 2,
  defaults: { logIndexPattern: 'logs-*' },
  jump_hosts: { jumpa: { host: 'jump-a', user: 'ops' } },
  clusters: [
    { name: 'Alpha', url: 'https://alpha:9200', via: 'jumpa', tags: ['prod'], _index: 0 },
    { name: 'Beta', url: 'https://beta:9200', _index: 1 },
  ],
};
/** The admin's file: the same clusters with their credentials. */
const FILE = { ...VIEW, credentials: { username: 'fleet', password: 'fleet-pw' },
  clusters: [{ name: 'Alpha', url: 'https://alpha:9200', via: 'jumpa', tags: ['prod'], username: 'alpha-svc', password: 'alpha-pw' },
             { name: 'Beta', url: 'https://beta:9200' }] };

const sent = [];
let viewText = JSON.stringify(VIEW);
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  const reply = msg.type === 'CONFIG_VIEW' ? { ok: true, text: viewText, scoped: false, clusters: 2 }
    : msg.type === 'CONFIG_READ' ? { ok: true, text: JSON.stringify(FILE), path: msg.path }
    : msg.type === 'CLUSTER_SAVE' ? { ok: true, action: msg.replace ? 'edited' : 'added', name: msg.cluster.name, credential: 'shared' }
    : msg.type === 'PING' ? { ok: true }
    : { ok: true };
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
};

const W = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/writes.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config.js')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/config-editor.js')).href);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const dialog = () => document.querySelector('.modal-overlay .modal');
const buttons = () => [...dialog().querySelectorAll('button')].map((b) => b.textContent);
const press = (label) => { const b = [...dialog().querySelectorAll('button')].find((x) => x.textContent === label); assert.ok(b, `a "${label}" button`); b.click(); };
const closeAll = () => document.querySelectorAll('.modal-overlay').forEach((o) => o.remove());

async function asOperator() {
  S.state.caller = { name: 'adam@zabbix', role: 'operator' };
  const view = await C.loadServerView();
  assert.equal(view.status, 'ok');
  await S.setConfig(view.config, view.path);
  sent.length = 0;
}
async function asAdmin() {
  S.state.caller = { name: 'Admin', role: 'admin' };
  const config = C.parseConfigText(JSON.stringify(FILE), 'config_cluster.json');
  config.fileMeta = { name: 'config_cluster.json', path: '/srv/config_cluster.json', size: 1, lastModified: 0 };
  await S.setConfig(config, '/srv/config_cluster.json');
  sent.length = 0;
}

test('who may manage clusters: operators and admins; who may write to one: admins', () => {
  for (const [role, manage, write] of [['admin', true, true], ['operator', true, false], ['user', false, false], ['guest', false, false]]) {
    S.state.caller = { name: 'x', role };
    assert.equal(W.roleMayManageClusters(), manage, `${role} manages`);
    assert.equal(W.roleMayWrite(), write, `${role} writes`);
  }
  S.state.caller = null;
  assert.equal(W.roleMayManageClusters(), true, 'the portable build is its own administrator');
});

test('an operator edits a cluster: no Remove, no credential, CLUSTER_SAVE with the entry and the name it replaces', async () => {
  await asOperator();
  assert.equal(E.editsFileDirectly(), false);
  const alpha = E.rawClusterOf(S.clusters().find((c) => c.name === 'Alpha'));
  assert.ok(alpha && alpha._index === 0, 'the server view entry is what the dialog opens on');
  const done = E.editCluster(alpha);
  await tick();
  assert.ok(dialog(), 'the dialog opened');
  assert.ok(!buttons().includes('Remove'), `no Remove for an operator: ${buttons().join(', ')}`);
  assert.equal(document.querySelector('#ce-cp'), null, 'no password field');
  assert.equal(document.querySelector('#ce-cu'), null, 'no username field');
  assert.match(dialog().querySelector('.ce-managed-cred').textContent, /Credential: managed by an administrator/);
  assert.match(dialog().textContent, /Saved to the server.s config/);
  document.querySelector('#ce-note').value = 'eu region';
  document.querySelector('#ce-tags').value = 'prod, eu';
  press('Save');
  await tick(80);
  const save = sent.find((m) => m.type === 'CLUSTER_SAVE');
  assert.ok(save, `CLUSTER_SAVE was sent (sent: ${sent.map((m) => m.type).join(', ')})`);
  assert.equal(save.replace, 'Alpha');
  assert.deepEqual(save.cluster, { name: 'Alpha', url: 'https://alpha:9200', via: 'jumpa', tags: ['prod', 'eu'], note: 'eu region' });
  assert.ok(!('_index' in save.cluster) && !('username' in save.cluster) && !('password' in save.cluster), 'nothing the file holds that the view did not');
  assert.ok(!sent.some((m) => m.type === 'CONFIG_WRITE'), 'the file is not written from here');
  assert.ok(sent.filter((m) => m.type === 'CONFIG_VIEW').length >= 1, 'the server view is read back');
  assert.equal(await done, true);
  assert.equal(dialog(), null, 'the dialog closed');
});

test('an operator adds a cluster: CLUSTER_SAVE with replace null', async () => {
  await asOperator();
  const done = E.editCluster(null);
  await tick();
  assert.match(dialog().textContent, /Add cluster/);
  document.querySelector('#ce-name').value = 'Gamma';
  document.querySelector('#ce-url').value = 'https://gamma:9200/';
  press('Add cluster');
  await tick(80);
  const save = sent.find((m) => m.type === 'CLUSTER_SAVE');
  assert.ok(save);
  assert.equal(save.replace, null);
  assert.deepEqual(save.cluster, { name: 'Gamma', url: 'https://gamma:9200' });
  assert.equal(await done, true);
});

test('a refused save stays in the dialog with the core\'s reason', async () => {
  await asOperator();
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.type !== 'CLUSTER_SAVE') return real(url, init);
    const reply = { ok: false, kind: 'name_taken', message: 'another cluster is already called "Beta"' };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => reply, text: async () => JSON.stringify(reply) };
  };
  try {
    E.editCluster(null);
    await tick();
    document.querySelector('#ce-name').value = 'Gamma';
    document.querySelector('#ce-url').value = 'https://gamma:9200';
    press('Add cluster');
    await tick(80);
    assert.ok(dialog(), 'the dialog stays open');
    assert.match(dialog().textContent, /another cluster is already called "Beta"/);
  } finally {
    globalThis.fetch = real;
    closeAll();
  }
});

test('an admin still edits the file: Remove, the credential block, CONFIG_WRITE', async () => {
  await asAdmin();
  assert.equal(E.editsFileDirectly(), true);
  const alpha = E.rawClusterOf(S.clusters().find((c) => c.name === 'Alpha'));
  const done = E.editCluster(alpha);
  await tick();
  assert.ok(buttons().includes('Remove'));
  assert.ok(document.querySelector('#ce-cp') && document.querySelector('#ce-cu'), 'the credential fields are there');
  assert.equal(dialog().querySelector('.ce-managed-cred'), null);
  document.querySelector('#ce-note').value = 'by the admin';
  press('Save');
  await tick(80);
  const write = sent.find((m) => m.type === 'CONFIG_WRITE');
  assert.ok(write, `CONFIG_WRITE was sent (sent: ${sent.map((m) => m.type).join(', ')})`);
  assert.ok(!sent.some((m) => m.type === 'CLUSTER_SAVE'));
  const written = JSON.parse(write.text);
  assert.equal(written.clusters[0].note, 'by the admin');
  assert.equal(written.clusters[0].password, 'alpha-pw', 'the admin\'s file keeps its credentials');
  assert.equal(await done, true);
});

test('automations: an operator saves them with AUTOMATIONS_SAVE, an admin with the file', async () => {
  await asOperator();
  S.state.config.raw.automations = [{ id: 'r1', name: 'old logs', action: 'delete' }];
  await E.saveAutomations();
  const save = sent.find((m) => m.type === 'AUTOMATIONS_SAVE');
  assert.ok(save, `AUTOMATIONS_SAVE was sent (sent: ${sent.map((m) => m.type).join(', ')})`);
  assert.deepEqual(save.automations, [{ id: 'r1', name: 'old logs', action: 'delete' }]);
  assert.ok(!sent.some((m) => m.type === 'CONFIG_WRITE'));
  await asAdmin();
  S.state.config.raw.automations = [{ id: 'r2', name: 'x', action: 'close' }];
  await E.saveAutomations();
  assert.ok(sent.some((m) => m.type === 'CONFIG_WRITE'));
  assert.ok(!sent.some((m) => m.type === 'AUTOMATIONS_SAVE'));
});
