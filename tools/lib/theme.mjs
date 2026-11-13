/**
 * Run a Playwright page in one of the app's themes — one definition, for contrast-check.mjs and
 * fit-check.mjs (--theme), so the two cannot disagree about what "Dark blue" means to a check.
 *
 * The themes are ui/js/core/prefs-rules.js THEMES. "system" follows the OS, so it is run twice:
 * system-light (no data-theme, light colour scheme) and system-dark (no data-theme, dark scheme),
 * because the dark tokens live in a media query as well as under [data-theme="dark"].
 *
 * The app paints the theme it reads from IndexedDB and the account (app.js applyTheme). A check
 * must not depend on either, so an init script pins the attribute: whatever the app sets, it is
 * set back.
 */

export const THEME_RUNS = Object.freeze({
  light: { attr: 'light', scheme: 'light' },
  dark: { attr: 'dark', scheme: 'light' },
  'dark-blue': { attr: 'dark-blue', scheme: 'light' },
  warm: { attr: 'warm', scheme: 'light' },
  'system-light': { attr: null, scheme: 'light' },
  'system-dark': { attr: null, scheme: 'dark' },
});

export const ALL_THEMES = Object.keys(THEME_RUNS);

/** Context options for a theme: the OS colour scheme it is seen under. */
export function themeContextOptions(name) {
  const t = THEME_RUNS[name];
  if (!t) throw new Error(`unknown theme "${name}" (one of ${ALL_THEMES.join(', ')})`);
  return { colorScheme: t.scheme };
}

/** Pin the theme for every page and frame of `ctx`. */
export async function pinTheme(ctx, name) {
  const t = THEME_RUNS[name];
  if (!t) throw new Error(`unknown theme "${name}" (one of ${ALL_THEMES.join(', ')})`);
  await ctx.addInitScript((attr) => {
    const fix = () => {
      const de = document.documentElement;
      if (!de) return;
      if (attr === null) { if (de.hasAttribute('data-theme')) de.removeAttribute('data-theme'); }
      else if (de.getAttribute('data-theme') !== attr) de.setAttribute('data-theme', attr);
    };
    fix();
    new MutationObserver(fix).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-theme'] });
    document.addEventListener('DOMContentLoaded', fix);
  }, t.attr);
}
