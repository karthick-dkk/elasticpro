/** The gate's refusals in the browser: an overloaded read is asked once more, a write never. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
// transport.js clears old session keys from storage on load; give it somewhere to do that.
globalThis.sessionStorage ??= { removeItem() {} };
globalThis.localStorage ??= { removeItem() {} };
const calls = [];
let answers = [];
globalThis.fetch = async (url, init) => {
  calls.push(JSON.parse(init.body));
  const body = answers.shift() || { ok: true };
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
};
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/transport.js')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/error-codes.js')).href);

test('an overloaded read is retried once, after the time the core named', async () => {
  calls.length = 0;
  answers = [{ ok: false, kind: 'overloaded', retryAfterMs: 300, errorCode: 'EP-214', message: 'busy (EP-214)' }, { ok: true, json: { status: 'green' } }];
  const t0 = Date.now();
  const r = await T.bridge({ type: 'ES', clusterId: 'c', method: 'GET', path: '/_cluster/health', origin: 'page:overview' });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - t0 >= 290, 'it waited before asking again');
});

test('only once: a second refusal is the answer', async () => {
  calls.length = 0;
  const busy = { ok: false, kind: 'overloaded', retryAfterMs: 1, errorCode: 'EP-214', message: 'busy (EP-214)' };
  answers = [busy, busy, { ok: true }];
  const r = await T.bridge({ type: 'ES', clusterId: 'c', method: 'GET', path: '/', origin: 'page:overview' });
  assert.equal(r.kind, 'overloaded');
  assert.equal(calls.length, 2);
});

test('a write and a queue timeout are never retried', async () => {
  for (const [msg, ans] of [
    [{ type: 'ES', clusterId: 'c', method: 'DELETE', path: '/idx', allowWrites: true }, { ok: false, kind: 'overloaded', retryAfterMs: 1 }],
    [{ type: 'ES', clusterId: 'c', method: 'GET', path: '/' }, { ok: false, kind: 'queue_timeout' }],
  ]) {
    calls.length = 0;
    answers = [ans, { ok: true }];
    const r = await T.bridge(msg);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 1, JSON.stringify(msg));
  }
  assert.equal(T.overloadRetryMs({ kind: 'overloaded', retryAfterMs: 99999 }, { type: 'PING' }), 10000, 'bounded');
  assert.equal(T.overloadRetryMs({ kind: 'overloaded' }, { type: 'PING' }), 1000, 'a default when the core named none');
});

test('leaving a page aborts its requests: answered "aborted" with the core\'s code', async () => {
  calls.length = 0;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const p = T.bridge({ type: 'ES', clusterId: 'c', method: 'GET', path: '/slow', origin: 'page:logs' });
  T.abortPage('page:logs');
  const r = await p;
  assert.equal(r.kind, 'aborted');
  assert.equal(r.errorCode, 'EP-208');
});

test('the browser\'s copy of the core codes matches errors.rs', () => {
  const rs = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/errors.rs'), 'utf8');
  for (const [kind, code] of Object.entries(E.CORE_CODES)) {
    assert.ok(rs.includes(`("${kind}", "${code}")`), `${kind} ${code} is not what errors.rs says`);
  }
});
