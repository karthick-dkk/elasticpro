/**
 * The page-side alert reporter: the core evaluates no alert, so the alerts record (Data ›
 * Backend, when alerts are not kept built-in only) learns what was raised and cleared from
 * the page that saw it — ALERT_EVENTS_PUT (docs/HANDBOOK.md "Backend — the message contract").
 *
 * This file is the pure half: transitions between two passes, batching, and the reporter's
 * state machine with every effect (send, clock, storage) passed in. app.js wires it to the
 * refresh loop. Nothing here touches the DOM.
 *
 *  - Only transitions are reported: `raised` when a key appears, `cleared` when it has been
 *    gone for GRACE_PASSES passes in a row (one failed refresh is not a recovery).
 *  - The first pass of a session reports nothing: what was already true is a state, not an
 *    event, and its start is unknown. (A reload in the same session compares against the set
 *    last seen, remembered in sessionStorage, so a reload storm repeats nothing.)
 *  - At most BATCH events per message; the core's limit is 200 per account per 15 minutes,
 *    so a flush is at most once per FLUSH_MS, and `too_many` stops the reporter for good.
 */

import { ruleForKey } from './alert-rules.js';

export const BATCH = 200;
export const FLUSH_MS = 20000;
export const GRACE_PASSES = 2;
/** After the core says alerts are kept built-in (`routed: false`) nothing is sent for this long. */
export const UNROUTED_PAUSE_MS = 10 * 60000;
/** The core's quota window: 200 events per account per 15 minutes. `too_many` pauses for it. */
export const ALERT_EVENTS_WINDOW_MS = 15 * 60000;
export const LEASE_MS = 45000;
const LEASE_KEY = 'ep.alertEvents.lease';
const STORE_KEY = 'ep.alertEvents.seen';

/** A key the core will accept: `<clusterId>:<rule>[:<instance>]` with a rule the pages know (or Play's node-left). */
export function reportable(key) {
  const parts = String(key || '').split(':');
  if (parts.length < 2 || !parts[0]) return false;
  return !!ruleForKey(key) || parts[1] === 'node-left';
}

/** The keys to track out of merged alerts (core/alert-groups.js): open and held ones, reportable only. */
export function keysOf(merged) {
  const out = new Set();
  for (const m of merged || []) {
    if (!m || (m.state !== 'open' && !m.held)) continue;
    for (const k of m.keys || [m.key]) if (reportable(k)) out.add(k);
  }
  return out;
}

/** The cluster a key belongs to. */
export const clusterOfKey = (key) => String(key || '').split(':')[0];
const ruleOfKey = (key) => String(key || '').split(':')[1] || '';

/**
 * One pass against the last. `seen` is a Map(key → passes absent) or null before the first
 * pass. `status(clusterId)` says what is known of the cluster now: 'up' (answered; its alerts
 * were evaluated), 'down' (unreachable: only its `unreachable` key is evaluated, the rest are
 * held or aged out), 'unknown' (not read yet, or being rebuilt) or anything else / undefined
 * (no longer configured, disabled or out of this person's scope).
 *
 * A key that merely stopped being evaluated is not a cleared alert: keys of a down or unknown
 * cluster are carried forward untouched, and keys of a cluster that is gone are dropped
 * silently (no `cleared`). Returns the events and the next `seen`.
 */
export function transitions(seen, keys, { grace = GRACE_PASSES, levelOf = () => undefined, at = Date.now(), status = () => 'up' } = {}) {
  const now = new Map([...keys].map((k) => [k, 0]));
  if (seen === null) return { events: [], seen: now };
  const events = [];
  for (const k of keys) if (!seen.has(k)) events.push(mk('raised', k, levelOf(k), at));
  for (const [k, gone] of seen) {
    if (keys.has(k)) continue;
    const st = status(clusterOfKey(k));
    if (st === 'unknown' || (st === 'down' && ruleOfKey(k) !== 'unreachable')) { now.set(k, gone); continue; }
    if (st !== 'up' && st !== 'down') continue;                // gone or out of scope: forgotten, not cleared
    if (gone + 1 >= grace) events.push(mk('cleared', k, levelOf(k), at));
    else now.set(k, gone + 1);
  }
  return { events, seen: now };
}

function mk(event, key, level, at) {
  const e = { event, key, at };
  if (level) e.level = level;
  return e;
}

/** Messages of at most `size` events, in order. */
export function batches(events, size = BATCH) {
  const out = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}

/** An event queued for a key that the next transition cancels out (raised then cleared before a flush) is dropped both ways. */
export function coalesce(queue) {
  const last = new Map();
  for (const e of queue) {
    const prev = last.get(e.key);
    if (prev && prev.event !== e.event) last.delete(e.key);
    else last.set(e.key, e);
  }
  return [...last.values()];
}

/**
 * One reporting tab per browser: every tab sharing the account would otherwise spend the same
 * 200-per-15-minutes quota. A lease in localStorage `{id, until}`; the holder renews it on
 * every pass, anyone may take it once it has expired. `storage` is a localStorage-shaped
 * object; with none, every tab reports (the single-tab case).
 */
export function createLease({ storage = null, id = Math.random().toString(36).slice(2), now = () => Date.now(), ttl = LEASE_MS } = {}) {
  return {
    id,
    acquire() {
      if (!storage) return true;
      try {
        const cur = JSON.parse(storage.getItem(LEASE_KEY) || 'null');
        if (cur && cur.id !== id && cur.until > now()) return false;
        storage.setItem(LEASE_KEY, JSON.stringify({ id, until: now() + ttl }));
        const back = JSON.parse(storage.getItem(LEASE_KEY) || 'null');
        return !!back && back.id === id;
      } catch (_) { return true; }
    },
    release() {
      if (!storage) return;
      try { const cur = JSON.parse(storage.getItem(LEASE_KEY) || 'null'); if (cur && cur.id === id) storage.removeItem(LEASE_KEY); } catch (_) { /* gone */ }
    },
  };
}

/**
 * The reporter. `send(events)` resolves to the core's reply (`{ok, routed, kind}`), never throws.
 * `store` is `{get(), set(arr)}` or null. `enabled()` is asked on every pass: false for a display
 * link, a snapshot file, an older core, no signed-in user.
 */
export function createReporter({ send, enabled = () => true, now = () => Date.now(), store = null, flushMs = FLUSH_MS, lease = null } = {}) {
  let seen = null;
  let queue = [];
  let lastFlush = 0;
  let stopped = false;
  let pausedUntil = 0;
  let busy = false;
  const blocked = new Set();      // clusters the core said this person may not report on
  if (store) {
    try { const prev = store.get(); if (Array.isArray(prev)) seen = new Map(prev.map((k) => [k, 0])); } catch (_) { /* no storage */ }
  }

  async function flush() {
    if (busy || stopped || !queue.length || now() < pausedUntil) return;
    if (now() - lastFlush < flushMs) return;
    busy = true;
    lastFlush = now();
    try {
      const todo = coalesce(queue);
      queue = [];
      for (const b of batches(todo)) {
        let res = await send(b);
        if (res && res.ok === false && res.kind === 'forbidden') {
          // The core names no cluster: ask per cluster, drop the one(s) refused, carry on.
          const by = new Map();
          for (const e of b) { const c = clusterOfKey(e.key); (by.get(c) || by.set(c, []).get(c)).push(e); }
          res = { ok: true };
          for (const [c, evs] of by) {
            const r = await send(evs);
            if (r && r.ok === false && r.kind === 'forbidden') blocked.add(c);
            else if (r && r.ok === false) { res = r; break; }
            else if (r && r.ok === true && r.routed === false) res = r;
          }
        }
        if (res && res.ok === false && res.kind === 'too_many') { pausedUntil = now() + ALERT_EVENTS_WINDOW_MS; queue = []; return; }
        if (res && res.ok === false && (res.supported === false || res.unknown)) { stopped = true; queue = []; return; }
        if (res && res.ok === true && res.routed === false) { pausedUntil = now() + UNROUTED_PAUSE_MS; return; }
      }
    } finally { busy = false; }
  }

  return {
    /** One refresh's merged alerts. Resolves after any flush it caused. */
    async observe(merged, { levelOf, status } = {}) {
      if (stopped || !enabled()) return;
      const keys = keysOf(merged);
      const r = transitions(seen, keys, { levelOf, status, at: now() });
      seen = r.seen;
      if (store) { try { store.set([...seen.keys()]); } catch (_) { /* no storage */ } }
      // A tab that does not hold the lease keeps its picture current and reports nothing.
      const mine = !lease || lease.acquire();
      if (mine && now() >= pausedUntil) queue.push(...r.events.filter((e) => !blocked.has(clusterOfKey(e.key))));
      if (mine) await flush();
    },
    get stopped() { return stopped; },
    get pausedUntil() { return pausedUntil; },
    get blocked() { return [...blocked]; },
    get queued() { return queue.length; },
  };
}

/** sessionStorage as a reporter store, or null where it is not there. */
export function sessionStore(storage = (typeof sessionStorage !== 'undefined' ? sessionStorage : null)) {
  if (!storage) return null;
  return {
    get: () => JSON.parse(storage.getItem(STORE_KEY) || 'null'),
    set: (arr) => storage.setItem(STORE_KEY, JSON.stringify(arr)),
  };
}
