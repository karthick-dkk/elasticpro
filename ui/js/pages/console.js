/** Page 3 — REST console with a persisted query history. */

import { h, mount, $, clear, activatable } from '../lib/dom.js';
import { bytes, num, dur, ago, dt, download } from '../lib/fmt.js';
import { state, client, activeClusters } from '../core/state.js';
import { idb } from '../lib/idb.js';

/**
 * Write to the query history, and carry on if it cannot be written.
 *
 * The history is a convenience; the response is the point. These calls were awaited
 * bare, so a browser with no IndexedDB — a private window, site data blocked — rejected
 * inside the click handler and the response that had already arrived was never drawn.
 * Pressing Run appeared to do nothing at all.
 */
function remember(fn) {
  // Deliberately not awaited by its callers and deliberately not returning anything to
  // await: IndexedDB can hang rather than fail, and nothing on this page may wait on
  // storage to finish before showing what the cluster said.
  try {
    const p = fn();
    if (p && typeof p.catch === 'function') p.catch(() => { /* no history; the request still ran */ });
  } catch (_) { /* storage unavailable */ }
}
import { jsonView } from '../lib/jsonview.js';
import { card, empty, pill } from './common.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { intent, navigateTo } from '../core/intent.js';
import { writesUnlocked, writesAllowed, syncWrites, setWritesUnlocked, writeToggle } from '../core/writes.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/menu.js';

/**
 * Common requests, grouped. `w: true` marks one that changes the cluster — it needs the
 * write unlock, and the picker marks it so nobody runs one by accident.
 */
const SNIPPETS = [
  // ---------------------------------------------------------------- diagnostics
  { g: 'Health & diagnostics', m: 'GET', p: '/_cluster/health?pretty' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cluster/health?level=indices&pretty' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cat/nodes?v&h=name,node.role,master,heap.percent,ram.percent,cpu,load_1m,disk.used_percent' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cat/allocation?v&bytes=gb' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cat/shards?v&s=state,index&h=index,shard,prirep,state,unassigned.reason,node,store' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cluster/allocation/explain?pretty',
    b: '{\n  "index": "my-index",\n  "shard": 0,\n  "primary": true\n}' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cat/thread_pool/write,search?v&h=node_name,name,active,queue,rejected' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_cat/pending_tasks?v' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_tasks?actions=*search&detailed' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_nodes/stats/jvm,fs,os?human' },
  { g: 'Health & diagnostics', m: 'GET', p: '/_nodes/hot_threads' },

  // ---------------------------------------------------------------- indices
  { g: 'Indices', m: 'GET', p: '/_cat/indices?v&s=store.size:desc&bytes=gb' },
  { g: 'Indices', m: 'GET', p: '/_cat/indices/logstash-*?v&s=index:desc&h=health,status,index,pri,rep,docs.count,store.size' },
  { g: 'Indices', m: 'GET', p: '/my-index/_settings?flat_settings=true&pretty' },
  { g: 'Indices', m: 'GET', p: '/my-index/_mapping?pretty' },
  { g: 'Indices', m: 'GET', p: '/_cat/aliases?v' },
  { g: 'Indices', m: 'POST', p: '/my-index/_open', w: true },
  { g: 'Indices', m: 'POST', p: '/my-index/_close', w: true },
  { g: 'Indices', m: 'DELETE', p: '/my-index', w: true },
  { g: 'Indices', m: 'POST', p: '/my-index/_refresh', w: true },
  { g: 'Indices', m: 'POST', p: '/my-index/_flush', w: true },
  { g: 'Indices', m: 'POST', p: '/my-index/_forcemerge?max_num_segments=1&wait_for_completion=false', w: true },
  { g: 'Indices', m: 'POST', p: '/my-index/_cache/clear', w: true },
  { g: 'Indices', m: 'POST', p: '/_aliases', w: true,
    b: '{\n  "actions": [\n    { "add":    { "index": "my-index-000002", "alias": "my-alias" } },\n' +
       '    { "remove": { "index": "my-index-000001", "alias": "my-alias" } }\n  ]\n}' },

  // ---------------------------------------------------------------- shards & replicas
  { g: 'Shards & replicas', m: 'PUT', p: '/my-index/_settings', w: true,
    b: '{\n  "index": {\n    "number_of_replicas": 1\n  }\n}' },
  { g: 'Shards & replicas', m: 'PUT', p: '/logstash-*/_settings', w: true,
    b: '{\n  "index": {\n    "number_of_replicas": 1\n  }\n}' },
  { g: 'Shards & replicas', m: 'PUT', p: '/_cluster/settings', w: true,
    b: '{\n  "persistent": {\n    "cluster.max_shards_per_node": 2000\n  }\n}' },
  { g: 'Shards & replicas', m: 'PUT', p: '/my-index/_settings', w: true,
    b: '{\n  "index": {\n    "routing.allocation.total_shards_per_node": 3\n  }\n}' },
  // The shard count of an existing index cannot be changed in place — split or shrink it.
  { g: 'Shards & replicas', m: 'POST', p: '/my-index/_split/my-index-split', w: true,
    b: '{\n  "settings": {\n    "index.number_of_shards": 6\n  }\n}' },
  { g: 'Shards & replicas', m: 'POST', p: '/my-index/_shrink/my-index-shrunk', w: true,
    b: '{\n  "settings": {\n    "index.number_of_shards": 1,\n    "index.number_of_replicas": 1\n  }\n}' },
  { g: 'Shards & replicas', m: 'POST', p: '/_cluster/reroute?retry_failed=true', w: true },
  { g: 'Shards & replicas', m: 'POST', p: '/_cluster/reroute', w: true,
    b: '{\n  "commands": [\n    {\n      "move": {\n        "index": "my-index",\n        "shard": 0,\n' +
       '        "from_node": "node-1",\n        "to_node": "node-2"\n      }\n    }\n  ]\n}' },

  // ---------------------------------------------------------------- disk watermarks
  { g: 'Disk watermarks', m: 'GET', p: '/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=**.disk.watermark**' },
  { g: 'Disk watermarks', m: 'PUT', p: '/_cluster/settings', w: true,
    b: '{\n  "persistent": {\n    "cluster.routing.allocation.disk.watermark.low": "85%",\n' +
       '    "cluster.routing.allocation.disk.watermark.high": "90%",\n' +
       '    "cluster.routing.allocation.disk.watermark.flood_stage": "95%"\n  }\n}' },
  // After a flood-stage lock the indices stay read-only until this is cleared.
  { g: 'Disk watermarks', m: 'PUT', p: '/_all/_settings', w: true,
    b: '{\n  "index.blocks.read_only_allow_delete": null\n}' },
  { g: 'Disk watermarks', m: 'PUT', p: '/_cluster/settings', w: true,
    b: '{\n  "persistent": {\n    "cluster.routing.allocation.disk.watermark.low": null,\n' +
       '    "cluster.routing.allocation.disk.watermark.high": null,\n' +
       '    "cluster.routing.allocation.disk.watermark.flood_stage": null\n  }\n}' },

  // ---------------------------------------------------------------- ILM
  { g: 'ILM', m: 'GET', p: '/_ilm/status' },
  { g: 'ILM', m: 'GET', p: '/_ilm/policy?pretty' },
  { g: 'ILM', m: 'GET', p: '/*/_ilm/explain?only_errors=true&only_managed=true' },
  { g: 'ILM', m: 'PUT', p: '/_ilm/policy/logs-retention', w: true,
    b: '{\n  "policy": {\n    "phases": {\n      "hot": {\n        "actions": {\n' +
       '          "rollover": { "max_primary_shard_size": "50gb", "max_age": "1d" },\n' +
       '          "set_priority": { "priority": 100 }\n        }\n      },\n' +
       '      "warm": {\n        "min_age": "7d",\n        "actions": {\n' +
       '          "forcemerge": { "max_num_segments": 1 },\n          "shrink": { "number_of_shards": 1 },\n' +
       '          "set_priority": { "priority": 50 }\n        }\n      },\n' +
       '      "delete": {\n        "min_age": "30d",\n        "actions": { "delete": {} }\n      }\n    }\n  }\n}' },
  { g: 'ILM', m: 'PUT', p: '/_index_template/logs-template', w: true,
    b: '{\n  "index_patterns": ["logstash-*"],\n  "template": {\n    "settings": {\n' +
       '      "index.lifecycle.name": "logs-retention",\n      "index.number_of_shards": 1,\n' +
       '      "index.number_of_replicas": 1\n    }\n  }\n}' },
  { g: 'ILM', m: 'POST', p: '/my-index/_ilm/retry', w: true },
  { g: 'ILM', m: 'POST', p: '/_ilm/start', w: true },
  { g: 'ILM', m: 'POST', p: '/_ilm/stop', w: true },
  { g: 'ILM', m: 'DELETE', p: '/_ilm/policy/logs-retention', w: true },

  // ---------------------------------------------------------------- snapshots & SLM
  { g: 'Snapshots & SLM', m: 'GET', p: '/_snapshot?pretty' },
  { g: 'Snapshots & SLM', m: 'GET', p: '/_cat/snapshots/my-repo?v&s=start_epoch:desc' },
  { g: 'Snapshots & SLM', m: 'GET', p: '/_slm/policy?human' },
  { g: 'Snapshots & SLM', m: 'GET', p: '/_slm/stats?human' },
  { g: 'Snapshots & SLM', m: 'PUT', p: '/_snapshot/my-repo', w: true,
    b: '{\n  "type": "fs",\n  "settings": {\n    "location": "/mnt/es-backups",\n    "compress": true\n  }\n}' },
  { g: 'Snapshots & SLM', m: 'PUT', p: '/_snapshot/my-repo/manual-snapshot?wait_for_completion=false', w: true,
    b: '{\n  "indices": "logstash-*",\n  "ignore_unavailable": true,\n  "include_global_state": false\n}' },
  { g: 'Snapshots & SLM', m: 'DELETE', p: '/_snapshot/my-repo/manual-snapshot', w: true },
  { g: 'Snapshots & SLM', m: 'PUT', p: '/_slm/policy/daily-snapshots', w: true,
    b: '{\n  "schedule": "0 30 1 * * ?",\n  "name": "<daily-{now/d}>",\n  "repository": "my-repo",\n' +
       '  "config": {\n    "indices": ["logstash-*"],\n    "ignore_unavailable": true,\n' +
       '    "include_global_state": false\n  },\n' +
       '  "retention": {\n    "expire_after": "30d",\n    "min_count": 7,\n    "max_count": 60\n  }\n}' },
  { g: 'Snapshots & SLM', m: 'POST', p: '/_slm/policy/daily-snapshots/_execute', w: true },

  // ---------------------------------------------------------------- search
  { g: 'Search', m: 'POST', p: '/logstash-*/_search',
    b: '{\n  "size": 5,\n  "sort": [{ "@timestamp": "desc" }],\n  "query": { "match_all": {} }\n}' },
  { g: 'Search', m: 'POST', p: '/logstash-*/_count', b: '{\n  "query": { "match_all": {} }\n}' },

  // ---------------------------------------------------------------- cluster settings
  { g: 'Cluster settings', m: 'GET', p: '/_cluster/settings?include_defaults=false&flat_settings=true' },
  { g: 'Cluster settings', m: 'PUT', p: '/_cluster/settings', w: true,
    b: '{\n  "transient": {\n    "cluster.routing.allocation.enable": "all"\n  }\n}' },
  { g: 'Cluster settings', m: 'PUT', p: '/_cluster/settings', w: true,
    b: '{\n  "persistent": {\n    "indices.recovery.max_bytes_per_sec": "80mb"\n  }\n}' },
];

let host = null;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** The response gets the larger share — see the comment where the columns are built. */
const DEFAULT_SPLIT = 35;

const ui = { method: 'GET', path: '/_cluster/health', body: '', running: false, res: null, raw: false,
             filter: '', showFav: false,
             split: DEFAULT_SPLIT,   // percent of the row given to the query pane
             find: '',               // search within the response
             findAt: 0,              // which match is current
             findTotal: 0,
             full: false };          // response filling the window
let history = [];

/* ------------------------------ the split handle ------------------------------ */

function setSplit(pct) {
  ui.split = Math.max(20, Math.min(70, Math.round(pct)));
  const cols = $('#c-columns');
  if (cols) cols.style.gridTemplateColumns = `minmax(0,${ui.split}fr) 6px minmax(0,${100 - ui.split}fr)`;
  try { localStorage.setItem('elasticpro.console.split', String(ui.split)); } catch (_) { /* private window */ }
}

function startDrag(e) {
  const cols = $('#c-columns');
  if (!cols) return;
  e.preventDefault();
  const rect = cols.getBoundingClientRect();
  const move = (ev) => setSplit(((ev.clientX - rect.left) / rect.width) * 100);
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function render(el) {
  host = el;
  try {
    const saved = Number(localStorage.getItem('elasticpro.console.split'));
    if (isFinite(saved) && saved >= 20 && saved <= 70) ui.split = saved;
  } catch (_) { /* private window: the default is fine */ }
  if (intent.console) { Object.assign(ui, intent.console); intent.console = null; ui.res = null; }
  idb.allQueries().then((q) => { history = (q || []).sort((a, b) => b.ts - a.ts); drawHistory(); })
    .catch(() => { /* no stored history to show */ });
  // The core owns the unlock, not this page — re-read it rather than trusting our copy.
  syncWrites().then(draw).catch(() => {});
  draw();
}
export function onData() {}

/** Esc leaves full screen — the way every other full-screen view behaves. */
export function onKey(e) {
  if (e.key === 'Escape' && ui.full) { ui.full = false; draw(); return true; }
  return false;
}

function cluster() { return activeClusters()[0] || null; }

function draw() {
  const c = cluster();
  if (isSnapshotMode()) return mount(host, snapshotNotice('The REST console'));
  if (!c) return mount(host, empty('No cluster selected'));

  const dl = h('datalist#ep-list', ...[...new Set(SNIPPETS.map((s) => s.p))].map((v) => h('option', { value: v })));

  // The console offers every method: this is the one page where a person types the
  // request. Whether the core accepts a write is decided by the toggle below (a session
  // unlock) or by readOnly:false in the config — never by which options are listed here.
  const methods = METHODS;
  if (!methods.includes(ui.method)) ui.method = 'GET';
  const methodSel = h('select#c-method', { style: { width: '96px', fontWeight: 700 },
    onchange: (e) => { ui.method = e.target.value; draw(); } },
    ...methods.map((m) => h('option', m)));
  methodSel.value = ui.method;

  const pathInput = h('input#c-path', { type: 'text', value: ui.path, list: 'ep-list', spellcheck: false,
    placeholder: '/_cluster/health', style: { flex: '1', fontFamily: 'var(--mono)' },
    oninput: (e) => { ui.path = e.target.value; syncTarget(); },
    onkeydown: (e) => { if (e.key === 'Enter') run(); } });

  // Grouped, so the list stays usable now that it covers ILM, watermarks and shards.
  const groups = [...new Set(SNIPPETS.map((s) => s.g))];
  const snippetSel = h('select', { style: { maxWidth: '300px' },
      onchange: (e) => {
        const s = SNIPPETS[e.target.value];
        e.target.value = '';
        if (!s) return;
        ui.method = s.m; ui.path = s.p; ui.body = s.b || '';
        draw();
      } },
    h('option', { value: '' }, 'Common requests…'),
    ...groups.map((g) => h('optgroup', { label: g },
      ...SNIPPETS.map((s, i) => [s, i]).filter(([s]) => s.g === g)
        .map(([s, i]) => h('option', { value: String(i) }, `${s.w ? '✎ ' : ''}${s.m} ${s.p}`)))));

  // ---- the address this will actually hit
  //
  // Above the method, not below it, and the whole URL rather than the cluster's base:
  // the console is the one page where a person can send anything to anything, so what
  // gets audited afterwards is which host received which path. Reading that off two
  // fields — a base down here, a path up there — is how the wrong cluster gets hit.
  // It follows the path field as it is typed, so it is never a stale answer.
  const targetUrl = () => {
    const base = String(c.url || '').replace(/\/+$/, '');
    const p = String(ui.path || '');
    return base + (p ? (p.startsWith('/') ? p : `/${p}`) : '');
  };
  const target = h('span.mono#c-target', { style: { fontSize: '12px', wordBreak: 'break-all' } }, targetUrl());
  const syncTarget = () => { target.textContent = targetUrl(); };

  // ---- request line: target · method · path · run
  const requestBar = h('section.card',
    h('div.body', { style: { display: 'grid', gap: '8px', padding: '10px 14px' } },
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } },
        h('b', { style: { fontSize: '12px' } }, c.name),
        h('span.muted', { style: { fontSize: '12px' } }, ui.method),
        target,
        c.via ? h('span.muted', { style: { fontSize: '11px' } }, `via ${c.via}`) : null),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        methodSel, pathInput,
        h('button.btn.primary#c-run', { onclick: run, style: { minWidth: '96px' } }, 'Run ▸'),
        snippetSel),
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '11px', flexWrap: 'wrap' } },
        h('span.muted', { style: { marginLeft: 'auto' } }, 'Ctrl/⌘+Enter runs · Enter in the path runs'),
        writeToggle(draw))));

  // ---- Query | Results
  const bodyArea = h('textarea#c-body', { spellcheck: false,
    style: { width: '100%', height: '100%', minHeight: '340px', fontFamily: 'var(--mono)', fontSize: '12px', resize: 'vertical', boxSizing: 'border-box' },
    oninput: (e) => { ui.body = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } } }, ui.body);

  const query = h('section.card', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
    h('header', h('h2', 'Query'), h('span.sub', 'request body'),
      h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
        h('button.btn.sm', { onclick: format }, 'Format JSON'),
        h('button.btn.sm', { onclick: () => { ui.body = ''; $('#c-body').value = ''; } }, 'Clear'),
        h('button.btn.sm.ghost', { onclick: () => saveFav(), title: 'Save this request to favourites' }, '★ Favourite'))),
    h('div.body', { style: { padding: '10px', flex: '1', display: 'flex' } }, bodyArea));

  const results = h('div#c-response', { style: { minWidth: 0, display: 'flex' } }, responseCard());

  // 35/65. A request body is usually a few lines and a response is usually hundreds, so
  // an even split gave half the window to whitespace and made the half that matters
  // scroll. Draggable, because "usually" is not "always" — a long aggregation body wants
  // the space back, and the position is remembered.
  const split = h('div.split-handle', {
    title: 'Drag to resize · double-click to reset to 35/65',
    ondblclick: () => setSplit(DEFAULT_SPLIT),
    onpointerdown: startDrag,
  });
  const columns = h('div#c-columns', {
    style: { display: 'grid', gridTemplateColumns: `minmax(0,${ui.split}fr) 6px minmax(0,${100 - ui.split}fr)`,
             gap: '8px', alignItems: 'stretch' },
  }, query, split, results);

  // ---- History (full width)
  const hist = h('div#c-history', historyCard());

  if (ui.full) {
    // Everything else is hidden rather than scrolled past: a full-screen response that
    // still has the request bar above it is not full screen, it is a taller column.
    mount(host, dl, h('div#c-response', {
      style: { display: 'flex', flexDirection: 'column', height: 'calc(100vh - 118px)', minHeight: '0' },
    }, responseCard()));
    return;
  }
  mount(host, dl, h('div', { style: { display: 'grid', gap: '14px' } }, requestBar, columns, hist));
}

/**
 * The write unlock. Two states matter here:
 *  - readOnly:false in the config — writes are on everywhere, nothing to toggle.
 *  - readOnly:true (the default) — this switch unlocks writes for THIS session and only
 *    for requests sent from this page. It is held in the core's memory, never written to
 *    disk, and gone on restart.
 */
/** The search-family POSTs the core allows even in read-only mode. */
const SEARCH_POST = /(^|\/)_(search|msearch|count|field_caps|mget|explain|validate\/query|render\/template|terms_enum|search_shards|async_search|eql\/search|sql|analyze|rank_eval|resolve\/index|knn_search)(\/|\?|$)/;

/** Would this request change the cluster? */
function isWrite(method, path) {
  if (method === 'GET' || method === 'HEAD') return false;
  if (method === 'POST') return !SEARCH_POST.test((path || '').split('?')[0]);
  return true;
}

/** Named in full, so pressing Run is never a surprise. */
function confirmWrite(c) {
  const path = ui.path.trim() || '/';
  return confirmDialog(`Send ${ui.method} to ${c.name}?`,
    `${ui.method} ${path}\n\nThis request can change the cluster.`,
    { yes: 'send it', danger: ui.method === 'DELETE' });
}

function format() {
  try { ui.body = JSON.stringify(JSON.parse(ui.body || '{}'), null, 2); $('#c-body').value = ui.body; }
  catch (e) { flash(`Not valid JSON: ${e.message}`); }
}

function flash(msg) {
  const el = $('#c-response');
  if (el) el.prepend(h('div.banner.warn', h('div', msg)));
}

async function run() {
  const c = cluster();
  if (!c) return;
  // Confirm only when the request is a write AND something will actually let it through.
  if (isWrite(ui.method, ui.path) && writesAllowed() && !(await confirmWrite(c))) return;
  const cl = client(c.id);
  ui.running = true;
  const btn = $('#c-run'); if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

  const started = Date.now();
  // allowWrites is set here and nowhere else in the app; the core still refuses it
  // unless the session has been unlocked above.
  const res = await cl.request(ui.method, ui.path.trim() || '/', ui.body.trim() || null,
                               { allowWrites: writesUnlocked() });
  ui.res = res;
  ui.running = false;
  if (btn) { btn.disabled = false; btn.textContent = 'Run ▸'; }

  const entry = {
    id: `${started}-${Math.random().toString(36).slice(2, 8)}`,
    ts: started, cluster: c.name, clusterId: c.id,
    method: ui.method, path: ui.path, body: ui.body,
    status: res.status || 0, ok: !!res.ok, tookMs: res.tookMs || 0, fav: 0,
  };
  // Show the response first. Saving it to the history is bookkeeping, and it used to be
  // awaited before the result was drawn — so a browser whose IndexedDB never answers
  // (blocked site data, some private modes) left the console reading "nothing run yet"
  // for a request that had already come back 200. It does not reject, it simply never
  // settles, which is why no catch helped.
  mount($('#c-response'), responseCard());

  history = [entry, ...history].slice(0, 500);
  drawHistory();
  remember(() => idb.putQuery(entry));

  // The response panel sits below the fold on a small window, and a request that failed
  // looks the same as one that has not run yet until you scroll down to it. The toast
  // puts the outcome where the eye already is — on the button just pressed. Failures
  // stay up twice as long, because they are the ones worth reading.
  const took = res.tookMs ? ` · ${res.tookMs} ms` : '';
  if (res.ok) {
    toast(`${ui.method} ${clip(ui.path)} → ${res.status}${took}`, 'ok', 2600, { key: 'console-run' });
  } else {
    toast(`${ui.method} ${clip(ui.path)} → ${res.status || res.kind || 'failed'}`
        + `${res.message ? ` · ${clip(res.message, 60)}` : ''}`, 'err', 5200, { key: 'console-run' });
  }
}

/** A long path or a long error makes a toast unreadable; the panel below keeps all of it. */
function clip(v, max = 40) {
  const t = String(v || '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function saveFav() {
  const c = cluster();
  const entry = {
    id: `fav-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(),
    cluster: c ? c.name : '', clusterId: c ? c.id : '', method: ui.method, path: ui.path, body: ui.body,
    status: 0, ok: true, tookMs: 0, fav: 1,
  };
  remember(() => idb.putQuery(entry));
  history = [entry, ...history];
  drawHistory();
}

/**
 * Make the response directly editable.
 *
 * `plaintext-only` where the browser has it, so pasting into a response cannot bring
 * markup with it; plain `true` elsewhere, which every current browser accepts.
 */
function editable(node) {
  node.id = 'c-out';
  node.spellcheck = false;
  try { node.contentEditable = 'plaintext-only'; } catch (_) { node.contentEditable = 'true'; }
  if (!node.isContentEditable && node.contentEditable !== 'plaintext-only') node.contentEditable = 'true';
  return node;
}

/** What is on screen now — including anything typed into it — else what came back. */
function currentText(bodyText) {
  const live = $('#c-out');
  return live ? live.textContent : bodyText;
}

/**
 * Search within the response, one match at a time.
 *
 * A count alone is not a search: "312 hits" in a 20,000-line response tells you the word
 * is in there somewhere and leaves you scrolling. So the matches are numbered, the
 * current one is marked differently from the rest, and the view moves to it.
 */
function step(by) {
  const total = ui.findTotal || 0;
  if (!total) return;
  // Wraps both ways: at the last match, next goes to the first, which is what every
  // find bar does and what the number under the cursor implies.
  ui.findAt = ((ui.findAt + by) % total + total) % total;
  mount($('#c-response'), responseCard());
  scrollToMatch();
  const el = $('#c-find'); if (el) el.focus();
}

/** Put the current match in the middle of the scroller, not just barely on screen. */
function scrollToMatch() {
  const on = $('#c-response mark.on');
  if (on && typeof on.scrollIntoView === 'function') {
    try { on.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { on.scrollIntoView(); }
  }
}

function findBox(bodyText) {
  const hits = ui.find ? countHits(bodyText, ui.find) : 0;
  ui.findTotal = hits;
  if (ui.findAt >= hits) ui.findAt = 0;

  const input = h('input#c-find', {
    type: 'search', value: ui.find, placeholder: 'find in results',
    style: { width: '150px', fontSize: '11.5px' },
    oninput: (e) => {
      ui.find = e.target.value;
      ui.findAt = 0;                      // a new search starts at its first match
      mount($('#c-response'), responseCard());
      const el = $('#c-find');
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
      scrollToMatch();
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);          // Enter / Shift+Enter, as in every editor
    },
  });

  const nav = (label, by, title) => h('button.btn.sm.ghost', {
    disabled: !hits,
    title,
    style: { padding: '2px 7px' },
    onclick: () => step(by),
  }, label);

  return h('span', { style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } },
    input,
    ui.find
      ? h('span.muted', { style: { fontSize: '11px', minWidth: '58px', fontVariantNumeric: 'tabular-nums' } },
          hits ? `${ui.findAt + 1} of ${hits}` : 'no hits')
      : null,
    ui.find ? nav('\u2039', -1, 'Previous match (Shift+Enter)') : null,
    ui.find ? nav('\u203a', 1, 'Next match (Enter)') : null);
}

function countHits(text, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  const hay = text.toLowerCase(), q = needle.toLowerCase();
  for (;;) {
    const at = hay.indexOf(q, i);
    if (at < 0) return n;
    n += 1; i = at + q.length;
  }
}

/**
 * The response with every match marked.
 *
 * Built as nodes rather than by splicing HTML: a response body is cluster data, and
 * putting it through innerHTML would make a document containing "&lt;img onerror&gt;"
 * into markup this page executes. Searching a response must not be a way to run
 * something.
 */
function highlightFind(text) {
  if (!ui.find) return text;
  const frag = document.createDocumentFragment();
  const hay = text.toLowerCase(), q = ui.find.toLowerCase();
  let i = 0;
  let n = 0;
  for (;;) {
    const at = hay.indexOf(q, i);
    if (at < 0) { frag.append(text.slice(i)); return frag; }
    if (at > i) frag.append(text.slice(i, at));
    // The current match is a different mark, not merely a scrolled-to one: with three
    // matches on screen, "which of these am I on" has to be answerable without moving.
    frag.append(h(n === ui.findAt ? 'mark.on' : 'mark', text.slice(at, at + q.length)));
    n += 1;
    i = at + q.length;
  }
}

function responseCard() {
  const r = ui.res;
  const head = (meta, actions) => h('header', h('h2', 'Results'), meta || null,
    actions ? h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, ...actions) : null);
  if (!r) {
    return h('section.card', { style: { flex: '1', display: 'flex', flexDirection: 'column' } }, head(h('span.sub', 'nothing run yet')),
      h('div.body', { style: { flex: '1' } }, empty('Run a request — the response appears here, next to the query.')));
  }
  const okCls = r.ok ? 'green' : r.status ? 'red' : 'yellow';
  const size = r.json ? JSON.stringify(r.json).length : (r.text || '').length;
  const bodyText = r.json !== null && r.json !== undefined ? JSON.stringify(r.json, null, 2) : (r.text || '');

  const meta = h('span', { style: { display: 'inline-flex', gap: '8px', alignItems: 'center', marginLeft: '8px' } },
    pill(r.status ? `HTTP ${r.status}` : (r.kind || 'error'), okCls),
    h('span.muted', { style: { fontSize: '11.5px' } }, `${dur(r.tookMs)} · ${bytes(size)}`));

  const body = r.kind === 'blocked_readonly'
    ? h('div.banner.warn', { style: { margin: 0 } },
        h('div', h('div.ttl', 'Blocked by read-only mode'), h('div', r.message),
          h('div', { style: { marginTop: '8px' } },
            h('button.btn.sm.primary', { onclick: async () => { await setWritesUnlocked(true); draw(); } }, 'Allow writes'))))
    : !r.status && r.message
    ? h('div',
        h('div.banner.err', { style: { margin: 0 } }, h('div', h('div.ttl', r.kind === 'tunnel_error' ? 'Jump host' : /^tls/.test(r.kind || '') ? 'Certificate' : 'Request failed'),
          h('div', r.message), r.help ? h('div.muted', { style: { fontSize: '11.5px', marginTop: '4px' } }, r.help) : null)),
        /^tls|tunnel_error/.test(r.kind || '')
          ? h('button.btn.sm.primary', { style: { marginTop: '8px' }, onclick: () => navigateTo('overview') }, 'Fix on the Clusters page')
          : null)
    // Editable where it sits, with no mode to enter or leave. Changes are scratch: the
    // response that came back is still in the history, nothing is sent anywhere, and the
    // next search or re-run redraws from the original. It is for reading — widening a
    // line, deleting noise to see what is left — not for keeping.
    : ui.raw || ui.find
      ? editable(h('pre.json', { style: { margin: 0 } }, highlightFind(bodyText)))
      : editable(jsonView(bodyText));

  return h('section.card', { style: { flex: '1', display: 'flex', flexDirection: 'column', minWidth: 0 } },
    head(meta, [
      findBox(bodyText),
      h('button.btn.sm', { onclick: () => { ui.raw = !ui.raw; mount($('#c-response'), responseCard()); } }, ui.raw ? 'Highlighted' : 'Raw'),
      h('button.btn.sm', { onclick: () => navigator.clipboard.writeText(currentText(bodyText)) }, 'Copy'),
      h('button.btn.sm', { onclick: () => download(`response-${Date.now()}.json`, currentText(bodyText), 'application/json') }, 'Save…'),
      h('button.btn.sm.ghost', {
        id: 'c-full',
        title: ui.full ? 'Leave full screen (Esc)' : 'Fill the window with the response',
        onclick: () => { ui.full = !ui.full; draw(); },
      }, ui.full ? '\u2715 Close' : '\u26F6 Full screen')]),
    // Beside the query pane the body is capped so the history stays reachable. In full
    // screen there is nothing else on the page, so it takes the window — the whole point
    // of pressing the button was to stop reading a response through a letterbox.
    h('div.body', {
      style: ui.full
        ? { padding: '10px', flex: '1', minHeight: '0', height: 'calc(100vh - 150px)', overflow: 'auto' }
        : { padding: '10px', flex: '1', minHeight: '340px', maxHeight: '64vh', overflow: 'auto' },
    },
      h('div.mono.muted.trunc', { style: { fontSize: '10.5px', marginBottom: '6px' }, title: r.url }, `${ui.method} ${r.url || ''}`),
      body));
}

function drawHistory() { const el = $('#c-history'); if (el) mount(el, historyCard()); }

function historyCard() {
  let items = history;
  if (ui.showFav) items = items.filter((x) => x.fav);
  if (ui.filter.trim()) {
    const t = ui.filter.toLowerCase();
    items = items.filter((x) => (x.path + ' ' + x.method + ' ' + (x.body || '') + ' ' + (x.cluster || '')).toLowerCase().includes(t));
  }
  const load = (x) => { ui.method = x.method; ui.path = x.path; ui.body = x.body || ''; ui.res = null; draw(); window.scrollTo({ top: 0 }); };
  const rows = items.slice(0, 300).map((x) => h('tr', {
    style: { cursor: 'pointer' },
    title: 'Load this request into the editor',
    // The star is its own button inside the row; a click on it must not also load the row.
    ...activatable((e) => { if (e.target.closest && e.target.closest('button')) return; load(x); }),
  },
    h('td', h('button.btn.sm.ghost', { title: x.fav ? 'Unstar' : 'Star', style: { padding: '0 4px', color: x.fav ? 'var(--warning)' : 'var(--text-muted)' },
      onclick: async () => { x.fav = x.fav ? 0 : 1; remember(() => idb.putQuery(x)); drawHistory(); } }, x.fav ? '★' : '☆')),
    h('td.muted', { style: { fontSize: '11px', whiteSpace: 'nowrap' }, title: dt(x.ts) }, ago(x.ts)),
    h('td', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, x.cluster || '?'),
    h('td.mono', { style: { fontSize: '11px', fontWeight: 700, color: 'var(--accent)' } }, x.method),
    h('td.mono', { style: { fontSize: '11.5px', maxWidth: '520px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: x.path + (x.body ? '\n\n' + x.body : '') }, x.path,
      x.body ? h('span.muted', { style: { marginLeft: '6px', fontSize: '10.5px' } }, `+ body ${bytes(x.body.length)}`) : null),
    h('td', x.status ? pill(`HTTP ${x.status}`, x.ok ? 'green' : 'red') : pill('saved', 'grey')),
    h('td.muted', { style: { fontSize: '11px', whiteSpace: 'nowrap' } }, x.tookMs ? dur(x.tookMs) : '–'),
    h('td', h('div', { style: { display: 'flex', gap: '4px', justifyContent: 'flex-end' } },
      h('button.btn.sm', { onclick: () => load(x) }, 'Load'),
      h('button.btn.sm', { title: 'Load and run', onclick: async () => { load(x); await run(); } }, 'Run'),
      h('button.btn.sm.ghost', { title: 'Delete', onclick: async () => { remember(() => idb.delQuery(x.id)); history = history.filter((y) => y.id !== x.id); drawHistory(); } }, '×')))));

  return card('History', `${history.length} saved · ${history.filter((x) => x.fav).length} favourites`,
    h('div', { style: { display: 'grid', gap: '8px' } },
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        h('input#c-histfilter', { type: 'search', placeholder: 'filter by path, method, body or cluster…', value: ui.filter, style: { flex: '1', maxWidth: '420px' },
          oninput: (e) => { ui.filter = e.target.value; drawHistory(); } }),
        h('button.btn.sm', { onclick: () => { ui.showFav = !ui.showFav; drawHistory(); },
          style: ui.showFav ? { color: 'var(--warning)', borderColor: 'var(--warning)' } : null }, '★ favourites only'),
        h('span.muted', { style: { fontSize: '11px', marginLeft: 'auto' } }, 'click a row to load it into the query')),
      rows.length
        ? h('div', { style: { maxHeight: '40vh', overflow: 'auto' } },
            h('table.tbl', h('thead', h('tr', h('th', ''), h('th', 'When'), h('th', 'Cluster'), h('th', 'Method'), h('th', 'Path'), h('th', 'Status'), h('th', 'Took'), h('th', ''))),
              h('tbody', ...rows)))
        : empty('No saved requests yet')),
    [h('button.btn.sm', { onclick: () => download('rest-history.json', JSON.stringify(history, null, 2), 'application/json') }, 'Export'),
     h('button.btn.sm.danger', { onclick: async () => {
        if (!(await confirmDialog('Clear the request history?',
          'Everything except starred favourites is removed from this machine. Nothing on any ' +
          'cluster is affected.', { yes: 'clear it', danger: true }))) return;
        const favs = history.filter((x) => x.fav);
        remember(() => idb.clearQueries());
        for (const f of favs) remember(() => idb.putQuery(f));
        history = favs; drawHistory();
      } }, 'Clear')]);
}

function snapshotNotice(what) {
  return h('div.banner.warn', { style: { margin: 0 } },
    h('div',
      h('div.ttl', `${what} needs a live connection`),
      h('div', 'You are viewing a snapshot file collected elsewhere, so there is no cluster to query. ',
        'Everything that was collected — cluster health, disk, indices, nodes, snapshots and SLM — is on the other pages.'),
      h('div.sec', { style: { fontSize: '12px', marginTop: '5px' } },
        'To use this page, load clusters.yaml instead (Config → Pick another file) and connect directly.')));
}
