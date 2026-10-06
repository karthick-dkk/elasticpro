/**
 * Config → Zabbix, the pure parts: what the form sends (and never sends), the status line,
 * the pairing countdown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const z = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-link.js')).href);

const status = (over = {}) => ({
  ok: true, supported: true, zabbixUrl: 'https://zbx.example.com', apiUrl: 'https://zbx.example.com/api_jsonrpc.php',
  apiUrlIsDefault: true, verifyTls: true, allowHttp: false, allowedSources: [], syncSecs: 300,
  managed: { zabbixUrl: false, apiUrl: false, apiToken: false, ssoSecret: false, verifyTls: false, allowedSources: false, syncSecs: false },
  apiToken: { set: false, source: '' }, ssoSecret: { set: false, source: '' }, paired: false, pending: null,
  sync: { configured: false, lastOk: null, error: null, clusters: 0, skipped: 0 }, events: [], ...over,
});
const form = (over = {}) => ({ zabbixUrl: 'https://zbx.example.com', apiUrl: 'https://zbx.example.com/api_jsonrpc.php', apiToken: '',
  verifyTls: true, allowHttp: false, allowedSources: '', syncSecs: '300', ...over });

test('the API URL defaults from the Zabbix URL', () => {
  assert.equal(z.defaultApiUrl('https://zbx.example.com/'), 'https://zbx.example.com/api_jsonrpc.php');
  assert.equal(z.defaultApiUrl('https://h/zabbix'), 'https://h/zabbix/api_jsonrpc.php');
  assert.equal(z.defaultApiUrl(''), '');
});

test('addresses are checked the way the core checks them', () => {
  assert.deepEqual(z.checkUrl('https://zbx.example.com/'), { ok: true, value: 'https://zbx.example.com', error: '' });
  assert.equal(z.checkUrl('http://zbx').ok, false);
  assert.equal(z.checkUrl('http://zbx', true).ok, true);
  assert.equal(z.checkUrl('zbx.example.com').ok, false);
  assert.equal(z.checkUrl('https://u:p@zbx').ok, false);
  assert.equal(z.checkUrl('https://zbx/?x=1').ok, false);
  assert.equal(z.checkUrl('').error, 'required');
});

test('allowed sources: IPs and CIDRs, anything else flagged', () => {
  assert.deepEqual(z.parseSources('10.0.0.0/24, 203.0.113.10\nfd00::/8'), { list: ['10.0.0.0/24', '203.0.113.10', 'fd00::/8'], bad: [] });
  assert.deepEqual(z.parseSources('10.0.0.300 zabbix.lan 10.0.0.0/33').bad, ['10.0.0.300', 'zabbix.lan', '10.0.0.0/33']);
  assert.deepEqual(z.parseSources('  ').list, []);
});

test('an unchanged form sends nothing', () => {
  assert.deepEqual(z.linkChanges(status(), form()), {});
});

test('only what changed is sent, and the default API URL stays a default', () => {
  const ch = z.linkChanges(status(), form({ zabbixUrl: 'https://new.example.com/', apiUrl: 'https://new.example.com/api_jsonrpc.php', syncSecs: '120' }));
  assert.deepEqual(ch, { zabbixUrl: 'https://new.example.com', syncSecs: 120 }, 'an API URL equal to the default is not pinned');
  assert.deepEqual(z.linkChanges(status(), form({ apiUrl: 'http://zabbix-web:8080/api_jsonrpc.php' })), { apiUrl: 'http://zabbix-web:8080/api_jsonrpc.php' });
  // Going back to the default clears the custom one.
  const custom = status({ apiUrl: 'http://zabbix-web:8080/api_jsonrpc.php', apiUrlIsDefault: false });
  assert.deepEqual(z.linkChanges(custom, form()), { apiUrl: '' });
});

test('the token is sent only when a new one was typed', () => {
  assert.equal('apiToken' in z.linkChanges(status({ apiToken: { set: true, source: 'ui' } }), form()), false);
  assert.equal(z.linkChanges(status(), form({ apiToken: ' abcdefabcdefabcdef ' })).apiToken, 'abcdefabcdefabcdef');
});

test('a field the server owns is never sent', () => {
  const s = status({ managed: { ...status().managed, apiToken: true, syncSecs: true, zabbixUrl: true } });
  const ch = z.linkChanges(s, form({ zabbixUrl: 'https://other', apiToken: 'abcdefabcdefabcdef', syncSecs: '60', verifyTls: false }));
  assert.deepEqual(ch, { verifyTls: false });
});

test('sources and TLS changes', () => {
  assert.deepEqual(z.linkChanges(status(), form({ allowedSources: '10.0.0.1\n10.0.0.2' })), { allowedSources: ['10.0.0.1', '10.0.0.2'] });
  assert.deepEqual(z.linkChanges(status({ allowedSources: ['10.0.0.1'] }), form({ allowedSources: '' })), { allowedSources: [] });
  assert.deepEqual(z.linkChanges(status(), form({ verifyTls: false, allowHttp: true })), { allowHttp: true, verifyTls: false });
});

test('form problems are named by field', () => {
  assert.deepEqual(z.formProblems(status(), form()), {});
  const p = z.formProblems(status(), form({ zabbixUrl: 'http://zbx', apiToken: 'short', allowedSources: 'nope', syncSecs: '5' }));
  assert.deepEqual(Object.keys(p).sort(), ['allowedSources', 'apiToken', 'syncSecs', 'zabbixUrl']);
  assert.deepEqual(z.formProblems(status(), form({ zabbixUrl: 'http://zbx', apiUrl: '', allowHttp: true })), {});
});

test('the countdown', () => {
  const now = 1_790_000_000_000;
  assert.equal(z.countdown(now / 1000 + 899, now), '14:59');
  assert.equal(z.countdown(now / 1000 + 5, now), '0:05');
  assert.equal(z.countdown(now / 1000 - 1, now), 'expired');
  assert.equal(z.secondsLeft(now / 1000 - 100, now), 0);
});

test('linkView: setup until something is connected, then summary', () => {
  assert.equal(z.linkView(status()), 'setup');
  assert.equal(z.linkView(status({ pending: { exp: Date.now() / 1000 + 60, zabbixUrl: 'https://zbx', by: 'a' } })), 'setup',
    'a pairing in progress is not yet a connection — the form (with the pending code dialog) still leads');
  assert.equal(z.linkView(status({ paired: true })), 'summary');
  assert.equal(z.linkView(status({ apiToken: { set: true, source: 'ui' } })), 'summary', 'a token pasted by hand counts as configured');
  assert.equal(z.linkView(status({ ssoSecret: { set: true, source: 'server' } })), 'summary', 'server-managed counts as configured too');
  assert.equal(z.linkView(status({ sync: { configured: true } })), 'summary');
  assert.equal(z.linkView({ supported: false }), 'setup', 'callers check supported/loading before asking');
});

test('the summary says what is known, and unknown is not zero', () => {
  const now = 1_790_000_000;
  assert.equal(z.linkSummary(status(), now).title, 'not connected');
  assert.equal(z.linkSummary({ supported: false }, now).title, 'not available');
  const pend = z.linkSummary(status({ pending: { exp: now + 60, zabbixUrl: 'https://zbx', by: 'a' } }), now);
  assert.equal(pend.title, 'pairing in progress');
  assert.match(pend.detail, /1:00/);
  const paired = z.linkSummary(status({ paired: true, zabbixVersion: '7.0.5', sync: { configured: true, lastOk: now, clusters: 3, skipped: 1 } }), now);
  assert.equal(paired.tone, 'green');
  assert.match(paired.detail, /Zabbix 7\.0\.5 · last sync OK — 3 cluster hosts, 1 skipped/);
  const never = z.linkSummary(status({ paired: true, sync: { configured: true, lastOk: null, clusters: 0 } }), now);
  assert.match(never.detail, /not synced yet/, 'never synced is not "0 clusters"');
  const broken = z.linkSummary(status({ paired: true, sync: { configured: true, error: 'Zabbix API unreachable' } }), now);
  assert.equal(broken.tone, 'red');
  const server = z.linkSummary(status({ ssoSecret: { set: true, source: 'server' }, sync: { configured: true, lastOk: now, clusters: 1 } }), now);
  assert.match(server.title, /server configuration/);
});

test('test results read as sentences', () => {
  assert.match(z.testMessage({ ok: true, version: '7.0.5', message: 'Zabbix 7.0.5: the token works' }), /token works/);
  assert.match(z.testMessage({ ok: false, kind: 'auth', message: 'Zabbix template.get: Not authorised.' }), /refused the API token/);
  assert.match(z.testMessage({ ok: false, kind: 'tls_untrusted' }), /not trusted yet/);
});

test('the callback address is what the browser sees', () => {
  assert.equal(z.epUrlFrom({ origin: 'https://ep.example.com', pathname: '/' }), 'https://ep.example.com');
  assert.equal(z.epUrlFrom({ origin: 'https://h', pathname: '/ep/index.html' }), 'https://h/ep');
  assert.equal(z.epUrlFrom({ origin: 'https://h', pathname: '/ep/' }), 'https://h/ep');
});

test('event lines name who and what, never a secret field value', () => {
  assert.equal(z.eventLine({ action: 'pair', ok: false, by: 'zabbix-module', source: '10.0.0.5', detail: 'bad signature' }),
    'FAILED pairing — zabbix-module from 10.0.0.5: bad signature');
  assert.equal(z.eventLine({ action: 'set', ok: true, by: 'admin', detail: 'changed apiToken' }), 'changed settings — admin: changed apiToken');
});
