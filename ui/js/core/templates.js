/**
 * Elasticsearch templates — index (composable), component and legacy — as plain data.
 *
 * No DOM and no requests here: the view in ui/templates-view.js asks the cluster and
 * draws; this module only reads what came back and answers questions about it. Kept
 * pure so the arithmetic that decides "which template wins" and "are these two clusters
 * running the same template" has exactly one definition, and so it can be tested without
 * a browser.
 *
 * Unknown is not zero: a cluster whose list could not be read is "unread", never
 * "missing". A template that is missing was looked for and is not there; one on an
 * unread cluster was never looked for.
 */

const enc = (n) => encodeURIComponent(String(n));

export const TEMPLATE_KINDS = {
  index: {
    label: 'Index templates', short: 'Index',
    list: '/_index_template', one: (n) => `/_index_template/${enc(n)}`,
  },
  component: {
    label: 'Component templates', short: 'Component',
    list: '/_component_template', one: (n) => `/_component_template/${enc(n)}`,
  },
  legacy: {
    label: 'Legacy templates', short: 'Legacy',
    list: '/_template', one: (n) => `/_template/${enc(n)}`,
  },
};

/* --------------------------------- shape ---------------------------------- */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v.map(String) : v == null || v === '' ? [] : [String(v)]);
const numOrNull = (v) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? null : Number(v));

/** Leaf settings, counted after flattening: {index:{number_of_shards:1}} is one. */
export function countSettings(settings) {
  if (!isObj(settings)) return 0;
  let n = 0;
  for (const v of Object.values(settings)) n += isObj(v) ? countSettings(v) : 1;
  return n;
}

/** Fields declared under `properties`, at every depth (object and nested fields included). */
export function countMappingFields(mappings) {
  if (!isObj(mappings)) return 0;
  const walk = (props) => {
    if (!isObj(props)) return 0;
    let n = 0;
    for (const f of Object.values(props)) {
      n += 1;
      if (isObj(f) && isObj(f.properties)) n += walk(f.properties);
    }
    return n;
  };
  return walk(mappings.properties);
}

/** Built in, or put there by a product rather than a person — `.`-prefixed or `_meta.managed`. */
export function isManaged(name, meta) {
  return String(name || '').startsWith('.') || !!(isObj(meta) && meta.managed === true);
}

function row(kind, name, body, extra) {
  const tpl = kind === 'legacy' ? body : (isObj(body.template) ? body.template : {});
  return {
    kind,
    name: String(name),
    patterns: [],
    priority: null,
    order: null,
    composedOf: [],
    version: numOrNull(body.version),
    dataStream: false,
    managed: isManaged(name, body._meta),
    body,
    settingsCount: countSettings(tpl.settings),
    mappingFieldCount: countMappingFields(tpl.mappings),
    ...extra,
  };
}

/** GET /_index_template → rows. */
export function normalizeIndexTemplates(json) {
  const list = (json && Array.isArray(json.index_templates)) ? json.index_templates : [];
  return list.filter((t) => t && t.name).map((t) => {
    const it = isObj(t.index_template) ? t.index_template : {};
    return row('index', t.name, it, {
      patterns: asList(it.index_patterns),
      priority: numOrNull(it.priority),
      composedOf: asList(it.composed_of),
      dataStream: it.data_stream !== undefined && it.data_stream !== null && it.data_stream !== false,
    });
  });
}

/** GET /_component_template → rows. */
export function normalizeComponentTemplates(json) {
  const list = (json && Array.isArray(json.component_templates)) ? json.component_templates : [];
  return list.filter((t) => t && t.name).map((t) =>
    row('component', t.name, isObj(t.component_template) ? t.component_template : {}, {}));
}

/** GET /_template → rows. The listing is keyed by name. */
export function normalizeLegacyTemplates(json) {
  if (!isObj(json)) return [];
  return Object.entries(json).filter(([, t]) => isObj(t)).map(([name, t]) =>
    row('legacy', name, t, { patterns: asList(t.index_patterns), order: numOrNull(t.order) }));
}

export function normalize(kind, json) {
  if (kind === 'index') return normalizeIndexTemplates(json);
  if (kind === 'component') return normalizeComponentTemplates(json);
  if (kind === 'legacy') return normalizeLegacyTemplates(json);
  throw new Error(`unknown template kind: ${kind}`);
}

/* ------------------------------- matching -------------------------------- */

const reCache = new Map();
/** Elasticsearch's simple wildcard: `*` is any run of characters, everything else literal. */
export function patternMatches(pattern, index) {
  const p = String(pattern);
  let re = reCache.get(p);
  if (!re) {
    re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    reCache.set(p, re);
  }
  return re.test(String(index));
}

/** Existing index names a template's patterns would apply to. */
export function matchingIndices(r, indexNames) {
  const pats = (r && r.patterns) || [];
  if (!pats.length) return [];
  return (indexNames || []).filter((n) => pats.some((p) => patternMatches(p, n)));
}

/**
 * Could some index name match both wildcard patterns? A memoised walk over the two
 * patterns, `*` on either side free to swallow the other side's next character.
 */
export function patternsOverlap(a, b) {
  a = String(a); b = String(b);
  const memo = new Map();
  const f = (i, j) => {
    const k = i * (b.length + 1) + j;
    if (memo.has(k)) return memo.get(k);
    let r;
    if (i === a.length && j === b.length) r = true;
    else if (i < a.length && a[i] === '*') r = f(i + 1, j) || (j < b.length && f(i, j + 1));
    else if (j < b.length && b[j] === '*') r = f(i, j + 1) || (i < a.length && f(i + 1, j));
    else r = i < a.length && j < b.length && a[i] === b[j] && f(i + 1, j + 1);
    memo.set(k, r);
    return r;
  };
  return f(0, 0);
}

const prio = (r) => (r.priority == null ? 0 : r.priority);

/**
 * The composable template Elasticsearch would use for a new index of this name: the
 * highest priority among those whose patterns match. Two at the same top priority is a
 * state Elasticsearch normally refuses to create, so it is reported rather than guessed.
 *
 * @returns {null | {template, priority, ambiguous, tiedWith: string[], candidates}}
 */
export function winningTemplate(indexName, indexTemplates) {
  const cands = (indexTemplates || [])
    .filter((r) => r.kind === 'index' && r.patterns.some((p) => patternMatches(p, indexName)))
    .sort((x, y) => prio(y) - prio(x) || x.name.localeCompare(y.name));
  if (!cands.length) return null;
  const top = prio(cands[0]);
  const tied = cands.filter((r) => prio(r) === top);
  return {
    template: cands[0],
    priority: top,
    ambiguous: tied.length > 1,
    tiedWith: tied.slice(1).map((r) => r.name),
    note: tied.length > 1 ? `ambiguous: ${tied.map((r) => r.name).join(', ')} share priority ${top}` : null,
    candidates: cands,
  };
}

/**
 * Pairs of composable templates with the same priority and patterns that can match the
 * same index. Elasticsearch refuses to store such a pair, so finding one before a PUT
 * turns a 400 into a sentence.
 */
export function overlaps(indexTemplates) {
  const list = (indexTemplates || []).filter((r) => r.kind === 'index');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.name === b.name || prio(a) !== prio(b)) continue;
      const pairs = [];
      for (const p of a.patterns) for (const q of b.patterns) if (patternsOverlap(p, q)) pairs.push([p, q]);
      if (pairs.length) out.push({ a: a.name, b: b.name, priority: prio(a), patterns: pairs });
    }
  }
  return out;
}

/* ------------------------------ comparison ------------------------------- */

/** Stable JSON: keys sorted at every depth, nothing dropped (version included). */
export function canonical(body) {
  const walk = (v) => {
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
  };
  return walk(body);
}

/** FNV-1a, 32 bits, as eight hex digits — short enough to show, enough to tell bodies apart. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function fingerprint(body) { return fnv1a(canonical(body)); }

/**
 * One row per (kind, name) across clusters.
 *
 * `byCluster` maps a cluster id to its rows, or to `{ error }` when the list could not be
 * read. A cluster that could not be read is in `unread`, not in `missingOn`, and its cell
 * is `undefined` rather than `null`.
 *
 * `reference` is the most common fingerprint (ties: the first cluster in order); `same`
 * is true only when every cluster that was read has the template with that fingerprint.
 */
export function compareAcross(byCluster) {
  const ids = Object.keys(byCluster || {});
  const unread = {};
  const read = [];
  for (const id of ids) {
    const v = byCluster[id];
    if (Array.isArray(v)) read.push(id);
    else unread[id] = (v && v.error) || 'not read';
  }
  const map = new Map();
  for (const id of read) {
    for (const r of byCluster[id]) {
      const key = `${r.kind}\u0000${r.name}`;
      let e = map.get(key);
      if (!e) { e = { kind: r.kind, name: r.name, managed: false, clusters: {}, rows: {} }; map.set(key, e); }
      e.clusters[id] = fingerprint(r.body);
      e.rows[id] = r;
      e.managed = e.managed || !!r.managed;
    }
  }
  const out = [];
  for (const e of map.values()) {
    const counts = new Map();
    for (const id of read) {
      const fp = e.clusters[id];
      if (fp) counts.set(fp, (counts.get(fp) || 0) + 1);
      else e.clusters[id] = null;
    }
    let reference = null, best = 0;
    for (const id of read) {
      const fp = e.clusters[id];
      if (fp && counts.get(fp) > best) { reference = fp; best = counts.get(fp); }
    }
    const missingOn = read.filter((id) => e.clusters[id] === null);
    out.push({
      ...e,
      reference,
      variants: counts.size,
      missingOn,
      differsOn: read.filter((id) => e.clusters[id] && e.clusters[id] !== reference),
      unread: { ...unread },
      same: counts.size === 1 && missingOn.length === 0,
    });
  }
  return out.sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name));
}

/** Which top-level (and `template.*`) keys differ between two bodies. For confirmations. */
export function changedKeys(before, after) {
  const b = isObj(before) ? before : {}, a = isObj(after) ? after : {};
  const out = [];
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    if (k === 'template' && isObj(b[k]) && isObj(a[k])) {
      for (const s of changedKeys(b[k], a[k])) out.push(`template.${s}`);
    } else if (canonical(b[k]) !== canonical(a[k])) out.push(k);
  }
  return out;
}

/* ------------------------------- validation ------------------------------ */

/** The built-in data-stream templates a user template can shadow, at their stock priority. */
export const BUILTIN_DATA_STREAM_PATTERNS = [
  { name: 'logs', pattern: 'logs-*-*', priority: 100 },
  { name: 'metrics', pattern: 'metrics-*-*', priority: 100 },
  { name: 'synthetics', pattern: 'synthetics-*-*', priority: 100 },
];

/** A name Elasticsearch will take in a path: non-empty, no spaces, commas, `#`, `*` or `/`. */
export function validateTemplateName(name) {
  const n = String(name || '').trim();
  if (!n) return 'Give the template a name.';
  if (/[\s,"*\\/<>|?#]/.test(n)) return 'A template name cannot contain spaces or any of , " * \\ / < > | ? #';
  if (n.startsWith('_') || n.startsWith('-') || n.startsWith('+')) return 'A template name cannot start with _, - or +.';
  if (n !== n.toLowerCase()) return 'Use lower case — Elasticsearch refuses upper-case template names.';
  return null;
}

/**
 * Parse and check what is in the editor. Errors stop a save; warnings are said and allowed.
 * @returns {{ok: boolean, body: object|null, problems: {level:'error'|'warn', text:string}[]}}
 */
export function validateTemplateBody(kind, text) {
  const problems = [];
  const err = (t) => problems.push({ level: 'error', text: t });
  const warn = (t) => problems.push({ level: 'warn', text: t });
  let body = null;
  try { body = JSON.parse(String(text == null ? '' : text)); }
  catch (e) { err(`Not valid JSON: ${e.message}`); return { ok: false, body: null, problems }; }
  if (!isObj(body)) { err('The body must be a JSON object.'); return { ok: false, body: null, problems }; }

  if (kind === 'index' || kind === 'legacy') {
    const pats = asList(body.index_patterns).filter((p) => p.trim());
    if (!pats.length) err('index_patterns is required and must name at least one pattern.');
    if (pats.some((p) => /\s/.test(p))) err('An index pattern cannot contain spaces.');
  }
  if (kind === 'index') {
    if (body.priority === undefined) warn('No priority set — Elasticsearch uses 0, which loses to almost every other template.');
    else if (!Number.isInteger(body.priority) || body.priority < 0) err('priority must be a whole number, 0 or more.');
    if (body.composed_of !== undefined && !Array.isArray(body.composed_of)) err('composed_of must be a list of component template names.');
    if (body.template !== undefined && !isObj(body.template)) err('template must be an object (settings, mappings, aliases).');
    if (body.order !== undefined) warn('order is a legacy-template field; composable index templates use priority.');
    const p = Number.isInteger(body.priority) ? body.priority : 0;
    for (const pat of asList(body.index_patterns)) {
      for (const b of BUILTIN_DATA_STREAM_PATTERNS) {
        if (!patternsOverlap(pat, b.pattern)) continue;
        if (p > b.priority) {
          warn(`"${pat}" at priority ${p} shadows the built-in "${b.name}" data-stream template (${b.pattern}, priority ${b.priority}) — matching data streams lose its mappings and lifecycle.`);
        } else if (p === b.priority) {
          warn(`"${pat}" at priority ${p} overlaps the built-in "${b.name}" template (${b.pattern}) at the same priority — Elasticsearch refuses that pair.`);
        }
      }
    }
  }
  if (kind === 'component') {
    if (!isObj(body.template)) err('A component template needs a template object (settings, mappings or aliases).');
    if (body.index_patterns !== undefined) err('A component template has no index_patterns — put those on the index template that uses it.');
  }
  if (kind === 'legacy') {
    if (body.order !== undefined && !Number.isInteger(body.order)) err('order must be a whole number.');
    warn('Legacy templates are deprecated in Elasticsearch 8 and lose to any matching composable index template.');
  }
  if (body.version !== undefined && !Number.isInteger(body.version)) err('version must be a whole number.');
  return { ok: !problems.some((x) => x.level === 'error'), body, problems };
}

/** A starting body for a new template of each kind. */
export function skeleton(kind) {
  if (kind === 'component') {
    return { template: { settings: { number_of_replicas: 1 }, mappings: { properties: {} } }, version: 1, _meta: { description: '' } };
  }
  if (kind === 'legacy') {
    return { index_patterns: ['example-*'], order: 0, settings: { number_of_replicas: 1 }, mappings: { properties: {} }, version: 1 };
  }
  return { index_patterns: ['example-*'], priority: 200, composed_of: [],
    template: { settings: { number_of_replicas: 1 }, mappings: { properties: {} }, aliases: {} }, version: 1, _meta: { description: '' } };
}

/* -------------------------------- requests -------------------------------- */

export function putRequest(kind, name, body) {
  return { method: 'PUT', path: TEMPLATE_KINDS[kind].one(name), body };
}
export function deleteRequest(kind, name) {
  return { method: 'DELETE', path: TEMPLATE_KINDS[kind].one(name) };
}
/**
 * What Elasticsearch would build for a new index of this name. Changes nothing — but it is
 * a POST, and the core's read-only allow-list (guard.rs READONLY_POST) does not name it, so
 * the caller has to send it through the write guard.
 */
export function simulateRequest(indexName) {
  return { method: 'POST', path: `/_index_template/_simulate_index/${enc(indexName)}` };
}

/** A plausible index name for simulating a pattern: the first existing match, else pattern + a date. */
export function exampleIndexName(r, indexNames, today = new Date()) {
  const hit = matchingIndices(r, indexNames)[0];
  if (hit) return hit;
  const p = ((r && r.patterns) || [])[0] || '';
  const d = `${today.getUTCFullYear()}.${String(today.getUTCMonth() + 1).padStart(2, '0')}.${String(today.getUTCDate()).padStart(2, '0')}`;
  return p.includes('*') ? p.replace(/\*+$/, '').replace(/\*/g, 'x') + d : p || `example-${d}`;
}
