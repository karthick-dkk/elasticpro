/**
 * What a snapshot can give back, measured on a known cluster (0.3.89): SUCCESS snapshots of
 * days 15, 18, 19 and 21, a PARTIAL one (20 failed, 22 ok) and one still running. The page said
 * "2026-11-15 → 2026-11-22" with no gaps, and "→ 2026-11-24" for the running one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
globalThis.indexedDB = undefined;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, append() {} }), body: { append() {} } };
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const R = await at('ui/js/core/snapshot-restorable.js');
const S = await at('ui/js/core/state.js');
const E = await at('ui/js/core/snapshot-evidence.js');
const L = await at('ui/js/core/snapshot-list.js');
const V = await at('ui/js/core/volume.js');
const C = await at('ui/js/core/snapshot-verify.js');

const day = (d) => `logstash-2026.11.${d}`;
const T = Date.UTC(2026, 10, 24);
const es = (snapshot, state, days, failures = [], n = 0) => ({ snapshot, state, indices: days.map(day),
  start_time_in_millis: T - n * 86400000, end_time_in_millis: T - n * 86400000 + 1000, duration_in_millis: 1000,
  shards: { total: days.length, successful: days.length - failures.length, failed: failures.length }, failures });
const BODY = { snapshots: [
  es('run', 'IN_PROGRESS', [16, 24], [], 0),
  es('part', 'PARTIAL', [20, 22], [{ index: day(20), shard_id: 0, reason: 'lost' }], 1),
  es('dead', 'FAILED', [17], [{ index: day(17), shard_id: 0 }], 2),
  es('good', 'SUCCESS', [15, 18, 19, 21], [], 3),
] };
const rows = () => S.snapshotRowsVerbose(BODY);
const byId = (id) => rows().find((r) => r.id === id);

test('restorableIndices: whole, minus the failed ones, none, or unknown', () => {
  assert.deepEqual(R.restorableIndices(byId('good')), [15, 18, 19, 21].map(day));
  assert.deepEqual(R.restorableIndices(byId('part')), [day(22)]);
  assert.deepEqual(R.restorableIndices(byId('dead')), []);
  assert.deepEqual(R.restorableIndices(byId('run')), []);
  assert.deepEqual(R.restorableIndices({ status: 'INCOMPATIBLE', indexNames: ['a'] }), []);
  // Unknown is not none: the failures were not read, or fewer are listed than failed.
  assert.equal(R.restorableIndices({ status: 'PARTIAL', failed: 1, failedIndices: null, indexNames: ['a'] }), null);
  assert.equal(R.restorableIndices({ status: 'SUCCESS', indexNames: null }), null);
  assert.equal(R.restorableIndices({ status: 'SUCCESS', failed: 1, indexNames: ['a'] }), null);
  assert.equal(R.failedIndexNames([{ index: 'a' }], 3), null);
  assert.equal(R.failedIndexNames([{ shard_id: 1 }], 1), null);
  assert.deepEqual(R.failedIndexNames(undefined, 0), []);
  assert.equal(R.failedIndexNames(undefined, 2), null);
});

test('the repository span counts only what can be restored, and says the gaps', () => {
  const s = E.recoverableRange(rows());
  assert.deepEqual([s.from, s.to, s.days, s.held, s.missing], ['2026-11-15', '2026-11-22', 8, 5, 3]);
  assert.equal(R.spanText(s.from, s.to, s.days, s.missing), '2026-11-15 → 2026-11-22 · 5 of 8 days');
  const success = E.recoverableRange(rows().filter((r) => r.id === 'good'));
  assert.equal(R.spanText(success.from, success.to, success.days, success.missing), '2026-11-15 → 2026-11-21 · 4 of 7 days');
  assert.match(E.spanTitle(s), /5 of 8 day\(s\) can be restored: 3 day\(s\) inside this span are in no snapshot/);
  assert.equal(E.recoverableRange([{ status: 'PARTIAL', failed: 1, indexNames: ['x'], failedIndices: null }]).unknown, true);
});

test('a row says what it covers: running, failed and partial are not full days', () => {
  assert.equal(R.snapshotCover(byId('run')).text, 'in progress');
  assert.equal(R.snapshotCover(byId('dead')).text, 'failed');
  const p = R.snapshotCover(byId('part'));
  assert.equal(p.text, '2026-11-22 → 2026-11-22');
  assert.equal(p.note, 'partial: 1 of 2 indices');
  assert.equal(R.snapshotCover(byId('good')).text, '2026-11-15 → 2026-11-21 · 4 of 7 days');
  assert.equal(byId('run').coverTo, null, 'an index named by a running snapshot is not backed up');
});

test('CSV: data columns are what can be restored, with the missing days and the note', () => {
  const csv = Object.fromEntries(L.snapshotCsvRows(rows()).map((r) => [r.snapshot, r]));
  assert.deepEqual([csv.good.data_from, csv.good.data_to, csv.good.data_days, csv.good.data_missing_days, csv.good.data_note],
    ['2026-11-15', '2026-11-21', 7, 3, '']);
  assert.deepEqual([csv.run.data_from, csv.run.data_days, csv.run.data_note], ['', 0, 'in progress: nothing to restore yet']);
  assert.equal(csv.part.data_note, 'partial: 1 of 2 indices');
  const [cat] = L.snapshotCsvRows([{ id: 'c', status: 'SUCCESS', indexNames: null }]);
  assert.deepEqual([cat.data_from, cat.data_missing_days, cat.data_note], ['unknown', '', 'index names not read']);
  const [cut] = L.snapshotCsvRows([byId('good')], { rows: [1], total: 812, cut: true });
  assert.match(cut.data_note, /newest 1 of 812/);
});

test('evidence rows: never "ok" while running or after a failed run', () => {
  const dayOf = (n) => n.slice(-10);
  const st = (state) => E.evidenceRows(['a-2026.11.20'], dayOf, [], state)[0].status;
  assert.equal(st('SUCCESS'), 'ok');
  assert.equal(st('PARTIAL'), 'ok');
  assert.equal(st('IN_PROGRESS'), 'in progress');
  assert.equal(st('FAILED'), 'not restorable');
  assert.equal(st('SOMETHING_NEW'), 'unknown');
  assert.match(E.coverLine(null, { named: true, note: 'in progress: nothing to restore yet' }), /covers no restorable days: in progress/);
});

test('the volume report: newest index day backed up is one that can be restored', () => {
  const r = V.volumeReport({ id: 'c', name: 'c' }, { snapshots: { r: rows() }, repos: [{ name: 'r' }] }, [], null);
  assert.equal(r.snapshotDataTo, '2026-11-22', 'not 24, which is only in the running snapshot');
  assert.equal(r.snapshotDataDays, 8);
  assert.equal(r.snapshotDataHeld, 5);
});

test('a snapshot read while running lends its names only: its days follow the newer status', () => {
  const full = { rows: S.snapshotRowsVerbose({ snapshots: [es('x', 'IN_PROGRESS', [20])] }), at: 1000, source: 'verbose', totals: {} };
  const cat = (status, failed) => ({ rows: S.snapshotRowsCat([{ id: 'x', status, start_epoch: '1', end_epoch: '2', indices: '1',
    successful_shards: '1', failed_shards: String(failed), total_shards: '1' }]), at: 2000, source: 'cat', totals: { whole: true } });
  assert.equal(S.mergeSnapshotListings(cat('SUCCESS', 0), full).rows[0].coverFrom, '2026-11-20');
  assert.equal(S.mergeSnapshotListings(cat('PARTIAL', 1), full).rows[0].coverFrom, null);
  assert.equal(S.mergeSnapshotListings(cat('FAILED', 1), full).rows[0].coverFrom, null);
});

test('a listing says when it is the newest of more; _cat is whole', () => {
  assert.deepEqual(R.listingCut(500, { total: 812, remaining: 312 }), { total: 812, cut: true });
  assert.deepEqual(R.listingCut(500, { total: null, remaining: 12 }), { total: 512, cut: true });
  assert.deepEqual(R.listingCut(500, { total: 500 }), { total: 500, cut: false });
  assert.deepEqual(R.listingCut(500, undefined), { total: null, cut: true }, 'a full page with no total may not be all');
  assert.deepEqual(R.listingCut(40, undefined), { total: 40, cut: false });
  assert.deepEqual(R.listingCut(700, { whole: true }), { total: 700, cut: false });
  assert.equal(R.cutText({ rows: [1, 2], total: 9, cut: true }), 'newest 2 of 9');
  assert.deepEqual(S.totalsOf({ ok: true, json: { total: 7, remaining: 2 } }), { total: 7, remaining: 2 });
  assert.deepEqual(S.totalsOf({ total: 7, remaining: 0, json: {} }), { total: 7, remaining: 0 });
});

test('unreadable, unread and empty are three things', () => {
  const d = { reachable: true, reposRead: true, repos: [{ name: 'a' }, { name: 'b', error: 'no such bucket' }, { name: 'c' }], snapshots: { a: [] } };
  assert.deepEqual(R.repoListing(d, d.repos[0]).rows, []);
  assert.equal(R.repoListing(d, d.repos[1]).rows, null);
  assert.match(R.repoListing(d, d.repos[1]).why, /no such bucket/);
  assert.equal(R.repoListing(d, d.repos[2]).why, 'not read yet');
  assert.equal(R.listingsKnown(d).unread.length, 2);
  assert.equal(E.listingEmptyText(E.repoEmptyFacts(d, 'a')), 'No snapshots in this repository');
  assert.match(E.listingEmptyText(E.repoEmptyFacts(d, 'b')), /could not be read \(no such bucket\)/);
  assert.match(E.listingEmptyText(E.repoEmptyFacts(d, 'c')), /not read yet/);
});

test('"no repository" only when the list was read, from a cluster that answers, and is empty', () => {
  assert.equal(R.noRepository({ reachable: true, reposRead: true, repos: [] }), true);
  assert.equal(R.noRepository({ reachable: true, reposRead: false, repos: [] }), false);
  assert.equal(R.noRepository({ reachable: false, reposRead: true, repos: [] }), false);
  assert.equal(R.noRepository(undefined), false);
  const bad = { ok: false, error: new Error('down') }, ok = (value) => ({ ok: true, value });
  const raw = { root: bad, health: bad, alloc: bad, nodes: bad, repos: bad, slm: bad, slmStatus: bad, ilm: bad, ilmErr: bad, repoPaths: bad };
  assert.equal(S.buildClusterData('x', {}, raw).reposRead, false);
  assert.equal(S.buildClusterData('x', {}, { ...raw, repos: ok({}) }).reposRead, true);
});

test('availability: today is not missed, days before the oldest listed are not read, days are in the zone', () => {
  const now = Date.UTC(2026, 10, 24, 20, 0);           // 25 Nov 01:30 in Kolkata
  const s = (iso, status = 'SUCCESS') => ({ status, start: Date.parse(iso) });
  const list = [s('2026-11-23T19:00:00Z'), s('2026-11-22T10:00:00Z', 'FAILED')];
  const utc = R.availability(list, { days: 4, tz: 'UTC', now });
  assert.deepEqual(utc.days.map((d) => [d.date.slice(5), d.state]),
    [['11-21', 'none'], ['11-22', 'bad'], ['11-23', 'ok'], ['11-24', 'today']]);
  assert.deepEqual(utc.missing, ['2026-11-21', '2026-11-22'], 'today is not a missed day');
  const ist = R.availability(list, { days: 3, tz: 'Asia/Kolkata', now });
  assert.deepEqual(ist.days.map((d) => [d.date.slice(5), d.state]), [['11-23', 'none'], ['11-24', 'ok'], ['11-25', 'today']]);
  const cut = R.availability(list, { days: 4, tz: 'UTC', now, cut: true });
  assert.deepEqual(cut.days.map((d) => d.state), ['notread', 'notread', 'ok', 'today'], 'before the oldest listed: not read');
  assert.deepEqual(cut.missing, []);
});

test('verify and the live + snapshot search: unread repositories and cut listings are not proof of absence', async () => {
  S.state.data.clear(); S.state.clients.clear(); S.state.indices.clear();
  let calls = 0;
  S.state.clients.set('c', { snapshots: async () => { calls++; return { snapshots: BODY.snapshots, total: 900, remaining: 896 }; } });
  S.state.data.set('c', { reposRead: true, repos: [{ name: 'r' }, { name: 'bad', error: 'denied' }], snapshots: { r: rows() },
    snapshotTotals: { r: { total: 900, remaining: 896 } } });
  const v = await C.verifyIndicesInSnapshots({ id: 'c' }, [day(15), day(24), day(17), day(22)]);
  assert.equal(calls, 0, 'nothing asked again, the unreadable repository included');
  assert.equal(v.get(day(15)).covered, true);
  for (const n of [24, 17, 22]) assert.equal(v.get(day(n)).covered, false, `${n}: only a whole SUCCESS snapshot counts for a deletion`);
  assert.ok(v.get(day(15)).unverified.some((x) => /bad: could not be read: denied/.test(x)));
  assert.ok(v.get(day(15)).unverified.some((x) => /newest 4 of 900/.test(x)));
  S.state.data.get('c').repos = [{ name: 'r' }];
  const f = await C.findIndexEverywhere({ id: 'c' }, 'logstash', { max: 2 });
  assert.equal(f.clusterId, 'c');
  assert.equal(f.truncated, true);
  assert.equal(f.snapshotted.length, 2);
  assert.equal(f.liveRead, false, 'the index list was never read: "0 live" would be a guess');
  assert.match(f.unverified[0], /newest 4 of 900/);
  const all = await C.findIndexEverywhere({ id: 'c' }, 'logstash');
  assert.equal(all.snapshotted.find((x) => x.index === day(24)).successful, 0);
  assert.equal(all.snapshotted.find((x) => x.index === day(15)).successful, 1);
});
