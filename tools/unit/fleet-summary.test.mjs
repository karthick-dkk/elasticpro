/** The Clusters page's one summary box — core/fleet-summary.js: one bucket per cluster,
 *  alerts by level, recurring problems grouped. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { fleetSummary, nameList } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/fleet-summary.js')).href);

const row = (name, st) => ({ c: { id: name, name }, d: { st } });
const health = (d) => d.st;
const al = (title, level, cluster, family) => ({ title, level, cluster: cluster ? { name: cluster } : null, key: family ? `${cluster}:${family}` : undefined });

test('every cluster is in exactly one bucket; unknown is loading, never green', () => {
  const s = fleetSummary([row('a', 'green'), row('b', 'yellow'), row('c', 'red'), row('d', 'unreachable'), row('e', undefined)], health, []);
  assert.deepEqual([s.total, s.green, s.yellow, s.red, s.loading, s.unreachable.length], [5, 1, 1, 1, 1, 1]);
  assert.equal(s.green + s.yellow + s.red + s.loading + s.unreachable.length, s.total);
  assert.deepEqual(s.unreachable, ['d']); assert.deepEqual(s.redNames, ['c']);
  assert.equal(s.bad, true);
});

test('alerts by level, and the same problem on many clusters is one line with a count', () => {
  const alerts = [al('Disk 94%', 'critical', 'a'), al('Snapshots failed', 'warning', 'a'), al('Snapshots failed', 'warning', 'b'),
    al('Snapshots failed', 'warning', 'c'), al('Yellow health', 'warning', 'b')];
  const s = fleetSummary([row('a', 'green')], health, alerts);
  assert.deepEqual([s.alerts, s.critical, s.warning, s.problemKinds], [5, 1, 4, 3]);
  assert.deepEqual(s.problems.map((p) => [p.title, p.critical, p.clusters]),
    [['Disk 94%', true, 1], ['Snapshots failed', false, 3], ['Yellow health', false, 1]], 'critical first, then the most widespread');
});

test('problems group by rule, not by title (titles carry the cluster and the value)', () => {
  const alerts = [al('a disk 91.2%', 'warning', 'a', 'disk'), al('b disk 84.0%', 'warning', 'b', 'disk'), al('c disk 93.9%', 'critical', 'c', 'disk'),
    al('a health is YELLOW', 'warning', 'a', 'health')];
  const s = fleetSummary([row('a', 'green')], health, alerts);
  assert.equal(s.problemKinds, 2);
  assert.deepEqual(s.problems[0], { title: 'Disk usage above threshold', critical: true, clusters: 3, count: 3 });
});

test('a quiet fleet is not bad; names are listed in full when few', () => {
  const s = fleetSummary([row('a', 'green'), row('b', 'green')], health, []);
  assert.equal(s.bad, false); assert.deepEqual(s.problems, []);
  assert.equal(nameList(['a', 'b']), 'a, b');
  assert.equal(nameList(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 6), 'a, b, c, d, e, f, +2 more');
});

// Regression: ISSUE-002 — with no data read yet the Alerts page said "Every cluster is healthy"
// right under "Alerts current for 0 of 2 clusters". An empty alert list means healthy only for
// the clusters that were read. Found by /qa on 2026-10-14.
// Report: .gstack/qa-reports/run-20261014T120616Z/qa-report-192-168-64-13-2026-10-14.md
test('no alerts reads as healthy only for the clusters that were read', async () => {
  const { alertsEmptyState } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/fleet-summary.js')).href);
  const all = alertsEmptyState({ total: 3, read: 3 });
  assert.equal(all.healthy, true); assert.match(all.title, /Every cluster is healthy/);
  const none = alertsEmptyState({ total: 2, read: 0 });
  assert.equal(none.healthy, false); assert.match(none.title, /Nothing read yet/); assert.doesNotMatch(none.title + none.detail, /healthy/);
  const some = alertsEmptyState({ total: 5, read: 2 });
  assert.equal(some.healthy, false); assert.match(some.title, /No problem on the 2 clusters read/); assert.match(some.detail, /3 not read/);
  assert.match(alertsEmptyState({ total: 1, read: 1 }).detail, /1 cluster\b/);
});
