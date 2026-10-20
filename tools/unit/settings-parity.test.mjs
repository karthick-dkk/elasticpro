/**
 * One definition per quantity: the rules deploy.sh applies to config.txt (CFG_RULES) and the
 * ones the core applies (SPECS in settings.rs) are the same table. This fails when they drift,
 * which is how --apply-config came to report success for a value the core then dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const num = (t) => {
  assert.match(t, /^[0-9_ *]+$/, `not a plain number expression: ${t}`);
  return t.split('*').reduce((acc, f) => acc * Number(f.replace(/[_\s]/g, '')), 1);
};

function coreRules() {
  const rs = read('crates/elasticpro-core/src/settings.rs');
  const consts = {};
  for (const m of rs.matchAll(/^const (\w+): &\[&str\] = &\[([^\]]*)\];/gm)) {
    consts[m[1]] = [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  }
  const block = rs.slice(rs.indexOf('const SPECS'), rs.indexOf('];', rs.indexOf('const SPECS')));
  const rules = new Map();
  for (const m of block.matchAll(/^\s*spec\("([A-Z0-9_]+)",\s*Kind::(Bool|Text|Int\(([^)]*)\)|Enum\((.*?)\)),\s*To::/gm)) {
    const [, key, kind, ints, en] = m;
    let rule;
    if (kind === 'Bool') rule = 'bool';
    else if (kind === 'Text') rule = 'text';
    else if (ints !== undefined) { const [lo, hi] = ints.split(','); rule = `int ${num(lo.trim())} ${num(hi.trim())}`; }
    else {
      const list = en.startsWith('&[') ? [...en.matchAll(/"([^"]*)"/g)].map((x) => x[1]) : consts[en];
      assert.ok(list, `enum list not found for ${key}: ${en}`);
      rule = `enum ${list.join(',')}`;
    }
    assert.ok(!rules.has(key), `${key} listed twice in SPECS`);
    rules.set(key, rule);
  }
  const dk = rs.match(/const DEPLOY_KEYS: &\[&str\] = &\[([^\]]*)\];/);
  const deployKeys = [...dk[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  return { rules, deployKeys };
}

function deployRules() {
  const sh = read('deploy/deploy.sh');
  const m = sh.match(/^CFG_RULES='\n([\s\S]*?)'\n/m);
  assert.ok(m, 'CFG_RULES table not found in deploy.sh');
  const rules = new Map();
  for (const line of m[1].split('\n').filter((l) => l.trim())) {
    const [key, ...rest] = line.trim().split(/\s+/);
    assert.ok(!rules.has(key), `${key} listed twice in CFG_RULES`);
    rules.set(key, rest.join(' '));
  }
  return rules;
}

test('deploy.sh and the core apply the same rule to every core key', () => {
  const core = coreRules();
  const sh = deployRules();
  assert.ok(core.rules.size > 30, `parsed only ${core.rules.size} SPECS lines`);
  for (const [key, rule] of core.rules) {
    assert.ok(sh.has(key), `${key} is in SPECS but not in deploy.sh CFG_RULES`);
    assert.equal(sh.get(key), rule, `${key}: deploy.sh says "${sh.get(key)}", the core says "${rule}"`);
  }
});

test('deploy.sh knows no key the core does not, other than its own', () => {
  const core = coreRules();
  const sh = deployRules();
  const own = [...sh].filter(([, r]) => r === 'deploy').map(([k]) => k).sort();
  assert.deepEqual(own, [...core.deployKeys].sort(), 'deploy-only keys differ from DEPLOY_KEYS');
  for (const key of sh.keys()) {
    assert.ok(core.rules.has(key) || core.deployKeys.includes(key), `${key} is in deploy.sh CFG_RULES but unknown to the core`);
  }
});

test('every key in config.txt.example is known to both', () => {
  const core = coreRules();
  const sh = deployRules();
  const keys = [...read('deploy/config.txt.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.ok(keys.length > 30, 'no keys found in config.txt.example');
  for (const key of keys) {
    assert.ok(sh.has(key), `${key} (config.txt.example) is not in deploy.sh CFG_RULES`);
    assert.ok(core.rules.has(key) || core.deployKeys.includes(key), `${key} (config.txt.example) is unknown to the core`);
  }
  for (const key of core.rules.keys()) assert.ok(keys.includes(key), `${key} is a core key missing from config.txt.example`);
});

test('the request gate\'s keys sit in the performance section, in all three places', () => {
  const GATE_KEYS = ['ES_CONCURRENCY', 'ES_PER_CLUSTER', 'ES_PER_JUMP_HOST', 'ES_BACKGROUND_RESERVE', 'ES_QUEUE_MAX',
    'ES_QUEUE_PER_USER', 'ES_QUEUE_WAIT_MS', 'ES_MAX_TIMEOUT_MS', 'ES_READ_CACHE_SECONDS', 'ES_READ_CACHE_MB',
    'ES_MAX_RESPONSE_MB', 'ES_MAX_FLEET_RESPONSE_MB', 'ES_TASK_REAPER', 'ES_TASK_MAX_SECONDS', 'ZABBIX_CONCURRENCY'];
  const core = coreRules();
  const sh = deployRules();
  const ex = read('deploy/config.txt.example');
  const perf = ex.slice(ex.indexOf('-- performance'), ex.indexOf('-- UI defaults'));
  assert.ok(perf.length > 0, 'no performance section in config.txt.example');
  for (const k of GATE_KEYS) {
    assert.ok(core.rules.has(k), `${k} missing from SPECS`);
    assert.ok(sh.has(k), `${k} missing from deploy.sh CFG_RULES`);
    assert.match(perf, new RegExp(`^${k}=`, 'm'), `${k} is not in the performance section of config.txt.example`);
  }
  // The core reads each through the environment variable SPECS names; gate.rs must read the same.
  const rs = read('crates/elasticpro-core/src/settings.rs');
  const gate = read('crates/elasticpro-core/src/gate.rs');
  for (const k of GATE_KEYS) {
    const env = new RegExp(`spec\\("${k}",[^\\n]*To::Env\\("([A-Z_]+)"\\)`).exec(rs);
    assert.ok(env, `${k} does not map to an environment variable`);
    assert.ok(gate.includes(`"${env[1]}"`), `gate.rs never reads ${env[1]} (${k})`);
  }
});
