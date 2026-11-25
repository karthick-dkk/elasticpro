/**
 * Log delay — can this cluster be analysed at all?
 *
 * Delay is arrival time minus event time, per device. That needs three things present in
 * the indices: a field to group devices by, at least one field carrying when the event
 * actually happened, and the arrival timestamp the page already uses. A cluster missing
 * any of them cannot be analysed.
 *
 * This module is only the preflight. It exists before any aggregation because of how
 * Elasticsearch answers a question about a field it does not have: a terms aggregation on
 * an unmapped field returns zero buckets, with no error and no warning. Run the analysis
 * without asking first and a cluster whose parser changed renders an empty table that
 * reads as "no devices are delayed" — good news, and false. Asking costs one cheap call
 * and turns that into a named refusal.
 *
 *      preflight(cluster)
 *        │
 *        ├── _field_caps on the names the AGGREGATION will use
 *        │
 *        ├── device field present?        no ──┐
 *        ├── any event-time field present? no ──┼──► { ok: false, missing: [...] }
 *        └── both present ──────────────────────┴──► { ok: true, resolved: {...} }
 */

/**
 * The name an aggregation actually runs against.
 *
 * Elasticsearch cannot aggregate a `text` field; the convention is a `.keyword` sub-field
 * beside it. The Python this is ported from appends `.keyword` unless the name already
 * ends in it, or the field is IP-like, or it is `ClientID` — three exceptions that exist
 * because those are mapped as keyword or ip directly.
 *
 * Checking the base name instead of this one is the mistake that makes a preflight pass
 * and the query that follows return nothing.
 */
import { statusFor, levelState, levelsOf, zoneOf, deviceReading } from './delay-levels.js';
import { LOG_TYPE_FIELD, NO_LOG_TYPE, typeLabel } from './log-types.js';
import { correct as correctByZone, matchOffset as matchOffsetFor, offsetLabel as offsetLabelOf } from './log-tz.js';

const IP_LIKE = /(^|[._])(ip|addr|address)([._]|$)/i;
const ALREADY_KEYWORD = /\.keyword$/;
const LITERAL = new Set(['ClientID']);

export function aggregatableName(field) {
  const f = String(field || '');
  if (!f) return '';
  if (ALREADY_KEYWORD.test(f)) return f;
  if (LITERAL.has(f)) return f;
  if (IP_LIKE.test(f)) return f;
  return `${f}.keyword`;
}

/** The delayFields block for a cluster, with the shape guaranteed. */
export function resolveFields(cluster) {
  const d = (cluster && cluster.delayFields) || {};
  return {
    device: d.device || 'src_hostname',
    eventTime: Array.isArray(d.eventTime) && d.eventTime.length
      ? d.eventTime : ['ingested_time', 'event_created', 'event.created'],
    metadata: Array.isArray(d.metadata) ? d.metadata : [],
    arrival: (cluster && cluster.timeField) || '@timestamp',
  };
}

/**
 * Every field name to ask about, in the form it will be used.
 *
 * The device field is asked about by its aggregatable name because that is what the terms
 * aggregation will use. Event-time and arrival are date fields read from `_source`, never
 * aggregated as keywords, so they are asked about as they are.
 */
export function fieldsToProbe(fields, { logType = false } = {}) {
  return [
    aggregatableName(fields.device),
    ...fields.eventTime,
    fields.arrival,
    ...fields.metadata.map(aggregatableName),
    ...(logType ? [LOG_TYPE_FIELD, `${LOG_TYPE_FIELD}.keyword`] : []),
  ];
}

/**
 * The log type field a _field_caps answer allows (0.3.90): `{field, why}`. The field is one and the
 * same on every cluster (log-types.js LOG_TYPE_FIELD, the owner, 2026-11-24); the mapping alone says
 * whether it is aggregated as itself or as its `.keyword`. Not mapped: no field, and why.
 */
export function logTypeFrom(caps) {
  const f = (caps && caps.fields) || {};
  const aggregatable = (name) => f[name] && Object.values(f[name]).every((t) => !t || t.aggregatable !== false);
  if (aggregatable(LOG_TYPE_FIELD)) return { field: LOG_TYPE_FIELD, why: null };
  const kw = `${LOG_TYPE_FIELD}.keyword`;
  if (aggregatable(kw)) return { field: kw, why: null };
  return { field: null, why: f[LOG_TYPE_FIELD] ? `${LOG_TYPE_FIELD} is mapped as text without a keyword` : `${LOG_TYPE_FIELD} is not in the mapping` };
}

/**
 * Read a _field_caps response into the set of names that exist.
 *
 * A name is present when the response lists it at all; `_field_caps` omits what it cannot
 * find rather than returning it empty, so absence from the map is the answer.
 */
export function presentFields(caps) {
  const f = (caps && caps.fields) || {};
  return new Set(Object.keys(f));
}

/**
 * Decide whether the analysis can run, from a _field_caps response.
 *
 * Separated from the call so it can be exercised without a cluster: this is the part with
 * the rules in it, and the part worth being sure about.
 */
export function decide(fields, caps) {
  const have = presentFields(caps);
  const deviceName = aggregatableName(fields.device);

  const deviceOk = have.has(deviceName);
  const eventOk = fields.eventTime.filter((f) => have.has(f));
  const arrivalOk = have.has(fields.arrival);

  const missing = [];
  if (!deviceOk) missing.push(deviceName);
  if (!arrivalOk) missing.push(fields.arrival);
  // Only one event-time candidate has to exist. Naming all of them when none does is
  // more useful than naming the first — it says what the parser could be producing.
  if (!eventOk.length) missing.push(...fields.eventTime);

  return {
    ok: deviceOk && arrivalOk && eventOk.length > 0,
    missing,
    resolved: {
      device: deviceOk ? deviceName : null,
      eventTime: eventOk[0] || null,
      // Every candidate the mapping has, in the configured order: a document is read by the
      // first of them it carries (the core's rule, logdelay/measure.rs). Reading only the
      // first one the mapping has made every device whose logs carry another one "error".
      eventTimes: eventOk,
      arrival: arrivalOk ? fields.arrival : null,
      metadata: fields.metadata.map(aggregatableName).filter((m) => have.has(m)),
    },
    // What was asked for but is not there, so the page can say which context columns
    // will be blank rather than pretending the data has them.
    metadataMissing: fields.metadata.map(aggregatableName).filter((m) => !have.has(m)),
  };
}

/**
 * Ask one cluster whether it can be analysed.
 *
 * Returns the same shape whether the answer is yes, no, or the question could not be
 * asked — a cluster that refuses the call is "unknown", never "no fields".
 *
 * `logType: true` asks for the log type field in the same call: `resolved.logType` is its name or
 * null and `logTypeWhy` says why null. Without it nothing changes — a display link's measurement
 * (auth.rs delay_search_body) holds only the device aggregation.
 */
export async function preflight(client, cluster, { logType = false } = {}) {
  const fields = resolveFields(cluster);
  if (!client) return { ok: false, unknown: true, error: 'not connected', fields, missing: [], resolved: {} };
  try {
    const caps = await client.fieldCaps(cluster.logIndexPattern || 'logstash-*', fieldsToProbe(fields, { logType }));
    const out = { ...decide(fields, caps), unknown: false, error: null, fields };
    if (logType) {
      const t = logTypeFrom(caps);
      out.resolved.logType = t.field;
      out.logTypeWhy = t.why;
    }
    return out;
  } catch (e) {
    const es = e.res && e.res.json && e.res.json.error;
    return {
      ok: false, unknown: true, missing: [], resolved: {}, fields,
      error: (es && (es.reason || es.type)) || e.message || String(e),
    };
  }
}

/* ------------------------------- classification ------------------------------- */

/**
 * What a delay means is the core's: its levels per cluster (docs/LOGDELAY.md "Levels"), read
 * by core/delay-levels.js and never kept here. `levels` below is always such a set —
 * {noDelayUnder, delayFrom, criticalOver} — from levelsOf(clusterId), or Play's own watch
 * rules on the wall. A cluster whose levels the core has not said is UNKNOWN, never OK.
 *
 * Order matters (delay-levels.js levelState): clock ahead is tested first, critical is strictly
 * above the critical line (exactly 60 min is still delayed), a delay that cannot be computed
 * is ERROR and a device that sent nothing is NO_DATA; neither is zero.
 */
export const STATUS = {
  OK: { label: 'ok', cls: 'green' },
  DELAYED: { label: 'delayed', cls: 'yellow' },
  CRITICAL: { label: 'critical', cls: 'red' },
  PART_DELAY: { label: 'part delayed', cls: 'part' },
  CLOCK_AHEAD: { label: 'clock ahead', cls: 'grey' },
  OTHER_TZ: { label: 'other time zone', cls: 'blue' },
  ERROR: { label: 'error', cls: 'grey' },
  NO_DATA: { label: 'no data', cls: 'grey' },
  UNKNOWN: { label: 'levels unknown', cls: 'grey' },
};

/**
 * The shape of a delay, not its size: how close to a real time-zone offset (the core's
 * tz.rs TOLERANCE_MINUTES — one figure; tools/unit holds them equal), and what counts as very long.
 */
export const PATTERN = Object.freeze({ tzToleranceMinutes: 3, veryLongMinutes: 24 * 60 });

/** Why it is in that state, in the words an operator would use. */
export function reasonFor(status, trend = 'NO_TREND') {
  const base = {
    OK: 'Healthy — within threshold',
    DELAYED: 'Pipeline lag: forwarder batching or network latency',
    CRITICAL: 'Severe lag: forwarder backlog, pipeline backpressure, or device clock behind',
    PART_DELAY: 'Only some of its log types are late; the others arrive on time',
    CLOCK_AHEAD: 'Device clock is ahead of real time (NTP)',
    OTHER_TZ: 'Logs stamped in another time zone than the cluster’s (device clock or parser date filter)',
    ERROR: 'Timestamp missing or unparseable (parser)',
    NO_DATA: 'No logs received in the window',
  }[status] || status;
  if (trend === 'WORSENING' && (status === 'DELAYED' || status === 'CRITICAL')) {
    return `${base} — the backlog is growing`;
  }
  if (trend === 'IMPROVING' && (status === 'DELAYED' || status === 'CRITICAL')) {
    return `${base} — the queue is draining`;
  }
  return base;
}

/** What to do about it. */
export function fixFor(status) {
  return {
    OK: 'None',
    DELAYED: 'Reduce the forwarder flush interval; check the site link; tune Logstash batch and workers',
    CRITICAL: 'Check the forwarder queue and service; Logstash backpressure; Elasticsearch write rejections; NTP on the device',
    PART_DELAY: 'Look at the late log type’s path (its forwarder input / parser), not the device or the network',
    CLOCK_AHEAD: 'Fix NTP and timezone on the source device, and the parser date filter',
    OTHER_TZ: 'Set the device’s time zone, or the parser’s date filter time zone (Logstash date { timezone => "…" })',
    ERROR: 'Fix the parser, or point eventTime at the field your pipeline actually writes',
    NO_DATA: 'Verify the device and its forwarder are alive and shipping',
  }[status] || '';
}

/**
 * Which way it is moving, from a series of delays oldest-first.
 *
 * Compares the first half against the second rather than first-against-last, because one
 * outlying sample at either end should not decide the answer. Fewer than four samples is
 * NO_TREND: two points make a line through noise, not a trend.
 */
export function trend(series, minChangePct = 20) {
  const xs = (series || []).filter((v) => typeof v === 'number' && isFinite(v));
  if (xs.length < 4) return 'NO_TREND';
  const mid = Math.floor(xs.length / 2);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const first = mean(xs.slice(0, mid));
  const second = mean(xs.slice(mid));
  if (Math.abs(first) < 1 && Math.abs(second) < 1) return 'NO_TREND';
  const base = Math.max(Math.abs(first), 1);
  const changePct = ((second - first) / base) * 100;
  if (changePct >= minChangePct) return 'WORSENING';
  if (changePct <= -minChangePct) return 'IMPROVING';
  return 'NO_TREND';
}

/**
 * What the shape of the delay suggests, beyond how big it is.
 *
 * The one worth having: a delay within a few minutes of a real time-zone offset is almost never
 * a queue. Queues drift; offsets do not. A device an exact 5 h 30 behind has its clock or its
 * parser in the wrong zone, and telling someone to tune their forwarder would send them to fix
 * the wrong thing. Every real offset counts, half- and quarter-hours included (core/log-tz.js
 * `matchOffset`, the same list as the core's tz.rs) — until 0.3.62 only whole hours did, so
 * +05:30 and +05:45 were never recognised. `deviceOffset` (from `correctByZone`) is the offset the
 * raw gap sits at; given, it is used instead of matching again.
 */
export function analysePattern(delayMinutes, t = PATTERN, deviceOffset = undefined) {
  if (delayMinutes === null || delayMinutes === undefined || !isFinite(delayMinutes)) {
    return { pattern: '-', note: '' };
  }
  const abs = Math.abs(delayMinutes);
  const off = deviceOffset === undefined ? matchOffsetFor(delayMinutes, t.tzToleranceMinutes) : deviceOffset;
  if (off !== null && off !== 0) {
    const offBy = Math.abs(delayMinutes - off);
    const dir = delayMinutes > 0 ? 'behind' : 'ahead';
    return {
      pattern: 'timezone',
      note: `within ${Math.round(offBy)} min of exactly ${offsetWords(off)} ${dir} — a time-zone offset (${offsetLabelOf(off)}), not a queue`,
    };
  }
  if (abs >= t.veryLongMinutes) {
    return { pattern: 'very-long', note: `more than ${Math.round(t.veryLongMinutes / 60)}h — likely a replay or a stalled forwarder` };
  }
  return { pattern: '-', note: '' };
}

/** "5 h 30", "1 h", "3 h 45": an offset's size in words. */
function offsetWords(minutes) {
  const a = Math.abs(Math.round(minutes));
  return a % 60 ? `${Math.floor(a / 60)} h ${a % 60}` : `${a / 60} h`;
}

/* --------------------------------- the record --------------------------------- */

/**
 * One device's delay, built from a terms bucket and its top_hits document.
 *
 * Every figure the rest of the app shows comes from here, so the arithmetic exists once.
 * A document missing either timestamp yields a null delay and ERROR — never a zero, which
 * would sort as healthy and read as measured. `tz` is the cluster's time zone as the core said
 * it (delay-levels.js `zoneOf`): `delayMinutes` is the corrected delay, `rawGapMinutes` the
 * gap as measured, `tzOffsetMinutes` what was taken out (null = no zone, nothing taken out).
 */
export function recordFrom(bucket, resolved, levels = null, tz = null) {
  const hit = ((((bucket || {}).latest || {}).hits || {}).hits || [])[0];
  const src = (hit && hit._source) || {};
  const newest = docDelay(src, resolved.arrival, eventSource(resolved), tz);
  const { arrival } = newest;
  const types = typesFrom(bucket, resolved, levels, tz);
  const { status, figures, delayLogType } = deviceReading({ newest, types }, levels);
  const { event, delayMinutes, rawGapMinutes, tzOffsetMinutes, deviceTzOffset } = figures;
  const { pattern, note } = analysePattern(rawGapMinutes, PATTERN, deviceTzOffset);

  return {
    device: bucket.key,
    docs: bucket.doc_count || 0,
    arrival,
    event,
    delayMinutes,
    rawGapMinutes,
    tzOffsetMinutes,
    deviceTzOffset,
    clusterTzOffset: tzOffsetMinutes,
    status,
    // Its log types (worst first), or null: the field is not mapped or was not asked for.
    types,
    // With log types: the newest document's figures, and the log type the delay above is of (null: the newest document's).
    ...(types ? { newest, delayLogType } : {}),
    typesTruncated: !!(types && bucket.types && (bucket.types.sum_other_doc_count > 0 || strayType(bucket) !== null)),
    pattern,
    patternNote: note,
    trend: 'NO_TREND',
    reason: reasonFor(status),
    fix: fixFor(status),
    meta: Object.fromEntries((resolved.metadata || []).map((m) => {
      const plain = String(m).replace(/\.keyword$/, '');
      return [plain, dotted(src, plain) ?? dotted(src, m) ?? ''];
    })),
  };
}

/** The log type in the source of the newest document outside the aggregation (an index mapped otherwise), or null. */
function strayType(bucket) {
  const named = (v) => (Array.isArray(v) ? v.map(named).find((x) => x !== null) ?? null : v === null || v === undefined || typeof v === 'object' || !String(v).trim() ? null : String(v).trim());
  const b = bucket && bucket.no_type;
  const hit = b && b.doc_count > 0 ? ((((b.latest || {}).hits || {}).hits) || [])[0] : null;
  return hit ? named(dotted(hit._source || {}, LOG_TYPE_FIELD)) : null;
}

/**
 * A device's log types from its bucket (0.3.90): one per `log_type` value — its newest document,
 * measured as the device's is — and one for the documents without the field (noType). Worst first.
 * null when the search asked for none.
 */
function typesFrom(bucket, resolved, levels, tz) {
  if (!resolved.logType || !bucket || !bucket.types || !Array.isArray(bucket.types.buckets)) return null;
  const one = (b, logType, noType) => {
    const hit = ((((b || {}).latest || {}).hits || {}).hits || [])[0];
    const d = docDelay((hit && hit._source) || {}, resolved.arrival, eventSource(resolved), tz);
    const state = levelState(d.delayMinutes, levels);
    return { logType, noType, label: typeLabel({ logType, noType }), docs: b.doc_count || 0, arrival: d.arrival, event: d.event, delayMinutes: d.delayMinutes,
      rawGapMinutes: d.rawGapMinutes, tzOffsetMinutes: d.tzOffsetMinutes, deviceTzOffset: d.deviceTzOffset, state, status: statusFor(d.delayMinutes, levels) };
  };
  // The core's reading (logdelay/measure.rs types_of): a blank value is no log type; a document outside
  // the aggregation that does carry a value is of that type; one type is listed once, at its newest document.
  const out = [];
  const add = (b, name) => {
    const t = name === null ? one(b, NO_LOG_TYPE, true) : one(b, name, false);
    const i = out.findIndex((x) => x.noType === t.noType && x.logType === t.logType);
    if (i < 0) { out.push(t); return; }
    const docs = out[i].docs + t.docs;
    if (t.arrival !== null && (out[i].arrival === null || t.arrival > out[i].arrival)) out[i] = t;
    out[i].docs = docs;
  };
  for (const b of bucket.types.buckets) { const k = String(b.key_as_string ?? b.key); add(b, k.trim() ? k : null); }
  if (bucket.no_type && bucket.no_type.doc_count > 0) {
    add(bucket.no_type, strayType(bucket));
  }
  const rank = { critical: 0, delay: 1 };
  return out.sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || (b.delayMinutes ?? -Infinity) - (a.delayMinutes ?? -Infinity)
    || String(a.logType).localeCompare(String(b.logType)));
}

/** Whether a record's log type is late now (delayed or critical). */
const typeLate = (t) => LATE_STATUSES.has(t.status);

const dotted = (o, path) => {
  if (o && path && Object.prototype.hasOwnProperty.call(o, path)) return o[path];
  return String(path || '').split('.').reduce((v, k) => (v == null ? v : v[k]), o);
};

/**
 * A date as Elasticsearch hands it back: RFC 3339 text, or epoch milliseconds as a number
 * (a `date` mapped `epoch_millis`). Anything else is NaN — unreadable, never 0.
 */
export function toMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && /^\d{12,14}$/.test(v.trim())) return Number(v.trim());
  return typeof v === 'string' ? Date.parse(v) : NaN;
}

/** The first of `names` the document carries that reads as a date (`toMs`), else NaN. */
function firstMs(src, names) {
  for (const n of names) {
    const t = toMs(dotted(src, n));
    if (Number.isFinite(t)) return t;
  }
  return NaN;
}

/** The event time of one document: the first candidate it carries that reads as a date. */
export function eventMs(src, resolved) {
  return firstMs(src, eventSource(resolved));
}

/**
 * Every event-time candidate: the fields a search brings back in `_source` and the order a
 * document is read by (`resolveFields` lists them as `eventTimes`; a caller with one name
 * only, `eventTime`, is read by that one).
 */
export const eventSource = (resolved) => ((resolved.eventTimes && resolved.eventTimes.length) ? resolved.eventTimes : [resolved.eventTime]);

/**
 * The search the analysis runs.
 *
 * One terms aggregation over the device field with a top_hits picking the newest document
 * per device. `size` bounds the device count; a fleet with more devices than that reports
 * the shortfall rather than silently showing a subset.
 *
 * With `resolved.logType` each device bucket also holds its log types (at most TYPES_MAX, each with
 * its newest document) and the documents without one — the same request: 500 devices × 21 buckets,
 * far under search.max_buckets. Without it the body is exactly the one a display link may send.
 */
export const TYPES_MAX = 20;
export function buildSearchBody(resolved, { from, to, size = 500 } = {}) {
  const latest = {
    top_hits: {
      size: 1,
      sort: [{ [resolved.arrival]: { order: 'desc' } }],
      _source: [...new Set([resolved.arrival, ...eventSource(resolved), ...(resolved.logType ? [LOG_TYPE_FIELD] : []),
        ...(resolved.metadata || []).map((m) => String(m).replace(/\.keyword$/, ''))])],
    },
  };
  return {
    size: 0,
    query: { bool: { filter: [{ range: { [resolved.arrival]: { gte: from, lte: to, format: 'strict_date_optional_time' } } }] } },
    aggs: {
      devices: {
        terms: { field: resolved.device, size, order: { _count: 'desc' } },
        aggs: {
          latest,
          ...(resolved.logType ? {
            types: { terms: { field: resolved.logType, size: TYPES_MAX, shard_size: 100 }, aggs: { latest } },
            no_type: { missing: { field: resolved.logType }, aggs: { latest } },
          } : {}),
        },
      },
    },
  };
}

/* ------------------------------ the late list ------------------------------ */

/** The statuses that put a device on the late list: at or past the yellow line (statusFor). */
export const LATE_STATUSES = new Set(['DELAYED', 'CRITICAL']);
/** The most devices one re-check may name (the measurement's own terms size; auth.rs DELAY_LATE_MAX). */
export const LATE_MAX = 500;

/**
 * A device name a re-check may name: what a terms aggregation returned as a bucket key, as
 * the display-link gate accepts it (auth.rs `device_name`) — text up to 256 characters with
 * no wildcard and no control character. One that is not stays as measured until the next
 * full check.
 */
export function recheckable(name) {
  const s = String(name ?? '');
  // eslint-disable-next-line no-control-regex
  return s.trim() !== '' && [...s].length <= 256 && !/[*?\u0000-\u001f\u007f-\u009f]/.test(s);
}

/**
 * The late list: the devices of a measurement at or past the yellow line (`statusFor` on
 * `levels`, the one definition), worst first, at most LATE_MAX — the names a re-check asks about.
 * Unknown levels name no device.
 */
export function lateList(records, levels) {
  return (records || [])
    .filter((r) => r && LATE_STATUSES.has(statusFor(r.delayMinutes, levels)) && recheckable(r.device))
    .sort((a, b) => b.delayMinutes - a.delayMinutes)
    .slice(0, LATE_MAX)
    .map((r) => String(r.device));
}

/**
 * The late list's re-check: the measurement's own search (buildSearchBody, unchanged) with one
 * more filter naming only those devices, on the field the aggregation groups by — the one
 * extra shape a display link may send (auth.rs `delay_search_body`).
 */
export function buildLateSearchBody(resolved, devices, opts = {}) {
  const body = buildSearchBody(resolved, opts);
  body.query.bool.filter.push({ terms: { [resolved.device]: (devices || []).map(String) } });
  return body;
}

/**
 * The late devices of one cluster, measured again in one request. Returns the fresh records
 * of the devices that answered; one that sent nothing in the window is not in it.
 */
export async function measureLate(esClient, cluster, pre, devices, hours = 24, levels = levelsOf(cluster.id), tz = zoneOf(cluster.id)) {
  const names = (devices || []).filter(recheckable).slice(0, LATE_MAX);
  if (!names.length) return { records: [] };
  const t = levels;
  const body = buildLateSearchBody(pre.resolved, names, { from: `now-${hours}h`, to: 'now', size: 500 });
  const res = await esClient.search(cluster.logIndexPattern || 'logstash-*', body,
    { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 60000 });
  const agg = (res.aggregations || {}).devices || {};
  return { records: (agg.buckets || []).map((b) => recordFrom(b, pre.resolved, t, tz)) };
}

/** Roll a set of records into the counts the summary shows. */
/**
 * A measurement, as the numbers Zabbix keeps — the one list. The scraper sends these to each
 * cluster's Zabbix host and tools/zabbix-delay-template.mjs writes their items from it, so
 * what is measured and what is stored cannot drift apart.
 *
 * `late` is delayed + critical: devices behind real time. A device whose clock runs ahead
 * is not late, and one that sent nothing measurable is unknown, not on time. Delays go in
 * seconds, which Zabbix formats itself; one that could not be measured is null and is not
 * sent — a gap in Zabbix, never a zero.
 *
 * With log types measured (0.3.90) `delayed`, `critical` and `late` count the devices every log type
 * of which is late; a device with only some of them late is in `part_delayed`. Where log types are
 * not measured (the field is not mapped) the two log type figures are not sent and the others are
 * what they always were. `description` is the item's, where the label does not say it all.
 */
export const DELAY_ITEMS = [
  { key: 'devices', label: 'Devices measured', units: '', value: (s) => s.devices },
  // A count that needs the levels is unknown — not sent — while any device's levels are (UNKNOWN).
  { key: 'late', label: 'Devices late (delayed + critical)', units: '', description: 'Devices fully late: where log types are measured, every log type of the device is late. A device with only some log types late is in elasticpro.delay[part_delayed].',
    value: (s) => levelled(s, (s.by.DELAYED || 0) + (s.by.CRITICAL || 0)) },
  { key: 'delayed', label: 'Devices delayed', units: '', description: 'Devices fully late, at the delayed level. A device with only some log types late is in elasticpro.delay[part_delayed].',
    value: (s) => levelled(s, s.by.DELAYED || 0) },
  { key: 'critical', label: 'Devices critical', units: '', description: 'Devices fully late, above the critical line. A device with only some log types late is in elasticpro.delay[part_delayed].',
    value: (s) => levelled(s, s.by.CRITICAL || 0) },
  { key: 'part_delayed', label: 'Devices part delayed', units: '', description: 'Devices with some log types late and others on time (field log_type). Not in late, delayed or critical. Not sent where log_type is not mapped.',
    value: (s) => (s.logTypes ? levelled(s, s.by.PART_DELAY || 0) : null) },
  { key: 'log_types_late', label: 'Log types late', units: '', description: 'Log types late, counted per device (two late log types on one device count 2). Not sent where log_type is not mapped.',
    value: (s) => (s.logTypes ? levelled(s, s.logTypes.late) : null) },
  { key: 'clock_ahead', label: 'Devices with clock ahead', units: '', value: (s) => levelled(s, s.by.CLOCK_AHEAD || 0) },
  { key: 'median', label: 'Median delay', units: 's', value: (s) => (s.median === null || s.median === undefined ? null : Math.round(s.median * 60)) },
  { key: 'worst', label: 'Worst delay', units: 's',
    value: (s) => (s.worst && s.worst.delayMinutes !== null && s.worst.delayMinutes !== undefined ? Math.round(s.worst.delayMinutes * 60) : null) },
];

function levelled(s, n) { return s.by.UNKNOWN ? null : n; }

/** "threat on fw-blr-05": the log type furthest behind, with the device it comes from. */
export const worstLogTypeText = (w) => `${w.logType} on ${w.device}`;

/** `summarise()` output → `[{ key, value }]`, unknowns left out; plus the worst device's name and the worst log type. */
export function delayItemValues(summary) {
  if (!summary || !summary.by) return [];
  const out = DELAY_ITEMS.map((d) => ({ key: d.key, value: d.value(summary) })).filter((v) => v.value !== null && v.value !== undefined);
  if (summary.worst && summary.worst.device) out.push({ key: 'worst_device', value: String(summary.worst.device) });
  if (summary.worstLogType) out.push({ key: 'worst_log_type', value: worstLogTypeText(summary.worstLogType) });
  return out;
}

/**
 * One cluster's devices, measured: the aggregation the Log delay page runs, as a function
 * so the page and the headless scraper (tools/elasticpro-scrape.mjs) ask the same question.
 * `pre` is what `preflight` resolved for this cluster.
 */
export async function measureDelay(esClient, cluster, pre, hours = 24, levels = levelsOf(cluster.id), tz = zoneOf(cluster.id)) {
  return measureDelayIn(esClient, cluster, pre, { from: `now-${hours}h`, to: 'now' }, levels, {}, tz);
}

/**
 * measureDelay over any window: `{from, to}` as Elasticsearch date strings (`now-5m`, an ISO
 * time). The Log Delay page's Live Watch asks its own range with it; `opts.signal` lets go of
 * the request when the view is left.
 */
/**
 * What an answer does not hold, in words; [] when it is whole. `truncated` is the documents of the
 * devices past the terms size (Elasticsearch counts documents, not devices); `gaps` the shards
 * that failed and a search that timed out. A device missing from such an answer is not known —
 * never "silent".
 */
export function answerGaps(res, size = LATE_MAX) {
  const out = [];
  const agg = (res && res.aggregations && res.aggregations.devices) || {};
  if (agg.sum_other_doc_count > 0) out.push(`only the ${size} devices with the most logs were read; ${Number(agg.sum_other_doc_count).toLocaleString('en')} documents of other devices were not`);
  const sh = (res && res._shards) || {};
  if (sh.failed > 0) out.push(`${sh.failed} of ${sh.total ?? '?'} shards failed`);
  if (res && res.timed_out) out.push('the search timed out');
  return out;
}

export async function measureDelayIn(esClient, cluster, pre, { from, to }, levels = levelsOf(cluster.id), opts = {}, tz = zoneOf(cluster.id)) {
  const t = levels;
  const body = buildSearchBody(pre.resolved, { from, to, size: 500 });
  const res = await esClient.search(cluster.logIndexPattern || 'logstash-*', body,
    { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 60000, ...(opts.signal ? { signal: opts.signal } : {}) });
  const agg = (res.aggregations || {}).devices || {};
  return {
    records: (agg.buckets || []).map((b) => recordFrom(b, pre.resolved, t, tz)),
    timeZone: tz,
    // Devices beyond the terms size are not in the answer. Saying so beats implying
    // the list is everything.
    truncated: agg.sum_other_doc_count || 0,
    gaps: answerGaps(res),
  };
}

/**
 * Live › Fetch all devices in cluster: the devices seen in a lookback before the range (the core's
 * tracker keeps a device 7 days unseen, docs/LOGDELAY.md "Which devices"), each with its newest
 * arrival — one terms aggregation with a max, no documents. The devices of the range are measured
 * by measureDelayIn; one seen here and not there is silent in the range.
 */
export const SEEN_LOOKBACK = 'now-7d';
export function buildSeenSearchBody(resolved, { from, to, size = LATE_MAX } = {}) {
  return {
    size: 0,
    query: { bool: { filter: [{ range: { [resolved.arrival]: { gte: from, lte: to, format: 'strict_date_optional_time' } } }] } },
    aggs: { devices: { terms: { field: resolved.device, size, order: { last: 'desc' } }, aggs: { last: { max: { field: resolved.arrival } } } } },
  };
}

/** The devices seen between `from` and `to`: `{devices: [{device, lastArrival}], truncated}`. */
export async function measureSeenIn(esClient, cluster, pre, { from, to }, opts = {}) {
  const res = await esClient.search(cluster.logIndexPattern || 'logstash-*', buildSeenSearchBody(pre.resolved, { from, to }),
    { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 60000, ...(opts.signal ? { signal: opts.signal } : {}) });
  const agg = (res.aggregations || {}).devices || {};
  return {
    devices: (agg.buckets || []).map((b) => ({ device: String(b.key), lastArrival: b.last && Number.isFinite(b.last.value) ? b.last.value : null })),
    truncated: agg.sum_other_doc_count || 0,
    gaps: answerGaps(res),
  };
}

/**
 * A measurement's counts. `by` holds PART_DELAY only where log types were measured; `logTypes`
 * ({total, late, above}: log types counted per device), `partLate` (the late log types of the part
 * delayed devices, most devices first) and `worstLogType` are null where they were not — not
 * measured is not 0.
 */
export function summarise(records) {
  const by = { OK: 0, DELAYED: 0, CRITICAL: 0, CLOCK_AHEAD: 0, OTHER_TZ: 0, ERROR: 0, NO_DATA: 0, UNKNOWN: 0 };
  let worst = null;
  let logTypes = null; let worstLogType = null;
  const part = new Map();
  const addTypes = (r) => {
    logTypes = logTypes || { total: 0, late: 0, above: 0 };
    for (const t of r.types) {
      logTypes.total += 1;
      if (typeLate(t)) logTypes.late += 1;
      if (t.status === 'CRITICAL') logTypes.above += 1;
      if (t.delayMinutes !== null && (worstLogType === null || t.delayMinutes > worstLogType.delayMinutes)) worstLogType = { logType: t.label, device: r.device, delayMinutes: t.delayMinutes };
      if (r.status === 'PART_DELAY' && typeLate(t)) part.set(t.label, (part.get(t.label) || 0) + 1);
    }
  };
  for (const r of records) {
    by[r.status] = (by[r.status] || 0) + 1;
    if (Array.isArray(r.types)) addTypes(r);
    if (r.delayMinutes !== null && (worst === null || r.delayMinutes > worst.delayMinutes)) worst = r;
  }
  const measured = records.filter((r) => r.delayMinutes !== null).map((r) => r.delayMinutes);
  if (logTypes) by.PART_DELAY = by.PART_DELAY || 0;
  return {
    logTypes,
    partLate: logTypes ? [...part.entries()].map(([logType, devices]) => ({ logType, devices })).sort((a, b) => b.devices - a.devices || a.logType.localeCompare(b.logType)) : null,
    worstLogType,
    devices: records.length,
    by,
    unhealthy: by.DELAYED + by.CRITICAL + by.CLOCK_AHEAD,
    // Unknown rather than zero when nothing could be measured.
    median: measured.length ? median(measured) : null,
    worst,
  };
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * What a fleet-wide run actually covered.
 *
 * This is the arithmetic behind "6 of 9 clusters answered", and it lives here rather
 * than in the page because getting it wrong is the failure this whole feature has to
 * avoid: a device list assembled from four clusters, presented as if it were nine, is a
 * number somebody makes a decision from. Counting it in one tested place is the only way
 * the coverage line and the table can be guaranteed to agree.
 *
 * `entries` is one per cluster, in whatever shape the page holds: `{ state, pre,
 * records }`. `phase` is `'preflight'` — did we manage to ask — or `'fetch'` — did we
 * manage to measure. They have different denominators: a cluster that cannot be analysed
 * is a complete answer to the first question and not a candidate for the second, so
 * counting it as a gap in the fetch would make a healthy fleet look broken.
 *
 * @returns {{total:number, ok:number, failed:number, skipped:number}}
 */
export function delayCoverage(entries, phase = 'preflight') {
  const list = [...entries];
  if (phase === 'fetch') {
    const candidates = list.filter((e) => e.pre && e.pre.ok && !e.pre.unknown);
    return {
      total: candidates.length,
      ok: candidates.filter((e) => e.records).length,
      failed: candidates.filter((e) => e.state === 'failed').length,
      skipped: candidates.filter((e) => !e.records && e.state !== 'failed').length,
    };
  }
  return {
    total: list.length,
    // A preflight that came back is an answer whether or not it was a happy one: "this
    // cluster cannot be analysed" is knowledge. Only "we never asked" is a gap.
    ok: list.filter((e) => e.pre).length,
    failed: list.filter((e) => e.state === 'error').length,
    skipped: list.filter((e) => !e.pre && e.state !== 'error').length,
  };
}

/* ------------------------- one device, close up ------------------------- */

/**
 * Is this an address rather than a name?
 *
 * It decides which field the device is looked up by, and getting it wrong means an empty
 * result that looks like "this device has stopped shipping". Deliberately strict: a
 * hostname that happens to be four numbers is not a thing, but a hostname containing a
 * colon is, so IPv6 is only recognised in its real shapes.
 */
export function looksLikeIp(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split('.').every((o) => o.length <= 3 && Number(o) <= 255);
  }
  // IPv6: hex groups separated by colons, with at most one "::". Bracketed forms and a
  // zone suffix both appear in log fields.
  const bare = v.replace(/^\[|\]$/g, '').split('%')[0];
  if (!bare.includes(':')) return false;
  if ((bare.match(/::/g) || []).length > 1) return false;
  return /^[0-9a-f:]+$/i.test(bare) && bare.split(':').filter(Boolean).every((g) => g.length <= 4);
}

/**
 * Which fields to look a device up by.
 *
 * An address is not necessarily in the field the aggregation groups by — a report
 * grouped by hostname still has the address in `src_ip` — so looking up "10.1.2.3" in
 * the hostname field finds nothing and says the device is silent. Ported from
 * `build_single_query` in ES_delay_finder.py, which draws the same distinction.
 */
export function deviceFieldsFor(value, resolved, fields) {
  if (!looksLikeIp(value)) {
    return [String(resolved.device || '').replace(/\.keyword$/, '')];
  }
  const meta = (fields && fields.metadata) || (resolved && resolved.metadata) || [];
  // IP_LIKE is the same predicate that decides a field needs no `.keyword`, which is
  // not a coincidence: an address field is mapped as an address, so it is both natively
  // searchable and the place an address is found.
  const ips = meta
    .map((f) => String(f).replace(/\.keyword$/, ''))
    .filter((f) => IP_LIKE.test(f));
  return ips.length ? [...new Set(ips)] : ['src_ip'];
}

/**
 * The fields Live's Logs filters search, as the cluster's configured log fields name them (one
 * definition, resolveFields): the device field (src_hostname by default), the address field —
 * where deviceFieldsFor looks an address up: the first address-like context field, else src_ip —
 * and tag1 (the extra always measured). Whether the indices map them is asked on Search.
 */
export function logFilterFields(cluster) {
  const f = resolveFields(cluster);
  const plain = (x) => String(x || '').replace(/\.keyword$/, '');
  return {
    host: plain(f.device) || null,
    ip: deviceFieldsFor('0.0.0.0', { device: f.device, metadata: f.metadata }, { metadata: f.metadata })[0] || null,
    tag1: f.metadata.map(plain).find((m) => m.toLowerCase() === 'tag1') || 'tag1',
  };
}

/**
 * One Logs filter as a query clause: a value with a wildcard is a pattern, one without is one exact
 * value — quoted, so a dash or a dot in a device name is not query syntax; an address range
 * ("10.4.0.0/16") is a term on the field, which an ip field reads as a CIDR. The field and its
 * .keyword are both searched (which one exists is the mapping's); `lenient` keeps a field an index
 * lacks from failing the whole search.
 */
export function logFilterClause(field, value) {
  const v = String(value || '').trim();
  if (!field || !v) return null;
  if (/^[0-9a-f:.]+\/\d{1,3}$/i.test(v)) return { term: { [field]: v } };
  return { query_string: { query: /[*?]/.test(v) ? v : `"${v.replace(/(["\\])/g, '\\$1')}"`, analyze_wildcard: true, lenient: true, fields: [field, `${field}.keyword`] } };
}

/**
 * The search behind the close-up: the newest `size` documents for one device.
 *
 * Both the raw field and its `.keyword` twin are matched, because which one is the
 * searchable one depends on a mapping this code does not get to see.
 */
export function buildDeviceQuery(resolved, { device, size = 15, fields = null, from = null, to = null } = {}) {
  const names = deviceFieldsFor(device, resolved, fields);
  const should = [];
  for (const n of names) {
    should.push({ term: { [n]: device } });
    const kw = aggregatableName(n);
    if (kw !== n) should.push({ term: { [kw]: device } });
  }
  // Bounded by the arrival time (Live Watch's range). Without it the search read every index of
  // the pattern — every day the cluster keeps — and counted every hit, which on a real cluster
  // runs past the request timeout and comes back as an error instead of the device's newest logs.
  const filter = from || to
    ? [{ range: { [resolved.arrival]: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}), format: 'strict_date_optional_time' } } }]
    : [];
  return {
    size,
    track_total_hits: from || to ? 10000 : true,
    sort: [{ [resolved.arrival]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { must: [{ bool: { should, minimum_should_match: 1 } }], ...(filter.length ? { filter } : {}) } },
    _source: [...new Set([resolved.arrival, ...eventSource(resolved),
              ...(resolved.metadata || []).map((m) => String(m).replace(/\.keyword$/, ''))])],
  };
}

/**
 * Per-document delay for one device, newest first.
 *
 * A document whose timestamps cannot both be read carries `delayMinutes: null` and is
 * still listed — it is evidence, and dropping it would make the list look cleaner than
 * the data is. It is the aggregate figures that exclude it, never the row.
 */
/**
 * One document's delay — the one definition every list of documents uses (the device record,
 * the Live Watch close-up, Live logs): the raw gap, arrival minus event time in minutes, with the
 * cluster's log time zone taken out (core/log-tz.js `correct`; `tz` as the core said it, null =
 * no zone, nothing taken out). `eventFields` is one name or a list tried in order (the first the
 * document carries that reads as a date, as RFC 3339 text or epoch milliseconds — `toMs`). Either
 * time unreadable: null, never 0. Returns `{arrival, event, delayMinutes, rawGapMinutes,
 * tzOffsetMinutes, deviceTzOffset}`.
 */
export function docDelay(src, arrivalField, eventFields, tz = null) {
  const arrival = toMs(dotted(src || {}, arrivalField));
  const event = firstMs(src || {}, Array.isArray(eventFields) ? eventFields : [eventFields]);
  const ok = isFinite(arrival) && isFinite(event);
  const c = correctByZone(ok ? (arrival - event) / 60000 : null, tz, ok ? event : null, PATTERN.tzToleranceMinutes);
  return {
    arrival: isFinite(arrival) ? arrival : null,
    event: isFinite(event) ? event : null,
    delayMinutes: c.delayMinutes,
    rawGapMinutes: c.rawGapMinutes,
    tzOffsetMinutes: c.offsetMinutes,
    deviceTzOffset: c.deviceOffset,
  };
}

export function documentDelays(hits, resolved, levels = null, tz = null) {
  return (hits || []).map((hit) => {
    const src = (hit && hit._source) || {};
    const { arrival, event, delayMinutes, rawGapMinutes, tzOffsetMinutes, deviceTzOffset } = docDelay(src, resolved.arrival, eventSource(resolved), tz);
    return {
      id: (hit && hit._id) || '',
      index: (hit && hit._index) || '',
      arrival,
      event,
      delayMinutes,
      rawGapMinutes,
      tzOffsetMinutes,
      deviceTzOffset,
      status: statusFor(delayMinutes, levels),
      meta: Object.fromEntries((resolved.metadata || []).map((m) => {
        const plain = String(m).replace(/\.keyword$/, '');
        return [plain, dotted(src, plain) ?? dotted(src, m) ?? ''];
      })),
    };
  });
}

/**
 * What a run of documents says about one device right now.
 *
 * `latest` is the newest measurable document, which is the number the status is taken
 * from — the same definition the fleet table uses, so a device cannot read DELAYED in
 * one place and OK in the other. `trend` needs four measurable samples and says
 * NO_TREND below that rather than guessing from two.
 */
export function deviceSnapshot(docs, levels = null) {
  const measurable = (docs || []).filter((d) => d.delayMinutes !== null);
  const unreadable = (docs || []).length - measurable.length;
  if (!measurable.length) {
    return {
      documents: (docs || []).length, measurable: 0, unreadable,
      latest: null, status: statusFor(null, levels), trend: 'NO_TREND',
      min: null, max: null, median: null,
    };
  }
  const values = measurable.map((d) => d.delayMinutes);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    documents: (docs || []).length,
    measurable: measurable.length,
    unreadable,
    latest: values[0],
    status: statusFor(values[0], levels),
    // Oldest to newest, which is the direction trend() reads.
    trend: trend([...values].reverse()),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  };
}
