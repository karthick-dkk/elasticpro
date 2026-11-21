/**
 * Acknowledgements and operator notes on alerts.
 *
 * An alert is a live reading, not a record — it exists while the condition holds and
 * disappears when it clears. What an operator adds to it is the opposite: "seen it, the
 * vendor is on it, ticket 4412". That belongs to the alert's KEY, which names the problem
 * rather than its current value, so a note written when the disk was at 86% is still
 * attached when it reaches 91%.
 *
 * Where it is kept depends on the edition (0.3.47):
 *
 *  - desktop (portable / installed): IndexedDB on this machine, a local operator log — two
 *    people running the app do not see each other's notes;
 *  - hosted: the server (`ACK_LIST` / `ACK_SET` / `ACK_CLEAR`, `<data>/acks.json`), so an
 *    acknowledgement is the team's — the person at the desk acknowledges and the Play wall
 *    stops taking the screen for it. Same keys; the server says who acknowledged and when,
 *    and audits every change. Acknowledgements a browser kept before are not moved (they
 *    were one person's). A server too old to know the messages: IndexedDB, as before.
 *
 * The exports are the same in both: the pages never ask which it is.
 */

import { idb } from '../lib/idb.js';
import { bridge } from './transport.js';

const cache = new Map();      // key -> record, so rendering does not await
let loaded = false;
/** Bumped on every change, so a memo built from acknowledgements knows when to rebuild. */
let rev = 0;
export function acksRev() { return rev; }
/** Every record, for a reader that has to look across keys (the history of an alert). */
export function ackRecords() { return [...cache.values()]; }

/** @typedef {{key:string, acked:boolean, ackedAt:number, ackedBy:string, notes:Array, missingSince:number}} AckRecord */

/* ----------------------------- where they are kept ----------------------------- */

/** true: the hosted server keeps them; false: IndexedDB. Asked once (WHOAMI's edition). */
let onServer = null;
async function serverKeeps() {
  if (onServer !== null) return onServer;
  try {
    const w = await bridge({ type: 'WHOAMI' });
    onServer = !!(w && w.ok && w.edition === 'hosted');
  } catch (_) { onServer = false; }
  return onServer;
}

/** Where they are kept now: true the server, false this browser, null not asked yet. */
export function acksOnServer() { return onServer; }
/** For the checks: forget where they are kept, so the next use asks WHOAMI again. */
export function forgetAcksPlace() { onServer = null; }

/** A reply saying the server does not have these messages (an older core): IndexedDB then. */
function unsupported(res) {
  return !!res && !res.ok && (res.kind === 'bad_message'
    || (res.kind === 'forbidden' && /is not available to the/.test(String(res.message || ''))));
}

/** The server's entry `{by, at, note?, record?}` as the record the pages use. */
function fromServer(key, a) {
  const r = (a && a.record && typeof a.record === 'object') ? a.record : null;
  const rec = {
    key,
    acked: r ? r.acked !== false : true,
    ackedAt: r && Number.isFinite(r.ackedAt) ? r.ackedAt : (a.at || 0),
    ackedBy: r && typeof r.ackedBy === 'string' ? r.ackedBy : (a.by || ''),
    notes: r && Array.isArray(r.notes) ? r.notes : (a.note ? [{ text: a.note, by: a.by || '', ts: a.at || 0 }] : []),
    missingSince: (r && r.missingSince) || 0,
  };
  if (r && Array.isArray(r.ackedItems)) rec.ackedItems = r.ackedItems;
  return rec;
}

/**
 * Keep one record where this edition keeps them; the server's answer (who, when) wins.
 *
 * Hosted, a record the server refused or never got comes back marked `unsaved` (the reason):
 * it is shown in this browser only, so the page must say "not saved" and offer Retry rather
 * than look like the team's record (UI-03/UI-04). The mark itself is never sent or stored.
 */
async function persist(rec) {
  const { unsaved: _was, attemptAt: _at, ...clean } = rec;
  if (await serverKeeps()) {
    const { key, ...record } = clean;
    const res = await bridge({ type: 'ACK_SET', key, record });
    if (res && res.ok && res.ack) return fromServer(key, res.ack);
    if (!unsupported(res)) {
      // When it was tried: Retry lets an acknowledgement made on the server after this win.
      return { ...clean, unsaved: String((res && res.message) || 'the server did not answer'), attemptAt: Date.now() };
    }
    onServer = false;
  }
  try { await idb.putAck(clean); } catch (_) { /* memory-only for this session */ }
  return clean;
}

/** Why this key's record is not saved (hosted: the server refused it or did not answer), or ''. */
export function unsavedReason(key) { return String((cache.get(key) || {}).unsaved || ''); }

/** Two notes are the same note when written by the same person at the same time with the same text. */
const sameNote = (a, b) => a.ts === b.ts && a.text === b.text && (a.by || '') === (b.by || '');

/**
 * What Retry sends (pure): the server's record as it is now, with the notes this browser could
 * not save appended (none twice), and this browser's acknowledgement — unless the server's was
 * made after the failed attempt (`attemptAt`), when the server's stands and `dropped` says so.
 * Sending the stale whole record instead would overwrite acknowledgements and notes others
 * made meanwhile. `server` is the server's record for the key, or null when it has none.
 */
export function mergeForRetry(local, server) {
  const { unsaved: _u, attemptAt, ...mine } = local;
  const base = server || { key: local.key, acked: false, ackedAt: 0, ackedBy: '', notes: [], missingSince: 0 };
  const theirs = Array.isArray(base.notes) ? base.notes : [];
  const notes = [...theirs, ...(mine.notes || []).filter((n) => !theirs.some((t) => sameNote(t, n)))];
  const serverNewer = !!server && Number.isFinite(server.ackedAt) && server.ackedAt > 0
    && Number.isFinite(attemptAt) && server.ackedAt > attemptAt;
  const ackFrom = serverNewer ? base : mine;
  const rec = { ...base, key: local.key, notes, acked: !!ackFrom.acked, ackedAt: ackFrom.ackedAt || 0, ackedBy: ackFrom.ackedBy || '' };
  delete rec.ackedItems;
  if (Array.isArray(ackFrom.ackedItems)) rec.ackedItems = ackFrom.ackedItems;
  const changedAck = !!mine.acked !== !!base.acked || (mine.acked && !!server && (mine.ackedAt || 0) !== (base.ackedAt || 0));
  const dropped = serverNewer && changedAck
    ? `${base.ackedBy || 'Someone'} ${base.acked ? 'acknowledged' : 'changed'} it on the server after your attempt: theirs stands, yours was dropped`
    : '';
  return { rec, dropped };
}

/**
 * Send a record that did not save again — merged with the server's copy as it is now
 * (`mergeForRetry`), never the stale whole record. Resolves to the record kept; `dropped`
 * on it (not stored) says when this browser's acknowledgement gave way to a newer one.
 */
export async function retrySave(key) {
  const rec = cache.get(key);
  if (!rec || !rec.unsaved) return rec || null;
  if (!(await serverKeeps())) return save(rec);
  const res = await bridge({ type: 'ACK_LIST' });
  if (!res || !res.ok) {
    if (unsupported(res)) { onServer = false; return save(rec); }
    const still = { ...rec, unsaved: String((res && res.message) || 'the server did not answer') };
    cache.set(key, still); rev++;
    return still;
  }
  const a = res.acks && res.acks[key];
  const { rec: merged, dropped } = mergeForRetry(rec, a ? fromServer(key, a) : null);
  const kept = await save(merged);
  return dropped && kept && !kept.unsaved ? { ...kept, dropped } : kept;
}

/** Forget one record where this edition keeps them. */
async function unpersist(key) {
  if (await serverKeeps()) {
    const res = await bridge({ type: 'ACK_CLEAR', key });
    if (!unsupported(res)) return;
    onServer = false;
  }
  try { await idb.delAck(key); } catch (_) { /* ignore */ }
}

export async function loadAcks() {
  if (await serverKeeps()) {
    const res = await bridge({ type: 'ACK_LIST' });
    if (res && res.ok) {
      // What did not save stays shown, marked, until it is retried: the server's list does
      // not have it, and dropping it would lose what the person wrote without a word.
      const pending = [...cache.values()].filter((r) => r.unsaved);
      cache.clear();
      for (const [key, a] of Object.entries(res.acks || {})) cache.set(key, fromServer(key, a));
      for (const r of pending) cache.set(r.key, r);
      loaded = true; rev++;
      return cache;
    }
    if (!unsupported(res)) { loaded = true; return cache; }   // keep what is shown; the next load asks again
    onServer = false;
  }
  try {
    const all = (await idb.allAcks()) || [];
    cache.clear();
    for (const a of all) cache.set(a.key, a);
    loaded = true; rev++;
  } catch (_) { loaded = true; }   // a browser with no IndexedDB just gets no notes
  return cache;
}

export function acksLoaded() { return loaded; }

export function ackFor(key) {
  return cache.get(key) || { key, acked: false, ackedAt: 0, ackedBy: '', notes: [], missingSince: 0 };
}

export function isAcked(key) { return !!(cache.get(key) || {}).acked; }
export function noteCount(key) { return ((cache.get(key) || {}).notes || []).length; }

async function save(rec) {
  cache.set(rec.key, rec); rev++;
  const kept = await persist(rec);
  if (kept !== rec) { cache.set(rec.key, kept); rev++; }
  return kept;
}

/** Who wrote this. Remembered so it is typed once, not once per note. */
let who = '';
export function currentUser() { return who; }
export async function setCurrentUser(name) {
  who = String(name || '').trim();
  try { await idb.setKV('ackUser', who); } catch (_) { /* ignore */ }
}
export async function loadCurrentUser() {
  try { who = (await idb.getKV('ackUser')) || ''; } catch (_) { who = ''; }
  return who;
}

export async function acknowledge(key, { by = who, note = '' } = {}) {
  const rec = { ...ackFor(key), acked: true, ackedAt: Date.now(), ackedBy: by || 'operator' };
  delete rec.ackedItems;        // the whole key, as before
  rec.notes = [...(rec.notes || [])];
  if (note.trim()) rec.notes.push({ text: note.trim(), by: by || 'operator', ts: Date.now() });
  return save(rec);
}

/**
 * Acknowledge a merged alert (core/alert-groups.js): the record is kept under the merged
 * key and remembers WHICH items it covered, so an item that joins later is not hidden
 * behind it. A record with no item list (everything acknowledged before merging existed)
 * covers everything under its key, as it always did.
 */
export async function acknowledgeItems(key, itemIds, { by = who, note = '' } = {}) {
  const rec = { ...ackFor(key), acked: true, ackedAt: Date.now(), ackedBy: by || 'operator',
    ackedItems: [...new Set(itemIds || [])] };
  rec.notes = [...(rec.notes || [])];
  if (note.trim()) rec.notes.push({ text: note.trim(), by: by || 'operator', ts: Date.now() });
  return save(rec);
}

export async function unacknowledge(key) {
  const rec = { ...ackFor(key), acked: false, ackedAt: 0, ackedBy: '' };
  delete rec.ackedItems;
  // Notes are kept: they are the history of the problem, not of the acknowledgement.
  return save(rec);
}

export async function addNote(key, text, by = who) {
  const t = String(text || '').trim();
  if (!t) return null;
  const rec = { ...ackFor(key) };
  rec.notes = [...(rec.notes || []), { text: t, by: by || 'operator', ts: Date.now() }];
  return save(rec);
}

export async function removeNote(key, ts) {
  const rec = { ...ackFor(key) };
  rec.notes = (rec.notes || []).filter((n) => n.ts !== ts);
  return save(rec);
}

/**
 * The cluster an acknowledgement key names (`<clusterId>:…`), the longest of `ids` that
 * prefixes it, or null when none does: the core's own rule (silences::cluster_of).
 */
export function ackClusterOf(key, ids) {
  let best = null;
  for (const id of ids) if (String(key).startsWith(`${id}:`) && (!best || id.length > best.length)) best = id;
  return best;
}

/**
 * Drop records whose alert no longer exists, so the store does not grow forever with
 * problems that were fixed months ago. Records carrying notes are kept.
 */
/**
 * How long an acknowledgement survives after its alert stops being emitted.
 *
 * Long enough that every ordinary reason for a key to disappear — a cluster briefly
 * unreachable, a threshold retuned, a rule switched off for the afternoon, a repository
 * renamed — passes without losing anything a person wrote.
 */
export const ACK_GRACE_DAYS = 30;

/**
 * Forget acknowledgements whose alert has been gone for a long time.
 *
 * This used to delete on absence: any acknowledged alert not in the current list went,
 * immediately, from memory and from disk. That was written for alerts that genuinely went
 * away — a cluster you removed — and it cannot tell that apart from an alert that stopped
 * being emitted for a moment. Disabling a rule, nudging a threshold, or a cluster failing
 * one refresh all look identical to it, so a single edit could destroy the triage history
 * of an entire fleet on the next page load.
 *
 * Now absence only starts a clock. A key that comes back inside the grace period keeps
 * everything, including the date it was first acknowledged. Records carrying notes are
 * still never removed at all — somebody wrote those.
 */
export async function pruneAcks(liveKeys, { clusterIds = null, complete = false } = {}) {
  const live = new Set(liveKeys);
  const now = Date.now();
  const graceMs = ACK_GRACE_DAYS * 86400000;

  // Hosted, the records are the team's (ACK_LIST). One browser's list of live alerts is not
  // enough to rewrite them: it may be partial (a fleet still loading, a cluster this person
  // cannot see), and writing a record back would stamp it in this person's name. So nothing
  // is written here; a record is cleared only when its cluster is gone from the fleet, and
  // only once every cluster has answered.
  if (await serverKeeps()) {
    if (!complete || !Array.isArray(clusterIds) || !clusterIds.length) return;
    const ids = clusterIds.map(String);
    for (const [key, rec] of [...cache.entries()]) {
      if ((rec.notes || []).length || ackClusterOf(key, ids)) continue;
      cache.delete(key);
      await unpersist(key);
    }
    return;
  }

  for (const [key, rec] of [...cache.entries()]) {
    if (live.has(key)) {
      // Back among the living: clear the clock so a later absence starts a fresh one.
      if (rec.missingSince) {
        const next = { ...rec, missingSince: 0 };
        cache.set(key, next);
        await persist(next);              // a failure leaves the in-memory copy, which is still right
      }
      continue;
    }
    if ((rec.notes || []).length) continue;

    if (!rec.missingSince) {
      const next = { ...rec, missingSince: now };
      cache.set(key, next);
      await persist(next);
      continue;
    }
    if (now - rec.missingSince < graceMs) continue;

    cache.delete(key);
    await unpersist(key);
  }
}
