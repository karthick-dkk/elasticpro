/**
 * The volume record's settings (`defaults.volume`), as pure arithmetic: the built-in values,
 * how config.txt's flat names fold into the nested object, the legacy `volumeFields`
 * conversion, per-cluster override diffing, validation, and the text of the two "same
 * settings elsewhere" cards. docs/VOLUME.md is the contract; this file is the UI's one
 * definition of it, so the Config page, core/config.js and the tests cannot drift apart.
 *
 * No DOM, no bridge: tools/unit/volume-config.test.mjs imports it bare.
 */

/** The built-in values (docs/VOLUME.md "Settings"). Copies are made with cloneVolume(). */
export const VOLUME_DEFAULTS = {
  indexFormat: 'logstash-*-YYYY.MM.DD',
  tag: ['tag1', 'labels.tag1', 'tags'],
  forwarder: ['fwd_tag', 'fwdtag', 'observer.name'],
  sourceHost: ['src_hostname', 'host.name'],
  sourceIp: ['src_ip', 'source.ip', 'host.ip'],
  eventSize: ['event_logsize'],
  subSize: ['sub_size'],
  extra: { name: 'Dataset', fields: ['event.dataset', 'log_type'] },
  sizeBasis: 'primary',
  topValues: 25,
  keepMonths: 13,
  collectAt: '06:00',
};

/** The rows with a list of fields, in table order. `ecs` is the hint column. */
export const FIELD_ROWS = [
  { key: 'tag',        label: 'Tag',           use: 'what the log is about', ecs: 'labels.* / tags' },
  { key: 'forwarder',  label: 'Forwarder tag', use: 'which forwarder sent it', ecs: 'observer.name' },
  { key: 'sourceHost', label: 'Source host',   use: 'the machine that wrote it', ecs: 'host.name' },
  { key: 'sourceIp',   label: 'Source IP',     use: 'its address', ecs: 'source.ip' },
  { key: 'eventSize',  label: 'Event size',    use: 'bytes of one event, summed', ecs: 'none in ECS' },
  { key: 'subSize',    label: 'Sub size',      use: 'bytes of the parsed part, summed', ecs: 'none in ECS' },
];

/**
 * Each setting's config.txt key and the name the core reports it under in PING
 * `managedDefaults`. `path` is where it lives in the nested object.
 */
export const VOLUME_KEYS = [
  { path: 'indexFormat',  managed: 'volumeIndexFormat',  env: 'UI_VOLUME_INDEX_FORMAT',     kind: 'text' },
  { path: 'tag',          managed: 'volumeTag',          env: 'UI_VOLUME_TAG_FIELDS',       kind: 'list' },
  { path: 'forwarder',    managed: 'volumeForwarder',    env: 'UI_VOLUME_FORWARDER_FIELDS', kind: 'list' },
  { path: 'sourceHost',   managed: 'volumeSourceHost',   env: 'UI_VOLUME_HOST_FIELDS',      kind: 'list' },
  { path: 'sourceIp',     managed: 'volumeSourceIp',     env: 'UI_VOLUME_IP_FIELDS',        kind: 'list' },
  { path: 'eventSize',    managed: 'volumeEventSize',    env: 'UI_VOLUME_EVENT_SIZE_FIELD', kind: 'list' },
  { path: 'subSize',      managed: 'volumeSubSize',      env: 'UI_VOLUME_SUB_SIZE_FIELD',   kind: 'list' },
  { path: 'extra.name',   managed: 'volumeExtraName',    env: 'UI_VOLUME_EXTRA_NAME',       kind: 'text' },
  { path: 'extra.fields', managed: 'volumeExtraFields',  env: 'UI_VOLUME_EXTRA_FIELDS',     kind: 'list' },
  { path: 'sizeBasis',    managed: 'volumeSizeBasis',    env: 'UI_VOLUME_SIZE_BASIS',       kind: 'enum' },
  { path: 'topValues',    managed: 'volumeTopValues',    env: 'UI_VOLUME_TOP_VALUES',       kind: 'int' },
  { path: 'keepMonths',   managed: 'volumeKeepMonths',   env: 'UI_VOLUME_KEEP_MONTHS',      kind: 'int' },
  { path: 'collectAt',    managed: 'volumeCollectAt',    env: 'UI_VOLUME_COLLECT_AT',       kind: 'text' },
];

export const SIZE_BASES = ['primary', 'total', 'eventSize'];
export const BOUNDS = { topValues: [5, 100], keepMonths: [1, 36] };

/** A field name: what Elasticsearch accepts in practice, no spaces, no commas. */
const FIELD_RE = /^[A-Za-z0-9_.@-]+$/;

export function cloneVolume(v = VOLUME_DEFAULTS) {
  return JSON.parse(JSON.stringify(v));
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** `a, b ,c` or a YAML list, as a clean array of non-empty strings. */
export function toList(v) {
  const a = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  return a.map((x) => String(x).trim()).filter(Boolean);
}

export const listText = (a) => toList(a).join(', ');

export function getPath(o, path) {
  return path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
}

export function setPath(o, path, v) {
  const parts = path.split('.');
  let cur = o;
  parts.slice(0, -1).forEach((k) => { if (!isObj(cur[k])) cur[k] = {}; cur = cur[k]; });
  cur[parts[parts.length - 1]] = v;
}

function coerce(kind, v) {
  if (kind === 'list') return toList(v);
  if (kind === 'int') return Number(v);
  return String(v);
}

/**
 * A partial volume object laid over a base, key by key (the list keys are replaced whole,
 * `extra` merges its name and its fields separately). A value of the wrong shape is ignored
 * rather than trusted: a hand-edited file must not break the page.
 */
export function mergeVolume(base, partial) {
  const out = cloneVolume(base);
  if (!isObj(partial)) return out;
  for (const k of VOLUME_KEYS) {
    const v = getPath(partial, k.path);
    if (v === undefined || v === null || v === '') continue;
    if (k.kind === 'list') { const l = toList(v); if (l.length) setPath(out, k.path, l); }
    else setPath(out, k.path, coerce(k.kind, v));
  }
  return out;
}

/**
 * Legacy `volumeFields` as a partial volume. Only rows that have a name get one: the rest
 * keep the built-in lists. docs/VOLUME.md "Legacy": tag1 to tag, fwd_tag/fwdtag to forwarder,
 * src_hostname to sourceHost, src_ip to sourceIp, anything else to the extra fields.
 */
export function legacyToVolume(fields) {
  const out = {};
  const push = (k, n) => { (out[k] = out[k] || []).push(n); };
  const rest = [];
  for (const n of toList(fields)) {
    if (n === 'tag1') push('tag', n);
    else if (n === 'fwd_tag' || n === 'fwdtag') push('forwarder', n);
    else if (n === 'src_hostname') push('sourceHost', n);
    else if (n === 'src_ip') push('sourceIp', n);
    else rest.push(n);
  }
  if (rest.length) out.extra = { fields: rest };
  return out;
}

/** True when a `volume` object states anything (`{}` or only `overrides` is not a setting). */
export function hasVolume(v) { return isObj(v) && Object.keys(v).some((k) => k !== 'overrides'); }

/**
 * What the file says the defaults are: its `volume` when it has one, else the legacy
 * `volumeFields` converted, else the built-ins. No config.txt in it (see foldManaged).
 */
export function fileVolume(rawDefaults) {
  const d = isObj(rawDefaults) ? rawDefaults : {};
  if (hasVolume(d.volume)) return mergeVolume(VOLUME_DEFAULTS, d.volume);
  if (d.volumeFields !== undefined && toList(d.volumeFields).length) return mergeVolume(VOLUME_DEFAULTS, legacyToVolume(d.volumeFields));
  return cloneVolume();
}

/**
 * config.txt's flat names laid over a nested volume, sub-key by sub-key. The shallow
 * `{...DEFAULTS, ...raw.defaults, ...managedDefaults()}` in config.js would replace the whole
 * object by one managed key. Returns the folded volume and the set of paths that are locked.
 */
export function foldManaged(volume, managedFlat) {
  const out = cloneVolume(volume);
  const locked = new Set();
  const m = isObj(managedFlat) ? managedFlat : {};
  for (const k of VOLUME_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(m, k.managed)) continue;
    locked.add(k.path);
    const v = m[k.managed];
    if (v === undefined || v === null || v === '') continue;
    setPath(out, k.path, coerce(k.kind, v));
  }
  return { volume: out, locked };
}

/** Everything the app uses: file (or legacy, or built-in), then config.txt on top. */
export function effectiveVolume(rawDefaults, managedFlat) {
  return foldManaged(fileVolume(rawDefaults), managedFlat).volume;
}

/** The cluster ids that carry an override in the file (`defaults.volume.overrides`). */
export function overrideIds(rawDefaults) {
  const o = rawDefaults && rawDefaults.volume && rawDefaults.volume.overrides;
  return isObj(o) ? Object.keys(o).filter((id) => isObj(o[id]) && Object.keys(o[id]).length) : [];
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The keys of `values` that differ from `defaults`, as a partial volume: what an override
 * saves. `locked` paths are skipped (config.txt wins everywhere). Equal, or empty, means inherit.
 */
export function diffOverride(values, defaults, locked = new Set()) {
  const out = {};
  for (const k of VOLUME_KEYS) {
    if (locked.has(k.path)) continue;
    const v = getPath(values, k.path);
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (!same(v, getPath(defaults, k.path))) setPath(out, k.path, v);
  }
  return out;
}

/** Messages for everything wrong with a (partial) volume object; empty means savable. */
export function validateVolume(v, { partial = false } = {}) {
  const bad = [];
  const has = (x) => x !== undefined && x !== null && x !== '';
  const fields = (label, list) => {
    const l = toList(list);
    if (!partial && !l.length) bad.push(`${label}: name at least one field.`);
    for (const n of l) if (!FIELD_RE.test(n)) bad.push(`${label}: "${n}" is not a field name (letters, digits, _ . @ -).`);
  };
  if (has(v.indexFormat) || !partial) {
    const f = String(v.indexFormat || '');
    if (!f.includes('*') || !f.includes('YYYY.MM.DD')) bad.push('Index name: must contain * and YYYY.MM.DD, for example logstash-*-YYYY.MM.DD.');
  }
  for (const r of FIELD_ROWS) if (has(getPath(v, r.key)) || !partial) fields(r.label, getPath(v, r.key));
  const ex = isObj(v.extra) ? v.extra : {};
  if (!partial && !String(ex.name || '').trim()) bad.push('Extra field: give it a name.');
  if (!partial || (ex.fields && toList(ex.fields).length)) fields('Extra field', ex.fields);
  if (has(v.sizeBasis) && !SIZE_BASES.includes(v.sizeBasis)) bad.push('Size that counts as volume: pick one of the three.');
  for (const [key, label] of [['topValues', 'Top values kept per field'], ['keepMonths', 'Keep the daily record for']]) {
    if (!has(v[key]) && partial) continue;
    const n = Number(v[key]); const [lo, hi] = BOUNDS[key];
    if (!Number.isInteger(n) || n < lo || n > hi) bad.push(`${label}: a whole number from ${lo} to ${hi}.`);
  }
  if (has(v.collectAt) || !partial) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v.collectAt || ''))) bad.push('Collect once a day at: use HH:MM, for example 06:00.');
  }
  return bad;
}

/**
 * The volume object to write to `defaults.volume`: the form's values for every key config.txt
 * does not manage; a managed key keeps whatever the file already holds (or is left out), so
 * config.txt's value is never copied into the file. `overrides` is carried over untouched.
 */
export function buildDefaultsToWrite(values, rawVolume, locked = new Set()) {
  const out = {};
  const old = isObj(rawVolume) ? rawVolume : {};
  for (const k of VOLUME_KEYS) {
    const from = locked.has(k.path) ? getPath(old, k.path) : getPath(values, k.path);
    if (from !== undefined && from !== null) setPath(out, k.path, from);
  }
  if (isObj(old.overrides) && Object.keys(old.overrides).length) out.overrides = old.overrides;
  return out;
}

/**
 * The file's `defaults` after saving the defaults mode: `volume` replaced, and the legacy
 * `volumeFields` dropped (its content is in `volume` now, VOLUME.md "Legacy"). Pure: returns
 * a new object.
 */
export function applyDefaults(rawDefaults, values, locked = new Set()) {
  const d = { ...(isObj(rawDefaults) ? rawDefaults : {}) };
  d.volume = buildDefaultsToWrite(values, d.volume, locked);
  delete d.volumeFields;
  return d;
}

/**
 * The file's `defaults` after saving an override for one cluster. Nothing different from
 * the defaults means no override at all; the last one gone takes `overrides` with it.
 * `defaults` are the values the override is measured against (file plus config.txt).
 */
export function applyOverride(rawDefaults, clusterId, values, defaults, locked = new Set()) {
  const d = { ...(isObj(rawDefaults) ? rawDefaults : {}) };
  // The defaults themselves are not touched by an override save, but a first save still
  // converts the legacy list, so the file never holds both.
  if (!hasVolume(d.volume) && d.volumeFields !== undefined) d.volume = buildDefaultsToWrite(fileVolume(d), d.volume, locked);
  delete d.volumeFields;
  const vol = { ...(isObj(d.volume) ? d.volume : {}) };
  const ov = { ...(isObj(vol.overrides) ? vol.overrides : {}) };
  const diff = diffOverride(values, defaults, locked);
  if (Object.keys(diff).length) ov[clusterId] = diff; else delete ov[clusterId];
  if (Object.keys(ov).length) vol.overrides = ov; else delete vol.overrides;
  if (Object.keys(vol).length) d.volume = vol; else delete d.volume;
  return d;
}

/* ------------------------------ the two info cards ------------------------------ */

const flow = (l) => `[ ${toList(l).join(', ')} ]`;

/** The settings as the clusters file holds them: a YAML block, no overrides. */
export function yamlBlock(v) {
  return [
    'defaults:',
    '  volume:',
    `    indexFormat: ${v.indexFormat}`,
    `    tag:         ${flow(v.tag)}`,
    `    forwarder:   ${flow(v.forwarder)}`,
    `    sourceHost:  ${flow(v.sourceHost)}`,
    `    sourceIp:    ${flow(v.sourceIp)}`,
    `    eventSize:   ${flow(v.eventSize)}`,
    `    subSize:     ${flow(v.subSize)}`,
    `    extra:       { name: ${v.extra.name}, fields: ${flow(v.extra.fields)} }`,
    `    sizeBasis:   ${v.sizeBasis}`,
    `    topValues:   ${v.topValues}`,
    `    keepMonths:  ${v.keepMonths}`,
    `    collectAt:   "${v.collectAt}"`,
  ].join('\n');
}

/** The same settings as config.txt lines (hosted). */
export function configTxtLines(v) {
  return VOLUME_KEYS.map((k) => {
    const x = getPath(v, k.path);
    return `${k.env}=${k.kind === 'list' ? toList(x).join(',') : x}`;
  }).join('\n');
}

/** A value for a read-only table cell: lists joined, objects compact, never "[object Object]". */
export function displayValue(v) {
  if (Array.isArray(v)) return v.map(displayValue).join(', ');
  if (isObj(v)) return Object.entries(v).map(([k, x]) => `${k}: ${displayValue(x)}`).join(' · ');
  return String(v);
}

/* ------------------------------ the check column ------------------------------ */

/**
 * One cell of the "On <cluster>" column from a VOLUME_FIELDS_CHECK row: `{ok, text}`.
 * An unresolved Event size says what it costs, because that is the one that blanks a figure.
 */
export function checkCell(key, row) {
  if (!row) return { ok: null, text: '' };
  if (row.resolved) return { ok: true, text: `${row.resolved}${row.type ? ` (${row.type})` : ''}` };
  if (key === 'eventSize') return { ok: false, text: 'not in mapping: Event bytes will read "not measured"' };
  return { ok: false, text: row.note ? `not in mapping: ${row.note}` : 'none of these in the mapping' };
}

/** The Index name row's cell from VOLUME_FIELDS_CHECK `indices`. */
export function indicesCell(indices) {
  const match = Number(indices && indices.match) || 0;
  const skipped = (indices && Array.isArray(indices.skipped)) ? indices.skipped : [];
  const names = skipped.slice(0, 2).join(', ') + (skipped.length > 2 ? `, +${skipped.length - 2} more` : '');
  const text = `${match} match${skipped.length ? ` · ${skipped.length} skipped (${names})` : ''}`;
  return { ok: match > 0, text };
}

/** Whether a reply is an older core not knowing the message at all. */
export function isUnknownType(res) {
  return !!res && res.ok === false && (res.kind === 'bad_message' || /unknown message/i.test(String(res.message || '')));
}
