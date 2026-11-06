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

/**
 * One pass against the last. `seen` is a Map(key → passes absent) or null before the first
 * pass. Returns the events and the next `seen`.
 */
export function transitions(seen, keys, { grace = GRACE_PASSES, levelOf = () => undefined, at = Date.now() } = {}) {
  const now = new Map([...keys].map((k) => [k, 0]));
  if (seen === null) return { events: [], seen: now };
  const events = [];
  for (const k of keys) if (!seen.has(k)) events.push(mk('raised', k, levelOf(k), at));
  for (const [k, gone] of seen) {
    if (keys.has(k)) continue;
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
 * The reporter. `send(events)` resolves to the core's reply (`{ok, routed, kind}`), never throws.
 * `store` is `{get(), set(arr)}` or null. `enabled()` is asked on every pass: false for a display
 * link, a snapshot file, an older core, no signed-in user.
 */
export function createReporter({ send, enabled = () => true, now = () => Date.now(), store = null, flushMs = FLUSH_MS } = {}) {
  let seen = null;
  let queue = [];
  let lastFlush = 0;
  let stopped = false;
  let pausedUntil = 0;
  let busy = false;
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
        const res = await send(b);
        if (res && res.ok === false && (res.kind === 'too_many' || res.kind === 'forbidden' || res.supported === false || res.unknown)) {
          stopped = true; queue = []; return;
        }
        if (res && res.ok === true && res.routed === false) { pausedUntil = now() + UNROUTED_PAUSE_MS; return; }
      }
    } finally { busy = false; }
  }

  return {
    /** One refresh's merged alerts. Resolves after any flush it caused. */
    async observe(merged, { levelOf } = {}) {
      if (stopped || !enabled()) return;
      const keys = keysOf(merged);
      const r = transitions(seen, keys, { levelOf, at: now() });
      seen = r.seen;
      if (store) { try { store.set([...seen.keys()]); } catch (_) { /* no storage */ } }
      if (r.events.length && now() >= pausedUntil) queue.push(...r.events);
      await flush();
    },
    get stopped() { return stopped; },
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
