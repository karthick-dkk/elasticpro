/**
 * Empty states.
 *
 * These are the branches nothing else reaches: render-check draws every page against a
 * fixture that has data, so the "there is nothing here" path never runs, and a missing
 * import inside it stays invisible until a real cluster comes back empty. That is how
 * two of them shipped broken while both checks were green.
 *
 * What is asserted is the distinction the whole product turns on — an absence and a
 * failure must not render the same — plus the shape callers depend on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'SVGElement', 'HTMLElement', 'customElements']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { empty, unreadable, table } = await import(pathToFileURL(path.join(ROOT, 'ui/js/pages/common.js')).href);

test('a plain reason still renders as it always did', () => {
  const el = empty('Nothing held back');
  assert.equal(el.className, 'tbl-empty');
  assert.equal(el.textContent, 'Nothing held back');
  assert.equal(el.querySelector('.acts'), null, 'nothing to do should offer no buttons');
});

test('a reason with evidence keeps them apart', () => {
  const el = empty('The cluster answered, but listed no nodes.', {
    detail: 'GET /_cat/nodes returned nothing',
  });
  assert.match(el.className, /rich/);
  assert.equal(el.querySelector('.why').textContent, 'The cluster answered, but listed no nodes.');
  assert.match(el.querySelector('.detail').textContent, /_cat\/nodes/);
});

test('actions are rendered, and absent ones are not holes', () => {
  const btn = document.createElement('button');
  btn.textContent = 'Retry';
  const el = empty('Nothing here.', { actions: [btn, null, undefined] });
  const acts = el.querySelector('.acts');
  assert.equal(acts.children.length, 1, 'a null action must not leave a gap');
  assert.equal(acts.textContent, 'Retry');
});

test('an empty actions list draws no action row at all', () => {
  const el = empty('Nothing here.', { detail: 'because', actions: [] });
  assert.equal(el.querySelector('.acts'), null);
});

test('"could not be read" never reads as "there is none"', () => {
  // The distinction the rest of the codebase already insists on. If these two ever
  // render the same string, an operator is told the cluster is fine when it is unknown.
  const none = empty('This cluster has no snapshot repository.');
  const broken = unreadable('The repository list', 'HTTP 403 forbidden');
  assert.notEqual(none.textContent, broken.textContent);
  assert.match(broken.textContent, /could not be read/);
  assert.match(broken.textContent, /403/);
});

test('unreadable says so even when the cluster gave no reason', () => {
  const el = unreadable('The node list', '');
  assert.match(el.textContent, /could not be read/);
  assert.match(el.textContent, /no reason/);
});

test('a table with no rows shows the empty state it was given', () => {
  const el = empty('No cluster is selected.', { detail: 'pick one' });
  const t = table(['A', 'B'], [], { emptyText: el });
  assert.match(t.textContent, /No cluster is selected/);
  assert.match(t.textContent, /pick one/);
  // It spans the table rather than sitting under the first column.
  assert.equal(t.querySelector('tbody td').getAttribute('colspan'), '2');
});

test('a table with rows shows no empty state', () => {
  const tr = document.createElement('tr');
  tr.innerHTML = '<td>x</td><td>y</td>';
  const t = table(['A', 'B'], [tr], { emptyText: empty('should not appear') });
  assert.doesNotMatch(t.textContent, /should not appear/);
});
