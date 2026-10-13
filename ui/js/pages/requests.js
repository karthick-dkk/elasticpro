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
import { clusters, requestLoad, refreshRequestLoad } from '../core/state.js';
import { requestLog, policyGet, policySet } from '../core/es.js';
import { togglePaused, setPausedAll, isPaused } from '../core/policy.js';
import { toast } from '../ui/menu.js';
import { card, table, pill, statTile, empty } from './common.js';
import { NO_FILTER, requestRows, originChoices, perCluster, requestCsvRows, CSV_HEADER, originLabel } from '../core/request-log.js';

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

export function render(el) {
  host = el;
  draw();
  poll();
  loadPolicy();
  clearInterval(timer);
  timer = setInterval(() => { if (host && host.isConnected) poll(); else clearInterval(timer); }, 2000);
}

export function onData() { /* the log is the core's; data events do not change it */ }

/** Leaving the page stops the re-read; nothing is polled for a page nobody is looking at. */
export function onLeave() { clearInterval(timer); timer = null; }

async function poll() {
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
    .map((c) => ({ cluster: c.id, count: 0, inflight: 0, failed: 0, slowestMs: 0 }))];

  const select = (key, options, labelOf = (x) => x) => h('select', { onchange: (e) => { filter[key] = e.target.value; draw(); } },
    ...options.map(([v, l]) => h('option', { value: v, selected: String(filter[key]) === String(v) ? '' : null }, l)));
  const bar = h('div.toolbar', { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '10px' } },
    h('label.field', 'Cluster', select('cluster', [['all', 'All clusters'], ...byCluster.map((c) => [c.cluster, nameOf(c.cluster)])])),
    h('label.field', 'Origin', select('origin', [['all', 'All origins'], ...originChoices(log).map((o) => [o, o === 'poller' ? 'poller (background)' : originLabel(o)])])),
    h('label.field', 'Outcome', select('outcome', [['all', 'All'], ['inflight', 'In flight'], ['ok', 'OK'], ['http-error', 'HTTP error'], ['failed', 'Failed / timed out']])),
    h('label.field', 'Slower than', select('slowerThanMs', [[0, 'any'], [500, '500 ms'], [2000, '2 s'], [10000, '10 s'], [30000, '30 s']])),
    h('button.btn.sm', { style: { marginLeft: 'auto' }, onclick: () => download(`elasticpro-requests-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(requestCsvRows(rows), CSV_HEADER), 'text/csv') }, 'Export CSV'),
    h('button.btn.sm', { onclick: poll }, '↻ Refresh'));

  const tiles = h('div.tiles', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '12px' } },
    statTile('In flight', num(inflight), inflight ? 'right now' : 'nothing waiting'),
    statTile('Last 5 minutes', `${perMin.toFixed(1)}/min`, `${num(Object.values(requestLoad.clusters || {}).reduce((s, c) => s + (c.last5m || 0), 0))} requests, every cluster`),
    statTile('Remembered', num((log.recent || []).length), `of the last ${num(log.keep || 2000)} finished`),
    statTile('Clusters seen', num(byCluster.length), byCluster[0] ? `busiest: ${nameOf(byCluster[0].cluster)} (${byCluster[0].count})` : '—'));

  const trs = rows.slice(0, 500).map((r) => h('tr', { class: r.inflight ? 'inflight' : (r.ok ? '' : 'failed') },
    h('td.mono', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, dt(r.startedAt)),
    h('td', h('b', nameOf(r.cluster)), r.via ? h('div.muted', { style: { fontSize: '11px' } }, `via ${r.via}`) : null),
    h('td', r.originLabel),
    h('td.mono', { style: { fontSize: '11.5px' } }, r.method),
    h('td.mono', { style: { fontSize: '11.5px', wordBreak: 'break-all' } }, r.path),
    h('td.num', r.inflight ? pill(`${dur(r.elapsedMs)} so far`, 'yellow') : dur(r.ms)),
    h('td', r.inflight ? pill('in flight', 'yellow') : pill(r.outcome, r.ok ? 'green' : 'red'))));

  mount(host,
    pauseBar(),
    error ? h('div.banner.err', h('div', h('div.ttl', 'Could not read the request log'), h('div', error))) : null,
    tiles, bar,
    card('Requests', `${num(rows.length)} shown · in flight first, then newest first · re-read every 2 s while this page is open`,
      rows.length ? table(['Started', 'Cluster', 'Origin', 'Method', 'Path', 'Took', 'Outcome'], trs, {})
        : empty('No requests match — or the core has sent none since it started.')),
    h('div', { style: { marginTop: '14px' } },
      card('Per cluster', 'what the log holds for each cluster',
        table(['Cluster', 'Requests', 'In flight', 'Failed', 'Slowest', ''], clusterRows.map((c) => h('tr',
          h('td', h('b', nameOf(c.cluster)), policyKnown() && isPaused(policy, c.cluster)
            ? h('span.pill.grey', { style: { marginLeft: '6px' }, title: policy.paused.all ? 'Every request is paused' : 'Nothing new starts for this cluster' }, 'paused') : null),
          h('td.num', num(c.count)), h('td.num', num(c.inflight)),
          h('td.num', c.failed ? pill(num(c.failed), 'red') : '0'), h('td.num', c.count ? dur(c.slowestMs) : '\u2014'),
          h('td', { style: { textAlign: 'right' } }, pauseButton(c.cluster, nameOf(c.cluster))))), { emptyText: 'nothing yet' }))));
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
