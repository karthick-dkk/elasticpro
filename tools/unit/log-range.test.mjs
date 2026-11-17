/**
 * The Log Delay page's time range and clock (ui/js/core/log-range.js): what "Last 5 minutes"
 * covers, a custom from/to that is not whole (never a guessed window), and a time written in the
 * server's zone with its offset in the column head.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/log-range.js')).href);

test('the ranges each selector offers, in order: the boards 30m to 60d, the live tabs 5m to 12h', () => {
  assert.deepEqual([...R.BOARD_RANGES], ['30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '7d', '15d', '30d', '60d', 'custom']);
  assert.deepEqual([...R.LIVE_RANGES], ['5m', '10m', '30m', '1h', '3h', '12h', 'custom']);
  assert.ok(!R.BOARD_RANGES.includes('5m') && !R.BOARD_RANGES.includes('10m'), 'no 5m or 10m on the boards');
  assert.deepEqual(R.BOARD_RANGES.filter((id) => R.rangeDays(id) !== null), ['1d', '3d', '7d', '15d', '30d', '60d'], 'the More menu holds the day ranges');
  assert.equal(R.LIVE_RANGES.filter((id) => R.rangeDays(id) !== null).length, 0, 'no day range on the live tabs');
  assert.equal(R.rangeDays('7d'), 7);
  assert.equal(R.rangeDays('8h'), null);
  assert.equal(R.rangeLabel('60d'), 'Last 60 days');
  assert.equal(R.rangeLabel('1d'), 'Today');
  assert.equal(R.DEFAULT_RANGE, '1h');
  assert.ok(R.BOARD_RANGES.includes(R.DEFAULT_RANGE) && R.LIVE_RANGES.includes(R.DEFAULT_RANGE), 'the default is in both sets');
  assert.ok(60 <= R.BOARD_MAX_DAYS, 'the longest fixed range is inside what the core takes');
});

test('a range from the other set becomes the shortest of this one that covers as much, else its longest', () => {
  const B = R.BOARD_RANGES; const L = R.LIVE_RANGES;
  assert.deepEqual(R.normaliseRange({ id: '5m' }, B), { id: '30m' }, 'an old 5m board is 30m');
  assert.deepEqual(R.normaliseRange({ id: '10m' }, B), { id: '30m' });
  assert.deepEqual(R.normaliseRange({ id: '3h' }, B), { id: '4h' });
  assert.deepEqual(R.normaliseRange({ id: '12h' }, B), { id: '12h' });
  assert.deepEqual(R.normaliseRange({ id: '7d' }, L), { id: '12h' }, 'a 7d on Live is 12h');
  assert.deepEqual(R.normaliseRange({ id: '60d' }, L), { id: '12h' });
  assert.deepEqual(R.normaliseRange({ id: '2h' }, L), { id: '3h' });
  assert.deepEqual(R.normaliseRange({ id: '8h' }, L), { id: '12h' });
  assert.deepEqual(R.normaliseRange({ id: '30d' }, B), { id: '30d' });
  assert.deepEqual(R.normaliseRange({ id: 'custom', from: 1, to: 2 }, B), { id: 'custom', from: 1, to: 2 }, 'custom is in both');
  assert.deepEqual(R.normaliseRange({ id: 'bogus' }, B), { id: '1h' });
  assert.deepEqual(R.normaliseRange(null, L), { id: '1h' });
  assert.deepEqual(R.normaliseRange({ id: 'toString' }), { id: '1h' }, 'not a prototype key');
});

test('a day range is that many whole local days ending today, from the first day’s midnight in the zone', () => {
  // 2026-11-17 08:30 in India (03:00 UTC).
  const now = Date.UTC(2026, 10, 17, 3, 0, 0);
  const ist = (y, mo, d) => Date.UTC(y, mo - 1, d, 0, 0, 0) - 330 * 60000;
  assert.deepEqual(R.rangeBounds({ id: '1d' }, now, 'Asia/Kolkata'), { from: ist(2026, 11, 17), to: now }, 'today since midnight');
  assert.deepEqual(R.rangeBounds({ id: '7d' }, now, 'Asia/Kolkata'), { from: ist(2026, 11, 11), to: now }, '7 days: the 11th to the 17th');
  assert.deepEqual(R.rangeBounds({ id: '60d' }, now, 'Asia/Kolkata'), { from: ist(2026, 9, 19), to: now }, '60 days: 19 Sep to 17 Nov');
  // The same instant is still the 16th in New York: its 3 days are the 14th to the 16th.
  const ny = R.rangeBounds({ id: '3d' }, now, 'America/New_York');
  assert.equal(R.zonedText(ny.from, 'America/New_York'), '2026-11-14 00:00:00');
  assert.equal(R.rangeWords({ id: '7d' }), 'the last 7 days');
  assert.equal(R.rangeWords({ id: '1d' }), 'today');
  assert.equal(R.rangeText({ id: '15d' }), 'Last 15 days');
  assert.deepEqual(R.rangeBounds({ id: '8h' }, now), { from: now - 8 * 3600000, to: now });
});

test('a "Last …" range ends now; a custom one is its own two ends, or nothing', () => {
  const now = Date.UTC(2026, 10, 13, 3, 0, 0);
  assert.deepEqual(R.rangeBounds({ id: '5m' }, now), { from: now - 5 * 60000, to: now });
  assert.deepEqual(R.rangeBounds({ id: '12h' }, now), { from: now - 12 * 3600000, to: now });
  assert.equal(R.rangeMinutes({ id: '3h' }, now), 180);
  assert.deepEqual(R.rangeBounds({ id: 'custom', from: 1000, to: 5000 }), { from: 1000, to: 5000 });
  assert.equal(R.rangeBounds({ id: 'custom', from: 5000, to: 1000 }), null, 'from after to');
  assert.equal(R.rangeBounds({ id: 'custom', from: 5000 }), null, 'one end missing');
  assert.deepEqual(R.normaliseRange({ id: 'bogus' }), { id: '1h' }, 'an unknown range is the default');
  assert.deepEqual(R.normaliseRange(null), { id: '1h' });
});

test('the server zone: offset, time, and a datetime-local value read back in that zone', () => {
  const at = Date.UTC(2026, 10, 13, 3, 19, 7);
  assert.equal(R.zoneOffsetMinutes('Asia/Kolkata', at), 330);
  assert.equal(R.offsetText(330), 'UTC +05:30');
  assert.equal(R.offsetText(-180), 'UTC −03:00');
  assert.equal(R.offsetText(0), 'UTC +00:00');
  assert.equal(R.zonedText(at, 'Asia/Kolkata'), '2026-11-13 08:49:07');
  assert.equal(R.zonedText(at, 'UTC', { seconds: false }), '2026-11-13 03:19');
  assert.equal(R.zonedText(null, 'UTC'), '—', 'an unknown time is not the epoch');
  assert.equal(R.zonedInputValue(at, 'Asia/Kolkata'), '2026-11-13T08:49');
  assert.equal(R.fromZonedInput('2026-11-13T08:49', 'Asia/Kolkata'), Date.UTC(2026, 10, 13, 3, 19, 0));
  assert.equal(R.fromZonedInput('2026-07-01T12:00', 'Europe/Berlin'), Date.UTC(2026, 6, 1, 10, 0, 0), 'summer time');
  assert.equal(R.fromZonedInput('', 'UTC'), null);
  assert.equal(R.rangeText({ id: '30m' }), 'Last 30 minutes');
  assert.equal(R.rangeText({ id: 'custom', from: at, to: at + 3600000 }, 'Asia/Kolkata'), '2026-11-13 08:49 → 09:49');
});
