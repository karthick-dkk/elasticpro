/**
 * A JOBS_LIST answer shaped like docs/JOBS.md, for the browser checks (fit-check, flicker-check)
 * that need the Jobs page to have runs on it — a fresh data directory has none. Long names and
 * a long error on purpose: a short one fits anything.
 *
 *   jobsListAnswer({ now, step })   step: how many reads so far — the running collection moves
 *                                   5 % a read, so a page that polls sees its progress change.
 *   jobsListAnswer({ governor: false })  as a core without the governor (or a worker's heartbeat late):
 *                                   no `governor`, no `state.allocation`.
 */

const CLUSTERS = ['frankfurt-production-logging-cluster-01', 'frankfurt-production-logging-cluster-02', 'singapore-disaster-recovery-siem'];

const job = (id, name, o = {}, s = {}) => ({
  id, name, kind: 'automatic', owner: 'worker', schedule: `${name}: once a day at each cluster's collectAt, server local time (volume settings)`,
  nextRun: 'x', priority: 'medium', pausable: true, requests: { min: 1, max: 4 }, report: null, detailsFor: 'user', clusterScoped: true, ...o,
  state: { enabled: true, paused: false, pausedBy: null, pausedAt: null, current: null, activeRuns: 0, lastRun: null, nextRunAt: null, nextRunNote: null, ...s },
});

export function jobsListAnswer({ now = Date.now(), step = 0, before = null, governor = true } = {}) {
  const pct = Math.min(95, 10 + step * 5);
  const alloc = (requests, max, reason = 'share') => (governor ? { requests, min: 1, max, auto: true, reason } : null);
  const running = { id: '4b0e1c2d3e4f5a6b', jobId: 'volume.daily', owner: 'worker', trigger: 'timer', status: 'running', createdAt: now - 600_000, startedAt: now - 600_000,
    endedAt: null, progress: pct, done: Math.round(pct / 20), total: 5, records: 40 + step, error: null, clusters: CLUSTERS };
  const counting = { id: '9f2c51ab03de4e17', jobId: 'hosts.collect', owner: 'worker', trigger: 'manual:platform-administrator', status: 'running', createdAt: now - 60_000,
    startedAt: now - 60_000, endedAt: null, progress: null, done: null, total: null, records: null, error: null, clusters: CLUSTERS.slice(0, 1) };
  const queued = { id: 'report-17a2b3c4d5e6', jobId: 'report.run', owner: 'worker', trigger: 'manual:platform-administrator', status: 'queued', createdAt: now - 20_000,
    startedAt: null, endedAt: null, progress: null, done: null, total: null, records: null, error: null, clusters: CLUSTERS.slice(1, 2) };
  const failed = { id: '0aa1bb2cc3dd4ee5', jobId: 'settings.backup', owner: 'core', trigger: 'timer', status: 'failed', createdAt: now - 7_200_000, startedAt: now - 7_200_000,
    endedAt: now - 7_100_000, progress: null, done: null, total: null, records: null,
    error: 'the backup could not be written to /var/lib/elasticpro/backups/settings-2026-11-10T02-00-00.tar.gz: no space left on device (os error 28)', clusters: [] };
  const done = (i) => ({ id: `d${String(i).padStart(15, '0')}`, jobId: i % 2 ? 'housekeeping' : 'zabbix.sync', owner: 'core', trigger: 'timer', status: i % 5 ? 'completed' : 'skipped',
    createdAt: now - i * 3_600_000, startedAt: now - i * 3_600_000, endedAt: now - i * 3_600_000 + 4200, progress: null, done: null, total: null, records: i * 7,
    error: i % 5 ? null : 'the Zabbix API is not configured (Config → Zabbix)', note: i % 2 ? 'removed 12 files and folders, 3.4 MB' : null, clusters: [] });
  const jobs = [
    job('logdelay.measure', 'Log delay measurement', { priority: 'high', owner: 'core', clusterScoped: false }, { nextRunAt: now + 1_800_000 }),
    job('volume.daily', 'Daily volume collection', {}, { current: running, activeRuns: 1, nextRunAt: now + 18_000_000, allocation: alloc(2 + (step % 2), 4) }),
    job('hosts.collect', 'Hosts collection', { requests: { min: 1, max: 2 } }, { current: counting, activeRuns: 1, nextRunAt: now + 40_000_000, allocation: alloc(1, 2, 'min') }),
    job('report.run', 'Report runs', { kind: 'manual', pausable: false }, { current: queued, activeRuns: 1, nextRunNote: 'runs when a person asks' }),
    job('report.mailed.volume', 'Mailed volume report', {}, { nextRunNote: 'the mailed schedule is off or has no recipients (Reports › Exports)' }),
    job('history.mirror', 'History store mirror', { priority: 'low', requests: { min: 1, max: 2 }, owner: 'core', clusterScoped: false },
      { nextRunNote: 'within a minute whenever something is queued; no fixed time' }),
    job('housekeeping', 'Housekeeping', { priority: 'low', requests: { min: 1, max: 1 }, owner: 'core', clusterScoped: false }, { lastRun: done(1), nextRunAt: now + 2_400_000 }),
    job('settings.backup', 'Settings backup', { owner: 'core', clusterScoped: false }, { lastRun: failed, nextRunAt: now + 93_600_000 }),
    job('zabbix.sync', 'Zabbix sync', { priority: 'low', requests: { min: 1, max: 2 }, owner: 'core', clusterScoped: false },
      { paused: true, pausedBy: 'platform-administrator', pausedAt: now - 600_000, nextRunNote: 'paused by platform-administrator (JOB_RESUME starts the timer again)' }),
    job('zabbix.push', 'Zabbix push', { priority: 'low', requests: { min: 1, max: 2 }, owner: 'core', clusterScoped: false }, { nextRunNote: 'ZABBIX_METRICS_HOST is not set' }),
    job('report.schedule.0a1b2c3d4e5f', 'Monthly volume for the Frankfurt logging platform team', { report: 'volume',
      created: { by: 'platform-administrator', at: now - 86_400_000, clusters: CLUSTERS.slice(0, 2), cadence: 'monthly', at: '07:00', period: 'cadence', enabled: true, lastSent: null,
        to: ['logging-platform-team@corp.internal.example.com', 'frankfurt-operations-lead@corp.internal.example.com'], cc: [], bcc: [], subject: '' } },
    { nextRunAt: now + 1_728_000_000 }),
  ];
  const runs = before ? Array.from({ length: 6 }, (_, i) => done(40 + i)) : [queued, counting, running, failed, ...Array.from({ length: 12 }, (_, i) => done(i + 1))];
  return {
    ok: true, role: 'core', jobs, runs, next: before ? null : `${now - 13 * 3_600_000}:d000000000000013`,
    busy: [{ cluster: CLUSTERS[2], signal: 'pool', reason: 'its search thread pool queue is over half full (812 of 1000)', since: now - 420_000 }],
    // The governor's figures move with the reads too: its chip is kept while they do.
    governor: governor ? { auto: true, inUse: 2 + (step % 3), total: 8, mostAtOnce: 4, jobsRunning: 2,
      lastChange: { at: now - 40_000, from: 16, to: 8, reason: 'people_waiting' },
      signals: { cpuPct: 41.2 + (step % 4), memoryPct: 23.8, peopleWaiting: step % 2, queue: 1, avgPageMs: 840 } } : null,
    process: {
      core: { role: 'core', cpuPct: 3.1, cpuOfLimitPct: 1.6, memoryBytes: 212_000_000, memoryLimitBytes: 1_073_741_824, memoryPct: 19.7, gate: { running: 2, queued: 0, oldestWaitMs: 0 } },
      worker: { state: 'up', text: 'heartbeat 4 s ago', heartbeatAt: now - 4000, cpuPct: 41, cpuOfLimitPct: 20.5, memoryBytes: 512_000_000, memoryLimitBytes: 2_147_483_648, memoryPct: 23.8, gate: { running: 6, queued: 3 } },
    },
    problems: [],
  };
}
