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

test('the ranges the selector offers, in order', () => {
  assert.deepEqual(R.RANGES.map(([id]) => id), ['1m', '5m', '30m', '1h', '2h', '3h', '6h', '8h', '12h', 'custom']);
});

test('a "Last …" range ends now; a custom one is its own two ends, or nothing', () => {
  const now = Date.UTC(2026, 10, 13, 3, 0, 0);
  assert.deepEqual(R.rangeBounds({ id: '5m' }, now), { from: now - 5 * 60000, to: now });
  assert.deepEqual(R.rangeBounds({ id: '12h' }, now), { from: now - 12 * 3600000, to: now });
  assert.equal(R.rangeMinutes({ id: '8h' }, now), 480);
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
