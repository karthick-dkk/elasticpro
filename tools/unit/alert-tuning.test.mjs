/**
 * Alert tuning — core/alert-tuning.js. One row per problem, hysteresis on disk, a stale
 * reading says its age, and "open" means neither acknowledged nor silenced, everywhere.
 *
 * Regression: a live 32-cluster fleet showed "88 open alerts", most of them one fault raised
 * by two or three rules; the Clusters banner and nav badge counted acknowledged alerts as
 * open; a disk at 79.9–80.0% opened and closed an alert every refresh. Reported 2026-10-14.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const T = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/alert-tuning.js')).href);
const c = { id: 'p1', name: 'prod-1' };
const A = (family, level, extra = {}) => ({ key: `p1:${family}${extra.suffix || ''}`, level, cluster: c, title: `prod-1 ${family}`, detail: 'd', ...extra });
const fams = (list) => list.map((a) => a.key.split(':').slice(1).join(':')).sort();

test('disk hysteresis: raised at the threshold, cleared two points below it', () => {
  const L = { warning: 85, high: 90, critical: 95 };
  assert.equal(T.diskLevel(84.9, null, L), null);
  assert.equal(T.diskLevel(85.0, null, L), 'warning');
  assert.equal(T.diskLevel(84.9, 'warning', L), 'warning', 'no flap at 84.9 once raised');
  assert.equal(T.diskLevel(83.1, 'warning', L), 'warning');
  assert.equal(T.diskLevel(82.9, 'warning', L), null, 'clears below 83');
  assert.equal(T.diskLevel(90, 'warning', L), 'high');
  assert.equal(T.diskLevel(88.5, 'high', L), 'high', 'held high down to 88');
  assert.equal(T.diskLevel(87.9, 'high', L), 'warning');
  assert.equal(T.diskLevel(95, 'high', L), 'critical');
  assert.equal(T.diskLevel(93.5, 'critical', L), 'critical', 'held critical down to 93');
  assert.equal(T.diskLevel(92.9, 'critical', L), 'high');
  assert.equal(T.diskLevel(NaN, 'critical', L), null, 'unknown is not a level');
});

test('a node at the flood stage is one row: the cluster average is folded into it', () => {
  const out = T.tuneAlerts([A('disk', 'warning', { diskPercent: 91, diskAverage: 84.2 }), A('disk-balance', 'critical', { balanceCauses: ['flood'] }), A('health', 'warning')]);
  assert.deepEqual(fams(out), ['disk-balance', 'health']);
  const bal = out.find((a) => a.key === 'p1:disk-balance');
  assert.equal(bal.level, 'critical'); assert.match(bal.detail, /Cluster average 84\.2%/);
});

test('a spread-only balance warning does not swallow the disk row', () => {
  assert.deepEqual(fams(T.tuneAlerts([A('disk', 'warning', { diskPercent: 81 }), A('disk-balance', 'warning', { balanceCauses: ['spread'] })])), ['disk', 'disk-balance']);
});

test('unassigned shards are said once, by the health row', () => {
  assert.deepEqual(fams(T.tuneAlerts([A('health', 'warning'), A('disk-balance', 'warning', { balanceCauses: ['unassigned'] })])), ['health']);
  // …but not when the balance rule has something of its own to say
  assert.deepEqual(fams(T.tuneAlerts([A('health', 'warning'), A('disk-balance', 'warning', { balanceCauses: ['unassigned', 'high'] })])), ['disk-balance', 'health']);
});

test('a failing repository is raised once, not again per SLM policy; SLM stopped explains "no recent success"', () => {
  const out = T.tuneAlerts([A('repo', 'critical', { suffix: ':nightly:failing', repo: 'nightly' }), A('slm-fail', 'critical', { suffix: ':nightly-snap', repo: 'nightly' }),
    A('slm-fail', 'critical', { suffix: ':other-snap', repo: 'other' })]);
  assert.deepEqual(fams(out), ['repo:nightly:failing', 'slm-fail:other-snap'], 'the other repository\'s policy is a different problem');
  assert.deepEqual(fams(T.tuneAlerts([A('slm-mode', 'warning'), A('slm-stale', 'warning', { suffix: ':p', repo: 'r' })])), ['slm-mode']);
});

test('many field-volume spikes on one cluster are one row with the count', () => {
  const out = T.tuneAlerts([1, 2, 3, 4].map((i) => A('volume', 'warning', { suffix: `:f:t${i}`, title: `prod-1: f "t${i}" volume up 50%` })));
  assert.equal(out.length, 1); assert.equal(out[0].grouped, 4); assert.match(out[0].title, /4 field-volume spikes/); assert.match(out[0].detail, /\+1 more/);
});

test('a reading older than its dataset allows keeps its level and says how old it is', () => {
  const out = T.tuneAlerts([A('disk', 'critical', { diskPercent: 95 }), A('health', 'warning')], {
    ageOf: (id, ds) => (ds === 'nodes' ? { ageMs: 3 * 3600e3, staleAfterMs: 600e3 } : { ageMs: 60e3, staleAfterMs: 360e3 }), ago: () => '3 h' });
  const disk = out.find((a) => a.key === 'p1:disk');
  assert.equal(disk.level, 'critical', 'a disk at 95% three hours ago is not fine now');
  assert.equal(disk.stale, true); assert.match(disk.detail, /Read 3 h ago/);
  assert.ok(!out.find((a) => a.key === 'p1:health').stale);
});

test('open = neither acknowledged nor silenced; counts by level from one place', () => {
  const list = [A('disk', 'critical'), A('health', 'warning'), A('ilm', 'warning')];
  const open = T.openAlerts(list, { isAcked: (k) => k === 'p1:health', isSilenced: (a) => a.key === 'p1:ilm' });
  assert.deepEqual(open.map((a) => a.key), ['p1:disk']);
  assert.deepEqual(T.alertCounts(list), { total: 3, critical: 1, high: 0, warning: 2 });
});
