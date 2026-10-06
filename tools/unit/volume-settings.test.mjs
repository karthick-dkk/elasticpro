/**
 * How the daily volume figure is calculated, now that the window and the
 * heaviest-N come from config rather than being baked into the arithmetic.
 *
 * The figure these produce is the one every capacity number on the volume report is
 * multiplied out from, so a setting that is silently ignored does not show up as a
 * broken page — it shows up as a disk estimate that is wrong by a third.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { dailyVolume, volumeSettings, VOLUME_DEFAULTS } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/volume.js')).href);

const GB = 1024 ** 3;

/** n complete days ending yesterday, newest first, sized by the given list. */
function indicesOf(sizesNewestFirst) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < sizesNewestFirst.length; i++) {
    d.setUTCDate(d.getUTCDate() - (i === 0 ? 1 : 1));
    out.push({ day: d.toISOString().slice(0, 10), size: sizesNewestFirst[i] * GB });
  }
  return out;
}

test('defaults are unchanged: 3 heaviest of 7', () => {
  assert.deepEqual(volumeSettings({}), { windowDays: 7, topDays: 3, headroomPercent: 30 });
  assert.deepEqual(VOLUME_DEFAULTS, { windowDays: 7, topDays: 3, headroomPercent: 30 });
});

test('the window and heaviest-N come from the cluster config', () => {
  const s = volumeSettings({ volumeWindowDays: 14, volumeTopDays: 5, volumeHeadroomPercent: 50 });
  assert.deepEqual(s, { windowDays: 14, topDays: 5, headroomPercent: 50 });
});

test('topDays above the window is clamped, not silently treated as the whole window', () => {
  // A hand-edited YAML saying "top 30 of 7" means something impossible. Clamping makes
  // it a plain mean of 7 — which is a legitimate choice, but only because it was asked
  // for, and the clamped value is what the report then states it used.
  assert.equal(volumeSettings({ volumeWindowDays: 7, volumeTopDays: 30 }).topDays, 7);
});

test('nonsense settings fall back rather than producing NaN', () => {
  assert.equal(volumeSettings({ volumeWindowDays: 0 }).windowDays, 1);
  assert.equal(volumeSettings({ volumeWindowDays: -5 }).windowDays, 1);
  assert.equal(volumeSettings({ volumeTopDays: 0 }).topDays, 1);
  assert.equal(volumeSettings({ volumeWindowDays: 'abc' }).windowDays, VOLUME_DEFAULTS.windowDays);
  assert.equal(volumeSettings({ volumeHeadroomPercent: -10 }).headroomPercent, 0);
});

test('topDays 1 sizes against the peak day', () => {
  const idx = indicesOf([10, 100, 20, 30, 40, 50, 60]);
  const v = dailyVolume(idx, { volumeTopDays: 1 });
  assert.equal(v.perDay / GB, 100, 'the single heaviest day');
});

test('topDays equal to the window is a plain mean', () => {
  const idx = indicesOf([10, 20, 30, 40]);
  const v = dailyVolume(idx, { volumeWindowDays: 4, volumeTopDays: 4 });
  assert.equal(v.perDay / GB, 25);
});

test('a wider window pulls in older days the default would have ignored', () => {
  // 10 days, with the two heaviest sitting at positions 8 and 9 — outside a 7-day window.
  const idx = indicesOf([1, 1, 1, 1, 1, 1, 1, 100, 100, 1]);
  const narrow = dailyVolume(idx, { volumeWindowDays: 7, volumeTopDays: 2 });
  const wide = dailyVolume(idx, { volumeWindowDays: 10, volumeTopDays: 2 });
  assert.equal(narrow.perDay / GB, 1, 'the spike is outside the default window');
  assert.equal(wide.perDay / GB, 100, 'a wider window sees it');
});

test('the report states the settings it actually used', () => {
  const v = dailyVolume(indicesOf([5, 5, 5]), { volumeWindowDays: 3, volumeTopDays: 2 });
  assert.deepEqual(v.settings, { windowDays: 3, topDays: 2, headroomPercent: 30 });
  assert.match(v.basis, /2 heaviest of the last 3 day/,
    'the basis line must describe the configured window, not the default one');
});

test('today is still never counted', () => {
  const today = new Date().toISOString().slice(0, 10);
  const v = dailyVolume([{ day: today, size: 999 * GB }], {});
  assert.equal(v.perDay, 0, "today's index is still being written to");
  assert.equal(v.daysCovered, 0);
});
