/**
 * The Zabbix templates ElasticPro ships are also shipped by the modules repository
 * (github.com/karthick-dkk/integration-zabbix-elasticpro, zabbix/templates/). Three are
 * generated here and copied there; the automation template is kept by hand in both. A fix made
 * in one repository and not the other is undone by the next regeneration or copy, which is how
 * the modules repo's template audit (2.1.3) would have been lost.
 *
 * Point ELASTICPRO_MODULES_REPO at a checkout of the modules repository and this test asserts
 * that every template is byte-identical in both: what each generator writes now (not only the
 * committed file), and the hand-kept automation template as committed. Unset, it is skipped,
 * because the checkout is not part of this repository. A path that is set but is not a modules
 * checkout fails, so a typo cannot pass as "skipped".
 *
 *   ELASTICPRO_MODULES_REPO=~/devops/projects/integration-zabbix-elasticpro node tools/unit-check.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPO = process.env.ELASTICPRO_MODULES_REPO || '';
const skip = REPO ? false : 'ELASTICPRO_MODULES_REPO is not set (a checkout of the modules repository)';

// template file name → the generator that writes it here, or null for the hand-kept one.
const TEMPLATES = {
  'template-elasticpro-alerts.yaml': 'tools/zabbix-alert-template.mjs',
  'template-elasticpro-log-delay.yaml': 'tools/zabbix-delay-template.mjs',
  'template-elasticpro-client-plan.yaml': 'tools/zabbix-plan-template.mjs',
  'template-elasticpro.yaml': null,
};

const theirs = (name) => {
  const dir = path.join(REPO, 'zabbix/templates');
  assert.ok(fs.existsSync(dir), `ELASTICPRO_MODULES_REPO=${REPO} has no zabbix/templates/ — not a modules checkout`);
  return fs.readFileSync(path.join(dir, name), 'utf8');
};

for (const [name, generator] of Object.entries(TEMPLATES)) {
  test(`${name} is the same in the modules repository`, { skip }, () => {
    const ours = generator
      ? execFileSync(process.execPath, [path.join(ROOT, generator)], { encoding: 'utf8' })
      : fs.readFileSync(path.join(ROOT, 'deploy/zabbix', name), 'utf8');
    const hint = generator
      ? `fix ${generator}, regenerate deploy/zabbix/${name}, and copy it to the modules repository's zabbix/templates/`
      : `deploy/zabbix/${name} and the modules repository's zabbix/templates/${name} must carry the same change`;
    assert.equal(ours, theirs(name), hint);
  });
}
