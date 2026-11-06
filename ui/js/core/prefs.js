/**
 * "Your settings", kept with the account — the glue between core/prefs-rules.js (the rules),
 * the bridge (PREFS_GET / PREFS_SET; docs/HANDBOOK.md "Your settings") and IndexedDB (the
 * browser's own copy, which is the fallback when the core has no answer: an older core, a
 * snapshot file, a file:// render).
 *
 *   const p = await loadPrefs();          // {menu, theme, opensOn, source, supported}
 *   await savePref('theme', 'warm');      // the account when supported; the browser copy always
 *
 * The migration is one PREFS_SET on the first load that finds the account without a value
 * the browser has (the theme a person chose before 0.3.55) — see migrationPatch.
 */

import { bridge } from './transport.js';
import { idb } from '../lib/idb.js';
import { KEYS, readAnswer, effective, migrationPatch, changePatch } from './prefs-rules.js';

/** The IndexedDB key for each setting. `theme` is the one that already existed. */
const IDB_KEYS = { menu: 'menu', theme: 'theme', opensOn: 'opensOn' };

let account = { supported: null, prefs: null };

async function browserCopy() {
  const out = {};
  for (const k of KEYS) {
    try { out[k] = await idb.getKV(IDB_KEYS[k]); } catch { out[k] = null; }
  }
  return out;
}

async function ask(msg) {
  try { return await bridge(msg); } catch { return null; }
}

/** Whether the core keeps these with the account (null until loadPrefs has asked). */
export function prefsSupported() {
  return account.supported;
}

/**
 * Read the account's settings (falling back to the browser's), carry the browser's over to
 * the account once, and return what to apply.
 */
/**
 * Set in this browser once the hand-over has been done for the first account the browser met
 * on a core that keeps settings: a second person on the same browser starts from their own
 * account, not from the first person's choices (migrationPatch).
 */
const MIGRATED_KEY = 'prefsMigrated';

export async function loadPrefs() {
  const browser = await browserCopy();
  account = readAnswer(await ask({ type: 'PREFS_GET' }));
  if (account.supported) {
    let migrated = false;
    try { migrated = (await idb.getKV(MIGRATED_KEY)) === true; } catch { migrated = false; }
    const patch = migrationPatch(account.prefs, browser, { migrated });
    if (patch) {
      const moved = readAnswer(await ask({ type: 'PREFS_SET', prefs: patch }));
      if (moved.supported) account = moved;
    }
    if (!migrated) { try { await idb.setKV(MIGRATED_KEY, true); } catch { /* memory only: asked again next time */ } }
  }
  return { ...effective(account.prefs, browser), supported: account.supported === true };
}

/**
 * One change from the panel. Saved to the account when the core keeps them (the answer is
 * the account's new state), and always to the browser's copy, which is what an older core
 * or an offline render reads. Throws on a value the core would refuse.
 */
export async function savePref(key, value) {
  const patch = changePatch(key, value);
  try { await idb.setKV(IDB_KEYS[key], value); } catch { /* the account copy still stands */ }
  if (account.supported) {
    const res = readAnswer(await ask({ type: 'PREFS_SET', prefs: patch }));
    if (res.supported) account = res;
  }
  return { ...effective(account.prefs, await browserCopy()), supported: account.supported === true };
}
