/**
 * Disk capacity change detection.
 *
 * Every case here is about NOT alerting. Capacity is summed over the nodes answering
 * right now, so the obvious implementation cries wolf at every restart — which is the
 * fastest way to teach people to ignore the alert that matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { capacityChange, jvmSummary } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const GB = 1024 ** 3;

test('the first reading is a baseline, not a change', () => {
  const r = capacityChange(null, 100 * GB, 3);
  assert.equal(r.total, 100 * GB);
  assert.equal(r.changedAt, null, 'nothing to compare against yet');
});

test('steady capacity is silent', () => {
  const first = capacityChange(null, 100 * GB, 3);
  const second = capacityChange(first, 100 * GB, 3);
  assert.equal(second.changedAt, null);
});

test('a real change on an unchanged fleet is reported', () => {
  const first = capacityChange(null, 100 * GB, 3);
  const grown = capacityChange(first, 200 * GB, 3);
  assert.equal(grown.changedFrom, 100 * GB);
  assert.ok(grown.changedAt > 0);
});

test('a node dropping out is NOT a capacity change', () => {
  const three = capacityChange(null, 300 * GB, 3);
  const restarting = capacityChange(three, 200 * GB, 2);   // one node mid-restart
  assert.equal(restarting.changedAt, null, 'a rolling restart must not alert');
  assert.equal(restarting.total, 200 * GB, 'but the new figure is adopted');
});

test('a node coming back is NOT a capacity change either', () => {
  const two = capacityChange(null, 200 * GB, 2);
  const back = capacityChange(two, 300 * GB, 3);
  assert.equal(back.changedAt, null, 'a node returning is not somebody adding a disk');
});

test('after a restart settles, a later real change is still caught', () => {
  let s = capacityChange(null, 300 * GB, 3);
  s = capacityChange(s, 200 * GB, 2);        // restart: baseline moves, silent
  s = capacityChange(s, 300 * GB, 3);        // back: baseline moves, silent
  const shrunk = capacityChange(s, 150 * GB, 3);   // a path genuinely disappears
  assert.equal(shrunk.changedFrom, 300 * GB, 'the real change is still detected afterwards');
  assert.ok(shrunk.changedAt > 0);
});

test('a previous change is carried forward until it ages out of the alert', () => {
  const first = capacityChange(null, 100 * GB, 3);
  const grown = capacityChange(first, 200 * GB, 3);
  const steady = capacityChange(grown, 200 * GB, 3);
  assert.equal(steady.changedFrom, 100 * GB, 'the alert survives the next refresh');
  assert.equal(steady.changedAt, grown.changedAt, 'and keeps its original timestamp');
});

test('zero or missing totals are not treated as a change', () => {
  const first = capacityChange(null, 100 * GB, 3);
  assert.equal(capacityChange(first, 0, 3).changedAt, null, '0 means we could not read it');
  assert.equal(capacityChange({ total: 0, nodeCount: 3 }, 100 * GB, 3).changedAt, null);
});

/* ------------------------------- JVM version ------------------------------- */

test('one JVM across the cluster reads as that version', () => {
  const s = jvmSummary([{ jdk: '17.0.9' }, { jdk: '17.0.9' }, { jdk: '17.0.9' }]);
  assert.equal(s.text, '17.0.9');
  assert.equal(s.mixed, false);
  assert.deepEqual(s.versions, ['17.0.9']);
});

test('nodes that disagree are not flattened to one of them', () => {
  // A half-finished upgrade is the case worth seeing. Showing "17.0.9" because that node
  // answered first would hide it.
  const s = jvmSummary([{ jdk: '17.0.9' }, { jdk: '21.0.2' }, { jdk: '17.0.9' }]);
  assert.equal(s.mixed, true);
  assert.equal(s.text, 'mixed (2)');
  assert.deepEqual(s.versions, ['17.0.9', '21.0.2']);
  assert.match(s.detail, /17\.0\.9 \(2\)/);
  assert.match(s.detail, /21\.0\.2 \(1\)/);
});

test('no answer is unknown, not blank', () => {
  for (const nodes of [[], null, undefined, [{}], [{ jdk: '' }], [{ jdk: '   ' }]]) {
    const s = jvmSummary(nodes);
    assert.equal(s.text, 'unknown', `${JSON.stringify(nodes)} should be unknown`);
    assert.equal(s.versions.length, 0);
  }
});

test('a node that did not answer does not hide the ones that did', () => {
  const s = jvmSummary([{ jdk: '21.0.2' }, {}, { jdk: '21.0.2' }]);
  assert.equal(s.text, '21.0.2');
  assert.equal(s.mixed, false);
});
