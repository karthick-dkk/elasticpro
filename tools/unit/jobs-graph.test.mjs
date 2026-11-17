/**
 * The Jobs tab's graphical view, its pure half (ui/js/core/jobs-graph.js): a run's result, the
 * 24-hour success rate (partial when the run log kept only a job's newest runs), the run lanes,
 * a running job's time left (never a guess), the ticks, and the check tiles' words.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const G = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/jobs-graph.js')).href);

const NOW = 1_793_944_800_000;
const H = 3600e3;
const run = (o) => ({ id: 'r', jobId: 'volume.daily', status: 'completed', createdAt: NOW - H, startedAt: NOW - H, endedAt: NOW - H + 2000, progress: null, ...o });

test('a run\'s result: ok, warning, failed, running', () => {
  assert.equal(G.resultOf(run({})), 'ok');
  for (const s of ['deferred', 'skipped', 'cancelled']) assert.equal(G.resultOf(run({ status: s })), 'warn', s);
  assert.equal(G.resultOf(run({ status: 'failed' })), 'bad');
  assert.equal(G.resultOf(run({ status: 'running', endedAt: null })), 'run');
  assert.equal(G.resultOf(run({ status: 'queued', endedAt: null })), 'run');
  assert.equal(G.resultOf(null), null);
  assert.equal(G.resultMark('ok'), '✓');
  assert.equal(G.resultMark('warn'), '⚠');
});

test('success over 24 hours: counts by result, the rate, partial when a job kept only its newest runs', () => {
  const runs = [run({ id: 'a' }), run({ id: 'b', status: 'failed' }), run({ id: 'c', status: 'deferred' }), run({ id: 'd' }),
    run({ id: 'old', endedAt: NOW - 30 * H }), run({ id: 'open', status: 'running', endedAt: null })];
  const s = G.successOf(runs, { from: NOW - 24 * H, now: NOW });
  assert.deepEqual([s.ok, s.warn, s.bad, s.total], [2, 1, 1, 4]);
  assert.equal(s.pct, 50);
  assert.equal(s.partial, false);
  assert.equal(G.successOf([], { from: NOW - 24 * H, now: NOW }).pct, null, 'no runs: no rate, never 0 % or 100 %');
  const many = Array.from({ length: G.KEPT_PER_JOB }, (_, i) => run({ id: `p${i}`, jobId: 'zabbix.push', endedAt: NOW - i * 60e3 }));
  const p = G.successOf(many, { from: NOW - 24 * H, now: NOW });
  assert.equal(p.partial, true);
  assert.deepEqual(p.partialJobs, ['zabbix.push']);
  assert.equal(G.pctWord(99.6), '99.6 %', '99.6 never reads 100');
  assert.equal(G.pctWord(94.2), '94 %');
  assert.equal(G.pctWord(null), '—');
});

test('time left: linear from the core\'s percent, only once it means something', () => {
  const r = run({ status: 'running', endedAt: null, startedAt: NOW - 100_000, progress: 64 });
  assert.equal(G.timeLeftMs(r, NOW), Math.round((100_000 * 36) / 64));
  assert.match(G.elapsedText(r, NOW), /^running 1m 40s · about 56 s left$/);
  assert.equal(G.timeLeftMs({ ...r, progress: null }, NOW), null, 'no percent: no time left');
  assert.equal(G.timeLeftMs({ ...r, progress: 3 }, NOW), null, 'under 5 %: a guess');
  assert.equal(G.timeLeftMs({ ...r, startedAt: NOW - 4000 }, NOW), null, 'under 10 s: a guess');
  assert.equal(G.elapsedText({ ...r, progress: null, startedAt: NOW - 4000 }, NOW), 'running 4 s');
  assert.equal(G.elapsedText(run({ status: 'queued', startedAt: null, endedAt: null, createdAt: NOW - 12_000 }), NOW), 'queued 12 s ago');
});

test('lanes: one per job in the registry order, bars inside the window, a run of milliseconds still seen, the next run', () => {
  const jobs = [{ id: 'logdelay.measure', name: 'Log delay', state: { nextRunAt: NOW + H } }, { id: 'volume.daily', name: 'Volume', state: { nextRunAt: null } }];
  const runs = [
    run({ id: 'v1', startedAt: NOW - 12 * H, endedAt: NOW - 12 * H + 5 }),
    run({ id: 'v0', startedAt: NOW - 30 * H, endedAt: NOW - 30 * H + 5 }),
    run({ id: 'l1', jobId: 'logdelay.measure', status: 'running', startedAt: NOW - 6 * H, endedAt: null }),
    run({ id: 'gone', jobId: 'report.schedule.0a1b', startedAt: NOW - H, endedAt: NOW - H + 1000 }),
  ];
  const ls = G.lanes(jobs, runs, { from: NOW - 24 * H, now: NOW });
  assert.deepEqual(ls.map((l) => l.id), ['logdelay.measure', 'volume.daily', 'report.schedule.0a1b']);
  const [ld, vol] = ls;
  assert.equal(vol.bars.length, 1, 'the run before the window is not drawn');
  assert.ok(Math.abs(vol.bars[0].x - 0.5) < 1e-9);
  assert.ok(vol.bars[0].w >= 0.002, 'a 5 ms run is still a visible bar');
  assert.equal(ld.bars[0].result, 'run');
  assert.ok(Math.abs(ld.bars[0].x + ld.bars[0].w - 1) < 1e-9, 'a running run reaches now');
  assert.deepEqual(ld.next, { at: NOW + H, beyond: true });
  assert.equal(vol.next, null, 'no next time: no dashed bar, nothing guessed');
});

test('ticks: hour marks inside the window, at most eight steps', () => {
  const t = G.ticks(NOW - 24 * H, NOW);
  assert.ok(t.length <= 9 && t.length >= 4, String(t.length));
  assert.ok(t.every((x) => x.x >= 0 && x.x <= 1));
  assert.ok(t.every((x) => x.t % (3 * H) === 0));
  assert.ok(G.ticks(NOW - H, NOW).length >= 1);
});

test('the check tiles: one definition of which line each check draws, and its words', () => {
  assert.deepEqual(G.CHECK_TILES.map((c) => c.check), ['core.memory', 'worker.memory', 'messages.p95', 'gate.refused', 'poller.late', 'disk.free']);
  assert.deepEqual(G.HEALTH_TILES.map((t) => t.field), ['workerCpu', 'coreCpu', 'coreMem', 'rps', 'busy']);
  assert.equal(G.levelShort('ok'), 'ok');
  assert.equal(G.levelShort('warn'), 'watch');
  assert.equal(G.levelShort('bad'), 'over');
  assert.equal(G.levelShort('unknown'), 'not known');
  assert.equal(G.limitText({ amber: '≥ 80%', red: '≥ 90%' }), 'watch ≥ 80% · over ≥ 90%');
  assert.equal(G.rangeMs('7d'), 7 * 24 * H);
  assert.equal(G.rangeMs('nonsense'), 24 * H);
});
