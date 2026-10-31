/**
 * Transport to the Rust core.
 *
 * Inside the desktop app this is a Tauri command (`bridge`); in the development bridge
 * (`elasticpro-bridge`) it is POST /bridge on loopback. Same message API either way, and the
 * same shape the browser extension used for chrome.runtime.sendMessage — which is why
 * the pages did not need to change.
 */

import { stampReply, CORE_CODES } from './error-codes.js';

const T = globalThis.__TAURI__;
export const isTauri = !!(T && T.core && typeof T.core.invoke === 'function');

/**
 * The signed-in session.
 *
 * Signed in directly, the browser holds it only as the server's HttpOnly cookie, which no
 * script can read and which travels with every request by itself: the page never sees
 * the token and never stores it. Nothing about a session is ever put in localStorage or
 * sessionStorage — secrets live on the server (the core's session store), not in the
 * browser.
 *
 * Two cases have no cookie and hold the token here, in page memory only, gone on reload:
 * Zabbix's frame (cross-site, so a Strict cookie is not sent; Zabbix signs the frame in
 * again on every load) and the desktop app (no HTTP at all). The portable build never has
 * one — the core does not ask.
 */
let session = '';
let signedIn = false;
// Before this, the token was kept in sessionStorage. Clear any left there.
try { sessionStorage.removeItem('elasticpro.session'); localStorage.removeItem('elasticpro.session'); } catch { /* no storage: nothing to clear */ }

export function getSession() { return session; }
/** A token the reply carried (frame, desktop), or '' — the cookie needs no help. */
export function setSession(token) { session = token || ''; }
/** Whether this page is signed in, so a refusal from the core can send it back to the login. */
export function setSignedIn(on) { signedIn = !!on; if (!on) session = ''; }

/** Notified when the core says the session is gone, so the app can show the login again. */
const expiryListeners = new Set();
export function onSessionLost(fn) { expiryListeners.add(fn); return () => expiryListeners.delete(fn); }

/**
 * One AbortController per page origin (`page:<id>`), for the page's own ES requests. Leaving
 * the page aborts it alongside ABORT_REQUESTS: the browser lets go of the connection, the
 * core sees the client gone and drops the request — whether it was still waiting for a
 * slot or already at the cluster. The desktop app has no connection to close; there
 * ABORT_REQUESTS does it alone.
 */
const pageControllers = new Map();

function signalFor(msg) {
  const origin = msg && msg.type === 'ES' ? String(msg.origin || '') : '';
  if (isTauri || !origin.startsWith('page:')) return undefined;
  let c = pageControllers.get(origin);
  if (!c) { c = new AbortController(); pageControllers.set(origin, c); }
  return c.signal;
}

/** Let go of every request the page `origin` still has open. */
export function abortPage(origin) {
  const c = pageControllers.get(origin);
  if (!c) return;
  pageControllers.delete(origin);
  c.abort();
}

const ABORTED = { ok: false, kind: 'aborted', status: 0, message: 'cancelled: the page that asked was left' };

/**
 * An `overloaded` refusal means nothing was sent: the core's queue was full. A read is
 * asked once more after the time the core named (bounded here to a quarter second .. ten
 * seconds); a write never — the person decides whether to press again.
 */
export function overloadRetryMs(res, msg) {
  if (!res || res.kind !== 'overloaded' || !readsOnly(msg)) return 0;
  const ms = Number(res.retryAfterMs);
  return Math.min(10000, Math.max(250, Number.isFinite(ms) ? ms : 1000));
}

async function callOnce(out, signal) {
  return isTauri ? T.core.invoke('bridge', { msg: out }) : httpBridge(out, signal);
}

export async function bridge(msg) {
  try {
    // LOGIN carries no session, and LOGOUT carries the one it is ending.
    const out = session && msg.session === undefined ? { ...msg, session } : msg;
    const signal = signalFor(msg);
    let res = await callOnce(out, signal);
    const wait = overloadRetryMs(res, msg);
    if (wait) {
      await pause(wait);
      res = signal && signal.aborted ? ABORTED : await callOnce(out, signal);
    }
    // An expired or revoked session must not leave the app quietly showing stale data —
    // every caller would otherwise have to notice this for itself.
    if (res && res.kind === 'unauthenticated' && (session || signedIn) && msg.type !== 'LOGIN') {
      setSignedIn(false);
      for (const fn of expiryListeners) { try { fn(); } catch { /* keep telling the rest */ } }
    }
    // Every failure leaves here with a code — the core's, or the browser's for one it never sent.
    return stampReply(res);
  } catch (e) {
    if (e && e.name === 'AbortError') return stampReply({ ...ABORTED, errorCode: CORE_CODES.aborted });
    return stampReply({ ok: false, kind: 'worker_error', message: `ElasticPro server did not answer: ${String(e && e.message || e)}` });
  }
}

/**
 * What an HTTP status from the proxy in front of the core means, when the answer is not the
 * core's JSON. nginx answers these itself with an HTML page — which read as "Unexpected
 * token '<' … is not valid JSON" and said nothing about why.
 */
const PROXY_STATUS = {
  429: ['proxy_rate_limited', 'this browser sent more requests than the server allows per second — slowed down; it clears by itself'],
  502: ['core_unavailable', 'the ElasticPro core is not answering nginx (restarting, or stopped)'],
  503: ['core_unavailable', 'the ElasticPro core is not answering nginx (restarting, or stopped)'],
  504: ['core_timeout', 'the ElasticPro core took longer than nginx waits (120 s) to answer'],
};
// A 429 is nginx refusing before passing anything on: always safe to send again. A 502/503
// usually means nginx could not reach the core, but it also answers 502 when the core went
// away mid-request (a restart, a crash) — after it may have acted. So those are retried only
// for messages that change nothing; a 504 never.
const RETRY_MS = { 429: [500, 1000, 2000], 502: [1500], 503: [1500] };
const CHANGES = /^(ES|.*_(SET|ADD|REMOVE|DELETE|WRITE|SAVE|CLEAR|CREATE|REVOKE|UPLOAD|UNLOCK|RUN|RESTORE|BEGIN|PROMOTE)|WRITE_UNLOCK|PRIME|FORGET|SEAL|OPEN|LOGIN|LOGOUT|BOOTSTRAP_ADMIN|TRUST_.*|UNTRUST_.*|ZABBIX_SYNC|ZABBIX_UNPAIR|REFRESH|REPORT_STOP|REPORT_SEND_NOW|MAIL_TEST)$/;
export const readsOnly = (msg) => !CHANGES.test(String(msg.type || ''))
  || (msg.type === 'ES' && /^(GET|HEAD)?$/i.test(String(msg.method || '').trim()));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpBridge(out, signal) {
  const body = JSON.stringify(out);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch('/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal });
    const waits = (r.status === 429 || readsOnly(out)) ? RETRY_MS[r.status] : null;
    if (waits && attempt < waits.length) {
      const after = Number(r.headers.get('retry-after'));
      await pause(after > 0 && after < 10 ? after * 1000 : waits[attempt]);
      continue;
    }
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      const [kind, why] = PROXY_STATUS[r.status] || ['worker_error', `the server answered HTTP ${r.status} with a page instead of data`];
      return { ok: false, kind, status: r.status, message: `ElasticPro server: ${why} (HTTP ${r.status})` };
    }
  }
}

/**
 * Be told when the core's fleet cache changes.
 *
 * `onEvent` receives `{type: 'dataset'|'reach', clusterId, …}` as the server announces a
 * change, `{type: 'resync'}` when the stream fell behind or was re-opened (anything may
 * have been missed: ask FLEET_STATE in full), and `{type: 'poll'}` on the desktop, which
 * has no socket and is simply told when to ask FLEET_STATE {since} again. The events say
 * WHAT changed, never what it changed to — the caller reads the bodies with FLEET_STATE,
 * so this carries nothing the message API would not.
 *
 * In the browser it is an EventSource on the path a single-use ticket names. A ticket is
 * spent on the first connection, so EventSource's own reconnect (same URL) can only be
 * refused; every error closes the stream and asks for a new ticket, backing off from one
 * second to a minute while the server keeps saying no. `expired` means the session behind
 * the ticket ended, which the next ticket request reports to the session listeners.
 *
 * Returns a function that stops it.
 */
export function subscribe(onEvent, { pollMs = 5000 } = {}) {
  let stopped = false;
  const emit = (ev) => { if (!stopped) { try { onEvent(ev); } catch (e) { console.error(e); } } };

  if (isTauri) {
    // In-process core, no HTTP server to hold a stream open: a poll every five seconds
    // is one message on a local channel, and FLEET_STATE {since} answers "nothing" cheaply.
    const t = setInterval(() => emit({ type: 'poll' }), pollMs);
    return () => { stopped = true; clearInterval(t); };
  }
  const ES = globalThis.EventSource;
  if (typeof ES !== 'function') return () => { stopped = true; };   // the caller's fallback poll covers it

  let es = null;
  let timer = null;
  let backoff = 1000;
  let opened = false;

  const close = () => { if (es) { try { es.close(); } catch (_) { /* already gone */ } es = null; } };
  const again = () => {
    close();
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; open(); }, backoff);
    backoff = Math.min(60000, backoff * 2);
  };
  const on = (name, fn) => es.addEventListener(name, (e) => {
    let data = {};
    try { data = e.data ? JSON.parse(e.data) : {}; } catch (_) { /* keep-alive or junk: ignore */ }
    fn(data);
  });

  async function open() {
    if (stopped) return;
    const t = await bridge({ type: 'EVENTS_TICKET' });
    if (stopped) return;
    if (!t || !t.ok || !t.path) { again(); return; }
    try { es = new ES(t.path); } catch (_) { again(); return; }
    es.onopen = () => {
      backoff = 1000;
      // A stream that was down may have missed changes; the first one never had any.
      if (opened) emit({ type: 'resync' });
      opened = true;
    };
    es.onerror = () => again();
    on('dataset', (d) => emit({ type: 'dataset', ...d }));
    on('reach', (d) => emit({ type: 'reach', ...d }));
    on('resync', () => emit({ type: 'resync' }));
    on('expired', () => { opened = true; again(); });
  }
  open();
  return () => { stopped = true; close(); if (timer) { clearTimeout(timer); timer = null; } };
}
