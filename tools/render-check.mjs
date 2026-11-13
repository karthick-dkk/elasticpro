#!/usr/bin/env node
/**
 * Render every UI page against a running dev bridge and fail on the first exception.
 *
 * `check-ui.mjs` resolves imports statically, which cannot see a reference to something
 * that was never imported at all — a stale `workerStatus()` left behind by a refactor
 * looks fine until the page is actually drawn and the operator gets a blank screen.
 * This draws all of them.
 *
 *   cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765 &
 *   node tools/render-check.mjs --config path/to/config_cluster.json
 *   node tools/render-check.mjs --config path/to/config_cluster.json --direct   # the fallback path
 *
 * Needs jsdom (`npm i jsdom`); it exits 0 with a notice when jsdom is absent, so it can
 * sit in CI without making Node a build dependency of the app itself.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findJsdom, bootApp, applyConfig } from './lib/jsdom-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');

// jsdom is resolved from the repo, the working directory, or $RENDER_CHECK_MODULES, so it
// can live outside the project and Node stays out of the app's own build.
let JSDOM;
{
  const { entry, paths } = findJsdom([ROOT, process.cwd()]);
  if (!entry) {
    console.log('render-check: jsdom not found — skipping.');
    console.log(`  install it in one of: ${paths.join(', ')}  (npm i jsdom)`);
    process.exit(0);
  }
  ({ JSDOM } = await import(pathToFileURL(entry).href));
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765');
const configPath = arg('--config', '');

try {
  const ping = await fetch(`${bridgeUrl}/bridge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"PING"}',
  });
  if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.error(`render-check: no dev bridge at ${bridgeUrl} (${e.message})`);
  console.error('  start one with: cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765');
  process.exit(1);
}

/* ------------------------------- a browser-ish global scope ------------------------------- */

const { window, errors, load, restoreConsole } = await bootApp({ JSDOM, uiRoot: UI, bridgeUrl, fleet: !process.argv.includes('--direct') });

/* ------------------------------------- drive the app -------------------------------------- */

let configured = false;

if (configPath) {
  const { config, fleet } = await applyConfig({ load, configPath });
  configured = config.clusters.length > 0;
  // Run it both ways: without --direct the pages read the core's fleet cache (when the
  // bridge runs its poller); with it, they take the direct path an older core gets.
  console.log(`render-check: data path — ${fleet ? 'fleet cache (FLEET_STATE / CLUSTER_DATASET)' : 'direct (one ES request per figure)'}`);
} else {
  console.log('render-check: no --config given — pages will draw their "no cluster" state only');
}

// play: the wall display (docs/PLAY.md). Drawn against whatever core this is — an older one
// has no PLAY_* messages, and Play must still draw, saying what is missing.
// reports: one page of seven sections (docs/REPORTS.md), each drawn from its own route. Log delay
// moved to the Log Delay page (0.3.60): its Reports entry is a link there, not a section.
const REPORT_SECTIONS = ['overview', 'daily', 'hosts', 'capacity', 'measure', 'planning', 'exports'];
// The Log Delay page (docs/LOGDELAY.md): every view — the fleet, the fixes, one cluster, a device the
// store does not hold (a fresh data directory has none, which must say so rather than draw blank),
// Live Watch and Live logs (one device too).
const LD_FIRST = configured ? ((await load('core/state.js')).clusters()[0] || null) : null;
const LD_VIEWS = ['log-delay', 'log-delay/fixes', 'log-delay/watch', 'log-delay/live',
  ...(LD_FIRST ? [`log-delay/cluster/${encodeURIComponent(LD_FIRST.id)}`, `log-delay/device/${encodeURIComponent(LD_FIRST.id)}/no-such-device`,
    `log-delay/live/${encodeURIComponent(LD_FIRST.id)}/fw-core-02`] : [])];
// The old addresses still open the Log Delay page, on the matching view: `#/<old>` → the view it names.
const LD_MOVED = [['reports/log-delay', 'fleet'], ['reports/log-delay/fixes', 'fixes'], ['logs', 'live'],
  ...(LD_FIRST ? [[`reports/log-delay/cluster/${encodeURIComponent(LD_FIRST.id)}`, 'cluster']] : [])];
// Config-Management (pages/settings.js): every tab it draws itself, each from its own route; and
// the three app pages it hosts as tabs (Automation, Request Centre, Accounts), drawn inside its frame
// the way the shell draws them (hostedPage). A tab the bridge does not support (Data, Backup) is
// left out of the frame by the page itself, which draws the first tab it does have.
const CONFIG_TABS = ['clusters/clusters', 'clusters/creds', 'clusters/trust', 'zabbix/zabbix', 'alerts/triggers',
  'requests/policy', 'reports/fields', 'reports/mail', 'reports/templates', 'play/play', 'system/defaults', 'system/file', 'system/backup'];
const HOSTED = new Set(['automation', 'requests', 'accounts']);
const PAGES = ['alerts', 'overview', 'indices', 'shards', ...LD_VIEWS, ...LD_MOVED.map(([old]) => `moved:${old}`), 'console', 'snapshots',
  ...REPORT_SECTIONS.map((s) => `reports/${s}`), 'reports/log-delay-link', 'automation', 'requests', 'requests/health', 'accounts', 'settings',
  ...CONFIG_TABS.map((t) => `settings/${t}`), 'play'];
const { ldRoute, ldTab } = await load('core/logdelay-report.js');
const view = window.document.createElement('div');
window.document.body.append(view);

for (const name of PAGES) {
  const before = errors.length;
  try {
    // `moved:<old>`: an old address, drawn by the page it now opens (the shell resolves it the same way).
    const moved = name.startsWith('moved:') ? name.slice(6) : null;
    // `reports/log-delay-link`: the Reports page asked for its Log delay section, which is a link now.
    const linkOnly = name === 'reports/log-delay-link';
    const path = moved ? 'log-delay' : linkOnly ? 'reports/log-delay' : name;
    const [page, section, tab] = path.split('/');
    const own = await load(`pages/${page}.js`);
    // A page that lives in Config-Management is drawn inside its frame, as the shell does.
    const mod = HOSTED.has(page) ? (await load('pages/settings.js')).hostedPage(page, own) : own;
    while (view.firstChild) view.removeChild(view.firstChild);
    window.history.replaceState(null, '', `#/${moved || name}`);
    if (linkOnly) (await load('core/intent.js')).intent.reports = { section: 'log-delay' };
    mod.render(view);
    await new Promise((r) => setTimeout(r, section ? 900 : 350));
    if (mod.onData) mod.onData();
    await new Promise((r) => setTimeout(r, 150));
    // The bottom status strip was removed; no page may bring it back.
    if (window.document.querySelector('#side-foot, .status-strip')) errors.push(`${name}: a bottom status strip is on the page`);
    // Requests › ElasticPro health (docs/HEALTH.md): drawn from the bridge's own SYSTEM_HEALTH.
    if (page === 'requests' && section === 'health') {
      const tab = view.querySelector('nav.rq-tabs button[aria-current="page"]');
      if (!tab || tab.dataset.tab !== 'health') errors.push('requests/health: the tab bar does not mark ElasticPro health as the one shown');
      if (!view.querySelector('.hl-strip .hl-chip[data-part="core"]')) errors.push('requests/health: no status strip with the core');
      if (!view.querySelector('tr[data-check="core.memory"]')) errors.push('requests/health: no memory check');
    } else if (page === 'settings' && section) {
      // Config-Management: the menu marks the page, the tab row (when there is one) the tab.
      const item = view.querySelector('.cm-nav .cm-item[aria-current="page"]');
      if (!item || item.dataset.cmPage !== section) errors.push(`${name}: the Config-Management menu does not mark ${section}`);
      const row = view.querySelector('nav.cm-tabs');
      const cur = row && row.querySelector('button[aria-current="page"]');
      if (row && (!cur || cur.dataset.cmTab !== tab)) errors.push(`${name}: the tab row does not mark ${tab}`);
      if (!view.querySelector('.cm-about #cm-version')) errors.push(`${name}: no About card with the version`);
    } else if (page === 'log-delay') {
      // The Log Delay page: the tab of the view the address names is marked, and that view is drawn.
      const r = ldRoute(window.location.hash);
      const want = moved ? LD_MOVED.find(([o]) => o === moved)[1] : r.view;
      if (r.view !== want) errors.push(`${name}: the address opened the ${r.view} view, not ${want}`);
      const on = view.querySelector('.ld-tabs a[aria-current="page"]');
      if (!on || on.dataset.tab !== ldTab(want)) errors.push(`${name}: the tabs do not mark ${ldTab(want)}`);
      const drawn = view.querySelector('.ld[data-ld]');
      if (!drawn || drawn.dataset.ld !== want) errors.push(`${name}: drew ${drawn ? drawn.dataset.ld : 'no view'}, not ${want}`);
      // zone and tag1 are columns of every device and log table the view drew.
      for (const t of view.querySelectorAll('table.tbl')) {
        const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.toLowerCase());
        const devices = t.id === 'ld-devices' || t.id === 'ld-cluster-devices' || t.id === 'ld-fix-devices' || t.id === 'ld-watch-devices' || t.id === 'ld-live-logs';
        if (devices && !(heads.some((x) => x.startsWith('zone')) && heads.some((x) => x.startsWith('tag1')))) errors.push(`${name}: table ${t.id} has no zone or tag1 column`);
      }
    } else if (linkOnly) {
      const a = view.querySelector('.rp-nav a[data-section="log-delay"]');
      if (!a || a.getAttribute('href') !== '#/log-delay') errors.push(`${name}: the Reports entry for Log delay is not a link to #/log-delay`);
      if (!view.querySelector('#rp-ld-moved[href="#/log-delay"]')) errors.push(`${name}: the Log delay section does not link to the Log Delay page`);
    } else if (section) {
      const on = view.querySelector('.rp-nav a[aria-current="page"]');
      if (!on || on.dataset.section !== section) errors.push(`${name}: the section nav does not mark ${section} as the one shown`);
    }
    // Indices lost its Summary tab to Reports › Daily & monthly (board 7): one line says where.
    if (page === 'indices' && configured) {
      if ([...view.querySelectorAll('.seg button')].some((b) => b.textContent.trim() === 'Summary')) errors.push('indices: the Summary tab is still there');
      if (!/Daily and monthly summary is now in/.test(view.textContent)) errors.push('indices: no line saying the summary moved to Reports');
    }
    if (HOSTED.has(page) && !view.querySelector('.cm-side')) errors.push(`${name}: not drawn inside Config-Management`);
    // Leave the page the way the app does, so a page that re-reads on a timer stops.
    if (mod.onLeave) mod.onLeave();
    const nodes = view.querySelectorAll('*').length;
    const failed = errors.length > before;
    // Without a config the pages correctly draw a single "No cluster selected" node, so
    // the blank-page check only means anything once there is something to render.
    if (!failed && configured && nodes < 3) {
      errors.push(`${name}: rendered only ${nodes} node(s) — the page is effectively blank`);
    }
    console.log(`${errors.length > before ? '✗' : '✓'} ${name.padEnd(17)} ${String(nodes).padStart(5)} nodes`);
  } catch (e) {
    console.log(`✗ ${name.padEnd(10)} THREW: ${e.message}`);
    errors.push(`${name}: ${e.message}`);
  }
}

restoreConsole();
if (errors.length) {
  console.error(`\n${errors.length} problem(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`\nok: all ${PAGES.length} pages rendered without error`);
// Done: the pages' own pollers (the report-jobs poll Reports › Exports starts, say) would keep
// Node alive until they are stopped, which is not what a check should wait for.
process.exit(0);
