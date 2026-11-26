/**
 * 0.3.95: a break in reading is over 3 min (the server's rule), and a Fleet card takes the devices
 * of the reading its log delay alert rests on where the scheduled record has none.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const O = await import(pathToFileURL(path.join(ROOT, 'ui/js/play/opened.js')).href);
const MIN = 60000;
const DS = ['health', 'nodes', 'policies', 'snapshots'];
const crit = (key, family) => ({ key, family, level: 'critical', clusterId: key.split(':')[0], state: 'open' });

test('a gap of up to 3 min is not a break; a longer one is, and a reading out of date is not read', () => {
  const since = new Map();
  const alerts = [crit('c1:health', 'health'), crit('c1:log-delay', 'log-delay')];
  const sure = (now) => O.openReport(alerts, new Map(), since, DS, now).sure.map((k) => k.split('|')[0]);
  const every = (read, from, to) => { for (let t = from; t <= to; t += MIN) O.noteReads(since, ['c1'], [...DS, 'log-delay'], read, t); };
  every(() => true, 0, 10 * MIN);
  assert.deepEqual(sure(10 * MIN), ['c1:health', 'c1:log-delay']);
  // The log delay reading goes out of date for 2 min (a measurement due at the end of its interval).
  every((id, ds) => ds !== 'log-delay', 11 * MIN, 12 * MIN);
  assert.deepEqual(sure(12 * MIN), ['c1:health', 'c1:log-delay'], 'within 3 min it still counts');
  every(() => true, 13 * MIN, 14 * MIN);
  // Then it stops for good: after 3 min it has had a break, and what it shows next is not known.
  every((id, ds) => ds !== 'log-delay', 15 * MIN, 19 * MIN);
  assert.deepEqual(sure(19 * MIN), ['c1:health']);
  every(() => true, 20 * MIN, 29 * MIN);
  assert.deepEqual(sure(29 * MIN), ['c1:health'], 'nine minutes after it came back');
  every(() => true, 30 * MIN, 30 * MIN);
  assert.deepEqual(sure(30 * MIN), ['c1:health', 'c1:log-delay']);
});

test('a reading not looked at for over 3 min is not current, even with no break recorded', () => {
  const since = new Map();
  O.noteReads(since, ['c1'], DS, () => true, 0);
  O.noteReads(since, ['c1'], DS, () => true, 11 * MIN);
  assert.equal(O.openReport([crit('c1:health', 'health')], new Map(), since, DS, 11 * MIN).sure.length, 0, 'a gap of 11 min between looks is a break');
  assert.equal(O.openReport([crit('c1:health', 'health')], new Map(), since, DS, 30 * MIN).sure.length, 0, 'not looked at since 11 min');
});
