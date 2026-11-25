// One log type over its devices (0.3.92): core/log-types.js, the routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceSeries, typeCountsText, typeKey, typeLabel, lineSlots } from '../../ui/js/core/log-types.js';
import { ldHash, ldRoute } from '../../ui/js/core/logdelay-report.js';

test('a line is a device, not a log type; only those with points', () => {
  const res = { label: '1 – 2 Nov', logType: 'threat', noType: false, devicesWithPoints: 2, devices: ['a', 'b', 'c'].map((device) => ({ device, logType: 'threat', points: [] })) };
  const s = deviceSeries(res);
  assert.deepEqual(s.map(typeLabel), ['a', 'b']);
  assert.equal(new Set(s.map(typeKey)).size, 2);
  assert.deepEqual([...lineSlots(s).keys()], ['device:a', 'device:b']);
  assert.equal(typeLabel(res), 'threat', 'the range label is not the log type');
  assert.deepEqual(deviceSeries({}), []);
});

test('the counts in words; not counted is nothing, never 0', () => {
  assert.equal(typeCountsText({ devices: 10, late: 2, above: 1, silent: 3 }, { high: 'Above 60 min' }), '2 of 10 devices late · 1 above 60 min · 3 with no logs of it now');
  assert.equal(typeCountsText({ devices: 1, late: 0, above: 0, silent: 0 }), '0 of 1 device late');
  assert.equal(typeCountsText(null), '');
});

test('the address of a log type, also one with odd characters and the documents without the field', () => {
  for (const o of [{ logType: 'threat' }, { logType: 'a/b?c=d&e' }, { logType: '' }, { noType: true }]) {
    const r = ldRoute(ldHash('cluster', 'one/two', null, o));
    assert.deepEqual({ view: r.view, clusterId: r.clusterId, ...(o.noType ? { noType: r.noType } : { logType: r.logType }) }, { view: 'cluster', clusterId: 'one/two', ...o });
  }
  const plain = ldRoute(ldHash('cluster', 'one'));
  assert.ok(plain.logType === undefined && !plain.noType);
  assert.ok(!/log_type/.test(ldHash('devices', 'one', null, { logType: 'threat' })), 'other views drop it');
});
