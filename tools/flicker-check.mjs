#!/usr/bin/env node
/**
 * Does anything flicker while the page refreshes itself? In WebKit and Chromium, with every
 * page's own timers and the core's pushes running:
 *
 *   for i in 0 1 2 3 4; do MOCK_CLUSTER_NAME=mock$i node tools/mock-es.mjs $((9299+i)) & done
 *   ELASTICPRO_DATA_DIR=$(mktemp -d) cargo run -p elasticpro-core --features bridge \
 *     --bin elasticpro-bridge -- ui 8765 &
 *   node tools/flicker-check.mjs --config $PWD/tools/fit-fixture.json
 *   node tools/flicker-check.mjs --browsers webkit --pages requests/health,reports/exports
 *   node tools/flicker-check.mjs --pages log-delay,log-delay/watch --ld-delay 15000   # slow answers
 *   node tools/flicker-check.mjs --pages log-delay --ld-delay fail                    # failing answers
 *
 * Why it exists: the pages redraw on every push from the core and on their own timers (the
 * request log every 2 s, ElasticPro health every 5 s, the report jobs every 2 s while one
 * runs). A redraw that rebuilds what did not change replaces the row under the mouse — the
 * hover colour blinks, a title tooltip closes, a press that lands between the down and the up
 * hits an element that is gone — closes an open <details> or <select>, and puts a new search
 * box where the one being typed into was. jsdom has no pointer, no hover and no layout, so
 * render-check and behaviour-check cannot see any of it.
 *
 * What it measures, per page (and per tab or section):
 *   typing    a search box, one character every 150 ms for --type-ms (10 s), while the polls
 *             run: focus stays in it, the caret and the value are what was typed, and the
 *             element is the same one the whole time (identity and isConnected after every
 *             key). A page without a search box is "—".
 *   pointer   the mouse parked on a row, button or pill for --hover-ms (15 s): how many times
 *             the element under it was replaced, whether :hover and the cursor changed, and
 *             whether a details/select/tooltip that was open closed. A redraw whose data did
 *             not change must not touch it.
 *   redraws   childList mutations under #view per redraw (a burst of mutations is one redraw),
 *             and the largest number any one card took in one redraw.
 *   shift     how far content moved during a redraw with the scroll position unchanged (the
 *             tops of cards, rows and tiles, sampled every 100 ms), plus Chromium's own
 *             layout-shift score.
 *   errors    uncaught errors, console errors and failed requests while on the page.
 *
 * The Log Delay page's boards read the core's store (LOGDELAY_*), which a fresh data directory has
 * empty: their answers come from tools/lib/logdelay-fixture.mjs, as in fit-check. `--ld-delay <ms>`
 * holds each of those answers that long before it arrives (4000 and 15000: the owner's "it
 * flickers while it fetches"), and `--ld-delay fail` answers each with a timeout after 4 s — the
 * pointer is parked while they are still out, so an answer arriving must not replace what is under it.
 *
 * Exit 1 when a search box loses focus, a character or its element, or when the element under
 * a parked pointer is replaced more than --max-replaced times (default 0) on a page listed in
 * STRICT (the ones fixed in 0.3.54); the rest is reported. --json writes every figure.
 *
 * Nothing here writes. Needs playwright with chromium and webkit (see scroll-check.mjs); exits
 * 0 with a notice when it is absent, like the jsdom checks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './lib/playwright.mjs';
import { logDelayAnswer, logDelayData } from './lib/logdelay-fixture.mjs';
import { jobsListAnswer } from './lib/jobs-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('--base', 'http://127.0.0.1:8765').replace(/\/$/, '');
const CONFIG = arg('--config', '');
const BROWSERS = arg('--browsers', 'chromium,webkit').split(',');
const TYPE_MS = Number(arg('--type-ms', '10000'));
const HOVER_MS = Number(arg('--hover-ms', '15000'));
const MAX_REPLACED = Number(arg('--max-replaced', '0'));
const SIZE = arg('--size', '1366x768').split('x').map(Number);
const SCHEME = arg('--scheme', 'light');
const JSON_OUT = arg('--json', '');
const SHOTS = arg('--shots', '');
const PAGE_FILTER = arg('--pages', '');
const ROLE = arg('--role', 'admin');
const LD_DELAY = arg('--ld-delay', '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Every page and tab, with its search box (null when it has none) and where to park the
 * pointer (the first visible match of each selector, in order). `setup` runs on arrival.
 */
const PAGES = [
  { id: 'alerts', search: '#alerts-search', hover: ['#view .al-row, #view tbody tr', '#view .seg-group button', '#view .pill'] },
  { id: 'overview', search: '#clusters-search', setup: async (F) => { await F.evaluate(() => document.querySelector('#view .cl-searchbox button')?.click()); },
    hover: ['#view tbody tr', '#view .pill', '#view .btn'] },
  { id: 'indices', search: '#idx-search, #idx-search2', hover: ['#view tbody tr', '#view .pill', '#view .btn'] },
  { id: 'shards', search: '#view input[type=search]', hover: ['#view tbody tr', '#view .pill', '#view .btn'] },
  // The Log Delay page (was Logs & Delay, 0.3.60): every view. @c / @d are the fixture's first
  // cluster and its worst device. The pointer goes on a device row once one is drawn, else on a tab.
  { id: 'log-delay', search: '#ld-dev-filter', hover: ['#ld-devices tbody tr', '#view .ld-tabs a', '#view .btn'] },
  { id: 'log-delay/cluster/@c', search: '#ld-cd-filter', hover: ['#ld-cluster-devices tbody tr', '#view .ld-tabs a', '#view .btn'] },
  { id: 'log-delay/device/@c/@d', search: '#ld-q-name', hover: ['#ld-periods tbody tr', '#view .ld-kpi', '#view .ld-tabs a'] },
  { id: 'log-delay/fixes', search: '#ld-fix-filter', hover: ['#ld-fix-devices tbody tr', '#view .ld-fix', '#view .ld-tabs a'] },
  { id: 'log-delay/watch', search: null, setup: async (F) => { await F.evaluate(() => document.querySelector('#delay-fetch')?.click()); await sleep(4000); },
    hover: ['#ld-watch-devices tbody tr', '#view .ld-tabs a', '#view .btn'] },
  { id: 'log-delay/live', search: '#ld-live-value', hover: ['#ld-live-logs tbody tr', '#view .ld-tabs a', '#view .btn'] },
  { id: 'console', search: '#c-histfilter, #c-saved-filter', hover: ['#view .btn', '#view .tab'] },
  { id: 'snapshots', search: '#view input[aria-label="Search snapshots"]',
    setup: async (F) => { await F.evaluate(() => [...document.querySelectorAll('#view [title^="Open "]')][0]?.click()); }, hover: ['#view tbody tr', '#view .pill', '#view .btn'] },
  { id: 'reports/overview', search: null, hover: ['#view tbody tr', '#view .btn', '#view .pill'] },
  { id: 'reports/daily', search: null, hover: ['#view tbody tr', '#view .btn'] },
  { id: 'reports/hosts', search: '#hv-q', hover: ['#view .hv-tbl tbody tr', '#view .hv-tbl th.sortable', '#view .btn'] },
  { id: 'reports/capacity', search: null, hover: ['#view tbody tr', '#view .btn'] },
  { id: 'reports/measure', search: null, hover: ['#view .btn', '#view tbody tr'] },
  { id: 'reports/planning', search: null, hover: ['#view tbody tr', '#view .btn'] },
  { id: 'reports/exports', search: '#rt-volume-subject', hover: ['#view .rj-job .btn', '#view .rj-job', '#view .rp-dlc .btn'] },
  { id: 'automation', search: null, hover: ['#view tbody tr', '#view .btn'] },
  // Jobs: JOBS_LIST is stubbed with a run that moves 5 % a read (every 2 s): the Stop button under a
  // parked pointer, its row and the bar must stay the same elements while it does.
  { id: 'jobs', search: null, hover: ['#view tr[data-run="4b0e1c2d3e4f5a6b"] .jb-stop', '#view tr[data-run] .jb-stop', '#view .jb-chip'] },
  { id: 'requests', search: null, hover: ['#view .rq-tbl tbody tr', '#view select', '#view .btn'] },
  { id: 'requests/health', search: null, hover: ['#view .hl-chip', '#view [data-check] td', '#view .hl-page details summary'] },
  { id: 'accounts', search: '#view input[aria-label="Filter by user"]', hover: ['#view tbody tr', '#view .btn'] },
  { id: 'settings', search: null, hover: ['#view tbody tr', '#view .subnav button', '#view .pill'] },
  { id: 'play', search: null, hover: ['.pl-slide .pl-tile, .pl-slide .pl-arow', '.pl-head'] },
].filter((p) => !PAGE_FILTER || PAGE_FILTER.split(',').includes(p.id));

/** Pages whose pointer figures must be zero (the redraws fixed in 0.3.54); others are reported. */
const STRICT = new Set(['requests', 'requests/health', 'reports/exports', 'reports/hosts',
  'log-delay', 'log-delay/cluster/@c', 'log-delay/device/@c/@d', 'log-delay/fixes', 'log-delay/watch', 'log-delay/live', 'jobs']);

const pw = await loadPlaywright(ROOT, 'flicker-check');
if (!pw) process.exit(0);
try {
  const r = await fetch(`${BASE}/bridge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`flicker-check: no bridge at ${BASE} (${e.message})`);
  process.exit(1);
}

/* ------------------------------ in-page instruments ------------------------------ */

/** Installed once per page load: a recorder the steps below start and read. */
const INSTRUMENTS = () => {
  if (window.__fl) return;
  const fl = window.__fl = { cls: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput && fl.on) fl.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: false });
    fl.clsSupported = true;
  } catch { fl.clsSupported = false; }
  const panelOf = (n) => {
    for (let e = n && n.nodeType === 1 ? n : n && n.parentElement; e && e.id !== 'view'; e = e.parentElement) {
      if (e.matches && e.matches('.card, section, .hl-strip, .hl-head, .rq-top, .toolbar, .tiles, .pl-slide')) {
        const t = e.querySelector(':scope > header h2, :scope > h2');
        return `${e.tagName.toLowerCase()}.${String(e.className).split(/\s+/)[0]}${t ? `:${t.textContent.slice(0, 24)}` : ''}`;
      }
    }
    return 'view';
  };
  /** Start recording, with the pointer at (x, y) (or none). */
  fl.start = (x, y) => {
    fl.on = true; fl.cls = 0;
    const view = document.querySelector('#view') || document.body;
    const rec = fl.rec = { childList: 0, removed: 0, bursts: [], panels: {}, replaced: 0, hoverLost: 0, cursorChanged: 0,
      shiftEvents: 0, shiftMaxPx: 0, openClosed: 0, t0: performance.now() };
    let burst = null, last = 0;
    const under = () => (x === null ? null : document.elementFromPoint(x, y));
    let el = under();
    let cursorWas = el ? getComputedStyle(el).cursor : '';
    let hovered = el ? el.matches(':hover') : false;
    const openNow = () => document.querySelectorAll('#view details[open]').length + document.querySelectorAll('.tip[style*="block"], .pop, .menu-pop').length;
    let open0 = openNow();
    fl.mo = new MutationObserver((ms) => {
      const t = performance.now();
      if (!burst || t - last > 250) { burst = { t: Math.round(t - rec.t0), n: 0, panels: {} }; rec.bursts.push(burst); }
      last = t;
      for (const m of ms) {
        if (m.type !== 'childList') continue;
        rec.childList++; burst.n++;
        for (const r of m.removedNodes) rec.removed += 1 + (r.getElementsByTagName ? r.getElementsByTagName('*').length : 0);
        const p = panelOf(m.target);
        burst.panels[p] = (burst.panels[p] || 0) + 1;
        if (el) for (const r of m.removedNodes) if (r === el || (r.contains && r.contains(el))) { rec.replaced++; break; }
      }
    });
    fl.mo.observe(view, { childList: true, subtree: true });
    // positions: the tops of what a reader's eye holds on to, keyed by what it says
    const key = (e) => `${e.tagName}|${(e.textContent || '').trim().slice(0, 40)}`;
    const tops = () => {
      const m = new Map();
      for (const e of document.querySelectorAll('#view .card > header, #view tr, #view .tile, #view .hl-chip, #view h2, #view .toolbar, #view .rj-job')) {
        const r = e.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight || !r.height) continue;
        const k = key(e);
        if (!m.has(k)) m.set(k, r.top);
        if (m.size >= 60) break;
      }
      return m;
    };
    let prev = tops(), sy = scrollY;
    fl.timer = setInterval(() => {
      const now = under();
      if (x !== null && now !== el) {
        if (el && !el.isConnected) rec.replaced += 0;           // counted by the observer
        el = now;
      }
      if (el) {
        const hv = el.matches(':hover');
        if (hovered && !hv) rec.hoverLost++;
        hovered = hv;
        const cur = getComputedStyle(el).cursor;
        if (cur !== cursorWas) { rec.cursorChanged++; cursorWas = cur; }   // transitions, not samples
      }
      const o = openNow();
      if (o < open0) rec.openClosed += open0 - o;
      open0 = o;
      const cur = tops();
      if (scrollY === sy) {
        let moved = 0;
        for (const [k, t] of cur) { const p0 = prev.get(k); if (p0 !== undefined && Math.abs(p0 - t) > 0.5) { moved = Math.max(moved, Math.abs(p0 - t)); } }
        if (moved) { rec.shiftEvents++; rec.shiftMaxPx = Math.max(rec.shiftMaxPx, Math.round(moved)); }
      }
      prev = cur; sy = scrollY;
    }, 100);
  };
  fl.stop = () => {
    fl.on = false;
    if (fl.mo) fl.mo.disconnect();
    clearInterval(fl.timer);
    const rec = fl.rec;
    for (const b of rec.bursts) for (const [p, n] of Object.entries(b.panels)) rec.panels[p] = Math.max(rec.panels[p] || 0, n);
    const redraws = rec.bursts.length;
    const worstPanel = Object.entries(rec.panels).sort((a, b) => b[1] - a[1])[0] || null;
    return { ...rec, redraws, perRedraw: redraws ? Math.round(rec.childList / redraws) : 0, worstPanel, cls: fl.clsSupported ? Number(fl.cls.toFixed(4)) : null, bursts: rec.bursts.map((b) => [b.t, b.n]) };
  };
};

/* ----------------------------------- one browser ---------------------------------- */

const results = [];

async function run(browserName) {
  const browser = await pw[browserName].launch();
  const ctx = await browser.newContext({ viewport: { width: SIZE[0], height: SIZE[1] }, colorScheme: SCHEME });
  if (CONFIG) await ctx.addInitScript((p) => { try { localStorage.setItem('elasticpro.configPath', p); } catch { /* none */ } }, path.resolve(CONFIG));
  await ctx.addInitScript(INSTRUMENTS);
  // A signed-in administrator on the hosted build, so the Accounts page is there (as fit-check).
  const WHOAMI = { ok: true, authRequired: true, needsBootstrap: false, apiTokens: true, edition: 'hosted', caller: { name: 'qa', role: ROLE } };
  let ldList = [];
  let jobReads = 0;
  await ctx.route(`${BASE}/bridge`, async (route) => {
    const t = ((route.request().postData() || '').match(/"type"\s*:\s*"([A-Z_]+)"/) || [])[1];
    if (t === 'WHOAMI') return route.fulfill({ json: WHOAMI });
    if (t === 'JOBS_LIST') return route.fulfill({ json: jobsListAnswer({ step: jobReads++ }) });
    // The log delay store's answers (see the header): from the fixture, held --ld-delay ms, or failing.
    if (t && t.startsWith('LOGDELAY_') && ldList.length) {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not ours */ }
      const fail = LD_DELAY === 'fail';
      const wait = fail ? 4000 : Number(LD_DELAY) || 0;
      if (wait) await sleep(wait);
      if (fail) return route.fulfill({ json: { ok: false, kind: 'timeout', message: 'the store did not answer in time' } }).catch(() => {});
      const a = logDelayAnswer(body, ldList);
      if (a) return route.fulfill({ json: a }).catch(() => {});
    }
    return route.continue().catch(() => {});
  });
  const p = await ctx.newPage();
  let errs = [];
  p.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 160)}`); });
  p.on('requestfailed', (r) => { const f = r.failure(); if (!/aborted|cancel/i.test((f && f.errorText) || '')) errs.push(`failed: ${r.url().replace(BASE, '')} ${(f && f.errorText) || ''}`); });
  p.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) errs.push(`HTTP ${r.status()}: ${r.url().replace(BASE, '')}`); });

  await p.goto(`${BASE}/#/overview`);
  await p.waitForSelector('.head-fix', { timeout: 30000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const ready = await p.evaluate(async () => {
      try { const S = await import('/js/core/state.js'); return [...S.state.data.values()].filter((d) => d.reachable).length >= 3; } catch { return false; }
    });
    if (ready) break;
    await sleep(1000);
  }
  await sleep(2000);

  for (const pg of PAGES) {
    errs = [];
    const row = { browser: browserName, page: pg.id, size: SIZE.join('x'), scheme: SCHEME, ldDelay: pg.id.startsWith('log-delay') ? LD_DELAY : null };
    let to = pg.id;
    if (to.startsWith('log-delay') && !ldList.length) ldList = await p.evaluate(async () => (await import('/js/core/state.js')).clusters().map((c) => ({ id: c.id, name: c.name })));
    if (to.includes('@c')) {
      const first = logDelayData(ldList).per[0];
      to = to.replace('@c', encodeURIComponent(first ? first.c.id : '')).replace('@d', encodeURIComponent(first ? first.rows[0].device : ''));
    }
    await p.evaluate((id) => { location.hash = `#/${id}`; }, to);
    await sleep(2500);
    if (pg.setup) { await pg.setup(p); await sleep(600); }
    await p.evaluate(INSTRUMENTS);

    /* ---- typing ---- */
    if (pg.search && TYPE_MS > 0) {
      const sel = await p.evaluate((s) => {
        const el = [...document.querySelectorAll(s)].find((e) => e.offsetParent !== null);
        if (!el) return null;
        window.__flIn = el;           // held by reference: a marker attribute would change the markup the page compares
        return true;
      }, pg.search);
      if (!sel) row.typing = { skipped: 'no visible search box' };
      else {
        const handle = await p.evaluateHandle(() => window.__flIn);
        await handle.click();
        await handle.fill('');
        await p.evaluate((s) => { window.__flIn = [...document.querySelectorAll(s)].find((e) => e.offsetParent !== null); }, pg.search);
        await p.evaluate(() => window.__fl.start(null, null));
        const pattern = 'mock-zz';      // matches, then stops matching: the table under it changes
        let expect = '', caret = 0;
        const ty = { keys: 0, focusLost: 0, replaced: 0, valueWrong: 0, caretWrong: 0, first: '' };
        const tEnd = Date.now() + TYPE_MS;
        let i = 0;
        // Keys only ever go to a text field: a Backspace that lands on the page is "back" in WebKit.
        const refocus = async () => {
          const v = await p.evaluate((sel) => {
            const el = (window.__flIn && window.__flIn.isConnected && window.__flIn.matches(sel) ? window.__flIn : null) || [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
            if (!el) return null;
            window.__flIn = el;
            el.focus(); el.setSelectionRange(el.value.length, el.value.length);
            return el.value;
          }, pg.search);
          if (v === null) return false;
          expect = v; caret = v.length;
          return true;
        };
        while (Date.now() < tEnd) {
          const typing = await p.evaluate(() => document.activeElement === window.__flIn && window.__flIn.isConnected);
          if (!typing && !(await refocus())) { ty.first = ty.first || 'the search box is gone'; break; }
          const step = i % (pattern.length + 3);
          if (step < pattern.length) { const ch = pattern[step]; await p.keyboard.type(ch); expect = expect.slice(0, caret) + ch + expect.slice(caret); caret++; }
          else if (step === pattern.length) { await p.keyboard.press('ArrowLeft'); caret = Math.max(0, caret - 1); }
          // ArrowRight, not End: End does not move the caret in WebKit on a Mac
          else { await p.keyboard.press('ArrowRight'); caret = Math.min(expect.length, caret + 1); if (step === pattern.length + 2 && expect.length > 14) { await p.evaluate(() => { const el = window.__flIn; if (el && el.select) el.select(); }); await p.keyboard.press('Backspace'); expect = ''; caret = 0; } }
          i++; ty.keys++;
          await sleep(150);
          const s = await p.evaluate(() => {
            const el = window.__flIn || document.body;
            const now = document.activeElement;
            return { connected: el.isConnected, same: document.activeElement === el, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
              value: el.value, start: el.selectionStart, end: el.selectionEnd, liveValue: now && now.value };
          });
          if (!s.connected) ty.replaced++;
          if (!s.same) ty.focusLost++;
          if (s.value !== expect && s.liveValue !== expect) ty.valueWrong++;
          if (s.same && (s.start !== caret || s.end !== caret)) ty.caretWrong++;
          if (!ty.first && (!s.connected || !s.same || s.value !== expect)) ty.first = `after ${ty.keys} keys: connected=${s.connected} focused=${s.same} active=${s.active} value=${JSON.stringify(s.value)} want ${JSON.stringify(expect)}`;
          // a lost box is found again (by its marker or the focused element) so the run goes on
          if (!s.connected) await p.evaluate((sel) => { window.__flIn = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null) || document.activeElement; }, pg.search);
        }
        ty.mut = await p.evaluate(() => window.__fl.stop());
        row.typing = ty;
        if (await refocus()) {
          await p.evaluate(() => { const el = window.__flIn; if (el && el.select) el.select(); });
          await p.keyboard.press('Backspace');
        }
        await p.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
        await sleep(600);
      }
    }

    /* ---- pointer ---- */
    const target = await p.evaluate((sels) => {
      for (const s of sels) {
        const el = [...document.querySelectorAll(s)].find((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.top > 60 && r.bottom < innerHeight - 4; });
        if (el) { const r = el.getBoundingClientRect(); return { sel: s, x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2), tag: el.tagName, text: (el.textContent || '').trim().slice(0, 30) }; }
      }
      return null;
    }, pg.hover);
    if (target && HOVER_MS > 0) {
      await p.mouse.move(target.x, target.y);
      // a details on the health tab is opened first: a redraw must not close it
      if (pg.id === 'requests/health') await p.evaluate(() => { document.querySelectorAll('#view details').forEach((d) => { d.open = true; d.dispatchEvent(new Event('toggle')); }); });
      await sleep(300);
      await p.evaluate(({ x, y }) => window.__fl.start(x, y), target);
      await sleep(HOVER_MS);
      row.pointer = { target, ...(await p.evaluate(() => window.__fl.stop())) };
    } else row.pointer = { skipped: 'nothing to point at' };
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${browserName}-${SIZE.join('x')}-${SCHEME}-${pg.id.replace('/', '_')}.png`) }).catch(() => {}); }
    row.errors = [...new Set(errs)];
    results.push(row);
    const ty = row.typing;
    const po = row.pointer;
    console.log(`${browserName.padEnd(8)} ${pg.id.padEnd(17)} ` +
      `typing ${ty ? (ty.skipped ? '—' : `focusLost=${ty.focusLost} replaced=${ty.replaced} valueWrong=${ty.valueWrong} caretWrong=${ty.caretWrong} redraws=${ty.mut.redraws} removedEls=${ty.mut.removed}`) : '—'} | ` +
      `pointer ${po.skipped ? '—' : `replaced=${po.replaced} hoverLost=${po.hoverLost} cursor=${po.cursorChanged} closed=${po.openClosed} redraws=${po.redraws} perRedraw=${po.perRedraw} removedEls=${po.removed} worst=${po.worstPanel ? po.worstPanel.join(':') : '-'} shift=${po.shiftEvents}/${po.shiftMaxPx}px cls=${po.cls}`} | ` +
      `errors ${row.errors.length}${row.errors.length ? ' ' + row.errors.slice(0, 2).join(' ; ') : ''}`);
    if (ty && ty.first) console.log(`         first typing problem: ${ty.first}`);
  }
  await browser.close();
}

for (const b of BROWSERS) await run(b);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));

let bad = 0;
for (const r of results) {
  const ty = r.typing;
  if (ty && !ty.skipped && (ty.focusLost || ty.replaced || ty.valueWrong)) { bad++; console.log(`FAIL ${r.browser} ${r.page}: the search box ${ty.first}`); }
  if (STRICT.has(r.page) && r.pointer && !r.pointer.skipped && r.pointer.replaced > MAX_REPLACED) { bad++; console.log(`FAIL ${r.browser} ${r.page}: the element under the pointer was replaced ${r.pointer.replaced} times`); }
}
console.log(bad ? `flicker-check: ${bad} failure(s)` : 'flicker-check: all clear');
process.exit(bad ? 1 : 0);
