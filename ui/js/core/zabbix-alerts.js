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
  for (const rule of ZABBIX_ALERT_RULES) {
    const mine = (alertsForCluster || []).filter((a) => ruleOf(a) === rule);
    const level = mine.reduce((m, a) => Math.max(m, LEVEL_VALUE[a.level] || 0), 0);
    const detail = mine.slice(0, 3).map((a) => a.title + (a.detail ? ` — ${a.detail}` : '')).join(' | ')
      + (mine.length > 3 ? ` | and ${mine.length - 3} more` : '');
    const word = level === 2 ? 'critical' : 'warning';
    out[rule] = { level, detail: level ? `${word}: ${detail}`.slice(0, 250) : '' };
  }
  return out;
}
