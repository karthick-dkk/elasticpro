/**
 * Documents inside Indices (core/documents.js): the request shapes, the field list, the
 * total label, the page-size clamp and the line diff — the arithmetic the view draws from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const D = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/documents.js')).href);

test('page sizes: the owner\'s choices, and the first is the default', () => {
  assert.deepEqual([...D.INDEX_PAGE_SIZES], [10, 25, 50, 100]);
  assert.deepEqual([...D.DOC_PAGE_SIZES], [5, 10, 25, 50]);
  assert.equal(D.clampPageSize(100, D.INDEX_PAGE_SIZES), 100);
  assert.equal(D.clampPageSize('50', D.DOC_PAGE_SIZES), 50);
  assert.equal(D.clampPageSize(7, D.DOC_PAGE_SIZES), 5, 'a size not offered falls back to the default');
  assert.equal(D.clampPageSize(undefined, D.INDEX_PAGE_SIZES), 10);
  assert.equal(D.clampPageSize('junk', D.DOC_PAGE_SIZES), 5);
});

test('target: a plain pattern list goes as typed', () => {
  assert.deepEqual(D.documentsTarget('logstash-*'), { target: 'logstash-*', asTyped: true, reason: '' });
  assert.deepEqual(D.documentsTarget(' logstash-acme-* , metrics-? '), { target: 'logstash-acme-*,metrics-?', asTyped: true, reason: '' });
  assert.deepEqual(D.documentsTarget(''), { target: '*', asTyped: true, reason: '' }, 'nothing typed is every open index');
});

test('target: plain text, inversion or other filters send the matched open names', () => {
  const names = ['logstash-acme-2026.09.09', 'logstash-beta-2026.09.09'];
  assert.equal(D.documentsTarget('acme', { names }).target, names.join(','), 'plain text means "contains" — not a pattern');
  assert.equal(D.documentsTarget('!logstash-*', { names }).target, names.join(','));
  assert.equal(D.documentsTarget('logstash-*', { not: true, names }).target, names.join(','));
  assert.equal(D.documentsTarget('logstash-*', { narrowed: true, names }).target, names.join(','), 'a status or day filter narrows what the search matched');
  assert.equal(D.documentsTarget('', { narrowed: true, names }).target, names.join(','));
  assert.equal(D.documentsTarget('logstash-*,acme', { names }).asTyped, false, 'one part without a wildcard makes the whole list a names list');
});

test('target: no match and too many names are said, not sent', () => {
  assert.equal(D.documentsTarget('zzz', { names: [] }).target, null);
  assert.match(D.documentsTarget('zzz', { names: [] }).reason, /No open index/);
  const many = Array.from({ length: 200 }, (_, i) => `logstash-tenant-2026.09.${String(i).padStart(2, '0')}`);   // ~5,000 chars
  const r = D.documentsTarget('tenant', { names: many });
  assert.equal(r.target, null);
  assert.equal(r.reason, 'Too many indices for one search — narrow the search');
  assert.ok(D.documentsTarget('tenant', { names: many.slice(0, 100) }).target, 'under the limit goes through');
});

test('paths carry the three flags, and the hash round-trips the target', () => {
  assert.equal(D.documentsPath('logstash-*'), '/logstash-*/_search?ignore_unavailable=true&allow_no_indices=true&expand_wildcards=open');
  assert.equal(D.mappingPath('a,b'), '/a%2Cb/_mapping?ignore_unavailable=true&allow_no_indices=true&expand_wildcards=open');
  assert.equal(D.docsHash('logstash-*,x'), '#/indices/docs/logstash-*%2Cx');
  assert.equal(D.docsTargetOf('#/indices/docs/logstash-*%2Cx'), 'logstash-*,x');
  assert.equal(D.docsTargetOf('#/indices'), null);
  assert.equal(D.docsTargetOf('#/indices/docs/'), null);
});

test('search body: query_string or match_all, the window on the time field, newest first, the total capped', () => {
  const b = D.searchBody({ query: 'level:error', timeField: '@timestamp', window: { from: 1000, to: 2000 }, from: 10, size: 5 });
  assert.deepEqual(b.query.bool.filter[0], { query_string: { query: 'level:error', default_operator: 'AND' } });
  assert.deepEqual(b.query.bool.filter[1], { range: { '@timestamp': { format: 'epoch_millis', gte: 1000, lte: 2000 } } });
  assert.deepEqual(b.sort, [{ '@timestamp': 'desc' }]);
  assert.equal(b.from, 10); assert.equal(b.size, 5);
  assert.equal(b.track_total_hits, D.MAX_RESULT_WINDOW);
  assert.equal(b.seq_no_primary_term, undefined, 'a read-only view asks for no version numbers');
  const plain = D.searchBody({ query: '  ', timeField: null, window: { from: 1, to: 2 } });
  assert.deepEqual(plain.query.bool.filter, [{ match_all: {} }], 'no time field: no range, whatever the window');
  assert.deepEqual(plain.sort, ['_doc']);
  const open = D.searchBody({ timeField: 't', window: { from: null, to: 5 } });
  assert.deepEqual(open.query.bool.filter[1], { range: { t: { format: 'epoch_millis', lte: 5 } } });
});

test('values body: the same question, no hits, one terms agg of ten', () => {
  const b = D.valuesBody({ query: 'a:b', timeField: '@timestamp', window: { from: 1, to: 2 }, field: 'host.keyword' });
  assert.equal(b.size, 0);
  assert.deepEqual(b.aggs, { top_values: { terms: { field: 'host.keyword', size: 10 } } });
  assert.equal(b.query.bool.filter.length, 2);
  assert.deepEqual(D.topValues({ aggregations: { top_values: { buckets: [{ key: 'x', doc_count: 3 }, { key: 1, key_as_string: 'true', doc_count: 1 }], sum_other_doc_count: 7 } } }),
    { values: [{ value: 'x', count: 3 }, { value: 'true', count: 1 }], other: 7 });
  assert.deepEqual(D.topValues({}), { values: [], other: 0 });
});

test('range window: fixed ranges end now; custom passes its ends through; none when empty', () => {
  const now = 1_700_000_000_000;
  assert.deepEqual(D.rangeWindow('15m', now), { from: now - 900000, to: now });
  assert.deepEqual(D.rangeWindow('7d', now), { from: now - 7 * 86400000, to: now });
  assert.equal(D.rangeWindow('custom', now), null);
  assert.deepEqual(D.rangeWindow('custom', now, { from: 5, to: null }), { from: 5, to: null });
  assert.equal(D.rangeWindow('nope', now), null);
});

const MAPPING = {
  'logstash-a': { mappings: { properties: {
    '@timestamp': { type: 'date' }, message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
    level: { type: 'keyword' }, bytes: { type: 'long' }, note: { type: 'text' }, ip: { type: 'ip' }, ok: { type: 'boolean' },
    host: { properties: { name: { type: 'keyword' }, os: { properties: { family: { type: 'keyword' } } } } } } } },
  'logstash-b': { mappings: { properties: { '@timestamp': { type: 'date' }, level: { type: 'long' }, extra: { type: 'keyword' } } } },
};

test('fields from a mapping: merged, sorted, leaves dotted, text aggregatable only through .keyword', () => {
  const f = D.fieldsFromMapping(MAPPING);
  assert.deepEqual(f.map((x) => x.name), ['@timestamp', 'bytes', 'extra', 'host.name', 'host.os.family', 'ip', 'level', 'message', 'note', 'ok']);
  const by = Object.fromEntries(f.map((x) => [x.name, x]));
  assert.equal(by.message.aggregatable, true); assert.equal(by.message.aggField, 'message.keyword');
  assert.equal(by.note.aggregatable, false); assert.equal(by.note.aggField, null);
  assert.equal(by['host.os.family'].aggField, 'host.os.family');
  assert.equal(by.level.type, 'keyword', 'the first type seen is kept');
  assert.equal(by.level.conflict, true, 'and the second index mapping it differently is marked');
  assert.equal(by.ip.aggregatable, true); assert.equal(by.ok.aggregatable, true);
  assert.deepEqual(D.fieldsFromMapping({}), []);
  assert.deepEqual(D.fieldsFromMapping(null), []);
});

test('time field: @timestamp when it is a date, else the first date, else none', () => {
  assert.equal(D.timeFieldOf(D.fieldsFromMapping(MAPPING)), '@timestamp');
  assert.equal(D.timeFieldOf([{ name: 'zed', type: 'date' }, { name: 'alpha', type: 'date_nanos' }]), 'zed');
  assert.equal(D.timeFieldOf([{ name: '@timestamp', type: 'keyword' }, { name: 'created', type: 'date' }]), 'created');
  assert.equal(D.timeFieldOf([{ name: 'x', type: 'keyword' }]), null);
});

test('total: the count when counted, 10,000+ when Elasticsearch stopped — never a guess', () => {
  assert.deepEqual(D.totalLabel({ value: 1234, relation: 'eq' }), { text: '1,234', value: 1234, exact: true });
  assert.deepEqual(D.totalLabel({ value: 10000, relation: 'gte' }), { text: '10,000+', value: 10000, exact: false });
  assert.deepEqual(D.totalLabel(7), { text: '7', value: 7, exact: true });
  assert.equal(D.totalLabel(undefined).text, '?');
});

test('pages: never past from+size 10,000, and capped says so', () => {
  assert.deepEqual(D.docPages({ value: 23, relation: 'eq' }, 5), { pages: 5, capped: false, per: 5 });
  assert.deepEqual(D.docPages({ value: 10000, relation: 'gte' }, 50), { pages: 200, capped: true, per: 50 });
  assert.deepEqual(D.docPages({ value: 12345, relation: 'eq' }, 25), { pages: 400, capped: true, per: 25 });
  assert.equal(D.docPages({ value: 0, relation: 'eq' }, 5).pages, 1);
});

test('time value: ISO strings and epoch numbers parse, anything else is NaN (shown raw, not guessed)', () => {
  assert.equal(D.timeMs('2026-11-16T07:54:00.000Z'), Date.parse('2026-11-16T07:54:00.000Z'));
  assert.equal(D.timeMs(1763279640000), 1763279640000);
  assert.equal(D.timeMs('1763279640000'), 1763279640000);
  assert.ok(Number.isNaN(D.timeMs('yesterday-ish')));
  assert.ok(Number.isNaN(D.timeMs(null)));
  assert.ok(Number.isNaN(D.timeMs({})));
});

test('summary: one line of k: v, objects as JSON, clipped', () => {
  assert.equal(D.summaryOf({ a: 1, b: 'x', c: { d: 2 }, e: null }), 'a: 1 · b: x · c: {"d":2} · e: null');
  assert.equal(D.summaryOf({ '@timestamp': 't', m: 'hi' }, { skip: ['@timestamp'] }), 'm: hi');
  assert.equal(D.summaryOf({ m: 'x'.repeat(300) }, { max: 20 }).length, 20);
  assert.equal(D.summaryOf(null), '');
});

test('addTerm: field:"value", AND-ed, quotes escaped, not twice', () => {
  assert.equal(D.addTerm('', 'level', 'error'), 'level:"error"');
  assert.equal(D.addTerm('a:b', 'level', 'error'), 'a:b AND level:"error"');
  assert.equal(D.addTerm('level:"error"', 'level', 'error'), 'level:"error"');
  assert.equal(D.addTerm('', 'msg', 'say "hi"'), 'msg:"say \\"hi\\""');
});

test('doc path: the GET the REST console opens, encoded', () => {
  assert.equal(D.docGetPath({ _index: 'logstash-a', _id: 'id/1' }), '/logstash-a/_doc/id%2F1');
});

test('fields view: dotted names in source order, leaves as JSON, nothing dropped', () => {
  const src = { '@timestamp': '2026-10-13T23:57:45.272Z', host: { name: 'win-hyd-02', ip: ['10.20.2.16'] }, event: { size: 1233, ok: true }, empty: {}, gone: null, tags: [] };
  assert.deepEqual(D.flatFields(src), [
    ['@timestamp', '2026-10-13T23:57:45.272Z'], ['host.name', 'win-hyd-02'], ['host.ip', ['10.20.2.16']],
    ['event.size', 1233], ['event.ok', true], ['empty', {}], ['gone', null], ['tags', []],
  ]);
  assert.deepEqual(D.flatFields(null), []);
  assert.equal(D.fieldText('a "b"'), 'a "b"', 'a string is copied as it is, not quoted');
  assert.equal(D.fieldText(['10.20.2.16']), '["10.20.2.16"]');
  assert.equal(D.fieldText(null), 'null');
  assert.equal(D.fieldsText({ a: 1, b: { c: 'x' } }), 'a\t1\nb.c\tx');
});
