/**
 * Row action menu.
 *
 * Destructive actions used to sit in the row as plain buttons, one mis-click away from
 * deleting an index or a snapshot. They live behind this now: the row keeps the safe,
 * frequent actions, and everything that changes or removes something is a deliberate
 * two-step — open the menu, then confirm.
 */

import { h, mount } from '../lib/dom.js';
import { mergeNotifications, newId, sendRule, toPut } from '../lib/notify-history.js';

let open = null;   // the popup currently on screen, if any

function close() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener('mousedown', open.away, true);
  document.removeEventListener('keydown', open.key, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', close, true);
  open = null;
}

export function closeMenus() { close(); }

/**
 * @param items  [{ label, icon, onClick, danger, disabled, title, sep, hint }]
 *               `sep: true` draws a divider; `hint` is a line of muted text.
 * @param opts   { label } for the trigger button (default '⋮')
 */
export function rowMenu(items, opts = {}) {
  const trigger = h('button.btn.sm.menu-trigger', {
    title: opts.title || 'More actions',
    'aria-haspopup': 'menu',
    onclick: (e) => {
      e.stopPropagation();
      const wasOpen = open && open.trigger === trigger;
      close();
      if (wasOpen) return;             // clicking the same trigger closes it
      show(trigger, items);
    },
  }, opts.label || '⋮');
  return trigger;
}

function show(trigger, items) {
  const el = h('div.menu-pop', { role: 'menu' });

  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div.sep')); continue; }
    if (it.hint) { el.append(h('div.hint', it.hint)); continue; }
    el.append(h(`button${it.danger ? '.danger' : ''}`, {
      disabled: !!it.disabled,
      title: it.title || '',
      role: 'menuitem',
      onclick: (e) => {
        e.stopPropagation();
        close();
        if (!it.disabled && it.onClick) it.onClick(e);
      },
    }, h('span.ico', it.icon || ''), h('span', it.label)));
  }

  document.body.append(el);
  anchorTo(el, trigger);

  const away = (e) => { if (!el.contains(e.target) && e.target !== trigger) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);

  open = { el, trigger, away, key };
  const first = el.querySelector('button:not(:disabled)');
  if (first) first.focus();
}

/** The icons used for row actions, so they mean the same thing on every page. */
export const ICON = {
  delete: '🗑',
  edit: '✎',
  open: '⊕',
  close: '⊘',
  move: '⇄',
  settings: '⚙',
  restore: '⇩',
  details: '☰',
  refresh: '↻',
  verify: '✓',
  cleanup: '🧹',
  console: '↗',
  free: '⌫',
};

/** Position a floating panel under its trigger, flipped or nudged to stay on screen. */
export function anchorTo(el, trigger) {
  const r = trigger.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - m.width), window.innerWidth - m.width - 8);
  const below = r.bottom + 4;
  const top = below + m.height > window.innerHeight - 8 ? Math.max(8, r.top - m.height - 4) : below;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/* --------------------------------- popover ---------------------------------- */

let openPop = null;

export function closePopover() {
  if (!openPop) return;
  const { el, away, key, onClose } = openPop;
  el.remove();
  document.removeEventListener('mousedown', away, true);
  document.removeEventListener('keydown', key, true);
  window.removeEventListener('resize', closePopover);
  window.removeEventListener('scroll', closePopover, true);
  openPop = null;
  if (onClose) onClose();
}

/**
 * A panel anchored to what you clicked, for content that does not deserve a row of its
 * own — notes on an alert, say. Unlike the row menu it stays open while you interact
 * with it, and closes on Escape, on a click outside, or when its own content asks to.
 *
 * @param trigger  the element to anchor under
 * @param build    (ctx) => Node — ctx.close() dismisses, ctx.rebuild() redraws in place
 * @param opts     { title, sub, width, onClose }
 */
export function popover(trigger, build, opts = {}) {
  const already = openPop && openPop.trigger === trigger;
  closePopover();
  closeMenus();
  if (already) return null;   // clicking the same trigger again closes it

  const el = h('div.pop', opts.width ? { style: { minWidth: opts.width } } : null);
  const body = h('div.body');
  const ctx = {
    close: closePopover,
    rebuild: () => { mount(body, build(ctx)); anchorTo(el, trigger); },
  };

  el.append(
    h('header', h('span', opts.title || ''),
      opts.sub ? h('span.sub', opts.sub) : null,
      h('button.btn.sm.ghost', { title: 'Close', onclick: closePopover }, '×')),
    body,
  );
  mount(body, build(ctx));
  document.body.append(el);
  anchorTo(el, trigger);

  const away = (e) => { if (!el.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', closePopover);
  window.addEventListener('scroll', closePopover, true);

  openPop = { el, trigger, away, key, onClose: opts.onClose };
  const first = el.querySelector('input,textarea');
  if (first) setTimeout(() => first.focus(), 0);
  return ctx;
}

/* ---------------------------------- toast ------------------------------------ */

let toastWrap = null;

/**
 * A short confirmation that fades itself out. For actions that close the panel they were
 * performed in, where an alert() would be an interruption and silence would be a doubt.
 */
/** At most this many on screen. Beyond it they stop being notices and become a wall. */
const MAX_TOASTS = 4;

/**
 * A short-lived notice.
 *
 * `opts.key` is what stops a repeated action stacking. Pressing Run four times used to
 * leave four notices piled over the page, because each message ended with a different
 * duration and so counted as a different message — the one thing they had in common was
 * the only thing not being compared. A keyed toast replaces the one already showing and
 * restarts its clock, so repeating an action updates one line instead of growing a
 * column.
 *
 * Unkeyed toasts still stack, because two different things happening are two things
 * worth seeing. They are capped: past four, the oldest goes, since a notice nobody can
 * read before the next arrives is not a notice.
 */
export function toast(message, kind = 'ok', ms = 2600, opts = {}) {
  // A redraw of the page must never take the notices with it: a wrapper that has been
  // detached still accepts toasts, it just shows none of them.
  if (!toastWrap || !toastWrap.isConnected) {
    toastWrap = h('div.toast-wrap', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }

  placeToasts();
  const k = toastKind(kind, message);
  const key = opts.key || null;
  const detail = [].concat(opts.detail || []).filter(Boolean).map(String);
  const meta = opts.meta ? String(opts.meta) : '';
  const cluster = opts.cluster ? String(opts.cluster) : '';
  // A task's progress ticks are not new notifications: they update its bell entry in
  // place, and its card only if that card is still on screen — a running task shows for
  // five seconds, then lives in the bell until it finishes and shows again.
  if (opts.silent) {
    touch(key, message, k, detail, meta, cluster);
    const live = key ? toastWrap.querySelector(`[data-toast-key="${CSS_ESCAPE(key)}"]:not(.out)`) : null;
    if (!live) return null;
  } else {
    remember(message, k, key, detail, meta, cluster);
  }

  const content = () => [
    k === 'run' ? h('span.toast-ico.spin', { 'aria-hidden': 'true' }) : h('span.toast-ico', TOAST_ICON[k]),
    h('div.toast-body',
      h('span.toast-msg', message),
      ...detail.map((d) => h('div.toast-detail', d)),
      meta ? h('div.toast-meta', meta) : null),
    h('button.toast-x', { type: 'button', title: 'Close', 'aria-label': 'Close notification',
      onclick: (e) => { e.stopPropagation(); dismiss(el); } }, '×'),
  ];

  // Replacing in place rather than removing and appending: a toast that vanishes and
  // reappears at the bottom reads as two events, which is exactly what this avoids.
  // A card already fading out is finished with: take it away now and show a fresh one,
  // or its pending removal would take the new one with it.
  if (key) toastWrap.querySelectorAll(`[data-toast-key="${CSS_ESCAPE(key)}"].out`).forEach((x) => x.remove());
  let el = key ? toastWrap.querySelector(`[data-toast-key="${CSS_ESCAPE(key)}"]`) : null;
  if (el) {
    clearTimeout(Number(el.dataset.timer));
    el.className = `toast ${k}${detail.length || meta ? ' rich' : ''}`;
    el.replaceChildren(...content());
  } else {
    el = h(`div.toast.${k}${detail.length || meta ? '.rich' : ''}`, ...content());
    if (key) el.dataset.toastKey = key;
    toastWrap.append(el);
    // Over the cap the oldest finished notice goes; a task still running keeps its card.
    while (toastWrap.children.length > MAX_TOASTS) {
      const old = [...toastWrap.children].find((x) => !x.classList.contains('run'));
      if (!old) break;
      old.remove();
    }
  }
  // A running task shows for five seconds and then waits in the bell; a progress tick
  // does not restart that clock. A failure is the one worth reading: at least six seconds.
  if (!(opts.silent && k === 'run')) {
    const hold = k === 'run' ? RUNNING_SHOWN_MS : k === 'err' ? Math.max(ms || 0, 6000) : (ms || 2600);
    const timer = setTimeout(() => dismiss(el), hold);
    el.dataset.timer = String(timer);
  }
  return el;
}

/** How long a task that is still running stays on screen before it goes to the bell. */
export const RUNNING_SHOWN_MS = 5000;

function dismiss(el) {
  if (!el || !el.isConnected) return;
  clearTimeout(Number(el.dataset.timer));
  el.classList.add('out');
  setTimeout(() => el.remove(), 300);
}

const TOAST_ICON = { ok: '✓', err: '✕', warn: '!', run: '' };

/**
 * Green for done, red for failed, blue for still running. A timeout is a failure whatever
 * the caller called it — amber is kept for "cannot do that here", a warning, not a result.
 */
export function toastKind(kind, message = '') {
  if (kind === 'run') return 'run';
  const k = kind === 'error' || kind === 'fail' ? 'err' : (kind === 'warn' || kind === 'err' ? kind : 'ok');
  if (k !== 'err' && /\btime(d)?[\s-]?out\b|\bfailed\b|\bcould not\b/i.test(String(message))) return 'err';
  return k;
}

/**
 * Top right, just under the pinned header — measured, because the header is one row on a
 * wide window and two when the tabs wrap.
 */
function placeToasts() {
  const head = document.querySelector('.head-fix');
  const bottom = head ? Math.max(0, Math.round(head.getBoundingClientRect().bottom)) : 0;
  toastWrap.style.top = `${bottom + 12}px`;
}

/* ----------------------------- notification history ----------------------------- */

/**
 * Every notice, kept after it fades: a toast is gone in three seconds and the one you
 * needed was the one you looked away from. The last HISTORY_MAX, newest first, kept in
 * this browser (localStorage) so a reload does not lose them; a keyed notice that repeats
 * (Run pressed four times) updates its entry instead of adding four.
 */
const HISTORY_MAX = 50;
const HISTORY_KEY = 'elasticpro.notifications';
let history = loadHistory();
let unread = history.filter((n) => !n.read).length;
let bell = null;

function loadHistory() {
  try { const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}
function saveHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) { /* private window: memory only */ }
}

/** A progress tick: the task's bell entry changes in place, nothing becomes unread. */
function touch(key, message, kind, detail = [], meta = '', cluster = '') {
  const e = key ? history.find((n) => n.key === key) : null;
  if (!e) return;
  Object.assign(e, { message: String(message), kind, detail: detail.length ? detail : undefined, meta: meta || undefined });
  if (cluster) e.cluster = cluster;
  saveHistory();
  // A tick goes to the core only when it changes what kind of notice this is.
  if (storeOn() && shouldSend(key, kind, true)) sendQuietly(toPut(e));
}

function remember(message, kind, key, detail = [], meta = '', cluster = '') {
  const at = Date.now();
  const same = key ? history.find((n) => n.key === key) : null;
  const entry = { message: String(message), kind, at, key: key || undefined, id: key || newId(at), read: false,
                  detail: detail.length ? detail : undefined, meta: meta || undefined, cluster: cluster || undefined };
  history = [entry, ...history.filter((n) => n !== same)].slice(0, HISTORY_MAX);
  unread = history.filter((n) => !n.read).length;
  saveHistory();
  paintBell();
  if (storeOn() && shouldSend(entry.id, kind, false)) sendQuietly(toPut(entry));
}

/* ---------------------- the core's copy (PING says notifyStore) ---------------------- */

/**
 * Where the history is also kept, when the core keeps one: `{ send(msg) → Promise,
 * active?() → bool, days? }`. Set by the app once PING has said so; left null by an older
 * core, a snapshot file and a render from disk, and then the bell is local only.
 */
let sink = null;
const shouldSend = sendRule();
/** Records fetched from the core for the open bell, and whether there are older ones. */
let fetched = [];
let fetchedMore = false;
let fetchGen = 0;
/** Records the core returns per page. */
export const SERVER_PAGE = 50;

export function setNotificationSink(s) {
  sink = s && typeof s.send === 'function' ? s : null;
  fetched = []; fetchedMore = false; fetchGen++;
}

function storeOn() {
  try { return !!sink && (!sink.active || sink.active()); } catch (_) { return false; }
}

/** Fire and forget: the notice has already been shown, and a lost copy is not an error. */
function sendQuietly(msg) {
  try {
    const p = sink.send(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return p;
  } catch (_) { return null; }
}

/** Ask the core for a page of history; `older` continues past what is already shown. */
async function loadServer(older = false) {
  if (!storeOn()) return false;
  const gen = fetchGen;
  const msg = { type: 'NOTIFY_LIST', limit: SERVER_PAGE };
  if (older && fetched.length) msg.before = Math.min(...fetched.map((r) => Number(r.at) || 0));
  let res;
  try { res = await sink.send(msg); } catch (_) { return false; }
  if (gen !== fetchGen || !res || res.ok !== true || !Array.isArray(res.items)) return false;
  const seen = new Set(fetched.map((r) => r.id));
  fetched = older ? [...fetched, ...res.items.filter((r) => !seen.has(r.id))] : res.items.slice();
  fetchedMore = !!res.more;
  return true;
}

/** What the open bell lists: this browser's notices and the core's, one per key. */
export function notificationsShown() {
  return fetched.length ? mergeNotifications(history, fetched) : history.slice();
}

/** The notices so far, newest first. */
export function notifications() { return history.slice(); }

export function clearNotifications() {
  history = []; unread = 0; saveHistory(); paintBell();
  fetched = []; fetchedMore = false; fetchGen++;
  if (storeOn()) sendQuietly({ type: 'NOTIFY_CLEAR' });
}

function markRead() {
  if (!unread) return;
  history = history.map((n) => ({ ...n, read: true })); unread = 0; saveHistory(); paintBell();
}

function paintBell() {
  if (!bell) return;
  const badge = bell.querySelector('.bell-count');
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = !unread;
  bell.title = unread ? `${unread} new notification${unread === 1 ? '' : 's'}` : 'Notifications';
}

function agoShort(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} m ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleString();
}

/**
 * The bell in the top bar. One element for the life of the page, so redrawing the top bar
 * keeps it (and its count) rather than building a new one each time.
 */
export function notificationBell() {
  if (bell) return bell;
  bell = h('button.btn.sm.ghost.bell', {
    'aria-label': 'Notifications',
    onclick: () => {
      const server = storeOn();
      const ctx = popover(bell, (c) => {
        const list = notificationsShown();
        if (!list.length) return h('div.muted', { style: { fontSize: '12px', padding: '6px 2px' } }, 'No notifications yet.');
        return h('div.notif-list',
          ...list.map((n) => h(`div.notif.${n.kind}`,
            n.kind === 'run' ? h('span.toast-ico.spin') : h('span.toast-ico', { ok: '✓', err: '✕', warn: '!' }[n.kind] || '•'),
            h('div.notif-body', h('div.notif-msg', n.message),
              ...(n.detail || []).map((d) => h('div.notif-detail', d)),
              h('div.notif-at', [n.meta, agoShort(n.at)].filter(Boolean).join(' · '))))),
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '6px', paddingTop: '4px' } },
            server && fetchedMore
              ? h('button.btn.sm', { onclick: async () => { if (await loadServer(true)) c.rebuild(); } }, 'Load more')
              : null,
            h('button.btn.sm', { onclick: () => { clearNotifications(); c.rebuild(); } }, 'Clear all')));
      }, { title: 'Notifications', width: '380px',
        sub: server ? `last ${(sink && sink.days) || 30} days` : `last ${HISTORY_MAX}, this browser` });
      markRead();
      // The local list shows at once; the core's copy fills in when it answers.
      if (ctx && server) loadServer(false).then((ok) => { if (ok && openPop && openPop.trigger === bell) ctx.rebuild(); });
    },
  }, h('span.bell-ico', { 'aria-hidden': 'true' }, '🔔'), h('span.bell-count', { hidden: true }, '0'));
  paintBell();
  return bell;
}

/** Attribute selectors need quoting; CSS.escape is not everywhere (jsdom has none). */
function CSS_ESCAPE(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}
