/**
 * Jobs › Jobs, the graphical view (approved canvas "Jobs graphical view", 0.3.77): above the
 * All jobs table, after *Now* (pages/jobs.js), three cards —
 *
 *   Health             Worker CPU, Core CPU, Memory, Requests/s, Busy clusters: the value now
 *                      (what the strip reads) and a line over 1h · 6h · 24h · 7d (HEALTH_HISTORY,
 *                      kept on the server for 7 days, docs/HEALTH.md "History").
 *   ElasticPro health  administrators (SYSTEM_HEALTH is theirs): the service pills and one tile per
 *                      health check — value, limit, ok / watch / over — with its line, same switch.
 *   Runs               one lane per job, a bar per run coloured by its result, the next run dashed,
 *                      a "now" line; 6h · 24h · 7d. From the run log JOBS_LIST already pages.
 *
 * The pure half is core/jobs-graph.js. Reads: HEALTH_HISTORY every minute (its points are a
 * minute apart) or on a new range, SYSTEM_HEALTH every 30 s, the runs every minute or on a new
 * range — only while the Jobs tab is open (pages/jobs.js calls `refresh`). Nothing is sent to a
 * cluster.
 */

import { h, svg } from '../lib/dom.js';
import { dt } from '../lib/fmt.js';
import { jobsList, systemHealth, healthHistory } from '../core/es.js';
import { trendSeries, sparkPath, levelTone } from '../core/system-health.js';
import * as G from '../core/jobs-graph.js';
import * as J from '../core/jobs.js';

const HISTORY_EVERY_MS = 60_000;
const SYSTEM_EVERY_MS = 30_000;
const RUNS_EVERY_MS = 60_000;
/** At most this many pages of 200 runs for the lanes (the run log keeps 50 a job: 7 days fit). */
const RUN_PAGES = 6;

const store = {
  get(k, d) { try { const v = localStorage.getItem(`elasticpro.jobs.${k}`); return v || d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(`elasticpro.jobs.${k}`, v); } catch (_) { /* a private window */ } },
};

export function createGraph() {
  const st = {
    range: G.HEALTH_RANGES.includes(store.get('healthRange')) ? store.get('healthRange') : G.DEFAULT_RANGE,
    runRange: G.RUN_RANGES.includes(store.get('runRange')) ? store.get('runRange') : G.DEFAULT_RANGE,
    hist: null, histAt: 0, histRange: null, histErr: null,
    sys: null, sysAt: 0, sysErr: null,
    runs: null, runsAt: 0, runsFrom: 0, runsErr: null, runsCut: false,
    busy: new Set(),
  };
  let redraw = () => {};

  async function once(key, fn) {
    if (st.busy.has(key)) return;
    st.busy.add(key);
    try { await fn(); } finally { st.busy.delete(key); redraw(); }
  }

  /** The runs of the window the lanes and the 24-hour tile need, newest first, a page at a time. */
  async function loadRuns(now) {
    const from = now - Math.max(G.rangeMs(st.runRange), G.rangeMs('24h'));
    const out = [];
    let before = null, cut = false;
    for (let i = 0; i < RUN_PAGES; i++) {
      const res = await jobsList({ limit: 200, ...(before ? { before } : {}) });
      if (!res || !res.ok) { st.runsErr = J.refusalText(res) || 'the core did not answer'; return; }
      const runs = res.runs || [];
      out.push(...runs);
      const last = runs[runs.length - 1];
      if (!res.next || !last || (last.createdAt || 0) < from) break;
      before = res.next;
      if (i === RUN_PAGES - 1) cut = true;
    }
    st.runs = out; st.runsAt = Date.now(); st.runsFrom = from; st.runsErr = null; st.runsCut = cut;
  }

  /** Read what is due; `onDone` draws again when an answer lands. */
  function refresh({ admin, onDone }) {
    redraw = onDone || redraw;
    const now = Date.now();
    if (now - st.histAt > HISTORY_EVERY_MS || st.histRange !== st.range) {
      st.histAt = now;
      const range = st.range;
      once('hist', async () => {
        const res = await healthHistory(range);
        if (res && res.ok) { st.hist = res; st.histRange = range; st.histErr = null; }
        else if (res && (res.kind === 'bad_message' || res.kind === 'unknown_message')) { st.hist = null; st.histRange = range; st.histErr = 'this server keeps no health history yet (HEALTH_HISTORY needs a newer ElasticPro)'; }
        // No points for this range: the last range's would be drawn on the wrong span.
        else { st.hist = null; st.histRange = range; st.histErr = J.refusalText(res) || 'the core did not answer'; }
      });
    }
    if (admin && now - st.sysAt > SYSTEM_EVERY_MS) {
      st.sysAt = now;
      once('sys', async () => {
        const res = await systemHealth();
        if (res && res.ok) { st.sys = res; st.sysErr = null; } else st.sysErr = J.refusalText(res) || 'the core did not answer';
      });
    }
    const want = now - Math.max(G.rangeMs(st.runRange), G.rangeMs('24h'));
    if (now - st.runsAt > RUNS_EVERY_MS || want < st.runsFrom - 60_000) {
      st.runsAt = now;
      once('runs', () => loadRuns(now));
    }
  }

  /** The runs read for the lanes, with the page's newest (open ones move faster than a minute). */
  function allRuns(list) {
    const m = new Map();
    for (const r of st.runs || []) m.set(r.id, r);
    for (const r of (list && list.runs) || []) m.set(r.id, r);
    for (const j of (list && list.jobs) || []) for (const r of [j.state && j.state.current, j.state && j.state.lastRun]) if (r && r.id) m.set(r.id, r);
    return [...m.values()];
  }

  /* ------------------------------------ drawing ------------------------------------ */

  const switcher = (id, ranges, cur, onPick) => h(`div.jg-switch`, { role: 'group', 'aria-label': id, dataset: { switch: id } },
    ...ranges.map((r) => h('button', { type: 'button', 'aria-pressed': String(r === cur), dataset: { range: r }, onclick: () => onPick(r) }, r)));

  /** A small line over the range: the series [t, v] (unknown minutes left out). */
  function line(series, colour, label) {
    const W = 220, H = 40;
    const span = G.rangeMs(st.histRange || st.range);
    const now = st.hist ? st.hist.at : Date.now();
    const pts = sparkPath(series, { w: W, h: H, now, spanMs: span });
    if (!pts) return h('div.jg-noline.muted', st.histErr ? 'no history' : 'not enough samples yet');
    const xs = pts.split(' ').map((p) => p.split(',')[0]);
    // Colours are CSS custom properties: a style (an SVG attribute does not resolve var()).
    return svg('svg', { class: 'jg-line', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${label}, ${st.histRange || st.range}` },
      svg('polygon', { points: `${xs[0]},${H} ${pts} ${xs[xs.length - 1]},${H}`, style: { fill: colour, opacity: '0.14' } }),
      svg('polyline', { points: pts, fill: 'none', style: { stroke: colour }, 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke' }));
  }
  const series = (field) => trendSeries(st.hist, field);

  function setRange(r) { st.range = r; store.set('healthRange', r); refresh({ admin: false }); redraw(); }
  function setRunRange(r) { st.runRange = r; store.set('runRange', r); refresh({ admin: false }); redraw(); }

  const card = (key, title, sub, right, ...body) => h(`section.card.jg-card`, { dataset: { card: key } },
    h('header', h('h2', title), sub ? h('span.sub', sub) : null, h('span.jg-sp'), right), ...body);

  /** Health: the strip's figures now, and their lines. `now` values come from pages/jobs.js. */
  function healthCard(values) {
    const colours = ['var(--series-1)', 'var(--series-5)', 'var(--series-7)', 'var(--series-4)', 'var(--series-2)'];
    const tiles = G.HEALTH_TILES.map((t, i) => {
      const v = values[t.id] || {};
      const hidden = st.hist && Array.isArray(st.hist.fields) && !st.hist.fields.includes(t.field);
      return h('div.jg-tile', { dataset: { tile: t.id }, title: v.title || null },
        h('span.k', t.label), h('b.v', v.text ?? '—'), h('span.d', v.sub || ''),
        hidden ? h('div.jg-noline.muted', 'counts every cluster: not for a view limited to some') : line(series(t.field), colours[i], t.label));
    });
    const sub = st.histErr ? `the lines: ${st.histErr}` : 'this server and its worker · kept on the server for 7 days';
    return card('health', 'Health', sub, switcher('Health time frame', G.HEALTH_RANGES, st.range, setRange), h('div.jg-tiles', ...tiles));
  }

  /** ElasticPro health: the parts and the checks (SYSTEM_HEALTH, an administrator's), each check with its line. */
  function appHealthCard() {
    const s = st.sys;
    if (!s) return card('apphealth', 'ElasticPro health', st.sysErr ? `could not be read: ${st.sysErr}` : 'Loading…', null);
    const pills = (s.parts || []).map((p) => h(`span.jg-part.${levelTone(p.level)}`, { dataset: { part: p.id }, title: p.at ? `${p.text} · ${dt(p.at)}` : p.text },
      h('i.dot'), h('b', p.label), h('span', J.truncate(p.text, 48))));
    const th = new Map((s.thresholds || []).map((t) => [t.id, t]));
    const colours = ['var(--series-1)', 'var(--series-5)', 'var(--series-4)', 'var(--series-2)', 'var(--series-6)', 'var(--series-8)'];
    const tiles = G.CHECK_TILES.map((ct, i) => {
      const c = (s.checks || []).find((x) => x.id === ct.check);
      if (!c) return null;     // no worker (role all): no worker line, as the tab
      const lvl = G.levelShort(c.level);
      return h(`div.jg-tile.jg-check.lv-${c.level}`, { dataset: { check: c.id }, title: [c.text, c.fix].filter(Boolean).join('\n') },
        h('span.k', h(`i.dot.${levelTone(c.level)}`), c.label, h('span.jg-sp'), h(`span.jg-lv.${levelTone(c.level)}`, lvl)),
        h('b.v', c.value || '—'), h('span.d', G.limitText(th.get(c.threshold))),
        line(series(ct.field), colours[i], c.label));
    }).filter(Boolean);
    return card('apphealth', 'ElasticPro health', 'this app itself · same time frame · the full list is Jobs › Requests › ElasticPro health',
      switcher('ElasticPro health time frame', G.HEALTH_RANGES, st.range, setRange),
      h('div.jg-parts', ...pills), h('div.jg-tiles', ...tiles));
  }

  /** Runs: one lane per job over the window, a bar per run, the next run dashed, a "now" line. */
  function runsCard(list, nameOf) {
    const now = Date.now();
    const from = now - G.rangeMs(st.runRange);
    const jobs = (list && list.jobs) || [];
    const lanes = G.lanes(jobs, allRuns(list), { from, now });
    const LW = 170, W = 1000, ROW = 20, TOP = 16, H = TOP + lanes.length * ROW + 14;
    const PW = W - LW - 8;
    const X = (f) => LW + f * PW;
    const fill = { ok: 'var(--chart-good)', warn: 'var(--chart-warn)', bad: 'var(--chart-bad)', run: 'var(--chart-info)' };
    const kids = [];
    for (const t of G.ticks(from, now)) {
      kids.push(svg('line', { x1: X(t.x), x2: X(t.x), y1: TOP - 2, y2: H - 12, class: 'jg-grid' }));
      kids.push(svg('text', { x: X(t.x), y: 10, 'text-anchor': 'middle', class: 'jg-tick' },
        new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(st.runRange === '7d' ? { weekday: 'short' } : {}) }).format(new Date(t.t))));
    }
    lanes.forEach((ln, i) => {
      const y = TOP + i * ROW;
      kids.push(svg('text', { x: LW - 8, y: y + 13, 'text-anchor': 'end', class: 'jg-lane' }, J.truncate(ln.name, 26)));
      for (const b of ln.bars) {
        const r = b.run;
        const tip = `${ln.name}\n${J.statusWord(r.status)} · ${(r.clusters || []).map(nameOf).join(', ') || 'no cluster'}\nstarted ${r.startedAt ? dt(r.startedAt) : '—'} · took ${J.durationText(J.durationMs(r, now))}${r.error ? `\n${J.truncate(r.error, 160)}` : ''}`;
        kids.push(svg('rect', { x: X(b.x), y: y + 3, width: Math.max(2, b.w * PW), height: 12, rx: 2, style: { fill: fill[b.result] || 'var(--text-muted)' }, 'data-run': r.id, 'data-result': b.result || '' },
          svg('title', {}, tip)));
      }
      if (ln.next) kids.push(svg('rect', { x: X(1) + 1, y: y + 3, width: 6, height: 12, rx: 2, class: 'jg-next' }, svg('title', {}, `next run ${dt(ln.next.at)} (${J.relativeText(ln.next.at, now)})`)));
    });
    kids.push(svg('line', { x1: X(1), x2: X(1), y1: TOP - 4, y2: H - 10, class: 'jg-now' }));
    kids.push(svg('text', { x: X(1), y: H - 1, 'text-anchor': 'middle', class: 'jg-now-t' }, 'now'));
    const chart = svg('svg', { class: 'jg-runs', viewBox: `0 0 ${W + 10} ${H}`, role: 'img', 'aria-label': `Job runs over the last ${st.runRange}` }, ...kids);
    const key = (c, label, dash) => h('span.jg-key', h(`i${dash ? '.dash' : ''}`, { style: dash ? null : { background: c } }), label);
    const legend = h('div.jg-legend', key('var(--chart-good)', 'succeeded'), key('var(--chart-warn)', 'with warnings (deferred, skipped, cancelled)'),
      key('var(--chart-bad)', 'failed'), key('var(--chart-info)', 'running'), key(null, 'next run', true),
      st.runsCut ? h('span.muted', '· the oldest runs of the window were not read (more than six pages)') : null,
      st.runsErr ? h('span.jb-err', `· ${st.runsErr}`) : null);
    return card('runs', `Runs, last ${st.runRange}`, 'one lane per job · a bar per run, coloured by its result · dashed = next run · the run log keeps 50 runs a job',
      switcher('Runs time frame', G.RUN_RANGES, st.runRange, setRunRange), h('div.jg-chart', chart), legend);
  }

  /** The 24-hour success tile's figures, from the runs read (and the page's newest). */
  function day(list) {
    const now = Date.now();
    return st.runs ? G.successOf(allRuns(list), { from: now - G.rangeMs('24h'), now }) : null;
  }

  return { refresh, healthCard, appHealthCard, runsCard, day, state: st };
}
