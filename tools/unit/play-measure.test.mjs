/**
 * The log delay while Play runs, in two tiers (play/measure.js, docs/PLAY.md): a full check of
 * every device every 2 h, and the late list — the devices at or past the yellow line, by
 * log-delay.js `classify` — re-checked every 15 min with one request naming only them. A
 * device that catches up leaves the list. The shared record carries both times, and the Log
 * delay slide says when each last ran.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;

/** A core in miniature: the shared delay record, kept as play/share.rs keeps it. */
const shared = new Map();
const puts = [];
globalThis.fetch = async (_url, init) => {
  const msg = JSON.parse(init.body);
  let out;
  if (msg.type === 'PLAY_SHARE_GET') {
    out = { ok: true, byCluster: Object.fromEntries((msg.clusterIds || []).filter((id) => shared.has(id)).map((id) => [id, shared.get(id)])) };
  } else if (msg.type === 'PLAY_SHARE_PUT') {
    puts.push(msg);
    const { measuredAt, ...data } = msg.data;
    shared.set(msg.clusterId, { measuredAt: msg.measuredAt, data, by: 'tv' });
    out = { ok: true, kept: true };
  } else {
    out = { ok: false, kind: 'bad_message', message: `Unknown message type ${msg.type}` };
  }
  return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(out) };
};

const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const M = await import(url('ui/js/play/measure.js'));
const L = await import(url('ui/js/core/log-delay.js'));

const T = { ...L.DEFAULT_THRESHOLDS };   // yellow 30, red above 60
const MIN = 60000;
const rec = (device, delayMinutes) => ({ device, delayMinutes, arrival: 1, event: 1, docs: 1 });

test('the display-link gate knows the shipped delay fields the pages use (config.js DEFAULTS = auth.rs)', async () => {
  const fs = await import('node:fs');
  const rs = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/auth.rs'), 'utf8');
  const list = (name) => [...new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\];`).exec(rs)[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const { DEFAULTS } = await import(url('ui/js/core/config.js'));
  assert.equal(/pub const DELAY_DEVICE_DEFAULT: &str = "([^"]+)";/.exec(rs)[1], DEFAULTS.delayFields.device);
  assert.deepEqual(list('DELAY_EVENT_TIME_DEFAULT'), DEFAULTS.delayFields.eventTime);
  assert.deepEqual(list('DELAY_METADATA_DEFAULT'), DEFAULTS.delayFields.metadata);
  assert.equal(/pub const DELAY_ARRIVAL_DEFAULT: &str = "([^"]+)";/.exec(rs)[1], DEFAULTS.timeField);
  // The aggregation's field, the same rule on both sides.
  for (const f of ['host', 'src_ip', 'dst_addr', 'ClientID', 'x.keyword', 'src_hostname']) {
    const want = L.aggregatableName(f);
    assert.ok(rs.includes('pub fn aggregatable_name'), 'the Rust rule exists');
    assert.equal(want, f === 'host' ? 'host.keyword' : f === 'src_hostname' ? 'src_hostname.keyword' : f, f);
  }
});

test('the schedule is the request policy\'s, 2 h and 15 min when the core does not say', () => {
  assert.deepEqual(M.scheduleFrom(null), { fullMs: 2 * 60 * MIN, lateMs: 15 * MIN });
  assert.deepEqual(M.scheduleFrom({ play: { delayFullSec: 3600, delayLateSec: 600 } }), { fullMs: 60 * MIN, lateMs: 10 * MIN });
  assert.deepEqual(M.scheduleFrom({ play: { delayFullSec: 1800, delayLateSec: 7200 } }), { fullMs: 30 * MIN, lateMs: 30 * MIN },
    'the late list is never re-checked less often than a full check runs');
  assert.equal(M.MEASURE_EVERY_MS, M.FULL_EVERY_MS, 'a measurement is good for one full-check interval');
});

test('the late list is classify\'s yellow line and above, worst first — one definition', () => {
  const recs = [rec('ok', 29.9), rec('yellow', 30), rec('edge', 60), rec('red', 61), rec('ahead', -45), rec('unknown', null), rec('wild*', 90)];
  assert.deepEqual(L.lateList(recs, T), ['red', 'edge', 'yellow'],
    'at 30 min a device is late; ahead of time, unmeasured and an unaskable name are not');
  assert.deepEqual(L.lateList(recs, { ...T, delayMinutes: 10 }), ['red', 'edge', 'yellow', 'ok'], 'on the wall\'s own yellow line');
  assert.equal(L.lateList(Array.from({ length: 600 }, (_, i) => rec(`d${i}`, 40)), T).length, L.LATE_MAX);
  assert.ok(L.recheckable('fe80::1') && L.recheckable('edge router 7'));
  assert.ok(!L.recheckable('') && !L.recheckable('a?b') && !L.recheckable('x'.repeat(257)) && !L.recheckable('a\u0007b'));
});

test('the re-check is today\'s body with one terms filter on the aggregation\'s own field', () => {
  const resolved = { device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: 'event.created', metadata: [] };
  const full = L.buildSearchBody(resolved, { from: 'now-24h', to: 'now', size: 500 });
  const late = L.buildLateSearchBody(resolved, ['fw1', 'fw2'], { from: 'now-24h', to: 'now', size: 500 });
  assert.equal(late.query.bool.filter.length, 2);
  assert.deepEqual(late.query.bool.filter[0], full.query.bool.filter[0], 'the range first, unchanged');
  assert.deepEqual(late.query.bool.filter[1], { terms: { 'src_hostname.keyword': ['fw1', 'fw2'] } });
  assert.deepEqual({ ...late, query: null }, { ...full, query: null }, 'everything else is the full check\'s body');
});

test('what is due: a full check every 2 h, the late list every 15 min, nothing when nobody is late', () => {
  const s = { fullMs: 120 * MIN, lateMs: 15 * MIN };
  assert.equal(M.dueKind(null, 0, s), 'full', 'never measured');
  const r = M.fullRecord([rec('a', 45), rec('b', 5)], 0, null, 1000, T);
  assert.deepEqual(r.late, ['a']);
  assert.equal(r.fullAt, 1000);
  assert.equal(M.dueKind(r, 1000 + 14 * MIN, s), null);
  assert.equal(M.dueKind(r, 1000 + 15 * MIN, s), 'late');
  assert.equal(M.dueKind({ ...r, lateAt: 1000 + 15 * MIN }, 1000 + 29 * MIN, s), null, '15 min from the last re-check');
  assert.equal(M.dueKind({ ...r, lateAt: 1000 + 15 * MIN }, 1000 + 30 * MIN, s), 'late');
  assert.equal(M.dueKind({ ...r, late: [] }, 1000 + 119 * MIN, s), null, 'nobody late: nothing until the full check');
  assert.equal(M.dueKind({ ...r, late: [] }, 1000 + 120 * MIN, s), 'full');
  assert.equal(M.dueKind(r, 1000 + 120 * MIN, s), 'full', 'the full check wins when both are due');
  assert.equal(M.dueKind(null, 5 * MIN, s, 1), null, 'a failed attempt is not repeated sooner than the late interval');
});

test('a re-check updates the late devices; one that caught up leaves the list, the rest stay as measured', () => {
  const full = M.fullRecord([rec('a', 45), rec('b', 70), rec('c', 5), rec('d', 50)], 3, null, 1000, T);
  assert.deepEqual(full.late, ['b', 'd', 'a']);
  const after = M.lateRecord(full, [rec('a', 12), rec('b', 75)], 1000 + 15 * MIN, T);
  assert.deepEqual(after.late, ['b', 'd'], 'a caught up and left; d sent nothing new and stays');
  assert.equal(after.records.find((x) => x.device === 'a').delayMinutes, 12);
  assert.equal(after.records.find((x) => x.device === 'c').delayMinutes, 5, 'a device not on the list keeps its full-check value');
  assert.deepEqual([after.fullAt, after.lateAt, after.measuredAt, after.truncated], [1000, 1000 + 15 * MIN, 1000 + 15 * MIN, 3]);
  assert.equal(after.records.find((x) => x.device === 'b').peak24.value, 75, 'the peak follows the re-check');
  // A device that was not late is never added by a re-check, whatever it answers: that waits for the full check.
  const again = M.lateRecord(after, [rec('c', 99)], 1000 + 30 * MIN, T);
  assert.deepEqual(again.late, ['b', 'd']);
});

test('the shared record carries both times and reads back as it was put', () => {
  const r = M.lateRecord(M.fullRecord([rec('a', 45)], 0, null, 1000, T), [rec('a', 50)], 5000, T);
  const data = M.shareData(r);
  assert.deepEqual(Object.keys(data).sort(), ['devices', 'fullAt', 'late', 'lateAt', 'truncated']);
  const back = M.fromShare({ measuredAt: 5000, data });
  assert.deepEqual([back.fullAt, back.lateAt, back.late], [1000, 5000, ['a']]);
  const old = M.fromShare({ measuredAt: 7, data: { devices: [rec('a', 1)] } });
  assert.deepEqual([old.fullAt, old.lateAt, old.late], [7, 0, null], 'a record from before the tiers was a full check');
  assert.equal(M.fromShare({ measuredAt: 7, data: { devices: [], fullAt: 99 } }).fullAt, 7, 'a time past the record\'s own is not believed');
});

test('the slide says when the last full check ran and when the late list was re-checked', () => {
  const clock = (ms) => `t${ms}`;
  assert.equal(M.tierLine([], clock), null);
  assert.equal(M.tierLine([{ fullAt: 100, late: [] }, { fullAt: 50, late: [] }], clock), 'last full check t50 · no device late');
  assert.equal(M.tierLine([{ fullAt: 100, lateAt: 900, late: ['a'] }, { fullAt: 50, lateAt: 700, late: ['b'] }], clock),
    'last full check t50 · late devices re-checked t700', 'the oldest of each: never fresher than the stalest cluster');
  assert.equal(M.tierLine([{ fullAt: 100, lateAt: 0, late: ['a'] }], clock), 'last full check t100 · late devices not re-checked yet');
});

test('a display measures on the two tiers, shares both times, and asks only what is due', async () => {
  let now = 10 * 3600000;
  const searches = [];
  let delays = { fw1: 45, fw2: 5, fw3: 70 };
  const bucket = (d) => ({ key: d, doc_count: 1, latest: { hits: { hits: [{ _source: { '@timestamp': new Date(now).toISOString(), event: { created: new Date(now - delays[d] * MIN).toISOString() } } }] } } });
  const es = {
    fieldCaps: async () => ({ fields: { 'src_hostname.keyword': {}, 'event.created': {}, '@timestamp': {} } }),
    search: async (_index, body) => {
      const terms = body.query.bool.filter[1];
      searches.push(terms ? terms.terms : 'full');
      const names = terms ? Object.values(terms.terms)[0] : Object.keys(delays);
      return { aggregations: { devices: { buckets: names.filter((d) => d in delays).map(bucket), sum_other_doc_count: 0 } } };
    },
  };
  const c = { id: 'c1', name: 'one', logIndexPattern: 'logs-*', delayFields: { device: 'src_hostname', eventTime: ['event.created'] } };
  const m = M.createMeasurer({ clusters: () => [c], client: () => es, reachable: () => true, now: () => now, onChange: () => {},
    schedule: () => ({ fullMs: 120 * MIN, lateMs: 15 * MIN }), thresholds: () => T });
  await m.cycle();
  assert.deepEqual(searches, ['full']);
  assert.deepEqual(m.get('c1').late, ['fw3', 'fw1']);
  assert.equal(puts.at(-1).data.fullAt, now);
  await m.cycle();
  assert.equal(searches.length, 1, 'nothing due a minute later');
  now += 15 * MIN;
  delays = { ...delays, fw1: 3 };
  await m.cycle();
  assert.deepEqual(searches[1], { 'src_hostname.keyword': ['fw3', 'fw1'] }, 'one request naming only the late devices');
  assert.deepEqual(m.get('c1').late, ['fw3'], 'fw1 caught up and left the list');
  assert.equal(puts.at(-1).data.lateAt, now);
  assert.equal(puts.at(-1).data.fullAt, now - 15 * MIN, 'the full check\'s time is kept beside it');
  // Another display reads the shared record and measures nothing: one display measures.
  const other = [];
  const m2 = M.createMeasurer({ clusters: () => [c], client: () => ({ ...es, search: async () => { other.push(1); return {}; } }), reachable: () => true,
    now: () => now, onChange: () => {}, schedule: () => ({ fullMs: 120 * MIN, lateMs: 15 * MIN }), thresholds: () => T });
  await m2.cycle();
  assert.deepEqual(other, [], 'the shared record was fresh');
  assert.deepEqual([m2.get('c1').fullAt, m2.get('c1').lateAt, m2.get('c1').late], [now - 15 * MIN, now, ['fw3']]);
  // At the full check's interval: every device again.
  now += 105 * MIN;
  await m.cycle();
  assert.equal(searches.at(-1), 'full');
});
