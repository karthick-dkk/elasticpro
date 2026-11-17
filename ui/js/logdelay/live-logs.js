/**
 * Log Delay › Live, its bottom card "Logs": one cluster's log documents over the Live range,
 * newest first, with each one's own delay — filtered by Source (the tenant in the index name),
 * the device field (src_hostname), the address field (src_ip), tag1 and a query. Live logs until
 * the merge (Live Watch and Live logs became one tab, Live; docs/LOGDELAY.md "Live").
 *
 * Nothing is searched until Search is pressed, and the live tail is off until Start live tail is.
 * The tail stops by itself when the tab or the page is left, and after IDLE_MS (core/activity.js,
 * three minutes — the same "idle" the menu rail folds on) with no mouse, key, wheel or touch in
 * the app; then the card says so, with Start again (0.3.77).
 * Watching a device in "Delayed now" (logdelay/watch.js), or arriving by a row's address
 * (#/log-delay/live/<cluster>/<device>), narrows the filters to that device and waits for Search.
 *
 * The filters' field names are the cluster's configured log fields (core/log-delay.js
 * logFilterFields — the one definition); a field the configuration does not name is a disabled
 * filter that says so, and one the indices do not map is refused in words before a search is sent.
 *
 * A tail is one stream of one cluster's documents — merging several would give a list whose
 * order means nothing — so with All clusters chosen the card picks one and names it. Times are in
 * the server's zone (or the cluster's log time zone), and the card's head says which.
 */

import { tailTick } from '../core/tail.js';
import { idleMs, idleWords, onActivity } from '../core/activity.js';
import { h, mount, activatable, svg } from '../lib/dom.js';
import { nodeCache, objId } from '../lib/keyed.js';
import { num, dur, ymdDots, eachDay, download, toCsv } from '../lib/fmt.js';
import { sortTh, tableSort } from '../lib/table-sort.js';
import { state, client, activeClusters, fetchIndices, clusters } from '../core/state.js';
import { timeHistogram, histogramEmptyText } from '../lib/charts.js';
import { resolveFields, docDelay, logFilterFields, logFilterClause, looksLikeIp, aggregatableName } from '../core/log-delay.js';
import { minutesText } from '../core/logdelay-report.js';
import { zoneOf, loadLevels } from '../core/delay-levels.js';
import { clusterOffsetAt, offsetLabel, timeZoneShort } from '../core/log-tz.js';
import { rangeBounds, rangeText, zonedText, zoneOffsetMinutes, offsetText } from '../core/log-range.js';
import { jsonView } from '../lib/jsonview.js';
import { pickId } from './boards.js';

const ui = {
  clusterId: '',
  sourceFilter: 'all',
  host: '', ip: '', tag1: '', query: '',
  size: 200,
  running: false,
  searched: false,        // a search ran for the filters on screen (false: "Nothing searched yet")
  error: null,
  hits: [], total: 0, totalRelation: 'eq', tookMs: 0, buckets: [], resolved: null, rangeText: '',
  tail: false,
  tailStopped: null,      // 'idle': the tail stopped itself after IDLE_MS without activity (said, with Start again)
  expanded: new Set(),
  narrowed: null,         // { clusterId, device }: watched above, or named by the address
  mapped: new Map(),      // cluster id -> Set of the filter fields its indices map (asked once, on the first Search that needs it)
  ver: 0,
};

let tailTimer = null;
/** The tail's idle stop (armTailIdle): its timer, when it was last armed, and the activity listener to let go of. */
const TAIL_SEAM = '__EP_TAIL_IDLE_MS';
let tailIdleTimer = null;
let tailArmedAt = 0;
let tailActive = null;
/** The search still out: a newer one, or leaving the tab, lets go of it. */
let searchCtl = null;
let searchSeq = 0;
let ctx = { repaint: () => {}, range: () => ({ id: '1h' }), zone: () => null };
const L = nodeCache();
const bump = () => { ui.ver += 1; ctx.repaint(); };
const sortLogs = tableSort('logdelay.live', { onChange: () => bump() });

/** The cluster the card reads: the watched device's, else the one chosen in the top bar, else the one picked here, else the first. */
function cluster() {
  const active = activeClusters();
  const all = clusters();
  if (ui.narrowed) { const n = all.find((c) => c.id === ui.narrowed.clusterId); if (n) return n; }
  const sel = pickId();
  if (sel) { const c = all.find((x) => x.id === sel); if (c) return c; }
  return active.find((c) => c.id === ui.clusterId) || active[0] || null;
}

/** Forget the documents on screen: the filters they answered changed. */
function forget() {
  stopTail();
  if (searchCtl) searchCtl.abort();
  searchCtl = null;
  Object.assign(ui, { running: false, searched: false, error: null, hits: [], total: 0, buckets: [], resolved: null, expanded: new Set() });
}

/**
 * The tab is shown, for `route` ({clusterId, device} names one device). Nothing is searched: an
 * address naming a device fills the filters and waits for Search.
 */
export function liveEnter(c, route) {
  ctx = { ...ctx, ...c };
  if (route && route.clusterId) {
    const want = `${route.clusterId}|${route.device || ''}`;
    const have = ui.narrowed ? `${ui.narrowed.clusterId}|${ui.narrowed.device || ''}` : '';
    if (want !== have) {
      if (route.device) liveNarrow({ clusterId: route.clusterId, device: route.device }, false);
      else { forget(); ui.narrowed = null; ui.clusterId = route.clusterId; }
    }
  }
}

/** The tab is left: the tail stops and the search still out is let go of. */
export function liveLeave() {
  stopTail();
  ui.tailStopped = null;
  if (searchCtl) searchCtl.abort();
  searchCtl = null;
  ui.running = false;
}

export const liveBusy = () => ui.running;

/** The range changed above: a tail over a custom range has nothing new to follow. Nothing is searched. */
export function liveRangeChanged() { if (ui.tail && ctx.range().id === 'custom') { stopTail(); bump(); } }

/** Narrow the filters to one device (Watch, or an address): its name in the device field, an address in the address field. */
export function liveNarrow({ clusterId, device }, repaint = true) {
  forget();
  ui.narrowed = { clusterId, device };
  ui.clusterId = clusterId;
  const ip = looksLikeIp(device);
  ui.host = ip ? '' : device; ui.ip = ip ? device : '';
  if (repaint) bump();
}

/** Stop watching: the device leaves the filters, and its documents leave the card. */
export function liveUnnarrow() {
  const n = ui.narrowed;
  if (!n) return;
  forget();
  if (ui.host === n.device) ui.host = '';
  if (ui.ip === n.device) ui.ip = '';
  ui.narrowed = null;
}

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

/** The filters with a value, as `[label, field, value]`; a filter whose field is not configured has none. */
function filled(c) {
  const f = logFilterFields(c);
  return [['src_hostname', f.host, ui.host], ['src_ip', f.ip, ui.ip], ['tag1', f.tag1, ui.tag1]].filter(([, field, v]) => field && String(v || '').trim());
}

/**
 * Whether the indices map each filled filter's field (the field or its .keyword): one _field_caps
 * per cluster, on the first Search that needs it. A field they do not map is refused in words —
 * a filter that cannot match must not read as "no documents". Unknown (the call failed) searches.
 */
async function unmapped(c, list) {
  if (!list.length) return [];
  let have = ui.mapped.get(c.id);
  const want = list.flatMap(([, f]) => [f, aggregatableName(f)]);
  if (!have || want.some((f) => !have.asked.has(f))) {
    try {
      const caps = await client(c.id).fieldCaps(c.logIndexPattern || 'logstash-*', want);
      have = { asked: new Set(want), present: new Set(Object.keys((caps && caps.fields) || {})) };
      ui.mapped.set(c.id, have);
    } catch (_) { return []; }
  }
  return list.filter(([, f]) => !have.present.has(f) && !have.present.has(aggregatableName(f)));
}

/** The search body for `c` over `b` with the filters on screen. */
function searchBody(c, b) {
  const gte = new Date(b.from).toISOString();
  const lte = new Date(b.to).toISOString();
  const must = ui.query.trim() ? [{ query_string: { query: ui.query.trim(), analyze_wildcard: true, default_field: '*' } }] : [];
  for (const [, field, value] of filled(c)) { const cl = logFilterClause(field, value); if (cl) must.push(cl); }
  return {
    size: Number(ui.size) || 200,
    track_total_hits: 10000,
    sort: [{ [c.timeField]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { filter: [{ range: { [c.timeField]: { gte, lte, format: 'strict_date_optional_time' } } }], must } },
    aggs: { over_time: { date_histogram: { field: c.timeField, fixed_interval: interval(b.to - b.from), min_doc_count: 0, extended_bounds: { min: gte, max: lte } } } },
  };
}

/** Search: only from a press (Search, Enter in a filter, the live tail the person started). */
async function search({ silent = false } = {}) {
  const c = cluster();
  if (!c) return;
  const b = rangeBounds(ctx.range());
  if (!b) { ui.error = 'Set both ends of the custom range.'; ui.searched = true; bump(); return; }
  if (searchCtl) searchCtl.abort();
  searchCtl = typeof AbortController === 'undefined' ? null : new AbortController();
  const signal = searchCtl ? searchCtl.signal : undefined;
  const mine = ++searchSeq;
  ui.running = true; ui.error = null; ui.searched = true;
  if (!silent) { ui.tailStopped = null; bump(); }
  // The clusters' log time zones (core/delay-levels.js zoneOf), for each document's delay.
  await loadLevels().catch(() => {});
  if (!state.indices.get(c.id)) { try { await fetchIndices(c.id, '*'); } catch (_) { /* the pattern below still works */ } }
  if (mine !== searchSeq) return;
  const missing = await unmapped(c, filled(c));
  if (mine !== searchSeq) return;
  if (missing.length) {
    ui.running = false; ui.hits = []; ui.buckets = []; ui.total = 0;
    ui.error = missing.map(([label, f]) => `${label}: ${f} is not mapped in ${c.logIndexPattern || 'logstash-*'} on ${c.name}, so this filter cannot match`).join(' · ')
      + ' — empty it, or set the cluster’s delayFields to the name its parser produces.';
    stopTail();
    bump();
    return;
  }
  const t = targetIndices(c, b);
  ui.resolved = t;
  ui.rangeText = rangeText(ctx.range(), ctx.zone());
  try {
    // Whole index names up to what a URL holds; past that the pattern, never a name cut in half.
    let idx = '';
    for (const n of t.list) { if (idx.length + n.length + 1 > 3500) { idx = c.logIndexPattern || '*'; break; } idx += (idx ? ',' : '') + n; }
    const r = await client(c.id).search(idx, searchBody(c, b), { qs: 'ignore_unavailable=true&allow_no_indices=true&rest_total_hits_as_int=false', timeoutMs: 45000, signal });
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
  ui.tailStopped = null;
  tailTimer = setInterval(() => tailTick(() => ui.running, () => search({ silent: true })),
    Math.max(5, state.defaults.refreshIntervalSec || 30) * 1000);
  armTailIdle();
  // Any activity in the app restarts the count, at most a few times a second-or-so (a moving mouse is one activity).
  tailActive = onActivity(() => { if (ui.tail && Date.now() - tailArmedAt > Math.min(1000, idleMs(TAIL_SEAM) / 4)) armTailIdle(); });
  search();
}
function stopTail() {
  ui.tail = false;
  if (tailTimer) clearInterval(tailTimer);
  tailTimer = null;
  clearTimeout(tailIdleTimer);
  tailIdleTimer = null;
  if (tailActive) tailActive();
  tailActive = null;
}

/**
 * The tail's idle stop: IDLE_MS (core/activity.js) after the last activity it stops and says so.
 * A browser check shortens it with `window.__EP_TAIL_IDLE_MS`, as the menu rail's `__EP_RAIL_IDLE_MS`.
 */
function armTailIdle() {
  clearTimeout(tailIdleTimer);
  tailArmedAt = Date.now();
  tailIdleTimer = setTimeout(() => {
    tailIdleTimer = null;
    if (!ui.tail) return;
    stopTail();
    ui.tailStopped = 'idle';
    bump();
  }, idleMs(TAIL_SEAM));
}
// Leaving the page for good (closed, reloaded, gone elsewhere): no tail left behind.
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { if (ui.tail) { stopTail(); bump(); } });

/* -------------------------------- the columns -------------------------------- */

const pick = (src, keys) => {
  for (const k of keys) {
    const v = String(k).split('.').reduce((o, p) => (o == null ? o : o[p]), src);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/**
 * A document as the row shows it: the values each column reads (the filters' own fields), the
 * delay from docDelay with the cluster's log time zone taken out (core/log-tz.js; `zoneOf`).
 */
function docOf(hit, c) {
  const s = hit._source || {};
  const f = resolveFields(c);
  const lf = logFilterFields(c);
  // resolveFields gives the event-time candidates as a list, tried in order (eventSource is for a preflight's `resolved`).
  const d = docDelay(s, c.timeField || f.arrival, f.eventTime, zoneOf(c.id));
  const msg = pick(s, ['message', 'log.message', 'msg', 'event.original', 'full_message']);
  return {
    hit,
    ts: d.arrival,
    event: d.event,
    host: pick(s, [lf.host, 'src_hostname', 'host.name', 'host.hostname', 'agent.hostname', 'hostname'].filter(Boolean)) ?? null,
    ip: lf.ip ? pick(s, [lf.ip]) ?? null : null,
    tag1: pick(s, [lf.tag1, 'tag1']) ?? null,
    delay: d.delayMinutes,
    rawGap: d.rawGapMinutes,
    tzOffset: d.tzOffsetMinutes,
    message: typeof msg === 'string' ? msg : JSON.stringify(s).slice(0, 400),
  };
}

const COLS = [
  ['ts', 'Arrived', 'date', (d) => d.ts],
  ['event', 'Event time', 'date', (d) => d.event],
  ['host', null, 'text', (d) => d.host],
  ['ip', null, 'text', (d) => d.ip],
  ['tag1', null, 'text', (d) => d.tag1],
  ['delay', 'Delay', 'number', (d) => d.delay],
  ['message', 'Message', 'text', (d) => d.message],
];

/** The zone both times are written in: the cluster's log time zone when it has one (the difference seen is the delay), else the page's. */
function zoneOfCard(c) {
  const tz = ctx.zone();
  const off = offsetText(zoneOffsetMinutes(tz));
  const ltz = zoneOf(c.id);
  const lOff = clusterOffsetAt(ltz, Date.now());
  const showZone = ltz && lOff !== null ? (ltz.zone && ltz.zone !== 'UTC' ? ltz.zone : null) : null;
  const inZone = (ms) => (showZone ? zonedText(ms, showZone) : lOff !== null ? zonedText(ms + lOff * 60000, 'UTC') : zonedText(ms, tz));
  const words = lOff !== null ? `the cluster’s log time zone (${ltz.zone ? `${ltz.zone}, ` : ''}${offsetLabel(lOff)}, ${ltz.mode})` : `${tz || 'the browser’s zone'} (${off})`;
  return { tz, off, ltz, lOff, inZone, words };
}

function tableNode(c) {
  const z = zoneOfCard(c);
  const lf = logFilterFields(c);
  const docs = ui.hits.map((hit) => docOf(hit, c));
  const ordered = sortLogs.apply(docs, Object.fromEntries(COLS.map(([k, , type, value]) => [k, { type, value }])));
  const sig = `${objId(ui.hits)}|${[...ui.expanded].join(',')}|${sortLogs.sort ? `${sortLogs.sort.key}${sortLogs.sort.dir}` : '-'}|${z.tz}|${z.ltz ? `${z.ltz.mode}${z.lOff}` : '-'}|${ui.running && !ui.hits.length}|${lf.host}|${lf.ip}`;
  return L.get('live:table', sig, () => {
    const cell = (v, cls = '') => h(`td${cls}`, v === null || v === undefined ? h('span.muted', '—') : String(v));
    const rows = ordered.flatMap((d, i) => {
      const k = `${d.hit._index}/${d.hit._id}`;
      const open = ui.expanded.has(k);
      return [
        h('tr.ld-log', {
          id: `log-row-${i}`, 'aria-expanded': String(open), title: 'Show the whole document',
          ...activatable(() => { if (ui.expanded.has(k)) ui.expanded.delete(k); else ui.expanded.add(k); bump(); }),
        },
        h('td.mono.nowrap', d.ts === null ? h('span.muted', 'unreadable') : z.inZone(d.ts).slice(11)),
        h('td.mono.nowrap', d.event === null ? h('span.muted', 'unreadable') : z.inZone(d.event).slice(d.ts !== null && z.inZone(d.ts).slice(0, 10) === z.inZone(d.event).slice(0, 10) ? 11 : 0)),
        cell(d.host, '.mono'), cell(d.ip, '.mono'), cell(d.tag1),
        h('td.num', { title: d.delay === null ? null : d.tzOffset === null ? `arrival − event = ${minutesText(d.delay)}`
          : `arrival − event − time zone ${offsetLabel(d.tzOffset)} = ${minutesText(d.delay)} (raw gap ${minutesText(d.rawGap)})` },
        d.delay === null ? h('span.muted', 'unknown') : minutesText(d.delay)),
        h(`td.mono.ld-msg${open ? '.ld-open-msg' : ''}`, d.message)),
        open ? h('tr', h('td.ld-json', { colspan: COLS.length }, jsonView(d.hit._source))) : null,
      ];
    }).filter(Boolean);
    const evName = (resolveFields(c).eventTime || [])[0] || 'event time';
    const label = (k, lbl) => lbl || (k === 'host' ? lf.host || 'src_hostname' : k === 'ip' ? lf.ip || 'src_ip' : lf.tag1);
    const title = (k) => (k === 'ts' ? `When it arrived (${c.timeField || '@timestamp'}), in ${z.words}`
      : k === 'event' ? `When it happened (${evName}), stored in UTC, written in the same zone as Arrived so the difference is the delay` : null);
    const head = h('thead', h('tr', ...COLS.map(([k, lbl, type]) => sortTh(sortLogs, k, label(k, lbl), { num: type === 'number', title: title(k) }))));
    return h('div.tbl-wrap', h('table.tbl.ld-logs#ld-live-logs', head,
      h('tbody', ...(rows.length ? rows : [h('tr', h('td', { colspan: COLS.length }, h('div.tbl-empty', ui.running ? 'Searching…' : 'No documents in this range for these filters.')))]))));
  });
}

function exportHits(c) {
  const z = zoneOfCard(c);
  const lf = logFilterFields(c);
  const data = ui.hits.map((hit) => {
    const d = docOf(hit, c);
    return {
      [`arrived (${z.off})`]: d.ts === null ? '' : zonedText(d.ts, z.tz), [`event_time (${z.off})`]: d.event === null ? '' : zonedText(d.event, z.tz),
      [lf.host || 'src_hostname']: d.host ?? '', [lf.ip || 'src_ip']: d.ip ?? '', [lf.tag1]: d.tag1 ?? '',
      delay_minutes: d.delay === null ? '' : d.delay.toFixed(2), message: d.message, index: hit._index,
    };
  });
  download(`logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`, toCsv(data), 'text/csv');
}

/* -------------------------------- the filters -------------------------------- */

/** The text fields: one element each for the visit, so typing never loses its box. */
const fields = new Map();
function textField(id, key, attrs) {
  let el = fields.get(id);
  if (!el) {
    el = h(`input#${id}`, { type: 'search', ...attrs, oninput: (e) => { ui[key] = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') search(); } });
    fields.set(id, el);
  }
  for (const [k, v] of Object.entries(attrs)) if (k === 'disabled' ? el.disabled !== !!v : el.getAttribute(k) !== String(v)) { if (k === 'disabled') el.disabled = !!v; else el.setAttribute(k, String(v)); }
  if (el.value !== String(ui[key])) el.value = String(ui[key]);
  return el;
}

const icon = (paths, fill = 'none') => svg('svg', { viewBox: '0 0 24 24', width: '13', height: '13', 'aria-hidden': 'true', fill, stroke: fill === 'none' ? 'currentColor' : 'none', 'stroke-width': '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  ...paths.map((d) => svg('path', { d })));

function filtersRow(c) {
  const active = activeClusters();
  const known = state.indices.get(c.id) || [];
  const sources = [...new Set(known.filter((r) => r.source).map((r) => r.source))].sort();
  const lf = logFilterFields(c);
  const pickHere = !pickId() && active.length > 1 && !ui.narrowed;
  const shell = L.get('live:filters', `${active.map((x) => x.id).join(',')}|${c.id}|${sources.join(',')}|${ui.sourceFilter}|${lf.host}|${lf.ip}|${lf.tag1}|${pickHere}`, () => {
    const pickC = pickHere ? h('label.ld-lf', { title: 'Logs follow one cluster at a time' }, 'Cluster', (() => {
      const sel = h('select#ld-live-cluster', { onchange: (e) => { ui.clusterId = e.target.value; forget(); bump(); } },
        ...active.map((x) => h('option', { value: x.id }, x.name)));
      sel.value = c.id; return sel;
    })()) : null;
    const src = h('select#ld-live-source', { onchange: (e) => { ui.sourceFilter = e.target.value; } },
      h('option', { value: 'all' }, 'All sources'), ...sources.map((n) => h('option', { value: n }, n)));
    src.value = ui.sourceFilter;
    const field = (id, key, name, fallback, placeholder) => h('label.ld-lf', { title: name ? `Searches ${name} (the cluster’s configured log field)` : `No ${fallback} field is configured for ${c.name}: set it in the cluster’s delayFields to filter by it` },
      name || fallback, textField(id, key, { placeholder: name ? placeholder : 'not configured', 'aria-label': name || fallback, disabled: !name }));
    return h('div.ld-lfilters',
      pickC,
      h('label.ld-lf', 'Source', src),
      field('ld-live-host', 'host', lf.host, 'src_hostname', 'fw-core-*'),
      field('ld-live-ip', 'ip', lf.ip, 'src_ip', '10.4.0.0/16'),
      field('ld-live-tag1', 'tag1', lf.tag1, 'tag1', 'firewall'),
      h('label.ld-lf.ld-lf-q', 'Query', textField('ld-live-query', 'query', { placeholder: 'log_type:syslog AND level:error', 'aria-label': 'Query' })),
      h('button.btn.primary#ld-live-search', { type: 'button', onclick: () => search() }, icon(['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-3.5-3.5']), ' Search'));
  });
  // The row is kept while its shape holds; what a Watch or an address put in a filter reaches its box on every draw.
  for (const [id, key] of [['ld-live-host', 'host'], ['ld-live-ip', 'ip'], ['ld-live-tag1', 'tag1'], ['ld-live-query', 'query']]) {
    const el = fields.get(id);
    if (el && el.value !== String(ui[key])) el.value = String(ui[key]);
  }
  return shell;
}

/* -------------------------------- the card -------------------------------- */

/**
 * The Logs card for the page to mount; `strip` is the watched device's strip from Delayed now
 * (logdelay/watch.js watchStrip), drawn at the card's top.
 */
export function liveCard(strip) {
  L.begin();
  try {
    const c = cluster();
    const shell = L.get('live:card', '', () => h('section.card.ld-lcard#ld-logs-card', { dataset: { ld: 'live-logs' } }, h('header', h('h2'), h('span.sub'), h('div.ld-lcard-acts')), h('div.body')));
    const [title, sub, acts] = shell.firstChild.children;
    if (!c) { title.textContent = 'Logs'; sub.textContent = ''; mount(acts); mount(shell.lastChild, L.get('live:none', '', () => h('div.ld-lempty', h('b', 'No cluster selected')))); return shell; }
    const z = zoneOfCard(c);
    const lf = logFilterFields(c);
    const n = ui.narrowed;
    const t = n ? `Logs · ${n.device}` : 'Logs';
    const narrowWords = n ? ` · ${looksLikeIp(n.device) ? lf.ip || 'src_ip' : lf.host || 'src_hostname'} = ${n.device}` : '';
    const s = `${c.name}${narrowWords} · one cluster’s documents · times in ${z.words}${z.ltz && z.ltz.mode === 'none' ? ` · cluster time zone ${timeZoneShort(z.ltz)}: delay as measured` : ''}`;
    if (title.textContent !== t) title.textContent = t;
    if (sub.textContent !== s) sub.textContent = s;
    const custom = ctx.range().id === 'custom';
    mount(acts, L.get('live:acts', `${ui.tail}|${custom}|${ui.hits.length > 0}`, () => [
      h('button.btn.sm#ld-live-tail', { type: 'button', disabled: custom, 'aria-pressed': String(ui.tail),
        title: custom ? 'A custom range does not move: pick a “Last …” range to follow new documents' : 'Search again on every refresh interval, until stopped',
        onclick: () => (ui.tail ? (stopTail(), bump()) : startTail()) },
      ui.tail ? icon(['M6 5h4v14H6z', 'M14 5h4v14h-4z'], 'currentColor') : icon(['M7 4v16l13-8z'], 'currentColor'), ui.tail ? ' Stop live tail' : ' Start live tail'),
      h('button.btn.sm#ld-live-csv', { type: 'button', disabled: !ui.hits.length, onclick: () => exportHits(c) }, icon(['M12 4v12', 'M6 11l6 6 6-6', 'M5 20h14']), ' Export CSV'),
    ]));
    const status = L.get('live:status', `${ui.running}|${objId(ui.resolved)}|${ui.error}`, () => (ui.running || ui.error || (ui.resolved && ui.resolved.list) ? h('div.ld-live-status',
      ui.running ? h('span.muted', h('span.spin'), ' Searching…') : null,
      ui.resolved && ui.resolved.list && !ui.error ? h('span.muted',
        ui.resolved.exact ? `${ui.resolved.list.length} daily ${ui.resolved.list.length === 1 ? 'index' : 'indices'}: ` : 'No matching daily indices cached — the pattern ',
        h('code.inline', ui.resolved.list.slice(0, 3).join(', ') + (ui.resolved.list.length > 3 ? ` +${ui.resolved.list.length - 3} more` : ''))) : null,
      ui.error ? h('div.banner.err.ld-flat#ld-live-error', h('div', h('div.ttl', 'Not searched'), h('div', ui.error))) : null) : null));
    const stopped = L.get('live:stopped', `${ui.tailStopped}|${custom}`, () => (ui.tailStopped === 'idle' ? h('div.ld-live-stopped#ld-live-tail-stopped', { role: 'status' },
      `Live tail stopped after ${idleWords()} without activity · `,
      h('button.linkish#ld-live-tail-again', { type: 'button', disabled: custom, onclick: () => startTail() }, 'Start again')) : null));
    let results;
    if (!ui.searched) {
      results = L.get('live:idle', `${!!n}`, () => h('div.ld-lidle#ld-live-idle', 'Nothing searched yet. Set filters and press ', h('b', 'Search'),
        n ? ' — the device watched above is in the filters.' : ' — or watch a device above.'));
    } else {
      const chart = L.get('live:chart', `${objId(ui.buckets)}|${ui.running && !ui.buckets.length}|${ui.total}|${z.tz}|${ui.rangeText}`, () => h('div.ld-lchart',
        h('div.ld-lchart-h', h('span', `Documents over time · ${num(ui.total)}${ui.totalRelation === 'gte' ? '+' : ''} in range`), h('span.muted', `${ui.rangeText} · query took ${dur(ui.tookMs)}`)),
        ui.running && !ui.buckets.length ? h('div.tbl-empty', h('span.spin'), ' Searching…')
          : timeHistogram(ui.buckets, { height: 110, yLabel: 'Documents', emptyText: histogramEmptyText(ui.total, c.timeField),
            formatX: (x) => zonedText(x, z.tz, { seconds: false }).slice(11) })));
      results = [chart, tableNode(c)];
    }
    mount(shell.lastChild, ...[strip, filtersRow(c), stopped, status].concat(results).filter(Boolean));
    return shell;
  } finally { L.end(); }
}

/** For a test or a new config: forget what was searched. */
export function liveReset() {
  liveLeave();
  forget();
  Object.assign(ui, { narrowed: null, host: '', ip: '', tag1: '', query: '', mapped: new Map() });
  L.clear();
}
