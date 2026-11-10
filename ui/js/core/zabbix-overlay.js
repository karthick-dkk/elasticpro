/**
 * Edits made in ElasticPro to a cluster that comes from Zabbix — the page's half of the core's
 * overlay (crates/elasticpro-core/src/zbx_overlay.rs). Zabbix itself is never written to.
 *
 * The address is never one of them: it always comes from Zabbix. A credential is not either:
 * an administrator's typed one is kept encrypted on the server (CREDENTIAL_SET), like a config
 * cluster's own. The type, ULM and SLM are CLUSTER_META_SET's. Pure, no DOM.
 */

/** Every field an edit may set — the core's `zbx_overlay::FIELDS`. */
export const OVERLAY_FIELDS = Object.freeze([
  'name', 'via', 'tls', 'enabled', 'tags', 'note', 'liveRetention', 'snapshotRetention', 'backupCapacity',
  'volumeWindowDays', 'volumeTopDays', 'volumeHeadroomPercent',
]);

/** With the address, where the requests go: what a cluster's own credential is bound to. */
export const DESTINATION_FIELDS = Object.freeze(['via', 'tls']);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What `ZABBIX_CLUSTER_SAVE` sends, from the dialog. Each entry is one field: its value now and
 * when the dialog opened (`null` = empty), whether it is set in ElasticPro, and whether "Use
 * Zabbix's value" was pressed for it. A field nobody touched is not sent; one emptied that was
 * set in ElasticPro is reset (Zabbix's value, or none, again); a reset of a field that was never
 * set is nothing to do.
 * @param {{key: string, now: any, was: any, overridden: boolean, reset?: boolean}[]} entries
 * @returns {{set: Object, reset: string[]}}
 */
export function overlayChange(entries) {
  const set = {};
  const reset = [];
  for (const e of entries || []) {
    if (!OVERLAY_FIELDS.includes(e.key)) continue;
    if (e.reset) { if (e.overridden) reset.push(e.key); continue; }
    if (same(e.now, e.was)) continue;
    if (e.now === null || e.now === undefined) { if (e.overridden) reset.push(e.key); continue; }
    set[e.key] = e.now;
  }
  return { set, reset };
}

/** Whether a change moves where the cluster's requests go (its route or certificate setting). */
export function movesDestination(change) {
  return DESTINATION_FIELDS.some((k) => k in (change.set || {}) || (change.reset || []).includes(k));
}

/** Whether there is anything to send. */
export const changesSomething = (change) => Object.keys(change.set || {}).length > 0 || (change.reset || []).length > 0;

/**
 * How a Zabbix cluster signs in when no credential of its own was set in ElasticPro, in words —
 * from the row's `credential` (bridge::zabbix_build). Pure.
 */
export function zabbixCredentialLabel(credential) {
  switch (credential) {
    case 'vault': return 'from Vault';
    case 'plain-macro': return 'the host’s password macro';
    case 'core-secret': return 'handed over by Cluster Management';
    case 'core-default': return 'the default credential';
    case 'elasticpro': return 'ElasticPro’s credential for the address';
    case 'password-not-set': return 'none readable — password not set';
    case 'none': return 'none';
    default: return 'as set on the Zabbix host';
  }
}
