/**
 * Saved REST console queries — on the server (QUERY_*; crates/elasticpro-core/src/saved_queries.rs),
 * the caller's own and the team's shared ones. Secrets are redacted before a query leaves
 * the page, so a shared query never hands anyone a password or a token.
 */
import { bridge } from './transport.js';
import { redactSecrets, redactPath } from '../lib/redact.js';

let list = [];
let me = '';

export function savedQueries() { return list; }
export function savedQueriesUser() { return me; }

function take(res) {
  if (res && res.ok && Array.isArray(res.queries)) { list = res.queries; if (res.user) me = res.user; }
  return res;
}

export async function loadSavedQueries() {
  try { return take(await bridge({ type: 'QUERY_LIST' })); } catch (_) { return null; }
}

/** Create (no id) or update (id) — always redacted first. */
export async function saveQuery({ id, name, method, path, body, shared, note }) {
  const res = take(await bridge({
    type: 'QUERY_SAVE', ...(id ? { id } : {}), name, method,
    path: redactPath(path || '/'), body: redactSecrets(body || ''), shared: !!shared, note: note || '',
  }));
  // The list call above may not carry `user`; keep the last known one.
  return res;
}

export async function deleteSavedQuery(id) {
  return take(await bridge({ type: 'QUERY_DELETE', id }));
}

/** Whether this query is the caller's to change (the core checks again). */
export function ownQuery(q) { return !me || String(q.owner || '').toLowerCase() === me.toLowerCase(); }

/** Search over name, path, body and note. */
export function filterQueries(qs, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return qs;
  return qs.filter((q) => `${q.name} ${q.method} ${q.path} ${q.body} ${q.note || ''} ${q.owner}`.toLowerCase().includes(t));
}
