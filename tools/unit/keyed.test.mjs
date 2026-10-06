/**
 * lib/keyed.js — pieces of a page kept between redraws, rebuilt only when their signature
 * changes, and a time budget per redraw past which the caller gets a placeholder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { nodeCache } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/keyed.js')).href);

test('same signature, same element; a new one is built only when it changes', () => {
  const c = nodeCache();
  let builds = 0;
  const b = (v) => () => { builds++; return { v }; };
  c.begin();
  const a1 = c.get('a', '1', b('a1'));
  c.end();
  c.begin();
  assert.equal(c.get('a', '1', b('again')), a1);
  assert.equal(builds, 1);
  const a2 = c.get('a', '2', b('a2'));
  assert.notEqual(a2, a1);
  assert.equal(a2.v, 'a2');
  assert.equal(builds, 2);
});

test('what a draw did not ask for is forgotten at its end', () => {
  const c = nodeCache();
  c.begin(); c.get('a', 's', () => ({})); c.get('b', 's', () => ({})); c.end();
  assert.equal(c.size, 2);
  c.begin(); c.get('a', 's', () => ({})); c.end();
  assert.equal(c.size, 1);
});

test('past the budget: placeholders, never cached, and the draw says it is incomplete', () => {
  let clock = 0;
  const c = nodeCache({ budgetMs: 10, now: () => clock });
  c.begin();
  const x = c.get('x', 's', () => { clock += 20; return { built: 'x' }; }, () => ({ ph: true }));
  assert.equal(x.built, 'x', 'the first is always built');
  const y = c.get('y', 's', () => ({ built: 'y' }), () => ({ ph: 'y' }));
  assert.deepEqual(y, { ph: 'y' });
  assert.equal(c.incomplete, true);
  c.end();
  // The next draw starts a fresh budget, reuses x and builds y.
  c.begin();
  assert.equal(c.get('x', 's', () => ({ built: 'x2' }), () => ({ ph: true })), x);
  assert.equal(c.get('y', 's', () => ({ built: 'y' }), () => ({ ph: true })).built, 'y');
  assert.equal(c.incomplete, false);
});

test('past the budget, a stale element stands in rather than a blank', () => {
  let clock = 0;
  const c = nodeCache({ budgetMs: 10, now: () => clock });
  c.begin(); const old = c.get('y', 'v1', () => ({ v: 1 })); c.end();
  c.begin();
  clock += 50;
  assert.equal(c.get('y', 'v2', () => ({ v: 2 }), () => ({ ph: true })), old);
  assert.equal(c.incomplete, true);
});

test('without a placeholder the budget does not apply', () => {
  let clock = 0;
  const c = nodeCache({ budgetMs: 1, now: () => clock });
  c.begin();
  clock += 100;
  assert.equal(c.get('z', 's', () => ({ z: 1 })).z, 1);
  assert.equal(c.incomplete, false);
});

test('objId: stable for one object, different for another, 0 for none', async () => {
  const { objId } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/keyed.js')).href);
  const a = {}, b = {};
  assert.equal(objId(a), objId(a));
  assert.notEqual(objId(a), objId(b));
  assert.equal(objId(null), 0);
  assert.equal(objId('x'), 0);
});
