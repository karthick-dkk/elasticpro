/**
 * Announcing a snapshot that finished.
 *
 * Creating a snapshot returns as soon as the cluster accepts it; the copy happens
 * afterwards and can take minutes. The failure this guards against is the quiet one —
 * a snapshot that came back PARTIAL while you were on another page, which reads as
 * "there is a snapshot" until the day you try to restore from it.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');

// notify.js pulls in state.js, which wants a browser. None of that is reached by the
// function under test, but the import has to resolve.
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const { announceSnapshotOutcomes, resetSnapshotMemory } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/notify.js')).href);

const said = [];
const notify = (msg, kind, ms) => said.push({ msg, kind, ms });
const cluster = { id: 'c1', name: 'vm-1' };
const pass = (snapshots) => announceSnapshotOutcomes([{ cluster, snapshots }], { notify });

beforeEach(() => { said.length = 0; resetSnapshotMemory(); });

test('the first pass announces nothing', () => {
  // A snapshot that finished last night is a state, not news. Announcing everything on
  // start-up is how a notifier teaches people to dismiss it unread.
  const out = pass([{ repo: 'daily', id: 'snap-1', status: 'SUCCESS' },
                    { repo: 'daily', id: 'snap-2', status: 'FAILED' }]);
  assert.deepEqual(out, []);
  assert.equal(said.length, 0);
});

test('a snapshot that finishes is announced once', () => {
  pass([{ repo: 'daily', id: 'snap-1', status: 'IN_PROGRESS' }]);
  const out = pass([{ repo: 'daily', id: 'snap-1', status: 'SUCCESS' }]);
  assert.equal(out.length, 1);
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'ok');
  assert.match(said[0].msg, /finished/);
  assert.match(said[0].msg, /snap-1 in daily on vm-1/);

  // And not again on the next refresh, where it is still SUCCESS.
  pass([{ repo: 'daily', id: 'snap-1', status: 'SUCCESS' }]);
  assert.equal(said.length, 1, 'the same outcome was announced twice');
});

test('PARTIAL is reported as the problem it is', () => {
  // The one people misread as success. It is a snapshot with shards missing.
  pass([{ repo: 'daily', id: 's', status: 'IN_PROGRESS' }]);
  pass([{ repo: 'daily', id: 's', status: 'PARTIAL' }]);
  assert.equal(said.length, 1);
  assert.equal(said[0].kind, 'err', 'PARTIAL must not be announced as a success');
  assert.match(said[0].msg, /PARTIAL/);
  assert.match(said[0].msg, /shards/);
});

test('a failure is announced as a failure', () => {
  pass([{ repo: 'daily', id: 's', status: 'IN_PROGRESS' }]);
  pass([{ repo: 'daily', id: 's', status: 'FAILED' }]);
  assert.equal(said[0].kind, 'err');
  assert.match(said[0].msg, /FAILED/);
});

test('a snapshot still running says nothing', () => {
  pass([{ repo: 'daily', id: 's', status: 'IN_PROGRESS' }]);
  pass([{ repo: 'daily', id: 's', status: 'IN_PROGRESS' }]);
  assert.equal(said.length, 0);
});

test('a snapshot that was never seen running is not announced', () => {
  // It appeared already finished — taken by SLM overnight, or by somebody else. There is
  // no transition to report, and reporting it would announce history on every restart.
  pass([{ repo: 'daily', id: 'old', status: 'SUCCESS' }]);
  pass([{ repo: 'daily', id: 'old', status: 'SUCCESS' },
        { repo: 'daily', id: 'new', status: 'SUCCESS' }]);
  assert.equal(said.length, 0);
});

test('STARTED counts as running, the way Elasticsearch uses it', () => {
  pass([{ repo: 'daily', id: 's', status: 'STARTED' }]);
  pass([{ repo: 'daily', id: 's', status: 'SUCCESS' }]);
  assert.equal(said.length, 1);
});

test('snapshots are tracked per repository and per cluster', () => {
  // The same snapshot name in two repositories is two snapshots. Keying on the name
  // alone would let one finishing silence the other.
  pass([{ repo: 'daily', id: 'nightly', status: 'IN_PROGRESS' },
        { repo: 'weekly', id: 'nightly', status: 'IN_PROGRESS' }]);
  pass([{ repo: 'daily', id: 'nightly', status: 'SUCCESS' },
        { repo: 'weekly', id: 'nightly', status: 'IN_PROGRESS' }]);
  assert.equal(said.length, 1);
  assert.match(said[0].msg, /in daily/);

  pass([{ repo: 'daily', id: 'nightly', status: 'SUCCESS' },
        { repo: 'weekly', id: 'nightly', status: 'FAILED' }]);
  assert.equal(said.length, 2);
  assert.match(said[1].msg, /in weekly/);
});

test('several finishing at once are each announced', () => {
  pass([{ repo: 'r', id: 'a', status: 'IN_PROGRESS' }, { repo: 'r', id: 'b', status: 'IN_PROGRESS' }]);
  pass([{ repo: 'r', id: 'a', status: 'SUCCESS' }, { repo: 'r', id: 'b', status: 'FAILED' }]);
  assert.equal(said.length, 2);
  assert.equal(said.filter((x) => x.kind === 'ok').length, 1);
  assert.equal(said.filter((x) => x.kind === 'err').length, 1);
});

test('a snapshot that disappears is not an outcome', () => {
  // Deleted while running, or aged out of the listing. There is nothing true to say
  // about how it ended.
  pass([{ repo: 'r', id: 'gone', status: 'IN_PROGRESS' }]);
  pass([]);
  assert.equal(said.length, 0);
});

test('failures are left on screen longer than successes', () => {
  pass([{ repo: 'r', id: 'a', status: 'IN_PROGRESS' }, { repo: 'r', id: 'b', status: 'IN_PROGRESS' }]);
  pass([{ repo: 'r', id: 'a', status: 'SUCCESS' }, { repo: 'r', id: 'b', status: 'FAILED' }]);
  const ok = said.find((x) => x.kind === 'ok');
  const err = said.find((x) => x.kind === 'err');
  assert.ok(err.ms > ok.ms, 'the one worth reading should not vanish first');
});
