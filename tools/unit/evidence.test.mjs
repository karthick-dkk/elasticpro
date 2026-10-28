/**
 * The evidence layout: which pages have it, how addresses are kept out, what it holds back.
 *
 * Snapshots, the REST console and Indices are screenshotted for one client, so they must
 * show one cluster and nothing about the fleet. The DOM side is in behaviour-check.mjs;
 * these are the decisions underneath, which have no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ev = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/evidence.js')).href);
const { EVIDENCE_PAGES, evidenceLayout, evidenceSelection, hideAddress, scrubFresh, createHeldNotices } = ev;

const PAGES = ['alerts', 'overview', 'indices', 'shards', 'logs', 'console', 'snapshots', 'volume', 'automation',
  'requests', 'accounts', 'settings'];

test('exactly Snapshots, the REST console and Indices are evidence pages', () => {
  assert.deepEqual([...EVIDENCE_PAGES].sort(), ['console', 'indices', 'snapshots']);
  for (const id of PAGES) {
    assert.equal(evidenceLayout(id, 'c1').evidence, EVIDENCE_PAGES.has(id), id);
  }
  assert.equal(evidenceLayout(null, 'c1').evidence, false);
});

test('an evidence page with no single cluster asks for one', () => {
  for (const id of EVIDENCE_PAGES) {
    assert.deepEqual(evidenceLayout(id, 'c1', true), { evidence: true, needsCluster: false });
    assert.equal(evidenceLayout(id, 'all', true).needsCluster, true, 'All clusters is not one cluster');
    assert.equal(evidenceLayout(id, '', true).needsCluster, true);
    assert.equal(evidenceLayout(id, 'gone', false).needsCluster, true, 'a cluster not in the config');
  }
  assert.deepEqual(evidenceLayout('overview', 'all', true), { evidence: false, needsCluster: false });
});

test('app.js leaves the decision to evidence.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  assert.match(src, /evidenceLayout\(/);
  assert.doesNotMatch(src, /EVIDENCE_PAGES\s*=/, 'a second list of evidence pages');
});

test('no page carries the evidence stamp any more (0.3.39)', () => {
  assert.equal(ev.evidenceStamp, undefined);
  for (const f of ['ui/js/app.js', 'ui/js/pages/snapshots.js', 'ui/js/pages/console.js', 'ui/js/pages/indices.js', 'ui/css/app.css']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /evidenceData|evidence-foot|evidence-note|Refresh before capturing/, f);
  }
});

test('an error text that quotes the address is reduced to the cluster name', () => {
  const c = { name: 'Alpha-logging', url: 'https://elastic:pw@alpha.internal:9200/' };
  assert.equal(hideAddress('connect to https://alpha.internal:9200/_cat failed', c), 'connect to Alpha-logging failed');
  assert.equal(hideAddress('dial alpha.internal:9200: refused', c), 'dial Alpha-logging: refused');
  assert.equal(hideAddress('proxy http://10.0.0.1:3128 said no', c), 'proxy Alpha-logging said no');
  assert.equal(hideAddress(undefined, c), '');
  const f = scrubFresh({ ts: 1, status: 'error', error: { kind: 'x', message: 'no route to http://10.1.1.1:9200' } }, c);
  assert.equal(f.error.message, 'no route to Alpha-logging');
  assert.equal(scrubFresh(null, c), null);
});

test('held notices come back once, as bell entries, with one line saying how many', () => {
  const held = createHeldNotices();
  held.hold('late-up-2: 3 new alerts', 'err', 9000, { key: 'alerts:a', cluster: 'late-up-2' });
  held.hold('late-up-3: 1 new alert', 'warn', 6000, { key: 'alerts:b' });
  held.hold('late-up-2: 4 new alerts', 'err', 9000, { key: 'alerts:a' });        // replaces the first
  held.hold('4 new alerts on 2 clusters', 'err', 9000, { key: 'alerts-batch', noHistory: true });
  assert.equal(held.size(), 3);
  const shown = [];
  const n = held.release((m, k, ms, o) => shown.push({ m, k, o }));
  assert.equal(n, 2, 'the batch line only summarises entries that are replayed');
  assert.equal(shown.length, 3);
  assert.deepEqual(shown.slice(0, 2).map((x) => x.m), ['late-up-3: 1 new alert', 'late-up-2: 4 new alerts']);
  assert.ok(shown.slice(0, 2).every((x) => x.o.bellOnly), 'replayed into the bell, not stacked on screen');
  assert.equal(shown[2].m, 'Held 2 notices while on an evidence page');
  assert.equal(shown[2].k, 'err');
  assert.equal(held.size(), 0);
  assert.equal(held.release(() => assert.fail('nothing left to release')), 0);
});

test('one held notice is "1 notice", and nothing held says nothing', () => {
  const held = createHeldNotices();
  assert.equal(held.release(() => assert.fail('no line for nothing')), 0);
  held.hold('x', 'warn', 1000, {});
  const lines = [];
  held.release((m) => lines.push(m));
  assert.equal(lines.at(-1), 'Held 1 notice while on an evidence page');
});

test('an evidence page picks the remembered cluster, else the first, and keeps a valid one', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(evidenceSelection('c', 'b', ids), 'c', 'a cluster already selected stays');
  assert.equal(evidenceSelection('all', 'b', ids), 'b', 'All clusters -> the last chosen');
  assert.equal(evidenceSelection('all', '', ids), 'a', 'nothing remembered -> the first');
  assert.equal(evidenceSelection('all', 'gone', ids), 'a', 'a remembered cluster no longer configured');
  assert.equal(evidenceSelection('gone', 'c', ids), 'c', 'an unknown selection');
  assert.equal(evidenceSelection('', undefined, ids), 'a');
  assert.equal(evidenceSelection('all', 'b', []), '', 'no cluster at all');
});
