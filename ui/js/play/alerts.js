/**
 * Slide 2, Alerts: the merged alerts (core/state.js mergedAlerts) that are open or
 * acknowledged, critical first, then high, then warning, then newest — what the Alerts page and the tab badge count,
 * nothing recounted. Beside them: open now, and the last 24 h from the alert history this
 * browser keeps (core/alert-history.js). Never skipped: with nothing open it says All clear.
 */

import { h } from '../lib/dom.js';
import { alertCounts } from '../core/alert-tuning.js';
import { alertHistory } from '../core/alert-history.js';
import { kpi, unknown, openFor, fitRows, clockText } from './parts.js';
import { heldNote } from './fleet.js';
import { levelRank, levelOf, LEVEL_SHORT } from '../core/alert-levels.js';

export const id = 'alerts';
export const title = 'Alerts';
export const DATASETS = ['health', 'nodes', 'ilm_errors', 'policies', 'snapshots'];

export const isEmpty = () => false;

/** Open before acknowledged; within each, critical, then high, then warning, then the newest. */
export function alertOrder(list, { acked, since }) {
  return [...list].sort((a, b) => (acked(a) ? 1 : 0) - (acked(b) ? 1 : 0)
    || levelRank(b.level) - levelRank(a.level) || since(b) - since(a));
}

/**
 * The last 24 h, from the history log, for the clusters on this display: raised (episodes
 * that started in the window), resolved (that ended in it) and the longest open of them.
 */
export function lastDay(win, visible, now) {
  const from = now - 86400000;
  const mine = (e) => visible.has(e.clusterId);
  const open = win.open.filter(mine);
  const closed = win.closed.filter(mine);
  const raised = open.filter((e) => e.start >= from).length + closed.filter((e) => e.start >= from).length;
  const resolved = closed.filter((e) => e.end >= from).length;
  let longest = null;
  for (const e of [...open.map((x) => ({ ...x, end: now })), ...closed]) {
    const d = e.end - Math.max(e.start, 0);
    if (!longest || d > longest.ms) longest = { ms: d, key: e.key, clusterId: e.clusterId, rule: e.rule, open: e.end === now };
  }
  return { raised, resolved, longest, partial: win.since > from };
}

function row(ctx, m, hot) {
  const ack = ctx.acked(m);
  const cluster = m.cluster ? m.cluster.name : m.clusterId;
  const level = levelOf(m.level);
  return h(`div.pl-arow.${level}${ack ? '.acked' : ''}${hot ? '.hot' : ''}`, { dataset: { key: m.key } },
    h(`span.pl-sev.${level}`, LEVEL_SHORT[level]),
    h('div.pl-atext',
      h('div.pl-atitle', m.title, m.count ? h('span.pl-acount', ` ${m.count}`) : null),
      h('div.pl-adetail', [cluster, m.detail].filter(Boolean).join(' · ')),
      // A down cluster's row says what is held behind it, as the Alerts page's line does.
      m.family === 'unreachable' ? heldNote(ctx, m.clusterId) : null),
    h('div.pl-afor', openFor(ctx.now - ctx.openSince(m))),
    h('div.pl-aby', ack ? `ack ${ack.by || 'someone'}` : ''));
}

export function render(ctx) {
  const shown = ctx.merged.filter((m) => m.state === 'open' || ctx.acked(m));
  const list = alertOrder(shown, { acked: (m) => !!ctx.acked(m), since: (m) => ctx.openSince(m) });
  const hotKey = ctx.takeover ? ctx.takeover.key : null;
  if (hotKey) {
    const i = list.findIndex((m) => m.key === hotKey);
    if (i > 0) list.unshift(...list.splice(i, 1));
  }
  const openNow = list.filter((m) => !ctx.acked(m));
  const c = alertCounts(openNow);
  const ackN = list.length - openNow.length;
  const day = lastDay(alertHistory.window(ctx.now - 86400000, ctx.now), new Set(ctx.clusters.map((x) => x.id)), ctx.now);
  const nameOf = (id) => (ctx.clusters.find((x) => x.id === id) || {}).name || id;

  const rows = list.map((m) => row(ctx, m, m.key === hotKey));
  const box = h('div.pl-alist', rows.length ? rows : h('div.pl-clear', h('div.pl-clear-big', 'All clear'),
    h('div.pl-clear-sub', `No open alert on ${ctx.clusters.length} cluster${ctx.clusters.length === 1 ? '' : 's'}`)));
  if (rows.length) ctx.afterMount(() => fitRows(box, rows, (n) => h('div.pl-arow.pl-more', `+${n} more`)));

  return h(`div.pl-slide.pl-alerts${hotKey ? '.takeover' : ''}`,
    box,
    h('aside.pl-aside',
      h('div.pl-ahead', 'Open now'),
      kpi('Critical', String(c.critical), null, c.critical ? 'red' : 'green'),
      kpi('High', String(c.high), null, c.high ? 'orange' : 'green'),
      kpi('Warning', String(c.warning), null, c.warning ? 'yellow' : 'green'),
      kpi('Acknowledged', String(ackN), ctx.sharedAcks ? 'shared' : 'on this screen'),
      h('div.pl-ahead', 'Last 24 h'),
      kpi('Raised', String(day.raised), day.partial ? `seen since ${clockText(alertHistory.since(), ctx.tz, { seconds: false })}` : null),
      kpi('Resolved', String(day.resolved)),
      kpi('Longest open', day.longest ? openFor(day.longest.ms) : unknown('none'),
        day.longest ? `${day.longest.rule} · ${nameOf(day.longest.clusterId)}${day.longest.open ? ' · still open' : ''}` : null)));
}
