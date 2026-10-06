/**
 * Freshness reporting.
 *
 * Pages serve cached data, so the age on screen is what makes that safe. The cases
 * below are the ones where a wrong answer is worse than no answer: never-fetched must
 * not read as "just now", and a fleet figure must describe the stalest cluster, not the
 * freshest — otherwise one recently-refreshed cluster makes the whole fleet look current.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { isStale, STALE_AFTER_MS, freshnessText, UNREACHABLE_RETRY_MS } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/lib/freshness.js')).href);
const { stampFetch, fetchedAt, oldestFetch, state } =
  await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);

test('never fetched is 0, not now', () => {
  assert.equal(fetchedAt('nope', 'indices'), 0);
  assert.equal(isStale(0), false, 'never-fetched is not "stale", it is unknown');
});

test('a stamp is per cluster AND per dataset', () => {
  stampFetch('c1', 'indices');
  assert.ok(fetchedAt('c1', 'indices') > 0);
  assert.equal(fetchedAt('c1', 'data'), 0, 'stamping indices must not imply disk stats');
  assert.equal(fetchedAt('c2', 'indices'), 0, 'stamping one cluster must not imply another');
});

test('staleness is decided by the threshold, not by feel', () => {
  const now = Date.now();
  assert.equal(isStale(now - 1000, now), false);
  assert.equal(isStale(now - STALE_AFTER_MS - 1, now), true);
  assert.equal(isStale(now - STALE_AFTER_MS + 1, now), false, 'exactly at the threshold is not yet stale');
});

test('a fleet figure reports the OLDEST cluster', () => {
  state.fetchedAt['a:indices'] = 1000;
  state.fetchedAt['b:indices'] = 9000;
  assert.equal(oldestFetch(['a', 'b'], 'indices'), 1000,
    'reporting the newest would let one fresh cluster make a stale fleet look current');
});

test('a fleet figure is unknown until every cluster has been read', () => {
  state.fetchedAt['a:indices'] = 1000;
  delete state.fetchedAt['zz:indices'];
  assert.equal(oldestFetch(['a', 'zz'], 'indices'), 0,
    'one unread cluster means the fleet age is not known — not that it equals the read one');
});

/* ---- the fleet cache's per-dataset freshness (lib/freshness.js freshnessText) ---- */

const MIN = 60 * 1000;

test('a bare timestamp reads exactly as it did before the cache', () => {
  const now = Date.now();
  assert.equal(freshnessText('Indices', { ts: now - 2 * MIN }, now).text, 'Indices fetched 2 m ago');
  assert.equal(freshnessText('Indices', { ts: 0 }, now).text, 'Indices not fetched yet');
  assert.equal(freshnessText('Indices', { ts: now - 1000 }, now).text, 'Indices fetched just now');
});

test('ok: "health fetched N ago", stale by the ENTRY\'s threshold, not the global one', () => {
  const now = Date.now();
  const f = { ts: now - 10 * MIN, status: 'ok', staleAfterMs: 2 * 3600 * 1000 };
  const w = freshnessText('policies', f, now);
  assert.equal(w.text, 'policies fetched 10 m ago');
  assert.equal(w.stale, false, 'ten minutes is not stale for a dataset polled hourly');
  assert.equal(freshnessText('health', { ts: now - 10 * MIN, status: 'ok', staleAfterMs: 6 * MIN }, now).stale, true);
  assert.equal(isStale(now - 10 * MIN, now, 2 * 3600 * 1000), false);
  assert.equal(isStale(now - 10 * MIN, now), true, 'without a threshold the old five minutes still applies');
});

test('unreachable: unknown, since when, and how often it is retried', () => {
  const now = Date.now();
  const since = new Date(2026, 8, 29, 10, 4).getTime();
  const w = freshnessText('health', { ts: 0, status: 'error', reach: { state: 'unreachable', since },
    error: { kind: 'timeout', message: 'connect timed out' } }, now);
  assert.equal(w.text, 'health unknown — unreachable since 10:04, retrying every 2 min');
  assert.equal(w.unknown, true);
  assert.equal(UNREACHABLE_RETRY_MS, 120000);
});

test('a failed fetch with a last good value names that value\'s age', () => {
  const now = Date.now();
  const w = freshnessText('nodes', { ts: now - 30 * MIN, status: 'error', error: { message: 'HTTP 503' } }, now);
  assert.equal(w.text, 'nodes unknown — last fetch failed: HTTP 503 (showing what was fetched 30 m ago)');
  assert.equal(w.stale, true);
});

test('restored and never', () => {
  const now = Date.now();
  assert.equal(freshnessText('health', { ts: now - 3 * 3600 * 1000, status: 'restored' }, now).text,
    'health restored from cache (before restart), refreshing…');
  const never = freshnessText('health', { ts: 0, status: 'never' }, now);
  assert.equal(never.text, 'health never fetched');
  assert.equal(never.stale, false, 'never is unknown, not old');
  assert.equal(never.unknown, true);
});
