#!/usr/bin/env node
/**
 * Does everything fit? In WebKit (Safari's engine) and Chromium, at the sizes a Mac and the
 * Zabbix frame give the app: no page, dialog or floating panel needs a sideways scrollbar,
 * and nothing sticks out past the edge it lives in.
 *
 *   for i in 0 1 2 3 4; do MOCK_CLUSTER_NAME=mock$i node tools/mock-es.mjs $((9299+i)) & done
 *   ELASTICPRO_DATA_DIR=$(mktemp -d) cargo run -p elasticpro-core --features bridge \
 *     --bin elasticpro-bridge -- ui 8765 &
 *   node tools/fit-check.mjs --base http://127.0.0.1:8765 --config $PWD/tools/fit-fixture.json
 *   node tools/fit-check.mjs --browsers webkit --only dialogs --skips
 *
 * Why it exists: the Config -> Defaults dialog shipped with a scrollbar along its bottom edge.
 * Its grids were `1fr 1fr 1fr`, and a 1fr column cannot shrink below its content, so one long
 * choice in a select pushed the columns past the dialog. jsdom has no layout, so render-check
 * and behaviour-check drew that dialog and said nothing; scroll-check pressed the wheel on a
 * handful of dialogs and never measured their width. Fit is a property of layout, and only a
 * real engine can answer it.
 *
 * What it measures (1440x900, 1280x800, 1024x768 and the app framed 1180 wide, the way the
 * Zabbix module shows it):
 *   pages     documentElement.scrollWidth <= clientWidth for all 12 pages, each view of the
 *             Alerts page grouped each way, every segment / tab on a page, with every <details> open. A wide
 *             table scrolling inside its own .tbl-wrap is intended and is not the page.
 *   dialogs   every dialog the code can open — called by name where the page does not offer
 *             a button for it, and found by pressing the buttons and row-menu items of every
 *             page otherwise. For each: the dialog and its body have no sideways scroll and
 *             nothing inside sticks out past the dialog's edge (a nested scroller such as a
 *             table box clips what is inside it, so what is inside it is not measured). Every
 *             <select> in a dialog is also run through its options, because a dialog's fields
 *             often follow the choice. Nothing is submitted: Escape closes each one.
 *   panels    bell, notes popover, volume popover, every row menu (first row and last row, so
 *             the flip above the trigger is measured), notices: wholly inside the window,
 *             with no sideways scroll of their own.
 *
 * Nothing here writes. The page is told it may write (the in-memory read-only default is
 * turned off so the dialogs open instead of asking to unlock first), but no primary button is
 * pressed, and the core refuses a write without its own unlock and a request a person made.
 * Zabbix pairing and certificate answers, and WHOAMI (so the Accounts page is on), are
 * stubbed at the network edge, because the fixture has no Zabbix to ask.
 *
 * --config is a path the BRIDGE can read (same machine). tools/fit-fixture.json has long,
 * realistic names, tags and notes on purpose: a short name fits anything.
 *
 * Needs playwright with chromium and webkit (see scroll-check.mjs). Exits 0 with a notice
 * when it is absent, like the jsdom checks.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('--base', 'http://127.0.0.1:8765').replace(/\/$/, '');
const CONFIG = arg('--config', '');
const BROWSERS = arg('--browsers', 'chromium,webkit').split(',');
const WARM = Number(arg('--warm', '25000'));
const ONLY = arg('--only', 'pages,dialogs,panels').split(',');
const PAGE_FILTER = arg('--pages', '');
const SIZES = [[1440, 900, false], [1280, 800, false], [1024, 768, false], [1280, 800, true]]
  .filter(([w, , framed]) => !arg('--sizes', '') || arg('--sizes', '').split(',').includes(framed ? 'f' : String(w)));
const FRAME_W = 1180;
/** The buttons that change what a page shows without doing anything: segments, tabs, the Config page's sections. */
const VIEW_SEL = '#view .seg button, #view .seg-btn, #view [role=tab], #view .tabs button, #view .subnav button';
const PAGES = ['alerts', 'overview', 'indices', 'shards', 'logs', 'console', 'snapshots', 'volume', 'automation', 'requests', 'accounts', 'settings']
  .filter((id) => !PAGE_FILTER || PAGE_FILTER.split(',').includes(id));

const pw = await loadPlaywright(ROOT, 'fit-check');
if (!pw) process.exit(0);
try {
  const r = await fetch(`${BASE}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`fit-check: no bridge at ${BASE} (${e.message})`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** [{ col, area, name, status: PASS|FAIL|SKIP, detail }] */
const results = [];

/* ------------------------------ in-page helpers ------------------------------ */
// Passed by value into evaluate, so each is self-contained.

/** Does the page need a sideways scrollbar, and if so which boxes stick out. */
const pageFit = () => {
  const de = document.documentElement;
  const cw = de.clientWidth;
  const out = { sw: de.scrollWidth, bw: document.body.scrollWidth, cw, culprits: [] };
  if (out.sw <= cw + 1 && out.bw <= cw + 1) return out;
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const clipped = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).overflowX !== 'visible') return true; return false; };
  const over = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= cw + 1 || clipped(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.position === 'fixed') continue;
    over.push([el, r]);
  }
  // the innermost boxes: a parent that sticks out only because its child does is not the cause
  const leaf = over.filter(([el]) => !over.some(([o]) => o !== el && el.contains(o)));
  out.culprits = leaf.slice(0, 4).map(([el, r]) => `${name(el)} right=${Math.round(r.right)} width=${Math.round(r.width)}`);
  return out;
};

/** The topmost dialog's sideways trouble, as a list of sentences (empty = fits). */
const dialogFit = () => {
  const ovs = [...document.querySelectorAll('.modal-overlay')];
  const ov = ovs[ovs.length - 1];
  const m = ov && ov.querySelector('.modal');
  if (!m) return { none: true, issues: [] };
  m.querySelectorAll('details').forEach((d) => { d.open = true; });
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const issues = [];
  const body = m.querySelector('.modal-body');
  if (m.scrollWidth > m.clientWidth + 1) issues.push(`dialog scrolls sideways (${m.scrollWidth} > ${m.clientWidth})`);
  if (body && body.scrollWidth > body.clientWidth + 1) issues.push(`dialog body scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`);
  if (ov.scrollWidth > ov.clientWidth + 1) issues.push(`backdrop scrolls sideways (${ov.scrollWidth} > ${ov.clientWidth})`);
  const mr = m.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  if (mr.left < -1 || mr.right > vw + 1) issues.push(`dialog spans ${Math.round(mr.left)}..${Math.round(mr.right)} in a ${vw}px window`);
  const edge = mr.left + m.clientLeft + m.clientWidth;      // inside the border, before a scrollbar
  const clipped = (el) => { for (let e = el.parentElement; e && e !== m; e = e.parentElement) if (getComputedStyle(e).overflowX !== 'visible') return true; return false; };
  const stick = [];
  for (const el of m.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || clipped(el)) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    if (r.right > edge + 1 || r.left < mr.left - 1) stick.push([el, r]);
  }
  const leaf = stick.filter(([el]) => !stick.some(([o]) => o !== el && el.contains(o)));
  for (const [el, r] of leaf.slice(0, 4)) issues.push(`${name(el)} sticks out (${Math.round(r.left)}..${Math.round(r.right)} vs dialog edge ${Math.round(edge)})`);
  return { none: false, issues, title: (m.querySelector('h2') || {}).textContent || '', n: ovs.length };
};

/** Floating things: wholly in the window, and no sideways scroll of their own. */
const panelFit = (sel) => {
  const de = document.documentElement;
  const cw = de.clientWidth, ch = de.clientHeight;
  const name = (e) => `${e.tagName.toLowerCase()}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const issues = [];
  let seen = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    seen++;
    if (r.left < -1 || r.top < -1 || r.right > cw + 1 || r.bottom > ch + 1) {
      issues.push(`${name(el)} spans x ${Math.round(r.left)}..${Math.round(r.right)}, y ${Math.round(r.top)}..${Math.round(r.bottom)} in a ${cw}x${ch} window`);
    }
    for (const b of [el, ...el.querySelectorAll('*')]) {
      if (!/(auto|scroll)/.test(getComputedStyle(b).overflowX) && b !== el) continue;
      if (b.scrollWidth > b.clientWidth + 1 && b.clientWidth > 0) issues.push(`${name(b)} scrolls sideways (${b.scrollWidth} > ${b.clientWidth})`);
    }
  }
  return { seen, issues };
};

/* --------------------------------- one run ---------------------------------- */

async function run(browserName, [vw, vh, framed]) {
  const size = framed ? FRAME_W : vw;
  const col = `${browserName === 'webkit' ? 'wk' : 'cr'} ${size}${framed ? 'f' : ''}`;
  const rec = (area, name, status, detail = '') => results.push({ col, area, name, status, detail });
  const check = (area, name, ok, detail = '') => rec(area, name, ok ? 'PASS' : 'FAIL', ok ? '' : detail);

  const browser = await pw[browserName].launch();
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
  if (CONFIG) await ctx.addInitScript((p) => { try { localStorage.setItem('elasticpro.configPath', p); } catch { /* none */ } }, path.resolve(CONFIG));

  // Answers the fixture cannot give. WHOAMI: a signed-in administrator on the hosted build, so
  // the Accounts page and the API-token dialog are there to be measured. The two Zabbix
  // answers: a certificate to decide about and a pairing code, which a real core would mint.
  const stub = {
    WHOAMI: { ok: true, authRequired: true, needsBootstrap: false, apiTokens: true, edition: 'hosted', caller: { name: 'qa', role: 'admin' } },
    ZABBIX_LINK_GET: {
      ok: true, supported: true, paired: true, zabbixUrl: 'https://zabbix.corp.internal.example.com', apiUrlIsDefault: true,
      apiUrl: 'https://zabbix.corp.internal.example.com/api_jsonrpc.php', verifyTls: true, allowHttp: false, signIn: true, syncSecs: 300,
      apiToken: { set: true, at: Math.floor(Date.now() / 1000) - 86400, by: 'platform-administrator', source: 'ui' },
      allowedSources: ['10.20.0.0/16', '192.168.100.0/24', '172.16.0.0/12'], frameAncestors: 'https://zabbix.corp.internal.example.com',
      pairedAt: Math.floor(Date.now() / 1000) - 86400, pairedBy: 'platform-administrator', zabbixVersion: '7.0.4',
      ssoSecret: { source: 'ui' }, managedBy: {}, sync: { configured: true, lastOk: Math.floor(Date.now() / 1000) - 120, clusters: 12, skipped: 1 },
    },
    ZABBIX_LINK_TEST: {
      ok: false, kind: 'tls_pin_mismatch', message: 'The certificate is not the one pinned for this address.',
      pinned: '9f2c1d7a5b8e4c3f0a6d2b1e7c9f4a8d3b5e6c0f1a2d4b7e8c9f0a1b3d5e7f92',
      cert: { host: 'zabbix.corp.internal.example.com:443', subject: 'CN=zabbix.corp.internal.example.com, O=Example Corporation International, C=DE',
        issuer: 'CN=Example Corporation Internal Issuing CA 2, O=Example Corporation International', self_signed: false,
        not_before: '2026-01-01T00:00:00Z', not_after: '2027-01-01T00:00:00Z',
        sans: ['zabbix.corp.internal.example.com', 'zabbix-secondary.corp.internal.example.com', 'monitoring.corp.internal.example.com'],
        sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' },
    },
    ZABBIX_PAIR_BEGIN: {
      ok: true, code: 'ZPAIR-' + 'q7Wm3KxT9bRv2LcYh8NfJd4SgPz6AeUo1XiBt5CrVn0MlHsDyQwEkGjFaZpO'.repeat(3),
      exp: Math.floor(Date.now() / 1000) + 600, zabbixUrl: 'https://zabbix.corp.internal.example.com',
      epUrl: 'https://elasticpro.corp.internal.example.com', pasteAt: 'Administration → ElasticPro → Pairing code',
    },
  };
  await ctx.route(`${BASE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST' && req.url() === `${BASE}/bridge`) {
      const t = ((req.postData() || '').match(/"type"\s*:\s*"([A-Z_]+)"/) || [])[1];
      if (t && stub[t]) return route.fulfill({ json: stub[t] });
      return route.continue();
    }
    if (framed && req.resourceType() === 'document') {
      // the app says who may frame it (frame-ancestors); this stand-in parent is nobody
      const r = await route.fetch();
      const headers = { ...r.headers() }; delete headers['content-security-policy'];
      return route.fulfill({ response: r, headers });
    }
    return route.continue();
  });

  const p = await ctx.newPage();
  let F = p;
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  const quiet = (ms = 500, max = 4000) => F.evaluate(({ ms, max }) => new Promise((res) => {
    let t = setTimeout(done, ms); const cap = setTimeout(done, max);
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ms); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    function done() { mo.disconnect(); clearTimeout(cap); clearTimeout(t); res(); }
  }), { ms, max });
  const goPage = async (id) => {
    await F.evaluate((id) => { location.hash = `#/${id}`; }, id);
    await sleep(900); await quiet(700, 5000);
    await readWrite();
  };
  /** The dialogs ask to unlock writes before they open when the config is read-only; turn that
   *  one question off in memory (the core still refuses a write nobody unlocked). */
  const readWrite = () => F.evaluate(async () => { const S = await import('/js/core/state.js'); S.state.defaults.readOnly = false; });
  const escape = () => F.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  const closeAll = async () => {
    for (let i = 0; i < 6; i++) {
      const n = await F.evaluate(() => document.querySelectorAll('.modal-overlay, .pop, .menu-pop').length);
      if (!n) return;
      await escape(); await sleep(120);
    }
  };
  /** The Config page shows one section at a time. */
  const section = async (label) => {
    await F.evaluate((l) => { [...document.querySelectorAll('#view .subnav button')].find((b) => b.textContent.includes(l))?.click(); }, label);
    await sleep(500); await quiet(500, 4000);
  };
  const overlays = () => F.evaluate(() => document.querySelectorAll('.modal-overlay').length);
  const waitOverlay = async (above = 0, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if ((await overlays()) > above) return true; await sleep(100); }
    return false;
  };

  /* ---- load, wait for the reachable clusters to answer ---- */
  if (framed) {
    await p.goto('about:blank');
    await p.setContent(`<body style="margin:0"><div style="height:60px;background:#333"></div><iframe src="${BASE}/#/alerts" style="display:block;width:${FRAME_W}px;height:calc(100vh - 60px);border:0"></iframe></body>`);
    for (let i = 0; i < 100 && !p.frames().some((x) => x.url().startsWith(BASE)); i++) await sleep(100);
    F = p.frames().find((x) => x.url().startsWith(BASE));
  } else await p.goto(`${BASE}/#/alerts`);
  try { await F.waitForSelector('.head-fix', { timeout: 20000 }); } catch { /* reported below */ }
  const t0 = Date.now();
  while (Date.now() - t0 < WARM) {
    const ready = await F.evaluate(async () => {
      try { const S = await import('/js/core/state.js'); return [...S.state.data.values()].filter((d) => d.reachable && (d.repos || []).length).length >= 3; } catch { return false; }
    });
    if (ready) break;
    await sleep(1000);
  }
  await sleep(2500);
  await readWrite();
  const shell = await F.evaluate(() => !!document.querySelector('.head-fix') && !!document.querySelector('#view'));
  check('setup', 'app loaded with data', shell, `shell=${shell} — start the bridge with the fixture (see --config)`);
  if (!shell) { await browser.close(); return; }
  const inner = await F.evaluate(() => innerWidth);
  check('setup', `window is ${size}px wide`, Math.abs(inner - size) <= 20, `app sees ${inner}px`);   // a classic scrollbar takes up to 15

  // Notes and acknowledgements are written under a name; without one the first press asks for it.
  await F.evaluate(async () => { await (await import('/js/core/acks.js')).setCurrentUser('qa'); });

  // What the openers below need, found once per page load.
  await F.evaluate(() => {
    window.__env = async () => {
      const S = await import('/js/core/state.js');
      const c = S.clusters().find((x) => x.name.startsWith('acme')) || S.clusters()[0];
      const d = S.state.data.get(c.id) || {};
      const repo = (d.repos && d.repos[0] && d.repos[0].name) || 'daily';
      const snaps = (d.snapshots && d.snapshots[repo]) || [];
      const snap = snaps[0] || { id: 'daily-2026.09.09-0', status: 'SUCCESS' };
      return { S, c, d, repo, snap };
    };
  });

  /** Measure the topmost dialog now (after it stops changing), then everything its selects offer. */
  const measureDialog = async (area, name, { variants = true } = {}) => {
    await quiet(450, 3500);
    const m = await F.evaluate(dialogFit);
    if (m.none) { rec(area, name, 'FAIL', 'the dialog went away before it was measured'); return false; }
    check(area, name, !m.issues.length, m.issues.join('; '));
    if (!variants) return true;
    // rows and fields that appear on demand: "+ Add ..." buttons, then every select's options
    const plus = await F.evaluate(() => {
      const ovs = [...document.querySelectorAll('.modal-overlay')]; const m = ovs[ovs.length - 1].querySelector('.modal');
      const bs = [...m.querySelectorAll('button')].filter((b) => !b.disabled && /^\s*\+\s*\S|^\s*add\b/i.test(b.textContent) && !/\bsave\b|\bapply\b/i.test(b.textContent));
      bs.forEach((b, i) => b.setAttribute('data-fit-add', String(i)));
      return bs.length;
    });
    for (let i = 0; i < Math.min(plus, 3); i++) {
      await F.evaluate((i) => { const b = document.querySelector(`.modal [data-fit-add="${i}"]`); if (b) b.click(); }, i);
      await sleep(250);
    }
    if (plus) {
      await quiet(300, 2000);
      const m2 = await F.evaluate(dialogFit);
      check(area, `${name} + rows added`, !m2.issues.length, m2.issues.join('; '));
    }
    const sels = await F.evaluate(() => {
      const ovs = [...document.querySelectorAll('.modal-overlay')]; const m = ovs[ovs.length - 1].querySelector('.modal');
      return [...m.querySelectorAll('select')].map((s, i) => { s.setAttribute('data-fit-sel', String(i));
        return { i, id: s.id || `select ${i + 1}`, opts: [...s.options].map((o) => [o.value, (o.textContent || '').trim().slice(0, 28)]) }; })
        .filter((s) => s.opts.length > 1 && s.opts.length <= 8);
    });
    for (const s of sels.slice(0, 6)) {
      for (const [v, label] of s.opts) {
        const done = await F.evaluate(({ i, v }) => {
          const el = document.querySelector(`.modal [data-fit-sel="${i}"]`); if (!el || el.value === v) return false;
          el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('input', { bubbles: true })); return true;
        }, { i: s.i, v });
        if (!done) continue;
        await quiet(250, 2500);
        const mv = await F.evaluate(dialogFit);
        if (mv.none) break;
        check(area, `${name} [${s.id}=${label}]`, !mv.issues.length, mv.issues.join('; '));
      }
    }
    return true;
  };

  /* ---- 1. pages ---- */
  if (ONLY.includes('pages')) {
    const ENTRIES = PAGES.map((id) => [id, '']);
    for (const [id, variant] of ENTRIES) {
      const label = variant ? `${id}:${variant}` : id;
      await goPage(id);
      if (variant) {
        await F.evaluate((v) => { const sel = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === v));
          if (sel) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); } }, variant);
        await sleep(600); await quiet();
      }
      if (!(await F.evaluate(() => document.querySelector('#view')?.children.length || 0))) { rec(`page ${label}`, 'drawn', 'SKIP', 'not available to this session'); continue; }
      await F.evaluate(() => { document.querySelectorAll('#view details').forEach((d) => { d.open = true; }); });
      await sleep(150);
      const m = await F.evaluate(pageFit);
      check(`page ${label}`, 'no sideways scroll', m.sw <= m.cw + 1 && m.bw <= m.cw + 1,
        `document is ${m.sw} wide in ${m.cw}${m.culprits.length ? ' — ' + m.culprits.join('; ') : ''}`);

      // every view a page offers: segments and tabs (not the ones that act), and its selects
      if (variant) continue;
      const views = await F.evaluate((sel) => {
        const bs = [...document.querySelectorAll(sel)]
          .filter((b) => !b.disabled && !/start|stop|run|send|apply|delete|remove|clear|save|pause|resume/i.test(b.textContent));
        bs.forEach((b, i) => b.setAttribute('data-fit-view', String(i)));
        return bs.map((b, i) => ({ i, label: (b.textContent || '').trim().slice(0, 30) }));
      }, VIEW_SEL);
      const seenView = new Set();
      for (const v of views.slice(0, 10)) {
        if (seenView.has(v.label)) continue; seenView.add(v.label);
        const hit = await F.evaluate((i) => { const b = document.querySelector(`[data-fit-view="${i}"]`); if (!b) return false; b.click(); return true; }, v.i);
        if (!hit) continue;
        await sleep(500); await quiet(500, 4000);
        await F.evaluate(() => { document.querySelectorAll('#view details').forEach((d) => { d.open = true; }); });
        const mv = await F.evaluate(pageFit);
        check(`page ${label}`, `view "${v.label}"`, mv.sw <= mv.cw + 1 && mv.bw <= mv.cw + 1,
          `document is ${mv.sw} wide in ${mv.cw}${mv.culprits.length ? ' — ' + mv.culprits.join('; ') : ''}`);
        // re-stamp: the click may have redrawn the page
        const again = await F.evaluate((sel) => {
          const bs = [...document.querySelectorAll(sel)]
            .filter((b) => !b.disabled && !/start|stop|run|send|apply|delete|remove|clear|save|pause|resume/i.test(b.textContent));
          bs.forEach((b, i) => b.setAttribute('data-fit-view', String(i)));
          return bs.map((b, i) => ({ i, label: (b.textContent || '').trim().slice(0, 30) }));
        }, VIEW_SEL);
        for (const a of again) { const k = views.find((x) => x.label === a.label); if (k) k.i = a.i; }
      }
      const sels = await F.evaluate(() => {
        const ss = [...document.querySelectorAll('#view select')].filter((s) => s.options.length > 1 && s.options.length <= 6 && s.offsetParent);
        ss.forEach((s, i) => s.setAttribute('data-fit-psel', String(i)));
        return ss.map((s, i) => ({ i, id: s.id || `select ${i + 1}`, opts: [...s.options].map((o) => [o.value, (o.textContent || '').trim().slice(0, 28)]) }));
      });
      for (const s of sels.slice(0, 4)) {
        for (const [v, ol] of s.opts) {
          const done = await F.evaluate(({ i, v }) => { const el = document.querySelector(`#view [data-fit-psel="${i}"]`); if (!el || el.value === v) return false;
            el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }, { i: s.i, v });
          if (!done) continue;
          await sleep(500); await quiet(500, 4000);
          const mv = await F.evaluate(pageFit);
          check(`page ${label}`, `${s.id}=${ol}`, mv.sw <= mv.cw + 1 && mv.bw <= mv.cw + 1,
            `document is ${mv.sw} wide in ${mv.cw}${mv.culprits.length ? ' — ' + mv.culprits.join('; ') : ''}`);
        }
        // put it back where it was: the next page visit redraws anyway, but a later select shares this page
      }
    }
  }

  /* ---- 2. dialogs by name ---- */
  if (ONLY.includes('dialogs')) {
    const LONG_INDEX = 'logstash-acme-corporation-production-application-audit-events-2026.09.09-000001';
    const NAMES = [LONG_INDEX, 'logstash-acme-2026.09.09', 'logstash-beta-2026.09.09', 'metrics-2026.09'];
    /** [name, page, fn(arg) opening the dialog without awaiting it, arg, then(F) pressing something inside it] */
    const D = [];
    const dlg = (name, page, fn, o = {}) => D.push({ name, page, fn, ...o });

    /* config-editor.js */
    dlg('Config · Defaults', 'settings', async () => { (await import('/js/ui/config-editor.js')).editDefaults(); });
    dlg('Config · Add cluster', 'settings', async () => { (await import('/js/ui/config-editor.js')).editCluster(null); });
    dlg('Config · Edit cluster (own credential, jump host)', 'settings', async () => {
      const m = await import('/js/ui/config-editor.js');
      m.editCluster({ name: 'behind-the-frankfurt-jump-host', url: 'https://es-logging-frankfurt-01.corp.internal.example.com:9200',
        via: 'jump-windows-datacenter-frankfurt-1', tls: 'insecure', tags: ['production', 'eu-central-1', 'pci-scope', 'customer-facing'],
        liveRetention: '30d', snapshotRetention: '6M', username: 'svc-elasticpro-readonly-frankfurt', password: 'x' });
    });
    dlg('Config · Add jump host', 'settings', async () => { (await import('/js/ui/config-editor.js')).editJumpHost(null); });
    dlg('Config · Edit jump host', 'settings', async () => { (await import('/js/ui/config-editor.js')).editJumpHost('jump-windows-datacenter-frankfurt-1'); });
    // WHOAMI says hosted, so this is the server's default credential (kept encrypted on the server).
    dlg('Config · Shared credential', 'settings', async () => { (await import('/js/ui/config-editor.js')).editCredentials(); });
    // The master password belongs to the portable build, where the file keeps the credential.
    dlg('Config · Master password (new)', 'settings', async () => {
      (await import('/js/core/server-credentials.js')).setHostedEdition(false);
      (await import('/js/ui/config-editor.js')).editCredentials();
    }, {
      // Save asks for the master password before it seals anything; Cancel there writes nothing
      then: async (F) => { await F.evaluate(() => { document.querySelector('#ce-secret').value = 'not-a-secret'; document.querySelector('.modal-foot .btn.primary').click(); }); },
    });
    dlg('Config · Unlock credentials', 'settings', async () => {
      (await import('/js/core/server-credentials.js')).setHostedEdition(true);   // back to what WHOAMI said
      const S = await import('/js/core/state.js'); const m = await import('/js/ui/config-editor.js');
      const cfg = S.state.config; const c = cfg.clusters[0];
      const was = [cfg.sealed, c.sealedCred, c.needsCred];
      cfg.sealed = true; c.sealedCred = { password: 'AES256GCM:not-a-real-sealed-value' }; c.needsCred = true;
      m.unlockSealed();                                  // builds its dialog before its first await
      [cfg.sealed, c.sealedCred, c.needsCred] = was;
    });
    dlg('Credentials · manual', 'settings', async () => { (await import('/js/ui/credential-dialog.js')).showCredentialDialog('manual'); });
    dlg('Credentials · startup', 'settings', async () => { (await import('/js/ui/credential-dialog.js')).showCredentialDialog('startup'); });
    dlg('Credentials · auth error', 'settings', async () => { (await import('/js/ui/credential-dialog.js')).showCredentialDialog('auth_error'); });
    dlg('About', 'overview', async () => { (await import('/js/ui/about.js')).aboutDialog('0.3.18'); });
    dlg('Write unlock question', 'indices', async () => {
      const S = await import('/js/core/state.js'); S.state.defaults.readOnly = true;
      (await import('/js/core/writes.js')).ensureWrites();
      setTimeout(() => { S.state.defaults.readOnly = false; }, 300);
    });

    /* modal.js: the confirm every destructive action goes through, with the longest text real callers give it */
    dlg('Confirm · long name and body', 'indices', async (a) => {
      const { confirmDialog, nameList } = await import('/js/ui/modal.js'); const { h } = await import('/js/lib/dom.js');
      confirmDialog(`Delete ${a.names[0]}?`, h('div', h('div', 'On acme-corporation-production-eu-central-1-logging-hot. This cannot be undone: ' + 'the index and everything in it is removed. '.repeat(3)),
        nameList(a.names)), { yes: 'delete', danger: true, hint: 'Snapshot ' + a.names[0] + ' keeps a copy.' });
    }, { arg: { names: NAMES } });
    dlg('Confirm · type to confirm', 'snapshots', async (a) => {
      const { confirmDialog } = await import('/js/ui/modal.js');
      confirmDialog(`Remove repository ${a.names[0]}?`, 'The repository is unregistered. Snapshots in it stay on disk.', { yes: 'remove', danger: true, typeToConfirm: a.names[0] });
    }, { arg: { names: NAMES } });
    dlg('Input dialog', 'alerts', async () => {
      (await import('/js/ui/modal.js')).inputDialog('Who is acknowledging?', 'Your name or initials — recorded against acknowledgements and notes on this machine', '', { yes: 'Save' });
    });

    /* index-actions.js */
    const IDX = 'logstash-acme-2026.09.09';
    dlg('Indices · Move a shard', 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).moveShardDialog(e.c, a.idx); }, { arg: { idx: IDX } });
    dlg('Indices · Settings (one)', 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).indexSettingsDialog(e.c, [a.idx]); }, { arg: { idx: IDX } });
    dlg('Indices · Settings (several)', 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).indexSettingsDialog(e.c, a.names); }, { arg: { names: NAMES } });
    dlg('Indices · Open', 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).openIndices(e.c, a.names); }, { arg: { names: NAMES } });
    dlg('Indices · Close', 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).closeIndices(e.c, a.names); }, { arg: { names: NAMES } });
    dlg('Indices · Delete', 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).deleteIndices(e.c, a.names); }, { arg: { names: NAMES } });
    for (const kind of ['refresh', 'flush', 'clear', 'forcemerge']) {
      dlg(`Indices · ${kind}`, 'indices', async (a) => { const e = await window.__env(); (await import('/js/ui/index-actions.js')).maintenance(e.c, a.names, a.kind); }, { arg: { names: NAMES, kind } });
    }

    /* snapshot-dialogs.js */
    dlg('Snapshots · Create', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).createSnapshotDialog(e.c, e.d.repos, e.repo); });
    dlg('Snapshots · Restore', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).restoreSnapshotDialog(e.c, e.repo, e.snap.id); });
    dlg('Snapshots · Restore indices', 'indices', async (a) => {
      const e = await window.__env();
      const items = a.names.map((index, i) => ({ index, alsoLive: i % 2 === 0, snapshots: [{ state: 'SUCCESS', repo: e.repo, snapshot: e.snap.id }] }));
      (await import('/js/ui/snapshot-dialogs.js')).restoreIndicesDialog(e.c, items);
    }, { arg: { names: NAMES } });
    dlg('Snapshots · Delete', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).deleteSnapshot(e.c, e.repo, e.snap.id); });
    dlg('Snapshots · Delete live indices', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).deleteIndicesDialog(e.c, e.repo, e.snap.id); });
    dlg('Snapshots · Add repository', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).createRepositoryDialog(e.c, ['/mnt/es-backups', '/mnt/es-backups-secondary/long-path/for-the-warm-tier']); });
    dlg('Snapshots · Remove repository', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).deleteRepository(e.c, e.repo); });
    dlg('Snapshots · Clean up repository', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).cleanupRepository(e.c, e.repo); });
    dlg('Snapshots · Indices in a snapshot', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).snapshotIndicesDialog(e.c, e.repo, e.snap); });
    dlg('Snapshots · Evidence drawer', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).snapshotDetailsDialog(e.c, e.repo, e.snap.id); });
    dlg('Snapshots · Evidence drawer (listing row)', 'snapshots', async () => { const e = await window.__env(); (await import('/js/ui/snapshot-dialogs.js')).snapshotIndicesDialog(e.c, e.repo, e.snap, { details: true }); });

    /* cluster-users.js */
    dlg('Cluster users · Create', 'accounts', async () => { const e = await window.__env(); (await import('/js/ui/cluster-users.js')).createDialog({ preselect: [e.c.id] }); });
    dlg('Cluster users · Create (all clusters)', 'accounts', async () => { (await import('/js/ui/cluster-users.js')).createDialog({}); });
    dlg('Cluster users · Edit', 'accounts', async () => {
      const e = await window.__env();
      (await import('/js/ui/cluster-users.js')).editDialog(e.c.id, { name: 'svc-logging-reader-for-the-frankfurt-datacenter', roles: ['viewer', 'monitoring_user'], fullName: 'Service account for the Frankfurt logging platform', email: 'svc-logging-reader.frankfurt@corp.internal.example.com' });
    });
    dlg('Cluster users · Remove', 'accounts', async () => { const e = await window.__env(); (await import('/js/ui/cluster-users.js')).removeClusterUser(e.c.id, 'svc-logging-reader-for-the-frankfurt-datacenter'); });

    /* rule-builder.js */
    dlg('Automation · New rule', 'automation', async () => { (await import('/js/ui/rule-builder.js')).ruleBuilder(null); });
    dlg('Automation · Edit rule', 'automation', async () => {
      const { blankRule } = await import('/js/core/user-rules.js'); const r = blankRule();
      r.name = 'Close logstash indices older than ninety days on the acme corporation production logging clusters';
      (await import('/js/ui/rule-builder.js')).ruleBuilder(r);
    });

    /* settings.js: dialogs of the page itself, reached through its buttons with the Zabbix answers stubbed */
    dlg('Zabbix · certificate changed', 'settings', null, { ui: async (F) => {
      await section('Zabbix');
      await F.evaluate(() => { const b = [...document.querySelectorAll('#view button')].find((x) => /^Test connection$/.test(x.textContent.trim())); b && b.click(); });
    } });
    dlg('Zabbix · pairing code', 'settings', null, { ui: async (F) => {
      await section('Zabbix');
      await F.evaluate(() => {
        const z = document.querySelector('#zl-zurl'); if (z && !z.value) { z.value = 'https://zabbix.corp.internal.example.com'; z.dispatchEvent(new Event('input', { bubbles: true })); }
        const b = [...document.querySelectorAll('#view button')].find((x) => /Pair( again)?…|Re-pair…/.test(x.textContent.trim())); b && b.click();
      });
    } });
    dlg('Zabbix · unpair question', 'settings', async () => {
      // the question itself, as unpairLink words it; the page's own button is disabled until something is paired
      const { confirmDialog } = await import('/js/ui/modal.js');
      confirmDialog('Unpair from Zabbix?', 'The API token and the sign-in secret stored here are deleted. Signing in from Zabbix stops at once, and the clusters that come from Zabbix disappear from ElasticPro until you pair again.\n\nSettings made in the server’s own configuration are not touched.', { yes: 'unpair', danger: true });
    });

    /* accounts.js: its dialogs are the page's own functions, so its buttons open them */
    dlg('Accounts · New user', 'accounts', null, { ui: async (F) => { await F.evaluate(() => { [...document.querySelectorAll('#view button')].find((b) => /New ElasticPro user/.test(b.textContent))?.click(); }); } });
    dlg('Accounts · New API token', 'accounts', null, { ui: async (F) => { await F.evaluate(() => { [...document.querySelectorAll('#view button')].find((b) => /New token/.test(b.textContent))?.click(); }); } });

    let at = '';
    for (const o of D) {
      const area = 'dialog';
      if (o.page !== at) { await goPage(o.page); at = o.page; }
      await readWrite();
      await closeAll();
      const before = await overlays();
      try {
        if (o.fn) await F.evaluate(o.fn, o.arg || null);
        else await o.ui(F);
      } catch (e) { rec(area, o.name, 'FAIL', `could not open it: ${e.message.split('\n')[0]}`); continue; }
      if (!(await waitOverlay(before))) { rec(area, o.name, 'FAIL', `did not open${errors.length ? ` (page error: ${errors[errors.length - 1]})` : ''}`); continue; }
      await measureDialog(area, o.name);
      if (o.then) {
        const n = await overlays();
        await o.then(F);
        if (await waitOverlay(n, 4000)) await measureDialog(area, `${o.name} — second dialog`, { variants: false });
        else rec(area, `${o.name} — second dialog`, 'FAIL', 'did not open');
      }
      await closeAll();
    }
  }

  /* ---- 3. dialogs and panels found by pressing things ---- */
  /** Bring the marked element ([data-fit-hit]) into view, let the scroll settle, then press it:
   *  a panel opened in the same breath as the scroll is closed by it (intended — the page moved
   *  away from its anchor), and a person never presses what is below the fold. */
  const pressMarked = async (block = 'center') => {
    await F.evaluate((block) => { document.querySelector('[data-fit-hit]')?.scrollIntoView({ block, behavior: 'instant' }); }, block);
    await sleep(350);
    await F.evaluate(() => { const b = document.querySelector('[data-fit-hit]'); if (b) { b.removeAttribute('data-fit-hit'); b.click(); } });
  };
  const press = async (page, label, locate) => {
    // press, and say what appeared: a dialog (measured), a panel (measured), or nothing
    const before = await overlays();
    const clicked = await F.evaluate(locate.fn, locate.arg);
    if (!clicked) return 'gone';
    await pressMarked();
    await sleep(450);
    if ((await overlays()) > before) { await measureDialog(`dialog ${page}`, `"${label}"`); await closeAll(); return 'dialog'; }
    if (ONLY.includes('panels') && await F.evaluate(() => !!document.querySelector('.pop, .menu-pop'))) {
      const m = await F.evaluate(panelFit, '.pop, .menu-pop');
      check(`panel ${page}`, `"${label}"`, !m.issues.length, m.issues.join('; '));
      await closeAll(); return 'panel';
    }
    // nothing opened: the click may have redrawn the page (a tab, a form, a filter) — still has to fit
    const m = await F.evaluate(pageFit);
    check(`page ${page}`, `after pressing "${label}"`, m.sw <= m.cw + 1 && m.bw <= m.cw + 1,
      `document is ${m.sw} wide in ${m.cw}${m.culprits.length ? ' — ' + m.culprits.join('; ') : ''}`);
    return 'nothing';
  };
  if (ONLY.includes('dialogs') || ONLY.includes('panels')) {
    const SAFE_BUTTON = /^(?!.*(sign ?out|log ?out|forget|clear|reset|wipe|purge|unpair|delete|remove|revoke|apply|save|restore|upload|browse|download|export|import|\bstop\b|kill|lock|block|refresh|reload|sync|test connection|connect\b|start|run|send|execute|cancel task|pause|resume|retry|expand|collapse)).+$/i;
    const SAFE_ITEM = /^(?!.*(refresh|flush|clear cache|verify|acknowledge|ack\b|copy|export|csv|download|force|retry|pause|resume|enable|disable|run|re-?open|unsilence|sync)).+$/i;
    const dbg = (...a) => { if (process.env.FIT_DEBUG) console.log(`[${col}]`, ...a); };
    const openDetails = () => F.evaluate(() => { document.querySelectorAll('#view details').forEach((d) => { d.open = true; }); });
    /** What this state of the page offers to press: its buttons (3a) and its row menus (3b). */
    const sweep = async (id, tag) => {
      await openDetails();

      // 3a. buttons the page offers
      if (ONLY.includes('dialogs')) {
        const labels = await F.evaluate((rx) => {
          const safe = new RegExp(rx.source, rx.flags);
          const seen = new Set(), out = [];
          for (const b of document.querySelectorAll('#view button, #view a.btn, #view summary')) {
            const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 40 || b.disabled || !b.offsetParent || b.classList.contains('menu-trigger') || b.matches(rx.views) || seen.has(t)) continue;
            if (!safe.test(t)) continue;
            seen.add(t); out.push(t);
          }
          return out;
        }, { source: SAFE_BUTTON.source, flags: SAFE_BUTTON.flags, views: VIEW_SEL.replaceAll('#view ', '') });
        dbg(tag, 'buttons', labels.join(' | '));
        for (const label of labels.slice(0, 14)) {
          const r = await press(tag, label, { fn: (l) => {
            const b = [...document.querySelectorAll('#view button, #view a.btn, #view summary')].find((x) => (x.textContent || '').replace(/\s+/g, ' ').trim() === l && !x.disabled && x.offsetParent);
            if (!b) return false; b.setAttribute('data-fit-hit', ''); return true; }, arg: label });
          dbg(tag, label, '->', r);
          if (r === 'nothing' || r === 'gone') await closeAll();
          // a press that redrew the page (a filter, a form) leaves the rest of the labels where they were
        }
      }

      // 3b. row menus: the first row and the last row (the menu flips above a trigger near the bottom)
      for (const which of ['first', 'last']) {
        const n = await F.evaluate(() => [...document.querySelectorAll('#view .menu-trigger')].filter((t) => t.offsetParent).length);
        dbg(tag, 'menu triggers', n);
        if (!n) break;
        const open = async () => {
          await closeAll();
          const found = await F.evaluate((which) => {
            const ts = [...document.querySelectorAll('#view .menu-trigger')].filter((t) => t.offsetParent);
            if (!ts.length) return false;
            (which === 'first' ? ts[0] : ts[ts.length - 1]).setAttribute('data-fit-hit', ''); return true;
          }, which);
          if (found) await pressMarked(which === 'first' ? 'start' : 'end');
          await sleep(300);
          return found && await F.evaluate(() => !!document.querySelector('.menu-pop'));
        };
        if (!(await open())) { rec(`panel ${tag}`, `row menu (${which})`, 'SKIP', 'did not open'); continue; }
        if (ONLY.includes('panels')) {
          const m = await F.evaluate(panelFit, '.menu-pop');
          check(`panel ${tag}`, `row menu (${which})`, !m.issues.length, m.issues.join('; '));
        }
        if (!ONLY.includes('dialogs')) { await closeAll(); continue; }
        const items = await F.evaluate(() => [...document.querySelectorAll('.menu-pop button')].filter((b) => !b.disabled).map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()));
        dbg(tag, `menu (${which}) items`, items.join(' | '));
        for (const label of items.filter((t) => SAFE_ITEM.test(t)).slice(0, 8)) {
          if (!(await open())) break;
          const before = await overlays();
          const hit = await F.evaluate((l) => { const b = [...document.querySelectorAll('.menu-pop button')].find((x) => (x.textContent || '').replace(/\s+/g, ' ').trim() === l && !x.disabled); if (!b) return false; b.click(); return true; }, label);
          if (!hit) continue;
          await sleep(400);
          if ((await overlays()) > before || await waitOverlay(before, 2500)) { await measureDialog(`dialog ${tag}`, `menu (${which}) "${label}"`); await closeAll(); }
          else await closeAll();
        }
        await closeAll();
      }
    };

    for (const id of PAGES) {
      await goPage(id);
      // Every view the page offers is a different set of buttons and rows: segments, tabs, and
      // the Config page's sections. The page as it opens first, then each view from a fresh page.
      const views = await F.evaluate((sel) => {
        const seen = new Set();
        return [...document.querySelectorAll(sel)].filter((b) => !b.disabled && b.offsetParent)
          .map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim())
          .filter((t) => t && !seen.has(t) && seen.add(t) && !/start|stop|run|send|apply|delete|remove|clear|save|pause|resume/i.test(t));
      }, VIEW_SEL);
      dbg(id, 'views', views.join(' | '));
      await sweep(id, id);
      for (const v of views.slice(0, 10)) {
        await goPage(id);
        const hit = await F.evaluate(({ sel, v }) => { const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').replace(/\s+/g, ' ').trim() === v); if (!b) return false; b.click(); return true; }, { sel: VIEW_SEL, v });
        if (!hit) continue;
        await sleep(500); await quiet(500, 4000);
        await sweep(id, `${id}/${v}`);
      }
    }
  }

  /* ---- 4. the remaining panels ---- */
  if (ONLY.includes('panels')) {
    await goPage('alerts');
    // notices: the stack at the corner, and the bell with a long history of long lines
    await F.evaluate(async () => {
      const m = await import('/js/ui/menu.js');
      for (let i = 0; i < 8; i++) {
        m.toast(`fit-check notice ${i}: ${'a long line with a-very-long-unbroken-name-like-logstash-acme-corporation-production-application-audit-events-2026.09.09-000001 '.repeat(2)}`,
          i % 3 ? 'ok' : 'err', 60000, { meta: 'acme-corporation-production-eu-central-1-logging-hot', detail: ['logstash-acme-corporation-production-application-audit-events-2026.09.09-000001 refused the request: ' + 'x'.repeat(60)] });
      }
    });
    await sleep(500);
    const t = await F.evaluate(panelFit, '.toast-wrap, .toast');
    check('panels', 'notices', t.seen > 0 && !t.issues.length, t.seen ? t.issues.join('; ') : 'no notice was drawn');
    await F.evaluate(() => document.querySelector('button.bell')?.click());
    await sleep(500);
    const bell = await F.evaluate(panelFit, '.pop');
    check('panels', 'bell', bell.seen > 0 && !bell.issues.length, bell.seen ? bell.issues.join('; ') : 'the bell did not open');
    await closeAll();

    // the notes popover, on the first and the last alert row
    for (const which of ['first', 'last']) {
      // the alert list redraws as data lands, and a redraw takes the button out from under the popover: try again
      let ok = false, m = { seen: 0, issues: [] };
      for (let attempt = 0; attempt < 3 && !m.seen; attempt++) {
        ok = await F.evaluate((which) => {
          const bs = [...document.querySelectorAll('#view .arow button, #view tbody tr button')].filter((b) => /💬/.test(b.textContent) && b.offsetParent);
          if (!bs.length) return false;
          (which === 'first' ? bs[0] : bs[bs.length - 1]).setAttribute('data-fit-hit', ''); return true;
        }, which);
        if (!ok) break;
        await pressMarked(which === 'first' ? 'start' : 'end');
        await sleep(500);
        m = await F.evaluate(panelFit, '.pop');
        if (!m.seen) await closeAll();
      }
      if (!ok) { rec('panels', `notes popover (${which})`, 'SKIP', 'no alert row with a notes button'); break; }
      check('panels', `notes popover (${which})`, m.seen > 0 && !m.issues.length, m.seen ? m.issues.join('; ') : 'did not open');
      await closeAll();
    }

    // the volume report's column notes: the first column and the last, which sits at the window's right edge
    await goPage('volume');
    await F.evaluate(() => { [...document.querySelectorAll('#view button')].find((b) => /^Full report$/.test(b.textContent.trim()))?.click(); });
    await sleep(600); await quiet(500, 4000);
    for (const which of ['first', 'last']) {
      const ok = await F.evaluate((which) => {
        const bs = [...document.querySelectorAll('#view button.colinfo')];
        if (!bs.length) return false;
        (which === 'first' ? bs[0] : bs[bs.length - 1]).setAttribute('data-fit-hit', ''); return true;
      }, which);
      if (!ok) { rec('panels', `column note (${which})`, 'SKIP', 'no column with a note'); break; }
      await pressMarked('start');
      await sleep(400);
      const m = await F.evaluate(panelFit, '.pop');
      check('panels', `column note (${which})`, m.seen > 0 && !m.issues.length, m.seen ? m.issues.join('; ') : 'did not open');
      await closeAll();
    }
  }

  check('setup', 'no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

/* ---------------------------------- report ---------------------------------- */

// The runs do not interact (each has its own browser and its own page): a few at a time. The
// default is every one of them; --jobs 2 for a small machine.
const JOBS = Number(arg('--jobs', '8'));
const queue = BROWSERS.flatMap((b) => SIZES.map((sz) => [b, sz]));
await Promise.all(Array.from({ length: Math.min(JOBS, queue.length) }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    const [b, sz] = job;
    try { await run(b, sz); } catch (e) {
      results.push({ col: `${b === 'webkit' ? 'wk' : 'cr'} ${sz[2] ? FRAME_W + 'f' : sz[0]}`, area: 'setup', name: 'run completed', status: 'FAIL', detail: e.message.split('\n')[0] });
    }
  }
}));

const cols = [...new Set(results.map((r) => r.col))].sort();
const areas = [...new Set(results.map((r) => r.area))];
const n = (s, f = () => true) => results.filter((r) => r.status === s && f(r)).length;
const pad = Math.max(...areas.map((a) => a.length), 6);
console.log(`\n${'area'.padEnd(pad)}  ${cols.map((c) => c.padEnd(14)).join(' ')}`);
for (const a of areas) {
  console.log(`${a.padEnd(pad)}  ${cols.map((c) => {
    const rs = results.filter((r) => r.area === a && r.col === c);
    const f = rs.filter((r) => r.status === 'FAIL').length, ok = rs.filter((r) => r.status === 'PASS').length;
    return (rs.length ? `${ok} pass${f ? ` ${f} FAIL` : ''}` : '-').padEnd(14);
  }).join(' ')}`);
}
if (process.argv.includes('--list')) {
  console.log('\nCHECKED (every distinct check, once)');
  for (const k of [...new Set(results.map((r) => `${r.area} · ${r.name}`))]) console.log(`  ${k}`);
}
if (process.argv.includes('--skips')) {
  console.log('\nSKIPPED');
  for (const r of results.filter((x) => x.status === 'SKIP')) console.log(`  [${r.col}] ${r.area} · ${r.name}: ${r.detail}`);
}
const failed = results.filter((r) => r.status === 'FAIL');
if (failed.length) {
  console.log('\nFAILURES');
  // One line per dialog or page, not per size and per option: the columns that share it are
  // listed once, with the first sentence of what is wrong and how many variants of it failed.
  const by = new Map();
  for (const f of failed) {
    const base = f.name.replace(/ \[[^\]]*\]$/, '').replace(/ \+ rows added$/, '');
    const k = `${f.area} · ${base}`;
    const e = by.get(k) || by.set(k, { cols: new Set(), n: 0, detail: f.detail }).get(k);
    e.cols.add(f.col); e.n++;
  }
  for (const [k, e] of by) console.log(`  [${[...e.cols].sort().join(', ')}] ${k}${e.n > e.cols.size ? ` (+${e.n - e.cols.size} variants)` : ''}: ${e.detail}`);
}
console.log(`\nfit-check: ${n('PASS')} pass, ${failed.length} fail, ${n('SKIP')} skipped (${cols.join(', ')})`);
process.exit(failed.length ? 1 : 0);
