/** Minimal IndexedDB helper. Stores the config FILE HANDLE, query history, alert
 *  acknowledgements and notes, and UI settings.
 *  It never stores credentials — the config file on disk stays the only place they live. */

const DB_NAME = 'elasticpro';
const DB_VERSION = 3;
const STORES = { handles: 'handles', queries: 'queries', kv: 'kv', acks: 'acks', repoSize: 'repoSize' };

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.handles)) db.createObjectStore(STORES.handles);
      if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv);
      if (!db.objectStoreNames.contains(STORES.queries)) {
        const s = db.createObjectStore(STORES.queries, { keyPath: 'id' });
        s.createIndex('ts', 'ts');
        s.createIndex('fav', 'fav');
      }
      // v2: acknowledgements and operator notes against an alert key
      if (!db.objectStoreNames.contains(STORES.acks)) db.createObjectStore(STORES.acks, { keyPath: 'key' });
      // v3: measured snapshot repository bytes, one row per (cluster, repo, snapshot) —
      // see repoSizeCache() below.
      if (!db.objectStoreNames.contains(STORES.repoSize)) {
        const s = db.createObjectStore(STORES.repoSize, { keyPath: 'id' });
        s.createIndex('clusterId', 'clusterId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const os = t.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const idb = {
  getHandle: (k = 'config') => tx(STORES.handles, 'readonly', (os) => os.get(k)),
  setHandle: (h, k = 'config') => tx(STORES.handles, 'readwrite', (os) => os.put(h, k)),
  delHandle: (k = 'config') => tx(STORES.handles, 'readwrite', (os) => os.delete(k)),

  getKV: (k) => tx(STORES.kv, 'readonly', (os) => os.get(k)),
  setKV: (k, v) => tx(STORES.kv, 'readwrite', (os) => os.put(v, k)),

  getAck: (k) => tx(STORES.acks, 'readonly', (os) => os.get(k)),
  putAck: (a) => tx(STORES.acks, 'readwrite', (os) => os.put(a)),
  delAck: (k) => tx(STORES.acks, 'readwrite', (os) => os.delete(k)),
  allAcks: () => tx(STORES.acks, 'readonly', (os) => os.getAll()),

  putQuery: (q) => tx(STORES.queries, 'readwrite', (os) => os.put(q)),
  delQuery: (id) => tx(STORES.queries, 'readwrite', (os) => os.delete(id)),
  allQueries: () => tx(STORES.queries, 'readonly', (os) => os.getAll()),
  clearQueries: () => tx(STORES.queries, 'readwrite', (os) => os.clear()),
};

/**
 * Which of a repo-size cache's entries are safe to write to disk.
 *
 * Separated from the IndexedDB plumbing below so it can be asserted on directly: a
 * snapshot never changes size once it is done, so its bytes are worth remembering, but an
 * IN_PROGRESS one is still growing and a cached figure for it would go stale the moment it
 * is written. `loadedKeys` is what came FROM disk this run — writing those back is
 * harmless but pointless, so they are skipped too.
 *
 * `map` holds every entry measureRepoBytes (core/volume.js) has touched, keyed exactly the
 * way it keys its cache: `${repoName}/${snapshotId}`.
 */
export function persistableEntries(map, loadedKeys, statusOf) {
  const writes = [];
  for (const [id, bytes] of map) {
    if (loadedKeys && loadedKeys.has(id)) continue;
    if (statusOf && statusOf(id) === 'IN_PROGRESS') continue;
    writes.push({ repoSnap: id, bytes });
  }
  return writes;
}

/**
 * A repository-size cache backed by IndexedDB, scoped to one cluster.
 *
 * measureRepoBytes (core/volume.js) takes a plain `Map` for its `cache` option and reads
 * and writes it synchronously while it runs — it does not know or care that the entries
 * came from disk. So this preloads a real Map from IndexedDB (async, once, up front) and
 * hands that Map straight to measureRepoBytes; `flush()` is called afterwards to persist
 * whatever got added, gated through `persistableEntries` above.
 *
 * Best-effort throughout: IndexedDB can be unavailable (private browsing, storage
 * disabled), and a failed read or write here costs one repeated measurement next time —
 * never a wrong figure, since the cache is only ever a shortcut past calling
 * `cl.snapshotStatus` again.
 */
export function repoSizeCache(clusterId) {
  const map = new Map();
  const loadedKeys = new Set();
  const ready = tx(STORES.repoSize, 'readonly', (os) => os.index('clusterId').getAll(IDBKeyRange.only(clusterId)))
    .then((rows) => {
      for (const r of rows || []) { map.set(r.repoSnap, r.bytes); loadedKeys.add(r.repoSnap); }
    })
    .catch(() => { /* no IndexedDB, or the store is not there yet — start empty */ });
  return {
    ready,
    map,
    /** Persist whatever `map` gained since `ready` resolved, for snapshots that are done. */
    async flush(statusOf) {
      const writes = persistableEntries(map, loadedKeys, statusOf);
      if (!writes.length) return;
      try {
        await tx(STORES.repoSize, 'readwrite', (os) => {
          for (const w of writes) os.put({ id: `${clusterId}::${w.repoSnap}`, clusterId, repoSnap: w.repoSnap, bytes: w.bytes });
        });
        for (const w of writes) loadedKeys.add(w.repoSnap);
      } catch (_) { /* best-effort; see the doc comment above */ }
    },
  };
}
