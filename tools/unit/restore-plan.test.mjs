/**
 * Restoring what a search found: each index comes from its newest SUCCESS snapshot, and
 * indices from the same snapshot go in one restore request.
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
const { restorePlan, restoreSourceOf } = await import(pathToFileURL(path.join(ROOT, 'ui/js/ui/snapshot-dialogs.js')).href);

const snap = (repo, snapshot, st, start) => ({ repo, snapshot, state: st, start });

test('the source is the newest successful copy, never a partial one', () => {
  const found = { index: 'a', snapshots: [snap('daily', 'n3', 'PARTIAL', 3), snap('daily', 'n2', 'SUCCESS', 2), snap('daily', 'n1', 'SUCCESS', 1)] };
  assert.equal(restoreSourceOf(found).snapshot, 'n2');
  assert.equal(restoreSourceOf({ index: 'b', snapshots: [snap('daily', 'x', 'FAILED', 1)] }), null);
});

test('one request per snapshot, and an index with no good copy is left out', () => {
  const plan = restorePlan([
    { index: 'a', snapshots: [snap('daily', 's2', 'SUCCESS', 2)] },
    { index: 'b', snapshots: [snap('daily', 's2', 'SUCCESS', 2)] },
    { index: 'c', snapshots: [snap('weekly', 'w1', 'SUCCESS', 1)] },
    { index: 'd', snapshots: [snap('daily', 's9', 'FAILED', 9)] },
  ]);
  assert.deepEqual(plan, [
    { repo: 'daily', snapshot: 's2', indices: ['a', 'b'] },
    { repo: 'weekly', snapshot: 'w1', indices: ['c'] },
  ]);
});
