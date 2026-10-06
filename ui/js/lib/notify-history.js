/**
 * The bell's history, when the core keeps a copy.
 *
 * Pure: no DOM, no network. `ui/menu.js` owns the bell and calls these; `app.js` decides
 * whether there is a store to talk to (PING says `notifyStore: true`). Without one the
 * bell is exactly what it was — local, last 50 — so nothing here may be required.
 */

/** Characters the core accepts in an id, and its length limit. */
const ID_OK = /[^A-Za-z0-9._:-]/g;
const ID_MAX = 128;

/** The id a local entry is stored under on the core: its key, else the id it was given. */
export function serverId(entry) {
  const raw = String((entry && (entry.key || entry.id)) || '');
  const id = raw.replace(ID_OK, '_').slice(0, ID_MAX);
  return id || null;
}

/** A fresh id for a notice that has no key, so the core and this browser agree on it. */
export function newId(at = Date.now()) {
  return `n-${at}-${Math.random().toString(16).slice(2, 10)}`;
}

/** A local history entry as the NOTIFY_PUT it becomes. */
export function toPut(entry) {
  const msg = { type: 'NOTIFY_PUT', id: serverId(entry), message: String(entry.message || '').slice(0, 2000),
    kind: entry.kind, at: entry.at, detail: (entry.detail || []).slice(0, 40).map(String), meta: entry.meta || '' };
  if (entry.cluster) msg.cluster = String(entry.cluster);
  return msg;
}

/** A record NOTIFY_LIST returned, as a local history entry. */
export function fromServer(rec, read = true) {
  return {
    message: String(rec.message || ''), kind: rec.kind, at: Number(rec.at) || 0, key: rec.id, id: rec.id, read,
    detail: rec.detail && rec.detail.length ? rec.detail.slice() : undefined,
    meta: rec.meta || undefined, cluster: rec.cluster || undefined, server: true,
  };
}

/**
 * Local entries and server records, one per key/id, newest first.
 *
 * The same key on both sides is one notice and the server's copy wins — it is the one
 * another tab or another browser may have finished — except that having been read here
 * stays read. A server record with no local twin arrives read: it is history, and the
 * bell's count is for what happened in front of you since you last looked.
 */
export function mergeNotifications(local, server) {
  const byId = new Map();
  const out = [];
  for (const e of local || []) {
    const id = serverId(e);
    if (id && byId.has(id)) continue;
    const copy = { ...e };
    if (id) byId.set(id, copy);
    out.push(copy);
  }
  for (const r of server || []) {
    if (!r || !r.id) continue;
    const mine = byId.get(r.id);
    if (mine) {
      Object.assign(mine, fromServer(r, !!mine.read), { key: mine.key || r.id });
      if (!r.detail || !r.detail.length) delete mine.detail;
      if (!r.meta) delete mine.meta;
    } else {
      const e = fromServer(r, true);
      byId.set(r.id, e);
      out.push(e);
    }
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * Whether a notice should go to the core now.
 *
 * Every notice that shows, yes. A task's progress ticks, only when the kind changes — a
 * tick every three seconds for half an hour is six hundred writes of the same fact.
 * `remember` is the notice the person saw; `touch` a tick. Returns a function
 * `(key, kind, isTick) => boolean` that remembers what it last let through per key.
 */
export function sendRule(max = 500) {
  const last = new Map();
  return (key, kind, isTick = false) => {
    if (!key) return !isTick;
    const prev = last.get(key);
    if (isTick && prev === kind) return false;
    last.delete(key);
    last.set(key, kind);
    if (last.size > max) last.delete(last.keys().next().value);
    return true;
  };
}
