/**
 * What a display reports as open, and what it is sure of (ui/js/play/opened.js, docs/PLAY.md
 * "Since when"): a time nobody could know must never be reported as known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const O = await import(pathToFileURL(path.join(ROOT, 'ui/js/play/opened.js')).href);
const MIN = 60000;
const DS = ['health', 'nodes', 'policies', 'snapshots'];
const m = (key, family, level, more = {}) => ({ key, family, level, clusterId: key.split(':')[0], state: 'open', ...more });

test('every Critical and High problem is reported with its level: acknowledged, silenced and held too', () => {
  const r = O.openReport([m('c1:health', 'health', 'critical'), m('c1:disk', 'disk', 'high', { state: 'acked' }), m('c1:ilm', 'ilm', 'critical', { state: 'silenced' }),
    m('c1:heap', 'heap', 'warning'), m('c2:repo', 'repo', 'critical', { held: true })], new Map(), new Map(), DS, 0);
  assert.deepEqual(r.open, ['c1:health|critical', 'c1:disk|high', 'c1:ilm|critical', 'c2:repo|critical']);
  assert.deepEqual(r.sure, [], 'nothing has been read long enough');
});

test('a fact with no alert is reported once; one with its own time is not', () => {
  const st = new Map([['c1', { problems: [{ key: 'c1:health', level: 'critical', family: 'health', since: null }, { key: 'c1:node-left', level: 'high', family: 'node-left', since: 5 }] }],
    ['c2', { problems: [{ key: 'c2:disk', level: 'high', family: 'disk', alert: {} }] }]]);
  assert.deepEqual(O.openReport([], st, new Map(), DS, 0).open, ['c1:health|critical']);
});

test('sure only when what the problem comes from was read for ten minutes without a break', () => {
  const since = new Map(), all = (id, ds) => true;
  const alerts = [m('c1:health', 'health', 'critical'), m('c1:repo', 'repo', 'critical'), m('c1:user:x', 'user', 'critical'), m('c1:unreachable', 'unreachable', 'critical')];
  const sure = (now) => O.openReport(alerts, new Map(), since, DS, now).sure.map((k) => k.split('|')[0]);
  O.noteReads(since, ['c1'], DS, all, 0);
  assert.deepEqual(sure(9 * MIN), ['c1:unreachable']);
  assert.deepEqual(sure(10 * MIN), ['c1:health', 'c1:repo', 'c1:user:x', 'c1:unreachable']);
  // The snapshots fail to read once and come back: what they show then may be old.
  O.noteReads(since, ['c1'], DS, (id, ds) => ds !== 'snapshots', 11 * MIN);
  assert.deepEqual(sure(11 * MIN), ['c1:health', 'c1:unreachable']);
  O.noteReads(since, ['c1'], DS, all, 12 * MIN);
  assert.deepEqual(sure(21 * MIN), ['c1:health', 'c1:unreachable']);
  assert.deepEqual(sure(22 * MIN).length, 4);
  assert.equal(O.openReport([m('c2:health', 'health', 'critical')], new Map(), since, DS, 99 * MIN).sure.length, 0, 'another cluster was never read');
});

test('an alert\'s own start is the one of its members at its level', () => {
  assert.equal(O.ownStart({ level: 'critical', members: [{ level: 'warning', failingSince: 1 }, { level: 'critical', failingSince: 7 }, { level: 'critical', failingSince: 5 }] }), 5);
  assert.equal(O.ownStart({ level: 'critical', members: [{ level: 'warning', failingSince: 1 }] }), null);
  assert.equal(O.ownStart({ level: 'critical' }), null);
});
