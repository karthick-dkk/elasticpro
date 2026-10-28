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
 *
 * The same goes for the status itself (0.3.44, `lifecycleView`): ILM or SLM that ES reports
 * as RUNNING is only shown as Running in green when it looks after the log indices —
 * every open log index under an ILM policy, a scheduled SLM policy that takes them. RUNNING
 * with nothing of the logs in its care is Running in red, and why is in the tooltip.
 */

export const DEFAULT_LOG_PATTERN = 'logstash-*';

/** A cluster's log index pattern: its own, else the config default (logstash-* when neither says). */
export const logPatternOf = (cluster, defaults) => (cluster && cluster.logIndexPattern) || (defaults && defaults.logIndexPattern) || undefined;

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

/** RUNNING → "Running", STOPPED → "Stopped": the mode as every ILM/SLM pill writes it. */
export function modeWord(mode) {
  const m = String(mode || '').trim();
  return m ? m.charAt(0).toUpperCase() + m.slice(1).toLowerCase() : 'Unknown';
}
const isRunning = (mode) => String(mode || '').toUpperCase() === 'RUNNING';

/**
 * Does ILM look after the log indices? `d.ilmOfIndex` is { index: policy name or null } over
 * every OPEN index of the ilm_assign answer (closed indices are not asked for), or null when
 * that answer was not read or did not list the indices without a policy (state.js). Then the
 * coverage is unknown, never assumed.
 * → { known, ok, total, managed, unmanaged: [names], policies: [names] }
 */
export function ilmCoverage(d, pattern) {
  const of = d && d.ilmOfIndex;
  if (!of) return { known: false, ok: false, total: 0, managed: 0, unmanaged: [], policies: [] };
  const names = Object.keys(of).filter((n) => matchesPattern(n, pattern)).sort();
  const unmanaged = names.filter((n) => !of[n]);
  const policies = [...new Set(names.map((n) => of[n]).filter(Boolean))].sort();
  return { known: true, ok: names.length > 0 && !unmanaged.length, total: names.length,
    managed: names.length - unmanaged.length, unmanaged, policies };
}

/**
 * Does SLM look after the log indices: a scheduled policy whose indices take them?
 * `d.slm` is the policy list (undefined when not read). → { known, ok, policies: [ids], others: [ids] }
 */
export function slmCoverage(d, pattern) {
  if (!d || !Array.isArray(d.slm)) return { known: false, ok: false, policies: [], others: [] };
  const scheduled = d.slm.filter((p) => p && p.policy && p.policy.schedule);
  const policies = scheduled.filter((p) => slmCoversPattern(p, pattern)).map((p) => p.id).sort();
  const others = scheduled.filter((p) => !slmCoversPattern(p, pattern)).map((p) => p.id).sort();
  return { known: true, ok: policies.length > 0, policies, others };
}

const logsOf = (pattern) => patternsOf(pattern).join(', ');
const listOf = (a, n = 5) => `${a.slice(0, n).join(', ')}${a.length > n ? `, +${a.length - n} more` : ''}`;

/**
 * The pill for ILM or SLM — ONE definition for the Clusters columns and tiles, the Snapshots
 * page and the CSV. `kind` is 'ILM' or 'SLM'.
 * → { tone: 'green'|'red'|'grey', word: 'Running'|'Stopped'|…|'Running ?', covered: true|false|null, why }
 *   tone grey (and covered null) when the mode is not read, or it runs and what it covers
 *   could not be read: unknown is not shown as good or as bad.
 */
export function lifecycleView(kind, d, pattern) {
  const mode = kind === 'ILM' ? d && d.ilm && d.ilm.operation_mode : d && d.slmStatus && d.slmStatus.operation_mode;
  if (!mode) return { tone: 'grey', word: 'Unknown', covered: null, why: `${kind} status has not been read.` };
  const word = modeWord(mode);
  if (!isRunning(mode)) return { tone: 'red', word, covered: false, why: `${kind} is ${word.toLowerCase()}: nothing is managed until it is started again.` };
  const logs = logsOf(pattern);
  if (kind === 'ILM') {
    const c = ilmCoverage(d, pattern);
    if (!c.known) return { tone: 'grey', word: 'Running ?', covered: null,
      why: `ILM is running, but which policy each ${logs} index has could not be read (it needs view_index_metadata on ${logs}).` };
    if (!c.total) return { tone: 'red', word, covered: false, why: `ILM is running, but there is no open ${logs} index for it to manage.` };
    if (c.unmanaged.length) return { tone: 'red', word, covered: false,
      why: `ILM is running, but ${c.unmanaged.length} of ${c.total} open ${logs} indices ${c.unmanaged.length === 1 ? 'has' : 'have'} no ILM policy: ${listOf(c.unmanaged)}` };
    return { tone: 'green', word, covered: true,
      why: `ILM is running and all ${c.total} open ${logs} indices are under a policy (${listOf(c.policies, 3)}).` };
  }
  const c = slmCoverage(d, pattern);
  if (!c.known) return { tone: 'grey', word: 'Running ?', covered: null,
    why: `SLM is running, but its policies could not be read (it needs manage_slm or read_slm).` };
  if (!c.ok) return { tone: 'red', word, covered: false,
    why: `SLM is running, but no scheduled SLM policy takes ${logs}${c.others.length ? ` (${listOf(c.others, 3)} take${c.others.length === 1 ? 's' : ''} other indices)` : ''}.` };
  return { tone: 'green', word, covered: true, why: `SLM is running and ${listOf(c.policies, 3)} snapshot${c.policies.length === 1 ? 's' : ''} ${logs}.` };
}
