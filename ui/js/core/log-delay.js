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
export function fieldsToProbe(fields) {
  return [
    aggregatableName(fields.device),
    ...fields.eventTime,
    fields.arrival,
    ...fields.metadata.map(aggregatableName),
  ];
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
 */
export async function preflight(client, cluster) {
  const fields = resolveFields(cluster);
  if (!client) return { ok: false, unknown: true, error: 'not connected', fields, missing: [], resolved: {} };
  try {
    const caps = await client.fieldCaps(cluster.logIndexPattern || 'logstash-*', fieldsToProbe(fields));
    return { ...decide(fields, caps), unknown: false, error: null, fields };
  } catch (e) {
    const es = e.res && e.res.json && e.res.json.error;
    return {
      ok: false, unknown: true, missing: [], resolved: {}, fields,
      error: (es && (es.reason || es.type)) || e.message || String(e),
    };
  }
}

/* ------------------------------- classification ------------------------------- */

/** Defaults from the tool this is ported from; overridable per cluster. */
export const DEFAULT_THRESHOLDS = {
  delayMinutes: 30,
  criticalMinutes: 60,
  tzToleranceMinutes: 3,
  veryLongMinutes: 24 * 60,
};

export function thresholds(cluster) {
  const t = (cluster && cluster.delayThresholds) || {};
  return {
    delayMinutes: num(t.delayMinutes, DEFAULT_THRESHOLDS.delayMinutes),
    criticalMinutes: num(t.criticalMinutes, DEFAULT_THRESHOLDS.criticalMinutes),
    tzToleranceMinutes: num(t.tzToleranceMinutes, DEFAULT_THRESHOLDS.tzToleranceMinutes),
    veryLongMinutes: num(t.veryLongMinutes, DEFAULT_THRESHOLDS.veryLongMinutes),
  };
}
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * What a delay means.
 *
 * Order matters. A negative delay is not a small delay — it is a device whose clock is
 * ahead of real time, which is a different fault with a different fix, so it is tested
 * before the "is it big" questions. A delay that cannot be computed at all is ERROR, and
 * a device that sent nothing is NO_DATA; neither is zero.
 */
export const STATUS = {
  OK: { label: 'ok', cls: 'green' },
  DELAYED: { label: 'delayed', cls: 'yellow' },
  CRITICAL: { label: 'critical', cls: 'red' },
  CLOCK_AHEAD: { label: 'clock ahead', cls: 'orange' },
  ERROR: { label: 'error', cls: 'grey' },
  NO_DATA: { label: 'no data', cls: 'grey' },
};

export function classify(delayMinutes, t = DEFAULT_THRESHOLDS) {
  if (delayMinutes === null || delayMinutes === undefined || !isFinite(delayMinutes)) return 'ERROR';
  if (delayMinutes <= -t.delayMinutes) return 'CLOCK_AHEAD';
  if (delayMinutes >= t.criticalMinutes) return 'CRITICAL';
  if (delayMinutes >= t.delayMinutes) return 'DELAYED';
  return 'OK';
}

/** Why it is in that state, in the words an operator would use. */
export function reasonFor(status, trend = 'NO_TREND') {
  const base = {
    OK: 'Healthy — within threshold',
    DELAYED: 'Pipeline lag: forwarder batching or network latency',
    CRITICAL: 'Severe lag: forwarder backlog, pipeline backpressure, or device clock behind',
    CLOCK_AHEAD: 'Device clock is ahead of real time (NTP)',
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
    CLOCK_AHEAD: 'Fix NTP and timezone on the source device, and the parser date filter',
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
 * The one worth having: a delay within a few minutes of a whole number of hours is almost
 * never a queue. Queues drift; timezone offsets do not. A device an exact hour behind has
 * its clock or its parser in the wrong zone, and telling someone to tune their forwarder
 * would send them to fix the wrong thing.
 */
export function analysePattern(delayMinutes, t = DEFAULT_THRESHOLDS) {
  if (delayMinutes === null || delayMinutes === undefined || !isFinite(delayMinutes)) {
    return { pattern: '-', note: '' };
  }
  const abs = Math.abs(delayMinutes);
  const hours = abs / 60;
  const nearestHour = Math.round(hours);
  const offBy = Math.abs(hours - nearestHour) * 60;

  if (nearestHour >= 1 && offBy <= t.tzToleranceMinutes) {
    const dir = delayMinutes > 0 ? 'behind' : 'ahead';
    return {
      pattern: 'timezone',
      note: `within ${Math.round(offBy)} min of exactly ${nearestHour}h ${dir} — a timezone or NTP offset, not a queue`,
    };
  }
  if (abs >= t.veryLongMinutes) {
    return { pattern: 'very-long', note: `more than ${Math.round(t.veryLongMinutes / 60)}h — likely a replay or a stalled forwarder` };
  }
  return { pattern: '-', note: '' };
}

/* --------------------------------- the record --------------------------------- */

/**
 * One device's delay, built from a terms bucket and its top_hits document.
 *
 * Every figure the rest of the app shows comes from here, so the arithmetic exists once.
 * A document missing either timestamp yields a null delay and ERROR — never a zero, which
 * would sort as healthy and read as measured.
 */
export function recordFrom(bucket, resolved, t = DEFAULT_THRESHOLDS) {
  const hit = ((((bucket || {}).latest || {}).hits || {}).hits || [])[0];
  const src = (hit && hit._source) || {};
  const arrival = Date.parse(dotted(src, resolved.arrival));
  const event = Date.parse(dotted(src, resolved.eventTime));

  const ok = isFinite(arrival) && isFinite(event);
  const delayMinutes = ok ? (arrival - event) / 60000 : null;
  const status = classify(delayMinutes, t);
  const { pattern, note } = analysePattern(delayMinutes, t);

  return {
    device: bucket.key,
    docs: bucket.doc_count || 0,
    arrival: isFinite(arrival) ? arrival : null,
    event: isFinite(event) ? event : null,
    delayMinutes,
    status,
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

const dotted = (o, path) => String(path || '').split('.').reduce((v, k) => (v == null ? v : v[k]), o);

/**
 * The search the analysis runs.
 *
 * One terms aggregation over the device field with a top_hits picking the newest document
 * per device. `size` bounds the device count; a fleet with more devices than that reports
 * the shortfall rather than silently showing a subset.
 */
export function buildSearchBody(resolved, { from, to, size = 500 } = {}) {
  return {
    size: 0,
    query: { bool: { filter: [{ range: { [resolved.arrival]: { gte: from, lte: to, format: 'strict_date_optional_time' } } }] } },
    aggs: {
      devices: {
        terms: { field: resolved.device, size, order: { _count: 'desc' } },
        aggs: {
          latest: {
            top_hits: {
              size: 1,
              sort: [{ [resolved.arrival]: { order: 'desc' } }],
              _source: [resolved.arrival, resolved.eventTime,
                        ...(resolved.metadata || []).map((m) => String(m).replace(/\.keyword$/, ''))],
            },
          },
        },
      },
    },
  };
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
 */
export const DELAY_ITEMS = [
  { key: 'devices', label: 'Devices measured', units: '', value: (s) => s.devices },
  { key: 'late', label: 'Devices late (delayed + critical)', units: '', value: (s) => (s.by.DELAYED || 0) + (s.by.CRITICAL || 0) },
  { key: 'delayed', label: 'Devices delayed', units: '', value: (s) => s.by.DELAYED || 0 },
  { key: 'critical', label: 'Devices critical', units: '', value: (s) => s.by.CRITICAL || 0 },
  { key: 'clock_ahead', label: 'Devices with clock ahead', units: '', value: (s) => s.by.CLOCK_AHEAD || 0 },
  { key: 'median', label: 'Median delay', units: 's', value: (s) => (s.median === null || s.median === undefined ? null : Math.round(s.median * 60)) },
  { key: 'worst', label: 'Worst delay', units: 's',
    value: (s) => (s.worst && s.worst.delayMinutes !== null && s.worst.delayMinutes !== undefined ? Math.round(s.worst.delayMinutes * 60) : null) },
];

/** `summarise()` output → `[{ key, value }]`, unknowns left out; plus the worst device's name. */
export function delayItemValues(summary) {
  if (!summary || !summary.by) return [];
  const out = DELAY_ITEMS.map((d) => ({ key: d.key, value: d.value(summary) })).filter((v) => v.value !== null && v.value !== undefined);
  if (summary.worst && summary.worst.device) out.push({ key: 'worst_device', value: String(summary.worst.device) });
  return out;
}

/**
 * One cluster's devices, measured: the aggregation the Log delay page runs, as a function
 * so the page and the headless scraper (tools/elasticpro-scrape.mjs) ask the same question.
 * `pre` is what `preflight` resolved for this cluster.
 */
export async function measureDelay(esClient, cluster, pre, hours = 24) {
  const t = thresholds(cluster);
  const body = buildSearchBody(pre.resolved, { from: `now-${hours}h`, to: 'now', size: 500 });
  const res = await esClient.search(cluster.logIndexPattern || 'logstash-*', body,
    { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 60000 });
  const agg = (res.aggregations || {}).devices || {};
  return {
    records: (agg.buckets || []).map((b) => recordFrom(b, pre.resolved, t)),
    // Devices beyond the terms size are not in the answer. Saying so beats implying
    // the list is everything.
    truncated: agg.sum_other_doc_count || 0,
  };
}

export function summarise(records) {
  const by = { OK: 0, DELAYED: 0, CRITICAL: 0, CLOCK_AHEAD: 0, ERROR: 0, NO_DATA: 0 };
  let worst = null;
  for (const r of records) {
    by[r.status] = (by[r.status] || 0) + 1;
    if (r.delayMinutes !== null && (worst === null || r.delayMinutes > worst.delayMinutes)) worst = r;
  }
  const measured = records.filter((r) => r.delayMinutes !== null).map((r) => r.delayMinutes);
  return {
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
 * The search behind the close-up: the newest `size` documents for one device.
 *
 * Both the raw field and its `.keyword` twin are matched, because which one is the
 * searchable one depends on a mapping this code does not get to see.
 */
export function buildDeviceQuery(resolved, { device, size = 15, fields = null } = {}) {
  const names = deviceFieldsFor(device, resolved, fields);
  const should = [];
  for (const n of names) {
    should.push({ term: { [n]: device } });
    const kw = aggregatableName(n);
    if (kw !== n) should.push({ term: { [kw]: device } });
  }
  return {
    size,
    track_total_hits: true,
    sort: [{ [resolved.arrival]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { must: [{ bool: { should, minimum_should_match: 1 } }] } },
    _source: [resolved.arrival, resolved.eventTime,
              ...(resolved.metadata || []).map((m) => String(m).replace(/\.keyword$/, ''))],
  };
}

/**
 * Per-document delay for one device, newest first.
 *
 * A document whose timestamps cannot both be read carries `delayMinutes: null` and is
 * still listed — it is evidence, and dropping it would make the list look cleaner than
 * the data is. It is the aggregate figures that exclude it, never the row.
 */
export function documentDelays(hits, resolved, t = DEFAULT_THRESHOLDS) {
  return (hits || []).map((hit) => {
    const src = (hit && hit._source) || {};
    const arrival = Date.parse(dotted(src, resolved.arrival));
    const event = Date.parse(dotted(src, resolved.eventTime));
    const ok = isFinite(arrival) && isFinite(event);
    const delayMinutes = ok ? (arrival - event) / 60000 : null;
    return {
      id: (hit && hit._id) || '',
      index: (hit && hit._index) || '',
      arrival: isFinite(arrival) ? arrival : null,
      event: isFinite(event) ? event : null,
      delayMinutes,
      status: classify(delayMinutes, t),
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
export function deviceSnapshot(docs, t = DEFAULT_THRESHOLDS) {
  const measurable = (docs || []).filter((d) => d.delayMinutes !== null);
  const unreadable = (docs || []).length - measurable.length;
  if (!measurable.length) {
    return {
      documents: (docs || []).length, measurable: 0, unreadable,
      latest: null, status: classify(null, t), trend: 'NO_TREND',
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
    status: classify(values[0], t),
    // Oldest to newest, which is the direction trend() reads.
    trend: trend([...values].reverse()),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
  };
}
