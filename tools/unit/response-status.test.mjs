/** The REST console's status pill — core/response-status.js: one label and tone per answer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/response-status.js')).href);

test('nothing run yet is a grey dash, not a zero or an error', () => {
  assert.deepEqual(S.responseStatus(null), { label: '—', tone: 'grey' });
  assert.deepEqual(S.responseStatus(undefined), { label: '—', tone: 'grey' });
});

test('2xx green, 3xx and 4xx amber, 5xx red', () => {
  assert.deepEqual(S.responseStatus({ status: 200, ok: true }), { label: 'HTTP 200', tone: 'green' });
  assert.deepEqual(S.responseStatus({ status: 201, ok: true }), { label: 'HTTP 201', tone: 'green' });
  assert.deepEqual(S.responseStatus({ status: 304, ok: false }), { label: 'HTTP 304', tone: 'yellow' });
  assert.deepEqual(S.responseStatus({ status: 404, ok: false }), { label: 'HTTP 404', tone: 'yellow' });
  assert.deepEqual(S.responseStatus({ status: 429, ok: false }), { label: 'HTTP 429', tone: 'yellow' });
  assert.deepEqual(S.responseStatus({ status: 500, ok: false }), { label: 'HTTP 500', tone: 'red' });
  assert.deepEqual(S.responseStatus({ status: 503, ok: false }), { label: 'HTTP 503', tone: 'red' });
  assert.equal(S.responseStatus({ status: '200' }).label, 'HTTP 200', 'a status given as text still reads');
});

test('no answer at all is red and named by its kind; the read-only refusal is amber', () => {
  assert.deepEqual(S.responseStatus({ status: 0, kind: 'tunnel_error', message: 'no route' }), { label: 'tunnel_error', tone: 'red' });
  assert.deepEqual(S.responseStatus({ status: 0, kind: 'tls_untrusted' }), { label: 'tls_untrusted', tone: 'red' });
  assert.deepEqual(S.responseStatus({ status: 0, message: 'socket hang up' }), { label: 'error', tone: 'red' });
  assert.deepEqual(S.responseStatus({ status: 0, kind: 'blocked_readonly' }), { label: 'blocked_readonly', tone: 'yellow' });
});

test('the size is the JSON re-serialised, else the text, else nothing', () => {
  assert.equal(S.responseSize({ json: { a: 1 } }), 7);
  assert.equal(S.responseSize({ json: null, text: 'green open idx' }), 14);
  assert.equal(S.responseSize({ text: '' }), 0);
  assert.equal(S.responseSize(null), 0);
});
