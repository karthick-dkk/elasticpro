/** QA-01: when the UI checks may skip for want of jsdom, and when they must fail instead. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { jsdomRequired } = await import(pathToFileURL(path.join(ROOT, 'tools/lib/jsdom-app.mjs')).href);

test('jsdom is required under CI or with --require-jsdom, and only then', () => {
  assert.equal(jsdomRequired(['node', 'x'], {}), false);
  assert.equal(jsdomRequired(['node', 'x', '--require-jsdom'], {}), true);
  for (const v of ['1', 'true', 'TRUE', 'yes']) assert.equal(jsdomRequired(['node', 'x'], { CI: v }), true, v);
  for (const v of ['', '0', 'false', ' ']) assert.equal(jsdomRequired(['node', 'x'], { CI: v }), false, JSON.stringify(v));
});
