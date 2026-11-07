/**
 * Config-Management › Data › Scheduled log delay (0.3.57): what the levels, fields and report
 * generator forms turn into before they go to the core. No DOM, so tools/unit tests it.
 * docs/LOGDELAY.md "LOGDELAY_SETTINGS_SET" and "Report kind log_delay" are the shapes.
 */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Why a set of levels cannot be saved, or ''. They must climb: no delay < delay < critical. */
export function validLevels(l) {
  if (!l || ![l.noDelayUnder, l.delayFrom, l.criticalOver].every(finite)) return 'Every delay level must be a number of minutes.';
  if (l.noDelayUnder <= 0) return 'No delay must be above 0 minutes.';
  if (!(l.noDelayUnder <= l.delayFrom)) return 'Little delay must end where Delay begins: No delay under ≤ Delay from.';
  if (!(l.delayFrom < l.criticalOver)) return 'Critical must be above Delay: Delay from < Critical over.';
  if (l.criticalOver > 7 * 24 * 60) return 'Critical over must be at most a week (10080 min).';
  return '';
}

/** The partial settings for the levels card: levels, and silentAfterHours when it is 1–168. */
export function levelsDraft(levels, silentAfterHours) {
  const out = { levels: { noDelayUnder: levels.noDelayUnder, delayFrom: levels.delayFrom, criticalOver: levels.criticalOver } };
  if (finite(silentAfterHours) && silentAfterHours >= 1 && silentAfterHours <= 168) out.silentAfterHours = Math.round(silentAfterHours);
  return out;
}

/** A comma list as names, empty ones and repeats dropped. */
export const nameList = (text) => [...new Set(String(text || '').split(',').map((s) => s.trim()).filter(Boolean))];

/**
 * The `fields` object for LOGDELAY_SETTINGS_SET: only what was typed (an empty box keeps what is
 * in force), extras at most 12.
 */
export function fieldsDraft({ device, arrival, eventTime, extras }) {
  const out = {};
  if (String(device || '').trim()) out.device = String(device).trim();
  if (String(arrival || '').trim()) out.arrival = String(arrival).trim();
  const ev = Array.isArray(eventTime) ? eventTime : nameList(eventTime);
  if (ev.length) out.eventTime = ev;
  const ex = Array.isArray(extras) ? [...new Set(extras.map((x) => String(x).trim()).filter(Boolean))] : nameList(extras);
  out.extras = ex.slice(0, 12);
  return out;
}

/** Column keys in words (BASE_COLUMNS); `arrival` and `eventTime` take the field names when drawn. */
export const COLUMN_LABEL = Object.freeze({
  device: 'Device', cluster: 'Cluster', nowMinutes: 'Delay now', level: 'Level', startedSolved: 'Started → solved',
  median: 'Median', max: 'Max', episodes: 'Delays', lateTime: 'Time late', docsPerDay: 'Logs a day',
  arrival: 'Arrival time', eventTime: 'Event time', lateSince: 'Late since',
});

export const SECTION_LABEL = Object.freeze({
  summary: 'Summary', lateEvery2h: 'Late devices every N hours', windows: 'Every N hours: newly late and solved',
  dayByDay: 'Day by day (7 days)', topDelayed: 'Top delayed', fixes: 'Recommended fixes',
});

export const DEVICE_CHOICES = Object.freeze([
  ['delayed', 'Only delayed (at the delay level or more)'], ['little', 'Delayed and little delay'], ['all', 'All devices'],
]);
export const WHEN_CHOICES = Object.freeze([
  ['daily', 'Daily'], ['weekly', 'Weekly · Monday'], ['monthly', 'Monthly · 1st'], ['manual', 'Only when sent by hand'],
]);
/** What the scheduled mail covers (report/schedule.rs PeriodChoice). */
export const PERIOD_CHOICES = Object.freeze([
  ['yesterday', 'Yesterday'], ['cadence', 'The cadence’s own period (day, week, month)'], ['monthSoFar', 'Month so far'],
]);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The REPORT_RUN period for Download now, from the schedule's cadence and period choice. */
export function runPeriodFor(schedule, period, now = Date.now()) {
  if (period === 'monthSoFar') {
    const t = new Date(now);
    const y = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
    if (t.getDate() === 1) return 'previousMonth';
    return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: ymd(y) };
  }
  if (period === 'cadence') return schedule === 'weekly' ? 'previousWeek' : schedule === 'monthly' ? 'previousMonth' : schedule === 'manual' ? 'last7' : 'yesterday';
  return 'yesterday';
}

const SCHEDULE_KEYS = { to: 'to', schedule: 'schedule', at: 'at', UI_REPORT_LOGDELAY_TO: 'to', UI_REPORT_LOGDELAY_SCHEDULE: 'schedule', UI_REPORT_LOGDELAY_AT: 'at' };

/**
 * The generator as REPORT_SCHEDULE_SET takes it, and what Download now sends. `problem` says
 * why it cannot go ('' when it can). Fields config.txt manages are left out.
 */
export function reportDraft(f) {
  const options = {
    devices: f.devices || 'delayed', groupBy: f.groupBy || 'cluster',
    columns: f.columns || [], sections: f.sections || [],
    xlsx: !!f.xlsx, csv: !!f.csv, pdf: !!f.pdf,
    top: finite(f.top) ? Math.min(100, Math.max(1, Math.round(f.top))) : 10,
  };
  const clusters = !f.clusters || f.clusters === 'all' ? 'all' : [f.clusters];
  const schedule = {
    enabled: !!f.enabled, to: f.to || [], schedule: f.schedule || 'daily', at: f.at || '07:00',
    period: f.period || 'yesterday', clusters, options,
  };
  for (const m of f.managed || []) { const k = SCHEDULE_KEYS[m]; if (k) delete schedule[k]; }
  let problem = '';
  if (!options.columns.length) problem = 'Pick at least one column.';
  else if (!options.sections.length) problem = 'Pick at least one section.';
  else if (schedule.enabled && Array.isArray(schedule.to) && !schedule.to.length) problem = 'Add at least one address to send it to, or untick Send on the schedule.';
  else if (schedule.at !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.at)) problem = 'At must be a time, HH:MM.';
  return { problem, schedule, options, clusters, period: schedule.period || f.period || 'yesterday', scheduleKind: f.schedule };
}
