/**
 * Redraws that touch only what changed (0.3.54 flicker pass): lib/keyed.js markupSig and
 * nodeCache.same, and pages/common.js keptCard / keptTable built on them.
 *
 * A page that redraws on a timer used to build a new tree and put it in place of the old one,
 * so the row under the mouse, an open <details> or <select> and a field being typed into were
 * replaced every few seconds. These pin the rules: an element drawn the same is the element
 * already there; a field's typed text counts as what it shows; a kept card keeps its section
 * while its subtitle and rows change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>');
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'MutationObserver']) {
  globalThis[k] = k === 'window' ? dom.window : dom.window[k];
}
const mod = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { h } = await mod('ui/js/lib/dom.js');
const { nodeCache, markupSig } = await mod('ui/js/lib/keyed.js');
const { keptCard, keptTable } = await mod('ui/js/pages/common.js');

test('markupSig: markup plus what form controls hold', () => {
  const a = h('div', h('input', { value: 'abc' }));
  const b = h('div', h('input', { value: 'abd' }));
  assert.notEqual(markupSig(a), markupSig(b), 'a field\'s text is a property, not markup, and still counts');
  const s1 = h('select', h('option', { value: 'x' }, 'X'), h('option', { value: 'y', selected: true }, 'Y'));
  const s2 = h('select', h('option', { value: 'x' }, 'X'), h('option', { value: 'y' }, 'Y'));
  assert.notEqual(markupSig(s1), markupSig(s2));
  assert.equal(markupSig(h('p', 'same')), markupSig(h('p', 'same')));
});

test('same(): drawn identically, the kept element comes back; changed, the fresh one', () => {
  const c = nodeCache();
  c.begin();
  const first = c.same('row', h('tr', h('td', '1')));
  c.end();
  c.begin();
  assert.equal(c.same('row', h('tr', h('td', '1'))), first, 'unchanged: the row on screen');
  const next = h('tr', h('td', '2'));
  assert.equal(c.same('row', next), next, 'changed: the new row');
  c.end();
  c.begin();
  assert.equal(c.same('row', h('tr', h('td', '2'))), next, 'and that one is kept from then on');
  c.end();
});

test('same(): what was typed into a kept field since it was drawn counts as what it shows', () => {
  const c = nodeCache();
  const draw = (text) => h('label', 'Search', h('input', { type: 'search', value: text }));
  c.begin();
  const bar = c.same('bar', draw(''));
  c.end();
  bar.querySelector('input').value = 'mo';             // the person typed
  c.begin();
  assert.equal(c.same('bar', draw('mo')), bar, 'the redraw the typing caused keeps the field');
  c.end();
});

test('same(): text and nothing pass through; sameAll keys by position and drops nulls', () => {
  const c = nodeCache();
  c.begin();
  assert.equal(c.same('t', 'text'), 'text');
  assert.equal(c.same('n', null), null);
  const [a, b] = c.sameAll('k', [h('i', 'a'), null, [h('i', 'b')]]);
  c.end();
  c.begin();
  const again = c.sameAll('k', [h('i', 'a'), [h('i', 'b')]]);
  assert.equal(again[0], a);
  assert.equal(again[1], b);
  c.end();
});

test('keptCard: the same section while the title holds; subtitle in place; unchanged body kept', () => {
  const c = nodeCache();
  c.begin();
  const body1 = h('p', 'body');
  const card1 = keptCard(c, 'k', 'Title', 'sub 1', body1);
  c.end();
  c.begin();
  const card2 = keptCard(c, 'k', 'Title', 'sub 2', h('p', 'body'));
  c.end();
  assert.equal(card2, card1, 'the section is kept');
  assert.equal(card2.querySelector('.sub').textContent, 'sub 2', 'the subtitle changed in place');
  assert.equal(card2.querySelector('.body').firstChild, body1, 'an unchanged body is the body on screen');
  c.begin();
  const card3 = keptCard(c, 'k', 'Other title', '', h('p', 'body'));
  c.end();
  assert.notEqual(card3, card1, 'a new title is a new card');
  assert.equal(card3.querySelector('.sub').hidden, true, 'no subtitle, none shown');
});

test('keptTable: the table kept, only the row that changed replaced', () => {
  const c = nodeCache();
  const rows = (vals) => c.sameAll('r', vals.map((v) => h('tr', h('td', v))));
  c.begin();
  const t1 = keptTable(c, 't', ['A'], rows(['1', '2', '3']));
  c.end();
  const [r1, r2, r3] = t1.querySelectorAll('tbody tr');
  const removed = [];
  const mo = new MutationObserver((ms) => ms.forEach((m) => removed.push(...m.removedNodes)));
  mo.observe(t1, { childList: true, subtree: true });
  c.begin();
  const t2 = keptTable(c, 't', ['A'], rows(['1', '2b', '3']));
  c.end();
  const kept = t2.querySelectorAll('tbody tr');
  assert.equal(t2, t1, 'same table');
  assert.equal(kept[0], r1);
  assert.equal(kept[2], r3);
  assert.notEqual(kept[1], r2);
  assert.equal(kept[1].textContent, '2b');
  return new Promise((res) => setTimeout(() => {
    mo.disconnect();
    assert.deepEqual(removed, [r2], 'only the changed row left the page');
    res();
  }, 0));
});

test('keptTable: no rows shows the empty text; rows again bring the table back', () => {
  const c = nodeCache();
  c.begin();
  const empty = keptTable(c, 't', ['A'], [], { emptyText: 'nothing yet' });
  c.end();
  assert.match(empty.textContent, /nothing yet/);
  c.begin();
  const full = keptTable(c, 't', ['A'], c.sameAll('r', [h('tr', h('td', 'x'))]), { emptyText: 'nothing yet' });
  c.end();
  assert.doesNotMatch(full.textContent, /nothing yet/);
  assert.equal(full.querySelectorAll('tbody tr').length, 1);
});
