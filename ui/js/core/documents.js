/**
 * Documents inside Indices — the arithmetic and the request shapes, in one place.
 *
 * The Indices page opens an index's documents in the same page (ui/ui/documents-view.js draws
 * them). Everything here is pure: which indices a Documents request names and whether that
 * path is too long for one request, the `_search` body for a page of hits and for a field's
 * top values, the field list read out of `_mapping`, the time field, the "x–y of total" label
 * (10,000+ when Elasticsearch stops counting — never a guessed number), the page-size clamp,
 * and the line diff the Review and save dialog shows. tools/unit/documents.test.mjs holds it.
 */

/** Rows per page on the Indices table: 10 by default, up to 100 (the owner, 2026-11-16). */
export const INDEX_PAGE_SIZES = Object.freeze([10, 25, 50, 100]);
/** Rows per page on the documents table: 5 by default, up to 50 (the owner, 2026-11-16). */
export const DOC_PAGE_SIZES = Object.freeze([5, 10, 25, 50]);
/** `from + size` may not pass this: Elasticsearch's index.max_result_window default. */
export const MAX_RESULT_WINDOW = 10000;
/** The longest path one Documents request may carry (a list of index names in the URL). */
export const MAX_TARGET_CHARS = 3000;
/** The top values a field panel click asks for. */
export const TOP_VALUES = 10;

/** `n` when it is one of `sizes`, else the first of them (the default). */
export function clampPageSize(n, sizes) {
  const v = Math.floor(Number(n));
  return sizes.includes(v) ? v : sizes[0];
}

/** The time range buttons: an id, its label and its length in ms; `custom` has none. */
export const RANGES = Object.freeze([
  { id: '15m', label: '15m', ms: 15 * 60000 },
  { id: '1h', label: '1h', ms: 3600000 },
  { id: '24h', label: '24h', ms: 86400000 },
  { id: '7d', label: '7d', ms: 7 * 86400000 },
  { id: 'custom', label: 'Custom', ms: null },
]);

/**
 * `{from, to}` in ms for a range id at `now`; a custom range passes its own ms through
 * (either end may be null = open); null when there is no time filter at all.
 */
export function rangeWindow(id, now, custom = null) {
  const r = RANGES.find((x) => x.id === id);
  if (!r) return null;
  if (r.ms === null) {
    if (!custom || (custom.from == null && custom.to == null)) return null;
    return { from: custom.from ?? null, to: custom.to ?? null };
  }
  return { from: now - r.ms, to: now };
}

/** One comma-separated part is an Elasticsearch pattern when it carries `*` or `?`. */
const isGlob = (p) => /[*?]/.test(p);

/**
 * Which indices a Documents request names, from the Indices search as typed.
 *
 * A plain pattern list — every part a glob, no inversion ("Not matching" off, no leading
 * `!`), and no other filter narrowing the table — goes to Elasticsearch as typed. Anything
 * else (plain text, which means "contains" here and would match nothing as an index name;
 * an inverted search; a table narrowed by status, day or source) sends the matched OPEN index
 * names, joined by commas. Nothing typed and nothing narrowing is every open index (`*`).
 * A names list longer than MAX_TARGET_CHARS cannot be one request: `target` is null and
 * `reason` says what to do.
 */
export function documentsTarget(text, { not = false, narrowed = false, names = [] } = {}) {
  const t = String(text ?? '').trim();
  const bang = t.startsWith('!');
  const parts = (bang ? t.slice(1) : t).split(',').map((x) => x.trim()).filter(Boolean);
  if (!parts.length && !narrowed) return { target: '*', asTyped: true, reason: '' };
  if (parts.length && parts.every(isGlob) && !not && !bang && !narrowed) {
    return { target: parts.join(','), asTyped: true, reason: '' };
  }
  const list = names.filter(Boolean).join(',');
  if (!list) return { target: null, asTyped: false, reason: 'No open index matches the search' };
  if (list.length > MAX_TARGET_CHARS) return { target: null, asTyped: false, reason: 'Too many indices for one search — narrow the search' };
  return { target: list, asTyped: false, reason: '' };
}

/** The search path for a target, with the flags every Documents request carries. */
export const SEARCH_FLAGS = 'ignore_unavailable=true&allow_no_indices=true&expand_wildcards=open';
export function documentsPath(target) {
  return `/${encodeURIComponent(target)}/_search?${SEARCH_FLAGS}`;
}
export function mappingPath(target) {
  return `/${encodeURIComponent(target)}/_mapping?${SEARCH_FLAGS}`;
}

/** The hash that opens the documents of `target` inside the Indices page. */
export const docsHash = (target) => `#/indices/docs/${encodeURIComponent(target)}`;
/** The target a hash names, or null when it is not a documents address. */
export function docsTargetOf(hash) {
  const m = /^#\/indices\/docs\/([^?]+)/.exec(String(hash || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
}

/** The query part every Documents search shares: the query string and the time window. */
function filterClauses({ query = '', timeField = null, window = null } = {}) {
  const q = String(query || '').trim();
  const filter = [q ? { query_string: { query: q, default_operator: 'AND' } } : { match_all: {} }];
  if (timeField && window && (window.from != null || window.to != null)) {
    const range = { format: 'epoch_millis' };
    if (window.from != null) range.gte = Math.floor(window.from);
    if (window.to != null) range.lte = Math.floor(window.to);
    filter.push({ range: { [timeField]: range } });
  }
  return filter;
}

/**
 * The body for one page of hits: newest first by the time field when there is one, else by
 * `_doc`; the exact total (`track_total_hits`), and each hit's `_seq_no` / `_primary_term`
 * so an edit or a delete can name the version it read.
 */
export function searchBody({ query = '', timeField = null, window = null, from = 0, size = 5 } = {}) {
  return {
    query: { bool: { filter: filterClauses({ query, timeField, window }) } },
    sort: timeField ? [{ [timeField]: 'desc' }] : ['_doc'],
    from: Math.max(0, Math.floor(from) || 0),
    size: Math.max(1, Math.floor(size) || 1),
    track_total_hits: true,
    seq_no_primary_term: true,
  };
}

/** The body for a field's top values: the same question, no hits, one terms aggregation. */
export function valuesBody({ query = '', timeField = null, window = null, field } = {}) {
  return {
    query: { bool: { filter: filterClauses({ query, timeField, window }) } },
    size: 0,
    aggs: { top_values: { terms: { field, size: TOP_VALUES } } },
  };
}

/** What the agg answered: `[{value, count}]`, and how many documents sit outside the top. */
export function topValues(answer) {
  const a = answer && answer.aggregations && answer.aggregations.top_values;
  if (!a || !Array.isArray(a.buckets)) return { values: [], other: 0 };
  return {
    values: a.buckets.map((b) => ({ value: b.key_as_string !== undefined ? b.key_as_string : b.key, count: Number(b.doc_count) || 0 })),
    other: Number(a.sum_other_doc_count) || 0,
  };
}

const AGGREGATABLE = new Set(['keyword', 'long', 'integer', 'short', 'byte', 'double', 'float', 'half_float', 'scaled_float',
  'unsigned_long', 'date', 'date_nanos', 'boolean', 'ip', 'constant_keyword', 'wildcard']);

/**
 * The fields of `_mapping`'s answer, merged across every index in it and sorted by name:
 * `{ name, type, aggregatable, aggField }`. A text field with a `.keyword` sub-field is
 * aggregatable through it; one without is listed and not clickable. Object fields are
 * walked, their leaves named with dots; a field mapped two ways in two indices keeps the
 * first type seen and is marked `conflict`.
 */
export function fieldsFromMapping(mapping) {
  const out = new Map();
  const walk = (props, prefix) => {
    for (const [name, def] of Object.entries(props || {})) {
      if (!def || typeof def !== 'object') continue;
      const full = prefix ? `${prefix}.${name}` : name;
      if (def.properties && !def.type) { walk(def.properties, full); continue; }
      const type = def.type || (def.properties ? 'object' : 'unknown');
      const sub = def.fields && Object.entries(def.fields).find(([, f]) => f && f.type === 'keyword');
      const aggField = AGGREGATABLE.has(type) ? full : sub ? `${full}.${sub[0]}` : null;
      const have = out.get(full);
      if (have) { if (have.type !== type) have.conflict = true; continue; }
      out.set(full, { name: full, type, aggregatable: !!aggField, aggField });
      if (def.properties) walk(def.properties, full);
    }
  };
  for (const idx of Object.values(mapping || {})) {
    const m = idx && idx.mappings;
    if (!m) continue;
    walk(m.properties, '');
  }
  return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** `@timestamp` when it is a date, else the first date field by name, else null. */
export function timeFieldOf(fields) {
  const dates = fields.filter((f) => f.type === 'date' || f.type === 'date_nanos');
  const ts = dates.find((f) => f.name === '@timestamp');
  return ts ? ts.name : dates.length ? dates[0].name : null;
}

/**
 * The total as Elasticsearch reported it: the number when it counted (`eq`), "10,000+" when
 * it stopped at its limit (`gte`) — never a guess. `{ text, value, exact }`.
 */
export function totalLabel(total) {
  if (total == null) return { text: '?', value: 0, exact: false };
  const value = typeof total === 'number' ? total : Number(total.value) || 0;
  const exact = typeof total === 'number' || !total.relation || total.relation === 'eq';
  return { text: exact ? value.toLocaleString('en-US') : `${value.toLocaleString('en-US')}+`, value, exact };
}

/**
 * The pages that can be offered: `pages` counts the ones under MAX_RESULT_WINDOW, `capped`
 * says the result goes further than can be paged. Page numbers are 0-based.
 */
export function docPages(total, size) {
  const per = Math.max(1, Math.floor(size) || 1);
  const t = totalLabel(total);
  const reachable = Math.min(t.value, MAX_RESULT_WINDOW);
  const pages = Math.max(1, Math.ceil(reachable / per));
  return { pages, capped: t.value > MAX_RESULT_WINDOW || !t.exact, per };
}

/**
 * A time field's value as epoch ms: a number as it is (epoch_millis), a string parsed as a
 * date; NaN for anything else — the caller shows the raw value then, never a guessed time.
 */
export function timeMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim()) { const t = Date.parse(v); return Number.isNaN(t) && /^\d+$/.test(v.trim()) ? Number(v) : t; }
  return NaN;
}

/** One line of a `_source`, `k: v · k: v`, for the table's summary column. */
export function summaryOf(source, { skip = [], max = 160 } = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(source || {})) {
    if (skip.includes(k)) continue;
    const text = v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${text}`);
  }
  const line = parts.join(' · ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The query with `field:"value"` added (AND), or that term alone when the query was empty. */
export function addTerm(query, field, value) {
  const term = `${field}:"${String(value).replace(/(["\\])/g, '\\$1')}"`;
  const q = String(query || '').trim();
  if (!q) return term;
  if (q.split(/\s+/).includes(term)) return q;
  return `${q} AND ${term}`;
}

/**
 * The path of one document for an edit or a delete: the version read (`if_seq_no`,
 * `if_primary_term`) so a document changed since is refused (409) rather than overwritten,
 * and the routing when the hit carried one.
 */
export function docPath(hit) {
  const qs = [`if_seq_no=${encodeURIComponent(hit._seq_no)}`, `if_primary_term=${encodeURIComponent(hit._primary_term)}`];
  if (hit._routing) qs.push(`routing=${encodeURIComponent(hit._routing)}`);
  return `/${encodeURIComponent(hit._index)}/_doc/${encodeURIComponent(hit._id)}?${qs.join('&')}`;
}

/** The GET the REST console opens for a hit. */
export const docGetPath = (hit) => `/${encodeURIComponent(hit._index)}/_doc/${encodeURIComponent(hit._id)}`;

/** Pretty JSON, two spaces, the key order as given. */
export const pretty = (v) => JSON.stringify(v, null, 2);

/**
 * The editor's status for its text: `{ ok, error, value, changes }` — parsed, the parse
 * error's message, and how many lines differ from the original (lineDiff).
 */
export function editStatus(text, original) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'A document is a JSON object', value: null, changes: 0 };
    const changes = lineDiff(pretty(original), pretty(value)).filter((l) => l.kind !== 'same').length;
    return { ok: true, error: '', value, changes };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'Not valid JSON', value: null, changes: 0 };
  }
}

/**
 * A line diff of two texts: `[{ kind: 'same' | 'del' | 'add', text }]`, in order. The
 * longest common subsequence over lines; small inputs (a document), so the quadratic table
 * is fine.
 */
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n'), B = String(b ?? '').split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ kind: 'same', text: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ kind: 'del', text: A[i] }); i++; }
    else { out.push({ kind: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ kind: 'del', text: A[i++] });
  while (j < m) out.push({ kind: 'add', text: B[j++] });
  return out;
}

/** What a write answered, read the same way for an edit and a delete. */
export function writeOutcome(err) {
  const res = err && err.res;
  const status = res && Number(res.status);
  if (status === 409) return { conflict: true, message: 'Someone changed this document since you opened it — nothing was overwritten. Reload it.' };
  return { conflict: false, message: (err && err.message) || 'The cluster refused the request' };
}
