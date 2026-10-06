/** ElasticPro alert rules as Zabbix trigger values. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const z = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-alerts.js')).href);
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { ALERT_RULES } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/alert-rules.js')).href);

test('every rule is either sent to Zabbix or named as covered by it — none falls between', () => {
  const ids = ALERT_RULES.map((r) => r.id).sort();
  const accounted = [...z.ZABBIX_ALERT_RULES, ...Object.keys(z.COVERED_BY_ZABBIX)].sort();
  assert.deepEqual(accounted, ids, 'a new alert rule must be placed on one side or the other');
});

test('no rule is both sent and called covered — that is the double alarm this avoids', () => {
  for (const r of z.ZABBIX_ALERT_RULES) assert.ok(!(r in z.COVERED_BY_ZABBIX), r);
});

test('the worst level wins, and the detail names what is wrong', () => {
  const v = z.zabbixAlertValues([
    { key: 'c:disk', level: 'warning', title: 'c disk 82%', detail: 'Above warning threshold' },
    { key: 'c:slm-fail:daily', level: 'critical', title: 'daily failed', detail: 'on 09-01' },
    { key: 'c:slm-fail:weekly', level: 'critical', title: 'weekly failed', detail: 'on 09-02' },
    { key: 'c:health', level: 'critical', title: 'health RED' },
  ]);
  assert.deepEqual(v.disk, { level: 1, detail: 'warning: c disk 82% — Above warning threshold' });
  assert.equal(v['slm-fail'].level, 2);
  assert.match(v['slm-fail'].detail, /^critical: .*09-01.*09-02/, 'the level leads the detail the triggers read');
  assert.ok(!('health' in v), 'a rule Zabbix covers is not sent');
});

test('a clear rule is sent as 0, so the trigger resolves when the condition does', () => {
  const v = z.zabbixAlertValues([]);
  assert.equal(Object.keys(v).length, z.ZABBIX_ALERT_RULES.length);
  assert.ok(Object.values(v).every((x) => x.level === 0 && x.detail === ''));
});

test('the committed alerts template is what the generator writes', async () => {
  const fs = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const fresh = execFileSync(process.execPath, [path.join(ROOT, 'tools/zabbix-alert-template.mjs')], { encoding: 'utf8' });
  const committed = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro-alerts.yaml'), 'utf8');
  assert.equal(committed, fresh, 'regenerate: node tools/zabbix-alert-template.mjs > deploy/zabbix/template-elasticpro-alerts.yaml');
  for (const r of z.ZABBIX_ALERT_RULES) assert.ok(committed.includes(`elasticpro.alert[${r}]`), `${r} missing from the template`);
  for (const r of Object.keys(z.COVERED_BY_ZABBIX)) assert.ok(!committed.includes(`elasticpro.alert[${r}]`), `${r} would alarm twice`);
});
