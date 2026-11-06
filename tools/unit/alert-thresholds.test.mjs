/**
 * Config-Management › Alerts › Triggers writes only what differs (core/alert-rules.js
 * nextRuleSettings): a threshold left at the shared default stays unset, so System › Defaults
 * goes on deciding it; a stored one is kept or changed; a switch left on writes nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const A = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/alert-rules.js')).href);
const disk = A.ruleById('disk');
const keys = disk.thresholds.map((t) => t.key);
const defaults = Object.fromEntries(keys.map((k, i) => [k, 80 + i * 5]));
const typedAt = (vals) => Object.fromEntries(keys.map((k, i) => [k, vals[i]]));

test('untouched: nothing is written', () => {
  assert.equal(A.nextRuleSettings(undefined, disk, { on: true, typed: typedAt(keys.map((k) => defaults[k])) }, defaults), undefined);
});

test('a threshold at the default stays unset; one changed is written', () => {
  const vals = keys.map((k) => defaults[k]);
  vals[0] += 1;
  const e = A.nextRuleSettings(undefined, disk, { on: true, typed: typedAt(vals) }, defaults);
  assert.deepEqual(e, { thresholds: { [keys[0]]: vals[0] } });
});

test('a stored threshold is kept when untouched, and changed when changed — even back to the default', () => {
  const stored = { thresholds: { [keys[0]]: 70 } };
  const same = A.nextRuleSettings(stored, disk, { on: true, typed: typedAt([70, defaults[keys[1]]]) }, defaults);
  assert.deepEqual(same, { thresholds: { [keys[0]]: 70 } });
  const back = A.nextRuleSettings(stored, disk, { on: true, typed: typedAt([defaults[keys[0]], defaults[keys[1]]]) }, defaults);
  assert.deepEqual(back, { thresholds: { [keys[0]]: defaults[keys[0]] } });
});

test('switching off is written; switching back on keeps the entry, saying enabled', () => {
  assert.deepEqual(A.nextRuleSettings(undefined, A.ruleById('heap'), { on: false }, defaults), { enabled: false });
  assert.deepEqual(A.nextRuleSettings({ enabled: false }, A.ruleById('heap'), { on: true }, defaults), { enabled: true });
});

test('a locked threshold (not typed) is left as it was', () => {
  const stored = { thresholds: { [keys[1]]: 99 } };
  assert.deepEqual(A.nextRuleSettings(stored, disk, { on: true, typed: {} }, defaults), stored);
});
