/**
 * Opening ElasticPro from inside Zabbix.
 *
 * The code in the URL is a credential for sixty seconds. These pin that it is removed from
 * the address bar without taking the page or the embed flag with it, and that the Zabbix
 * theme maps onto one this app actually has.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const e = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/embed.js')).href);

test('the launch URL is read', () => {
  const l = e.readLaunch({ search: '?sso_code=abc123&embed=1&zbx_theme=dark-theme' });
  assert.deepEqual({ ...l, trouble: undefined }, { code: 'abc123', embed: true, zabbixTheme: 'dark-theme', trouble: undefined });
  assert.deepEqual(l.trouble, { host: '', client: '', rule: '', problem: '' });
});

test('a plain visit is not embedded and carries no code', () => {
  const plain = e.readLaunch({ search: '' });
  assert.deepEqual([plain.code, plain.embed, plain.zabbixTheme], ['', false, '']);
  assert.equal(e.readLaunch({ search: '?embed=0' }).embed, false);
});

test('the code leaves the address bar, and nothing else does', () => {
  assert.equal(e.withoutCode('https://h/?sso_code=abc&embed=1&zbx_theme=blue-theme#/indices'),
    '/?embed=1&zbx_theme=blue-theme#/indices');
  assert.equal(e.withoutCode('https://h/?sso_code=abc#/logs'), '/#/logs');
  assert.ok(!e.withoutCode('https://h/app/?x=1&sso_code=abc').includes('sso_code'));
});

test('Zabbix themes map onto ones this app has', () => {
  assert.equal(e.themeFor('dark-theme'), 'dark');
  assert.equal(e.themeFor('hc-dark'), 'dark');
  assert.equal(e.themeFor('blue-theme'), 'light');
  assert.equal(e.themeFor('hc-light'), 'light');
  // "The Zabbix default" is not visible from here; guessing would be wrong half the time.
  assert.equal(e.themeFor('default'), null);
  assert.equal(e.themeFor(''), null);
});

test('an exchange that fails says why and does not throw', async () => {
  const refused = await e.exchangeCode('x', async () => ({ ok: false, message: 'expired' }));
  assert.deepEqual(refused, { ok: false, message: 'expired' });
  const broken = await e.exchangeCode('x', async () => { throw new Error('network down'); });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /network down/);
  const none = await e.exchangeCode('', async () => { throw new Error('must not be called'); });
  assert.equal(none.ok, false);
});

test('an exchange that works hands back the session', async () => {
  let sent = null;
  const res = await e.exchangeCode('c0de', async (m) => { sent = m; return { ok: true, session: 's', caller: { name: 'u@zabbix' } }; });
  assert.deepEqual(sent, { type: 'SSO_EXCHANGE', code: 'c0de' });
  assert.equal(res.session, 's');
});

test('inside Zabbix, a lost session asks the page around it — never a login form', () => {
  const sent = [];
  const parent = { postMessage: (m, o) => sent.push([m, o]) };
  assert.equal(e.askZabbixToSignIn({ parent }), true);
  assert.deepEqual(sent, [[{ type: e.REAUTH_MESSAGE }, '*']]);
});

test('opened on its own there is nobody to ask, so the caller falls back to the login', () => {
  const win = {}; win.parent = win;
  assert.equal(e.askZabbixToSignIn(win), false);
  assert.equal(e.askZabbixToSignIn(null), false);
  assert.equal(e.askZabbixToSignIn({ parent: { postMessage() { throw new Error('blocked'); } } }), false);
});

test('inZabbix reads the launch class, and nothing else', () => {
  const had = globalThis.document;
  globalThis.document = { documentElement: { classList: { contains: (c) => c === 'embedded' } } };
  assert.equal(e.inZabbix(), true);
  globalThis.document = { documentElement: { classList: { contains: () => false } } };
  assert.equal(e.inZabbix(), false);
  globalThis.document = had;
});

/* ---------------- Troubleshoot in ElasticPro, from a Zabbix problem ---------------- */

const { pageForProblem } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/alert-rules.js')).href);
const fleet = [
  { id: 'c1', name: 'vm-1', tags: ['acme'], zabbix: { host: 'es-acme-prod', client: 'acme' } },
  { id: 'c2', name: 'vm-2', tags: ['beta'] },
  { id: 'c3', name: 'vm-3', tags: ['beta'] },
];
const launch = (qs) => e.readLaunch({ search: `?embed=1&${qs}` }).trouble;

test('a macro Zabbix could not fill is treated as absent, not as a name', () => {
  // {$GRP.CLIENT} on a host that does not define it, and a problem without a rule tag.
  const t = launch('zbx_host=es-acme-prod&client=%7B%24GRP.CLIENT%7D&rule=*UNKNOWN*&problem=x');
  assert.equal(t.client, '');
  assert.equal(t.rule, '');
  assert.equal(t.host, 'es-acme-prod');
});

test('an ElasticPro problem lands on its cluster, on the page its rule names', () => {
  const t = launch('zbx_host=es-acme-prod&rule=slm-fail&problem=Last%20SLM%20run%20failed');
  assert.deepEqual(e.troubleshootTarget(t, fleet, pageForProblem), { page: 'snapshots', cluster: 'c1' });
});

test('the rule beats the words', () => {
  // An ILM problem that names a disk is still answered where ILM is.
  const t = launch('zbx_host=es-acme-prod&rule=ilm&problem=Indices%20stuck%20on%20a%20full%20disk');
  assert.equal(e.troubleshootTarget(t, fleet, pageForProblem).page, 'indices');
});

test('a Zabbix-template problem, with no rule, is placed by its name', () => {
  const at = (problem) => e.troubleshootTarget(launch(`zbx_host=vm-2&problem=${encodeURIComponent(problem)}`), fleet, pageForProblem);
  assert.deepEqual(at('Elasticsearch: Health is YELLOW'), { page: 'shards', cluster: 'c2' });
  assert.equal(at('ES Indices size above than avg').page, 'volume');
  assert.equal(at('Client plan: live storage over 85% used').page, 'volume');
  assert.equal(at('EC2 backup failed').page, 'snapshots');
  assert.equal(at('Elasticsearch: Service is down').page, 'overview');
});

test('a config-file cluster is found by its own name, case aside', () => {
  const t = launch('zbx_host=VM-2&problem=x');
  assert.equal(e.troubleshootTarget(t, fleet, pageForProblem).cluster, 'c2');
});

test('a forwarder host finds its cluster through the client, when the client has one', () => {
  const one = launch('zbx_host=fwd-acme-01&client=acme&problem=High%20CPU%20utilization');
  assert.equal(e.troubleshootTarget(one, fleet, pageForProblem).cluster, 'c1');
  // Two clusters for the client: picking one would be a guess, so none is picked.
  const two = launch('zbx_host=fwd-beta-01&client=beta&problem=High%20CPU%20utilization');
  assert.equal(e.troubleshootTarget(two, fleet, pageForProblem).cluster, null);
});

test('a cluster this person cannot see is not selected', () => {
  // The list passed in is already only what the caller may see.
  const t = launch('zbx_host=es-acme-prod&rule=disk');
  assert.deepEqual(e.troubleshootTarget(t, fleet.slice(1), pageForProblem), { page: 'shards', cluster: null });
});

test('a plain launch is not a troubleshoot request', () => {
  assert.equal(e.troubleshootTarget(launch(''), fleet, pageForProblem), null);
  // A host action on a host that is no cluster of theirs: nothing to act on.
  assert.equal(e.troubleshootTarget(launch('zbx_host=unrelated'), fleet, pageForProblem), null);
});

test('the request is dropped from the URL once acted on, and nothing else is', () => {
  const href = 'https://ep.example/?embed=1&zbx_theme=blue-theme&zbx_host=a&client=b&rule=disk&problem=p#/shards';
  assert.equal(e.withoutTrouble(href), '/?embed=1&zbx_theme=blue-theme#/shards');
});

test('an ElasticPro problem is placed by its rule even when Zabbix leaves the rule tag unfilled', () => {
  // What Zabbix 7.0 actually sends: {EVENT.TAGS.rule} stays as its own text.
  const at = (name) => e.troubleshootTarget(
    launch(`zbx_host=es-acme-prod&rule=%7BEVENT.TAGS.rule%7D&problem=${encodeURIComponent(name)}`), fleet, pageForProblem).page;
  assert.equal(at('Devices shipping logs late — critical: vm-1: 2 device(s) critically late'), 'logs');
  assert.equal(at('Automation rule has work waiting — warning: vm-1: rule found 3 indices'), 'automation');
  assert.equal(at('Master moved — critical: vm-1: master moved from a to b'), 'shards');
  assert.equal(at('Indices in an ILM error step — warning: vm-1: 2 index(es)'), 'indices');
  assert.equal(at('No recent successful snapshot — warning: vm-1/daily'), 'snapshots');
});
