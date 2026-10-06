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

test('a device past its critical delay raises a critical alert naming the worst', () => {
  s.setDelaySummary('c1', summarise([rec('fw-1', 'OK', 2), rec('proxy-3', 'CRITICAL', 95), rec('fw-2', 'DELAYED', 41)]));
  const [a] = delayAlerts();
  assert.equal(a.level, 'critical');
  assert.match(a.title, /1 device\(s\) critically late/);
  assert.match(a.detail, /1 critical, 1 delayed of 3/);
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
  assert.equal(v['log-delay'].level, 2);
  assert.match(v['log-delay'].detail, /^critical: vm-1: 1 device/);
});
