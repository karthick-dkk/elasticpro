/**
 * Edits made in ElasticPro to a Zabbix cluster (core: zbx_overlay.rs): what the dialog sends,
 * and how the row the core built — overlay applied — becomes the cluster the pages use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
const cfg = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/config.js')).href);
const ov = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-overlay.js')).href);

test('the fields are the core\'s, and the address is not one of them', () => {
  assert.equal(ov.OVERLAY_FIELDS.length, 12);
  for (const k of ['url', 'username', 'password', 'type']) assert.ok(!ov.OVERLAY_FIELDS.includes(k), k);
});

test('only what changed is sent; emptied overrides and "Use Zabbix\'s value" are resets', () => {
  const change = ov.overlayChange([
    { key: 'name', now: 'Prod EU', was: 'es-prod', overridden: false },          // changed: set
    { key: 'note', now: null, was: 'old', overridden: true },                    // emptied: reset
    { key: 'liveRetention', now: '30d', was: '30d', overridden: true },          // untouched
    { key: 'via', now: '', was: 'jumpa', overridden: false },                    // direct on purpose: set ""
    { key: 'tls', now: null, was: null, overridden: false, reset: true },        // reset of nothing: nothing
    { key: 'tags', now: ['eu'], was: ['eu'], overridden: true, reset: true },    // Use Zabbix's value
    { key: 'enabled', now: true, was: true, overridden: false },
    { key: 'url', now: 'https://elsewhere', was: 'https://here', overridden: false }, // never sent
  ]);
  assert.deepEqual(change.set, { name: 'Prod EU', via: '' });
  assert.deepEqual(change.reset, ['note', 'tags']);
  assert.ok(ov.movesDestination(change), 'the route moved');
  assert.ok(!ov.movesDestination(ov.overlayChange([{ key: 'name', now: 'x', was: 'y', overridden: false }])));
  assert.ok(!ov.changesSomething(ov.overlayChange([])));
});

test('a row with an overlay becomes a cluster with its fields, the client tag otherwise', () => {
  const base = { _id: 'zbx-es-prod', name: 'Prod EU', url: 'http://10.0.0.1:9200', zabbixHost: 'es-prod', zabbixHostId: '101',
                 client: 'acme', credential: 'elasticpro-own', credentialOk: true, zabbixGroups: [] };
  const edited = { ...base, tags: ['eu'], note: 'team A', liveRetention: '30d', backupCapacity: '2TB', volumeWindowDays: 14, tls: 'system',
                   enabled: true, overridden: ['name', 'tags', 'note'], zabbixValues: { name: 'es-prod', via: null, tags: ['acme'] },
                   ownCredential: true, overriddenBy: 'otto' };
  const c = cfg.mergeZabbixClusters(cfg.normalize({ clusters: [] }), [edited]).clusters[0];
  assert.deepEqual(c.tags, ['zabbix', 'eu']);
  assert.equal(c.note, 'team A');
  assert.equal(c.liveRetention, '30d');
  assert.equal(c.backupCapacity, '2TB');
  assert.equal(c.volumeWindowDays, 14);
  assert.equal(c.tls, 'system');
  assert.equal(c.url, 'http://10.0.0.1:9200', 'the address is Zabbix\'s');
  assert.deepEqual(c.zabbix.overridden, ['name', 'tags', 'note']);
  assert.equal(c.zabbix.values.name, 'es-prod');
  assert.equal(c.zabbix.ownCredential, true);
  // A core from before overlays: no tags in the row — the client is the tag, as always.
  const old = cfg.mergeZabbixClusters(cfg.normalize({ clusters: [] }), [base]).clusters[0];
  assert.deepEqual(old.tags, ['zabbix', 'acme']);
  assert.deepEqual(old.zabbix.overridden, []);
});

test('a Zabbix cluster switched off in ElasticPro is listed disabled, not held back, and is no drift', () => {
  const off = { _id: 'zbx-a', name: 'a', url: 'http://10.0.0.2:9200', zabbixHost: 'a', zabbixHostId: '2',
                credential: 'password-not-set', credentialOk: false, enabled: false, zabbixGroups: [] };
  const c = cfg.mergeZabbixClusters(cfg.normalize({ clusters: [] }), [off]);
  assert.equal(c.clusters.length, 1);
  assert.equal(c.clusters[0].enabled, false);
  assert.deepEqual(c.zabbixPending, []);
  assert.equal(cfg.zabbixDrift([], c), '', 'not polled on purpose: the core not holding it is no difference');
});

test('how Zabbix\'s credential is named', () => {
  assert.equal(ov.zabbixCredentialLabel('vault'), 'from Vault');
  assert.match(ov.zabbixCredentialLabel('password-not-set'), /not set/);
  assert.equal(ov.zabbixCredentialLabel('something-new'), 'as set on the Zabbix host');
});
