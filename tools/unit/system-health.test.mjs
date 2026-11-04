/**
 * Requests › ElasticPro health (docs/HEALTH.md), the pure half: which tab a hash opens, the nav
 * dot from PING, and that a figure the core could not read is "not known" — never 0, never green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const S = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/system-health.js')).href);

test('the tab comes from the hash', () => {
  assert.equal(S.tabOfHash('#/requests/health'), 'health');
  assert.equal(S.tabOfHash('#/requests'), 'log');
  assert.equal(S.tabOfHash('#/requests/other'), 'log');
  assert.equal(S.tabOfHash('#/reports/health'), 'log');
  assert.equal(S.tabHash('health'), '#/requests/health');
  assert.equal(S.tabHash('log'), '#/requests');
  assert.deepEqual(S.REQUEST_TABS.map((t) => t.label), ['Requests', 'ElasticPro health']);
});

test('the nav dot is there for amber and red only', () => {
  assert.equal(S.navDot({ health: 'ok' }), null);
  assert.equal(S.navDot({}), null, 'an older core, or not an administrator');
  assert.equal(S.navDot(null), null);
  assert.equal(S.navDot({ health: 'warn' }).tone, 'yellow');
  assert.equal(S.navDot({ health: 'bad' }).tone, 'red');
});

test('unknown is not zero and never green', () => {
  assert.equal(S.levelTone('unknown'), 'grey');
  assert.equal(S.levelWord('unknown'), 'not known');
  assert.equal(S.levelWord(undefined), 'not known');
  assert.deepEqual(S.memoryLine({ rssBytes: null }), { text: 'not known', frac: null, pct: null });
  assert.equal(S.memoryLine({ rssBytes: 1024 * 1024 * 300, limitBytes: null }).text, '300 MB · no limit');
  const m = S.memoryLine({ rssBytes: 900, limitBytes: 1000, usedPct: 90 });
  assert.equal(m.pct, 90);
  assert.equal(m.frac, 0.9);
  assert.equal(S.oomText({ oomKills: null }), 'not known');
  assert.equal(S.oomText({ oomKills: 0, oomKills24h: 0 }), 'none');
  assert.equal(S.oomText({ oomKills: 2, oomKills24h: 1 }), '2 (1 in 24 h)');
  assert.equal(S.cpuLine({ pct1m: null }), 'not known yet');
  assert.equal(S.cpuLine({ pct1m: 37.2, limitCpus: 1.5, pctOfLimit: 24.8 }), '37% of one CPU · 25% of its 1.5');
  assert.equal(S.throttleLine({ pct1m: 3, nrPeriods: null }), 'no CPU limit');
  assert.equal(S.throttleLine({ throttledPct5m: 12.4 }), '12% of periods');
  assert.equal(S.throttleLine(null), 'not known');
  assert.equal(S.cpuLine({ readable: false }), 'not known', 'no cgroup: not known, not "no limit"');
  assert.equal(S.throttleLine({ readable: false }), 'not known');
  assert.equal(S.shareLine(null), 'not known');
  assert.equal(S.sizeText(null), 'not known');
  assert.equal(S.msText(null), '—');
  assert.equal(S.msText(1400), '1.4 s');
  assert.equal(S.pctText(undefined), 'not known');
});

test('trends leave unknown minutes out and draw a line from two points', () => {
  const t = { fields: ['t', 'rss', 'p95Ms'], points: [[1000, 10, null], [2000, null, 5], [3000, 30, 7]] };
  assert.deepEqual(S.trendSeries(t, 'rss'), [[1000, 10], [3000, 30]]);
  assert.deepEqual(S.trendSeries(t, 'nope'), []);
  assert.equal(S.sparkPath([[1000, 1]], { now: 3000, spanMs: 2000 }), '');
  const p = S.sparkPath([[1000, 0], [3000, 10]], { w: 100, h: 20, now: 3000, spanMs: 2000 });
  assert.equal(p, '0.0,19.0 100.0,1.0');
});

test('problems come worst first, and job progress says what the job carries', () => {
  const p = S.problems([{ id: 'a', level: 'ok' }, { id: 'b', level: 'warn' }, { id: 'c', level: 'bad' }, { id: 'd', level: 'unknown' }]);
  assert.deepEqual(p.map((c) => c.id), ['c', 'b']);
  assert.equal(S.jobProgress({ progress: { done: 1, total: 4 }, day: '2026-11-03', partitions: { done: 3, total: 8 }, pages: 12, rows: 4000 }),
    '1/4 · day 2026-11-03 · partitions 3/8 · 12 pages · 4,000 rows');
  assert.equal(S.concurrencyText({ concurrency: null }), 'not reported');
  assert.equal(S.concurrencyText({ concurrency: 2, halvings: 1, lastReason: '429 from c2' }), '2 (halved 1×: 429 from c2)');
});
