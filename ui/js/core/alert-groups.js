/**
 * Alerts as the Alerts page shows them: repeats merged, then grouped.
 *
 * `alerts()` (core/state.js) raises one alert per problem it finds — one per snapshot
 * policy that failed, one per repository, one per field value that spiked. On a cluster
 * with three failing policies that is three rows saying the same thing about the same
 * place. A MERGED alert is the rule on the cluster: every alert with the same cluster and
 * the same rule (the family segment of its key — `ruleOf`, alert-rules.js ALERT_RULES)
 * becomes one, listing each thing it is about — node, index, repository, policy, device,
 * field value — with its own value and age.
 *
 *  - Its level is the worst of its items; its age is the oldest item's.
 *  - Its key is `<cluster>:<rule>`. Acknowledgements are stored against that key and
 *    remember WHICH items they covered, so a node that joins an acknowledged disk alert is
 *    not hidden behind an acknowledgement given before it existed: the alert opens again,
 *    saying "1 new since acknowledged". An acknowledgement written before merging existed
 *    (against a member's own key, or against `<cluster>:<rule>` with no item list) keeps
 *    covering what it covered.
 *  - The same function decides what is "open" everywhere a count is shown (state.js
 *    openAlertsNow), so the tab badge, the top bar and this page cannot disagree.
 *
 * Pure: everything it needs (acks, silences, first-seen times, the clusters' data) comes in
 * through `ctx`, so tools/unit covers it without a DOM.
 */

import { ruleById } from './alert-rules.js';
import { ruleOf } from './zabbix-alerts.js';
import { compareNames } from '../lib/cluster-order.js';
import { diskBalance } from './disk-balance.js';
import { ilmErrorsOf } from './lifecycle-errors.js';

export const clusterIdOf = (a) => (a && a.cluster && a.cluster.id) || String((a && a.key) || '').split(':')[0];
/** The rule family: `vm-1:slm-fail:daily` → `slm-fail`. Alerts of no known family share `other`. */
export const familyOf = (a) => ruleOf(a) || 'other';
/** One merged alert per cluster and rule. */
export const mergeKeyOf = (a) => `${clusterIdOf(a)}:${familyOf(a)}`;

const rank = (level) => (level === 'critical' ? 2 : 1);
const worst = (a, b) => (rank(a) >= rank(b) ? a : b);

/** "33 m", "1 h 40 m", "26 h", "3 d 4 h" — an age to read at a glance, never decimals. */
export function ageShort(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return '< 1 m';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/* ---------------------------------- items ----------------------------------- */

const segs = (key) => String(key || '').split(':');
const pctText = (p) => `${Math.round(p)}%`;

/** Data nodes with their disk use, fullest first — from the same rows the Nodes page reads. */
function diskNodes(d) {
  const rows = ((d && d.disk && d.disk.nodes) || []).filter((r) => r && r.node && r.node !== 'UNASSIGNED');
  return rows.map((r) => {
    const used = Number(r['disk.used']) || 0, total = Number(r['disk.total']) || 0;
    return { name: r.node, pct: total > 0 ? (used / total) * 100 : NaN };
  }).filter((n) => Number.isFinite(n.pct)).sort((a, b) => b.pct - a.pct);
}

const one = (a, label, value, extra = {}) => ({ id: a.key, label, value, level: a.level, alertKey: a.key, ...extra });

/**
 * What one alert is about, as items. A rule that raises one alert per thing already gives
 * one item per alert; a rule that raises a single alert for several things (disk across
 * nodes, ILM errors across indices) is expanded from the cluster's own data, so the list
 * is what the cluster reports, not a guess at it.
 */
export function itemsOf(a, ctx = {}) {
  const fam = familyOf(a);
  const d = ctx.data ? ctx.data(clusterIdOf(a)) : null;
  const defaults = ctx.defaults || {};
  switch (fam) {
    case 'disk': {
      const warn = Number(defaults.diskWarnPercent), crit = Number(defaults.diskCritPercent);
      const hot = Number.isFinite(warn) ? diskNodes(d).filter((n) => n.pct >= warn) : [];
      if (hot.length) {
        return hot.map((n) => ({ id: `${a.key}|${n.name}`, label: n.name, value: pctText(n.pct),
          level: Number.isFinite(crit) && n.pct >= crit ? 'critical' : 'warning', alertKey: a.key, node: n.name }));
      }
      return [one(a, 'cluster average', Number.isFinite(a.diskPercent) ? `${a.diskPercent.toFixed(1)}%` : '')];
    }
    case 'disk-balance': {
      // The nodes the verdict rests on (past the flood stage, past the high watermark), from
      // the same reading the alert was raised from.
      const bal = d ? diskBalance(d, d.clusterSettings) : null;
      const flagged = bal && bal.applicable
        ? [...(bal.aboveFlood || []).map((n) => ({ n, level: 'critical' })), ...(bal.aboveHigh || []).map((n) => ({ n, level: 'warning' }))]
        : [];
      if (flagged.length) {
        return flagged.map(({ n, level }) => ({ id: `${a.key}|${n.name}`, label: n.name, value: pctText(n.pct), level, alertKey: a.key, node: n.name }));
      }
      return [one(a, a.title, '')];
    }
    case 'ilm': {
      const errs = ilmErrorsOf(d, (d && d.logIndexPattern) || defaults.logIndexPattern).details;
      const names = Object.keys(errs);
      if (!names.length) return [one(a, 'indices', '')];
      return names.sort().map((n) => {
        const e = errs[n] || {};
        return { id: `${a.key}|${n}`, label: n, value: String(e.failed_step || e.step || ''), level: a.level, alertKey: a.key, index: n };
      });
    }
    case 'slm-fail': case 'slm-stale': {
      const policy = segs(a.key).slice(2).join(':') || a.key;
      return [one(a, policy, fam === 'slm-fail' ? 'last run failed' : 'no recent success', { policy })];
    }
    case 'repo': {
      const state = segs(a.key).pop();
      const word = { unreadable: 'unreadable', none: 'no snapshots', failing: 'snapshots failing', stale: 'no recent snapshot' }[state] || state;
      return [one(a, a.repo || segs(a.key)[2] || a.key, word, { repo: a.repo || null })];
    }
    case 'volume': {
      const members = Array.isArray(a.members) && a.members.length ? a.members : [a];
      return members.map((m) => {
        const [, , field, ...term] = segs(m.key);
        const up = /up (\d+)%/.exec(m.title || '');
        return { id: m.key, label: field ? `${field} = ${term.join(':')}` : (m.title || m.key),
          value: up ? `up ${up[1]}%` : '', level: m.level, alertKey: a.key, field: field || null };
      });
    }
    case 'automation': {
      const rule = segs(a.key).slice(2).join(':');
      return [one(a, a.title, a.detail || '', { automationRule: rule || null })];
    }
    default:
      return [one(a, a.title, '')];
  }
}

/** What a merged alert's count says: "on 3 nodes", "6 indices". Empty for a lone, unit-less alert. */
function countText(fam, items, merged) {
  const n = items.length;
  const unit = {
    disk: ['node', 'nodes', 'on '], 'disk-balance': ['node', 'nodes', 'on '], ilm: ['index', 'indices', ''], repo: ['repository', 'repositories', ''],
    'slm-fail': ['policy', 'policies', ''], 'slm-stale': ['policy', 'policies', ''],
    volume: ['field value', 'field values', ''], automation: ['automation', 'automations', ''],
  }[fam];
  if (!unit) return '';
  if ((fam === 'disk' || fam === 'disk-balance') && (n < 1 || !items[0].node)) return '';
  if (n === 1 && !['ilm', 'repo', 'volume'].includes(fam)) return '';
  return `${unit[2]}${n} ${n === 1 ? unit[0] : unit[1]}`;
}

/** The merged alert's title: the rule's own name, with the live figure where the rule has one. */
function titleFor(fam, rule, members, ctx) {
  if (fam === 'disk') {
    const warn = Number((ctx.defaults || {}).diskWarnPercent);
    return Number.isFinite(warn) ? `Disk usage above ${warn}%` : 'Disk usage above threshold';
  }
  if (fam === 'health') {
    const red = members.some((m) => /RED/.test(m.title || ''));
    return `Cluster health ${red ? 'red' : 'yellow'}`;
  }
  if (fam === 'disk-balance' && members.length === 1 && members[0].title) {
    // The alert already says what it found ("es-hot-1 above the high watermark"); the rule's
    // name is a category, and a node at the flood stage is not "unevenly spread".
    const t = members[0].title.replace(/^[^:]*:\s*/, '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  return rule ? rule.label : (members[0] && members[0].title) || 'Alert';
}

/* ---------------------------------- merging --------------------------------- */

/**
 * Whether an acknowledgement record covers an item.
 *
 * A record with an item list covers exactly those items; a record without one (written
 * before merging, or by a key that was always one alert) covers everything under its key.
 */
function coveredBy(rec, itemId) {
  if (!rec || !rec.acked) return false;
  return !Array.isArray(rec.ackedItems) || rec.ackedItems.includes(itemId);
}

/**
 * @param {Array} list  what alerts() raised (after tuning)
 * @param {object} ctx
 *   data(clusterId) → the cluster's state.data entry | null
 *   defaults        → { diskWarnPercent, diskCritPercent, … }
 *   ackFor(key)     → acknowledgement record
 *   isAcked(key)    → bool
 *   silenced(alert) → bool
 *   startOf(mergedKey), itemFirstSeen(mergedKey, itemId), approxStart(mergedKey) → history (optional)
 *   now             → ms
 * @returns {Array} merged alerts, unsorted
 */
export function mergeAlerts(list, ctx = {}) {
  const now = ctx.now || Date.now();
  const ackFor = ctx.ackFor || (() => null);
  const isAcked = ctx.isAcked || (() => false);
  const silenced = ctx.silenced || (() => false);

  const buckets = new Map();
  for (const a of list || []) {
    const k = mergeKeyOf(a);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(a);
  }

  const out = [];
  for (const [key, members] of buckets) {
    const first = members[0];
    const fam = familyOf(first);
    const rule = ruleById(fam);
    const rec = ackFor(key);

    const items = [];
    for (const a of members) {
      const memberSilenced = silenced(a);
      const legacy = a.key !== key && isAcked(a.key);
      for (const it of itemsOf(a, ctx)) {
        const seen = ctx.itemFirstSeen ? ctx.itemFirstSeen(key, it.id) : null;
        const hint = Number.isFinite(a.failingSince) && a.failingSince > 0 ? a.failingSince : null;
        const since = hint && (!seen || hint < seen) ? hint : (seen || now);
        const acked = coveredBy(rec, it.id) || legacy;
        items.push({ ...it, since, acked, silenced: memberSilenced, handled: acked || memberSilenced });
      }
    }
    // Worst first, then the oldest: what to look at before what to look at later.
    items.sort((x, y) => rank(y.level) - rank(x.level) || x.since - y.since || compareNames(x.label, y.label));

    // The worst of what was raised and of what is listed: a disk alert raised critical on the
    // cluster's average stays critical even when no single node is over its own line.
    const level = [...members.map((a) => a.level), ...items.map((it) => it.level)].reduce((m, l) => worst(m, l), 'warning');
    const unhandled = items.filter((it) => !it.handled);
    const ackedItems = items.filter((it) => it.acked);
    const stateName = unhandled.length ? 'open' : items.every((it) => it.silenced) ? 'silenced' : 'acked';
    const startHint = members.reduce((m, a) => (Number.isFinite(a.failingSince) && a.failingSince > 0 && (!m || a.failingSince < m) ? a.failingSince : m), null);
    const histStart = ctx.startOf ? ctx.startOf(key) : null;
    const since = Math.min(histStart || Infinity, startHint || Infinity, ...items.map((it) => it.since));

    out.push({
      key, clusterId: clusterIdOf(first), cluster: first.cluster || null, family: fam, rule,
      level,
      title: titleFor(fam, rule, members, ctx),
      count: countText(fam, items, members.length > 1),
      detail: items.length > 1
        ? items.slice(0, 3).map((it) => (it.value ? `${it.label} ${it.value}` : it.label)).join(' · ')
          + (items.length > 3 ? ` · +${items.length - 3} more` : '')
        : (first.detail || ''),
      items, members, keys: members.map((m) => m.key),
      since: Number.isFinite(since) ? since : now,
      approxSince: ctx.approxStart ? !!ctx.approxStart(key) && !startHint : false,
      startHint,
      state: stateName,
      // Items that arrived after the acknowledgement: the reason an acked alert is open again.
      newSince: unhandled.length && (ackedItems.length || (rec && rec.acked)) ? unhandled.filter((it) => !it.acked).length : 0,
      ackedBy: rec && rec.acked ? rec.ackedBy || '' : '',
      ackedAt: rec && rec.acked ? rec.ackedAt || 0 : 0,
      snapshot: members.map((m) => m.snapshot).find(Boolean) || null,
      stale: members.some((m) => m.stale),
      problemUrl: members.map((m) => m.problemUrl).find(Boolean) || null,
    });
  }
  return out;
}

/** The merged alerts as the history log takes them (core/alert-history.js observe). */
export function toObservations(merged) {
  return merged.map((m) => ({ key: m.key, clusterId: m.clusterId, rule: m.family, level: m.level,
    startHint: m.startHint, items: m.items.map((i) => ({ id: i.id, label: i.label })) }));
}

/** Open means something on it still needs a person: some item neither acknowledged nor silenced. */
export const isOpen = (m) => m.state === 'open';
/** Handled is a person's decision: acknowledged or silenced. A held alert is neither (see holdUnreachable). */
export const isHandled = (m) => m.state === 'acked' || m.state === 'silenced';
/** Held: raised on a cluster that cannot be reached now, so not current (see holdUnreachable). */
export const isHeld = (m) => !!m.held;
/** The alert that says a cluster cannot be reached. */
export const isUnreachableAlert = (m) => m.family === 'unreachable';

/* ------------------------------ unreachable clusters ------------------------------ */

/**
 * Alerts raised on a cluster that cannot be reached are HELD: kept, listed (dimmed, under
 * the cluster's one unreachable line, labelled "not current"), and counted nowhere.
 *
 * A cluster that is down is one problem. Its other alerts were raised from data read before
 * it went down, and nothing now can say they are still true — so they neither stand as
 * separate groups beside the unreachable alert nor count a second time in the bell, the tab
 * badge, the top bar or the Alerts summary. Their `state` becomes 'held' (so `isOpen` is
 * false for them, which is the one definition every count reads) and the state they had is
 * kept in `heldState`. Nothing is dropped: the unreachable line says how many are held.
 *
 * The one rule: a cluster with a merged `unreachable` alert is unreachable, and every other
 * merged alert on it is held. Applied once, where the merged list is made (state.js
 * mergedAlerts), so no reader can see the two disagree.
 */
export function holdUnreachable(merged) {
  const down = new Set(merged.filter(isUnreachableAlert).map((m) => m.clusterId));
  if (!down.size) return merged;
  return merged.map((m) => (down.has(m.clusterId) && !isUnreachableAlert(m)
    ? { ...m, held: true, heldState: m.state, state: 'held' }
    : m));
}

/**
 * The merged list, split into the unreachable clusters and everything else.
 * `down` is one entry per unreachable cluster — its unreachable alert and the alerts held
 * behind it — A–Z; `rest` is every alert of a cluster that answers. Each alert is in
 * exactly one place: the unreachable alert and the held ones only in `down`, never in `rest`.
 */
export function splitUnreachable(merged) {
  const held = new Map();
  for (const m of merged) if (isHeld(m)) (held.get(m.clusterId) || held.set(m.clusterId, []).get(m.clusterId)).push(m);
  const down = [];
  const rest = [];
  for (const m of merged) {
    if (isUnreachableAlert(m)) {
      down.push({ clusterId: m.clusterId, cluster: m.cluster, name: (m.cluster && m.cluster.name) || m.clusterId, alert: m,
        held: (held.get(m.clusterId) || []).sort(compareAlerts) });
    } else if (!isHeld(m)) rest.push(m);
  }
  down.sort((a, b) => compareNames(a.name, b.name));
  return { down, rest };
}

/** The unreachable entries a filter leaves: decided by the unreachable alert itself. */
export function filterDown(down, opts = {}) {
  return down.filter((d) => filterAlerts([d.alert], opts).length > 0);
}

/** "under a minute", "12 min", "1 h 40 min", "3 d 4 h" — how long a cluster has been down. */
export function downFor(ms) {
  const m = Math.floor(Math.max(0, Number(ms) || 0) / 60000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/**
 * Why a cluster cannot be reached, as a short label, from the client's state. The one
 * definition: the Alerts unreachable line, and the Clusters page's Health cell, tooltip
 * and CSV. `cls` says how bad; a certificate is amber because it is a decision to take
 * rather than an outage.
 */
export function unreachableReason(cl) {
  const st = cl && cl.state;
  if (st === 'auth_error') return { label: 'Auth error', cls: 'red' };
  if (st === 'tls_error') return { label: 'Certificate', cls: 'yellow' };
  if (st === 'tunnel_error') return { label: 'Jump host down', cls: 'red' };
  return { label: 'Offline', cls: 'red' };
}

/** "2 older alerts held, not current" / "no other alerts" — what an unreachable line says of the rest. */
export function heldText(n) {
  return n ? `${n} older alert${n === 1 ? '' : 's'} held, not current` : 'no other alerts';
}

/* --------------------------------- ordering --------------------------------- */

/** Critical first, then the oldest, then by title — inside a group. */
export function compareAlerts(a, b) {
  return rank(b.level) - rank(a.level) || a.since - b.since || compareNames(a.title, b.title);
}

/** Worst severity, then how many alerts, then name A–Z (natural, case-insensitive). */
export function compareGroups(a, b) {
  return (b.critical > 0) - (a.critical > 0)
    || b.alerts.length - a.alerts.length
    || compareNames(a.name, b.name);
}

export const GROUP_MODES = ['cluster', 'type', 'none'];

/**
 * @param {Array} merged  the alerts to show
 * @param {'cluster'|'type'|'none'} mode
 * @returns {Array<{id:string, name:string, clusterId?:string, family?:string, critical:number,
 *                  warning:number, oldest:number, alerts:Array}>}
 */
export function groupAlerts(merged, mode = 'cluster') {
  if (mode === 'none') {
    const list = [...merged].sort((a, b) => rank(b.level) - rank(a.level)
      || compareNames(a.cluster ? a.cluster.name : a.clusterId, b.cluster ? b.cluster.name : b.clusterId)
      || a.since - b.since || compareNames(a.title, b.title));
    return list.length ? [summarise({ id: 'all', name: 'All alerts', alerts: list })] : [];
  }
  const by = new Map();
  for (const m of merged) {
    const id = mode === 'type' ? m.family : m.clusterId;
    if (!by.has(id)) {
      by.set(id, mode === 'type'
        ? { id, name: (m.rule && m.rule.label) || id, family: m.family, alerts: [] }
        : { id, name: (m.cluster && m.cluster.name) || id, clusterId: m.clusterId, alerts: [] });
    }
    by.get(id).alerts.push(m);
  }
  return [...by.values()].map((g) => { g.alerts.sort(compareAlerts); return summarise(g); }).sort(compareGroups);
}

function summarise(g) {
  const critical = g.alerts.filter((a) => a.level === 'critical').length;
  return { ...g, critical, warning: g.alerts.length - critical,
    oldest: g.alerts.reduce((m, a) => Math.min(m, a.since), Infinity) };
}

/* --------------------------------- filtering -------------------------------- */

/**
 * The alerts a filter bar leaves: severity, text, and whether acknowledged or silenced
 * ones are shown. `notesOf(mergedAlert)` supplies note text for the search.
 */
export function filterAlerts(merged, { level = 'all', text = '', showHandled = false, notesOf = () => '' } = {}) {
  const t = String(text || '').trim().toLowerCase();
  return merged.filter((m) => {
    if (isHeld(m)) return false;   // held alerts are listed under their cluster's unreachable line, never here
    if (level === 'critical' && m.level !== 'critical') return false;
    if (level === 'warning' && m.level === 'critical') return false;
    if (!showHandled && isHandled(m)) return false;
    if (t) {
      const hay = [m.title, m.count, m.detail, m.cluster && m.cluster.name, ...m.items.map((i) => `${i.label} ${i.value}`), notesOf(m)]
        .join(' ').toLowerCase();
      if (!hay.includes(t)) return false;
    }
    return true;
  });
}

/**
 * The counts the summary line and the footer show, from one list, so they cannot disagree.
 * An unreachable cluster counts once, as one critical alert; what is held behind it counts
 * nowhere (`held` says how many).
 */
export function summaryOf(merged, fleetSize) {
  const open = merged.filter(isOpen);
  const handled = merged.filter(isHandled);
  const withOpen = new Set(open.map((m) => m.clusterId));
  const critical = open.filter((m) => m.level === 'critical').length;
  return {
    critical, warning: open.length - critical, open: open.length,
    clustersAffected: withOpen.size, fleet: fleetSize,
    clustersClear: Math.max(0, fleetSize - withOpen.size),
    acknowledged: handled.filter((m) => m.state === 'acked').length,
    silenced: handled.filter((m) => m.state === 'silenced').length,
    // Not counted above: alerts on unreachable clusters, held until they answer.
    held: merged.filter(isHeld).length,
  };
}
