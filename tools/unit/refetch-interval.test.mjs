/**
 * The throttle behind elasticpro-scrape.mjs's --indices-every: skip re-listing a cluster's
 * indices when the last run's listing is still within the interval, fetch when it is not
 * (or when nothing was ever remembered).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFreshEnough } from '../lib/refetch-interval.mjs';

test('nothing remembered — never fresh, always fetch', () => {
  assert.equal(isFreshEnough(null, 1_000_000, 30 * 60000), false);
  assert.equal(isFreshEnough(undefined, 1_000_000, 30 * 60000), false);
});

test('within the interval — fresh, skip fetching', () => {
  const intervalMs = 30 * 60000;
  const at = 1_000_000;
  const now = at + 10 * 60000;   // 10 minutes later, inside a 30-minute window
  assert.equal(isFreshEnough({ at }, now, intervalMs), true);
});

test('exactly at the interval boundary is not fresh — refetch rather than run stale forever', () => {
  const intervalMs = 30 * 60000;
  const at = 1_000_000;
  assert.equal(isFreshEnough({ at }, at + intervalMs, intervalMs), false);
});

test('past the interval — stale, fetch again', () => {
  const intervalMs = 30 * 60000;
  const at = 1_000_000;
  const now = at + 45 * 60000;
  assert.equal(isFreshEnough({ at }, now, intervalMs), false);
});

test('a record with no `at` is treated as fetched at time zero — stale on any real clock', () => {
  assert.equal(isFreshEnough({}, Date.now(), 30 * 60000), false);
});
