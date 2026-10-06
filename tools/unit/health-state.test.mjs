/** One cluster's health, one definition — the top bar and the Clusters page both read it. */
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
const { healthState } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);

test('each state, and never-read is loading, not green', () => {
  assert.equal(healthState(null), 'loading');
  assert.equal(healthState({ reachable: false, updatedAt: 0, healthUnknown: true }), 'loading');
  assert.equal(healthState({ reachable: false, updatedAt: 5 }), 'unreachable');
  assert.equal(healthState({ reachable: true, updatedAt: 5, health: { status: 'red' } }), 'red');
  assert.equal(healthState({ reachable: true, updatedAt: 5, health: { status: 'yellow' } }), 'yellow');
  assert.equal(healthState({ reachable: true, updatedAt: 5, health: { status: 'green' } }), 'green');
  assert.equal(healthState({ reachable: true, updatedAt: 5, health: {} }), 'loading');
});
