/**
 * "Go to …" — where each alert leads, and what is in view when you get there.
 *
 * The PAGE is not decided here: it is the rule's own `page` in alert-rules.js (the same
 * answer the Zabbix "Troubleshoot in ElasticPro" link uses), so the Alerts page and Zabbix
 * cannot send one alert to two places. What this adds is the FOCUS — the hint handed to the
 * page being opened (core/focus.js) so the problem is in view rather than somewhere on the
 * page: the unassigned shards, the indices in an ILM error step, the delayed devices.
 *
 * Every rule in ALERT_RULES must have an entry in FOCUS (a test fails if one does not), so
 * a rule added later cannot ship without saying where it leads. `null` is a valid answer —
 * "the page, with the cluster selected, is all there is to show" — but it has to be said.
 */

import { ALERT_RULES, pageForProblem } from './alert-rules.js';
import { pageLabel } from './page-labels.js';
import { setFocus } from './focus.js';
import { navigateTo } from './intent.js';

/**
 * Focus per rule: `(mergedAlert, item?) → hint | null`. An item narrows it ("this node →").
 * What a hint means is each page's own business (see the page's render()).
 */
export const FOCUS = {
  // Clusters: that cluster's unreachable card, scrolled to and opened.
  unreachable: (m) => ({ section: 'unreachable', cluster: m.clusterId || null }),
  // Nodes & shards: the shard table filtered to what is unassigned.
  health: () => ({ section: 'unassigned' }),
  // Nodes & shards: the nodes and their disk; an item narrows the shard table to that node.
  disk: (m, it) => ({ section: 'disk', ...(it && it.node ? { node: it.node } : {}) }),
  'disk-balance': () => ({ section: 'disk' }),
  'disk-unaccounted': () => ({ section: 'disk' }),
  capacity: () => ({ section: 'disk' }),
  'no-master': () => ({ section: 'nodes' }),
  'master-changed': () => ({ section: 'nodes' }),
  // Indices: only the indices in an ILM error step.
  ilm: (m, it) => ({ ilm: true, ...(it && it.index ? { index: it.index } : {}) }),
  // Snapshots: the summary view, which holds the repositories and the SLM policies.
  'slm-mode': () => ({ view: 'summary', section: 'policies' }),
  'slm-fail': () => ({ view: 'summary', section: 'policies' }),
  'slm-stale': () => ({ view: 'summary', section: 'policies' }),
  repo: () => ({ view: 'summary', section: 'repos' }),
  // Log delay: the delay view, not the live tail.
  'log-delay': () => ({ view: 'delay' }),
  // Automation: the rule that raised it.
  automation: (m, it) => ({ rule: (it && it.automationRule) || (m.items[0] && m.items[0].automationRule) || null }),
  // Volume report: the field volume for that field.
  volume: (m, it) => {
    const f = it ? it.field : (m.items[0] && m.items[0].field);
    return f ? { field: f } : null;
  },
};

/**
 * Where an alert (or one of its items) leads.
 * @returns {{ page:string, label:string, focus:object|null, clusterId:string, external:string|null }}
 */
export function gotoFor(m, item = null) {
  if (m.problemUrl) {
    return { page: null, label: 'Zabbix problem', focus: null, clusterId: m.clusterId, external: m.problemUrl };
  }
  const page = pageForProblem(m.family, `${m.title} ${m.detail || ''}`);
  const make = FOCUS[m.family];
  return { page, label: pageLabel(page), focus: make ? make(m, item) : null, clusterId: m.clusterId, external: null };
}

/** Go there: leave the hint, then navigate with the cluster selected. */
export function openGoto(g) {
  if (!g || !g.page) return;
  if (g.focus) setFocus(g.page, g.focus);
  navigateTo(g.page, null, { cluster: g.clusterId || null });
}

/** Rule ids with no FOCUS entry — empty when the table is complete. For the test. */
export function rulesWithoutTarget() {
  return ALERT_RULES.filter((r) => !(r.id in FOCUS)).map((r) => r.id);
}
