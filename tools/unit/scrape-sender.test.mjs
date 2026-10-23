/**
 * `elasticpro-scrape.mjs --format sender` against the template it feeds.
 *
 * The sender format once emitted keys the automation template did not have
 * (`elasticpro.scrape.ok`, `elasticpro.freed.bytes`, …) or had only as dependent items,
 * which do not take trapped values, so Zabbix rejected every one. Each key emitted must be
 * an item in deploy/zabbix/template-elasticpro.yaml that accepts a pushed value: a trapper
 * item, or an HTTP agent item with trapping enabled (the master the dependents read from).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { senderLines, SENDER_KEY } = await import(pathToFileURL(path.join(ROOT, 'tools/lib/scrape-sender.mjs')).href);
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro.yaml'), 'utf8');

/**
 * The template's top-level items as {key, type, allowTraps, master}. A small reader, not a
 * YAML parser: an item starts at `- uuid:` at the items list's indent, and its own fields
 * are the lines two deeper (nested preprocessing and master_item sit deeper still).
 */
function templateItems(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^ {6}items:$/.test(l));
  assert.ok(start >= 0, 'the template has an items: list');
  const items = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (/^ {0,6}\S/.test(l)) break; // the next section of the template (discovery_rules, …)
    const m = l.match(/^ {8}- uuid: (\S+)/);
    if (m) { cur = { uuid: m[1] }; items.push(cur); continue; }
    const f = cur && l.match(/^ {10}(\w+): ?(.*)$/);
    if (f) cur[f[1]] = f[2].replace(/^'(.*)'$/, '$1');
    const mk = cur && l.match(/^ {12}key: (.+)$/);
    if (mk && lines[i - 1].trim() === 'master_item:') cur.master = mk[1];
  }
  return items;
}

/** zabbix_sender -i input → [{host, key, value}], unquoting as zabbix_sender does. */
function parseSenderInput(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const m = line.match(/^(\S+) (\S+) "((?:[^"\\]|\\.)*)"$/);
    assert.ok(m, `a zabbix_sender line: ${line.slice(0, 80)}`);
    return { host: m[1], key: m[2], value: m[3].replace(/\\(.)/g, '$1') };
  });
}

const DOC = {
  ok: false, generated: '2026-10-23T00:00:00.000Z', generatedEpoch: 1792713600, durationMs: 1200,
  source: 'clusters.yaml', problems: ['a "quoted" problem \\ with a backslash\nand a newline'],
  totals: { clusters: 1, unreachable: 0, proposed: 2, held: 1, freedBytes: 4096, errors: 0, rulesEvaluated: 3 },
  clusters: [{ id: 'prod', name: 'prod', reachable: true, health: 'green', proposed: 2, held: 1, freedBytes: 4096, errors: 0,
    rules: [{ id: 'r1', title: 'Old logs', proposed: 2, held: 1, freedBytes: 4096, detail: 'past "30d"', targets: [], heldBack: [] }] }],
  plan: {},
  discovery: { clusters: [{ '{#CLUSTER.ID}': 'prod', '{#CLUSTER.NAME}': 'prod' }], rules: [] },
};

test('every key the sender format emits is an item in the template that takes a pushed value', () => {
  const items = templateItems(TEMPLATE);
  const byKey = new Map(items.map((it) => [it.key, it]));
  const rows = parseSenderInput(senderLines(DOC, 'elasticpro'));
  assert.ok(rows.length > 0);
  for (const r of rows) {
    const it = byKey.get(r.key);
    assert.ok(it, `${r.key} is not an item in template-elasticpro.yaml`);
    assert.ok(it.type === 'TRAP' || (it.type === 'HTTP_AGENT' && it.allow_traps === 'YES'),
      `${r.key} is ${it.type}${it.allow_traps ? ` (allow_traps ${it.allow_traps})` : ''}: Zabbix rejects a trapped value for it`);
  }
});

test('the pushed value is the scrape document itself, so the dependents read it as they read the polled one', () => {
  const [row] = parseSenderInput(senderLines(DOC, 'ep-host'));
  assert.equal(row.host, 'ep-host');
  assert.equal(row.key, SENDER_KEY);
  assert.deepEqual(JSON.parse(row.value), DOC, 'quoting round-trips quotes, backslashes and newlines');
  // Every dependent's master is the key the sender fills.
  const deps = templateItems(TEMPLATE).filter((it) => it.type === 'DEPENDENT');
  assert.ok(deps.length >= 5);
  for (const d of deps) assert.equal(d.master, SENDER_KEY, `${d.key} reads from ${d.master}`);
  assert.ok(!TEMPLATE.match(/master_item:\n\s+key: (?!elasticpro\.state\b)/), 'every master_item in the template is elasticpro.state');
});

test('a push-only host can stop the master from polling', () => {
  const master = templateItems(TEMPLATE).find((it) => it.key === SENDER_KEY);
  assert.equal(master.delay, '{$ELASTICPRO.POLL}');
  assert.match(TEMPLATE, /- macro: '\{\$ELASTICPRO\.POLL\}'\n {10}value: '5m'/, 'polls every 5 minutes unless a host sets 0');
});

test('elasticpro-scrape.mjs emits the sender format through this module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/elasticpro-scrape.mjs'), 'utf8');
  assert.match(src, /import \{ senderLines \} from '\.\/lib\/scrape-sender\.mjs';/);
  assert.match(src, /text = senderLines\(doc, zbxHost\);/);
  assert.doesNotMatch(src, /elasticpro\.scrape\.ok|elasticpro\.freed\.bytes/, 'no per-figure sender keys left behind');
});
