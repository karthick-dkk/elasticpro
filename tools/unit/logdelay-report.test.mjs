/**
 * Reports › Log delay (0.3.57): the routes, the words and the chart arithmetic of
 * ui/js/core/logdelay-report.js, and the settings drafts of ui/js/core/logdelay-settings.js.
 * The rule under test throughout: unknown is not zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/logdelay-report.js')).href);
const ST = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/logdelay-settings.js')).href);

test('routes: each view round-trips, names with slashes and spaces included', () => {
  assert.deepEqual(R.ldRoute('#/log-delay'), { view: 'fleet', clusterId: null, device: null, tz: null });
  assert.deepEqual(R.ldRoute(R.ldHash('watch')), { view: 'watch', clusterId: null, device: null, tz: null });
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
  assert.deepEqual(['fleet', 'cluster', 'summary', 'devices', 'device', 'fixes', 'watch', 'live'].map(R.ldTab), ['fleet', 'fleet', 'summary', 'devices', 'devices', 'devices', 'watch', 'live']);
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
  assert.deepEqual(R.sharedLevels([{ levels: { delayFrom: 30, criticalOver: 60 } }, { levels: { delayFrom: 30, criticalOver: 60 } }]), { delayFrom: 30, criticalOver: 60 });
  assert.equal(R.sharedLevels([{ levels: { delayFrom: 30, criticalOver: 60 } }, { levels: { delayFrom: 20, criticalOver: 60 } }]), null);
  assert.equal(R.sharedLevels([]), null);
});

test('summary day by day: a day without totals is a gap, every tick its own date', () => {
  const day = (d, o = {}) => ({ day: d, devices: 10, onTimeAll: 6, delayed: 2, critical: 1, otherTz: 0, silent: 1, unmeasured: 0, ...o });
  const bars = R.dayBars([day('2026-11-09'), { day: '2026-11-10', devices: 0 }, day('2026-11-11', { onTimeAll: 1, delayed: 0, critical: 0, silent: 0 })], 100);
  assert.equal(bars[1].gap, true); assert.equal(bars[1].ok + bars[1].delay + bars[1].critical + bars[1].unk, 0);
  assert.deepEqual([bars[0].ok, bars[0].delay, bars[0].critical, bars[0].unk], [60, 20, 10, 10]);
  assert.equal(bars[2].ok, 10);
  assert.match(R.dayTitle({ day: '2026-11-10', devices: 0 }), /10 Nov · no measurement/);
  assert.match(R.dayTitle(day('2026-11-09'), R.bands({ delayFrom: 30, criticalOver: 60 })), /6 on time, 2 at 30–60 min, 1 above 60 min, 1 silent/);
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

test('heat map: a cell the core has no total for is unknown, never 0; a cluster never measured says so', () => {
  const rows = R.heatRows([
    { id: 'a', name: 'A', lastRunAt: 1, sparkline: [3, null, 0], windows: [{ stillLate: 2 }, { stillLate: null }] },
    { id: 'b', name: 'B', lastRunAt: null, sparkline: [] },
  ], 'last7');
  assert.deepEqual(rows[0].cells, [3, null, 0]);
  assert.equal(rows[1].never, true);
  assert.deepEqual(R.heatRows([{ id: 'a', lastRunAt: 1, windows: [{ stillLate: 2 }, { stillLate: null }] }], 'today')[0].cells, [2, null]);
  assert.deepEqual([R.heatStep(null), R.heatStep(0), R.heatStep(1), R.heatStep(3), R.heatStep(6), R.heatStep(40)], [-1, 0, 1, 2, 3, 4]);
  assert.equal(R.HEAT_LEGEND.length, 5);
});

test('device filters: the three levels, late, another time zone, silent (can\'t measure too); counts per chip', () => {
  const rows = ['no_delay', 'little', 'clock_ahead', 'delay', 'critical', 'other_tz', 'silent', 'unmeasured'].map((state) => ({ state }));
  assert.deepEqual(R.filterCounts(rows), { all: 8, late: 2, critical: 1, delay: 1, ok: 3, tz: 1, silent: 2 });
  assert.ok(R.matchesFilter({ state: 'little' }, 'ok'), 'an old little row is under the line');
  assert.ok(!R.matchesFilter({ state: 'silent' }, 'late'), 'silent is not late: it has no figure');
  assert.ok(R.matchesFilter({ state: 'silent' }, 'all'));
  assert.deepEqual(R.DEVICE_FILTERS, ['all', 'late', 'critical', 'delay', 'ok', 'tz', 'silent']);
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
  assert.deepEqual(R.tileCounts(rows), { devices: 6, onTime: 2, delay: 1, critical: 1, otherTz: 1, silent: 1, unmeasured: 0 });
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
  const fills = Object.entries(R.LD_COLOURS).filter(([k]) => k !== 'line').map(([, v]) => v);
  assert.deepEqual(fills, ['var(--ld-ok)', 'var(--ld-delay)', 'var(--ld-crit)', 'var(--ld-tz)', 'var(--ld-silent)']);
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
