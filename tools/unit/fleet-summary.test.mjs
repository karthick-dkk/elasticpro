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
