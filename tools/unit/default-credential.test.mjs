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

/* ---------------- review of f330d57 ---------------- */

test('an anonymous cluster starts on "No credential", whatever else is kept', () => {
  assert.equal(K.initialCredentialChoice({ anonymous: true }), 'none');
  assert.equal(K.initialCredentialChoice({ anonymous: true, keptOwn: { id: 'a' } }), 'none');
  assert.equal(K.initialCredentialChoice({ anonymous: false, fileOwn: true }), 'own');
});

test('setting the default from a dialog never replaces one: onlyIfAbsent, and the refusal says whose', async () => {
  sent.length = 0;
  reply = { ok: false, kind: 'exists', user: 'fleet', setBy: 'Admin', message: 'a default credential is already set (fleet, set by Admin)' };
  const err = await K.keepCredential('*', { username: 'u', password: 'p' }, { onlyIfAbsent: true }).catch((e) => e);
  assert.equal(sent.at(-1).onlyIfAbsent, true);
  assert.equal(err.kind, 'exists');
  assert.equal(err.user, 'fleet');
  reply = { ok: true };
  await K.keepCredential('alpha', { username: 'u', password: 'p' });
  assert.equal('onlyIfAbsent' in sent.at(-1), false, 'a cluster\'s own is not sent with it');
  reply = { ok: false, kind: 'exists', user: 'fleet', message: 'already set' };
  const e2 = await K.promoteCredential('cfg:a').catch((e) => e);
  assert.equal(e2.kind, 'exists');
});

test('markServerDefault(false) puts back what it (or a held mark) took off, and nothing else', () => {
  S.state.config = { clusters: [
    { id: 'a', name: 'a', url: 'http://a', enabled: true, needsCred: true, anonymous: false, credSource: 'none', source: 'file', username: '' },
    { id: 'b', name: 'b', url: 'http://b', enabled: true, needsCred: true, anonymous: false, credSource: 'none', source: 'file', username: '' },
    { id: 'f', name: 'f', url: 'http://f', enabled: true, needsCred: false, anonymous: false, credSource: 'shared', source: 'file', username: 'elastic' },
  ], fileMeta: { name: 'c.json' } };
  S.markServerHeld(['b']);
  S.markServerDefault(true, ['b']);
  assert.deepEqual(S.clustersNeedingCredential(), []);
  // The default was forgotten: the core now holds only b (its own).
  S.markServerDefault(false, ['b']);
  assert.deepEqual(S.clustersNeedingCredential().map((c) => c.id), ['a'], 'a needs one again; b is held; f has the file\'s');
  const a = S.state.config.clusters.find((c) => c.id === 'a');
  assert.equal(a.credSource, 'none');
  assert.equal(a.username, '');
  // …and b, once the core stops holding it too.
  S.markServerDefault(false, []);
  assert.deepEqual(S.clustersNeedingCredential().map((c) => c.id), ['a', 'b']);
  assert.equal(S.state.config.clusters.find((c) => c.id === 'f').needsCred, false);
  S.state.config = null;
});

test('hosted: a typed credential is never held by the page, and never rides a PRIME as the shared one', async () => {
  K.setHostedEdition(true);
  try {
    S.state.config = { clusters: [
      { id: 'a', name: 'a', url: 'http://a', enabled: true, needsCred: true, anonymous: false, credSource: 'none', source: 'file' },
      { id: 'q', name: 'q', url: 'http://q', enabled: true, needsCred: true, anonymous: true, credSource: 'none', source: 'file' },
    ], fileMeta: { name: 'c.json' }, jumpHosts: [] };
    S.state.clients.clear();
    sent.length = 0;
    reply = (m) => (m.type === 'PRIME' ? { ok: true, held: ['a'], anonymous: [], defaultCredential: true } : { ok: true });
    await S.setSessionCredential({ username: 'typed-user', password: 'typed-pw' });
    assert.equal(S.hasSessionCredential(), false, 'the page holds no typed credential on hosted');
    const primes = sent.filter((m) => m.type === 'PRIME');
    assert.ok(primes.length >= 1, 'it re-primed');
    const typedHeader = Buffer.from('typed-user:typed-pw').toString('base64');
    for (const p of primes) {
      assert.equal('sharedAuthHeader' in p, false, `a PRIME carried a shared credential: ${JSON.stringify(p.sharedAuthHeader)}`);
      assert.ok(!JSON.stringify(p).includes('typed-pw') && !JSON.stringify(p).includes(typedHeader), 'the typed credential reached a PRIME');
    }
    // An anonymous cluster given a credential: the next PRIME — and only that one — says so.
    sent.length = 0;
    S.withdrawAnonymous('q');
    await S.reprime();
    await S.reprime();
    const [first, second] = sent.filter((m) => m.type === 'PRIME');
    assert.deepEqual(first.dropAnonymous, ['q']);
    assert.ok(first.clusters.find((c) => c.id === 'q').authHeader == null, 'not "" — no longer anonymous');
    assert.equal('dropAnonymous' in second, false);
  } finally {
    K.setHostedEdition(false);
    S.state.config = null;
  }
});
