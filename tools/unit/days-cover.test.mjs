/** A partial month total says how many days it covers (one definition: daysCoverText). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const VD = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume-daily.js')).href);

test('daysCoverText words the count against the days it could cover', () => {
  assert.equal(VD.daysCoverText(23, 30), '23 of 30 days');
  assert.equal(VD.daysCoverText(1, 1), '1 of 1 day');
});

test('the month so far reports measured days apart from the days elapsed', () => {
  const rec = { days: [{ day: '2026-11-01', eventBytes: 10 }, { day: '2026-11-02' }, { day: '2026-11-03', eventBytes: 5 }] };
  const m = VD.eventMonthSoFar(rec, { today: '2026-11-05' });
  assert.equal(m.days, 4);
  assert.ok(m.measured < m.days);
});
