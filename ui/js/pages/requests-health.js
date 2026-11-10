/**
 * Request Centre › ElasticPro health (docs/HEALTH.md): ElasticPro's own memory, CPU, response
 * time, request gate, poller, reports, disk and trends, with the amber/red checks first and
 * what fixes each. Drawn from one SYSTEM_HEALTH answer; it reads nothing else and sends no
 * cluster anything. The page (requests.js) owns the 5-s read and the tab bar.
 */

import { h, svg, reconcile, mount } from '../lib/dom.js';
import { num, dt, ago } from '../lib/fmt.js';
import { card, table, pill, empty, keptCard, keptTable } from './common.js';
import { tableSort } from '../lib/table-sort.js';
import { levelTone, levelWord, memoryLine, oomText, cpuLine, throttleLine, shareLine, sizeText, msText, pctText,
  trendSeries, sparkPath, problems, jobProgress, concurrencyText } from '../core/system-health.js';

const levelPill = (level) => pill(levelWord(level), levelTone(level));

/*
 * The tab is read every 5 s. Drawn into a cache (the page's nodeCache, passed to healthView),
 * every card, table and row is the one already on screen unless what it shows changed, so the
 * row under the mouse is not replaced, a hover tooltip stays open and a folded section stays
 * as it was left. Without a cache (a test drawing it once) it is built fresh.
 */
let C = null;
/** A card: kept (keptCard) under `key` while drawing into the cache, else card(). */
const K = (key, title, sub, body, actions) => (C ? keptCard(C, `hl:${key}`, title, sub, body, actions) : card(title, sub, body, actions));
/** A table: kept, its rows each kept while unchanged (keptTable), else table(). */
const T = (key, headers, rows, opts) => (C ? keptTable(C, `hl:${key}`, headers, C.sameAll(`hl:${key}:row`, rows), opts) : table(headers, rows, opts));
/** What redraws the page after a header is pressed (healthView's `redraw`). */
let R = () => {};
/**
 * A table whose heads sort (lib/table-sort.js): `cols` is `[label | {label, width}, sortKey | null,
 * { type, value(item) } | null]`, the items are put in the header's order (the core's own order
 * until one is pressed), then `limit`ed, then drawn by `row`.
 */
const ST = (key, cols, items, row, opts = {}) => {
  const sort = tableSort(`requests.health.${key}`, { onChange: () => R() });
  const spec = Object.fromEntries(cols.filter((c) => c[1]).map((c) => [c[1], c[2]]));
  const shown = sort.apply(items || [], spec).slice(0, opts.limit || Infinity);
  const headers = cols.map(([l, k]) => (typeof l === 'object' ? { ...l, sort: k } : { label: l, sort: k }));
  return T(key, headers, shown.map(row), { ...opts, sort });
};
const LEVEL_RANK = { bad: 3, warn: 2, ok: 1, off: 0 };
const msOf = (k) => ({ type: 'number', value: (x) => x[k] });
/** Two cards side by side, in a kept grid (a kept card must never go into a fresh element). */
const grid = (key, ...cards) => {
  if (!C) return h('div.hl-grid', ...cards);
  const g = C.get(`hl:grid:${key}`, '', () => h('div.hl-grid'));
  reconcile(g, cards);
  return g;
};
/** Which folds are open: kept here, so a redraw that rebuilds one draws it as it was left. */
const openFolds = new Set();
const fold = (id, summary, body) => {
  const make = () => h('details', {
    class: id === 'thresholds' ? 'hl-thresholds' : null, open: openFolds.has(id), dataset: { fold: id },
    ontoggle: (e) => { if (e.target.open) openFolds.add(id); else openFolds.delete(id); },
  }, h('summary', summary));
  if (!C) { const d = make(); d.append(body); return d; }
  const d = C.get(`hl:fold:${id}`, summary, make);
  reconcile(d, [d.firstChild, ...C.sameAll(`hl:fold:${id}:body`, [body])]);
  return d;
};

function bar(frac, level) {
  if (frac === null || frac === undefined) return h('div.hl-bar.unknown', h('i'));
  return h('div.hl-bar', { class: level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : 'ok' },
    h('i', { style: { width: `${Math.max(1.5, Math.min(100, frac * 100))}%` } }));
}

/**
 * The status strip: one chip per part; a part that cannot report says so. A chip's words
 * (the core's uptime, a heartbeat's age) change between reads; they are changed in place, so
 * the chip under the mouse and its tooltip stay.
 */
function strip(parts) {
  const chip = (p) => {
    const make = () => h('div.hl-chip', { role: 'listitem', dataset: { part: p.id, level: p.level } },
      h('i.hl-dot', { class: levelTone(p.level), 'aria-hidden': 'true' }), h('b', p.label), h('span.hl-chip-t'));
    const el = C ? C.get(`hl:chip:${p.id}`, `${p.level}|${p.label}`, make) : make();
    const words = `${p.text}${p.at && p.level !== 'off' ? ` · ${ago(p.at)}` : ''}`;
    const t = el.lastChild;
    if (t.textContent !== words) {
      t.replaceChildren(p.text, p.at && p.level !== 'off' ? h('span.muted', ` · ${ago(p.at)}`) : '');
    }
    if (el.title !== (p.text || '')) el.title = p.text || '';
    return el;
  };
  const chips = (parts || []).map(chip);
  if (!C) return h('div.hl-strip', { role: 'list', 'aria-label': 'ElasticPro parts' }, ...chips);
  const el = C.get('hl:strip', '', () => h('div.hl-strip', { role: 'list', 'aria-label': 'ElasticPro parts' }));
  reconcile(el, chips);
  return el;
}

function checksCard(snap) {
  const bad = problems(snap.checks);
  const row = (c) => h('tr', { class: c.level === 'bad' || c.level === 'warn' ? `hl-row-${c.level}` : '', dataset: { check: c.id } },
    h('td', h('b', c.label)),
    h('td', levelPill(c.level)),
    h('td.mono', c.value),
    h('td', h('div', c.text), c.fix ? h('div.hl-fix', h('b', 'Fix: '), c.fix) : null));
  const text = (k) => ({ type: 'text', value: (x) => x[k] });
  const thresholds = fold('thresholds', 'Thresholds',
    ST('thresholds', [['Check', 'check', text('check')], ['Amber', 'amber', text('amber')], ['Red', 'red', text('red')]], snap.thresholds,
      (t) => h('tr', h('td', t.check), h('td', t.amber), h('td', t.red))));
  const sub = bad.length ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention` : 'all within their thresholds';
  return K('checks', 'Checks', sub, [ST('checks', [[{ label: 'Check', width: '22%' }, 'label', text('label')],
    [{ label: 'Status', width: '96px' }, 'level', { type: 'number', value: (c) => (c.level in LEVEL_RANK ? LEVEL_RANK[c.level] : null), start: -1 }],
    [{ label: 'Value', width: '22%' }, 'value', text('value')], ['What it means', 'text', text('text')]], snap.checks, row), thresholds]);
}

function memoryCard(snap) {
  const core = snap.core || {};
  const w = snap.worker && snap.worker.status;
  const check = (id) => (snap.checks || []).find((c) => c.id === id);
  const row = (who, m, id) => {
    const line = memoryLine(m);
    return h('tr', h('td', h('b', who)), h('td', bar(line.frac, (check(id) || {}).level), h('div.hl-sub', line.text)),
      h('td.mono', sizeText(m && m.peakBytes24h)), h('td.mono', oomText(m)));
  };
  const rows = [row('Core', core.memory, 'core.memory')];
  rows.push(w ? row('Worker', w.memory, 'worker.memory')
    : h('tr', h('td', h('b', 'Worker')), h('td', { colspan: 3 }, h('span.muted', snap.worker ? snap.worker.text : 'not known'))));
  const b = core.budget || {};
  const budget = T('budget', ['Share of the core’s budget', 'Used of budget'], [
    h('tr', h('td', 'Fleet cache'), h('td.mono', shareLine(b.cache))),
    h('tr', h('td', 'In flight (response bodies)'), h('td.mono', shareLine(b.inflight))),
    h('tr', h('td', 'Read cache'), h('td.mono', shareLine(b.readCache))),
    h('tr', h('td', 'Reports share'), h('td', b.reports ? h('span.mono', shareLine(b.reports)) : h('span.muted', 'not known — this core has no reports share'))),
  ]);
  return K('memory', 'Memory', `resident against the container limit · limit read from ${(core.memory && core.memory.limitSource) || 'not known'}`, [
    T('memory', [{ label: '', width: '80px' }, 'Resident of limit', { label: 'Peak 24 h', width: '110px' }, { label: 'OOM kills', width: '120px' }], rows),
    b.warning ? h('div.banner.warn', h('div', b.warning)) : null,
    budget]);
}

function cpuCard(snap) {
  const core = snap.core || {};
  const w = snap.worker && snap.worker.status;
  const row = (who, c) => h('tr', h('td', h('b', who)), h('td', cpuLine(c)), h('td', throttleLine(c)),
    h('td.mono', c && c.nrThrottled !== null && c.nrThrottled !== undefined ? `${num(c.nrThrottled)} of ${num(c.nrPeriods)}` : '—'),
    h('td.mono', c && c.throttledUsec !== null && c.throttledUsec !== undefined ? msText(c.throttledUsec / 1000) : '—'));
  return K('cpu', 'CPU', 'throttling is what makes a capped container slow', T('cpu',
    [{ label: '', width: '80px' }, 'Last minute', 'Throttled (5 min)', 'Periods throttled', 'Time throttled'],
    [row('Core', core.cpu), w ? row('Worker', w.cpu) : h('tr', h('td', h('b', 'Worker')), h('td', { colspan: 4 }, h('span.muted', snap.worker ? snap.worker.text : 'not known')))]));
}

function timesCard(snap) {
  const m = (snap.core && snap.core.messages) || {};
  const line = (label, s) => h('tr', h('td', label), h('td.mono', msText(s && s.p50Ms)), h('td.mono', msText(s && s.p95Ms)), h('td.mono', msText(s && s.p99Ms)),
    h('td.mono', num((s && s.count) || 0)), h('td.mono', (s && s.errors) ? pill(num(s.errors), 'red') : '0'));
  const head = [{ label: '', width: '34%' }, 'p50', 'p95', 'p99', 'Count', 'Errors'];
  const summary = T('times', head, [
    line('All types, 5 min', m.w5m && m.w5m.all), line('All types, 1 h', m.w1h && m.w1h.all),
    line('The core’s own, 5 min', m.w5m && m.w5m.own), line('The core’s own, 1 h', m.w1h && m.w1h.own)]);
  const typeCols = (first) => [[first, 'type', { type: 'text', value: (t) => t.type }], ['p50', 'p50', msOf('p50Ms')], ['p95', 'p95', msOf('p95Ms')],
    ['p99', 'p99', msOf('p99Ms')], ['Count', 'count', { type: 'number', value: (t) => t.count || 0 }], ['Errors', 'errors', { type: 'number', value: (t) => t.errors || 0 }]];
  const slowest = ST('slowest', typeCols('Slowest types (5 min)'), m.slowest, (t) => line(h('span.mono', t.type), t), { emptyText: 'no messages in 5 min' });
  const all = fold('types', `Every type (1 h, ${((m.w1h && m.w1h.byType) || []).length})`,
    ST('types', typeCols('Type'), (m.w1h && m.w1h.byType) || [], (t) => line(h('span.mono', t.type), t)));
  return K('times', 'Response time', `the core’s handling time per message · ${num(m.sessions || 0)} sessions · ${num(m.eventStreams || 0)} event streams open`,
    [summary, slowest, all,
      h('p.muted.hl-note', '“Own” leaves out messages that wait on a cluster, Zabbix, mail or a password hash; the p95 check reads it. Percentiles are bucket bounds.')]);
}

function gateTables(g, who) {
  if (!g) return [h('p.muted', 'not known')];
  const n = (k) => ({ type: 'number', value: (x) => x[k] });
  const classes = ST(`gate-classes-${who}`, [['Class', 'class', { type: 'text', value: (c) => c.class }], ['In use', 'running', n('running')], ['Waiting', 'waiting', n('waiting')],
    ['Wait p95 (5 min)', 'waitP95', n('waitP95Ms')], ['Overloaded 5 min / 1 h', 'overloaded', n('overloaded5m')], ['Queue timeout 5 min / 1 h', 'queueTimeout', n('queueTimeout5m')]],
    g.classes, (c) => h('tr', h('td', c.class), h('td.mono', num(c.running)), h('td.mono', c.waiting ? pill(num(c.waiting), 'grey') : '0'),
      h('td.mono', msText(c.waitP95Ms)),
      h('td.mono', `${num(c.overloaded5m)} / ${c.overloaded1h === null || c.overloaded1h === undefined ? '—' : num(c.overloaded1h)}`),
      h('td.mono', `${num(c.queueTimeout5m)} / ${c.queueTimeout1h === null || c.queueTimeout1h === undefined ? '—' : num(c.queueTimeout1h)}`)));
  // The first 15 in the header's order (the core's busiest-first until one is pressed).
  const clusters = ST(`gate-clusters-${who}`, [['Cluster', 'cluster', { type: 'text', value: (c) => c.cluster }], ['In use', 'running', n('running')], ['Waiting', 'waiting', n('waiting')],
    ['Sent (5 min)', 'sent', n('sent5m')], ['Upstream p95', 'upstream', n('upstreamP95Ms')], ['Timeouts', 'timeouts', n('timeouts5m')], ['429s', 'rejected', n('rejected5m')]],
    g.clusters, (c) => h('tr', h('td', h('b', c.cluster)), h('td.mono', num(c.running)), h('td.mono', num(c.waiting)), h('td.mono', num(c.sent5m)),
      h('td.mono', msText(c.upstreamP95Ms)), h('td.mono', c.timeouts5m ? pill(num(c.timeouts5m), 'red') : '0'), h('td.mono', c.rejected5m ? pill(num(c.rejected5m), 'yellow') : '0')),
    { emptyText: 'no cluster asked in 5 min', limit: 15 });
  return [h('div.hl-sub', `${num(g.slotsInUse)} of ${num(g.slots)} slots in use · ${num(g.perCluster)} per cluster · ${num(g.perJump)} per jump host · ${num(g.backgroundReserve)} kept for background`),
    classes, clusters];
}

function gateCard(snap) {
  const w = snap.worker && snap.worker.status;
  return K('gate', 'Request gate', 'every request to Elasticsearch waits here for a slot', [
    ...gateTables(snap.core && snap.core.gate, 'core'),
    w && w.gate ? [h('h3.hl-h3', 'worker'), ...gateTables(w.gate, 'worker')] : null]);
}

function pollerCard(snap) {
  const p = (snap.core && snap.core.poller) || {};
  const f = (k, v, d) => h('div.hl-fig', h('div.k', k), h('div.v', v), d ? h('div.d', d) : null);
  return K('poller', 'Fleet poller', p.enabled ? (p.stopped ? 'held by the emergency stop' : 'running') : 'not running in this process', h('div.hl-figs',
    f('Datasets due', num(p.due || 0), `of ${num(p.tracked || 0)} scheduled`),
    f('Late', p.latePct === null || p.latePct === undefined ? '—' : `${num(p.late)} · ${pctText(p.latePct)}`, p.lateByMaxMs ? `worst by ${msText(p.lateByMaxMs)}` : 'more than 30 s past due'),
    f('Cycle time', msText(p.cycleMs), `p95 ${msText(p.cycleP95Ms)} (5 min)`),
    f('Clusters down', `${num(p.down || 0)} of ${num(p.clusters || 0)}`)));
}

function reportsCard(snap) {
  const r = snap.reports || {};
  const t = (f) => ({ type: 'text', value: f });
  const done = (x) => (x.progress && x.progress.total ? x.progress.done / x.progress.total : null);
  const running = ST('running', [['Job', 'kind', t((j) => j.kind || 'volume')], ['Cluster', 'cluster', t((j) => j.clusterName || j.clusterId)],
    ['Progress', 'progress', { type: 'number', value: done }], ['Concurrency', 'concurrency', t((j) => concurrencyText(j))], ['Started', 'started', { type: 'date', value: (j) => j.startedAt || null }]],
  r.running, (j) => h('tr',
    h('td', h('span.mono', j.kind || 'volume'), h('div.hl-sub', j.by || '')),
    h('td', j.clusterName || j.clusterId || '—'),
    h('td', jobProgress(j) || '—'),
    h('td', concurrencyText(j)),
    h('td', j.startedAt ? ago(j.startedAt) : '—')), { emptyText: 'nothing running' });
  const coll = (r.collection || []).length ? ST('collection', [['Collecting', 'cluster', t((c) => c.clusterId)], ['Kind', 'kind', t((c) => c.kind)],
    ['Progress', 'progress', { type: 'number', value: done }], ['Concurrency', 'concurrency', t((c) => concurrencyText(c))]], r.collection, (c) => h('tr',
    h('td', c.clusterId), h('td', c.kind), h('td.mono', c.progress && c.progress.total ? `${c.progress.done}/${c.progress.total}` : '—'),
    h('td', concurrencyText(c)))) : null;
  const last = r.lastJob || {};
  const sched = ST('schedules', [['Kind', 'kind', t((s) => s.kind)], ['Schedule', 'schedule', t((s) => (s.enabled ? `${s.cadence || ''} ${s.at || ''}` : null))],
    ['Next run', 'next', t((s) => s.nextAt || null)], ['Last send', 'lastSend', { type: 'date', value: (s) => (s.lastSent ? s.lastSent.at : null) }],
    ['Last job', 'lastJob', t((s) => (last[s.kind] ? last[s.kind].status : null))]], r.schedules, (s) => {
    const ls = s.lastSent;
    const lj = last[s.kind];
    return h('tr', h('td', h('b', s.kind)),
      h('td', s.enabled ? `${s.cadence || '—'} at ${s.at || '—'} · ${num(s.recipients)} recipient(s)` : h('span.muted', 'off')),
      h('td', s.nextAt || h('span.muted', 'not scheduled')),
      h('td', ls ? [ls.ok ? pill('sent', 'green') : pill('failed', 'red'), ` ${dt(ls.at)}`, ls.error ? h('div.hl-sub', ls.error) : null] : h('span.muted', 'never')),
      h('td', lj ? [pill(lj.status, lj.status === 'done' ? 'green' : lj.status === 'failed' ? 'red' : 'grey'), lj.endedAt ? ` ${ago(lj.endedAt)}` : '', lj.error ? h('div.hl-sub', lj.error) : null] : h('span.muted', 'none kept')));
  }, { emptyText: 'no schedule file' });
  return K('reports', 'Reports and collection', `${num((r.running || []).length)} running · ${num(r.queued || 0)} queued · from ${r.source || 'not known'}`, [running, coll, sched]);
}

function diskCard(snap) {
  const d = snap.core && snap.core.disk;
  if (!d) return K('disk', 'Disk', 'the data volume', empty('Not known — this core has no data directory.'));
  const check = (snap.checks || []).find((c) => c.id === 'disk.free');
  const used = d.totalBytes ? d.usedBytes / d.totalBytes : null;
  const prune = snap.core.lastPrune;
  return K('disk', 'Disk', d.path || 'the data volume', [
    bar(used, check && check.level),
    h('div.hl-sub', d.totalBytes ? `${sizeText(d.usedBytes)} used · ${sizeText(d.freeBytes)} free (${pctText(d.freePct)}) of ${sizeText(d.totalBytes)}` : 'space not known (no statvfs here)'),
    ST('areas', [['Area', 'label', { type: 'text', value: (a) => a.label }], ['Size', 'bytes', { type: 'bytes', value: (a) => a.bytes }], ['Files', 'files', { type: 'number', value: (a) => a.files }]],
      d.areas, (a) => h('tr', h('td', a.label), h('td.mono', `${a.atLeast ? 'at least ' : ''}${sizeText(a.bytes)}`), h('td.mono', num(a.files)))),
    h('div.hl-sub', d.areasAt ? `areas measured ${ago(d.areasAt)}` : 'areas not measured yet',
      ' · last prune: ', prune ? `${ago(prune.finishedAt || prune.startedAt)}${prune.dryRun ? ' (dry run)' : ''}` : 'none since start')]);
}

function spark(label, series, fmt, now) {
  const W = 160, H = 28;
  const pts = sparkPath(series, { w: W, h: H, now });
  const last = series.length ? series[series.length - 1][1] : null;
  const peak = series.length ? Math.max(...series.map((p) => p[1])) : null;
  return h('div.hl-spark',
    h('div.k', label),
    pts ? svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': `${label}, last 24 hours` },
      svg('polyline', { points: pts, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '1.5' })) : h('div.hl-spark-empty', 'not enough samples yet'),
    h('div.d', last === null ? 'not known' : `now ${fmt(last)} · peak ${fmt(peak)}`));
}

function trendsCard(snap) {
  const t = snap.trends;
  // to the minute: the samples are a minute apart, so the lines move once a minute, not every read
  const now = Math.floor((snap.at || Date.now()) / 60000) * 60000;
  return K('trends', 'Trends', '24 h, one sample a minute · kept across a restart', h('div.hl-sparks',
    spark('Core memory', trendSeries(t, 'rss'), sizeText, now),
    spark('Message p95', trendSeries(t, 'p95Ms'), msText, now),
    spark('Gate waiting', trendSeries(t, 'waiting'), (v) => num(v), now),
    spark('Worker memory', trendSeries(t, 'workerRss'), sizeText, now),
    spark('Report concurrency', trendSeries(t, 'workerConcurrency'), (v) => num(v), now)));
}

/** The line at the top: its level and wording kept, the time of the read changed in place. */
function head(snap) {
  const words = snap.level === 'ok' ? ' Nothing needs attention.' : ' Something needs attention — see Checks.';
  const read = ` · role ${snap.role} · read ${dt(snap.at)} · every 5 s while this tab is open · no cluster is asked`;
  const make = () => h('div.hl-head', levelPill(snap.level), h('span', words), h('span.muted.hl-read'));
  const el = C ? C.get('hl:head', `${snap.level}`, make) : make();
  const r = el.lastChild;
  if (r.textContent !== read) r.textContent = read;
  return el;
}

/**
 * The tab's body. `snap`: SYSTEM_HEALTH's answer, or null before the first one; `error`: why
 * the last read failed; `cache`: the page's nodeCache (lib/keyed.js), between its begin() and
 * end(), to keep what did not change from one read to the next — the tab is then one kept
 * element.
 */
export function healthView(snap, { error = null, cache = null, redraw = null } = {}) {
  if (redraw) R = redraw;
  if (!snap) {
    return h('div.hl-page', error ? h('div.banner.err', h('div', h('div.ttl', 'Could not read ElasticPro health'), h('div', error)))
      : h('p.muted', 'Reading ElasticPro health…'));
  }
  C = cache;
  try {
    const kids = [
      error ? h('div.banner.err', h('div', h('div.ttl', 'Could not read ElasticPro health — showing the last answer'), h('div', error))) : null,
      head(snap),
      strip(snap.parts),
      checksCard(snap),
      grid('mem', memoryCard(snap), cpuCard(snap)),
      timesCard(snap),
      gateCard(snap),
      grid('poll', pollerCard(snap), diskCard(snap)),
      reportsCard(snap),
      trendsCard(snap)];
    if (!C) return h('div.hl-page', ...kids);
    const page = C.get('hl:page', '', () => h('div.hl-page'));
    mount(page, ...C.sameAll('hl:top', kids));
    return page;
  } finally {
    C = null;
  }
}
