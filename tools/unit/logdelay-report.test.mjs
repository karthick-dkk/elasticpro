/**
 * Reports › Log delay (0.3.57): the routes, the words and the chart arithmetic of
 * ui/js/core/logdelay-report.js, and the settings drafts of ui/js/core/logdelay-settings.js.
 * The rule under test throughout: unknown is not zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/logdelay-report.js')).href);
const ST = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/logdelay-settings.js')).href);

test('routes: each view round-trips, names with slashes and spaces included', () => {
  assert.deepEqual(R.ldRoute('#/log-delay'), { view: 'fleet', clusterId: null, device: null, tz: null });
  // Live Watch and Live logs are one tab, Live: the old Live Watch address opens it.
  assert.equal(R.ldHash('watch'), '#/log-delay/live');
  assert.deepEqual(R.ldRoute('#/log-delay/watch'), { view: 'live', clusterId: null, device: null, tz: null });
  assert.equal(R.ldTab('watch'), 'live');
  assert.equal(R.ldTab('live'), 'live');
  assert.deepEqual(R.ldRoute(R.ldHash('live')), { view: 'live', clusterId: null, device: null, tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('live', 'c 1', 'fw/dc1 07')), { view: 'live', clusterId: 'c 1', device: 'fw/dc1 07', tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('live', 'c1')), { view: 'live', clusterId: 'c1', device: null, tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('cluster', 'client a/prod')), { view: 'cluster', clusterId: 'client a/prod', device: null, tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('device', 'c1', 'fw/dc1 07')), { view: 'device', clusterId: 'c1', device: 'fw/dc1 07', tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('devices')), { view: 'devices', clusterId: null, device: null, tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('devices', 'c1')), { view: 'devices', clusterId: 'c1', device: null, tz: null });
  assert.equal(R.ldHash('devices', 'c 1'), '#/log-delay/devices/c%201');
  // The Recommended fixes tab went in 0.3.62: its address opens Devices (every row has its "i").
  assert.deepEqual(R.ldRoute(R.ldHash('fixes', 'c1')), { view: 'devices', clusterId: 'c1', device: null, tz: null });
  assert.deepEqual(R.ldRoute('#/log-delay/fixes'), { view: 'devices', clusterId: null, device: null, tz: null });
  assert.equal(R.ldRoute('#/reports/capacity').view, 'fleet', 'another page is not a log delay view');
  assert.equal(R.ldHash('fleet'), '#/log-delay');
  // The time-zone filter lives in the address like the other filters: an offset, or 'none'.
  assert.deepEqual(R.ldRoute('#/log-delay/devices?tz=480'), { view: 'devices', clusterId: null, device: null, tz: 480 });
  assert.deepEqual(R.ldRoute('#/log-delay?tz=none'), { view: 'fleet', clusterId: null, device: null, tz: 'none' });
  assert.equal(R.ldRoute('#/log-delay/watch?tz=abc').tz, null, 'nonsense is no filter');
  assert.equal(R.ldHash('devices', 'c 1', null, { tz: 'none' }), '#/log-delay/devices/c%201?tz=none');
  assert.equal(R.ldHash('cluster', 'c1', null, { tz: 330 }), '#/log-delay/cluster/c1?tz=330');
  assert.equal(R.ldHash('fleet', null, null, { tz: null }), '#/log-delay', 'no filter, no query');
  assert.deepEqual(['fleet', 'cluster', 'summary', 'devices', 'device', 'fixes', 'watch', 'live'].map(R.ldTab), ['fleet', 'fleet', 'summary', 'devices', 'devices', 'devices', 'live', 'live']);
  // Summary (the fleet view of Reports › Log delay before 0.3.60), second in the tabs; one cluster too.
  assert.deepEqual(R.ldRoute(R.ldHash('summary')), { view: 'summary', clusterId: null, device: null, tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('summary', 'c 1')), { view: 'summary', clusterId: 'c 1', device: null, tz: null });
  assert.equal(R.ldHash('summary'), '#/log-delay/summary');
  assert.equal(R.ldHash('summary', 'c1', null, { tz: 480 }), '#/log-delay/summary/c1?tz=480');
  assert.equal(R.LD_VIEWS.indexOf('summary'), R.LD_VIEWS.indexOf('cluster') + 1);
});

test('summary: the late split, Delay reduced, the rings worst first and their arcs — unknown is not zero', () => {
  const b = R.bands({ delayFrom: 30, criticalOver: 60 });
  assert.equal(R.lateSplitText({ delay: 116, critical: 440 }, b), '116 at 30–60 min, 440 above 60 min');
  assert.equal(R.lateSplitText({ delay: null, critical: 3 }, b), '— at 30–60 min, 3 above 60 min');
  const red = R.reducedBars([{ hours: 2, n: 4 }, { hours: 4, n: 0 }, { hours: 24, n: 23 }], 44);
  assert.deepEqual(red.map((r) => r.label), ['2 h', '4 h', '6 h', '12 h', '24 h']);
  assert.deepEqual(red.map((r) => r.n), [4, 0, null, null, 23], 'an hour the core did not send is unknown, not 0');
  assert.equal(red[4].px, 44); assert.equal(red[1].px, 0); assert.equal(red[2].px, 0);
  assert.ok(red[0].px >= 3);
  const order = R.ringsOrder([
    { id: 'a', name: 'a', latePct: 3.4, lateNow: 14, lastRunAt: 1 },
    { id: 'n', name: 'n', latePct: null, lateNow: 0, lastRunAt: null },
    { id: 'b', name: 'b', latePct: 24.0, lateNow: 3, lastRunAt: 1 },
    { id: 'c', name: 'c', latePct: 3.4, lateNow: 20, lastRunAt: 1 },
  ]).map((c) => c.id);
  assert.deepEqual(order, ['b', 'c', 'a', 'n'], 'worst share first, then most late; never measured last');
  assert.equal(R.ringArcs(1, 1, 0), null, 'no device: no share, never 0 %');
  assert.equal(R.ringArcs(null, 2, 10), null, 'a figure missing: unknown');
  assert.deepEqual(R.ringArcs(0, 0, 10), [], 'measured, nothing late: no arc');
  const arcs = R.ringArcs(2, 1, 10);
  assert.deepEqual(arcs.map((x) => x.kind), ['critical', 'delay']);
  assert.equal(arcs[0].dash, '10.00 90.00'); assert.equal(arcs[1].dash, '20.00 80.00'); assert.equal(arcs[1].offset, '-10.00', 'the delay band starts where the critical arc ends');
  assert.equal(R.ringArcs(0, 1, 100000)[0].dash, '1.50 98.50', 'one late device still shows');
  const three = R.ringArcs(2, 1, 10, 6);
  assert.deepEqual(three.map((x) => [x.kind, x.dash, x.offset]), [['critical', '10.00 90.00', '0.00'], ['delay', '20.00 80.00', '-10.00'], ['ok', '60.00 40.00', '-30.00']], 'No delay after the late arcs; the rest is another time zone');
  assert.deepEqual(R.sharedLevels([{ levels: { delayFrom: 30, criticalOver: 60 } }, { levels: { delayFrom: 30, criticalOver: 60 } }]), { delayFrom: 30, criticalOver: 60 });
  assert.equal(R.sharedLevels([{ levels: { delayFrom: 30, criticalOver: 60 } }, { levels: { delayFrom: 20, criticalOver: 60 } }]), null);
  assert.equal(R.sharedLevels([]), null);
});

test('summary day by day: a day without totals is a gap, every tick its own date', () => {
  const day = (d, o = {}) => ({ day: d, devices: 10, onTimeAll: 6, delayed: 2, critical: 1, otherTz: 0, silent: 1, unmeasured: 0, ...o });
  const bars = R.dayBars([day('2026-11-09'), { day: '2026-11-10', devices: 0 }, day('2026-11-11', { onTimeAll: 1, delayed: 0, critical: 0, silent: 0 })], 100);
  assert.equal(bars[1].gap, true); assert.equal(bars[1].ok + bars[1].delay + bars[1].critical, 0);
  assert.deepEqual([bars[0].ok, bars[0].delay, bars[0].critical], [70, 20, 10], 'No delay: on time and silent together');
  assert.equal(bars[2].ok, 10);
  assert.match(R.dayTitle({ day: '2026-11-10', devices: 0 }), /10 Nov · no measurement/);
  assert.match(R.dayTitle(day('2026-11-09'), R.bands({ delayFrom: 30, criticalOver: 60 })), /No delay 7 \(on time 6 · silent 1 · can't measure 0\), 2 at 30–60 min, 1 above 60 min/);
  // The old board's ticks read "10 Nov" five times over a short period; each is its own day now.
  assert.deepEqual(R.dayTicks([day('2026-11-10')]), ['10 Nov']);
  assert.deepEqual(R.dayTicks([day('2026-11-16'), day('2026-11-17')]), ['16 Nov', '17']);
  const month = Array.from({ length: 30 }, (_, i) => day(new Date(Date.UTC(2026, 9, 19 + i)).toISOString().slice(0, 10)));
  const ticks = R.dayTicks(month).filter(Boolean);
  assert.equal(ticks.length, 6);
  assert.equal(new Set(ticks).size, ticks.length, 'no date twice');
  assert.deepEqual(ticks, ['19 Oct', '24', '29', '3 Nov', '8', '13'], 'the month once, and again where it changes');
});

test('summary day by day covers at least the last 7 days: a short range widens, a long one is its own days', () => {
  assert.deepEqual(R.dayChartDays({ from: '2026-11-17', to: '2026-11-17' }, '2026-11-17'), { from: '2026-11-11', to: '2026-11-17', days: 7, widened: true });
  assert.deepEqual(R.dayChartDays({ from: '2026-11-16', to: '2026-11-17' }, '2026-11-17'), { from: '2026-11-11', to: '2026-11-17', days: 7, widened: true }, 'a 1 h window past midnight is still short');
  assert.deepEqual(R.dayChartDays({ from: '2026-11-01', to: '2026-11-10' }, '2026-11-17'), { from: '2026-11-01', to: '2026-11-10', days: 10, widened: false }, 'a 10-day custom range is its own days');
  assert.deepEqual(R.dayChartDays({ from: '2026-11-11', to: '2026-11-17' }, '2026-11-17').widened, false, 'exactly 7 days is not widened');
  assert.deepEqual(R.dayChartDays({ from: '2026-12-03', to: '2026-12-03' }, '2026-12-03'), { from: '2026-11-27', to: '2026-12-03', days: 7, widened: true }, 'across a month boundary');
  assert.deepEqual(R.dayChartDays({ from: '2027-01-02', to: '2027-01-02' }, '2027-01-02').from, '2026-12-27', 'across a year boundary');
  assert.deepEqual(R.dayChartDays(null, '2026-11-17').from, '2026-11-11', 'no window: the last 7 days');
  assert.equal(R.dayChartWords(R.dayChartDays({ from: '2026-11-17', to: '2026-11-17' }, '2026-11-17')), 'Last 7 days · 11 Nov – 17 Nov');
  assert.equal(R.dayChartWords({ from: '2026-10-19', to: '2026-11-17', days: 30, widened: false }), '30 days · 19 Oct – 17 Nov');
});

test('the old addresses open the matching view of the Log Delay page', () => {
  // The mail's "Open the full report" link and saved Reports › Log delay links.
  assert.deepEqual(R.ldRoute('#/reports/log-delay'), { view: 'fleet', clusterId: null, device: null, tz: null });
  assert.deepEqual(R.ldRoute('#/reports/log-delay/cluster/c%201'), { view: 'cluster', clusterId: 'c 1', device: null, tz: null });
  assert.deepEqual(R.ldRoute('#/reports/log-delay/device/c1/fw%2Fdc1'), { view: 'device', clusterId: 'c1', device: 'fw/dc1', tz: null });
  assert.deepEqual(R.ldRoute('#/reports/log-delay/fixes/c1'), { view: 'devices', clusterId: 'c1', device: null, tz: null });
  // #/logs was the live tail.
  assert.deepEqual(R.ldRoute('#/logs'), { view: 'live', clusterId: null, device: null, tz: null });
});

test('Fetch Now: the scoped JOB_RUN, the run found in JOBS_LIST, and its words', () => {
  assert.deepEqual(R.fetchNowMessage({}), { type: 'JOB_RUN', jobId: 'logdelay.measure' }, 'no cluster: the core refuses it (one cluster at a time)');
  assert.deepEqual(R.fetchNowMessage({ clusterIds: ['c1'], device: 'fw-07' }), { type: 'JOB_RUN', jobId: 'logdelay.measure', clusterIds: ['c1'], device: 'fw-07' });
  assert.deepEqual(R.fetchNowMessage({ clusterIds: ['c1'], devices: 'all' }), { type: 'JOB_RUN', jobId: 'logdelay.measure', clusterIds: ['c1'], devices: 'all' });
  assert.deepEqual(R.fetchNowMessage({ clusterIds: ['c1'], devices: 'late' }), { type: 'JOB_RUN', jobId: 'logdelay.measure', clusterIds: ['c1'], devices: 'late' });
  assert.deepEqual(R.fetchNowMessage({ clusterIds: ['c1', 'c2'] }), { type: 'JOB_RUN', jobId: 'logdelay.measure', clusterIds: ['c1'] }, 'one cluster at a time');
  assert.ok(R.fetchNowAllowed({ clusterIds: ['c1'] }) && !R.fetchNowAllowed({ clusterIds: [] }) && !R.fetchNowAllowed({ clusterIds: ['a', 'b'] }));
  assert.equal(R.runText({ status: 'running', done: 12, total: 40, progress: 30, records: 12, scope: { clusterIds: ['c1'], devices: 'late' } }), 'running · 12 of 40 devices (30 %) · 12 devices read so far', 'a one-cluster run counts devices');
  const list = { ok: true, jobs: [{ id: 'logdelay.measure', state: { current: { id: 'r2', status: 'running' }, lastRun: { id: 'r1', status: 'completed' } } }],
    runs: [{ id: 'r3', jobId: 'logdelay.measure', status: 'queued' }] };
  assert.equal(R.runOf(list, 'r3').status, 'queued');
  assert.equal(R.runOf(list, 'r2').status, 'running', 'the job\'s current run');
  assert.equal(R.runOf(list, 'r1').status, 'completed', 'its last run');
  assert.equal(R.runOf(list, 'nope'), null);
  assert.equal(R.runText({ status: 'running', done: 3, total: 8, progress: 37.5, records: 1240 }), 'running · 3 of 8 clusters (38 %) · 1,240 devices read so far');
  assert.equal(R.runText({ status: 'running', done: null, total: null, progress: null, records: null }), 'running · progress not known yet', 'unknown progress is said, never 0');
  assert.equal(R.runText({ status: 'completed', done: 8, total: 8, progress: 100, records: 1 }), 'done · 8 of 8 clusters (100 %) · 1 device measured');
  assert.equal(R.runText({ status: 'skipped', error: 'not armed' }), 'skipped · not armed');
  assert.equal(R.fetchRefusalText({ ok: true }), null);
  assert.match(R.fetchRefusalText({ ok: false, kind: 'already_running', runId: 'abc' }), /already running \(run abc\)/);
  assert.match(R.fetchRefusalText({ ok: false, kind: 'blocked_readonly' }), /read-only/);
  assert.match(R.fetchRefusalText({ ok: false, kind: 'forbidden' }), /administrator/);
  assert.match(R.fetchRefusalText(null), /did not answer/);
});

test('zone and tag1 of a row: any case, the pipeline\'s other names, unknown is null', () => {
  assert.equal(R.extraOf({ extras: { Zone: 'dc1', tag1: 'fw' } }, 'zone'), 'dc1');
  assert.equal(R.extraOf({ meta: { zone: 'z2' } }, 'zone'), 'z2');
  assert.equal(R.extraOf({ extras: { fwdtag: 'syslog-1' } }, 'fwd_tag'), 'syslog-1');
  assert.equal(R.extraOf({ extras: { tag1: '' } }, 'tag1'), null, 'an empty value is unknown');
  assert.equal(R.extraOf({}, 'tag1'), null);
  assert.equal(R.valuesText([{ extras: { Zone: 'b' } }, { extras: { Zone: 'a' } }, { extras: { Zone: 'b' } }, {}], 'zone'), 'a, b');
  assert.equal(R.valuesText([{ extras: { tag1: 'a' } }, { extras: { tag1: 'b' } }, { extras: { tag1: 'c' } }, { extras: { tag1: 'd' } }], 'tag1'), 'a, b, c +1');
  assert.equal(R.valuesText([], 'zone'), '—');
});

test('a device Live Watch measured is a board row: the contract\'s state, unknown never 0', () => {
  const L = { noDelayUnder: 15, delayFrom: 30, criticalOver: 60 };
  const rec = { device: 'fw-07', docs: 120, arrival: 1000, event: 500, delayMinutes: 41, pattern: '-', patternNote: '', meta: { zone: 'dc1', tag1: 'fw' } };
  const r = R.liveDeviceRow(rec, { id: 'c1', name: 'prod' }, L);
  assert.equal(r.state, 'delay');
  assert.equal(r.nowMinutes, 41);
  assert.equal(r.cluster, 'c1');
  assert.equal(R.extraOf(r, 'zone'), 'dc1');
  assert.equal(r.maxMinutes, null, 'one measurement does not know the worst');
  assert.equal(r.pattern, null);
  assert.equal(R.liveDeviceRow({ ...rec, delayMinutes: 95 }, { id: 'c1' }, L).state, 'critical');
  assert.equal(R.liveDeviceRow({ ...rec, delayMinutes: null }, { id: 'c1' }, L).state, 'unmeasured');
  assert.equal(R.liveDeviceRow(rec, { id: 'c1' }, null).state, 'unknown', 'levels the core has not said: unknown, never on time');
  assert.equal(R.stateText('unknown'), 'levels unknown');
});

test('words: minutes, durations, docs — unknown says so', () => {
  assert.equal(R.minutesText(94), '94 min');
  assert.equal(R.minutesText(3.84), '3.8 min');
  assert.equal(R.minutesText(null), '—');
  assert.equal(R.minutesText(undefined, 'not measured'), 'not measured');
  assert.equal(R.durationText(67200000), '18 h 40 min');
  assert.equal(R.durationText(45 * 60000), '45 min');
  assert.equal(R.durationText(null), '—');
  assert.equal(R.docsText(41000), '41k');
  assert.equal(R.docsText(null), 'unknown');
  assert.equal(R.pctText(null), '—');
});

test('delay now: silent is "—", unmeasurable is "can\'t measure", never 0 min', () => {
  assert.equal(R.nowText({ state: 'silent', nowMinutes: null }), '—');
  assert.equal(R.nowText({ state: 'unmeasured', nowMinutes: null }), "can't measure");
  assert.equal(R.nowText({ state: 'no_delay', nowMinutes: 0 }), '0 min', 'a measured zero is a zero');
  assert.equal(R.stateText('unmeasured'), "can't measure");
  assert.equal(R.stateText('silent'), 'silent');
});

test('started → solved: still late, solved, silent, never late', () => {
  const now = new Date(2026, 10, 5, 14, 0).getTime();
  const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime();
  assert.equal(R.startedSolvedText({ state: 'critical', lateSince: at(5, 11, 15), lastStarted: at(5, 11, 15) }, now), 'today 11:15 → still late');
  assert.equal(R.startedSolvedText({ state: 'no_delay', lastStarted: at(3, 22, 0), lastSolved: at(4, 1, 15) }, now), '3 Nov 22:00 → 4 Nov 01:15');
  assert.equal(R.startedSolvedText({ state: 'silent', silentSince: at(5, 12, 40) }, now), 'no logs since 12:40');
  assert.equal(R.startedSolvedText({ state: 'no_delay' }, now), 'never late in this period');
  // Not measured since: never "still late".
  assert.equal(R.startedSolvedText({ state: 'critical', lateSince: at(5, 11, 15), stale: true, lastMeasuredMs: at(5, 11, 40) }, now), 'today 11:15 → not solved · last measured 11:40');
});

test('devices behind: a day without totals is a gap, not zero; today is one series per window', () => {
  const res = {
    days: [{ day: '2026-11-01', devices: 10, delayed: 2, critical: 1, solved: 3, complete: true }, { day: '2026-11-02', devices: 0 }],
    windows: [{ from: 0, to: 7200000, label: '00:00–02:00', stillLate: 4, delay: 3, critical: 1, solved: 1, complete: true }, { from: 7200000, to: 14400000, label: '02:00–04:00', stillLate: 2, solved: null, complete: false }],
  };
  const days = R.behindSeries(res, 'last7');
  assert.equal(days.length, 2);
  assert.deepEqual([days[0].delay, days[0].critical, days[0].behind, days[0].back, days[0].split], [2, 1, 3, 3, true]);
  assert.equal(days[1].gap, true, 'no totals is a gap');
  assert.equal(days[1].behind, null, 'a gap has no figure');
  const win = R.behindSeries(res, 'today');
  assert.deepEqual([win[0].label, win[0].behind, win[0].delay, win[0].critical, win[0].back, win[0].split], ['00:00', 4, 3, 1, 1, true], 'the core splits a window by level');
  assert.deepEqual([win[1].delay, win[1].critical, win[1].split], [null, null, false], 'a core that sends no split: unknown, not 0');
  assert.equal(win[1].back, null, 'a window the core gave no solved count for is unknown');
  assert.equal(win[1].complete, false);
  assert.deepEqual(R.behindSeries(null, 'last7'), []);
  assert.equal(R.niceStep(7), 2.5, 'about three steps: 1, 2, 2.5, 5 or 10 × a power of ten');
  assert.equal(R.niceStep(100), 50);
  assert.deepEqual([R.labelEvery(24), R.labelEvery(30), R.labelEvery(12), R.labelEvery(7)], [4, 5, 2, 1]);
});

test('late grid: a window with no measurement is missing, never an earlier reading carried forward', () => {
  const w = (i, o) => ({ from: i * 7200000, to: (i + 1) * 7200000, label: `${String(i * 2).padStart(2, '0')}:00`, ...o });
  const rows = R.lateGridRows([
    { id: 'a', name: 'A', lastRunAt: 5, lateNow: 6, critical: 2, yesterdayWindow: { measured: true, lateAt: 2, criticalAt: 3 },
      windows: [w(0, { measured: true, lateAt: 4, criticalAt: 1, stillLate: 4 }), w(1, { measured: false, lateAt: null, stillLate: 4 }), w(2, { measured: true, lateAt: 8, criticalAt: 2 })] },
    { id: 'q', name: 'Quiet', lastRunAt: 5, lateNow: 1, critical: 0, windows: [w(0, { measured: true, lateAt: 1, criticalAt: 0 })] },
    { id: 'n', name: 'Never', lastRunAt: null, windows: [] },
    { id: 'o', name: 'Old core', lastRunAt: 5, lateNow: 9, windows: [w(0, { stillLate: 9 })] },
  ], 2, 'late');
  assert.deepEqual(rows.map((r) => r.id), ['o', 'a', 'q', 'n'], 'worst first by Late now; never measured last');
  const a = rows[1];
  assert.equal(a.cells.length, 12, 'one cell per window of the day at 2 h');
  assert.deepEqual(a.cells.slice(0, 4).map((c) => [c.state, c.v]), [['measured', 4], ['missing', null], ['measured', 8], ['future', null]]);
  assert.deepEqual([a.measured, a.begun, a.worst, a.lateNow, a.vs], [2, 3, 8, 6, 4]);
  assert.equal(rows[0].cells[0].state, 'missing', 'a core that does not say `measured`: unknown, never its stillLate');
  const crit = R.lateGridRows([{ id: 'a', lastRunAt: 5, lateNow: 6, critical: 2, yesterdayWindow: { measured: true, lateAt: 2, criticalAt: 3 },
    windows: [w(0, { measured: true, lateAt: 4, criticalAt: 1 })] }], 2, 'critical')[0];
  assert.deepEqual([crit.cells[0].v, crit.lateNow, crit.vs], [1, 2, -1]);
  assert.equal(R.vsYesterday({ lastRunAt: 5, lateNow: 3, yesterdayWindow: { measured: false } }), null, 'yesterday not measured: unknown, not "="');
  assert.deepEqual([R.vsText(4), R.vsText(-2), R.vsText(0), R.vsText(null)], ['▲ 4', '▼ 2', '=', '']);
  assert.deepEqual([R.windowsPerDay(2), R.windowsPerDay(3), R.windowsPerDay(5), R.windowsPerDay(null)], [12, 8, 5, null]);
  assert.deepEqual(R.windowHeads(4), ['00', '04', '08', '12', '16', '20']);
});

test('late grid: the window in progress with no reading is pending, not a miss, and not in Measured', () => {
  const H = 3600000;
  const w = (i, o) => ({ from: i * 2 * H, to: (i + 1) * 2 * H, label: `${String(i * 2).padStart(2, '0')}:00`, ...o });
  // 05:00 now: 00 and 02 ended (02 not measured), 04 in progress with no reading yet.
  const [r] = R.lateGridRows([{ id: 'a', lastRunAt: 3 * H, lateNow: 5, critical: 1,
    windows: [w(0, { measured: true, lateAt: 4, complete: true }), w(1, { measured: false, complete: true }), w(2, { measured: false, complete: false })] }], 2);
  assert.deepEqual(r.cells.slice(0, 4).map((c) => c.state), ['measured', 'missing', 'pending', 'future']);
  assert.deepEqual([r.measured, r.done, r.begun], [1, 2, 3], 'the pending window is not in the denominator');
  assert.equal(r.nextAt, 5 * H, 'next measurement: the last run plus the interval');
  assert.equal(r.lastBeforeToday, false);
  // A window in progress that already has a reading counts, as measured.
  const [m] = R.lateGridRows([{ id: 'a', lastRunAt: 1, lateNow: 2, windows: [w(0, { measured: true, lateAt: 2, complete: false })] }], 2);
  assert.deepEqual([m.cells[0].state, m.measured, m.done], ['measured', 1, 1]);
  // From midnight until the first run: Late now is yesterday's last measurement, flagged; nothing is "missing".
  const day = 10 * 24 * H;
  const [y] = R.lateGridRows([{ id: 'a', lastRunAt: day - H, lateNow: 7, critical: 0, yesterdayWindow: { measured: true, lateAt: 6, criticalAt: 0 },
    windows: [{ from: day, to: day + 2 * H, label: '00:00', measured: false, complete: false }] }], 2);
  assert.deepEqual([y.cells[0].state, y.measured, y.done, y.lateNow, y.vs, y.lastBeforeToday], ['pending', 0, 0, 7, 1, true]);
});

test('late grid: each row is shaded on its own scale, its worst window darkest', () => {
  assert.deepEqual([R.gridShade(null, 8), R.gridShade(0, 8), R.gridShade(1, 8), R.gridShade(4, 8), R.gridShade(8, 8)], [-1, 0, 1, 2, 4]);
  assert.equal(R.gridShade(1, 1), 4, 'a quiet cluster\'s one late device is its worst: darkest');
  assert.equal(R.lateAtWindow({ measured: true, lateAt: 0 }), 0, 'measured and none late is 0');
  assert.equal(R.lateAtWindow(null), null);
});

test('device filters: the three levels, late, another time zone, silent (can\'t measure too); counts per chip', () => {
  const rows = ['no_delay', 'little', 'clock_ahead', 'delay', 'critical', 'other_tz', 'silent', 'unmeasured'].map((state) => ({ state }));
  assert.deepEqual(R.filterCounts(rows), { all: 8, late: 2, critical: 1, delay: 1, part: 0, noDelay: 5, ok: 2, tz: 1, silent: 3 });
  assert.ok(R.matchesFilter({ state: 'little' }, 'ok'), 'an old little row is under the line');
  assert.ok(!R.matchesFilter({ state: 'silent' }, 'late'), 'silent is not late: it has no figure');
  assert.ok(R.matchesFilter({ state: 'silent' }, 'all'));
  assert.deepEqual(R.DEVICE_FILTERS, ['all', 'late', 'critical', 'delay', 'part', 'noDelay', 'ok', 'tz', 'silent']);
});

test('time zones: a device\'s zone, the filter, the counts behind Expand, the chip\'s words, the By cluster cell', () => {
  const rows = [
    { state: 'no_delay', clusterTzOffset: 330, deviceTzOffset: 330 }, { state: 'delay', clusterTzOffset: 330, deviceTzOffset: 330 },
    { state: 'other_tz', clusterTzOffset: 330, deviceTzOffset: 480 }, { state: 'no_delay', clusterTzOffset: 0, deviceTzOffset: 0 },
    { state: 'silent', clusterTzOffset: null, deviceTzOffset: null }, { state: 'critical', clusterTzOffset: null, deviceTzOffset: null },
  ];
  assert.deepEqual(rows.map(R.zoneOfRow), [330, 330, 480, 0, null, null], 'own steady offset first, else the cluster\'s, else not detected');
  assert.deepEqual(rows.filter((r) => R.matchesZone(r, 330)).length, 2);
  assert.deepEqual(rows.filter((r) => R.matchesZone(r, 'none')).length, 2, 'none = a cluster without a majority');
  assert.deepEqual(rows.filter((r) => R.matchesZone(r, null)).length, 6, 'no filter keeps every row');
  const z = R.devicesByZone(rows);
  assert.deepEqual(z.map((x) => [x.key, x.devices]), [['330', 2], ['0', 1], ['480', 1], ['none', 2]], 'most devices first, not detected last');
  const off = (m) => (m === 330 ? '+05:30' : m === 0 ? '+00:00' : m === 480 ? '+08:00' : `${m}`);
  assert.equal(R.timeZoneChipText(z, null, off), '+05:30', 'the majority zone, no counts in the chip');
  assert.equal(R.timeZoneChipText(z, 480, off), '+08:00 · only these devices');
  assert.equal(R.timeZoneChipText(z, 'none', off), 'not detected · only these devices');
  assert.equal(R.timeZoneChipText([{ key: 'none', offsetMinutes: null, devices: 3 }], null, off), 'not detected');
  assert.deepEqual(R.tileCounts(rows), { devices: 6, onTime: 2, delay: 1, critical: 1, otherTz: 1, silent: 1, unmeasured: 0, clockAhead: 0, cantMeasure: 0, lateBeforeSilent: 0 });
  const by = [
    { id: 'a', name: 'A', lastRunAt: 1, timeZone: { mode: 'detected', offset: '+05:30', offsetMinutes: 330, agree: 12, of: 13, pct: 92.3 } },
    { id: 'c', name: 'C', lastRunAt: 1, timeZone: { mode: 'none', pct: 41.7 } },
  ];
  assert.equal(R.timeZoneCell(by[0].timeZone, off), '+05:30 · 12 of 13 devices');
  assert.equal(R.timeZoneCell(by[1].timeZone, off), 'not detected · 42 % agree');
  assert.equal(R.timeZoneCell(null, off), '—');
});

test('fix item: the core\'s finding as the popover takes it; no finding is null, never a guess', () => {
  const it = R.fixItem({ step: 'forwarder', stepLabel: 'Forwarder', why: 'its forwarder holds logs', fix: 'check the queue', devices: ['a', 'b'], group: ['fwd_tag', 'syslog-1'], missing: [] });
  assert.deepEqual(it, { title: 'Forwarder', cause: 'its forwarder holds logs', fix: 'check the queue', where: 'forwarder', count: 2, group: 'fwd_tag syslog-1', missing: [] });
  assert.equal(R.fixItem({ step: 'unknown', why: 'late, no pattern', fix: '', devices: ['x'], missing: ['parser_tag'] }).title, 'Not enough evidence');
  assert.equal(R.fixItem(null), null);
  assert.equal(R.STATE_TONE.little, 'ld-ok', 'an old little row draws as under the line');
  assert.deepEqual([R.STATE_TONE.delay, R.STATE_TONE.critical, R.STATE_TONE.other_tz, R.STATE_TONE.silent], ['ld-delay', 'ld-crit', 'ld-tz', 'grey']);
});

test('device graph: unknown points break the line; the scale holds the critical line', () => {
  const g = R.deviceGraph([{ t: 0, m: 5 }, { t: 1, m: 10 }, { t: 2, m: null }, { t: 3, m: 40 }], { fromMs: 0, toMs: 3, height: 100, levels: { criticalOver: 60 } });
  assert.equal(g.segments.length, 2);
  assert.ok(g.scaleMax >= 90, `scale ${g.scaleMax} holds 1.5 × critical`);
  const band = R.periodBand({ started: 1, solved: null, worstState: 'critical' }, 0, 4, 3);
  assert.equal(band.critical, true);
  assert.equal(Math.round(band.left), 25);
});

test('tables: filter by name, cluster or extra; order by time late with unknowns last', () => {
  const rows = [
    { device: 'fw-1', cluster: 'a', lateMs: 10, nowMinutes: 5, extras: { Zone: 'dc1' } },
    { device: 'sw-2', cluster: 'b', lateMs: null, nowMinutes: null, extras: { Zone: 'dc2' } },
    { device: 'fw-3', cluster: 'b', lateMs: 50, nowMinutes: 1, extras: {} },
  ];
  assert.deepEqual(R.filterRows(rows, 'DC2').map((r) => r.device), ['sw-2']);
  assert.deepEqual(R.filterRows(rows, '').length, 3);
  assert.deepEqual(R.byTimeLate(rows).map((r) => r.device), ['fw-3', 'fw-1', 'sw-2']);
});

test('periods: today, last N days, this month, last month', () => {
  const now = new Date(2026, 10, 7, 12).getTime();
  assert.deepEqual(R.periodQuery('today', now), { days: 1 });
  assert.deepEqual(R.periodQuery('last30', now), { days: 30 });
  assert.deepEqual(R.periodQuery('last7', now), { days: 7 });
  assert.deepEqual(R.periodQuery('thisMonth', now), { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(R.periodQuery('lastMonth', now), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(R.periodDays('2026-10-06', '2026-11-04'), 30);
});

test('chart colours: the theme tokens for the three levels, another time zone and silent — never a hex of its own', () => {
  const fills = Object.values(R.LD_COLOURS);
  assert.ok(fills.every((v) => !/#/.test(v)), 'a theme draws its own tones');
});

test('settings: the two lines must climb; noDelayUnder travels equal to delayFrom (no little band)', () => {
  assert.equal(ST.validLevels({ delayFrom: 30, criticalOver: 60 }), '');
  assert.match(ST.validLevels({ delayFrom: 30, criticalOver: 20 }), /Critical/);
  assert.match(ST.validLevels({ delayFrom: 0, criticalOver: 60 }), /above 0/);
  assert.match(ST.validLevels({ delayFrom: NaN, criticalOver: 60 }), /number/);
  assert.deepEqual(ST.levelsDraft({ delayFrom: 25, criticalOver: 90 }, 2), { levels: { noDelayUnder: 25, delayFrom: 25, criticalOver: 90 }, silentAfterHours: 2 });
  assert.deepEqual(ST.DEVICE_CHOICES.map(([v]) => v), ['delayed', 'all']);
  assert.equal(ST.levelsDraft({ noDelayUnder: 1, delayFrom: 2, criticalOver: 3 }, 500).silentAfterHours, undefined, 'out of 1–168 is left out');
});

test('settings: fields send only what was typed; extras at most 12, no repeats', () => {
  assert.deepEqual(ST.fieldsDraft({ device: '', arrival: ' ', eventTime: 'event_created, ingested_time,', extras: ['tag1', 'tag1', 'Zone'] }),
    { eventTime: ['event_created', 'ingested_time'], extras: ['tag1', 'Zone'] });
  assert.equal(ST.fieldsDraft({ extras: Array.from({ length: 20 }, (_, i) => `f${i}`) }).extras.length, 12);
});

test('settings: the report draft, its problems and managed keys', () => {
  const base = { enabled: true, to: ['noc@example.com'], schedule: 'daily', at: '07:00', period: 'yesterday', clusters: 'all',
    columns: ['device'], sections: ['summary'], devices: 'delayed', groupBy: 'cluster', xlsx: true, csv: false, top: 500, managed: [] };
  const d = ST.reportDraft(base);
  assert.equal(d.problem, '');
  assert.equal(d.schedule.options.top, 100, 'top is 1–100');
  assert.equal(d.schedule.options.csv, false);
  assert.equal(d.schedule.clusters, 'all');
  assert.match(ST.reportDraft({ ...base, columns: [] }).problem, /column/);
  assert.match(ST.reportDraft({ ...base, to: [] }).problem, /address/);
  assert.equal(ST.reportDraft({ ...base, to: [], enabled: false }).problem, '');
  const m = ST.reportDraft({ ...base, managed: ['UI_REPORT_LOGDELAY_TO', 'at'] });
  assert.equal('to' in m.schedule, false);
  assert.equal('at' in m.schedule, false);
  assert.deepEqual(ST.reportDraft({ ...base, clusters: 'c1' }).schedule.clusters, ['c1']);
});

test('settings: Download now covers what the schedule would', () => {
  const now = new Date(2026, 10, 7, 12).getTime();
  assert.equal(ST.runPeriodFor('daily', 'yesterday', now), 'yesterday');
  assert.equal(ST.runPeriodFor('hourly', 'yesterday', now), 'lastHour');
  assert.equal(ST.runPeriodFor('weekly', 'cadence', now), 'previousWeek');
  assert.equal(ST.runPeriodFor('monthly', 'cadence', now), 'previousMonth');
  assert.deepEqual(ST.runPeriodFor('daily', 'monthSoFar', now), { from: '2026-11-01', to: '2026-11-06' });
  assert.equal(ST.runPeriodFor('daily', 'monthSoFar', new Date(2026, 10, 1, 9).getTime()), 'previousMonth');
});

test('Live: a device silent in the range is a silent row, its last arrival kept; the schedule as an answer says it', () => {
  const r = R.silentDeviceRow('old-sw-09', 1762000000000, { id: 'c1', name: 'one' });
  assert.equal(r.state, 'silent');
  assert.equal(r.nowMinutes, null, 'no delay figure: unknown, never 0');
  assert.equal(r.silentSince, 1762000000000);
  assert.equal(r.cluster, 'c1');
  assert.deepEqual(R.scheduleOf({ schedule: { supported: true, enabled: true, everyHours: 3, lastRunAt: 5, state: { nextDueAt: 9 } } }),
    { supported: true, enabled: true, everyHours: 3, lastRunAt: 5, nextDueAt: 9 });
  assert.deepEqual(R.scheduleOf({ byCluster: [{ lastRunAt: 4 }, { lastRunAt: 7 }] }),
    { supported: false, enabled: null, everyHours: null, lastRunAt: 7, nextDueAt: null }, 'no schedule in the answer: not run here; the newest cluster run');
  assert.deepEqual(R.scheduleOf(null), { supported: null, enabled: null, everyHours: null, lastRunAt: null, nextDueAt: null }, 'no answer: nothing known');
});

test('states have one colour everywhere: critical red, delayed yellow, No delay green (owner, 2026-11-24)', () => {
  const C = R.LD_COLOURS;
  assert.deepEqual([C.ok, C.delay, C.crit, C.tz, C.silent], ['var(--state-ok)', 'var(--state-late)', 'var(--state-crit)', 'var(--ld-tz)', 'var(--ld-silent)']);
  assert.match(C.delayLine, /--state-late\b/); assert.match(C.critLine, /--state-crit\b/);
  // A grid cell: red when a device was above the critical line then, yellow late, none at 0; unknown split is not red.
  assert.deepEqual([R.gridHue({ criticalAt: 1 }, 3), R.gridHue({ criticalAt: 0 }, 3), R.gridHue({ criticalAt: null }, 3), R.gridHue({ criticalAt: 0 }, 0)], ['crit', 'late', 'late', '']);
  // A fix on the path is not a level.
  assert.ok(!Object.values(R.STEP_TONE).some((t) => /ld-(ok|delay|crit)/.test(t)));
});

test('the state tokens: set in every theme, one set (good/warning/critical and the chart fills are these), none of the old ones left', () => {
  const css = fs.readFileSync(new URL('../../ui/css/app.css', import.meta.url), 'utf8');
  for (const s of ['crit', 'late', 'ok']) {
    for (const k of ['', '-ink', '-bg']) assert.equal((css.match(new RegExp(`--state-${s}${k}: #`, 'g')) || []).length, 5, `--state-${s}${k}: light, dark by system, dark, dark-blue, warm`);
  }
  for (const [a, b] of [['good-ink', 'ok-ink'], ['warning-ink', 'late-ink'], ['critical-ink', 'crit-ink'], ['good-bg', 'ok-bg'], ['warning-bg', 'late-bg'], ['critical-bg', 'crit-bg'], ['chart-good', 'ok'], ['chart-warn', 'late'], ['chart-bad', 'crit']]) {
    assert.equal((css.match(new RegExp(`--${a}:`, 'g')) || []).length, 1, `--${a} is set once`);
    assert.ok(css.includes(`--${a}: var(--state-${b});`), `--${a} is the state's`);
  }
  assert.ok(!/--ld-(pink|blue|green|orange|ok|delay|crit|hx|heat)|--level-crit/.test(css));
  // A yellow pill is dark ink on yellow in every theme: 4.5:1 and more.
  const lum = (hex) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const pills = [...css.matchAll(/--state-late-pill: (#\w{6}); --state-late-on: (#\w{6});/g)];
  assert.equal(pills.length, 5);
  for (const [, bg, on] of pills) assert.ok((lum(bg) + 0.05) / (lum(on) + 0.05) >= 4.5, `${on} on ${bg}`);
});

test('documents without a device name: one summed line, never a note per cluster (0.3.77)', () => {
  const by = [
    { id: 'a', lastRead: { noDevice: 3183 } }, { id: 'b', lastRead: { noDevice: 0 } },
    { id: 'c', lastRead: { noDevice: 9221 } }, { id: 'd', lastRead: {} }, { id: 'e', lastRead: null }, { id: 'f' },
  ];
  assert.deepEqual(R.noDeviceTotal(by), { docs: 12404, clusters: 2 }, 'only the clusters that said a count above 0; not reported is left out, not 0');
  assert.equal(R.noDeviceLine(R.noDeviceTotal(by)), '12,404 documents in 2 clusters have no device name and are in no device’s figures');
  assert.equal(R.noDeviceLine({ docs: 3183, clusters: 1 }), '3,183 documents have no device name and are in no device’s figures', 'one cluster: no "in 1 cluster"');
  assert.equal(R.noDeviceLine({ docs: 1, clusters: 1 }), '1 document has no device name and is in no device’s figures');
  assert.equal(R.noDeviceTotal([{ lastRead: { noDevice: 0 } }, {}]), null, 'none: no line');
  assert.equal(R.noDeviceLine(null), '');
});

test('the time-zone chip is drawn only when it has a zone to say (0.3.77)', () => {
  const none = [{ key: 'none', offsetMinutes: null, devices: 40 }];
  assert.equal(R.zoneChipShown(none, null), false, 'every device not detected: no chip');
  assert.equal(R.zoneChipShown([], null), false, 'nothing in view: no chip');
  assert.equal(R.zoneChipShown(none, 'none'), true, 'the filter on: the chip says so, with Show all time zones');
  assert.equal(R.zoneChipShown(none, 480), true);
  assert.equal(R.zoneChipShown([...none, { key: '0', offsetMinutes: 0, devices: 2 }], null), true, 'UTC detected is a zone');
  assert.equal(R.zoneChipShown([{ key: '330', offsetMinutes: 330, devices: 12 }], null), true);
});

test('lastRunChange: became late and came back in the window of the last run; unknown is null', () => {
  const { lastRunChange } = R;
  const windows = [{ from: 0, to: 100, label: '00:00–02:00', newlyLate: 9, solved: 1 }, { from: 100, to: 200, label: '02:00–04:00', newlyLate: 12, solved: 5 }];
  assert.deepEqual(lastRunChange({ lastRunAt: 150, windows }), { up: 12, down: 5, net: 7, label: '02:00–04:00' });
  assert.deepEqual(lastRunChange({ lastRunAt: 50, windows }), { up: 9, down: 1, net: 8, label: '00:00–02:00' });
  assert.equal(lastRunChange({ lastRunAt: 999, windows }), null, 'the last run is not today: not known');
  assert.equal(lastRunChange({ lastRunAt: null, windows }), null, 'never measured');
  assert.equal(lastRunChange({ lastRunAt: 150 }), null, 'no windows');
});

test('No delay = on time + silent + can\'t measure, with its split; the shares add up to 100', () => {
  // The owner's example: on time 89 %, delayed 5 %, silent 6 % → No delay 95 %, Delayed 5 %.
  const nd = R.noDelayOf({ devices: 100, onTime: 89, late: 5, silent: 6, unmeasured: 0, otherTz: 0 });
  assert.equal(nd.count, 95);
  assert.equal(R.shareText(nd.pct.noDelay), '95 %');
  assert.equal(R.shareText(nd.pct.late), '5 %');
  assert.equal(nd.pct.noDelay + nd.pct.late + nd.pct.tz, 100);
  assert.equal(R.noDelaySplit(nd), "on time 89 % · silent 6 % · can't measure 0 %");
  assert.equal(R.noDelaySplit(R.noDelayOf({ devices: 100, onTime: 89, late: 5, silent: 6, unmeasured: 0, lateBeforeSilent: 1 })), "on time 89 % · silent 6 % · can't measure 0 % · 1 of them was late before it went silent");
  // Thirds never add up to 99.9 or 100.1.
  for (const [onTime, silent, cant, late, tz] of [[1, 1, 1, 0, 0], [2, 1, 0, 4, 0], [7, 11, 13, 17, 19], [1, 0, 0, 999999, 0]]) {
    const p = R.noDelayOf({ devices: onTime + silent + cant + late + tz, onTime, silent, unmeasured: cant, late, otherTz: tz }).pct;
    assert.equal(Math.round((p.noDelay + p.late + p.tz) * 10), 1000);
  }
  // The core's own figures are used when it sends them; a clock ahead is can't measure, not on time.
  const core = R.noDelayOf({ devices: 4, onTime: 1, noDelay: 3, silent: 1, unmeasured: 0, clockAhead: 1, cantMeasure: 1, late: 1, pctNoDelay: 75, pctOnTime: 25, pctSilent: 25, pctCantMeasure: 25, pctLate: 25, pctOtherTz: 0 });
  assert.deepEqual([core.count, core.onTime, core.cant, core.pct.noDelay], [3, 1, 1, 75]);
  const rows = R.tileCounts(['no_delay', 'clock_ahead', 'silent', 'critical'].map((state) => ({ state })));
  assert.deepEqual([R.noDelayOf(rows).count, rows.onTime, rows.cantMeasure], [3, 1, 1]);
  // A browser measurement, the same sum.
  assert.equal(R.noDelayOfStatuses({ devices: 4, by: { OK: 1, ERROR: 1, CLOCK_AHEAD: 1, DELAYED: 1 } }).count, 3);
});

test('No delay: no percentage for a cluster never measured, whose last run failed, or with no device — with the reason', () => {
  for (const [t, why] of [
    [{ lastRunAt: null, devices: 0, below: 0, silent: 0, unmeasured: 0, critical: 0, delay: 0 }, /never measured/],
    [{ lastRunAt: 5, devices: 3, onTime: 3, noDelay: 3, notMeasured: 'last run failed: refused', pctNoDelay: null }, /refused/],
    [{ devices: 0, onTime: 0, silent: 0, unmeasured: 0, critical: 0, delay: 0 }, /no device/],
    [{ devices: 4, onTime: 4, noDelay: 4, pctNoDelay: null, pctOf: { clusters: 0, ofClusters: 2 } }, /no cluster was measured/],
  ]) { const nd = R.noDelayOf(t); assert.equal(nd.pct, null); assert.match(nd.why, why); }
  // A core before 0.3.89: `noDelay` is the strict count and a clock ahead is inside `onTime`; the sum is the same.
  const old = R.noDelayOf({ devices: 100, onTime: 90, noDelay: 88, little: 0, clockAhead: 2, late: 4, silent: 5, unmeasured: 1, otherTz: 0 });
  assert.deepEqual([old.count, old.onTime, old.cant, old.silent, old.pct.noDelay], [96, 88, 3, 5, 96]);
  assert.equal(R.noDelayOfText(R.noDelayOf({ devices: 4, onTime: 4, noDelay: 4, pctNoDelay: 100, pctOf: { clusters: 30, ofClusters: 32 } })), 'of 30 of 32 clusters');
});

test('a window the core did not measure is a gap in the panels, never 0', () => {
  const [a, b] = R.behindSeries({ windows: [
    { from: 0, label: '00:00–02:00', measured: false, delay: 0, critical: 0, solved: 0, stillLate: 0 },
    { from: 1, label: '02:00–04:00', measured: true, delay: 2, critical: 1, solved: 0, stillLate: 3 }] }, 'today');
  assert.deepEqual([a.gap, a.delay, a.critical, a.back, a.behind], [true, null, null, null, null]);
  assert.deepEqual([b.gap, b.delay, b.critical, b.back, b.behind], [false, 2, 1, 0, 3]);
});

test('a device measured once: a dot, the band and the mark end at the measurement, nothing says now', () => {
  const H = 3600000; const at = Date.UTC(2026, 10, 24, 4, 35); const now = at + 8 * H + 3 * 60000;
  const res = { points: [{ t: at, m: 95 }], periods: [{ started: at, solved: null, worstState: 'critical' }], lateMs: now - at, latePct: 44.4, docsPerDay: 195, now };
  const g = R.deviceGraph(res.points, { fromMs: at - 10 * H, toMs: now, height: 100, levels: { criticalOver: 60 } });
  assert.equal(g.dots.length, 1, 'a one-point line has no length: the dot is what is seen');
  const age = R.measuredAge(res, now, 2);
  assert.deepEqual(age, { at, stale: true }, 'an older core: the last point, older than one interval');
  assert.deepEqual(R.measuredAge({ ...res, lastMeasuredMs: at, stale: false }, now, 2), { at, stale: false }, 'the core decides when it says');
  assert.match(R.staleText(at, now), /^late when last measured .*, not measured since$/);
  const band = R.periodBand(res.periods[0], g.lo, g.hi, age.at);
  assert.ok(band.width < 1, `the band ends at the measurement: ${band.width}`);
  assert.deepEqual(R.lateTime(res, age).pct, null, 'no share of a period nothing was measured in');
  assert.equal(R.lateTime(res, age).ms, 0);
  const core = R.lateTime({ measuredMs: 6 * H, lateMeasuredMs: 4 * H, latePct: 66.7 }, age);
  assert.deepEqual([core.ms, core.pct, core.of], [4 * H, 66.7, 'of the 6 h 00 min measured']);
});

test('the device graph\'s x axis: hours up to two days, day and hour up to seven, else days — never one label five times', () => {
  const H = 3600000; const t = Date.UTC(2026, 10, 24);
  const day = R.axisTicks(t, t + 24 * H - 1000);
  assert.ok(day.every((x) => /\d\d:\d\d$/.test(x)) && new Set(day).size === 5, day.join(' | '));
  const week = R.axisTicks(t - 6 * 24 * H, t);
  assert.ok(week.every((x) => /^\d+ Nov \d\d:\d\d$/.test(x)) && new Set(week).size === 5, week.join(' | '));
  const month = R.axisTicks(t - 20 * 24 * H, t);
  assert.ok(month.every((x) => /^\d+ Nov$/.test(x)), month.join(' | '));
});

test('logs a day says what it rests on; less than a day counted is a count', () => {
  assert.deepEqual(R.logsADay({ docsPerDay: null, docsCounted: 195, docsCountedHours: 2 }), { text: '195', label: 'logs in the 2 h counted: less than a day' });
  assert.deepEqual(R.logsADay({ docsPerDay: 4100, docsCountedHours: 30 }), { text: '4k', label: 'logs a day · from 30 h counted' });
  assert.equal(R.logsADay({}).text, 'unknown');
});

test('event time: the fields the devices\' times really came from', () => {
  assert.equal(R.eventFieldsText([{ eventField: 'ingested_time' }, { eventField: 'ingested_time' }], ['ingested_time', 'event_created']), 'ingested_time');
  assert.equal(R.eventFieldsText([{ eventField: 'ingested_time' }, { eventField: 'event_created' }, { eventField: 'ingested_time' }], []), 'ingested_time (2 devices), event_created (1 device)');
  assert.equal(R.eventFieldsText([{}], ['ingested_time', 'event_created']), 'the first of ingested_time, event_created a device’s log has');
  assert.equal(R.eventFieldsText([], []), 'field not known');
});
