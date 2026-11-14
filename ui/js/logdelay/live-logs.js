/**
 * Log Delay › Live logs: the log documents themselves, over the page's time range, newest first,
 * with the fields a delay is read from — device, ClientID, zone, tag1, parser_tag, fwd_tag,
 * log_type — and each document's own delay. Until 0.3.60 this was the "Live tail" view of the
 * Logs & Delay page. "Open in logs" on a board or Live Watch row lands here narrowed to that
 * device (#/log-delay/live/<cluster>/<device>).
 *
 * A tail is one stream of one cluster's documents — merging several would give a list whose
 * order means nothing — so it picks one cluster and names it, without narrowing the fleet the
 * rest of the page measures. Times are in the server's zone, and the column head says which.
 *
 * "Source" is the tenant inside the index name (logstash-<source>-YYYY.MM.DD), not a client: a
 * client is a whole cluster with its own Elasticsearch URL.
 */

import { tailTick } from '../core/tail.js';
import { h, mount, activatable } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { num, dur, ymdDots, eachDay, download, toCsv } from '../lib/fmt.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { state, client, activeClusters, fetchIndices } from '../core/state.js';
import { timeHistogram, histogramEmptyText } from '../lib/charts.js';
import { card, empty } from '../pages/common.js';
import { resolveFields, deviceFieldsFor, docDelay, eventSource } from '../core/log-delay.js';
import { minutesText } from '../core/logdelay-report.js';
import { zoneOf, loadLevels } from '../core/delay-levels.js';
import { clusterOffsetAt, offsetLabel, timeZoneShort } from '../core/log-tz.js';
import { rangeBounds, rangeText, zonedText, zoneOffsetMinutes, offsetText } from '../core/log-range.js';
import { jsonView } from '../lib/jsonview.js';

const ui = {
  clusterId: '',
  sourceFilter: 'all',
  query: '',
  field: 'any',
  term: '',
  size: 200,
  running: false,
  error: null,
  hits: [],
  total: 0,
  totalRelation: 'eq',
  tookMs: 0,
  buckets: [],
  resolved: [],
  tail: false,
  expanded: new Set(),
  ver: 0,
  /** The device a link narrowed the view to (route), so arriving twice does not search twice. */
  narrowedTo: '',
};

let tailTimer = null;
/** The search still out: a newer one, or leaving the view, lets go of it. */
let searchCtl = null;
let searchSeq = 0;
let ctx = { repaint: () => {}, range: () => ({ id: '1h' }), zone: () => null };
const L = nodeCache();
const bump = () => { ui.ver += 1; ctx.repaint(); };
const sortLogs = tableSort('logdelay.live', { onChange: () => bump() });

/** The cluster the view follows: the chosen one, or the first available. */
function cluster() {
  const active = activeClusters();
  return active.find((c) => c.id === ui.clusterId) || active[0] || null;
}

/** The field a device is looked up by on cluster `c` (its delayFields, an address by its address field). */
function deviceField(c, device) {
  const f = resolveFields(c);
  return deviceFieldsFor(device, { device: f.device, metadata: f.metadata }, { metadata: f.metadata })[0] || 'src_hostname';
}

/**
 * The view is shown, for `route` ({clusterId, device} narrows it to one device). Searches when it
 * has nothing yet, or when the route names a device it is not already narrowed to.
 */
export function liveEnter(c, route) {
  ctx = { ...ctx, ...c };
  // The clusters' log time zones (core/delay-levels.js zoneOf): asked once, drawn when they land.
  loadLevels().then((got) => { if (got) bump(); }).catch(() => {});
  const want = route && route.clusterId ? `${route.clusterId}|${route.device || ''}` : '';
  if (want && want !== ui.narrowedTo) {
    ui.narrowedTo = want;
    ui.clusterId = route.clusterId;
    const cl = cluster();
    if (route.device && cl) { ui.field = deviceField(cl, route.device); ui.term = route.device; }
    stopTail();
    search();
    return;
  }
  if (!ui.hits.length && !ui.running) search();
}

/** The view is left: the tail stops and the search still out is let go of. */
export function liveLeave() {
  stopTail();
  if (searchCtl) searchCtl.abort();
  searchCtl = null;
  ui.running = false;
}

export const liveBusy = () => ui.running;

/** The range changed above: the documents shown are for the old one, so ask again. */
export function liveRangeChanged() { if (ui.tail && ctx.range().id === 'custom') stopTail(); search(); }

/** Which daily indices does the range touch? Their day is the UTC day, a day either side kept. */
function targetIndices(c, b) {
  const known = state.indices.get(c.id) || [];
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const days = eachDay(utcDay(b.from - 86400000), utcDay(b.to + 86400000)).map((d) => ymdDots(d, '-'));
  const inRange = known.filter((r) => r.day && days.includes(r.day) && (ui.sourceFilter === 'all' || r.source === ui.sourceFilter));
  if (inRange.length) return { list: inRange.map((r) => r.index), exact: true, days };
  const pat = ui.sourceFilter === 'all' ? c.logIndexPattern : c.logIndexPattern.replace('*', `${ui.sourceFilter}-*`);
  return { list: [pat], exact: false, days };
}

function interval(ms) {
  const step = ms / 60;
  const table = [[1000, '1s'], [5000, '5s'], [10000, '10s'], [30000, '30s'], [60000, '1m'], [300000, '5m'],
    [600000, '10m'], [1800000, '30m'], [3600000, '1h'], [10800000, '3h'], [21600000, '6h'], [43200000, '12h'], [86400000, '1d']];
  for (const [msv, label] of table) if (step <= msv) return label;
  return '7d';
}

async function search({ silent = false } = {}) {
  const c = cluster();
  if (!c) return;
  const b = rangeBounds(ctx.range());
  if (!b) { ui.error = 'Set both ends of the custom range.'; bump(); return; }
  if (searchCtl) searchCtl.abort();
  searchCtl = typeof AbortController === 'undefined' ? null : new AbortController();
  const signal = searchCtl ? searchCtl.signal : undefined;
  const mine = ++searchSeq;
  const cl = client(c.id);
  ui.running = true; ui.error = null;
  if (!silent) bump();
  if (!state.indices.get(c.id)) { try { await fetchIndices(c.id, '*'); } catch (_) { /* the wildcard below still works */ } }
  if (mine !== searchSeq) return;
  const t = targetIndices(c, b);
  ui.resolved = t;
  const gte = new Date(b.from).toISOString();
  const lte = new Date(b.to).toISOString();
  const filters = [{ range: { [c.timeField]: { gte, lte, format: 'strict_date_optional_time' } } }];
  const must = ui.query.trim() ? [{ query_string: { query: ui.query.trim(), analyze_wildcard: true, default_field: '*' } }] : [];
  // The field picker, as a clause of its own rather than text spliced into the Lucene box: a
  // value with a space or a colon would change what the query means. The field and its .keyword
  // are both searched (which one exists is the mapping's), and `lenient` keeps a field this index
  // does not have from failing the whole search.
  const term = ui.term.trim();
  if (term) {
    must.push(ui.field === 'any'
      ? { query_string: { query: term, analyze_wildcard: true, default_field: '*', lenient: true } }
      // A value without a wildcard is one exact value (a device name, an address): quoted, so a
      // dash or a dot in it is not read as query syntax.
      : { query_string: { query: /[*?]/.test(term) ? term : `"${term.replace(/(["\\])/g, '\\$1')}"`, analyze_wildcard: true, lenient: true, fields: [ui.field, `${ui.field}.keyword`] } });
  }
  const body = {
    size: Number(ui.size) || 100,
    track_total_hits: 10000,
    sort: [{ [c.timeField]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { filter: filters, must } },
    aggs: { over_time: { date_histogram: { field: c.timeField, fixed_interval: interval(b.to - b.from), min_doc_count: 0, extended_bounds: { min: gte, max: lte } } } },
  };
  try {
    // Whole index names up to what a URL holds; past that the pattern, never a name cut in half.
    let idx = '';
    for (const n of t.list) { if (idx.length + n.length + 1 > 3500) { idx = c.logIndexPattern || '*'; break; } idx += (idx ? ',' : '') + n; }
    const r = await cl.search(idx, body, { qs: 'ignore_unavailable=true&allow_no_indices=true&rest_total_hits_as_int=false', timeoutMs: 45000, signal });
    if (mine !== searchSeq) return;
    ui.hits = (r.hits && r.hits.hits) || [];
    ui.total = (r.hits && r.hits.total && (r.hits.total.value ?? r.hits.total)) || 0;
    ui.totalRelation = (r.hits && r.hits.total && r.hits.total.relation) || 'eq';
    ui.tookMs = r.took || 0;
    ui.buckets = ((r.aggregations && r.aggregations.over_time && r.aggregations.over_time.buckets) || []).map((x) => ({ t: x.key, v: x.doc_count }));
  } catch (e) {
    if (mine !== searchSeq || (e && e.res && e.res.kind === 'aborted')) return;
    ui.error = e.message; ui.hits = []; ui.buckets = []; ui.total = 0;
  }
  ui.running = false;
  bump();
}

function startTail() {
  stopTail();
  ui.tail = true;
  tailTimer = setInterval(() => tailTick(() => ui.running, () => search({ silent: true })),
    Math.max(5, state.defaults.refreshIntervalSec || 30) * 1000);
  search();
}
function stopTail() { ui.tail = false; if (tailTimer) clearInterval(tailTimer); tailTimer = null; }

/* -------------------------------- the columns -------------------------------- */

const pick = (src, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), src);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/**
 * A document as the row shows it: the values each column reads, the delay from docDelay with the
 * cluster's log time zone taken out (core/log-tz.js; the zone as the core said it, `zoneOf`).
 */
function docOf(hit, c) {
  const s = hit._source || {};
  const f = resolveFields(c);
  const d = docDelay(s, c.timeField || f.arrival, eventSource(f), zoneOf(c.id));
  const msg = pick(s, ['message', 'log.message', 'msg', 'event.original', 'full_message']);
  return {
    hit,
    ts: d.arrival,
    device: pick(s, [String(f.device).replace(/\.keyword$/, ''), 'src_hostname', 'host.name', 'host.hostname', 'agent.hostname', 'hostname']) ?? null,
    clientId: pick(s, ['ClientID', 'clientId', 'client_id']) ?? null,
    zone: pick(s, ['zone', 'Zone']) ?? null,
    tag1: pick(s, ['tag1']) ?? null,
    parser: pick(s, ['parser_tag', 'parsertag']) ?? null,
    fwd: pick(s, ['fwd_tag', 'fwdtag']) ?? null,
    logType: pick(s, ['log_type', 'logtype', 'event.dataset']) ?? null,
    event: d.event,
    delay: d.delayMinutes,
    rawGap: d.rawGapMinutes,
    tzOffset: d.tzOffsetMinutes,
    message: typeof msg === 'string' ? msg : JSON.stringify(s).slice(0, 400),
  };
}

const COLS = [
  ['ts', null, 'date', (d) => d.ts],
  ['event', null, 'date', (d) => d.event],
  ['device', 'device / src_hostname', 'text', (d) => d.device],
  ['clientId', 'ClientID', 'text', (d) => d.clientId],
  ['zone', 'zone', 'text', (d) => d.zone],
  ['tag1', 'tag1', 'text', (d) => d.tag1],
  ['parser', 'parser_tag', 'text', (d) => d.parser],
  ['fwd', 'fwd_tag', 'text', (d) => d.fwd],
  ['logType', 'log_type', 'text', (d) => d.logType],
  ['delay', 'delay (min)', 'number', (d) => d.delay],
  ['message', 'message', 'text', (d) => d.message],
];

function hitsCard(c) {
  const tz = ctx.zone();
  const off = offsetText(zoneOffsetMinutes(tz));
  // The cluster's log time zone (core/log-tz.js): both times are written in it, so the difference
  // seen is the delay. Without one, both are in the page's zone and nothing is taken out.
  const ltz = zoneOf(c.id);
  const lOff = clusterOffsetAt(ltz, Date.now());
  const showZone = ltz && lOff !== null ? (ltz.zone && ltz.zone !== 'UTC' ? ltz.zone : null) : null;
  const inZone = (ms) => (showZone ? zonedText(ms, showZone) : lOff !== null ? zonedText(ms + lOff * 60000, 'UTC') : zonedText(ms, tz));
  const zoneWord = lOff !== null ? `cluster zone, ${offsetLabel(lOff)}` : `${tz || 'the browser’s zone'}, ${off}`;
  const docs = ui.hits.map((hit) => docOf(hit, c));
  const ordered = sortLogs.apply(docs, Object.fromEntries(COLS.map(([k, , type, value]) => [k, { type, value }])));
  const sig = `${objId(ui.hits)}|${ui.expanded.size}|${[...ui.expanded].join(',')}|${sortLogs.sort ? `${sortLogs.sort.key}${sortLogs.sort.dir}` : '-'}|${tz}|${ltz ? `${ltz.mode}${lOff}` : '-'}|${ui.running && !ui.hits.length}|${ui.tail}`;
  return L.get('live:hits', sig, () => {
    const cell = (v, cls = '') => h(`td${cls}`, v === null || v === undefined ? h('span.muted', '—') : String(v));
    const rows = ordered.flatMap((d, i) => {
      const k = `${d.hit._index}/${d.hit._id}`;
      const open = ui.expanded.has(k);
      return [
        h('tr.ld-log', {
          id: `log-row-${i}`, 'aria-expanded': String(open), title: 'Show the whole document',
          ...activatable(() => { if (ui.expanded.has(k)) ui.expanded.delete(k); else ui.expanded.add(k); bump(); }),
        },
        h('td.mono.nowrap', d.ts === null ? h('span.muted', 'unreadable') : inZone(d.ts)),
        h('td.mono.nowrap', d.event === null ? h('span.muted', 'unreadable') : inZone(d.event)),
        cell(d.device, '.mono'), cell(d.clientId), cell(d.zone), cell(d.tag1), cell(d.parser), cell(d.fwd), cell(d.logType),
        h('td.num', { title: d.delay === null ? null : d.tzOffset === null ? `arrival − event = ${minutesText(d.delay)}`
          : `arrival − event − time zone ${offsetLabel(d.tzOffset)} = ${minutesText(d.delay)} (raw gap ${minutesText(d.rawGap)})` },
        d.delay === null ? h('span.muted', 'unknown') : minutesText(d.delay)),
        h(`td.mono.ld-msg${open ? '.ld-open-msg' : ''}`, d.message)),
        open ? h('tr', h('td.ld-json', { colspan: COLS.length }, jsonView(d.hit._source))) : null,
      ];
    }).filter(Boolean);
    const evName = eventSource(resolveFields(c))[0] || 'event time';
    const label = (k) => (k === 'ts' ? `${c.timeField || '@timestamp'} (${zoneWord})` : k === 'event' ? `${evName} (UTC → ${lOff !== null ? offsetLabel(lOff) : off})` : null);
    const head = h('thead', h('tr', ...COLS.map(([k, lbl, type]) => sortTh(sortLogs, k, lbl || label(k), { num: type === 'number',
      title: k === 'ts' ? `Arrival time (${c.timeField}) in ${lOff !== null ? 'the cluster’s log time zone' : `the server's zone, ${tz || 'the browser’s zone'}`}`
        : k === 'event' ? `Event time (${evName}), stored in UTC, written in the same zone as the arrival so the difference is the delay` : null }))));
    return card('Log events', `${num(ui.hits.length)} shown${ui.tail ? ' · live tail on' : ''} · times in ${lOff !== null ? `the cluster’s log time zone (${ltz.zone ? `${ltz.zone}, ` : ''}${offsetLabel(lOff)}, ${ltz.mode})` : `${tz || 'the browser’s zone'} (${off})`}`
      + (ltz && ltz.mode === 'none' ? ` · cluster time zone ${timeZoneShort(ltz)}: delay as measured` : '') + ' · a row opens the whole document',
      h('div.tbl-wrap', h('table.tbl.ld-logs#ld-live-logs', head,
        h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: COLS.length }, empty(ui.running ? 'Searching…' : 'No documents in this range')))])))),
      [h('button.btn.sm#ld-live-csv', { type: 'button', disabled: !ui.hits.length, onclick: () => exportHits(c) }, 'Export CSV')]);
  });
}

function exportHits(c) {
  const tz = ctx.zone();
  const off = offsetText(zoneOffsetMinutes(tz));
  const data = ui.hits.map((hit) => {
    const d = docOf(hit, c);
    return {
      [`@timestamp (${off})`]: d.ts === null ? '' : zonedText(d.ts, tz), device: d.device ?? '', ClientID: d.clientId ?? '', zone: d.zone ?? '', tag1: d.tag1 ?? '',
      parser_tag: d.parser ?? '', fwd_tag: d.fwd ?? '', log_type: d.logType ?? '', delay_minutes: d.delay === null ? '' : d.delay.toFixed(2),
      message: d.message, index: hit._index,
    };
  });
  download(`logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`, toCsv(data), 'text/csv');
}

/* -------------------------------- the toolbar -------------------------------- */

/** The text fields: one element each for the visit, so typing never loses its box. */
const fields = new Map();
function textField(id, key, attrs) {
  let el = fields.get(id);
  if (!el) {
    el = h(`input#${id}`, { type: 'search', ...attrs, oninput: (e) => { ui[key] = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') search(); } });
    fields.set(id, el);
  }
  if (el.value !== String(ui[key])) el.value = String(ui[key]);
  return el;
}

function toolbar(c) {
  const active = activeClusters();
  const known = state.indices.get(c.id) || [];
  const sources = [...new Set(known.filter((r) => r.source).map((r) => r.source))].sort();
  const logFields = (c.logSearchFields && c.logSearchFields.length) ? c.logSearchFields : [];
  const fieldList = [...new Set([...(ui.field !== 'any' ? [ui.field] : []), ...logFields])];
  const custom = ctx.range().id === 'custom';
  const shell = L.get('live:bar', `${active.map((x) => x.id).join(',')}|${c.id}|${sources.join(',')}|${fieldList.join(',')}|${ui.field}|${ui.sourceFilter}|${ui.tail}|${custom}`, () => {
    const pickC = active.length > 1 ? h('label.field', { title: 'A tail follows one cluster at a time' }, 'Cluster', (() => {
      const sel = h('select#ld-live-cluster', { onchange: (e) => { ui.clusterId = e.target.value; ui.narrowedTo = ''; stopTail(); search(); } },
        ...active.map((x) => h('option', { value: x.id }, x.name)));
      sel.value = c.id; return sel;
    })()) : null;
    const src = h('select#ld-live-source', { onchange: (e) => { ui.sourceFilter = e.target.value; search(); } },
      h('option', { value: 'all' }, 'All sources'), ...sources.map((n) => h('option', { value: n }, n)));
    src.value = ui.sourceFilter;
    const fld = h('select#ld-live-field', { onchange: (e) => { ui.field = e.target.value; if (ui.term.trim()) search(); } },
      h('option', { value: 'any' }, 'Any field'), ...fieldList.map((n) => h('option', { value: n }, n)));
    fld.value = ui.field;
    const rowsIn = h('input#ld-live-rows', { type: 'number', min: '10', max: '2000', step: '10', value: String(ui.size), onchange: (e) => { ui.size = Number(e.target.value) || 200; } });
    return h('div.toolbar.ld-live-bar',
      pickC,
      h('label.field', 'Source', src),
      h('label.field', 'Field', fld),
      h('label.field', 'Value', textField('ld-live-value', 'term', { placeholder: 'fw-dc1-07, 10.0.*, timeout', 'aria-label': 'Value' })),
      h('label.field', 'Lucene query', textField('ld-live-query', 'query', { placeholder: 'log_type:firewall AND zone:dc1', 'aria-label': 'Lucene query' })),
      h('label.field', 'Rows', rowsIn),
      h('button.btn.primary#ld-live-search', { type: 'button', onclick: () => search() }, 'Search'),
      h('div.ld-bar-right',
        h('button.btn.sm#ld-live-tail', { type: 'button', disabled: custom, title: custom ? 'A custom range does not move: pick a “Last …” range to follow new documents' : 'Search again on every refresh interval',
          'aria-pressed': String(ui.tail), onclick: () => (ui.tail ? (stopTail(), bump()) : startTail()) },
        ui.tail ? '■ Stop live tail' : '▶ Live tail')));
  });
  return shell;
}

/** The view's nodes for the page to mount. */
export function liveNodes() {
  L.begin();
  try {
    const wrap = L.get('live:wrap', '', () => h('div.rp-section.ld', { dataset: { ld: 'live' } }));
    const c = cluster();
    if (!c) { mount(wrap, L.get('live:none', '', () => empty('No cluster selected'))); return wrap; }
    const tz = ctx.zone();
    const status = L.get('live:status', `${ui.running}|${objId(ui.resolved)}|${ui.error}|${ui.total}|${ui.tookMs}|${tz}`, () => h('div.ld-live-status',
      ui.running ? h('span.muted', h('span.spin'), ' searching…') : null,
      ui.resolved && ui.resolved.list ? h('span.muted',
        ui.resolved.exact ? `${ui.resolved.list.length} daily ${ui.resolved.list.length === 1 ? 'index' : 'indices'}: ` : 'No matching daily indices cached — the pattern ',
        h('code.inline', ui.resolved.list.slice(0, 3).join(', ') + (ui.resolved.list.length > 3 ? ` +${ui.resolved.list.length - 3} more` : ''))) : null,
      ui.error ? h('div.banner.err.ld-flat', h('div', h('div.ttl', 'Search failed'), h('div.mono', ui.error))) : null));
    const chart = L.get('live:chart', `${objId(ui.buckets)}|${ui.running && !ui.buckets.length}|${ui.total}|${tz}`, () => card('Documents over time',
      `${num(ui.total)}${ui.totalRelation === 'gte' ? '+' : ''} matching · ${rangeText(ctx.range(), tz)} · query took ${dur(ui.tookMs)}`,
      ui.running && !ui.buckets.length ? h('div.tbl-empty', h('span.spin'), ' searching…')
        : timeHistogram(ui.buckets, { height: 120, yLabel: 'Documents', emptyText: histogramEmptyText(ui.total, c.timeField),
          formatX: (t) => zonedText(t, tz, { seconds: false }).slice(5) })));
    mount(wrap, toolbar(c), status, chart, hitsCard(c));
    return wrap;
  } finally { L.end(); }
}

/** For a test or a new config: forget what was searched. */
export function liveReset() {
  liveLeave();
  Object.assign(ui, { hits: [], buckets: [], total: 0, error: null, resolved: [], expanded: new Set(), narrowedTo: '', term: '', field: 'any', query: '' });
  L.clear();
}
