/**
 * Page — nodes and shards: what the cluster is made of, and moving pieces of it.
 *
 * Shards lead because they are the unit of work: an index is only as available as its
 * shards, a full disk is a placement problem, and a yellow cluster is a shard with
 * nowhere to go. The nodes are here in full underneath — roles, heap, load, disk — both
 * because choosing where to move a shard needs them and because "which node is master,
 * and is it struggling" is asked at the same moment as "where is this shard".
 */

import { h, mount } from '../lib/dom.js';
import { bytes, num, pct, compact } from '../lib/fmt.js';
import { state, clusters, activeClusters, client, refreshAll, fetchIndices, fetchShards,
         datasetFreshness, diskAccounting, setDangling, danglingFor, demandDataset, fleetMode } from '../core/state.js';
import { freshnessBar } from '../lib/freshness.js';
import { card, table, empty, pill, figure, connectionBanner } from './common.js';
import { navigateTo } from '../core/intent.js';
import { modal, field, select, val, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/menu.js';
import { trackTask, shardMovePoll, allocationPoll } from '../ui/tasks.js';
import { ensureWrites, writeToggle, writesAllowed } from '../core/writes.js';
import { splitGauge, STATUS } from '../lib/charts.js';
import { parseRetention } from '../core/volume.js';

let host = null;
const ui = { index: '', node: 'all', state: 'all', limit: 300, sort: 'index', dir: 1 };
/** Shards ticked for a bulk move, keyed `index/shard/p|r`. */
const picked = new Map();
/**
 * Shard listings, tasks, thread pools and pending cluster tasks, per cluster — read from
 * state.shards (core/state.js fetchShards), where the fleet cache's pushed updates land
 * too, so a move started here shows up as it happens without this page asking again.
 */
const shards = { get: (id) => { const s = state.shards.get(id); return !s ? undefined : s.error ? s : s.rows == null ? undefined : s.rows; } };
const load2 = { get: (id) => state.shards.get(id) || null };
const loading = new Set();

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  refresh();
}
export function onData() {
  if (!host || !host.isConnected) return;
  draw();
  refresh();
}

/**
 * Load anything not loaded yet.
 *
 * Re-checked on every visit and every data event, not only on the first render. The first
 * version cached the result — including a failure — for the life of the page module, so a
 * cluster that was still connecting when you first opened this page stayed blank until a
 * full reload, while every other page filled in. A failure is worth keeping only until
 * there is a reason to think it would go differently.
 */
function refresh() {
  const list = activeClusters();
  if (list.length > 2 && fleetMode()) { refreshMany(list); return; }
  for (const c of list) {
    const got = shards.get(c.id);
    // `pending`: the core is still fetching it and will push it when it lands — asking
    // again on every data event would only queue behind the same fetch.
    const worthRetrying = !got || (got.error && !got.pending && isReachable(c.id));
    if (worthRetrying && !loading.has(c.id)) load(c, false);
    // The index list is what the disk accounting is compared against; only the Indices
    // page fetches it otherwise.
    if (!state.indices.get(c.id)) fetchIndices(c.id, '*').catch(() => {});
  }
}

const isReachable = (id) => !!(state.data.get(id) || {}).reachable;

/**
 * "All clusters": one message to the core per dataset for the whole fleet, the tables
 * filling in as its answers are pushed. A held request per cluster (and a second for its
 * index list) was two hundred and forty requests queued in front of every click. Without
 * the fleet cache each cluster is still read directly, as before.
 */
let manyAsked = 0;
async function refreshMany(list) {
  // Every data event lands here; demandDataset already skips what it asked for recently,
  // and this keeps a burst of pushes from even computing that more than once a second.
  if (Date.now() - manyAsked < 1000) return;
  manyAsked = Date.now();
  const ids = list.map((c) => c.id);
  await Promise.all([
    demandDataset(ids, 'shards').catch(() => false),
    demandDataset(ids, 'indices').catch(() => false),
  ]);
}

/** `force` (a button, or after a write): fetch now rather than serve the cache. */
async function load(c, force = true) {
  if (!client(c.id)) return;
  loading.add(c.id); draw();
  try {
    await fetchShards(c.id, { force });
  } catch (e) {
    state.shards.set(c.id, { rows: null, error: e.message || String(e), at: 0 });
  } finally {
    loading.delete(c.id); draw();
  }
  const cl = client(c.id);

  // Only worth asking when the figures disagree; the answer decides what the gap is.
  try {
    const acct = diskAccounting(state.data.get(c.id) || {}, state.indices.get(c.id));
    if (acct.material) {
      const res = await cl.danglingIndices();
      setDangling(c.id, { indices: (res && res.dangling_indices) || [], at: Date.now() });
      draw();
    }
  } catch (_) { /* the alert says to look here; it does not depend on this succeeding */ }
}

function draw() {
  if (!host || !host.isConnected) return;
  const list = activeClusters();
  if (!list.length) return mount(host, empty('No cluster selected'));
  mount(host, ...list.map((c) => h('div', { style: { marginBottom: '14px' } }, block(c))));
}

/* --------------------------------- one cluster --------------------------------- */

function block(c) {
  const d = state.data.get(c.id) || {};
  if (!d.reachable) return connectionBanner(c, () => refreshAll({ force: true, selected: true }));

  const raw = shards.get(c.id);
  const all = Array.isArray(raw) ? raw.map(normalise) : [];

  const started = all.filter((s) => s.state === 'STARTED');
  const moving = all.filter((s) => s.state === 'RELOCATING' || s.state === 'INITIALIZING');
  const unassigned = all.filter((s) => s.state === 'UNASSIGNED');
  const nodes = d.nodes || [];

  // No stat tiles. They said Nodes / Shards / Unassigned / Moving, which is precisely
  // what the gauge and its legend say one card below — the same duplication that cost
  // the honeycomb its place. The figures that were only on the tiles moved into the
  // summary card instead.
  return h('div', { style: { display: 'grid', gap: '10px' } },
    glanceCard(c, all, d, { nodes, moving, unassigned }),
    nodesAndLoadCard(c, d),
    shardsCard(c, d, all, raw, started));
}

/** A task running longer than this is worth looking at rather than scrolling past. */
const SLOW_TASK_MS = 30000;

/**
 * What the cluster is doing right now, and whether it is coping.
 *
 * Three readings that answer different halves of "is it busy or is it struggling".
 * Active and queued work says busy. Rejected work says struggling — a thread pool only
 * rejects once its queue is full, so a non-zero number there is dropped work, not slow
 * work. Pending cluster tasks say the master is behind, which looks like everything
 * being slow for reasons nothing else explains.
 *
 * The long-running list excludes the perpetual ones. `geoip-downloader` and the monitor
 * tasks run for the life of the node; showing them as "slow queries" would bury the one
 * search that actually is.
 */
const PERPETUAL = /geoip-downloader|cluster:monitor\/tasks\/lists|health-node|persistent/i;

/**
 * What the cluster is busy doing, as a body rather than a card — it shares a pane with
 * the node table, because "which nodes are there" and "what are they doing" are one
 * question asked twice and they were being answered a screen apart.
 */
function loadBody(c) {
  const got = load2.get(c.id);
  if (!got) return null;
  // Arrays or nothing. A cluster that does not have one of these endpoints answers with
  // whatever its router does for an unknown path, and an object here reaches .filter as a
  // crash rather than as a missing card.
  const arr = (v) => (Array.isArray(v) ? v : []);
  const tasks = arr(got.tasks);
  const pools = arr(got.pools);
  const pending = arr(got.pending);
  if (!tasks.length && !pools.length && !pending.length) return null;

  const real = tasks.filter((t) => !PERPETUAL.test(`${t.action} ${t.type}`));
  const slow = real
    .map((t) => ({ ...t, ms: Number(t.running_time_ns || 0) / 1e6 }))
    .filter((t) => t.ms >= SLOW_TASK_MS)
    .sort((a, b) => b.ms - a.ms);

  const rejected = pools.reduce((n, p) => n + (Number(p.rejected) || 0), 0);
  const queued = pools.reduce((n, p) => n + (Number(p.queue) || 0), 0);
  const active = pools.reduce((n, p) => n + (Number(p.active) || 0), 0);

  const poolTrs = pools
    .filter((p) => Number(p.active) || Number(p.queue) || Number(p.rejected))
    .map((p) => h('tr',
      h('td', p.node_name), h('td.mono', p.name),
      h('td.num', num(Number(p.active) || 0)),
      h('td.num', num(Number(p.queue) || 0)),
      h('td.num', Number(p.rejected)
        ? h('b', { style: { color: 'var(--critical)' } }, num(Number(p.rejected)))
        : '0'),
      h('td.num.muted', num(Number(p.completed) || 0))));

  const health = rejected ? { label: 'rejecting work', cls: 'red' }
    : pending.length > 5 ? { label: 'master behind', cls: 'yellow' }
    : slow.length ? { label: 'slow work running', cls: 'yellow' }
    : queued ? { label: 'busy', cls: 'yellow' }
    : { label: 'idle', cls: 'green' };

  return {
    sub: `${num(real.length)} task(s) · ${num(active)} active · ${num(queued)} queued · `
       + `${num(rejected)} rejected · ${num(pending.length)} pending state change(s)`,
    node: h('div', { style: { display: 'grid', gap: '10px' } },
      // The state and what it means share a line. An idle cluster is one fact, and it
      // was taking two rows: a pill, then a sentence under it in the empty half.
      h('div', { style: { display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' } },
        pill(health.label, health.cls),
        rejected
          ? h('span.muted', { style: { fontSize: '11.5px' } },
              'a thread pool only rejects once its queue is full — this is dropped work, not slow work')
          : null,
        slow.length
          ? null
          : h('span.muted', { style: { fontSize: '12px' } },
              real.length ? 'Nothing has been running long enough to be worth a look.'
                          : 'No tasks in flight.')),

      slow.length
        ? h('div',
            h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } },
              `running longer than ${Math.round(SLOW_TASK_MS / 1000)}s`),
            table(['Action', 'Node', { label: 'Running', num: true }, 'Detail'],
              slow.slice(0, 10).map((t) => h('tr',
                h('td.mono', { style: { fontSize: '11px' } }, t.action),
                h('td', t.node),
                h('td.num', h('b', { style: { color: t.ms > 300000 ? 'var(--critical)' : 'var(--warning)' } },
                  t.running_time)),
                h('td.muted', { style: { fontSize: '11px', maxWidth: '340px', wordBreak: 'break-word' } },
                  t.description || ''))),
              { emptyText: '' }))
        : null,

      poolTrs.length
        ? h('div',
            h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } }, 'thread pools with work'),
            table(['Node', 'Pool', { label: 'Active', num: true }, { label: 'Queued', num: true },
                   { label: 'Rejected', num: true }, { label: 'Completed', num: true }], poolTrs))
        : null,

      pending.length
        ? h('div.banner.warn', { style: { margin: 0 } },
            h('div', h('div.ttl', `${num(pending.length)} cluster-state change(s) waiting on the master`),
              h('div.mono', { style: { fontSize: '11px' } },
                pending.slice(0, 4).map((t) => `${t.source} (${t.time_in_queue || ''})`).join(' · '))))
        : null),
  };
}

/** Everything _cat/nodes knows, which is what "is this node healthy" is answered from. */
function nodesBody(c, d) {
  const nodes = d.nodes || [];
  const alloc = (d.disk && d.disk.nodes) || [];

  const trs = nodes.map((n) => {
    const a = alloc.find((x) => x.node === n.name) || {};
    const used = Number(n['disk.used']) || Number(a['disk.used']) || 0;
    const total = Number(n['disk.total']) || Number(a['disk.total']) || 0;
    const p = total ? (used / total) * 100 : NaN;
    const heap = Number(n['heap.percent']);
    const isMaster = String(n.master || '').trim() === '*';
    return h('tr',
      h('td', h('div', { style: { fontWeight: 620 } }, n.name,
        isMaster ? h('span', { style: { marginLeft: '6px' } }, pill('master', 'blue')) : null),
        h('div.mono.muted', { style: { fontSize: '10.5px' } }, n.ip || '')),
      h('td', h('span.mono', { style: { fontSize: '11px' }, title: roleTitle(n['node.role']) },
        n['node.role'] || '–')),
      h('td.muted', { style: { fontSize: '11.5px' } }, n.version || ''),
      h('td.num', isFinite(heap) ? heapCell(heap, n) : '–'),
      h('td.num', n['ram.percent'] ? `${n['ram.percent']}%` : '–'),
      h('td.num', n.cpu ? `${n.cpu}%` : '–'),
      h('td.num.muted', `${n.load_1m || '–'} / ${n.load_5m || '–'}`),
      h('td', diskBar(used, total, p, Number(a.shards) || null)),
      h('td.muted', { style: { fontSize: '11.5px' } }, n.uptime || ''));
  });

  return table(['Node', 'Roles', 'Version', { label: 'Heap', num: true }, { label: 'RAM', num: true },
                { label: 'CPU', num: true }, { label: 'Load 1m/5m', num: true }, 'Disk', 'Uptime'],
    trs, {
      // A cluster with no nodes is not a thing. An empty list here means the call did
      // not come back with one, so it says that rather than implying an empty cluster.
      emptyText: empty('The cluster answered, but listed no nodes.', {
        detail: h('span.mono', 'GET /_cat/nodes returned nothing'),
        actions: [h('button.btn.sm.primary', { onclick: () => refreshAll({ force: true, selected: true }) }, 'Retry'),
                  h('button.btn.sm', { onclick: () => navigateTo('settings') }, 'Check credentials')],
      }),
    });
}

/**
 * Where the shards stand: one arc, split.
 *
 * Assigned and unassigned are not two readings to compare — they are one population
 * divided, and the division is the whole question. Two separate gauges would show two
 * percentages of a denominator the reader cannot see; one arc shows the split and the
 * counts underneath say how many, which is what somebody acts on. "0 unassigned" is
 * listed rather than dropped: it is the reassurance the page is opened for.
 *
 * Relocating and initialising are drawn separately from settled shards. They are
 * assigned — a cluster mid-rebalance is not broken — but lumping them in would hide the
 * one thing that tells you to wait a minute before worrying.
 */
function shardMixBody(c, all, d) {
  const h2 = d.health || {};
  const state = (x) => String(x.state || '').toUpperCase();
  const started = all.filter((x) => state(x) === 'STARTED').length;
  const moving = all.filter((x) => ['RELOCATING', 'INITIALIZING'].includes(state(x))).length;
  const unassigned = all.filter((x) => state(x) === 'UNASSIGNED').length;
  // _cat/shards is the detail; _cluster/health is the cluster's own count. Prefer the
  // rows we actually have, and fall back to health when the listing was refused.
  const total = all.length || (Number(h2.active_shards) || 0) + (Number(h2.unassigned_shards) || 0);

  if (!total) {
    return { sub: 'nothing reported',
             node: empty('No shard listing and no health count — unknown, not zero.') };
  }

  const segments = [
    { key: 'started', label: 'assigned', value: started, color: 'var(--good)' },
    { key: 'moving', label: 'moving', value: moving, color: 'var(--warning)' },
    { key: 'unassigned', label: 'unassigned', value: unassigned, color: 'var(--critical)' },
  ];
  const sub = unassigned
    ? `${num(unassigned)} of ${num(total)} not placed`
    : moving ? `all placed · ${num(moving)} in flight` : 'every shard is placed';

  return {
    sub,
    node: h('div', { style: { display: 'grid', gap: '9px', justifyItems: 'center' } },
      splitGauge(segments, {
        total, size: 140, centreLabel: 'shards total', format: (v) => num(v),
        // Stacked: three items wrapping two-then-one in a narrow column reads as a
        // grouping that is not there.
        legendColumn: true,
      })),
  };
}

/**
 * What this cluster is, in one band: the shard split on the left, the figures on the
 * right.
 *
 * This replaced two cards side by side, then one card with two columns, and both had the
 * same fault — the gauge half is tall and the figures half was short, so whichever ran
 * out first left a slab of empty page. The fix was not a better column ratio, it was
 * putting enough in the right half to match: everything the stat tiles used to carry is
 * there now, in a grid that fills the height rather than a row that stops after four.
 *
 * Anything that needs a paragraph — a dangling index, indices past retention — runs full
 * width underneath both, because a paragraph in a 240px column is a column of syllables.
 */
function glanceCard(c, all, d, counts) {
  const mix = shardMixBody(c, all, d);
  const acct = accountingBody(c, d);
  const indices = state.indices.get(c.id) || [];

  const figures = h('div', {
    style: { display: 'grid', gap: '14px 18px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' },
  },
    figure('Nodes', num(counts.nodes.length), d.master ? `master ${d.master}` : 'no master elected'),
    figure('Indices', num(indices.length), `${num(all.length)} shards in total`),
    ...acct.figures);

  return card('Cluster at a glance', `${c.name} · ${mix.sub} · ${acct.sub}`,
    h('div', { style: { display: 'grid', gap: '12px' } },
      h('div', { style: { display: 'grid', gap: '18px', gridTemplateColumns: 'minmax(190px, 220px) 1fr', alignItems: 'start' } },
        mix.node,
        h('div', { style: { borderLeft: '1px solid var(--border)', paddingLeft: '18px' } }, figures)),
      unassigned(all)
        ? h('div.muted', { style: { fontSize: '11.5px' } },
            'An unassigned shard holds no data that can be read. The table below says why each one is unplaced.')
        : null,
      ...acct.notes));
}

/** How many shards are not placed — asked by the glance card for its footnote. */
function unassigned(all) {
  return all.filter((x) => String(x.state || '').toUpperCase() === 'UNASSIGNED').length;
}

/**
 * The node table and the cluster's workload, in one pane at the top of the page.
 *
 * They were two cards, and briefly two of three columns, which cut a nine-column table
 * down to a third of the window — the widest table on the page in the narrowest space it
 * has ever had. It gets the full width back, and the load summary sits with it because
 * you read them together: a node at 96% RAM means one thing when the cluster is idle and
 * another when it is rejecting work.
 */
function nodesAndLoadCard(c, d) {
  const nodes = d.nodes || [];
  const load = loadBody(c);
  const sub = `${nodes.length} node(s)${d.master ? ` · master ${d.master}` : ' · no master'}`
    + (load ? ` · ${load.sub}` : '');
  return card('Nodes & cluster load', sub,
    h('div', { style: { display: 'grid', gap: '12px' } },
      nodes.length ? nodesBody(c, d) : empty('The cluster did not return a node list.'),
      load
        ? h('div', { style: { borderTop: '1px solid var(--border)', paddingTop: '11px' } }, load.node)
        : null));
}

function heapCell(p, n) {
  const colour = p >= 85 ? 'var(--critical)' : p >= 75 ? 'var(--warning)' : 'inherit';
  const cur = Number(n['heap.current']), max = Number(n['heap.max']);
  return h('span', { style: { color: colour, fontWeight: p >= 75 ? 640 : 400 },
    title: isFinite(cur) && isFinite(max) ? `${bytes(cur)} of ${bytes(max)}` : '' }, `${p}%`);
}

function diskBar(used, total, p, shardCount) {
  if (!total) return h('span.muted', '–');
  const colour = p >= 90 ? 'var(--critical)' : p >= 80 ? 'var(--warning)' : 'var(--good)';
  return h('div', { style: { display: 'grid', gap: '3px', minWidth: '170px' } },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11px' } },
      h('span', `${p.toFixed(1)}%`),
      h('span.muted', `${bytes(total - used)} free${shardCount !== null ? ` · ${num(shardCount)} shards` : ''}`)),
    h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: colour } })));
}

/**
 * The letters _cat/nodes uses for roles, spelled out.
 *
 * "cdfhilmrstw" is not readable, and the difference between a node that holds data and
 * one that only coordinates is the first thing you want when a shard will not place.
 */
const ROLE_LETTERS = {
  c: 'cold', d: 'data', f: 'frozen', h: 'hot', i: 'ingest', l: 'machine learning',
  m: 'master-eligible', r: 'remote cluster client', s: 'content', t: 'transform',
  v: 'voting only', w: 'warm', '-': 'coordinating only',
};
function roleTitle(letters) {
  return [...String(letters || '')].map((x) => ROLE_LETTERS[x] || x).join(', ');
}

/**
 * Disk Elasticsearch holds against disk any index accounts for.
 *
 * Shown only when they disagree materially. Agreeing is the normal case and a card saying
 * "these two numbers match" every time is a card nobody reads.
 */
function accountingBody(c, d) {
  const acct = diskAccounting(d, state.indices.get(c.id));
  const dang = danglingFor(c.id);
  const stale = staleIndices(c, state.indices.get(c.id));

  // The two figures are always worth showing — "how much do the indices hold against how
  // much is on disk" is asked whether or not they disagree. The explanation below only
  // appears when they do.
  // Handed back one by one rather than pre-wrapped, so the caller can lay them out with
  // its own figures in a single grid. A pre-built row of four could only ever be a row
  // of four, which is what left the right half of the card short.
  const figures = [
    figure('Indices hold', acct.known ? bytes(acct.accounted) : '–',
      acct.known ? `${num((state.indices.get(c.id) || []).length)} indices` : 'index list not read yet'),
    figure('Elasticsearch holds', d.disk ? bytes(d.disk.indicesBytes || 0) : '–', 'on the data path'),
    figure('Disk used', d.disk ? bytes(d.disk.used || 0) : '–',
      d.disk && isFinite(d.disk.percent) ? `${d.disk.percent.toFixed(1)}% of ${bytes(d.disk.total)}` : ''),
    figure('Unaccounted', acct.known ? bytes(Math.max(0, acct.gap)) : 'unknown',
      acct.known ? (acct.material ? 'worth a look' : 'within rounding') : 'needs the index list'),
  ];

  // Everything below is a paragraph or a table, and runs full width under both columns.
  const body = [];

  if (acct.material) {
    body.push(h('div.banner.warn', { style: { margin: 0 } },
      h('div',
        h('div.ttl', `${bytes(acct.gap)} on disk that no index accounts for`),
        h('div', { style: { fontSize: '12px' } },
          'Data the cluster state does not know about — a dangling index left by a removed '
          + 'node, or shard directories orphaned by a failed relocation. Deleting an index '
          + 'will not reclaim it, because there is no index to delete.'))));
    body.push(dang === null
      ? h('div.muted', { style: { fontSize: '12px' } }, 'Checking for dangling indices…')
      : (dang.indices || []).length
        ? h('div',
            h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } }, 'dangling'),
            table(['Index', 'UUID', 'Created'], dang.indices.map((r) => h('tr',
              h('td.mono', r.index_name),
              h('td.mono.muted', { style: { fontSize: '10.5px' } }, r.index_uuid),
              h('td.muted', { style: { fontSize: '11.5px' } }, r.creation_date_millis
                ? new Date(r.creation_date_millis).toISOString().slice(0, 10) : '')))))
        : h('div.muted', { style: { fontSize: '12px' } },
            'No dangling indices, so the gap is orphaned shard data rather than a lost index. '
            + 'A rolling restart of the affected node clears directories it no longer owns.'));
  }

  if (stale.list.length) {
    body.push(h('div',
      h('div.muted', { style: { fontSize: '11px', marginBottom: '3px' } },
        `past the ${stale.policy} retention policy — ${bytes(stale.bytes)} across ${num(stale.list.length)} indices`),
      table([{ label: 'Index', sort: null }, 'Day', { label: 'Size', num: true }],
        stale.list.slice(0, 12).map((i) => h('tr',
          h('td.mono', i.index), h('td.muted', i.day), h('td.num', bytes(i.size || 0)))),
        { emptyText: '' }),
      stale.list.length > 12
        ? h('div.muted', { style: { fontSize: '11px' } }, `…and ${num(stale.list.length - 12)} more`)
        : null));
  }

  const sub = acct.material ? `${bytes(acct.gap)} unexplained`
    : stale.list.length ? `${num(stale.list.length)} indices past retention`
    : 'indices and disk agree';
  return { sub, figures, notes: body };
}



/**
 * Indices whose data is older than the retention this cluster promises.
 *
 * "Stale" in the sense that matters when disk is short: still on disk, still costing,
 * and past the point the policy said they would be kept. Read from the date in the index
 * name, so a cluster whose indices are not dated reports none rather than guessing.
 */
function staleIndices(c, indices) {
  const ret = parseRetention(c.liveRetention);
  if (!ret || !Array.isArray(indices)) return { list: [], bytes: 0, policy: '' };
  const cutoff = new Date(Date.now() - ret.days * 86400000).toISOString().slice(0, 10);
  const list = indices.filter((i) => i.day && i.day < cutoff)
    .sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { list, bytes: list.reduce((n, i) => n + (i.size || 0), 0), policy: ret.label };
}

/** _cat gives strings; everything downstream wants the numbers as numbers. */
function normalise(r) {
  return {
    index: r.index,
    shard: Number(r.shard),
    primary: r.prirep === 'p',
    state: String(r.state || '').toUpperCase(),
    node: r.node || '',
    store: Number(r.store) || 0,
    docs: Number(r.docs) || 0,
    reason: r['unassigned.reason'] || '',
  };
}

/**
 * The nodes, as somewhere to put a shard.
 *
 * Shard count and free disk together, because choosing a target needs both: the emptiest
 * node is the wrong answer if it is also the fullest, and Elasticsearch will refuse the
 * move at the high watermark anyway.
 */
function nodeStrip(c, d, all) {
  const rows = (d.disk && d.disk.nodes) || [];
  if (!rows.length) return null;
  const counted = new Map();
  all.forEach((s) => { if (s.node) counted.set(s.node, (counted.get(s.node) || 0) + 1); });

  const tiles = rows.map((n) => {
    const used = Number(n['disk.used']) || 0;
    const total = Number(n['disk.total']) || 0;
    const p = total ? (used / total) * 100 : 0;
    const colour = p >= 90 ? 'var(--critical)' : p >= 80 ? 'var(--warning)' : 'var(--good)';
    return h('div', { style: { display: 'grid', gap: '3px', minWidth: '160px', flex: '1 1 160px' } },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '11.5px' } },
        h('b', n.node),
        h('span.muted', `${num(counted.get(n.node) || Number(n.shards) || 0)} shards`)),
      h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: colour } })),
      h('div.muted', { style: { fontSize: '10.5px' } },
        `${bytes(Number(n['disk.avail']) || 0)} free of ${bytes(total)}`));
  });
  return card('Nodes', 'where a shard can go, and the disk left to put it on',
    h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } }, ...tiles));
}

function shardsCard(c, d, all, raw, started) {
  // Every reason the table can be empty, said out loud. "Nothing here" was indisputably
  // the worst of the states this page could be in: it looks the same whether the listing
  // failed, has not been asked for yet, or genuinely came back with no shards.
  const why = loading.has(c.id) ? 'Reading the shard table…'
    : raw && raw.error ? null
    : raw === undefined ? 'The shard table has not been read yet.'
    : !all.length ? 'Elasticsearch returned no shards for this cluster.'
    : null;
  if (raw && raw.error) {
    return card(`Shards — ${c.name}`, 'could not be read',
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('div.banner.err', { style: { margin: 0 } },
          h('div', h('div.ttl', 'The shard listing failed'), h('div.mono', raw.error))),
        h('div', h('button.btn.sm', { onclick: () => load(c) }, '↻ Try again'))));
  }

  const nodeNames = [...new Set(all.map((s) => s.node).filter(Boolean))].sort();
  const states = [...new Set(all.map((s) => s.state))].sort();

  const filtered = all.filter((s) => {
    if (ui.index && !s.index.toLowerCase().includes(ui.index.toLowerCase())) return false;
    if (ui.node !== 'all' && s.node !== ui.node) return false;
    if (ui.state !== 'all' && s.state !== ui.state) return false;
    return true;
  });
  const SHARD_SORTS = {
    index: (x) => x.index, shard: (x) => x.shard, type: (x) => (x.primary ? 0 : 1),
    state: (x) => x.state, node: (x) => x.node || '\uffff', store: (x) => x.store, docs: (x) => x.docs,
  };
  const sortKey = SHARD_SORTS[ui.sort] || SHARD_SORTS.index;
  const sorted = [...filtered].sort((a, b) => {
    const av = sortKey(a), bv = sortKey(b);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * ui.dir;
    return String(av).localeCompare(String(bv)) * ui.dir;
  });
  const shown = sorted.slice(0, ui.limit);

  const key = (x) => `${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`;
  const trs = shown.map((s) => h('tr',
    h('td', { style: { width: '26px' } }, s.state === 'STARTED'
      ? h('input', { type: 'checkbox', checked: picked.has(key(s)),
          title: 'Include this shard in a bulk move',
          onchange: (e) => {
            if (e.target.checked) picked.set(key(s), { ...s, clusterId: c.id }); else picked.delete(key(s));
            draw();
          } })
      : null),
    h('td.mono', { style: { maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' }, title: s.index }, s.index),
    h('td.num', String(s.shard)),
    h('td', s.primary ? pill('primary', 'blue') : pill('replica', 'grey')),
    h('td', stateCell(s)),
    h('td', s.node || h('span.muted', '–')),
    h('td.num', s.store ? bytes(s.store) : '–'),
    h('td.num', s.docs ? compact(s.docs) : '–'),
    h('td.muted', { style: { fontSize: '11px', maxWidth: '200px', wordBreak: 'break-word' } },
      s.reason ? s.reason.replace(/_/g, ' ').toLowerCase() : ''),
    h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
      s.state === 'STARTED'
        ? h('button.btn.sm', {
            title: writesAllowed() ? 'Move this shard to another node' : 'Allow writes first',
            onclick: () => moveOne(c, d, s),
          }, 'Move…')
        : null))));

  const controls = h('div.toolbar',
    h('label.field', 'Index',
      h('input', { type: 'search', value: ui.index, placeholder: 'filter by name', style: { width: '200px' },
        oninput: (e) => { ui.index = e.target.value; draw(); } })),
    h('label.field', 'Node', (() => {
      const sel = h('select', { onchange: (e) => { ui.node = e.target.value; draw(); } },
        h('option', { value: 'all' }, 'any node'), ...nodeNames.map((n) => h('option', { value: n }, n)));
      sel.value = ui.node; return sel;
    })()),
    h('label.field', 'State', (() => {
      const sel = h('select', { onchange: (e) => { ui.state = e.target.value; draw(); } },
        h('option', { value: 'all' }, 'any state'), ...states.map((n) => h('option', { value: n }, n)));
      sel.value = ui.state; return sel;
    })()),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
      writeToggle(draw),
      h('button.btn.sm', {
        title: 'Ask Elasticsearch to try the allocations it gave up on. Safe: it retries, it does not force.',
        onclick: () => retry(c),
      }, 'Retry failed allocations'),
      freshnessBar(datasetFreshness(c.id, 'shards'), () => load(c), { label: 'shards', busy: loading.has(c.id), dense: true }),
      h('button.btn.sm', { onclick: () => load(c) }, '↻ Reload shards')));

  const mine = [...picked.values()].filter((x) => x.clusterId === c.id);
  const bulkBar = mine.length
    ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 10px',
                          background: 'var(--accent-soft)', borderRadius: '4px', marginBottom: '6px' } },
        h('b', { style: { fontSize: '12px' } }, `${num(mine.length)} shard(s) ticked`),
        h('span.muted', { style: { fontSize: '11px' } },
          `${bytes(mine.reduce((n, x) => n + (x.store || 0), 0))} in total`),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
          h('button.btn.sm.primary', { onclick: () => moveMany(c, d, mine) }, 'Move them…'),
          h('button.btn.sm.ghost', { onclick: () => { mine.forEach((x) => picked.delete(`${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`)); draw(); } }, 'Clear')))
    : null;

  const sub = `${num(filtered.length)} of ${num(all.length)} shard(s)`
    + (shown.length < filtered.length ? ` · showing the first ${num(shown.length)}` : '');

  return card(`Shards — ${c.name}`, why || sub,
    h('div', controls, bulkBar,
      why ? h('div', { style: { padding: '14px' } }, empty(why)) : null,
      table([tickAll(shown.filter((x) => x.state === 'STARTED'), c),
           { label: 'Index', sort: 'index' }, { label: 'Shard', num: true, sort: 'shard' },
           { label: 'Type', sort: 'type' }, { label: 'State', sort: 'state' },
           { label: 'Node', sort: 'node' }, { label: 'Store', num: true, sort: 'store' },
           { label: 'Docs', num: true, sort: 'docs' }, 'Unassigned reason', ''],
        trs, { emptyText: all.length ? 'No shard matches the filter' : 'No shards reported' }),
      shown.length < filtered.length
        ? h('div', { style: { padding: '10px', textAlign: 'center' } },
            h('button.btn.sm', { onclick: () => { ui.limit += 300; draw(); } },
              `Show more (${num(filtered.length - shown.length)} hidden)`))
        : null));
}

/** The header tick: select every movable shard currently shown, or none of them. */
function tickAll(movable, c) {
  const allOn = movable.length > 0 && movable.every((x) => picked.has(`${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`));
  return {
    label: h('input', { type: 'checkbox', checked: allOn,
      title: allOn ? 'Clear the selection' : 'Tick every started shard shown',
      onchange: () => {
        movable.forEach((x) => {
          const k = `${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`;
          if (allOn) picked.delete(k); else picked.set(k, { ...x, clusterId: c.id });
        });
        draw();
      } }),
  };
}

/**
 * Move several shards to one node.
 *
 * Elasticsearch takes a list of reroute commands in a single call and applies them as one
 * decision, which is better than looping: it can refuse the batch as a whole if the
 * result would breach an allocation rule, rather than moving four shards and then
 * discovering the fifth was the one that mattered.
 */
async function moveMany(c, d, list) {
  if (!(await ensureWrites())) return;
  const cl = client(c.id);
  const rows = (d.disk && d.disk.nodes) || [];
  const froms = new Set(list.map((x) => x.node));
  const targets = rows.map((n) => n.node).filter(Boolean);
  if (targets.length < 2) { toast('There is only one node to place shards on', 'warn'); return; }

  const opts = targets.map((n) => {
    const row = rows.find((x) => x.node === n) || {};
    return [n, `${n} — ${bytes(Number(row['disk.avail']) || 0)} free, ${num(Number(row.shards) || 0)} shards`];
  });
  const total = list.reduce((n, x) => n + (x.store || 0), 0);

  const res = await modal(`Move ${list.length} shard(s)`, c.name, [
    h('div.muted', { style: { fontSize: '12px' } },
      `${bytes(total)} in total. Sent as one reroute, so Elasticsearch accepts or refuses the `
      + 'whole set rather than leaving it half done. Shards already on the target are skipped.'),
    field('From', h('span.mono', [...froms].join(', ') || '–')),
    field('To', select('sh-bulk-to', opts[0][0], opts)),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const to = val('sh-bulk-to');
      const moving = list.filter((x) => x.node !== to);
      if (!moving.length) throw new Error('Every ticked shard is already on that node.');
      const ok = await confirmDialog(`Move ${moving.length} shard(s) to ${to}?`,
        `${bytes(moving.reduce((n, x) => n + (x.store || 0), 0))} will be copied, then removed from `
        + 'the source. The indices stay available throughout.',
        { yes: `move ${moving.length}`, danger: true });
      if (!ok) return null;
      const r = await cl.reroute(moving.map((x) => ({
        move: { index: x.index, shard: x.shard, from_node: x.node, to_node: to },
      })));
      if (r && r.acknowledged === false) throw new Error('Elasticsearch did not acknowledge it');
      return { to, n: moving.length, list: moving };
    }) }, 'Move'),
    h('button.btn', { onclick: () => ctx.close(null) }, 'Cancel'),
  ], { width: '600px' });

  if (res) {
    list.forEach((x) => picked.delete(`${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`));
    trackTask({ title: `Moving ${res.n} shard${res.n === 1 ? '' : 's'}`, cluster: c,
      detail: [`→ ${res.to}`, res.list.slice(0, 3).map((x) => `${x.index}[${x.shard}]`).join(', ') + (res.list.length > 3 ? ` +${res.list.length - 3} more` : '')],
      poll: shardMovePoll(c, res.list.map((x) => ({ index: x.index, shard: x.shard, to: res.to }))), timeoutMs: 6 * 3600e3 });
    await load(c);
  }
}

function stateCell(s) {
  const st = s.state;
  if (st === 'STARTED') return pill('started', 'green');
  if (st === 'RELOCATING') return pill('relocating', 'yellow');
  if (st === 'INITIALIZING') return pill('initialising', 'yellow');
  if (st === 'UNASSIGNED') return pill('unassigned', 'red');
  return pill(st.toLowerCase(), 'grey');
}

/* ---------------------------------- actions ---------------------------------- */

/**
 * Move one shard to another node.
 *
 * The reroute command is the same one the Indices page uses; only the way in differs.
 * Elasticsearch copies the shard and drops the source once the copy lands, so the index
 * stays readable throughout — which is worth saying, because "move" sounds like downtime.
 */
async function moveOne(c, d, s) {
  if (!(await ensureWrites())) return;
  const cl = client(c.id);
  const rows = (d.disk && d.disk.nodes) || [];
  const targets = rows.map((n) => n.node).filter((n) => n && n !== s.node);
  if (!targets.length) {
    toast('No other node to move this shard to', 'warn');
    return;
  }
  const opts = targets.map((n) => {
    const row = rows.find((x) => x.node === n) || {};
    const avail = Number(row['disk.avail']) || 0;
    return [n, `${n} — ${bytes(avail)} free, ${num(Number(row.shards) || 0)} shards`];
  });

  const res = await modal(`Move ${s.index}[${s.shard}]`, c.name, [
    h('div.muted', { style: { fontSize: '12px' } },
      'Elasticsearch copies the shard to the target and removes the source once the copy is '
      + 'complete. The index stays available throughout.'),
    field('Shard', h('span.mono', `${s.index}[${s.shard}] ${s.primary ? 'primary' : 'replica'} · ${bytes(s.store)}`)),
    field('From', h('span.mono', s.node)),
    field('To', select('sh-to', opts[0][0], opts)),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const to = val('sh-to');
      const ok = await confirmDialog('Move this shard?',
        `${s.index}[${s.shard}]  ${bytes(s.store)}\n\n  from  ${s.node}\n  to    ${to}\n\n`
        + 'The copy runs in the background; the shard shows as RELOCATING until it lands.',
        { yes: 'move it' });
      if (!ok) return null;
      const r = await cl.reroute([{ move: { index: s.index, shard: s.shard, from_node: s.node, to_node: to } }]);
      if (r && r.acknowledged === false) throw new Error('Elasticsearch did not acknowledge it');
      return to;
    }) }, 'Move'),
    h('button.btn', { onclick: () => ctx.close(null) }, 'Cancel'),
  ]);

  if (res) {
    trackTask({ title: 'Shard move started', cluster: c,
      detail: [`${s.index}[${s.shard}] ${s.primary ? 'primary' : 'replica'}`, `${s.node} → ${res}`],
      poll: shardMovePoll(c, [{ index: s.index, shard: s.shard, to: res }]), timeoutMs: 6 * 3600e3 });
    await load(c);
  }
}

/** Retry the allocations Elasticsearch gave up on after repeated failures. */
async function retry(c) {
  if (!(await ensureWrites())) return;
  try {
    const r = await client(c.id).retryFailedAllocation();
    if (r && r.acknowledged === false) throw new Error('Elasticsearch did not acknowledge it');
    trackTask({ title: 'Allocation retry started', cluster: c, detail: ['retrying shards Elasticsearch gave up on'],
      poll: allocationPoll(c) });
    await load(c);
  } catch (e) {
    toast('Allocation retry failed', 'err', 12000, { meta: c.name, detail: [e.message] });
  }
}
