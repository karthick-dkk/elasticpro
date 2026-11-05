/**
 * Config-Management's map (core/config-nav.js): nine pages and their tabs, who sees which,
 * where yesterday's thirteen Config tabs went, the hashes, and "Find a setting".
 *
 * Role gating must not loosen: an operator gets Clusters › Clusters, Alerts › Automation and
 * Requests › Request Centre and nothing else; a user and a guest get nothing; everything else
 * stays an admin's. A tab the core has not said it supports (history store, scheduled delay,
 * backup) is not there at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const N = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config-nav.js')).href);
const ALL = { accounts: true, history: true, sink: true, backup: true };
const ids = (vis) => vis.map((p) => `${p.id}:${p.tabs.map((t) => t.id).join('+')}`);

test('nine pages, in the order of the board', () => {
  assert.deepEqual(N.CFG_PAGES.map((p) => p.label),
    ['Clusters', 'Accounts', 'Zabbix', 'Alerts', 'Requests', 'Reports', 'Data', 'Play', 'System']);
  const tabs = Object.fromEntries(N.CFG_PAGES.map((p) => [p.id, p.tabs.map((t) => t.label)]));
  assert.deepEqual(tabs.clusters, ['Clusters', 'Credentials', 'Jump hosts & trust']);
  assert.deepEqual(tabs.alerts, ['Triggers', 'Automation']);
  assert.deepEqual(tabs.requests, ['Policy', 'Request Centre']);
  assert.deepEqual(tabs.reports, ['Indices & volume fields', 'Mail delivery', 'Plan templates']);
  assert.deepEqual(tabs.data, ['Backend', 'Scheduled log delay']);
  assert.deepEqual(tabs.system, ['Defaults', 'Config file', 'Backup & restore']);
});

test('an admin (or a build without accounts) sees every supported tab', () => {
  assert.equal(N.visibleConfig('admin', ALL).length, 9);
  // No accounts: the portable build, where nobody is signed in and everyone is the admin.
  const none = N.visibleConfig(null, { history: false, sink: false, backup: false, accounts: false });
  assert.deepEqual(ids(none), ['clusters:clusters+creds+trust', 'zabbix:zabbix', 'alerts:triggers+automation',
    'requests:policy+centre', 'reports:fields+mail+templates', 'play:play', 'system:defaults+file']);
});

test('an operator sees Clusters, Automation and the Request Centre only', () => {
  assert.deepEqual(ids(N.visibleConfig('operator', ALL)), ['clusters:clusters', 'alerts:automation', 'requests:centre']);
});

test('a user and a guest do not reach Config-Management', () => {
  assert.deepEqual(N.visibleConfig('user', ALL), []);
  assert.deepEqual(N.visibleConfig('guest', ALL), []);
  assert.deepEqual(N.visibleConfig('someone-new', ALL), []);
  assert.equal(N.reachesConfig('operator'), true);
  assert.equal(N.reachesConfig('user'), false);
  assert.equal(N.reachesConfig(null), true);
});

test('a tab the core does not report is not there; Data goes when both of its tabs do', () => {
  const vis = N.visibleConfig('admin', { accounts: true, history: true, sink: false, backup: false });
  assert.deepEqual(vis.find((p) => p.id === 'data').tabs.map((t) => t.id), ['backend']);
  assert.ok(!vis.find((p) => p.id === 'system').tabs.some((t) => t.id === 'backup'), 'Backup & restore shown without core support');
  const bare = N.visibleConfig('admin', {});
  assert.ok(!bare.some((p) => p.id === 'data'), 'an empty Data page is listed');
  assert.ok(!bare.some((p) => p.id === 'accounts'), 'Accounts listed where there are no accounts');
});

test('every one of yesterday\'s thirteen Config tabs has a home', () => {
  const old = ['file', 'creds', 'clusters', 'zabbix', 'trust', 'alerts', 'schedule', 'history', 'requests', 'defaults', 'volume', 'play', 'diag'];
  for (const id of old) {
    const home = N.LEGACY_SECTIONS[id];
    assert.ok(home, `${id} has no home`);
    const page = N.CFG_PAGES.find((p) => p.id === home[0]);
    assert.ok(page && page.tabs.some((t) => t.id === home[1]), `${id} points at ${home.join('/')}, which does not exist`);
  }
  assert.deepEqual(N.routeOfRest('volume'), { page: 'reports', tab: 'fields' });
  assert.deepEqual(N.routeOfRest('requests/policy'), { page: 'requests', tab: 'policy' });
  assert.deepEqual(N.routeOfRest(''), { page: '', tab: '' });
});

test('the hosted tabs keep their own app page and address', () => {
  assert.equal(N.tabHash('alerts', 'automation'), '#/automation');
  assert.equal(N.tabHash('requests', 'centre'), '#/requests');
  assert.equal(N.tabHash('accounts', 'accounts'), '#/accounts');
  assert.equal(N.tabHash('system', 'file'), '#/settings/system/file');
  assert.equal(N.appPageOf('requests', 'centre'), 'requests');
  assert.equal(N.appPageOf('requests', 'policy'), 'settings');
  for (const [app, [page, tab]] of Object.entries(N.HOSTED_TABS)) assert.equal(N.appPageOf(page, tab), app);
});

test('a route falls back to what is visible', () => {
  const op = N.visibleConfig('operator', ALL);
  assert.deepEqual(N.resolveRoute(op, 'system', 'file'), { page: 'clusters', tab: 'clusters' });
  assert.deepEqual(N.resolveRoute(op, 'requests', 'policy'), { page: 'requests', tab: 'centre' });
  assert.deepEqual(N.resolveRoute(op, 'alerts', ''), { page: 'alerts', tab: 'automation' });
  assert.equal(N.resolveRoute([], 'clusters', 'clusters'), null);
});

test('sub-lines name the tabs, or the page\'s own words', () => {
  const vis = N.visibleConfig('admin', ALL);
  assert.equal(N.subLine(vis.find((p) => p.id === 'clusters')), 'Clusters · Credentials · Jump hosts & trust');
  assert.equal(N.subLine(vis.find((p) => p.id === 'play')), 'TV displays · watch rules');
});

test('Find a setting: every word must match, best first, visible tabs only', () => {
  const vis = N.visibleConfig('admin', ALL);
  const hits = N.findSettings('watch window', vis);
  assert.equal(hits[0].label, 'Watch window');
  assert.equal(hits[0].page, 'requests');
  assert.equal(hits[0].tab, 'policy');
  assert.equal(hits[0].field, 'pol-watch');
  assert.equal(hits[0].where, 'Requests › Policy');
  assert.deepEqual(N.findSettings('', vis), []);
  assert.deepEqual(N.findSettings('zzzz-no-such-setting', vis), []);
  // A word from the extra keywords finds it too ("smtp" is not in "Mail server").
  assert.ok(N.findSettings('smtp', vis).some((x) => x.field === 'ms-host'));
  // Starts-with ranks above contains.
  const port = N.findSettings('port', vis).map((x) => x.label);
  assert.ok(port.indexOf('SMTP port') >= 0);
  // An operator does not find an admin's settings.
  const op = N.visibleConfig('operator', ALL);
  assert.deepEqual(N.findSettings('watch window', op), []);
  assert.ok(N.findSettings('emergency stop', op).length === 1);
  // Rows a page adds at run time are searched as well.
  const extra = [...N.SETTING_INDEX, ['alerts', 'triggers', 'JVM heap above 85%', 'al-on-heap', 'alert']];
  assert.equal(N.findSettings('heap', vis, { index: extra })[0].field, 'al-on-heap');
  // No result twice, and never more than the limit.
  assert.ok(N.findSettings('a', vis, { limit: 5 }).length <= 5);
});

test('every index row points at a page and tab that exist', () => {
  for (const [page, tab, label] of N.SETTING_INDEX) {
    const p = N.CFG_PAGES.find((x) => x.id === page);
    assert.ok(p && p.tabs.some((t) => t.id === tab), `${label} → ${page}/${tab}`);
  }
});
