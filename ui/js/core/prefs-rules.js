/**
 * "Your settings" — page menu position, theme, what the app opens on — as plain rules, no
 * DOM and no transport (core/prefs.js is the glue; tools/unit/prefs-rules.test.mjs holds these).
 *
 * The core keeps them with the account (PREFS_GET / PREFS_SET, user_prefs.rs) when PING says
 * `userPrefs: true`. A value the account never set comes back `null`, and this side then uses
 * what the browser had (IndexedDB, where the theme lived until 0.3.55), and only then the
 * shipped default. Unknown is not "system": an account that never chose is not told it chose.
 *
 * Keep the three lists equal to MENUS / THEMES / OPENS_ON in user_prefs.rs (the core refuses
 * anything else, and the test reads both).
 */

export const MENUS = ['top', 'left'];
export const THEMES = ['system', 'light', 'dark', 'dark-blue', 'warm'];
export const OPENS_ON = ['last', 'all'];
export const KEYS = ['menu', 'theme', 'opensOn'];

/** What a person who never chose anything gets. */
export const DEFAULTS = { menu: 'top', theme: 'system', opensOn: 'last' };

const CHOICES = { menu: MENUS, theme: THEMES, opensOn: OPENS_ON };

/** Whether `value` is a spelling the core takes for `key`. */
export function isChoice(key, value) {
  return Array.isArray(CHOICES[key]) && CHOICES[key].includes(value);
}

/**
 * A PREFS_GET / PREFS_SET answer, read defensively: `{supported, prefs}` where `prefs` has
 * every key, `null` where unset or not a known spelling. `supported: false` is an older core
 * (no answer, or one that does not know the message) — the browser keeps its own then.
 */
export function readAnswer(res) {
  if (!res || res.ok !== true || !res.prefs || typeof res.prefs !== 'object') return { supported: false, prefs: null };
  const prefs = {};
  for (const k of KEYS) prefs[k] = isChoice(k, res.prefs[k]) ? res.prefs[k] : null;
  return { supported: true, prefs, user: typeof res.user === 'string' ? res.user : null };
}

/**
 * What to apply, and where each value came from: the account's choice, else the browser's,
 * else the shipped default. `account` is readAnswer().prefs (or null); `browser` is
 * `{menu?, theme?, opensOn?}` from IndexedDB (or null).
 */
export function effective(account, browser) {
  const out = { source: {} };
  for (const k of KEYS) {
    const a = account && isChoice(k, account[k]) ? account[k] : null;
    const b = browser && isChoice(k, browser[k]) ? browser[k] : null;
    out[k] = a ?? b ?? DEFAULTS[k];
    out.source[k] = a !== null ? 'account' : b !== null ? 'browser' : 'default';
  }
  return out;
}

/**
 * The one-time hand-over: values the browser had that the account has not — the theme a
 * person chose before 0.3.55 — go to the account, as the first PREFS_SET. `null` when there is
 * nothing to carry over, so nothing is sent. Never overwrites a choice the account already made,
 * and never happens twice from one browser (`migrated`: the browser's flag, set after the first
 * account it met).
 */
export function migrationPatch(account, browser, { migrated = false } = {}) {
  // Once per browser: after the first account it carried over to, the browser's copy is that
  // person's choice too (savePref writes it), and must not become the next person's on a shared
  // browser.
  if (!browser || migrated) return null;
  const patch = {};
  for (const k of KEYS) {
    const has = account && isChoice(k, account[k]);
    if (!has && isChoice(k, browser[k])) patch[k] = browser[k];
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * The patch for one change from the "Your settings" panel: refused here, before it is sent,
 * when the value is not a spelling the core takes. `null` to unset is allowed.
 */
export function changePatch(key, value) {
  if (!KEYS.includes(key)) throw new Error(`no such setting: ${key}`);
  if (value !== null && !isChoice(key, value)) throw new Error(`${key}: "${value}" is not one of ${CHOICES[key].join(', ')}`);
  return { [key]: value };
}
