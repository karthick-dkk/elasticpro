/**
 * Theme completeness.
 *
 * A theme is a set of tokens, and the failure mode is silent: miss one and that single
 * value falls back to the light palette, so a dark screen gets one white card, or one
 * unreadable pill, and it is found by somebody using the app rather than by a test.
 * Comparing token sets catches it before it ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const css = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');

/** The custom properties declared in one selector's block. */
function tokensIn(selector) {
  const i = css.indexOf(selector);
  assert.ok(i >= 0, `no ${selector} block in app.css`);
  const j = css.indexOf('}', i);
  return new Set([...css.slice(i, j).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/**
 * Deliberately not themed: geometry, font stacks, and the status FILL colours, which are
 * the colour of the thing itself and are tuned to read on either ground.
 */
const UNTHEMED = ['--radius', '--radius-sm', '--mono', '--sans',
                  '--good', '--warning', '--serious', '--critical'];

const root = tokensIn(':root {');
const DARK_THEMES = [':root[data-theme="dark"] {', ':root[data-theme="dark-blue"] {',
                     ':root[data-theme="warm"] {'];

test('the light palette defines the untheme-able tokens too', () => {
  for (const t of UNTHEMED) assert.ok(root.has(t), `:root is missing ${t}`);
});

for (const sel of DARK_THEMES) {
  test(`${sel.trim()} themes every token that needs theming`, () => {
    const theme = tokensIn(sel);
    const needed = [...root].filter((t) => !UNTHEMED.includes(t));
    const missing = needed.filter((t) => !theme.has(t));
    assert.deepEqual(missing, [],
      `${sel} falls back to the light value for: ${missing.join(', ')}`);
  });

  test(`${sel.trim()} invents no token the rest of the app does not know`, () => {
    const extra = [...tokensIn(sel)].filter((t) => !root.has(t));
    assert.deepEqual(extra, [], `${sel} declares ${extra.join(', ')}, which nothing reads`);
  });

  test(`${sel.trim()} declares its colour-scheme so form controls follow`, () => {
    const i = css.indexOf(sel);
    const body = css.slice(i, css.indexOf('}', i));
    assert.match(body, /color-scheme:\s*dark/, `${sel} must tell the browser it is dark`);
  });
}

test('every theme the button offers has a stylesheet block', () => {
  const app = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  const block = app.slice(app.indexOf('const THEMES = ['), app.indexOf('];', app.indexOf('const THEMES = [')));
  const ids = [...block.matchAll(/id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 4, `only found ${ids.length} themes in the cycle`);
  assert.ok(ids.includes('system'), 'system must stay in the cycle');
  for (const id of ids) {
    if (id === 'system') continue;   // system stamps no attribute; it is the OS default
    if (id === 'light') { assert.ok(css.includes(':root {'), 'light lives on bare :root'); continue; }
    assert.ok(css.includes(`:root[data-theme="${id}"]`),
      `the button offers "${id}" but app.css has no block for it`);
  }
});

/* ---------------------- colour that escapes the token system ---------------------- */

/**
 * A label sitting on the accent has to be themed.
 *
 * `.btn.primary` hard-coded `color: #fff`, which meant the one control the eye is
 * supposed to land on was the one colour no theme could touch. White on the accent
 * measured 4.42:1 in light, 3.64:1 in dark and 2.74:1 on the dark-blue accent — all
 * below AA, and invisible to a token-parity check because the value was never a token.
 */
test('the primary button takes its label colour from a token', () => {
  const rule = css.slice(css.indexOf('.btn.primary {'), css.indexOf('}', css.indexOf('.btn.primary {')));
  assert.match(rule, /color:\s*var\(--on-accent\)/,
    '.btn.primary must not hard-code its label colour');
  assert.ok(!/color:\s*#/.test(rule), `.btn.primary still carries a literal colour: ${rule}`);
});

/**
 * Every theme must clear WCAG AA for a label on its own accent.
 *
 * Whether white or near-black wins depends entirely on how light that theme's accent is,
 * which is exactly why it is a token and not a constant.
 */
test('a label on the accent clears AA in every theme', () => {
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const valueIn = (sel, token) => {
    const i = css.indexOf(sel);
    const body = css.slice(i, css.indexOf('}', i));
    const m = body.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{6})`));
    assert.ok(m, `${sel} does not define ${token}`);
    return m[1];
  };
  for (const sel of [':root {', ...DARK_THEMES]) {
    const r = ratio(valueIn(sel, '--on-accent'), valueIn(sel, '--accent'));
    assert.ok(r >= 4.5,
      `${sel.trim()} renders its primary button label at ${r.toFixed(2)}:1, under the 4.5:1 AA floor`);
  }
});

/** The accent is also link text on a card, which is the other place it has to hold up. */
test('the accent clears AA as text on its own card surface', () => {
  const lum = (hex) => {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const valueIn = (sel, token) => {
    const i = css.indexOf(sel);
    const body = css.slice(i, css.indexOf('}', i));
    return (body.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{6})`)) || [])[1];
  };
  for (const sel of [':root {', ...DARK_THEMES]) {
    const r = ratio(valueIn(sel, '--accent'), valueIn(sel, '--surface-1'));
    assert.ok(r >= 4.5, `${sel.trim()} renders links at ${r.toFixed(2)}:1 on a card, under AA`);
  }
});

/* ------------------------- the app does not advertise ghosts ------------------------- */

/**
 * A shortcut the app lists but does not implement.
 *
 * The number keys that jumped between pages were removed on purpose, and the Config
 * page went on offering them. Documentation drifting from behaviour is invisible to
 * every other check here, because both halves are individually fine.
 */
test('the keyboard hints name only shortcuts that exist', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'ui/js/pages/settings.js'), 'utf8');
  const hint = settings.slice(settings.indexOf("h('b', 'Keyboard: ')"));
  const line = hint.slice(0, hint.indexOf('),\n'));

  const claimsDigits = /switch pages/.test(line);
  const handlesDigits = /e\.key\s*>=\s*'1'|Number\(e\.key\)|\/\^\[1-9\]\$\//.test(appJs);
  assert.equal(claimsDigits, handlesDigits,
    claimsDigits
      ? 'the Config page offers number-key page switching, which app.js does not implement'
      : 'app.js implements number-key switching that the Config page no longer mentions');
});
