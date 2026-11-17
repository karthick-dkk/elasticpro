/**
 * Changing SLM policies and deleting many snapshots at once (Snapshots page, 0.3.72): the
 * request shapes and their checks, one definition each. Pure — no DOM, no network — so the
 * dialogs (ui/snapshot-dialogs.js), the ES client (core/es.js) and the unit tests
 * (tools/unit/snapshot-admin.test.mjs) all read the same rules.
 */

/* ------------------------------------ SLM ------------------------------------ */

/** `/_slm/policy/<id>` — the one path the read, the edit and the delete of a policy use. */
export function slmPolicyPath(id) {
  return `/_slm/policy/${encodeURIComponent(String(id))}`;
}

/**
 * The editable fields of a policy as the dialog shows them. `entry` is one value of the
 * `GET _slm/policy/<id>` answer (`{ version, policy: {…}, … }`) or the policy itself.
 * Indices are a comma list; a count or an age that is not set is ''.
 */
export function slmForm(entry) {
  const p = (entry && entry.policy) || entry || {};
  const cfg = p.config || {};
  const ret = p.retention || {};
  const ix = cfg.indices;
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  return {
    name: str(p.name),
    schedule: str(p.schedule),
    repository: str(p.repository),
    indices: Array.isArray(ix) ? ix.join(', ') : str(ix),
    expireAfter: str(ret.expire_after),
    minCount: str(ret.min_count),
    maxCount: str(ret.max_count),
  };
}

/** A comma list as Elasticsearch wants it: trimmed, no empties. */
export function splitList(text) {
  return String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Cron as SLM reads it: six or seven fields (seconds first, year optional). */
export function cronFields(schedule) {
  return String(schedule || '').trim().split(/\s+/).filter(Boolean).length;
}

/** An Elasticsearch time value as retention takes it: `30d`, `12h`, `90m`… */
const TIME_VALUE = /^\d+(\.\d+)?(d|h|m|s|ms|micros|nanos)$/;
const COUNT = /^\d+$/;

/**
 * What is wrong with the form, one sentence each; empty when it may be saved. `repos` is the
 * cluster's repository names — the policy must write to one that exists.
 */
export function slmFormErrors(form, repos = []) {
  const f = form || {};
  const errs = [];
  if (!String(f.name || '').trim()) errs.push('The snapshot name pattern is empty (for example <daily-{now/d}>).');
  const n = cronFields(f.schedule);
  if (n < 6 || n > 7) errs.push(`The schedule has ${n} field${n === 1 ? '' : 's'}; SLM's cron needs 6 or 7 (seconds minutes hours day month weekday [year]), for example 0 30 1 * * ?.`);
  const repo = String(f.repository || '').trim();
  if (!repo) errs.push('Choose a repository.');
  else if (!repos.includes(repo)) errs.push(`Repository "${repo}" does not exist on this cluster.`);
  const exp = String(f.expireAfter || '').trim();
  if (exp && !TIME_VALUE.test(exp)) errs.push(`Expire after "${exp}" is not a time value (for example 30d or 12h).`);
  const min = String(f.minCount || '').trim(), max = String(f.maxCount || '').trim();
  if (min && !COUNT.test(min)) errs.push(`Min count "${min}" is not a whole number.`);
  if (max && (!COUNT.test(max) || Number(max) < 1)) errs.push(`Max count "${max}" is not a whole number of at least 1.`);
  if (min && max && COUNT.test(min) && COUNT.test(max) && Number(min) > Number(max)) errs.push(`Min count (${min}) is more than max count (${max}).`);
  return errs;
}

/**
 * The `PUT _slm/policy/<id>` body: the form's fields over the policy as it was read. Every
 * key the dialog does not show — include_global_state, ignore_unavailable, partial,
 * feature_states, metadata, and anything newer — is carried over exactly as read. Indices
 * left empty means every index (the key is left out, as Elasticsearch defaults it);
 * retention with nothing set is left out.
 */
export function slmPolicyBody(entry, form) {
  const p = (entry && entry.policy) || entry || {};
  const f = form || {};
  const body = {};
  // Top-level keys other than the ones written below keep their place and value.
  for (const [k, v] of Object.entries(p)) if (!['name', 'schedule', 'repository', 'config', 'retention'].includes(k)) body[k] = v;
  body.name = String(f.name || '').trim();
  body.schedule = String(f.schedule || '').trim().split(/\s+/).join(' ');
  body.repository = String(f.repository || '').trim();
  const config = { ...(p.config || {}) };
  const ix = splitList(f.indices);
  if (ix.length) config.indices = ix; else delete config.indices;
  body.config = config;
  const ret = { ...(p.retention || {}) };
  const exp = String(f.expireAfter || '').trim(), min = String(f.minCount || '').trim(), max = String(f.maxCount || '').trim();
  if (exp) ret.expire_after = exp; else delete ret.expire_after;
  if (min) ret.min_count = Number(min); else delete ret.min_count;
  if (max) ret.max_count = Number(max); else delete ret.max_count;
  if (Object.keys(ret).length) body.retention = ret;
  return body;
}

/* --------------------------- many snapshots at once --------------------------- */

/** Longest request path a bulk delete sends; Elasticsearch's own limit (4 KB line) less room for the rest. */
export const DELETE_PATH_MAX = 3000;

/** `DELETE /_snapshot/<repo>/<a>,<b>,…` — each name encoded, the commas literal. */
export function snapshotsDeletePath(repo, names) {
  return `/_snapshot/${encodeURIComponent(String(repo))}/${names.map((n) => encodeURIComponent(String(n))).join(',')}`;
}

/**
 * The names cut into requests whose path stays within `max` characters, in the order given.
 * A name too long to share a request with anything goes alone.
 * @returns {{names: string[], path: string}[]}
 */
export function snapshotDeleteBatches(repo, names, max = DELETE_PATH_MAX) {
  const out = [];
  let cur = [];
  for (const n of names || []) {
    const next = [...cur, n];
    if (cur.length && snapshotsDeletePath(repo, next).length > max) {
      out.push({ names: cur, path: snapshotsDeletePath(repo, cur) });
      cur = [n];
    } else cur = next;
  }
  if (cur.length) out.push({ names: cur, path: snapshotsDeletePath(repo, cur) });
  return out;
}

/** A snapshot still being taken cannot be ticked: Elasticsearch would abort it, not delete it. */
export function snapshotSelectable(s) {
  return String((s && s.status) || '').toUpperCase() !== 'IN_PROGRESS';
}
/** Why a row has no tick, for its title. */
export const NOT_SELECTABLE_WHY = 'Still being taken — it can be ticked once it has finished';

/** The bulk delete's confirmation: the number of snapshots, or the word delete. */
export function bulkDeleteConfirmed(typed, count) {
  const t = String(typed || '').trim().toLowerCase();
  return t === 'delete' || (count > 0 && t === String(count));
}
