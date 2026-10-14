/**
 * A cluster's native-realm users, from `GET _security/user` — pure.
 *
 * Elasticsearch answers a map of username → user. Anything else (a proxy's error page parsed
 * as JSON, a generic acknowledgement) is reported as "not a list of users": unknown, never
 * an empty list (which would say the cluster has no accounts) and never a crash.
 */
export function usersFromSecurityResponse(res) {
  const notUsers = { users: null, error: 'The cluster answered, but not with a list of users.', fix: null };
  if (!res || typeof res !== 'object' || Array.isArray(res)) return notUsers;
  const entries = Object.entries(res);
  const rows = entries.filter(([, u]) => u && typeof u === 'object' && !Array.isArray(u));
  if (entries.length && rows.length !== entries.length) return notUsers;
  const users = rows.map(([key, u]) => ({
    name: typeof u.username === 'string' && u.username ? u.username : key,
    roles: Array.isArray(u.roles) ? u.roles : [],
    enabled: u.enabled !== false,
    fullName: u.full_name || '',
    email: u.email || '',
    reserved: !!(u.metadata && u.metadata._reserved),
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { users, error: null, fix: null };
}
