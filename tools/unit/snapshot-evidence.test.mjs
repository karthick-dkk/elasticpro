/** The snapshot evidence view's rows, header, CSV and text — one source for all three. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const E = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/snapshot-evidence.js')).href);
const { evidenceRows, evidenceHeader, evidenceCsv, evidenceText, coverLine, NO_DATE, safeUrl } = E;

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
  cluster: 'prod-eu', url: 'https://es:9200', repository: 'daily', snapshot: 'snap-1', state: 'SUCCESS',
  taken: Date.UTC(2026, 8, 30, 1, 0, 0), ended: Date.UTC(2026, 8, 30, 1, 5, 0), takenText: 'T', endedText: 'E',
  durationText: '5 m', shards: { successful: 9, failed: 1, total: 10 }, indexCount: 5,
  cover: 'covers 2026-09-23 → 2026-09-25 (3 days, 0 missing days)', generatedAt: Date.UTC(2026, 8, 30, 12, 0, 0),
  generatedText: 'G', user: 'karthick',
});

test('header: cluster first, and who generated it', () => {
  assert.equal(header[0].label, 'Cluster');
  assert.equal(header[0].value, 'prod-eu');
  const gen = header.find((f) => f.key === 'generated');
  assert.equal(gen.value, 'G by karthick');
  assert.equal(header.find((f) => f.key === 'shards').value, '9 ok · 1 failed · 10 total');
  const anon = evidenceHeader({ generatedAt: 1 });
  assert.match(anon.find((f) => f.key === 'generated').value, /by user not known$/);
  assert.equal(anon.find((f) => f.key === 'shards').value, 'unknown', 'no shard counts is unknown, not 0');
});

test('CSV leads with the header fields (ISO times), then a blank line, then every row', () => {
  const rows = evidenceRows(NAMES, dayOf, []);
  const csv = evidenceCsv(header, rows);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines[0], 'Cluster,prod-eu');
  assert.ok(lines.includes('Taken,2026-09-30T01:00:00.000Z'), 'the CSV carries ISO times');
  assert.ok(lines.includes('Evidence generated,2026-09-30T12:00:00.000Z by karthick'));
  const blank = lines.indexOf('');
  assert.equal(blank, header.length, 'one row per header field, then a blank line');
  assert.equal(lines[blank + 1], '#,index,data_date,shard_status,shard_detail');
  assert.equal(lines.length, blank + 2 + NAMES.length);
  assert.ok(lines.some((l) => l === `5,.kibana_1,${NO_DATE},ok,`), 'an undated index says so, it is not blank');
});

test('text block: header aligned, one line per index, undated named as such', () => {
  const rows = evidenceRows(NAMES, dayOf, null);
  const txt = evidenceText(header, rows);
  assert.match(txt, /^SNAPSHOT EVIDENCE\n\nCluster {13}prod-eu\n/);
  assert.match(txt, /\n1 {2}b-2026\.09\.23 {9}2026-09-23 {7}unknown\n/);
  assert.match(txt, new RegExp(`\\.kibana_1 +${NO_DATE} +unknown`));
  assert.equal(txt.trimEnd().split('\n').length, 2 + header.length + 1 + 1 + NAMES.length);
});

test('the cluster address in evidence never carries a credential', () => {
  assert.equal(safeUrl('https://elastic:s3cret@es.example.com:9200/'), 'https://es.example.com:9200');
  assert.equal(safeUrl('http://203.0.113.10:9200'), 'http://203.0.113.10:9200');
  assert.equal(safeUrl(''), '');
  const h = evidenceHeader({ cluster: 'c', url: 'https://u:p@h:9200', generatedAt: 1 });
  const url = h.find((x) => x.key === 'url');
  assert.equal(url.value, 'https://h:9200');
  assert.ok(!evidenceText(h, []).includes('u:p@'), 'nor in the copied text');
});
