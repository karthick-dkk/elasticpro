/**
 * Config layer.
 *
 * The whole configuration - including the single shared credential - lives in an
 * external YAML file on disk. The desktop app remembers the file's PATH; the file's
 * CONTENTS (and therefore the password / API key) are read into memory on every start
 * and never written anywhere else.
 */

import { pickConfigPath, readConfigText, savedConfigPath, rememberConfigPath } from './platform.js';
import { bridge } from './transport.js';

export const CONFIG_FILE_TYPES = [
  { description: 'YAML config', accept: { 'application/yaml': ['.yaml', '.yml'], 'text/yaml': ['.yaml', '.yml'] } },
];

export const DEFAULTS = {
  // Safety default: the extension only ever sends GET/HEAD plus search-family POSTs.
  // Set `readOnly: false` under `defaults:` in clusters.yaml to allow writes.
  readOnly: true,
  // Off by default: the dashboard loads once and then stays put until you ask it to
  // refresh. Set autoRefresh: true here, or use the toggle in the top bar (which is
  // remembered), to have it poll every refreshIntervalSec.
  autoRefresh: false,
  refreshIntervalSec: 30,
  requestTimeoutMs: 15000,
  logIndexPattern: 'logstash-*',
  // Named groups <source> and <date> drive the source picker on the Indices page.
  // <client> is still honoured for configs written before the rename. The source is
  // optional: a plain daily index (logstash-2026.09.23) is dated too.
  indexNameRegex: '^(?<prefix>[a-z0-9_.-]*?logstash)(?:-(?<source>.+))?-(?<date>\\d{4}[.\\-]\\d{2}[.\\-]\\d{2})$',
  timeField: '@timestamp',
  diskWarnPercent: 80,
  diskCritPercent: 90,
  // Capacity planning defaults, overridable per cluster. Empty means "not stated" —
  // the volume report then says so rather than assuming a number.
  liveRetention: '',
  snapshotRetention: '',
  // How the daily-ingest figure is derived from the dated indices — the number every
  // capacity figure on the volume report is built on, so it is stated here rather than
  // hard-coded in the arithmetic.
  //
  // Default: the mean of the 3 heaviest of the last 7 complete days. A plain mean
  // under-provisions whenever the window catches a quiet weekend or a collector outage;
  // taking the busiest few sizes against days that actually happen. Today is never
  // counted — its index is still being written to.
  //
  // The two knobs cover the usual preferences without needing a mode setting:
  //   volumeTopDays: 1                     -> size against the peak day
  //   volumeTopDays: volumeWindowDays      -> a plain mean of the whole window
  volumeWindowDays: 7,
  volumeTopDays: 3,
  // Planning headroom added on top of the daily figure before it is multiplied out into
  // retention requirements. 30 means "provision for 30% more than measured".
  volumeHeadroomPercent: 30,
  // Rows per page in the Indices and Shards tables. A cluster with thousands of indices
  // renders every row otherwise, which is slow to draw and impossible to read.
  tableRowsPerPage: 50,
  // Total size of the snapshot repository. Elasticsearch has no API for it — a repository
  // is a bucket or a mount point, and only the operator knows how big it is. "2TB",
  // "500 GB" or a bare number of GB. Empty means the report says "not set" rather than
  // guessing.
  backupCapacity: '',
  // ECS fields the Indices page breaks daily volume down by, and watches for spikes.
  // Each must be aggregatable; a `.keyword` sub-field is tried automatically.
  // Offered in the Volume analysis picker when a cluster names none of its own. They are
  // only candidates: the aggregation runs on demand, one field at a time, and a name
  // this cluster does not have reports that rather than costing anything.
  volumeFields: ['tag1', 'fwd_tag', 'fwdtag', 'src_hostname'],
  // Offered in the Live logs field picker. Searching one named field is the common case —
  // "which host", "which tag" — and spelling it as Lucene every time is a way to mistype
  // a field name and get zero hits that look like zero data.
  logSearchFields: ['tag1', 'fwd_tag', 'fwdtag', 'src_ip', 'src_hostname', 'message'],

  // Log delay: which field names the analysis needs on a cluster.
  //
  // `device` is what delay is grouped by, `eventTime` are the candidates for "when the
  // event actually happened" tried in order, and `metadata` are carried through for
  // context. They are per-cluster because two clusters can parse the same logs into
  // different shapes — one estate ships Filebeat ECS, another a custom parser — and a
  // single hard-coded set would silently analyse neither.
  delayFields: {
    device: 'src_hostname',
    eventTime: ['ingested_time', 'event_created', 'event.created'],
    metadata: ['parser_tag', 'fwdtag', 'src_ip', 'tag1', 'ClientID', 'branch', 'log_type'],
  },
  snapshotStaleHours: 26,
  maxLogRows: 200,
  // Certificate policy: auto (OS store, else trust-on-first-use with a prompt), system (strict), insecure.
  tls: 'auto',
};

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'cluster';
}

export function b64(s) {
  // btoa is latin1-only; encode UTF-8 first so non-ASCII passwords survive.
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export function authHeaderFor(cred) {
  if (!cred) return null;
  if (cred.apiKey) {
    // Accept both the raw "id:api_key" pair and an already-base64 encoded value.
    const v = cred.apiKey.includes(':') ? b64(cred.apiKey) : cred.apiKey;
    return `ApiKey ${v}`;
  }
  if (cred.bearer) return `Bearer ${cred.bearer}`;
  if (cred.username) return `Basic ${b64(`${cred.username}:${cred.password || ''}`)}`;
  return null;
}

class ConfigError extends Error {}

function requireYaml() {
  const y = globalThis.jsyaml;
  if (!y) throw new ConfigError('YAML parser not loaded (vendor/js-yaml.min.js missing).');
  return y;
}

/** Turn the raw YAML object into the shape the app uses. */
export function normalize(raw, sourceName = 'clusters.yaml') {
  if (!raw || typeof raw !== 'object') throw new ConfigError('Config file is empty or not a YAML mapping.');

  const defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
  const globalCred = raw.credentials || raw.credential || null;
  let anySealed = false;

  const list = raw.clusters || raw.hosts || [];
  if (!Array.isArray(list)) throw new ConfigError('`clusters:` must be a list.');

  // jump_hosts: { jumpwin: { host, port, user, keyFile } }  (a list of {id,...} is accepted too)
  const jhRaw = raw.jump_hosts || raw.jumpHosts || raw.jumps || {};
  const jumpHosts = (Array.isArray(jhRaw) ? jhRaw.map((j, i) => ({ id: j.id || j.name || `jump${i + 1}`, ...j }))
    : Object.entries(jhRaw).map(([id, j]) => ({ id, ...(j || {}) })))
    .map((j) => {
      if (!j.host) throw new ConfigError(`jump_hosts.${j.id} is missing \`host:\``);
      if (!j.user) throw new ConfigError(`jump_hosts.${j.id} is missing \`user:\``);
      if (j.passphrase || j.password) throw new ConfigError(`jump_hosts.${j.id}: passphrase/password must not be in the file — the app asks for them.`);
      return { id: String(j.id), host: String(j.host), port: Number(j.port) || 22, user: String(j.user),
               keyFile: j.keyFile || j.key_file || j.key || '', note: j.note || '' };
    });
  const jumpIds = new Set(jumpHosts.map((j) => j.id));

  const seen = new Set();
  const clusters = list.map((c, i) => {
    if (!c || !c.url) throw new ConfigError(`clusters[${i}] is missing a \`url:\``);
    const name = c.name || new URL(c.url).host;
    // `_id` is an id decided elsewhere — a Zabbix host's, which the core already uses —
    // and is kept exactly, rather than re-derived from a name that may collide.
    let id = c._id ? String(c._id) : slug(name);
    // `_index` is the cluster's place in the full list, set by the server's credential-free
    // view, which may leave some clusters out. Without it a name that collides with a
    // hidden cluster's would get a different id here than the core primed it under.
    const pos = Number.isInteger(c._index) ? c._index : i;
    while (seen.has(id) && !c._id) id = `${id}-${pos}`;
    seen.add(id);

    // Rule 3: one credential drives every URL, unless a cluster explicitly overrides it.
    const hasOwn = c.username || c.apiKey || c.bearer;
    const cred = hasOwn
      ? { username: c.username, password: c.password, apiKey: c.apiKey, bearer: c.bearer }
      : globalCred;

    // A credential is only usable if the file actually carries a secret. A file that
    // names a username but no password is a deliberate pattern - we prompt for the
    // password and prefill the username. A secret stored encrypted (enc:v1:…) is not
    // usable until the master password unlocks it.
    const sealed = !!(cred && [cred.password, cred.apiKey, cred.bearer].some((v) => isSealed(v)));
    if (sealed) anySealed = true;
    const hasSecret = !sealed && !!(cred && (cred.apiKey || cred.bearer || (cred.username && cred.password)));

    const via = c.via || c.jump || c.jumpHost || c.jump_host || '';
    if (via && !jumpIds.has(String(via))) throw new ConfigError(`clusters[${i}] (${name}): via: ${via} is not defined under jump_hosts:`);

    return {
      id,
      name,
      via: via ? String(via) : '',
      tls: String(c.tls || defaults.tls || 'auto'),
      url: String(c.url).replace(/\/+$/, ''),
      origin: (() => { try { return new URL(c.url).origin; } catch { return c.url; } })(),
      tags: c.tags || [],
      note: c.note || '',
      credSource: hasSecret ? (hasOwn ? 'cluster' : 'shared') : 'none',
      needsCred: !hasSecret,
      sealedCred: sealed ? { ...cred } : null,
      hasOwnCred: !!hasOwn,
      suggestedUsername: (cred && cred.username) || '',
      authHeader: hasSecret ? authHeaderFor(cred) : null,
      username: hasSecret ? ((cred && cred.username) || (cred && cred.apiKey ? '(api key)' : '')) : '',
      logIndexPattern: c.logIndexPattern || defaults.logIndexPattern,
      indexNameRegex: c.indexNameRegex || defaults.indexNameRegex,
      timeField: c.timeField || defaults.timeField,
      snapshotRepos: c.snapshotRepos || null,
      // Capacity planning: how long logs are meant to stay on the cluster and in the
      // repository. "30d", "90 days", "3M", "6 months", "1y" or a bare number of days.
      volumeFields: normFields(c.volumeFields || c.volume_fields || defaults.volumeFields),
      logSearchFields: normFields(c.logSearchFields || c.log_search_fields || defaults.logSearchFields),
      delayFields: normDelayFields(c.delayFields || c.delay_fields, defaults.delayFields),
      liveRetention: c.liveRetention || c.live_retention || defaults.liveRetention || '',
      snapshotRetention: c.snapshotRetention || c.snapshot_retention || defaults.snapshotRetention || '',
      backupCapacity: c.backupCapacity || c.backup_capacity || defaults.backupCapacity || '',
      // Zabbix user groups whose members may see this cluster. Only a Zabbix User's
      // account is limited by it; the core enforces it, this only carries it there.
      zabbixGroups: normFields(c.zabbixGroups || c.zabbix_groups),
      enabled: c.enabled !== false,
    };
  });

  // The shared credential as a header, for the core to use for Zabbix clusters when the
  // config says to connect with ElasticPro's credentials. Built here, by the one function
  // every cluster's header comes from; a sealed one is not usable until it is unlocked.
  const sharedUsable = globalCred && ![globalCred.password, globalCred.apiKey, globalCred.bearer].some((v) => isSealed(v));
  const sharedAuthHeader = sharedUsable ? authHeaderFor(globalCred) : null;
  return { defaults, clusters, jumpHosts, sourceName, loadedAt: Date.now(), raw, sealed: anySealed, sharedAuthHeader };
}

/** `tag1, src_hostname` or a YAML list — either way, a clean array of field names. */
/** A partial delayFields block overrides only the parts it names. */
function normDelayFields(v, defaults) {
  const d = v && typeof v === 'object' ? v : {};
  return {
    device: String(d.device || defaults.device),
    eventTime: normFields(d.eventTime || d.event_time || defaults.eventTime),
    metadata: normFields(d.metadata || defaults.metadata),
  };
}

function normFields(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
}

export function isSealed(v) { return typeof v === 'string' && v.startsWith('enc:v1:'); }

/** YAML or JSON — decided by content, not by extension. */
export function parseConfigText(text, sourceName) {
  const t = String(text || '').replace(/^\uFEFF/, '');
  let raw, format;
  if (/^\s*\{/.test(t)) {
    try { raw = JSON.parse(t); format = 'json'; }
    catch (e) { throw new ConfigError(`JSON parse error: ${e.message}`); }
  } else {
    const y = requireYaml();
    try { raw = y.load(t, { schema: y.JSON_SCHEMA }); format = 'yaml'; }
    catch (e) { throw new ConfigError(`YAML parse error: ${e.message}`); }
  }
  const cfg = normalize(raw, sourceName);
  cfg.format = format;
  return cfg;
}
export const parseYamlText = parseConfigText;

/** The file the app writes: JSON, stable key order, 2-space indent. */
export function serializeConfig(raw) {
  const ordered = {};
  for (const k of ['version', 'credentials', 'defaults', 'jump_hosts', 'clusters']) if (raw[k] !== undefined) ordered[k] = raw[k];
  for (const k of Object.keys(raw)) if (!(k in ordered)) ordered[k] = raw[k];
  ordered.version = 2;
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Skeleton for a config created in the UI. */
export function newRawConfig() {
  return {
    version: 2,
    defaults: { readOnly: true, autoRefresh: false, refreshIntervalSec: 30, logIndexPattern: 'logstash-*', tls: 'auto' },
    jump_hosts: {},
    clusters: [],
  };
}

/* ------------------------------ file plumbing ------------------------------ */

export const fsSupported = true;

function basename(p) { return String(p).split(/[\\/]/).pop() || p; }

/** Read + parse the YAML at `path` through the core. */
export async function readPath(path) {
  const r = await readConfigText(path);
  if (!r || !r.ok) {
    const e = new ConfigError((r && r.message) || `Could not read ${path}`);
    // Carried through so the caller can tell "no config here yet" from "this config is
    // broken" without reading the message.
    e.kind = (r && r.kind) || 'io_error';
    throw e;
  }
  const cfg = parseConfigText(r.text, basename(path));
  cfg.fileMeta = { name: basename(path), path, size: r.size || r.text.length, lastModified: r.lastModified || 0 };
  return cfg;
}

/** Native file dialog → remembered path. Returns '' when cancelled. */
export async function pickConfigFile() {
  const p = await pickConfigPath();
  if (p) rememberConfigPath(p);
  return p;
}

export function savedPath() { return savedConfigPath(); }
export async function forgetHandle() { rememberConfigPath(''); }

/**
 * The cluster list for somebody who may not read the config file: the server's own
 * file, with every credential removed and only the clusters this account may see.
 *
 * Nothing here needs a credential — the core was primed by an admin and keeps that — so
 * every cluster is marked as signed in on the server's side, which stops the pages
 * asking this person for a password they were never meant to have.
 */
export async function loadServerView() {
  let res;
  try { res = await bridge({ type: 'CONFIG_VIEW' }); } catch (e) { return { status: 'error', error: e.message }; }
  if (!res || !res.ok) {
    return { status: res && res.kind === 'not_found' ? 'no_file' : 'error', error: (res && res.message) || 'no answer' };
  }
  let config;
  try { config = parseConfigText(res.text, 'server'); } catch (e) { return { status: 'error', error: e.message }; }
  // An empty file is not yet "nothing for you": clusters may still come from Zabbix hosts,
  // which setConfig adds. The shell decides "nothing to show" after that.
  config.serverView = true;
  config.sealed = false;
  for (const c of config.clusters) {
    c.needsCred = false;
    c.credSource = 'server';
    c.sealedCred = null;
  }
  return { status: 'ok', path: '(server)', config };
}

/**
 * Clusters that are Zabbix hosts, as the core found them — credentials removed, and only
 * those this account may see. Never throws: no Zabbix, or no answer, is simply none.
 */
export async function loadZabbixClusters() {
  try {
    const res = await bridge({ type: 'ZABBIX_CLUSTERS' });
    return res && res.ok && Array.isArray(res.clusters) ? res : { ok: false, clusters: [] };
  } catch (_) {
    return { ok: false, clusters: [] };
  }
}

const urlKey = (u) => String(u || '').replace(/\/+$/, '').toLowerCase();

/**
 * Fold Zabbix clusters into a loaded config.
 *
 * Zabbix wins. A config-file cluster at the same address as a Zabbix host is set aside —
 * listed in `config.shadowed` so the Config page can say so, but no longer used — because
 * two definitions of one cluster disagreeing is exactly what "Zabbix wins" rules out.
 *
 * Zabbix clusters are the core's: it holds their credentials, read from Vault, so they
 * carry none here, never ask for one, and are never primed from the browser. Running it
 * again replaces the previous Zabbix set rather than adding to it.
 *
 * A Zabbix host whose password could not be read is held back (`config.zabbixPending`)
 * rather than used: it would replace a config cluster that works with one that cannot
 * sign in. It takes over the moment its credential does work — the next sync after the
 * password lands in Vault.
 */
export function mergeZabbixClusters(config, list) {
  if (!config) return config;
  const own = (config.clusters || []).filter((c) => c.source !== 'zabbix').concat(config.shadowedClusters || []);
  const all = Array.isArray(list) ? list : [];
  const rows = all.filter((z) => z.credentialOk !== false);
  config.zabbixPending = all.filter((z) => z.credentialOk === false);
  let zbx = [];
  if (rows.length) {
    zbx = normalize({ defaults: config.raw && config.raw.defaults,
      clusters: rows.map((z) => ({ _id: z._id, name: z.name, url: z.url,
        zabbixGroups: z.zabbixGroups || [], tags: ['zabbix', ...(z.client ? [z.client] : [])] })) }, 'zabbix')
      .clusters.map((c, i) => ({
        ...c,
        via: rows[i].via || '',
        source: 'zabbix',
        needsCred: false,
        credSource: rows[i].credential === 'elasticpro' ? 'zabbix-elasticpro' : 'zabbix',
        authHeader: null,
        username: rows[i].username || '',
        zabbix: { host: rows[i].zabbixHost, hostId: rows[i].zabbixHostId, client: rows[i].client || '',
                  credential: rows[i].credential, credentialOk: rows[i].credentialOk !== false, notes: rows[i].notes || [] },
      }));
  }
  const byUrl = new Map(zbx.map((c) => [urlKey(c.url), c]));
  config.shadowedClusters = own.filter((c) => byUrl.has(urlKey(c.url)));
  config.shadowed = config.shadowedClusters.map((c) => ({ name: c.name, url: c.url, by: byUrl.get(urlKey(c.url)).name }));
  config.clusters = [...own.filter((c) => !byUrl.has(urlKey(c.url))), ...zbx];
  config.fromZabbix = zbx.length;
  return config;
}

/**
 * Whether the core's cluster list has moved on from the Zabbix clusters merged into this
 * page — a host added in Zabbix (or by Cluster Management) that the core's five-minute sync
 * has picked up, or one Zabbix no longer has.
 *
 * `coreIds` is FLEET_STATE's `clusterIds`: what the core holds that this caller may see.
 * Returns a signature of the difference, or '' when there is none, so the caller can act
 * once per difference rather than on every FLEET_STATE — an id the Zabbix list cannot
 * explain (a cluster another admin primed) must not make every read re-load the list.
 *
 * Known without being in `clusters`: a config cluster set aside because Zabbix has its
 * address (the core still holds it, primed), and a Zabbix host held back because its
 * password could not be read (`zabbixPending`).
 */
export function zabbixDrift(coreIds, config) {
  if (!config || !Array.isArray(coreIds)) return '';
  const core = new Set(coreIds.map(String));
  const known = new Set([...(config.clusters || []), ...(config.shadowedClusters || [])].map((c) => String(c.id)));
  for (const z of config.zabbixPending || []) if (z && z._id) known.add(String(z._id));
  const added = [...core].filter((id) => !known.has(id)).sort();
  const removed = (config.clusters || []).filter((c) => c.source === 'zabbix' && !core.has(String(c.id)))
    .map((c) => String(c.id)).sort();
  if (!added.length && !removed.length) return '';
  return `+${added.join(',')}|-${removed.join(',')}`;
}

/** Load config on startup from the remembered path. */
export async function loadConfig() {
  const path = savedConfigPath();
  if (!path) return { status: 'no_file' };
  try {
    return { status: 'ok', path, config: await readPath(path) };
  } catch (e) {
    return { status: 'error', path, error: e.message };
  }
}

export { ConfigError };
