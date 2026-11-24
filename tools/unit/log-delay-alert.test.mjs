/**
 * Late logs, as an alert.
 *
 * The Log delay page measured and showed; nothing raised. So a device an hour behind was
 * visible to whoever happened to open that page and to nobody else — not the Alerts list,
 * not Zabbix. The measurement is now published per cluster and alerts() reads it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const s = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);
const { summarise } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/log-delay.js')).href);
const { zabbixAlertValues } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-alerts.js')).href);

const c = { id: 'c1', name: 'vm-1', enabled: true };
const rec = (device, status, delayMinutes) => ({ device, status, delayMinutes });
const delayAlerts = () => s.alerts().filter((a) => a.key === 'c1:log-delay');

beforeEach(() => {
  s.state.config = { clusters: [c] };
  s.state.data.set('c1', { reachable: true });
  s.setDelaySummary('c1', null);
});

test('nothing measured, nothing raised', () => {
  assert.deepEqual(delayAlerts(), []);
});

test('a device past its critical delay (over 60 min) raises a High alert naming the worst', () => {
  s.setDelaySummary('c1', summarise([rec('fw-1', 'OK', 2), rec('proxy-3', 'CRITICAL', 95), rec('fw-2', 'DELAYED', 41)]));
  const [a] = delayAlerts();
  assert.equal(a.level, 'high', 'log delay over 60 min is High, not critical (2026-11-01)');
  assert.match(a.title, /1 device\(s\) shipping logs over 60 min late/);
  assert.doesNotMatch(`${a.title} ${a.detail}`, /critical/, 'a High alert does not call itself critical');
  assert.match(a.detail, /1 over 60 min, 1 30–60 min late, of 3/);
  assert.match(a.detail, /proxy-3, 95 min/);
});

test('only delayed is a warning', () => {
  s.setDelaySummary('c1', summarise([rec('fw-2', 'DELAYED', 41), rec('fw-1', 'OK', 2)]));
  assert.equal(delayAlerts()[0].level, 'warning');
});

test('a device whose clock runs ahead is not reported as late', () => {
  s.setDelaySummary('c1', summarise([rec('vpn-4', 'CLOCK_AHEAD', -37), rec('silent', 'NO_DATA', null)]));
  assert.deepEqual(delayAlerts(), []);
});

test('an old measurement says nothing about now', () => {
  s.setDelaySummary('c1', summarise([rec('proxy-3', 'CRITICAL', 95)]), Date.now() - 3 * 3600 * 1000);
  assert.deepEqual(delayAlerts(), []);
});

test('it reaches Zabbix as the log-delay rule', () => {
  s.setDelaySummary('c1', summarise([rec('proxy-3', 'CRITICAL', 95)]));
  const v = zabbixAlertValues(s.alerts().filter((a) => a.cluster && a.cluster.id === 'c1'));
  // High reaches the template's critical trigger (priority HIGH) and says it is High.
  assert.equal(v['log-delay'].level, 2);
  assert.match(v['log-delay'].detail, /^critical: \[High\] vm-1: 1 device/);
});

const typed = (device, status, delayMinutes, types) => ({ ...rec(device, status, delayMinutes), types: types.map(([label, st, m]) => ({ logType: label, label, noType: false, status: st, delayMinutes: m })) });

test('part delayed (0.3.90) is said beside the delayed devices, which alone decide the level', () => {
  s.setDelaySummary('c1', summarise([typed('a', 'CRITICAL', 95, [['x', 'CRITICAL', 95], ['y', 'CRITICAL', 70]]), typed('b', 'PART_DELAY', 2, [['threat', 'DELAYED', 46], ['traffic', 'OK', 2]])]));
  const [a] = delayAlerts();
  assert.equal(a.level, 'high');
  assert.match(a.detail, /1 over 60 min, 0 30–60 min late, of 2 · 1 part delayed \(log types: threat\)\./);
});

test('only part delayed is a warning naming the log types; log types all on time raise nothing', () => {
  s.setDelaySummary('c1', summarise([typed('b', 'PART_DELAY', 2, [['threat', 'CRITICAL', 96], ['traffic', 'OK', 2]]), typed('d', 'PART_DELAY', 1, [['audit', 'DELAYED', 40], ['threat', 'DELAYED', 35], ['sys', 'OK', 1]])]));
  const [a] = delayAlerts();
  assert.equal(a.level, 'warning');
  assert.match(a.title, /2 device\(s\) part delayed/);
  assert.match(a.detail, /0 delayed of 2 · 2 part delayed \(log types: threat, audit\)\. Worst log type: threat on b, 96 min behind\./);
  s.setDelaySummary('c1', summarise([typed('b', 'OK', 2, [['threat', 'OK', 3], ['traffic', 'OK', 2]])]));
  assert.deepEqual(delayAlerts(), []);
});
