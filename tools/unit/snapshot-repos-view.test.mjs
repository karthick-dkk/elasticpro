/** The Snapshots page's first level: one overview row per repository, from the figures the list already carries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { repoOverview, openRepo, recoverableRange } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-evidence.js')).href);

const snap = (id, from, to, extra = {}) => ({ id, start: 1, coverFrom: from, coverTo: to, indexNames: [], ...extra });
const pols = [
  { id: 'daily', policy: { repository: 'a' } },
  { id: 'weekly', policy: { repository: 'b' } },
  { id: 'hourly', policy: { repository: 'a' } },
];

test('a repository row: count, newest, data span and the policies writing to it', () => {
  const o = repoOverview({ name: 'a' }, [snap('new', '2026-09-07', '2026-09-09'), snap('old', '2026-09-01', '2026-09-05')], pols);
  assert.equal(o.count, 2);
  assert.equal(o.newest.id, 'new');
  assert.equal(o.span.from, '2026-09-01');
  assert.equal(o.span.to, '2026-09-09');
  assert.equal(o.span.days, 9);
  assert.equal(o.span.unknown, false);
  assert.deepEqual(o.policies, ['daily', 'hourly']);
});

test('the span is the one recoverableRange gives', () => {
  const l = [snap('x', '2026-09-03', '2026-09-04')];
  const { from, to, days } = recoverableRange(l);
  const o = repoOverview({ name: 'a' }, l, []);
  assert.deepEqual([o.span.from, o.span.to, o.span.days], [from, to, days]);
});

test('unknown is not zero: an unread listing has no count, no newest', () => {
  const o = repoOverview({ name: 'a' }, null, pols);
  assert.equal(o.count, null);
  assert.equal(o.newest, null);
  assert.equal(o.span.unknown, false);
});

test('a read, empty repository is zero snapshots', () => {
  const o = repoOverview({ name: 'a' }, [], []);
  assert.equal(o.count, 0);
  assert.equal(o.newest, null);
});

test('rows from _cat name no indices: the span is flagged unknown', () => {
  const o = repoOverview({ name: 'a' }, [snap('c', null, null, { indexNames: null })], []);
  assert.equal(o.span.from, null);
  assert.equal(o.span.unknown, true);
});

test('openRepo keeps only a repository that is still registered', () => {
  const repos = [{ name: 'a' }, { name: 'b' }];
  assert.equal(openRepo('b', repos), 'b');
  assert.equal(openRepo('gone', repos), null);
  assert.equal(openRepo(null, repos), null);
  assert.equal(openRepo('a', undefined), null);
});
