/**
 * Reports › Daily & monthly (docs/REPORTS.md, boards 2 and 3): how much one cluster took
 * per day and per month. Moved here from Indices › Summary (0.3.53); its state, polling and
 * collection rules are unchanged (docs/VOLUME.md).
 *
 * Every size is event_logsize: the record's `eventBytes`, through the functions in
 * core/volume-daily.js (perDayEventBytes, eventVsAvgPct, eventMonthSoFar, eventPeak,
 * dayStatus…), so a tile, a row and the CSV are the same calculation. Where the record says
 * null the page says "not measured", in amber, and names the setting that would measure it.
 *
 * The Day by day and Month by month columns are lib/columns.js, and their layout is shared on
 * the server (VOLUME_LAYOUT_*, tables daily / monthly): an operator arranges them once for
 * everybody. The core keeps a fixed list of keys for those two tables, so Status and
 * "vs previous" are drawn after the arranged columns rather than inside the layout.
 */

import { h } from '../lib/dom.js';
import { bytes, num, toCsv, download } from '../lib/fmt.js';
import { lineChart, signedPct } from '../lib/charts.js';
import { columnsButton, columnTable, sanitizeLayout } from '../lib/columns.js';
import { tableSort } from '../lib/table-sort.js';
import { state } from '../core/state.js';
import { navigateTo } from '../core/intent.js';
import { card, statTile, empty, unreadable, configErrorBanner } from '../pages/common.js';
import { toast } from '../ui/menu.js';
import { fromHistory, historyMarkText, historyLine } from '../core/history-store.js';
import { configErrorOf,
  volumeDaily, volumeMonthly, volumeBreakdown, volumeRun, volumeLayoutGet, volumeLayoutSet, isHosted,
  NEEDS_VERSION, collectDue, utcDay, monthName,
  lastMonths, breakdownPeriods, breakdownLabel, breakdownCsvRows, BREAKDOWN_CSV, shortDay,
  addDays, eventBytesOf, perDayEventBytes, eventVsAvgPct, eventYesterday, eventMonthSoFar, eventPeak,
  monthEventPeak, monthVsPrevious, daysInMonth, dayStatus, breakdownEventShares,
  reportDailyCsvRows, reportMonthlyCsvRows, REPORT_DAILY_CSV, REPORT_MONTHLY_CSV,
} from '../core/volume-daily.js';
import { forgetRecords } from './record.js';
import { isWorkerDown } from '../core/reports.js';

/** While a collection runs the record is asked for again this often, for at most this long. */
const POLL_MS = 3000;
const POLL_LIMIT_MS = 5 * 60 * 1000;

/** The days the chart and the table show. */
const SHOWN_DAYS = 30;
const AVG_CHOICES = [3, 7, 15, 30, 60, 180];
const MONTHS = 13;
const TOP_CHOICES = [10, 25, 50];
/** The graph's height in viewBox units (1000 wide): short, so the table starts on the first screen. */
const CHART_H = 150;

const vs = {
  mode: 'daily', source: '', avgDays: 7,
  bd: { field: 'sourceHost', period: 'month', top: 10 },
  rev: 0,
};
/** The record asked for: enough days for the month so far, the chart and the longest average before them. */
const recordDays = () => Math.min(400, Math.max(40, SHOWN_DAYS + 1 + vs.avgDays));
/** Replies by request, so changing a choice and changing it back costs nothing. */
const daily = new Map();
const monthly = new Map();
const breakdowns = new Map();
/** The last daily reply per cluster: drawn while a new choice loads, so nothing jumps. */
const lastDaily = new Map();
/** Polls in flight, per cluster: { until, timer }. Every one ends by itself. */
const polls = new Map();
/** Desktop asks for a run once per cluster per session, on opening the section. */
const autoAsked = new Set();
/** The shared column layouts, and whether this caller may change them. */
const layouts = { state: 'unknown', daily: null, monthly: null };
let unsupported = false;
/** The core answered `no_store`: it was started without a data directory, so it keeps no record. */
let noStore = false;
let redrawPage = () => {};
let built = { sig: null, node: null };

/**
 * Forget every answer, but keep the choices. Called when the Reports page opens, so each
 * visit reads the record as it is now — and a core upgraded since the last visit is asked
 * again rather than still taken for one without a daily record.
 */
export function resetVolumeSummary() {
  for (const p of polls.values()) if (p.timer) clearTimeout(p.timer);
  for (const m of [daily, monthly, breakdowns, lastDaily, polls]) m.clear();
  Object.assign(layouts, { state: 'unknown', daily: null, monthly: null });
  unsupported = false;
  noStore = false;
  built = { sig: null, node: null };
  vs.rev++;
}

const bump = () => { vs.rev++; redrawPage(); };

/** Open on Daily or Monthly (a link from another section). */
export function setSummaryMode(mode) {
  if (mode !== 'daily' && mode !== 'monthly') return;
  if (vs.mode !== mode) { vs.mode = mode; vs.rev++; }
}
const alive = () => !!(built.node && built.node.isConnected);

/**
 * The section for one cluster.
 *
 * Built once per change of its own state and kept otherwise: the page redraws on every push
 * from the core, and rebuilding this each time would close a header menu or a name being
 * edited under the operator's hands.
 */
export function volumeSummary(c, { redraw, picker = null }) {
  redrawPage = redraw || (() => {});
  if (layouts.state === 'unknown') loadLayouts();
  const sig = `${c.id}|${vs.rev}`;
  if (built.sig === sig && built.node) return built.node;
  const node = h('div.vs', vs.mode === 'daily' ? dailyView(c, picker) : monthlyView(c, picker));
  built = { sig, node };
  return node;
}

function modeSeg() {
  const b = (id, label, title) => h('button.btn.sm', {
    type: 'button', 'aria-pressed': vs.mode === id ? 'true' : 'false', title,
    onclick: () => { if (vs.mode !== id) { vs.mode = id; bump(); } },
  }, label);
  return h('div.seg', { role: 'group', 'aria-label': 'Daily or monthly' },
    b('daily', 'Daily', 'A row per index day, with the average and the change'),
    b('monthly', 'Monthly', 'A row per month, and a breakdown by field'));
}

function select(id, value, options, onChange) {
  const s = h(`select#${id}`, { onchange: (e) => onChange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: String(v) }, label)));
  s.value = String(value);
  return s;
}

/** Unknown is not zero: say why there is no record and which setting would keep one. */
function noRecordKept() {
  return empty('This server keeps no daily volume record.', {
    detail: 'It was started without a data directory. Set ELASTICPRO_DATA_DIR (the hosted image sets /app/data) and restart it.',
  });
}

function needsNewer() {
  return empty('This server does not keep a daily volume record yet.', {
    detail: `Per day and per month volume needs ElasticPro ${NEEDS_VERSION} or later on the server.`,
  });
}

/** The event size field's name, as the settings in use call it. */
function eventField(settings) {
  const s = settings || {};
  return (Array.isArray(s.eventSize) && s.eventSize[0]) || 'event_logsize';
}

/** "not measured", in amber, with what would measure it. */
function notMeasured(field = 'event_logsize') {
  return h('span.vs-notm', { title: `${field} is not measured: no numeric field for it in the mapping. Set it in Config-Management › Reports.` }, 'not measured');
}
const dash = () => h('span.muted', '—');

function openVolumeFields(field) {
  navigateTo('settings', { section: 'volume', field: field || null });
}

/** Where a layout lives, and whether this caller may change the shared one. */
function roleMaySave() {
  const role = state.caller && state.caller.role;
  return !role || role === 'operator' || role === 'admin';
}
const canSave = () => layouts.state === 'ok' && roleMaySave();

async function loadLayouts() {
  layouts.state = 'loading';
  const res = await volumeLayoutGet();
  if (res && res.ok) {
    // The core's own default when nobody has saved one is the Reports default (event_logsize
    // first, index size hidden: crates/elasticpro-core/src/volume/mod.rs DAILY_COLUMNS).
    layouts.daily = (res.layouts && res.layouts.daily) || null;
    layouts.monthly = (res.layouts && res.layouts.monthly) || null;
    layouts.state = 'ok';
  } else {
    layouts.state = 'unavailable';
  }
  bump();
}

/** Show/hide kept in this browser only, for a caller who cannot change the shared layout. */
const LOCAL_KEY = (t) => `elasticpro.volume.columns.${t}`;
function localLayout(t) {
  try { const s = localStorage.getItem(LOCAL_KEY(t)); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
function layoutFor(t) {
  return canSave() ? layouts[t] : (localLayout(t) || layouts[t]);
}
function changeLayout(t, defs, next) {
  const clean = sanitizeLayout(next, defs);
  if (!canSave()) {
    try { localStorage.setItem(LOCAL_KEY(t), JSON.stringify(clean)); } catch (_) { /* this session only */ }
    bump();
    return;
  }
  layouts[t] = clean;
  bump();
  volumeLayoutSet(t, clean).then((res) => {
    if (res && res.ok) return;
    if (res && res.kind === 'forbidden') { layouts.state = 'unavailable'; bump(); }
    toast(`The column layout was not saved: ${(res && res.message) || 'no answer'}`, 'warn', 5000, { key: 'vol-layout' });
  });
}

/* ---------------------------------- daily ----------------------------------- */

const dkey = (c) => `${c.id}|${recordDays()}|${vs.source}`;

async function loadDaily(c, force) {
  const key = dkey(c);
  const had = daily.get(key);
  if (!force && had && (had.loading || had.reply || had.error)) return had;
  // No redraw here: this is called while the view is being drawn, and that draw already
  // shows the loading state. The answer redraws.
  const ent = { loading: true, reply: had && had.reply, error: null };
  daily.set(key, ent);
  const res = await volumeDaily(c.id, { days: recordDays(), avgDays: Math.min(180, Math.max(3, vs.avgDays)), source: vs.source });
  ent.loading = false;
  if (res.unsupported) { unsupported = true; bump(); return ent; }
  if (res.kind === 'no_store') { noStore = true; bump(); return ent; }
  if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else { ent.reply = res; lastDaily.set(c.id, res); }
  bump();
  if (res.ok) afterDaily(c, res);
  return ent;
}

/** A run already going is followed; desktop asks for one when the last is older than collectAt. */
async function afterDaily(c, res) {
  const st = res.status || {};
  if (st.running) { poll(c); return; }
  if (autoAsked.has(c.id)) return;
  autoAsked.add(c.id);
  if (!(await isHosted()) && collectDue(st)) refreshNow(c, { auto: true });
}

async function refreshNow(c, { auto = false } = {}) {
  if (polls.has(c.id)) return;
  const res = await volumeRun([c.id]);
  if (res.unsupported) { unsupported = true; bump(); return; }
  if (res.kind === 'no_store') { noStore = true; bump(); return; }
  if (!res.ok) {
    // config_unreadable: the core's message is the whole answer.
    // The report worker not running is amber, in the core's words: collection resumes when it is back.
    if (!auto) {
      toast(res.kind === 'config_unreadable' || isWorkerDown(res) ? (res.message || res.kind) : `Could not start a collection: ${res.message || res.kind}`,
        isWorkerDown(res) ? 'warn' : 'err', 6000);
    }
    return;
  }
  if ((res.tooSoon || []).includes(c.id)) {
    if (!auto) toast('This cluster was collected less than a minute ago. Try again in a minute.', 'warn', 5000, { key: 'vol-too-soon' });
    return;
  }
  poll(c);
}

/** Follow a run until it ends, or five minutes pass, or the page is left. */
function poll(c) {
  if (polls.has(c.id)) return;
  const p = { until: Date.now() + POLL_LIMIT_MS, timer: null };
  polls.set(c.id, p);
  bump();
  const stop = () => {
    if (p.timer) clearTimeout(p.timer);
    polls.delete(c.id);
    // What was asked before the run is older than what it wrote.
    for (const m of [monthly, breakdowns]) for (const k of [...m.keys()]) if (k.startsWith(`${c.id}|`)) m.delete(k);
    for (const k of [...daily.keys()]) if (k.startsWith(`${c.id}|`) && k !== dkey(c)) daily.delete(k);
    // …and the fleet sections' copy of this cluster's record (reports/record.js).
    forgetRecords([c.id]);
    bump();
  };
  const tick = async () => {
    p.timer = null;
    if (!alive()) { stop(); return; }
    const ent = await loadDaily(c, true);
    const st = ent && ent.reply && ent.reply.status;
    if (st && st.running && Date.now() < p.until && alive()) { p.timer = setTimeout(tick, POLL_MS); return; }
    stop();
  };
  p.timer = setTimeout(tick, 1000);
}

function progressText(st, polling) {
  if (!st || !(st.running || polling)) return null;
  const pr = st.progress;
  return pr && pr.total ? `Collecting ${num(pr.done)}/${num(pr.total)} days` : 'Collecting…';
}

function collectButton(c, reply) {
  const polling = polls.has(c.id);
  return h('button#vs-collect.btn.sm', {
    type: 'button', disabled: polling || unsupported,
    title: 'Collect this cluster\'s daily record now',
    onclick: () => refreshNow(c),
  }, '↻ Collect now');
}

function dailyToolbar(c, reply, picker) {
  const st = reply && reply.status;
  const sources = (reply && reply.sources) || [];
  const prog = progressText(st, polls.has(c.id));
  return h('div.toolbar.vs-bar',
    modeSeg(),
    picker,
    h('label.field', 'Source', select('vs-source', vs.source,
      [['', 'All sources'], ...sources.map((s) => [s, s])], (v) => { vs.source = v; bump(); })),
    h('label.field', 'Average over', select('vs-avg-days', vs.avgDays, AVG_CHOICES.map((d) => [d, `${d} days`]),
      (v) => { vs.avgDays = Number(v); bump(); })),
    h('div.vs-right',
      prog ? h('span.vs-progress', { role: 'status' }, prog) : null,
      collectButton(c, reply),
      h('button.btn.sm.primary', {
        type: 'button', disabled: !reply,
        title: 'The days as CSV, one row per index day; every size is event_logsize',
        onclick: () => exportDaily(c, reply),
      }, 'Export CSV')));
}

function dailyView(c, picker) {
  if (unsupported) return [modeSeg(), needsNewer()];
  if (noStore) return [modeSeg(), noRecordKept()];
  const ent = daily.get(dkey(c));
  if (!ent) loadDaily(c);
  const reply = (ent && ent.reply) || lastDaily.get(c.id) || null;
  const out = [dailyToolbar(c, reply, picker)];
  if (reply) out.push(configErrorBanner(configErrorOf(reply)));
  if (ent && ent.error && !reply) return [...out, unreadable('The daily volume record', ent.error)];
  if (!reply) return [...out, h('div.tbl-empty', 'Reading the daily record…')];
  const st = reply.status || {};
  out.push(historyBanner(reply));
  if (st.lastError) out.push(h('div.banner.warn', h('div', h('div.ttl', 'The last collection did not finish'), h('div.mono', String(st.lastError)))));
  if (ent && ent.error) out.push(h('div.banner.err', h('div', h('div.ttl', 'Could not read the daily record'), h('div.mono', ent.error))));
  const rows = reply.days || [];
  if (!rows.length) {
    return [...out, empty('Nothing recorded yet for this cluster.', {
      detail: Math.max(Number(reply.skippedCount) || 0, (reply.skipped || []).length)
        ? `No index name fits the index pattern; ${num(Math.max(Number(reply.skippedCount) || 0, reply.skipped.length))} were skipped (for example ${(reply.skipped || []).slice(0, 3).join(', ')}).`
        : 'A collection fills this in: press Collect now.',
      actions: [h('button.btn.sm', { type: 'button', onclick: () => openVolumeFields('indexFormat') }, 'Config-Management › Reports')],
    })];
  }
  out.push(dailyCards(reply), dailyChart(reply), dailyTable(c, reply));
  return out;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const weekday = (ymd) => WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
/** "1–2 Nov" for a run of days in one month. */
const dayRange = (from, to) => (from === to ? shortDay(from) : `${Number(from.slice(8, 10))}–${shortDay(to)}`);

/** A tile's value: the figure, or "not measured" naming where to set the field. */
function tileValue(v, field) {
  return v === null ? h('button.linkish.vs-notm', { type: 'button', title: `Set the Event size field (${field}) in Config-Management › Reports`,
    onclick: () => openVolumeFields('eventSize') }, 'not measured') : bytes(v);
}

function dailyCards(reply) {
  const field = eventField(reply.settings);
  const today = utcDay();
  const y = eventYesterday(reply, { today });
  const avg = perDayEventBytes(reply, vs.avgDays, { today });
  const chg = eventVsAvgPct(reply, y.day, vs.avgDays, { today });
  const peak = eventPeak(reply, { today, from: addDays(today, -SHOWN_DAYS) });
  const month = eventMonthSoFar(reply, { today });
  return h('div.grid.c4.vs-cards',
    statTile(`Yesterday · ${shortDay(y.day)}`, tileValue(y.value, field),
      `${field}${y.docs !== null ? ` · ${num(y.docs)} docs` : ''}`),
    statTile(`${vs.avgDays}-day average`, tileValue(avg, field),
      chg === null ? 'no earlier day to compare'
        : h('span', h(`span${chg > 25 ? '.vs-high' : ''}`, signedPct(chg)), ` yesterday against the ${vs.avgDays} days before it`)),
    statTile('Peak day in period', peak ? bytes(peak.value) : tileValue(null, field),
      peak ? `${shortDay(peak.day)} · ${weekday(peak.day)}` : `last ${SHOWN_DAYS} days`),
    statTile('Month so far', month.days ? tileValue(month.value, field) : dash(),
      month.days ? `${dayRange(month.from, month.to)}${month.docs !== null ? ` · ${num(month.docs)} docs` : ''}` : 'no finished day this month yet'));
}

function dailyChart(reply) {
  const field = eventField(reply.settings);
  const today = utcDay();
  const from = addDays(today, -SHOWN_DAYS);
  const points = (reply.days || []).filter((d) => d.day >= from && d.day < today)
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((d) => ({ key: d.day, label: shortDay(d.day), value: eventBytesOf(d),
      avg: perDayEventBytes(reply, vs.avgDays, { today, before: d.day }), changePct: eventVsAvgPct(reply, d.day, vs.avgDays, { today }) }));
  return card('Log size per day', null,
    h('div',
      lineChart(points, { height: CHART_H, yLabel: field, avgLabel: `${vs.avgDays}-day average`, emptyText: `No finished day with ${field} recorded yet` }),
      h('div.legend.vs-legend',
        h('span', h('i.vs-sw-line'), field),
        h('span', h('i.vs-sw-avg'), `${vs.avgDays}-day average`))));
}

/** The Day by day columns (docs/VOLUME.md keys, which the core keeps for the shared layout). */
function dailyDefs(reply) {
  const s = (reply && reply.settings) || {};
  const first = (list, dflt) => (Array.isArray(list) && list.length ? list[0] : dflt);
  return [
    { key: 'day', label: 'Day', locked: true },
    { key: 'indices', label: 'Indices', num: true },
    { key: 'docs', label: 'Documents', num: true },
    { key: 'eventBytes', label: eventField(s), num: true },
    { key: 'changeVsAvg', label: `vs ${vs.avgDays}-day avg`, num: true },
    { key: 'topExtra', label: `Top ${(s.extra && s.extra.name) || 'ECS field'}`, hidden: true },
    { key: 'topSourceHost', label: `Top ${first(s.sourceHost, 'src_hostname')}`, hidden: true },
    { key: 'topForwarder', label: `Top ${first(s.forwarder, 'fwd_tag')}`, hidden: true },
    { key: 'topTag', label: `Top ${first(s.tag, 'tag1')}`, hidden: true },
    { key: 'topSourceIp', label: `Top ${first(s.sourceIp, 'src_ip')}`, hidden: true },
    { key: 'subBytes', label: 'Sub size', num: true, hidden: true },
    // Index store size belongs to Measure size (docs/REPORTS.md); kept only so a layout
    // that shows them still reads, and hidden by default.
    { key: 'priBytes', label: 'Index size (primary)', num: true, hidden: true },
    { key: 'totalBytes', label: 'Index size (total)', num: true, hidden: true },
  ];
}

const TOP_KEY = { topExtra: 'extra', topSourceHost: 'sourceHost', topForwarder: 'forwarder', topTag: 'tag', topSourceIp: 'sourceIp' };
/** "value · 41 %", or a dash where the core has none (under a source filter, say). */
function topCell(top, key) {
  const t = top && top[TOP_KEY[key]];
  if (!t || t.value === null || t.value === undefined) return dash();
  const share = typeof t.share === 'number' ? ` · ${Math.round(t.share * 100)} %` : '';
  return h('span.vs-top', { title: String(t.value) }, `${t.value}${share}`);
}

const sizeCell = (v, field) => (v === null || v === undefined ? notMeasured(field) : bytes(v));
/**
 * Index store size, or "not measured" in amber: since 0.3.53 a day whose indices are split
 * by the time field has no size per day (Elasticsearch reports size per index), and the
 * record says null. bytes(null) would print "0 B", which reads as a day that took nothing.
 */
export function indexSizeCell(v) {
  return typeof v === 'number' && Number.isFinite(v) ? bytes(v)
    : h('span.vs-notm', { title: 'Index size is not measured here: these indices are split into days by the time field, and Elasticsearch reports size per index.' }, 'not measured');
}
const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayLabel = (ymd) => `${DAY_NAME[new Date(`${ymd}T00:00:00Z`).getUTCDay()]} ${shortDay(ymd)}`;

export function dailyCellFor(reply) {
  const field = eventField(reply.settings);
  const today = utcDay();
  return (key, d) => {
    switch (key) {
      case 'day': return h('span', { title: d.day }, dayLabel(d.day), historyMark(d));
      case 'indices': return num(d.indices);
      case 'docs': return d.docs === null || d.docs === undefined ? h('span.muted', { title: 'This day has not been aggregated yet' }, 'not yet') : num(d.docs);
      case 'eventBytes': return sizeCell(eventBytesOf(d), field);
      case 'subBytes': return sizeCell(d.subBytes, 'Sub size');
      case 'priBytes': return indexSizeCell(d.priBytes);
      case 'totalBytes': return indexSizeCell(d.totalBytes);
      case 'changeVsAvg': {
        if (d.day === today) return dash();
        const p = eventVsAvgPct(reply, d.day, vs.avgDays, { today });
        return p === null ? dash() : h(`span${p > 25 ? '.vs-high' : ''}`, signedPct(p));
      }
      default: return key in TOP_KEY ? topCell(d.top, key) : '';
    }
  };
}

/** A day or month the history store supplied (docs/HISTORY.md): a small muted marker. */
const historyMark = (r) => (fromHistory(r) ? h('span.muted', { title: 'From the history store', style: { fontSize: '10.5px' } }, historyMarkText(r)) : null);
/** The history store was asked and could not be reached: said once, in amber; never zeros. */
const historyBanner = (reply) => {
  const t = historyLine(reply && reply.history);
  return t ? h('div.banner.warn.vs-history', h('div', t)) : null;
};

const STATUS_CLS = { ok: 'green', today: 'grey', warn: 'yellow', na: 'grey' };
function statusCell(d) {
  const s = dayStatus(d);
  return h(`span.pill.${STATUS_CLS[s.kind] || 'grey'}`, { title: s.title || null }, s.text);
}

function dailyTable(c, reply) {
  const defs = dailyDefs(reply);
  const today = utcDay();
  const from = addDays(today, -SHOWN_DAYS);
  const sort = tableSort('reports.daily', { initial: { key: 'day', dir: -1 }, onChange: bump });
  const sortCols = dailySortCols(reply, today);
  const rows = sort.apply([...(reply.days || [])].filter((d) => d.day >= from).sort((a, b) => (a.day < b.day ? 1 : -1)), sortCols);
  const layout = layoutFor('daily');
  const onChange = (next) => changeLayout('daily', defs, next);
  return card('Day by day', null,
    columnTable({ defs, layout, rows, cell: dailyCellFor(reply), canEdit: canSave(), onChange, sort, sortCols,
      after: [{ label: 'Status', cell: statusCell }],
      rowAttrs: (d) => (d.day === today ? { class: 'today' } : null) }),
    [columnsButton({ defs, layout, onChange, id: 'vs-cols-daily' })]);
}

/** What each Day by day column sorts on: the figure, not the text drawn (core/sort.js). */
function dailySortCols(reply, today) {
  const top = (k) => ({ type: 'text', value: (d) => (d.top && d.top[TOP_KEY[k]] ? d.top[TOP_KEY[k]].value : null) });
  return {
    day: { type: 'date', value: (d) => d.day },
    indices: { type: 'number', value: (d) => d.indices },
    docs: { type: 'number', value: (d) => d.docs },
    eventBytes: { type: 'bytes', value: (d) => eventBytesOf(d) },
    changeVsAvg: { type: 'percent', value: (d) => (d.day === today ? null : eventVsAvgPct(reply, d.day, vs.avgDays, { today })) },
    subBytes: { type: 'bytes', value: (d) => d.subBytes },
    priBytes: { type: 'bytes', value: (d) => d.priBytes },
    totalBytes: { type: 'bytes', value: (d) => d.totalBytes },
    ...Object.fromEntries(Object.keys(TOP_KEY).map((k) => [k, top(k)])),
  };
}

function exportDaily(c, reply) {
  const rows = reportDailyCsvRows(c.name, reply, vs.avgDays);
  download(`reports-daily-${c.name}-${utcDay()}.csv`, toCsv(rows, REPORT_DAILY_CSV), 'text/csv');
}

/* --------------------------------- monthly ---------------------------------- */

const mkey = (c) => `${c.id}|${MONTHS}`;

async function loadMonthly(c) {
  const key = mkey(c);
  if (monthly.has(key)) return;
  const ent = { loading: true, reply: null, error: null, peaks: null };
  monthly.set(key, ent);
  // The months (VOLUME_MONTHLY) and, for each month's heaviest day on event_logsize, the
  // record's days over the same months (VOLUME_DAILY, its widest window).
  const [res, days] = await Promise.all([
    volumeMonthly(c.id, { months: MONTHS }),
    volumeDaily(c.id, { days: 400, avgDays: 7 }).catch(() => null),
  ]);
  ent.loading = false;
  if (res.unsupported) { unsupported = true; bump(); return; }
  if (res.kind === 'no_store') { noStore = true; bump(); return; }
  if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else ent.reply = res;
  if (days && days.ok) ent.peaks = days;
  bump();
}

/** The months the view shows, oldest first; a month the core has no row for is a gap. */
function monthRows(reply) {
  const by = new Map(((reply && reply.months) || []).map((m) => [m.month, m]));
  const axis = lastMonths(MONTHS);
  for (const ym of by.keys()) if (!axis.includes(ym)) axis.push(ym);
  return axis.sort().map((ym) => by.get(ym) || { month: ym, daysWithData: 0 });
}

function monthlyToolbar(c, ent, picker) {
  return h('div.toolbar.vs-bar',
    modeSeg(),
    picker,
    h('div.vs-right',
      collectButton(c, null),
      h('button.btn.sm.primary', {
        type: 'button', disabled: !(ent && ent.reply),
        title: 'The months as CSV, one row per month; every size is event_logsize',
        onclick: () => exportMonthly(c, ent),
      }, 'Export CSV')));
}

function monthlyView(c, picker) {
  if (unsupported) return [modeSeg(), needsNewer()];
  if (noStore) return [modeSeg(), noRecordKept()];
  const ent = monthly.get(mkey(c));
  if (!ent) loadMonthly(c);
  const reply = ent && ent.reply;
  const out = [monthlyToolbar(c, ent, picker)];
  if (reply) out.push(configErrorBanner(configErrorOf(reply)));
  if (ent && ent.error) return [...out, unreadable('The monthly volume record', ent.error)];
  if (!reply) return [...out, h('div.tbl-empty', 'Reading the monthly record…')];
  const rows = monthRows(reply);
  const settings = reply.settings || {};
  out.push(historyBanner(reply));
  out.push(h('div.grid.c2.vs-split', monthlyTable(c, rows, settings, ent.peaks), breakdownCard(c, settings)));
  return out;
}

function monthlyDefs(settings) {
  const s = settings || {};
  const first = (list, dflt) => (Array.isArray(list) && list.length ? list[0] : dflt);
  return [
    { key: 'month', label: 'Month', locked: true },
    { key: 'daysWithData', label: 'Days', num: true },
    { key: 'docs', label: 'Documents', num: true },
    { key: 'eventBytes', label: eventField(s) },
    { key: 'peakDay', label: 'Peak day', num: true },
    { key: 'topExtra', label: `Top ${(s.extra && s.extra.name) || 'ECS field'}`, hidden: true },
    { key: 'topSourceHost', label: `Top ${first(s.sourceHost, 'src_hostname')}`, hidden: true },
    { key: 'topForwarder', label: `Top ${first(s.forwarder, 'fwd_tag')}`, hidden: true },
    { key: 'subBytes', label: 'Sub size', num: true, hidden: true },
    { key: 'from', label: 'From', hidden: true },
    { key: 'priBytes', label: 'Index size (primary)', num: true, hidden: true },
    { key: 'avgPerDay', label: 'Avg per day (size basis)', num: true, hidden: true },
  ];
}

function monthlyTable(c, rows, settings, peaks) {
  const defs = monthlyDefs(settings);
  const field = eventField(settings);
  const layout = layoutFor('monthly');
  const onChange = (next) => changeLayout('monthly', defs, next);
  const max = Math.max(0, ...rows.map((m) => (typeof m.eventBytes === 'number' ? m.eventBytes : 0)));
  const prevOf = new Map(rows.map((m, i) => [m.month, rows[i - 1] || null]));
  const cell = (key, m) => {
    const has = m.daysWithData > 0;
    if (key === 'month') return h('span', monthName(m.month), historyMark(m));
    if (key === 'daysWithData') {
      const all = daysInMonth(m.month);
      const short = has && (m.partial || m.daysWithData < all);
      return short ? h('span.vs-notm', { title: m.partial ? 'The month so far' : 'Days missing from the record' }, `${num(m.daysWithData)} of ${all}`) : num(m.daysWithData || 0);
    }
    if (!has) return dash();
    switch (key) {
      case 'docs': return m.docs === null || m.docs === undefined ? h('span.muted', 'not yet') : num(m.docs);
      case 'eventBytes': {
        if (typeof m.eventBytes !== 'number') return notMeasured(field);
        const w = max > 0 ? Math.max(2, Math.round((m.eventBytes / max) * 90)) : 0;
        return h('span.vs-mbar', h('i', { style: { width: `${w}px` } }), h('span', bytes(m.eventBytes)));
      }
      case 'peakDay': {
        const p = peaks ? monthEventPeak(peaks, m.month) : null;
        return p ? h('span', { title: `${shortDay(p.day)} · ${weekday(p.day)}` }, bytes(p.value)) : dash();
      }
      case 'subBytes': return sizeCell(m.subBytes, 'Sub size');
      case 'priBytes': return indexSizeCell(m.priBytes);
      case 'avgPerDay': return typeof m.avgPerDay === 'number' ? bytes(m.avgPerDay) : dash();
      case 'from': return m.keptDays && m.liveDays ? `${m.keptDays} kept, ${m.liveDays} live` : m.keptDays ? 'kept record' : 'live indices';
      default: return key in TOP_KEY ? topCell(m.top, key) : '';
    }
  };
  const vsPrev = (m) => {
    const r = monthVsPrevious(m, prevOf.get(m.month));
    if (r.pct === null) return r.why ? h('span.muted', r.why) : dash();
    return h(`span.${r.pct >= 0 ? 'vs-up' : 'vs-dn'}`, `${r.pct >= 0 ? '▲' : '▼'} ${Math.abs(r.pct).toFixed(1)} %`);
  };
  // A month with no day in the record has no figures: unknown, so it sorts last either way.
  const known = (f) => (m) => (m.daysWithData > 0 ? f(m) : null);
  const top = (k) => ({ type: 'text', value: known((m) => (m.top && m.top[TOP_KEY[k]] ? m.top[TOP_KEY[k]].value : null)) });
  const sortCols = {
    month: { type: 'text', value: (m) => m.month },
    daysWithData: { type: 'number', value: (m) => m.daysWithData || 0 },
    docs: { type: 'number', value: known((m) => m.docs) },
    eventBytes: { type: 'bytes', value: known((m) => m.eventBytes) },
    peakDay: { type: 'bytes', value: known((m) => { const p = peaks ? monthEventPeak(peaks, m.month) : null; return p ? p.value : null; }) },
    subBytes: { type: 'bytes', value: known((m) => m.subBytes) },
    priBytes: { type: 'bytes', value: known((m) => m.priBytes) },
    avgPerDay: { type: 'bytes', value: known((m) => m.avgPerDay) },
    from: { type: 'text', value: known((m) => (m.keptDays && m.liveDays ? 'kept and live' : m.keptDays ? 'kept record' : 'live indices')) },
    ...Object.fromEntries(['topExtra', 'topSourceHost', 'topForwarder'].map((k) => [k, top(k)])),
  };
  const sort = tableSort('reports.monthly', { initial: { key: 'month', dir: -1 }, onChange: bump });
  return card('Month by month', null,
    columnTable({ defs, layout, rows: sort.apply([...rows].reverse(), sortCols), cell, canEdit: canSave(), onChange, sort, sortCols,
      after: [{ label: 'vs previous', num: true, cell: vsPrev }] }),
    [columnsButton({ defs, layout, onChange, id: 'vs-cols-monthly' })]);
}

function exportMonthly(c, ent) {
  const rows = reportMonthlyCsvRows(c.name, (ent && ent.reply && ent.reply.months) || [], ent && ent.peaks);
  download(`reports-monthly-${c.name}-${utcDay()}.csv`, toCsv(rows, REPORT_MONTHLY_CSV), 'text/csv');
}

/* -------------------------------- breakdown --------------------------------- */

/** The fields a breakdown can be by, named after the settings in use (docs/VOLUME.md keys). */
function fieldChoices(settings) {
  const s = settings || {};
  const names = (list, dflt) => (Array.isArray(list) && list.length ? list.slice(0, 2).join(' / ') : dflt);
  return [
    ['sourceHost', `Source host (${names(s.sourceHost, 'src_hostname')})`],
    ['tag', `Tag (${names(s.tag, 'tag1')})`],
    ['forwarder', `Forwarder (${names(s.forwarder, 'fwd_tag / fwdtag')})`],
    ['sourceIp', `Source IP (${names(s.sourceIp, 'src_ip')})`],
    ['extra', (s.extra && s.extra.name) || 'Dataset'],
  ];
}
const NOUN = { sourceHost: 'hosts', tag: 'tags', forwarder: 'forwarders', sourceIp: 'addresses', extra: 'values' };

const bkey = (c, p) => `${c.id}|${vs.bd.field}|${p.from}|${p.to}|${vs.bd.top}`;
function periodNow() {
  const all = breakdownPeriods();
  return all.find((p) => p.id === vs.bd.period) || all[0];
}

async function loadBreakdown(c, p) {
  const key = bkey(c, p);
  if (breakdowns.has(key)) return;
  const ent = { loading: true, reply: null, error: null };
  breakdowns.set(key, ent);
  const res = await volumeBreakdown(c.id, { field: vs.bd.field, from: p.from, to: p.to, top: vs.bd.top });
  ent.loading = false;
  if (res.unsupported) { unsupported = true; bump(); return; }
  if (res.kind === 'no_store') { noStore = true; bump(); return; }
  if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else ent.reply = res;
  bump();
}

function breakdownCard(c, settings) {
  const p = periodNow();
  const ent = breakdowns.get(bkey(c, p));
  if (!ent) loadBreakdown(c, p);
  const reply = ent && ent.reply;
  const set = (k) => (v) => { vs.bd[k] = k === 'top' ? Number(v) : v; bump(); };
  const field = eventField(settings);
  const days = Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86400000) + 1;

  const controls = h('div.toolbar.vs-bar',
    h('label.field', 'By', select('vs-bd-field', vs.bd.field, fieldChoices(settings), set('field'))),
    h('label.field', 'Period', select('vs-bd-period', p.id, breakdownPeriods().map((x) => [x.id, x.label]), set('period'))),
    h('label.field', 'Top', select('vs-bd-top', vs.bd.top, TOP_CHOICES.map((n) => [n, String(n)]), set('top'))),
    h('div.vs-right',
      h('button.btn.sm', {
        type: 'button', disabled: !reply,
        title: 'The breakdown rows as CSV',
        onclick: () => download(`reports-breakdown-${c.name}-${vs.bd.field}-${p.from}-${p.to}.csv`,
          toCsv(breakdownCsvRows(c.name, reply, p), BREAKDOWN_CSV), 'text/csv'),
      }, 'Export CSV')));

  let body;
  if (ent && ent.error) body = unreadable('The breakdown', ent.error);
  else if (!reply) body = h('div.tbl-empty', 'Reading the breakdown…');
  else if (reply.error) body = empty('This field cannot be broken down.', { detail: String(reply.error),
    actions: [h('button.btn.sm', { type: 'button', onclick: () => openVolumeFields(vs.bd.field) }, 'Config-Management › Reports')] });
  else {
    const shares = breakdownEventShares(reply);
    const noun = NOUN[vs.bd.field] || 'values';
    const resolved = reply.resolved || vs.bd.field;
    const items = shares.map(({ row: r, value, share }) => {
      const missing = r.kind === 'missing' || r.missing;
      const other = r.kind === 'other' || r.other;
      const n = Number(r.count ?? r.values ?? r.valueCount);
      const label = missing ? `no ${resolved}` : other ? (Number.isFinite(n) && n > 0 ? `${num(n)} other ${noun}` : `all other ${noun}`) : breakdownLabel(r);
      return h(`div.vs-hb${missing ? '.missing' : other ? '.other' : ''}`,
        h('span.nm', { title: label }, label),
        h('span.vs-share-bar', h('i', { style: { width: `${share === null ? 0 : Math.max(1, Math.min(100, share))}%` } })),
        h('span.n', value === null ? notMeasured(field) : bytes(value)),
        h('span.p', share === null ? '—' : `${Math.round(share)} %`));
    });
    body = items.length ? h('div.vs-hbars', ...items) : h('div.tbl-empty', 'No value recorded in this period');
  }
  return card('Breakdown', `${p.label} · ${days} day${days === 1 ? '' : 's'}`, h('div', controls, body));
}
