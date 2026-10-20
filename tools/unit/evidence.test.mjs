/**
 * The evidence layout: which pages have it, what its footer says, what it holds back.
 *
 * Snapshots, the REST console and Indices are screenshotted for one client, so they must
 * show one cluster and nothing about the fleet. The DOM side is in behaviour-check.mjs;
 * these are the decisions underneath, which have no DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ev = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/evidence.js')).href);
const { EVIDENCE_PAGES, evidenceLayout, evidenceStamp, stampTime, ageWords, safeAddress, createHeldNotices } = ev;

const PAGES = ['alerts', 'overview', 'indices', 'shards', 'logs', 'console', 'snapshots', 'volume', 'automation',
  'requests', 'accounts', 'settings'];

test('exactly Snapshots, the REST console and Indices are evidence pages', () => {
  assert.deepEqual([...EVIDENCE_PAGES].sort(), ['console', 'indices', 'snapshots']);
  for (const id of PAGES) {
    assert.equal(evidenceLayout(id, 'c1').evidence, EVIDENCE_PAGES.has(id), id);
  }
  assert.equal(evidenceLayout(null, 'c1').evidence, false);
});

test('an evidence page with no single cluster asks for one', () => {
  for (const id of EVIDENCE_PAGES) {
    assert.deepEqual(evidenceLayout(id, 'c1', true), { evidence: true, needsCluster: false });
    assert.equal(evidenceLayout(id, 'all', true).needsCluster, true, 'All clusters is not one cluster');
    assert.equal(evidenceLayout(id, '', true).needsCluster, true);
    assert.equal(evidenceLayout(id, 'gone', false).needsCluster, true, 'a cluster not in the config');
  }
  assert.deepEqual(evidenceLayout('overview', 'all', true), { evidence: false, needsCluster: false });
});

test('app.js leaves the decision to evidence.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  assert.match(src, /evidenceLayout\(/);
  assert.doesNotMatch(src, /EVIDENCE_PAGES\s*=/, 'a second list of evidence pages');
});

const NOW = new Date(2026, 9, 20, 13, 27, 2).getTime();
const at = (h, m, s) => new Date(2026, 9, 20, h, m, s).getTime();
const cluster = { name: 'Alpha-logging', url: 'https://alpha.example.com:9200' };
const base = { cluster, label: 'Snapshot data read', now: NOW, version: '0.3.22', user: 'Admin', tz: 'IST' };

test('the footer names the cluster, the data time, the capture time, the version and the user', () => {
  const s = evidenceStamp({ ...base, fresh: { ts: at(13, 25, 20), status: 'ok' } });
  assert.equal(s.text, 'Cluster: Alpha-logging · https://alpha.example.com:9200 · '
    + 'Snapshot data read 2026-10-20 13:25:20 IST (2 min before this capture) · Captured 13:27:02 · '
    + 'ElasticPro 0.3.22 · Signed in as Admin');
  assert.equal(s.tone, 'ok');
  assert.equal(s.note, '');
});

test('data past the page\'s limit turns amber and says to refresh', () => {
  const s = evidenceStamp({ ...base, fresh: { ts: NOW - 2 * 3600 * 1000, status: 'ok' } });
  assert.equal(s.tone, 'stale');
  assert.match(s.text, /Data is 2 h old\. Refresh before capturing\./);
  assert.match(s.note, /2 h old/);
  // the page's own limit decides, not a global one
  const young = evidenceStamp({ ...base, fresh: { ts: NOW - 4 * 60 * 1000, status: 'ok', staleAfterMs: 2 * 60 * 1000 } });
  assert.equal(young.tone, 'stale');
  const ok = evidenceStamp({ ...base, fresh: { ts: NOW - 4 * 60 * 1000, status: 'ok', staleAfterMs: 20 * 60 * 1000 } });
  assert.equal(ok.tone, 'ok');
});

test('unknown is not zero: never read, no timestamp and unreachable each say so', () => {
  const never = evidenceStamp({ ...base, fresh: { ts: 0, status: 'never' } });
  assert.match(never.text, /not read yet/);
  assert.equal(never.tone, 'unknown');
  assert.doesNotMatch(never.text, /1970|before this capture/);

  const none = evidenceStamp({ ...base, fresh: { ts: 0, status: 'never' }, none: 'no request run yet' });
  assert.match(none.text, /no request run yet/);

  const unknown = evidenceStamp({ ...base, fresh: null });
  assert.match(unknown.text, /data time unknown/);

  const down = evidenceStamp({ ...base, fresh: { ts: NOW - 60000, status: 'ok', reach: { state: 'unreachable' } } });
  assert.equal(down.tone, 'stale');
  assert.match(down.text, /cluster unreachable/);
  assert.match(down.note, /unreachable/);

  const failed = evidenceStamp({ ...base, fresh: { ts: NOW - 60000, status: 'error' } });
  assert.match(failed.text, /last fetch failed/);
});

test('the version and the user are left out when unknown, not printed as "?"', () => {
  const s = evidenceStamp({ ...base, version: '?', user: '', fresh: { ts: NOW - 1000, status: 'ok' } });
  assert.doesNotMatch(s.text, /ElasticPro|Signed in/);
});

test('the printed address carries no credentials, query or fragment', () => {
  assert.equal(safeAddress('https://elastic:s3cret@alpha.example.com:9200/?token=abc#x'), 'https://alpha.example.com:9200');
  assert.equal(safeAddress('http://10.0.0.5:9200/es/'), 'http://10.0.0.5:9200/es');
  assert.equal(safeAddress('not a url'), 'not a url');
  assert.equal(safeAddress(''), '');
  const s = evidenceStamp({ ...base, cluster: { name: 'A', url: 'https://u:p@h:9200' }, fresh: { ts: NOW, status: 'ok' } });
  assert.doesNotMatch(s.text, /u:p|@/);
});

test('ages are said in words a reader of a screenshot understands', () => {
  assert.equal(ageWords(0), '0 s');
  assert.equal(ageWords(40000), '40 s');
  assert.equal(ageWords(6 * 60000), '6 min');
  assert.equal(ageWords(2 * 3600000), '2 h');
  assert.equal(ageWords(3 * 86400000), '3 days');
  assert.equal(ageWords(-5000), '0 s', 'a clock a little ahead is not a negative age');
});

test('the time is local, to the second, with the zone', () => {
  assert.equal(stampTime(at(9, 5, 7), 'IST'), '2026-10-20 09:05:07 IST');
  assert.equal(stampTime(at(9, 5, 7), ''), '2026-10-20 09:05:07');
});

test('held notices come back once, as bell entries, with one line saying how many', () => {
  const held = createHeldNotices();
  held.hold('late-up-2: 3 new alerts', 'err', 9000, { key: 'alerts:a', cluster: 'late-up-2' });
  held.hold('late-up-3: 1 new alert', 'warn', 6000, { key: 'alerts:b' });
  held.hold('late-up-2: 4 new alerts', 'err', 9000, { key: 'alerts:a' });        // replaces the first
  held.hold('4 new alerts on 2 clusters', 'err', 9000, { key: 'alerts-batch', noHistory: true });
  assert.equal(held.size(), 3);
  const shown = [];
  const n = held.release((m, k, ms, o) => shown.push({ m, k, o }));
  assert.equal(n, 2, 'the batch line only summarises entries that are replayed');
  assert.equal(shown.length, 3);
  assert.deepEqual(shown.slice(0, 2).map((x) => x.m), ['late-up-3: 1 new alert', 'late-up-2: 4 new alerts']);
  assert.ok(shown.slice(0, 2).every((x) => x.o.bellOnly), 'replayed into the bell, not stacked on screen');
  assert.equal(shown[2].m, 'Held 2 notices while on an evidence page');
  assert.equal(shown[2].k, 'err');
  assert.equal(held.size(), 0);
  assert.equal(held.release(() => assert.fail('nothing left to release')), 0);
});

test('one held notice is "1 notice", and nothing held says nothing', () => {
  const held = createHeldNotices();
  assert.equal(held.release(() => assert.fail('no line for nothing')), 0);
  held.hold('x', 'warn', 1000, {});
  const lines = [];
  held.release((m) => lines.push(m));
  assert.equal(lines.at(-1), 'Held 1 notice while on an evidence page');
});
