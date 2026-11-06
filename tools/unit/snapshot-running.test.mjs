/**
 * The Snapshots dot — core/snapshot-running.js: green while a known running snapshot is on
 * the selection, nothing when the core does not know (never "none" for "unknown"), and the
 * dataset the core adds is named the same on both sides.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-running.js')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/policy.js')).href);

const reply = {
  ok: true, now: 1_762_300_600_000, intervalSec: 300, effectiveClass: 'background',
  clusters: {
    a: { known: true, why: null, fetchedAt: 1, staleAfterMs: 600000, running: [{ repository: 'backups', snapshot: 'daily', state: 'STARTED', started: 1_762_300_000_000 }] },
    b: { known: true, why: null, fetchedAt: 1, staleAfterMs: 600000, running: [] },
    c: { known: false, why: 'not fetched yet', fetchedAt: null, staleAfterMs: 600000, running: [] },
  },
  running: [{ cluster: 'a', repository: 'backups', snapshot: 'daily', state: 'STARTED', started: 1_762_300_000_000 }],
  unknown: ['c'],
};

test('running on the chosen cluster, none on another, unknown where the core does not know', () => {
  assert.equal(S.snapshotRunning(reply, 'a').state, 'running');
  assert.equal(S.snapshotRunning(reply, 'b').state, 'none');
  const c = S.snapshotRunning(reply, 'c');
  assert.equal(c.state, 'unknown');
  assert.deepEqual(c.unknown, ['c']);
  assert.equal(c.why.c, 'not fetched yet');
  // All: running wins; without the running one, one unknown cluster makes the whole unknown.
  assert.equal(S.snapshotRunning(reply, 'all').state, 'running');
  assert.equal(S.snapshotRunning(reply, ['b', 'c']).state, 'unknown');
  assert.equal(S.snapshotRunning(reply, ['b']).state, 'none');
  assert.equal(S.snapshotRunning(reply, 'zzz').state, 'unknown', 'a cluster not in the answer is not known');
});

test('the dot is green only while something runs, and names it', () => {
  const dot = S.snapshotDot(reply, 'all', { names: { a: 'client-a' }, now: reply.now });
  assert.equal(dot.tone, 'green');
  assert.equal(dot.count, 1);
  assert.match(dot.title, /^A snapshot is running: backups\/daily on client-a \(since /);
  assert.equal(S.snapshotDot(reply, 'b'), null);
  assert.equal(S.snapshotDot(reply, 'c'), null, 'unknown draws nothing — not a guess');
  assert.equal(S.snapshotDot(null, 'all'), null);
  assert.equal(S.snapshotDot({ ok: false, kind: 'forbidden' }, 'all'), null);
  const many = { ...reply, running: Array.from({ length: 6 }, (_, i) => ({ cluster: 'a', repository: 'r', snapshot: `s${i}`, started: 1 })) };
  const d = S.snapshotDot(many, 'a', { now: 2 });
  assert.equal(d.count, 6);
  assert.match(d.title, /6 snapshots are running: .*\(\+2 more\)$/);
});

test('the note says what is not known and, under an on-demand policy, why', () => {
  assert.equal(S.snapshotNote(reply, 'b'), 'No snapshot is running.');
  assert.equal(S.snapshotNote(reply, 'a'), '1 running');
  assert.equal(S.snapshotNote(reply, 'c'), 'Whether a snapshot is running is not known on c (not fetched yet).');
  const onDemand = { ...reply, effectiveClass: 'onDemand' };
  assert.match(S.snapshotNote(onDemand, ['b', 'c']), /not known on c \(not fetched yet\)\. Under this request policy it is read only while the Snapshots page is open\.$/);
  assert.equal(S.snapshotNote(null, 'all'), null, 'an older core offers no reading');
});

test('the dataset exists on both sides under one name, in the background class', () => {
  assert.equal(P.DATASET_LABELS.snapshot_status, 'Snapshots (running now)');
  assert.equal(P.FALLBACK_DEFAULTS.intervalsSec.snapshot_status, 300);
  assert.ok(!P.ON_DEMAND_ALWAYS.includes('snapshot_status'), 'polled for every cluster under Background, so the dot works on every page');
  const cat = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/fleet/catalogue.rs'), 'utf8');
  assert.match(cat, /Dataset::SnapshotStatus => "snapshot_status"/);
  assert.match(cat, /Dataset::SnapshotStatus => 300,/);
  const st = fs.readFileSync(path.join(ROOT, 'ui/js/core/state.js'), 'utf8');
  assert.match(st, /snapshot_status: \['status'\]/, 'FLEET_KEYS names the one request');
  assert.match(st, /if \(module === 'snapshots'\) return \['policies', 'snapshots', 'snapshot_status'/, 'the Snapshots page watches it');
  // A plain refresh leaves it out unless the policy polls it on its own — both sides say so.
  assert.match(st, /export const POLICY_ONLY = new Set\(\['snapshot_status'\]\)/);
  assert.match(st, /entry\.effectiveClass === 'background'/, 'backgroundNames() keeps it only under Background');
  const mod = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/fleet/mod.rs'), 'utf8');
  assert.match(mod, /\*d != Dataset::SnapshotStatus \|\| cfg\.effective_class\(\*d, known\) == Class::Background/, 'refresh_msg agrees');
});
