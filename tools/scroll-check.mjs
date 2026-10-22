#!/usr/bin/env node
/**
 * Scroll the UI the way a Mac does, in WebKit (Safari's engine) and Chromium, and say what
 * does not move.
 *
 *   for i in 0 1 2 3 4; do MOCK_CLUSTER_NAME=mock$i node tools/mock-es.mjs $((9299+i)) & done
 *   ELASTICPRO_DATA_DIR=$(mktemp -d) cargo run -p elasticpro-core --features bridge \
 *     --bin elasticpro-bridge -- ui 8765 &
 *   node tools/scroll-check.mjs --base http://127.0.0.1:8765 --config $PWD/tools/scroll-fixture.json
 *   node tools/scroll-check.mjs --browsers webkit --pages alerts,overview --hold 3000 --skips
 *
 * Why it exists: jsdom does no layout, so `render-check` and `behaviour-check` can draw and
 * press every page and still miss "I cannot mouse-scroll the alerts". Scrolling is a
 * property of layout (overflow, sticky, fixed panels, overscroll chaining) and of listeners
 * that react to scroll events — only a real engine with a real wheel can answer it.
 *
 * What it presses (1440x900 and 1280x800, deviceScaleFactor 2, trackpad-sized 30x10 px
 * wheel steps AND mouse-wheel notches of 100 px):
 *   page      wheel over the content, a table row, a chart, a pill, a code block: the page
 *             moves, and does not jump back for --hold ms while a refresh lands
 *   inner     every overflow:auto/scroll box that overflows: it scrolls; at its end the
 *             page takes over (unless it is a floating panel)
 *   panels    bell, alert-notes popover, row menu: stay open and scroll under the wheel,
 *             survive a data refresh, close when the PAGE scrolls (intended)
 *   modals    wheel scrolls the dialog body, never the page behind; closing leaves the page
 *             scrollable
 *   keys      Space / PageDown / arrows with nothing focused (Alerts, Clusters)
 *   sticky    the sticky header does not cover the first row at the top
 *   clusters  the Clusters summary's column heads stay pinned under the top bar and line up
 *             with their columns while the page scrolls; its Columns panel and a cluster's
 *             name menu stay open under their own wheel and do not move the page
 *   hit       document.elementFromPoint at the pointer is the thing meant, not an overlay
 *
 * --config is a path the BRIDGE can read (same machine); it is remembered in the browser
 * the way the Config page does. Without it the bridge's own ELASTICPRO_CONFIG applies.
 * tools/scroll-fixture.json is that kind of fixture: 35 clusters, 30 of them at unreachable
 * ports, so there are 40+ alerts and the lists are long; a short list proves nothing about
 * scrolling. The first 30–60 s of a run is the fleet answering (--warm).
 *
 * Needs playwright with chromium and webkit (`npm i playwright && npx playwright install
 * chromium webkit`), found from the repo, the working directory or $PLAYWRIGHT_MODULES.
 * Exits 0 with a notice when it is absent, like the jsdom checks.
 */

import fs from 'node:fs';
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
const HOLD = Number(arg('--hold', '10000'));
const WARM = Number(arg('--warm', '30000'));
const ONLY = arg('--pages', '');
const VIEWPORTS = [[1440, 900], [1280, 800]];
const PAGES = ['alerts', 'overview', 'indices', 'shards', 'logs', 'console', 'snapshots', 'volume', 'automation', 'requests', 'accounts', 'settings']
  .filter((id) => !ONLY || ONLY.split(',').includes(id));

const pw = await loadPlaywright(ROOT, 'scroll-check');
if (!pw) process.exit(0);
try {
  const r = await fetch(`${BASE}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`scroll-check: no bridge at ${BASE} (${e.message})`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** [{ col, area, name, status: PASS|FAIL|SKIP, detail }] */
const results = [];

/* ------------------------------ in-page helpers ------------------------------ */
// Passed by value into page.evaluate, so each is self-contained.

const pageInfo = () => {
  const se = document.scrollingElement;
  const head = document.querySelector('.head-fix');
  return { y: Math.round(se.scrollTop), max: se.scrollHeight - innerHeight, vw: innerWidth, vh: innerHeight,
    headBottom: head ? Math.round(head.getBoundingClientRect().bottom) : 0 };
};

const describe = (el) => {
  if (!el) return 'nothing';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`;
};

/** Every box that scrolls on its own and has something to scroll to. */
const findScrollers = () => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.toast-wrap')) continue;
    const cs = getComputedStyle(el);
    const ox = /(auto|scroll)/.test(cs.overflowX), oy = /(auto|scroll)/.test(cs.overflowY);
    if (!ox && !oy) continue;
    const v = oy && el.scrollHeight > el.clientHeight + 4, hz = ox && el.scrollWidth > el.clientWidth + 4;
    if (!v && !hz) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20 || cs.visibility === 'hidden') continue;
    el.setAttribute('data-sc', String(out.length));
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
    out.push({ idx: out.length, key: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`,
      v, hz, floating: !!el.closest('.pop,.menu-pop,.modal-overlay') });
  }
  return out;
};

/** The first point of `el` that is both on screen and really hit by the pointer. */
const hitPoint = ({ sel, headBottom }) => {
  const el = document.querySelector(sel);
  if (!el) return { err: 'gone' };
  const r = el.getBoundingClientRect();
  const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth);
  const y0 = Math.max(r.top, headBottom + 4), y1 = Math.min(r.bottom, innerHeight - 4);
  if (x1 - x0 < 8 || y1 - y0 < 5) return { err: 'not on screen' };
  const seen = [];
  for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    for (const fx of [0.5, 0.3, 0.7]) {
      const x = Math.round(x0 + (x1 - x0) * fx), y = Math.round(y0 + (y1 - y0) * fy);
      const top = document.elementFromPoint(x, y);
      if (top && (el.contains(top) || top.contains(el))) return { x, y };
      seen.push(top);
    }
  }
  const d = (e) => {
    if (!e) return 'nothing';
    const c = typeof e.className === 'string' ? e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${c ? '.' + c : ''}`;
  };
  return { err: `covered by ${[...new Set(seen.map(d))].slice(0, 3).join(', ')}` };
};

/* --------------------------------- one run --------------------------------- */

/**
 * `framed`: the app inside an iframe under a 60 px bar, the way the Zabbix module shows it
 * (embed-module/views/elasticpro.embed.php: the frame fills the rest of the viewport and
 * scrolls its own document). The engines treat wheel events over a frame differently from
 * wheel events over the top document, which is where a Mac-only "cannot scroll" would hide.
 */
async function run(browserName, [vw, vh], framed = false) {
  const col = `${browserName === 'webkit' ? 'wk' : 'cr'} ${vw}${framed ? 'f' : ''}`;
  const OY = framed ? 60 : 0;   // where the app's own (0,0) sits on the page
  const rec = (area, name, status, detail = '') => results.push({ col, area, name, status, detail });
  const check = (area, name, ok, detail = '') => rec(area, name, ok ? 'PASS' : 'FAIL', ok ? '' : detail);

  const browser = await pw[browserName].launch();
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
  if (CONFIG) await ctx.addInitScript((p) => { try { localStorage.setItem('elasticpro.configPath', p); } catch { /* none */ } }, path.resolve(CONFIG));
  const p = await ctx.newPage();
  let F = p;                     // where the app's document lives: the page, or its frame
  const mv = (x, y) => p.mouse.move(x, y + OY);
  const mclick = (x, y) => p.mouse.click(x, y + OY);
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const info = () => F.evaluate(pageInfo);
  const toTop = async () => { await F.evaluate(() => { document.scrollingElement.scrollTo({ top: 0, behavior: 'instant' }); }); await sleep(120); };
  const settleScroll = (ms = 700) => sleep(ms);   // also lets a wheel gesture's latch lapse

  /** trackpad: many small steps; wheel: a few notches. */
  // Chromium animates wheel scrolling, and a loaded machine stretches it: wait for the page to
  // stop moving rather than for a fixed time, then a beat more so the gesture's latch lapses.
  const stable = async () => {
    let last = -1, same = 0;
    for (let i = 0; i < 30 && same < 3; i++) { const y = (await info()).y; same = y === last ? same + 1 : 0; last = y; await sleep(120); }
    await sleep(250);
  };
  const trackpad = async (dx, dy, n = 30) => { for (let i = 0; i < n; i++) { await p.mouse.wheel(dx, dy); await sleep(16); } await stable(); };
  const notches = async (dy, n = 5) => { for (let i = 0; i < n; i++) { await p.mouse.wheel(0, dy); await sleep(90); } await stable(); };

  /** What scrolled or resized from now on — says WHO closed a panel when a check fails. */
  const watch = () => F.evaluate(() => {
    window.__ev = [];
    const d = (t) => (t === document ? 'document' : `${t.tagName.toLowerCase()}.${String(t.className).split(' ')[0]}`);
    window.addEventListener('scroll', (e) => window.__ev.push(`scroll ${d(e.target)}@${Math.round(document.scrollingElement.scrollTop)}`), true);
    window.addEventListener('resize', () => window.__ev.push('resize'), true);
  });
  const heard = () => F.evaluate(() => (window.__ev || []).slice(0, 4).join(', ') || 'no scroll or resize event');
  const quiet = (ms = 900, max = 7000) => F.evaluate(({ ms, max }) => new Promise((res) => {
    let t = setTimeout(done, ms); const cap = setTimeout(done, max);
    const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, ms); });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    function done() { mo.disconnect(); clearTimeout(cap); clearTimeout(t); res(); }
  }), { ms, max });

  const goPage = async (id) => { await F.evaluate((id) => { location.hash = `#/${id}`; }, id); await sleep(1500); await quiet(); };

  /* ---- load, wait for the fleet to answer ---- */
  if (framed) {
    // the app says who may frame it (frame-ancestors); this stand-in parent is nobody
    await p.route(`${BASE}/**`, async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      const r = await route.fetch();
      const headers = { ...r.headers() }; delete headers['content-security-policy'];
      return route.fulfill({ response: r, headers });
    });
    await p.goto('about:blank');
    await p.setContent(`<body style="margin:0"><div style="height:60px;background:#333"></div><iframe src="${BASE}/#/alerts" style="display:block;width:100%;height:calc(100vh - 60px);border:0"></iframe></body>`);
    for (let i = 0; i < 100 && !p.frames().some((x) => x.url().startsWith(BASE)); i++) await sleep(100);
    F = p.frames().find((x) => x.url().startsWith(BASE));
  } else await p.goto(`${BASE}/#/alerts`);
  try { await F.waitForSelector('.head-fix', { timeout: 20000 }); } catch { /* reported below */ }
  const t0 = Date.now();
  while (Date.now() - t0 < WARM) {
    const loading = await F.evaluate(() => /No data read yet|loading/i.test(document.querySelector('#view')?.textContent || ''));
    if (!loading && Date.now() - t0 > 6000) break;
    await sleep(1000);
  }
  // ...and for the alert list to stop growing: the unreachable clusters fail one by one, and a
  // page that is still gaining rows under the wheel is a measurement of the wait, not of the page
  for (let same = 0, last = -1; Date.now() - t0 < WARM * 2 && same < 8; await sleep(1000)) {
    const n = await F.evaluate(() => document.querySelectorAll('#view tbody tr, #view .arow').length);
    same = n === last ? same + 1 : 0; last = n;
  }
  const alertRows = await F.evaluate(() => document.querySelectorAll('#view tbody tr, #view .arow').length);
  const shell = await F.evaluate(() => !!document.querySelector('.head-fix') && !!document.querySelector('#view'));
  check('setup', 'app loaded with data', shell && alertRows > 0, `shell=${shell} alert rows=${alertRows} — start the bridge with the fixture (see --config)`);
  if (!shell) { await browser.close(); return; }

  /* ---- 1. every page ---- */
  const ENTRIES = (framed ? ['alerts'] : PAGES).map((id) => [id, '']);
  for (const [id, variant] of ENTRIES) {
    const label = variant ? `${id}:${variant}` : id;
    await goPage(id);
    if (variant) {
      await F.evaluate((v) => { const sel = [...document.querySelectorAll('#view select')].find((x) => [...x.options].some((o) => o.value === v));
        if (sel) { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); } }, variant);
      await sleep(800); await quiet();
    }
    const view = await F.evaluate(() => document.querySelector('#view')?.children.length || 0);
    if (!view) { rec(`page ${label}`, 'drawn', 'SKIP', 'not available to this session'); continue; }
    await toTop();
    const pi = await info();
    const hd = pi.headBottom;

    // sticky head must not cover the first thing on the page at the top
    {
      const gap = await F.evaluate(() => {
        const head = document.querySelector('.head-fix').getBoundingClientRect().bottom;
        const first = [...document.querySelectorAll('#view > *')].find((e) => e.getBoundingClientRect().height > 0);
        const r = first.getBoundingClientRect();
        return { head, top: r.top };
      });
      check(`page ${label}`, 'sticky head clear of content', gap.top >= gap.head - 1, `content starts at ${Math.round(gap.top)} under head bottom ${Math.round(gap.head)}`);
    }

    // targets: where the pointer rests
    const TARGETS = [['content', null], ['row', '#view tbody tr, #view .arow'], ['chart', '#view .chart svg, #view svg.chart, #view .bar-mini'],
      ['pill', '#view .pill'], ['code', '#view pre, #view code']];

    if (pi.max <= 40) {
      rec(`page ${label}`, 'page scroll', 'SKIP', `page fits or is within ${pi.max}px of fitting (${pi.vh}px window)`);
    } else {
      for (const [tname, tq] of TARGETS) {
        await toTop();
        let x = Math.round(pi.vw / 2), y = Math.round(pi.vh * 0.62);
        if (tq) {
          // found and measured in one go: a page that redraws between the two would lose the mark
          const hp = await F.evaluate(({ q, hd }) => {
            const inScroller = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
              const cs = getComputedStyle(e);
              if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4) return true; } return false; };
            for (const el of document.querySelectorAll(q)) {
              const r = el.getBoundingClientRect();
              if (r.width < 8 || r.height < 6 || r.top < hd + 4 || r.bottom > innerHeight - 4) continue;
              if (inScroller(el) || el.closest('.pop,.toast-wrap')) continue;
              const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
              const top = document.elementFromPoint(x, y);
              if (top && (el.contains(top) || top.contains(el))) return { x, y };
              return { err: `pointer over ${top ? top.tagName.toLowerCase() + '.' + top.className : 'nothing'}, not the ${el.tagName.toLowerCase()} under it` };
            }
            return null;
          }, { q: tq, hd });
          if (!hp) continue;               // this page has none of those on screen
          if (hp.err) { check(`page ${label}`, `hit ${tname}`, false, hp.err); continue; }
          ({ x, y } = hp);
        } else {
          const top = await F.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return { d: e && e.closest('#view') ? 'view' : e ? e.tagName + '.' + e.className : 'nothing' }; }, { x, y });
          check(`page ${label}`, 'hit content', top.d === 'view', `pointer at ${x},${y} is over ${top.d}, not the page content`);
        }
        await mv(x, y);
        await trackpad(0, 10, 30);
        const a = await info();
        const want = Math.min(250, a.max * 0.8);
        check(`page ${label}`, `trackpad over ${tname}`, a.y >= want, `scrollY ${a.y} after 30x10px (page can go ${a.max})`);
        await toTop(); await mv(x, y);
        await notches(100, 5);
        const b = await info();
        const want2 = Math.min(400, b.max * 0.8);
        check(`page ${label}`, `wheel over ${tname}`, b.y >= want2, `scrollY ${b.y} after 5x100px (page can go ${b.max})`);
      }

      // ...and it stays where it was put while data keeps arriving
      await toTop();
      await mv(Math.round(pi.vw / 2), Math.round(pi.vh * 0.62));
      // half way down, not to the bottom: a refresh that trims a banner would clamp a page
      // that sits at its very end, and that is the browser's arithmetic, not a jump
      await trackpad(0, 10, Math.max(3, Math.min(15, Math.floor(pi.max / 20))));
      const y0 = (await info()).y;
      let low = y0, nap = 0;
      const t1 = Date.now();
      while (Date.now() - t1 < HOLD) {
        if (!nap && Date.now() - t1 > HOLD / 2) {
          nap = 1;
          await F.evaluate(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => /^\W*Refresh$/i.test(x.textContent.trim())); if (b) b.click(); });
        }
        await sleep(250);
        // a page that got shorter is clamped by the browser; only a fall with room left is a jump
        const now = await info();
        if (now.max >= y0) low = Math.min(low, now.y);
      }
      // 48 px of slack: a banner above ("refreshing…", "cached data") coming and going moves the offset by its own height
      check(`page ${label}`, `holds position ${HOLD / 1000}s + refresh`, low >= y0 - 48, `scrollY fell from ${y0} to ${low}`);
    }

    // inner scroll boxes
    const scrollers = await F.evaluate(findScrollers);
    const seen = new Set();
    for (const sc of scrollers) {
      if (seen.has(sc.key) || seen.size >= 5) continue;
      seen.add(sc.key);
      const sel = `[data-sc="${sc.idx}"]`;
      await F.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = 0; el.scrollLeft = 0; el.scrollIntoView({ block: 'center', behavior: 'instant' }); }, sel);
      await sleep(200);
      const hp = await F.evaluate(hitPoint, { sel, headBottom: hd });
      const area = `inner ${label}`;
      if (hp.err) { check(area, sc.key, false, hp.err); continue; }
      await mv(hp.x, hp.y);
      const read = () => F.evaluate((sel) => { const el = document.querySelector(sel); return el ? { t: Math.round(el.scrollTop), l: Math.round(el.scrollLeft), mt: el.scrollHeight - el.clientHeight, ml: el.scrollWidth - el.clientWidth } : null; }, sel);
      const before = await read();
      if (sc.v) await trackpad(0, 10, 12); else await trackpad(15, 0, 12);
      const after = await read();
      const moved = sc.v ? after.t > before.t : after.l > before.l;
      check(area, `${sc.key} scrolls`, moved, `${sc.v ? 'scrollTop' : 'scrollLeft'} ${sc.v ? before.t : before.l} → ${sc.v ? after.t : after.l} (room ${sc.v ? after.mt : after.ml})`);
      if (sc.floating) continue;
      // to its end, then the page must take over
      for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 400); await sleep(20); const r = await read(); if (r.t >= r.mt - 1) break; }
      await settleScroll();
      const pg = await info();
      if (pg.max - pg.y > 20) {
        await notches(80, 5);
        const pg2 = await info();
        check(area, `${sc.key} hands over at its end`, pg2.y > pg.y, `page stuck at ${pg.y} while the box sits at its end`);
      }
    }
  }

  /* ---- 2. floating panels ---- */
  await goPage('alerts');
  await toTop();
  const panelOpen = (q) => F.evaluate((q) => !!document.querySelector(q), q);
  // Somewhere on the page and not on the open panel: a panel keeps the wheel over itself
  // (menu.js keepWheel), so "the page scrolls" has to be wheeled from outside it. Where the
  // top bar wraps, a panel can open on the left and cover the usual spot.
  const farPoint = { x: 40, y: Math.round(vh * 0.7) };
  const awayFrom = async (sel) => {
    const spot = await F.evaluate(({ sel, vw, vh }) => {
      const r = document.querySelector(sel) && document.querySelector(sel).getBoundingClientRect();
      const head = document.querySelector('.head-fix').getBoundingClientRect().bottom;
      for (const [x, y] of [[40, vh * 0.7], [vw - 40, vh * 0.7], [vw / 2, vh - 30], [40, vh - 30], [vw - 40, vh - 30]]) {
        if (y > head && (!r || x < r.left || x > r.right || y < r.top || y > r.bottom)) return { x: Math.round(x), y: Math.round(y) };
      }
      return null;
    }, { sel, vw, vh });
    return spot || farPoint;
  };
  {
    // the bell, with a long history
    await F.evaluate(async () => {
      const m = await import('/js/ui/menu.js');
      for (let i = 0; i < 45; i++) m.toast(`scroll-check notice ${i} — a line long enough to wrap onto a second row in the bell`, i % 5 ? 'ok' : 'err', 100);
    });
    await sleep(400);
    await F.click('button.bell');
    await sleep(500);
    const list = '.pop .notif-list';
    const open = await panelOpen(list);
    check('panels', 'bell opens with a long list', open, 'no .notif-list');
    if (open) {
      const hp = await F.evaluate(hitPoint, { sel: list, headBottom: 0 });
      check('panels', 'bell list is under the pointer', !hp.err, hp.err);
      if (!hp.err) {
        await mv(hp.x, hp.y);
        await trackpad(0, 10, 20);
        const st = await F.evaluate(() => { const l = document.querySelector('.pop .notif-list'); return l && { t: Math.round(l.scrollTop), room: l.scrollHeight - l.clientHeight }; });
        check('panels', 'bell scrolls under trackpad', !!st && st.t > 0, st ? `scrollTop ${st.t} (room ${st.room})` : 'closed on first wheel');
        for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 400); await sleep(20); }
        await settleScroll();
        const y1 = (await info()).y;
        await notches(100, 5);
        const still = await panelOpen(list);
        check('panels', 'bell survives wheel past its end', still && (await info()).y === y1, still ? 'page scrolled behind it' : 'closed at the end of the list');
        if (still) {
          // an open bell must not be rebuilt under the reader by a refresh or a new notice
          await F.evaluate(() => { const l = document.querySelector('.pop .notif-list'); l.scrollTop = 150; });
          await watch();
          await F.evaluate(async () => { (await import('/js/ui/menu.js')).toast('scroll-check late notice', 'ok', 100); });
          await sleep(1500);
          await F.evaluate(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => /^\W*Refresh$/i.test(x.textContent.trim())); if (b) b.click(); });
          await sleep(Math.min(HOLD, 8000));
          const after = await F.evaluate(() => { const l = document.querySelector('.pop .notif-list'); return l ? Math.round(l.scrollTop) : null; });
          check('panels', 'bell keeps place through refresh', after !== null && after >= 100, after === null ? `closed by a refresh (${await heard()})` : `scrollTop 150 → ${after}`);
        }
      }
      if (await panelOpen(list)) {
        const pg = await info();
        if (pg.max > 20) {
          { const fp = await awayFrom('.pop'); await mv(fp.x, fp.y); }
          await notches(100, 3);
          check('panels', 'bell closes when the page scrolls', !(await panelOpen(list)), 'still open after the page moved away from its anchor');
        }
      }
    }
    await p.keyboard.press('Escape');
    await toTop();
  }
  {
    // notes popover: needs a long list, so write real notes
    const btn = '#view .arow button:has-text("💬")';
    if (await F.locator(btn).count()) {
      await F.evaluate(async () => { await (await import('/js/core/acks.js')).setCurrentUser('qa'); });
      for (let n = 0; n < 24; n++) {
        if (!(await panelOpen('.pop #note-input'))) { await F.locator(btn).first().click(); await sleep(250); }
        if (!(await panelOpen('.pop #note-input'))) break;
        await F.fill('.pop #note-input', `scroll-check note ${n}: something worth writing down about this alert, long enough to wrap`);
        await p.keyboard.press('Enter');
        await sleep(350);
      }
      await p.keyboard.press('Escape');
      await sleep(300);
      await F.locator(btn).first().click();
      await sleep(500);
      const body = '.pop > .body';
      const open = await panelOpen(body);
      check('panels', 'notes popover opens', open, 'no popover');
      if (open) {
        const geo = await F.evaluate(() => { const pop = document.querySelector('.pop'); const r = pop.getBoundingClientRect(); const b = pop.querySelector('.body'); return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight, room: b.scrollHeight - b.clientHeight }; });
        check('panels', 'notes popover fits the window', geo.top >= 0 && geo.bottom <= geo.vh, `popover spans ${geo.top}..${geo.bottom} in a ${geo.vh}px window`);
        const hp = await F.evaluate(hitPoint, { sel: '.pop > .body', headBottom: 0 });
        if (!hp.err && geo.room > 20) {
          await mv(hp.x, hp.y);
          await trackpad(0, 10, 20);
          const st = await F.evaluate(() => { const b = document.querySelector('.pop > .body'); return b && Math.round(b.scrollTop); });
          check('panels', 'notes list scrolls under trackpad', st > 0, st === null ? 'closed on first wheel' : `scrollTop ${st}`);
          await notches(100, 6);
          check('panels', 'notes list survives wheel notches', await panelOpen(body), 'closed while scrolling its own list');
          // a refresh while reading must not close or rewind it
          const mid = await F.evaluate(() => { const b = document.querySelector('.pop > .body'); b.scrollTop = 120; return Math.round(b.scrollTop); });
          await watch();
          await F.evaluate(() => { const b = [...document.querySelectorAll('.topbar button')].find((x) => /^\W*Refresh$/i.test(x.textContent.trim())); if (b) b.click(); });
          await sleep(Math.min(HOLD, 8000));
          const after = await F.evaluate(() => { const b = document.querySelector('.pop > .body'); return b ? Math.round(b.scrollTop) : null; });
          check('panels', 'notes keep place through refresh', after !== null && after >= mid - 4, after === null ? `closed by a refresh (${await heard()})` : `scrollTop ${mid} → ${after}`);
        } else rec('panels', 'notes list scrolls', 'SKIP', hp.err || `list fits (room ${geo.room})`);
        if (await panelOpen(body)) {
          const y0 = (await info()).y;
          { const fp = await awayFrom('.pop'); await mv(fp.x, fp.y); }
          await notches(100, 3);
          check('panels', 'notes close when the page scrolls', !(await panelOpen(body)), `still open after the page went ${y0} → ${(await info()).y}`);
        }
      }
      await p.keyboard.press('Escape');
    } else rec('panels', 'notes popover', 'SKIP', 'no alert rows with a notes button');
    await toTop();
  }
  {
    // row menu
    // a notes popover closing redraws the rows under the click that closed it: let that settle
    await mclick(6, Math.round(vh * 0.5)); await sleep(1500);
    const trig = '#view tbody tr button.menu-trigger';
    if (await F.locator(trig).count()) {
      await watch();
      // pressed where it is on screen, like a hand: a scripted click would scroll it into view first
      const spot = await F.evaluate((q) => { for (const el of document.querySelectorAll(q)) { const r = el.getBoundingClientRect();
        if (r.top > 100 && r.bottom < innerHeight) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; } return null; }, trig);
      if (spot) await mclick(spot.x, spot.y); else await F.locator(trig).first().click();
      await sleep(300);
      const open = await panelOpen('.menu-pop');
      check('panels', 'row menu opens', open, `no .menu-pop (${await heard()})`);
      if (open) {
        const hp = await F.evaluate(hitPoint, { sel: '.menu-pop', headBottom: 0 });
        if (!hp.err) { await mv(hp.x, hp.y); await trackpad(0, 10, 6); }
        // A menu that fits has nothing to scroll, so a wheel over it is the page's: closing is right.
        { const fp = await awayFrom('.menu-pop'); await mv(fp.x, fp.y); }
        await notches(100, 3);
        const pg = await info();
        if (pg.y > 0) check('panels', 'row menu closes when the page scrolls', !(await panelOpen('.menu-pop')), 'still open');
      }
      await p.keyboard.press('Escape');
    }
    await toTop();
  }

  /* ---- 2b. the Clusters page: pinned heads, Columns panel, name menu ---- */
  if (!framed && (!ONLY || PAGES.includes('overview'))) {
    // How far the page moved because of the wheel. The top bar wraps onto a second line and
    // back as its pills change length, and a browser that anchors scrolling moves the page by
    // exactly that much (or clamps it at the end); that is not the wheel getting through.
    const headH = () => F.evaluate(() => Math.round(document.querySelector('.head-fix').getBoundingClientRect().height));
    const movedByWheel = (y0, h0, a, h1) => a.y - y0 - (h1 - h0);
    await goPage('overview');
    // The whole fleet, so there is a table to scroll; the selection is put back afterwards.
    const prevSel = await F.evaluate(() => { const s = document.getElementById('cluster-select'); return s ? s.value : null; });
    const pickAll = (v) => F.evaluate((v) => { const s = document.getElementById('cluster-select'); if (s && [...s.options].some((o) => o.value === v)) { s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); } }, v);
    await pickAll('all'); await sleep(1200); await quiet();
    // Open every row's details so the table is taller than the window, as on a real fleet.
    await F.evaluate(() => { for (const b of [...document.querySelectorAll('.cl-summary tbody button.btn[aria-expanded="false"]')].slice(0, 8)) b.click(); });
    await sleep(800); await quiet();
    const tall = await F.evaluate(() => { const t = document.querySelector('table.cl-tbl'); return t ? Math.round(t.getBoundingClientRect().height) : 0; });
    if (tall < vh) rec('clusters', 'heads pinned while the page scrolls', 'SKIP', `table ${tall}px in a ${vh}px window`);
    else {
      await toTop();
      // wheel over a row until the table's top has gone under the top bar
      const start = await F.evaluate(() => { const r = document.querySelector('.cl-summary tbody tr').getBoundingClientRect(); return { x: Math.round(r.left + 200), y: Math.round(Math.min(Math.max(r.top + 10, 200), innerHeight - 60)) }; });
      await mv(start.x, start.y);
      for (let i = 0; i < 120; i++) {
        await p.mouse.wheel(0, 30); await sleep(16);
        if (i % 10 === 9 && await F.evaluate(() => document.querySelector('table.cl-tbl').getBoundingClientRect().top < document.querySelector('.head-fix').getBoundingClientRect().bottom - 150)) break;
      }
      await stable();
      const pin = await F.evaluate(() => {
        const head = document.querySelector('.head-fix').getBoundingClientRect().bottom;
        const strip = document.querySelector('.cl-head').getBoundingClientRect();
        const tblTop = document.querySelector('table.cl-tbl').getBoundingClientRect().top;
        const cells = [...document.querySelectorAll('.cl-head .cl-hcell')];
        const tr = [...document.querySelectorAll('.cl-summary tbody tr')].find((r) => r.children.length === cells.length && r.getBoundingClientRect().top > strip.bottom);
        const drift = tr ? Math.max(...cells.map((c, i) => Math.abs(c.getBoundingClientRect().left - tr.children[i].getBoundingClientRect().left))) : -1;
        const hit = document.elementFromPoint(Math.round(strip.left + 30), Math.round(strip.top + strip.height / 2));
        return { head: Math.round(head), stripTop: Math.round(strip.top), tblTop: Math.round(tblTop), drift: Math.round(drift * 10) / 10, onTop: !!(hit && hit.closest('.cl-head')) };
      });
      check('clusters', 'heads pinned while the page scrolls', pin.tblTop < pin.head && Math.abs(pin.stripTop - pin.head) <= 1, JSON.stringify(pin));
      check('clusters', 'pinned heads line up with their columns', pin.drift >= 0 && pin.drift <= 1.5, JSON.stringify(pin));
      check('clusters', 'pinned heads are on top, not covered', pin.onTop, JSON.stringify(pin));
    }
    await F.evaluate(() => { for (const b of document.querySelectorAll('.cl-summary tbody button.btn[aria-expanded="true"]')) b.click(); });
    await sleep(500);

    // the Columns panel: opens, the wheel inside it never closes it or moves the page
    await toTop();
    const colBtn = await F.evaluate(() => { const b = document.getElementById('cl-columns'); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
    if (!colBtn) rec('clusters', 'Columns panel', 'SKIP', 'no Columns button');
    else {
      await sleep(200);
      await mclick(colBtn.x, colBtn.y); await sleep(400);
      // The top bar can change height between finding the button and pressing it (it wraps
      // as its pills come and go): find it again and press once more.
      if (!(await panelOpen('.pop.cl-cols'))) {
        await quiet();
        const again = await F.evaluate(() => { const r = document.getElementById('cl-columns').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
        await mclick(again.x, again.y); await sleep(400);
      }
      const open = await panelOpen('.pop.cl-cols');
      check('clusters', 'Columns panel opens', open, 'no panel');
      if (open) {
        const geo = await F.evaluate(() => { const r = document.querySelector('.pop.cl-cols').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, vh: innerHeight }; });
        check('clusters', 'Columns panel fits the window', geo.top >= 0 && geo.bottom <= geo.vh && geo.left >= 0 && geo.right <= geo.vw, JSON.stringify(geo));
        const hp = await F.evaluate(hitPoint, { sel: '.pop.cl-cols > .body', headBottom: 0 });
        if (!hp.err) {
          const y0 = (await info()).y, h0 = await headH();
          await mv(hp.x, hp.y);
          await trackpad(0, 10, 20);
          await notches(100, 4);
          check('clusters', 'Columns panel stays open under its own wheel', await panelOpen('.pop.cl-cols'), 'closed while the wheel was over it');
          const a = await info();
          check('clusters', 'wheel over the Columns panel leaves the page', movedByWheel(y0, h0, a, await headH()) <= 1, `page moved ${y0} → ${a.y} (max ${a.max}, top bar ${h0} → ${await headH()})`);
        } else check('clusters', 'Columns panel hit', false, hp.err);
      }
      await p.keyboard.press('Escape'); await sleep(200);
      check('clusters', 'Columns panel closes on Escape', !(await panelOpen('.pop.cl-cols')), 'still open');
    }

    // the name menu: the same, and the page scrolling elsewhere closes it (intended)
    // bring the first names into the middle of the window (the pointer line and the toolbar fill the top)
    await F.evaluate(() => { const b = document.querySelector('.cl-summary tbody button.cl-name'); if (b) b.scrollIntoView({ block: 'center', behavior: 'instant' }); });
    await sleep(300);
    const nm = await F.evaluate(() => { for (const el of document.querySelectorAll('.cl-summary tbody button.cl-name')) { const r = el.getBoundingClientRect();
      if (r.top > 140 && r.bottom < innerHeight - 160) return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; } return null; });
    if (!nm) rec('clusters', 'name menu', 'SKIP', 'no cluster name on screen');
    else {
      await mclick(nm.x, nm.y); await sleep(300);
      // A push from the core may redraw the row between finding the name and pressing it.
      if (!(await panelOpen('.menu-pop'))) { await quiet(); await mclick(nm.x, nm.y); await sleep(300); }
      const open = await panelOpen('.menu-pop');
      check('clusters', 'name menu opens', open, 'no menu');
      if (open) {
        const hp = await F.evaluate(hitPoint, { sel: '.menu-pop', headBottom: 0 });
        const y0 = (await info()).y, h0 = await headH();
        if (!hp.err) { await mv(hp.x, hp.y); await trackpad(0, 10, 10); await notches(100, 3); }
        check('clusters', 'name menu stays open under its own wheel', await panelOpen('.menu-pop'), 'closed while the wheel was over it');
        const a = await info();
        check('clusters', 'wheel over the name menu leaves the page', movedByWheel(y0, h0, a, await headH()) <= 1, `page moved ${y0} → ${a.y} (max ${a.max}, top bar ${h0} → ${await headH()})`);
        { const fp = await awayFrom('.menu-pop'); await mv(fp.x, fp.y); }
        await notches(100, 3);
        if ((await info()).y > y0) check('clusters', 'name menu closes when the page scrolls', !(await panelOpen('.menu-pop')), 'still open');
      }
      await p.keyboard.press('Escape');
    }
    if (prevSel && prevSel !== 'all') { await pickAll(prevSel); await sleep(800); }
    await toTop();
  }

  /* ---- 3. modals ---- */
  const openers = [];
  {
    const long = (cls, n) => F.evaluate(async ({ cls, n }) => {
      const { modal } = await import('/js/ui/modal.js');
      const { h } = await import('/js/lib/dom.js');
      modal('scroll-check dialog', 'long content', Array.from({ length: n }, (_, i) => h('p', `Paragraph ${i} — enough words to take a line or two of the dialog.`)),
        (c) => [h('button.btn', { onclick: () => c.done(null) }, 'Close')], { cls });
    }, { cls, n });
    openers.push({ name: 'long dialog', open: () => long('', 60) }, { name: 'long drawer', open: () => long('drawer', 80) });
  }
  const modalCheck = async (name) => {
    await sleep(500);
    const ov = await F.evaluate(() => !!document.querySelector('.modal-overlay'));
    if (!ov) { rec('modals', name, 'SKIP', 'did not open'); return; }
    const sc = await F.evaluate(() => {
      const m = document.querySelector('.modal');
      const cands = [m, ...m.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4);
      cands.forEach((e, i) => e.setAttribute('data-ms', String(i)));
      return cands.map((e, i) => ({ i, d: e.className || e.tagName }));
    });
    // put the page somewhere it can be seen to move
    await F.evaluate(() => { document.scrollingElement.scrollTo({ top: 120, behavior: 'instant' }); });
    await sleep(150);
    const y0 = (await info()).y, max0 = (await info()).max;
    if (!sc.length) { rec('modals', `${name} body scrolls`, 'SKIP', 'content fits'); }
    else {
      const target = sc[0];
      const hp = await F.evaluate(hitPoint, { sel: `[data-ms="${target.i}"]`, headBottom: 0 });
      if (hp.err) check('modals', `${name} hit`, false, hp.err);
      else {
        await mv(hp.x, hp.y);
        await trackpad(0, 10, 20);
        const st = await F.evaluate((i) => Math.round(document.querySelector(`[data-ms="${i}"]`).scrollTop), target.i);
        check('modals', `${name} scrolls under trackpad`, st > 0, `scrollTop ${st}`);
        for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 400); await sleep(20); }
        await settleScroll();
        await notches(100, 5);
        const y1 = (await info()).y;
        check('modals', `${name} does not scroll the page behind`, y1 === y0 || max0 <= 40, `page moved ${y0} → ${y1} while wheeling a dialog at its end`);
      }
    }
    // backdrop wheel
    await F.evaluate(() => { document.scrollingElement.scrollTo({ top: 120, behavior: 'instant' }); });
    await sleep(150);
    const bd = await F.evaluate(() => { const o = document.querySelector('.modal-overlay'); const m = document.querySelector('.modal').getBoundingClientRect(); return { x: Math.max(8, Math.round(m.left / 2)), y: Math.round(innerHeight / 2), tight: m.left < 20 }; });
    if (!bd.tight && max0 > 40) {
      const yb = (await info()).y;
      await mv(bd.x, bd.y); await notches(100, 3);
      check('modals', `${name} backdrop wheel leaves page`, (await info()).y === yb, `page moved from ${yb}`);
    }
    await p.keyboard.press('Escape');
    await sleep(400);
    const after = await F.evaluate(() => ({ ov: !!document.querySelector('.modal-overlay'),
      ob: getComputedStyle(document.body).overflow, oh: getComputedStyle(document.documentElement).overflow }));
    const hidden = /hidden/.test(after.ob + after.oh);
    check('modals', `${name} closes cleanly`, !after.ov && !hidden, `overlay left=${after.ov} body overflow=${after.ob} html overflow=${after.oh}`);
    if (max0 > 40 && (await info()).max > 40) {
      await mv(Math.round(vw / 2), Math.round(vh * 0.6));
      await F.evaluate(() => { document.scrollingElement.scrollTo({ top: 0, behavior: 'instant' }); });
      await sleep(150);
      const ya = (await info()).y;
      await notches(100, 3);
      check('modals', `${name}: page scrolls again after close`, (await info()).y > ya, 'wheel does nothing after the dialog closed');
    }
  };
  await goPage('alerts');
  for (const o of openers) { await o.open(); await modalCheck(o.name); }
  // dialogs the pages open themselves: any button that opens a .modal-overlay and is not a write
  for (const id of ['settings', 'snapshots', 'alerts', 'overview', 'automation']) {
    if (ONLY && !PAGES.includes(id)) continue;
    await goPage(id);
    const labels = await F.evaluate(() => [...document.querySelectorAll('#view button, #view a.btn')]
      .map((b) => (b.textContent || '').trim())
      .filter((t) => /^(evidence|details?|view|edit|rules?|open|show|tune|configure|manage|preview|add|new|notes?)\b/i.test(t) && !/delete|remove|apply|save|restore|run/i.test(t))
      .slice(0, 40));
    const tried = new Set();
    for (const label of labels) {
      if (tried.has(label) || tried.size >= 4) continue;
      tried.add(label);
      await toTop();
      const loc = F.locator('#view button', { hasText: label }).first();
      try { await loc.scrollIntoViewIfNeeded({ timeout: 1500 }); await loc.click({ timeout: 1500 }); } catch { continue; }
      await sleep(400);
      if (await F.evaluate(() => !!document.querySelector('.modal-overlay'))) await modalCheck(`${id}: "${label}"`);
      else { await p.keyboard.press('Escape'); await F.evaluate(() => document.querySelector('.pop') && document.body.click()); }
    }
  }

  /* ---- 4. keyboard ---- */
  for (const id of ['alerts', 'overview']) {
    await goPage(id);
    // In a frame the parent has the keyboard until somebody clicks inside: not the app's to fix.
    for (const [name, key, min] of framed ? [] : [['Space', 'Space', 200], ['PageDown', 'PageDown', 200], ['ArrowDown', 'ArrowDown', 20]]) {
      await toTop();
      await F.evaluate(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
      await p.keyboard.press(key === 'Space' ? ' ' : key);
      await stable();
      const y = (await info()).y;
      const pg = await info();
      if (pg.max <= 4) { rec('keys', `${id} ${name}`, 'SKIP', 'page fits'); continue; }

      // Playwright's WebKit does not synthesize arrow-key scrolling reliably — a bare tall
      // page does not move either — so there an arrow that fails is the harness, not the app.
      if (key === 'ArrowDown' && y < min && browserName === 'webkit') { rec('keys', `${id} ${name} (nothing focused)`, 'SKIP', 'WebKit harness does not scroll on arrows'); continue; }
      check('keys', `${id} ${name} (nothing focused)`, y >= min, `scrollY ${y} after ${key}`);
    }
    // after a click on blank page, the usual way to arrive at the keyboard
    await toTop();
    await mclick(6, Math.round(vh * 0.6));
    await p.keyboard.press('PageDown');
    await stable();
    const pg = await info();
    if (pg.max > 4) check('keys', `${id} PageDown after clicking the page`, pg.y >= 200, `scrollY ${pg.y}`);
  }

  check('setup', 'no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
}

/* ---------------------------------- report ---------------------------------- */

const jobs = [];
for (const b of BROWSERS) for (const vp of VIEWPORTS) jobs.push([b, vp]);
// One browser at a time per viewport pair would be kinder to the bridge, but the two engines
// do not interact: run the engines side by side, the viewports one after the other.
await Promise.all(BROWSERS.map(async (b) => {
  for (const [vp, framed] of [...VIEWPORTS.map((v) => [v, false]), [VIEWPORTS[0], true]]) {
    try { await run(b, vp, framed); } catch (e) { results.push({ col: `${b === 'webkit' ? 'wk' : 'cr'} ${vp[0]}${framed ? 'f' : ''}`, area: 'setup', name: 'run completed', status: 'FAIL', detail: e.message.split('\n')[0] }); }
  }
}));

const cols = [...new Set(results.map((r) => r.col))].sort();
const rows = [...new Set(results.map((r) => `${r.area}\u0000${r.name}`))];
const width = Math.min(70, Math.max(...rows.map((r) => r.replace('\u0000', ' · ').length)));
const cell = (row, col) => {
  const rs = results.filter((r) => `${r.area}\u0000${r.name}` === row && r.col === col);
  if (!rs.length) return '  -  ';
  return rs.some((r) => r.status === 'FAIL') ? ' FAIL' : rs.every((r) => r.status === 'SKIP') ? ' skip' : ' PASS';
};
console.log(`\n${'check'.padEnd(width)}  ${cols.map((c) => c.padEnd(8)).join(' ')}`);
for (const row of rows) console.log(`${row.replace('\u0000', ' · ').slice(0, width).padEnd(width)} ${cols.map((c) => cell(row, c).padEnd(9)).join('')}`);
if (process.argv.includes('--skips')) {
  console.log('\nSKIPPED');
  for (const r of results.filter((x) => x.status === 'SKIP')) console.log(`  [${r.col}] ${r.area} · ${r.name}: ${r.detail}`);
}
const failed = results.filter((r) => r.status === 'FAIL');
if (failed.length) {
  console.log('\nFAILURES');
  for (const f of failed) console.log(`  [${f.col}] ${f.area} · ${f.name}: ${f.detail}`);
}
const n = (s) => results.filter((r) => r.status === s).length;
console.log(`\nscroll-check: ${n('PASS')} pass, ${failed.length} fail, ${n('SKIP')} skipped (${cols.join(', ')})`);
process.exit(failed.length ? 1 : 0);
