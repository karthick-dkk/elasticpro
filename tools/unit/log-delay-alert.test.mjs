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
const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/delay-levels.js')).href);
const { hmz } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/fmt.js')).href);
const { zabbixAlertValues } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-alerts.js')).href);

const c = { id: 'c1', name: 'vm-1', enabled: true };
const rec = (device, status, delayMinutes) => ({ device, status, delayMinutes });
const delayAlerts = () => s.alerts().filter((a) => a.key === 'c1:log-delay');

beforeEach(() => {
  s.state.config = { clusters: [c] };
  s.state.data.set('c1', { reachable: true });
  s.setDelaySummary('c1', null);
  D.forgetLevels();
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

/* The server's own last run (0.3.90): the alert no longer needs a browser that measured. */

const H = 3600000;
const runRow = (at, o = {}) => ({ id: 'c1', lastRunAt: at, devices: 40, delay: 3, critical: 3, levels: { delayFrom: 30, criticalOver: 60 }, stale: false, notMeasured: null, ...o });
const readRuns = async (rows, o = {}) => { D.forgetLevels(); const sent = []; await D.loadServerRuns({ send: async (m) => { sent.push(m); return { ok: true, everyHours: 2, byCluster: rows, ...o }; } }); return sent; };

test('the server\'s run raises it with no measurement of ours: the core\'s counts, as of the run', async () => {
  const at = Date.now() - 20 * 60000;
  const sent = await readRuns([runRow(at, { partDelayed: 2, worst: { device: 'fw-9', minutes: 95.4, state: 'critical', logType: 'threat', at, stale: false } })]);
  assert.deepEqual(sent.map((m) => ({ ...m })), [{ type: 'LOGDELAY_SUMMARY', days: 1, maxDevices: 1 }]);
  const [a] = delayAlerts();
  assert.equal(a.level, 'high');
  assert.match(a.title, /3 device\(s\) shipping logs over 60 min late/);
  assert.equal(a.detail, `3 over 60 min, 3 30–60 min late, of 40 · 2 part delayed, as of last run ${hmz(at)}. Worst: fw-9, log type threat, 95 min behind.`);
  assert.match(a.detail, /(GMT|UTC)/);
});

test('its levels are the cluster\'s own; a worst device is named only when the answer has one', async () => {
  await readRuns([runRow(Date.now() - H, { critical: 1, levels: { delayFrom: 45, criticalOver: 90 }, worst: null })]);
  const [a] = delayAlerts();
  assert.match(a.detail, /^1 over 90 min, 3 45–90 min late, of 40, as of last run /);
  assert.doesNotMatch(a.detail, /Worst/);
});

test('never read, never measured or a count missing: no alert, no claim', async () => {
  assert.deepEqual(delayAlerts(), []);
  for (const row of [runRow(null), runRow(Date.now(), { critical: null }), runRow(Date.now(), { devices: undefined })]) {
    await readRuns([row]);
    assert.equal(D.serverRunOf('c1'), null);
    assert.deepEqual(delayAlerts(), []);
  }
  await readRuns([runRow(Date.now(), { delay: 0, critical: 0 })]);
  assert.deepEqual(delayAlerts(), [], 'none late');
  await readRuns([runRow(Date.now(), { delay: 0, critical: 0, partDelayed: 1 })]);
  assert.match(delayAlerts()[0].title, /1 device\(s\) part delayed/);
});

test('a run is good until the next is due and the core\'s grace is over, and not once the core calls it stale', async () => {
  const now = Date.now();
  await readRuns([runRow(now - 20 * H)], { everyHours: 24 });
  assert.equal(delayAlerts().length, 1, 'a 24 h schedule: 20 h old is the last word');
  await readRuns([runRow(now - 37 * H)], { everyHours: 24 });
  assert.deepEqual(delayAlerts(), [], 'past 24 h and the grace of 12 h');
  await readRuns([runRow(now - 2.9 * H)]);
  assert.equal(delayAlerts().length, 1);
  await readRuns([runRow(now - 3.1 * H)]);
  assert.deepEqual(delayAlerts(), [], 'every 2 h: 2 h + 1 h');
  await readRuns([runRow(now - H, { stale: true })]);
  assert.deepEqual(delayAlerts(), [], 'the core says stale');
  await readRuns([runRow(now - 3 * H)], { everyHours: undefined });
  assert.deepEqual(delayAlerts(), [], 'no interval known: no longer than a measurement of ours');
  await readRuns([runRow(now - H, { notMeasured: 'the last run failed (timeout)' })]);
  assert.match(delayAlerts()[0].detail, /as of last run .* \(a newer run failed\)/);
});

test('the newest of the two wins; a browser measurement is never replaced by an older run', async () => {
  const now = Date.now();
  await readRuns([runRow(now - 30 * 60000)]);
  s.setDelaySummary('c1', summarise([rec('fw-1', 'OK', 2)]), now - 10 * 60000);
  assert.deepEqual(delayAlerts(), [], 'measured since: nothing late');
  s.setDelaySummary('c1', summarise([rec('fw-1', 'DELAYED', 41)]), now - H);
  assert.equal(delayAlerts()[0].level, 'high', 'the run is newer');
  await readRuns([runRow(now - 5 * H)], { everyHours: 24 });
  s.setDelaySummary('c1', summarise([rec('fw-1', 'OK', 2)]), now - 3 * H);
  assert.deepEqual(delayAlerts(), [], 'ours is out of date, and the older run does not come back');
});

test('the runs are asked at most once in five minutes, answered or not, and never thrown', async () => {
  let n = 0;
  const send = async () => { n += 1; throw new Error('down'); };
  assert.equal(await D.loadServerRuns({ send }), false);
  assert.equal(await D.loadServerRuns({ send }), false);
  assert.equal(n, 1);
  await D.loadServerRuns({ send, now: Date.now() + 5 * 60000 + 1 });
  assert.equal(n, 2);
  await readRuns([runRow(Date.now())]);
  assert.equal(D.levelsOf('c1').criticalOver, 60, 'the same answer says the levels');
});
