/**
 * Request Centre › ElasticPro health (docs/HEALTH.md): ElasticPro's own memory, CPU, response
 * time, request gate, poller, reports, disk and trends, with the amber/red checks first and
 * what fixes each. Drawn from one SYSTEM_HEALTH answer; it reads nothing else and sends no
 * cluster anything. The page (requests.js) owns the 5-s read and the tab bar.
 */

import { h, svg } from '../lib/dom.js';
import { num, dt, ago } from '../lib/fmt.js';
import { card, table, pill, empty } from './common.js';
import { levelTone, levelWord, memoryLine, oomText, cpuLine, throttleLine, shareLine, sizeText, msText, pctText,
  trendSeries, sparkPath, problems, jobProgress, concurrencyText } from '../core/system-health.js';

const levelPill = (level) => pill(levelWord(level), levelTone(level));

function bar(frac, level) {
  if (frac === null || frac === undefined) return h('div.hl-bar.unknown', h('i'));
  return h('div.hl-bar', { class: level === 'bad' ? 'bad' : level === 'warn' ? 'warn' : 'ok' },
    h('i', { style: { width: `${Math.max(1.5, Math.min(100, frac * 100))}%` } }));
}

/** The status strip: one chip per part; a part that cannot report says so. */
function strip(parts) {
  return h('div.hl-strip', { role: 'list', 'aria-label': 'ElasticPro parts' },
    ...(parts || []).map((p) => h('div.hl-chip', { role: 'listitem', dataset: { part: p.id, level: p.level }, title: p.text },
      h('i.hl-dot', { class: levelTone(p.level), 'aria-hidden': 'true' }),
      h('b', p.label),
      h('span.hl-chip-t', p.text, p.at && p.level !== 'off' ? h('span.muted', ` · ${ago(p.at)}`) : null))));
}

function checksCard(snap) {
  const bad = problems(snap.checks);
  const rows = (snap.checks || []).map((c) => h('tr', { class: c.level === 'bad' || c.level === 'warn' ? `hl-row-${c.level}` : '', dataset: { check: c.id } },
    h('td', h('b', c.label)),
    h('td', levelPill(c.level)),
    h('td.mono', c.value),
    h('td', h('div', c.text), c.fix ? h('div.hl-fix', h('b', 'Fix: '), c.fix) : null)));
  const thresholds = h('details.hl-thresholds', h('summary', 'Thresholds'),
    table(['Check', 'Amber', 'Red'], (snap.thresholds || []).map((t) => h('tr', h('td', t.check), h('td', t.amber), h('td', t.red)))));
  const sub = bad.length ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention` : 'all within their thresholds';
  return card('Checks', sub, [table([{ label: 'Check', width: '22%' }, { label: 'Status', width: '96px' }, { label: 'Value', width: '22%' }, 'What it means'], rows), thresholds]);
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
  const budget = table(['Share of the core’s budget', 'Used of budget'], [
    h('tr', h('td', 'Fleet cache'), h('td.mono', shareLine(b.cache))),
    h('tr', h('td', 'In flight (response bodies)'), h('td.mono', shareLine(b.inflight))),
    h('tr', h('td', 'Read cache'), h('td.mono', shareLine(b.readCache))),
    h('tr', h('td', 'Reports share'), h('td', b.reports ? h('span.mono', shareLine(b.reports)) : h('span.muted', 'not known — this core has no reports share'))),
  ]);
  return card('Memory', `resident against the container limit · limit read from ${(core.memory && core.memory.limitSource) || 'not known'}`, [
    table([{ label: '', width: '80px' }, 'Resident of limit', { label: 'Peak 24 h', width: '110px' }, { label: 'OOM kills', width: '120px' }], rows),
    b.warning ? h('div.banner.warn', h('div', b.warning)) : null,
    budget]);
}

function cpuCard(snap) {
  const core = snap.core || {};
  const w = snap.worker && snap.worker.status;
  const row = (who, c) => h('tr', h('td', h('b', who)), h('td', cpuLine(c)), h('td', throttleLine(c)),
    h('td.mono', c && c.nrThrottled !== null && c.nrThrottled !== undefined ? `${num(c.nrThrottled)} of ${num(c.nrPeriods)}` : '—'),
    h('td.mono', c && c.throttledUsec !== null && c.throttledUsec !== undefined ? msText(c.throttledUsec / 1000) : '—'));
  return card('CPU', 'throttling is what makes a capped container slow', table(
    [{ label: '', width: '80px' }, 'Last minute', 'Throttled (5 min)', 'Periods throttled', 'Time throttled'],
    [row('Core', core.cpu), w ? row('Worker', w.cpu) : h('tr', h('td', h('b', 'Worker')), h('td', { colspan: 4 }, h('span.muted', snap.worker ? snap.worker.text : 'not known')))]));
}

function timesCard(snap) {
  const m = (snap.core && snap.core.messages) || {};
  const line = (label, s) => h('tr', h('td', label), h('td.mono', msText(s && s.p50Ms)), h('td.mono', msText(s && s.p95Ms)), h('td.mono', msText(s && s.p99Ms)),
    h('td.mono', num((s && s.count) || 0)), h('td.mono', (s && s.errors) ? pill(num(s.errors), 'red') : '0'));
  const head = [{ label: '', width: '34%' }, 'p50', 'p95', 'p99', 'Count', 'Errors'];
  const summary = table(head, [
    line('All types, 5 min', m.w5m && m.w5m.all), line('All types, 1 h', m.w1h && m.w1h.all),
    line('The core’s own, 5 min', m.w5m && m.w5m.own), line('The core’s own, 1 h', m.w1h && m.w1h.own)]);
  const slowest = table(['Slowest types (5 min)', 'p50', 'p95', 'p99', 'Count', 'Errors'],
    (m.slowest || []).map((t) => line(h('span.mono', t.type), t)), { emptyText: 'no messages in 5 min' });
  const all = h('details', h('summary', `Every type (1 h, ${((m.w1h && m.w1h.byType) || []).length})`),
    table(['Type', 'p50', 'p95', 'p99', 'Count', 'Errors'], ((m.w1h && m.w1h.byType) || []).map((t) => line(h('span.mono', t.type), t))));
  return card('Response time', `the core’s handling time per message · ${num(m.sessions || 0)} sessions · ${num(m.eventStreams || 0)} event streams open`,
    [summary, slowest, all,
      h('p.muted.hl-note', '“Own” leaves out messages that wait on a cluster, Zabbix, mail or a password hash; the p95 check reads it. Percentiles are bucket bounds.')]);
}

function gateTables(g) {
  if (!g) return [h('p.muted', 'not known')];
  const classes = table(['Class', 'In use', 'Waiting', 'Wait p95 (5 min)', 'Overloaded 5 min / 1 h', 'Queue timeout 5 min / 1 h'],
    (g.classes || []).map((c) => h('tr', h('td', c.class), h('td.mono', num(c.running)), h('td.mono', c.waiting ? pill(num(c.waiting), 'grey') : '0'),
      h('td.mono', msText(c.waitP95Ms)),
      h('td.mono', `${num(c.overloaded5m)} / ${c.overloaded1h === null || c.overloaded1h === undefined ? '—' : num(c.overloaded1h)}`),
      h('td.mono', `${num(c.queueTimeout5m)} / ${c.queueTimeout1h === null || c.queueTimeout1h === undefined ? '—' : num(c.queueTimeout1h)}`))));
  const clusters = table(['Cluster', 'In use', 'Waiting', 'Sent (5 min)', 'Upstream p95', 'Timeouts', '429s'],
    (g.clusters || []).slice(0, 15).map((c) => h('tr', h('td', h('b', c.cluster)), h('td.mono', num(c.running)), h('td.mono', num(c.waiting)), h('td.mono', num(c.sent5m)),
      h('td.mono', msText(c.upstreamP95Ms)), h('td.mono', c.timeouts5m ? pill(num(c.timeouts5m), 'red') : '0'), h('td.mono', c.rejected5m ? pill(num(c.rejected5m), 'yellow') : '0'))),
    { emptyText: 'no cluster asked in 5 min' });
  return [h('div.hl-sub', `${num(g.slotsInUse)} of ${num(g.slots)} slots in use · ${num(g.perCluster)} per cluster · ${num(g.perJump)} per jump host · ${num(g.backgroundReserve)} kept for background`),
    classes, clusters];
}

function gateCard(snap) {
  const w = snap.worker && snap.worker.status;
  return card('Request gate', 'every request to Elasticsearch waits here for a slot', [
    ...gateTables(snap.core && snap.core.gate),
    w && w.gate ? [h('h3.hl-h3', 'worker'), ...gateTables(w.gate)] : null]);
}

function pollerCard(snap) {
  const p = (snap.core && snap.core.poller) || {};
  const f = (k, v, d) => h('div.hl-fig', h('div.k', k), h('div.v', v), d ? h('div.d', d) : null);
  return card('Fleet poller', p.enabled ? (p.stopped ? 'held by the emergency stop' : 'running') : 'not running in this process', h('div.hl-figs',
    f('Datasets due', num(p.due || 0), `of ${num(p.tracked || 0)} scheduled`),
    f('Late', p.latePct === null || p.latePct === undefined ? '—' : `${num(p.late)} · ${pctText(p.latePct)}`, p.lateByMaxMs ? `worst by ${msText(p.lateByMaxMs)}` : 'more than 30 s past due'),
    f('Cycle time', msText(p.cycleMs), `p95 ${msText(p.cycleP95Ms)} (5 min)`),
    f('Clusters down', `${num(p.down || 0)} of ${num(p.clusters || 0)}`)));
}

function reportsCard(snap) {
  const r = snap.reports || {};
  const running = table(['Job', 'Cluster', 'Progress', 'Concurrency', 'Started'], (r.running || []).map((j) => h('tr',
    h('td', h('span.mono', j.kind || 'volume'), h('div.hl-sub', j.by || '')),
    h('td', j.clusterName || j.clusterId || '—'),
    h('td', jobProgress(j) || '—'),
    h('td', concurrencyText(j)),
    h('td', j.startedAt ? ago(j.startedAt) : '—'))), { emptyText: 'nothing running' });
  const coll = (r.collection || []).length ? table(['Collecting', 'Kind', 'Progress', 'Concurrency'], r.collection.map((c) => h('tr',
    h('td', c.clusterId), h('td', c.kind), h('td.mono', c.progress && c.progress.total ? `${c.progress.done}/${c.progress.total}` : '—'),
    h('td', concurrencyText(c))))) : null;
  const last = r.lastJob || {};
  const sched = table(['Kind', 'Schedule', 'Next run', 'Last send', 'Last job'], (r.schedules || []).map((s) => {
    const ls = s.lastSent;
    const lj = last[s.kind];
    return h('tr', h('td', h('b', s.kind)),
      h('td', s.enabled ? `${s.cadence || '—'} at ${s.at || '—'} · ${num(s.recipients)} recipient(s)` : h('span.muted', 'off')),
      h('td', s.nextAt || h('span.muted', 'not scheduled')),
      h('td', ls ? [ls.ok ? pill('sent', 'green') : pill('failed', 'red'), ` ${dt(ls.at)}`, ls.error ? h('div.hl-sub', ls.error) : null] : h('span.muted', 'never')),
      h('td', lj ? [pill(lj.status, lj.status === 'done' ? 'green' : lj.status === 'failed' ? 'red' : 'grey'), lj.endedAt ? ` ${ago(lj.endedAt)}` : '', lj.error ? h('div.hl-sub', lj.error) : null] : h('span.muted', 'none kept')));
  }), { emptyText: 'no schedule file' });
  return card('Reports and collection', `${num((r.running || []).length)} running · ${num(r.queued || 0)} queued · from ${r.source || 'not known'}`, [running, coll, sched]);
}

function diskCard(snap) {
  const d = snap.core && snap.core.disk;
  if (!d) return card('Disk', 'the data volume', empty('Not known — this core has no data directory.'));
  const check = (snap.checks || []).find((c) => c.id === 'disk.free');
  const used = d.totalBytes ? d.usedBytes / d.totalBytes : null;
  const prune = snap.core.lastPrune;
  return card('Disk', d.path || 'the data volume', [
    bar(used, check && check.level),
    h('div.hl-sub', d.totalBytes ? `${sizeText(d.usedBytes)} used · ${sizeText(d.freeBytes)} free (${pctText(d.freePct)}) of ${sizeText(d.totalBytes)}` : 'space not known (no statvfs here)'),
    table(['Area', 'Size', 'Files'], (d.areas || []).map((a) => h('tr', h('td', a.label), h('td.mono', `${a.atLeast ? 'at least ' : ''}${sizeText(a.bytes)}`), h('td.mono', num(a.files))))),
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
  const now = snap.at || Date.now();
  return card('Trends', '24 h, one sample a minute · kept across a restart', h('div.hl-sparks',
    spark('Core memory', trendSeries(t, 'rss'), sizeText, now),
    spark('Message p95', trendSeries(t, 'p95Ms'), msText, now),
    spark('Gate waiting', trendSeries(t, 'waiting'), (v) => num(v), now),
    spark('Worker memory', trendSeries(t, 'workerRss'), sizeText, now),
    spark('Report concurrency', trendSeries(t, 'workerConcurrency'), (v) => num(v), now)));
}

/**
 * The tab's body. `snap`: SYSTEM_HEALTH's answer, or null before the first one; `error`: why
 * the last read failed.
 */
export function healthView(snap, { error = null } = {}) {
  if (!snap) {
    return h('div.hl-page', error ? h('div.banner.err', h('div', h('div.ttl', 'Could not read ElasticPro health'), h('div', error)))
      : h('p.muted', 'Reading ElasticPro health…'));
  }
  return h('div.hl-page',
    error ? h('div.banner.err', h('div', h('div.ttl', 'Could not read ElasticPro health — showing the last answer'), h('div', error))) : null,
    h('div.hl-head', levelPill(snap.level), h('span', snap.level === 'ok' ? ' Nothing needs attention.' : ' Something needs attention — see Checks.'),
      h('span.muted', ` · role ${snap.role} · read ${dt(snap.at)} · every 5 s while this tab is open · no cluster is asked`)),
    strip(snap.parts),
    checksCard(snap),
    h('div.hl-grid', memoryCard(snap), cpuCard(snap)),
    timesCard(snap),
    gateCard(snap),
    h('div.hl-grid', pollerCard(snap), diskCard(snap)),
    reportsCard(snap),
    trendsCard(snap));
}
