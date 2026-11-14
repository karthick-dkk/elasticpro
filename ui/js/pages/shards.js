/**
 * Page — nodes and shards: what the cluster is made of, and moving pieces of it.
 *
 * Four things and nothing else (the owner's cut of 0.3.62): the nodes and their resource
 * usage, where the shards stand (and the allocation switch), whether the cluster is under
 * query pressure, and the shard table with its management. Storage accounting, dangling
 * indices and the rest of the old "Cluster at a glance" live on the Clusters overview.
 */

import { h, mount, reconcile } from '../lib/dom.js';
import { tableSort } from '../lib/table-sort.js';
import { nodeCache } from '../lib/keyed.js';
import { bytes, num, compact } from '../lib/fmt.js';
import { state, activeClusters, client, refreshAll, fetchIndices, fetchShards,
         datasetFreshness, demandDataset, fleetMode, askForPage, fleetPolicy } from '../core/state.js';
import { pauseFor } from '../core/policy.js';
import { freshnessBar } from '../lib/freshness.js';
import { card, table, empty, pill, edgeTile, connectionBanner, keptCard } from './common.js';
import { navigateTo } from '../core/intent.js';
import { modal, field, select, val, confirmDialog } from '../ui/modal.js';
import { toast, rowMenu } from '../ui/menu.js';
import { infoButton } from '../ui/fix-popover.js';
import { trackTask, shardMovePoll, allocationPoll } from '../ui/tasks.js';
import { ensureWrites, writeToggle, writesAllowed, roleMayWrite } from '../core/writes.js';
import { splitDonut, STATUS } from '../lib/charts.js';
import { takeFocus, revealFocus } from '../core/focus.js';
import { shardSplit, visibleShards, usageLevel, loadPercent, coresByNode, queueSizes, shortNodeId,
         shardsPerNode, unassignedByReason, allocationSetting, ALLOCATION_VALUES, ALLOCATION_MEANING } from '../core/nodes-shards.js';
import { nodeRates, pressureState, recordReading, readingCount, latestReadingAt, PERPETUAL } from '../core/node-rates.js';
import { explainInWords, explainBody } from '../core/shard-fixes.js';

let host = null;
/**
 * Whether shards of hidden indices (names starting with ".") are listed. Off until asked:
 * `.kibana`, `.security` and the like are system furniture, and a table opened to find a
 * log index should not begin with them. Remembered per browser; every access is in
 * try/catch, so a blocked storage just means the default.
 */
const HIDDEN_KEY = 'elasticpro.shards.showHidden';
const readShowHidden = () => { try { return window.localStorage.getItem(HIDDEN_KEY) === '1'; } catch (_) { return false; } };
const writeShowHidden = (v) => { try { window.localStorage.setItem(HIDDEN_KEY, v ? '1' : '0'); } catch (_) { /* not kept; still applied for now */ } };
const ui = { index: '', node: 'all', state: 'all', limit: 300, showHidden: readShowHidden() };
/**
 * The shard table's column sort (lib/table-sort.js): by index until a header says otherwise,
 * remembered per browser. A link to one node's shards asks for the largest first. Applied
 * after the filters and before "Show more". Every column sorts, the unassigned reason too.
 */
const SHARD_SORT = tableSort('shards', { initial: { key: 'index', dir: 1 }, onChange: () => draw() });
const SHARD_COLS = {
  index: { type: 'text', value: (x) => x.index },
  shard: { type: 'number', value: (x) => x.shard },
  type: { type: 'number', value: (x) => (x.primary ? 0 : 1) },
  state: { type: 'text', value: (x) => x.state },
  node: { type: 'text', value: (x) => x.node || null },
  store: { type: 'bytes', value: (x) => x.store },
  docs: { type: 'number', value: (x) => x.docs },
  reason: { type: 'text', value: (x) => x.reason || null },
};
/** Shards ticked for a bulk move, keyed `index/shard/p|r`. */
const picked = new Map();
const keyOf = (x) => `${x.index}/${x.shard}/${x.primary ? 'p' : 'r'}`;
/**
 * Shard listings, tasks, thread pools and pending cluster tasks, per cluster — read from
 * state.shards (core/state.js fetchShards), where the fleet cache's pushed updates land
 * too, so a move started here shows up as it happens without this page asking again.
 */
const shards = { get: (id) => { const s = state.shards.get(id); return !s ? undefined : s.error ? s : s.rows == null ? undefined : s.rows; } };
const load2 = { get: (id) => state.shards.get(id) || null };
const loading = new Set();

/**
 * A link that opened this page with a problem in view (core/focus.js): `unassigned` shows
 * only the shards with nowhere to go, `disk`/`nodes` bring the node table into view, and a
 * `node` narrows the shard table to that node, largest first — for that visit only; the
 * remembered order is not touched. Applied once, on arrival.
 */
let reveal = null;
function applyFocus() {
  const f = takeFocus('shards');
  SHARD_SORT.forVisit(null);      // an order a link asked for lasts one visit
  if (!f) return;
  if (f.section === 'unassigned') showUnassigned();
  else if (f.section === 'disk' || f.section === 'nodes') reveal = '[data-focus="nodes"]';
  // Largest first for this visit only: the remembered Shards order is left as it is.
  if (f.node) { ui.node = f.node; ui.state = 'all'; SHARD_SORT.forVisit({ key: 'store', dir: -1 }); }
}
/** The shard table narrowed to the unassigned shards and brought into view (the tile's "show", a link's focus). */
function showUnassigned() { ui.state = 'UNASSIGNED'; ui.node = 'all'; reveal = '[data-focus="shards"]'; }
const focusable = (el, name) => { if (el.dataset.focus !== name) el.dataset.focus = name; return el; };

export function render(el) {
  host = el;
  el.classList.add('dense');
  applyFocus();
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
/** What the nodes and shards view is drawn from besides its own listing (state.js FLEET_KEYS). */
const PAGE_DATASETS = ['health', 'nodes'];
let askedOpenAt = 0;
/** Whether the page is showing the whole fleet (more than two clusters): no call per cluster then. */
let fleetView = false;
function refresh() {
  const list = activeClusters();
  // Under a policy that fetches nothing on its own, whether the cluster is up and what its
  // nodes are is not known until this page asks. Throttled: every push lands here.
  if (Date.now() - askedOpenAt >= 1000) {
    askedOpenAt = Date.now();
    askForPage(list.map((c) => c.id), PAGE_DATASETS).catch(() => {});
  }
  fleetView = list.length > 2 && fleetMode();
  if (fleetView) { refreshMany(list); return; }
  for (const c of list) {
    const got = shards.get(c.id);
    // `pending`: the core is still fetching it and will push it when it lands — asking
    // again on every data event would only queue behind the same fetch.
    // Stopped: nothing is asked until the stop ends or is lifted; asking again changes nothing.
    const worthRetrying = !got || (got.error && !got.pending && (!got.paused || !pauseFor(fleetPolicy(), c.id)) && isReachable(c.id));
    if (worthRetrying && !loading.has(c.id)) load(c, false);
    // The index list is what the disk accounting is compared against; only the Indices
    // page fetches it otherwise.
    if (!state.indices.get(c.id)) fetchIndices(c.id, '*').catch(() => {});
    if (isReachable(c.id)) { loadCores(c); loadRates(c); loadAllocation(c); }
  }
}

const isReachable = (id) => !!(state.data.get(id) || {}).reachable;

/**
 * Each node's processor count, per cluster — the scale the Load column's bar is drawn on
 * (core/nodes-shards.js loadPercent) — and the search and write pools' queue sizes (the scale
 * of the Query pressure queues), from one `_nodes/_all/os,thread_pool` call. Read once per
 * cluster per visit and kept for ten minutes: they change only when a node is resized. Not
 * read in the fleet view, where a call per cluster is the queue of requests refreshMany
 * exists to avoid — the load shows as text there. `byName` null means not known: no bar,
 * the text alone (unknown is not zero).
 */
const CORES_MAX_AGE_MS = 10 * 60 * 1000;
const cores = new Map();      // cluster id → { byName: Map|null, sizes, at, inflight }
const coresFor = (id) => { const e = cores.get(id); return e && e.byName ? e.byName : null; };
const sizesFor = (id) => { const e = cores.get(id); return e && e.sizes ? e.sizes : null; };
async function loadCores(c) {
  const cl = client(c.id);
  const e = cores.get(c.id);
  if (!cl || (e && (e.inflight || Date.now() - e.at < CORES_MAX_AGE_MS))) return;
  cores.set(c.id, { byName: e ? e.byName : null, sizes: e ? e.sizes : null, at: e ? e.at : 0, inflight: true });
  let byName = null, sizes = null;
  try { const ans = await cl.nodesOs(); byName = coresByNode(ans); sizes = queueSizes(ans); } catch (_) { /* not reported: the load stays text */ }
  cores.set(c.id, { byName, sizes, at: Date.now(), inflight: false });
  draw();
}

/**
 * The Query pressure readings (core/node-rates.js): one `_nodes/stats` reading per cluster per
 * poll, the second one ten seconds after the first so the card measures soon after the page
 * opens, then every thirty seconds while the page is open. The timer is the page's own: a
 * policy that pushes nothing on its own would otherwise leave the card at "measuring" for
 * ever. It fires only while this page is on screen.
 */
const RATES_EVERY_MS = 30000, RATES_SECOND_MS = 10000;
const ratesIo = new Map();    // cluster id → { inflight, timer, error }
async function loadRates(c) {
  const cl = client(c.id);
  const e = ratesIo.get(c.id) || { inflight: false, timer: null, error: null };
  ratesIo.set(c.id, e);
  if (!cl || e.inflight) return;
  const every = readingCount(c.id) < 2 ? RATES_SECOND_MS : RATES_EVERY_MS;
  const age = Date.now() - latestReadingAt(c.id);
  if (age < every) { scheduleRates(c, every - age); return; }
  e.inflight = true;
  try { recordReading(c.id, await cl.nodesRates(), Date.now()); e.error = null; }
  catch (err) { e.error = err.message || String(err); }
  e.inflight = false;
  draw();
  scheduleRates(c, readingCount(c.id) < 2 ? RATES_SECOND_MS : RATES_EVERY_MS);
}
function scheduleRates(c, ms) {
  const e = ratesIo.get(c.id);
  if (!e || e.timer) return;
  e.timer = setTimeout(() => {
    e.timer = null;
    if (host && host.isConnected && !fleetView && isReachable(c.id) && activeClusters().some((x) => x.id === c.id)) loadRates(c);
  }, ms);
}

/**
 * `cluster.routing.allocation.enable`, per cluster, read with its source (core/nodes-shards.js
 * allocationSetting) and kept a minute; re-read at once after this page changes it. `setting`
 * null with no error means not read yet; with an error, not known — the control says so and
 * never guesses.
 */
const ALLOC_MAX_AGE_MS = 60 * 1000;
const alloc = new Map();      // cluster id → { setting, at, inflight, error }
async function loadAllocation(c, force = false) {
  const cl = client(c.id);
  const e = alloc.get(c.id);
  if (!cl || (e && (e.inflight || (!force && Date.now() - e.at < ALLOC_MAX_AGE_MS)))) return;
  alloc.set(c.id, { setting: e ? e.setting : null, at: e ? e.at : 0, inflight: true, error: e ? e.error : null });
  let setting = null, error = null;
  try { setting = allocationSetting(await cl.allocationEnable()); if (!setting) error = 'the answer carries no cluster.routing.allocation.enable'; }
  catch (err) { error = err.message || String(err); }
  alloc.set(c.id, { setting, at: Date.now(), inflight: false, error });
  draw();
}

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
}

/**
 * What the last draw put on screen (lib/keyed.js). The page redraws on every push from the
 * core and on every key typed into the Index filter; a card that reads the same is the card
 * already there, and the filter field is never rebuilt while it is typed into — it had no id,
 * so the redraw its first character caused took the keyboard with it.
 */
const built = nodeCache();
/** A kept element of `tag` under `key` whose children are `kids`, each kept while unchanged. */
function keptBox(key, tag, attrs, kids) {
  const el = built.get(`${key}:box`, tag, () => h(tag, attrs));
  reconcile(el, built.sameAll(key, kids));
  return el;
}

function draw() {
  if (!host || !host.isConnected) return;
  const list = activeClusters();
  if (!list.length) return mount(host, empty('No cluster selected'));
  built.begin();
  try {
    mount(host, ...list.map((c) => keptBox(`wrap:${c.id}`, 'div', { style: { marginBottom: '14px' } }, [block(c)])));
  } finally { built.end(); }
  if (reveal && revealFocus(host, reveal)) reveal = null;
}

/* --------------------------------- one cluster --------------------------------- */

function block(c) {
  const d = state.data.get(c.id) || {};
  // Unknown is not unreachable: a cluster whose health was never read has not failed to
  // answer. The page asked for it on opening; this is what shows until it lands.
  if (d.healthUnknown) {
    return h('div.banner', { style: { margin: 0 } },
      h('div', h('div.ttl', `${c.name} — not read yet`),
        h('div.sec', { style: { fontSize: '12px' } }, 'Nothing has been fetched from this cluster yet, so whether it is up is not known. Its health and nodes were asked for; they appear here as they arrive.'),
        h('div.mono.muted', { style: { fontSize: '11px', marginTop: '2px' } }, c.url + (c.via ? `  (via ${c.via})` : ''))),
      h('div.acts', h('button.btn.sm', { onclick: () => refreshAll({ force: true, selected: true }) }, 'Read now')));
  }
  if (!d.reachable) return connectionBanner(c, () => refreshAll({ force: true, selected: true }));

  const raw = shards.get(c.id);
  const all = Array.isArray(raw) ? raw.map(normalise) : [];

  return keptBox(`grid:${c.id}`, 'div', { style: { display: 'grid', gap: '10px' } }, [
    nodesCard(c, d),
    h('div.ns-row', allocationCard(c, all, d), pressureCard(c)),
    shardsCard(c, d, all, raw)]);
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
 * The long-running list excludes the perpetual ones (core/node-rates.js PERPETUAL — the
 * same rule the Query pressure card's task count follows).
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
        ? h('b', { style: { color: 'var(--critical-ink)' } }, num(Number(p.rejected)))
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
                h('td.num', h('b', { style: { color: t.ms > 300000 ? 'var(--critical-ink)' : 'var(--warning-ink)' } },
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

/**
 * Everything _cat/nodes knows, which is what "is this node healthy" is answered from: one
 * 32 px line per node — name, the short node id (the whole id is its tooltip), IP, roles,
 * version, then the usage bars, the disk and the uptime. Nothing stacked.
 */
function nodesBody(c, d) {
  const nodes = d.nodes || [];
  const alloc = (d.disk && d.disk.nodes) || [];
  const coreMap = coresFor(c.id);
  // _cat gives strings; an empty one is "not reported", which is not 0 %.
  const pctOf = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

  const trs = nodes.map((n) => {
    const a = alloc.find((x) => x.node === n.name) || {};
    const used = Number(n['disk.used']) || Number(a['disk.used']) || 0;
    const total = Number(n['disk.total']) || Number(a['disk.total']) || 0;
    const p = total ? (used / total) * 100 : NaN;
    const heap = pctOf(n['heap.percent']);
    const heapCur = Number(n['heap.current']), heapMax = Number(n['heap.max']);
    const isMaster = String(n.master || '').trim() === '*';
    return h('tr',
      h('td', h('span', { style: { fontWeight: 620 } }, n.name),
        isMaster ? h('span', { style: { marginLeft: '6px' } }, pill('master', 'blue')) : null),
      h('td', n.id ? h('span.mono.muted.id', { title: n.id }, shortNodeId(n.id)) : h('span.muted', '–')),
      h('td.mono', { style: { fontSize: '11px' } }, n.ip || h('span.muted', '–')),
      h('td', h('span.mono', { style: { fontSize: '11px' }, title: roleTitle(n['node.role']) },
        n['node.role'] || '–')),
      h('td.muted', { style: { fontSize: '11.5px' } }, n.version || ''),
      h('td.num', usageBar(heap, 'heap', isFinite(heapCur) && isFinite(heapMax)
        ? `heap ${heap}% — ${bytes(heapCur)} of ${bytes(heapMax)}` : `heap ${heap}%`)),
      h('td.num', usageBar(pctOf(n['ram.percent']), 'disk', `RAM ${n['ram.percent']}% in use on the host`)),
      h('td.num', usageBar(pctOf(n.cpu), 'disk', `CPU ${n.cpu}% (the process, over the last sample)`)),
      h('td.num', loadCell(n, coreMap ? coreMap.get(n.name) : undefined)),
      h('td', diskBar(used, total, p, Number(a.shards) || null)),
      h('td.muted', { style: { fontSize: '11.5px' } }, n.uptime || ''));
  });

  return h('div.ns-nodes', table(['Node', 'Node ID', 'IP', 'Roles', 'Version', { label: 'Heap', num: true }, { label: 'RAM', num: true },
                { label: 'CPU', num: true }, { label: 'Load 1m/5m', num: true }, 'Disk', 'Uptime'],
    trs, {
      // A cluster with no nodes is not a thing. An empty list here means the call did
      // not come back with one, so it says that rather than implying an empty cluster.
      emptyText: empty('The cluster answered, but listed no nodes.', {
        detail: h('span.mono', 'GET /_cat/nodes returned nothing'),
        actions: [h('button.btn.sm.primary', { onclick: () => refreshAll({ force: true, selected: true }) }, 'Retry'),
                  h('button.btn.sm', { onclick: () => navigateTo('settings') }, 'Check credentials')],
      }),
    }));
}

/**
 * The node table and the cluster's workload, in one pane at the top of the page: you read
 * them together — a node at 96% RAM means one thing when the cluster is idle and another
 * when it is rejecting work.
 */
function nodesCard(c, d) {
  const nodes = d.nodes || [];
  const load = loadBody(c);
  const sub = `${nodes.length} node(s)${d.master ? ` · master ${d.master}` : ' · no master'}`
    + (load ? ` · ${load.sub}` : '');
  return focusable(card('Nodes & resource usage', sub,
    h('div', { style: { display: 'grid', gap: '12px' } },
      nodes.length ? nodesBody(c, d) : empty('The cluster did not return a node list.'),
      load
        ? h('div', { style: { borderTop: '1px solid var(--border)', paddingTop: '11px' } }, load.node)
        : null)), 'nodes');
}

/** The fill and the ink for a usage level (core/nodes-shards.js usageLevel). */
const LEVEL_FILL = { ok: STATUS.good, warn: STATUS.warning, crit: STATUS.critical };
const LEVEL_INK = { warn: 'var(--warning-ink)', crit: 'var(--critical-ink)' };

/**
 * A percentage as the bar the Disk column has always drawn: a thin track, the filled part
 * coloured by `kind`'s thresholds, and the number beside it — in the level's ink from
 * amber up, so colour is never the only signal. A figure the node did not report is a dash.
 */
function usageBar(p, kind, title, suffix = null) {
  if (!isFinite(p)) return h('span.muted', '–');
  const level = usageLevel(p, kind);
  return h('div.use-bar', { title },
    h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: LEVEL_FILL[level] } })),
    h('span.use-num', { style: LEVEL_INK[level] ? { color: LEVEL_INK[level], fontWeight: 640 } : null }, `${Number.isInteger(p) ? p : p.toFixed(1)}%`),
    suffix ? h('span.muted', { style: { fontSize: '11px', whiteSpace: 'nowrap' } }, suffix) : null);
}

/**
 * Load 1m / 5m. A load average is not a percentage; what makes it one is the node's
 * processor count — 3.5 is idle on 32 cores and saturated on 2 — so the bar is load 1 m over
 * the cores `_nodes/os` reported, capped at 100 %. Without that count there is no bar, only
 * the figures: a scale guessed is a measurement nobody took (unknown is not zero).
 */
function loadCell(n, coreCount) {
  const text = `${n.load_1m || '–'} / ${n.load_5m || '–'}`;
  const p = loadPercent(n.load_1m, coreCount);
  if (p === null) {
    return h('span.muted.use-num', { title: `load 1 m / 5 m${n.load_1m ? ' — the node did not report its processor count, so there is no scale to draw it on' : ''}` }, text);
  }
  const level = usageLevel(p, 'disk');
  return h('div.use-bar', { title: `load 1 m over ${num(coreCount)} cores: ${p.toFixed(0)} % · 5 m ${n.load_5m || '–'}` },
    h('div.bar-mini', h('i', { style: { width: `${Math.min(100, Math.max(1.5, p))}%`, background: LEVEL_FILL[level] } })),
    h('span.use-num', { style: LEVEL_INK[level] ? { color: LEVEL_INK[level], fontWeight: 640 } : null }, text));
}

/** Disk as the same bar, the free space and the shard count beside the number — one line. */
function diskBar(used, total, p, shardCount) {
  if (!total) return h('span.muted', '–');
  return usageBar(p, 'disk', `disk ${p.toFixed(1)} % — ${bytes(used)} of ${bytes(total)} used`,
    `${bytes(total - used)} free${shardCount !== null ? ` · ${num(shardCount)} shards` : ''}`);
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

/* ------------------------------- shard allocation ------------------------------- */

/**
 * Where the shards stand: one population divided (core/nodes-shards.js shardSplit).
 * `_cat/shards` is the detail; `_cluster/health` is the cluster's own count. The rows we
 * have come first, the health count when the listing was refused. Hidden indices count:
 * this is the cluster's truth, not the table's filter.
 */
function shardMix(all, d) {
  const h2 = d.health || {};
  const split = shardSplit(all);
  const total = split.total || (Number(h2.active_shards) || 0) + (Number(h2.unassigned_shards) || 0);
  const sub = !total ? 'nothing reported'
    : split.unassigned ? `${num(split.unassigned)} of ${num(total)} not placed`
    : split.moving ? `all placed · ${num(split.moving)} in flight` : 'every shard is placed';
  return { split, total, sub };
}

/** How the allocation switch's values read on the control. */
const ALLOC_LABEL = { all: 'on', primaries: 'primaries only', new_primaries: 'new primaries only', none: 'off' };

/**
 * Shard allocation: the 96 px ring with the total inside, three tiles (assigned · moving ·
 * unassigned — the unassigned one carries the reasons and a "show" that narrows the table),
 * the shards per node as short bars, and in the header the allocation switch.
 */
function allocationCard(c, all, d) {
  const mix = shardMix(all, d);
  const split = mix.split;
  const segments = [
    { key: 'started', label: 'assigned', value: split.started, color: STATUS.good },
    { key: 'moving', label: 'moving', value: split.moving, color: 'var(--chart-info)' },
    { key: 'unassigned', label: 'unassigned', value: split.unassigned, color: STATUS.critical },
  ];
  const reasons = unassignedByReason(all);
  const reasonWords = reasons.map((r) => `${r.reason.replace(/_/g, ' ').toLowerCase()} ${num(r.count)}`).join(' · ');

  // The listing is the truth about who holds what; `_cat/allocation` stands in when it was refused.
  let per = [...shardsPerNode(all).entries()];
  if (!per.length) per = ((d.disk && d.disk.nodes) || []).filter((n) => n.node && n.node !== 'UNASSIGNED').map((n) => [n.node, Number(n.shards) || 0]);
  per.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const busiest = per.reduce((m, [, n]) => Math.max(m, n), 0);

  const body = !mix.total
    ? h('div.muted', { style: { fontSize: '11.5px' } }, 'No shard listing and no health count — unknown, not zero.')
    : h('div',
        h('div.ns-alloc',
          splitDonut(segments, { total: mix.total, totalLabel: 'shards', format: (v) => num(v), size: 96, inside: true, legend: false }),
          h('div.ns-alloc-tiles',
            edgeTile(num(split.started), 'assigned', { edge: STATUS.good, title: `${num(split.started)} shards started` }),
            edgeTile(num(split.moving), 'moving', { edge: 'var(--chart-info)', title: split.moving ? `${num(split.moving)} relocating or initialising` : 'no shard is relocating or initialising',
              extra: split.moving ? null : h('span', 'none') }),
            edgeTile(num(split.unassigned), 'unassigned', { edge: STATUS.critical, alert: split.unassigned > 0,
              title: split.unassigned ? `unassigned, by reason: ${reasonWords}` : 'every shard is placed',
              extra: split.unassigned ? [h('span', reasonWords),
                h('button.btn.sm.ghost', { title: 'Show only the unassigned shards in the table below', onclick: () => { showUnassigned(); draw(); } }, 'show')] : null }))),
        per.length
          ? h('div.ns-pernode', { title: 'Shards per node, from the shard listing' },
              ...per.flatMap(([name, n]) => [
                h('span', name),
                h('div.bar-mini', h('i', { style: { width: `${busiest ? Math.max(1.5, (n / busiest) * 100) : 0}%`, background: 'var(--chart-info)' } })),
                h('span.n', num(n))]))
          : null);

  return card('Shard allocation', `${c.name} · ${mix.sub}`, body, [allocationControl(c)]);
}

/**
 * The allocation switch: `cluster.routing.allocation.enable` as read (transient over persistent
 * over default), and a menu of the four values. Choosing one is a write through the same gate
 * as Move… and Retry failed allocations; while writes are locked the control is disabled and
 * its title says why. "Not known" when the setting could not be read — never a guess.
 */
function allocationControl(c) {
  const e = alloc.get(c.id);
  const s = e && e.setting;
  const text = s ? `Allocation: ${ALLOC_LABEL[s.value] || s.value}`
    : e && e.inflight ? 'Allocation: reading…'
    : fleetView ? 'Allocation: not read' : 'Allocation: not known';
  const read = s ? `cluster.routing.allocation.enable = ${s.value} (${s.source} setting)`
    : e && e.error ? `cluster.routing.allocation.enable could not be read: ${e.error}`
    : fleetView ? 'cluster.routing.allocation.enable is not read with All clusters — pick one cluster' : 'cluster.routing.allocation.enable — not read yet';
  const locked = !roleMayWrite() ? `Your role (${state.caller.role}) reads clusters only — an ElasticPro admin changes allocation (EP-110)`
    : !writesAllowed() ? 'Writes are locked: tick ✎ writes in the Shards card first' : null;
  const btn = rowMenu(() => [
    { hint: 'cluster.routing.allocation.enable — which shards Elasticsearch may place or move. Written as a persistent setting.' },
    ...ALLOCATION_VALUES.map((v) => ({
      label: `${ALLOC_LABEL[v]} (${v})`, disabled: !!(s && s.value === v), note: s && s.value === v ? 'current' : null,
      title: ALLOCATION_MEANING[v], onClick: () => setAllocation(c, v),
    })),
  ], { label: `${text} ▾`, title: locked ? `${read} · ${locked}` : read, trigger: 'button.btn.sm.menu-trigger.ns-alloc-btn', menuLabel: 'Shard allocation' });
  if (locked) { btn.disabled = true; btn.setAttribute('aria-disabled', 'true'); }
  btn.dataset.allocation = s ? s.value : 'unknown';
  return btn;
}

/** Switch `cluster.routing.allocation.enable`: the gate, the consequence in words, then the write. */
async function setAllocation(c, v) {
  if (!(await ensureWrites())) return;
  const ok = await confirmDialog(`Switch shard allocation to ${ALLOC_LABEL[v]}?`,
    `cluster.routing.allocation.enable: ${v}\n\n${ALLOCATION_MEANING[v][0].toUpperCase()}${ALLOCATION_MEANING[v].slice(1)}.\n\n`
    + `Written to ${c.name} as a persistent cluster setting; it stays until it is changed again.`,
    { yes: `set ${v}`, danger: v !== 'all' });
  if (!ok) return;
  try {
    const r = await client(c.id).setAllocationEnable(v);
    if (r && r.acknowledged === false) throw new Error('Elasticsearch did not acknowledge it');
    toast(`Shard allocation: ${ALLOC_LABEL[v]}`, 'ok', 5000, { meta: c.name, detail: [`cluster.routing.allocation.enable = ${v}`] });
    await loadAllocation(c, true);
    if (v === 'all') await load(c);
  } catch (e) {
    toast('Could not change shard allocation', 'err', 12000, { meta: c.name, detail: [e.message] });
  }
}

/* -------------------------------- query pressure -------------------------------- */

/**
 * Query pressure: a pill in the header — No pressure / Under pressure, by the one rule in
 * core/node-rates.js pressureState — and four tiles: rejected, breaker trips, search queue,
 * write queue, each with its breakdown in the tooltip. Before two readings exist the card
 * says it is measuring; nothing is shown as zero that was not measured.
 */
function pressureCard(c) {
  const r = nodeRates(c.id);
  const ps = pressureState(r);
  const io = ratesIo.get(c.id);
  const sizes = sizesFor(c.id);
  const nodeCount = ((state.data.get(c.id) || {}).nodes || []).length;
  const fmt = (v) => (v === null || v === undefined ? '–' : num(v));
  const poolText = (pool) => {
    const z = sizes && sizes[pool];
    if (!z || !z.nodes) return 'pool size not read';
    if (z.size === null) return `pool sizes differ across the ${num(z.nodes)} nodes`;
    return `of ${z.size === -1 ? 'an unbounded queue' : num(z.size)} per node · ${num(z.nodes)} node${z.nodes === 1 ? '' : 's'}`;
  };
  const headPill = ps.state === 'unknown' ? pill('measuring', 'grey')
    : ps.state === 'pressure' ? pill('Under pressure', 'red') : pill('No pressure', 'green');
  const note = r.measured
    ? `between the last two polls, ${Math.round(r.sinceMs / 1000)} s apart${ps.why.length ? ` · ${ps.why.join(' · ')}` : ''}`
    : fleetView ? 'not measured with All clusters — pick one cluster'
    : io && io.error ? `could not read _nodes/stats: ${io.error}`
    : 'measuring · next poll';
  const by = r.rejectedBy || {}, tb = r.tripsBy || {};
  return card('Query pressure', `${c.name} · between the last two polls`,
    h('div',
      h('div.ns-pressure',
        edgeTile(fmt(r.rejected), 'rejected', { alert: r.rejected > 0,
          title: `rejected between the last two polls — search ${fmt(by.search)} · write ${fmt(by.write)} · bulk ${fmt(by.bulk)}${r.measured ? '' : ' · not measured yet'}` }),
        edgeTile(fmt(r.breakerTrips), 'breaker trips', { alert: r.breakerTrips > 0,
          title: `breaker trips between the last two polls — parent ${fmt(tb.parent)} · request ${fmt(tb.request)} · fielddata ${fmt(tb.fielddata)}${r.measured ? '' : ' · not measured yet'}` }),
        edgeTile(fmt(r.searchQueue), 'search queue', { alert: r.queueSustained && r.searchQueue > 0,
          title: `search requests queued now across the nodes · ${poolText('search')}${nodeCount ? ` · ${num(nodeCount)} nodes in the cluster` : ''}` }),
        edgeTile(fmt(r.writeQueue), 'write queue', { alert: r.queueSustained && r.writeQueue > 0,
          title: `write requests queued now across the nodes · ${poolText('write')}` })),
      h('div.ns-note', note)),
    [headPill]);
}

/* ---------------------------------- the table ---------------------------------- */

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

function shardsCard(c, d, all, raw) {
  // Every reason the table can be empty, said out loud. "Nothing here" was indisputably
  // the worst of the states this page could be in: it looks the same whether the listing
  // failed, has not been asked for yet, or genuinely came back with no shards.
  const why = loading.has(c.id) ? 'Reading the shard table…'
    : raw && raw.error ? null
    : raw === undefined ? 'The shard table has not been read yet.'
    : !all.length ? 'Elasticsearch returned no shards for this cluster.'
    : null;
  if (raw && raw.error && raw.paused) {
    return card(`Shards — ${c.name}`, 'emergency stop',
      h('div.banner.warn', { style: { margin: 0 } }, h('div', h('div.ttl', 'Emergency stop'), h('div', raw.error))));
  }
  if (raw && raw.error) {
    return card(`Shards — ${c.name}`, 'could not be read',
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('div.banner.err', { style: { margin: 0 } },
          h('div', h('div.ttl', 'The shard listing failed'), h('div.mono', raw.error))),
        h('div', h('button.btn.sm', { onclick: () => load(c) }, '↻ Try again'))));
  }

  const nodeNames = [...new Set(all.map((s) => s.node).filter(Boolean))].sort();
  const states = [...new Set(all.map((s) => s.state))].sort();
  // A filter carried in by a link (core/focus.js) for a state nothing is in: show everything.
  if (all.length && ui.state !== 'all' && !states.includes(ui.state)) ui.state = 'all';

  // Hidden (".") indices are kept out unless asked for — by the box, or by a filter that
  // starts with "." (core/nodes-shards.js). The head counts what was kept out.
  const visible = visibleShards(all, ui.showHidden, ui.index);
  const filtered = visible.rows.filter((s) => {
    if (ui.index && !s.index.toLowerCase().includes(ui.index.toLowerCase())) return false;
    if (ui.node !== 'all' && s.node !== ui.node) return false;
    if (ui.state !== 'all' && s.state !== ui.state) return false;
    return true;
  });
  const sorted = SHARD_SORT.apply(filtered, SHARD_COLS);
  const shown = sorted.slice(0, ui.limit);

  const trs = shown.map((s) => h('tr',
    h('td', { style: { width: '26px' } }, s.state === 'STARTED'
      ? h('input', { type: 'checkbox', checked: picked.has(keyOf(s)),
          title: 'Include this shard in a bulk move',
          onchange: (e) => {
            if (e.target.checked) picked.set(keyOf(s), { ...s, clusterId: c.id }); else picked.delete(keyOf(s));
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
    h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end', alignItems: 'center' } },
      s.state === 'STARTED'
        ? h('button.btn.sm', {
            title: writesAllowed() ? 'Move this shard to another node' : 'Allow writes first',
            onclick: () => moveOne(c, d, s),
          }, 'Move…')
        : s.state === 'UNASSIGNED' ? explainButton(c, s) : null))));

  const controls = keptBox(`controls:${c.id}`, 'div.toolbar', null, [
    h('label.field', 'Index',
      h('input', { id: `shards-filter-${c.id}`, type: 'search', value: ui.index, placeholder: 'filter by name', style: { width: '200px' },
        'aria-label': 'Filter shards by index name', oninput: (e) => { ui.index = e.target.value; draw(); } })),
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
    h('label.field.check', { title: 'Indices whose name starts with "." (.kibana, .security, …) are left out of the table until this is ticked. A name filter that starts with "." shows them too.' },
      h('input', { id: `shards-hidden-${c.id}`, type: 'checkbox', checked: ui.showHidden,
        onchange: (e) => { ui.showHidden = e.target.checked; writeShowHidden(ui.showHidden); draw(); } }),
      'Show hidden (.) indices'),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
      writeToggle(draw),
      h('button.btn.sm', {
        title: 'Ask Elasticsearch to try the allocations it gave up on. Safe: it retries, it does not force.',
        onclick: () => retry(c),
      }, 'Retry failed allocations'),
      freshnessBar(datasetFreshness(c.id, 'shards'), () => load(c), { label: 'shards', busy: loading.has(c.id), dense: true }),
      h('button.btn.sm.icon', { 'aria-label': 'Reload shards', title: 'Reload shards', onclick: () => load(c) }, '↻'))]);

  const mine = [...picked.values()].filter((x) => x.clusterId === c.id);
  const bulkBar = mine.length
    ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '8px 10px',
                          background: 'var(--accent-soft)', borderRadius: '4px', marginBottom: '6px' } },
        h('b', { style: { fontSize: '12px' } }, `${num(mine.length)} selected`),
        h('span.muted', { style: { fontSize: '11px' } },
          `${bytes(mine.reduce((n, x) => n + (x.store || 0), 0))} in total`),
        h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
          h('button.btn.sm.primary', { onclick: () => moveMany(c, d, mine) }, 'Move them…'),
          h('button.btn.sm.ghost', { onclick: () => { mine.forEach((x) => picked.delete(keyOf(x))); draw(); } }, 'Clear')))
    : null;

  const sub = `${num(filtered.length)} of ${num(visible.rows.length)} shard(s)`
    + (visible.hidden ? ` · ${num(visible.hidden)} hidden` : '')
    + (shown.length < filtered.length ? ` · showing the first ${num(shown.length)}` : '');

  return focusable(keptCard(built, `shards:${c.id}`, `Shards — ${c.name}`, why || sub,
    [controls, bulkBar,
      why ? h('div', { style: { padding: '14px' } }, empty(why)) : null,
      // The head tick works on every started shard the filters match — on every page, not
      // only the rows on screen — and says how many are ticked.
      table([tickAll(sorted.filter((x) => x.state === 'STARTED'), c, mine.length),
           { label: 'Index', sort: 'index' }, { label: 'Shard', num: true, sort: 'shard' },
           { label: 'Type', sort: 'type' }, { label: 'State', sort: 'state' },
           { label: 'Node', sort: 'node' }, { label: 'Store', num: true, sort: 'store' },
           { label: 'Docs', num: true, sort: 'docs' }, { label: 'Unassigned reason', sort: 'reason' }, ''],
        // One order for every cluster's table, but each head its own id (focus comes back to the right one).
        trs, { emptyText: all.length
            ? (visible.hidden && visible.hidden === all.length ? 'Every shard here belongs to a hidden (.) index — tick "Show hidden (.) indices"' : 'No shard matches the filter')
            : 'No shards reported',
          sort: { id: `shards-${c.id}`, get key() { return SHARD_SORT.key; }, get dir() { return SHARD_SORT.dir; }, on: SHARD_SORT.on } }),
      shown.length < filtered.length
        ? h('div', { style: { padding: '10px', textAlign: 'center' } },
            h('button.btn.sm', { onclick: () => { ui.limit += 300; draw(); } },
              `Show more (${num(filtered.length - shown.length)} hidden)`))
        : null]), 'shards');
}

/**
 * The header tick: select every movable shard the current filters match — all pages, not the
 * one on screen — or clear them; "N selected" beside it while any are. Half-ticked when some are.
 */
function tickAll(movable, c, selectedCount) {
  const allOn = movable.length > 0 && movable.every((x) => picked.has(keyOf(x)));
  const box = h('input', { type: 'checkbox', checked: allOn,
    'aria-label': 'Select every started shard the filters match',
    title: allOn ? 'Clear the selection' : `Tick every started shard the filters match (${num(movable.length)}, on every page)`,
    onchange: () => {
      movable.forEach((x) => { if (allOn) picked.delete(keyOf(x)); else picked.set(keyOf(x), { ...x, clusterId: c.id }); });
      draw();
    } });
  box.indeterminate = selectedCount > 0 && !allOn;
  return { label: h('span.tick-all', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' } }, box,
    selectedCount ? h('span.muted', { style: { fontWeight: 400, textTransform: 'none' } }, `${num(selectedCount)} selected`) : null) };
}

/**
 * The "i" at the end of an unassigned shard row: why this shard is unassigned, from
 * `GET _cluster/allocation/explain` for that very shard (asked when pressed, through the core
 * like any read), in words (core/shard-fixes.js), with the recommended fix and two buttons —
 * Retry failed allocations (the gated action) and the explain request in the REST console.
 * A failed explain says so; nothing is guessed.
 */
function explainButton(c, s) {
  const id = `${s.index} · shard ${s.shard} · ${s.primary ? 'primary' : 'replica'}`;
  return infoButton({
    id, head: 'why unassigned · recommended fix',
    label: `Why ${s.index}[${s.shard}] is unassigned`, title: 'Why this shard is unassigned, and the recommended fix',
    failed: 'The cluster could not explain it:',
    items: async () => {
      const w = explainInWords(await client(c.id).allocationExplainFor(s.index, s.shard, s.primary));
      if (!w) throw new Error('the answer was not an explain answer');
      return [{
        title: `Reason: ${w.title}${w.reason ? ` (${w.reason})` : ''}`,
        cause: h('div', { style: { display: 'grid', gap: '3px' } },
          h('div', w.cause),
          w.explanation ? h('div.muted', `Elasticsearch: “${w.explanation}”`) : null,
          w.details ? h('div.muted.mono', { style: { fontSize: '11px' } }, w.details) : null,
          ...w.deciders.map((dc) => h('div.ld-fixdec', h('b', `${dc.node} · ${dc.decider}: `), dc.explanation))),
        fix: w.fix ? h('span', h('b', `${w.fix.title}. `), w.fix.fix) : 'No fix is known for this reason — read the node decisions above.',
        actions: [
          h('button.btn.sm', { title: 'Ask Elasticsearch to try the allocations it gave up on. Safe: it retries, it does not force.', onclick: () => retry(c) }, 'Retry failed allocations'),
          h('button.btn.sm', { title: 'Open GET _cluster/allocation/explain for this shard in the REST console',
            onclick: () => navigateTo('console', { method: 'GET', path: '/_cluster/allocation/explain', body: JSON.stringify(explainBody(s.index, s.shard, s.primary), null, 2) }) },
            'Open the explain answer in REST'),
        ],
      }];
    },
  });
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
    list.forEach((x) => picked.delete(keyOf(x)));
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
