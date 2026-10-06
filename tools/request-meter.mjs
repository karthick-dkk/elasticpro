#!/usr/bin/env node
/**
 * How many requests does one refresh cost a cluster?
 *
 * Drives the real UI modules through one full refresh against a running dev bridge and
 * reads the core's own per-cluster counter before and after. The answer to "are we
 * stressing Elasticsearch" should be a measured number, and one that is re-measured
 * whenever a page starts fetching something new.
 *
 *   cargo run -p elasticpro-core --features bridge --bin elasticpro-bridge -- ui 8765 &
 *   node tools/mock-es.mjs 9299 &
 *   node tools/request-meter.mjs --config tools/render-fixture.json
 *
 * Needs jsdom (see render-check.mjs for how it is resolved).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765');
const configPath = arg('--config', '');
if (!configPath) { console.error('usage: request-meter.mjs --config <config.json> [--bridge url]'); process.exit(1); }

let JSDOM;
{
  const req = createRequire(import.meta.url);
  let entry = null;
  for (const base of [ROOT, process.cwd(), process.env.RENDER_CHECK_MODULES].filter(Boolean)) {
    try { entry = req.resolve('jsdom', { paths: [base] }); break; } catch { /* next */ }
  }
  if (!entry) { console.log('request-meter: jsdom not found — skipping'); process.exit(0); }
  ({ JSDOM } = await import(pathToFileURL(entry).href));
}

const dom = new JSDOM(fs.readFileSync(path.join(UI, 'index.html'), 'utf8'), { url: `${bridgeUrl}/`, pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {}; window.alert = () => {}; window.confirm = () => false;
for (const k of ['window', 'document', 'location', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'getComputedStyle',
                 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'alert', 'confirm', 'scrollTo', 'localStorage', 'DOMParser', 'Element', 'SVGElement']) {
  try { globalThis[k] = window[k]; } catch { /* read-only */ }
}
const nodeFetch = globalThis.fetch;
globalThis.fetch = (i, o) => nodeFetch(typeof i === 'string' && i.startsWith('/') ? bridgeUrl + i : i, o);

const load = (p) => import(path.join(UI, 'js', p));
const state = await load('core/state.js'), cfgMod = await load('core/config.js'), es = await load('core/es.js');
const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
raw.clusters = [raw.clusters[0]];      // one cluster, so every figure is per cluster
const config = cfgMod.normalize(raw, path.basename(configPath));
config.fileMeta = { name: path.basename(configPath), path: configPath, size: 1, lastModified: Date.now() };
await state.setConfig(config, configPath);
const id = config.clusters[0].id;
const count = async () => ((await es.requestStats()).requests.clusters[id] || {}).last5m || 0;

const t0 = await count();
await state.refreshAll({ force: true });
const t1 = await count();
await state.fetchIndices(id, '*');
const t2 = await count();

const refresh = t1 - t0, indices = t2 - t1;
console.log(`requests to one cluster, measured:`);
console.log(`  one full refresh (Clusters/Alerts/Nodes/Snapshots/Volume): ${refresh}`);
console.log(`  opening the Indices page adds:                            ${indices}`);
console.log(`  auto-refresh is OFF by default; if turned on:`);
for (const iv of [30, 60, 300]) console.log(`    every ${String(iv).padStart(3)}s -> ${(refresh * 60 / iv).toFixed(1)} req/min, ${Math.round(refresh * 3600 / iv).toLocaleString()} req/hour per cluster`);
process.exit(0);
