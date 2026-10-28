/**
 * Credentials the hosted server keeps for its clusters (0.3.42).
 *
 * Typed once — the default by an admin, a cluster's own when it is added or changed — and
 * kept encrypted by the core (cluster-secrets.json, AES-256-GCM under the server's key, see
 * crates/elasticpro-core/src/cluster_secrets.rs). The core never sends one back: the status
 * says which username, who set it and when. Nobody is asked for them again, not on a page
 * load and not after a restart, because the core resolves every cluster's credential itself:
 * the cluster's own, else the default (`*`, the same default Zabbix hands over).
 *
 * The portable build keeps credentials in the config file as before (sealed with the master
 * password); `credentialsKeptOnServer()` is how the dialogs tell the two apart.
 */

import { bridge } from './transport.js';

/** The name the default credential is kept under — every cluster without its own uses it. */
export const DEFAULT_CREDENTIAL = '*';

let hosted = false;

/** Set once at start from WHOAMI's edition. */
export function setHostedEdition(on) { hosted = !!on; }

/** Whether credentials are the server's to keep (hosted) or the config file's (portable). */
export function credentialsKeptOnServer() { return hosted; }

/**
 * The CREDENTIAL_SET fields for one credential as the dialogs read it, or null when it is
 * not complete. Pure.
 */
export function credentialFields(cred) {
  if (!cred || typeof cred !== 'object') return null;
  const s = (v) => (v == null ? '' : String(v));
  if (s(cred.apiKey).trim()) return { apiKey: s(cred.apiKey).trim() };
  if (s(cred.bearer).trim()) return { bearer: s(cred.bearer).trim() };
  if (s(cred.username).trim() && s(cred.password)) return { username: s(cred.username).trim(), password: s(cred.password) };
  return null;
}

/** What the server keeps: `{ ok, default, clusters: [{id, user, kind, setBy, setAt}], problem }`. */
export async function keptCredentials() {
  let r;
  try { r = await bridge({ type: 'CREDENTIAL_STATUS' }); } catch (e) { r = { ok: false, message: e.message }; }
  if (!r || !r.ok) return { ok: false, default: null, clusters: [], problem: (r && r.message) || 'no answer' };
  return { ok: true, default: r.default || null, clusters: Array.isArray(r.clusters) ? r.clusters : [], problem: r.problem || null };
}

/** The entry kept for one cluster id (or `*`), or null. Pure. */
export function keptFor(status, id) {
  if (!status) return null;
  if (id === DEFAULT_CREDENTIAL) return status.default || null;
  return (status.clusters || []).find((c) => c.id === id) || null;
}

/** Keep a credential for a cluster id, or `*` for the default. Throws with the server's reason. */
export async function keepCredential(id, cred) {
  const fields = credentialFields(cred);
  if (!fields) throw new Error('Enter a username and a password, an API key or a token.');
  const r = await bridge({ type: 'CREDENTIAL_SET', cluster: id, ...fields });
  if (!r || !r.ok) throw new Error((r && r.message) || 'the server did not keep it');
  return r;
}

/** Forget what is kept for a cluster id (it then uses the default), or the default itself. */
export async function forgetCredential(id) {
  const r = await bridge({ type: 'CREDENTIAL_CLEAR', cluster: id });
  if (!r || !r.ok) throw new Error((r && r.message) || 'the server did not clear it');
  return r;
}

/**
 * A cluster's own credential is bound to its address, route and certificate setting. After an
 * admin moved the cluster on purpose, this binds it to where it is polled now.
 */
export async function rebindCredential(id) {
  const r = await bridge({ type: 'CREDENTIAL_SET', cluster: id, rebind: true });
  if (!r || !r.ok) throw new Error((r && r.message) || 'the server did not move it');
  return r;
}

/** "elastic · set by Admin on 28 Oct 2026" — never more than the status carries. Pure. */
export function keptLine(entry) {
  if (!entry) return '';
  const who = entry.kind === 'header' ? 'API key or token' : (entry.user || '(no username)');
  const when = entry.setAt ? new Date(entry.setAt * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  return `${who}${entry.setBy ? ` · set by ${entry.setBy}` : ''}${when ? ` on ${when}` : ''}`;
}
