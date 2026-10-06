/**
 * Log delay as Zabbix receives it (DELAY_ITEMS, delayItemValues, the log-delay template).
 *
 * Unknown is not zero: a cluster where nothing could be measured sends nothing, and a
 * median that could not be worked out is left out rather than sent as 0 seconds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { DELAY_ITEMS, delayItemValues, summarise } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/log-delay.js')).href);

const rec = (device, status, delayMinutes) => ({ device, status, delayMinutes });
const asMap = (vs) => Object.fromEntries(vs.map((v) => [v.key, v.value]));

test('a measurement becomes counts and seconds', () => {
  const v = asMap(delayItemValues(summarise([
    rec('fw-1', 'OK', 2), rec('fw-2', 'DELAYED', 41), rec('proxy-3', 'CRITICAL', 95), rec('vpn-4', 'CLOCK_AHEAD', -37), rec('silent', 'NO_DATA', null)])));
  assert.equal(v.devices, 5);
  assert.equal(v.late, 2, 'late is delayed + critical — not the clock-ahead device, not the silent one');
  assert.equal(v.delayed, 1);
  assert.equal(v.critical, 1);
  assert.equal(v.clock_ahead, 1);
  assert.equal(v.worst, 95 * 60);
  assert.equal(v.worst_device, 'proxy-3');
  // The same median the Log delay page shows: every measured device, -37 2 41 95 → 21.5 min.
  assert.equal(v.median, 21.5 * 60);
});

test('nothing measurable sends no delay figures at all', () => {
  const v = asMap(delayItemValues(summarise([rec('silent', 'NO_DATA', null)])));
  assert.equal(v.median, undefined);
  assert.equal(v.worst, undefined);
  assert.equal(v.devices, 1);
  assert.deepEqual(delayItemValues(null), []);
});

test('the committed template is what the generator writes, one item per figure', () => {
  const fresh = execFileSync(process.execPath, [path.join(ROOT, 'tools/zabbix-delay-template.mjs')], { encoding: 'utf8' });
  const committed = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro-log-delay.yaml'), 'utf8');
  assert.equal(committed, fresh, 'regenerate: node tools/zabbix-delay-template.mjs > deploy/zabbix/template-elasticpro-log-delay.yaml');
  for (const d of [...DELAY_ITEMS.map((x) => x.key), 'worst_device']) assert.ok(committed.includes(`key: 'elasticpro.delay[${d}]'`), d);
});
