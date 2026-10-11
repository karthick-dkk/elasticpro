/**
 * The pollers that watch a restore or a shard move read a `_cat` endpoint asked with
 * format=json, which answers a list of rows. When something else comes back the operator
 * used to be shown the raw JavaScript error "rows.map is not a function", which says
 * nothing about their cluster — it was reported as a product bug from a Snapshots page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'customElements', 'localStorage']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { rowsOf } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/tasks.js')).href);

test('a list of rows passes through untouched', () => {
  const rows = [{ index: 'logstash-1', shard: '0', stage: 'done' }];
  assert.equal(rowsOf(rows, '/_cat/recovery'), rows);
  assert.deepEqual(rowsOf([], '/_cat/recovery'), [], 'an empty listing is a valid answer');
});

test('an object names the endpoint instead of throwing rows.map', () => {
  // Exactly what a cluster with no /_cat/recovery route sends back.
  assert.throws(() => rowsOf({ acknowledged: true, url: '/_cat/recovery/x' }, '/_cat/recovery'), (e) => {
    assert.doesNotMatch(e.message, /is not a function/, 'a raw TypeError tells the operator nothing');
    assert.match(e.message, /_cat\/recovery/, 'the message has to name what misbehaved');
    return true;
  });
});

test('null, a string and a number are refused the same way', () => {
  for (const bad of [null, undefined, 'not json', 42, true]) {
    assert.throws(() => rowsOf(bad, '/_cat/shards'), /_cat\/shards/);
  }
});

test('each caller names its own endpoint', () => {
  assert.throws(() => rowsOf({}, '/_cat/shards'), /_cat\/shards/);
  assert.throws(() => rowsOf({}, '/_cat/recovery'), /_cat\/recovery/);
});
