/**
 * Transport to the Rust core.
 *
 * Inside the desktop app this is a Tauri command (`bridge`); in the development bridge
 * (`elasticpro-bridge`) it is POST /bridge on loopback. Same message API either way, and the
 * same shape the browser extension used for chrome.runtime.sendMessage — which is why
 * the pages did not need to change.
 */

const T = globalThis.__TAURI__;
export const isTauri = !!(T && T.core && typeof T.core.invoke === 'function');

/**
 * The signed-in session, attached to every message the core then authorises against.
 *
 * Kept in sessionStorage rather than localStorage: closing the window should end the
 * session, and a reload should not. It is a bearer token, so it lives per-tab and goes
 * when the tab does. The portable build never has one — the core does not ask.
 */
const KEY_SESSION = 'elasticpro.session';
let session = read();

function read() {
  try { return sessionStorage.getItem(KEY_SESSION) || ''; } catch { return ''; }
}
export function getSession() { return session; }
export function setSession(token) {
  session = token || '';
  try {
    if (session) sessionStorage.setItem(KEY_SESSION, session);
    else sessionStorage.removeItem(KEY_SESSION);
  } catch { /* a private window still works, it just forgets on reload */ }
}

/** Notified when the core says the session is gone, so the app can show the login again. */
const expiryListeners = new Set();
export function onSessionLost(fn) { expiryListeners.add(fn); return () => expiryListeners.delete(fn); }

export async function bridge(msg) {
  try {
    // LOGIN carries no session, and LOGOUT carries the one it is ending.
    const out = session && msg.session === undefined ? { ...msg, session } : msg;
    const res = isTauri
      ? await T.core.invoke('bridge', { msg: out })
      : await (await fetch('/bridge', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(out),
      })).json();
    // An expired or revoked session must not leave the app quietly showing stale data —
    // every caller would otherwise have to notice this for itself.
    if (res && res.kind === 'unauthenticated' && session) {
      setSession('');
      for (const fn of expiryListeners) { try { fn(); } catch { /* keep telling the rest */ } }
    }
    return res;
  } catch (e) {
    return { ok: false, kind: 'worker_error', message: String(e && e.message || e) };
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
