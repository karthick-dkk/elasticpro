#!/usr/bin/env node
/**
 * Can every theme be read? In Chromium, for each theme the app offers, on the pages that show
 * every pill tone, tables, buttons, links, inputs and muted text: WCAG AA, measured from the
 * colours the browser actually computed.
 *
 *   for i in 0 1 2 3 4; do MOCK_CLUSTER_NAME=mock$i node tools/mock-es.mjs $((9299+i)) & done
 *   ELASTICPRO_DATA_DIR=$(mktemp -d) cargo run -p elasticpro-core --features bridge \
 *     --bin elasticpro-bridge -- ui 8765 &
 *   node tools/contrast-check.mjs --config $PWD/tools/fit-fixture.json
 *   node tools/contrast-check.mjs --themes dark-blue --pages reports/log-delay --list 80
 *
 * Why it exists: Dark blue shipped with the log delay pills drawn in the light theme's inks —
 * dark pink on a pink-tinted navy, dark green on a green-tinted navy — because the .ld inks were
 * re-declared for "dark" and nobody else. A token table read by eye cannot catch that: the
 * colour that reaches the screen is a color-mix() of a theme token, a literal and whatever the
 * pill sits on, and only a real engine computes it.
 *
 * What it measures, per theme (tools/lib/theme.mjs: light, dark, dark-blue, warm, and system
 * under a light and a dark OS):
 *   text      every element with its own text: its colour against the background it sits on —
 *             the stack of backgrounds up to the page, with each ancestor's opacity applied as a
 *             group (an opacity:.75 row fades its text and its background together). 4.5:1;
 *             3:1 at 24px, or 18.66px bold. Split into text, muted (the --text-muted and
 *             --text-secondary inks), link, button, header (th), pill and input text.
 *   pill      the pill against the surface it sits on: its border (drawn over its own fill) or
 *             its fill, whichever stands out more. 3:1, a UI component.
 *   input     a text field's or select's border against what is around it. 3:1.
 *   sticky    a sticky table head has an opaque background, so rows scrolling under it never
 *             show through, and its text passes like any other.
 *   hover     the first row of each table, with the pointer on it.
 *   selected  rows the page marks as chosen: an opened Overview row, a chosen Reports row, an
 *             opened log delay device.
 *   focus     the keyboard focus ring of a button, a field, a tab, a sortable column head and a
 *             link, against what is around it. 3:1.
 *   errors    uncaught errors and console errors on every page in every theme, Play included.
 * Disabled controls are exempt, as WCAG has them. Text over a background image or gradient is
 * counted, not measured.
 *
 * Exit 1 when anything is below AA or a page logs an error. --json writes every sample.
 *
 * Nothing here writes. Needs playwright with chromium (see scroll-check.mjs); exits 0 with a
 * notice when it is absent, like the jsdom checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { logDelayAnswer, logDelayData } from './lib/logdelay-fixture.mjs';
import { ALL_THEMES, pinTheme, themeContextOptions } from './lib/theme.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('--base', 'http://127.0.0.1:8765').replace(/\/$/, '');
const CONFIG = arg('--config', '');
const THEMES = arg('--themes', ALL_THEMES.join(',')).split(',');
const WARM = Number(arg('--warm', '25000'));
const LIST = Number(arg('--list', '40'));
const JSON_OUT = arg('--json', '');
const SIZE = arg('--size', '1440x900').split('x').map(Number);
const ERRORS_ONLY = process.argv.includes('--errors-only');

/** Measured for contrast: between them every pill tone, table, button, link, field and muted line. */
const CONTRAST_PAGES = ['alerts', 'overview', 'indices', 'shards', 'logs', 'console', 'snapshots',
  'reports/overview', 'reports/daily', 'reports/capacity', 'reports/measure', 'reports/planning', 'reports/exports',
  'reports/log-delay', 'reports/log-delay/cluster/@c', 'reports/log-delay/device/@c/@d', 'reports/log-delay/fixes',
  'automation', 'requests', 'accounts', 'settings',
  'settings/clusters/creds', 'settings/zabbix/zabbix', 'settings/alerts/triggers', 'settings/reports/mail',
  'settings/data/schedule', 'settings/system/defaults'];
/** Visited for console errors only. Play is a wall display with its own fixed palette (--tv-*), not a theme. */
const ERROR_ONLY_PAGES = ['settings/clusters/trust', 'settings/requests/policy', 'settings/reports/fields', 'settings/reports/templates',
  'settings/data/backend', 'settings/play/play', 'settings/system/file', 'play'];
const PAGE_FILTER = arg('--pages', '');
const pick = (ids) => ids.filter((id) => !PAGE_FILTER || PAGE_FILTER.split(',').includes(id));

const pw = await loadPlaywright(ROOT, 'contrast-check');
if (!pw) process.exit(0);
try {
  const r = await fetch(`${BASE}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`contrast-check: no bridge at ${BASE} (${e.message})`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ in-page helpers ------------------------------ */
// Installed once per page load as window.__cc; self-contained, because it is passed by value.

const install = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const memo = new Map();
  /** Any computed colour string → {r,g,b,a}, 0..255 and 0..1. */
  const rgba = (s) => {
    if (memo.has(s)) return memo.get(s);
    let v = null;
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
    if (m) v = { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
    if (!v && (m = /^color\(srgb\s+([-\d.e]+)\s+([-\d.e]+)\s+([-\d.e]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s))) {
      v = { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4] };
    }
    if (!v) {   // anything else (oklab, named): let the canvas resolve it
      cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data; v = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    }
    memo.set(s, v); return v;
  };
  const CLEAR = { r: 0, g: 0, b: 0, a: 0 };
  /** Source-over: s painted on d, both straight (not premultiplied) alpha. */
  const over = (s, d) => {
    const a = s.a + d.a * (1 - s.a);
    if (a <= 0) return CLEAR;
    const ch = (k) => (s[k] * s.a + d[k] * d.a * (1 - s.a)) / a;
    return { r: ch('r'), g: ch('g'), b: ch('b'), a };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };

  /** html … el, top first. */
  const chainOf = (el) => { const c = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) c.unshift(e); return c; };
  /**
   * What the stack of backgrounds from the page down to `el` paints, with `top` (a text colour,
   * a border) painted last inside `el`. Each element is a group: its own background, then what
   * is inside it, and the whole group faded by its opacity — which is how a browser composites
   * opacity, and why it is not the same as multiplying alphas down the chain.
   */
  const paint = (el, top) => {
    const chain = chainOf(el);
    let image = false;
    const group = (i) => {
      const e = chain[i]; const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') image = true;
      let c = over(rgba(cs.backgroundColor), CLEAR);
      if (i < chain.length - 1) c = over(group(i + 1), c);
      else if (top) c = over(top, c);
      const op = parseFloat(cs.opacity);
      return op < 1 ? { ...c, a: c.a * op } : c;
    };
    return { c: over(group(0), WHITE), image };
  };
  const bgOf = (el) => paint(el, null);

  const styleVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const INKS = ['--text-muted', '--text-secondary'].map((v) => { const s = styleVar(v); return s ? hex(rgba(s)) : ''; }).filter(Boolean);
  const name = (e) => {
    const cls = typeof e.className === 'string' ? e.className.trim().split(/\s+/).filter((c) => !c.startsWith('cc-')).slice(0, 3).join('.') : '';
    return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${cls ? '.' + cls : ''}`;
  };
  const path = (e) => { const p = []; for (let x = e; x && x !== document.body && p.length < 3; x = x.parentElement) p.unshift(name(x)); return p.join(' > '); };
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    // a control faded out until its card is hovered (opacity 0) is not on screen
    let op = 1; for (let x = e; x && x.nodeType === 1; x = x.parentElement) op *= parseFloat(getComputedStyle(x).opacity);
    return op >= 0.1;
  };
  const exempt = (e) => !!e.closest(':disabled, [aria-disabled="true"], fieldset:disabled');
  const PILL = '.pill, .apill, .zr-badge, .pl-pill';

  /** One sample: what, where, the two colours and their ratio, and the bar it must clear. */
  const sample = (kind, e, fg, bg, need, text, extra = {}) => {
    const rt = ratio(fg, bg);
    return { kind, sel: path(e), text: (text || '').trim().replace(/\s+/g, ' ').slice(0, 40), fg: hex(fg), bg: hex(bg),
      ratio: Math.round(rt * 100) / 100, need, ok: rt + 1e-6 >= need, ...extra };
  };

  /** Every own-text element in `root`, measured against what it sits on. */
  const texts = (root, kindOverride) => {
    const out = []; const seen = new Set(); let images = 0;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const e = n.parentElement;
      if (!e || seen.has(e)) continue;
      seen.add(e);
      if (/^(SCRIPT|STYLE|OPTION|NOSCRIPT|TEMPLATE|TEXTAREA|TITLE)$/.test(e.tagName)) continue;
      const inSvg = e.closest('svg');
      if (inSvg && !/^(text|tspan)$/i.test(e.tagName)) continue;
      if (!visible(e) || exempt(e)) continue;
      const cs = getComputedStyle(e);
      const fg0 = rgba(inSvg ? cs.fill : cs.color);
      if (fg0.a === 0) continue;
      const fill = inSvg ? (e.closest('svg').parentElement || e) : e;
      const b = bgOf(fill);
      if (b.image) { images++; continue; }
      const fg = paint(inSvg ? fill : e, fg0).c;
      const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      let kind = kindOverride;
      if (!kind) {
        if (e.closest(PILL)) kind = 'pill text';
        else if (e.closest('a[href]')) kind = 'link';
        else if (e.closest('button, .btn, [role="button"], [role="tab"]')) kind = 'button';
        else if (e.closest('th')) kind = 'header';
        else if (INKS.includes(hex(fg0)) && fg0.a === 1) kind = 'muted';
        else kind = 'text';
      }
      out.push(sample(kind, e, fg, b.c, large ? 3 : 4.5, n.nodeValue, { size, large }));
    }
    return { out, images };
  };

  /** A pill against the surface it sits on: its border over its own fill, or the fill. */
  const pills = (root) => {
    const out = [];
    for (const e of root.querySelectorAll(PILL)) {
      if (!visible(e) || exempt(e)) continue;
      const cs = getComputedStyle(e);
      const outside = bgOf(e.parentElement).c;
      const fill = bgOf(e).c;
      const bw = parseFloat(cs.borderTopWidth) || 0;
      // its edge: a border, or a 1px inset ring (box-shadow), which draws one without moving anything
      const ring = /^(rgba?\([^)]*\)|color\([^)]*\))\s+0px\s+0px\s+0px\s+[1-9][\d.]*px\s+inset/.exec(cs.boxShadow || '');
      const edge = bw > 0 && cs.borderTopStyle !== 'none' ? over(rgba(cs.borderTopColor), fill) : ring ? over(rgba(ring[1]), fill) : fill;
      const s1 = sample('pill edge', e, edge, outside, 3, e.textContent);
      const s2 = sample('pill edge', e, fill, outside, 3, e.textContent);
      out.push(s1.ratio >= s2.ratio ? s1 : s2);
    }
    return out;
  };

  const FIELDS = 'input[type="text"], input[type="search"], input[type="number"], input[type="date"], input[type="datetime-local"], input[type="password"], input[type="email"], input[type="url"], input:not([type]), select, textarea';
  /** A field's border against what is around it, and the text in it against its fill. */
  const fields = (root) => {
    const out = [];
    for (const e of root.querySelectorAll(FIELDS)) {
      if (!visible(e) || exempt(e)) continue;
      const cs = getComputedStyle(e);
      const outside = bgOf(e.parentElement).c;
      const fill = bgOf(e).c;
      const bw = parseFloat(cs.borderTopWidth) || 0;
      const edge = bw > 0 && cs.borderTopStyle !== 'none' ? over(rgba(cs.borderTopColor), outside) : fill;
      out.push(sample('input border', e, edge, outside, 3, e.getAttribute('aria-label') || e.name || e.id || e.tagName));
      const val = e.tagName === 'SELECT' ? (e.selectedOptions[0] || {}).textContent : e.value;
      if (val && val.trim()) out.push(sample('input text', e, paint(e, rgba(cs.color)).c, fill, 4.5, val));
    }
    return out;
  };

  /** Sticky table heads: opaque, so rows never show through. */
  const sticky = (root) => {
    const out = [];
    for (const th of root.querySelectorAll('th')) {
      if (!visible(th)) continue;
      const cs = getComputedStyle(th);
      if (cs.position !== 'sticky') continue;
      // the head's own box, thead or tr included, must cover what scrolls beneath it
      let a = 0;
      for (let e = th; e && e.tagName !== 'TABLE'; e = e.parentElement) a = Math.max(a, rgba(getComputedStyle(e).backgroundColor).a);
      out.push({ kind: 'sticky head', sel: path(th), text: th.textContent.trim().slice(0, 40), fg: '', bg: hex(bgOf(th).c), ratio: a, need: 1, ok: a >= 0.999 });
    }
    return out;
  };

  /** The focus ring of the focused element against what is around it. */
  const focusRing = () => {
    const e = document.activeElement;
    if (!e || e === document.body) return null;
    const cs = getComputedStyle(e);
    const outside = bgOf(e.parentElement).c;
    const ow = parseFloat(cs.outlineWidth) || 0;
    if (cs.outlineStyle !== 'none' && ow >= 1) {
      const off = parseFloat(cs.outlineOffset) || 0;
      const behind = off < 0 ? bgOf(e).c : outside;
      return sample('focus', e, over(rgba(cs.outlineColor), behind), behind, 3, e.textContent || e.tagName, { how: `outline ${ow}px` });
    }
    // fields: the border turns accent, with a soft ring outside it
    const bw = parseFloat(cs.borderTopWidth) || 0;
    if (bw > 0) return sample('focus', e, over(rgba(cs.borderTopColor), outside), outside, 3, e.getAttribute('aria-label') || e.tagName, { how: 'border' });
    return { kind: 'focus', sel: path(e), text: (e.textContent || '').trim().slice(0, 40), fg: '', bg: hex(outside), ratio: 0, need: 3, ok: false, how: 'no ring drawn' };
  };

  window.__cc = { texts, pills, fields, sticky, focusRing, path };
};

/* --------------------------------- one theme --------------------------------- */

const all = [];       // every sample: { theme, page, ...sample }
const errors = [];    // { theme, page, msg }
const notes = [];

async function runTheme(theme) {
  const browser = await pw.chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: SIZE[0], height: SIZE[1] }, ...themeContextOptions(theme) });
  await pinTheme(ctx, theme);
  if (CONFIG) await ctx.addInitScript((p) => { try { localStorage.setItem('elasticpro.configPath', p); } catch { /* none */ } }, path.resolve(CONFIG));

  // A signed-in administrator on the hosted build, so Accounts and the scheduled measurement are drawn.
  let ldList = [];
  const stub = {
    DELAY_SINK_GET: { ok: true, supported: true, config: { enabled: true, everyHours: 2, destination: 'builtin', clusters: [], maxDevices: 2000 }, state: { runs: 1, lastOk: true } },
    WHOAMI: { ok: true, authRequired: true, needsBootstrap: false, apiTokens: true, edition: 'hosted', caller: { name: 'qa', role: 'admin' } },
  };
  await ctx.route(`${BASE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.url() === `${BASE}/bridge`) {
      const t = ((req.postData() || '').match(/"type"\s*:\s*"([A-Z_]+)"/) || [])[1];
      if (t && stub[t]) return route.fulfill({ json: stub[t] });
      if (t && ldList.length && (t.startsWith('LOGDELAY_') || t.startsWith('REPORT_'))) {
        let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* not ours */ }
        const a = logDelayAnswer(body, ldList);
        if (a) return route.fulfill({ json: a });
      }
    }
    return route.continue();
  });

  const p = await ctx.newPage();
  let where = 'load';
  p.on('pageerror', (e) => errors.push({ theme, page: where, msg: `uncaught ${[e.name, e.message].filter(Boolean).join(': ')}` }));
  p.on('console', (m) => { if (m.type() === 'error') errors.push({ theme, page: where, msg: m.text().slice(0, 300) }); });

  const quiet = (ms = 500, max = 4000) => p.evaluate(({ ms, max }) => new Promise((res) => {
    let t = setTimeout(done, ms); const cap = setTimeout(done, max);
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ms); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    function done() { mo.disconnect(); clearTimeout(cap); clearTimeout(t); res(); }
  }), { ms, max });

  await p.goto(`${BASE}/#/alerts`);
  try { await p.waitForSelector('.head-fix', { timeout: 20000 }); } catch { /* reported below */ }
  const t0 = Date.now();
  while (Date.now() - t0 < WARM) {
    const ready = await p.evaluate(async () => {
      try { const S = await import('/js/core/state.js'); return [...S.state.data.values()].filter((d) => d.reachable && (d.repos || []).length).length >= 3; } catch { return false; }
    });
    if (ready) break;
    await sleep(1000);
  }
  await sleep(2000);
  const shell = await p.evaluate(() => !!document.querySelector('.head-fix') && !!document.querySelector('#view'));
  if (!shell) { errors.push({ theme, page: 'load', msg: 'the app did not load — start the bridge with the fixture (see --config)' }); await browser.close(); return; }
  const applied = await p.evaluate(() => document.documentElement.getAttribute('data-theme') || '(none)');
  notes.push(`${theme}: data-theme=${applied}, scheme=${themeContextOptions(theme).colorScheme}`);
  await p.evaluate(async () => { try { await (await import('/js/core/acks.js')).setCurrentUser('qa'); } catch { /* optional */ } });

  const goPage = async (id) => {
    if (id.startsWith('reports/log-delay') && !ldList.length) {
      ldList = await p.evaluate(async () => (await import('/js/core/state.js')).clusters().map((c) => ({ id: c.id, name: c.name })));
    }
    if (id.includes('@c')) {
      const first = logDelayData(ldList).per[0];
      id = id.replace('@c', encodeURIComponent(first ? first.c.id : '')).replace('@d', encodeURIComponent(first ? first.rows[0].device : ''));
    }
    await p.evaluate((id) => { location.hash = `#/${id}`; }, id);
    await sleep(900); await quiet(700, 5000);
  };
  const keep = (page, list) => { for (const s of list) all.push({ theme, page, ...s }); };

  const pages = [...pick(CONTRAST_PAGES), ...pick(ERROR_ONLY_PAGES)];
  for (const id of pages) {
    where = id;
    await goPage(id);
    if (ERRORS_ONLY || ERROR_ONLY_PAGES.includes(id)) continue;
    if (!(await p.evaluate(() => document.querySelector('#view')?.children.length || 0))) { notes.push(`${theme} ${id}: nothing drawn, skipped`); continue; }
    await p.mouse.move(0, 0);
    await p.evaluate(() => { document.querySelectorAll('#view details').forEach((d) => { d.open = true; }); });
    await sleep(200);
    await p.evaluate(install);

    // at rest: the whole document, the shell included
    const rest = await p.evaluate(() => {
      const t = window.__cc.texts(document.body);
      return { list: [...t.out, ...window.__cc.pills(document.body), ...window.__cc.fields(document.body), ...window.__cc.sticky(document.body)], images: t.images };
    });
    keep(id, rest.list);
    if (rest.images) notes.push(`${theme} ${id}: ${rest.images} text element(s) over a background image, not measured`);

    // hover: the first data row of each table on the page (up to four)
    const rows = await p.evaluate(() => {
      let n = 0;
      for (const t of document.querySelectorAll('#view table')) {
        const tr = [...t.querySelectorAll(':scope > tbody > tr')].find((r) => r.querySelector('td') && r.getBoundingClientRect().height > 4 && !r.classList.contains('cl-detail-row'));
        if (!tr) continue;
        tr.setAttribute('data-cc-hover', String(n++));
        if (n >= 4) break;
      }
      return n;
    });
    for (let i = 0; i < rows; i++) {
      try {
        await p.hover(`[data-cc-hover="${i}"]`, { timeout: 2000, position: { x: 3, y: 3 } });
        await sleep(150);
        const list = await p.evaluate((i) => { const tr = document.querySelector(`[data-cc-hover="${i}"]`); return tr ? window.__cc.texts(tr, 'hover row').out : []; }, i);
        keep(id, list);
      } catch { /* the row went away under a redraw */ }
    }
    await p.mouse.move(0, 0);

    // selected: open the first Overview row; then whatever the page marks as chosen
    if (id === 'overview') {
      await p.evaluate(() => { const tr = document.querySelector('#view tr.cl-row'); if (tr) tr.click(); });
      await sleep(600); await quiet(400, 3000);
    }
    if (id === 'reports/measure') {
      await p.evaluate(() => { const tr = document.querySelector('#view .rp-measure-tbl tbody tr:not(.on)'); if (tr) tr.click(); });
      await sleep(500); await quiet(400, 3000);
    }
    if (id.startsWith('reports/log-delay/cluster')) {
      await p.evaluate(() => { const tr = document.querySelector('#view .ld table.tbl tbody tr'); if (tr) tr.click(); });
      await sleep(500); await quiet(400, 3000);
    }
    await p.mouse.move(0, 0);
    await p.evaluate(install);
    keep(id, await p.evaluate(() => {
      const out = [];
      for (const tr of document.querySelectorAll('#view tr.open, #view tr.on, #view tr.ld-open, #view tr.zr-pinned, #view tr[aria-selected="true"], #view tr.cl-data')) out.push(...window.__cc.texts(tr, 'selected row').out);
      return out;
    }));

    // focus: a button, a field, a tab, a sortable head, a link — the first of each on the page
    const targets = await p.evaluate(() => {
      const sels = ['#view .btn:not(:disabled)', '#view input[type="text"]:not(:disabled), #view input[type="search"]:not(:disabled), #view select:not(:disabled)',
        '.nav button', '#view th.sortable', '#view a[href]', '#view .subnav button, #view .seg-btn, #view .rp-nav a'];
      const out = [];
      sels.forEach((s, i) => {
        const e = [...document.querySelectorAll(s)].find((x) => { const r = x.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.bottom > 0; });
        if (e) { e.setAttribute('data-cc-focus', String(i)); out.push(i); }
      });
      return out;
    });
    for (const i of targets) {
      await p.keyboard.press('Shift');   // keyboard modality, so :focus-visible applies to what is focused next
      await p.evaluate((i) => { const e = document.querySelector(`[data-cc-focus="${i}"]`); if (e) { e.scrollIntoView({ block: 'center' }); e.focus(); } }, i);
      await sleep(120);
      const s = await p.evaluate(() => window.__cc.focusRing());
      if (s) keep(id, [s]);
    }
    await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); window.scrollTo(0, 0); });
  }
  await browser.close();
}

for (const theme of THEMES) {
  if (!themeContextOptions(theme)) continue;
  const t = Date.now();
  await runTheme(theme);
  console.log(`contrast-check: ${theme} done in ${Math.round((Date.now() - t) / 1000)}s`);
}

/* ---------------------------------- report ---------------------------------- */

const KINDS = ['text', 'muted', 'link', 'button', 'header', 'input text', 'input border', 'pill text', 'pill edge', 'sticky head', 'hover row', 'selected row', 'focus'];
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
let failed = 0;
if (!ERRORS_ONLY) {
  for (const theme of THEMES) {
    const mine = all.filter((s) => s.theme === theme);
    console.log(`\n== ${theme} ==  (bar: text 4.5, large text 3, pill edge / input border / focus 3, sticky head opaque)`);
    console.log(`  ${pad('what', 14)}${lpad('samples', 8)}${lpad('lowest', 9)}${lpad('below', 7)}`);
    for (const k of KINDS) {
      const ks = mine.filter((s) => s.kind === k);
      if (!ks.length) { console.log(`  ${pad(k, 14)}${lpad(0, 8)}${lpad('—', 9)}${lpad('—', 7)}`); continue; }
      const low = k === 'sticky head' ? (ks.every((s) => s.ok) ? 'opaque' : 'see-thru') : Math.min(...ks.map((s) => s.ratio)).toFixed(2);
      const bad = ks.filter((s) => !s.ok).length;
      console.log(`  ${pad(k, 14)}${lpad(ks.length, 8)}${lpad(low, 9)}${lpad(bad, 7)}`);
    }
    // failures, one line per distinct (kind, selector, colours)
    const seen = new Map();
    for (const s of mine.filter((x) => !x.ok)) {
      const key = `${s.kind}|${s.sel}|${s.fg}|${s.bg}`;
      if (!seen.has(key)) seen.set(key, { ...s, pages: new Set([s.page]) }); else seen.get(key).pages.add(s.page);
    }
    const bad = [...seen.values()].sort((a, b) => a.ratio - b.ratio);
    failed += bad.length;
    for (const s of bad.slice(0, LIST)) {
      const pages = [...s.pages]; const pg = pages.length > 2 ? `${pages.slice(0, 2).join(', ')} +${pages.length - 2}` : pages.join(', ');
      console.log(`  FAIL ${pad(s.kind, 12)} ${lpad(s.kind === 'sticky head' ? 'alpha ' + s.ratio : s.ratio.toFixed(2), 6)} < ${s.need}  ${s.fg || '—'} on ${s.bg}  ${s.sel}  "${s.text}"${s.how ? ` (${s.how})` : ''}  [${pg}]`);
    }
    if (bad.length > LIST) console.log(`  … and ${bad.length - LIST} more (--list N)`);
  }
}

console.log('\n== console errors ==');
const errSeen = new Map();
for (const e of errors) { const k = `${e.theme}|${e.page}|${e.msg}`; errSeen.set(k, e); }
for (const e of errSeen.values()) console.log(`  ERROR ${pad(e.theme, 13)} ${pad(e.page, 32)} ${e.msg}`);
if (!errSeen.size) console.log('  none');
for (const n of notes) console.log(`  note: ${n}`);

if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ samples: all, errors, notes }, null, 1));
const total = all.length;
console.log(`\ncontrast-check: ${THEMES.length} theme(s), ${total} samples, ${failed} distinct below AA, ${errSeen.size} console error(s)`);
process.exit(failed || errSeen.size ? 1 : 0);
