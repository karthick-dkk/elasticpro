/**
 * Per-cluster collection switches (Edit cluster › Collection, docs/JOBS.md "Per-cluster
 * switches") — ui/js/core/collection.js, the page's half of the core's collection.rs: only what
 * is switched off is saved, the hours are whole hours that may cross midnight, and the words and
 * the place to turn it on are the core's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const C = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/collection.js')).href);
const RS = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/collection.rs'), 'utf8');

test('the switches and the place are the core\'s', () => {
  const m = /pub const WHERE: &str = "([^"]+)";/.exec(RS);
  assert.ok(m, 'collection.rs names WHERE');
  assert.equal(C.WHERE, m[1]);
  for (const s of C.SWITCHES) assert.ok(RS.includes(`=> "${s.key}"`), `collection.rs keys ${s.key}`);
  assert.ok(RS.includes('switched off for this cluster ({WHERE})'), 'the core says it the same way');
  assert.equal(C.offText('hosts'), 'Hosts collection switched off for this cluster (Edit cluster › Collection)');
});

test('only what is off is saved; everything on is no key; bad hours are refused', () => {
  assert.equal(C.collectionValue({ off: [], hours: null }), null);
  assert.deepEqual(C.collectionValue({ off: ['ilm', 'nope'], hours: { from: '22', to: '6' } }), { ilm: false, heavyHours: { from: 22, to: 6 } });
  assert.throws(() => C.collectionValue({ off: [], hours: { from: '5', to: '5' } }), /two different whole hours/);
  assert.deepEqual(C.collectionOf({ collection: { ilm: false, snapshots: true, heavyHours: { from: 1, to: 1 } } }), { ilm: false }, 'unreadable hours: none');
  assert.deepEqual(C.collectionOf({}), {});
  assert.ok(C.isOff({ collection: { hosts: false } }, 'hosts') && !C.isOff({ collection: { hosts: false } }, 'ilm'));
  assert.equal(C.collectionSummary({ collection: { ilm: false, heavyHours: { from: 22, to: 6 } } }), 'off: ILM checks · heavy jobs 22:00–06:00');
});

test('a window across midnight holds the night', () => {
  const w = { from: 22, to: 6 };
  for (const h of [22, 23, 0, 5]) assert.ok(C.hoursContain(w, h), `${h}`);
  for (const h of [6, 12, 21]) assert.ok(!C.hoursContain(w, h), `${h}`);
  assert.ok(C.hoursContain(null, 12), 'no window: any time');
  assert.equal(C.hoursText(w), '22:00–06:00');
});
