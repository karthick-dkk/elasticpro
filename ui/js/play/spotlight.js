/**
 * Slide 3, the cluster spotlight: clusters with a critical problem (play/status.js
 * spotlightReasons) join by themselves and leave 10 minutes after their last one clears.
 * One cluster at a time, `perClusterSec` each; its volume chart cycles 7 → 15 → 30 days
 * (3 s / 5 s / 5 s). Every figure is an existing one: the node table's columns (as the
 * Clusters page), lifecycleView for ILM / SLM, the snapshot rows, the volume record.
 */

import { h } from '../lib/dom.js';
import { bytes, num, ago } from '../lib/fmt.js';
import { lineChart, signedPct } from '../lib/charts.js';
import { alertCounts } from '../core/alert-tuning.js';
import { lifecycleView } from '../core/lifecycle-errors.js';
import { clusterKind, slmExempt } from '../core/cluster-kind.js';
import { nodeLoadLevel } from '../pages/overview.js';
import { cardValue, dailyPoints, BASIS_LABEL, basisOf, NEEDS_VERSION } from '../core/volume-daily.js';
import { kpi, unknown, minutes, fitRows, openFor, pillEl } from './parts.js';
import { SPOTLIGHT_WHY } from './status.js';
import { lastGood, listingState, endOf } from './snapshots.js';
import { totalEvents, yesterdayRow } from './volume.js';
import { spotlightPhase } from './engine.js';

export const id = 'spotlight';
export const title = 'Cluster spotlight';
export const DATASETS = ['health', 'nodes', 'policies', 'snapshots', 'ilm_assign'];

export const isEmpty = (ctx) => !ctx.spot.order.length && ctx.watch.spotlight.whenEmpty !== 'allHealthy';

const LEVEL_TONE = { high: 'red', low: 'yellow', ok: 'green' };

function chips(ctx, currentId) {
  return h('div.pl-chips', h('span.pl-chiplabel', 'In the spotlight'),
    ...ctx.spot.order.map((cid) => {
      const m = ctx.spot.members.get(cid);
      const c = ctx.clusters.find((x) => x.id === cid);
      return h(`span.pl-chip${cid === currentId ? '.on' : ''}${m && m.clearing ? '.clearing' : ''}`,
        h('b', c ? c.name : cid),
        m && m.why.length ? ` · ${m.why.map((w) => SPOTLIGHT_WHY[w] || w).join(', ')}` : m && m.clearing ? ' · cleared' : '',
        m ? h('span.pl-since', ` · ${openFor(ctx.now - m.since)}`) : null);
    }));
}

function nodesTable(ctx, d, fullest) {
  const disk = new Map(((fullest && fullest.nodes) || []).map((n) => [n.name, n]));
  const nodes = [...(d.nodes || [])].sort((a, b) => ((disk.get(b.name) || {}).pct || -1) - ((disk.get(a.name) || {}).pct || -1)
    || String(a.name).localeCompare(String(b.name)));
  const bar = (p, tone) => h('span.pl-bar', h(`i.${tone}`, { style: { width: `${Math.max(2, Math.min(100, p))}%` } }));
  const pctCell = (p, tone) => (isFinite(p) ? h('span.pl-pc', bar(p, tone), h(`b.${tone}`, `${Math.round(p)} %`)) : unknown('–'));
  const rows = nodes.map((n) => {
    const dn = disk.get(n.name);
    const dt = dn ? (dn.pct >= fullest.high ? 'red' : dn.pct >= fullest.low ? 'yellow' : 'green') : 'grey';
    const heap = Number(n['heap.percent']), cpu = Number(n.cpu);
    return h('tr', h('td.pl-node', n.name, String(n.master || '').trim() === '*' ? ' ★' : ''),
      h('td', dn ? pctCell(dn.pct, dt) : h('span.pl-unk', 'no data role')),
      h('td', pctCell(heap, LEVEL_TONE[nodeLoadLevel(heap, 'heap')])),
      h('td', pctCell(cpu, LEVEL_TONE[nodeLoadLevel(cpu, 'cpu')])));
  });
  const body = h('tbody', rows.length ? rows : h('tr', h('td', { colSpan: 4 }, h('span.pl-unk', 'no node list'))));
  const box = h('div.pl-nodes', h('table.pl-tbl', h('thead', h('tr', h('th', 'Node'), h('th', 'Disk'), h('th', 'Heap'), h('th', 'CPU'))), body));
  ctx.afterMount(() => fitRows(box, rows, (k) => h('div.pl-more', `+${k} more nodes`)));
  return box;
}

function chart(ctx, cid, days) {
  const v = ctx.volume.get(cid);
  if (!v || v.unsupported) return h('div.pl-chart', unknown(v && v.unsupported ? `no daily record on this server (needs ${NEEDS_VERSION})` : 'no data'));
  if (!v.reply) return h('div.pl-chart', unknown(v.error || 'no data'));
  const basis = basisOf(v.reply.settings);
  const points = dailyPoints(v.reply).slice(-days);
  return h('div.pl-chart',
    h('div.pl-chead', h('b', `${BASIS_LABEL[basis]} per day · ${days} days`),
      h('span.pl-cdots', ...[7, 15, 30].map((x) => h(`i${x === days ? '.on' : ''}`, `${x}d`))),
      h('span.pl-clegend', h('i.pl-sw-avg'), '7-day average')),
    lineChart(points, { height: 230, yLabel: BASIS_LABEL[basis], avgLabel: '7-day average', emptyText: 'No finished day recorded yet' }));
}

function panel(ctx, c, days) {
  const d = ctx.data(c.id) || {};
  const s = ctx.st.get(c.id);
  const open = ctx.openBy.get(c.id) || [];
  const a = alertCounts(open);
  const v = ctx.volume.get(c.id);
  const reply = v && v.reply;
  const cards = (reply && reply.cards) || {};
  const avg = cardValue(cards.average || cards.avgPerDay);
  const y = cards.yesterday || null;
  const yv = cardValue(y);
  const chg = y && typeof y.changeVsAvgPct === 'number' ? y.changeVsAvgPct : null;
  const yRow = reply ? yesterdayRow(reply) : null;
  const events = reply ? totalEvents(reply) : null;
  const heapTop = (d.nodes || []).reduce((m, n) => (isFinite(Number(n['heap.percent'])) && (!m || Number(n['heap.percent']) > m.p) ? { p: Number(n['heap.percent']), name: n.name } : m), null);
  const disk = d.disk && isFinite(d.disk.percent) ? d.disk : null;
  const pattern = c.logIndexPattern || ctx.logPattern;
  const ilm = lifecycleView('ILM', d, pattern), slm = lifecycleView('SLM', d, pattern);
  const kind = clusterKind(c);
  const good = lastGood(d);
  const listing = listingState(d);
  const repo = ctx.repoSize.get(c.id);
  const del = ctx.delay.get(c.id);
  const sum = del && del.summary;
  const noVol = v && v.unsupported ? `needs ${NEEDS_VERSION}` : 'no data';

  return h('div.pl-spot',
    h('div.pl-shead', h('span.pl-sname', c.name), h(`span.pl-sline.${s.tone}`, s.line)),
    h('div.pl-kpis',
      kpi('Total events', events === null ? unknown(noVol) : num(events), 'live days in the record'),
      kpi('Disk used', disk ? `${Math.round(disk.percent)} %` : unknown(), disk ? `${bytes(disk.used)} of ${bytes(disk.total)}` : null,
        s.fullest && s.fullest.pct >= s.fullest.high ? 'red' : ''),
      kpi('Heap', heapTop ? `${Math.round(heapTop.p)} %` : unknown(), heapTop ? `highest · ${heapTop.name}` : null,
        heapTop ? LEVEL_TONE[nodeLoadLevel(heapTop.p, 'heap')] : ''),
      kpi('Open alerts', String(a.total), a.total ? `${a.critical} critical · ${a.warning} warning` : 'none', a.critical ? 'red' : a.warning ? 'yellow' : 'green'),
      kpi('Volume · 7-day avg', avg === null ? unknown(noVol) : bytes(avg), 'per day')),
    h('div.pl-sbody',
      h('div.pl-scol', nodesTable(ctx, d, s.fullest)),
      h('div.pl-scol',
        chart(ctx, c.id, days),
        h('div.pl-facts',
          h('div.pl-fact', h('span.pl-fk', 'Lifecycle'), h('span', pillEl(`ILM ${ilm.word}`, ilm.tone), ' ',
            slmExempt(c) ? pillEl(`ULM${kind.ulm.bucket ? ` · s3 ${kind.ulm.bucket}` : ''}`, 'blue') : pillEl(`SLM ${slm.word}`, slm.tone))),
          h('div.pl-fact', h('span.pl-fk', 'Last good snapshot'), slmExempt(c) && !good ? h('span', 'ULM archive, SLM not used')
            : good ? h('span', `${ago(endOf(good))} · ${good.repo}/${good.id}`) : unknown(listing === 'none' ? 'no repository' : listing === 'read' ? 'none' : 'no data')),
          h('div.pl-fact', h('span.pl-fk', 'Backup size'), repo && repo.bytes !== null && repo.bytes !== undefined
            ? h('span', `${bytes(repo.bytes)} · measured ${ago(repo.measuredAt)}`)
            : unknown('not measured', 'Measured from the Volume report (Measure size) or the scraper; Play shows the last shared measurement')),
          h('div.pl-fact', h('span.pl-fk', 'Delayed devices'), sum
            ? h('span', h('b.yellow', String((sum.by.DELAYED || 0) + (sum.by.CRITICAL || 0))), ` over ${ctx.watch.delayYellowFromMin} min · `,
              h('b.red', String(sum.by.CRITICAL || 0)), ` over ${ctx.watch.delayRedAboveMin} min`,
              sum.worst && sum.worst.delayMinutes !== null ? ` · worst ${sum.worst.device} ${minutes(sum.worst.delayMinutes)}` : '')
            : unknown(del && del.error ? 'not measurable' : 'not measured', del && del.error ? del.error : '')),
          h('div.pl-fact', h('span.pl-fk', 'Yesterday vs 7-day avg'), yv === null ? unknown(noVol)
            : h('span', bytes(yv), chg === null ? ' · no earlier day' : h(`b${chg > 25 ? '.yellow' : ''}`, ` ${signedPct(chg)}`))),
          h('div.pl-fact', h('span.pl-fk', 'Indices per day'), yRow ? h('span', `${num(yRow.indices)} indices · ${bytes(yRow.size)} yesterday`) : unknown(noVol))))));
}

export function render(ctx) {
  const perMs = ctx.watch.spotlight.perClusterSec * 1000;
  if (!ctx.spot.order.length) {
    return h('div.pl-slide.pl-spotlight', h('div.pl-clear', h('div.pl-clear-big', 'All healthy'),
      h('div.pl-clear-sub', 'No cluster has a critical problem')));
  }
  const ph = spotlightPhase(ctx.elapsed, ctx.spot.order.length, perMs);
  const cid = ctx.spot.order[ph.index];
  const c = ctx.clusters.find((x) => x.id === cid);
  return h('div.pl-slide.pl-spotlight', chips(ctx, cid), c ? panel(ctx, c, ph.days) : unknown());
}

/** What changes the drawing while the slide is on: which cluster, which chart window. */
export function phaseKey(ctx) {
  if (!ctx.spot.order.length) return '';
  const ph = spotlightPhase(ctx.elapsed, ctx.spot.order.length, ctx.watch.spotlight.perClusterSec * 1000);
  return `${ph.index}:${ph.days}`;
}
