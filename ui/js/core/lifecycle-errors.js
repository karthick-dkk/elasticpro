/**
 * ILM and SLM errors — ONE definition, used by the Clusters cell and its tooltip, the sort,
 * the CSV, the alerts and the Indices "in ILM error" filter.
 *
 * The question an operator asks is "is my log data lifecycle broken", not "does anything
 * anywhere in this cluster have a failed step". So an error only counts when it concerns the
 * cluster's log indices (its logIndexPattern, logstash-* by default) and the feature is
 * actually running:
 *
 *  - ILM error: an index matching the log pattern, managed by an ILM policy and in the ERROR
 *    step (d.ilmErrors is `_ilm/explain?only_errors&only_managed` over every index), while
 *    ILM's operation mode is RUNNING.
 *  - SLM error: a scheduled policy whose indices cover the log pattern (policy.config.indices;
 *    absent or `*` means everything) and whose last run failed (last_failure newer than
 *    last_success), while SLM's operation mode is RUNNING.
 *
 * `known` is false when the figure cannot be told (mode not read): unknown is not zero.
 * `count`/`names` are 0/[] when the feature is not RUNNING — a stopped feature is already
 * shown by its mode.
 */

export const DEFAULT_LOG_PATTERN = 'logstash-*';

const patternsOf = (p) => String(p || DEFAULT_LOG_PATTERN).split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('-'));
const escRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const globRe = (g) => new RegExp(`^${g.split('*').map(escRe).join('.*')}$`);

/** Does `name` match any of the comma-separated `pattern` globs? */
export function matchesPattern(name, pattern) {
  return patternsOf(pattern).some((g) => globRe(g).test(String(name)));
}

/** Could a glob `a` and a glob `b` select the same index? (literal prefix overlap / literal match) */
function overlap(a, b) {
  if (a === '*' || a === '_all' || b === '*' || b === '_all') return true;
  const wa = a.includes('*'), wb = b.includes('*');
  if (!wa) return globRe(b).test(a);
  if (!wb) return globRe(a).test(b);
  const pa = a.slice(0, a.indexOf('*')), pb = b.slice(0, b.indexOf('*'));
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Does an SLM policy's index selection cover any of the log patterns? */
export function slmCoversPattern(policy, pattern) {
  const cfg = (policy && policy.policy && policy.policy.config) || {};
  let sel = cfg.indices;
  if (typeof sel === 'string') sel = sel.split(',');
  if (!Array.isArray(sel) || !sel.length) return true;      // no selection = all indices
  const mine = patternsOf(pattern);
  return sel.map((s) => String(s).trim()).filter((s) => s && !s.startsWith('-'))
    .some((s) => mine.some((m) => overlap(s, m)));
}

/** { known, count, names, details } — see the header. `pattern` is the cluster's logIndexPattern. */
export function ilmErrorsOf(d, pattern) {
  const mode = d && d.ilm && d.ilm.operation_mode;
  if (!mode) return { known: false, count: 0, names: [], details: {} };
  if (String(mode).toUpperCase() !== 'RUNNING') return { known: true, count: 0, names: [], details: {} };
  const details = {};
  for (const [name, x] of Object.entries((d && d.ilmErrors) || {})) if (matchesPattern(name, pattern)) details[name] = x;
  const names = Object.keys(details).sort();
  return { known: true, count: names.length, names, details };
}

/** { known, count, names, failures } — failures: [{ id, at, details }]. */
export function slmErrorsOf(d, pattern) {
  const mode = d && d.slmStatus && d.slmStatus.operation_mode;
  if (!mode) return { known: false, count: 0, names: [], failures: [] };
  if (String(mode).toUpperCase() !== 'RUNNING') return { known: true, count: 0, names: [], failures: [] };
  const failures = [];
  for (const p of (d && d.slm) || []) {
    const lf = p.last_failure, ls = p.last_success;
    if (!lf || (ls && !(lf.time > ls.time))) continue;
    if (!(p.policy && p.policy.schedule)) continue;          // not scheduled = not applied
    if (!slmCoversPattern(p, pattern)) continue;
    failures.push({ id: p.id, at: lf.time, details: String(lf.details || '') });
  }
  failures.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { known: true, count: failures.length, names: failures.map((f) => f.id), failures };
}

/** One line per erroring index, for a tooltip. */
export function ilmErrorTitle(e) {
  if (!e.count) return '';
  const lines = e.names.slice(0, 8).map((n) => {
    const x = e.details[n] || {};
    const where = [x.policy, x.phase, x.step].filter(Boolean).join(' · ');
    const why = x.step_info && (x.step_info.reason || x.step_info.type);
    return `${n}${where ? ` — ${where}` : ''}${why ? `: ${why}` : ''}`;
  });
  const more = e.count - lines.length;
  return `${e.count} log ind${e.count === 1 ? 'ex' : 'ices'} in ILM error:\n${lines.join('\n')}${more > 0 ? `\n+${more} more` : ''}`;
}

export function slmErrorTitle(e) {
  if (!e.count) return '';
  const lines = e.failures.slice(0, 8).map((f) => {
    const t = Number.isFinite(f.at) ? new Date(f.at).toISOString().replace('T', ' ').slice(0, 16) : '?';
    return `${f.id} failed at ${t}${f.details ? `: ${f.details.slice(0, 120)}` : ''}`;
  });
  return `SLM policy failing:\n${lines.join('\n')}`;
}
