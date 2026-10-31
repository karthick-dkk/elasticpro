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

/**
 * What the server keeps: `{ ok, default, clusters: [{id, user, kind, setBy, setAt}], promotable, problem }`.
 * `promotable` (0.3.46): with no default, the kept entries that could become it without anybody
 * typing the password again — `[{id, cluster, source: 'config'|'zabbix', user, kind}]`.
 */
export async function keptCredentials() {
  let r;
  try { r = await bridge({ type: 'CREDENTIAL_STATUS' }); } catch (e) { r = { ok: false, message: e.message }; }
  if (!r || !r.ok) return { ok: false, default: null, clusters: [], promotable: [], problem: (r && r.message) || 'no answer' };
  return { ok: true, default: r.default || null, clusters: Array.isArray(r.clusters) ? r.clusters : [],
           promotable: !r.default && Array.isArray(r.promotable) ? r.promotable : [], problem: r.problem || null };
}

/**
 * Make a credential the server already keeps the default (`CREDENTIAL_PROMOTE`): nothing is
 * typed and nothing comes back but the username. An existing default is replaced only with
 * `replace`. Throws with the server's reason.
 */
export async function promoteCredential(from, { replace = false } = {}) {
  const r = await bridge({ type: 'CREDENTIAL_PROMOTE', from, ...(replace ? { replace: true } : {}) });
  if (!r || !r.ok) throw refusal(r, 'the server did not make it the default');
  return r;
}

/** An Error carrying the core's `kind` (and, for `exists`, the default's user), never a secret. */
function refusal(r, fallback) {
  return Object.assign(new Error((r && r.message) || fallback), { kind: (r && r.kind) || '', user: (r && r.user) || null });
}

/** "Local-ES-Cluster's credential (user zabbix)" — a promotable entry as a choice reads. Pure. */
export function promotableLabel(entry) {
  if (!entry) return '';
  const name = entry.cluster || entry.id;
  return entry.kind === 'header' || !entry.user ? `${name}’s API key or token` : `${name}’s credential (user ${entry.user})`;
}

/** "Default credential (user fleet)" / "— none set yet": the default as the Add-cluster choice names it. Pure. */
export function defaultChoiceLabel(entry) {
  if (!entry) return 'Default credential — none set yet';
  return entry.kind === 'header' || !entry.user ? 'Default credential (an API key or token)' : `Default credential (user ${entry.user})`;
}

/**
 * Which credential the Add/Edit cluster dialog starts on: a cluster connected without one on
 * purpose says so ('none' — the core sends it nothing, whatever is kept); one that has its own
 * (kept on the server, or still in the file) keeps it; everything else — a new cluster above
 * all — uses the default and asks for nothing. Pure.
 */
export function initialCredentialChoice({ keptOwn = null, fileOwn = false, anonymous = false } = {}) {
  if (anonymous) return 'none';
  return keptOwn || fileOwn ? 'own' : 'default';
}

/** The entry kept for one cluster id (or `*`), or null. Pure. */
export function keptFor(status, id) {
  if (!status) return null;
  if (id === DEFAULT_CREDENTIAL) return status.default || null;
  return (status.clusters || []).find((c) => c.id === id) || null;
}

/** Keep a credential for a cluster id, or `*` for the default. Throws with the server's reason. */
export async function keepCredential(id, cred, { onlyIfAbsent = false } = {}) {
  const fields = credentialFields(cred);
  if (!fields) throw new Error('Enter a username and a password, an API key or a token.');
  // `onlyIfAbsent` (the default only): set it where there is none, never replace one somebody
  // set meanwhile — the core answers `exists` instead.
  const r = await bridge({ type: 'CREDENTIAL_SET', cluster: id, ...fields, ...(onlyIfAbsent ? { onlyIfAbsent: true } : {}) });
  if (!r || !r.ok) throw refusal(r, 'the server did not keep it');
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

/**
 * Clusters that rejected the default credential (HTTP 401/403): a config cluster with no
 * credential of its own kept, or a Zabbix cluster signing in with the default
 * (`core-default`). Each needs a credential of its own — not the default replaced for every
 * other cluster, and not a generic sign-in form. `stateOf(id)` is the client's state. Pure.
 */
export function rejectedDefault(list, stateOf, status) {
  if (!status || !status.default) return [];
  return (list || []).filter((c) => stateOf(c.id) === 'auth_error'
    && (c.source === 'zabbix' ? !!(c.zabbix && c.zabbix.credential === 'core-default') : !keptFor(status, c.id)));
}
