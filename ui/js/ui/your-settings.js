/**
 * "Your settings" (board 8, LeftMenu.dc.html): the page menu on the Left (default) or on the Top,
 * the theme, and which cluster the app opens on — one person's own choices, opened from their name.
 * Icons only since 0.3.72 (the owner): the names are in the buttons' titles and labels.
 *
 * Kept with the account where the core keeps them (core/prefs.js, PREFS_GET / PREFS_SET), and
 * always in this browser too; the panel says which is true for this core rather than promising
 * the account to an older one.
 *
 * Applies at once; there is nothing to save. A dialog that closes on Escape or a click outside.
 */

import { h } from '../lib/dom.js';

export const MENU_POSITIONS = Object.freeze([['left', 'Left'], ['top', 'Top']]);
/** The menu buttons' pictures: a bar down the left, a bar across the top (names in title + aria-label). */
const MENU_ICON = {
  left: '<svg aria-hidden="true" width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="16" height="14" rx="2"/><rect x="1" y="1" width="5" height="14" rx="1.5" fill="currentColor" stroke="none"/></svg>',
  top: '<svg aria-hidden="true" width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="16" height="14" rx="2"/><rect x="1" y="1" width="16" height="4" rx="1.5" fill="currentColor" stroke="none"/></svg>',
};
/** core/prefs-rules.js OPENS_ON, with '' for "not chosen": the config's default for everyone applies. */
export const OPENS_ON = Object.freeze([['', 'Default'], ['last', 'Last cluster chosen'], ['all', 'All clusters']]);

/** A menu position as stored, made safe: the left menu unless it is exactly 'top' (the owner, 0.3.72: left by default). */
export const normaliseMenuPosition = (v) => (v === 'top' ? 'top' : 'left');

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
 *   menus     false hides the menu position (inside Zabbix the menu is always across the top)
 *   who       {name, role} or null (no accounts)
 *   onChange  (key, value) => void — applied at once by the shell
 *   onSignOut () => void, or null where signing out is not this app's (inside Zabbix, no accounts)
 */
export function openYourSettings(anchor, { prefs, supported = false, themes, menus = true, who, onChange, onSignOut }) {
  if (open) { const same = open.anchor === anchor; closeYourSettings(); if (same) return; }
  // Icons only (the owner, 0.3.72): every choice is a picture with its name in title and aria-label.
  const pick = (group, key, value) => (e) => {
    for (const b of group.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
    onChange(key, value);
  };
  const seg = h('span.ys-seg', { role: 'group', 'aria-label': 'Page menu' });
  for (const [id, label] of MENU_POSITIONS) {
    const b = h('button', { type: 'button', 'aria-pressed': String(prefs.menu === id), dataset: { menu: id }, title: `Menu on the ${label.toLowerCase()}`, 'aria-label': `Menu on the ${label.toLowerCase()}`, onclick: pick(seg, 'menu', id) });
    b.innerHTML = MENU_ICON[id];
    seg.append(b);
  }
  // A theme's label is "<glyph> <name>" (app.js THEMES): the glyph is the button, the name its title.
  const theme = themes ? h('span.ys-seg#ys-theme', { role: 'group', 'aria-label': 'Theme' }) : null;
  if (theme) {
    for (const t of themes) {
      const [glyph, ...name] = t.label.split(' ');
      theme.append(h('button', { type: 'button', 'aria-pressed': String(t.id === prefs.theme), dataset: { theme: t.id }, title: name.join(' '), 'aria-label': name.join(' '),
        onclick: pick(theme, 'theme', t.id) }, glyph));
    }
  }
  const opensOn = h('select#ys-open', { 'aria-label': 'Opens on', title: 'Which cluster the app opens on', onchange: (e) => onChange('opensOn', e.target.value) },
    ...OPENS_ON.map(([v, l]) => h('option', { value: v, selected: v === (prefs.opensOn || '') }, l)));
  const el = h('section.ys-pop', { role: 'dialog', 'aria-labelledby': 'ys-h', title: supported ? 'Kept with your account' : 'Kept in this browser' },
    h('div.ys-head', h('h2#ys-h', 'Your settings'), h('span.muted', who ? `${who.name} · ${who.role}` : '')),
    h('div.ys-body',
      menus || theme ? h('div.ys-row.ys-line', menus ? seg : null, theme) : null,
      h('label.ys-row', opensOn)),
    onSignOut ? h('div.ys-foot', h('button.btn.sm', { type: 'button', title: 'Sign out', onclick: () => { closeYourSettings(); onSignOut(); } }, '⏻ Sign out')) : null);
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
