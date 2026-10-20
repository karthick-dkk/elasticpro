/**
 * What ElasticPro itself has seen of each alert: when it started, when it cleared.
 *
 * An alert is a live reading (core/state.js alerts()) — it carries no start time, and the
 * moment it clears it is gone. Two things on this page need a time anyway: how long an
 * alert has been open, and "has this happened before on this cluster". Neither can be
 * answered from the clusters, which keep no record of what ElasticPro raised, and the
 * bell's history (core/notify.rs, 30 days) stores sentences, not rules and not when a
 * condition ended. So this keeps its own small log of *episodes* — one per merged alert
 * (cluster + rule, see alert-groups.js), opened the first time it is seen and closed once
 * it has been gone for a few minutes.
 *
 * It is a log of what THIS browser saw while the app was open, and says so: an episode
 * first seen on the first pass after the page opened is `approx` (it may have started
 * earlier), one whose end was found long after it was last seen is `unsure`, and `since()`
 * says how far back the log goes. Absence of history is "no history yet", never "0 times".
 *
 * Pure but for the storage handed in — the tests give it a Map, the app gives it
 * localStorage. Retention matches the bell's (30 days).
 */

export const RETENTION_DAYS = 30;
const DAY_MS = 86400000;
/** Gone this long and the episode is over. Longer than a refresh or two, so a blip is not an end. */
export const CLOSE_AFTER_MS = 3 * 60000;
/** An end found more than this long after the last sighting is a guess: the app was closed. */
export const EXACT_END_MS = 10 * 60000;
/** Most closed episodes kept, however recent. */
export const MAX_CLOSED = 600;
/** Most items remembered per open episode. */
const MAX_ITEMS = 200;

const STORE_KEY = 'elasticpro.alert-history';

function blank(now) { return { v: 1, since: now, open: {}, closed: [] }; }

/** localStorage, or nothing: a private window or a snapshot render simply keeps no log. */
function browserStorage() {
  return {
    get() { try { return globalThis.localStorage.getItem(STORE_KEY); } catch (_) { return null; } },
    set(s) { try { globalThis.localStorage.setItem(STORE_KEY, s); } catch (_) { /* memory only */ } },
  };
}

/**
 * @param {{ storage?: {get():string|null, set(s:string):void}, retentionDays?: number }} opts
 */
export function createHistory({ storage = browserStorage(), retentionDays = RETENTION_DAYS } = {}) {
  let st = null;
  let passes = 0;

  function load(now) {
    if (st) return st;
    try {
      const raw = storage.get();
      const v = raw ? JSON.parse(raw) : null;
      st = v && v.v === 1 && v.open && Array.isArray(v.closed) ? v : blank(now);
    } catch (_) { st = blank(now); }
    return st;
  }
  const save = () => { try { storage.set(JSON.stringify(st)); } catch (_) { /* ignore */ } };

  function prune(now) {
    const cut = now - retentionDays * DAY_MS;
    st.closed = st.closed.filter((e) => e.end >= cut).slice(-MAX_CLOSED);
  }

  /**
   * Record one pass over the merged alerts.
   * @param {Array<{key:string, clusterId:string, rule:string, level:string, startHint?:number,
   *                items:Array<{id:string, label?:string}>}>} merged
   * @returns {number} how many episodes this pass opened — the caller's cue to rebuild anything
   *                   that was built from first-seen times
   */
  function observe(merged, now = Date.now()) {
    load(now);
    const first = passes === 0;
    passes++;
    const live = new Set();
    let created = 0;
    for (const m of merged || []) {
      live.add(m.key);
      let ep = st.open[m.key];
      if (!ep) {
        created++;
        ep = { clusterId: m.clusterId, rule: m.rule, start: now, last: now, level: m.level, items: {}, approx: first };
        st.open[m.key] = ep;
      }
      ep.last = now;
      ep.level = m.level === 'critical' || ep.level === 'critical' ? 'critical' : 'warning';
      // A time the alert itself knows (a snapshot failing since…) beats the first sighting.
      if (Number.isFinite(m.startHint) && m.startHint > 0 && m.startHint < ep.start) { ep.start = m.startHint; ep.approx = false; }
      for (const it of m.items || []) {
        const cur = ep.items[it.id];
        if (cur) cur.last = now;
        else if (Object.keys(ep.items).length < MAX_ITEMS) ep.items[it.id] = { first: now, last: now, approx: first };
      }
      // An item that stopped being listed is forgotten after a while, so a node that
      // recovered and later crossed again counts as new rather than old.
      for (const [id, v] of Object.entries(ep.items)) if (now - v.last >= CLOSE_AFTER_MS) delete ep.items[id];
    }
    for (const [key, ep] of Object.entries(st.open)) {
      if (live.has(key) || now - ep.last < CLOSE_AFTER_MS) continue;
      st.closed.push({ key, clusterId: ep.clusterId, rule: ep.rule, start: ep.start, end: ep.last, level: ep.level,
        approx: !!ep.approx, unsure: now - ep.last > EXACT_END_MS, items: Object.keys(ep.items).length });
      delete st.open[key];
    }
    prune(now);
    save();
    return created;
  }

  return {
    observe,
    /** When this alert's current episode started (ms), or null if it is not open. */
    startOf(key) { load(Date.now()); const e = st.open[key]; return e ? e.start : null; },
    /** Whether that start is a first sighting at page open rather than a known time. */
    approxStart(key) { load(Date.now()); const e = st.open[key]; return !!(e && e.approx); },
    /** When this item (by id) was first seen in the open episode of `key`. */
    itemFirstSeen(key, id) { load(Date.now()); const e = st.open[key]; const i = e && e.items[id]; return i ? i.first : null; },
    /** Closed episodes of `key` within retention, newest first. */
    episodes(key, now = Date.now()) {
      load(now);
      const cut = now - retentionDays * DAY_MS;
      return st.closed.filter((e) => e.key === key && e.end >= cut).sort((a, b) => b.start - a.start);
    },
    /** Open episodes' starts for a cluster, by merged key — what "related alerts" orders by. */
    openStarts(clusterId) {
      load(Date.now());
      const out = {};
      for (const [k, e] of Object.entries(st.open)) if (e.clusterId === clusterId) out[k] = e.start;
      return out;
    },
    /** When the log began: nothing earlier than this was seen, so nothing earlier is "history". */
    since() { return load(Date.now()).since; },
    retentionDays,
    /** Forget everything (tests; a changed fleet). */
    reset(now = Date.now()) { st = blank(now); passes = 0; save(); },
  };
}

/** The log this app keeps. */
export const alertHistory = createHistory();
