/** Application state, refresh loop and auto-reconnect. */

import { EsClient, primeWorker, setBadge, requestStats, workerStatus,
         fleetState, clusterDataset, refreshFleet } from './es.js';
// lib/fmt is a leaf: no cycle, and two alert sentences need to read like the rest of the UI.
import { bytes as bytesish, ago } from '../lib/fmt.js';
// Cyclic with field-volume.js, which needs client() from here. Safe because both sides
// only touch the other inside functions, never while the modules are evaluating.
import { fieldVolumeSpikes, clearFieldVolume } from './field-volume.js';
import { diskBalance, balanceHeadline, primaryAction } from './disk-balance.js';
import { DEFAULTS, authHeaderFor, loadZabbixClusters, mergeZabbixClusters, zabbixDrift } from './config.js';
import { ZABBIX_ITEMS, fromZabbix } from './zabbix-metrics.js';
import { bridge, subscribe } from './transport.js';
import { automationAlerts } from './automation.js';
import { loadAlertSettings, applySettings, effectiveDefaults } from './alert-rules.js';
// Bounded fan-out for the fleet refresh loop — see runBounded's own doc comment for why:
// a page asking every cluster something at once is a simultaneous aggregation against
// each one, and the clusters this app watches are the ones already under load.
import { runBounded } from './fleet.js';
import { spanDaysIso } from './volume.js';
import { clustersToAsk } from '../lib/demand.js';
import { limiter } from '../lib/limit.js';

class Emitter {
  constructor() { this.map = new Map(); }
  on(ev, fn) { (this.map.get(ev) || this.map.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { const s = this.map.get(ev); if (s) s.delete(fn); }
  emit(ev, payload) {
    // Anything but the clock tick may have changed what alerts() would say.
    if (ev !== 'tick' && ev !== 'refreshing') alertsMemo.rev++;
    if (ev === 'data' || ev === 'indices' || ev === 'config') {
      if (typeof payload === 'string') revs.byId.set(payload, (revs.byId.get(payload) || 0) + 1);
      else revs.all++;
    }
    (this.map.get(ev) || []).forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
  }
}

/**
 * alerts() is a walk over every cluster, every repository's snapshots and every node, and
 * a page asks for it several times per draw — on a hundred-odd clusters that was a large
 * part of each redraw. See cachedAlerts().
 */
const alertsMemo = { rev: 0, at: 0, forRev: -1, value: null, deps: [] };

/**
 * A number that changes whenever a cluster's data does: every 'data' or 'indices' event
 * about it, and every one about no cluster in particular (a new config, a delay summary).
 * Pages use it as part of the signature of what they drew for that cluster (lib/keyed.js),
 * so an unchanged cluster's row is not rebuilt because another cluster's answer arrived.
 */
const revs = { all: 0, byId: new Map() };
export function clusterRev(id) { return `${revs.all}.${revs.byId.get(id) || 0}`; }
const ALERTS_MEMO_MS = 1000;
/** Forget the memoised alert list — for a caller that changed state without the bus. */
export function invalidateAlerts() { alertsMemo.rev++; }

export const bus = new Emitter();

export const state = {
  mode: 'live',        // 'live' | 'snapshot'
  snapshot: null,      // metadata when mode === 'snapshot'
  config: null,
  handle: null,
  defaults: { ...DEFAULTS },
  clients: new Map(),
  data: new Map(),
  indices: new Map(),
  /** Shard table, tasks, thread pools and pending tasks per cluster — see fetchShards. */
  shards: new Map(),
  selected: 'all',
  autoRefresh: false,   // opt-in; see DEFAULTS.autoRefresh and the top-bar toggle
  lastRefresh: 0,
  /**
   * When each dataset was last fetched, keyed `${clusterId}:${dataset}`.
   *
   * Separate from lastRefresh, which says when ANY refresh ran. One timestamp made
   * indices fetched ten minutes ago and disk stats fetched ten seconds ago read as
   * equally current — and once a page serves cached data, its age stops being a detail
   * and becomes part of whether the number is true.
   */
  fetchedAt: {},
  refreshing: false,
  /** Who is signed in ({name, role}), on builds with accounts; null on the portable one. */
  caller: null,
  timer: null,
  tick: null,
  nextRefreshAt: 0,
};

export function clusters() { return state.config ? state.config.clusters.filter((c) => c.enabled) : []; }
export function client(id) { return state.clients.get(id); }
/** Record that `dataset` for `clusterId` was just fetched. */
export function stampFetch(clusterId, dataset) {
  state.fetchedAt[`${clusterId}:${dataset}`] = Date.now();
}

/** When it was fetched, or 0 if this dataset has never been read. */
export function fetchedAt(clusterId, dataset) {
  return state.fetchedAt[`${clusterId}:${dataset}`] || 0;
}

/**
 * The oldest fetch across several clusters — what a fleet-wide page must show.
 * Reporting the newest would describe the freshest cluster and quietly imply the
 * stalest one was just as current.
 */
export function oldestFetch(clusterIds, dataset) {
  const ts = clusterIds.map((id) => fetchedAt(id, dataset)).filter(Boolean);
  return ts.length === clusterIds.length && ts.length ? Math.min(...ts) : 0;
}

/**
 * One cluster's health as the operator should read it: 'green' | 'yellow' | 'red' |
 * 'unreachable' | 'loading'. Unreachable means a fetch was answered "no"; a cluster whose
 * health has not been read yet is 'loading' — never counted as green. The top bar and the
 * Clusters page both read this, so they cannot disagree.
 */
export function healthState(d) {
  if (!d) return 'loading';
  if (!d.reachable && d.updatedAt) return 'unreachable';
  const st = d.healthUnknown ? null : d.health && d.health.status;
  return st === 'green' || st === 'yellow' || st === 'red' ? st : 'loading';
}

export function activeClusters() {
  const all = clusters();
  return state.selected === 'all' ? all : all.filter((c) => c.id === state.selected);
}

/**
 * A credential typed into the app rather than read from the YAML.
 * Memory only: it is never written to disk unless you tick "remember in the OS vault".
 * It is re-applied after a config reload so editing the YAML does not log you out.
 */
let sessionCred = null;

export function hasSessionCredential() { return !!sessionCred; }
export function sessionCredentialLabel() {
  if (!sessionCred) return '';
  if (sessionCred.apiKey) return 'API key';
  if (sessionCred.bearer) return 'bearer token';
  return sessionCred.username || 'credential';
}

/** Clusters the config file did not supply a usable secret for. */
export function clustersNeedingCredential() {
  return clusters().filter((c) => c.needsCred && !c.anonymous && c.source !== 'zabbix');
}

/** Clusters whose credential was rejected by Elasticsearch. */
export function clustersWithAuthError() {
  // A Zabbix cluster's credential is fixed in Vault or on its Zabbix host, never by typing
  // one here — the Config page's Zabbix tab says which.
  return clusters().filter((c) => { const cl = state.clients.get(c.id); return c.source !== 'zabbix' && cl && cl.state === 'auth_error'; });
}

/** A username the YAML already named, to prefill the prompt. */
export function suggestedUsername() {
  const c = clusters().find((x) => x.suggestedUsername);
  return c ? c.suggestedUsername : '';
}

function stampCredential(c, cred) {
  c.authHeader = authHeaderFor(cred);
  c.credSource = 'session';
  c.needsCred = false;
  c.anonymous = false;
  c.clearCred = false;
  c.username = cred.username || (cred.apiKey ? '(api key)' : cred.bearer ? '(bearer)' : '');
}

/** Stamp an unlocked (decrypted) credential onto one cluster — file-sourced, not session. */
export function applyUnlockedCredential(clusterId, cred) {
  const c = state.config && state.config.clusters.find((x) => x.id === clusterId);
  if (!c) return;
  stampCredential(c, cred);
  c.credSource = c.hasOwnCred ? 'cluster' : 'shared';
}

/** Re-apply the typed credential after a config reload. */
export function applySessionCredential({ overrideAll = false } = {}) {
  if (!sessionCred || !state.config) return 0;
  let n = 0;
  for (const c of state.config.clusters) {
    if (c.source === 'zabbix') continue;
    if (c.needsCred || c.credSource === 'session' || overrideAll) { stampCredential(c, sessionCred); n++; }
  }
  return n;
}

/**
 * Store a credential typed by the user and push it to every cluster that needs one
 * (or to all clusters when overrideAll is set), then reconnect.
 */
export async function setSessionCredential(cred, { overrideAll = false } = {}) {
  sessionCred = cred;
  const n = applySessionCredential({ overrideAll });
  for (const c of state.config.clusters) {
    const cl = state.clients.get(c.id);
    if (cl) { cl.failures = 0; cl.nextRetryAt = 0; cl.state = 'unknown'; }
  }
  await reprime();
  bus.emit('config', state.config);
  return n;
}

/** Mark the clusters without a credential as deliberately anonymous. */
export async function continueAnonymously() {
  if (!state.config) return;
  for (const c of state.config.clusters) if (c.needsCred) c.anonymous = true;
  await reprime();
  bus.emit('config', state.config);
}

export async function clearSessionCredential() {
  sessionCred = null;
  if (state.config) {
    for (const c of state.config.clusters) {
      // `clearCred` makes the next prime say so explicitly; without it the core would keep
      // the credential it holds, which is the opposite of forgetting it.
      if (c.credSource === 'session' || c.credSource === 'server') {
        c.authHeader = null; c.credSource = 'none'; c.needsCred = true; c.username = ''; c.anonymous = false; c.clearCred = true;
      }
    }
  }
  await reprime();
  bus.emit('config', state.config);
}

export async function setConfig(config, handle) {
  // Every config, however it arrived, gets the clusters that are Zabbix hosts — here, once,
  // so reloading the file from the Config page cannot quietly drop them.
  mergeZabbixClusters(config, (await loadZabbixClusters()).clusters);
  state.config = config;
  state.handle = handle !== undefined ? handle : state.handle;   // the remembered path, or null for load-once
  // Shipped defaults, then the file's, then whatever an admin retuned on the Config page.
  // Applied here so every reader of state.defaults — alerts, pages, charts — sees one
  // answer, rather than each of them remembering to consult the settings.
  state.defaults = effectiveDefaults({ ...DEFAULTS, ...config.defaults },
    loadAlertSettings(config.raw));
  applySessionCredential();
  state.clients.clear();
  for (const c of config.clusters) {
    state.clients.set(c.id, new EsClient(c, state.defaults, reprime));
  }
  // Drop what we cached for clusters the file no longer names — otherwise a reload
  // that removed or renamed a cluster keeps rendering it from stale data.
  const live = new Set(config.clusters.map((c) => c.id));
  for (const m of [state.data, state.indices, state.shards, fleet.raw]) {
    for (const id of [...m.keys()]) if (!live.has(id)) m.delete(id);
  }
  clearFieldVolume();   // field analysis is tied to the config that produced it
  await reprime();
  bus.emit('config', config);
}

export function isReadOnly() { return state.defaults.readOnly !== false; }

export async function reprime() {
  if (!state.config) return;
  // The server's credential-free view has nothing to prime with, and nobody holding it
  // may prime anyway. The core already holds what an admin gave it.
  if (state.config.serverView) return;
  // Zabbix clusters are the core's own: it read their credentials from Vault, and a
  // browser priming them would only offer it a worse copy.
  // A config cluster set aside because Zabbix has its address is still primed: its
  // credential is the one "use ElasticPro credentials" hands to the Zabbix cluster there.
  const own = state.config.clusters.filter((c) => c.source !== 'zabbix').concat(state.config.shadowedClusters || []);
  const res = await primeWorker(own, isReadOnly(), state.config.jumpHosts || [],
    // Unlocked sealed secrets are not written to the server's disk in the clear.
    { persist: !state.config.sealed,
      // ElasticPro's own credential, for Zabbix clusters when the config asks for it: one
      // typed this session wins, as it does for every cluster; else the config's shared one.
      sharedAuthHeader: sessionCred ? authHeaderFor(sessionCred) : (state.config.sharedAuthHeader || '') });
  markServerHeld(res && res.held);
}

/**
 * Clusters the core already holds a credential for need no prompt.
 *
 * On the hosted build the config file usually holds no password — an admin typed it once
 * and the server kept it. Every page load is a fresh app that re-reads that file, so
 * without this each one asked for the password again although the server had it.
 */
export function markServerHeld(held) {
  if (!Array.isArray(held) || !state.config) return;
  const ids = new Set(held);
  for (const c of state.config.clusters) {
    if (ids.has(c.id) && c.needsCred && !c.anonymous) {
      c.needsCred = false;
      c.credSource = 'server';
      c.username = c.username || '(held by the server)';
    }
  }
}

/* ------------------------------- data fetching ------------------------------- */

function repoLocation(settings = {}) {
  if (settings.location) return settings.location;
  if (settings.bucket) return `${settings.bucket}${settings.base_path ? '/' + settings.base_path : ''}`;
  if (settings.container) return `${settings.container}${settings.base_path ? '/' + settings.base_path : ''}`;
  if (settings.url) return settings.url;
  if (settings.path) return settings.path;
  return '';
}

async function settled(p) {
  try { return { ok: true, value: await p }; } catch (e) { return { ok: false, error: e }; }
}

/**
 * Turn raw Elasticsearch responses into the shape every page renders from.
 * `raw` values are {ok, value} pairs, so a live fetch and a snapshot file take the
 * identical path through here — the pages cannot tell the two apart, and neither can
 * drift away from the other.
 */
export function buildClusterData(id, prev, raw) {
  const { root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths,
          ilmPolicies, ilmOfIndices, clusterSettings } = raw;
  const out = { ...prev, id, loading: false, updatedAt: raw.updatedAt || Date.now() };

  out.reachable = root.ok || health.ok;
  out.error = out.reachable ? null : (root.error && root.error.res) || { message: String(root.error && root.error.message) };
  out.info = root.ok ? root.value : prev.info || null;
  out.health = health.ok ? health.value : null;

  // disk usage aggregated from _cat/allocation (bytes)
  if (alloc.ok) {
    const rows = alloc.value.filter((r) => r.node && r.node !== 'UNASSIGNED');
    const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    out.disk = {
      used: sum('disk.used'), avail: sum('disk.avail'), total: sum('disk.total'),
      indicesBytes: sum('disk.indices'), shards: sum('shards'),
      percent: sum('disk.total') ? (sum('disk.used') / sum('disk.total')) * 100 : NaN,
      nodes: rows,
      unassignedShards: Number((alloc.value.find((r) => r.node === 'UNASSIGNED') || {}).shards || 0),
    };
  }
  out.nodes = nodes.ok ? nodes.value : [];

  // Total disk CAPACITY, and whether it changed since the last look.
  //
  // Not usage — the size of the disk itself. It should be a constant, so a change means
  // somebody added storage or a data path went away, and the second one is a fault that
  // looks like nothing else on this page.
  //
  // Guarded against the way it would otherwise cry wolf: disk.total is summed over the
  // nodes present in _cat/allocation RIGHT NOW, so a node restarting drops out of the
  // table and capacity appears to fall. A change is only believed when the node count is
  // the same at both readings; when nodes came or went, the new figure is adopted
  // silently as the baseline. A rolling restart should not page anybody.
  out.capacity = alloc.ok && out.disk
    ? capacityChange(prev.capacity, out.disk.total, (out.disk.nodes || []).length)
    : prev.capacity || null;

  // Who is master, and whether that changed since the last look.
  //
  // A master election is not a fault on its own, but it is never nothing: it means the
  // old master left, was partitioned off, or was restarted, and whatever else went wrong
  // in that window usually starts there. The previous holder is remembered so the alert
  // can say what it changed from — "master is node-3" is not news, "master moved from
  // node-1 to node-3" is.
  if (nodes.ok) {
    const now = (out.nodes.find((n) => String(n.master || '').trim() === '*') || {}).name || null;
    out.master = now;
    if (prev.master && now && prev.master !== now) {
      out.masterChangedFrom = prev.master;
      out.masterChangedAt = Date.now();
    } else {
      // Carried forward so the alert survives the refreshes after the election itself.
      out.masterChangedFrom = prev.masterChangedFrom || null;
      out.masterChangedAt = prev.masterChangedAt || null;
    }
  } else {
    out.master = prev.master || null;
    out.masterChangedFrom = prev.masterChangedFrom || null;
    out.masterChangedAt = prev.masterChangedAt || null;
  }
  out.ilm = ilm.ok ? ilm.value : null;
  out.ilmErrorCount = ilmErr.ok && ilmErr.value && ilmErr.value.indices ? Object.keys(ilmErr.value.indices).length : 0;
  out.ilmErrors = ilmErr.ok && ilmErr.value ? ilmErr.value.indices || {} : {};
  out.slmStatus = slmStatus.ok ? slmStatus.value : null;
  out.slm = slm.ok ? Object.entries(slm.value || {}).map(([pid, p]) => ({ id: pid, ...p })) : [];
  // Unknown (the fleet cache has not fetched it yet) is not "this cluster has no SLM API".
  out.slmSupported = slm.ok ? true : slm.unknown ? (prev.slmSupported ?? null) : false;

  if (repoPaths.ok && repoPaths.value && repoPaths.value.nodes) {
    const set = new Set();
    Object.values(repoPaths.value.nodes).forEach((n) => {
      const r = n.settings && n.settings.path && n.settings.path.repo;
      (Array.isArray(r) ? r : r ? [r] : []).forEach((p) => set.add(p));
    });
    out.pathRepo = [...set];
  }

  if (repos.ok) {
    out.repos = Object.entries(repos.value || {}).map(([name, r]) => ({
      name, type: r.type, settings: r.settings || {}, location: repoLocation(r.settings || {}),
    }));
  } else out.repos = prev.repos || [];

  out.clusterSettings = clusterSettings && clusterSettings.ok ? clusterSettings.value : prev.clusterSettings || null;
  out.appliedIlm = appliedIlm(ilmPolicies, ilmOfIndices) || prev.appliedIlm || null;
  out.appliedSlm = appliedSlm(out.slm) || prev.appliedSlm || null;

  return out;
}

/**
 * The ILM policy the log indices are actually attached to, and the age at which it
 * deletes them — the cluster's real live retention, whatever the config claims.
 *
 * Which policy is in force is answered by the indices themselves rather than guessed:
 * a cluster can define a dozen policies and apply none of them.
 */
function appliedIlm(policiesRes, ofIndicesRes) {
  if (!policiesRes || !policiesRes.ok) return null;
  const policies = policiesRes.value || {};

  // Count how many indices name each policy; the commonest one governs the logs.
  const counts = new Map();
  if (ofIndicesRes && ofIndicesRes.ok) {
    for (const entry of Object.values(ofIndicesRes.value || {})) {
      const name = entry && entry.settings && entry.settings.index
        && entry.settings.index.lifecycle && entry.settings.index.lifecycle.name;
      if (name) counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  let name = null, indices = 0;
  for (const [n, c] of counts) if (c > indices) { name = n; indices = c; }
  // No index says so, but the cluster defines exactly one policy — that is the answer.
  if (!name) {
    const only = Object.keys(policies);
    if (only.length === 1) name = only[0];
  }
  if (!name || !policies[name]) return name ? { name, indices, deleteAfter: null, phases: [] } : null;

  const phases = (policies[name].policy && policies[name].policy.phases) || {};
  const order = ['hot', 'warm', 'cold', 'frozen', 'delete'];
  return {
    name,
    indices,
    deleteAfter: (phases.delete && phases.delete.min_age) || null,
    phases: order.filter((p) => phases[p]).map((p) => ({ phase: p, minAge: phases[p].min_age || '0ms' })),
    modifiedDate: policies[name].modified_date_string || null,
  };
}

/** The SLM policy actually configured, and the age at which it expires snapshots. */
function appliedSlm(slmList) {
  const list = slmList || [];
  if (!list.length) return null;
  // Prefer one that has actually run; a policy that never fired says little.
  const chosen = list.find((p) => p.last_success) || list[0];
  const pol = chosen.policy || {};
  const ret = pol.retention || {};
  return {
    name: chosen.id,
    repository: pol.repository || null,
    schedule: pol.schedule || null,
    expireAfter: ret.expire_after || null,
    minCount: ret.min_count ?? null,
    maxCount: ret.max_count ?? null,
    policies: list.length,
  };
}

/**
 * Re-read one cluster's own state. With the fleet cache: the `health` dataset, fetched now
 * (a Retry on a connection banner means "try again", not "show me the cache"), then
 * whatever else changed. Without it: every call, as it always was.
 */
export async function fetchOverview(id, opts = {}) {
  if (fleetMode() && fleetKnows(id)) {
    const r = await fetchFleetDataset(id, 'health', { maxAgeSec: 0 });
    if (r && r.ok) { await syncFleet(); return state.data.get(id) || null; }
  }
  return fetchOverviewDirect(id, opts);
}

async function fetchOverviewDirect(id, { withSnapshots = true } = {}) {
  const cl = state.clients.get(id);
  if (!cl) return null;
  const prev = state.data.get(id) || {};

  // Reach for the cluster before interrogating it.
  //
  // These two decide reachability (see buildClusterData), so both are tried. The other
  // eleven are only worth sending to something that answered: against a cluster that is
  // down they are eleven more connection timeouts establishing a fact the first two
  // already established, and they are why an offline cluster reported twenty-six
  // requests in five minutes — thirteen per refresh, every refresh, none of them
  // arriving anywhere.
  // A cluster that is a Zabbix host: what Zabbix already measured, where it is fresh, so
  // this tab does not poll the same endpoints again. Anything stale or missing is asked
  // of Elasticsearch directly, one call at a time.
  const z = cl.c.source === 'zabbix' ? await zabbixSide(id) : null;
  const [root, health] = await Promise.all([
    z && z.root ? { ok: true, value: { ...(prev.info || {}), ...z.root.value, version: { ...((prev.info || {}).version || {}), ...z.root.value.version } } }
      : settled(cl.root()),
    z && z.health ? z.health : settled(cl.health()),
  ]);
  const answered = root.ok || health.ok;

  // The same shape settled() produces, so buildClusterData cannot tell a skipped call
  // from a failed one and needs no special case for this.
  const skipped = () => ({ ok: false, error: (root.error || health.error), skipped: true });

  const [alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths, ilmPolicies,
         ilmOfIndices, clusterSettings] = answered
    ? await Promise.all([
        settled(cl.allocation()), settled(cl.nodes()),
        settled(cl.repositories()), settled(cl.slmPolicies()),
        z && z.slmStatus ? z.slmStatus : settled(cl.slmStatus()),
        z && z.ilm ? z.ilm : settled(cl.ilmStatus()), settled(cl.ilmErrors()),
        settled(cl.json('GET', '/_nodes/settings?filter_path=nodes.*.settings.path.repo,nodes.*.name')),
        // What the cluster actually enforces, as opposed to what the config says it should.
        settled(cl.ilmPolicies()),
        settled(cl.ilmPolicyOfIndices(cl.c.logIndexPattern || '*')),
        // The real watermarks, so disk advice is not given against assumed thresholds.
        settled(cl.json('GET', '/_cluster/settings?include_defaults=true&flat_settings=true' +
          '&filter_path=**.disk.watermark**,**.allocation.enable,**.rebalance.enable')),
      ])
    : Array.from({ length: 11 }, skipped);

  const out = buildClusterData(id, prev, {
    root, health, alloc, nodes, repos, slm, slmStatus, ilm, ilmErr, repoPaths, ilmPolicies,
    ilmOfIndices, clusterSettings,
  });
  // Which figures came from Zabbix, and how old they were — the page says so.
  out.fromZabbix = z ? {
    parts: ['root', 'health', 'ilm', 'slmStatus'].filter((k) => z[k]),
    healthAge: z.ages.health ?? null,
  } : null;
  state.data.set(id, out);
  stampFetch(id, 'data');
  bus.emit('data', id);

  if (withSnapshots && out.repos.length) await fetchSnapshotsDirect(id);
  return out;
}

/** Zabbix's latest values for a Zabbix cluster, mapped; null when Zabbix cannot say. */
async function zabbixSide(id) {
  try {
    const res = await bridge({ type: 'ZABBIX_METRICS', clusterId: id, keys: Object.keys(ZABBIX_ITEMS) });
    return res && res.ok ? fromZabbix(res.items || {}, res.now || Math.floor(Date.now() / 1000)) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Snapshot inventory per repo, with the index names in each snapshot.
 *
 * With the fleet cache this is the `snapshots_full` dataset (the verbose listing), asked
 * for now — the background `snapshots` dataset is the light _cat listing, which counts
 * snapshots but cannot say what is in them. Without it, the listing is fetched directly.
 */
export async function fetchSnapshots(id, { force = true } = {}) {
  if (fleetMode() && fleetKnows(id)) {
    const r = await fetchFleetDataset(id, 'snapshots_full', { maxAgeSec: force ? 0 : undefined });
    if (r && r.ok) return;
  }
  return fetchSnapshotsDirect(id);
}

/**
 * Make sure the snapshot listing in state.data carries index names, where that is what the
 * caller is about to ask (coverage days, "is this index in a snapshot").
 *
 * A no-op on the direct path, whose listing is already the verbose one. With the fleet
 * cache it asks for `snapshots_full` — answered at once when the core holds a fresh one —
 * which also marks it watched, so the core keeps it current while somebody is looking.
 */
export async function ensureFullSnapshots(id) {
  if (!fleetMode() || !fleetKnows(id)) return;
  await fetchFleetDataset(id, 'snapshots_full', {});
}

/**
 * One snapshot row per snapshot, from the verbose `_snapshot/<repo>/_all` listing.
 *
 * One definition for the direct fetch and the fleet cache's `snapshots_full`, which
 * carries the same body — the pages cannot tell which one they are reading.
 */
export function snapshotRowsVerbose(j, reSrc) {
  return ((j && j.snapshots) || []).map((s) => {
    const names = s.indices || [];
    return {
      id: s.snapshot, status: s.state,
      start: s.start_time_in_millis, end: s.end_time_in_millis,
      duration: s.duration_in_millis,
      indices: names.length,
      indexNames: names,
      ...coveredDays(names, reSrc),
      successful: (s.shards || {}).successful || 0, failed: (s.shards || {}).failed || 0,
      total: (s.shards || {}).total || 0,
    };
  }).sort((a, b) => b.start - a.start);
}

/** The same rows from `_cat/snapshots/<repo>` — counts only, no index names. */
export function snapshotRowsCat(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    status: r.status,
    start: Number(r.start_epoch) * 1000,
    end: Number(r.end_epoch) * 1000,
    duration: r.duration,
    indices: Number(r.indices) || 0,
    // _cat does not name the indices, so the covered range is unknown rather
    // than empty — the page says so instead of showing a misleading blank.
    indexNames: null,
    coverFrom: null, coverTo: null, coverDays: 0, missingDays: 0,
    successful: Number(r.successful_shards) || 0,
    failed: Number(r.failed_shards) || 0,
    total: Number(r.total_shards) || 0,
  })).sort((a, b) => b.start - a.start);
}

async function fetchSnapshotsDirect(id) {
  const cl = state.clients.get(id);
  const d = state.data.get(id);
  if (!cl || !d) return;
  d.snapshots = d.snapshots || {};
  for (const repo of d.repos) {
    try {
      // The verbose listing is one call per repository and carries the index names,
      // which is what makes "which days of logs are actually in here" answerable.
      // _cat/snapshots is cheaper but returns only a count, so it is the fallback.
      d.snapshots[repo.name] = snapshotRowsVerbose(await cl.snapshots(repo.name, 500), cl.c.indexNameRegex);
      repo.error = null;
    } catch (e) {
      try {
        d.snapshots[repo.name] = snapshotRowsCat(await cl.snapshotsCat(repo.name));
        repo.error = null;
      } catch (e2) {
        d.snapshots[repo.name] = [];
        repo.error = e2.message;
      }
    }
  }
  state.data.set(id, d);
  stampFetch(id, 'data');
  bus.emit('data', id);
}

/**
 * Which days of data a snapshot actually holds, read from the dates in its index names.
 *
 * This is not the same question as when the snapshot ran: a snapshot taken this morning
 * can contain ninety days of daily indices, and it is the span of those that says how
 * far back the backup reaches.
 */
export function coveredDays(names, reSrc) {
  let from = null, to = null, dated = 0;
  const seen = new Set();
  for (const n of names || []) {
    const day = parseIndexName(n, reSrc).day;
    if (!day) continue;
    dated++;
    seen.add(day);
    if (from === null || day < from) from = day;
    if (to === null || day > to) to = day;
  }
  const span = spanDaysIso(from, to);
  // Days inside the span that no index in the snapshot carries: a gap in what it holds.
  return { coverFrom: from, coverTo: to, coverDays: span, datedIndices: dated, missingDays: span - seen.size };
}

/**
 * The index list. With the fleet cache (and the whole list, which is the only one it
 * keeps) the core's `indices` dataset, fetched first when it is older than its interval —
 * or at once when `force`, which is what a Reload button means. Otherwise directly.
 *
 * Throws when there is no list to give, as the direct call always has: an index list that
 * could not be fetched is unknown, and an empty array would read as "no indices".
 */
export async function fetchIndices(id, pattern = '*', { force = false } = {}) {
  if (pattern === '*' && fleetMode() && fleetKnows(id)) {
    const r = await fetchFleetDataset(id, 'indices', { maxAgeSec: force ? 0 : undefined });
    if (r && r.ok) {
      const e = r.entry || {};
      const a = e.data && e.data.indices;
      if (a && !a.ok) throw answerError(a);
      if (a && state.indices.has(id)) return state.indices.get(id);
      throw new Error((e.error && e.error.message)
        || (r.timedOut ? 'the index list is still being fetched — it will appear when it arrives'
                       : 'the index list has not been fetched yet'));
    }
    if (r && !FALL_BACK_KINDS.has(r.kind)) throw new Error(r.message || r.kind || 'the index list could not be read');
  }
  const cl = state.clients.get(id);
  if (!cl) return [];
  const rows = await cl.indices(pattern);
  const parsed = rows.map((r) => parseIndexName(r.index, cl.c.indexNameRegex, r));
  state.indices.set(id, parsed);
  stampFetch(id, 'indices');
  bus.emit('indices', id);
  return parsed;
}

/**
 * The default naming pattern before 2.6.1. It demanded a source between `logstash-` and the
 * date, so a plain daily index — `logstash-2026.09.23` — matched nothing and read as
 * undated everywhere: the snapshot dialog said "no dated indices" while listing seven of
 * them. The example config copied this string into `defaults:`, so most config files carry
 * it verbatim; it is read as the current default rather than asking everyone to edit
 * theirs. A pattern anyone actually wrote is used exactly as written.
 */
export const LEGACY_INDEX_RE = '^(?<prefix>[a-z0-9_.-]*?logstash)-(?<source>.+)-(?<date>\\d{4}[.\\-]\\d{2}[.\\-]\\d{2})$';

/** The pattern a cluster's index names are read with — the legacy default upgraded. */
export function effectiveIndexRe(reSrc) {
  if (reSrc === undefined || reSrc === null || reSrc === '' || reSrc === LEGACY_INDEX_RE) return DEFAULTS.indexNameRegex;
  return reSrc;
}

let cachedRe = { src: null, re: null };
export function parseIndexName(name, reSrc, row = {}) {
  if (cachedRe.src !== reSrc) {
    try { cachedRe = { src: reSrc, re: new RegExp(effectiveIndexRe(reSrc)) }; }
    catch { cachedRe = { src: reSrc, re: null }; }
  }
  const m = cachedRe.re ? cachedRe.re.exec(name) : null;
  const g = (m && m.groups) || {};
  return {
    index: name,
    // The named group is `source`; `client` is still accepted because configs written
    // before the rename use it, and "client" means a whole cluster in this app.
    source: g.source || g.client || null,
    day: g.date ? g.date.replace(/[.\-]/g, '-') : null,
    health: row.health, status: row.status,
    pri: Number(row.pri) || 0, rep: Number(row.rep) || 0,
    docs: Number(row['docs.count']) || 0,
    deleted: Number(row['docs.deleted']) || 0,
    size: Number(row['store.size']) || 0,
    priSize: Number(row['pri.store.size']) || 0,
    created: Number(row['creation.date']) || 0,
    uuid: row.uuid,
  };
}

/* --------------------------------- refreshing -------------------------------- */

/**
 * Re-read the fleet, or just the part of it being looked at.
 *
 * `selected: true` follows the cluster picker — one cluster when one is chosen, the whole
 * fleet on "All clusters". That is what the Refresh button means: refresh what is on
 * screen, not eleven clusters because one of them is.
 *
 * Everything else still sweeps the fleet, deliberately. Auto-refresh feeds the alert list
 * and the tab badge, which cover every cluster whichever one is selected, and a fleet
 * that only updated the cluster in front of you would go quietly stale everywhere else —
 * the failure being watched for is usually on the cluster nobody is looking at.
 */
/**
 * The parts of a cluster that can be refreshed on their own.
 *
 * A full refresh is thirteen calls per cluster. Most of the time the thing you are
 * watching is one of them — a snapshot you just started, an index you just deleted — and
 * waiting for the other twelve is the difference between a control that feels instant
 * and one you press twice because nothing appeared to happen.
 *
 * Exported as data so the menu is built from it: a module that exists here and not in
 * the menu is unreachable, and one in the menu but not here is a button that does
 * nothing, and both have happened in this codebase to other lists.
 */
export const REFRESH_MODULES = [
  { id: 'all', label: 'Everything', hint: 'health, nodes, indices, snapshots — the full refresh' },
  { id: 'health', label: 'Health only', hint: 'the fastest: two calls per cluster' },
  { id: 'indices', label: 'Indices', hint: 'the index list and its sizes' },
  { id: 'snapshots', label: 'Snapshots', hint: 'the repositories and what is in them' },
];

/**
 * Refresh one part, for the selected clusters.
 *
 * Returns the number of clusters it actually reached, so a caller can say "2 clusters"
 * rather than assuming it worked.
 */
export async function refreshModule(module, { selected = true } = {}) {
  if (module === 'all') { await refreshAll({ force: true, selected }); return (selected ? activeClusters() : clusters()).length; }
  if (state.refreshing || !state.config) return 0;
  state.refreshing = true;
  bus.emit('refreshing', true);
  const targets = selected ? activeClusters() : clusters();
  try {
    const viaFleet = (await detectFleet()) === 'fleet' && await refreshModuleFleet(module, targets);
    if (!viaFleet) {
      // Bounded rather than all-at-once: runBounded already swallows a worker's error into
      // an {error} entry per item, which is the same "one cluster failing must not stop the
      // rest" guarantee the old per-item try/catch gave, without asking every cluster at once.
      await runBounded(targets, async (c) => {
        if (module === 'snapshots') await fetchSnapshotsDirect(c.id);
        else if (module === 'indices') await fetchIndices(c.id, '*');
        // `health` re-reads the cluster's own state without the eleven calls that hang
        // off it — withSnapshots:false is what makes it the quick one.
        else if (module === 'health') await fetchOverviewDirect(c.id, { withSnapshots: false });
      }, { limit: 6 });
    }
    state.lastRefresh = Date.now();
  } finally {
    state.refreshing = false;
    bus.emit('refreshing', false);
    bus.emit('refreshed');
  }
  return targets.length;
}

/**
 * The datasets each refresh-menu entry asks the core for. The snapshot entry includes the
 * verbose listing only once something in this tab has needed it — asking for it marks it
 * watched, and the core then keeps polling it for every cluster named.
 */
function moduleDatasets(module) {
  if (module === 'health') return ['health'];
  if (module === 'indices') return ['indices'];
  if (module === 'snapshots') return ['policies', 'snapshots', ...(fleet.onDemand.has('snapshots_full') ? ['snapshots_full'] : [])];
  return backgroundNames();
}

/**
 * A refresh through the core: REFRESH queues the fetches (at once, ahead of the schedule)
 * and the answers arrive the way every other change does. With one cluster on screen the
 * first dataset is also waited for, so the button's spinner means something.
 */
async function refreshModuleFleet(module, targets) {
  const ids = targets.filter((c) => fleetKnows(c.id)).map((c) => c.id);
  const datasets = moduleDatasets(module);
  const r = await refreshFleet({ clusterIds: ids, datasets });
  if (!r || !r.ok) return false;
  for (const d of datasets) if (ON_DEMAND.has(d)) fleet.onDemand.add(d);
  if (ids.length === 1) await fetchFleetDataset(ids[0], datasets[datasets.length - 1], {});
  await syncFleet();
  // Anything the core does not hold (a cluster it was never given) is still asked directly.
  const rest = targets.filter((c) => !fleetKnows(c.id));
  if (rest.length) {
    await runBounded(rest, async (c) => {
      if (module === 'snapshots') await fetchSnapshotsDirect(c.id);
      else if (module === 'indices') await fetchIndices(c.id, '*');
      else await fetchOverviewDirect(c.id, { withSnapshots: false });
    }, { limit: 6 });
  }
  return true;
}

/**
 * Re-read the fleet.
 *
 * With the core's fleet cache (PING says `fleetCache: true`) this reads what the core
 * last found — FLEET_STATE {since} — and asks nobody anything; `force` (a person pressed
 * Refresh, or trusted a certificate) first has the core fetch the background datasets of
 * the named clusters now. The first read in a tab is never forced: a page load reading the
 * cache is the point of having one. Without the cache, every cluster is asked directly,
 * as it always was.
 */
export async function refreshAll({ force = false, selected = false } = {}) {
  if (state.refreshing || !state.config) return;
  state.refreshing = true;
  bus.emit('refreshing', true);
  try {
    const viaFleet = (await detectFleet()) === 'fleet'
      && await refreshAllFleet({ force: force && !!state.lastRefresh, selected });
    if (!viaFleet) {
      const targets = (selected ? activeClusters() : clusters()).filter((c) => {
        const cl = state.clients.get(c.id);
        return force || !cl || cl.state === 'online' || cl.state === 'unknown' || cl.canTryNow;
      });
      // Bounded fan-out (limit 6, see fleet.js) rather than every cluster's thirteen calls
      // landing on the core at once — see SPEC.md, "Measured problem": that was ~1,540
      // simultaneous requests on a 120-cluster fleet.
      await runBounded(targets, (c) => fetchOverviewDirect(c.id), { limit: 6 });
    }
    await refreshRequestLoad();
    state.lastRefresh = Date.now();
    state.nextRefreshAt = state.lastRefresh + (fleetMode() ? FLEET_FALLBACK_MS : state.defaults.refreshIntervalSec * 1000);
  } finally {
    state.refreshing = false;
    bus.emit('refreshing', false);
    bus.emit('refreshed');
  }
  updateBadge();
  publishPopupSummary();
}

async function refreshAllFleet({ force, selected }) {
  const targets = selected ? activeClusters() : clusters();
  if (force) {
    const ids = targets.filter((c) => fleetKnows(c.id)).map((c) => c.id);
    const r = await refreshFleet({ clusterIds: ids, datasets: backgroundNames() });
    if (r && r.ok && ids.length === 1) await fetchFleetDataset(ids[0], 'health', {});
  }
  const res = await syncFleet({ full: !fleet.seq });
  if (!res || !res.ok) {
    // An older core that does not know the message, or one that stopped its poller:
    // the direct path, for the rest of this page's life.
    if (res && NO_CACHE_KINDS.has(res.kind)) { fleet.mode = 'direct'; return false; }
    return true;   // e.g. a network blip: what is on screen stays, labelled with its age
  }
  if (res.running === false) { fleet.mode = 'direct'; return false; }
  // Clusters the core does not hold — in this config but never primed to it — are asked
  // directly, as before, rather than shown as unknown forever.
  const rest = targets.filter((c) => !fleetKnows(c.id));
  if (rest.length) await runBounded(rest, (c) => fetchOverviewDirect(c.id), { limit: 6 });
  return true;
}

export function startAutoRefresh() {
  stopAutoRefresh();
  if (fleetMode()) {
    // Told, not polling: the core says what changed (SSE in the browser, a 5 s local poll
    // on the desktop) and FLEET_STATE {since} fetches only that. The 60 s timer is the
    // fallback for a stream that died without saying so — a proxy that drops idle
    // connections, a laptop that slept.
    fleet.unsub = subscribe(onFleetEvent);
    state.nextRefreshAt = Date.now() + FLEET_FALLBACK_MS;
    state.timer = setInterval(() => {
      if (Date.now() < state.nextRefreshAt) return;
      state.nextRefreshAt = Date.now() + FLEET_FALLBACK_MS;
      pushedSync();
    }, 1000);
  } else {
    state.nextRefreshAt = Date.now() + state.defaults.refreshIntervalSec * 1000;
    state.timer = setInterval(() => {
      // Decided after the timer started (the first refresh found the cache): switch over.
      if (fleetMode()) { startAutoRefresh(); return; }
      if (!state.autoRefresh) { state.nextRefreshAt = Date.now() + state.defaults.refreshIntervalSec * 1000; return; }
      if (document.hidden) return;
      if (Date.now() >= state.nextRefreshAt) refreshAll();
    }, 1000);
  }
  state.tick = setInterval(() => bus.emit('tick'), 1000);
}
export function stopAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  if (state.tick) clearInterval(state.tick);
  state.timer = state.tick = null;
  if (fleet.unsub) { fleet.unsub(); fleet.unsub = null; }
  if (fleet.pushTimer) { clearTimeout(fleet.pushTimer); fleet.pushTimer = null; }
}

/**
 * Nodes and shards, tasks, thread pools and pending cluster tasks — what the Nodes &
 * shards page reads, kept in state.shards so a pushed update reaches the page.
 *
 * `{rows, error, tasks, pools, pending, at}`: `rows` null with `error` when the shard table
 * could not be read (unknown, not "no shards"); the other three null when theirs could not.
 */
export async function fetchShards(id, { force = false } = {}) {
  if (fleetMode() && fleetKnows(id)) {
    const r = await fetchFleetDataset(id, 'shards', { maxAgeSec: force ? 0 : undefined });
    if (r && r.ok) {
      const got = state.shards.get(id);
      if (got) return got;
      const e = r.entry || {};
      // `pending`: nothing went wrong, the core simply has not finished; it pushes the
      // table when it lands, so the page waits rather than asking again.
      const out = { rows: null, tasks: null, pools: null, pending: !e.error, at: 0,
        error: (e.error && e.error.message)
          || (r.timedOut ? 'the shard table is still being fetched — it will appear when it arrives'
                         : 'the shard table has not been fetched yet') };
      state.shards.set(id, out);
      return out;
    }
    if (r && !FALL_BACK_KINDS.has(r.kind)) {
      const out = { rows: null, error: r.message || r.kind, tasks: null, pools: null, pending: null, at: 0 };
      state.shards.set(id, out);
      return out;
    }
  }
  const cl = state.clients.get(id);
  if (!cl) return null;
  const out = { rows: null, error: null, tasks: null, pools: null, pending: null, at: Date.now() };
  try { out.rows = await cl.shardsAll(); } catch (e) { out.error = e.message || String(e); }
  // What the cluster is busy doing. Separate from the shard read so one failing does not
  // take the other with it — an old cluster without _cat/tasks should still list shards.
  const [tasks, pools, pending] = await Promise.all([
    cl.tasks().catch(() => null), cl.threadPools().catch(() => null), cl.pendingTasks().catch(() => null),
  ]);
  Object.assign(out, { tasks, pools, pending: pending && pending.tasks });
  state.shards.set(id, out);
  stampFetch(id, 'shards');
  bus.emit('data', id);
  return out;
}

/**
 * After this app changed something on a cluster: make sure the page shows it.
 *
 * With the fleet cache nothing is needed for a write the core recognises — it queues the
 * datasets a write changes (a snapshot → snapshots and policies; an index → indices,
 * shards, health) 3 s after it succeeds, and the answer arrives like any other change.
 * `coreCovers: false` is for a write whose effect the core does not map (running an SLM
 * policy writes to `_slm` but creates a snapshot): one REFRESH, 3 s later, instead.
 * Without the cache, the one delayed re-read the pages used to schedule for themselves.
 */
export function expectChange(clusterId, what = 'snapshots', { coreCovers = true } = {}) {
  if (fleetMode()) {
    if (coreCovers) return;
    setTimeout(() => {
      refreshFleet({ clusterIds: [clusterId], datasets: moduleDatasets(what) }).catch(() => {});
    }, 3000);
    return;
  }
  setTimeout(() => {
    if (what === 'snapshots') fetchSnapshotsDirect(clusterId).catch(() => {});
    else if (what === 'indices') fetchIndices(clusterId, '*').catch(() => {});
    else fetchOverviewDirect(clusterId).catch(() => {});
  }, 3500);
}

/* ------------------------------ the fleet cache ------------------------------- *
 * The core polls every cluster itself and keeps what it found (crates/elasticpro-core/src/
 * fleet, docs/HANDBOOK.md "Fleet cache — the message contract"). A page reads that, so
 * two hundred browser tabs are still one poller's load on each cluster. Everything below
 * turns the core's entries into exactly the {ok, value, error} pairs buildClusterData
 * already took from a direct fetch — one place computes the figures, whichever way the
 * bodies arrived.
 */

/** The answers each dataset carries, by the names buildClusterData reads them under. */
export const FLEET_KEYS = {
  health: ['root', 'health'],
  nodes: ['nodes', 'alloc'],
  ilm_errors: ['ilmErr'],
  policies: ['repos', 'slm', 'slmStatus', 'ilm', 'ilmPolicies', 'repoPaths', 'clusterSettings'],
  ilm_assign: ['ilmOfIndices'],
};
/** What FLEET_STATE sends without `include` — until its own catalogue says otherwise. */
const BACKGROUND = ['health', 'nodes', 'ilm_errors', 'policies', 'ilm_assign', 'snapshots'];
const ON_DEMAND = new Set(['snapshots_full', 'indices', 'shards']);
/** Answers that mean "this core has no fleet cache for that": ask the cluster directly. */
const FALL_BACK_KINDS = new Set(['fleet_off', 'not_found', 'bad_message', 'bad_request', 'worker_error']);
/** …of which these say the core has none at all (an older core, a stopped poller). A
 *  network blip ('worker_error') is not one of them: it must not end the cache for good. */
const NO_CACHE_KINDS = new Set(['fleet_off', 'bad_message']);
/** How often the page reads FLEET_STATE {since} when nothing has told it to. */
export const FLEET_FALLBACK_MS = 60 * 1000;

export const fleet = {
  mode: null,              // null (not asked yet) | 'fleet' | 'direct'
  seq: 0,                  // the core's seq at the last FLEET_STATE; `since` for the next
  epoch: null,             // which run of the core that seq belongs to (FLEET_STATE.epoch)
  skew: 0,                 // core clock minus ours, so "fetched 2 min ago" is about the core's 2 min
  catalogue: [],
  ids: null,               // the clusters the core holds for this caller (null: not known yet)
  onDemand: new Set(),     // on-demand datasets this tab has asked for, kept current by FLEET_STATE
  raw: new Map(),          // clusterId → {reach, datasets: {name: entry}}, as the core sent them
  unsub: null, pushTimer: null, syncing: null, again: null, lastAnnounce: 0, announceTimer: null, lastPushSync: 0,
};

export function fleetMode() { return fleet.mode === 'fleet'; }

/** For tests, and for a core that turned out not to have the cache after all. */
export function setFleetMode(mode) {
  fleet.mode = mode;
  if (mode !== 'fleet') { fleet.seq = 0; fleet.epoch = null; fleet.ids = null; fleet.raw.clear(); fleet.onDemand.clear(); }
}

/** Whether the core holds this cluster (true until it has said which ones it holds). */
function fleetKnows(id) { return !fleet.ids || fleet.ids.has(id); }

function backgroundNames() {
  const bg = (fleet.catalogue || []).filter((c) => c.class === 'background').map((c) => c.dataset);
  return bg.length ? bg : BACKGROUND;
}

/** A core timestamp as ours. */
const local = (ts) => (ts ? Number(ts) - fleet.skew : 0);

async function detectFleet() {
  if (fleet.mode) return fleet.mode;
  // A snapshot file is not live, and no server: nothing to ask.
  if (state.mode !== 'live') return 'direct';
  let st = null;
  try { st = await workerStatus(); } catch (_) { /* no core answering: direct */ }
  fleet.mode = st && st.ok && st.fleetCache === true ? 'fleet' : 'direct';
  return fleet.mode;
}

/** An Error the way EsClient.json() throws one, so a caller cannot tell the two apart. */
function answerError(a) {
  const e = new Error((a && a.message) || (a && a.status ? `HTTP ${a.status}` : 'no answer'));
  e.res = a;
  return e;
}

/** Why a dataset has no value: never fetched, or its last fetch never reached the cluster. */
function entryError(entry, dataset) {
  const err = entry && entry.error;
  const res = err
    ? { ok: false, ...err }
    : { ok: false, kind: 'unknown', message: `${dataset} has not been fetched yet` };
  const e = new Error(res.message || res.kind || 'unknown');
  e.res = res;
  return e;
}

/** One answer from an entry's `data` as a settled() pair. */
export function answerToPair(a) {
  return a && a.ok ? { ok: true, value: a.json } : { ok: false, error: answerError(a) };
}

/**
 * The raw pairs buildClusterData takes, from one cluster's entries.
 *
 * Unknown is not zero, in three ways:
 *   * a dataset never fetched gives `{ok: false, unknown: true}` — not an empty value;
 *   * one whose last fetch failed keeps its LAST GOOD answers, marked `stale: 'error'`,
 *     rather than going blank — the freshness line names their age;
 *   * except `health`, whose failure is the fact that the cluster is not answering: its
 *     last good body would make a cluster that is down read as up. The answers fail with
 *     the error, and buildClusterData keeps the rest of what it knew from `prev` as always.
 * `restored` (read back from the core's disk at start-up) is used, marked `stale: 'restored'`.
 */
export function fleetPairs(cs) {
  const out = {};
  const ds = (cs && cs.datasets) || {};
  for (const [name, keys] of Object.entries(FLEET_KEYS)) {
    const e = ds[name];
    const usable = !!(e && e.data && e.status !== 'never' && !(name === 'health' && e.status === 'error'));
    for (const k of keys) {
      const a = usable ? e.data[k] : null;
      // A failed health check is a known fact (the cluster did not answer); anything else
      // without a value is not known.
      if (!a) { out[k] = { ok: false, unknown: !(name === 'health' && e && e.status === 'error'), error: entryError(e, name) }; continue; }
      const p = answerToPair(a);
      if (e.status !== 'ok') p.stale = e.status;
      out[k] = p;
    }
  }
  return out;
}

/**
 * Parsed listings per entry object. A verbose listing is every snapshot's every index name
 * run through the index-name pattern, and the cluster's data is rebuilt whenever any of
 * its datasets changes — health every few seconds — so on a fleet this re-parsed hundreds
 * of thousands of names a minute to arrive at the same rows. The core sends a new entry
 * object whenever the listing changes, so the entry itself is the key.
 */
const listingCache = new WeakMap();
/** One repository's listing from a snapshot dataset entry, or null when it has none. */
function listingOf(entry, repo, reSrc) {
  if (!entry || typeof entry !== 'object') return null;
  let byRepo = listingCache.get(entry);
  if (!byRepo) { byRepo = new Map(); listingCache.set(entry, byRepo); }
  const k = `${repo}\u0000${reSrc || ''}`;
  if (!byRepo.has(k)) byRepo.set(k, parseListing(entry, repo, reSrc));
  const got = byRepo.get(k);
  // `at` in our clock, which moves with the measured skew; the rows do not.
  return got ? { ...got, at: local(entry.fetchedAt) } : null;
}

function parseListing(entry, repo, reSrc) {
  if (!entry || !entry.data || entry.status === 'never') return null;
  const a = (entry.data.byRepo || {})[repo];
  if (!a) return null;
  const at = local(entry.fetchedAt);
  if (!a.ok) return { error: a.message || `HTTP ${a.status}`, at };
  const rows = a.source === 'verbose' ? snapshotRowsVerbose(a.json, reSrc) : snapshotRowsCat(a.json);
  return { rows, at, source: a.source === 'verbose' ? 'verbose' : 'cat' };
}

const COVERAGE = ['indexNames', 'coverFrom', 'coverTo', 'coverDays', 'datedIndices', 'missingDays'];

/**
 * One repository's rows from the two listings the core keeps: `snapshots` (_cat, every
 * 30 min, no index names) and `snapshots_full` (verbose, on demand).
 *
 * The NEWER of the two decides which snapshots exist and their status — a snapshot taken
 * since the verbose listing was read must still count, and one deleted since must not. The
 * other lends only index names, and only to the same snapshot id, since what a finished
 * snapshot holds does not change. A row neither can name the indices of keeps
 * `indexNames: null`, which every reader treats as unknown, never as "holds nothing".
 *
 * @returns {{rows, at, source: 'cat'|'verbose'|'mixed'} | {error, at} | null} null = unknown.
 */
export function mergeSnapshotListings(cat, full) {
  const good = [cat, full].filter((l) => l && l.rows);
  if (!good.length) {
    const bad = [cat, full].filter((l) => l && l.error).sort((a, b) => b.at - a.at)[0];
    return bad || null;
  }
  let rows, at;
  if (good.length === 1) ({ rows, at } = good[0]);
  else {
    const [newer, other] = full.at >= cat.at ? [full, cat] : [cat, full];
    const byId = new Map(other.rows.map((r) => [r.id, r]));
    at = newer.at;
    rows = newer.rows.map((r) => {
      if (r.indexNames != null) return r;
      const o = byId.get(r.id);
      if (!o || o.indexNames == null) return r;
      const lent = {};
      for (const k of COVERAGE) lent[k] = o[k];
      return { ...r, ...lent };
    });
  }
  const named = rows.filter((r) => r.indexNames != null).length;
  const source = !rows.length ? good[good.length - 1].source
    : named === rows.length ? 'verbose' : named ? 'mixed' : 'cat';
  return { rows, at, source };
}

/** d.snapshots from the two snapshot datasets, per repository in d.repos. */
function applySnapshotEntries(d, cur, reSrc) {
  const cat = cur.datasets.snapshots, full = cur.datasets.snapshots_full;
  const snaps = {}, source = {};
  for (const repo of d.repos || []) {
    const m = mergeSnapshotListings(listingOf(cat, repo.name, reSrc), listingOf(full, repo.name, reSrc));
    // Not listed yet: left out, so it reads as unknown rather than as "no snapshots".
    if (!m) continue;
    if (m.error) { snaps[repo.name] = []; repo.error = m.error; continue; }
    snaps[repo.name] = m.rows;
    source[repo.name] = m.source;
    repo.error = null;
  }
  d.snapshots = snaps;
  d.snapshotsSource = source;
}

/** Per-dataset status, for the freshness lines: the entry minus its bodies, in our clock. */
function datasetMeta(cur) {
  const out = {};
  for (const [name, e] of Object.entries(cur.datasets)) {
    out[name] = { status: e.status, fetchedAt: local(e.fetchedAt), attemptedAt: local(e.attemptedAt),
      nextDue: local(e.nextDue), staleAfterMs: e.staleAfterMs, error: e.error || null };
  }
  return out;
}

/**
 * The EsClient's connection state, from what the core found rather than from a request
 * this page made — the banners and the credential prompt read it.
 */
function applyReach(cl, cur) {
  if (!cl) return;
  const r = cur.reach;
  const h = cur.datasets.health;
  const before = cl.lastError;
  if (h && h.data && h.status !== 'error') {
    const a = [h.data.root, h.data.health].find((x) => x && x.ok) || h.data.root || h.data.health;
    if (a) cl._track(a);
    if (a && a.ok) cl.lastOkAt = local(h.fetchedAt);
  } else if (h && h.status === 'error' && h.error) {
    cl._track({ ok: false, ...h.error });
  }
  if (r) {
    if (r.state === 'unreachable') {
      if (cl.state === 'online' || cl.state === 'unknown') cl.state = 'offline';
      if (r.lastError) cl.lastError = { ok: false, ...r.lastError };
    } else if (r.state === 'unknown' && (!h || h.status === 'never')) {
      cl.state = 'unknown';
    }
    cl.failures = r.failures || 0;
    if (r.nextProbeAt) cl.nextRetryAt = local(r.nextProbeAt);
  }
  // The core's error names the kind; the certificate or host key a banner offers to trust
  // comes only with a request's own answer. Keep a richer copy of the same error.
  if (before && cl.lastError && before.kind === cl.lastError.kind
      && (before.cert || before.hostKey || before.tunnel) && !(cl.lastError.cert || cl.lastError.hostKey)) {
    cl.lastError = before;
  }
  // …and ask for one, once per outage, when it is a trust decision the banner must offer.
  const needs = cl.state === 'tls_error' || cl.state === 'tunnel_error';
  const le = cl.lastError || {};
  const outage = (r && r.since) || (h && h.attemptedAt) || 0;
  if (needs && !(le.cert || le.hostKey || le.tunnel) && cl._enrichedFor !== outage && typeof cl.request === 'function') {
    cl._enrichedFor = outage;
    cl.request('GET', '/').then(() => bus.emit('data', cl.c.id)).catch(() => {});
  }
}

/**
 * Take one cluster's part of a FLEET_STATE (or CLUSTER_DATASET) answer into state.
 *
 * `clusterState` is `{reach?, datasets: {name: entry}}`, possibly partial (FLEET_STATE with
 * `since` sends only what changed); it is merged over what this cluster already had.
 */
export function applyFleetEntry(id, clusterState) {
  if (!clusterState) return null;
  const cur = fleet.raw.get(id) || { reach: null, datasets: {} };
  if (clusterState.reach) cur.reach = clusterState.reach;
  const changed = Object.keys(clusterState.datasets || {});
  for (const n of changed) cur.datasets[n] = clusterState.datasets[n];
  fleet.raw.set(id, cur);

  const cl = state.clients.get(id);
  const reSrc = cl && cl.c ? cl.c.indexNameRegex : undefined;
  const prev = state.data.get(id) || {};
  const rebuild = !state.data.has(id) || changed.some((n) => n in FLEET_KEYS);
  let d = prev;
  if (rebuild) {
    const raw = fleetPairs(cur);
    raw.updatedAt = local(cur.datasets.health && cur.datasets.health.fetchedAt) || undefined;
    d = buildClusterData(id, prev, raw);
    d.fromZabbix = null;
    // Never checked is not "unreachable": the overview says loading, and no alert is raised
    // about a cluster nobody has asked yet.
    const he = cur.datasets.health;
    d.healthUnknown = !he || he.status === 'never';
    if (d.healthUnknown) { d.updatedAt = 0; d.reachable = false; }
  }
  if (rebuild || changed.includes('snapshots') || changed.includes('snapshots_full')) {
    applySnapshotEntries(d, cur, reSrc);
  }
  d.datasets = datasetMeta(cur);
  d.reach = cur.reach ? { ...cur.reach, since: local(cur.reach.since), nextProbeAt: local(cur.reach.nextProbeAt) } : null;
  state.data.set(id, d);

  // Fetch stamps in our clock. `data` is the OLDEST of the datasets the overview is built
  // from, so the page never calls a figure fresher than the stalest one beside it.
  const bgAt = Object.keys(FLEET_KEYS).map((n) => cur.datasets[n] && local(cur.datasets[n].fetchedAt)).filter(Boolean);
  if (bgAt.length) state.fetchedAt[`${id}:data`] = Math.min(...bgAt);
  for (const n of changed) {
    const e = cur.datasets[n];
    if (e && e.fetchedAt) state.fetchedAt[`${id}:${n}`] = local(e.fetchedAt);
  }

  const ie = cur.datasets.indices;
  if (changed.includes('indices') && ie && ie.data && ie.data.indices && ie.data.indices.ok) {
    const rows = Array.isArray(ie.data.indices.json) ? ie.data.indices.json : [];
    state.indices.set(id, rows.map((r) => parseIndexName(r.index, reSrc, r)));
    bus.emit('indices', id);
  }
  const se = cur.datasets.shards;
  if (changed.includes('shards') && se && se.data) {
    const a = se.data;
    const val = (k) => (a[k] && a[k].ok ? a[k].json : null);
    state.shards.set(id, {
      rows: a.shards && a.shards.ok ? a.shards.json : null,
      error: a.shards && !a.shards.ok ? (a.shards.message || `HTTP ${a.shards.status}`)
        : !a.shards ? 'the shard table was not in the answer' : null,
      tasks: val('tasks'), pools: val('threadPools'), pending: (val('pendingTasks') || {}).tasks || null,
      at: local(se.fetchedAt), status: se.status,
    });
  }
  applyReach(cl, cur);
  bus.emit('data', id);
  return d;
}

/** A whole FLEET_STATE answer. */
export function applyFleetState(res) {
  if (!res || !res.ok) return;
  if (typeof res.now === 'number') fleet.skew = res.now - Date.now();
  if (Array.isArray(res.catalogue) && res.catalogue.length) fleet.catalogue = res.catalogue;
  if (Array.isArray(res.clusterIds)) {
    fleet.ids = new Set(res.clusterIds);
    if (res.full) for (const id of [...fleet.raw.keys()]) if (!fleet.ids.has(id)) fleet.raw.delete(id);
  }
  for (const [id, cs] of Object.entries(res.clusters || {})) applyFleetEntry(id, cs);
  if (typeof res.seq === 'number') fleet.seq = res.full ? res.seq : Math.max(fleet.seq, res.seq);
  if (res.epoch) fleet.epoch = res.epoch;
  if (Array.isArray(res.clusterIds)) followZabbix(res.clusterIds);
}

/**
 * The Zabbix clusters on this page are read once, when the config loads. The core re-reads
 * Zabbix every five minutes and its poller picks a new host up at once — so FLEET_STATE
 * names a cluster added in Zabbix (or by Cluster Management) long before this page would.
 * When it does, or stops naming one this page still shows, the list is re-read the same
 * way the Config page's "Sync now" does. Once per difference (see zabbixDrift): an id the
 * Zabbix list cannot explain is left alone rather than re-asked on every read.
 */
const zbxFollow = { tried: '', busy: false };
function followZabbix(ids) {
  if (state.mode !== 'live' || !state.config || zbxFollow.busy) return;
  const sig = zabbixDrift(ids, state.config);
  if (!sig || sig === zbxFollow.tried) return;
  zbxFollow.tried = sig;
  zbxFollow.busy = true;
  // Not inside the FLEET_STATE being applied: setConfig asks the core again.
  setTimeout(async () => {
    try {
      await setConfig(state.config, state.handle);
      await pushedSync({ full: true });
    } catch (e) {
      console.error(e);
    } finally {
      zbxFollow.busy = false;
    }
  }, 0);
}

/**
 * CLUSTER_DATASET, applied. Returns the answer; `fleet_off` switches this page to direct.
 * The same question already in flight is shared, not asked twice — pages re-check what
 * they are missing on every data event, and each ask can wait up to 20 s in the core.
 */
const inflight = new Map();
/**
 * Held requests at once. A CLUSTER_DATASET with `wait` stays open until the cluster
 * answers (up to 20 s); the browser has six connections to the core and the event stream
 * holds one, so more than a couple of these left nothing for a click or a tab switch.
 */
const waitSlots = limiter(2);
/**
 * The last answer per question, for a caller that is not forcing a fetch. Pages re-check
 * what they are missing on every redraw; a cluster whose answer was "not fetched yet" (it
 * is unreachable, or the core is still on it) was asked again on each one, for as long as
 * the page stayed open.
 */
const recentAnswers = new Map();
const RECENT_MS = 10000;
function fetchFleetDataset(id, dataset, { maxAgeSec } = {}) {
  const key = `${id}\u0000${dataset}\u0000${maxAgeSec ?? ''}`;
  if (inflight.has(key)) return inflight.get(key);
  const recent = maxAgeSec === 0 ? null : recentAnswers.get(key);
  if (recent && Date.now() - recent.at < RECENT_MS) {
    // …with the entry as it is NOW: a push may have delivered it since.
    const cur = fleet.raw.get(id);
    const entry = (cur && cur.datasets[dataset]) || recent.r.entry;
    return Promise.resolve({ ...recent.r, entry, reach: (cur && cur.reach) || recent.r.reach });
  }
  const p = waitSlots(() => askFleetDataset(id, dataset, { maxAgeSec }))
    .then((r) => { if (r && r.ok) recentAnswers.set(key, { at: Date.now(), r }); return r; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function askFleetDataset(id, dataset, { maxAgeSec } = {}) {
  if (ON_DEMAND.has(dataset)) fleet.onDemand.add(dataset);
  const r = await clusterDataset(id, dataset, { wait: true, maxAgeSec });
  if (!r || !r.ok) {
    if (r && r.kind === 'fleet_off') fleet.mode = 'direct';
    return r || { ok: false, kind: 'worker_error' };
  }
  applyFleetEntry(id, { reach: r.reach, datasets: { [dataset]: r.entry } });
  return r;
}

/**
 * One dataset for many clusters, without a request per cluster.
 *
 * Reads what the core already holds for it (once per tab: after that FLEET_STATE {since}
 * carries it, since it is now in fleet.onDemand), then asks the core in ONE REFRESH to
 * fetch it for the clusters that have none or an old one (lib/demand.js decides which).
 * Nothing waits for the clusters: their answers arrive as pushes, and each page redraws
 * as they land, showing the ones not in yet as unknown rather than as empty.
 *
 * Returns false when there is no fleet cache (the caller then asks the clusters itself),
 * true otherwise. `force` is a Refresh press: fetch even what is fresh.
 */
const demandAsked = new Map();
const datasetRead = new Map();
export async function demandDataset(ids, dataset, { force = false } = {}) {
  if ((await detectFleet()) !== 'fleet') return false;
  const known = (ids || []).filter(fleetKnows);
  if (!known.length) return true;
  if (ON_DEMAND.has(dataset)) fleet.onDemand.add(dataset);
  if (!datasetRead.has(dataset)) {
    datasetRead.set(dataset, readDatasetOnce(dataset).catch(() => { datasetRead.delete(dataset); }));
  }
  await datasetRead.get(dataset);
  if (!fleetMode()) return false;
  const cat = (fleet.catalogue || []).find((c) => c.dataset === dataset);
  const now = Date.now();
  const due = clustersToAsk(known.map((id) => {
    const cur = fleet.raw.get(id);
    const e = cur && cur.datasets[dataset];
    return {
      id, reach: cur && cur.reach, askedAt: demandAsked.get(`${id}\u0000${dataset}`),
      entry: e ? { status: e.status, fetchedAt: local(e.fetchedAt), attemptedAt: local(e.attemptedAt) } : null,
    };
  }), { now, force, intervalMs: cat && cat.intervalSec ? cat.intervalSec * 1000 : 0 });
  if (!due.length) return true;
  for (const id of due) demandAsked.set(`${id}\u0000${dataset}`, now);
  const r = await refreshFleet({ clusterIds: due, datasets: [dataset] });
  if (r && !r.ok && NO_CACHE_KINDS.has(r.kind)) { fleet.mode = 'direct'; return false; }
  return true;
}

/**
 * What the core holds for one dataset, every cluster, applied — without moving `seq`: this
 * is a side read, and the next FLEET_STATE {since} must still hear everything else that
 * changed since the last one.
 */
async function readDatasetOnce(dataset) {
  const res = await fleetState({ include: [dataset] });
  if (!res || !res.ok) {
    if (res && NO_CACHE_KINDS.has(res.kind)) fleet.mode = 'direct';
    throw new Error((res && res.message) || 'FLEET_STATE failed');
  }
  if (typeof res.now === 'number') fleet.skew = res.now - Date.now();
  if (Array.isArray(res.catalogue) && res.catalogue.length) fleet.catalogue = res.catalogue;
  for (const [id, cs] of Object.entries(res.clusters || {})) {
    const e = cs && cs.datasets && cs.datasets[dataset];
    if (!e) continue;
    // Only when it is news: an entry this tab already holds at the same seq changes nothing.
    const cur = fleet.raw.get(id);
    const had = cur && cur.datasets[dataset];
    if (had && had.seq === e.seq && had.status === e.status) continue;
    applyFleetEntry(id, { datasets: { [dataset]: e } });
  }
}

/**
 * FLEET_STATE, applied: `since` the last one unless `full`. Calls that arrive while one
 * is in flight collapse into one more after it, so a burst of pushes is two reads.
 */
export function syncFleet({ full = false } = {}) {
  if (fleet.syncing) {
    fleet.again = full || fleet.again === 'full' ? 'full' : 'since';
    return fleet.syncing;
  }
  const run = async () => {
    const include = fleet.onDemand.size ? [...new Set([...backgroundNames(), ...fleet.onDemand])] : undefined;
    const res = await fleetState({ since: full ? undefined : fleet.seq || undefined, include });
    if (!res || !res.ok) return res || { ok: false, kind: 'worker_error' };
    // A core that restarted counts from zero again; `since` our old number would hear
    // nothing ever again. Start over. The epoch says so directly — a restarted core that
    // has already counted past our number would slip through the seq check alone.
    const restarted = !!(res.epoch && fleet.epoch && res.epoch !== fleet.epoch);
    if (!res.full && (restarted || (typeof res.seq === 'number' && res.seq < fleet.seq))) {
      fleet.seq = 0;
      fleet.again = 'full';
      return res;
    }
    applyFleetState(res);
    return res;
  };
  fleet.syncing = run().finally(() => {
    fleet.syncing = null;
    const again = fleet.again;
    fleet.again = null;
    if (again) syncFleet({ full: again === 'full' });
  });
  return fleet.syncing;
}

/** What the core pushed. Batched: a burst of dataset events becomes one FLEET_STATE. */
function onFleetEvent(ev) {
  if (!ev) return;
  if (ev.type === 'resync') { pushedSync({ full: true }); return; }
  if (fleet.pushTimer) return;
  // While a refresh streams in, the core announces several changes a second; reading them
  // four times a second bought nothing the page can show faster than it redraws. The first
  // change after a quiet spell is still read within a quarter of a second.
  const busy = Date.now() - fleet.lastPushSync < 2000;
  fleet.pushTimer = setTimeout(() => { fleet.pushTimer = null; fleet.lastPushSync = Date.now(); pushedSync(); },
    ev.type === 'poll' ? 0 : busy ? 1000 : 250);
}

async function pushedSync({ full = false } = {}) {
  if (!fleetMode()) return;
  const res = await syncFleet({ full });
  if (!res || !res.ok) return;
  state.lastRefresh = Date.now();
  state.nextRefreshAt = state.lastRefresh + FLEET_FALLBACK_MS;
  // The desktop asks every 5 s and is usually told "nothing": no redraw for that.
  if (!res.full && !Object.keys(res.clusters || {}).length) return;
  // `refreshed` redraws the shell and announces new alerts. Pushes can arrive every
  // second on a large fleet; once every five is plenty for a toast, and the page itself
  // is already redrawn by the (coalesced) data events.
  const since = Date.now() - fleet.lastAnnounce;
  if (since >= 5000) announceRefreshed();
  else if (!fleet.announceTimer) fleet.announceTimer = setTimeout(announceRefreshed, 5000 - since);
}

function announceRefreshed() {
  if (fleet.announceTimer) { clearTimeout(fleet.announceTimer); fleet.announceTimer = null; }
  fleet.lastAnnounce = Date.now();
  bus.emit('refreshed');
  updateBadge();
  publishPopupSummary();
}

/**
 * One dataset's freshness for lib/freshness.js: when, and — with the fleet cache — its
 * status, its own staleness threshold and the cluster's reach. `dataset` is a fleet name
 * (`health`, `indices`, `shards`, `snapshots`, …); on the direct path it falls back to the
 * page's own stamp for the same thing.
 */
export function datasetFreshness(clusterId, dataset) {
  const cur = fleet.raw.get(clusterId);
  const e = cur && cur.datasets[dataset];
  if (!fleetMode() || !e) {
    const legacy = dataset === 'indices' || dataset === 'shards' ? dataset : 'data';
    return { ts: fetchedAt(clusterId, legacy) };
  }
  const r = cur.reach;
  return {
    ts: local(e.fetchedAt), status: e.status, staleAfterMs: e.staleAfterMs, error: e.error || null,
    reach: r ? { ...r, since: local(r.since) } : null,
  };
}

/* ---------------------------------- alerts ----------------------------------- */

/**
 * Everything currently wrong across the fleet.
 *
 * Each alert carries a `key` that identifies the PROBLEM rather than its current value —
 * `<cluster>:disk`, not "disk 87.3%". An acknowledgement is stored against that key, so
 * it survives the number moving and only disappears when the problem itself clears.
 */
/**
 * The last log-delay measurement per cluster: `summarise()` of its devices, and when.
 *
 * Published by whoever measured — the Log delay page when a person runs it, the scraper
 * on its own schedule — because measuring is one aggregation per cluster and alerts()
 * runs on every refresh. A measurement older than DELAY_ALERT_HOURS says nothing about now
 * and raises nothing.
 */
const delaySummaries = new Map();
const DELAY_ALERT_HOURS = 2;

export function setDelaySummary(clusterId, summary, at = Date.now()) {
  if (summary) delaySummaries.set(clusterId, { summary, at });
  else delaySummaries.delete(clusterId);
  bus.emit('data');
}

export function delaySummaryFor(clusterId) { return delaySummaries.get(clusterId) || null; }

/**
 * alerts(), memoised for the places that ask on every redraw — the tab badge, the topbar,
 * the Clusters banner and its per-row counts. Recomputed when anything was emitted on the
 * bus since, when one of its inputs was replaced outright, and at least once a second
 * regardless, since some rules are about how long ago something happened. alerts() itself
 * always computes: anything that has just changed state by hand and asks gets the truth.
 */
export function cachedAlerts() {
  const now = Date.now();
  const deps = [state.config, state.defaults, state.data, state.indices, state.clients];
  if (alertsMemo.value && alertsMemo.forRev === alertsMemo.rev && now - alertsMemo.at < ALERTS_MEMO_MS
      && deps.every((d, i) => d === alertsMemo.deps[i])) {
    return [...alertsMemo.value];
  }
  const value = alerts();
  Object.assign(alertsMemo, { value, forRev: alertsMemo.rev, at: now, deps });
  return [...value];
}

export function alerts() {
  const out = [];
  const add = (...a) => out.push(...a.filter(Boolean));
  for (const c of clusters()) {
    const d = state.data.get(c.id);
    const cl = state.clients.get(c.id);
    // The fleet cache has not checked this one yet: nothing is known, so nothing is raised.
    if (d && d.healthUnknown) continue;
    if (!d || !d.reachable) {
      add({ key: `${c.id}:unreachable`, level: 'critical', cluster: c, title: `${c.name} unreachable`,
        detail: (cl && cl.lastError && cl.lastError.message) || 'No response', kind: cl && cl.state });
      continue;
    }
    // Devices shipping late, from the last measurement — see setDelaySummary.
    const ds = delaySummaries.get(c.id);
    if (ds && Date.now() - ds.at < DELAY_ALERT_HOURS * 3600 * 1000) {
      const by = ds.summary.by || {};
      const w = ds.summary.worst;
      const worst = w && w.delayMinutes !== null ? ` Worst: ${w.device}, ${Math.round(w.delayMinutes)} min behind.` : '';
      if (by.CRITICAL) {
        add({ key: `${c.id}:log-delay`, level: 'critical', cluster: c,
          title: `${c.name}: ${by.CRITICAL} device(s) critically late shipping logs`,
          detail: `${by.CRITICAL} critical, ${by.DELAYED || 0} delayed of ${ds.summary.devices}.${worst}` });
      } else if (by.DELAYED) {
        add({ key: `${c.id}:log-delay`, level: 'warning', cluster: c,
          title: `${c.name}: ${by.DELAYED} device(s) shipping logs late`,
          detail: `${by.DELAYED} delayed of ${ds.summary.devices}.${worst}` });
      }
    }
    if (d.health && d.health.status === 'red') add({ key: `${c.id}:health`, level: 'critical', cluster: c, title: `${c.name} health is RED`, detail: `${d.health.unassigned_shards} unassigned shards` });
    else if (d.health && d.health.status === 'yellow') add({ key: `${c.id}:health`, level: 'warning', cluster: c, title: `${c.name} health is YELLOW`, detail: `${d.health.unassigned_shards} unassigned shards` });
    if (d.disk && isFinite(d.disk.percent)) {
      if (d.disk.percent >= state.defaults.diskCritPercent) add({ key: `${c.id}:disk`, level: 'critical', cluster: c, title: `${c.name} disk ${d.disk.percent.toFixed(1)}%`, detail: 'Above critical threshold' });
      else if (d.disk.percent >= state.defaults.diskWarnPercent) add({ key: `${c.id}:disk`, level: 'warning', cluster: c, title: `${c.name} disk ${d.disk.percent.toFixed(1)}%`, detail: 'Above warning threshold' });
    }
    if (d.ilmErrorCount) add({ key: `${c.id}:ilm`, level: 'warning', cluster: c, title: `${c.name}: ${d.ilmErrorCount} index(es) in ILM error step`, detail: Object.keys(d.ilmErrors).slice(0, 3).join(', ') });
    if (d.slmStatus && d.slmStatus.operation_mode && d.slmStatus.operation_mode !== 'RUNNING') add({ key: `${c.id}:slm-mode`, level: 'warning', cluster: c, title: `${c.name}: SLM is ${d.slmStatus.operation_mode}`, detail: 'Snapshot lifecycle is not running' });
    // Disk balance across data nodes — only meaningful with more than one.
    const bal = diskBalance(d, d.clusterSettings);
    if (bal.applicable && (bal.verdict === 'critical' || bal.verdict === 'required' || bal.verdict === 'watch')) {
      const act = primaryAction(bal);
      add({ key: `${c.id}:disk-balance`,
        level: bal.verdict === 'critical' ? 'critical' : 'warning',
        cluster: c,
        title: `${c.name}: ${balanceHeadline(bal)}`,
        // One suggestion, named — an alert that only states a problem leaves the reader
        // to work out the next step for themselves.
        detail: bal.reasons[0] + (act ? `  Suggested: ${act.title} (${act.method} ${act.path}).` : '') });
    }

    // Field-volume spikes, when the Indices page has run an analysis for this cluster.
    for (const sp of spikesFor(c.id)) {
      add({ key: `${c.id}:volume:${sp.field}:${sp.term}`, level: 'warning', cluster: c,
        title: `${c.name}: ${sp.field} "${sp.term}" volume up ${Math.round(sp.changePct)}%`,
        detail: `${sp.latest.docs.toLocaleString()} documents on ${sp.latestDay} against a ` +
                `${Math.round(sp.baseline).toLocaleString()} average over the previous ${sp.baselineDays} days` });
    }
    // Who holds the master role, and whether it just changed hands.
    if (d.master === null && d.nodes && d.nodes.length) {
      add({ key: `${c.id}:no-master`, level: 'critical', cluster: c,
        title: `${c.name}: no master node`,
        detail: `${d.nodes.length} node(s) answered but none holds the master role. The cluster `
              + 'cannot accept changes to its state until one is elected.' });
    } else if (d.masterChangedAt && Date.now() - d.masterChangedAt < MASTER_ALERT_HOURS * 3600 * 1000) {
      add({ key: `${c.id}:master-changed:${d.masterChangedFrom}->${d.master}`, level: 'critical', cluster: c,
        title: `${c.name}: master moved from ${d.masterChangedFrom} to ${d.master}`,
        detail: `Elected ${ago(d.masterChangedAt)}. The previous master left, was cut off or was `
              + 'restarted; anything else that went wrong around then probably started there.' });
    }

    // The disk itself getting bigger or smaller.
    if (d.capacity && d.capacity.changedAt
        && Date.now() - d.capacity.changedAt < CAPACITY_ALERT_HOURS * 3600 * 1000) {
      const from = d.capacity.changedFrom, to = d.capacity.total;
      const grew = to > from;
      add({
        key: `${c.id}:capacity:${from}->${to}`,
        level: grew ? 'warning' : 'critical',
        cluster: c,
        title: grew
          ? `${c.name}: disk capacity grew to ${bytesish(to)}`
          : `${c.name}: disk capacity FELL to ${bytesish(to)}`,
        detail: grew
          ? `Was ${bytesish(from)}, now ${bytesish(to)} — ${bytesish(to - from)} added ${ago(d.capacity.changedAt)}. `
            + 'Expected if you just extended the storage; worth confirming nobody else did it.'
          : `Was ${bytesish(from)}, now ${bytesish(to)} — ${bytesish(from - to)} gone ${ago(d.capacity.changedAt)}. `
            + 'A data path is missing or a mount was lost. The node count is unchanged, so this is not a node leaving.',
      });
    }

    // Disk Elasticsearch holds that no index accounts for.
    {
      const acct = diskAccounting(d, state.indices.get(c.id));
      if (acct.material) {
        const dang = danglingFor(c.id);
        const named = dang && dang.indices && dang.indices.length
          ? ` ${dang.indices.length} dangling index(es): ${dang.indices.slice(0, 3).map((x) => x.index_name).join(', ')}.`
          : dang ? ' No dangling indices, so it is orphaned shard data rather than a lost index.'
                 : ' Open Nodes & shards to check for dangling indices.';
        add({ key: `${c.id}:disk-unaccounted`, level: 'warning', cluster: c,
          title: `${c.name}: ${bytesish(acct.gap)} of disk is not accounted for by any index`,
          detail: `Elasticsearch holds ${bytesish(acct.held)} on its data path but the index list `
                + `totals ${bytesish(acct.accounted)}.${named}` });
      }
    }

    // Snapshots, per repository, over the last five runs and no further back.
    //
    // A repository that has been running for a year holds hundreds of snapshots, and
    // whether the one from March failed says nothing about whether backups work today.
    // Five is enough to tell a bad night from a broken schedule, and short enough that
    // the answer is about now.
    //
    // Per repository rather than per cluster: two repositories are two different places
    // the data is being written to, and one of them failing while the other succeeds is
    // exactly the case a merged view hides.
    for (const repo of d.repos || []) {
      // A repository whose listing has not been read yet is unknown — "no snapshots" would
      // be a guess presented as a finding.
      if (!repo.error && !Array.isArray((d.snapshots || {})[repo.name])) continue;
      add(...snapshotAlertsFor(c, repo, ((d.snapshots || {})[repo.name]) || []));
    }

    (d.slm || []).forEach((p) => {
      const lf = p.last_failure, ls = p.last_success;
      if (lf && (!ls || lf.time > ls.time)) add({ key: `${c.id}:slm-fail:${p.id}`, level: 'critical', cluster: c, title: `${c.name}/${p.id}: last SLM run failed`, detail: String(lf.details || '').slice(0, 160) });
      const staleMs = state.defaults.snapshotStaleHours * 3600 * 1000;
      if (ls && Date.now() - ls.time > staleMs) add({ key: `${c.id}:slm-stale:${p.id}`, level: 'warning', cluster: c, title: `${c.name}/${p.id}: no successful snapshot recently`, detail: `Last success ${new Date(ls.time).toISOString().replace('T', ' ').slice(0, 16)}` });
    });
  }
  // Automations the operator wrote, from the last automation run. Computed there because
  // evaluating a rule can need a snapshot listing and this function is synchronous.
  for (const a of automationAlerts((id) => clusters().find((c) => c.id === id))) add(a);

  // Rules an admin switched off are removed here rather than never raised, so the code
  // above stays one description of what is true and the registry decides what is shown.
  return applySettings(out, loadAlertSettings(state.config && state.config.raw));
}

/**
 * Whether the size of the disk changed, and whether that change is believable.
 *
 * Separated out because the guard is the whole point and it is the part that has to be
 * right. `disk.total` is summed over the nodes present in _cat/allocation at this
 * instant, so a node restarting drops out of the table and capacity appears to collapse.
 * A change is therefore only believed when the node count is identical at both readings;
 * when nodes came or went, the new figure becomes the baseline silently. A rolling
 * restart must not page anybody.
 */
export function capacityChange(prev, total, nodeCount) {
  const prevTotal = prev && prev.total;
  const sameFleet = prev && prev.nodeCount === nodeCount;
  const changed = !!(sameFleet && prevTotal && total && prevTotal !== total);
  return {
    total,
    nodeCount,
    changedFrom: changed ? prevTotal : (prev && prev.changedFrom) || null,
    changedAt: changed ? Date.now() : (prev && prev.changedAt) || null,
  };
}

/** How long a master election stays worth an alert. */
export const MASTER_ALERT_HOURS = 24;

/** And how long a change in the size of the disk does. */
export const CAPACITY_ALERT_HOURS = 48;

/**
 * Disk that Elasticsearch holds but no open or closed index accounts for.
 *
 * `_cat/allocation` reports what the data path occupies; `_cat/indices` reports what the
 * indices in the cluster state occupy. They should agree closely. When allocation is
 * materially larger, the difference is data on disk that the cluster state does not
 * account for — a dangling index left by a removed node, or shard directories orphaned by
 * a failed relocation. That is disk nobody is going to reclaim by deleting an index,
 * because there is no index to delete.
 *
 * Reported as unknown rather than zero when either figure is missing: a missing index
 * list would otherwise make the whole of allocation look unaccounted for.
 */
export const DISK_GAP_MIN_BYTES = 1024 ** 3;     // a gigabyte
export const DISK_GAP_MIN_RATIO = 0.05;          // and at least 5% of what ES holds

export function diskAccounting(d, indices) {
  const held = d && d.disk ? Number(d.disk.indicesBytes) || 0 : 0;
  if (!held || !Array.isArray(indices) || !indices.length) {
    return { known: false, held, accounted: 0, gap: 0, material: false };
  }
  const accounted = indices.reduce((sum, i) => sum + (Number(i.size) || 0), 0);
  const gap = held - accounted;
  const material = gap > DISK_GAP_MIN_BYTES && gap > held * DISK_GAP_MIN_RATIO;
  return { known: true, held, accounted, gap, material };
}

/** Dangling indices, per cluster — read by the Nodes & shards page, on demand. */
const dangling = new Map();
export function setDangling(clusterId, v) { dangling.set(clusterId, v); }
export function danglingFor(clusterId) { return dangling.get(clusterId) || null; }

/** Snapshot alerts look this far back, and no further. */
export const SNAPSHOT_WINDOW = 5;

const SNAP_BAD = new Set(['FAILED', 'PARTIAL']);
const snapDay = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : 'unknown');

/**
 * What the last five snapshots in one repository say about it.
 *
 * Returns the alerts for that repository — never more than one, because "it is failing"
 * and "it is stale" are the same problem seen twice and two rows for one repository is
 * how an alert list stops being read.
 *
 * When something is failing, the useful figure is not that it failed but since when. That
 * is the oldest run in the unbroken failing streak counting back from the newest: a repo
 * that failed last night and has failed every night since reads as one problem starting
 * then, not five. If the streak fills the whole window the start is older than we looked,
 * and the alert says so rather than naming the fifth-oldest run as the beginning.
 */
function snapshotAlertsFor(c, repo, all) {
  const key = `${c.id}:repo:${repo.name}`;
  if (repo.error) {
    return [{ key: `${key}:unreadable`, level: 'warning', cluster: c, repo: repo.name,
      title: `${c.name}/${repo.name}: repository could not be read`,
      detail: `${repo.error}. Snapshot coverage for this repository is unknown, not empty.` }];
  }

  const recent = all.slice(0, SNAPSHOT_WINDOW);   // fetchSnapshots sorts newest first
  if (!recent.length) {
    return [{ key: `${key}:none`, level: 'warning', cluster: c, repo: repo.name,
      title: `${c.name}/${repo.name}: no snapshots`,
      detail: 'The repository is registered but holds none.' }];
  }

  const latest = recent[0];
  const staleMs = state.defaults.snapshotStaleHours * 3600 * 1000;
  const isNew = Date.now() - latest.start <= staleMs;
  // Carried structurally as well as in the prose so the alerts table can show the date
  // and the new/old answer in their own column rather than making them be read out of a
  // sentence.
  const snapshot = {
    repo: repo.name, id: latest.id, at: latest.start,
    status: String(latest.status || '').toUpperCase(), isNew,
    windowChecked: recent.length, windowTotal: all.length,
  };

  let streak = 0;
  while (streak < recent.length && SNAP_BAD.has(String(recent[streak].status || '').toUpperCase())) streak++;

  if (streak) {
    const since = recent[streak - 1];
    const older = streak === recent.length && all.length > recent.length;
    return [{
      key: `${key}:failing`, level: 'critical', cluster: c, repo: repo.name, snapshot,
      failingSince: since.start,
      title: `${c.name}/${repo.name}: ${streak} of the last ${recent.length} snapshots failed`,
      detail: `Failing since ${snapDay(since.start)} (${since.id})`
            + `${older ? ' — or earlier; every run in the window failed' : ''}. `
            + `Newest ${latest.id} is ${snapshot.status} at ${snapDay(latest.start)}.`,
    }];
  }

  if (!isNew) {
    return [{
      key: `${key}:stale`, level: 'warning', cluster: c, repo: repo.name, snapshot,
      title: `${c.name}/${repo.name}: newest snapshot is not recent`,
      detail: `${latest.id} succeeded at ${snapDay(latest.start)}, which is older than the `
            + `${state.defaults.snapshotStaleHours}h this cluster allows. The last `
            + `${recent.length} runs all succeeded, so the schedule stopped rather than broke.`,
    }];
  }
  return [];
}

/** Spikes the Indices page found for this cluster, if it has been asked to look. */
function spikesFor(clusterId) {
  try { return fieldVolumeSpikes().filter((s) => s.clusterId === clusterId); }
  catch (_) { return []; }
}

/**
 * Our own load on each cluster: requests sent in the last five minutes, per cluster.
 * Refreshed alongside the data so the number on screen is never older than the data
 * beside it. The core keeps the log; this is only the latest reading.
 */
export const requestLoad = { at: 0, windowSec: 300, clusters: {} };

export async function refreshRequestLoad() {
  try {
    const r = await requestStats();
    if (r && r.ok && r.requests) {
      requestLoad.at = Date.now();
      requestLoad.windowSec = r.requests.windowSec || 300;
      requestLoad.clusters = r.requests.clusters || {};
    }
  } catch (_) { /* the previous reading stands */ }
  return requestLoad;
}

export function requestsFor(clusterId) {
  return requestLoad.clusters[clusterId] || { last5m: 0, perMinute: 0, perSecond: 0 };
}

export function worstHealth() {
  let worst = 'grey';
  const rank = { grey: 0, green: 1, yellow: 2, red: 3 };
  for (const c of clusters()) {
    const d = state.data.get(c.id);
    const s = d && d.healthUnknown ? 'grey' : !d || !d.reachable ? 'red' : (d.health && d.health.status) || 'grey';
    if (rank[s] > rank[worst]) worst = s;
  }
  return worst;
}

function updateBadge() {
  const a = cachedAlerts();
  const crit = a.filter((x) => x.level === 'critical').length;
  const warn = a.length - crit;
  const w = worstHealth();
  const color = crit ? '#d03b3b' : warn ? '#fab219' : w === 'green' ? '#0ca30c' : '#64748b';
  setBadge(a.length ? String(a.length) : '', color,
    a.length ? `ElasticPro — ${crit} critical, ${warn} warning` : 'ElasticPro — all clusters healthy');
}

/** Small, credential-free summary so the toolbar popup can render instantly. */
function publishPopupSummary() {
  try {
    const rows = clusters().map((c) => {
      const d = state.data.get(c.id) || {};
      return {
        id: c.id, name: c.name, host: c.origin,
        status: !d.reachable ? 'offline' : (d.health && d.health.status) || 'grey',
        nodes: (d.health && d.health.number_of_nodes) || 0,
        diskPct: d.disk && isFinite(d.disk.percent) ? Math.round(d.disk.percent) : null,
        version: (d.info && d.info.version && d.info.version.number) || '',
      };
    });
    if (globalThis.chrome && chrome.storage && chrome.storage.session) chrome.storage.session.set({ summary: { at: Date.now(), rows, alerts: cachedAlerts().length } });
  } catch (_) { /* storage.session unavailable */ }
}

/**
 * Which JVM a cluster's nodes are running on.
 *
 * One definition because two screens want it: the fleet summary needs one line per
 * cluster, and a node listing needs the same words for the same thing. A cluster whose
 * nodes disagree is the interesting case — that is a half-finished upgrade, and it must
 * not be flattened to whichever node happened to answer first.
 *
 * Elasticsearch reports this only for nodes that answered. If none did, the answer is
 * "unknown", never a blank that reads as "none".
 *
 * @returns {{text: string, mixed: boolean, versions: string[], detail: string}}
 */
export function jvmSummary(nodes) {
  const seen = (nodes || [])
    .map((n) => String((n && n.jdk) || '').trim())
    .filter(Boolean);
  if (!seen.length) {
    return { text: 'unknown', mixed: false, versions: [], detail: 'no node reported a JVM version' };
  }
  const versions = [...new Set(seen)].sort();
  if (versions.length === 1) {
    return { text: versions[0], mixed: false, versions, detail: `every node runs JVM ${versions[0]}` };
  }
  const byVersion = versions.map((v) => `${v} (${seen.filter((x) => x === v).length})`);
  return {
    text: `mixed (${versions.length})`,
    mixed: true,
    versions,
    detail: `nodes disagree: ${byVersion.join(', ')}`,
  };
}
