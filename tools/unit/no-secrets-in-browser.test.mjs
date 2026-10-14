/**
 * No secret in browser storage. The session token is never written to localStorage or
 * sessionStorage (the server holds it, the browser carries only the HttpOnly cookie), and
 * a console request's password/token fields are redacted before history is stored.
 *
 * Regression: reported 2026-10-14 — "never use browser local storage for passwords/secure
 * information, only Redis, DB and backends".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

function recordingStorage() {
  const writes = [];
  const m = new Map();
  return { writes, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { writes.push([k, v]); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k) };
}

test('the session token never touches localStorage or sessionStorage', async () => {
  globalThis.localStorage = recordingStorage();
  globalThis.sessionStorage = recordingStorage();
  globalThis.location = { search: '' };
  const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/transport.js')).href + '?t=1');
  T.setSession('a'.repeat(64)); T.setSignedIn(true); T.setSignedIn(false); T.setSession('b'.repeat(64));
  assert.deepEqual(globalThis.localStorage.writes, [], 'nothing written to localStorage');
  assert.deepEqual(globalThis.sessionStorage.writes, [], 'nothing written to sessionStorage');
  assert.equal(T.getSession(), 'b'.repeat(64), 'kept in memory only');
});

test('console history keeps no password, token or key', async () => {
  const { redactSecrets, REDACTED } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/redact.js')).href);
  const body = '{ "password": "hunter2-really", "roles": ["superuser"], "full_name": "A", "metadata": {"api_key": "abc\\"d"},\n "refresh_token": "t0k", "passphrase":"p" }';
  const out = redactSecrets(body);
  for (const s of ['hunter2-really', 'abc', 't0k', '"p"']) assert.ok(!out.includes(s), `${s} survived: ${out}`);
  assert.equal(out.split(REDACTED).length - 1, 4);
  // A body holding a secret is stored re-serialised; everything that is not a secret is kept.
  const kept = JSON.parse(out);
  assert.deepEqual(kept.roles, ['superuser']); assert.equal(kept.full_name, 'A');
  assert.equal(redactSecrets('GET-like, no body'), 'GET-like, no body');
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets('{"query":{"match_all":{}}}'), '{"query":{"match_all":{}}}');
});

test('a path keeps no password, token or URL credentials either', async () => {
  const { redactPath, REDACTED } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/redact.js')).href);
  const out = redactPath('/_security/_authenticate?pretty&password=hunter2&api_key=abc&size=10');
  assert.ok(!out.includes('hunter2') && !out.includes('abc'), out);
  assert.ok(out.includes('pretty') && out.includes('size=10'), 'the rest is kept');
  assert.equal(redactPath('https://ops:s3cret@es.local:9200/_cat/health'), `https://${REDACTED}@es.local:9200/_cat/health`);
  assert.equal(redactPath('/_cat/indices?v&h=index,docs.count'), '/_cat/indices?v&h=index,docs.count');
  assert.equal(redactPath('/x?access%5Ftoken=t1'), `/x?access%5Ftoken=${REDACTED}`);
});

test('redaction reads keys as a JSON parser does: escapes, numbers, nesting, NDJSON', async () => {
  const { redactSecrets } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/redact.js')).href);
  const esc = redactSecrets('{"pass\\u0077ord":"hunter2-really","roles":["viewer"]}');
  assert.ok(!esc.includes('hunter2-really'), `an escaped key slipped through: ${esc}`);
  const num = redactSecrets('{"user":"a","password":12345678}');
  assert.ok(!num.includes('12345678'), `a numeric secret slipped through: ${num}`);
  const nested = redactSecrets('{"metadata":{"credentials":{"user":"a","key":"k"}},"keep":1}');
  assert.ok(!nested.includes('"k"') && nested.includes('"keep":1'), nested);
  const nd = redactSecrets('{"index":{"_index":"x"}}\n{"token":"t-secret","msg":"hi"}\n');
  assert.ok(!nd.includes('t-secret') && nd.includes('"msg":"hi"') && nd.includes('_index'), nd);
  const broken = redactSecrets('{"pass\\u0077ord": "zzz-secret", oops');
  assert.ok(!broken.includes('zzz-secret'), `not-JSON fallback missed an escaped key: ${broken}`);
  assert.equal(redactSecrets('{"query":{"match_all":{}}}'), '{"query":{"match_all":{}}}', 'nothing secret: kept exactly as typed');
});
