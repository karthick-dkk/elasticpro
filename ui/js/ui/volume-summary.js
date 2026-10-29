/**
 * Indices › Summary: how much one cluster took per day and per month (0.3.45).
 *
 * Daily is the record the core keeps — a row per index day, the cards above it and the
 * line through it. Monthly is the same record summed by month, with a breakdown by field.
 * Every figure on here is the core's (docs/VOLUME.md); this file lays them out and hands
 * them to a CSV, and works none of them out again. Where the core says null the page says
 * "not measured", in amber, and names the setting that would measure it.
 *
 * The columns of both tables are lib/columns.js, and their layout is shared on the
 * server: an operator arranges them once for everybody.
 */

import { h } from '../lib/dom.js';
import { bytes, num, toCsv, download } from '../lib/fmt.js';
import { lineChart, signedPct } from '../lib/charts.js';
import { columnsButton, columnTable, sanitizeLayout } from '../lib/columns.js';
import { state } from '../core/state.js';
import { navigateTo } from '../core/intent.js';
import { card, statTile, table, empty, unreadable, configErrorBanner } from '../pages/common.js';
import { toast } from './menu.js';
import { reportJobsMount, reportPanel, setReportPanelOpen } from './report-jobs.js';
import { configErrorOf,
  volumeDaily, volumeMonthly, volumeBreakdown, volumeRun, volumeLayoutGet, volumeLayoutSet, isHosted,
  NEEDS_VERSION, collectDue, hhmm, utcDay, basisOf, BASIS_LABEL, BASIS_KEY, monthValue, fromText, monthName,
  lastMonths, breakdownPeriods, breakdownLabel, peakOf, dailyCsvRows, monthlyCsvRows, breakdownCsvRows,
  DAILY_CSV, MONTHLY_CSV, BREAKDOWN_CSV,
} from '../core/volume-daily.js';

/** While a collection runs the record is asked for again this often, for at most this long. */
const POLL_MS = 3000;
const POLL_LIMIT_MS = 5 * 60 * 1000;

const DAY_CHOICES = [14, 30, 60, 90];
const AVG_CHOICES = [3, 7, 15, 30, 60, 180];
const MONTH_CHOICES = [13, 6, 3];
const TOP_CHOICES = [25, 12, 50];
/** The graphs' height in viewBox units (1000 wide): short, so the table starts on the first screen. */
const CHART_H = 140;

const vs = {
  mode: 'daily', days: 30, source: '', avgDays: 7, months: 13,
  bd: { field: 'sourceHost', period: 'month', top: 25 },
  rev: 0,
};
/** Replies by request, so changing a choice and changing it back costs nothing. */
const daily = new Map();
const monthly = new Map();
const breakdowns = new Map();
/** The last daily reply per cluster: drawn while a new choice loads, so nothing jumps. */
const lastDaily = new Map();
/** Polls in flight, per cluster: { until, timer }. Every one ends by itself. */
const polls = new Map();
/** Desktop asks for a run once per cluster per session, on opening Summary. */
const autoAsked = new Set();
/** The shared column layouts, and whether this caller may change them. */
const layouts = { state: 'unknown', daily: null, monthly: null };
let unsupported = false;
let redrawPage = () => {};
let built = { sig: null, node: null };

/**
 * Forget every answer, but keep the choices. Called when the Indices page opens, so each
 * visit reads the record as it is now — and a core upgraded since the last visit is asked
 * again rather than still taken for one without a daily record.
 */
export function resetVolumeSummary() {
  for (const p of polls.values()) if (p.timer) clearTimeout(p.timer);
  for (const m of [daily, monthly, breakdowns, lastDaily, polls]) m.clear();
  Object.assign(layouts, { state: 'unknown', daily: null, monthly: null });
  unsupported = false;
  built = { sig: null, node: null };
  // Indices is an evidence page: the Generate report panel starts collapsed on every visit
  // (the pill's way in, showReportJobs, opens it after this).
  setReportPanelOpen(false);
  vs.rev++;
}

const bump = () => { vs.rev++; redrawPage(); };

/**
 * Arrive on Monthly with the report panel open: the top-bar pill's way in (the Indices page
 * takes the hint, core/focus.js). The panel keeps its own state; only the view changes.
 */
export function showReportJobs() {
  vs.mode = 'monthly';
  setReportPanelOpen(true);
  vs.rev++;
}
const alive = () => !!(built.node && built.node.isConnected);

/**
 * The Summary tab for one cluster.
 *
 * Built once per change of its own state and kept otherwise: the Indices page redraws on
 * every push from the core, and rebuilding this each time would close a header menu or a
 * name being edited under the operator's hands.
 */
export function volumeSummary(c, { redraw }) {
  redrawPage = redraw || (() => {});
  if (layouts.state === 'unknown') loadLayouts();
  const sig = `${c.id}|${vs.rev}`;
  if (built.sig === sig && built.node) return built.node;
  const node = h('div.vs', vs.mode === 'daily' ? dailyView(c) : monthlyView(c));
  built = { sig, node };
  return node;
}

function modeSeg() {
  const b = (id, label, title) => h('button.btn.sm', {
    type: 'button', 'aria-pressed': vs.mode === id ? 'true' : 'false', title,
    onclick: () => { if (vs.mode !== id) { vs.mode = id; bump(); } },
  }, label);
  return h('div.seg', { role: 'group', 'aria-label': 'Summary view' },
    b('daily', 'Daily', 'A row per index day, with the average and the change'),
    b('monthly', 'Monthly', 'A row per month, and a breakdown by field'));
}

function select(id, value, options, onChange) {
  const s = h(`select#${id}`, { onchange: (e) => onChange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: String(v) }, label)));
  s.value = String(value);
  return s;
}

function needsNewer() {
  return empty('This server does not keep a daily volume record yet.', {
    detail: `Per day and per month volume needs ElasticPro ${NEEDS_VERSION} or later on the server.`,
  });
}

/** "not measured", in amber, with what would measure it. */
function notMeasured(what) {
  return h('span.vs-notm', { title: `${what} is not measured: no numeric field for it in the mapping. Set it in Config › Volume fields.` }, 'not measured');
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

const dkey = (c) => `${c.id}|${vs.days}|${vs.avgDays}|${vs.source}`;

async function loadDaily(c, force) {
  const key = dkey(c);
  const had = daily.get(key);
  if (!force && had && (had.loading || had.reply || had.error)) return had;
  // No redraw here: this is called while the view is being drawn, and that draw already
  // shows the loading state. The answer redraws.
  const ent = { loading: true, reply: had && had.reply, error: null };
  daily.set(key, ent);
  const res = await volumeDaily(c.id, { days: vs.days, avgDays: vs.avgDays, source: vs.source });
  ent.loading = false;
  if (res.unsupported) { unsupported = true; bump(); return ent; }
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
  if (!res.ok) {
    // config_unreadable: the core's message is the whole answer.
    if (!auto) toast(res.kind === 'config_unreadable' ? res.message : `Could not start a collection: ${res.message || res.kind}`, 'err', 6000);
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

function dailyToolbar(c, reply) {
  const st = reply && reply.status;
  const polling = polls.has(c.id);
  const sources = (reply && reply.sources) || [];
  const prog = progressText(st, polling);
  return h('div.toolbar.vs-bar',
    modeSeg(),
    h('label.field', 'Days', select('vs-days', vs.days, DAY_CHOICES.map((d) => [d, `${d} days`]),
      (v) => { vs.days = Number(v); bump(); })),
    h('label.field', 'Source', select('vs-source', vs.source,
      [['', 'All sources'], ...sources.map((s) => [s, s])], (v) => { vs.source = v; bump(); })),
    h('div.vs-right',
      prog ? h('span.vs-progress', { role: 'status' }, prog) : null,
      h('button.btn.sm', {
        type: 'button', disabled: polling || unsupported,
        title: 'Collect this cluster\'s daily record now',
        onclick: () => refreshNow(c),
      }, '↻ Refresh now'),
      h('button.btn.sm.primary', {
        type: 'button', disabled: !reply,
        title: 'The daily rows as CSV, one row per index day',
        onclick: () => exportDaily(c, reply),
      }, 'Export CSV')));
}

function dailyView(c) {
  if (unsupported) return [modeSeg(), needsNewer()];
  const ent = daily.get(dkey(c));
  if (!ent) loadDaily(c);
  const reply = (ent && ent.reply) || lastDaily.get(c.id) || null;
  const out = [dailyToolbar(c, reply)];
  if (reply) out.push(configErrorBanner(configErrorOf(reply)));
  if (ent && ent.error && !reply) return [...out, unreadable('The daily volume record', ent.error)];
  if (!reply) return [...out, h('div.tbl-empty', 'Reading the daily record…')];
  const st = reply.status || {};
  if (st.lastError) out.push(h('div.banner.warn', h('div', h('div.ttl', 'The last collection did not finish'), h('div.mono', String(st.lastError)))));
  if (ent && ent.error) out.push(h('div.banner.err', h('div', h('div.ttl', 'Could not read the daily record'), h('div.mono', ent.error))));
  const rows = reply.days || [];
  if (!rows.length) {
    return [...out, empty('Nothing recorded yet for this cluster.', {
      detail: Math.max(Number(reply.skippedCount) || 0, (reply.skipped || []).length)
        ? `No index name fits the index format; ${num(Math.max(Number(reply.skippedCount) || 0, reply.skipped.length))} were skipped (for example ${(reply.skipped || []).slice(0, 3).join(', ')}).`
        : 'A collection fills this in: press Refresh now.',
      actions: [h('button.btn.sm', { type: 'button', onclick: () => openVolumeFields('indexFormat') }, 'Config › Volume fields')],
    })];
  }
  out.push(dailyCards(reply), dailyChart(reply), dailyTable(c, reply));
  return out;
}

/** The card value the core sent, under whichever name it used for it. Picked, not computed. */
const cardValue = (x) => (x && typeof x === 'object' ? [x.value, x.basis, x.bytes].find((v) => typeof v === 'number') ?? null
  : typeof x === 'number' ? x : null);

function avgSeg() {
  return h('div.seg.vs-avg', { role: 'group', 'aria-label': 'Days in the average' },
    ...AVG_CHOICES.map((d) => h('button.btn.sm', {
      type: 'button', 'aria-pressed': vs.avgDays === d ? 'true' : 'false',
      title: `Average over the last ${d} finished days`,
      onclick: () => { if (vs.avgDays !== d) { vs.avgDays = d; bump(); } },
    }, `${d}D`)));
}

function dailyCards(reply) {
  const cards = reply.cards || {};
  const basis = basisOf(reply.settings);
  const word = { primary: 'primary', total: 'total', eventSize: 'event bytes' }[basis];
  const y = cards.yesterday || null;
  const yv = cardValue(y);
  const chg = y && typeof y.changeVsAvgPct === 'number' ? y.changeVsAvgPct : null;
  const avg = cards.average || cards.avgPerDay || null;
  const month = cards.monthSoFar || cards.month || null;
  const ev = cards.eventBytes30 || cards.eventBytes || null;
  const evv = cardValue(ev);
  return h('div.grid.c4.vs-cards',
    statTile(`Yesterday · ${word}`, yv === null ? dash() : bytes(yv),
      chg === null ? 'no earlier day to compare'
        : h('span', h(`span${chg > 25 ? '.vs-high' : ''}`, signedPct(chg)), ` vs ${vs.avgDays}-day avg`)),
    h('div.stat',
      h('div.k', 'Average per day'),
      h('div.v', cardValue(avg) === null ? dash() : bytes(cardValue(avg))),
      avgSeg()),
    statTile('This month so far', cardValue(month) === null ? dash() : bytes(cardValue(month)),
      month && hhmm(month.asOf) ? `as of ${hhmm(month.asOf)}` : null),
    statTile('Event bytes · 30 days', evv === null
      ? h('button.linkish.vs-notm', { type: 'button', title: 'Set the Event size field in Config › Volume fields',
          onclick: () => openVolumeFields('eventSize') }, 'not measured')
      : bytes(evv), evv === null ? 'no Event size field in the mapping' : 'measured, finished days'));
}

/**
 * Days to plot, oldest first: only today is left out (it is still filling up and would read
 * as a drop). A past day the core could not finish is plotted when it has a figure.
 */
function finishedDays(reply) {
  const basis = basisOf(reply.settings);
  return (reply.days || [])
    .filter((d) => d.day < utcDay() && (d.final !== false || dayBasis(d, basis) !== null))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}
const shortDay = (ymd) => {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  return m ? `${Number(m[2])} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[1]) - 1]}` : String(ymd || '');
};
const dayBasis = (d, basis) => (typeof d.basis === 'number' ? d.basis : (typeof d[BASIS_KEY[basis]] === 'number' ? d[BASIS_KEY[basis]] : null));

function dailyChart(reply) {
  const basis = basisOf(reply.settings);
  const label = BASIS_LABEL[basis];
  const points = finishedDays(reply).map((d) => ({
    key: d.day, label: shortDay(d.day), value: dayBasis(d, basis),
    avg: typeof d.avg === 'number' ? d.avg : null, changePct: typeof d.changeVsAvgPct === 'number' ? d.changeVsAvgPct : null,
  }));
  const st = reply.status || {};
  return card(`${label} per day · last ${vs.days} days`, st.lastRunAt ? `collected ${hhmm(st.lastRunAt)}` : null,
    h('div',
      lineChart(points, { height: CHART_H, yLabel: label, avgLabel: `${vs.avgDays}-day average`, emptyText: 'No finished day recorded yet' }),
      h('div.legend.vs-legend',
        h('span', h('i.vs-sw-line'), `${label} per day`),
        h('span', h('i.vs-sw-avg'), 'Average',
          select('vs-avg-days', vs.avgDays, AVG_CHOICES.map((d) => [d, `${d}D`]), (v) => { vs.avgDays = Number(v); bump(); })))));
}

/** The daily table's columns (docs/VOLUME.md keys). Names follow the settings in use. */
function dailyDefs(reply) {
  const s = (reply && reply.settings) || {};
  const first = (list, dflt) => (Array.isArray(list) && list.length ? list[0] : dflt);
  return [
    { key: 'day', label: 'Index day', locked: true },
    { key: 'indices', label: 'Indices', num: true },
    { key: 'docs', label: 'Documents', num: true },
    { key: 'priBytes', label: 'Primary size', num: true },
    { key: 'topExtra', label: `Top ${(s.extra && s.extra.name) || 'ECS field'}` },
    { key: 'eventBytes', label: 'Event bytes', num: true },
    { key: 'subBytes', label: 'Sub size', num: true },
    { key: 'changeVsAvg', label: `vs ${vs.avgDays}-day avg`, num: true },
    { key: 'topSourceHost', label: `Top ${first(s.sourceHost, 'src_hostname')}` },
    { key: 'topForwarder', label: `Top ${first(s.forwarder, 'fwd_tag')}` },
    { key: 'totalBytes', label: 'Total size', num: true, hidden: true },
    { key: 'topTag', label: `Top ${first(s.tag, 'tag1')}`, hidden: true },
    { key: 'topSourceIp', label: `Top ${first(s.sourceIp, 'src_ip')}`, hidden: true },
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

const sizeCell = (v, what) => (v === null || v === undefined ? notMeasured(what) : bytes(v));

function dailyCell(key, d) {
  if (d.__total) {
    if (key === 'day') return h('b', 'Total');
    if (key in TOP_KEY || key === 'changeVsAvg') return '';
  }
  switch (key) {
    case 'day':
      if (d.day === utcDay()) return h('span', d.day, h('span.muted', ` · as of ${hhmm(d.totalsAt || d.aggregatedAt) || 'now'}`));
      if (d.final === false) return h('span', d.day, h('span.muted', ` · ${d.error ? String(d.error) : 'not aggregated yet'}`));
      return d.day;
    case 'indices': return num(d.indices);
    case 'docs': return d.docs === null || d.docs === undefined ? h('span.muted', { title: 'This day has not been aggregated yet' }, 'not yet') : num(d.docs);
    case 'priBytes': return bytes(d.priBytes);
    case 'totalBytes': return bytes(d.totalBytes);
    case 'eventBytes': return sizeCell(d.eventBytes, 'Event bytes');
    case 'subBytes': return sizeCell(d.subBytes, 'Sub size');
    case 'changeVsAvg': return typeof d.changeVsAvgPct === 'number'
      ? h(`span${d.changeVsAvgPct > 25 ? '.vs-high' : ''}`, signedPct(d.changeVsAvgPct)) : dash();
    default: return key in TOP_KEY ? topCell(d.top, key) : '';
  }
}

function dailyTable(c, reply) {
  const defs = dailyDefs(reply);
  const rows = [...(reply.days || [])].sort((a, b) => (a.day < b.day ? 1 : -1));
  const layout = layoutFor('daily');
  const onChange = (next) => changeLayout('daily', defs, next);
  // The totals come from the core with the rows; a page that summed them would be a
  // second definition of a day's size.
  const foot = reply.totals ? [{ ...reply.totals, __total: true }] : [];
  const unmeasured = rows.some((d) => d.eventBytes === null || d.eventBytes === undefined);
  return h('div', { style: { marginTop: '10px' } },
    card('Daily volume', `newest first · ${num(rows.length)} days`,
      h('div',
        columnTable({ defs, layout, rows, cell: dailyCell, foot, canEdit: canSave(), onChange,
          rowAttrs: (d) => (d.final === false ? { class: 'today' } : null) }),
        unmeasured
          ? h('div.vs-note',
              'Event bytes "not measured": the mapping has no numeric Event size field. Set it in ',
              h('button.linkish', { type: 'button', onclick: () => openVolumeFields('eventSize') }, 'Config › Volume fields › Event size'),
              '. It is never shown as 0.')
          : null),
      [columnsButton({ defs, layout, onChange, id: 'vs-cols-daily' })]));
}

function exportDaily(c, reply) {
  const rows = dailyCsvRows(c.name, reply, vs.avgDays);
  download(`volume-daily-${c.name}-${utcDay()}.csv`, toCsv(rows, DAILY_CSV), 'text/csv');
}

/* --------------------------------- monthly ---------------------------------- */

const mkey = (c) => `${c.id}|${vs.months}`;

async function loadMonthly(c) {
  const key = mkey(c);
  if (monthly.has(key)) return;
  const ent = { loading: true, reply: null, error: null };
  monthly.set(key, ent);
  const res = await volumeMonthly(c.id, { months: vs.months });
  ent.loading = false;
  if (res.unsupported) { unsupported = true; bump(); return; }
  if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else ent.reply = res;
  bump();
}

/** The months the view shows, oldest first; a month the core has no row for is a gap. */
function monthRows(reply) {
  const by = new Map(((reply && reply.months) || []).map((m) => [m.month, m]));
  const axis = lastMonths(vs.months);
  for (const ym of by.keys()) if (!axis.includes(ym)) axis.push(ym);
  return axis.sort().map((ym) => by.get(ym) || { month: ym, daysWithData: 0 });
}

function monthlyToolbar(c, reply) {
  return h('div.toolbar.vs-bar',
    modeSeg(),
    h('label.field', 'Months', select('vs-months', vs.months, MONTH_CHOICES.map((m) => [m, `${m} months`]),
      (v) => { vs.months = Number(v); bump(); })),
    h('div.vs-right',
      // "Generate report" (ui/report-jobs.js): the same element on every rebuild.
      reportJobsMount(),
      h('button.btn.sm.primary', {
        type: 'button', disabled: !reply,
        title: 'The monthly rows as CSV, one row per month',
        onclick: () => exportMonthly(c, reply),
      }, 'Export CSV')));
}

function monthlyView(c) {
  if (unsupported) return [modeSeg(), needsNewer()];
  const ent = monthly.get(mkey(c));
  if (!ent) loadMonthly(c);
  const reply = ent && ent.reply;
  // The report panel sits under the toolbar whatever the record says: jobs are followed
  // even while this cluster's months are still loading or could not be read.
  const out = [monthlyToolbar(c, reply), reportPanel(c)];
  if (reply) out.push(configErrorBanner(configErrorOf(reply)));
  if (ent && ent.error) return [...out, unreadable('The monthly volume record', ent.error)];
  if (!reply) return [...out, h('div.tbl-empty', 'Reading the monthly record…')];
  const rows = monthRows(reply);
  const settings = reply.settings || {};
  out.push(monthlyChart(reply, rows, settings), monthlyTable(c, rows, settings), breakdownCard(c, settings));
  return out;
}

function monthlyChart(reply, rows, settings) {
  // The core names the basis on each month row (`basis`); the number is `basisBytes`.
  const named = (rows.find((m) => BASIS_LABEL[m.basis]) || {}).basis;
  const label = BASIS_LABEL[named || basisOf(settings)];
  const avg = typeof reply.avgPerMonth === 'number' ? reply.avgPerMonth : null;
  const points = rows.map((m) => ({ key: m.month, label: monthName(m.month), value: monthValue(m), avg }));
  const withData = rows.filter((m) => m.daysWithData > 0);
  const first = withData[0];
  const cur = rows.find((m) => m.partial) || null;
  const notes = [];
  if (first && first !== cur && first.daysWithData < daysInMonth(first.month)) {
    notes.push(`${monthName(first.month)} holds ${num(first.daysWithData)} of ${daysInMonth(first.month)} days: the record began during it.`);
  }
  if (cur) notes.push(`${monthName(cur.month)} is so far.`);
  return card(`${label} per month · last ${vs.months} months`, null,
    h('div',
      lineChart(points, { height: CHART_H, yLabel: label, avgLabel: 'Average per month', emptyText: 'No month recorded yet', formatX: (p) => p.label }),
      h('div.legend.vs-legend',
        h('span', h('i.vs-sw-line'), `${label} per month`),
        avg !== null ? h('span', h('i.vs-sw-avg'), 'Average') : null,
        notes.length ? h('span.muted', notes.join(' ')) : null)));
}

/** Calendar days in "YYYY-MM". */
function daysInMonth(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate() : 31;
}

function monthlyDefs(settings) {
  const s = settings || {};
  const first = (list, dflt) => (Array.isArray(list) && list.length ? list[0] : dflt);
  return [
    { key: 'month', label: 'Month', locked: true },
    { key: 'daysWithData', label: 'Days with data', num: true },
    { key: 'priBytes', label: 'Primary size', num: true },
    { key: 'topExtra', label: `Top ${(s.extra && s.extra.name) || 'ECS field'}` },
    { key: 'avgPerDay', label: 'Avg per day', num: true },
    { key: 'peakDay', label: 'Peak day' },
    { key: 'docs', label: 'Documents', num: true },
    { key: 'eventBytes', label: 'Event bytes', num: true },
    { key: 'subBytes', label: 'Sub size', num: true },
    { key: 'topSourceHost', label: `Top ${first(s.sourceHost, 'src_hostname')}` },
    { key: 'topForwarder', label: `Top ${first(s.forwarder, 'fwd_tag')}` },
    { key: 'from', label: 'From' },
  ];
}

function monthlyTable(c, rows, settings) {
  const defs = monthlyDefs(settings);
  const firstWith = (rows.find((m) => m.daysWithData > 0) || {}).month || null;
  const layout = layoutFor('monthly');
  const onChange = (next) => changeLayout('monthly', defs, next);
  const cell = (key, m) => {
    const has = m.daysWithData > 0;
    if (key === 'month') return h('span', monthName(m.month), m.partial ? h('span.muted', ' · so far') : null);
    if (key === 'from') return fromText(m, firstWith);
    if (key === 'daysWithData') return num(m.daysWithData || 0);
    if (!has) return dash();
    switch (key) {
      case 'priBytes': return bytes(m.priBytes);
      case 'avgPerDay': return typeof m.avgPerDay === 'number' ? bytes(m.avgPerDay) : dash();
      case 'peakDay': { const p = peakOf(m); return p && p.day ? `${shortDay(p.day)}${p.bytes !== null ? ` · ${bytes(p.bytes)}` : ''}` : dash(); }
      case 'docs': return m.docs === null || m.docs === undefined ? h('span.muted', 'not yet') : num(m.docs);
      case 'eventBytes': return sizeCell(m.eventBytes, 'Event bytes');
      case 'subBytes': return sizeCell(m.subBytes, 'Sub size');
      default: return key in TOP_KEY ? topCell(m.top, key) : '';
    }
  };
  return h('div', { style: { marginTop: '10px' } },
    card('Monthly volume', 'a month is the sum of its days · days whose indices were deleted come from the kept daily record',
      columnTable({ defs, layout, rows: [...rows].reverse(), cell, canEdit: canSave(), onChange }),
      [columnsButton({ defs, layout, onChange, id: 'vs-cols-monthly' })]));
}

function exportMonthly(c, reply) {
  download(`volume-monthly-${c.name}-${utcDay()}.csv`, toCsv(monthlyCsvRows(c.name, (reply && reply.months) || []), MONTHLY_CSV), 'text/csv');
}

/* -------------------------------- breakdown --------------------------------- */

/** The fields a breakdown can be by, named after the settings in use (docs/VOLUME.md keys). */
function fieldChoices(settings) {
  const s = settings || {};
  const names = (list, dflt) => (Array.isArray(list) && list.length ? list.slice(0, 2).join(' / ') : dflt);
  return [
    ['sourceHost', names(s.sourceHost, 'src_hostname')],
    ['tag', names(s.tag, 'tag1')],
    ['forwarder', names(s.forwarder, 'fwd_tag / fwdtag')],
    ['sourceIp', names(s.sourceIp, 'src_ip')],
    ['extra', (s.extra && s.extra.name) || 'Dataset'],
  ];
}

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
  if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else ent.reply = res;
  bump();
}

const EST_RULE = 'For each day: (documents with this value ÷ all documents that day) × that day\'s primary size, summed over the period. An estimate: Elasticsearch does not store size per value.';

function breakdownCard(c, settings) {
  const p = periodNow();
  const ent = breakdowns.get(bkey(c, p));
  if (!ent) loadBreakdown(c, p);
  const reply = ent && ent.reply;
  const set = (k) => (v) => { vs.bd[k] = k === 'top' ? Number(v) : v; bump(); };
  const resolved = reply ? (reply.resolved ? `field resolved: ${reply.resolved}` : 'field not found in the mapping') : '';

  const controls = h('div.toolbar.vs-bar',
    h('label.field', 'By', select('vs-bd-field', vs.bd.field, fieldChoices(settings), set('field'))),
    h('label.field', 'Period', select('vs-bd-period', p.id, breakdownPeriods().map((x) => [x.id, x.label]), set('period'))),
    h('label.field', 'Top', select('vs-bd-top', vs.bd.top, TOP_CHOICES.map((n) => [n, String(n)]), set('top'))),
    h('span.muted.vs-resolved', resolved),
    h('div.vs-right',
      h('button.btn.sm', {
        type: 'button', disabled: !reply,
        title: 'The breakdown rows as CSV',
        onclick: () => download(`volume-breakdown-${c.name}-${vs.bd.field}-${p.from}-${p.to}.csv`,
          toCsv(breakdownCsvRows(c.name, reply, p), BREAKDOWN_CSV), 'text/csv'),
      }, 'Export CSV')));

  let body;
  if (ent && ent.error) body = unreadable('The breakdown', ent.error);
  else if (!reply) body = h('div.tbl-empty', 'Reading the breakdown…');
  else if (reply.error) body = empty('This field cannot be broken down.', { detail: String(reply.error),
    actions: [h('button.btn.sm', { type: 'button', onclick: () => openVolumeFields(vs.bd.field) }, 'Config › Volume fields')] });
  else {
    const trs = (reply.rows || []).map((r) => {
      const share = typeof r.sharePct === 'number' ? r.sharePct : null;
      const special = r.kind === 'missing' || r.kind === 'other' || r.missing || r.other;
      return h(`tr${special ? '.vs-special' : ''}`,
        h('td', h('span.vs-top', { title: breakdownLabel(r) }, breakdownLabel(r))),
        h('td.num', r.docs === null || r.docs === undefined ? dash() : num(r.docs)),
        h('td.num', r.eventBytes === null || r.eventBytes === undefined ? notMeasured('Event bytes') : bytes(r.eventBytes)),
        h('td.num', { title: EST_RULE }, typeof r.estPriBytes === 'number' ? bytes(r.estPriBytes) : dash()),
        h('td', share === null ? dash() : h('span.vs-share',
          h('span.vs-share-bar', h('i', { style: { width: `${Math.max(1, Math.min(100, share))}%` } })),
          h('span.vs-share-n', `${share.toFixed(1)} %`))),
        h('td.num', r.daysSeen === null || r.daysSeen === undefined ? dash() : num(r.daysSeen)));
    });
    body = h('div',
      table(['Value', { label: 'Documents', num: true }, { label: 'Event bytes · measured', num: true },
        { label: 'Primary size · est.', num: true }, 'Share of primary size', { label: 'Days seen', num: true }],
      trs, { emptyText: 'No value recorded in this period' }),
      h('div.muted.vs-foot', `Primary size · est.: ${EST_RULE}`));
  }
  return h('div', { style: { marginTop: '10px' } },
    card('Breakdown', `${p.label} · ${p.from} to ${p.to}`, h('div', controls, body)));
}
