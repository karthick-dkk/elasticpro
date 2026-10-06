/**
 * The alerts this app raises, as a list rather than as fourteen scattered decisions.
 *
 * Every rule here already existed inside `alerts()`; this is a registry describing them,
 * not a second engine. An admin can switch one off or move its threshold, and that is
 * all — writing genuinely new rules is what the automation rule builder is for, and
 * building a second authoring surface beside it would leave two screens that both make
 * alerts with no way to tell which produced the one in front of you.
 *
 * A rule's `id` is the stable part of the alert key it produces. Keys are per instance —
 * `vm-1:slm-stale:daily` names a cluster and a policy — so the id is the family, and
 * `matches()` decides whether a given key belongs to it. Nothing about identity changes
 * when a rule is disabled or retuned, so nothing an operator acknowledged is orphaned.
 */

/**
 * `page` is the page that answers the rule — where an operator goes to act on it. Both the
 * link on an alert here and the "Troubleshoot in ElasticPro" link on a Zabbix problem
 * read it, so the two cannot send the same alert to different places.
 *
 * @typedef {{ id:string, page:string, label:string, why:string, level:'critical'|'warning',
 *             thresholds?: Array<{key:string,label:string,unit:string,min:number,max:number}> }} AlertRule
 */

/** @type {AlertRule[]} */
export const ALERT_RULES = [
  { id: 'unreachable', page: 'overview', label: 'Cluster unreachable', level: 'critical',
    why: 'The cluster did not answer. Everything else on this page about it is stale.' },
  { id: 'health', page: 'shards', label: 'Cluster health red or yellow', level: 'critical',
    why: 'Red means data is missing; yellow means a replica has nowhere to go.' },
  { id: 'disk', page: 'shards', label: 'Disk usage above threshold', level: 'critical',
    why: 'Elasticsearch stops allocating shards at the high watermark and stops writing at the flood stage.',
    thresholds: [
      { key: 'diskWarnPercent', label: 'Warn at', unit: '%', min: 50, max: 99 },
      { key: 'diskCritPercent', label: 'Critical at', unit: '%', min: 50, max: 99 },
    ] },
  { id: 'disk-balance', page: 'shards', label: 'Disk unevenly spread across nodes', level: 'warning',
    why: 'One node filling while others have room is a placement problem, not a capacity one.' },
  { id: 'disk-unaccounted', page: 'shards', label: 'Disk not accounted for by any index', level: 'warning',
    why: 'Data the cluster state does not know about — a dangling index or orphaned shard directories.' },
  { id: 'capacity', page: 'shards', label: 'Disk capacity changed', level: 'critical',
    why: 'The size of the storage itself moved. Growing is worth knowing; shrinking is a lost data path.' },
  { id: 'no-master', page: 'shards', label: 'No master node', level: 'critical',
    why: 'The cluster cannot accept changes to its state until one is elected.' },
  { id: 'master-changed', page: 'shards', label: 'Master moved', level: 'critical',
    why: 'The previous master left, was cut off or was restarted, and problems in that window start there.' },
  { id: 'ilm', page: 'indices', label: 'Indices in an ILM error step', level: 'warning',
    why: 'Lifecycle management has stopped for those indices; they will not roll over or delete.' },
  { id: 'slm-mode', page: 'snapshots', label: 'SLM not running', level: 'warning',
    why: 'Snapshot lifecycle is stopped, so scheduled backups are not being taken.' },
  { id: 'slm-fail', page: 'snapshots', label: 'Last SLM run failed', level: 'critical',
    why: 'The most recent scheduled snapshot did not succeed.' },
  { id: 'slm-stale', page: 'snapshots', label: 'No recent successful snapshot', level: 'warning',
    why: 'Backups have stopped running rather than started failing.',
    thresholds: [{ key: 'snapshotStaleHours', label: 'Stale after', unit: 'h', min: 1, max: 720 }] },
  { id: 'repo', page: 'snapshots', label: 'Snapshot repository problems', level: 'critical',
    why: 'A repository is unreadable, empty, or its recent snapshots failed.' },
  { id: 'log-delay', page: 'logs', label: 'Devices shipping logs late', level: 'critical',
    why: 'Logs are arriving behind real time — searches and detections see the past, not now. '
       + 'Critical when a device is past its critical delay, warning when only delayed.' },
  { id: 'automation', page: 'automation', label: 'Automation rule has work waiting', level: 'warning',
    why: 'A rule you set to notify found indices matching it. Nothing ran: the work waits for a person in the app.' },
  { id: 'volume', page: 'overview', label: 'Field volume spike', level: 'warning',
    why: 'One value is producing far more documents than its recent average.' },
];

export function ruleById(id) { return ALERT_RULES.find((r) => r.id === id) || null; }

/**
 * The page that answers an alert or a Zabbix problem.
 *
 * The rule decides when there is one. Without one — a problem raised by Zabbix's own
 * Elasticsearch or Linux templates, which carry no rule tag — the words decide, in the
 * order the question is most specific: a snapshot problem that mentions a shard is still
 * a snapshot problem.
 */
export function pageForProblem(ruleId, text) {
  const t = String(text || '').toLowerCase();
  // Zabbix names an ElasticPro problem after its rule ("Disk capacity changed — …"), and
  // does not fill {EVENT.TAGS.rule} into a script's URL — so the name is the rule too.
  const rule = ruleById(ruleId) || ALERT_RULES.find((r) => t.startsWith(r.label.toLowerCase()));
  if (rule && rule.page) return rule.page;
  if (/snapshot|slm|backup|repositor/.test(t)) return 'snapshots';
  if (/log delay|delayed device|ingest delay/.test(t)) return 'logs';
  if (/indices size|volume|client plan/.test(t)) return 'volume';
  if (/ilm/.test(t)) return 'indices';
  // A disk alert is a placement problem: the page that can act on it is the one that
  // moves shards off the full node. Health and masters are read there too.
  if (/shard|disk|master|node|heap|jvm|health/.test(t)) return 'shards';
  return 'overview';
}

/**
 * Which rule produced this alert key.
 *
 * Keys are `<clusterId>:<family>` with anything after that naming the instance. Matching
 * on the family segment means an id never has to encode a cluster or a policy name, so
 * the registry stays a list of rules rather than a list of alerts.
 */
export function ruleForKey(key) {
  const family = String(key || '').split(':')[1] || '';
  return ALERT_RULES.find((r) => r.id === family) || null;
}

/** Settings live beside the automation rules, in the same file and under the same gate. */
export function loadAlertSettings(raw) {
  const v = raw && raw.alertRules;
  return v && typeof v === 'object' ? v : {};
}

/** A rule is on unless somebody turned it off. Absent means enabled. */
export function isEnabled(settings, id) {
  const s = settings && settings[id];
  return !(s && s.enabled === false);
}

/**
 * Drop alerts whose rule is switched off.
 *
 * Applied where alerts are consumed rather than where they are raised, so `alerts()`
 * stays one description of what is true and the registry decides what is shown. An alert
 * from a family nobody registered is always kept — an unknown rule is not a disabled one.
 */
export function applySettings(list, settings) {
  return list.filter((a) => {
    const rule = ruleForKey(a.key);
    return rule ? isEnabled(settings, rule.id) : true;
  });
}

/** Thresholds an admin has moved, merged over the shipped defaults. */
export function effectiveDefaults(defaults, settings) {
  const out = { ...defaults };
  for (const rule of ALERT_RULES) {
    const s = settings && settings[rule.id];
    if (!s || !s.thresholds) continue;
    for (const t of rule.thresholds || []) {
      const v = s.thresholds[t.key];
      if (typeof v === 'number' && isFinite(v) && v >= t.min && v <= t.max) out[t.key] = v;
    }
  }
  return out;
}
