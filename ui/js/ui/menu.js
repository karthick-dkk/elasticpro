/**
 * Row action menu.
 *
 * Destructive actions used to sit in the row as plain buttons, one mis-click away from
 * deleting an index or a snapshot. They live behind this now: the row keeps the safe,
 * frequent actions, and everything that changes or removes something is a deliberate
 * two-step — open the menu, then confirm.
 */

import { h, mount } from '../lib/dom.js';
import { mergeNotifications, newId, sendRule, serverId, toPut } from '../lib/notify-history.js';

let open = null;   // the popup currently on screen, if any

/**
 * When somebody last tried to scroll the PAGE: a wheel, a touch or a key aimed anywhere
 * but at a floating panel. A `scroll` event alone cannot say — see closeOnOuterScroll.
 */
let lastPageScrollInput = 0;
if (typeof window !== 'undefined') {
  for (const ev of ['wheel', 'touchmove', 'keydown']) {
    window.addEventListener(ev, (e) => {
      const t = e.target;
      if (t instanceof Node && ((open && open.el.contains(t)) || (openPop && openPop.el.contains(t)))) return;
      lastPageScrollInput = Date.now();
    }, { capture: true, passive: true });
  }
}

/**
 * A scroll listener that closes a floating panel when the PAGE scrolls — the panel would
 * otherwise float away from what it is anchored to — but not for the two scrolls nobody
 * asked the page for:
 *
 * - The panel's own. The listener is in the capture phase, which hears scrolling anywhere,
 *   its own list included: a long bell or notes list closed on the first wheel tick, so it
 *   could never be scrolled at all ("cannot mouse-scroll the alerts").
 * - The browser's. When a refresh makes the document taller or shorter it adjusts the
 *   offset itself (scroll anchoring, clamping) and fires the very same `scroll` event with
 *   nobody at the wheel; a notes popover someone was reading shut under them. With no
 *   scrolling input just before it, the panel stays as long as its anchor stayed put.
 */
function closeOnOuterScroll(getEl, closeFn, trigger) {
  const at = trigger.getBoundingClientRect();
  return (e) => {
    const el = getEl();
    if (el && e.target instanceof Node && el.contains(e.target)) return;
    if (Date.now() - lastPageScrollInput > 800) {
      const now = trigger.getBoundingClientRect();
      if (trigger.isConnected && Math.abs(now.top - at.top) < 2 && Math.abs(now.left - at.left) < 2) return;
    }
    closeFn();
  };
}

/**
 * Keep the wheel inside a floating panel. A list in the panel scrolls as far as it goes;
 * past its end, or over a panel with nothing to scroll, the wheel stops there instead of
 * scrolling the page underneath. WebKit chains a wheel over a panel that does not scroll
 * straight to the page (overscroll-behavior only holds on a box that can scroll), which
 * moved the page, moved the panel's anchor, and closed the panel under the pointer.
 */
function keepWheel(el) {
  el.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      for (let n = e.target instanceof Element ? e.target : null; n; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) {
          const can = e.deltaY < 0 ? n.scrollTop > 0 : n.scrollTop + n.clientHeight < n.scrollHeight - 1;
          if (can) return;
        }
        if (n === el) break;
      }
    }
    e.preventDefault();
  }, { passive: false });
}

function close() {
  if (!open) return;
  open.el.remove();
  open.trigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', open.away, true);
  document.removeEventListener('keydown', open.key, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('scroll', open.onScroll, true);
  open = null;
}

export function closeMenus() { close(); }

/**
 * @param items  [{ label, icon, onClick, danger, disabled, title, sep, hint, note }]
 *               `sep: true` draws a divider; `hint` is a line of muted text; `note` is a
 *               quiet word at the end of an item's line (where it leads, say).
 * @param opts   { label, title, trigger, menuLabel } — `label` is the trigger's content
 *               (default '⋮', a node is fine); `trigger` its tag and classes (default
 *               'button.btn.sm.menu-trigger'); `menuLabel` names the menu for a reader.
 *               `items` may be a function, called each time the menu opens.
 */
export function rowMenu(items, opts = {}) {
  const trigger = h(opts.trigger || 'button.btn.sm.menu-trigger', {
    type: 'button',
    title: opts.title || 'More actions',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    onclick: (e) => {
      e.stopPropagation();
      const wasOpen = open && open.trigger === trigger;
      close();
      if (wasOpen) return;             // clicking the same trigger closes it
      show(trigger, typeof items === 'function' ? items() : items, opts);
    },
  }, opts.label || '⋮');
  return trigger;
}

function show(trigger, items, opts = {}) {
  const el = h('div.menu-pop', { role: 'menu', 'aria-label': opts.menuLabel || null });

  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div.sep')); continue; }
    if (it.hint) { el.append(h('div.hint', it.hint)); continue; }
    el.append(h(`button${it.danger ? '.danger' : ''}`, {
      type: 'button',
      disabled: !!it.disabled,
      title: it.title || '',
      role: 'menuitem',
      onclick: (e) => {
        e.stopPropagation();
        close();
        if (!it.disabled && it.onClick) it.onClick(e);
      },
    }, h('span.ico', { 'aria-hidden': 'true' }, it.icon || ''), h('span', it.label),
       it.note ? h('span.mi-note', it.note) : null));
  }

  document.body.append(el);
  anchorTo(el, trigger);
  keepWheel(el);
  trigger.setAttribute('aria-expanded', 'true');

  const away = (e) => { if (!el.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) close(); };
  // Escape closes and gives the keyboard back to the trigger; the arrows, Home and End
  // walk the items, as in any menu a keyboard user has met before.
  const key = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); close();
      if (trigger.isConnected) trigger.focus();
      return;
    }
    if (!el.contains(document.activeElement)) return;
    const btns = [...el.querySelectorAll('button:not(:disabled)')];
    if (!btns.length) return;
    const at = btns.indexOf(document.activeElement);
    const to = e.key === 'ArrowDown' ? (at + 1) % btns.length
      : e.key === 'ArrowUp' ? (at - 1 + btns.length) % btns.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? btns.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault(); e.stopPropagation();
    btns[to].focus();
  };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', close);
  const onScroll = closeOnOuterScroll(() => el, close, trigger);
  window.addEventListener('scroll', onScroll, true);

  open = { el, trigger, away, key, onScroll };
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
  const { el, away, key, onClose, onScroll, trigger } = openPop;
  el.remove();
  if (trigger.hasAttribute('aria-expanded')) trigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', away, true);
  document.removeEventListener('keydown', key, true);
  window.removeEventListener('resize', closePopover);
  window.removeEventListener('scroll', onScroll, true);
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
 * @param opts     { title, sub, width, onClose, cls } — `cls`: an extra class on the panel
 */
export function popover(trigger, build, opts = {}) {
  const already = openPop && openPop.trigger === trigger;
  closePopover();
  closeMenus();
  if (already) return null;   // clicking the same trigger again closes it

  const el = h(opts.cls ? `div.pop.${opts.cls}` : 'div.pop', {
    role: 'dialog', 'aria-label': opts.title || null,
    style: opts.width ? { minWidth: opts.width } : null,
  });
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
  keepWheel(el);

  const away = (e) => { if (!el.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) closePopover(); };
  // A field inside the panel that gives Escape a meaning of its own (an inline rename:
  // Escape cancels the edit) is marked data-own-escape, and keeps it.
  const key = (e) => {
    if (e.key !== 'Escape') return;
    if (e.target instanceof Element && e.target.closest('[data-own-escape]')) return;
    e.stopPropagation(); closePopover();
  };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', closePopover);
  const onScroll = closeOnOuterScroll(() => el, closePopover, trigger);
  window.addEventListener('scroll', onScroll, true);

  openPop = { el, trigger, away, key, onClose: opts.onClose, onScroll };
  // A trigger that says it opens something (aria-haspopup) also says whether it is open.
  if (trigger.hasAttribute('aria-haspopup')) trigger.setAttribute('aria-expanded', 'true');
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
const TOAST_DETAIL_LINES = 3;

export function toast(message, kind = 'ok', ms = 2600, opts = {}) {
  // A redraw of the page must never take the notices with it: a wrapper that has been
  // detached still accepts toasts, it just shows none of them.
  if (!toastWrap || !toastWrap.isConnected) {
    toastWrap = h('div.toast-wrap', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastWrap);
  }
  const k = toastKind(kind, message);
  const key = opts.key || null;
  const detail = [].concat(opts.detail || []).filter(Boolean).map(String);
  const meta = opts.meta ? String(opts.meta) : '';
  const cluster = opts.cluster ? String(opts.cluster) : '';
  // A task's progress ticks are not new notifications: they update its bell entry in
  // place, and its card only if that card is still on screen — a running task shows for
  // five seconds, then lives in the bell until it finishes and shows again.
  // bellOnly: for an entry that belongs in the bell but would be a wall on screen (one per
  // cluster when a dozen clusters raise alerts at once). noHistory: the opposite — a card
  // that summarises entries the bell already has.
  if (opts.bellOnly) { remember(message, k, key, detail, meta, cluster); return null; }
  if (opts.silent) {
    touch(key, message, k, detail, meta, cluster);
    const live = key ? toastWrap.querySelector(`[data-toast-key="${CSS_ESCAPE(key)}"]:not(.out)`) : null;
    if (!live) return null;
  } else if (!opts.noHistory) {
    remember(message, k, key, detail, meta, cluster);
  }

  const content = () => [
    k === 'run' ? h('span.toast-ico.spin', { 'aria-hidden': 'true' }) : h('span.toast-ico', TOAST_ICON[k]),
    h('div.toast-body',
      // A notice is read in a glance: three lines of message, three of detail, each clamped
      // in the CSS. The whole text stays in the bell and on hover.
      h('span.toast-msg', { title: String(message) }, message),
      ...detail.slice(0, TOAST_DETAIL_LINES).map((d) => h('div.toast-detail', { title: d }, d)),
      detail.length > TOAST_DETAIL_LINES
        ? h('div.toast-detail.muted', `+${detail.length - TOAST_DETAIL_LINES} more \u2014 open the bell for all of it`) : null,
      meta ? h('div.toast-meta', meta) : null),
    h('button.toast-x', { type: 'button', title: 'Close', 'aria-label': 'Close notification',
      onclick: (e) => { e.stopPropagation(); dismiss(el); } }, '×'),
  ];

  // Replacing in place rather than removing and appending: a toast that vanishes and
  // reappears at the bottom reads as two events, which is exactly what this avoids.
  // A card already fading out is finished with: take it away now and show a fresh one,
  // or its pending removal would take the new one with it.
  if (key) toastWrap.querySelectorAll(`[data-toast-key="${CSS_ESCAPE(key)}"].out`).forEach((x) => x.remove());
  // An unkeyed notice that says exactly what one already on screen says is the same
  // notice again (a poll finding the same thing, a button pressed twice): it refreshes
  // that card rather than stacking a second copy of it.
  const sig = key ? '' : [k, message, meta, detail.join('\n')].join('\u0001');
  let el = key ? toastWrap.querySelector(`[data-toast-key="${CSS_ESCAPE(key)}"]`)
    : [...toastWrap.children].find((x) => x.dataset.toastSig === sig && !x.classList.contains('out')) || null;
  if (el) {
    clearTimeout(Number(el.dataset.timer));
    el.className = `toast ${k}${detail.length || meta ? ' rich' : ''}`;
    el.replaceChildren(...content());
  } else {
    el = h(`div.toast.${k}${detail.length || meta ? '.rich' : ''}`, ...content());
    if (key) el.dataset.toastKey = key;
    else el.dataset.toastSig = sig;
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

/**
 * Take every card off the screen at once. They stay in the bell: this clears the view, not
 * the history. For a page about to be photographed (core/evidence.js).
 */
export function dismissToasts() {
  if (!toastWrap || !toastWrap.isConnected) return;
  for (const el of [...toastWrap.children]) el.remove();
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
  if (key) retired.delete(serverId({ key }));   // said again on purpose: it belongs in the bell
  // The same notice again is one entry with a count and a new time, not a second line:
  // by key when it has one, else by saying exactly the same thing. Without this a poll
  // that finds the same fact every cycle fills the 50-entry history with one sentence and
  // pushes out everything else worth reading.
  const sameText = (n) => !n.key && n.message === String(message) && n.kind === kind
    && (n.meta || '') === meta && (n.cluster || '') === cluster
    && (n.detail || []).join('\n') === detail.join('\n');
  const same = key ? history.find((n) => n.key === key) : history.find(sameText) || null;
  const entry = { message: String(message), kind, at, key: key || undefined, id: key || (same && same.id) || newId(at), read: false,
                  detail: detail.length ? detail : undefined, meta: meta || undefined, cluster: cluster || undefined,
                  count: !key && same ? (same.count || 1) + 1 : undefined };
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
/**
 * Links under a notice, decided by whoever knows what the notice is about: `fn(entry) →
 * [{ label, page?, run() }]`. The bell only draws them, so it needs to import nothing from
 * the alerts (core/notify.js registers the one for alert bursts).
 */
let noticeActions = null;
export function setNotificationActions(fn) { noticeActions = typeof fn === 'function' ? fn : null; }
function actionsFor(entry) {
  try { return noticeActions ? noticeActions(entry) || [] : []; } catch (_) { return []; }
}

export function notificationsShown() {
  const all = fetched.length ? mergeNotifications(history, fetched) : history.slice();
  return retired.size ? all.filter((n) => !retired.has(serverId(n))) : all;
}

/** The notices so far, newest first. */
export function notifications() { return history.slice(); }

export function clearNotifications() {
  history = []; unread = 0; saveHistory(); paintBell();
  fetched = []; fetchedMore = false; fetchGen++;
  if (storeOn()) sendQuietly({ type: 'NOTIFY_CLEAR' });
}

const retired = new Set();

/**
 * Take a keyed notice out of the bell: for one whose reason has gone (the setting it
 * warned about was changed on purpose), so it does not sit there reading as current.
 * Only this browser's copy; returns whether there was one.
 */
export function dropNotification(key) {
  if (!key) return false;
  // The core's copy (hosted installs keep 30 days) would otherwise come back through the
  // merge when the bell opens; it is hidden for this page's life, and asked again each load.
  retired.add(serverId({ key }));
  if (!history.some((n) => n.key === key)) return false;
  history = history.filter((n) => n.key !== key);
  unread = history.filter((n) => !n.read).length;
  saveHistory(); paintBell();
  return true;
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
              h('div.notif-at', [n.meta, n.count > 1 ? `\u00d7${n.count}, last ${agoShort(n.at)}` : agoShort(n.at)].filter(Boolean).join(' · ')),
              (() => {
                const acts = actionsFor(n);
                return acts.length ? h('div.notif-actions', ...acts.map((a) => h('a', {
                  href: a.page ? `#/${a.page}` : '#',
                  onclick: (e) => { e.preventDefault(); closePopover(); a.run(); },
                }, a.label))) : null;
              })()))),
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
