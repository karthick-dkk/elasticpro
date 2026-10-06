/**
 * Long-running actions, followed to the end.
 *
 * A restore, a snapshot, a shard move: Elasticsearch accepts each at once and does the
 * work afterwards. A toast saying "started" and then nothing leaves the operator re-reading
 * pages to find out whether it finished. trackTask() shows one card that says it started
 * (blue, stays up), updates it in place while the work runs, and turns it green when it
 * completed or red when it did not — the same card, and the same entry in the bell's
 * history, from start to finish.
 *
 * Watching lives in this tab: a reload stops it (the work itself carries on in
 * Elasticsearch), and the card says so if it gives up waiting.
 */
import { toast } from './menu.js';
import { client } from '../core/state.js';

let seq = 0;

export function elapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * @param o.title     what is happening, "Restore started"
 * @param o.detail    lines naming what it acts on
 * @param o.cluster   the cluster, for the card's footer
 * @param o.poll      async () => { done, ok, title, detail } — omitted for work already done
 * @param o.everyMs   between checks (default 3 s)
 * @param o.timeoutMs give up watching after this (default 30 min)
 */
export function trackTask(o) {
  const key = `task-${Date.now()}-${++seq}`;
  const t0 = Date.now();
  const meta = (extra) => [o.cluster && o.cluster.name, extra].filter(Boolean).join(' · ');
  const base = [].concat(o.detail || []);
  const cluster = (o.cluster && (o.cluster.id || o.cluster.name)) || undefined;
  toast(o.title, 'run', 0, { key, cluster, detail: base, meta: meta('started just now') });
  if (!o.poll) return key;

  let misses = 0;
  const tick = async () => {
    let r;
    try { r = (await o.poll()) || {}; misses = 0; }
    catch (e) { r = {}; misses++; if (misses >= 5) {
      toast(`${o.title.replace(/ started$/, '')} — could not check progress`, 'warn', 12000,
        { key, cluster, detail: [...base, e.message || String(e)], meta: meta('stopped watching; the work may still be running') });
      return;
    } }
    const took = Date.now() - t0;
    if (r.done) {
      toast(r.title, r.ok === false ? 'err' : 'ok', r.ok === false ? 15000 : 10000,
        { key, cluster, detail: [...base, ...[].concat(r.detail || [])], meta: meta(`took ${elapsed(took)}`) });
      return;
    }
    if (took > (o.timeoutMs || 30 * 60e3)) {
      toast(`${o.title.replace(/ started$/, '')} — still running after ${elapsed(took)}`, 'warn', 15000,
        { key, cluster, detail: base, meta: meta('stopped watching; check the page for its state') });
      return;
    }
    toast(o.title, 'run', 0, { key, cluster, silent: true,
      detail: [...base, ...[].concat(r.detail || [])], meta: meta(`running ${elapsed(took)}`) });
    setTimeout(tick, o.everyMs || 3000);
  };
  setTimeout(tick, o.everyMs || 3000);
  return key;
}

/** A 404 while waiting means "not there yet", not "failed". */
const notYet = (e) => e && e.res && e.res.status === 404;

/* ----------------------------------- pollers ----------------------------------- */

/** A restore is complete when every shard of every restored index has recovered. */
export function restorePoll(cluster, names) {
  const cl = client(cluster.id);
  return async () => {
    let rows;
    try {
      rows = await cl.json('GET', `/_cat/recovery/${names.map(encodeURIComponent).join(',')}?format=json&h=index,shard,stage,type`);
    } catch (e) { if (notYet(e)) return { detail: 'waiting for the indices to be created' }; throw e; }
    const seen = new Set(rows.map((r) => r.index));
    const done = rows.filter((r) => r.stage === 'done').length;
    const missing = names.filter((n) => !seen.has(n));
    if (!missing.length && rows.length && done === rows.length) {
      return { done: true, ok: true, title: 'Restore completed',
        detail: `${names.length} ${names.length === 1 ? 'index' : 'indices'} · ${rows.length} shard${rows.length === 1 ? '' : 's'} recovered` };
    }
    return { detail: `${done} of ${rows.length || '?'} shards recovered` };
  };
}

/** A snapshot is complete when its state leaves IN_PROGRESS. */
export function snapshotPoll(cluster, repo, name) {
  const cl = client(cluster.id);
  return async () => {
    let s;
    try { s = ((await cl.json('GET', `/_snapshot/${encodeURIComponent(repo)}/${encodeURIComponent(name)}`)).snapshots || [])[0]; }
    catch (e) { if (notYet(e)) return { detail: 'waiting for the snapshot to be registered' }; throw e; }
    if (!s) return { detail: 'waiting for the snapshot to be registered' };
    const sh = s.shards || {};
    const counts = sh.total ? `${sh.successful || 0} of ${sh.total} shards${sh.failed ? `, ${sh.failed} failed` : ''}` : '';
    const st = String(s.state || '').toUpperCase();
    if (st === 'SUCCESS') return { done: true, ok: true, title: 'Snapshot completed', detail: [`${(s.indices || []).length} indices`, counts].filter(Boolean).join(' · ') };
    if (st === 'PARTIAL') return { done: true, ok: false, title: 'Snapshot finished PARTIAL — some shards were not saved', detail: counts };
    if (st === 'FAILED' || st === 'INCOMPATIBLE') return { done: true, ok: false, title: `Snapshot ${st.toLowerCase()}`, detail: s.reason || counts };
    return { detail: counts ? `in progress · ${counts}` : 'in progress' };
  };
}

/** A move is complete when each shard copy is STARTED on its target and nothing relocates. */
export function shardMovePoll(cluster, moves) {
  const cl = client(cluster.id);
  const indices = [...new Set(moves.map((m) => m.index))];
  return async () => {
    const rows = await cl.json('GET', `/_cat/shards/${indices.map(encodeURIComponent).join(',')}?format=json&h=index,shard,prirep,state,node`);
    const landed = moves.filter((m) => rows.some((r) => r.index === m.index && String(r.shard) === String(m.shard)
      && r.state === 'STARTED' && r.node === m.to));
    const moving = rows.filter((r) => r.state === 'RELOCATING' || r.state === 'INITIALIZING').length;
    if (landed.length === moves.length && !moving) {
      return { done: true, ok: true, title: moves.length === 1 ? 'Shard move completed' : `${moves.length} shard moves completed`,
        detail: `now on ${[...new Set(moves.map((m) => m.to))].join(', ')}` };
    }
    return { detail: `${landed.length} of ${moves.length} landed${moving ? ` · ${moving} relocating` : ''}` };
  };
}

/** Retrying allocation is complete when nothing is initialising any more. */
export function allocationPoll(cluster) {
  const cl = client(cluster.id);
  return async () => {
    const hh = await cl.json('GET', '/_cluster/health?filter_path=status,initializing_shards,relocating_shards,unassigned_shards');
    const busy = (hh.initializing_shards || 0) + (hh.relocating_shards || 0);
    if (busy) return { detail: `${hh.initializing_shards || 0} initialising · ${hh.unassigned_shards || 0} unassigned` };
    return hh.unassigned_shards
      ? { done: true, ok: false, title: `Allocation retry finished — ${hh.unassigned_shards} shard(s) still unassigned`, detail: `cluster is ${hh.status}` }
      : { done: true, ok: true, title: 'Allocation retry completed — every shard assigned', detail: `cluster is ${hh.status}` };
  };
}

/** What a restore will name each index, given the rename the operator chose. */
export function restoredNames(names, pattern, replacement) {
  if (!pattern) return names.slice();
  let re;
  try { re = new RegExp(pattern); } catch (_) { return names.slice(); }
  return names.map((n) => n.replace(re, replacement));
}
