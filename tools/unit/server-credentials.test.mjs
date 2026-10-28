/**
 * Credentials kept on the hosted server (core/server-credentials.js): the message each form
 * sends, what the status line says, and that nothing is ever read back or kept in the browser.
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

test('the fields each kind of credential sends', () => {
  assert.deepEqual(K.credentialFields({ username: ' elastic ', password: 'p w' }), { username: 'elastic', password: 'p w' });
  assert.deepEqual(K.credentialFields({ apiKey: ' a2V5 ' }), { apiKey: 'a2V5' });
  assert.deepEqual(K.credentialFields({ bearer: 'tok' }), { bearer: 'tok' });
  assert.equal(K.credentialFields({ username: 'elastic', password: '' }), null, 'a username alone is not a credential');
  assert.equal(K.credentialFields({ username: '', password: 'p' }), null);
  assert.equal(K.credentialFields(null), null);
});

test('portable keeps credentials in the file; hosted on the server', () => {
  assert.equal(K.credentialsKeptOnServer(), false);
  K.setHostedEdition(true);
  assert.equal(K.credentialsKeptOnServer(), true);
  K.setHostedEdition(false);
});

test('keepCredential sends CREDENTIAL_SET for one cluster or the default, and says why it failed', async () => {
  sent.length = 0;
  reply = { ok: true, cluster: '*' };
  await K.keepCredential(K.DEFAULT_CREDENTIAL, { username: 'fleet', password: 'pw' });
  await K.keepCredential('prod-es', { apiKey: 'abc' });
  assert.deepEqual(sent.map(({ type, cluster, username, password, apiKey }) => ({ type, cluster, username, password, apiKey })), [
    { type: 'CREDENTIAL_SET', cluster: '*', username: 'fleet', password: 'pw', apiKey: undefined },
    { type: 'CREDENTIAL_SET', cluster: 'prod-es', username: undefined, password: undefined, apiKey: 'abc' },
  ]);
  await assert.rejects(K.keepCredential('x', { username: 'u' }), /username and a password/);
  reply = { ok: false, message: 'the cluster secret key is 5 characters; at least 32 are required' };
  await assert.rejects(K.keepCredential('x', { username: 'u', password: 'p' }), /at least 32/);
  reply = { ok: true, cleared: true };
  await K.forgetCredential('prod-es');
  assert.equal(sent.at(-1).type, 'CREDENTIAL_CLEAR');
  assert.equal(sent.at(-1).cluster, 'prod-es');
});

test('the status: which entry is whose, and a line that never shows a secret', async () => {
  reply = { ok: true, default: { id: '*', user: 'fleet', kind: 'basic', setBy: 'Admin', setAt: 1793000000 },
    clusters: [{ id: 'prod-es', user: null, kind: 'header', setBy: 'Admin', setAt: 1793000000 }], problem: null };
  const st = await K.keptCredentials();
  assert.equal(K.keptFor(st, '*').user, 'fleet');
  assert.equal(K.keptFor(st, 'prod-es').kind, 'header');
  assert.equal(K.keptFor(st, 'other'), null);
  assert.match(K.keptLine(K.keptFor(st, '*')), /^fleet · set by Admin on /);
  assert.match(K.keptLine(K.keptFor(st, 'prod-es')), /^API key or token · set by Admin/);
  assert.equal(K.keptLine(null), '');
  reply = { ok: false, kind: 'forbidden', message: 'CREDENTIAL_STATUS is not available to the operator role' };
  const no = await K.keptCredentials();
  assert.equal(no.ok, false);
  assert.deepEqual(no.clusters, []);
  assert.match(no.problem, /operator/);
});
