/**
 * 0.3.46 — "a new cluster that uses the default credential never asks for a password".
 * The pure parts: what CREDENTIAL_PROMOTE sends, how the choices read, which credential the
 * Add/Edit dialog starts on, who rejected the default, and that a PRIME which says the default
 * covers a cluster takes it off the "needs a credential" list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const sent = [];
let reply = { ok: true };
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  sent.push(msg);
  const r = typeof reply === 'function' ? reply(msg) : reply;
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => r, text: async () => JSON.stringify(r) };
};
const K = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/server-credentials.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);

test('promoteCredential sends CREDENTIAL_PROMOTE, replace only when asked, and says why it failed', async () => {
  sent.length = 0;
  reply = { ok: true, cluster: '*', from: 'Local-ES-Cluster', user: 'zabbix', kind: 'basic', replaced: false };
  const r = await K.promoteCredential('Local-ES-Cluster');
  assert.equal(r.user, 'zabbix');
  await K.promoteCredential('cfg:alpha', { replace: true });
  assert.deepEqual(sent, [
    { type: 'CREDENTIAL_PROMOTE', from: 'Local-ES-Cluster' },
    { type: 'CREDENTIAL_PROMOTE', from: 'cfg:alpha', replace: true },
  ]);
  assert.ok(sent.every((m) => !('password' in m) && !('username' in m)), 'nothing typed travels');
  reply = { ok: false, kind: 'exists', message: 'a default credential is already set (fleet, set by Admin); say replace to replace it' };
  await assert.rejects(K.promoteCredential('x'), /already set/);
});

test('the status carries promotable entries only while there is no default', async () => {
  const entry = { id: 'Local-ES-Cluster', cluster: 'Local-ES-Cluster', source: 'zabbix', user: 'zabbix', kind: 'basic' };
  reply = { ok: true, default: null, clusters: [], promotable: [entry], problem: null };
  assert.deepEqual((await K.keptCredentials()).promotable, [entry]);
  reply = { ok: true, default: { id: '*', user: 'fleet', kind: 'basic' }, clusters: [], promotable: [entry] };
  assert.deepEqual((await K.keptCredentials()).promotable, [], 'a default set: nothing to offer');
  reply = { ok: true, default: null, clusters: [] };   // an older core
  assert.deepEqual((await K.keptCredentials()).promotable, []);
  reply = { ok: false, message: 'forbidden' };
  assert.deepEqual((await K.keptCredentials()).promotable, []);
});

test('how the choices read — never a secret', () => {
  assert.equal(K.promotableLabel({ id: 'Local-ES-Cluster', cluster: 'Local-ES-Cluster', user: 'zabbix', kind: 'basic' }),
    'Local-ES-Cluster’s credential (user zabbix)');
  assert.equal(K.promotableLabel({ id: 'cfg:alpha', cluster: 'alpha', user: null, kind: 'header' }), 'alpha’s API key or token');
  assert.equal(K.promotableLabel(null), '');
  assert.equal(K.defaultChoiceLabel({ user: 'fleet', kind: 'basic' }), 'Default credential (user fleet)');
  assert.equal(K.defaultChoiceLabel({ user: null, kind: 'header' }), 'Default credential (an API key or token)');
  assert.equal(K.defaultChoiceLabel(null), 'Default credential — none set yet');
});

test('a new cluster starts on the default; one with its own keeps it', () => {
  assert.equal(K.initialCredentialChoice({}), 'default');
  assert.equal(K.initialCredentialChoice(), 'default');
  assert.equal(K.initialCredentialChoice({ keptOwn: { id: 'alpha', user: 'a' } }), 'own');
  assert.equal(K.initialCredentialChoice({ fileOwn: true }), 'own');
});

test('who rejected the default: config clusters without their own, Zabbix clusters on core-default', () => {
  const status = { default: { id: '*', user: 'fleet' }, clusters: [{ id: 'own-one', user: 'x' }] };
  const list = [
    { id: 'plain', name: 'plain' },
    { id: 'own-one', name: 'own-one' },
    { id: 'fine', name: 'fine' },
    { id: 'zbx-a', name: 'zbx-a', source: 'zabbix', zabbix: { credential: 'core-default' } },
    { id: 'zbx-b', name: 'zbx-b', source: 'zabbix', zabbix: { credential: 'core-secret' } },
  ];
  const stateOf = (id) => (id === 'fine' ? 'online' : 'auth_error');
  assert.deepEqual(K.rejectedDefault(list, stateOf, status).map((c) => c.id), ['plain', 'zbx-a']);
  assert.deepEqual(K.rejectedDefault(list, stateOf, { default: null, clusters: [] }), [], 'no default, nothing rejected it');
  assert.deepEqual(K.rejectedDefault(list, stateOf, null), []);
});

test('a PRIME that says the default covers clusters takes them off the sign-in list', () => {
  const fresh = () => {
    S.state.config = { clusters: [
      { id: 'new', name: 'new', url: 'http://es-new:9200', enabled: true, needsCred: true, anonymous: false, credSource: 'none', source: 'file' },
      { id: 'open', name: 'open', url: 'http://es-open:9200', enabled: true, needsCred: true, anonymous: true, credSource: 'none', source: 'file' },
      { id: 'forgot', name: 'forgot', url: 'http://es-f:9200', enabled: true, needsCred: true, anonymous: false, clearCred: true, credSource: 'none', source: 'file' },
    ], fileMeta: { name: 'config_cluster.json' } };
  };
  fresh();
  S.markServerDefault(undefined);   // an older core says nothing: nothing changes
  assert.deepEqual(S.clustersNeedingCredential().map((c) => c.id), ['forgot', 'new']);
  assert.equal(S.serverDefaultCredential(), null);
  S.markServerDefault(false);
  assert.deepEqual(S.clustersNeedingCredential().map((c) => c.id), ['forgot', 'new']);
  assert.equal(S.serverDefaultCredential(), false);
  S.markServerDefault(true);
  assert.deepEqual(S.clustersNeedingCredential().map((c) => c.id), ['forgot'], 'a credential forgotten on purpose is not re-covered');
  const c = S.state.config.clusters.find((x) => x.id === 'new');
  assert.equal(c.credSource, 'server');
  assert.equal(c.username, '(default credential)');
  assert.equal(S.state.config.clusters.find((x) => x.id === 'open').credSource, 'none', 'anonymous stays anonymous');
  S.state.config = null;
});
