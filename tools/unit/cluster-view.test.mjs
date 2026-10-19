/**
 * The Clusters page's layout rules, without a page: the one name order every cluster list
 * uses, the per-user column preferences, and the unreachable section's fold — including
 * the rule that a NEW outage opens it again however it was left.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { compareNames, sortByName } = await imp('ui/js/lib/cluster-order.js');
const V = await imp('ui/js/core/cluster-view.js');

const names = (list) => sortByName(list.map((name) => ({ name }))).map((c) => c.name);

/* ------------------------------- the name order ------------------------------- */

test('numbers inside a name are read as numbers', () => {
  assert.deepEqual(names(['es-node-10', 'es-node-2', 'es-node-1', 'es-node-21']),
    ['es-node-1', 'es-node-2', 'es-node-10', 'es-node-21']);
  assert.ok(compareNames('dc9-prod', 'dc10-prod') < 0);
});

test('capitals do not matter, and equal-but-for-case names still have one order', () => {
  assert.deepEqual(names(['beta', 'Alpha', 'alpha2', 'ALPHA1', 'Gamma']), ['Alpha', 'ALPHA1', 'alpha2', 'beta', 'Gamma']);
  // "Prod" and "prod" are the same to the collator; the order between them is still fixed.
  assert.equal(compareNames('Prod', 'prod'), -compareNames('prod', 'Prod'));
  assert.notEqual(compareNames('Prod', 'prod'), 0);
  assert.deepEqual(names(['prod', 'Prod']), names(['Prod', 'prod']));
});

test('accents sort with their letter, not after z', () => {
  assert.deepEqual(names(['zulu', 'écho', 'echo-2', 'delta']), ['delta', 'écho', 'echo-2', 'zulu']);
  assert.ok(compareNames('Ålesund', 'zeta') < 0);
});

test('missing names do not throw and go first', () => {
  assert.ok(compareNames(undefined, 'a') < 0);
  assert.equal(compareNames(null, undefined), 0);
});

/* ----------------------------------- columns ----------------------------------- */

const ids = (cols) => cols.map((c) => c.id);
const shownIds = (p) => ids(V.visibleColumns(p));
const DEFAULT_SHOWN = ['name', 'version', 'health', 'nodes', 'size', 'disk', 'ilm', 'slm', 'snapshot', 'alerts'];

test('the defaults: Cluster first, JDK, Repository and requests hidden', () => {
  const p = V.sanitizePrefs(null);
  assert.deepEqual(ids(V.resolveColumns(p)), V.SUMMARY_COLUMNS.map((c) => c.id));
  assert.deepEqual(shownIds(p), DEFAULT_SHOWN);
  assert.equal(V.resolveColumns(p)[0].id, 'name');
});

test('hide and show; the Cluster column cannot be hidden', () => {
  let p = V.setColumnShown(null, 'ilm', false);
  assert.ok(!shownIds(p).includes('ilm'));
  p = V.setColumnShown(p, 'jdk', true);
  assert.ok(shownIds(p).includes('jdk'));
  p = V.setColumnShown(p, 'name', false);
  assert.equal(shownIds(p)[0], 'name', 'Cluster is always shown');
  // Even a stored "hidden" for it is ignored.
  assert.equal(shownIds({ columns: { shown: { name: false } } })[0], 'name');
});

test('reorder by position and by one step; Cluster stays first', () => {
  let p = V.moveColumn(null, 'alerts', 0);
  assert.deepEqual(ids(V.resolveColumns(p)).slice(0, 3), ['name', 'alerts', 'version']);
  p = V.moveColumnBy(p, 'alerts', 1);
  assert.deepEqual(ids(V.resolveColumns(p)).slice(0, 3), ['name', 'version', 'alerts']);
  p = V.moveColumnBy(p, 'version', -5);
  assert.equal(ids(V.resolveColumns(p))[1], 'version', 'clamped at the top of the movable ones');
  p = V.moveColumn(p, 'name', 5);
  assert.equal(ids(V.resolveColumns(p))[0], 'name', 'the fixed column does not move');
  p = V.moveColumn(p, 'snapshot', 99);
  assert.equal(ids(V.resolveColumns(p)).at(-1), 'snapshot');
});

test('rename: trimmed, capped, empty or the default name means the default', () => {
  let p = V.renameColumn(null, 'snapshot', '  Last backup  ');
  let col = V.resolveColumns(p).find((c) => c.id === 'snapshot');
  assert.equal(col.name, 'Last backup'); assert.equal(col.renamed, true); assert.equal(col.label, 'Last snapshot');
  p = V.renameColumn(p, 'snapshot', '');
  col = V.resolveColumns(p).find((c) => c.id === 'snapshot');
  assert.equal(col.name, 'Last snapshot'); assert.equal(col.renamed, false);
  p = V.renameColumn(p, 'disk', 'Disk usage');
  assert.equal(p.columns.names.disk, undefined, 'the default name typed back is not stored');
  p = V.renameColumn(p, 'disk', 'x'.repeat(100));
  assert.equal(V.resolveColumns(p).find((c) => c.id === 'disk').name.length, V.MAX_NAME);
  p = V.renameColumn(p, 'name', 'Where');
  assert.equal(V.resolveColumns(p)[0].name, 'Where', 'Cluster can be renamed, only not hidden');
});

test('reset brings back the default columns, order and names, and keeps the fold', () => {
  let p = V.hideUnreachable(null, ['a']);
  p = V.renameColumn(V.moveColumn(V.setColumnShown(p, 'jdk', true), 'alerts', 0), 'ilm', 'Lifecycle');
  p = V.resetColumns(p);
  assert.deepEqual(ids(V.resolveColumns(p)), V.SUMMARY_COLUMNS.map((c) => c.id));
  assert.deepEqual(shownIds(p), DEFAULT_SHOWN);
  assert.equal(V.resolveColumns(p).find((c) => c.id === 'ilm').name, 'ILM');
  assert.equal(p.unreachable.hidden, true);
});

test('stored ids this version does not know are ignored; columns it added appear in place', () => {
  const stored = { columns: { order: ['gone', 'alerts', 'version', 'nope', 'health'], shown: { gone: true, version: false }, names: { gone: 'X', alerts: 'Open' } } };
  const cols = V.resolveColumns(stored);
  assert.ok(!ids(cols).includes('gone') && !ids(cols).includes('nope'));
  // The stored ones keep their stored order; the ones it never named follow their default
  // neighbour (JDK after Version, the request count after Alerts).
  const at0 = ids(cols);
  assert.deepEqual(at0.filter((id) => ['alerts', 'version', 'health'].includes(id)), ['alerts', 'version', 'health']);
  assert.equal(at0[0], 'name');
  assert.equal(at0[at0.indexOf('version') + 1], 'jdk');
  assert.equal(at0[at0.indexOf('alerts') + 1], 'reqs');
  // Every column of this version is there exactly once.
  assert.deepEqual([...ids(cols)].sort(), V.SUMMARY_COLUMNS.map((c) => c.id).sort());
  assert.equal(cols.find((c) => c.id === 'alerts').name, 'Open');
  assert.equal(cols.find((c) => c.id === 'version').visible, false);

  // A newer version's column, unheard of by the stored order, lands after its default
  // neighbour, with its default visibility.
  const defs = [...V.SUMMARY_COLUMNS.slice(0, 2), { id: 'uptime', label: 'Uptime' }, ...V.SUMMARY_COLUMNS.slice(2)];
  const withNew = V.resolveColumns({ columns: { order: ['health', 'version', 'alerts'] } }, defs);
  const at = ids(withNew);
  assert.equal(at[at.indexOf('version') + 1], 'uptime');
  assert.equal(withNew.find((c) => c.id === 'uptime').visible, true);
});

test('garbage in storage gives the defaults, never a throw', () => {
  for (const raw of [null, 7, 'x', [], { columns: 'no' }, { columns: { order: 'a', shown: [1], names: { a: 5 } } }]) {
    assert.deepEqual(shownIds(raw), DEFAULT_SHOWN);
  }
  const bad = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
  assert.deepEqual(shownIds(V.readPrefs(bad, 'ann')), DEFAULT_SHOWN);
  assert.equal(V.writePrefs(bad, 'ann', V.sanitizePrefs(null)), false);
  assert.equal(V.writePrefs(null, 'ann', V.sanitizePrefs(null)), false);
  const throwing = { getItem: () => { throw new Error('denied'); } };
  assert.deepEqual(shownIds(V.readPrefs(throwing, 'ann')), DEFAULT_SHOWN);
});

test('saved per user, case-insensitively, and read back', () => {
  const m = new Map();
  const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
  assert.equal(V.writePrefs(st, 'Ann', V.setColumnShown(null, 'jdk', true)), true);
  assert.ok(shownIds(V.readPrefs(st, 'ann')).includes('jdk'));
  assert.ok(!shownIds(V.readPrefs(st, 'bob')).includes('jdk'), 'another user has their own');
  assert.ok(!shownIds(V.readPrefs(st, null)).includes('jdk'), 'the portable build has its own');
  assert.equal(V.prefsKey('Ann'), 'elasticpro.clusters.view.ann');
  // Nothing but layout is in it.
  assert.deepEqual(Object.keys(JSON.parse(m.get('elasticpro.clusters.view.ann'))).sort(), ['columns', 'unreachable', 'v']);
});

/* ------------------------------ the unreachable fold ------------------------------ */

test('hide, show, and the fold read back', () => {
  let p = V.hideUnreachable(null, ['a', 'b', 'a']);
  assert.deepEqual(p.unreachable, { hidden: true, seen: ['a', 'b'] });
  p = V.showUnreachable(p);
  assert.deepEqual(p.unreachable, { hidden: false, seen: [] });
  assert.deepEqual(V.sanitizePrefs({ unreachable: { hidden: false, seen: ['a'] } }).unreachable, { hidden: false, seen: [] });
});

test('three down going to two keeps it hidden', () => {
  const fold = V.hideUnreachable(null, ['a', 'b', 'c']).unreachable;
  const f = V.foldUnreachable(fold, ['a', 'b'], ['c', 'x']);
  assert.equal(f.hidden, true);
  assert.deepEqual(f.seen, ['a', 'b'], 'the one that came back is forgotten');
  assert.equal(f.changed, true);
  const same = V.foldUnreachable({ hidden: true, seen: f.seen }, ['a', 'b'], ['c']);
  assert.equal(same.hidden, true); assert.equal(same.changed, false);
});

test('a cluster newly down opens it again', () => {
  const fold = V.hideUnreachable(null, ['a', 'b']).unreachable;
  const f = V.foldUnreachable(fold, ['a', 'b', 'd'], []);
  assert.deepEqual([f.hidden, f.reopened, f.changed], [false, true, true]);
});

test('one that recovered and fails again is a new outage', () => {
  let fold = V.hideUnreachable(null, ['a', 'b']).unreachable;
  let f = V.foldUnreachable(fold, ['a'], ['b']);          // b answers again
  fold = { hidden: f.hidden, seen: f.seen };
  f = V.foldUnreachable(fold, ['a', 'b'], []);            // and goes down again
  assert.equal(f.hidden, false);
});

test('not read yet is neither up nor down: a reload keeps it hidden', () => {
  const fold = V.hideUnreachable(null, ['a', 'b']).unreachable;
  // Straight after a reload nothing has answered: nobody down, nobody known to be up.
  let f = V.foldUnreachable(fold, [], []);
  assert.deepEqual([f.hidden, f.seen], [true, ['a', 'b']]);
  // Then the first answers arrive and say the same two are still down.
  f = V.foldUnreachable({ hidden: true, seen: f.seen }, ['a', 'b'], ['c']);
  assert.equal(f.hidden, true);
});

test('an open section stays open', () => {
  assert.deepEqual(V.foldUnreachable({ hidden: false }, ['a'], []), { hidden: false, seen: [], changed: false, reopened: false });
  assert.equal(V.foldUnreachable(undefined, ['a'], []).hidden, false);
});
