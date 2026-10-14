/**
 * The Automation page and the fleet: opening it must not read every cluster.
 *
 * A check is an index list and a full snapshot listing per cluster — measured at 225
 * CLUSTER_DATASET for 120 clusters on open. With the fleet cache and more than one cluster
 * the page waits for the coverage bar's Read all; one cluster, or no cache, still reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'SVGElement', 'HTMLElement', 'customElements', 'localStorage', 'sessionStorage', 'navigator', 'location']) {
  if (!(k in globalThis) || globalThis[k] === undefined) {
    try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
  }
}
const { readsOnOpen } = await import(pathToFileURL(path.join(ROOT, 'ui/js/pages/automation.js')).href);

test('fleet mode with many clusters: opening the page reads nothing', () => {
  assert.equal(readsOnOpen(true, 2), false);
  assert.equal(readsOnOpen(true, 120), false);
});

test('one selected cluster still reads on open: the page asks for what it shows', () => {
  assert.equal(readsOnOpen(true, 1), true);
  assert.equal(readsOnOpen(true, 0), true);
});

test('without the fleet cache the page reads as it always did', () => {
  assert.equal(readsOnOpen(false, 1), true);
  assert.equal(readsOnOpen(false, 120), true);
});
