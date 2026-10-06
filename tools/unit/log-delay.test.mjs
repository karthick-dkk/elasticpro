/** The log-delay arithmetic: classification, trend, pattern, record building. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ld = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/log-delay.js')).href);
const T = ld.DEFAULT_THRESHOLDS;

test('classify: the ordinary bands', () => {
  assert.equal(ld.classify(0, T), 'OK');
  assert.equal(ld.classify(29.9, T), 'OK');
  assert.equal(ld.classify(30, T), 'DELAYED', 'the threshold itself is delayed');
  assert.equal(ld.classify(59.9, T), 'DELAYED');
  assert.equal(ld.classify(60, T), 'CRITICAL', 'the critical threshold itself is critical');
  assert.equal(ld.classify(6000, T), 'CRITICAL');
});

test('classify: a negative delay is a clock, not a small delay', () => {
  assert.equal(ld.classify(-5, T), 'OK', 'a little early is still fine');
  assert.equal(ld.classify(-30, T), 'CLOCK_AHEAD');
  assert.equal(ld.classify(-120, T), 'CLOCK_AHEAD', 'a big negative must never read as CRITICAL');
});

test('classify: unmeasurable is ERROR, never zero', () => {
  for (const v of [null, undefined, NaN, Infinity, 'x']) {
    assert.equal(ld.classify(v, T), 'ERROR', `${String(v)} should be ERROR`);
  }
});

test('classify: thresholds are per cluster', () => {
  const strict = { ...T, delayMinutes: 5, criticalMinutes: 10 };
  assert.equal(ld.classify(6, strict), 'DELAYED');
  assert.equal(ld.classify(11, strict), 'CRITICAL');
  assert.equal(ld.classify(6, T), 'OK', 'the same value is fine under the default');
});

test('trend: needs enough samples to mean anything', () => {
  assert.equal(ld.trend([]), 'NO_TREND');
  assert.equal(ld.trend([10, 90]), 'NO_TREND', 'two points are not a trend');
  assert.equal(ld.trend([10, 20, 90]), 'NO_TREND');
});

test('trend: direction from halves, not endpoints', () => {
  assert.equal(ld.trend([10, 10, 60, 60]), 'WORSENING');
  assert.equal(ld.trend([60, 60, 10, 10]), 'IMPROVING');
  assert.equal(ld.trend([30, 31, 30, 29]), 'NO_TREND', 'noise is not a trend');
  // One outlier at the end must not flip a flat series.
  assert.equal(ld.trend([30, 30, 30, 30, 30, 31]), 'NO_TREND');
});

test('trend: a flat near-zero series is not a 400% rise', () => {
  assert.equal(ld.trend([0, 0, 0.2, 0.3]), 'NO_TREND');
});

test('pattern: a whole-hour offset is a timezone, not a queue', () => {
  const p = ld.analysePattern(60, T);
  assert.equal(p.pattern, 'timezone');
  assert.match(p.note, /1h behind/);
  assert.equal(ld.analysePattern(300, T).pattern, 'timezone', '5h exactly');
  assert.equal(ld.analysePattern(-120, T).pattern, 'timezone', 'ahead counts too');
  assert.match(ld.analysePattern(-120, T).note, /ahead/);
});

test('pattern: near a whole hour counts, away from it does not', () => {
  assert.equal(ld.analysePattern(62, T).pattern, 'timezone', 'within tolerance');
  assert.equal(ld.analysePattern(75, T).pattern, '-', '15 min off the hour is a queue');
  assert.equal(ld.analysePattern(330, T).pattern, '-', '5h30 is not an offset');
});

test('pattern: under an hour is never a timezone', () => {
  assert.equal(ld.analysePattern(2, T).pattern, '-');
  assert.equal(ld.analysePattern(0, T).pattern, '-');
});

test('pattern: unmeasurable has no pattern', () => {
  assert.equal(ld.analysePattern(null, T).pattern, '-');
});

test('aggregatableName: the rule the preflight depends on', () => {
  assert.equal(ld.aggregatableName('src_hostname'), 'src_hostname.keyword');
  assert.equal(ld.aggregatableName('a.keyword'), 'a.keyword', 'never doubled');
  assert.equal(ld.aggregatableName('src_ip'), 'src_ip', 'ip-like stays bare');
  assert.equal(ld.aggregatableName('client.address'), 'client.address');
  assert.equal(ld.aggregatableName('ClientID'), 'ClientID');
  assert.equal(ld.aggregatableName(''), '');
});

test('recordFrom: builds a measured record', () => {
  const now = Date.now();
  const bucket = {
    key: 'fw-01', doc_count: 12,
    latest: { hits: { hits: [{ _source: {
      '@timestamp': new Date(now).toISOString(),
      ingested_time: new Date(now - 45 * 60000).toISOString(),
      tag1: 'acme',
    } }] } },
  };
  const resolved = { arrival: '@timestamp', eventTime: 'ingested_time', metadata: ['tag1.keyword'] };
  const r = ld.recordFrom(bucket, resolved, T);
  assert.equal(r.device, 'fw-01');
  assert.equal(Math.round(r.delayMinutes), 45);
  assert.equal(r.status, 'DELAYED');
  assert.equal(r.meta.tag1, 'acme', 'metadata is read by its plain name');
  assert.ok(r.fix.length > 0, 'a delayed device gets a fix');
});

test('recordFrom: a missing timestamp is ERROR with a null delay, not 0', () => {
  const resolved = { arrival: '@timestamp', eventTime: 'ingested_time', metadata: [] };
  const bucket = { key: 'x', doc_count: 1, latest: { hits: { hits: [{ _source: { '@timestamp': new Date().toISOString() } }] } } };
  const r = ld.recordFrom(bucket, resolved, T);
  assert.equal(r.delayMinutes, null, 'null, never 0');
  assert.equal(r.status, 'ERROR');
});

test('recordFrom: an empty bucket does not throw', () => {
  const r = ld.recordFrom({ key: 'y', doc_count: 0 }, { arrival: '@timestamp', eventTime: 'e', metadata: [] }, T);
  assert.equal(r.status, 'ERROR');
  assert.equal(r.delayMinutes, null);
});

test('buildSearchBody: aggregates on the resolved names', () => {
  const b = ld.buildSearchBody({ device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'ingested_time', metadata: ['tag1.keyword'] },
    { from: 'now-24h', to: 'now', size: 250 });
  assert.equal(b.aggs.devices.terms.field, 'src_hostname.keyword');
  assert.equal(b.aggs.devices.terms.size, 250);
  assert.ok(b.aggs.devices.aggs.latest.top_hits, 'top_hits is a sub-agg of the terms agg');
  assert.ok(b.aggs.devices.aggs.latest.top_hits._source.includes('tag1'), 'source asks for the plain name');
  assert.equal(b.size, 0, 'no documents, only aggregations');
});

test('summarise: counts, and unknown when nothing is measurable', () => {
  const mk = (status, delayMinutes) => ({ status, delayMinutes });
  const s = ld.summarise([mk('OK', 1), mk('DELAYED', 40), mk('CRITICAL', 90), mk('CLOCK_AHEAD', -60), mk('ERROR', null)]);
  assert.equal(s.devices, 5);
  assert.equal(s.unhealthy, 3, 'delayed + critical + clock ahead');
  assert.equal(s.worst.delayMinutes, 90);
  assert.equal(ld.summarise([mk('ERROR', null)]).median, null, 'unknown, not 0');
  assert.equal(ld.summarise([]).median, null);
});

/* ------------------------------ fleet coverage ------------------------------ */

const entry = (o) => ({ state: 'checked', ...o });
const okPre = { ok: true, unknown: false, resolved: {} };
const noPre = { ok: false, unknown: false, missing: ['ingested_time'] };
const unknownPre = { ok: false, unknown: true, error: 'HTTP 503' };

test('a complete preflight sweep has no gap', () => {
  const c = ld.delayCoverage([
    entry({ pre: okPre }), entry({ pre: noPre }), entry({ pre: unknownPre }),
  ]);
  assert.deepEqual(c, { total: 3, ok: 3, failed: 0, skipped: 0 });
});

test('"cannot be analysed" is an answer, not a gap', () => {
  // The distinction the whole coverage line rests on: we asked and were told no, versus
  // we never asked. Only the second one makes the totals below it partial.
  const c = ld.delayCoverage([entry({ pre: noPre }), entry({ pre: noPre })]);
  assert.equal(c.skipped, 0);
  assert.equal(c.ok, 2);
});

test('a cluster that was never reached is counted as never reached', () => {
  const c = ld.delayCoverage([
    entry({ pre: okPre }),
    { state: 'skipped' },
    { state: 'waiting' },
    { state: 'error', error: 'connection refused' },
  ]);
  assert.deepEqual(c, { total: 4, ok: 1, failed: 1, skipped: 2 });
  assert.equal(c.ok + c.failed + c.skipped, c.total, 'every cluster must be accounted for');
});

test('the fetch is judged against the clusters that could take it', () => {
  const c = ld.delayCoverage([
    entry({ pre: okPre, records: [{}, {}], state: 'done' }),
    entry({ pre: okPre, state: 'failed', fetchError: 'all shards failed' }),
    entry({ pre: okPre, state: 'not-asked' }),
    // Not a candidate at all — counting this as a missing measurement would make a
    // correctly-configured fleet look like a broken one.
    entry({ pre: noPre }),
  ], 'fetch');
  assert.deepEqual(c, { total: 3, ok: 1, failed: 1, skipped: 1 });
});

test('a fleet where nothing can be analysed has nothing to fetch, and no gap', () => {
  const c = ld.delayCoverage([entry({ pre: noPre }), entry({ pre: unknownPre })], 'fetch');
  assert.deepEqual(c, { total: 0, ok: 0, failed: 0, skipped: 0 });
});

/* --------------------------- one device, close up --------------------------- */

test('an address is recognised, a hostname is not', () => {
  for (const v of ['10.1.2.3', '203.0.113.12', '0.0.0.0', '255.255.255.255',
                   '2001:db8::1', 'fe80::1%eth0', '[2001:db8::1]', '::1']) {
    assert.equal(ld.looksLikeIp(v), true, `${v} should read as an address`);
  }
  for (const v of ['fw-core-02', 'host.example.com', '10.1.2', '10.1.2.3.4',
                   '256.1.1.1', '', null, 'not-an-ip', '1.2.3.4x']) {
    assert.equal(ld.looksLikeIp(v), false, `${JSON.stringify(v)} should not read as an address`);
  }
});

test('a hostname is looked up in the grouping field, an address is not', () => {
  const resolved = { device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'ingested_time',
                     metadata: ['src_ip', 'log_type', 'host.ip'] };
  assert.deepEqual(ld.deviceFieldsFor('fw-core-02', resolved), ['src_hostname']);
  // The address is in src_ip even when the report groups by hostname — looking it up in
  // the hostname field would find nothing and read as "this device has gone silent".
  assert.deepEqual(ld.deviceFieldsFor('10.1.2.3', resolved), ['src_ip', 'host.ip']);
});

test('an address with no address field falls back rather than searching the hostname', () => {
  const resolved = { device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'ingested_time',
                     metadata: ['log_type'] };
  assert.deepEqual(ld.deviceFieldsFor('10.1.2.3', resolved), ['src_ip']);
});

test('the device query matches both the raw field and its keyword twin', () => {
  const resolved = { device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'ingested_time', metadata: [] };
  const q = ld.buildDeviceQuery(resolved, { device: 'fw-core-02', size: 15 });
  const should = q.query.bool.must[0].bool.should;
  assert.deepEqual(should.map((c) => Object.keys(c.term)[0]).sort(), ['src_hostname', 'src_hostname.keyword']);
  assert.equal(q.size, 15);
  assert.equal(q.sort[0]['@timestamp'].order, 'desc');
  assert.equal(q.track_total_hits, true);
});

test('an address query does not ask for a keyword twin it would never have', () => {
  const resolved = { device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'ingested_time',
                     metadata: ['src_ip'] };
  const q = ld.buildDeviceQuery(resolved, { device: '10.1.2.3' });
  const should = q.query.bool.must[0].bool.should;
  assert.deepEqual(should.map((c) => Object.keys(c.term)[0]), ['src_ip']);
});

const R = { device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'ingested_time', metadata: [] };
const hit = (arrival, event) => ({ _id: `${arrival}`, _index: 'logstash-2026.09.19',
  _source: { '@timestamp': arrival, ingested_time: event } });

test('a document whose clocks cannot be read is listed, not dropped', () => {
  const docs = ld.documentDelays([
    hit('2026-09-19T12:41:00Z', '2026-09-19T12:00:00Z'),
    hit('2026-09-19T12:30:00Z', 'not a date'),
  ], R);
  assert.equal(docs.length, 2, 'the unreadable document is evidence, not noise');
  assert.equal(docs[0].delayMinutes, 41);
  assert.equal(docs[1].delayMinutes, null);
  assert.equal(docs[1].status, 'ERROR', 'unmeasurable is never OK and never zero');
});

test('the close-up takes its status from the newest document', () => {
  // Newest first, as the query sorts them. The device is delayed *now* even though most
  // of its recent history was fine; an average would hide exactly the thing being
  // watched for.
  const s = ld.deviceSnapshot(ld.documentDelays([
    hit('2026-09-19T12:45:00Z', '2026-09-19T12:00:00Z'),   // 45 — delayed
    hit('2026-09-19T12:40:00Z', '2026-09-19T12:39:00Z'),   // 1
    hit('2026-09-19T12:35:00Z', '2026-09-19T12:34:00Z'),   // 1
  ], R));
  assert.equal(s.latest, 45);
  assert.equal(s.status, 'DELAYED');
  assert.equal(s.median, 1);
  assert.equal(s.max, 45);
  assert.equal(s.min, 1);
  assert.equal(s.measurable, 3);
  assert.equal(s.unreadable, 0);
});

test('unreadable documents are counted but never averaged in', () => {
  const s = ld.deviceSnapshot(ld.documentDelays([
    hit('2026-09-19T12:41:00Z', '2026-09-19T12:00:00Z'),
    hit('2026-09-19T12:30:00Z', ''),
    hit('2026-09-19T12:20:00Z', ''),
  ], R));
  assert.equal(s.documents, 3);
  assert.equal(s.measurable, 1);
  assert.equal(s.unreadable, 2);
  assert.equal(s.median, 41, 'the two unreadable documents must not pull the median to zero');
});

test('a device with nothing readable is unknown, not fine', () => {
  const s = ld.deviceSnapshot(ld.documentDelays([hit('nope', 'nope')], R));
  assert.equal(s.latest, null);
  assert.equal(s.median, null);
  assert.equal(s.status, 'ERROR');
  assert.equal(s.trend, 'NO_TREND');
});

test('a device with no documents at all is not a zero delay', () => {
  const s = ld.deviceSnapshot([]);
  assert.equal(s.documents, 0);
  assert.equal(s.latest, null);
  assert.equal(s.status, 'ERROR');
});

test('the trend reads oldest to newest, not the order the query returned', () => {
  // Newest first from the query; the delay has been climbing, so the trend is worsening.
  const rising = ld.deviceSnapshot(ld.documentDelays([
    hit('2026-09-19T13:00:00Z', '2026-09-19T12:00:00Z'),  // 60
    hit('2026-09-19T12:55:00Z', '2026-09-19T12:00:00Z'),  // 55
    hit('2026-09-19T12:20:00Z', '2026-09-19T12:15:00Z'),  // 5
    hit('2026-09-19T12:10:00Z', '2026-09-19T12:08:00Z'),  // 2
  ], R));
  assert.equal(rising.trend, 'WORSENING', `a climbing delay read as ${rising.trend}`);
});
