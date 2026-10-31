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

/** Keep one record where this edition keeps them; the server's answer (who, when) wins. */
async function persist(rec) {
  if (await serverKeeps()) {
    const { key, ...record } = rec;
    const res = await bridge({ type: 'ACK_SET', key, record });
    if (res && res.ok && res.ack) return fromServer(key, res.ack);
    if (!unsupported(res)) return rec;          // refused or unreachable: this session only
    onServer = false;
  }
  try { await idb.putAck(rec); } catch (_) { /* memory-only for this session */ }
  return rec;
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
      cache.clear();
      for (const [key, a] of Object.entries(res.acks || {})) cache.set(key, fromServer(key, a));
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
export async function pruneAcks(liveKeys) {
  const live = new Set(liveKeys);
  const now = Date.now();
  const graceMs = ACK_GRACE_DAYS * 86400000;

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
