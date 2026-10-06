/**
 * A browser-ish scope for the unbundled UI, shared by the checks that drive it.
 *
 * `render-check.mjs` draws every page; `behaviour-check.mjs` clicks through a few of
 * them. Both need the same thing underneath — jsdom found wherever it happens to live, an
 * IndexedDB that remembers without a database, and `/bridge` resolved against a real dev
 * bridge. Two copies of that scaffolding would mean one check passing against a scope the
 * other cannot reproduce, which is the kind of disagreement nobody reads carefully.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * jsdom, from the repo, the working directory, or $RENDER_CHECK_MODULES.
 *
 * Returns null rather than throwing: Node is a check dependency, not a build dependency
 * of the app, and a machine without jsdom should be told so rather than fail a build.
 */
export function findJsdom(extraPaths = []) {
  const req = createRequire(import.meta.url);
  const paths = [...extraPaths, process.env.RENDER_CHECK_MODULES].filter(Boolean);
  for (const base of paths) {
    try {
      return { entry: req.resolve('jsdom', { paths: [base] }), paths };
    } catch { /* try the next one */ }
  }
  return { entry: null, paths };
}

function settle(o) {
  const r = { ...o };
  setTimeout(() => { if (r.onsuccess) r.onsuccess({ target: r }); }, 0);
  return r;
}

/** An IndexedDB that keeps the pages on their real code path without a database. */
function memoryIndexedDb() {
  const memory = new Map();
  return {
    open() {
      const req = {};
      setTimeout(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({ createIndex() {} }),
          transaction: () => ({
            objectStore: () => ({
              get: (k) => settle({ result: memory.get(k) }),
              getAll: () => settle({ result: [...memory.values()] }),
              put: (v, k) => settle({ result: (memory.set(k ?? v.id ?? v.key, v), true) }),
              delete: (k) => settle({ result: (memory.delete(k), true) }),
              clear: () => settle({ result: (memory.clear(), true) }),
              index: () => ({ getAll: () => settle({ result: [...memory.values()] }) }),
            }),
            oncomplete: null,
          }),
          close() {},
        };
        if (req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    },
  };
}

const GLOBALS = ['window', 'document', 'location', 'HTMLElement', 'Node', 'Event', 'CustomEvent',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
  'alert', 'confirm', 'scrollTo', 'localStorage', 'DOMParser', 'Element',
  'SVGElement', 'indexedDB', 'IDBKeyRange', 'Blob', 'URL', 'HTMLAnchorElement'];

/**
 * Stand the app's scope up.
 *
 * `errors` collects what the page reported rather than what it returned: a window error
 * or a console.error is a failure even when the render itself finished.
 *
 * `files` collects what the page tried to download. An export is a real feature and the
 * only way to check one is to catch the blob on its way out — jsdom has no file system to
 * write it to, and a link it cannot follow would otherwise fail silently.
 */
/**
 * `fleet: false` runs the app as an older core would have it: PING answers `fleetCache:
 * false`, so every page takes the direct path (one ES request per figure) — the fallback,
 * which must keep working. With `fleet: true` (the default) the bridge's own answer
 * decides, and a bridge running its poller puts every page on the fleet-cache path.
 *
 * `sent` records every message posted to /bridge, so a check can ask what the app asked.
 */
export async function bootApp({ JSDOM, uiRoot, bridgeUrl, fleet = true }) {
  const dom = new JSDOM(fs.readFileSync(path.join(uiRoot, 'index.html'), 'utf8'), {
    url: `${bridgeUrl}/`, pretendToBeVisual: true, runScripts: 'outside-only',
  });
  const { window } = dom;
  const errors = [];

  window.matchMedia = window.matchMedia
    || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  window.scrollTo = () => {};
  window.alert = () => {};
  window.confirm = () => false;          // never take a destructive branch while probing
  window.addEventListener('error', (e) => errors.push(`window error: ${e.message}`));
  window.indexedDB = memoryIndexedDb();

  const files = [];
  {
    let pending = null;
    const RealBlob = window.Blob;
    class CapturingBlob extends RealBlob {
      constructor(parts, opts) { super(parts, opts); pending = String(parts[0]); }
    }
    window.Blob = CapturingBlob;
    window.URL.createObjectURL = () => 'blob:captured';
    window.URL.revokeObjectURL = () => {};
    window.HTMLAnchorElement.prototype.click = function capture() {
      if (this.download) files.push({ name: this.download, text: pending });
    };
  }

  for (const k of GLOBALS) {
    try { globalThis[k] = window[k]; } catch { /* read-only here; node's own will do */ }
  }

  // transport.js posts to the relative path /bridge, which Node's fetch cannot resolve.
  // Resolving it against the bridge URL is what makes the pages see real cluster data
  // rather than rendering their "unreachable" branch.
  const nodeFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? bridgeUrl + input : input;
    let msg = null;
    if (typeof input === 'string' && input === '/bridge' && init && typeof init.body === 'string') {
      try { msg = JSON.parse(init.body); sent.push(msg); } catch { /* not ours */ }
    }
    const res = await nodeFetch(url, init);
    if (!fleet && msg && msg.type === 'PING') {
      // The fallback, exercised: what an older core (or one without its poller) answers.
      const j = await res.json();
      return new Response(JSON.stringify({ ...j, fleetCache: false }),
        { status: res.status, headers: { 'content-type': 'application/json' } });
    }
    return res;
  };

  const realError = console.error;
  console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ').split('\n')[0]); };

  return {
    window,
    errors,
    files,
    sent,
    load: (p) => import(path.join(uiRoot, 'js', p)),
    restoreConsole: () => { console.error = realError; },
  };
}

/** Wait for the app's own timers to settle, which is how the pages finish drawing. */
export const settleFor = (ms) => new Promise((r) => setTimeout(r, ms));

/** Load a config the way the app does, so the pages see real clusters. */
export async function applyConfig({ load, configPath }) {
  const cfgMod = await load('core/config.js');
  const state = await load('core/state.js');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const config = cfgMod.normalize(raw, path.basename(configPath));
  config.fileMeta = {
    name: path.basename(configPath), path: configPath, size: 1, lastModified: Date.now(),
  };
  await state.setConfig(config, configPath);
  await state.refreshAll({ force: true });
  if (state.fleetMode && state.fleetMode()) {
    // A bridge that has just started has fetched nothing yet: the first FLEET_STATE says
    // "never" for most of it, and the push that fills it in is an EventSource jsdom does
    // not have. Wait for the background datasets once, then read them, so the pages draw
    // real figures rather than every cluster "loading".
    const es = await load('core/es.js');
    for (const c of config.clusters) {
      // …and the on-demand ones the pages open with, so a page drawn 350 ms after it was
      // opened finds them in the core rather than still on their way.
      for (const ds of ['health', 'nodes', 'ilm_errors', 'policies', 'ilm_assign', 'snapshots',
                        'snapshots_full', 'shards']) {
        await es.clusterDataset(c.id, ds, { wait: true });
      }
    }
    await state.refreshAll();
  }
  for (const c of config.clusters) await state.fetchIndices(c.id, '*').catch(() => {});
  return { state, config, fleet: !!(state.fleetMode && state.fleetMode()) };
}
