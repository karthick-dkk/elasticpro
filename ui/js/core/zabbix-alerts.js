/**
 * Which of ElasticPro's alert rules become Zabbix triggers — the one list.
 *
 * The scraper sends these, the Zabbix template is generated from these, and inside Zabbix
 * the pages hand alerts over to Zabbix on the strength of these. Five rules are left out
 * because the Elasticsearch cluster template Zabbix already runs says the same thing, and
 * one condition must raise one alarm:
 *
 *   unreachable  ~ "Service is down"                 health   ~ "Health is RED / YELLOW"
 *   no-master    ~ "Cluster has only two masters"    slm-mode ~ "SLM Status Changed"
 *   volume       ~ "Indices size above average"
 */
export const ZABBIX_ALERT_RULES = [
  'disk', 'disk-balance', 'disk-unaccounted', 'capacity',
  'master-changed', 'ilm', 'slm-fail', 'slm-stale', 'repo', 'log-delay', 'automation',
];

/** The rules Zabbix's own template already covers, with what covers them. */
export const COVERED_BY_ZABBIX = {
  unreachable: 'Elasticsearch: Service is down',
  health: 'Elasticsearch: Health is RED / YELLOW / UNKNOWN',
  'no-master': 'Elasticsearch: Cluster has only two master nodes',
  'slm-mode': 'Elasticsearch SLM Status Changed',
  volume: 'ES Indices size above than avg',
};

/** `vm-1:disk` or `vm-1:slm-fail:daily` → `disk` / `slm-fail`. */
export const ruleOf = (alert) => String((alert && alert.key) || '').split(':')[1] || '';

/** 0 clear · 1 warning · 2 critical — the item value a trigger compares against. */
export const LEVEL_VALUE = { warning: 1, critical: 2 };

/**
 * One cluster's alerts as the values Zabbix receives: per rule, the worst level present
 * and a one-line detail. A rule with nothing open is sent as 0 with an empty detail, so
 * a trigger clears the moment the condition does rather than when the value goes stale.
 *
 * The detail starts with its level — "critical: …" — and the triggers read that one item.
 * Two items (a level and a text) raced: Zabbix opened the problem when the level arrived
 * and froze its name before the matching text was stored, so a problem could say
 * "critical" at warning severity. One item cannot disagree with itself.
 */
export function zabbixAlertValues(alertsForCluster) {
  const out = {};
  // Held alerts (worked out from a down cluster's cached data) are never sent as current.
  const current = (alertsForCluster || []).filter((a) => a && !a.cached && !a.held);
  for (const rule of ZABBIX_ALERT_RULES) {
    const mine = current.filter((a) => ruleOf(a) === rule);
    const level = mine.reduce((m, a) => Math.max(m, LEVEL_VALUE[a.level] || 0), 0);
    const detail = mine.slice(0, 3).map((a) => a.title + (a.detail ? ` — ${a.detail}` : '')).join(' | ')
      + (mine.length > 3 ? ` | and ${mine.length - 3} more` : '');
    const word = level === 2 ? 'critical' : 'warning';
    out[rule] = { level, detail: level ? `${word}: ${detail}`.slice(0, 250) : '' };
  }
  return out;
}

/**
 * What to send Zabbix for one cluster's rules this run: the values, or null — send none.
 *
 * A cluster that did not answer has rules nobody can evaluate now. Sending 0 ("clear") for
 * each resolved every ElasticPro problem on its host the minute it went down, and reopened
 * them — as new events, freshly notified — the minute it came back. Unknown is not zero: no
 * value is sent, so each trigger keeps the state it had (the triggers read the detail's last
 * value, alerts.find()). The outage itself is Zabbix's own "Service is down". When the cluster
 * answers, the next run sends every rule again: one still true stays the same open problem,
 * one that cleared while it was down resolves.
 */
export function zabbixAlertsToSend(reachable, alertsForCluster) {
  return reachable ? zabbixAlertValues(alertsForCluster) : null;
}

/** Every rule clear: what a cluster ElasticPro no longer watches is sent, once. */
export function zabbixAlertsCleared() {
  return Object.fromEntries(ZABBIX_ALERT_RULES.map((r) => [r, { level: 0, detail: '' }]));
}

/**
 * The Zabbix hosts rule values were sent to for clusters this run no longer has (removed, or
 * switched off). Sending nothing for a cluster that is not answering keeps its problems as
 * they were — right through an outage, wrong for good: a cluster that went down and was then
 * removed would never be sent a value again, and its problems would stay open for ever. So
 * each is sent every rule clear once (zabbixAlertsCleared) and then forgotten.
 *
 * `sent`: {clusterId: zabbixHost} remembered from earlier runs. Returns `clear` [{id, host}]
 * and `keep` — the remembered ones still configured, down or not.
 */
export function alertHostsToClear(sent, activeIds) {
  const active = new Set(activeIds || []);
  const clear = [];
  const keep = {};
  for (const [id, host] of Object.entries(sent || {})) {
    if (!host) continue;
    if (active.has(id)) keep[id] = host;
    else clear.push({ id, host });
  }
  return { clear, keep };
}
