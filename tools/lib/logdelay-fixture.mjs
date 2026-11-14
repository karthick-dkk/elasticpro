/**
 * Answers for the LOGDELAY_* messages, shaped as docs/LOGDELAY.md says, for the checks that
 * need a filled log delay report: behaviour-check (jsdom), fit-check and the screenshots
 * (Playwright). A fresh data directory has an empty built-in store, and the store is filled only
 * by the hosted scheduled measurement, so the pages' filled states are drawn from this.
 *
 *   logDelayAnswer(body, clusters, now) → a reply object, or null when `body` is not one of ours
 *
 * `clusters` is [{id, name}] (the fixture's). Deterministic: the same inputs give the same rows.
 * It includes the cases the pages must not get wrong: a silent device, one that can't be
 * measured, a cluster never measured, and days without totals (null in the sparkline).
 */

const DAY = 86400000;
const LEVELS = { noDelayUnder: 30, delayFrom: 30, criticalOver: 60 };
const EXTRAS = ['tag1', 'fwd_tag', 'parser_tag', 'Zone'];

/**
 * Each measured cluster's log time zone (docs/LOGDELAY.md "Time zones"), by position: the first
 * detected IST, the second set to UTC, the third not detected (41 % agree) — the three states the
 * chip, the By cluster column and the device rows must draw.
 */
export function timeZoneOf(ci, now) {
  const base = { majorityPercent: 60, toleranceMinutes: 3, runsNeeded: 3 };
  if (ci === 0) return { ...base, setting: 'detect', mode: 'detected', zone: 'Asia/Kolkata', offsetMinutes: 330, offset: '+05:30', agree: 12, of: 13, pct: 92.3, pluralityOffset: 330, pluralityOffsetText: '+05:30', since: now - 9 * DAY, steadyRuns: 3 };
  if (ci === 1) return { ...base, setting: 'UTC', mode: 'set', zone: 'UTC', offsetMinutes: 0, offset: '+00:00', agree: 10, of: 13, pct: 76.9, pluralityOffset: 0, pluralityOffsetText: '+00:00', since: null, steadyRuns: 3 };
  return { ...base, setting: 'detect', mode: 'none', zone: null, offsetMinutes: null, offset: null, agree: 5, of: 12, pct: 41.7, pluralityOffset: 60, pluralityOffsetText: '+01:00', since: null, steadyRuns: 0 };
}

const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function devicesOf(c, ci, now) {
  const kinds = [['fw', 'firewall'], ['proxy', 'proxy'], ['sw', 'switch'], ['app', 'app'], ['lb', 'loadbalancer'], ['dns', 'dns']];
  const out = [];
  for (let i = 0; i < 14; i++) {
    const [p, tag] = kinds[i % kinds.length];
    const device = `${p}-${c.id.replace(/[^a-z0-9]/gi, '').slice(0, 6)}-${String(i + 1).padStart(2, '0')}`;
    const seed = (ci * 31 + i * 17) % 23;
    let state = 'no_delay'; let nowMinutes = (seed % 9) + 0.5;
    if (i === 0) { state = 'critical'; nowMinutes = 94 - ci * 7; }
    else if (i === 1) { state = 'delay'; nowMinutes = 44 - ci * 3; }
    else if (i === 2 && ci === 0) { state = 'silent'; nowMinutes = null; }
    else if (i === 3 && ci === 0) { state = 'unmeasured'; nowMinutes = null; }
    else if (i === 4) { nowMinutes = 18.5; }   // under the delay line: no little-delay band since 0.3.62
    // The zone step: the cluster's offset taken out of the raw gap; one device on the IST cluster
    // sits at +08:00 (other time zone, not late); nothing is taken out where no zone is known.
    const tz = timeZoneOf(ci, now);
    const clusterTzOffset = tz.offsetMinutes;
    let tzOffsetMinutes = clusterTzOffset; let deviceTzOffset = clusterTzOffset;
    if (ci === 0 && i === 5) { state = 'other_tz'; nowMinutes = 1; tzOffsetMinutes = 480; deviceTzOffset = 480; }
    const rawGapMinutes = nowMinutes === null ? null : nowMinutes + (tzOffsetMinutes || 0);
    const late = state === 'critical' || state === 'delay';
    const episodes = late ? 5 - ci : seed % 3;
    const extras = { tag1: tag, fwd_tag: `syslog-${c.id.slice(0, 4)}-0${(i % 3) + 1}`, parser_tag: i % 2 ? 'fortigate-grok' : 'generic-json', Zone: state === 'other_tz' ? 'SG' : `dc${(i % 2) + 1}` };
    out.push({
      device, cluster: c.id, clusterName: c.name, state, nowMinutes, zone: extras.Zone, tag1: extras.tag1, inLastRun: state !== 'silent',
      rawGapMinutes, tzOffsetMinutes: nowMinutes === null ? null : tzOffsetMinutes, deviceTzOffset: nowMinutes === null ? null : deviceTzOffset, clusterTzOffset,
      medianMinutes: state === 'unmeasured' ? null : 3 + (seed % 5), maxMinutes: late ? 212 - i * 20 : 20 + seed,
      episodes, solved: late ? episodes - 1 : episodes, lateMs: late ? (18 - i * 3) * 3600000 + 40 * 60000 : episodes * 45 * 60000,
      lastStarted: episodes ? now - (late ? 3 : 40 + i) * 3600000 : null,
      lastSolved: late || !episodes ? null : now - (38 + i) * 3600000,
      lateSince: late ? now - 3 * 3600000 : null,
      docsPerDay: state === 'unmeasured' ? null : 41000 - i * 2500,
      lastArrival: state === 'silent' ? now - 5 * 3600000 : now - 20 * 60000,
      lastEvent: state === 'unmeasured' ? null : now - 20 * 60000 - (nowMinutes || 0) * 60000,
      silentSince: state === 'silent' ? now - 5 * 3600000 : null,
      extras,
    });
  }
  return out;
}

function daysOf(n, now, ci, devices) {
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const day = ymd(now - k * DAY);
    if (k === 9 || (ci === 1 && k === 4)) { out.push({ day, devices: 0, onTime: 0, little: 0, delayed: 0, critical: 0, clockAhead: 0, silent: 0, unmeasured: 0, started: 0, solved: 0, lateHours: 0, medianMinutes: null, measured: 0, complete: true, onTimeAll: 0, late: 0 }); continue; }
    const delayed = 1 + ((k * 7 + ci * 3) % 4); const critical = (k * 5 + ci) % 3;
    const silent = k % 4 === 0 ? 1 : 0;
    const onTimeAll = devices - delayed - critical - silent;
    out.push({ day, devices, onTime: onTimeAll, little: 0, delayed, critical, clockAhead: 0, otherTz: ci === 0 ? 1 : 0, silent, unmeasured: 0, started: (k % 3), solved: (k % 2),
      lateHours: delayed * 1.5, medianMinutes: 4.1, measured: devices - silent, complete: k > 0, onTimeAll, late: delayed + critical });
  }
  return out;
}

function totalsOf(rows) {
  const t = { devices: rows.length, measured: 0, onTime: 0, noDelay: 0, little: 0, delay: 0, critical: 0, clockAhead: 0, otherTz: 0, silent: 0, unmeasured: 0 };
  for (const r of rows) {
    if (r.state === 'no_delay') t.noDelay++; else if (r.state === 'little') t.little++; else if (r.state === 'delay') t.delay++;
    else if (r.state === 'critical') t.critical++; else if (r.state === 'clock_ahead') t.clockAhead++; else if (r.state === 'other_tz') t.otherTz++;
    else if (r.state === 'silent') t.silent++; else t.unmeasured++;
  }
  t.onTime = t.noDelay + t.little + t.clockAhead;
  t.late = t.delay + t.critical;
  t.measured = t.devices - t.silent - t.unmeasured;
  const pct = (n) => (t.devices ? Math.round((n / t.devices) * 1000) / 10 : null);
  return { ...t, pctOnTime: pct(t.onTime), pctLate: pct(t.late), pctSilent: pct(t.silent), pctUnmeasured: pct(t.unmeasured) };
}

function sumDays(lists) {
  const by = new Map();
  for (const l of lists) for (const d of l) {
    const a = by.get(d.day) || { day: d.day, devices: 0, onTime: 0, little: 0, delayed: 0, critical: 0, clockAhead: 0, otherTz: 0, silent: 0, unmeasured: 0, started: 0, solved: 0, lateHours: 0, medianMinutes: null, measured: 0, complete: d.complete, onTimeAll: 0, late: 0 };
    for (const k of ['devices', 'onTime', 'little', 'delayed', 'critical', 'clockAhead', 'otherTz', 'silent', 'unmeasured', 'started', 'solved', 'lateHours', 'measured', 'onTimeAll', 'late']) a[k] += d[k] || 0;
    by.set(d.day, a);
  }
  return [...by.values()];
}

/** Today's measurement windows of 2 hours up to now (docs/LOGDELAY.md "windows"): newly late, solved, still late. */
function windowsOf(now, ci, late) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const out = [];
  for (let from = d.getTime(); from <= now; from += 2 * 3600000) {
    const to = from + 2 * 3600000;
    const k = Math.round((from - d.getTime()) / 7200000);
    const hh = (ms) => `${String(new Date(ms).getHours()).padStart(2, '0')}:${String(new Date(ms).getMinutes()).padStart(2, '0')}`;
    out.push({ from, to, label: `${hh(from)}–${hh(to)}`, newlyLate: (k + ci) % 3 === 0 ? 1 : 0, solved: (k + ci) % 4 === 0 ? 1 : 0, stillLate: Math.max(0, late - ((k + ci) % 3)), complete: now >= to });
  }
  return out;
}

/** How the last run read a cluster (docs/LOGDELAY.md "Measurement" lastRead). */
const lastRead = (rows, now) => ({ at: now - 4 * 60000, from: now - 2 * 3600000 - 4 * 60000, to: now - 4 * 60000,
  devices: rows.filter((r) => r.inLastRun).length, pages: 1, complete: true, truncated: false });

const FINDINGS = (c, rows) => [
  { cluster: c.id, clusterName: c.name, step: 'forwarder', stepLabel: 'Forwarder', devices: rows.slice(0, 2).map((r) => r.device), group: ['fwd_tag', rows[0].extras.fwd_tag],
    why: `its forwarder ${rows[0].extras.fwd_tag} is holding logs back; devices on the other forwarders were on time at the same moments.`,
    fix: `check ${rows[0].extras.fwd_tag}: its queue or disk buffer, and the link to Logstash.`, evidence: { devices: 2, ofTag: 3, otherTagsLatePct: 0 }, missing: [] },
  { cluster: c.id, clusterName: c.name, step: 'unknown', stepLabel: 'Not enough evidence', devices: [rows[5].device], group: null,
    why: 'late, but no pattern matches. Shown as is; nothing is guessed.', fix: '', evidence: {}, missing: ['parser_tag on these devices', 'more measurements'] },
  ...(rows.some((r) => r.state === 'other_tz') ? [{ cluster: c.id, clusterName: c.name, step: 'device_time_zone', stepLabel: 'Device clock / parser', devices: rows.filter((r) => r.state === 'other_tz').map((r) => r.device),
    group: ['deviceTimeZone', '+08:00'], why: 'the device’s logs are stamped in another time zone (+08:00) than the cluster’s (+05:30): the gap sits at that offset run after run, so no log is actually late',
    fix: 'set the device’s clock to the cluster’s zone, or give the parser the device’s zone — for example Logstash date { timezone => "Asia/Singapore" } (a zone at +08:00)',
    evidence: { devices: 1, deviceOffsetMinutes: 480, clusterOffsetMinutes: 330, steadyRuns: 2 }, missing: [] }] : []),
];

const RULES = [
  { pattern: 'Device’s gap is a steady time-zone offset different from its cluster’s (+08:00 on an IST cluster)', step: 'device_time_zone', stepLabel: 'Device clock / parser', readFrom: 'the raw gap against every real UTC offset, run after run', recommendation: 'Set the device’s time zone, or the parser’s date filter time zone (Logstash date { timezone => "…" })' },
  { pattern: 'Most devices share one offset and the cluster has no zone set', step: 'cluster', stepLabel: 'Cluster', readFrom: 'the offsets of all measured devices over the last 3 runs', recommendation: 'Confirm the detected zone in Edit cluster › Log time zone, or set it' },
  { pattern: 'Many devices late in the same windows, across forwarders', step: 'elasticsearch', stepLabel: 'Elasticsearch', readFrom: 'delay periods + the cluster’s write rejections, disk watermark, snapshot times', recommendation: 'Move the snapshot or batch job; add indexing capacity; free disk' },
  { pattern: 'Late devices share one fwd_tag or Zone; others there on time', step: 'forwarder', stepLabel: 'Forwarder', readFrom: 'delay periods grouped by fwd_tag and Zone', recommendation: 'Check that forwarder’s queue, buffer and link' },
  { pattern: 'Late devices share one parser_tag', step: 'parser', stepLabel: 'Parser', readFrom: 'delay periods grouped by parser_tag', recommendation: 'Tune that pipeline’s filters; give it its own workers' },
  { pattern: 'Delay steady at a time-zone offset (60, 120, 330 min…) or negative, after the cluster’s zone is taken out', step: 'device_clock', stepLabel: 'Device clock', readFrom: 'the spread of one device’s delays', recommendation: 'Fix the device’s time zone and NTP' },
  { pattern: 'Silent, then a burst of old logs', step: 'device_link', stepLabel: 'Device', readFrom: 'silences + delay at the first logs after them', recommendation: 'Check the device’s connection' },
  { pattern: 'Nothing above', step: 'unknown', stepLabel: 'Not enough evidence', readFrom: '—', recommendation: '"Not enough evidence", never a guess' },
];

/** The fixture's whole state for `clusters` at `now`. The last cluster is never measured. */
export function logDelayData(clusters, now = Date.now()) {
  const measured = clusters.length > 1 ? clusters.slice(0, -1) : clusters;
  const per = measured.map((c, ci) => ({ c, ci, rows: devicesOf(c, ci, now) }));
  return { measured, per, never: clusters.length > 1 ? clusters.slice(-1) : [] };
}

export function logDelayAnswer(body, clusters, now = Date.now()) {
  const t = String((body && body.type) || '');
  if (!t.startsWith('LOGDELAY_') && !(t.startsWith('REPORT_') && body.kind === 'log_delay')) return null;
  const { per, never } = logDelayData(clusters, now);
  const only = Array.isArray(body.clusterIds) && body.clusterIds.length ? new Set(body.clusterIds) : null;
  const sel = per.filter((p) => !only || only.has(p.c.id));
  const n = body.days || 30;
  const from = body.from || ymd(now - (n - 1) * DAY); const to = body.to || ymd(now);
  const common = { ok: true, from, to, now, label: `${from} – ${to}`, everyHours: 2 };
  const fields = { pattern: 'logstash-*', device: 'src_hostname.keyword', arrival: '@timestamp', eventTime: ['event_created', 'ingested_time'], extras: EXTRAS };
  // Each device row's own finding (LOGDELAY_SUMMARY/CLUSTER `fix`, docs/LOGDELAY.md "Recommended fixes"): the late ones share a forwarder finding.
  const fixOf = (p, r) => (r.state === 'critical' || r.state === 'delay' ? { ...FINDINGS(p.c, p.rows)[0], devices: [r.device] } : r.state === 'other_tz' ? { ...FINDINGS(p.c, p.rows).find((f) => f.step === 'device_time_zone'), devices: [r.device] } : null);
  const withFix = (p) => p.rows.map((r) => ({ ...r, fix: fixOf(p, r) }));
  if (t === 'LOGDELAY_SUMMARY') {
    const rows = sel.flatMap(withFix);
    const daysPer = sel.map((p) => daysOf(n, now, p.ci, p.rows.length));
    const byCluster = sel.map((p, i) => {
      const tt = totalsOf(p.rows);
      return { id: p.c.id, name: p.c.name, devices: tt.devices, measured: tt.measured, lateNow: tt.late, delay: tt.delay, critical: tt.critical, silent: tt.silent, unmeasured: tt.unmeasured,
        windows: windowsOf(now, p.ci, tt.late), fixes: FINDINGS(p.c, p.rows),
        otherTz: tt.otherTz, timeZone: timeZoneOf(p.ci, now),
        below: tt.devices - tt.late, belowPct: Math.round(((tt.devices - tt.late) / tt.devices) * 1000) / 10, latePct: Math.round((tt.late / tt.devices) * 1000) / 10,
        belowPctPrevious: 95.2 - p.ci, newToday: p.ci === 0 ? 2 : 0, sparkline: daysPer[i].map((d) => (d.devices ? d.late : null)), sparklineDays: daysPer[i].map((d) => d.day),
        worst: { device: p.rows[0].device, minutes: p.rows[0].nowMinutes, state: 'critical' }, levels: LEVELS, lastRunAt: now - 4 * 60000,
        counts: { inLastRun: p.rows.filter((r) => r.inLastRun).length, now: p.rows.length, inRange: p.rows.length, lastRead: lastRead(p.rows, now) },
        lastRead: lastRead(p.rows, now) };
    });
    for (const c of never.filter((x) => !only || only.has(x.id))) {
      byCluster.push({ id: c.id, name: c.name, devices: 0, measured: 0, lateNow: 0, delay: 0, critical: 0, silent: 0, unmeasured: 0, otherTz: 0, below: 0, belowPct: null, latePct: null,
        timeZone: { setting: 'detect', mode: 'none', zone: null, offsetMinutes: null, offset: null, agree: null, of: null, pct: null, since: null, steadyRuns: 0, runsNeeded: 3, majorityPercent: 60, toleranceMinutes: 3 },
        belowPctPrevious: null, newToday: 0, sparkline: [], sparklineDays: [], worst: null, levels: LEVELS, lastRunAt: null, windows: [], fixes: [],
        counts: { inLastRun: 0, now: 0, inRange: 0, lastRead: null }, lastRead: null });
    }
    return { ...common, clusters: clusters.length, measuredClusters: sel.length, totals: totalsOf(rows),
      reduced: [{ hours: 2, n: 1 }, { hours: 4, n: 2 }, { hours: 6, n: 3 }, { hours: 12, n: 4 }, { hours: 24, n: 6 }],
      newlyLateToday: 2, solvedToday: 1, yesterday: { newlyLate: 3, solved: 4, averageLastedMs: 6600000 }, windows: windowsOf(now, 0, totalsOf(rows).late),
      days: sumDays(daysPer), byCluster, devices: rows, devicesTotal: rows.length, devicesInRange: rows.length,
      devicesInLastRun: rows.filter((r) => r.inLastRun).length, devicesTruncated: false,
      schedule: { supported: true, enabled: true, everyHours: 2, destination: 'builtin', lastRunAt: now - 4 * 60000, state: {} } };
  }
  if (t === 'LOGDELAY_CLUSTER') {
    const p = per.find((x) => x.c.id === body.clusterId);
    if (!p) {
      const c = clusters.find((x) => x.id === body.clusterId);
      if (!c) return { ok: false, kind: 'not_found', message: `no cluster ${body.clusterId}` };
      return { ...common, cluster: c.id, name: c.name, levels: LEVELS, fields, lastRunAt: null, totals: totalsOf([]), started: 0, solved: 0, medianNow: null, medianPrevious: null, windows: [], days: [], devices: [],
        timeZone: { setting: 'detect', mode: 'none', zone: null, offsetMinutes: null, offset: null, agree: null, of: null, pct: null, since: null, steadyRuns: 0, runsNeeded: 3, majorityPercent: 60, toleranceMinutes: 3 } };
    }
    return { ...common, cluster: p.c.id, name: p.c.name, levels: LEVELS, fields, lastRunAt: now - 4 * 60000, lastRead: lastRead(p.rows, now), timeZone: timeZoneOf(p.ci, now),
      counts: { inLastRun: p.rows.filter((r) => r.inLastRun).length, now: p.rows.length, inRange: p.rows.length, lastRead: lastRead(p.rows, now) },
      totals: totalsOf(p.rows), started: 7, solved: 5, fixes: FINDINGS(p.c, p.rows),
      medianNow: 5.1, medianPrevious: 4.2, windows: windowsOf(now, p.ci, totalsOf(p.rows).late), days: daysOf(n, now, p.ci, p.rows.length), devices: withFix(p) };
  }
  if (t === 'LOGDELAY_DEVICE') {
    const p = per.find((x) => x.c.id === body.clusterId);
    const r = p && p.rows.find((x) => x.device === body.device);
    if (!r) return { ok: false, kind: 'not_found', message: `${body.device} is not in the tracker` };
    const start = Date.parse(`${from}T00:00:00`);
    const points = [];
    for (let t2 = start; t2 <= now; t2 += 2 * 3600000) {
      const k = (t2 - start) / (2 * 3600000);
      let m = 3 + (k * 37) % 7;
      if (k % 97 > 40 && k % 97 < 48) m = 35 + (k % 97 - 40) * 22;
      if (k % 61 === 13) m = null;
      points.push({ t: t2, m, s: m === null ? 'silent' : m > 60 ? 'critical' : m >= 30 ? 'delay' : 'no_delay' });
    }
    if (r.nowMinutes !== null) points.push({ t: now - 60000, m: r.nowMinutes, s: r.state });
    const late = r.state === 'critical' || r.state === 'delay';
    const periods = [
      ...(late ? [{ started: now - 3 * 3600000, solved: null, lastedMs: 3 * 3600000, worstMinutes: r.nowMinutes, worstState: r.state, lastMinutes: r.nowMinutes, lastState: r.state, measurements: 2, pattern: null, extras: r.extras }] : []),
      { started: now - 10 * DAY, solved: now - 10 * DAY + 3.5 * 3600000, lastedMs: 3.5 * 3600000, worstMinutes: 61, worstState: 'critical', lastMinutes: 12, lastState: 'no_delay', measurements: 3, pattern: 'a whole hour off: time zone', extras: r.extras },
      { started: now - 19 * DAY, solved: now - 19 * DAY + 10.5 * 3600000, lastedMs: 10.5 * 3600000, worstMinutes: 212, worstState: 'critical', lastMinutes: 8, lastState: 'no_delay', measurements: 6, pattern: null, extras: r.extras },
    ];
    return { ...common, device: r.device, cluster: p.c.id, clusterName: p.c.name, levels: LEVELS, state: r.state, nowMinutes: r.nowMinutes, lateSince: r.lateSince, silentSince: r.silentSince,
      medianMinutes: r.medianMinutes, worst: { minutes: 212, at: now - 19 * DAY + 5 * 3600000 }, episodes: periods.length, solved: periods.filter((x) => x.solved).length,
      lateMs: r.lateMs, latePct: 2.6, docsPerDay: r.docsPerDay, lastSilence: now - 8 * DAY, extras: r.extras, zone: r.zone, tag1: r.tag1, inLastRun: r.inLastRun, lastArrival: r.lastArrival, lastEvent: r.lastEvent, firstSeen: now - 40 * DAY,
      timeZone: timeZoneOf(p.ci, now), rawGapMinutes: r.rawGapMinutes, tzOffsetMinutes: r.tzOffsetMinutes, deviceTzOffset: r.deviceTzOffset, clusterTzOffset: r.clusterTzOffset,
      points, periods, silences: [{ from: now - 8 * DAY, to: now - 8 * DAY + 40 * 60000, burstDocs: 6800, burstMinutes: 90 }],
      insights: { peak: { minutes: 212, at: now - 19 * DAY + 5 * 3600000 }, average: { minutes: 9, measurements: points.length },
        longest: { lastedMs: 10.5 * 3600000, started: now - 19 * DAY, solved: now - 19 * DAY + 10.5 * 3600000 }, solvedIn: { averageMs: 7 * 3600000, solved: 2 },
        lateMostOften: { label: '14:00–18:00', count: 2, of: 3 } },
      finding: late ? FINDINGS(p.c, p.rows)[0] : null,
      clusters: per.map((q) => { const d = daysOf(n, now, q.ci, q.rows.length); const s = d.map((x) => (x.devices ? x.late : null)); const peak = Math.max(...s.filter((v) => v !== null));
        return { id: q.c.id, name: q.c.name, lateNow: totalsOf(q.rows).late, sparkline: s, days: d.map((x) => x.day), peak, peakDay: d[s.indexOf(peak)].day }; }),
      olderMeasurements: [], olderTruncated: false };
  }
  if (t === 'LOGDELAY_SEARCH') {
    const name = String(body.name || '').toLowerCase();
    const re = body.value ? new RegExp(`^${String(body.value).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : null;
    const rows = sel.flatMap((p) => p.rows).filter((r) => (!name || r.device.toLowerCase().includes(name))
      && (!re || re.test(['device', 'src_hostname', 'src_device'].includes(body.field) || !body.field ? r.device : String(r.extras[body.field] ?? ''))));
    return { ok: true, matches: rows.length, truncated: false, clusters: [...new Set(rows.map((r) => r.cluster))], devices: rows.slice(0, body.max || 50), from, to };
  }
  if (t === 'LOGDELAY_FIXES') {
    const findings = sel.flatMap((p) => FINDINGS(p.c, p.rows));
    const devices = sel.flatMap((p) => p.rows.filter((r) => r.state === 'critical' || r.state === 'delay').map((r) => ({ device: r.device, cluster: r.cluster, clusterName: r.clusterName,
      state: r.state, nowMinutes: r.nowMinutes, zone: r.zone, tag1: r.tag1, step: 'forwarder', stepLabel: 'Forwarder', why: `Its forwarder ${r.extras.fwd_tag} is holding logs back`, fix: `Check ${r.extras.fwd_tag} queue, buffer and link`, group: ['fwd_tag', r.extras.fwd_tag] })));
    return { ok: true, from: ymd(now - 6 * DAY), to: ymd(now), now, findings, devices, rules: RULES };
  }
  if (t === 'LOGDELAY_SETTINGS_GET') {
    return { ok: true, supported: true,
      settings: { levels: LEVELS, silentAfterHours: 2, fields: { device: 'src_hostname', arrival: '@timestamp', eventTime: ['event_created'], extras: EXTRAS }, clusters: {}, setBy: 'Admin', setAt: now - DAY },
      resolved: clusters.map((c, ci) => ({ id: c.id, name: c.name, levels: LEVELS, levelsFrom: 'settings', fields, logTimeZone: timeZoneOf(ci, now).setting, timeZone: timeZoneOf(ci, now) })),
      timeZones: { toleranceMinutes: 3, majorityPercent: 60, steadyRuns: 3, server: 'Asia/Kolkata' },
      schedule: { enabled: true, everyHours: 2, destination: 'builtin', clusters: [], maxDevices: 20000, state: {}, blocked: null },
      builtinStore: { keepDays: 90, bytes: 1234567, dir: 'logdelay' }, extrasDefault: EXTRAS, uiCopy: '' };
  }
  if (t === 'LOGDELAY_SETTINGS_SET') return { ok: true, settings: body.settings };
  if (t === 'REPORT_SCHEDULE_GET') {
    return { ok: true, kind: 'log_delay', enabled: false, to: [], cc: [], bcc: [], schedule: 'daily', at: '07:00', period: 'yesterday', clusters: 'all', subject: '',
      lastSent: null, managed: [], timer: true, nextSendAt: null, mailConfigured: true, nextPeriod: null,
      options: { devices: 'delayed', groupBy: 'cluster', columns: ['device', 'cluster', 'nowMinutes', 'level', 'startedSolved', 'Zone', 'tag1', 'fwd_tag', 'parser_tag', 'arrival', 'eventTime'],
        sections: ['summary', 'lateEvery2h', 'windows', 'dayByDay', 'topDelayed', 'fixes'], xlsx: true, csv: true, pdf: false, top: 10 },
      optionsChoices: { devices: ['delayed', 'all'], groupBy: ['cluster', ...EXTRAS],
        columns: ['device', 'cluster', 'nowMinutes', 'level', 'startedSolved', 'median', 'max', 'episodes', 'lateTime', 'docsPerDay', 'arrival', 'eventTime', 'lateSince', 'rawGap', 'deviceTimeZone', ...EXTRAS],
        sections: ['summary', 'lateEvery2h', 'windows', 'dayByDay', 'topDelayed', 'fixes'], pdf: 'not built: no PDF writer in this build' } };
  }
  if (t === 'REPORT_SCHEDULE_SET') return { ok: true, kind: 'log_delay', ...body };
  if (t === 'REPORT_SEND_NOW' || t === 'REPORT_RUN') return { ok: true, job: { id: 'ld-job-1', reportKind: 'log_delay', status: 'queued' } };
  return null;
}
