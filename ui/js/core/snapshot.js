/**
 * Snapshot mode.
 *
 * Something outside this app does all the connecting and writes one JSON file in the
 * `elasticpro/snapshot` schema; the dashboard only reads it, and never writes one. The
 * browser makes no network requests at all, so no certificate is ever involved — the
 * whole TLS-trust problem simply does not arise.
 *
 * The trade: it is a point-in-time record. Anything interactive (log search, live tail,
 * the REST console) needs a live connection and is disabled.
 */

import { state, bus, buildClusterData, parseIndexName } from './state.js';
import { DEFAULTS, slug } from './config.js';

export const SNAPSHOT_SCHEMA = 'elasticpro/snapshot';

const ok = (v) => ({ ok: v !== undefined && v !== null, value: v });
const bad = (msg) => ({ ok: false, error: { message: msg } });

export function isSnapshotFile(obj) {
  return !!(obj && obj.schema === SNAPSHOT_SCHEMA && Array.isArray(obj.clusters));
}

/** Validate before we trust any of it — a truncated or half-written file is common. */
export function validateSnapshot(obj) {
  const problems = [];
  if (!obj || typeof obj !== 'object') return ['File is not a JSON object.'];
  if (obj.schema !== SNAPSHOT_SCHEMA) problems.push(`Not a snapshot file (schema is "${obj.schema || 'missing'}").`);
  if (!Array.isArray(obj.clusters)) problems.push('No clusters array.');
  else if (obj.clusters.length === 0) problems.push('The snapshot contains no clusters.');
  if (!obj.generatedAt) problems.push('No generatedAt timestamp.');
  (obj.clusters || []).forEach((c, i) => {
    if (!c || typeof c !== 'object') problems.push(`clusters[${i}] is not an object.`);
    else if (!c.name && !c.url) problems.push(`clusters[${i}] has neither name nor url.`);
  });
  // A collector that wrote credentials into the file would be a bug worth shouting about.
  const text = JSON.stringify(obj);
  if (/"(password|authHeader|apiKey|bearer)"\s*:\s*"[^"]/i.test(text)) {
    problems.push('This file appears to contain a credential. Do not use it; regenerate with a current collector.');
  }
  return problems;
}

/** Load a parsed snapshot object into application state. */
export function applySnapshot(obj) {
  const problems = validateSnapshot(obj);
  if (problems.length) { const e = new Error(problems.join(' ')); e.problems = problems; throw e; }

  const defaults = { ...DEFAULTS, ...(obj.defaults || {}), autoRefresh: false };

  const seen = new Set();
  const clusters = obj.clusters.map((c, i) => {
    let id = slug(c.name || c.url || `cluster-${i}`);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return {
      id,
      name: c.name || c.url,
      url: c.url || '',
      origin: (() => { try { return new URL(c.url).origin; } catch { return c.url || ''; } })(),
      tags: c.tags || [],
      credSource: 'snapshot',
      needsCred: false,
      anonymous: true,
      authHeader: null,
      username: '',
      logIndexPattern: c.logIndexPattern || defaults.logIndexPattern,
      indexNameRegex: c.indexNameRegex || defaults.indexNameRegex,
      timeField: c.timeField || defaults.timeField,
      enabled: true,
    };
  });

  state.config = {
    defaults, clusters,
    sourceName: obj.sourceName || 'snapshot',
    loadedAt: Date.now(),
    fileMeta: { name: obj.sourceName || 'es-snapshot.json', ephemeral: true },
  };
  state.defaults = defaults;
  state.clients.clear();
  state.data.clear();
  state.indices.clear();
  state.mode = 'snapshot';
  state.snapshot = {
    generatedAt: Date.parse(obj.generatedAt) || null,
    generatedBy: obj.generatedBy || '',
    host: obj.host || '',
    version: obj.version || 1,
  };
  state.autoRefresh = false;
  // Pages that show "updated ..." should show when the data was actually collected.
  state.lastRefresh = state.snapshot.generatedAt || Date.now();
  state.nextRefreshAt = 0;

  obj.clusters.forEach((c, i) => {
    const cluster = clusters[i];
    const raw = {
      updatedAt: Date.parse(c.collectedAt) || Date.parse(obj.generatedAt) || Date.now(),
      root:      c.info        ? ok(c.info)        : bad(c.error || 'not collected'),
      health:    c.health      ? ok(c.health)      : bad('not collected'),
      alloc:     Array.isArray(c.allocation) ? ok(c.allocation) : bad('not collected'),
      nodes:     Array.isArray(c.nodes)      ? ok(c.nodes)      : bad('not collected'),
      repos:     c.repositories ? ok(c.repositories) : bad('not collected'),
      slm:       c.slm         ? ok(c.slm)         : bad('not collected'),
      slmStatus: c.slmStatus   ? ok(c.slmStatus)   : bad('not collected'),
      ilm:       c.ilmStatus   ? ok(c.ilmStatus)   : bad('not collected'),
      ilmErr:    c.ilmErrors   ? ok(c.ilmErrors)   : bad('not collected'),
      repoPaths: c.nodeSettings ? ok(c.nodeSettings) : bad('not collected'),
    };
    const data = buildClusterData(cluster.id, {}, raw);
    if (c.ok === false && c.error) data.error = { message: String(c.error) };

    // snapshots per repository, already in the shape fetchSnapshots produces
    data.snapshots = {};
    Object.entries(c.snapshots || {}).forEach(([repo, rows]) => {
      data.snapshots[repo] = (rows || []).map((r) => ({
        id: r.id,
        status: r.status,
        start: Number(r.start_epoch) * 1000 || Number(r.start) || 0,
        end: Number(r.end_epoch) * 1000 || Number(r.end) || 0,
        duration: r.duration,
        indices: Number(r.indices) || 0,
        successful: Number(r.successful_shards) || 0,
        failed: Number(r.failed_shards) || 0,
        total: Number(r.total_shards) || 0,
      })).sort((a, b) => b.start - a.start);
    });

    data.shards = Array.isArray(c.shards) ? c.shards : [];
    state.data.set(cluster.id, data);

    const idx = Array.isArray(c.indices) ? c.indices : [];
    state.indices.set(cluster.id, idx.map((r) => parseIndexName(r.index, cluster.indexNameRegex, r)));
  });

  bus.emit('config', state.config);
  bus.emit('refreshed');
  return { clusters: clusters.length };
}

export async function loadSnapshotFile(file) {
  const text = await file.text();
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  obj.sourceName = file.name;
  const res = applySnapshot(obj);
  state.config.fileMeta = { name: file.name, size: file.size, lastModified: file.lastModified, ephemeral: true };
  return res;
}

export function isSnapshotMode() { return state.mode === 'snapshot'; }
