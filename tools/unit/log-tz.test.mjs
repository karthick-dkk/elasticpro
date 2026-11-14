/** The browser's log time zone step (core/log-tz.js): the same rule as the core's tz.rs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const tz = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/log-tz.js')).href);
const ld = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/log-delay.js')).href);
const lv = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/delay-levels.js')).href);

const NOV = Date.UTC(2025, 10, 14, 9, 0, 0); // standard time in Europe
const IST = { setting: 'detect', mode: 'detected', zone: 'Asia/Kolkata', offsetMinutes: 330, offset: '+05:30', agree: 9, of: 10, pct: 90 };
const T = { noDelayUnder: 15, delayFrom: 30, criticalOver: 60 };

test('the tolerance is one figure: log-delay.js PATTERN = tz.rs TOLERANCE_MINUTES', () => {
  const rs = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/logdelay/tz.rs'), 'utf8');
  const m = /pub const TOLERANCE_MINUTES: f64 = ([\d.]+);/.exec(rs);
  assert.ok(m, 'tz.rs names the tolerance');
  assert.equal(Number(m[1]), ld.PATTERN.tzToleranceMinutes);
  const maj = /pub const MAJORITY_PERCENT: u64 = (\d+);/.exec(rs);
  const runs = /pub const STEADY_RUNS: usize = (\d+);/.exec(rs);
  assert.ok(tz.ZONE_HINT.includes(`${maj[1]} %`) && tz.ZONE_HINT.includes(`${runs[1]} runs`), 'the hint quotes the core\'s figures');
});

test('offsets: every real zone, half and quarter hours, matched within the tolerance', () => {
  const o = tz.offsetsInUse(NOV);
  for (const want of [0, 60, 330, 345, 480, 525, -210, -570]) assert.ok(o.has(want), `${want} in use`);
  assert.equal(tz.matchOffset(330, 3, o), 330);
  assert.equal(tz.matchOffset(332.9, 3, o), 330);
  assert.equal(tz.matchOffset(334, 3, o), null, 'a 4-minute miss is a delay');
  assert.equal(tz.matchOffset(345, 3, o), 345, 'Nepal');
  assert.equal(tz.matchOffset(1.2, 3, o), 0, 'on time in a UTC cluster sits at UTC');
  assert.equal(tz.matchOffset(40, 3, o), null);
  assert.equal(tz.matchOffset(null, 3, o), null);
  assert.equal(tz.offsetLabel(330), '+05:30');
  assert.equal(tz.offsetLabel(-210), '−03:30');
  assert.equal(tz.offsetLabel(0), '+00:00');
  assert.equal(tz.offsetLabel(null), '—');
  assert.ok(tz.knownZone('Asia/Kolkata') && tz.knownZone('utc') && !tz.knownZone('Mars/Olympus') && !tz.knownZone(''));
});

test('the cluster offset follows a named zone at the event time (DST) and is fixed for a detected offset', () => {
  const berlin = { mode: 'set', zone: 'Europe/Berlin', offsetMinutes: 60 };
  assert.equal(tz.clusterOffsetAt(berlin, Date.UTC(2025, 6, 1)), 120, 'summer');
  assert.equal(tz.clusterOffsetAt(berlin, NOV), 60, 'winter');
  assert.equal(tz.clusterOffsetAt({ mode: 'detected', zone: null, offsetMinutes: 330 }, NOV), 330);
  assert.equal(tz.clusterOffsetAt({ mode: 'none', pct: 41 }, NOV), null, 'not detected: nothing taken out');
  assert.equal(tz.clusterOffsetAt(null, NOV), null);
  assert.equal(tz.clusterOffsetAt({ mode: 'set', zone: 'UTC', offsetMinutes: 0 }, NOV), 0);
});

test('correct(): the raw gap minus the cluster offset; unknown is not zero', () => {
  const c = tz.correct(332, IST, NOV);
  assert.deepEqual(c, { rawGapMinutes: 332, offsetMinutes: 330, delayMinutes: 2, deviceOffset: 330 });
  const sg = tz.correct(481, IST, NOV);
  assert.equal(sg.delayMinutes, 151, 'against the cluster: the browser cannot know it is steady');
  assert.equal(sg.deviceOffset, 480, 'but says which offset the gap sits at');
  assert.equal(tz.correct(370, IST, NOV).delayMinutes, 40, '330 + 40 late');
  assert.equal(tz.correct(330, { mode: 'none' }, NOV).delayMinutes, 330, 'no zone: as measured');
  assert.equal(tz.correct(330, null, NOV).offsetMinutes, null);
  assert.deepEqual(tz.correct(null, IST, NOV), { rawGapMinutes: null, offsetMinutes: null, delayMinutes: null, deviceOffset: null });
});

test('docDelay and recordFrom carry the raw gap, the offset taken out and the corrected delay', () => {
  const arrival = new Date(NOV).toISOString();
  const event = new Date(NOV - 332 * 60000).toISOString();
  const src = { '@timestamp': arrival, event_created: event };
  const plain = ld.docDelay(src, '@timestamp', ['event_created']);
  assert.equal(plain.delayMinutes, 332, 'no zone: the raw gap');
  assert.equal(plain.rawGapMinutes, 332);
  assert.equal(plain.tzOffsetMinutes, null);
  const d = ld.docDelay(src, '@timestamp', ['event_created'], IST);
  assert.equal(d.delayMinutes, 2);
  assert.equal(d.rawGapMinutes, 332);
  assert.equal(d.tzOffsetMinutes, 330);
  assert.equal(d.deviceTzOffset, 330);
  const bucket = { key: 'fw-1', doc_count: 3, latest: { hits: { hits: [{ _source: src }] } } };
  const r = ld.recordFrom(bucket, { arrival: '@timestamp', eventTimes: ['event_created'], metadata: [] }, T, IST);
  assert.equal(r.status, 'OK', 'on time once the zone is taken out');
  assert.equal(r.delayMinutes, 2);
  assert.equal(r.rawGapMinutes, 332);
  assert.equal(r.clusterTzOffset, 330);
  assert.equal(r.pattern, 'timezone', 'the raw gap sits at a real offset');
  assert.ok(r.patternNote.includes('5 h 30') && r.patternNote.includes('+05:30'), r.patternNote);
  const raw = ld.recordFrom(bucket, { arrival: '@timestamp', eventTimes: ['event_created'], metadata: [] }, T, null);
  assert.equal(raw.status, 'CRITICAL', 'without the zone the offset reads as a delay — what the dashboard showed before');
  const docs = ld.documentDelays([{ _id: 'a', _index: 'i', _source: src }], { arrival: '@timestamp', eventTimes: ['event_created'], metadata: [] }, T, IST);
  assert.equal(docs[0].delayMinutes, 2);
  assert.equal(docs[0].status, 'OK');
});

test('analysePattern knows half- and quarter-hour offsets (not only whole hours)', () => {
  assert.equal(ld.analysePattern(330).pattern, 'timezone', 'IST');
  assert.equal(ld.analysePattern(345).pattern, 'timezone', 'Nepal');
  assert.equal(ld.analysePattern(-210).pattern, 'timezone', 'Newfoundland, ahead');
  assert.equal(ld.analysePattern(60).pattern, 'timezone');
  assert.equal(ld.analysePattern(40).pattern, '-');
  assert.equal(ld.analysePattern(2).pattern, '-', 'UTC itself is not an offset to report');
  assert.equal(ld.analysePattern(100).pattern, '-');
  assert.equal(ld.analysePattern(26 * 60).pattern, 'very-long');
});

test('the texts: chip, column, device time zone, the delay sum', () => {
  assert.equal(tz.timeZoneText({ ...IST, agree: 1112, of: 1240, pct: 89.7 }), 'Asia/Kolkata +05:30 · detected · 1,112 of 1,240 devices (90 %)');
  assert.equal(tz.timeZoneText({ mode: 'detected', zone: null, offsetMinutes: 480, offset: '+08:00', pct: 100 }, { devices: false }), '+08:00 · detected (100 % agree)', 'no name is invented');
  assert.equal(tz.timeZoneText({ mode: 'set', zone: 'America/New_York', offset: '−05:00' }), 'America/New_York −05:00 · set');
  assert.equal(tz.timeZoneText({ mode: 'none', pct: 41.2 }), 'not detected (41 % agree)');
  assert.equal(tz.timeZoneText({ mode: 'none' }), 'not detected');
  assert.equal(tz.timeZoneText(null), '—');
  assert.equal(tz.timeZoneShort(IST), 'Asia/Kolkata · detected');
  assert.equal(tz.timeZoneShort({ mode: 'set', zone: 'UTC', offset: '+00:00' }), 'UTC · set');
  assert.equal(tz.timeZoneShort({ mode: 'none', pct: 41.2 }), 'not detected (41 % agree)');
  const same = { state: 'delay', nowMinutes: 42, rawGapMinutes: 372, tzOffsetMinutes: 330, deviceTzOffset: null, clusterTzOffset: 330, lastArrival: NOV, lastEvent: NOV - 372 * 60000 };
  assert.equal(tz.deviceZoneText(same), 'same as cluster');
  assert.equal(tz.deviceZoneText({ state: 'other_tz', nowMinutes: 1, tzOffsetMinutes: 480, deviceTzOffset: 480, clusterTzOffset: 330 }), '+08:00');
  assert.equal(tz.deviceZoneText({ state: 'no_delay', nowMinutes: 2, clusterTzOffset: null }), '—', 'no cluster zone: nothing to compare against');
  assert.equal(tz.deviceZoneText({ state: 'silent', nowMinutes: null, clusterTzOffset: 330 }), '—');
  assert.equal(tz.deviceZoneText({ state: 'critical', nowMinutes: 151, live: true, deviceTzOffset: 480, clusterTzOffset: 330 }), 'looks like +08:00', 'a live row cannot know it is steady');
  const fmt = (ms) => new Date(ms).toISOString().slice(11, 19);
  assert.equal(tz.delaySumText(same, fmt), 'arrival 09:00:00 − event 02:48:00 − time zone 5 h 30 = 42 min (raw gap 372 min)');
  assert.equal(tz.delaySumText({ state: 'delay', nowMinutes: 42, tzOffsetMinutes: null, lastArrival: NOV, lastEvent: NOV - 42 * 60000 }, fmt), 'arrival 09:00:00 − event 08:18:00 = 42 min');
  assert.equal(tz.delaySumText({ state: 'silent', nowMinutes: null }, fmt), '');
  const opts = tz.zoneOptions(NOV, { detectedText: 'Asia/Kolkata +05:30' });
  assert.deepEqual(opts[0], ['detect', 'Detect from devices (now: Asia/Kolkata +05:30)']);
  assert.deepEqual(opts[1], ['UTC', 'UTC (no correction)']);
  assert.ok(opts.some(([v, l]) => v === 'Asia/Kolkata' && l === 'Asia/Kolkata (+05:30)'));
  assert.ok(!opts.some(([v]) => v.startsWith('Etc/')));
  const offs = opts.slice(2).map(([, l]) => l.match(/\(([−+])(\d\d):(\d\d)\)$/)).map((m) => (m[1] === '−' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])));
  assert.ok(offs.every((o, i) => i === 0 || offs[i - 1] <= o), 'sorted by offset');
});

test('delay-levels remembers each cluster’s time zone from the core, never guesses one', () => {
  lv.forgetLevels();
  assert.equal(lv.zoneOf('a'), null);
  assert.ok(lv.rememberLevels({ ok: true, byCluster: [{ id: 'a', levels: T, timeZone: IST }, { id: 'b', levels: T, timeZone: { mode: 'none', pct: 41 } }, { id: 'c', levels: T }] }));
  assert.equal(lv.zoneOf('a').offsetMinutes, 330);
  assert.equal(lv.zoneOf('b').mode, 'none');
  assert.equal(lv.zoneOf('c'), null, 'no timeZone said: null');
  assert.ok(lv.rememberLevels({ ok: true, cluster: 'd', levels: T, timeZone: { mode: 'set', zone: 'UTC', offsetMinutes: 0 } }), 'a cluster answer');
  assert.equal(lv.zoneOf('d').mode, 'set');
  assert.equal(lv.zoneFrom({ mode: 'maybe' }), null);
  assert.equal(lv.levelState(1, T), 'no_delay');
  assert.equal(lv.STATE_LABEL.other_tz, 'other time zone');
  assert.equal(lv.STATUS_OF_STATE.other_tz, 'OTHER_TZ');
  lv.forgetLevels();
});
