/**
 * What is wrong with a cluster on Play's Fleet page, worst first (docs/PLAY.md "Fleet"), from
 * existing pieces: the merged Critical and High alerts (core/state.js mergedAlerts, whose disk
 * level is core/alert-tuning.js diskLevel), health and reachability (healthState) and the nodes
 * that left (PLAY_STATE). An acknowledged problem is still a problem; a silenced alert is not
 * shown. Warnings are not problems here: the Alerts page has them.
 */

import { healthState } from '../core/state.js';
import { diskBalance } from '../core/disk-balance.js';
import { diskLevel, DISK_HYSTERESIS } from '../core/alert-tuning.js';
import { unreachableReason } from '../core/alert-groups.js';
import { levelRank, countLevels } from '../core/alert-levels.js';
import { bytes } from '../lib/fmt.js';

export const HEALTH_WORD = { green: 'Health green', yellow: 'Health yellow', red: 'Health red', unreachable: 'Not answering', loading: 'No data' };
/**
 * A cluster's place in the wall's order: its level first (Critical > High), then yellow health or
 * a warning, then no data, then nothing. STEP is larger than anything the rest can add up to
 * on a real cluster, so no count lifts a cluster over a worse one.
 */
const STEP = 100000;
const HEALTH_RANK = { unreachable: 50, red: 40, yellow: 20, loading: 10, green: 0 };

/** The fullest data node, or null when the disk was not read: `{name, pct, avail, total, of}`. */
export function fullestOf(d) {
  if (!d || !d.disk) return null;
  const nodes = [...diskBalance(d, d.clusterSettings).nodes].sort((a, b) => b.pct - a.pct);
  const n = nodes[0];
  return n ? { name: n.name, pct: n.pct, avail: n.avail, total: n.total, of: nodes.length } : null;
}

/** An alert's own words without the cluster's name in front, first letter upper case. */
export function headline(m, c) {
  const one = m.members && m.members.length === 1 && m.members[0].title ? m.members[0].title : `${m.title || ''}${m.count ? ` ${m.count}` : ''}`;
  let t = String(one || m.title || '');
  if (c && c.name && t.toLowerCase().startsWith(c.name.toLowerCase())) t = t.slice(c.name.length).replace(/^[\s:·,-]+/, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : String(m.title || '');
}

/** What each disk line means, said as what Elasticsearch may do: its own watermarks decide when. */
const DISK_WHY = {
  critical: (l) => `From ${l} % Elasticsearch may make indices read-only and refuse new logs.`,
  high: (l) => `From ${l} % shards may move away.`,
};

/** What a merged alert of family disk-balance (the node-level one) was raised for. */
const balanceCauses = (m) => (m.members || []).flatMap((x) => x.balanceCauses || []);
/**
 * Is this alert about how full the disks are? The disk rule's own, and the node-level one raised
 * at Elasticsearch's high or flood watermark, into which core/alert-tuning.js folds the disk rule's.
 */
const isFullDisk = (m) => m.family === 'disk' || (m.family === 'disk-balance' && balanceCauses(m).some((x) => x === 'high' || x === 'flood'));

function diskProblem(m, fullest, lines) {
  // Its own level: one held by the hysteresis just below its line is still that level.
  const level = m.family === 'disk' ? m.level : diskLevel(fullest.pct, null, lines);
  const free = fullest.total > 0 ? `${bytes(fullest.avail)} free` : '';
  // A cluster with its own watermarks (flood below our Critical line, say) is told in its alert's words.
  const own = balanceCauses(m).includes('flood') && level !== 'critical';
  const held = m.family === 'disk' && fullest.pct < lines[level];
  const why = held ? `Stays ${level === 'critical' ? 'Critical' : 'High'} until it falls below ${lines[level] - DISK_HYSTERESIS} %.`
    : DISK_WHY[level] && !own ? DISK_WHY[level](lines[level]) : m.detail || '';
  return { what: `Disk ${Math.floor(fullest.pct)} % on ${fullest.name}`, why: [free, why].filter(Boolean).join('. ') };
}

/**
 * `{state, level, problems:[{level, key, family, what, why, since, acked, alert}], fullest, left, rank}` for
 * one cluster; `level` is 'critical', 'high' or null. `alerts` are its merged alerts that are
 * open or acknowledged, `nodes` its PLAY_STATE node entry, `lines` the disk lines (diskLines).
 */
export function clusterStatus(c, d, { alerts = [], nodes = null, client = null, lines = {}, hot = null } = {}) {
  const st = healthState(d);
  const read = st !== 'unreachable' && st !== 'loading';
  const fullest = read ? fullestOf(d) : null;
  const left = nodes && Array.isArray(nodes.left) ? nodes.left : [];
  const unassigned = d && d.health && Number.isFinite(d.health.unassigned_shards) ? d.health.unassigned_shards : null;
  const problems = [];
  for (const m of alerts) {
    if (m.level !== 'critical' && m.level !== 'high') continue;
    const p = { level: m.level, key: m.key, family: m.family, since: null, acked: m.state === 'acked', alert: m };
    if (m.family === 'unreachable') Object.assign(p, { what: 'Not answering', why: unreachableReason(client).label });
    else if (isFullDisk(m) && fullest) Object.assign(p, diskProblem(m, fullest, lines));
    else if (m.family === 'health' && st === 'red') Object.assign(p, redProblem(unassigned));
    else Object.assign(p, { what: headline(m, c), why: m.detail || '' });
    problems.push(p);
  }
  const has = (f) => problems.some((p) => p.family === f);
  // A fact with no alert (its rule is switched off or silenced) is still true.
  if (st === 'unreachable' && !has('unreachable')) problems.push({ level: 'critical', key: `${c.id}:unreachable`, family: 'unreachable', since: null, acked: false, what: 'Not answering', why: unreachableReason(client).label });
  if (st === 'red' && !has('health')) problems.push({ level: 'critical', key: `${c.id}:health`, family: 'health', since: null, acked: false, ...redProblem(unassigned) });
  if (left.length && read) {
    const at = Math.min(...left.map((l) => Number(l.since) || Date.parse(l.since) || Infinity));
    problems.push({ level: 'high', key: `${c.id}:node-left`, family: 'node-left', acked: false, since: Number.isFinite(at) ? at : null,
      what: left.length === 1 ? `Node ${left[0].node} left the cluster` : `${left.length} nodes left: ${left.map((l) => l.node).join(', ')}`,
      why: unassigned === null ? '' : unassigned ? `${unassigned} shards have no node until it returns or they are rebuilt.` : 'Every shard has a node.' });
  }
  problems.sort((a, b) => (b.key === hot) - (a.key === hot) || levelRank(b.level) - levelRank(a.level) || a.acked - b.acked
    || ((a.alert && a.alert.since) || 0) - ((b.alert && b.alert.since) || 0));
  const level = problems.some((p) => p.level === 'critical') ? 'critical' : problems.length ? 'high' : null;
  const n = countLevels(alerts);
  const tone = level === 'critical' ? 4 : level === 'high' ? 3 : st === 'yellow' || n.total ? 2 : st === 'loading' ? 1 : 0;
  const within = (HEALTH_RANK[st] || 0) + (left.length ? 30 : 0) + n.critical * 3 + n.high * 2 + n.warning;
  return { state: st, level, problems, fullest, left, rank: tone * STEP + Math.min(within, STEP - 1) };
}

const redProblem = (unassigned) => ({ what: 'Cluster health red', why: `${unassigned === null ? '' : `${unassigned} shards have no node. `}Red: part of the data cannot be read.` });
