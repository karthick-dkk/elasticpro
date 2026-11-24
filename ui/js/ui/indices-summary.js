/**
 * Indices › Summary (0.3.71; design "Indices › Summary", approved 2026-11-17): how much the
 * cluster's indices took per day — five tiles, the size per day as columns or rows, and the
 * same days by tag1 value.
 *
 * Nothing is searched for it. The figures are the daily volume record the core already keeps
 * (docs/VOLUME.md; the Daily volume collection job): VOLUME_DAILY for the days, and the core's
 * breakdown (VOLUME_BREAKDOWN, field `tag`) for the tag1 values — once over the whole window
 * for their ranking, and once per day for each day's documents per value. Every figure goes
 * through core/indices-summary.js: one average (avgPerDay) for the tiles, the line, its tooltip
 * and the CSV; one share rule (tagShareBytes) for a tag1 value's size. A day the record does not
 * have is said so, never drawn as 0; a record never collected says why (recordEmptyWhy) and
 * offers Collect now.
 *
 * Kept between redraws: the Indices page draws on every push from the core, and rebuilding this
 * would close the tooltip under the mouse. It is rebuilt when its own state changes (`rev`).
 */

import { h, svg, tooltip } from '../lib/dom.js';
import { bytes, num, toCsv, download } from '../lib/fmt.js';
import { refreshButton } from '../lib/freshness.js';
import { runBounded } from '../core/fleet.js';
import { navigateTo } from '../core/intent.js';
import { empty, unreadable, configErrorBanner } from '../pages/common.js';
import { toast } from './menu.js';
import {
  volumeDaily, volumeBreakdown, configErrorOf, recordEmptyWhy, utcDay, addDays, hhmm,
  basisOf, dayBasis, BASIS_LABEL, NEEDS_VERSION, backfillLine,
} from '../core/volume-daily.js';
import {
  DAY_CHOICES, DEFAULT_DAYS, AVG_TILES, LINE_AVG_DAYS, TOP_VALUES, RECORD_DAYS, SUMMARY_CSV, TAG_ESTIMATE, tagColumnName,
  dayWindow, avgPerDay, basisPoints, tagShareBytes, valueDocsOn, restDocsOn, rankedValues,
  sizeDayStatus, dayMonth, monthSpans, labelStep, labelledBars, niceScale,
} from '../core/indices-summary.js';
import { collectNow, collecting, reportStatus, FOLLOW_LIMIT_MS } from '../reports/collect.js';

const POLL_MS = 3000;
/** Values asked per day: every value the record keeps (topValues is 5..100). */
const BREAKDOWN_TOP = 100;
const DIR_KEY = 'elasticpro.indices.summary.chart';

const S = { days: DEFAULT_DAYS, chosen: [], more: false, rev: 0 };
/** id → { loading, reply, error } */
const daily = new Map();
/** `${id}|${from}|${to}` → { loading, reply, error }: the window's ranking. */
const ranking = new Map();
/** `${id}|${day}` → { loading, reply, error }: one day's documents per value. */
const perDay = new Map();
let unsupported = false;
let noStore = false;
let redrawPage = () => {};
let built = { sig: null, node: null };
let pending = false;
let poll = null;

const alive = () => !!(built.node && built.node.isConnected);
/** Something this view shows changed: drawn again on the next tick, once for a burst of answers. */
function bump() {
  S.rev++;
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; if (alive()) redrawPage(); }, 30);
}

/** Columns or Rows, remembered in this browser (a private window may refuse: then this visit only). */
let dirMemo = null;
function chartDir() {
  if (dirMemo) return dirMemo;
  try { const v = localStorage.getItem(DIR_KEY); dirMemo = v === 'rows' ? 'rows' : 'columns'; } catch (_) { dirMemo = 'columns'; }
  return dirMemo;
}
function setChartDir(d) {
  dirMemo = d;
  try { localStorage.setItem(DIR_KEY, d); } catch (_) { /* this visit only */ }
  bump();
}

/** Forget every answer (the page opened again, or Refresh): the record is read as it is now. */
export function resetIndicesSummary(id = null) {
  for (const m of [daily, ranking, perDay]) for (const k of [...m.keys()]) if (!id || k === id || k.startsWith(`${id}|`)) m.delete(k);
  if (!id) { unsupported = false; noStore = false; }
  S.rev++;
}

/* --------------------------------------- loading --------------------------------------- */

async function loadDaily(c, force = false) {
  const had = daily.get(c.id);
  if (!force && had) return had;
  const ent = { loading: true, reply: had ? had.reply : null, error: null };
  daily.set(c.id, ent);
  let res;
  try { res = await volumeDaily(c.id, { days: RECORD_DAYS, avgDays: LINE_AVG_DAYS }); } catch (e) { res = { ok: false, message: e && e.message }; }
  ent.loading = false;
  if (res.unsupported) unsupported = true;
  else if (res.kind === 'no_store') noStore = true;
  else if (!res.ok) ent.error = res.message || res.kind || 'no answer';
  else { ent.reply = res; ent.error = null; reportStatus(c.id, res.status); }
  bump();
  return ent;
}

async function loadRanking(c, from, to) {
  const key = `${c.id}|${from}|${to}`;
  if (ranking.has(key)) return;
  const ent = { loading: true, reply: null, error: null };
  ranking.set(key, ent);
  let res;
  try { res = await volumeBreakdown(c.id, { field: 'tag', from, to, top: BREAKDOWN_TOP }); } catch (e) { res = { ok: false, message: e && e.message }; }
  ent.loading = false;
  if (res.ok) ent.reply = res; else ent.error = res.message || res.kind || 'no answer';
  bump();
}

/** One breakdown per day not asked yet, four at a time. */
function loadDays(c, days) {
  const want = days.filter((d) => !perDay.has(`${c.id}|${d}`));
  if (!want.length) return;
  for (const d of want) perDay.set(`${c.id}|${d}`, { loading: true, reply: null, error: null });
  runBounded(want, async (d) => {
    const ent = perDay.get(`${c.id}|${d}`);
    let res;
    try { res = await volumeBreakdown(c.id, { field: 'tag', from: d, to: d, top: BREAKDOWN_TOP }); } catch (e) { res = { ok: false, message: e && e.message }; }
    if (!ent) return;
    ent.loading = false;
    if (res.ok) ent.reply = res; else ent.error = res.message || res.kind || 'no answer';
    bump();
  }, { limit: 4 }).catch(() => {});
}

function refresh(c) {
  resetIndicesSummary(c.id);
  loadDaily(c, true);
}

/** Collect now: the core's daily collection for this cluster (reports/collect.js), its record read again while it runs. */
async function collect(c) {
  if (collecting(c.id)) return;
  const res = await collectNow([c.id]);
  if (res.unsupported) { unsupported = true; bump(); return; }
  if (res.noStore) { noStore = true; bump(); return; }
  if (!res.ok) { toast(res.message, res.level === 'warn' ? 'warn' : 'err', 6000); return; }
  if (res.level === 'warn') toast(res.message, 'warn', 6000);
  if (res.started.length || res.already.length) follow(c);
  bump();
}

function follow(c) {
  if (poll) return;
  const p = { id: c.id, until: Date.now() + FOLLOW_LIMIT_MS, timer: null };
  poll = p;
  const tick = async () => {
    p.timer = null;
    if (poll !== p) return;
    if (!alive()) { poll = null; return; }
    const ent = await loadDaily(c, true);
    const st = ent && ent.reply && ent.reply.status;
    if ((collecting(c.id) || (st && st.running)) && Date.now() < p.until) { p.timer = setTimeout(tick, POLL_MS); return; }
    poll = null;
    resetIndicesSummary(c.id);
    loadDaily(c, true);
  };
  p.timer = setTimeout(tick, 1000);
}

/** The page was left: stop reading the record along with a run (the run goes on in the core). */
export function leaveIndicesSummary() {
  if (poll && poll.timer) clearTimeout(poll.timer);
  poll = null;
  tooltip.hide();
}

/* --------------------------------------- drawing --------------------------------------- */

/**
 * The Summary for one cluster. `tabs()` draws the page's Indices | Templates | Summary switch,
 * which sits at the left of this view's toolbar; `redraw` draws the page again.
 */
export function indicesSummary(c, { tabs, redraw }) {
  redrawPage = redraw || (() => {});
  const today = utcDay();
  const sig = `${c.id}|${S.rev}|${today}`;
  if (built.sig === sig && built.node && built.node.isConnected) return built.node;
  if (!daily.has(c.id) && !unsupported && !noStore) loadDaily(c);
  const node = h('div.isum', { dataset: { days: String(S.days) } }, view(c, today, tabs));
  built = { sig, node };
  return node;
}

function view(c, today, tabs) {
  const ent = daily.get(c.id);
  const reply = ent && ent.reply;
  const bar = toolbar(c, reply, tabs, today);
  if (unsupported) return [bar, empty('This server does not keep a daily volume record yet.', { detail: `The size per day needs ElasticPro ${NEEDS_VERSION} or later on the server.` })];
  if (noStore) return [bar, empty('This server keeps no daily volume record.', { detail: 'It was started without a data directory. Set ELASTICPRO_DATA_DIR (the hosted image sets /app/data) and restart it.' })];
  if (ent && ent.error && !reply) return [bar, unreadable('The daily volume record', ent.error, [h('button.btn.sm', { type: 'button', onclick: () => refresh(c) }, 'Try again')])];
  if (!reply) return [bar, h('div.tbl-empty', 'Reading the daily record…')];
  const out = [bar, configErrorBanner(configErrorOf(reply))];
  const st = reply.status || {};
  const rows = reply.days || [];
  if (st.lastError && rows.length) out.push(h('div.banner.warn', h('div', h('div.ttl', 'The last collection did not finish'), h('div.mono', String(st.lastError)))));
  const why = recordEmptyWhy(reply);
  if (why) return [...out, emptyWhy(c, why)];
  const basis = basisOf(reply.settings);
  const points = basisPoints(reply);
  if (!points.some((p) => p.value !== null)) {
    return [...out, empty('Index size is not measured on this cluster.', {
      detail: 'Its indices are split into days by the time field, and Elasticsearch reports size per index, not per day. Indices dated by name are measured per day: see Day from and the index pattern in Config-Management › Reports › Indices & volume fields.',
      actions: [settingsButton('indexFormat')] })];
  }
  const days = dayWindow(S.days, today);
  // The tag1 values: the window's ranking, then each day's documents per value (and, while a
  // filter is on, the 7 days before the first bar too, for the filtered line's average).
  loadRanking(c, days[0], today);
  const rk = ranking.get(`${c.id}|${days[0]}|${today}`);
  const ranked = rankedValues(rk && rk.reply);
  const rowOf = new Map(points.map((p) => [p.day, p.row]));
  const wanted = (S.chosen.length ? [...dayWindow(S.days + LINE_AVG_DAYS, today).slice(0, LINE_AVG_DAYS), ...days] : days).filter((d) => rowOf.has(d));
  loadDays(c, wanted);
  // A value chosen earlier that this window does not have is let go of.
  if (rk && rk.reply && !rk.error) S.chosen = S.chosen.filter((v) => ranked.values.includes(v));
  const series = seriesFor(c, points, rowOf, basis, today, wanted);
  out.push(tiles(reply, points, basis, today));
  out.push(chartCard(c, reply, days, series, basis, ranked, rk, today));
  out.push(tagCard(c, reply, days, rowOf, basis, ranked, rk, today));
  return out;
}

const settingsButton = (field) => h('button.btn.sm', { type: 'button', onclick: () => navigateTo('settings', { section: 'volume', field }) }, 'Config-Management › Reports');

function emptyWhy(c, why) {
  const actions = [];
  if (why.fix === 'collect') {
    actions.push(h('button#isum-collect.btn.sm', { type: 'button', disabled: collecting(c.id), onclick: () => collect(c) }, collecting(c.id) ? 'Collecting…' : '↻ Collect now'));
  }
  if (why.fix === 'pattern' || why.fix === 'collect') actions.push(settingsButton('indexFormat'));
  return h('div.isum-empty', empty(why.reason, { detail: why.detail, actions }));
}

function toolbar(c, reply, tabs, today) {
  const running = collecting(c.id) || !!(reply && reply.status && reply.status.running);
  const dayBtn = (n) => h('button.btn.sm', {
    type: 'button', 'aria-pressed': S.days === n ? 'true' : 'false', dataset: { days: String(n) },
    title: `The ${n} days ending today`,
    onclick: () => { if (S.days !== n) { S.days = n; bump(); } },
  }, `${n}d`);
  return h('div.isum-toolbar',
    tabs ? tabs() : null,
    h('span.isum-gap'),
    running ? h('span.vs-progress', { role: 'status' }, 'Collecting…') : null,
    h('div.seg', { role: 'group', 'aria-label': 'Days shown' }, ...DAY_CHOICES.map(dayBtn)),
    h('button#isum-csv.btn.sm', { type: 'button', disabled: !(reply && (reply.days || []).length),
      title: 'The days shown as CSV, one row per day, with the tag1 values shown',
      onclick: () => exportCsv(c, today) }, 'Export CSV'),
    refreshButton(() => refresh(c), { id: 'isum-refresh', title: 'read the daily record again' }));
}

/**
 * What the chart draws per day: the day's size on the basis (All), or — with tag1 values
 * chosen — the sum of their shares of it. `[{day, value|null, row|null, pending}]`, over every
 * day `wanted` holds plus the record's own days for the line's average.
 */
function seriesFor(c, points, rowOf, basis, today, wanted) {
  if (!S.chosen.length) return points.map((p) => ({ day: p.day, value: p.value, row: p.row, pending: false }));
  return wanted.map((d) => {
    const row = rowOf.get(d) || null;
    const ent = perDay.get(`${c.id}|${d}`);
    if (!ent || ent.loading) return { day: d, value: null, row, pending: true };
    let sum = 0;
    for (const v of S.chosen) {
      const b = tagShareBytes(valueDocsOn(ent.reply, v), row && row.docs, row && dayBasis(row, basis));
      if (b === null) return { day: d, value: null, row, pending: false };
      sum += b;
    }
    return { day: d, value: sum, row, pending: false };
  });
}

/* ---------------------------------------- tiles ---------------------------------------- */

function tile(k, v, d, id) {
  return h(`div.stat#isum-${id}`, h('div.k', k), h('div.v', v), d ? h('div.d', d) : null);
}
const notRecorded = (title) => h('span.vs-notm', { title }, 'not recorded');

function tiles(reply, points, basis, today) {
  const rowOf = new Map(points.map((p) => [p.day, p]));
  const yday = addDays(today, -1);
  const y = rowOf.get(yday);
  const t = rowOf.get(today);
  const st = reply.status || {};
  const out = [];
  out.push(tile('Yesterday',
    y && y.value !== null ? bytes(y.value) : notRecorded(y ? 'Index size is not measured for this day.' : `The record has no figure for ${yday}.`),
    `${yday} (UTC day)${y ? ` · ${num(y.row.indices)} indices · ${typeof y.row.docs === 'number' ? `${num(y.row.docs)} docs` : 'docs not counted yet'}${y.row.final === false ? ' · not final' : ''}` : ''}`, 'yesterday'));
  for (const n of AVG_TILES) {
    const a = avgPerDay(points, n, { today });
    out.push(tile(`Avg ${n} days`, a.value === null ? notRecorded(`No day of the last ${n} is in the record.`) : bytes(a.value),
      a.measured < a.of ? `per day · ${a.measured} of ${a.of} days recorded` : 'per day', `avg${n}`));
  }
  const asOf = t ? hhmm(t.row.totalsAt ?? t.row.aggregatedAt ?? st.lastRunAt) : '';
  out.push(tile('Today so far',
    t && t.value !== null ? bytes(t.value) : notRecorded('Today has not been collected yet.'),
    t ? `${asOf ? `as of ${asOf} · ` : ''}not final` : 'not collected yet today', 'today'));
  return h('div.isum-tiles', { title: BASIS_LABEL[basis] }, ...out);
}

/* ---------------------------------------- chart ---------------------------------------- */

const ICON_COLS = () => svg('svg', { 'aria-hidden': 'true', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' },
  svg('line', { x1: 6, y1: 20, x2: 6, y2: 12 }), svg('line', { x1: 12, y1: 20, x2: 12, y2: 5 }), svg('line', { x1: 18, y1: 20, x2: 18, y2: 9 }));
const ICON_ROWS = () => svg('svg', { 'aria-hidden': 'true', width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' },
  svg('line', { x1: 4, y1: 6, x2: 14, y2: 6 }), svg('line', { x1: 4, y1: 12, x2: 20, y2: 12 }), svg('line', { x1: 4, y1: 18, x2: 11, y2: 18 }));

function dirButtons() {
  const b = (id, label, title, icon) => h(`button.btn.sm.icon.isum-dir#isum-dir-${id}`, {
    type: 'button', 'aria-pressed': chartDir() === id ? 'true' : 'false', 'aria-label': label, title,
    onclick: () => { if (chartDir() !== id) setChartDir(id); },
  }, icon());
  return h('div.seg.isum-dirs', { role: 'group', 'aria-label': 'Chart direction' },
    b('columns', 'Columns', 'Columns: a bar per day', ICON_COLS), b('rows', 'Rows', 'Rows: a row per day', ICON_ROWS));
}

function chips(ranked, rk, field) {
  if (!rk || rk.loading) return [h('span.muted.isum-chips-wait', `${field}…`)];
  if (rk.error || ranked.error || !ranked.values.length) return [];
  const all = ranked.values;
  const top = all.slice(0, TOP_VALUES);
  const rest = all.slice(TOP_VALUES);
  const open = S.more || S.chosen.some((v) => rest.includes(v));
  const chip = (label, pressed, onclick, extra = {}) => h('button.isum-chip', { type: 'button', 'aria-pressed': pressed ? 'true' : 'false', onclick, ...extra }, label);
  const toggle = (v) => () => { S.chosen = S.chosen.includes(v) ? S.chosen.filter((x) => x !== v) : [...S.chosen, v]; bump(); };
  return [
    h('span.isum-chips-k', field),
    chip('All', !S.chosen.length, () => { if (S.chosen.length) { S.chosen = []; bump(); } }, { title: `Every index, whatever its ${field}` }),
    ...(open ? all : top).map((v) => chip(v, S.chosen.includes(v), toggle(v), { title: v, dataset: { value: v } })),
    rest.length ? chip(open ? 'fewer' : `+ ${rest.length} more`, false, () => { S.more = !open; bump(); },
      { id: 'isum-more', 'aria-expanded': open ? 'true' : 'false', title: open ? `Only the top ${TOP_VALUES}` : `The other ${rest.length} ${field} values` }) : null,
  ];
}

function chartCard(c, reply, days, series, basis, ranked, rk, today) {
  const field = tagField(reply, rk);
  const title = `${basis === 'eventSize' ? 'Event bytes per day' : 'Index size per day'}${S.chosen.length ? ` · ${field} ${TAG_ESTIMATE}` : ''}`;
  const byDay = new Map(series.map((p) => [p.day, p]));
  const shown = days.map((d) => byDay.get(d) || { day: d, value: null, row: null, pending: false });
  const avgOf = (d) => avgPerDay(series, LINE_AVG_DAYS, { today, before: d }).value;
  // No day of the window recorded: said in words, never an empty axis (unknown is not zero).
  const none = !shown.some((p) => p.value !== null || p.pending);
  const newest = [...series].reverse().find((p) => p.value !== null);
  const body = none
    ? h('div.isum-none', h('b', `No day in the last ${shown.length} days is recorded.`),
        h('span.muted', newest ? ` The newest recorded day is ${dayMonth(newest.day)} ${newest.day.slice(0, 4)}: a longer range shows it.` : ' Nothing is recorded yet for this cluster.'))
    : chartDir() === 'rows' ? rowsChart(shown, today, avgOf) : columnsChart(shown, today, avgOf);
  // Why a day of the range may be missing (docs/VOLUME.md "Backfill"), in one line under the chart.
  const bf = backfillLine(reply && reply.status);
  return h('section.card.isum-chart',
    h('header', h('h2', title), dirButtons(), h('span.isum-gap'), ...chips(ranked, rk, field)),
    h('div.body', body, bf ? h('div.muted.vs-backfill', { role: 'status', title: bf.title }, bf.text) : null));
}

/** The tooltip of one day, the same in Columns and Rows. */
function dayTip(p, today, avgOf) {
  const r = (k, v) => h('div.r', h('span', k), h('b', { style: { display: 'inline', margin: 0 } }, v));
  const st = p.day === today ? 'today so far' : p.row && p.row.final === false ? 'not final' : p.row ? 'final' : 'not recorded';
  const avg = avgOf(p.day);
  const est = p.value !== null && S.chosen.length ? ' (estimated)' : '';
  return h('div',
    h('b', `${dayMonth(p.day)} ${p.day.slice(0, 4)} · ${st}`),
    r('Size', p.value !== null ? `${bytes(p.value)}${est}` : p.pending ? 'Loading…' : 'not recorded'),
    p.row ? r('Indices', num(p.row.indices)) : null,
    r(`${LINE_AVG_DAYS}-day avg`, avg !== null ? bytes(avg) : 'no earlier day'));
}
const hover = (p, today, avgOf) => ({
  onmousemove: (e) => tooltip.show(dayTip(p, today, avgOf), e.clientX, e.clientY),
  onmouseleave: () => tooltip.hide(),
});

function columnsChart(shown, today, avgOf) {
  const W = 1000, H = 236, padL = 58, padR = 8, padT = 10, padB = 46;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = shown.length;
  const avgs = shown.map((p) => avgOf(p.day));
  const { max, step: yStep } = niceScale(Math.max(1, ...shown.map((p) => p.value || 0), ...avgs.map((v) => v || 0)));
  const slot = iw / n;
  const bw = Math.max(2, slot * 0.66);
  const xc = (i) => padL + slot * i + slot / 2;
  const y = (v) => padT + ih - (v / max) * ih;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'isum-cols', role: 'img', 'aria-label': `Index size per day, last ${n} days` });
  for (let k = 0; k <= 4; k++) {
    const yy = y(yStep * k);
    s.append(svg('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: 'grid-line' }),
      svg('text', { x: padL - 6, y: yy + 3.5, 'text-anchor': 'end', class: 'isum-ax' }, bytes(yStep * k)));
  }
  shown.forEach((p, i) => {
    if (p.value === null) {
      s.append(svg('line', { x1: xc(i), x2: xc(i), y1: padT + ih - 14, y2: padT + ih, class: 'isum-nobar', 'data-day': p.day }));
      return;
    }
    s.append(svg('rect', { x: xc(i) - bw / 2, y: y(p.value), width: bw, height: Math.max(0.5, padT + ih - y(p.value)), rx: Math.min(3, bw / 4),
      class: `isum-bar${p.day === today ? ' today' : ''}`, 'data-day': p.day }));
  });
  // The 7-day average, in runs between the days that have none.
  let run = [];
  const flush = () => { if (run.length > 1) s.append(svg('polyline', { points: run.join(' '), class: 'isum-avg' })); run = []; };
  avgs.forEach((v, i) => { if (v === null) flush(); else run.push(`${xc(i).toFixed(1)},${y(v).toFixed(1)}`); });
  flush();
  // A date under the bars, thinned so they never collide; the month once under its days.
  const step = labelStep(n, iw, 46);
  // A date near either end is anchored to it, so it is never cut off by the edge.
  for (const i of labelledBars(n, step)) {
    const x = xc(i);
    const anchor = x > W - padR - 22 ? 'end' : x < padL + 22 ? 'start' : 'middle';
    s.append(svg('text', { x: anchor === 'end' ? W - padR : anchor === 'start' ? padL : x, y: H - padB + 16, 'text-anchor': anchor, class: 'isum-x' }, dayMonth(shown[i].day)));
  }
  for (const m of monthSpans(shown.map((p) => p.day))) {
    const mid = (xc(m.first) + xc(m.last)) / 2;
    s.append(svg('text', { x: Math.min(W - padR - 50, Math.max(padL + 50, mid)), y: H - 8, 'text-anchor': 'middle', class: 'isum-month' }, m.label));
  }
  // Hover: the whole height of each day.
  shown.forEach((p, i) => s.append(svg('rect', { x: padL + slot * i, y: padT, width: slot, height: ih, class: 'isum-hit', 'data-day': p.day, ...hover(p, today, avgOf) })));
  return h('div.isum-plot', s,
    h('div.legend.vs-legend', h('span', h('i.isum-sw-bar'), 'size per day'), h('span', h('i.isum-sw-avg'), `${LINE_AVG_DAYS}-day average`),
      h('span', h('i.isum-sw-bar.today'), 'today, not final')));
}

function rowsChart(shown, today, avgOf) {
  const max = Math.max(1, ...shown.map((p) => p.value || 0));
  return h('div.isum-rows', { role: 'list', 'aria-label': `Index size per day, last ${shown.length} days` },
    ...shown.map((p) => h(`div.isum-row${p.day === today ? '.today' : ''}`, { role: 'listitem', dataset: { day: p.day }, ...hover(p, today, avgOf) },
      h('span.isum-row-d', dayMonth(p.day)),
      h('span.isum-track', p.value !== null ? h('i', { style: { width: `${Math.max(0.3, (p.value / max) * 100).toFixed(2)}%` } }) : null),
      h('span.isum-row-v', p.value !== null ? bytes(p.value) : p.pending ? '…' : h('span.vs-notm', 'not recorded')))));
}

/* -------------------------------------- per tag1 --------------------------------------- */

/** The tag field's name as the record resolved it ("tag1"), else as the settings name it. */
function tagField(reply, rk) {
  const res = rk && rk.reply && rk.reply.resolved;
  const set = reply && reply.settings && Array.isArray(reply.settings.tag) && reply.settings.tag[0];
  return String(res || set || 'tag1').replace(/\.keyword$/, '');
}

const tagInfo = (field) => `Elasticsearch does not store size per ${field} value: a value's size is its share of the day's documents × the day's index size. ${S.chosen.length ? 'The chosen values shown.' : `Top ${TOP_VALUES} values shown.`}`;

function infoButton(field) {
  const text = tagInfo(field);
  const show = (e) => { const r = e.currentTarget.getBoundingClientRect(); tooltip.show(h('div', text), r.left, r.bottom); };
  // Its own class: `button.ld-ibtn` is claimed by a document-wide handler (ui/fix-popover.js).
  return h('button#isum-tag-i.isum-i', { type: 'button', 'aria-label': `How ${field} sizes are worked out`, title: text,
    onclick: show, onfocus: show, onmouseenter: show, onblur: () => tooltip.hide(), onmouseleave: () => tooltip.hide() }, 'i');
}

/** The table's value columns: the chosen values, else the top ones and the rest as "other". */
function tagColumns(ranked) {
  if (S.chosen.length) return { values: ranked.values.filter((v) => S.chosen.includes(v)), other: false };
  return { values: ranked.values.slice(0, TOP_VALUES), other: ranked.values.length > 0 };
}

/** A value's size on a day, or why there is none (title). `undefined` docs: not asked yet. */
function tagCell(c, row, basis, d, value, named) {
  const ent = perDay.get(`${c.id}|${d}`);
  if (!row) return { v: null, why: 'not recorded' };
  if (!ent || ent.loading) return { v: null, why: 'reading', pending: true };
  if (ent.error) return { v: null, why: `could not be read: ${ent.error}` };
  if (ent.reply && ent.reply.error) return { v: null, why: String(ent.reply.error) };
  const docs = value === null ? restDocsOn(ent.reply, named) : valueDocsOn(ent.reply, value);
  if (docs === null) return { v: null, why: 'not among the values the record kept for this day' };
  const b = tagShareBytes(docs, row.docs, dayBasis(row, basis));
  return b === null ? { v: null, why: 'the day\'s size or documents are not measured' } : { v: b };
}

function tagCard(c, reply, days, rowOf, basis, ranked, rk, today) {
  const field = tagField(reply, rk);
  const head = h('header', h('h2', `Per day by ${field} · ${TAG_ESTIMATE}`), infoButton(field));
  let body;
  if (!rk || rk.loading) body = h('div.tbl-empty', `Reading the ${field} values…`);
  else if (rk.error) body = unreadable(`The ${field} values`, rk.error);
  else if (ranked.error || !ranked.values.length) {
    const tried = reply.settings && Array.isArray(reply.settings.tag) && reply.settings.tag.length ? reply.settings.tag.join(', ') : 'tag1';
    body = empty(ranked.error ? `These indices have no ${field} field.` : `No ${field} value recorded in these days.`, {
      detail: `${ranked.error ? `${ranked.error}. ` : ''}Tried ${tried}. Set the tag field in Config-Management › Reports › Indices & volume fields.`,
      actions: [settingsButton('tag')] });
  } else {
    const cols = tagColumns(ranked);
    const th = (t, num) => h(`th${num ? '.num' : ''}`, t);
    const statusCls = { ok: 'green', today: 'grey', warn: 'yellow', na: 'grey' };
    const trs = [...days].reverse().map((d) => {
      const row = rowOf.get(d) || null;
      const all = row ? dayBasis(row, basis) : null;
      const cell = (x) => (x.v !== null ? h('td.num', bytes(x.v)) : h('td.num', { title: x.why }, x.pending ? h('span.muted', '…') : h('span.muted', '—')));
      const s = sizeDayStatus(row && { ...row, day: d }, basis, { today });
      return h(`tr${d === today ? '.today' : ''}`, { dataset: { day: d } },
        h('td.mono', d),
        all !== null ? h('td.num.isum-all', bytes(all)) : h('td.num', h('span.vs-notm', { title: s.title || null }, 'not measured')),
        ...cols.values.map((v) => cell(tagCell(c, row, basis, d, v, null))),
        cols.other ? cell(tagCell(c, row, basis, d, null, cols.values)) : null,
        h('td', h(`span.pill.${statusCls[s.kind] || 'grey'}`, { title: s.title || null }, s.text)));
    });
    body = h('div.tbl-wrap', h('table.tbl.isum-tbl#isum-tag-table',
      h('thead', h('tr', th('Day'), th('All indices', true), ...cols.values.map((v) => h('th.num', { title: v }, v)), cols.other ? th('other', true) : null, th('Status'))),
      h('tbody', ...trs)));
  }
  return h('section.card.isum-tags', head, h('div.body', body));
}

/* ----------------------------------------- CSV ----------------------------------------- */

/**
 * One row per day shown, newest first, as the table reads: the size on the basis and its
 * 7-day average (avgPerDay, the tiles' and the line's function), and each tag1 value shown.
 * A figure not recorded stays empty — never a 0 in a spreadsheet.
 */
export function summaryCsv(c, today = utcDay()) {
  const ent = daily.get(c.id);
  const reply = ent && ent.reply;
  if (!reply) return null;
  const basis = basisOf(reply.settings);
  const points = basisPoints(reply);
  const rowOf = new Map(points.map((p) => [p.day, p.row]));
  const days = dayWindow(S.days, today);
  const rk = ranking.get(`${c.id}|${days[0]}|${today}`);
  const ranked = rankedValues(rk && rk.reply);
  const field = tagField(reply, rk);
  const cols = tagColumns(ranked);
  const tagHeads = [...cols.values.map((v) => tagColumnName(field, v)), ...(cols.other ? [tagColumnName(field, 'other')] : [])];
  const rows = [...days].reverse().map((d) => {
    const row = rowOf.get(d) || null;
    const avg = avgPerDay(points, LINE_AVG_DAYS, { today, before: d });
    const o = {
      cluster: c.name, day: d, status: sizeDayStatus(row && { ...row, day: d }, basis, { today }).text,
      indices: row && typeof row.indices === 'number' ? row.indices : null,
      docs: row && typeof row.docs === 'number' ? row.docs : null,
      size_basis: basis, size_bytes: row ? dayBasis(row, basis) : null,
      avg_7d_bytes: avg.value === null ? null : Math.round(avg.value),
      avg_7d_days_recorded: `${avg.measured} of ${avg.of}`,
    };
    cols.values.forEach((v, i) => { const x = tagCell(c, row, basis, d, v, null); o[tagHeads[i]] = x.v === null ? null : Math.round(x.v); });
    if (cols.other) { const x = tagCell(c, row, basis, d, null, cols.values); o[tagHeads[tagHeads.length - 1]] = x.v === null ? null : Math.round(x.v); }
    return o;
  });
  return toCsv(rows, [...SUMMARY_CSV, ...tagHeads]);
}

function exportCsv(c, today) {
  const text = summaryCsv(c, today);
  if (text) download(`indices-summary-${c.name}-${today}.csv`, text, 'text/csv');
}
