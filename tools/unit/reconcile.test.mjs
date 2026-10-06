/**
 * lib/dom.js reconcile(): a container's children made exactly the given list, touching
 * only what differs. Kept rows must not be moved — a moved element is restyled and laid
 * out again, which is the cost keeping it was meant to save.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const { reconcile } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/dom.js')).href);

function box(n) {
  const el = document.createElement('div');
  const kids = Array.from({ length: n }, (_, i) => { const d = document.createElement('p'); d.textContent = String(i); return d; });
  el.append(...kids);
  return { el, kids };
}
/** Count DOM insertions, which is what a move is. */
function counting(el) {
  let moves = 0;
  const real = el.insertBefore.bind(el);
  el.insertBefore = (a, b) => { moves++; return real(a, b); };
  return () => moves;
}

test('same list: nothing is touched', () => {
  const { el, kids } = box(5);
  const moves = counting(el);
  reconcile(el, kids);
  assert.equal(moves(), 0);
  assert.deepEqual([...el.children], kids);
});

test('one row replaced at the top: one insertion, the others stay put', () => {
  const { el, kids } = box(50);
  const moves = counting(el);
  const fresh = document.createElement('p');
  const next = [fresh, ...kids.slice(1)];
  reconcile(el, next);
  assert.equal(moves(), 1, `expected one insertion, saw ${moves()}`);
  assert.deepEqual([...el.children], next);
});

test('rows removed, added and reordered all end in the given order', () => {
  const { el, kids } = box(6);
  const a = document.createElement('p'), b = document.createElement('p');
  const next = [kids[5], a, kids[0], kids[2], b];
  reconcile(el, next);
  assert.deepEqual([...el.children], next);
});

test('an empty list empties the container', () => {
  const { el, kids } = box(3);
  reconcile(el, []);
  assert.equal(el.childNodes.length, 0);
  assert.equal(kids[0].parentNode, null);
});
