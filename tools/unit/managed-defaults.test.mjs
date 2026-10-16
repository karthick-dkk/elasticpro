/**
 * config.txt wins: what the server manages is applied to the effective defaults last, over
 * the shipped defaults, the config file and the thresholds an admin retuned on the Config
 * page — and a PING that says nothing about it never unlocks what is locked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
const { effectiveDefaults } = await load('ui/js/core/alert-rules.js');
const { setManaged, managedDefaults, managedZabbixOptions, isManagedDefault, isManagedZabbixOption } = await load('ui/js/core/managed.js');

const shipped = { readOnly: true, diskWarnPercent: 80, diskCritPercent: 90, refreshIntervalSec: 30, timeField: '@timestamp' };
const retuned = { disk: { thresholds: { diskWarnPercent: 60 } } };

test('nothing managed: the admin\'s retuned threshold applies as before', () => {
  setManaged({ ok: true, managedDefaults: {}, managedZabbixOptions: {} });
  assert.equal(effectiveDefaults(shipped, retuned).diskWarnPercent, 60);
  assert.equal(effectiveDefaults(shipped, retuned).diskCritPercent, 90);
});

test('a managed default beats the shipped one, the file\'s and a retuned threshold', () => {
  setManaged({ ok: true, managedDefaults: { diskWarnPercent: 70, readOnly: false, timeField: 'ts' }, managedZabbixOptions: { createHosts: true } });
  const d = effectiveDefaults({ ...shipped, timeField: 'from-file' }, retuned);
  assert.equal(d.diskWarnPercent, 70, 'managed over the retuned 60');
  assert.equal(d.readOnly, false);
  assert.equal(d.timeField, 'ts', 'managed over the config file');
  assert.equal(d.diskCritPercent, 90, 'what is not managed is untouched');
  assert.equal(d.refreshIntervalSec, 30);
});

test('the inputs are not mutated', () => {
  setManaged({ ok: true, managedDefaults: { diskCritPercent: 95 } });
  const input = { ...shipped };
  effectiveDefaults(input, null);
  assert.deepEqual(input, shipped);
});

test('the held set is a copy and answers per key', () => {
  setManaged({ ok: true, managedDefaults: { tls: 'insecure' }, managedZabbixOptions: { hostGroup: 'Lab' } });
  managedDefaults().tls = 'auto';
  assert.equal(managedDefaults().tls, 'insecure');
  assert.ok(isManagedDefault('tls') && !isManagedDefault('readOnly'));
  assert.ok(isManagedZabbixOption('hostGroup') && !isManagedZabbixOption('createHosts'));
  assert.deepEqual(managedZabbixOptions(), { hostGroup: 'Lab' });
});

test('a reply that says nothing about config.txt leaves the set alone', () => {
  setManaged({ ok: true, managedDefaults: { tls: 'insecure' } });
  setManaged({ ok: true, authRequired: true });          // signed out
  setManaged({ ok: false, message: 'down' });
  setManaged(null);
  assert.deepEqual(managedDefaults(), { tls: 'insecure' });
  setManaged({ ok: true, managedDefaults: {} });          // the server now manages nothing
  assert.deepEqual(managedDefaults(), {});
});
