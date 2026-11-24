/**
 * Log delay per log type (0.3.90; docs/LOGDELAY.md): the rule that makes a device "part delayed",
 * the browser's measurement of log types, and the words and lines the pages draw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const mod = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const lv = await mod('ui/js/core/delay-levels.js');
const ld = await mod('ui/js/core/log-delay.js');
const lt = await mod('ui/js/core/log-types.js');
const R = await mod('ui/js/core/logdelay-report.js');
const T = { noDelayUnder: 15, delayFrom: 30, criticalOver: 60 };
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
R.setDisplayZone('UTC');
const at = (min) => NOW - min * 60000;
const ser = (logType, state, delayMinutes, more = {}) => ({ logType, noType: false, state, delayMinutes, lastMeasuredMs: at(5), stale: false, episodes: [], points: [], ...more });

/* ------------------------------------ the rule ------------------------------------ */

test('stateFromTypes: some late and some on time is part delayed, all late is the worst, none late is the device’s own', () => {
  const f = lv.stateFromTypes;
  assert.equal(f(['critical', 'no_delay', 'no_delay'], 'critical'), 'part_delay', '1 of 3 late');
  assert.equal(f(['delay', 'critical', 'no_delay'], 'no_delay'), 'part_delay', '2 of 3 late, whichever logged last');
  assert.equal(f(['delay', 'critical', 'delay'], 'delay'), 'critical', 'all late: the worst');
  assert.equal(f(['delay', 'delay'], 'critical'), 'delay');
  assert.equal(f(['no_delay', 'no_delay'], 'no_delay'), 'no_delay');
  assert.equal(f(['critical'], 'critical'), 'critical', 'exactly one type: as before');
  assert.equal(f([], 'delay'), 'delay', 'the field off: as before');
  assert.equal(f(['delay', 'unmeasured'], 'unmeasured'), 'delay', 'a type that cannot be measured is not on time: every measured one is late');
  assert.equal(f(['no_delay', 'unmeasured'], 'no_delay'), 'no_delay');
  assert.equal(f(['delay', 'silent'], 'delay'), 'delay', 'a silent type is neither');
  assert.equal(f(['delay', null], null), null, 'levels unknown: unknown, never part delayed');
});

test('part delayed is neither late nor on time, and has its own label and status', () => {
  assert.equal(lv.isLate('part_delay'), false);
  assert.equal(lv.isOnTime('part_delay'), false);
  assert.equal(lv.isPart('part_delay'), true);
  assert.equal(R.stateText('part_delay'), 'part delayed');
  assert.equal(lv.STATUS_OF_STATE.part_delay, 'PART_DELAY');
  assert.equal(R.rowLate({ state: 'part_delay' }), false);
});

test('logTypeFieldOf: remembered as the core said it; a core that never said is undefined, not null', () => {
  lv.forgetLevels();
  lv.rememberLevels({ ok: true, byCluster: [{ id: 'a', logTypeField: 'log_type.keyword' }, { id: 'b', logTypeField: null }, { id: 'c' }] });
  assert.equal(lv.logTypeFieldOf('a'), 'log_type.keyword');
  assert.equal(lv.logTypeFieldOf('b'), null);
  assert.equal(lv.logTypeFieldOf('c'), undefined);
  lv.forgetLevels();
  assert.equal(lv.logTypeFieldOf('a'), undefined);
});

/* ------------------------------------ the browser's measurement ------------------------------------ */

const caps = (f) => ({ fields: f });
test('logTypeFrom: the mapping decides log_type or log_type.keyword; not mapped says so', () => {
  const kw = { keyword: { aggregatable: true } }; const text = { text: { aggregatable: false } };
  assert.deepEqual(ld.logTypeFrom(caps({ log_type: kw })), { field: 'log_type', why: null });
  assert.deepEqual(ld.logTypeFrom(caps({ log_type: text, 'log_type.keyword': kw })), { field: 'log_type.keyword', why: null });
  assert.deepEqual(ld.logTypeFrom(caps({ '@timestamp': { date: {} } })), { field: null, why: 'log_type is not in the mapping' });
  assert.equal(ld.logTypeFrom(caps({ log_type: text })).field, null);
  assert.match(ld.logTypeFrom(caps({ log_type: text })).why, /without a keyword/);
});

const RES = { device: 'host', deviceKind: 'keyword', arrival: 'ingest', eventTime: 'logtime', metadata: [] };
test('buildSearchBody: without log types exactly the body a display link may send; with them one request with types and no_type', () => {
  const plain = ld.buildSearchBody(RES, { from: 1, to: 2 });
  assert.deepEqual(Object.keys(plain.aggs.devices.aggs), ['latest']);
  assert.deepEqual(ld.buildSearchBody({ ...RES, logType: null }, { from: 1, to: 2 }), plain, 'the field off: the same');
  const b = ld.buildSearchBody({ ...RES, logType: 'log_type' }, { from: 1, to: 2 }).aggs.devices.aggs;
  assert.deepEqual(Object.keys(b), ['latest', 'types', 'no_type']);
  assert.deepEqual(b.types.terms, { field: 'log_type', size: 20, shard_size: 100 });
  assert.deepEqual(b.no_type.missing, { field: 'log_type' });
  assert.equal(b.types.aggs.latest.top_hits.size, 1);
});

const hit = (gapMin) => ({ hits: { hits: [{ _source: gapMin === null ? { ingest: new Date(at(10)).toISOString() } : { ingest: new Date(at(10)).toISOString(), logtime: new Date(at(10 + gapMin)).toISOString() } }] } });
const bucket = (key, newest, types, { none = null, other = 0 } = {}) => ({ key, doc_count: 9, latest: hit(newest),
  types: { sum_other_doc_count: other, buckets: Object.entries(types).map(([k, g]) => ({ key: k, doc_count: 3, latest: hit(g) })) },
  no_type: none === null ? { doc_count: 0 } : { doc_count: 2, latest: hit(none) } });
const rec = (...a) => ld.recordFrom(bucket(...a), { ...RES, logType: 'log_type' }, T, null);

test('recordFrom: a device with one of three types late is part delayed whichever type logged last', () => {
  const r = rec('fw', 46, { threat: 46, traffic: 2, system: 1 });
  assert.equal(r.status, 'PART_DELAY');
  assert.deepEqual(r.types.map((t) => [t.logType, t.status]), [['threat', 'DELAYED'], ['traffic', 'OK'], ['system', 'OK']], 'worst first');
  assert.equal(rec('fw', 1, { threat: 46, traffic: 2, system: 1 }).status, 'PART_DELAY');
  assert.equal(rec('all', 40, { a: 40, b: 80 }).status, 'CRITICAL', 'all late');
  assert.equal(rec('one', 40, { a: 40 }).status, 'DELAYED', 'one type: as before');
  assert.equal(rec('ok', 2, { a: 2, b: 1 }).status, 'OK');
});

test('recordFrom: documents without the field are their own type, never a value of the same text', () => {
  const r = rec('x', 2, { '(no log type)': 50, sys: 1 }, { none: 2, other: 4 });
  assert.equal(r.types.length, 3);
  assert.deepEqual(r.types.map((t) => [lt.typeKey(t), t.label]).sort(), [['none:(no log type)', '(no log type)'], ['type:(no log type)', '“(no log type)”'], ['type:sys', 'sys']]);
  assert.equal(r.typesTruncated, true);
  assert.equal(r.status, 'PART_DELAY');
});

test('recordFrom: an unreadable type is can’t measure, not on time; without the field types are null and the status is the newest document’s', () => {
  const r = rec('x', 40, { a: 40, b: null });
  assert.equal(r.types.find((t) => t.logType === 'b').state, 'unmeasured');
  assert.equal(r.status, 'DELAYED');
  const old = ld.recordFrom({ key: 'x', doc_count: 1, latest: hit(40) }, RES, T, null);
  assert.equal(old.types, null);
  assert.equal(old.status, 'DELAYED');
});

test('summarise: part delayed apart from delayed, log types counted per device; null where not measured', () => {
  const s = ld.summarise([rec('a', 46, { threat: 46, traffic: 2, system: 1 }), rec('b', 1, { audit: 90, sys: 1 }), rec('c', 40, { x: 40, y: 45 }), rec('d', 1, { z: 1 })]);
  assert.equal(s.by.PART_DELAY, 2); assert.equal(s.by.DELAYED, 1); assert.equal(s.by.OK, 1);
  assert.deepEqual(s.logTypes, { total: 8, late: 4, above: 1 });
  assert.deepEqual(s.partLate, [{ logType: 'audit', devices: 1 }, { logType: 'threat', devices: 1 }]);
  assert.deepEqual([s.worstLogType.logType, s.worstLogType.device], ['audit', 'b']);
  const v = Object.fromEntries(ld.delayItemValues(s).map((x) => [x.key, x.value]));
  assert.deepEqual([v.delayed, v.critical, v.late, v.part_delayed, v.log_types_late, v.worst_log_type], [1, 0, 1, 2, 4, 'audit on b']);
  const nd = R.noDelayOfStatuses(s);
  assert.deepEqual([nd.count, nd.part, nd.late], [1, 2, 1]);
  const sum = nd.pct.noDelay + nd.pct.part + nd.pct.late + nd.pct.tz;
  assert.equal(Math.round(sum * 10) / 10, 100);

  const off = ld.summarise([ld.recordFrom({ key: 'x', doc_count: 1, latest: hit(40) }, RES, T, null)]);
  assert.equal(off.logTypes, null); assert.equal(off.partLate, null); assert.equal(off.worstLogType, null);
  assert.equal(off.by.PART_DELAY, undefined, 'not measured is not 0');
  const keys = ld.delayItemValues(off).map((x) => x.key);
  for (const k of ['part_delayed', 'log_types_late', 'worst_log_type']) assert.ok(!keys.includes(k), `${k} is not sent`);
  assert.ok(keys.includes('delayed'));
});

test('a Live row: part delayed with its log types, on the levels of the page', () => {
  const row = R.liveDeviceRow(rec('fw', 46, { threat: 46, traffic: 2, system: 1 }), { id: 'c', name: 'C' }, T);
  assert.equal(row.state, 'part_delay');
  assert.deepEqual(row.types, { total: 3, measured: 3, late: 1, lateNames: ['threat'], truncated: false });
  assert.equal(R.liveDeviceRow(rec('fw', 46, { threat: 46, traffic: 2 }), { id: 'c' }, null).state, 'unknown', 'levels not known');
  const old = R.liveDeviceRow({ device: 'x', delayMinutes: 40, types: null }, { id: 'c' }, T);
  assert.equal(old.state, 'delay'); assert.ok(!('types' in old));
});

/* ------------------------------------ the words ------------------------------------ */

test('typesText: late of total with the names, never "on time" for what was not measured', () => {
  const t = (o) => ({ total: 3, measured: 3, late: 0, lateNames: [], truncated: false, ...o });
  assert.equal(lt.typesText(t({ late: 1, lateNames: ['threat'] })), '1 of 3 late: threat');
  assert.equal(lt.typesText(t({ total: 8, late: 4, lateNames: ['a', 'b', 'c', 'd'] })), '4 of 8 late: a, b +2');
  assert.equal(lt.typesText(t()), '0 of 3 late');
  assert.equal(lt.typesText(t({ measured: 1 })), '0 of 3 late · 1 measured');
  assert.equal(lt.typesText(t({ measured: 0 })), '3, none measured');
  assert.equal(lt.typesText(t({ total: 20, truncated: true, late: 1, lateNames: ['x'] })), '1 of 20+ late: x');
  assert.equal(lt.typesText(null), '—');
  assert.match(lt.typesTitle(t({ measured: 2 })), /2 of 3 log types measured/);
  assert.match(lt.typesTitle(null), /not measured with log types/);
});

test('the headline: how many log types are late and what the others are, each case', () => {
  const on = (n) => ser(n, 'no_delay', 2);
  assert.equal(lt.typesHeadline([ser('threat', 'delay', 46), on('traffic'), on('system')], { now: NOW }), '1 of 3 log types late: threat — the other 2 are on time');
  assert.equal(lt.typesHeadline([ser('a', 'critical', 90), ser('b', 'delay', 40), on('c')], { now: NOW }), '2 of 3 log types late: a, b — the other 1 is on time');
  assert.equal(lt.typesHeadline([ser('a', 'critical', 90), ser('b', 'delay', 40)], { now: NOW }), 'All 2 log types late: a, b');
  assert.equal(lt.typesHeadline([on('a'), on('b')], { now: NOW }), 'All 2 log types on time');
  assert.equal(lt.typesHeadline([ser('a', 'delay', 40), on('b'), ser('c', 'silent', null, { lastArrival: at(200) }), ser('d', 'unmeasured', null)], { now: NOW }),
    '1 of 4 log types late: a — the other 3: 1 on time · 1 no logs · 1 can\'t measure');
  assert.equal(lt.typesHeadline([on('a'), ser('c', 'silent', null)], { now: NOW }), 'None of 2 log types late — 1 on time · 1 no logs');
  assert.equal(lt.typesHeadline([ser('a', 'delay', 40, { stale: true, lastMeasuredMs: at(115) }), on('b')], { now: NOW }),
    'None of 2 log types late — 1 on time · 1 not measured since 10:05', 'a stale late series is not late now, and not on time');
  assert.equal(lt.typesHeadline([ser('a', 'delay', 46)], { now: NOW }), 'Its only log type, a: delayed');
  assert.match(lt.typesHeadline([on('a'), on('b')], { now: NOW, truncated: true }), /2 log types read, the device has more that were not/);
  assert.equal(lt.typesHeadline([], { now: NOW }), '');
  assert.equal(lt.typesHeadline(null), '');
});

test('a series in words: no logs since, can’t measure and a stale one never read as a 0 or as late', () => {
  assert.equal(lt.seriesNow(ser('a', 'delay', 46), NOW), '46 min');
  assert.equal(lt.seriesNow(ser('a', 'silent', null, { lastArrival: Date.UTC(2026, 10, 24, 9, 40) }), NOW), 'no logs since 09:40');
  assert.equal(lt.seriesNow(ser('a', 'unmeasured', null), NOW), "can't measure");
  const stale = ser('a', 'critical', 90, { stale: true, lastMeasuredMs: at(115) });
  assert.equal(lt.seriesNow(stale, NOW), '90 min at 10:05');
  assert.equal(lt.seriesStateText(stale, NOW), 'critical when last measured 10:05, not measured since');
  assert.equal(lt.seriesLate(stale), false);
  assert.deepEqual([lt.pointText({ t: 1, m: 46 }), lt.pointText({ t: 1, m: null, s: 'silent' }), lt.pointText({ t: 1, m: null, s: 'unmeasured' }), lt.pointText(undefined)], ['46 min', 'no logs', "can't measure", 'not measured']);
});

test('the hover: every drawn log type at that measurement, named', () => {
  const t1 = at(60);
  const list = [ser('threat', 'delay', 46, { points: [{ t: t1, m: 46, s: 'delay' }] }), ser('traffic', 'no_delay', 2, { points: [{ t: t1, m: 2, s: 'no_delay' }] }), ser('system', 'silent', null, { points: [{ t: t1, m: null, s: 'silent' }] }), ser('late', 'no_delay', 1)];
  assert.equal(lt.delaysAtText(list, t1), 'threat 46 min · traffic 2 min · system no logs · late not measured');
});

test('the lines: six at most, worst first; a toggled one takes a free slot and the others keep theirs', () => {
  const list = Array.from({ length: 8 }, (_, i) => ser(`t${i}`, 'no_delay', i));
  const slots = lt.lineSlots(list);
  assert.equal(slots.size, 6);
  assert.equal(lt.toggleLine(slots, 'type:t7').has('type:t7'), false, 'six drawn: no seventh');
  const less = lt.toggleLine(slots, 'type:t1');
  assert.equal(less.size, 5);
  const more = lt.toggleLine(less, 'type:t7');
  assert.equal(more.get('type:t7'), 1, 'the freed slot');
  assert.equal(more.get('type:t0'), 0); assert.equal(more.get('type:t5'), 5);
  assert.deepEqual([...lt.lineSlots(list.slice(0, 2), more).keys()].sort(), ['type:t0'], 'a series that left is not drawn');
  assert.equal(new Set(lt.LINE_COLOURS).size, lt.LINES_MAX);
  for (const c of lt.LINE_COLOURS) assert.ok(!['--series-5', '--series-8', '--state-crit', '--state-late'].includes(c), `${c}: never red, yellow or the time-zone violet`);
});

test('seriesGraph: one scale for every line, gaps stay gaps', () => {
  const g = lt.seriesGraph([ser('a', 'critical', 200, { points: [{ t: at(120), m: 200 }, { t: at(60), m: null, s: 'unmeasured' }, { t: at(10), m: 100 }] }), ser('b', 'no_delay', 2, { points: [{ t: at(60), m: 2 }] })], { fromMs: at(240), toMs: NOW, levels: T, height: 240 });
  assert.equal(g.scaleMax, 240);
  assert.equal(g.lines[0].segments.length, 2, 'an unreadable point breaks the line');
  assert.equal(g.lines[0].dots.length, 2);
  assert.ok(g.lines[1].dots[0].y > 230, 'on the same scale');
  assert.deepEqual(g.times, [at(120), at(60), at(10)]);
});

/* ------------------------------------ the boards' arithmetic ------------------------------------ */

test('partOf: null for an older core; off on every cluster is no count and why; some off is said', () => {
  assert.equal(R.partOf({ devices: 3 }, [{ id: 'a', lastRunAt: 1 }]), null);
  const on = { id: 'a', lastRunAt: 1, logTypeField: 'log_type' }; const off = { id: 'b', lastRunAt: 1, logTypeField: null, logTypeWhy: 'log_type is not in the mapping' };
  const t = { partDelayed: 4, pctPartDelayed: 2.5, logTypes: { total: 30, late: 7, above: 2 } };
  assert.equal(R.partText(R.partOf(t, [on])), '7 log types late');
  assert.equal(R.partText(R.partOf(t, [on, off])), '7 log types late · not on 1 of 2 clusters: no log_type');
  const p = R.partOf({ partDelayed: 0, logTypes: { total: 0, late: 0, above: 0 } }, [off]);
  assert.equal(p.count, null); assert.equal(R.partText(p), 'log_type is not in the mapping');
});

test('noDelayOf: part delayed is not in No delay, and the shares add up to 100', () => {
  const nd = R.noDelayOf({ devices: 7, onTime: 2, silent: 1, unmeasured: 0, cantMeasure: 1, late: 1, partDelayed: 2, otherTz: 0 });
  assert.equal(nd.count, 4); assert.equal(nd.part, 2);
  assert.equal(Math.round((nd.pct.noDelay + nd.pct.late + nd.pct.part + nd.pct.tz) * 10) / 10, 100);
  assert.equal(R.noDelayOf({ devices: 2, noDelay: 1, cantMeasure: 0, pctNoDelay: 50, pctPartDelayed: 50, pctLate: 0 }).pct.part, 50);
  assert.ok(!('part' in R.noDelayOf({ devices: 2, onTime: 2, late: 0 })), 'an older core: no part');
});

test('bars, rings, day titles and tiles count part delayed only where the core does', () => {
  const d = { day: '2026-11-24', devices: 10, onTime: 6, noDelay: 6, cantMeasure: 0, silent: 0, delayed: 1, critical: 1, partDelayed: 2, otherTz: 0 };
  assert.ok(R.dayBars([d], 100)[0].part > 0);
  assert.match(R.dayTitle(d), /2 part delayed/);
  assert.ok(!('part' in R.dayBars([{ ...d, partDelayed: undefined }], 100)[0]));
  assert.deepEqual(R.ringArcs(1, 1, 10, 6, 2).map((a) => a.kind), ['critical', 'delay', 'part', 'ok']);
  const rows = [{ state: 'part_delay', types: { total: 3, late: 1, lateNames: ['threat'] } }, { state: 'no_delay', types: null }];
  const c = R.tileCounts(rows);
  assert.equal(c.partDelayed, 1); assert.deepEqual(c.logTypes, { total: 3, late: 1 });
  assert.equal(R.tileCounts([{ state: 'no_delay' }]).partDelayed, undefined);
  assert.deepEqual(R.filterCounts(rows).part, 1); assert.equal(R.filterCounts(rows).late, 0);
  assert.equal(R.filterRows(rows, 'thre').length, 1, 'a late log type is searched');
});

test('started → solved of a part delayed device is its part late time, never "never late"', () => {
  assert.equal(R.startedSolvedText({ state: 'part_delay', partLateMs: 130 * 60000 }, NOW), 'part late 2 h 10 min');
  assert.equal(R.startedSolvedText({ state: 'part_delay' }, NOW), 'part late now');
});

test('Live’s address carries the log type, and only then', () => {
  assert.equal(R.ldHash('live', 'c', 'd', { logType: 'a b&c' }), '#/log-delay/live/c/d?log_type=a%20b%26c');
  assert.deepEqual(R.ldRoute('#/log-delay/live/c/d?log_type=a%20b%26c'), { view: 'live', clusterId: 'c', device: 'd', tz: null, logType: 'a b&c' });
  assert.deepEqual(R.ldRoute(R.ldHash('live', 'c', 'd', { noType: true })), { view: 'live', clusterId: 'c', device: 'd', tz: null, noType: true });
  assert.deepEqual(R.ldRoute('#/log-delay/live/c/d'), { view: 'live', clusterId: 'c', device: 'd', tz: null });
});
