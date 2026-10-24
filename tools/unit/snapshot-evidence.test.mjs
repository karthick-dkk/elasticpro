/** The snapshot evidence view's rows, header, CSV and text — one source for all three. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const E = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-evidence.js')).href);
const { evidenceRows, evidenceHeader, evidenceCsv, evidenceText, coverLine, NO_DATE, safeUrl,
        sortEvidenceRows, EVIDENCE_SORTS, DEFAULT_EVIDENCE_SORT } = E;
const { cycleSort, sortCaption } = await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/sort-order.js')).href);

// A stand-in for parseIndexName(n).day: the trailing yyyy.MM.dd, if any.
const dayOf = (n) => { const m = /(\d{4})\.(\d{2})\.(\d{2})$/.exec(n); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const NAMES = ['logstash-2026.09.25', '.kibana_1', 'logstash-2026.09.23', 'b-2026.09.23', 'logstash-2026.09.24'];

test('rows sort by data date then name, undated last, numbered from 1', () => {
  const rows = evidenceRows(NAMES, dayOf, []);
  assert.deepEqual(rows.map((r) => r.index),
    ['b-2026.09.23', 'logstash-2026.09.23', 'logstash-2026.09.24', 'logstash-2026.09.25', '.kibana_1']);
  assert.deepEqual(rows.map((r) => r.n), [1, 2, 3, 4, 5]);
  assert.equal(rows[4].day, null);
});

test('per-index shard status: failed from the detail, ok otherwise, unknown when not read', () => {
  const rows = evidenceRows(NAMES, dayOf, [{ index: 'logstash-2026.09.24', shard_id: 0, reason: 'node left' },
    { index: 'logstash-2026.09.24', shard_id: 2, reason: 'io' }]);
  const r = rows.find((x) => x.index === 'logstash-2026.09.24');
  assert.equal(r.status, 'failed');
  assert.equal(r.failedShards, 2);
  assert.match(r.detail, /shard 0: node left; shard 2: io/);
  assert.equal(rows.find((x) => x.index === '.kibana_1').status, 'ok');
  assert.ok(evidenceRows(NAMES, dayOf, null).every((x) => x.status === 'unknown'),
    'a snapshot not looked inside has not been shown to be clean');
});

test('coverLine states the span and the gaps, or why it cannot', () => {
  assert.equal(coverLine({ coverFrom: '2026-09-23', coverTo: '2026-09-29', coverDays: 7, missingDays: 0 }),
    'covers 2026-09-23 → 2026-09-29 (7 days, 0 missing days)');
  assert.equal(coverLine({ coverFrom: '2026-09-23', coverTo: '2026-09-23', coverDays: 1, missingDays: 1 }),
    'covers 2026-09-23 → 2026-09-23 (1 day, 1 missing day)');
  assert.match(coverLine({ coverFrom: null }), /no index name in this snapshot carries a date/);
  assert.match(coverLine(null, { named: false }), /unknown/);
});

const header = evidenceHeader({
  repository: 'daily', snapshot: 'snap-1', state: 'SUCCESS',
  taken: Date.UTC(2026, 8, 30, 1, 0, 0), ended: Date.UTC(2026, 8, 30, 1, 5, 0), takenText: 'T', endedText: 'E',
  durationText: '5 m', shards: { successful: 9, failed: 1, total: 10 }, indexCount: 5,
  cover: 'covers 2026-09-23 → 2026-09-25 (3 days, 0 missing days)',
});

// Evidence is handed to clients: snapshot data only. The cluster's name and address and
// the "generated … by <user>" stamp led this block until 0.3.29, and were asked off it.
test('header: repository first, snapshot data only — no cluster, address or operator', () => {
  assert.equal(header[0].label, 'Repository');
  assert.equal(header[0].value, 'daily');
  assert.deepEqual(header.map((f) => f.key),
    ['repository', 'snapshot', 'state', 'taken', 'ended', 'duration', 'shards', 'indices', 'covers']);
  assert.equal(header.find((f) => f.key === 'shards').value, '9 ok · 1 failed · 10 total');
  const leak = evidenceHeader({ cluster: 'prod-eu', url: 'https://u:p@es:9200', user: 'karthick', generatedAt: 1,
    repository: 'daily', snapshot: 's' });
  const all = JSON.stringify(leak);
  for (const word of ['prod-eu', 'es:9200', 'karthick', 'generated', 'Cluster', 'Address'])
    assert.ok(!all.includes(word), `the header still carries "${word}"`);
  assert.equal(leak.find((f) => f.key === 'shards').value, 'unknown', 'no shard counts is unknown, not 0');
});

test('CSV leads with the header fields (ISO times), then a blank line, then every row', () => {
  const rows = evidenceRows(NAMES, dayOf, []);
  const csv = evidenceCsv(header, rows);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'Repository,daily');
  assert.ok(lines.includes('Taken,2026-09-30T01:00:00.000Z'), 'the CSV carries ISO times');
  assert.ok(!lines.some((l) => /^Evidence generated|^Cluster|^Address/.test(l)), 'the CSV carries no cluster or operator line');
  const blank = lines.indexOf('');
  assert.equal(blank, header.length, 'one row per header field, then a blank line');
  assert.equal(lines[blank + 1], '#,index,data_date,shard_status,shard_detail');
  assert.equal(lines.length, blank + 2 + NAMES.length);
  assert.ok(lines.some((l) => l === `5,.kibana_1,${NO_DATE},ok,`), 'an undated index says so, it is not blank');
});

test('text block: header aligned, one line per index, undated named as such', () => {
  const rows = evidenceRows(NAMES, dayOf, null);
  const txt = evidenceText(header, rows);
  assert.match(txt, /^SNAPSHOT EVIDENCE\n\nRepository {3}daily\n/);
  assert.match(txt, /\n1 {2}b-2026\.09\.23 {9}2026-09-23 {7}unknown\n/);
  assert.match(txt, new RegExp(`\\.kibana_1 +${NO_DATE} +unknown`));
  assert.equal(txt.trimEnd().split('\n').length, 2 + header.length + 1 + 1 + NAMES.length);
});

test('safeUrl strips a credential from an address (for any evidence that still shows one)', () => {
  assert.equal(safeUrl('https://elastic:s3cret@es.example.com:9200/'), 'https://es.example.com:9200');
  assert.equal(safeUrl('http://203.0.113.10:9200'), 'http://203.0.113.10:9200');
  assert.equal(safeUrl(''), '');
});

// The table's sort: the order shown is the order exported, numbered from 1 as shown.
test('sortEvidenceRows: data date newest first by default, undated last either way', () => {
  const rows = evidenceRows(NAMES, dayOf, []);
  assert.deepEqual(DEFAULT_EVIDENCE_SORT, { key: 'day', dir: -1 });
  const newest = sortEvidenceRows(rows);
  assert.deepEqual(newest.map((r) => r.index),
    ['logstash-2026.09.25', 'logstash-2026.09.24', 'b-2026.09.23', 'logstash-2026.09.23', '.kibana_1']);
  assert.deepEqual(newest.map((r) => r.n), [1, 2, 3, 4, 5], 'numbered in the order shown');
  const oldest = sortEvidenceRows(rows, { key: 'day', dir: 1 });
  assert.equal(oldest[0].index, 'b-2026.09.23');
  assert.equal(oldest[4].index, '.kibana_1', 'undated stays last when the order flips');
  assert.equal(oldest[0].n, 1);
});

test('sortEvidenceRows: by index name, and failed shards first', () => {
  const rows = evidenceRows(NAMES, dayOf, [{ index: 'logstash-2026.09.24', shard_id: 0, reason: 'io' }]);
  assert.deepEqual(sortEvidenceRows(rows, { key: 'index', dir: 1 }).map((r) => r.index),
    ['.kibana_1', 'b-2026.09.23', 'logstash-2026.09.23', 'logstash-2026.09.24', 'logstash-2026.09.25']);
  assert.equal(sortEvidenceRows(rows, { key: 'index', dir: -1 })[0].index, 'logstash-2026.09.25');
  const failedFirst = sortEvidenceRows(rows, { key: 'status', dir: -1 });
  assert.equal(failedFirst[0].index, 'logstash-2026.09.24');
  assert.equal(failedFirst[1].index, 'b-2026.09.23', 'ties keep the canonical order (oldest data first)');
  const unknown = sortEvidenceRows(evidenceRows(NAMES, dayOf, null), { key: 'status', dir: 1 });
  assert.ok(unknown.every((r) => r.status === 'unknown'), 'a status sort invents no "ok"');
});

test('a header click flips the active order and starts a new key in its natural direction', () => {
  assert.deepEqual(cycleSort(DEFAULT_EVIDENCE_SORT, 'day', EVIDENCE_SORTS), { key: 'day', dir: 1 });
  assert.deepEqual(cycleSort(DEFAULT_EVIDENCE_SORT, 'index', EVIDENCE_SORTS), { key: 'index', dir: 1 });
  assert.deepEqual(cycleSort({ key: 'index', dir: 1 }, 'status', EVIDENCE_SORTS), { key: 'status', dir: -1 });
  assert.equal(sortCaption(DEFAULT_EVIDENCE_SORT, EVIDENCE_SORTS), 'sorted by data date, newest first');
  assert.equal(sortCaption({ key: 'status', dir: 1 }, EVIDENCE_SORTS), 'sorted by shards, ok first');
});

test('the CSV and the text follow the order shown', () => {
  const rows = sortEvidenceRows(evidenceRows(NAMES, dayOf, []), { key: 'index', dir: -1 });
  const csv = evidenceCsv(header, rows).trimEnd().split('\n');
  assert.equal(csv[csv.indexOf('') + 2], '1,logstash-2026.09.25,2026-09-25,ok,');
  assert.match(evidenceText(header, rows), /\n1 {2}logstash-2026\.09\.25/);
});

// Regression: ISSUE-B — before the repositories were read, the Snapshots page was headed
// "Snapshots in —" over "No snapshots in this repository": an unknown drawn as an empty result.
// Found by /qa on 2026-10-13
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-10-13.md
const { listingTitle, listingEmptyText } = E;

test('the listing title names a repository only when there is one', () => {
  assert.equal(listingTitle('daily'), 'Snapshots in daily');
  assert.equal(listingTitle(undefined), 'Snapshots');
  assert.equal(listingTitle(''), 'Snapshots');
});

test('an empty listing says what is actually known, in order', () => {
  assert.equal(listingEmptyText({ searching: true, fetched: true, repos: [{ name: 'daily' }] }), 'No snapshot matches that search');
  assert.equal(listingEmptyText({ error: 'No route to that address from this machine.' }), 'Repositories could not be read: No route to that address from this machine.');
  assert.equal(listingEmptyText({ fetched: false }), 'Repositories not read yet — press Refresh to list them');
  assert.equal(listingEmptyText({ fetched: true, repos: [] }), 'No snapshot repositories on this cluster');
  assert.equal(listingEmptyText({ fetched: true, repos: [{ name: 'daily' }] }), 'No snapshots in this repository');
  assert.equal(listingEmptyText(), 'Repositories not read yet — press Refresh to list them', 'nothing known = not read');
});
