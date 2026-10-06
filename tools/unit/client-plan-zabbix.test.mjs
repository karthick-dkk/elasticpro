/**
 * The client plan as Zabbix sees it.
 *
 * A Zabbix item's key is where its history lives. These pin that every plan column has one,
 * that it is safe inside elasticpro.plan[<cluster>,<key>], and that the committed template is
 * what the generator writes today — a template edited by hand, or a column added without
 * regenerating, would put the page and Zabbix out of step without anybody noticing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const v = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume.js')).href);

test('every client-plan column has a key, and no two share one', () => {
  const keys = v.CLIENT_COLUMNS.map((c) => c.key);
  assert.ok(keys.every(Boolean), 'a column without a key has nowhere to store its history');
  assert.equal(new Set(keys).size, keys.length, 'two columns would write into one item');
});

test('keys are safe inside an item key parameter', () => {
  // A comma, bracket or quote would split or end elasticpro.plan[key].
  for (const c of v.CLIENT_COLUMNS) assert.match(c.key, /^[a-z0-9.]+$/, c.key);
});

test('a value the report does not have stays null', () => {
  const r = { cluster: { name: 'c', url: 'u', tags: [] }, vol: { basis: '', daysCovered: 0 }, perDayGB: 5,
              bufferedGB: 6.5, liveTotalGB: 100, livePct: null, liveFreeGB: null, liveSufficientDays: null,
              required30GB: 195, required90GB: 585, backupCapacityGB: null, repoGB: null, backupFreeGB: null,
              required365GB: 2372.5, backupSufficientDays: null };
  const vals = Object.fromEntries(v.clientPlanValues(r).map((x) => [x.key, x.value]));
  assert.equal(vals['volume.day'], 5);
  assert.equal(vals['live.used.pct'], null, 'unknown must not become 0');
  assert.equal(vals['backup.total'], null);
  assert.equal(vals.name, 'c');
});

test('the committed Zabbix template is what the generator writes', () => {
  const fresh = execFileSync(process.execPath, [path.join(ROOT, 'tools/zabbix-plan-template.mjs')], { encoding: 'utf8' });
  const committed = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro-client-plan.yaml'), 'utf8');
  assert.equal(committed, fresh, 'regenerate: node tools/zabbix-plan-template.mjs > deploy/zabbix/template-elasticpro-client-plan.yaml');
});

test('the template carries one item per plan column', () => {
  const t = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro-client-plan.yaml'), 'utf8');
  for (const c of v.CLIENT_COLUMNS.filter((x) => x.key !== 'name')) {
    assert.ok(t.includes(`key: 'elasticpro.plan[${c.key}]'`), `${c.key} missing from the template`);
  }
});

test('each plan item carries its place in the Client plan grid, in the page’s own order', async () => {
  // The Volume report widget in Zabbix lays the plan out from these tags alone.
  const fs = await import('node:fs');
  const { CLIENT_COLUMNS } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume.js')).href);
  const yaml = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro-client-plan.yaml'), 'utf8');
  const placed = [...yaml.matchAll(/key: 'elasticpro\.plan\[([^\]]+)\]'[\s\S]*?- tag: column\n\s+value: '(\d+)'/g)]
    .map((m) => [Number(m[2]), m[1]]).sort((a, b) => a[0] - b[0]);
  const expected = CLIENT_COLUMNS.filter((c) => c.key !== 'name').map((c) => c.key);
  assert.deepEqual(placed.map(([, k]) => k), expected);
  assert.deepEqual(placed.map(([n]) => n), expected.map((_, i) => i + 1), 'numbered 1..n with no gaps');
});
