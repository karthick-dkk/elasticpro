/**
 * What the fleet-wide Reports sections are drawn from: one daily record per cluster
 * (VOLUME_DAILY, the record the core keeps, docs/VOLUME.md), the data-node disk
 * (core/volume.js dataNodeDisk) and the cluster's own settings. The figures themselves are
 * core/volume-daily.js (event_logsize) and core/volume.js (disk, storage plan); this module
 * only fetches and keeps.
 *
 * Bounded: at most four clusters are asked at once, each once per visit unless a run
 * (Collect now / Measure size) asks again.
 */

import { state } from '../core/state.js';
import { runBounded } from '../core/fleet.js';
import { volumeDaily, perDayEventBytes } from '../core/volume-daily.js';
import { collectNow, collecting, reportStatus, FOLLOW_LIMIT_MS } from './collect.js';
import { dataNodeDisk, storagePlanRow, parseRetention, parseSize, volumeSettings, diskLastsDays } from '../core/volume.js';
import { clusterKind } from '../core/cluster-kind.js';

/** Days of record asked for: the month so far, 30 days of chart, and the 7-day window before yesterday. */
export const RECORD_DAYS = 40;
/** The rate the Reports page plans on (docs/REPORTS.md): the 7-day average. */
export const RATE_DAYS = 7;

const POLL_MS = 3000;

/** id → { loading, reply, error, at } */
const records = new Map();
export const recordState = { rev: 0, unsupported: false, noStore: false, polling: null };
let listeners = [];
const changed = () => { recordState.rev++; for (const fn of listeners) { try { fn(); } catch (_) { /* the rest still hear */ } } };
export function onRecords(fn) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; }

export function recordOf(id) { const e = records.get(id); return e ? e.reply : null; }
export function recordEntry(id) { return records.get(id) || null; }

async function loadOne(id, force) {
  const had = records.get(id);
  if (!force && had && (had.loading || had.reply || had.error)) return;
  const ent = { loading: true, reply: had ? had.reply : null, error: null, at: had ? had.at : 0 };
  records.set(id, ent);
  let res;
  try { res = await volumeDaily(id, { days: RECORD_DAYS, avgDays: RATE_DAYS }); } catch (e) { res = { ok: false, message: e && e.message }; }
  ent.loading = false;
  if (res.unsupported) recordState.unsupported = true;
  else if (res.kind === 'no_store') recordState.noStore = true;
  else if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else { ent.reply = res; ent.at = Date.now(); reportStatus(id, res.status); }
}

/** Ask for the records of these clusters that are not here yet. Redraws through onRecords. */
export async function ensureRecords(ids, { force = false } = {}) {
  const want = ids.filter((id) => force || !records.has(id));
  if (!want.length) return;
  for (const id of want) if (!records.has(id)) records.set(id, { loading: true, reply: null, error: null, at: 0 });
  changed();
  await runBounded(want, (id) => loadOne(id, true), { limit: 4 });
  changed();
}

/**
 * Collect now / Measure size: VOLUME_RUN for these clusters (the same request either way,
 * docs/REPORTS.md) through reports/collect.js, which follows the run; the records are read
 * again while it runs. `{ok, level?, message, lines, started, already, tooSoon, skipped}`.
 */
export async function runCollection(ids) {
  const res = await collectNow(ids);
  if (res.unsupported) { recordState.unsupported = true; changed(); return res; }
  if (res.noStore) { recordState.noStore = true; changed(); return res; }
  if (!res.ok) return res;
  if (res.started.length || res.already.length) follow(ids);
  return res;
}

function follow(ids) {
  if (recordState.polling) clearTimeout(recordState.polling.timer);
  const p = { until: Date.now() + FOLLOW_LIMIT_MS, timer: null, ids };
  recordState.polling = p;
  changed();
  const tick = async () => {
    p.timer = null;
    if (recordState.polling !== p) return;
    await runBounded(ids, (id) => loadOne(id, true), { limit: 4 });
    const running = ids.some((id) => { const r = recordOf(id); return collecting(id) || (r && r.status && r.status.running); });
    if (running && Date.now() < p.until) { p.timer = setTimeout(tick, POLL_MS); changed(); return; }
    recordState.polling = null;
    changed();
  };
  p.timer = setTimeout(tick, 1000);
}

/** Stop following and forget every answer: each visit reads the record as it is now. */
export function resetRecords() {
  if (recordState.polling && recordState.polling.timer) clearTimeout(recordState.polling.timer);
  recordState.polling = null;
  records.clear();
  recordState.unsupported = false;
  recordState.noStore = false;
  recordState.rev++;
}
/** A collection ran for these clusters (Collect now on Daily & monthly): their records are asked again. */
export function forgetRecords(ids) {
  for (const id of ids || []) records.delete(id);
  recordState.rev++;
}

/** Stop the run being followed (the page was left); the answers stay. */
export function stopFollowing() {
  if (recordState.polling && recordState.polling.timer) clearTimeout(recordState.polling.timer);
  recordState.polling = null;
}

/** The newest `lastRunAt` among these clusters' records, ms; null when none ran. */
export function lastRunOf(ids) {
  let best = null;
  for (const id of ids) {
    const r = recordOf(id);
    const t = r && r.status && r.status.lastRunAt ? (typeof r.status.lastRunAt === 'number' ? r.status.lastRunAt : Date.parse(r.status.lastRunAt)) : null;
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best;
}

/* ------------------------------- repository size ------------------------------- */

/** Measured repository sizes this session (Measure on the Storage plan), bytes, per cluster. */
export const repoBytes = new Map();

/* ------------------------------- one row per cluster ------------------------------- */

/**
 * Everything one cluster's line on Overview and Capacity is made of. The storage plan row is
 * core/volume.js storagePlanRow, fed the one rate (perDayEventBytes) and the one disk
 * (dataNodeDisk), so the Overview's "fits / short by" and the Storage plan's shortfall are
 * the same calculation.
 */
export function clusterFigures(c) {
  const record = recordOf(c.id);
  const data = state.data.get(c.id) || {};
  const perDay = record ? perDayEventBytes(record, RATE_DAYS) : null;
  const disk = dataNodeDisk(data);
  const kind = clusterKind(c);
  const plan = storagePlanRow({
    perDay,
    headroomPercent: volumeSettings(c).headroomPercent,
    livePolicy: parseRetention(c.liveRetention),
    disk,
    ulm: kind.ulm.enabled && !kind.slmExpected,
    backupPolicy: parseRetention(c.snapshotRetention),
    backupCapacity: parseSize(c.backupCapacity),
    repoBytes: repoBytes.has(c.id) ? repoBytes.get(c.id) : null,
  });
  return { cluster: c, record, data, perDay, disk, kind, plan, lasts: diskLastsDays(disk, perDay) };
}
