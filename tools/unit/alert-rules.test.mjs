/**
 * The alert registry.
 *
 * The rules that matter here are about identity and about defaults: a rule must be able
 * to be switched off or retuned without anything an operator acknowledged losing its
 * name, and an unknown alert must never be silenced by accident.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ar = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/alert-rules.js')).href);

test('every rule has an id, a label and a reason', () => {
  for (const r of ar.ALERT_RULES) {
    assert.ok(r.id && r.label && r.why, `${r.id || '(no id)'} is incomplete`);
    assert.ok(['critical', 'warning'].includes(r.level), `${r.id} has level ${r.level}`);
  }
});

test('rule ids are unique', () => {
  const ids = ar.ALERT_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('a key maps to its family, whatever names the instance', () => {
  assert.equal(ar.ruleForKey('vm-1:disk').id, 'disk');
  assert.equal(ar.ruleForKey('vm-1:slm-stale:daily').id, 'slm-stale',
    'the policy name must not change which rule this is');
  assert.equal(ar.ruleForKey('vm-1:volume:tag1:acme').id, 'volume');
  assert.equal(ar.ruleForKey('vm-1:capacity:100->50').id, 'capacity');
  assert.equal(ar.ruleForKey('vm-1:repo:daily:failing').id, 'repo');
});

test('a cluster id containing a colon does not confuse the family', () => {
  assert.equal(ar.ruleForKey('c1:health').id, 'health');
});

test('an unrecognised key belongs to no rule', () => {
  assert.equal(ar.ruleForKey('vm-1:something-new'), null);
  assert.equal(ar.ruleForKey(''), null);
  assert.equal(ar.ruleForKey(null), null);
});

test('rules are on unless switched off', () => {
  assert.equal(ar.isEnabled({}, 'disk'), true, 'absent means enabled');
  assert.equal(ar.isEnabled({ disk: {} }, 'disk'), true);
  assert.equal(ar.isEnabled({ disk: { enabled: false } }, 'disk'), false);
  assert.equal(ar.isEnabled({ disk: { enabled: true } }, 'disk'), true);
});

test('disabling a rule hides its alerts and nothing else', () => {
  const list = [
    { key: 'vm-1:disk' }, { key: 'vm-1:health' },
    { key: 'vm-2:disk' }, { key: 'vm-1:slm-stale:daily' },
  ];
  const kept = ar.applySettings(list, { disk: { enabled: false } });
  assert.deepEqual(kept.map((a) => a.key), ['vm-1:health', 'vm-1:slm-stale:daily']);
});

test('an alert from an unknown family is never silenced', () => {
  const kept = ar.applySettings([{ key: 'vm-1:brand-new-thing' }], { 'brand-new-thing': { enabled: false } });
  assert.equal(kept.length, 1, 'an unknown rule is not a disabled one');
});

test('retuning a threshold changes the effective default', () => {
  const base = { diskWarnPercent: 80, diskCritPercent: 90, snapshotStaleHours: 26 };
  const out = ar.effectiveDefaults(base, { disk: { thresholds: { diskWarnPercent: 85 } } });
  assert.equal(out.diskWarnPercent, 85);
  assert.equal(out.diskCritPercent, 90, 'untouched thresholds keep their default');
});

test('a threshold outside its range is ignored, not applied', () => {
  const base = { diskWarnPercent: 80 };
  for (const bad of [0, 5, 100, 250, -1, NaN, 'eighty', null]) {
    const out = ar.effectiveDefaults(base, { disk: { thresholds: { diskWarnPercent: bad } } });
    assert.equal(out.diskWarnPercent, 80, `${String(bad)} should have been refused`);
  }
});

test('settings for a rule that no longer exists are ignored', () => {
  const out = ar.effectiveDefaults({ diskWarnPercent: 80 }, { 'rule-that-went-away': { thresholds: { x: 1 } } });
  assert.equal(out.diskWarnPercent, 80);
});

test('loadAlertSettings tolerates a config with nothing in it', () => {
  assert.deepEqual(ar.loadAlertSettings(null), {});
  assert.deepEqual(ar.loadAlertSettings({}), {});
  assert.deepEqual(ar.loadAlertSettings({ alertRules: 'nonsense' }), {});
});

test('every key family raised by state.js has a rule', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'ui/js/core/state.js'), 'utf8');
  const families = new Set([...src.matchAll(/key: `\$\{c\.id\}:([a-z-]+)/g)].map((m) => m[1]));
  for (const f of families) {
    assert.ok(ar.ruleById(f), `state.js raises "${f}" but the registry has no rule for it`);
  }
  assert.ok(families.size >= 10, `only found ${families.size} families — the scan is probably broken`);
});
