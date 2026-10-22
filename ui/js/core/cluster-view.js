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

/** A renamed column keeps at most this many characters: it is a header, not a note. */
export const MAX_NAME = 40;

const EMPTY = () => ({ v: 1, columns: { order: [], shown: {}, names: {} } });

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

/** Back to the default columns, order and names. */
export function resetColumns(prefs) {
  return withColumns(prefs, (c) => { c.order = []; c.shown = {}; c.names = {}; });
}
