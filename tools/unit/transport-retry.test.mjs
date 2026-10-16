/** The browser's answer when nginx, not the core, replies: retry what never reached the core, explain the rest. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/transport.js')).href);

const reply = (status, body, headers = {}) => ({
  status, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const NGINX = (code, title) => `<html>\r\n<head><title>${code} ${title}</title></head>\r\n<body></body></html>`;
function serve(...answers) {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(init.body); return answers.shift(); };
  return calls;
}

test('a 429 is retried and the core\'s answer comes through', async () => {
  const calls = serve(reply(429, NGINX(429, 'Too Many Requests')), reply(429, NGINX(429, 'Too Many Requests')), reply(200, { ok: true, n: 1 }));
  const r = await T.bridge({ type: 'PING' });
  assert.deepEqual(r, { ok: true, n: 1 });
  assert.equal(calls.length, 3);
});

test('an HTML page from nginx says what it means, with a code, not "Unexpected token <"', async () => {
  serve(reply(502, NGINX(502, 'Bad Gateway')), reply(502, NGINX(502, 'Bad Gateway')));
  const down = await T.bridge({ type: 'REQUEST_LOG' });
  assert.equal(down.kind, 'core_unavailable');
  assert.match(down.message, /core is not answering nginx.*\(HTTP 502\) \(EP-607\)$/);
  assert.doesNotMatch(down.message, /Unexpected token/);
});

test('a 504 is never retried: the core may have done the work', async () => {
  const calls = serve(reply(504, NGINX(504, 'Gateway Time-out')));
  const r = await T.bridge({ type: 'ES', method: 'DELETE', path: '/x' });
  assert.equal(calls.length, 1);
  assert.equal(r.errorCode, 'EP-608');
});

test('nginx\'s own JSON 429 (the new config) is read as it is once retries run out', async () => {
  const j = { ok: false, kind: 'proxy_rate_limited', message: 'too many requests per second from this address' };
  serve(...[0, 1, 2, 3].map(() => reply(429, j, { 'retry-after': '0' })));
  const r = await T.bridge({ type: 'PING' });
  assert.equal(r.errorCode, 'EP-606');
});
