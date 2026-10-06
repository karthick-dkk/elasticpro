/**
 * The Clusters page's figures, from what Zabbix already measured.
 *
 * Zabbix polls each Elasticsearch cluster through the cluster template; reading its latest
 * values means this app does not poll the same endpoints again from every open tab. Four
 * of the page's calls have their answer in Zabbix — the cluster's root, its health, ILM
 * and SLM status — and each is taken from Zabbix only while Zabbix's value is fresh. A
 * stale or missing one is left null, and the caller asks Elasticsearch for that one
 * directly. Nothing here guesses: an item with no value is unknown, never zero.
 *
 * Freshness is per item, because the template's items do not all move at the same pace.
 * Health is polled every two minutes. Node counts, disk totals and versions are stored
 * "discard unchanged, heartbeat 1h": their clock moves when the value changes or once an
 * hour, so a steady node count is an hour old and perfectly current.
 */

const MIN = 60;

/** key → how old its value may be, in seconds, before it is not believed. */
export const ZABBIX_ITEMS = {
  'es.cluster.status': 5 * MIN,
  'es.cluster.unassigned_shards': 5 * MIN,
  'es.cluster.initializing_shards': 5 * MIN,
  'es.cluster.relocating_shards': 5 * MIN,
  'es.cluster.delayed_unassigned_shards': 5 * MIN,
  'es.cluster.number_of_pending_tasks': 5 * MIN,
  'es.cluster.inactive_shards_percent_as_number': 5 * MIN,
  'es.cluster.number_of_nodes': 65 * MIN,
  'es.cluster.number_of_data_nodes': 65 * MIN,
  'es.version': 65 * MIN,
  'es.cluster.get_ilm': 125 * MIN,
  'es.cluster.get_slm': 125 * MIN,
};

const STATUS = { 0: 'green', 1: 'yellow', 2: 'red' };       // 255 is "unknown": not believed

function fresh(items, key, now) {
  const it = items && items[key];
  if (!it || !it.clock || it.value === undefined || it.value === '') return null;
  if (now - Number(it.clock) > ZABBIX_ITEMS[key]) return null;
  return it;
}
const num = (it) => (it === null || !isFinite(Number(it.value)) ? null : Number(it.value));

/**
 * `{ root, health, ilm, slmStatus }`, each a settled-shaped `{ok, value}` or null to ask
 * Elasticsearch instead; and `ages`, how old each figure taken from Zabbix is.
 */
export function fromZabbix(items, now) {
  const out = { root: null, health: null, ilm: null, slmStatus: null, ages: {} };
  const need = ['es.cluster.status', 'es.cluster.unassigned_shards', 'es.cluster.initializing_shards',
    'es.cluster.relocating_shards', 'es.cluster.number_of_nodes', 'es.cluster.number_of_data_nodes'];
  const got = Object.fromEntries(need.map((k) => [k, fresh(items, k, now)]));
  const status = got['es.cluster.status'] && STATUS[num(got['es.cluster.status'])];
  // Health from Zabbix only when every part of it is there and current. Half a health
  // object is worse than asking: a page cannot tell which half is missing.
  if (status && need.every((k) => num(got[k]) !== null)) {
    const inactive = num(fresh(items, 'es.cluster.inactive_shards_percent_as_number', now));
    out.health = { ok: true, value: {
      status,
      number_of_nodes: num(got['es.cluster.number_of_nodes']),
      number_of_data_nodes: num(got['es.cluster.number_of_data_nodes']),
      unassigned_shards: num(got['es.cluster.unassigned_shards']),
      initializing_shards: num(got['es.cluster.initializing_shards']),
      relocating_shards: num(got['es.cluster.relocating_shards']),
      delayed_unassigned_shards: num(fresh(items, 'es.cluster.delayed_unassigned_shards', now)),
      number_of_pending_tasks: num(fresh(items, 'es.cluster.number_of_pending_tasks', now)),
      active_shards_percent_as_number: inactive === null ? null : 100 - inactive,
    } };
    out.ages.health = now - Math.min(...need.map((k) => Number(got[k].clock)).filter((c) => now - c <= 5 * MIN).concat(now));
  }
  const ver = fresh(items, 'es.version', now);
  if (ver) {
    out.root = { ok: true, value: { version: { number: String(ver.value) } } };
    out.ages.root = now - Number(ver.clock);
  }
  // The template maps both to 1 RUNNING, 0 STOPPED.
  const mode = (k) => { const v = num(fresh(items, k, now)); return v === 1 ? 'RUNNING' : v === 0 ? 'STOPPED' : null; };
  const ilm = mode('es.cluster.get_ilm');
  if (ilm) out.ilm = { ok: true, value: { operation_mode: ilm } };
  const slm = mode('es.cluster.get_slm');
  if (slm) out.slmStatus = { ok: true, value: { operation_mode: slm } };
  return out;
}
