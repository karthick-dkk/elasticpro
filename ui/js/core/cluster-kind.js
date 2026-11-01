/**
 * Cluster type and ULM — ONE definition, read by the alert rules (state.js alerts()), the
 * Clusters page's badge, filter and snapshot cell, the Snapshots page and the edit dialog.
 *
 * Every cluster is CI, DI or On-Prem. CI and DI clusters archive their logs to S3 through
 * ULM and take no snapshots; an On-Prem cluster is backed up by SLM. So the type decides the
 * defaults, and an admin may override either half:
 *
 *   CI / DI   → ULM on,  SLM none      (no snapshot is the normal state, not a problem)
 *   On-Prem   → ULM off, SLM expected
 *   not set   → On-Prem's defaults     (an unknown cluster keeps every backup rule it had)
 *
 * `slmExempt(c)` — ULM on AND SLM not expected — is what turns the "SLM not running", "no
 * recent snapshot", "no snapshots" and "newest snapshot is not recent" rules off for a
 * cluster. A policy that exists and fails still raises: something set up to back the
 * cluster up and not doing it is always worth knowing.
 *
 * Where the settings live: hosted, the core's store (CLUSTER_META_GET, read once per config
 * load and again after a change; a Zabbix cluster with no entry is seeded from its host tag
 * `elasticpro:type`); desktop, the cluster's own keys in the config file —
 * `type: ci|di|onprem`, `ulm: true|false` or `ulm: {enabled, bucket}`, `slm: expected|none`.
 *
 * Only the bucket's NAME is kept. Whether the archive is complete is checked in Zabbix (the
 * log archive (S3) template); nothing in ElasticPro reads S3.
 */

import { bridge } from './transport.js';
import { credentialsKeptOnServer } from './server-credentials.js';

/** The types, in the order the dialog and the filter offer them. */
export const CLUSTER_TYPES = [
  { id: 'ci', label: 'CI' },
  { id: 'di', label: 'DI' },
  { id: 'onprem', label: 'On-Prem' },
];

/** "CI", "di", "On-Prem", "on_prem" → 'ci' | 'di' | 'onprem'; anything else → ''. Pure. */
export function normalizeType(v) {
  const k = String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k === 'ci' || k === 'di') return k;
  if (k === 'onprem' || k === 'onpremise' || k === 'onpremises') return 'onprem';
  return '';
}

/** 'onprem' → 'On-Prem'. Pure. */
export function typeLabel(type) {
  const t = CLUSTER_TYPES.find((x) => x.id === normalizeType(type));
  return t ? t.label : 'On-Prem';
}

/** What a type means when nothing overrides it. An unknown type is On-Prem. Pure. */
export function typeDefaults(type) {
  return normalizeType(type) === 'ci' || normalizeType(type) === 'di'
    ? { ulm: true, slm: 'none' }
    : { ulm: false, slm: 'expected' };
}

/* --------------------------------- the hosted store --------------------------------- */

let meta = new Map();
let rev = 0;

/** Replace what the core keeps (CLUSTER_META_GET's `clusters`, by cluster id). */
export function setClusterMeta(clusters) {
  meta = new Map(Object.entries(clusters && typeof clusters === 'object' ? clusters : {}));
  rev++;
}
/** Bumped on every change: part of a page's redraw signature. */
export function clusterKindRev() { return rev; }
/** The core's entry for one cluster, or null. */
export function clusterMetaOf(id) { return meta.get(String(id)) || null; }

/** Hosted: read the store once (setConfig calls this). Desktop: nothing to read. Never throws. */
export async function loadClusterMeta() {
  if (!credentialsKeptOnServer()) { if (meta.size) setClusterMeta({}); return; }
  try {
    const r = await bridge({ type: 'CLUSTER_META_GET' });
    if (r && r.ok) setClusterMeta(r.clusters);
  } catch (_) { /* unknown stays what it was: the defaults */ }
}

/**
 * Hosted: keep one cluster's settings (CLUSTER_META_SET, an admin's). `m` is
 * `{type, ulm: {enabled, bucket}, slm}` — `enabled` / `slm` null follow the type — or null
 * to forget the entry. Throws with the core's reason.
 */
export async function saveClusterMeta(id, m) {
  const r = await bridge({ type: 'CLUSTER_META_SET', clusterId: id, meta: m });
  if (!r || !r.ok) throw Object.assign(new Error((r && r.message) || 'the server did not keep it'), { kind: (r && r.kind) || '' });
  setClusterMeta(r.clusters);
  return r;
}

/* ------------------------------------ the definition ------------------------------------ */

/** The cluster's own settings, wherever they live: `{type, enabled, bucket, slm, source}` (unset = null). */
function ownOf(c) {
  if (!c) return { type: '', enabled: null, bucket: '', slm: null, source: 'default' };
  const m = credentialsKeptOnServer() ? clusterMetaOf(c.id) : null;
  if (m) {
    const u = m.ulm || {};
    return { type: normalizeType(m.type), enabled: typeof u.enabled === 'boolean' ? u.enabled : null,
             bucket: String(u.bucket || ''), slm: m.slm === 'expected' || m.slm === 'none' ? m.slm : null,
             source: m.source || 'set' };
  }
  if (credentialsKeptOnServer()) return { type: '', enabled: null, bucket: '', slm: null, source: 'default' };
  const u = c.ulm;
  return {
    type: normalizeType(c.type),
    enabled: typeof u === 'boolean' ? u : u && typeof u === 'object' && typeof u.enabled === 'boolean' ? u.enabled : null,
    bucket: String((u && typeof u === 'object' && u.bucket) || ''),
    slm: c.slm === 'expected' || c.slm === 'none' ? c.slm : null,
    source: normalizeType(c.type) ? 'file' : 'default',
  };
}

/**
 * → `{ type, label, ulm: {enabled, bucket}, slmExpected, set: {type, ulm, slm}, source }`.
 * `set` says which halves were chosen rather than defaulted (the dialog shows the rest
 * following the type). The bucket falls back to the cluster's `logBucket` (the same bucket,
 * named on the Clusters page before 0.3.47).
 */
export function clusterKind(c) {
  const own = ownOf(c);
  const type = own.type || 'onprem';
  const d = typeDefaults(type);
  const enabled = own.enabled === null ? d.ulm : own.enabled;
  const slm = own.slm || d.slm;
  return {
    type, label: typeLabel(type),
    ulm: { enabled, bucket: own.bucket || String((c && c.logBucket) || '') },
    slmExpected: slm === 'expected',
    set: { type: !!own.type, ulm: own.enabled !== null, slm: own.slm !== null },
    source: own.source,
  };
}

/** No snapshot is the normal state for this cluster: ULM archives its logs and SLM is not expected. */
export function slmExempt(c) {
  const k = clusterKind(c);
  return k.ulm.enabled && !k.slmExpected;
}

/** "ULM · s3 acme-logs" — what a snapshot cell says for an exempt cluster. Pure on the kind. */
export function ulmLabel(c) {
  const b = clusterKind(c).ulm.bucket;
  return b ? `ULM · s3 ${b}` : 'ULM · s3 (bucket not named)';
}

/** Why, for a tooltip. */
export const ULM_WHY = 'Logs are archived to S3 by ULM and SLM is not expected, so no snapshot is not a problem here. '
  + 'Whether the archive is complete is checked in Zabbix (log archive (S3) template), not here.';

/** An S3 bucket name by the general-purpose rules — the core's check_bucket, for the dialog. '' = fine. Pure. */
export function bucketProblem(b) {
  const s = String(b || '');
  if (!s) return '';
  if (s.length < 3 || s.length > 63) return 'An S3 bucket name is 3 to 63 characters.';
  if (!/^[a-z0-9.-]+$/.test(s)) return 'An S3 bucket name holds only lowercase letters, digits, dots and hyphens.';
  if (!/^[a-z0-9]/.test(s) || !/[a-z0-9]$/.test(s)) return 'An S3 bucket name starts and ends with a letter or a digit.';
  if (s.includes('..')) return 'An S3 bucket name has no two dots in a row.';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return 'An S3 bucket name is not an IP address.';
  return '';
}
