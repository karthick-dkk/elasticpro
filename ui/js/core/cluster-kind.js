/**
 * What kind of cluster this is: its type, whether its logs are archived by ULM, and whether
 * SLM snapshots are expected of it (docs/PLAY.md, "Cluster type and ULM"). The one
 * definition every page reads.
 *
 *   type  CI | DI | On-Prem       CI / DI → ULM on, SLM none;  On-Prem → ULM off, SLM expected
 *
 * Minimal on purpose: it reads `cluster.type`, `cluster.ulm` and `cluster.slm` as the
 * clusters file and CLUSTER_META carry them, with the documented defaults. A cluster that
 * says nothing is On-Prem, which is what every cluster was before types existed.
 */

const TYPES = ['CI', 'DI', 'On-Prem'];

/** @returns {{type: 'CI'|'DI'|'On-Prem', ulm: {enabled: boolean, bucket: string|null}, slmExpected: boolean}} */
export function clusterKind(cluster) {
  const c = cluster || {};
  const raw = String(c.type || '').trim().toLowerCase().replace(/[\s_]/g, '-');
  const type = TYPES.find((t) => t.toLowerCase() === raw) || 'On-Prem';
  const cloud = type !== 'On-Prem';
  const u = c.ulm;
  const enabled = u && typeof u === 'object' && typeof u.enabled === 'boolean' ? u.enabled
    : typeof u === 'boolean' ? u : cloud;
  const bucket = u && typeof u === 'object' && typeof u.bucket === 'string' && u.bucket.trim() ? u.bucket.trim() : null;
  const slm = String(c.slm || '').trim().toLowerCase();
  const slmExpected = slm === 'expected' ? true : slm === 'none' ? false : !cloud;
  return { type, ulm: { enabled, bucket }, slmExpected };
}

/** ULM archives the logs and no SLM is expected: snapshot "none / stale" says nothing about it. */
export function slmExempt(cluster) {
  const k = clusterKind(cluster);
  return k.ulm.enabled && !k.slmExpected;
}
