/** Every failure the page shows carries a code: the core's when it sent one, the browser's otherwise. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const M = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/error-codes.js')).href);

test('a core refusal keeps its own code and is not stamped twice', () => {
  const r = M.stampReply({ ok: false, kind: 'bad_credentials', errorCode: 'EP-102', message: 'wrong (EP-102)' });
  assert.equal(r.message, 'wrong (EP-102)');
  assert.equal(M.stampReply(r).message, 'wrong (EP-102)');
});

test('a failure the core never sent gets the browser code, or EP-999', () => {
  assert.equal(M.stampReply({ ok: false, kind: 'worker_error', message: 'offline' }).message, 'offline (EP-601)');
  assert.equal(M.stampReply({ ok: false, kind: 'something_new' }).errorCode, 'EP-999');
  assert.equal(M.stampReply({ ok: false }).message, 'failed (EP-999)');
});

test('success and no reply are left alone', () => {
  const ok = { ok: true, message: 'fine' };
  assert.equal(M.stampReply(ok), ok);
  assert.equal(M.stampReply(null), null);
});

test('errorText: the reply when there is one, else the fallback with a code', () => {
  assert.equal(M.errorText({ ok: false, message: 'nope', errorCode: 'EP-110' }), 'nope (EP-110)');
  assert.equal(M.errorText(null, 'Sign-in failed.'), 'Sign-in failed. (EP-602)');
  assert.equal(M.errorText(undefined, 'x', 'sso_failed'), 'x (EP-604)');
});

test('every browser code is in docs/ERROR-CODES.md, in the 6xx range, once', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/ERROR-CODES.md'), 'utf8');
  const codes = Object.values(M.UI_CODES);
  assert.equal(new Set(codes).size, codes.length);
  for (const [kind, code] of Object.entries(M.UI_CODES)) {
    assert.match(code, /^EP-6\d\d$/);
    assert.ok(doc.includes(`| ${code} | \`${kind}\``), `${code} ${kind} missing from the doc`);
  }
});

test('a pairing code in `code` is never taken for an error code', () => {
  const r = M.stampReply({ ok: false, kind: 'forbidden', code: 'PAIR-123', message: 'refused' });
  assert.equal(r.code, 'PAIR-123');
  assert.equal(r.message, 'refused (EP-999)');
});
