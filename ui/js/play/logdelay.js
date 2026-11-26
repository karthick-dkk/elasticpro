/**
 * Slide 2, Log delay (docs/PLAY.md): the scheduled measurement's record (LOGDELAY_BOARD, counts
 * only) of every cluster on this display, put together. One graph: the devices still late in
 * each 12 hours of the last 7 days, the last point being now. Under it: all devices now with
 * today's new and solved delays, the most delayed clusters of each 12 hours, and every cluster.
 *
 * Part delayed devices (some log types late) count as on time here, by the owner's decision of
 * 25 Nov 2026; the Log Delay page keeps them apart. A window nobody measured reads "not measured"
 * and a cluster whose last run failed or is old is in no "now" figure: never a 0.
 *
 * Without a record (the scheduled measurement is off, or a core before 0.3.94) the devices now
 * are Play's own measurement (play/measure.js), and the graph says what is missing.
 */

import { h, svg } from '../lib/dom.js';
import { donut, pageAt, unknown, clockText } from './parts.js';
import { dwellMs } from './engine.js';

export const id = 'delay';
export const title = 'Log delay';
export const DATASETS = [];

export const DAYS = 7;
const TOP_WINDOWS = 6;
const TOP_CLUSTERS = 3;
const PER_PAGE = 16;

const collate = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Whether the record has any cluster of this display that was ever measured. */
const recorded = (ctx) => !!(ctx.delayBoard && boardRows(ctx).some((r) => r.lastRunAt));

/** The record's clusters that are on this display (an excluded one is in no figure). */
function boardRows(ctx) {
  const by = new Map(((ctx.delayBoard && ctx.delayBoard.clusters) || []).map((r) => [r.id, r]));
  return ctx.clusters.map((c) => by.get(c.id)).filter(Boolean);
}

/** One cluster's row from a measurement's summary, when there is no record: nothing of today is known. */
export function measuredRow(c, summary) {
  const n = (k) => ((summary.by || {})[k] || 0);
  return { id: c.id, name: c.name, state: 'ok', devices: summary.devices, onTime: n('OK'), partDelayed: n('PART_DELAY'), delay: n('DELAYED'), critical: n('CRITICAL'),
    late: n('DELAYED') + n('CRITICAL'), silent: n('NO_DATA'), cantMeasure: n('ERROR') + n('CLOCK_AHEAD') + n('UNKNOWN'), otherTz: n('OTHER_TZ'), newToday: null, solvedToday: null, levels: null };
}

/** Every cluster on the display, most late first, then by name; one not read now goes last. */
export function delayRows(ctx) {
  const by = recorded(ctx) ? new Map(boardRows(ctx).map((r) => [r.id, r])) : null;
  return ctx.clusters.map((c) => {
    const d = ctx.delay.get(c.id);
    const r = by ? by.get(c.id) : d && d.summary ? measuredRow(c, d.summary) : null;
    return r ? { ...r, name: c.name } : { id: c.id, name: c.name, state: 'never' };
  }).sort((a, b) => (b.state === 'ok') - (a.state === 'ok') || (b.late || 0) - (a.late || 0) || (b.critical || 0) - (a.critical || 0) || collate(a, b));
}

/**
 * The parts of a devices donut, one definition for Fleet and Log delay: `t` delayTotals(), `words`
 * levelWords(). The two late parts are named by the lines they are over; `oneLate`, a label, puts
 * them together as one (Fleet).
 */
export function delayParts(t, words, { oneLate = '' } = {}) {
  return [
    { n: t.onTime, label: 'On time', tone: 'green' },
    ...(oneLate ? [{ n: t.late, label: oneLate, tone: 'yellow' }]
      : [{ n: t.delay, label: words.delay, tone: 'yellow' }, { n: t.critical, label: words.critical, tone: 'red' }]),
    { n: t.grey, label: 'Silent or can’t measure', tone: 'blue' },
    ...(t.otherTz ? [{ n: t.otherTz, label: 'Other time zone, not late', tone: 'grey' }] : []),
  ];
}

/** The devices now, over the clusters read; `today` null when no record says. */
export function delayTotals(rows) {
  const ok = rows.filter((r) => r.state === 'ok');
  const sum = (k) => ok.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const today = ok.length && ok.every((r) => typeof r.newToday === 'number');
  return { clusters: ok.length, devices: sum('devices'), onTime: sum('onTime') + sum('partDelayed'), delay: sum('delay'), critical: sum('critical'), late: sum('late'),
    grey: sum('silent') + sum('cantMeasure'), otherTz: sum('otherTz'), newToday: today ? sum('newToday') : null, solvedToday: today ? sum('solvedToday') : null };
}

/** The points of the graph over this display's clusters: `late` null where none was measured. */
export function delayWindows(ctx) {
  const rows = boardRows(ctx);
  return ((ctx.delayBoard && ctx.delayBoard.windows) || []).map((w, i) => {
    const have = rows.filter((r) => Array.isArray(r.windows) && typeof r.windows[i] === 'number');
    return { ...w, late: have.length ? have.reduce((a, r) => a + r.windows[i], 0) : null, measured: have.length, index: i };
  });
}

/** The most delayed clusters of one window, at most three; one with no late device is not among them. */
export function topOf(ctx, index) {
  return boardRows(ctx).filter((r) => r.windows && r.windows[index] > 0).map((r) => ({ name: (ctx.clusters.find((c) => c.id === r.id) || r).name, n: r.windows[index] }))
    .sort((a, b) => b.n - a.n || collate(a, b)).slice(0, TOP_CLUSTERS);
}

export const isEmpty = (ctx) => !recorded(ctx) && !ctx.clusters.some((c) => { const x = ctx.delay.get(c.id); return x && x.records; });

const dayText = (ms, tz) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', ...(tz ? { timeZone: tz } : {}) }).format(new Date(ms));
const at = (ms, tz) => clockText(ms, tz, { seconds: false });
/** "00:00–12:00", "12:00–24:00"; the running one "12:00–now". */
export const periodText = (w, tz) => `${at(w.from, tz)}–${w.complete ? (at(w.to, tz) === '00:00' ? '24:00' : at(w.to, tz)) : 'now'}`;

/** A round top for the graph, at least 4, with four steps of whole devices. */
export function scaleTop(max) {
  let step = 1;
  for (const f of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000]) { step = f; if (f * 4 >= max * 1.1) break; }
  return { top: step * 4, step };
}

const W = 1780, H = 386, X0 = 60, X1 = 1700, Y0 = 330, Y1 = 30;

function graph(ws, tz, full) {
  const { top, step } = scaleTop(Math.max(0, ...ws.map((w) => w.late || 0)));
  const x = (i) => (ws.length > 1 ? X0 + (i * (X1 - X0)) / (ws.length - 1) : (X0 + X1) / 2);
  const y = (n) => Y0 - (n / top) * (Y0 - Y1);
  const said = ws.map((w) => `${dayText(w.from, tz)} ${periodText(w, tz)} ${w.late === null ? 'not measured' : w.late}`).join(', ');
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Devices still late each 12 hours: ${said}` });
  for (let n = 0; n <= top; n += step) {
    s.append(svg('line', { x1: X0 - 10, x2: X1 + 60, y1: y(n), y2: y(n), class: n ? 'grid' : 'base' }),
      svg('text', { x: X0 - 22, y: y(n) + 6, 'text-anchor': 'end', class: 'axis' }, String(n)));
  }
  // A gap breaks the line: nothing is drawn over a period nobody measured.
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const p = run.map((w) => `${x(w.index).toFixed(1)},${y(w.late).toFixed(1)}`);
      s.append(svg('polygon', { class: 'area', points: `${x(run[0].index).toFixed(1)},${Y0} ${p.join(' ')} ${x(run[run.length - 1].index).toFixed(1)},${Y0}` }),
        svg('polyline', { class: 'line', points: p.join(' ') }));
    }
    run = [];
  };
  for (const w of ws) { if (w.late === null) flush(); else run.push(w); }
  flush();
  for (const w of ws) {
    const px = x(w.index);
    s.append(svg('text', { x: px, y: 354, 'text-anchor': 'middle', class: 'per' }, periodText(w, tz)),
      svg('text', { x: px, y: 378, 'text-anchor': 'middle', class: 'axis' }, dayText(w.from, tz)));
    if (w.late === null) { s.append(svg('text', { x: px, y: Y0 - 12, 'text-anchor': 'middle', class: 'none' }, 'not measured')); continue; }
    const part = w.measured < full;
    s.append(svg('circle', { cx: px, cy: y(w.late), r: 7, class: part ? 'dot part' : 'dot' }),
      svg('text', { x: px, y: y(w.late) - 16, 'text-anchor': 'middle', class: 'val' }, String(w.late)));
    if (part) s.append(svg('text', { x: px, y: y(w.late) + 28, 'text-anchor': 'middle', class: 'none' }, `${w.measured} of ${full} clusters`));
  }
  return s;
}

const pageNow = (ctx, total) => pageAt(ctx.elapsed || 0, total, PER_PAGE,
  dwellMs(id, { dwellSec: ctx.display.dwellSec, slideDwell: ctx.display.slideDwell }));
export const phaseKey = (ctx) => String(pageNow(ctx, ctx.clusters.length).index);

/** The words of the two late classes: the minutes when every cluster read has the same levels, else the level's name. */
export function levelWords(rows, fallback) {
  const ls = rows.filter((r) => r.state === 'ok').map((r) => r.levels || fallback);
  const one = ls.length && ls.every((l) => l && l.delayFrom === ls[0].delayFrom && l.criticalOver === ls[0].criticalOver) ? ls[0] : null;
  return one ? { delay: `${one.delayFrom}–${one.criticalOver} min late`, critical: `Over ${one.criticalOver} min late` } : { delay: 'Delayed', critical: 'Critical' };
}

const num = (n, tone) => (n === null ? unknown('–', 'No record of today') : h(`b${n ? `.${tone}` : '.zero'}`, String(n)));

function clusterRow(r, ctx) {
  if (r.state !== 'ok') {
    const word = r.state === 'old' || r.state === 'failed' ? `read ${at(r.lastRunAt, ctx.tz)}${dayText(r.lastRunAt, ctx.tz) === dayText(ctx.now, ctx.tz) ? '' : `, ${dayText(r.lastRunAt, ctx.tz)}`}` : 'not read';
    return h('div.pl-ldrow', { dataset: { cluster: r.id } }, h('span', r.name),
      h('span.pl-ldwide.grey', { title: r.state === 'failed' ? 'The last measurement failed' : r.state === 'old' ? 'No measurement since' : 'Never measured' }, r.state === 'failed' ? `failed · ${word}` : word));
  }
  const w = (n) => (r.devices ? `${(n / r.devices) * 100}%` : '0%');
  return h('div.pl-ldrow', { dataset: { cluster: r.id } }, h('span', r.name),
    h('span.pl-ldbar', { title: `${r.devices} devices` }, h('i.red', { style: { width: w(r.critical) } }), h('i.yellow', { style: { width: w(r.delay) } }), h('i.green', { style: { width: w(r.onTime + r.partDelayed) } })),
    h(`b.num.${r.critical ? 'red' : r.late ? 'yellow' : 'zero'}`, String(r.late)),
    h('span.num', num(r.newToday, 'yellow')), h('span.num', num(r.solvedToday, 'green')));
}

export function render(ctx) {
  const has = recorded(ctx);
  const rows = delayRows(ctx);
  const t = delayTotals(rows);
  const ws = has ? delayWindows(ctx) : [];
  const words = levelWords(rows, { delayFrom: ctx.watch.delayYellowFromMin, criticalOver: ctx.watch.delayRedAboveMin });
  const page = pageNow(ctx, rows.length);
  const shown = rows.slice(page.from, page.to);
  const half = Math.ceil(Math.min(PER_PAGE, shown.length) / 2);
  const head = () => h('div.pl-ldrow.head', h('span', 'Cluster'), h('span'), h('span.num', 'Late'), h('span.num', 'New'), h('span.num', 'Solved'));
  const pad = (n) => Array.from({ length: Math.max(0, PER_PAGE / 2 - n) }, () => h('div.pl-ldrow.pad'));
  const recent = ws.slice(-TOP_WINDOWS).reverse();
  return h('div.pl-slide.pl-logdelay', h('div.pl-ld',
    h('div.pl-panel.pl-ldgraph',
      h('div.pl-ph', 'Devices still late = late − solved, each 12 h, all clusters',
        ws.length ? h('small', `${dayText(ws[0].from, ctx.tz)} ${at(ws[0].from, ctx.tz)} to ${dayText(ctx.delayBoard.now, ctx.tz)} ${at(ctx.delayBoard.now, ctx.tz)}`) : null),
      ws.length ? graph(ws, ctx.tz, rows.length)
        : h('div.pl-ldnone', unknown(ctx.delayBoard && ctx.delayBoard.scheduled === false
          ? 'Not recorded: the scheduled log delay measurement is off (Config-Management › Log delay)' : 'Not recorded yet'))),
    h('div.pl-panel', h('div.pl-ph', 'All devices now', t.clusters < rows.length ? h('small', `${t.clusters} of ${rows.length} clusters`) : null),
      t.clusters ? donut(delayParts(t, words), { total: t.devices, label: t.devices === 1 ? 'device' : 'devices' }) : unknown('no cluster was read lately'),
      h('div.pl-ldtoday', h('span.pl-dim', 'Today'), h('span', num(t.newToday, 'yellow'), ' new'), h('span', num(t.solvedToday, 'green'), ' solved'),
        h('span', t.clusters ? h('b', String(t.late)) : unknown('–'), ' late now'))),
    h('div.pl-panel', h('div.pl-ph', 'Most delayed clusters, each 12 h', h('small', 'devices late')),
      recent.length ? h('div.pl-ldtop', ...recent.flatMap((w) => {
        const top = w.late === null ? [] : topOf(ctx, w.index);
        const cells = w.late === null ? [unknown('not measured')] : top.length ? top.map((x) => h('span', h('em', x.name), ' ', h('b.yellow', String(x.n)))) : [h('span.pl-dim', 'none late')];
        return [h('span.pl-dim', `${dayText(w.from, ctx.tz)} ${periodText(w, ctx.tz)}`), ...Array.from({ length: TOP_CLUSTERS }, (_, i) => h('span', cells[i] || ''))];
      })) : unknown('no record')),
    h('div.pl-panel.pl-ldall', h('div.pl-ph', 'Every cluster',
      page.pages > 1 ? h('small', `${page.from + 1}–${page.to} of ${rows.length}`) : null),
    h('div.pl-ldcols',
      h('div.pl-ldcol', head(), ...shown.slice(0, half).map((r) => clusterRow(r, ctx)), ...pad(half)),
      h('div.pl-ldcol', head(), ...shown.slice(half).map((r) => clusterRow(r, ctx)), ...pad(shown.length - half))))));
}
