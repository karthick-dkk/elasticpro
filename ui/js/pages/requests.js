/**
 * Page 10 — the Request Centre: every request this core sends to a cluster, in flight and
 * recent, with who asked and how it went. Administrators only: it shows every user's
 * requests on the clusters they share.
 *
 * It reads the core's own log (REQUEST_LOG) and nothing else: opening this page never
 * sends a cluster anything. While it is open it re-reads the log every two seconds — a
 * core round trip, not a cluster one — and stops the moment it is left.
 */

import { h, mount } from '../lib/dom.js';
import { num, dur, dt, toCsv, download } from '../lib/fmt.js';
import { state, clusters, client, requestLoad, refreshRequestLoad } from '../core/state.js';
import { requestLog, policyGet, policySet, housekeepingGet, housekeepingRun } from '../core/es.js';
import { housekeepingView } from '../core/housekeeping.js';
import { contractOf, taskRows, cancelPath, privilegeHint } from '../core/es-tasks.js';
import { ensureWrites, writesAllowed } from '../core/writes.js';
import { confirmDialog } from '../ui/modal.js';
import { togglePaused, setPausedAll, isPaused } from '../core/policy.js';
import { toast } from '../ui/menu.js';
import { card, table, pill, statTile, empty } from './common.js';
import { NO_FILTER, requestRows, originChoices, perCluster, requestCsvRows, CSV_HEADER, originLabel, gateFigures } from '../core/request-log.js';

let host = null;
let log = { inflight: [], recent: [] };
let error = null;
let timer = null;
const filter = { ...NO_FILTER };
/**
 * The request policy, read once on entry and again after each change made here — not on
 * the two-second poll, which is about the log. null until known; {error} if the core
 * refused or does not have one, in which case the pause buttons are not offered.
 */
let policy = null;
let policyBusy = false;
/** The Tasks panel: what the selected cluster said when last asked, and for which cluster. */
let tasks = { cluster: null, rows: null, error: null, busy: false, at: 0, note: '' };
/**
 * Housekeeping (the core cleaning what it leaves behind): its status, read on entry, after a
 * run, and about once a minute — not on the two-second poll, which is about the log. null
 * until known; {error} if the core refused or does not have it.
 */
let hk = null;
let hkBusy = false;
let hkTick = 0;

export function render(el) {
  host = el;
  draw();
  poll();
  loadPolicy();
  loadHousekeeping();
  clearInterval(timer);
  timer = setInterval(() => { if (host && host.isConnected) poll(); else clearInterval(timer); }, 2000);
}

export function onData() { /* the log is the core's; data events do not change it */ }

/** Leaving the page stops the re-read; nothing is polled for a page nobody is looking at. */
export function onLeave() { clearInterval(timer); timer = null; }

async function poll() {
  // About once a minute (every 30th two-second poll) the housekeeping card is read again,
  // so "next run" and a scheduled run's result keep up without a page of their own timer.
  if (++hkTick % 30 === 0) loadHousekeeping();
  try {
    const [r] = await Promise.all([requestLog({ limit: 500 }), refreshRequestLoad()]);
    if (r && r.ok) { log = r; error = null; } else { error = (r && r.message) || 'the core did not answer'; }
  } catch (e) { error = e.message || String(e); }
  if (host && host.isConnected) draw();
}

async function loadPolicy() {
  try {
    const r = await policyGet();
    policy = r && r.ok ? r.policy : { error: (r && r.message) || 'the core did not answer' };
  } catch (e) { policy = { error: e.message || String(e) }; }
  if (host && host.isConnected) draw();
}

async function loadHousekeeping() {
  try {
    const r = await housekeepingGet();
    hk = r && r.ok ? r : { error: (r && r.message) || 'the core did not answer' };
  } catch (e) { hk = { error: e.message || String(e) }; }
  if (host && host.isConnected) draw();
}

/**
 * Run housekeeping now, or only say what it would do. A real run deletes — expired cache
 * files, stale sessions — so it asks first; a dry run, and a core configured to only dry-run,
 * do not.
 */
async function runHousekeeping(dryRun) {
  if (hkBusy) return;
  if (!dryRun && !(hk && hk.dryRun)) {
    const yes = await confirmDialog('Run housekeeping now?',
      'It deletes what ElasticPro itself no longer needs: expired and orphaned cache files, Redis keys of removed clusters, ended sessions and expired API tokens. It never touches config files, saved queries, uploaded keys, users or the config history. Use Dry run to see the list first.',
      { yes: 'run now' });
    if (!yes) return;
  }
  hkBusy = true; draw();
  let r;
  try { r = await housekeepingRun(dryRun); } catch (e) { r = { ok: false, message: e.message || String(e) }; }
  hkBusy = false;
  if (r && r.ok) {
    hk = r;
    toast(r.message || 'Housekeeping ran', r.run && r.run.errors ? 'warn' : 'ok', 6000, { key: 'housekeeping' });
  } else {
    toast(`Not run: ${(r && r.message) || 'refused'}`, 'err', 8000, { key: 'housekeeping' });
  }
  draw();
}

/** Send a changed policy, then read it back: what the core kept is what is shown. */
async function changePolicy(next, said) {
  if (policyBusy) return;
  policyBusy = true; draw();
  let r;
  try { r = await policySet(next); } catch (e) { r = { ok: false, message: e.message || String(e) }; }
  policyBusy = false;
  if (r && r.ok) {
    policy = r.policy;
    toast(said, 'ok', 4000, { key: 'request-pause' });
    if (r.warning) toast(r.warning, 'warn', 8000, { key: 'request-pause-warning' });
  } else {
    toast(`Not changed: ${(r && r.message) || 'refused'}`, 'err', 8000, { key: 'request-pause' });
  }
  await loadPolicy();
}

const policyKnown = () => !!(policy && !policy.error && policy.paused);

function draw() {
  const rows = requestRows(log, filter);
  const inflight = rows.filter((r) => r.inflight).length;
  const perMin = Object.values(requestLoad.clusters || {}).reduce((s, c) => s + (c.perMinute || 0), 0);
  const byCluster = perCluster(log);
  const names = Object.fromEntries(clusters().map((c) => [c.id, c.name]));
  const nameOf = (id) => names[id] || id;
  // Every configured cluster gets a row, not only those in the log: a cluster that has
  // been quiet is exactly the one somebody may want to pause before it is asked again.
  const seen = new Set(byCluster.map((c) => c.cluster));
  const clusterRows = [...byCluster, ...clusters().filter((c) => !seen.has(c.id))
    .map((c) => ({ cluster: c.id, count: 0, inflight: 0, queued: 0, failed: 0, refused: 0, slowestMs: 0 }))];

  const select = (key, options, labelOf = (x) => x) => h('select', { onchange: (e) => { filter[key] = e.target.value; draw(); } },
    ...options.map(([v, l]) => h('option', { value: v, selected: String(filter[key]) === String(v) ? '' : null }, l)));
  const bar = h('div.toolbar', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '10px' } },
    h('label.field', 'Cluster', select('cluster', [['all', 'All clusters'], ...byCluster.map((c) => [c.cluster, nameOf(c.cluster)])])),
    h('label.field', 'Origin', select('origin', [['all', 'All origins'], ...originChoices(log).map((o) => [o, o === 'poller' ? 'poller (background)' : originLabel(o)])])),
    h('label.field', 'Outcome', select('outcome', [['all', 'All'], ['inflight', 'In flight'], ['queued', 'Queued (waiting for a slot)'], ['ok', 'OK'], ['http-error', 'HTTP error'], ['failed', 'Failed / timed out'], ['refused', 'Refused by the gate']])),
    h('label.field', 'Slower than', select('slowerThanMs', [[0, 'any'], [500, '500 ms'], [2000, '2 s'], [10000, '10 s'], [30000, '30 s']])),
    h('button.btn.sm', { style: { marginLeft: 'auto' }, onclick: () => download(`elasticpro-requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(requestCsvRows(rows), CSV_HEADER), 'text/csv') }, 'Export CSV'),
    h('button.btn.sm', { onclick: poll }, '↻ Refresh'));

  // The gate's four figures. From an older core that does not measure them: "—", never 0.
  const g = gateFigures(log);
  const unknown = 'this core does not report it';
  const lim = g.limits;
  const tiles = h('div.tiles', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '12px' } },
    statTile('In flight', num(inflight), inflight ? 'right now' : 'nothing waiting'),
    statTile('Queued', g.queued == null ? '\u2014' : num(g.queued),
      g.queued == null ? unknown : g.queued ? `oldest ${dur(g.oldestWaitMs || 0)}${lim ? ` · max ${num(lim.queueMax)}` : ''}` : `waiting for a slot${lim ? ` · ${num(lim.global)} slots, ${num(lim.perCluster)} per cluster` : ''}`),
    statTile('Wait p95', g.waitP95Ms == null ? '\u2014' : dur(g.waitP95Ms),
      !g.known ? unknown : g.waitCount ? `people's requests, ${num(g.waitCount)} in 5 min` : 'no request from a person in 5 min'),
    statTile('Refused 5 min', g.refused == null ? '\u2014' : num(g.refused),
      g.refused == null ? unknown : g.refused ? `${num(g.overloaded)} queue full · ${num(g.queueTimeout)} waited too long` : 'nothing turned away'),
    statTile('Shared + cached', g.known ? num(g.sharedOrCached) : '\u2014',
      g.known ? `${num(g.shared)} shared · ${num(g.cacheHits)} from cache — not sent again` : unknown),
    statTile('Last 5 minutes', `${perMin.toFixed(1)}/min`, `${num(Object.values(requestLoad.clusters || {}).reduce((s, c) => s + (c.last5m || 0), 0))} requests, every cluster`));

  const stateIn = (r) => r.state === 'queued' ? pill('queued', 'grey') : r.state === 'shared' ? pill(`waiting on #${r.leader}`, 'grey') : pill('in flight', 'yellow');
  const trs = rows.slice(0, 500).map((r) => h('tr', { class: r.inflight ? 'inflight' : (r.ok ? '' : 'failed') },
    h('td.mono', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, dt(r.startedAt)),
    h('td', h('b', nameOf(r.cluster)), r.via ? h('div.muted', { style: { fontSize: '11px' } }, `via ${r.via}`) : null),
    h('td', r.originLabel),
    h('td', { style: { fontSize: '11.5px' } }, r.class || '\u2014'),
    h('td.mono', { style: { fontSize: '11.5px' } }, r.method),
    h('td.mono', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, r.path),
    h('td.num', r.queuedMs ? dur(r.queuedMs) : (r.state === 'queued' ? pill(`${dur(r.elapsedMs)} so far`, 'grey') : '\u2014')),
    h('td.num', r.inflight ? (r.state === 'queued' ? '\u2014' : pill(`${dur(r.elapsedMs)} so far`, 'yellow')) : dur(r.ms)),
    h('td', r.inflight ? stateIn(r) : pill(r.outcome, r.ok ? 'green' : (r.status === 'overloaded' || r.status === 'queue_timeout' ? 'yellow' : 'red')),
      r.answeredBy ? h('span.pill.grey', { style: { marginLeft: '4px' }, title: 'Answered without sending the cluster another request' }, r.answeredBy) : null)));

  const reaper = log.gate && log.gate.taskReaper;
  const gateLine = lim ? h('div.muted', { style: { fontSize: '11.5px', margin: '-4px 0 10px' } },
    `Gate: ${num(lim.global)} connections (${num(lim.perCluster)} per cluster, ${num(lim.perJump)} per jump host, ${num(lim.backgroundReserve)} kept for background) · `
    + `a person's request waits up to ${dur(lim.queueWaitMs)} · read cache ${log.gate.readCache && log.gate.readCache.seconds ? `${log.gate.readCache.seconds} s` : 'off'}`
    + (reaper ? ` · task reaper: ${reaper.mode}${reaper.last && Array.isArray(reaper.last.cancelled) ? `, last run cancelled ${reaper.last.cancelled.filter((x) => x.ok).length}` : ''}` : '')) : null;

  mount(host,
    pauseBar(),
    error ? h('div.banner.err', h('div', h('div.ttl', 'Could not read the request log'), h('div', error))) : null,
    tiles, gateLine, bar,
    card('Requests', `${num(rows.length)} shown · in flight first, then newest first · re-read every 2 s while this page is open`,
      rows.length ? table(['Started', 'Cluster', 'Origin', 'Class', 'Method', 'Path', 'Queued', 'Took', 'Outcome'], trs, {})
        : empty('No requests match — or the core has sent none since it started.')),
    h('div', { style: { marginTop: '14px' } },
      card('Per cluster', 'what the log holds for each cluster',
        table(['Cluster', 'Requests', 'In flight', 'Queued', 'Failed', 'Refused', 'Slowest', ''], clusterRows.map((c) => h('tr',
          h('td', h('b', nameOf(c.cluster)), policyKnown() && isPaused(policy, c.cluster)
            ? h('span.pill.grey', { style: { marginLeft: '6px' }, title: policy.paused.all ? 'Every request is paused' : 'Nothing new starts for this cluster' }, 'paused') : null,
            throttleOf(c.cluster)),
          h('td.num', num(c.count)), h('td.num', num(c.inflight)),
          h('td.num', c.queued ? pill(num(c.queued), 'grey') : '0'),
          h('td.num', c.failed ? pill(num(c.failed), 'red') : '0'),
          h('td.num', c.refused ? pill(num(c.refused), 'yellow') : '0'), h('td.num', c.count ? dur(c.slowestMs) : '\u2014'),
          h('td', { style: { textAlign: 'right' } }, pauseButton(c.cluster, nameOf(c.cluster))))), { emptyText: 'nothing yet' }))),
    h('div', { style: { marginTop: '14px' } }, tasksCard(nameOf)),
    h('div', { style: { marginTop: '14px' } }, housekeepingCard()));
}

/* ------------------------------------ housekeeping ------------------------------------ */

function housekeepingCard() {
  const v = housekeepingView(hk);
  const title = 'Housekeeping';
  const sub = 'cleans what ElasticPro itself leaves behind \u2014 cache files, stale sessions, expired tokens';
  if (v.state === 'loading') return card(title, sub, empty('Loading\u2026'));
  if (v.state === 'unavailable') return card(title, sub, empty(v.title, { detail: v.reason }));
  const busy = hkBusy || v.running;
  const actions = [
    h('button.btn.sm', { 'data-act': 'hk-dry', disabled: busy, onclick: () => runHousekeeping(true),
      title: 'List what a run would remove, and remove nothing' }, busy ? 'Working\u2026' : 'Dry run'),
    h('button.btn.sm.primary', { 'data-act': 'hk-run', disabled: busy, onclick: () => runHousekeeping(false),
      title: v.dryRun ? 'This core is set to dry-run only (HOUSEKEEPING_DRY_RUN): a run reports and removes nothing' : 'Clean up now' }, 'Run now'),
  ];
  const last = v.last;
  const head = h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } },
    h('span', 'Runs ', h('b', v.schedule)),
    v.dryRun ? pill('dry-run only', 'yellow') : null,
    h('span', 'Next run ', h('b', v.nextRun || '\u2014')),
    last
      ? h('span', 'Last run ', h('b', dt(last.at)), ` ${last.trigger}${last.dryRun ? ' (dry run)' : ''}: ${last.summary}`,
        last.errors ? pill(`${last.errors} failed`, 'red') : null)
      : h('span.muted', 'Not run since the core started.'));
  const rows = v.jobs.map((j) => h('tr', { 'data-job': j.id },
    h('td', h('b', j.label)),
    h('td', j.state === 'err' ? pill('failed', 'red') : j.state === 'ok' ? pill(v.last && v.last.dryRun ? 'would remove' : 'removed', 'green') : j.state === 'skip' ? pill('skipped', 'grey') : pill('clean', 'grey')),
    h('td', { style: { fontSize: '12px' } }, j.text, ...j.notes.map((n) => h('div.muted', { style: { fontSize: '11px' } }, n)))));
  const kept = v.reportOnly.length
    ? h('div.muted', { style: { fontSize: '11.5px', marginTop: '8px' } },
      'Never deleted, only reported: ', v.reportOnly.map((r) => `${r.label} (${r.text})`).join(' \u00b7 '))
    : null;
  return card(title, sub, h('div',
    head,
    v.jobs.length ? table(['Job', '', 'Result'], rows, {}) : empty('Run it once to see what each job does.'),
    h('div.muted', { style: { fontSize: '11.5px', marginTop: '8px' } }, `Removes ${v.rules.join('; ')}.`),
    kept), actions);
}

/** "throttled: why" — the core is holding back from this cluster (budget spent, or backing off). */
function throttleOf(id) {
  const t = log.throttled && log.throttled[id];
  if (!t) return null;
  const left = Math.max(0, (t.until || 0) - Date.now());
  return h('span.pill.yellow', { style: { marginLeft: '6px' }, title: `${t.reason || t.kind}. The poller's own fetches wait${left ? ` ${dur(left)} more` : ''}; a request you make still goes.` },
    `throttled: ${t.kind === 'backoff' ? 'backing off' : 'budget'}`);
}

/* ------------------------------------ tasks ------------------------------------ */

/** Which cluster the panel is about: the selected one, else the first configured. */
function taskCluster() {
  const sel = state.selected && state.selected !== 'all' ? clusters().find((c) => c.id === state.selected) : null;
  return sel || clusters().find((c) => c.id === tasks.cluster) || clusters()[0] || null;
}

async function readTasks(c) {
  if (!c || tasks.busy) return;
  tasks = { ...tasks, cluster: c.id, busy: true, error: null, note: '' };
  draw();
  // Which listing to read, and how ours are recognised, are the core's: from the log when it
  // has been read, else asked for now.
  let contract = contractOf(log);
  if (!contract) contract = contractOf(await requestLog({ limit: 1 }).catch(() => null));
  if (!contract) {
    tasks = { ...tasks, busy: false, error: 'This ElasticPro core does not say how to list tasks (it is older than the page). Update it.' };
    draw();
    return;
  }
  const res = await client(c.id).request('GET', contract.path, null, { origin: 'page:requests' }).catch((e) => ({ ok: false, message: e.message || String(e) }));
  tasks = { ...tasks, busy: false, at: Date.now(),
    rows: res.ok ? taskRows(res.json, { contract }) : null,
    error: res.ok ? null : (privilegeHint(res.status, 'list') || res.message || `HTTP ${res.status}`) };
  draw();
}

async function cancelTask(c, row) {
  // Two decisions by hand: the guard (config permits writes, or the session is unlocked
  // for them) and this cancel. The core refuses anything less (`Writes::decide`).
  if (!(await ensureWrites())) return;
  const what = row.ours ? `our ${row.origin || 'request'}` : 'somebody else\u2019s search';
  const yes = await confirmDialog(`Cancel task ${row.id} on ${c.name}?`,
    `${what}, running ${dur(row.runningMs || 0)}: ${row.description || row.action}. Elasticsearch stops it where it is; nothing is rolled back.`, { yes: 'cancel the task' });
  if (!yes) return;
  const res = await client(c.id).request('POST', cancelPath(row.id), null, { allowWrites: true, origin: 'page:requests' })
    .catch((e) => ({ ok: false, message: e.message || String(e) }));
  if (res.ok) { toast(`Cancelled ${row.id} on ${c.name}`); tasks = { ...tasks, note: `Cancelled ${row.id}; re-read to see the list without it.` }; await readTasks(c); }
  else { tasks = { ...tasks, note: privilegeHint(res.status, 'cancel') || res.message || `Cancel failed: HTTP ${res.status}` }; draw(); }
}

function tasksCard(nameOf) {
  const c = taskCluster();
  const picker = h('select', { onchange: (e) => { tasks = { ...tasks, cluster: e.target.value, rows: null, error: null, note: '' }; draw(); } },
    ...clusters().map((x) => h('option', { value: x.id, selected: c && x.id === c.id ? '' : null }, x.name)));
  const head = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '8px' } },
    h('label.field', 'Cluster', picker),
    h('button.btn.sm', { disabled: !c || tasks.busy, onclick: () => readTasks(c), 'data-act': 'read-tasks' }, tasks.busy ? 'Loading\u2026' : 'Read tasks'),
    tasks.at && tasks.cluster === (c && c.id) ? h('span.muted', { style: { fontSize: '11.5px' } }, `read ${dt(tasks.at)}`) : null,
    h('span.muted', { style: { fontSize: '11.5px', marginLeft: 'auto' } }, writesAllowed() ? 'Cancel is a write under the guard' : 'Cancel asks to unlock writes first'));
  const rows = tasks.cluster === (c && c.id) ? tasks.rows : null;
  const body = tasks.error && tasks.cluster === (c && c.id)
    ? h('div.banner.err', h('div', h('div.ttl', 'Could not read the task list'), h('div', tasks.error)))
    : rows === null
      ? empty('Not read yet \u2014 press Read tasks. Listing needs the cluster privilege "monitor"; this sends one request to the cluster you chose.')
      : rows.length === 0
        ? empty('No search running on this cluster right now.')
        : table(['Task', 'Who', 'Running', 'Action', 'Description', ''], rows.map((r) => h('tr',
          h('td.mono', { style: { fontSize: '11.5px' } }, r.id, r.node ? h('div.muted', { style: { fontSize: '11px' } }, r.node) : null),
          h('td', r.ours ? pill(`ours \u00b7 ${r.origin || 'core'}${r.run === 'previous' ? ' \u00b7 before the restart' : r.run === 'other' ? ' \u00b7 another install' : ''}`, 'green') : pill('someone else', 'grey'),
            r.opaqueId ? h('div.mono.muted', { style: { fontSize: '10.5px', wordBreak: 'break-all' } }, r.opaqueId) : null),
          h('td.num', r.runningMs == null ? '\u2014' : dur(r.runningMs)),
          h('td.mono', { style: { fontSize: '11.5px' } }, r.action),
          h('td', { style: { fontSize: '12px', wordBreak: 'break-all' } }, r.description),
          h('td', { style: { textAlign: 'right' } }, r.cancellable
            ? h('button.btn.sm', { 'data-act': 'cancel-task', title: 'POST _tasks/<id>/_cancel \u2014 a write, under the guard', onclick: () => cancelTask(c, r) }, 'Cancel')
            : h('span.muted', { style: { fontSize: '11px' } }, 'not cancellable')))), {});
  return card('Tasks on the cluster', 'what Elasticsearch is running for anyone right now \u2014 ours carry our X-Opaque-Id',
    h('div', head, tasks.note ? h('div.banner', { style: { marginBottom: '8px' } }, tasks.note) : null, body));
}

/** "Pause all requests" / "Resume all", above everything else on the page. */
function pauseBar() {
  if (!policyKnown()) {
    return policy && policy.error
      ? h('div.muted', { style: { fontSize: '11.5px', marginBottom: '8px' } }, `Pausing is not available: ${policy.error}`)
      : null;
  }
  const all = !!policy.paused.all;
  const some = (policy.paused.clusters || []).length;
  return h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' } },
    all ? h('span.pill.grey', { title: 'Nothing new starts on any cluster; what was in flight finishes' }, 'requests paused')
      : some ? h('span.muted', { style: { fontSize: '11.5px' } }, `${some} cluster(s) paused`) : null,
    h('button.btn.sm', {
      disabled: policyBusy,
      title: all ? 'Let the core send requests again' : 'Nothing new starts; requests in flight finish, and a page\u2019s request waits',
      onclick: () => changePolicy(setPausedAll(policy, !all), all ? 'Requests resumed' : 'All requests paused'),
    }, all ? 'Resume all' : 'Pause all requests'));
}

function pauseButton(id, name) {
  if (!policyKnown()) return null;
  const paused = (policy.paused.clusters || []).includes(id);
  return h('button.btn.sm', {
    disabled: policyBusy,
    title: paused ? `Let the core send requests to ${name} again` : `Nothing new starts for ${name}; requests in flight finish`,
    onclick: () => changePolicy(togglePaused(policy, id, !paused), paused ? `${name}: resumed` : `${name}: paused`),
  }, paused ? 'Resume' : 'Pause');
}
