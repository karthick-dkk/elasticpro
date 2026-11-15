/**
 * A cluster's roles, from `GET _security/role` — pure.
 *
 * Elasticsearch answers a map of role name → definition. Anything else is "not a list of
 * roles": unknown, never an empty list (which would say the cluster defines none).
 */
import { esReason } from './security-users.js';

export function rolesFromSecurityResponse(res) {
  const notRoles = { roles: null, error: 'The cluster answered, but not with a list of roles.', fix: null };
  if (!res || typeof res !== 'object' || Array.isArray(res)) return notRoles;
  const entries = Object.entries(res);
  if (entries.some(([, r]) => !r || typeof r !== 'object' || Array.isArray(r))) return notRoles;
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  const roles = entries.map(([name, r]) => ({
    name,
    cluster: list(r.cluster),
    // "indices → privileges", one entry per index-privilege block.
    indices: (Array.isArray(r.indices) ? r.indices : []).map((i) => `${list(i.names).join(', ') || '(none)'} → ${list(i.privileges).join(', ') || '(none)'}`),
    runAs: list(r.run_as),
    reserved: !!(r.metadata && r.metadata._reserved),
    note: r.metadata && typeof r.metadata.description === 'string' ? r.metadata.description
      : r.description || '',
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { roles, error: null, fix: null };
}

/** Why the roles could not be read, in words, with Elasticsearch's own reason. */
export function rolesFailure(e) {
  const reason = esReason(e);
  if (/security must be explicitly enabled|xpack\.security\.enabled/i.test(reason)) {
    return { roles: null, error: `Security is switched off on this cluster, so it has no roles. (${reason})`, fix: 'Set xpack.security.enabled: true in elasticsearch.yml and restart the node.' };
  }
  if (/no handler found for uri/i.test(reason)) {
    return { roles: null, error: `This build of Elasticsearch has no security API. (${reason})`, fix: null };
  }
  if (/security_exception|unauthorized|forbidden|403|401/i.test(reason)) {
    return { roles: null, error: `This account is not permitted to read roles. (${reason})`, fix: 'Reading roles needs the manage_security or read_security privilege.' };
  }
  return { roles: null, error: reason, fix: null };
}
