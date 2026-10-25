/**
 * How one person likes the Clusters page laid out: which summary columns they see, in
 * what order and under what names. (It used to hold a fold for the unreachable section too;
 * that section is gone, and a stored `unreachable` key is ignored and dropped on the next save.)
 *
 * Pure: no DOM, no state. The storage is passed in, so the page hands it localStorage and
 * the unit tests hand it a Map. The core has no per-user preferences store (bridge.rs has
 * nothing of the kind), so this lives in the browser, keyed by the signed-in user — the
 * portable build, which has no accounts, uses one key for its single operator. Nothing in
 * it is a secret: column ids, column names somebody typed, cluster ids.
 */

/**
 * The summary's columns, in their default order. `id` is also the page's sort key, so a
 * column cannot exist without a way to sort it (tools/unit/cluster-view.test.mjs checks).
 * `fixed`: always shown and always first — the cluster's name is what a row IS. `hidden`:
 * off until somebody turns it on; JDK, Repository and the request count are read now and
 * then, and are also in each row's Details panel, so the default table fits a laptop.
 */
export const SUMMARY_COLUMNS = [
  { id: 'name', label: 'Cluster', fixed: true },
  { id: 'version', label: 'Version' },
  { id: 'jdk', label: 'JDK', hidden: true },
  { id: 'health', label: 'Health' },
  { id: 'nodes', label: 'Nodes', num: true },
  { id: 'size', label: 'Size', num: true },
  { id: 'disk', label: 'Disk usage' },
  { id: 'ilm', label: 'ILM' },
  { id: 'slm', label: 'SLM' },
  { id: 'repo', label: 'Repository', hidden: true },
  { id: 'snapshot', label: 'Last snapshot' },
  { id: 'alerts', label: 'Alerts', num: true },
  { id: 'reqs', label: 'Our reqs/5m', num: true, hidden: true },
];

/**
 * What an open row shows, in the same show/hide panel as the columns: the tiles across the
 * top, the two sections under them, and the columns of each section's table. One
 * choice for every cluster row. `fixed`: the name column of a table is the row.
 */
export const DETAIL_TILES = [
  { id: 'url', label: 'Cluster URL' },
  { id: 'jump', label: 'Jump host' },
  { id: 'ilm', label: 'ILM' },
  { id: 'slm', label: 'SLM' },
  { id: 'shards', label: 'Shard allocation' },
  { id: 'tasks', label: 'ES tasks' },
  { id: 'rate', label: 'Search / index rate' },
  { id: 'bucket', label: 'S3 log bucket' },
];
export const DETAIL_SECTIONS = [
  { id: 'repo', label: 'Repository/Snapshot section' },
  { id: 'nodes', label: 'Nodes section' },
];
export const REPO_COLUMNS = [
  { id: 'name', label: 'Repository', fixed: true },
  { id: 'type', label: 'Type' },
  { id: 'location', label: 'Location / bucket' },
  { id: 'policy', label: 'SLM policy' },
  { id: 'count', label: 'Snapshots', num: true },
  { id: 'oldest', label: 'Oldest' },
  { id: 'newest', label: 'Newest' },
  { id: 'status', label: 'Last snapshot status' },
  { id: 'size', label: 'Size' },
  { id: 'actions', label: 'Actions' },
];
export const NODE_COLUMNS = [
  { id: 'name', label: 'Node', fixed: true },
  { id: 'ip', label: 'IP' },
  { id: 'id', label: 'Node ID', hidden: true },
  { id: 'tier', label: 'Tier' },
  { id: 'roles', label: 'Roles' },
  { id: 'version', label: 'Version' },
  { id: 'jdk', label: 'JDK' },
  { id: 'cpu', label: 'CPU', num: true },
  { id: 'heap', label: 'Heap', num: true },
  { id: 'disk', label: 'Disk', num: true },
  { id: 'load', label: 'Load 1m', num: true },
  { id: 'shards', label: 'Shards', num: true },
  { id: 'uptime', label: 'Uptime' },
  { id: 'legend', label: 'Role legend' },
];
/** The groups the panel offers, keyed the way the stored preferences are. */
export const DETAIL_GROUPS = { tiles: DETAIL_TILES, sections: DETAIL_SECTIONS, repo: REPO_COLUMNS, nodes: NODE_COLUMNS };

/** A renamed column keeps at most this many characters: it is a header, not a note. */
export const MAX_NAME = 40;

const EMPTY = () => ({ v: 1, columns: { order: [], shown: {}, names: {} },
  details: { tiles: {}, sections: {}, repo: {}, nodes: {} }, expand: false });

/** What was stored, made safe to use: wrong types dropped, nothing assumed. */
export function sanitizePrefs(raw) {
  const out = EMPTY();
  if (!raw || typeof raw !== 'object') return out;
  const c = raw.columns && typeof raw.columns === 'object' ? raw.columns : {};
  if (Array.isArray(c.order)) out.columns.order = [...new Set(c.order.filter((x) => typeof x === 'string'))];
  if (c.shown && typeof c.shown === 'object') {
    for (const [k, v] of Object.entries(c.shown)) if (typeof v === 'boolean') out.columns.shown[k] = v;
  }
  if (c.names && typeof c.names === 'object') {
    for (const [k, v] of Object.entries(c.names)) {
      const n = typeof v === 'string' ? v.trim().slice(0, MAX_NAME) : '';
      if (n) out.columns.names[k] = n;
    }
  }
  const d = raw.details && typeof raw.details === 'object' ? raw.details : {};
  for (const g of Object.keys(DETAIL_GROUPS)) {
    if (!d[g] || typeof d[g] !== 'object') continue;
    for (const [k, v] of Object.entries(d[g])) if (typeof v === 'boolean') out.details[g][k] = v;
  }
  out.expand = raw.expand === true;
  return out;
}

/** The storage key: one per signed-in user, case-insensitive like the account names. */
export function prefsKey(user) {
  return `elasticpro.clusters.view.${String(user || 'local').toLowerCase()}`;
}

/** Read this user's preferences; a missing, unreadable or blocked store gives the defaults. */
export function readPrefs(storage, user) {
  try {
    const s = storage && storage.getItem(prefsKey(user));
    return sanitizePrefs(s ? JSON.parse(s) : null);
  } catch (_) {
    return EMPTY();
  }
}

/** Save them. False when the browser would not (a private window, storage full or off). */
export function writePrefs(storage, user, prefs) {
  try {
    if (!storage) return false;
    storage.setItem(prefsKey(user), JSON.stringify(sanitizePrefs(prefs)));
    return true;
  } catch (_) {
    return false;
  }
}

/* --------------------------------- columns --------------------------------- */

/**
 * The columns as this person has them: [{ id, label, name, visible, fixed, num, renamed }],
 * in display order. Stored ids this version does not have are ignored; columns a newer
 * version added, which the stored order has never heard of, appear at their default place
 * (after the default column before them) with their default visibility.
 */
export function resolveColumns(prefs, defs = SUMMARY_COLUMNS) {
  const c = sanitizePrefs(prefs).columns;
  const known = new Map(defs.map((d) => [d.id, d]));
  const order = c.order.filter((id) => known.has(id) && !known.get(id).fixed);
  defs.forEach((d, i) => {
    if (d.fixed || order.includes(d.id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(defs[j].id);
      if (k >= 0) { at = k + 1; break; }
    }
    order.splice(at, 0, d.id);
  });
  return [...defs.filter((d) => d.fixed), ...order.map((id) => known.get(id))].map((d) => {
    const own = c.names[d.id];
    return {
      id: d.id, label: d.label, name: own || d.label, renamed: !!own,
      visible: d.fixed ? true : (typeof c.shown[d.id] === 'boolean' ? c.shown[d.id] : !d.hidden),
      fixed: !!d.fixed, num: !!d.num,
    };
  });
}

/** Only the ones on screen, in order. */
export function visibleColumns(prefs, defs = SUMMARY_COLUMNS) {
  return resolveColumns(prefs, defs).filter((c) => c.visible);
}

const withColumns = (prefs, fn) => {
  const p = sanitizePrefs(prefs);
  fn(p.columns);
  return p;
};

/** Show or hide one column. The fixed column cannot be hidden. */
export function setColumnShown(prefs, id, on, defs = SUMMARY_COLUMNS) {
  const d = defs.find((x) => x.id === id);
  if (!d || d.fixed) return sanitizePrefs(prefs);
  return withColumns(prefs, (c) => { c.shown[id] = !!on; });
}

/** Move one column to position `to` among the movable ones (the fixed column stays first). */
export function moveColumn(prefs, id, to, defs = SUMMARY_COLUMNS) {
  const movable = resolveColumns(prefs, defs).filter((c) => !c.fixed).map((c) => c.id);
  const from = movable.indexOf(id);
  if (from < 0) return sanitizePrefs(prefs);
  movable.splice(from, 1);
  movable.splice(Math.max(0, Math.min(movable.length, to)), 0, id);
  return withColumns(prefs, (c) => { c.order = movable; });
}

/** One step up (-1) or down (+1): what the keyboard does instead of dragging. */
export function moveColumnBy(prefs, id, delta, defs = SUMMARY_COLUMNS) {
  const movable = resolveColumns(prefs, defs).filter((c) => !c.fixed).map((c) => c.id);
  const from = movable.indexOf(id);
  if (from < 0) return sanitizePrefs(prefs);
  return moveColumn(prefs, id, from + delta, defs);
}

/** Rename one column. Empty, or the default name typed back, means the default name. */
export function renameColumn(prefs, id, name, defs = SUMMARY_COLUMNS) {
  const d = defs.find((x) => x.id === id);
  if (!d) return sanitizePrefs(prefs);
  const n = String(name ?? '').trim().slice(0, MAX_NAME);
  return withColumns(prefs, (c) => {
    if (!n || n === d.label) delete c.names[id];
    else c.names[id] = n;
  });
}

/** Back to the default columns, order and names — and the default row details. */
export function resetColumns(prefs) {
  const p = withColumns(prefs, (c) => { c.order = []; c.shown = {}; c.names = {}; });
  p.details = EMPTY().details;
  p.expand = false;
  return p;
}

/* ------------------------------ the open row ------------------------------ */

/**
 * One group of the open row (`tiles`, `sections`, `repo` or `nodes`) as this person has
 * it: [{ id, label, visible, fixed, num }], in the definition's order.
 */
export function detailItems(prefs, group) {
  const defs = DETAIL_GROUPS[group] || [];
  const shown = sanitizePrefs(prefs).details[group] || {};
  return defs.map((d) => ({
    id: d.id, label: d.label, fixed: !!d.fixed, num: !!d.num,
    visible: d.fixed ? true : (typeof shown[d.id] === 'boolean' ? shown[d.id] : !d.hidden),
  }));
}

/** Only the ones on screen. */
export function detailShown(prefs, group) {
  return detailItems(prefs, group).filter((x) => x.visible);
}

/** Show or hide one tile, section or column of the open row. A fixed one stays. */
export function setDetailShown(prefs, group, id, on) {
  const d = (DETAIL_GROUPS[group] || []).find((x) => x.id === id);
  const p = sanitizePrefs(prefs);
  if (!d || d.fixed) return p;
  p.details[group][id] = !!on;
  return p;
}

/** Whether every cluster row opens expanded when the page is drawn. */
export function expandByDefault(prefs) {
  return sanitizePrefs(prefs).expand;
}

export function setExpandByDefault(prefs, on) {
  const p = sanitizePrefs(prefs);
  p.expand = !!on;
  return p;
}
