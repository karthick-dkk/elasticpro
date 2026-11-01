/**
 * Config › Play: the pure helpers. The payloads the page sends are built here, so what a
 * locked field, an empty reason or a bad address does is settled without a DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/play-config.js')).href);

test('a link is permanent and for every cluster unless said otherwise', () => {
  assert.deepEqual(P.linkPayload({ name: ' NOC wall ' }).payload, { name: 'NOC wall', clusters: 'all', expires: 'permanent' });
});

test('a link needs a name, a group or clusters when it says so, and valid addresses', () => {
  assert.match(P.linkPayload({ name: '' }).problem, /name/);
  assert.match(P.linkPayload({ name: 'a', scope: 'group' }).problem, /host group/);
  assert.match(P.linkPayload({ name: 'a', scope: 'chosen' }).problem, /cluster/);
  assert.match(P.linkPayload({ name: 'a', allowFrom: '10.0.0.0/33' }).problem, /10\.0\.0\.0\/33/);
  assert.match(P.linkPayload({ name: 'a', allowFrom: 'not-an-ip' }).problem, /not-an-ip/);
});

test('scope, addresses and expiry reach the payload', () => {
  const p = P.linkPayload({ name: 'a', scope: 'group', group: 'Prod', allowFrom: '10.1.0.0/16, fd00::/8 192.168.1.5', expires: '90' }).payload;
  assert.deepEqual(p, { name: 'a', clusters: { group: 'Prod' }, expires: 90, allowFrom: ['10.1.0.0/16', 'fd00::/8', '192.168.1.5'] });
  assert.deepEqual(P.linkPayload({ name: 'a', scope: 'chosen', chosen: ['c1', 'c2'] }).payload.clusters, ['c1', 'c2']);
});

test('scope and slide counts in words', () => {
  assert.equal(P.scopeText('all'), 'All');
  assert.equal(P.scopeText({ group: 'Prod' }), 'Host group Prod');
  assert.equal(P.scopeText(['x'], (id) => id.toUpperCase()), 'X');
  assert.equal(P.scopeText(['x', 'y']), '2 chosen');
  assert.equal(P.slidesText(undefined), '6 of 6');
  assert.equal(P.slidesText({ slides: [{ id: 'fleet', show: false }] }), '5 of 6');
});

test('display settings: defaults, order kept, unknown ids dropped, missing slides appended', () => {
  const d = P.displaySettings({ slides: [{ id: 'backups', show: false, dwellSec: 30 }, { id: 'nope' }, 'fleet'] });
  assert.deepEqual(d.slides.map((s) => s.id), ['backups', 'fleet', 'alerts', 'spotlight', 'delay', 'volume']);
  assert.equal(d.slides[0].show, false);
  assert.equal(d.slides[0].dwellSec, 30);
  assert.equal(d.slides[1].dwellSec, 20);
  assert.deepEqual([d.criticalTakesScreen, d.spotlightAll, d.theme, d.sound, d.zoom], [true, false, 'dark', 'off', null]);
  assert.equal(P.displaySettings({ zoom: 1.25, theme: 'light', sound: 'chime', criticalTakesScreen: false }).zoom, 1.25);
  assert.equal(P.displaySettings({ zoom: 3 }).zoom, null);
});

test('moveSlide swaps neighbours and stops at the ends', () => {
  const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(P.moveSlide(a, 1, -1).map((x) => x.id), [2, 1, 3]);
  assert.deepEqual(P.moveSlide(a, 2, 1).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(P.moveSlide(a, 0, -1).map((x) => x.id), [1, 2, 3]);
  assert.deepEqual(a.map((x) => x.id), [1, 2, 3]);
});

test('watch rules carry the documented defaults', () => {
  const w = P.watchRules(undefined);
  assert.deepEqual([w.delayYellowFromMin, w.delayRedAboveMin, w.nodeExpected, w.nodeBlink, w.nodeCheckSec], [30, 60, 'seen24h', 'untilBack', 60]);
  assert.deepEqual(w.spotlight.when, ['red', 'nodeLeft', 'slmFailed', 'storage', 'unreachable', 'criticalAlert']);
  assert.deepEqual([w.spotlight.perClusterSec, w.spotlight.leaveAfterMin, w.spotlight.whenEmpty], [13, 10, 'skip']);
  assert.equal(P.watchRules({ delayRedAboveMin: 90 }).delayRedAboveMin, 90);
});

test('watch problems', () => {
  const w = P.watchRules();
  assert.deepEqual(P.watchProblems(w), []);
  assert.match(P.watchProblems({ ...w, delayRedAboveMin: 30 })[0], /Red delay/);
  assert.match(P.watchProblems({ ...w, nodeCheckSec: 2 })[0], /10 seconds/);
});

test('which fields config.txt locks, and that the save leaves them out', () => {
  // The core's PLAY_CONFIG_GET: `managed` names the keys, `managedFields` maps each locked field to its key.
  const locked = P.lockedFields({ managed: ['UI_PLAY_DELAY_RED_MIN', 'UI_PLAY_SPOTLIGHT_WHEN', 'UI_PLAY_EXCLUDE'],
    managedFields: { 'watch.delayRedAboveMin': 'UI_PLAY_DELAY_RED_MIN', 'watch.spotlight.when': 'UI_PLAY_SPOTLIGHT_WHEN' } });
  assert.deepEqual([...locked].sort(), ['delayRedAboveMin', 'spotlight.when']);
  assert.equal(P.lockedFields({ managed: ['UI_PLAY_DELAY_RED_MIN'] }).size, 0, 'the field map is the core\'s managedFields, not a copy kept here');
  const out = P.watchPayload(P.watchRules(), locked);
  assert.equal('delayRedAboveMin' in out, false);
  assert.equal('when' in out.spotlight, false);
  assert.equal(out.delayYellowFromMin, 30);
  assert.equal(out.spotlight.perClusterSec, 13);
  assert.equal(out.spotlight.whenEmpty, 'skip');
  assert.equal(P.lockedFields(null).size, 0);
});

test('a link made again keeps its name, clusters, addresses, settings and the expiry it has left', () => {
  const now = 1_800_000_000_000;
  const p = P.replacePayload({ id: 'x', name: 'NOC', clusters: { group: 'Prod' }, allowFrom: ['10.0.0.0/8'], expires: { at: now + 2.5 * 86400000 },
    expiresAt: now + 2.5 * 86400000, settings: { slides: [{ id: 'alerts', show: true, dwellSec: 30 }], theme: 'light', sound: 'chime', zoom: 1.25 } }, now);
  assert.equal(p.name, 'NOC');
  assert.deepEqual(p.clusters, { group: 'Prod' });
  assert.deepEqual(p.allowFrom, ['10.0.0.0/8']);
  assert.equal(p.expires, 3);
  assert.equal(p.settings.slides[0].id, 'alerts');
  assert.equal(p.settings.slides[0].dwellSec, 30);
  assert.equal(p.settings.theme, 'light');
  assert.equal(p.settings.zoom, 1.25);
  const perm = P.replacePayload({ name: 'TV', clusters: 'all', allowFrom: [], expires: 'permanent', expiresAt: null, settings: {} }, now);
  assert.equal(perm.expires, 'permanent');
  assert.equal('allowFrom' in perm, false);
  assert.equal(P.replacePayload({ name: 'old', expiresAt: now - 1000 }, now).expires, 1, 'never zero days');
});

test('excluding needs a cluster and a reason', () => {
  assert.match(P.excludeAdd('', 'x').problem, /cluster/);
  assert.match(P.excludeAdd('c1', '   ').problem, /reason/);
  assert.deepEqual(P.excludeAdd('c1', ' decommissioning ').exclude, { add: { clusterId: 'c1', reason: 'decommissioning' } });
});
