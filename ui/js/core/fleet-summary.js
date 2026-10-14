/**
 * The Clusters page's one summary box, as numbers: how many clusters are in each health
 * state, which cannot be reached, how many alerts at each level, and the problems that
 * recur most. Pure — the page passes its rows, the health classifier and the alerts — so
 * one definition serves the box and its test.
 *
 * A cluster whose health has not been read yet is "loading", never counted as green; an
 * unreachable one is counted once, as unreachable, not also by a stale colour.
 */
import { ruleForKey } from './alert-rules.js';

/** What kind of problem an alert is: its rule. A title carries the cluster's name and the
 *  value ("prod-a disk 94.8%"), so grouping by title never groups anything. */
function kindOf(a) {
  const r = ruleForKey(a.key);
  return r ? { id: r.id, label: r.label } : { id: `title:${a.title}`, label: a.title };
}

export function fleetSummary(rows, healthOf, alerts, { top = 3 } = {}) {
  const by = { green: [], yellow: [], red: [], loading: [], unreachable: [] };
  for (const r of rows) {
    const st = healthOf(r.d);
    if (st === 'unreachable') by.unreachable.push(r.c.name);
    else if (st === 'green' || st === 'yellow' || st === 'red') by[st].push(r.c.name);
    else by.loading.push(r.c.name);
  }
  const list = alerts || [];
  const critical = list.filter((a) => a.level === 'critical').length;
  // Grouped by what they are, so twenty clusters with the same fault read as one line with a
  // count rather than twenty lines; critical first, then the most widespread.
  const groups = new Map();
  for (const a of list) {
    const k = kindOf(a);
    const g = groups.get(k.id) || { title: k.label, critical: false, clusters: new Set(), count: 0 };
    g.critical = g.critical || a.level === 'critical';
    g.count += 1;
    if (a.cluster) g.clusters.add(a.cluster.name);
    groups.set(k.id, g);
  }
  const problems = [...groups.values()]
    .sort((x, y) => (y.critical - x.critical) || (y.clusters.size - x.clusters.size) || (y.count - x.count))
    .slice(0, top)
    .map((g) => ({ title: g.title, critical: g.critical, clusters: g.clusters.size, count: g.count }));
  return {
    total: rows.length,
    green: by.green.length, yellow: by.yellow.length, red: by.red.length, loading: by.loading.length,
    redNames: by.red, unreachable: by.unreachable,
    alerts: list.length, critical, warning: list.length - critical,
    problems, problemKinds: groups.size,
    bad: by.red.length > 0 || by.unreachable.length > 0 || critical > 0,
  };
}

/** "a, b, c, +4 more" — every name when there are few, so a red cluster is named, not counted. */
export function nameList(names, max = 6) {
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')}, +${names.length - max} more`;
}

/**
 * What an empty alert list means, given how many clusters were actually read. No alerts is
 * "healthy" only for the clusters read; for the rest it is unknown, and the page must say so
 * rather than show a tick (unknown is not zero).
 */
export function alertsEmptyState({ total, read }) {
  const s = (n) => (n === 1 ? '' : 's');
  if (total > 0 && read >= total) {
    return { healthy: true, title: 'Every cluster is healthy',
      detail: `No health, disk, ILM or snapshot problem across ${total} cluster${s(total)}.` };
  }
  if (!read) {
    return { healthy: false, title: 'Nothing read yet',
      detail: `No alert can be raised for a cluster that has not been read — ${total} cluster${s(total)} not read yet. Read all (above) reads them one at a time.` };
  }
  return { healthy: false, title: `No problem on the ${read} cluster${s(read)} read`,
    detail: `${total - read} not read yet — their alerts are unknown. Read all (above) reads them.` };
}
