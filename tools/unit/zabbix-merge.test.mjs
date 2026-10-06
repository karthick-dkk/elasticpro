/**
 * Folding Zabbix clusters into a config — "Zabbix wins", as code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
const cfg = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config.js')).href);

const fileConfig = () => cfg.normalize({
  credentials: { username: 'u', password: 'p' },
  clusters: [
    { name: 'vm-1', url: 'http://203.0.113.12:9200/' },
    { name: 'lab', url: 'http://10.0.0.9:9200' },
  ],
});
const zbx = [{ _id: 'zbx-vm-1-cluster', name: 'vm-1 cluster', url: 'http://203.0.113.12:9200', zabbixHost: 'vm-1 cluster',
               client: 'vm-1', credential: 'vault', credentialOk: true, zabbixGroups: ['ES vm-1'] }];

test('a Zabbix host replaces the config cluster at the same address', () => {
  const c = cfg.mergeZabbixClusters(fileConfig(), zbx);
  assert.deepEqual(c.clusters.map((x) => x.id), ['lab', 'zbx-vm-1-cluster']);
  assert.deepEqual(c.shadowed, [{ name: 'vm-1', url: 'http://203.0.113.12:9200', by: 'vm-1 cluster' }],
    'the one set aside is named, so nobody edits the copy that is no longer used');
});

test('a Zabbix cluster keeps the id the core uses and never asks for a password', () => {
  const z = cfg.mergeZabbixClusters(fileConfig(), zbx).clusters.find((x) => x.source === 'zabbix');
  assert.equal(z.id, 'zbx-vm-1-cluster');
  assert.equal(z.needsCred, false);
  assert.equal(z.authHeader, null, 'its credential is the core\'s, from Vault');
  assert.deepEqual(z.zabbixGroups, ['ES vm-1']);
});

test('merging again replaces the Zabbix set, and a host that goes away gives the file back its cluster', () => {
  const c = cfg.mergeZabbixClusters(fileConfig(), zbx);
  cfg.mergeZabbixClusters(c, zbx);
  assert.equal(c.clusters.filter((x) => x.source === 'zabbix').length, 1, 'no duplicates on a second merge');
  cfg.mergeZabbixClusters(c, []);
  assert.deepEqual(c.clusters.map((x) => x.name).sort(), ['lab', 'vm-1'], 'the file cluster is back when Zabbix no longer has it');
  assert.deepEqual(c.shadowed, []);
});

test('no Zabbix answer leaves the config as it was', () => {
  const c = cfg.mergeZabbixClusters(fileConfig(), undefined);
  assert.deepEqual(c.clusters.map((x) => x.id), ['vm-1', 'lab']);
});

test('a Zabbix host that cannot sign in does not replace one that can', () => {
  // The password is not in Vault yet. Taking over now would swap a working cluster for a
  // broken one — so it waits, and says so.
  const broken = [{ ...zbx[0], credentialOk: false, notes: ['nothing is stored at secret/elasticpro/vm-1 in Vault'] }];
  const c = cfg.mergeZabbixClusters(fileConfig(), broken);
  assert.deepEqual(c.clusters.map((x) => x.id), ['vm-1', 'lab']);
  assert.deepEqual(c.shadowed, []);
  assert.equal(c.zabbixPending.length, 1);
  // And once it works, it takes over.
  cfg.mergeZabbixClusters(c, zbx);
  assert.deepEqual(c.clusters.map((x) => x.id), ['lab', 'zbx-vm-1-cluster']);
  assert.deepEqual(c.zabbixPending, []);
});

/* ---- following the core: a host added in Zabbix reaches an open page ---- */

test('no difference between the core and the page is no drift', () => {
  const c = cfg.mergeZabbixClusters(fileConfig(), zbx);
  // The shadowed config cluster is still primed to the core, so the core names it too.
  assert.equal(cfg.zabbixDrift(['lab', 'zbx-vm-1-cluster', 'vm-1'], c), '');
  assert.equal(cfg.zabbixDrift(['lab'], null), '', 'no config yet: nothing to follow');
  assert.equal(cfg.zabbixDrift(undefined, c), '', 'an answer with no clusterIds says nothing');
});

test('a cluster the core has and the page does not is drift — once per difference', () => {
  const c = cfg.mergeZabbixClusters(fileConfig(), zbx);
  const a = cfg.zabbixDrift(['lab', 'zbx-vm-1-cluster', 'vm-1', 'zbx-new-cluster'], c);
  assert.notEqual(a, '');
  // The same difference gives the same signature, so the page re-reads the list once, not
  // on every FLEET_STATE while an id it cannot explain is still there.
  assert.equal(cfg.zabbixDrift(['zbx-new-cluster', 'vm-1', 'lab', 'zbx-vm-1-cluster'], c), a);
});

test('a Zabbix cluster the core no longer has is drift; a config cluster it lacks is not', () => {
  const c = cfg.mergeZabbixClusters(fileConfig(), zbx);
  assert.notEqual(cfg.zabbixDrift(['lab', 'vm-1'], c), '', 'the Zabbix host was deleted');
  // A config cluster the core has not been primed with yet is the prime's business, not Zabbix's.
  assert.equal(cfg.zabbixDrift(['zbx-vm-1-cluster', 'vm-1'], c), '');
});

test('a Zabbix host held back for its password is known, not new', () => {
  const broken = [{ ...zbx[0], credentialOk: false }];
  const c = cfg.mergeZabbixClusters(fileConfig(), broken);
  // The core polls it (it has the spec) even though the page keeps using the config copy.
  assert.equal(cfg.zabbixDrift(['vm-1', 'lab', 'zbx-vm-1-cluster'], c), '');
});
