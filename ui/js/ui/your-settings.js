/**
 * "Your settings" (board 8, LeftMenu.dc.html): the page menu on the Top or on the Left, the
 * theme, and which cluster the app opens on — one person's own choices, opened from their name.
 *
 * Kept with the account where the core keeps them (core/prefs.js, PREFS_GET / PREFS_SET), and
 * always in this browser too; the panel says which is true for this core rather than promising
 * the account to an older one.
 *
 * Applies at once; there is nothing to save. A dialog that closes on Escape or a click outside.
 */

import { h } from '../lib/dom.js';

export const MENU_POSITIONS = Object.freeze([['top', 'Top'], ['left', 'Left']]);
/** core/prefs-rules.js OPENS_ON, with '' for "not chosen": the config's default for everyone applies. */
export const OPENS_ON = Object.freeze([['', 'As the defaults say (System › Defaults)'], ['last', 'The cluster last chosen in this browser'], ['all', 'All clusters']]);

/** A menu position as stored, made safe: 'top' unless it is exactly 'left'. */
export const normaliseMenuPosition = (v) => (v === 'left' ? 'left' : 'top');

let open = null;

export function closeYourSettings() {
  if (!open) return;
  const { el, off } = open;
  open = null;
  off();
  el.remove();
}

/**
 * Open the panel next to `anchor`.
 *
 *   prefs     {menu, theme, opensOn}   opensOn '' = not chosen
 *   supported whether the core keeps them with the account (else this browser only)
 *   themes    [{id, label}] (app.js THEMES); null hides the theme (inside Zabbix it is Zabbix's)
 *   who       {name, role} or null (no accounts)
 *   onChange  (key, value) => void — applied at once by the shell
 *   onSignOut () => void, or null where signing out is not this app's (inside Zabbix, no accounts)
 */
export function openYourSettings(anchor, { prefs, supported = false, themes, who, onChange, onSignOut }) {
  if (open) { const same = open.anchor === anchor; closeYourSettings(); if (same) return; }
  const seg = h('span.ys-seg', { role: 'group', 'aria-label': 'Page menu position' },
    ...MENU_POSITIONS.map(([id, label]) => h('button', {
      type: 'button', 'aria-pressed': String(prefs.menu === id), dataset: { menu: id },
      onclick: (e) => {
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        onChange('menu', id);
      },
    }, label)));
  const theme = themes ? h('select#ys-theme', { onchange: (e) => onChange('theme', e.target.value) },
    ...themes.map((t) => h('option', { value: t.id, selected: t.id === prefs.theme }, t.label.replace(/^\S+\s/, '')))) : null;
  const opensOn = h('select#ys-open', { onchange: (e) => onChange('opensOn', e.target.value) },
    ...OPENS_ON.map(([v, l]) => h('option', { value: v, selected: v === (prefs.opensOn || '') }, l)));
  const el = h('section.ys-pop', { role: 'dialog', 'aria-labelledby': 'ys-h' },
    h('div.ys-head', h('h2#ys-h', 'Your settings'), h('span.muted', who ? `${who.name} · ${who.role}` : 'only for you')),
    h('div.ys-body',
      h('div.ys-row', h('span.ys-l', 'Page menu'), seg,
        h('span.ys-hint', 'Left gives the content the full window height. On a narrow window the menu goes back across the top.')),
      theme ? h('label.ys-row', h('span.ys-l', 'Theme'), theme) : null,
      h('label.ys-row', h('span.ys-l', 'Opens on'), opensOn)),
    h('div.ys-foot',
      h('span', supported ? 'Kept with your account, so it follows you to any browser. Applies at once; nothing to save.'
        : 'Kept in this browser (this server does not keep them with the account). Applies at once; nothing to save.'),
      onSignOut ? h('button.btn.sm', { type: 'button', onclick: () => { closeYourSettings(); onSignOut(); } }, '⏻ Sign out') : null));
  document.body.append(el);
  // Under the name in the top bar; above it when the name is at the foot of the left menu.
  const r = anchor.getBoundingClientRect();
  const w = 340;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  if (r.top > window.innerHeight / 2) { el.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`; el.style.left = `${Math.max(8, r.left)}px`; }
  else { el.style.top = `${r.bottom + 6}px`; el.style.left = `${left}px`; }
  const onDown = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeYourSettings(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeYourSettings(); anchor.focus(); } };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  open = { el, anchor, off: () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onKey, true); } };
  const first = el.querySelector('button[aria-pressed="true"]') || el.querySelector('button, select');
  if (first) first.focus();
  return el;
}
