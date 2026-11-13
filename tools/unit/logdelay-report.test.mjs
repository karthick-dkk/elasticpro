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
  assert.deepEqual(R.ldRoute('#/log-delay'), { view: 'fleet', clusterId: null, device: null });
  assert.deepEqual(R.ldRoute(R.ldHash('watch')), { view: 'watch', clusterId: null, device: null });
  assert.deepEqual(R.ldRoute(R.ldHash('live')), { view: 'live', clusterId: null, device: null });
  assert.deepEqual(R.ldRoute(R.ldHash('live', 'c 1', 'fw/dc1 07')), { view: 'live', clusterId: 'c 1', device: 'fw/dc1 07' });
  assert.deepEqual(R.ldRoute(R.ldHash('live', 'c1')), { view: 'live', clusterId: 'c1', device: null });
  assert.deepEqual(R.ldRoute(R.ldHash('cluster', 'client a/prod')), { view: 'cluster', clusterId: 'client a/prod', device: null });
  assert.deepEqual(R.ldRoute(R.ldHash('device', 'c1', 'fw/dc1 07')), { view: 'device', clusterId: 'c1', device: 'fw/dc1 07' });
  assert.deepEqual(R.ldRoute(R.ldHash('fixes')), { view: 'fixes', clusterId: null, device: null });
  assert.deepEqual(R.ldRoute(R.ldHash('fixes', 'c1')), { view: 'fixes', clusterId: 'c1', device: null });
  assert.equal(R.ldRoute('#/reports/capacity').view, 'fleet', 'another page is not a log delay view');
  assert.equal(R.ldHash('fleet'), '#/log-delay');
  assert.deepEqual(['fleet', 'cluster', 'device', 'fixes', 'watch', 'live'].map(R.ldTab), ['fleet', 'fleet', 'fleet', 'fixes', 'watch', 'live']);
});

test('the old addresses open the matching view of the Log Delay page', () => {
  // The mail's "Open the full report" link and saved Reports › Log delay links.
  assert.deepEqual(R.ldRoute('#/reports/log-delay'), { view: 'fleet', clusterId: null, device: null });
  assert.deepEqual(R.ldRoute('#/reports/log-delay/cluster/c%201'), { view: 'cluster', clusterId: 'c 1', device: null });
  assert.deepEqual(R.ldRoute('#/reports/log-delay/device/c1/fw%2Fdc1'), { view: 'device', clusterId: 'c1', device: 'fw/dc1' });
  assert.deepEqual(R.ldRoute('#/reports/log-delay/fixes/c1'), { view: 'fixes', clusterId: 'c1', device: null });
  // #/logs was the live tail.
  assert.deepEqual(R.ldRoute('#/logs'), { view: 'live', clusterId: null, device: null });
});

test('Fetch Now: the scoped JOB_RUN, the run found in JOBS_LIST, and its words', () => {
  assert.deepEqual(R.fetchNowMessage({}), { type: 'JOB_RUN', jobId: 'logdelay.measure' });
  assert.deepEqual(R.fetchNowMessage({ clusterIds: ['c1'], device: 'fw-07' }), { type: 'JOB_RUN', jobId: 'logdelay.measure', clusterIds: ['c1'], device: 'fw-07' });
  assert.deepEqual(R.fetchNowMessage({ clusterIds: [] }), { type: 'JOB_RUN', jobId: 'logdelay.measure' }, 'no clusters named is every cluster');
  const list = { ok: true, jobs: [{ id: 'logdelay.measure', state: { current: { id: 'r2', status: 'running' }, lastRun: { id: 'r1', status: 'completed' } } }],
    runs: [{ id: 'r3', jobId: 'logdelay.measure', status: 'queued' }] };
  assert.equal(R.runOf(list, 'r3').status, 'queued');
  assert.equal(R.runOf(list, 'r2').status, 'running', 'the job\'s current run');
  assert.equal(R.runOf(list, 'r1').status, 'completed', 'its last run');
  assert.equal(R.runOf(list, 'nope'), null);
  assert.equal(R.runText({ status: 'running', done: 3, total: 8, progress: 37.5, records: 1240 }), 'running · 3 of 8 (38 %) · 1,240 devices measured');
  assert.equal(R.runText({ status: 'running', done: null, total: null, progress: null, records: null }), 'running · progress not known yet', 'unknown progress is said, never 0');
  assert.equal(R.runText({ status: 'completed', done: 8, total: 8, progress: 100, records: 1 }), 'done · 8 of 8 (100 %) · 1 device measured');
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

test('sparkline: a day without totals is a gap, not a drop to zero', () => {
  const segs = R.sparkSegments([3, 4, null, 5, 6], 120, 24);
  assert.equal(segs.length, 2, 'two runs of known values');
  assert.equal(segs[0].split(' ').length, 2);
  assert.equal(R.sparkSegments([null, null]).length, 0, 'nothing known draws nothing');
});

test('day bars: no totals is a gap; on time, delayed, critical, silent stack', () => {
  const bars = R.dayBars([
    { day: '2026-11-01', devices: 10, onTimeAll: 6, delayed: 2, critical: 1, silent: 1, unmeasured: 0 },
    { day: '2026-11-02', devices: 0 },
  ], 100);
  assert.equal(bars[1].gap, true);
  assert.equal(bars[0].gap, false);
  assert.equal(bars[0].ok + bars[0].del + bars[0].crit + bars[0].unk, 100);
  const late = R.dayBars([{ day: 'x', devices: 10, onTimeAll: 9, delayed: 1, critical: 0 }], 50, { withOk: false });
  assert.equal(late[0].ok, 0);
  assert.equal(late[0].del, 50);
  assert.match(R.dayTitle({ day: '2026-11-02', devices: 0 }), /no measurement/);
});

test('rings: a cluster with no devices has no share (—), a small share still shows', () => {
  assert.deepEqual(R.ringDash(0, 0), { dash: '0 100', share: null });
  assert.equal(R.ringDash(null, 10).share, null);
  assert.equal(R.ringDash(0, 10).share, 0);
  assert.equal(R.ringDash(1, 1000).dash.split(' ')[0], '2.00', 'a tiny share is drawn at 2 %');
  const order = R.ringsOrder([{ id: 'a', latePct: 1 }, { id: 'b', latePct: null }, { id: 'c', latePct: 5 }]).map((c) => c.id);
  assert.deepEqual(order, ['c', 'a', 'b'], 'worst first, never measured last');
});

test('delay reduced: the five windows, an absent one unknown', () => {
  const b = R.reducedBars([{ hours: 2, n: 4 }, { hours: 24, n: 23 }]);
  assert.deepEqual(b.map((x) => x.hours), [2, 4, 6, 12, 24]);
  assert.equal(b[1].n, null);
  assert.equal(b[1].px, 0);
  assert.equal(b[4].px, 44);
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

test('periods: last N days, this month, last month', () => {
  const now = new Date(2026, 10, 7, 12).getTime();
  assert.deepEqual(R.periodQuery('last30', now), { days: 30 });
  assert.deepEqual(R.periodQuery('last7', now), { days: 7 });
  assert.deepEqual(R.periodQuery('thisMonth', now), { from: '2026-11-01', to: '2026-11-07' });
  assert.deepEqual(R.periodQuery('lastMonth', now), { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(R.periodDays('2026-10-06', '2026-11-04'), 30);
});

test('chart colours: light green, blue, pink and orange only', () => {
  const fills = Object.entries(R.LD_COLOURS).filter(([k]) => k !== 'line').map(([, v]) => v);
  assert.deepEqual(fills, ['#bfe6bf', '#a9c8f0', '#f2a7c3', '#f5b77a']);
});

test('settings: levels must climb', () => {
  assert.equal(ST.validLevels({ noDelayUnder: 15, delayFrom: 30, criticalOver: 60 }), '');
  assert.match(ST.validLevels({ noDelayUnder: 15, delayFrom: 30, criticalOver: 20 }), /Critical/);
  assert.match(ST.validLevels({ noDelayUnder: 40, delayFrom: 30, criticalOver: 60 }), /Little delay/);
  assert.match(ST.validLevels({ noDelayUnder: NaN, delayFrom: 30, criticalOver: 60 }), /number/);
  assert.deepEqual(ST.levelsDraft({ noDelayUnder: 15, delayFrom: 25, criticalOver: 90 }, 2), { levels: { noDelayUnder: 15, delayFrom: 25, criticalOver: 90 }, silentAfterHours: 2 });
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
  assert.equal(ST.runPeriodFor('weekly', 'cadence', now), 'previousWeek');
  assert.equal(ST.runPeriodFor('monthly', 'cadence', now), 'previousMonth');
  assert.deepEqual(ST.runPeriodFor('daily', 'monthSoFar', now), { from: '2026-11-01', to: '2026-11-06' });
  assert.equal(ST.runPeriodFor('daily', 'monthSoFar', new Date(2026, 10, 1, 9).getTime()), 'previousMonth');
});
