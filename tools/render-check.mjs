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

const PAGES = ['alerts', 'overview', 'indices', 'shards', 'logs', 'console', 'snapshots', 'volume', 'automation', 'accounts', 'settings'];
const view = window.document.createElement('div');
window.document.body.append(view);

for (const name of PAGES) {
  const before = errors.length;
  try {
    const mod = await load(`pages/${name}.js`);
    while (view.firstChild) view.removeChild(view.firstChild);
    mod.render(view);
    await new Promise((r) => setTimeout(r, 350));
    if (mod.onData) mod.onData();
    await new Promise((r) => setTimeout(r, 150));
    const nodes = view.querySelectorAll('*').length;
    const failed = errors.length > before;
    // Without a config the pages correctly draw a single "No cluster selected" node, so
    // the blank-page check only means anything once there is something to render.
    if (!failed && configured && nodes < 3) {
      errors.push(`${name}: rendered only ${nodes} node(s) — the page is effectively blank`);
    }
    console.log(`${errors.length > before ? '✗' : '✓'} ${name.padEnd(10)} ${String(nodes).padStart(5)} nodes`);
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
