/**
 * Jobs (docs/JOBS.md "Jobs page"): everything ElasticPro runs by itself or when a person asks —
 * what runs now, what runs next, every job, every run, and the settings the controls keep.
 *
 * Three tabs, each its own address: Jobs (#/jobs), History (#/jobs/history) and Settings
 * (#/jobs/settings). A strip above them says how busy the server is. A fourth, Requests
 * (#/jobs/requests), is the Request Centre (pages/requests.js) — its own app page, `requests`,
 * drawn under this tab row (hostedPage below); it moved here from Config-Management in 0.3.71
 * and is an operator's and an administrator's, as it was there. A user reads it all;
 * only an administrator presses anything, and every press goes through the write unlock the
 * other admin pages use (core/writes.js ensureWrites) and says a refusal as a sentence.
 *
 * It reads JOBS_LIST every 3 s while a run is open, every 5 s on the Jobs tab otherwise and
 * every 15 s on History and Settings (core/jobs.js pollDelay), not at all while
 * the tab is hidden, and stops when the page is left. Nothing is sent to a cluster. Each row and
 * cell is the one already on screen unless what it shows changed (lib/keyed.js): the row under
 * the pointer, an open menu and a field being typed into stay where they are while runs move.
 */

import { h, mount, reconcile } from '../lib/dom.js';
import { nodeCache } from '../lib/keyed.js';
import { tableSort } from '../lib/table-sort.js';
import { dt, num as fmtNum, download } from '../lib/fmt.js';
import { state, clusters, requestLoad, refreshRequestLoad } from '../core/state.js';
import { jobsList, jobControl, jobRunDetail, slowSearches } from '../core/es.js';
import { ensureWrites } from '../core/writes.js';
import { MANAGED_NOTE } from '../core/managed.js';
import { confirmDialog, modal } from '../ui/modal.js';
import { toast, rowMenu } from '../ui/menu.js';
import { openCreateJob, createdToast } from '../ui/job-create.js';
import { keptCard, keptTable } from './common.js';
import { canOpenPage, navigateTo } from '../core/intent.js';
import * as J from '../core/jobs.js';
import * as GR from '../core/jobs-graph.js';
import * as D from '../core/job-detail.js';
import { createGraph } from './jobs-graph.js';

/** The tabs, in order. */
export const JOB_TABS = Object.freeze([
  { id: 'jobs', label: 'Jobs' }, { id: 'history', label: 'History' }, { id: 'settings', label: 'Settings' },
]);
/** The Request Centre's tab: an app page of its own (`requests`, #/jobs/requests), shown to whoever may open it. */
export const REQUESTS_TAB = Object.freeze({ id: 'requests', label: 'Requests' });
const tabHash = (id) => (id === 'jobs' ? '#/jobs' : `#/jobs/${id}`);
const hashNow = () => (typeof location !== 'undefined' ? location.hash : '');
/** The tab an address names; Jobs for anything else. */
export function tabOfHash(hash) {
  const rest = String(hash || '').replace(/^#\/?/, '').split('?')[0].split('/');
  return rest[0] === 'jobs' && JOB_TABS.some((t) => t.id === rest[1]) ? rest[1] : 'jobs';
}

/** Changes, and reads the settings: an administrator (the portable build is its own). */
const isAdmin = () => !state.caller || state.caller.role === 'admin';

let host = null;
let pageEl = null;
let tab = 'jobs';
/** JOBS_LIST's last answer (first page of runs), why the last read failed, whether the core has none. */
let list = null;
let listError = null;
let unsupported = false;
/** One loop of reads per visit: a read in flight from a visit that has ended schedules nothing. */
let gen = 0;
let timer = null;
let loadAt = 0;
let visHooked = false;
/** The last refusal or result, said under the tabs until the next press. */
let notice = null;
/** All jobs: the rows whose details are open. */
const expanded = new Set();
/** A job to show in Settings (a row's "Settings"): marked, and scrolled to once. */
let focusJob = null;
let focusScrolled = false;

/** History: the filter, the page (`before`), the pages walked through, and the answer. */
const hist = { jobId: '', result: '', before: null, stack: [], answer: null, error: null, loading: false };
/** Settings: JOB_SETTINGS_GET's answer, what is typed, and the read's state. */
const sett = { res: null, error: null, loading: false, draft: null, saving: false };

const built = nodeCache();
/** The graphical view's cards and their reads (pages/jobs-graph.js). */
const graph = createGraph();
const SORTS = {
  all: tableSort('jobs.all', { onChange: () => draw() }),
  history: tableSort('jobs.history', { onChange: () => draw() }),
};

/* ------------------------------------ the page ------------------------------------ */

export function render(el) {
  host = el;
  details.clear();
  tab = tabOfHash(hashNow());
  if (!visHooked && typeof document !== 'undefined') { document.addEventListener('visibilitychange', onVisibility); visHooked = true; }
  gen++;
  clearTimeout(timer); timer = null;
  draw();
  if (tab === 'settings') loadSettings({ again: !unsavedChanges() });
  if (tab === 'history') loadHistory();
  tick(gen);
}

/** Another tab of this page (#/jobs ↔ #/jobs/history ↔ #/jobs/settings). */
export function onRoute() {
  if (!host) return;
  const want = tabOfHash(hashNow());
  if (want === tab) return;
  tab = want;
  notice = null;
  if (tab === 'settings') loadSettings({ again: true });
  if (tab === 'history') loadHistory();
  draw();
  // Back on Jobs: read now and at its own pace (5 s), not after History's or Settings' 15 s.
  if (tab === 'jobs') kick();
}

export function onData() { if (host) draw(); }

/** Leaving the page stops the reads; a read still in flight lands on nothing. */
export function onLeave() {
  gen++;
  clearTimeout(timer); timer = null;
  host = null;
  if (visHooked && typeof document !== 'undefined') { document.removeEventListener('visibilitychange', onVisibility); visHooked = false; }
}

/** Unsaved settings: the shell asks before leaving (app.js go()). */
export function unsavedChanges() {
  return sett.res && sett.draft ? J.settingsChanges(sett.res, sett.draft).length : 0;
}
export { hashNow };

function onVisibility() {
  if (!host) return;
  if (document.hidden) { clearTimeout(timer); timer = null; return; }
  if (!timer) tick(gen);
}

/** Read now, then again after the delay the answer calls for — unless the visit ended or the tab is hidden. */
async function tick(g) {
  clearTimeout(timer); timer = null;
  await load();
  if (g !== gen || !host) return;
  if (typeof document !== 'undefined' && document.hidden) return;
  // A press reads again at once (kick) while the loop's own read may be in flight: whichever
  // ends last sets the one timer, so there is never a second loop.
  clearTimeout(timer);
  timer = setTimeout(() => tick(g), J.pollDelay(list, { jobsTab: tab === 'jobs' }));
}

/** Read again now (after a press), keeping the same loop. */
function kick() { if (host) tick(gen); }

async function load() {
  const res = await jobsList({ limit: 50 });
  if (res && res.ok) { list = res; listError = null; unsupported = false; }
  else if (res && (res.kind === 'bad_message' || res.kind === 'unknown_message')) unsupported = true;
  else listError = J.refusalText(res) || 'the core did not answer';
  // Requests per second to the clusters: REQUEST_STATS, as the Clusters page reads it — not every tick.
  if (Date.now() - loadAt > 10_000) { loadAt = Date.now(); await refreshRequestLoad(); }
  if (host && tab === 'history' && !hist.before) await loadHistory({ quiet: true });
  // The graphical view's own reads (health lines, ElasticPro health, the runs): each at its own pace.
  if (host && tab === 'jobs' && list) graph.refresh({ admin: isAdmin(), onDone: () => { if (host && tab === 'jobs') draw(); } });
  // Slow searches now: at most every 30 s, only while this tab is open (SLOW_SEARCHES).
  if (host && tab === 'jobs' && list) loadSlow();
  if (host) draw();
}

function openTab(id, { job = null } = {}) {
  focusJob = job; focusScrolled = false;
  if (typeof location !== 'undefined' && location.hash !== tabHash(id)) location.hash = tabHash(id);   // the shell calls onRoute
  else { tab = id; if (id === 'settings') loadSettings({ again: true }); if (id === 'history') loadHistory(); draw(); }
}

function draw() {
  if (!host) return;
  if (!pageEl) pageEl = h('div.jb-page');
  if (host.firstChild !== pageEl || host.childNodes.length !== 1) mount(host, pageEl);
  built.begin();
  try { mount(pageEl, ...pageKids()); } finally { built.end(); }
  if (tab === 'settings' && focusJob && !focusScrolled) {
    const row = [...pageEl.querySelectorAll('tr[data-job]')].find((r) => r.dataset.job === focusJob);
    if (row && row.scrollIntoView) { row.scrollIntoView({ block: 'center' }); focusScrolled = true; }
  }
}

function pageKids() {
  const now = Date.now();
  return [
    head(),
    notice ? built.same('notice', h(`div.banner.${notice.level === 'warn' ? 'warn' : notice.level === 'ok' ? 'ok' : 'err'}.jb-notice`, { role: 'status' },
      h('span', notice.text), h('button.btn.ghost.sm', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { notice = null; draw(); } }, '×'))) : null,
    unsupported ? built.same('unsup', h('div.banner.warn', 'This server does not list its jobs yet: JOBS_LIST needs a newer ElasticPro.')) : null,
    listError ? built.same('err', h('div.banner.err', `The jobs could not be read: ${listError}`)) : null,
    list && Array.isArray(list.problems) && list.problems.length
      ? built.same('problems', h('div.banner.warn', `Some runs are missing from this list — a run log could not be read: ${list.problems.join('; ')}`)) : null,
    // On the Jobs tab the Now and Health cards say what the strip says, with their lines.
    tab === 'jobs' ? null : strip(now),
    ...(tab === 'history' ? historyKids(now) : tab === 'settings' ? settingsKids() : jobsKids(now)),
  ].filter(Boolean);
}

/** The tab row: Jobs · History · Settings, and Requests for whoever may open the Request Centre. */
function tabsNav(current) {
  const all = canOpenPage('requests') ? [...JOB_TABS, REQUESTS_TAB] : JOB_TABS;
  return h('nav.subnav.jb-tabs', { 'aria-label': 'Jobs' },
    ...all.map((t) => h('button', {
      type: 'button', dataset: { tab: t.id }, 'aria-current': current === t.id ? 'page' : null, onclick: () => openTab(t.id),
    }, t.label)));
}

function head() {
  const admin = isAdmin();
  const tabs = tabsNav(tab);
  const right = h('div.jb-head-acts',
    admin ? null : h('span.muted.jb-ro', { title: 'Only an administrator runs, pauses or changes jobs' }, 'read-only · an administrator runs and changes jobs'),
    admin ? h('button#jb-create.btn.sm.primary', { type: 'button', onclick: createJob }, 'Create job') : null);
  return built.same('head', h('div.jb-head', tabs, right));
}

/* ---------------------------- Jobs › Requests (hosted) ---------------------------- */

/**
 * The Request Centre drawn as this page's Requests tab (#/jobs/requests, #/jobs/requests/health).
 * app.js registers it under its own id, `requests`, with this as its module: the shell's hooks
 * reach the page inside, and every navigateTo('requests'), alert "go to" and old address
 * (#/requests, #/settings/requests/centre — reports/route.js movedPath) still lands on it. The
 * Jobs tab row is drawn above it; JOBS_LIST is not read meanwhile (the Jobs tabs' own loop).
 */
export function hostedPage(mod) {
  let el = null;
  let body = null;
  return {
    render(view) {
      el = view;
      if (!body) body = h('div.jb-hosted', { dataset: { hosted: 'requests' } });
      mount(view, h('div.jb-host', h('div.jb-head', tabsNav(REQUESTS_TAB.id)), body));
      mod.render(body);
    },
    onData() { if (el && mod.onData) mod.onData(); },
    onRoute() { if (el && mod.onRoute) mod.onRoute(); },
    onKey(e) { return !!(mod.onKey && mod.onKey(e)); },
    onLeave() {
      if (mod.onLeave) { try { mod.onLeave(); } catch (_) { /* leaving must not block arriving */ } }
      el = null; body = null;
    },
    hashNow,
  };
}

/* ------------------------------------ the strip ------------------------------------ */

const nameOfCluster = (id) => (clusters().find((c) => c.id === id) || {}).name || id;

function chip(key, label, value, { sub = '', title = '', tone = '' } = {}) {
  return built.same(`chip:${key}`, h(`div.jb-chip${tone ? `.${tone}` : ''}`, { dataset: { chip: key }, title: title || null },
    h('span.k', label), h('b.v', value), sub ? h('span.d', sub) : null));
}

function strip(now) {
  const p = J.processFigures(list && list.process);
  const c = J.runCounts(list);
  const busy = (list && Array.isArray(list.busy)) ? list.busy : null;
  const gov = J.governorText(list && list.governor);
  const seen = new Set(clusters().map((x) => x.id));
  const rps = requestLoad.at ? Object.entries(requestLoad.clusters || {}).filter(([id]) => !seen.size || seen.has(id))
    .reduce((s, [, v]) => s + (Number(v && v.perSecond) || 0), 0) : null;
  const busyLines = busy ? busy.map((b) => J.busyText(b, nameOfCluster, now)) : [];
  const kids = [
    chip('worker-cpu', 'Worker CPU', p.inCore ? 'in core' : J.pctText(p.workerCpu), { title: p.workerText || 'the report worker\'s CPU, last minute', tone: p.workerText && !p.inCore ? 'warn' : '' }),
    chip('core-cpu', 'Core CPU', J.pctText(p.coreCpu), { title: 'the core\'s CPU, last minute' }),
    chip('memory', 'Memory', `${J.pctText(p.coreMem)}${p.inCore ? '' : ` · ${J.pctText(p.workerMem)}`}`, { sub: p.inCore ? 'core' : 'core · worker', title: 'resident memory of the limit' }),
    chip('rps', 'Requests/s', rps === null ? '—' : rps < 10 ? rps.toFixed(1) : String(Math.round(rps)), { title: `to the clusters, over the last ${Math.round((requestLoad.windowSec || 300) / 60)} minutes (REQUEST_STATS)` }),
    chip('runs', 'Jobs', list ? `${c.running} running · ${c.queued} queued` : '—', { tone: c.running ? 'run' : '' }),
    chip('busy', 'Busy clusters', busy === null ? '—' : busy.length ? String(busy.length) : 'none',
      { sub: busyLines.length ? J.truncate(busyLines[0], 46) + (busyLines.length > 1 ? ` +${busyLines.length - 1}` : '') : '', title: busyLines.join('\n') || 'no cluster is holding background work back', tone: busy && busy.length ? 'warn' : '' }),
    gov ? chip('governor', 'Governor', gov.text, { sub: gov.auto,
      title: ['the adaptive concurrency governor: requests the worker\'s jobs have at Elasticsearch', gov.jobs, gov.change, gov.signals].filter(Boolean).join('\n') }) : null,
  ];
  const el = built.get('strip', 'div', () => h('div.jb-strip', { role: 'group', 'aria-label': 'Server load' }));
  reconcile(el, kids.filter(Boolean));
  return el;
}

/* -------------------------------- kept rows and cells -------------------------------- */

/**
 * A cell kept under `key`: the same <td> for as long as the page shows it, its title and its
 * contents put back only where they changed. Text is written into the text node already there.
 */
function td(key, kids, { cls = '', title = null, num = false, colspan = null } = {}) {
  const tag = `td${num ? '.num' : ''}${cls ? `.${cls}` : ''}`;
  const el = built.get(key, `${tag}|${colspan || ''}`, () => h(tag, colspan ? { colspan } : null));
  const t = title ? String(title) : '';
  if ((el.getAttribute('title') || '') !== t) { if (t) el.setAttribute('title', t); else el.removeAttribute('title'); }
  if (typeof kids === 'string' || typeof kids === 'number') {
    const s = String(kids);
    if (el.childNodes.length === 1 && el.firstChild.nodeType === 3) { if (el.firstChild.data !== s) el.firstChild.data = s; }
    else mount(el, s);
    return el;
  }
  // Text among the pieces is compared as text: the same words keep the text node on screen.
  const nodes = built.sameAll(key, [kids]).map((k, i) => {
    if (k && k.nodeType) return k;
    const s = String(k);
    const was = el.childNodes[i];
    return was && was.nodeType === 3 && was.data === s ? was : document.createTextNode(s);
  });
  reconcile(el, nodes);
  return el;
}

/** A row kept under `key`, its cells put in order. */
function tr(key, cells, { cls = '', data = {} } = {}) {
  const el = built.get(key, `tr${cls}`, () => h(`tr${cls ? `.${cls}` : ''}`));
  for (const [k, v] of Object.entries(data)) if (el.dataset[k] !== String(v)) el.dataset[k] = String(v);
  reconcile(el, cells);
  return el;
}

/** A progress bar kept under `key`: its width set in place, never rebuilt while a run moves. */
function bar(key, pct, tone) {
  const el = built.get(key, tone, () => h(`span.jb-bar.${tone}`, { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i')));
  const w = `${pct}%`;
  if (el.firstChild.style.width !== w) el.firstChild.style.width = w;
  if (el.getAttribute('aria-valuenow') !== String(pct)) el.setAttribute('aria-valuenow', String(pct));
  return el;
}

const pill = (text, tone, title = null) => h(`span.pill.${tone}`, { title }, h('i.dot'), text);
const dash = () => h('span.muted', '—');

/* ------------------------------------- Jobs tab ------------------------------------- */

const jobById = (id) => ((list && list.jobs) || []).find((j) => j.id === id) || null;
const jobName = (id) => { const j = jobById(id); return j ? j.name : id; };
const tz = () => (list && (list.tz || list.serverTz)) || null;

function jobsKids(now) {
  if (!list) return [built.same('loading', h('div.tbl-empty', unsupported ? '' : 'Reading the jobs…'))];
  // The approved graphical view (0.3.77): Now, Health, ElasticPro health (an administrator's),
  // Runs — then the tables.
  // Slow searches now (0.3.81) sits under Now: what is running long on the clusters right now.
  return [nowCard(now), slowCard(), healthCard(now), isAdmin() ? appHealthCard() : null, runsCard(now),
    allJobsCard(now), upNextCard(now), createdCard(now)].filter(Boolean);
}

/**
 * The graph's cards, kept between reads while what they show is the same (a card rebuilt every
 * 3 s would take the hover from under the pointer): a signature of what each one draws.
 */
function healthValues(now) {
  const p = J.processFigures(list && list.process);
  const busy = (list && Array.isArray(list.busy)) ? list.busy : null;
  const seen = new Set(clusters().map((x) => x.id));
  const rps = requestLoad.at ? Object.entries(requestLoad.clusters || {}).filter(([id]) => !seen.size || seen.has(id))
    .reduce((s, [, v]) => s + (Number(v && v.perSecond) || 0), 0) : null;
  const busyLines = busy ? busy.map((b) => J.busyText(b, nameOfCluster, now)) : [];
  return {
    'worker-cpu': { text: p.inCore ? 'in core' : J.pctText(p.workerCpu), sub: p.inCore ? 'role all: the core runs the worker\'s jobs' : (p.workerText || 'the report worker · last minute'), title: p.workerText || null },
    'core-cpu': { text: J.pctText(p.coreCpu), sub: 'the core · last minute' },
    memory: { text: `${J.pctText(p.coreMem)}${p.inCore ? '' : ` · ${J.pctText(p.workerMem)}`}`, sub: p.inCore ? 'core, of its limit · the line is the core' : 'core · worker, of their limits · the line is the core' },
    rps: { text: rps === null ? '—' : rps < 10 ? rps.toFixed(1) : String(Math.round(rps)), sub: `to the clusters · last ${Math.round((requestLoad.windowSec || 300) / 60)} min` },
    busy: { text: busy === null ? '—' : String(busy.length), sub: busyLines.length ? J.truncate(busyLines[0], 40) + (busyLines.length > 1 ? ` +${busyLines.length - 1}` : '') : 'slow · pool · 429', title: busyLines.join('\n') || 'no cluster is holding background work back' },
  };
}

function healthCard(now) {
  const v = healthValues(now);
  const st = graph.state;
  const sig = JSON.stringify([v, st.range, st.histRange, st.hist && st.hist.at, st.histErr]);
  return built.get('g:health', sig, () => graph.healthCard(v));
}

function appHealthCard() {
  const st = graph.state;
  return built.get('g:apphealth', JSON.stringify([st.sys && st.sys.at, st.sysErr, st.range, st.histRange, st.hist && st.hist.at]), () => graph.appHealthCard());
}

function runsCard(now) {
  const st = graph.state;
  const open = J.openRuns(list).map((r) => `${r.id}:${r.status}`).join(',');
  const last = ((list && list.jobs) || []).map((j) => (j.state && j.state.lastRun ? j.state.lastRun.id : '')).join(',');
  const sig = [st.runsAt, st.runsErr, st.runRange, open, last, Math.floor(now / 60_000)].join('|');
  return built.get('g:runs', sig, () => graph.runsCard(list, nameOfCluster));
}

function clustersText(r) {
  const ids = Array.isArray(r.clusters) ? r.clusters : [];
  if (!ids.length) return { text: '—', title: '' };
  const names = ids.map(nameOfCluster);
  return { text: names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', '), title: names.join(', ') };
}

/**
 * The progress cell: a bar and the percent when the core gives one, "counting…" when it does
 * not (no bar at 0 %). The kept bar goes straight into the kept cell — wrapped in a fresh
 * element it would be pulled out of the page on every read.
 */
function progressCell(key, r) {
  const p = J.progressOf(r);
  const kids = p.pct !== null
    ? [bar(`${key}:bar`, p.pct, J.barTone(r.status)), h('span.jb-pct', p.text), p.detail ? h('span.muted.jb-of', p.detail) : null]
    : [h('span.muted', p.text), p.detail ? h('span.muted.jb-of', p.detail) : null];
  return td(key, kids.filter(Boolean), { cls: 'jb-prog', title: p.detail ? `${p.detail} done` : null });
}

/**
 * Now (the approved graphical view, 0.3.77): four tiles — Running, Queued, Slots in use (the
 * governor's), Last 24 hours (success rate of the runs kept) — then one row per open run (its
 * clusters, progress, how long it has run and, when the core counts it, about how long is left;
 * Stop, and for a queued run why it waits) and the "Just ran" chips: most runs end within a
 * second, far inside a read's interval, so the newest finished ones are shown here too.
 */
function nowCard(now) {
  const runs = J.openRuns(list);
  const admin = isAdmin();
  const c = J.runCounts(list);
  const gov = list && list.governor && typeof list.governor === 'object' ? list.governor : null;
  const g = J.governorText(gov);
  const rows = runs.map((r) => {
    const k = `run:${r.id}`;
    const job = jobById(r.jobId);
    const on = clustersText(r);
    const day = r.day ? ` · ${r.day}` : '';
    const req = job ? J.requestsText(job) : { text: '—', title: '' };
    const queued = r.status === 'queued' || r.status === 'pending';
    const stop = admin
      ? h('button.btn.sm.jb-stop', { type: 'button', disabled: !J.canCancel(r), title: r.cancelAsked ? 'asked to stop: it stops at its next safe point' : queued ? 'Cancel this queued run' : 'Stop this run at its next safe point', onclick: () => cancelRun(r.id) },
        r.cancelAsked ? 'Stopping…' : 'Stop')
      : null;
    const run = admin && queued && job && J.canRunNow(job) ? h('button.btn.sm', { type: 'button', onclick: () => runNow(job.id) }, 'Run now') : null;
    const why = queued ? `waits for a free slot${g ? ` · ${g.text}` : ''} · priority ${J.priorityText(job && job.priority)}` : null;
    return tr(k, [
      td(`${k}:job`, h('span.jb-name', h('b', job ? job.name : r.jobId), h('span.muted.jb-by', ` ${J.triggerText(r.trigger)}`),
        r.stale ? pill('stale', 'yellow', 'the worker\'s heartbeat is late: this run may have ended with the worker. It is not ended here.') : null,
        queued ? pill('queued', 'orange') : null)),
      td(`${k}:on`, `${on.text}${day}`, { cls: 'jb-on', title: on.title }),
      queued ? td(`${k}:prog`, why, { cls: 'muted.jb-why', title: why }) : progressCell(`${k}:prog`, r),
      td(`${k}:rec`, r.records === null || r.records === undefined ? '—' : fmtNum(r.records), { num: true }),
      td(`${k}:dur`, GR.elapsedText(r, now), { title: r.startedAt ? `started ${dt(r.startedAt)}` : (r.createdAt ? `asked for ${dt(r.createdAt)}` : null) }),
      td(`${k}:req`, req.text, { title: req.title }),
      admin ? td(`${k}:act`, h('span.jb-btns', run, stop), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { cls: r.stale ? 'jb-stale' : '', data: { run: r.id, status: r.status } });
  });
  const headers = ['Job', 'On', 'Progress', { label: 'Records', num: true }, 'Running', 'Requests', ...(admin ? [''] : [])];
  const body = runs.length ? keptTable(built, 'run', headers, rows)
    : built.same('run:none', h('div.jb-none.muted', 'Nothing running or queued right now.'));
  const every = Math.round(J.pollDelay(list, { jobsTab: true }) / 1000);
  return keptCard(built, 'run', 'Now', `read every ${every} s${runs.length ? ' while something runs' : ''}`, [nowTiles(c, gov, g), body, justRanChips(now)]);
}

/** A tile kept under `key`: label, value, a line under it and an optional bar, written in place. */
function tile(key, label, value, sub, { title = null, bar = null } = {}) {
  const el = built.get(`tile:${key}`, 'div', () => h('div.jg-tile.jg-now', { dataset: { tile: key } }, h('span.k'), h('b.v'), h('span.d')));
  const [k, v, d] = el.children;
  if (k.textContent !== label) k.textContent = label;
  if (v.textContent !== String(value)) v.textContent = String(value);
  if (d.textContent !== (sub || '')) d.textContent = sub || '';
  if ((el.getAttribute('title') || '') !== (title || '')) { if (title) el.setAttribute('title', title); else el.removeAttribute('title'); }
  // The bar: segments [share 0..100, colour], kept in place (its widths set, never rebuilt).
  let b = el.querySelector('.jg-bar');
  if (bar) {
    if (!b || b.children.length !== bar.length) { if (b) b.remove(); b = h('span.jg-bar', ...bar.map(() => h('i'))); el.append(b); }
    bar.forEach(([w, colour], i) => {
      const s = b.children[i].style;
      const ww = `${Math.max(0, Math.min(100, w))}%`;
      if (s.width !== ww) s.width = ww;
      if (s.background !== colour) s.background = colour;
    });
  } else if (b) b.remove();
  return el;
}

function nowTiles(c, gov, g) {
  const day = graph.day(list);
  const inUse = gov && Number.isFinite(gov.inUse) ? gov.inUse : null;
  const total = gov && Number.isFinite(gov.total) ? gov.total : null;
  const dayText = !day ? 'Loading…' : day.total ? `${day.ok} ok · ${day.warn} with warnings · ${day.bad} failed of ${day.total}${day.partial ? ' kept' : ''}` : 'no run ended in the last 24 hours';
  const box = built.get('tiles:now', 'div', () => h('div.jg-tiles.jg-now-tiles'));
  reconcile(box, [
    tile('running', 'Running', c.running, 'jobs working now'),
    tile('queued', 'Queued', c.queued, c.queued ? 'waiting for a slot' : 'nothing waiting'),
    tile('slots', 'Slots in use', inUse !== null && total !== null ? `${inUse} / ${total}` : '—',
      g ? `governor · ${g.auto || 'requests at Elasticsearch'}` : 'the governor is not reporting',
      { title: g ? ['the adaptive concurrency governor: requests the worker\'s jobs have at Elasticsearch', g.jobs, g.change, g.signals].filter(Boolean).join('\n')
        : 'no governor figures: role core without a worker heartbeat, or an older core — never a 0 it did not measure',
        bar: inUse !== null && total ? [[(inUse * 100) / total, 'var(--chart-info)']] : null }),
    tile('day', 'Last 24 hours', day && day.total ? GR.pctWord(day.pct) : '—', dayText, {
      title: day && day.partial ? `The run log keeps the newest ${GR.KEPT_PER_JOB} runs of a job: ${day.partialJobs.map(jobName).join(', ')} ran more often, so its older runs of the day are not counted.`
        : 'finished runs that ended in the last 24 hours: ok = completed; with warnings = deferred, skipped or cancelled; failed',
      bar: day && day.total ? [[(day.ok * 100) / day.total, 'var(--chart-good)'], [(day.warn * 100) / day.total, 'var(--chart-warn)'], [(day.bad * 100) / day.total, 'var(--chart-bad)']] : null }),
  ]);
  return box;
}

/** "Just ran": the newest finished runs (J.justRan) as chips — ✓ / ⚠ / ✗, the job, when, a short note. */
function justRanChips(now) {
  const runs = J.justRan(list, 6);
  if (!runs.length) return null;
  const chips = runs.map((r) => {
    const res = GR.resultOf(r) || 'warn';
    const why = r.error || r.note || '';
    const at = J.absoluteText(r.endedAt, { tz: tz(), now }).text;
    const rec = r.records !== null && r.records !== undefined ? ` · ${fmtNum(r.records)} records` : '';
    return built.same(`just:${r.id}`, h(`span.jg-chip.${res}`, { dataset: { just: r.id, status: r.status },
      title: `${jobName(r.jobId)} · ${J.statusWord(r.status)} · ${J.triggerText(r.trigger)}\nended ${dt(r.endedAt)} · took ${J.durationText(J.durationMs(r, now))}${rec}${why ? `\n${why}` : ''}` },
      h('b', GR.resultMark(res)), h('span.jg-chip-n', jobName(r.jobId)), h('span.muted', `${at}${why ? ` · ${J.truncate(why, 28)}` : ''}`)));
  });
  const box = built.get('just:box', 'div', () => h('div.jg-just', h('span.k', 'Just ran'), h('span.jg-chips')));
  reconcile(box.lastChild, chips);
  return box;
}

function upNextCard(now) {
  const admin = isAdmin();
  const rows = J.upNext(list, { now, tz: tz() }).map(({ job, next }) => {
    const k = `next:${job.id}`;
    const st = job.state || {};
    const acts = admin ? [
      J.canRunNow(job) ? h('button.btn.sm', { type: 'button', onclick: () => runNow(job.id) }, 'Run now') : null,
      J.canPause(job) ? h('button.btn.sm', { type: 'button', onclick: () => pauseJob(job.id, !st.paused) }, st.paused ? 'Resume' : 'Pause') : null,
    ].filter(Boolean) : [];
    return tr(k, [
      td(`${k}:job`, h('span.jb-name', h('b', job.name), J.isCreated(job) ? h('span.muted', ' · created') : null)),
      td(`${k}:at`, next.at !== null ? next.text : (st.paused ? 'paused' : 'off'), { title: next.at !== null ? `${dt(next.at)} · ${next.zone}` : next.note }),
      td(`${k}:in`, next.at !== null ? next.rel : J.truncate(next.note, 48), { cls: next.at !== null ? '' : 'muted', title: next.note || null }),
      td(`${k}:sched`, job.schedule || '—', { cls: 'muted.jb-sched', title: job.schedule || null }),
      admin ? td(`${k}:act`, h('span.jb-btns', ...acts), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { job: job.id } });
  });
  const zone = tz() ? `server time (${tz()})` : 'your time';
  const headers = ['Job', 'Next run', 'In', 'Schedule', ...(admin ? [''] : [])];
  const body = rows.length ? keptTable(built, 'next', headers, rows) : built.same('next:none', h('div.jb-none.muted', 'No scheduled job has a next run.'));
  return keptCard(built, 'next', 'Up next', `times in ${zone}`, body);
}

/** One row of All jobs: the job, its open run, its last run, and what the columns read. */
function jobRow(job, now) {
  const st = job.state || {};
  const cur = J.isOpen(st.current) ? st.current : null;
  const last = st.lastRun || null;
  return { job, cur, last, run: cur || last, status: J.jobStatus(job), next: J.nextRunOf(job, { now, tz: tz() }) };
}

function allColumns(now) {
  return {
    name: { type: 'text', value: (r) => r.job.name },
    type: { type: 'text', value: (r) => J.jobTypeText(r.job) },
    status: { type: 'text', value: (r) => J.statusWord(r.status) },
    ran: { type: 'date', value: (r) => (r.run ? r.run.startedAt : null), start: -1 },
    dur: { type: 'number', value: (r) => J.durationMs(r.run, now), start: -1 },
    next: { type: 'date', value: (r) => r.next.at },
    last: { type: 'text', value: (r) => (r.last ? D.resultOf(r.last).text : null) },
    priority: { type: 'number', value: (r) => J.priorityRank(r.job.priority) },
  };
}

/**
 * All jobs (the approved design, 0.3.81): the exact time the open run (else the last) started,
 * how long it took, the exact next run, and the last run's result — "Partial · 4 of 71
 * clusters" — so the row says what happened without opening it. ▸ opens the run's summary,
 * exceptions and log (JOB_RUN_DETAIL, read only then). It fits 1280 px with the menu on the
 * left: Priority and Requests one cell, Paused a chip in Status, Records and the trouble a line
 * under the row, only when there is one.
 */
const ALL_HEADERS = [
  { label: 'Name', sort: 'name' }, { label: 'Type', sort: 'type' }, { label: 'Status', sort: 'status' },
  { label: 'Last run', sort: 'ran', title: 'when the open run (else the last) started' },
  { label: 'Duration', sort: 'dur', num: true, title: 'how long it took, or has taken so far' },
  { label: 'Next run', sort: 'next' },
  { label: 'Result', sort: 'last', title: 'how the last run ended, and of how many clusters' },
  { label: 'Priority · requests', sort: 'priority', title: 'its priority · the requests it may use at once (what the governor gives it now, when it reports it)' },
];

/** The line under a row of All jobs: what the run processed, and the last run's trouble (a deferral amber, an error red). Null when neither. */
function subLineOf(run, last) {
  const rec = run && run.records !== null && run.records !== undefined ? `${fmtNum(run.records)} record${run.records === 1 ? '' : 's'}` : '';
  const trouble = D.troubleOf(last, nameOfCluster);
  if (!rec && !trouble) return null;
  return { rec, trouble };
}

function allJobsCard(now) {
  const admin = isAdmin();
  const rows = SORTS.all.apply((list.jobs || []).map((j) => jobRow(j, now)), allColumns(now));
  const n = ALL_HEADERS.length + (admin ? 1 : 0);
  const trs = [];
  for (const r of rows) {
    const { job, cur, last, run } = r;
    const k = `all:${job.id}`;
    const open = expanded.has(job.id);
    const p = cur ? J.progressOf(cur) : null;
    const req = J.requestsText(job);
    const st = job.state || {};
    const sub = subLineOf(run, last);
    const res = D.resultOf(last);
    const toggle = h('button.jb-x', {
      type: 'button', 'aria-expanded': String(open), title: open ? 'Hide the details' : 'Show the last run\'s summary, exceptions and log',
      onclick: () => toggleRow(job.id),
    }, open ? '▾' : '▸');
    // Paused while a run goes: the run's status, and a chip that says the timer is held.
    const pausedChip = st.paused && r.status !== 'paused' ? h('span.jb-chiplet', { title: `paused${st.pausedBy ? ` by ${st.pausedBy}` : ''}: its timer starts nothing; this run finishes` }, 'paused') : null;
    trs.push(tr(k, [
      td(`${k}:name`, h('span.jb-name', toggle, h('b', job.name), J.isCreated(job) ? h('span.muted.jb-cr', ' · created') : null), { cls: 'jb-nm', title: `${job.name} · ${job.id}` }),
      td(`${k}:type`, J.jobTypeText(job)),
      td(`${k}:status`, h('span.jb-st', pill(J.statusWord(r.status), J.statusTone(r.status), r.status === 'paused' && st.pausedBy ? `paused by ${st.pausedBy}` : null), pausedChip,
        p ? h('span.muted.jb-pct', p.text) : null)),
      td(`${k}:ran`, run && run.startedAt ? D.exactTime(run.startedAt, { tz: tz() }) : '—', { cls: run && run.startedAt ? 'mono' : 'muted',
        title: run && run.startedAt ? `${J.relativeText(run.startedAt, now)}${run.endedAt ? ` · ended ${D.exactTime(run.endedAt, { tz: tz() })}` : ' · still running'}` : null }),
      td(`${k}:dur`, run ? D.runDuration(run, now) : '—', { num: true, cls: run ? '' : 'muted' }),
      td(`${k}:next`, r.next.at !== null ? D.exactTime(r.next.at, { tz: tz(), seconds: false }) : '—', { cls: r.next.at !== null ? 'mono' : 'muted',
        title: r.next.at !== null ? `${r.next.rel} · ${r.next.zone}` : r.next.note }),
      td(`${k}:last`, last ? pill(res.text, res.tone, last.endedAt ? `ended ${D.exactTime(last.endedAt, { tz: tz() })}` : null) : dash(), { cls: 'jb-res' }),
      td(`${k}:req`, `${J.priorityText(job.priority)} · ${req.text}`, { title: req.title }),
      admin ? td(`${k}:act`, rowMenu(() => jobMenu(job.id), { title: `Actions for ${job.name}`, menuLabel: job.name }), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { cls: sub ? 'jb-has-sub' : '', data: { job: job.id, status: r.status } }));
    if (sub) {
      const t = sub.trouble;
      trs.push(tr(`${k}:sub`, [td(`${k}:sub:td`, [
        sub.rec ? h('span.jb-rec', sub.rec) : null,
        sub.rec && t ? h('span.muted', ' · ') : null,
        t ? h(t.level === 'warn' ? 'span.jb-warn' : 'span.jb-err', { title: t.title || t.text }, J.truncate(t.text, t.level === 'warn' ? 160 : 120)) : null,
      ].filter(Boolean), { colspan: n, cls: 'jb-subl' })], { cls: 'jb-sub', data: { sub: job.id } }));
    }
    if (open) trs.push(tr(`${k}:more`, [td(`${k}:more:td`, detailPanel(job, cur, last, now), { colspan: n, cls: 'jb-more' })], { cls: 'jb-detail', data: { detail: job.id } }));
  }
  const headers = [...ALL_HEADERS, ...(admin ? [''] : [])];
  return keptCard(built, 'all', 'All jobs', `${(list.jobs || []).length} jobs · times in ${tz() ? `server time (${tz()})` : 'your time'} · ▸ opens a job's last run`,
    keptTable(built, 'all', headers, trs, { sort: SORTS.all }));
}

/* ------------------------- a job opened: its run's details (JOB_RUN_DETAIL) ------------------------- */

/** Open rows: which tab, which run (null: the last), and the job's run history once asked for. */
const rowState = new Map();
/** Runs' details as read: runId → { res, error, loading }. Read once, when a row opens on it. */
const details = new Map();

function toggleRow(jobId) {
  if (expanded.has(jobId)) { expanded.delete(jobId); rowState.delete(jobId); }
  else { expanded.add(jobId); rowState.set(jobId, { tab: 'summary', runId: null, hist: null, histLoading: false, showAll: false }); }
  draw();
}

/** The run a row shows: the one picked in its Run history, else the job's last. */
function rowRun(jobId, last) {
  const s = rowState.get(jobId);
  const picked = s && s.runId && s.hist && Array.isArray(s.hist.runs) ? s.hist.runs.find((x) => x.id === s.runId) : null;
  return picked || last;
}

async function loadDetail(run) {
  const runId = run && run.id;
  if (!runId) return;
  const had = details.get(runId);
  // Read once — but a refusal is asked again at the next refresh, and "no details" for a run
  // that ended under a minute ago may only mean they were still being written.
  if (had && !D.detailAgain(had, run, Date.now())) return;
  details.set(runId, { res: null, error: null, loading: true, at: Date.now() });
  const res = await jobRunDetail(runId);
  details.set(runId, res && res.ok ? { res, error: null, loading: false, at: Date.now() }
    : { res: null, error: J.refusalText(res) || 'the core did not answer', loading: false, at: Date.now(), unsupported: !!(res && (res.kind === 'bad_message' || res.kind === 'unknown_message')) });
  if (host) draw();
}

async function loadRowHistory(jobId) {
  const s = rowState.get(jobId);
  if (!s || s.histLoading) return;
  s.histLoading = true;
  const res = await jobsList({ jobId, limit: 15 });
  s.histLoading = false;
  s.hist = res && res.ok ? res : { error: J.refusalText(res) || 'the core did not answer', runs: [] };
  if (host) draw();
}

function setRowTab(jobId, tab) {
  const s = rowState.get(jobId);
  if (!s) return;
  s.tab = tab;
  if (tab === 'history' && !s.hist) loadRowHistory(jobId);
  draw();
}

/** The expanded row: Summary · Exceptions (n) · All clusters (n) · Log · Run history. */
function detailPanel(job, cur, last, now) {
  const s = rowState.get(job.id) || { tab: 'summary' };
  const run = rowRun(job.id, last);
  const done = run && !J.isOpen(run);
  if (done) loadDetail(run);
  const d = done ? details.get(run.id) : null;
  const sig = JSON.stringify([s.tab, s.showAll, run && run.id, run && run.status, run && run.endedAt, d && [!!d.res, d.error, d.loading],
    s.hist ? (s.hist.runs || []).map((x) => x.id).join(',') : null, s.histLoading, cur && cur.id, job.state && job.state.nextRunAt,
    s.tab === 'summary' && cur ? Math.floor(now / 5000) : 0]);
  return built.get(`det:${job.id}`, sig, () => buildPanel(job, cur, run, d, s, now));
}

function buildPanel(job, cur, run, d, s, now) {
  const detail = d && d.res ? d.res.detail : null;
  const tabs = D.detailTabs(detail).map((t) => h('button', {
    type: 'button', dataset: { dtab: t.id }, 'aria-pressed': String(s.tab === t.id), onclick: () => setRowTab(job.id, t.id),
  }, t.label));
  // Why there are no details to show, when there are none (yet).
  const why = !run || J.isOpen(run) ? null
    : !d || d.loading ? 'Reading the run\'s details…'
      : d.error ? (d.unsupported ? 'This server keeps no run details yet: JOB_RUN_DETAIL needs ElasticPro 0.3.81.' : `The run's details could not be read: ${d.error}`)
        : (d.res && !d.res.detail ? d.res.why : null);
  let body;
  if (s.tab === 'history') body = historyPane(job, run);
  else if (!run) body = h('div.jb-dnote.muted', 'This job has not run here yet.');
  // The summary says what the run record says, whatever became of its details.
  else if (s.tab === 'summary') body = summaryPane(job, cur, run, detail, now, why);
  else if (J.isOpen(run)) body = h('div.jb-dnote.muted', 'The run is still going: its parts and log are kept when it ends.');
  else if (!detail) body = h('div.jb-dnote', h(d && d.error ? 'span.jb-err' : 'span.muted', why || 'This run kept no details.'));
  else if (s.tab === 'exceptions') body = partsPane(job, D.exceptionsOf(detail), detail, { exceptions: true });
  else if (s.tab === 'clusters') body = partsPane(job, (detail && detail.parts) || [], detail, { exceptions: false });
  else body = logPane(run, detail);
  return h('div.jb-exp', { dataset: { run: run ? run.id : '' } }, h('div.jb-dtabs', { role: 'group', 'aria-label': 'Run details' }, ...tabs), body);
}

function summaryPane(job, cur, run, detail, now, why = null) {
  const st = job.state || {};
  const line = (k, v) => (v === null || v === undefined || v === '' ? null : h('div.jb-kv', h('span.k', k), h('span.v', String(v))));
  const cells = D.summaryCells(run, detail, { tz: tz(), now });
  return h('div.jb-sum',
    h('div.jb-h', 'Run summary'),
    h('div.jb-grid', ...cells.map(([k, v, tone]) => h('div', h('small', k), h(`b${tone ? `.t-${tone}` : ''}`, v)))),
    why ? h('div.jb-dnote.muted', why) : null,
    h('div.jb-details',
      line('Schedule', job.schedule),
      line('Next run', st.nextRunAt ? `${D.exactTime(st.nextRunAt, { tz: tz(), seconds: false })} (${J.relativeText(st.nextRunAt, now)})` : st.nextRunNote),
      st.paused ? line('Paused', `by ${st.pausedBy || 'an administrator'}${st.pausedAt ? ` · ${dt(st.pausedAt)}` : ''}`) : null,
      cur && cur.id !== run.id ? line('Open run', `${J.statusWord(cur.status)} · run ${cur.id} · since ${D.exactTime(cur.startedAt, { tz: tz() })}`) : null,
      run.retryOf ? line('Retry of', `run ${run.retryOf}${run.attempt ? ` · try ${run.attempt}` : ''}`) : null,
      run.error ? line(run.status === 'deferred' ? 'Waited' : 'Error', run.error) : null,
      run.note ? line('Note', run.note) : null,
      run.deferred ? line('Waited for', J.busyText(run.deferred, nameOfCluster, now)) : null,
      run.clusters && run.clusters.length ? line('Clusters', run.clusters.map(nameOfCluster).join(', ')) : null,
      line('Runs in', job.owner), line('Job id', job.id)));
}

/** A part's Action: the page that has the setting, when the core names one the caller may open. */
function todoLink(p) {
  const t = p.todo;
  if (!t) return dash();
  if (!D.TODO_PAGES.includes(t.page) || !canOpenPage(t.page)) return h('span.muted', { title: t.text }, t.label);
  return h('a', { href: '#', title: t.text, onclick: (e) => { e.preventDefault(); navigateTo(t.page, null, { cluster: p.cluster }); } }, t.label);
}

function partsPane(job, parts, detail, { exceptions }) {
  const c = (detail && detail.counts) || {};
  const head = exceptions ? `Exceptions — clusters not fully ${job.id === 'logdelay.measure' ? 'measured' : 'done'}` : 'All clusters';
  const rows = parts.map((p) => h(`tr${p.status === 'deferred' ? '.jb-defer' : ''}`, { dataset: { part: p.cluster, status: p.status } },
    h('td', h('b', nameOfCluster(p.cluster))),
    h('td', pill(D.partWord(p.status), D.partTone(p.status))),
    h('td.jb-perr', p.code ? h('span.jb-code', p.code) : (p.status === 'succeeded' ? dash() : null),
      p.message ? h('div.sub', { title: p.message }, p.message) : null),
    h('td.num', p.records === null || p.records === undefined ? '—' : fmtNum(p.records)),
    h('td.num', D.elapsedText(p.elapsedMs)),
    h('td', p.retry || '—'),
    h('td', todoLink(p))));
  const okN = Number(c.succeeded) || 0;
  const allN = ['succeeded', 'partial', 'failed', 'deferred', 'skipped'].reduce((n, k) => n + (Number(c[k]) || 0), 0);
  const notListed = Number(detail && detail.partsNotListed) || 0;
  const foot = exceptions
    ? h('div.jb-dnote.muted', `${fmtNum(okN)} cluster${okN === 1 ? '' : 's'} succeeded · `,
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); setRowTab(job.id, 'clusters'); } }, `View all ${fmtNum(allN)}`))
    : (notListed ? h('div.jb-dnote.muted', `${fmtNum(notListed)} more succeeded — counted, not listed (a run keeps up to 300 by name)`) : null);
  const narrowed = detail && detail.narrowed ? h('div.jb-dnote.muted', 'Only the clusters you can see are listed, and counted.') : null;
  const tbl = parts.length
    ? h('div.jb-scroll', h('table.tbl.jb-inner', h('thead', h('tr', ...['Cluster', 'Result', 'Error', 'Records', 'Elapsed', 'Retry', 'Action'].map((x, i) => h(`th${[3, 4].includes(i) ? '.num' : ''}`, x)))), h('tbody', ...rows)))
    : h('div.jb-dnote.muted', exceptions ? 'Every cluster of this run succeeded.' : 'This run reported no clusters.');
  return h('div.jb-parts', h('div.jb-h', head), tbl, foot, narrowed);
}

function logPane(run, detail) {
  const lines = (detail && detail.lines) || [];
  const text = D.logText(detail, { tz: tz(), runId: run.id });
  const copy = async (e) => {
    e.preventDefault();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('this window has no clipboard access');
      await navigator.clipboard.writeText(text); toast('Log copied', 'ok', 1600);
    } catch (err) { toast(`Not copied: ${err && err.message ? err.message : err}`, 'err', 3000); }
  };
  const save = (e) => { e.preventDefault(); download(D.logFileName(run.id), text); };
  const body = lines.length
    ? h('pre.jb-log', ...lines.map((l) => h('div', h('span.m', D.logStamp(l.at, tz())), ' ',
      h(`span${l.level === 'ERROR' ? '.e' : l.level === 'WARN' ? '.w' : ''}`, `${String(l.level || '').padEnd(5)}  ${l.text}`))))
    : h('div.jb-dnote.muted', detail && detail.linesNote ? detail.linesNote : 'This run wrote no lines of its own.');
  return h('div.jb-logp',
    h('div.jb-h', `Log — run ${run.id} `, h('span.jb-hn', '· kept as long as the run · ',
      h('a', { href: '#', dataset: { act: 'copy' }, onclick: copy }, 'Copy'), ' · ',
      h('a', { href: '#', dataset: { act: 'download' }, onclick: save }, 'Download .txt'))),
    detail && detail.linesDropped ? h('div.jb-dnote.muted', `${fmtNum(detail.linesDropped)} lines between the first ${D.LOG_HEAD} and the last ${D.LOG_TAIL} were not kept.`) : null,
    body);
}

function historyPane(job, shown) {
  const s = rowState.get(job.id);
  if (!s || !s.hist) return h('div.jb-dnote.muted', 'Reading the job\'s runs…');
  if (s.hist.error) return h('div.jb-dnote', h('span.jb-err', `The runs could not be read: ${s.hist.error}`));
  const runs = (s.hist.runs || []).filter((r) => r.jobId === job.id);
  if (!runs.length) return h('div.jb-dnote.muted', 'No run of this job is kept.');
  const now = Date.now();
  return h('div.jb-scroll', h('table.tbl.jb-inner',
    h('thead', h('tr', ...['Started', 'Duration', 'Result', 'Trigger', ''].map((x) => h('th', x)))),
    h('tbody', ...runs.map((r) => {
      const res = D.resultOf(r);
      const pick = !J.isOpen(r) ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); s.runId = r.id; s.tab = 'summary'; draw(); } }, shown && shown.id === r.id ? 'shown' : 'Open') : h('span.muted', 'running');
      return h(`tr${shown && shown.id === r.id ? '.jb-focus' : ''}`, { dataset: { hrun: r.id } },
        h('td.mono', D.exactTime(r.startedAt || r.createdAt, { tz: tz() })), h('td.num', D.runDuration(r, now)),
        h('td', pill(res.text, res.tone)), h('td', J.triggerText(r.trigger)), h('td', pick));
    }))));
}

/* ------------------------------- Slow searches now (SLOW_SEARCHES) ------------------------------- */

/** The card's state: the threshold, the last answer, and whether all rows are shown. */
const slow = { minMs: D.SLOW_DEFAULT_MS, res: null, error: null, at: 0, loading: false, showAll: false, unsupported: false };

/** Ask for the slow searches — at most every 30 s, and only while the Jobs tab is open. */
async function loadSlow({ now = false } = {}) {
  if (slow.loading || slow.unsupported) return;
  if (!now && Date.now() - slow.at < D.SLOW_POLL_MS) return;
  slow.loading = true; slow.at = Date.now();
  const res = await slowSearches(slow.minMs);
  slow.loading = false;
  if (res && res.ok) {
    slow.res = res; slow.error = null;
    // Clusters still being read when the core answered: ask again in 5 s, not 30.
    if (Array.isArray(res.reading) && res.reading.length) slow.at = Date.now() - D.SLOW_POLL_MS + D.SLOW_RETRY_MS;
  } else if (res && (res.kind === 'bad_message' || res.kind === 'unknown_message')) slow.unsupported = true;
  else slow.error = J.refusalText(res) || 'the core did not answer';
  if (host && tab === 'jobs') draw();
}

function setSlowMin(ms) {
  if (slow.minMs === ms) return;
  slow.minMs = ms; slow.showAll = false;
  draw();
  loadSlow({ now: true });
}

function openSearch(sx) {
  const text = D.searchText(sx, nameOfCluster);
  const who = D.whoRan(sx);
  modal('Search running', `${sx.name || nameOfCluster(sx.cluster)} · ${D.runningText(sx.runningMs)} · task ${sx.taskId}`, [
    h('div.jb-kvs',
      h('div.jb-kv', h('span.k', 'Node'), h('span.v', sx.node || '—')),
      h('div.jb-kv', h('span.k', 'Index'), h('span.v.mono', sx.indices || 'not said')),
      h('div.jb-kv', h('span.k', 'Task id'), h('span.v.mono', sx.taskId)),
      h('div.jb-kv', h('span.k', 'X-Opaque-Id'), h('span.v.mono', sx.opaqueId || 'not set'), who === 'ElasticPro' ? h('span.jb-chiplet', 'ElasticPro') : null)),
    h('pre.jb-q-full', sx.query || sx.description || 'The cluster did not say the query.'),
  ], (ctx) => [
    h('button.btn', { type: 'button', onclick: async () => {
      try {
        if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('this window has no clipboard access');
        await navigator.clipboard.writeText(text); toast('Copied', 'ok', 1600);
      } catch (e) { ctx.msg(`Not copied: ${e && e.message ? e.message : e}`); }
    } }, 'Copy'),
    h('button.btn.primary', { type: 'button', onclick: () => ctx.done(null) }, 'Close'),
  ], { width: '760px', cls: 'jb-search-dlg' });
}

function slowCard() {
  if (slow.unsupported) return null;
  if (!slow.res && !slow.error && !slow.loading) loadSlow({ now: true });
  const r = slow.res;
  const sig = JSON.stringify([slow.minMs, slow.showAll, slow.error, r && r.at, r && r.minMs, !!r]);
  return built.get('slow:card', sig, () => {
    const seg = h('span.seg.jb-seg', { role: 'group', 'aria-label': 'Running longer than' }, ...D.SLOW_THRESHOLDS.map(([ms, label]) =>
      h('button.btn.sm', { type: 'button', dataset: { min: String(ms) }, 'aria-pressed': String(slow.minMs === ms), onclick: () => setSlowMin(ms) }, label)));
    const label = (D.SLOW_THRESHOLDS.find(([ms]) => ms === slow.minMs) || [0, '30 s'])[1];
    const sub = `searches running longer than ${label} on the clusters you see · read every 30 s while this page is open · read only`;
    let body;
    if (slow.error) body = [h('div.jb-dnote', h('span.jb-err', `The slow searches could not be read: ${slow.error}`))];
    else if (!r) body = [h('div.jb-dnote.muted', 'Reading the clusters\' tasks…')];
    else {
      // A higher threshold than the answer's is applied here at once; a lower one waits for the next answer.
      const all = r.searches || [];
      const list = all.filter((x) => (Number(x.runningMs) || 0) >= slow.minMs);
      const tiles = D.slowTiles({ ...r, searches: list, count: list.length === all.length ? r.count : list.length }, nameOfCluster);
      const shown = slow.showAll ? list : list.slice(0, D.SLOW_ROWS);
      const rows = shown.map((sx) => {
        const tone = D.runningTone(sx.runningMs);
        return h('tr', { dataset: { task: sx.taskId, cluster: sx.cluster } },
          h('td', h('b', sx.name || nameOfCluster(sx.cluster)), sx.by === 'ElasticPro' ? h('span.jb-chiplet', { title: 'one of ElasticPro\'s own searches' }, 'ElasticPro') : null),
          h('td.num', h(`b${tone ? `.t-${tone}` : ''}`, D.runningText(sx.runningMs))),
          h('td', sx.node || '—'),
          h('td.mono.jb-idx', { title: sx.indices || '' }, sx.indices || '—'),
          h('td.jb-qc', h('div.jb-q', { title: 'Open shows all of it' }, sx.query || sx.description || 'not said')),
          h('td', h('button.btn.sm', { type: 'button', onclick: () => openSearch(sx) }, 'Open')));
      });
      const more = list.length > shown.length
        ? h('tr', h('td.muted', { colspan: 6 }, `${list.length - shown.length} more · `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); slow.showAll = true; draw(); } }, `Show all ${list.length}`)))
        : null;
      const notRead = (r.notRead || []);
      const reading = (r.reading || []);
      body = [
        h('div.jg-tiles.jb-slow-tiles',
          h('div.jg-tile', { dataset: { tile: 'slow-count' } }, h('span.k', 'Running long'), h('b.v', tiles.count.value), h('span.d', tiles.count.sub)),
          h('div.jg-tile', { dataset: { tile: 'slow-longest' } }, h('span.k', 'Longest'), h(`b.v${tiles.longest.tone ? `.t-${tiles.longest.tone}` : ''}`, tiles.longest.value), h('span.d', tiles.longest.sub)),
          h('div.jg-tile', { dataset: { tile: 'slow-cluster' } }, h('span.k', 'Cluster slowest now'), h('b.v', tiles.slowest.value), h('span.d', tiles.slowest.sub))),
        list.length
          ? h('div.jb-scroll', h('table.tbl.jb-slow', h('thead', h('tr', ...['Cluster', 'Running', 'Node', 'Index', 'Query', ''].map((x, i) => h(`th${i === 1 ? '.num' : ''}`, x)))), h('tbody', ...rows, more)))
          : h('div.jb-none.muted', `No search has run longer than ${label} on the ${r.clustersRead} cluster${r.clustersRead === 1 ? '' : 's'} read.`),
        notRead.length ? h('div.jb-dnote.jb-notread', { title: notRead.map((x) => `${x.name || nameOfCluster(x.cluster)}: ${x.why}`).join('\n') },
          `${notRead.length} cluster${notRead.length === 1 ? '' : 's'} not read — `, notRead.slice(0, 3).map((x) => `${x.name || nameOfCluster(x.cluster)} (${x.why.replace(/^not read: /, '')})`).join(', '),
          notRead.length > 3 ? ` +${notRead.length - 3}` : '', ': unknown, not "none"') : null,
        reading.length ? h('div.jb-dnote.muted.jb-reading', { title: reading.map((x) => x.name || nameOfCluster(x.cluster)).join(', ') },
          `${reading.length} cluster${reading.length === 1 ? '' : 's'} still being read… — shown at the next read`) : null,
      ];
    }
    return h('section.card.jb-slowcard', { dataset: { card: 'slow' } },
      h('header', h('h2', 'Slow searches now'), h('span.sub', sub), h('div.card-acts', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } }, seg)),
      h('div.body', ...body));
  });
}

function jobMenu(id) {
  const job = jobById(id);
  if (!job) return [{ hint: 'This job is no longer listed.' }];
  const st = job.state || {};
  const cur = J.isOpen(st.current) ? st.current : null;
  const last = st.lastRun || null;
  return [
    { label: 'Run now', icon: '▶', disabled: !J.canRunNow(job), title: J.canRunNow(job) ? '' : (job.id === 'report.run' ? 'A report run names its clusters and dates: Create job › Run once' : 'It runs every minute by itself'), onClick: () => runNow(id) },
    J.canPause(job) ? { label: st.paused ? 'Resume' : 'Pause', icon: st.paused ? '⏵' : '⏸', onClick: () => pauseJob(id, !st.paused) } : null,
    { label: 'Stop the open run', icon: '■', disabled: !J.canCancel(cur), title: cur ? '' : 'Nothing of this job is running', onClick: () => cur && cancelRun(cur.id) },
    { label: 'Retry the last run', icon: '↻', disabled: !J.canRetry(last), title: J.canRetry(last) ? '' : 'Only a failed, deferred or cancelled run is tried again', onClick: () => last && retryRun(last.id) },
    { label: 'Settings', icon: '⚙', onClick: () => openTab('settings', { job: id }) },
    J.isCreated(job) ? { sep: true } : null,
    J.isCreated(job) ? { label: 'Delete this schedule', icon: '✕', danger: true, onClick: () => deleteJob(id) } : null,
  ];
}

function createdCard(now) {
  const created = (list.jobs || []).filter(J.isCreated);
  if (!created.length) return null;
  const admin = isAdmin();
  const rows = created.map((job) => {
    const k = `cr:${job.id}`;
    const c = job.created || {};
    const next = J.nextRunOf(job, { now, tz: tz() });
    const cl = c.clusters === 'all' || !c.clusters ? 'All clusters' : clustersText({ clusters: c.clusters }).text;
    const to = Array.isArray(c.to) ? c.to : null;
    return tr(k, [
      td(`${k}:name`, h('b', job.name), { cls: 'jb-cname', title: job.name }),
      td(`${k}:rep`, job.report || '—'),
      td(`${k}:cl`, cl),
      td(`${k}:when`, `${c.cadence || '—'}${c.at ? `, ${c.at}` : ''}`),
      td(`${k}:to`, to ? (to.length ? `${to[0]}${to.length > 1 ? ` +${to.length - 1}` : ''}` : 'nobody') : '—', { cls: 'jb-to', title: to ? to.join(', ') : 'recipients are an administrator\'s to read' }),
      td(`${k}:next`, next.at !== null ? next.rel : J.truncate(next.note, 36), { title: next.at !== null ? `${next.text} · ${next.zone}` : next.note }),
      admin ? td(`${k}:act`, h('button.btn.sm.danger', { type: 'button', onclick: () => deleteJob(job.id) }, 'Delete'), { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { job: job.id } });
  });
  return keptCard(built, 'cr', 'Created schedules', 'made with Create job; each is a job of its own',
    keptTable(built, 'cr', ['Name', 'Report', 'Clusters', 'When', 'To', 'Next send', ...(admin ? [''] : [])], rows));
}

/* ------------------------------------- History tab ------------------------------------- */

async function loadHistory({ quiet = false } = {}) {
  if (hist.loading) return;
  hist.loading = true;
  if (!quiet && host) draw();
  const res = await jobsList({ limit: 50, ...(hist.before ? { before: hist.before } : {}), ...(hist.jobId ? { jobId: hist.jobId } : {}) });
  hist.loading = false;
  if (res && res.ok) { hist.answer = res; hist.error = null; }
  else hist.error = J.refusalText(res) || 'the core did not answer';
  if (!quiet && host) draw();
}

function historyKids(now) {
  const admin = isAdmin();
  const jobs = (list && list.jobs) || [];
  const jobSel = h('select#jb-h-job', {
    'aria-label': 'Job',
    onchange: (e) => { hist.jobId = e.target.value; hist.before = null; hist.stack = []; loadHistory(); },
  }, h('option', { value: '' }, 'Every job'), ...jobs.map((j) => h('option', { value: j.id }, j.name)));
  jobSel.value = hist.jobId;
  const resSel = h('select#jb-h-result', { 'aria-label': 'Result', onchange: (e) => { hist.result = e.target.value; draw(); } },
    h('option', { value: '' }, 'Every result'), ...J.RESULTS.map((s) => h('option', { value: s }, J.statusWord(s))));
  resSel.value = hist.result;
  const a = hist.answer;
  const pageNo = hist.stack.length + 1;
  const bar = h('div.toolbar.jb-hbar',
    h('label.field', 'Job', jobSel), h('label.field', 'Result', resSel),
    h('div.jb-pager',
      h('button#jb-h-newer.btn.sm', { type: 'button', disabled: !hist.stack.length || hist.loading, onclick: () => { hist.before = hist.stack.pop() || null; loadHistory(); } }, '‹ Newer'),
      h('span.muted', `page ${pageNo}`),
      h('button#jb-h-older.btn.sm', { type: 'button', disabled: !(a && a.next) || hist.loading, onclick: () => { hist.stack.push(hist.before); hist.before = a.next; loadHistory(); } }, 'Older ›')),
    h('span.muted.jb-hnote', hist.result ? 'the result filter is applied to this page of 50' : 'every run, newest first, 50 a page'));
  const out = [built.same('hbar', bar)];
  if (hist.error) out.push(built.same('herr', h('div.banner.err', `The runs could not be read: ${hist.error}`)));
  if (!a) { out.push(built.same('hload', h('div.tbl-empty', 'Reading the runs…'))); return out; }
  const runs = J.filterRuns(a.runs, hist.result);
  const cols = {
    job: { type: 'text', value: (r) => jobName(r.jobId) },
    result: { type: 'text', value: (r) => J.statusWord(r.status) },
    by: { type: 'text', value: (r) => J.triggerText(r.trigger) },
    started: { type: 'date', value: (r) => r.startedAt ?? null, start: -1 },
    ended: { type: 'date', value: (r) => r.endedAt ?? null, start: -1 },
    duration: { type: 'duration', value: (r) => J.durationMs(r, now), start: -1 },
    progress: { type: 'percent', value: (r) => J.progressOf(r).pct, start: -1 },
    records: { type: 'number', value: (r) => r.records ?? null, start: -1 },
    clusters: { type: 'text', value: (r) => clustersText(r).title || null },
    error: { type: 'text', value: (r) => r.error || r.note || null },
  };
  const rows = SORTS.history.apply(runs, cols).map((r) => {
    const k = `h:${r.id}`;
    const cl = clustersText(r);
    const why = r.error || r.note || '';
    const p = J.progressOf(r);
    return tr(k, [
      td(`${k}:job`, h('b', jobName(r.jobId)), { title: r.id }),
      td(`${k}:res`, h('span', pill(J.statusWord(r.status), J.statusTone(r.status)), r.stale ? pill('stale', 'yellow', 'the worker\'s heartbeat is late') : null)),
      td(`${k}:by`, J.triggerText(r.trigger), { title: r.retryOf ? `retry ${r.attempt || ''} of ${r.retryOf}` : null }),
      td(`${k}:start`, r.startedAt ? dt(r.startedAt) : '—'),
      td(`${k}:end`, r.endedAt ? dt(r.endedAt) : '—'),
      td(`${k}:dur`, J.durationText(J.durationMs(r, now)), { num: true }),
      td(`${k}:prog`, p.text, { num: true, cls: p.pct === null ? 'muted' : '', title: p.detail || null }),
      td(`${k}:rec`, r.records === null || r.records === undefined ? '—' : fmtNum(r.records), { num: true }),
      td(`${k}:cl`, cl.text, { title: cl.title || null }),
      td(`${k}:why`, why ? J.truncate(why, 48) : '—', { cls: r.error ? 'jb-err' : 'muted', title: why || null }),
      admin ? td(`${k}:act`, J.canRetry(r) ? h('button.btn.sm', { type: 'button', onclick: () => retryRun(r.id) }, 'Retry') : null, { cls: 'jb-acts' }) : null,
    ].filter(Boolean), { data: { run: r.id, status: r.status } });
  });
  const headers = [{ label: 'Job', sort: 'job' }, { label: 'Result', sort: 'result' }, { label: 'By', sort: 'by' }, { label: 'Started', sort: 'started' },
    { label: 'Ended', sort: 'ended' }, { label: 'Duration', sort: 'duration', num: true }, { label: 'Progress', sort: 'progress', num: true },
    { label: 'Records', sort: 'records', num: true }, { label: 'Clusters', sort: 'clusters' }, { label: 'Error or note', sort: 'error' }, ...(admin ? [''] : [])];
  out.push(keptCard(built, 'hist', 'History', `${runs.length} of ${(a.runs || []).length} runs on this page${hist.jobId ? ` · ${jobName(hist.jobId)}` : ''}`,
    keptTable(built, 'hist', headers, rows, { sort: SORTS.history, emptyText: hist.result ? 'No run on this page has that result.' : 'No runs yet.' })));
  return out;
}

/* ------------------------------------- Settings tab ------------------------------------- */

async function loadSettings({ again = false } = {}) {
  if (!isAdmin() || sett.loading || (sett.res && !again)) return;
  sett.loading = true;
  const res = await jobControl('JOB_SETTINGS_GET');
  sett.loading = false;
  if (res && res.ok) { sett.res = res; sett.error = null; sett.draft = draftOf(res); }
  else sett.error = J.refusalText(res) || 'the core did not answer';
  if (host) draw();
}

function draftOf(res) {
  const overall = { ...(res.overall || {}) };
  const jobs = {};
  for (const j of res.jobs || []) jobs[j.jobId] = { enabled: !!j.enabled, auto: !!j.auto, min: (j.requests || {}).min, max: (j.requests || {}).max, priority: j.priority };
  return { overall, jobs };
}

function settingsKids() {
  if (!isAdmin()) return readOnlySettings();
  if (sett.error) return [built.same('serr', h('div.banner.err', `The settings could not be read: ${sett.error}`))];
  if (!sett.res || !sett.draft) return [built.same('sload', h('div.tbl-empty', 'Reading the settings…'))];
  const locked = J.lockedSettings(sett.res);
  const d = sett.draft;
  const lockNote = (key) => (locked.has(key) ? h('span.rm-managed.muted', MANAGED_NOTE) : null);
  const numIn = (id, value, lo, hi, oninput, key) => h('input.jb-num', {
    id, type: 'number', min: String(lo), max: String(hi), step: '1', value: value === undefined || value === null ? '' : String(value),
    disabled: locked.has(key), title: locked.has(key) ? MANAGED_NOTE : null, oninput,
  });
  const overallFields = J.OVERALL_FIELDS.map(([key, label, lo, hi, unit]) => h('label.field.jb-ofield', label,
    h('span.jb-in', numIn(`jb-s-${key}`, d.overall[key], lo, hi, (e) => { d.overall[key] = e.target.value; syncSave(); }, key), unit ? h('span.muted', unit) : null),
    lockNote(key)));
  const gov = list && list.governor;
  const autoField = typeof (sett.res.overall || {}).auto === 'boolean'
    ? h('label.jb-check', h('input#jb-s-auto', { type: 'checkbox', checked: !!d.overall.auto, disabled: locked.has('auto'), onchange: (e) => { d.overall.auto = e.target.checked; syncSave(); } }),
      h('span', 'Automatic optimisation (the adaptive governor moves each job\'s requests)'), lockNote('auto'))
    : h('div.muted.jb-auto-note', 'Automatic optimisation is switched per job below (the Auto column)',
      gov && typeof gov.auto === 'boolean' ? ` · the governor is ${gov.auto ? 'on' : 'off'} now` : '', '.');
  const overall = h('div.jb-overall', autoField, h('div.jb-ofields', ...overallFields));
  const changes = J.settingsChanges(sett.res, d).length;
  const acts = h('div.jb-save',
    h('button#jb-s-save.btn.sm.primary', { type: 'button', disabled: !changes || sett.saving, onclick: saveSettings }, sett.saving ? 'Saving…' : 'Save'),
    h('button#jb-s-discard.btn.sm', { type: 'button', disabled: !changes || sett.saving, onclick: () => { sett.draft = draftOf(sett.res); draw(); } }, 'Discard'),
    h('span#jb-s-count.muted', changes ? `${changes} change${changes === 1 ? '' : 's'} not saved` : 'no changes'),
    sett.res.setBy ? h('span.muted', ` · last saved by ${sett.res.setBy}${sett.res.setAt ? ` ${dt(sett.res.setAt)}` : ''}`) : null);
  const rows = (sett.res.jobs || []).map((j) => {
    const k = `s:${j.jobId}`;
    const dj = d.jobs[j.jobId] || {};
    const job = jobById(j.jobId);
    const manual = job ? job.kind === 'manual' : false;
    const lk = (f) => locked.has(`${j.jobId}.${f}`);
    const prio = h('select', { id: `jb-s-${j.jobId}-priority`, 'aria-label': `Priority of ${job ? job.name : j.jobId}`, disabled: lk('priority'), onchange: (e) => { dj.priority = e.target.value; syncSave(); } },
      ...['high', 'medium', 'low'].map((p) => h('option', { value: p }, J.priorityText(p))));
    prio.value = dj.priority;
    const box = (f, label, dis) => h('input', { type: 'checkbox', id: `jb-s-${j.jobId}-${f}`, 'aria-label': label, checked: !!dj[f], disabled: dis || lk(f), onchange: (e) => { dj[f] = e.target.checked; syncSave(); } });
    return tr(k, [
      td(`${k}:name`, h('b', job ? job.name : j.jobId), { title: j.jobId }),
      td(`${k}:en`, box('enabled', 'Automatic runs', manual), { title: manual ? 'a manual job has no automatic runs' : 'automatic runs on or off' }),
      td(`${k}:auto`, box('auto', 'Auto')),
      td(`${k}:min`, numIn(`jb-s-${j.jobId}-min`, dj.min, 1, J.REQUESTS_CEILING, (e) => { dj.min = e.target.value; syncSave(); }, `${j.jobId}.requests`)),
      td(`${k}:max`, numIn(`jb-s-${j.jobId}-max`, dj.max, 1, J.REQUESTS_CEILING, (e) => { dj.max = e.target.value; syncSave(); }, `${j.jobId}.requests`)),
      td(`${k}:prio`, prio),
      td(`${k}:def`, `${(j.defaults && j.defaults.requests) ? `${j.defaults.requests.min}–${j.defaults.requests.max}` : '—'} · ${J.priorityText(j.defaults && j.defaults.priority)}`, { cls: 'muted' }),
      td(`${k}:paused`, j.paused ? `paused by ${j.pausedBy || 'an administrator'}` : '—', { cls: j.paused ? '' : 'muted' }),
    ], { cls: focusJob === j.jobId ? 'jb-focus' : '', data: { job: j.jobId } });
  });
  return [
    keptCard(built, 'sov', 'Overall', 'for every job · pause, automatic runs and the retry policy act now; the rest is for the adaptive governor', overall),
    keptCard(built, 'sjobs', 'Per job', 'requests a job may use at once, and its priority', keptTable(built, 'sjobs',
      ['Job', 'Automatic runs', 'Auto', 'Requests at least', 'at most', 'Priority', 'Default', 'Paused'], rows)),
    built.same('ssave', acts),
  ];
}

/** The Save line follows what is typed without redrawing the fields being typed into. */
function syncSave() {
  if (!pageEl || !sett.res) return;
  const n = J.settingsChanges(sett.res, sett.draft).length;
  const save = pageEl.querySelector('#jb-s-save'), discard = pageEl.querySelector('#jb-s-discard'), count = pageEl.querySelector('#jb-s-count');
  if (save) save.disabled = !n || sett.saving;
  if (discard) discard.disabled = !n || sett.saving;
  if (count) count.textContent = n ? `${n} change${n === 1 ? '' : 's'} not saved` : 'no changes';
}

/** Everybody but an administrator: what JOBS_LIST says, nothing to change. */
function readOnlySettings() {
  const jobs = (list && list.jobs) || [];
  const gov = J.governorText(list && list.governor);
  const rows = jobs.map((job) => {
    const k = `ro:${job.id}`;
    const st = job.state || {};
    const alloc = st.allocation && typeof st.allocation === 'object' ? st.allocation : null;
    const req = J.requestsText(job);
    return tr(k, [
      td(`${k}:name`, h('b', job.name)),
      td(`${k}:en`, job.kind === 'manual' ? '—' : st.enabled === false ? 'off' : 'on'),
      td(`${k}:auto`, alloc && typeof alloc.auto === 'boolean' ? (alloc.auto ? 'on' : 'off') : '—', { title: alloc ? null : 'the adaptive governor is not reporting it' }),
      td(`${k}:req`, req.text, { title: req.title }),
      td(`${k}:prio`, J.priorityText(job.priority)),
      td(`${k}:paused`, st.paused ? `paused${st.pausedBy ? ` by ${st.pausedBy}` : ''}` : '—'),
    ], { data: { job: job.id } });
  });
  return [
    built.same('sro', h('div.banner.jb-ro-note', 'These settings are an administrator\'s. The overall limits (most jobs at once, CPU and memory thresholds, the retry policy) are read by administrators only.',
      gov ? ` The adaptive governor: ${gov.text}${gov.auto ? `, ${gov.auto}` : ''}.` : '')),
    keptCard(built, 'sro-jobs', 'Per job', 'as JOBS_LIST reports them', keptTable(built, 'sro-jobs', ['Job', 'Automatic runs', 'Auto', 'Requests', 'Priority', 'Paused'], rows,
      { emptyText: list ? 'No jobs listed.' : 'Reading the jobs…' })),
  ];
}

async function saveSettings() {
  const d = sett.draft;
  const problem = J.overallProblem(d.overall)
    || (sett.res.jobs || []).map((j) => J.jobSettingProblem(d.jobs[j.jobId], jobName(j.jobId))).find(Boolean) || '';
  if (problem) { say(problem, 'err'); return; }
  const msgs = J.settingsChanges(sett.res, d);
  if (!msgs.length) return;
  if (!(await ensureWrites())) return;
  sett.saving = true; draw();
  let failed = null;
  for (const m of msgs) {
    const res = await jobControl(m.type, m);
    if (!res || res.ok === false) { failed = { res, m }; break; }
  }
  sett.saving = false;
  // What is in force now is the core's to say; what was not saved stays typed.
  const keep = sett.draft;
  await loadSettings({ again: true });
  if (failed) { sett.draft = keep; say(`Not saved${failed.m.jobId ? ` (${jobName(failed.m.jobId)})` : ''}: ${J.refusalText(failed.res)}`, J.refusalLevel(failed.res)); draw(); return; }
  say('The job settings were saved.', 'ok');
  toast('Job settings saved', 'ok', 3000);
  kick();
}

/* --------------------------------------- controls --------------------------------------- */

function say(text, level = 'err') { notice = text ? { text, level } : null; draw(); }

/**
 * One control: the write unlock first (as every admin page), then the message, then the
 * answer said — a refusal as a sentence — and the list read again.
 */
async function control(type, params, { what = 'It', done }) {
  if (!(await ensureWrites())) return null;
  const res = await jobControl(type, params);
  if (!res || res.ok === false) { say(J.refusalText(res, { what }), J.refusalLevel(res)); kick(); return res; }
  say(done(res), 'ok');
  kick();
  return res;
}

function runNow(id) {
  const name = jobName(id);
  return control('JOB_RUN', { jobId: id }, { what: name, done: (r) => `${name}: started${r.runId ? ` (run ${r.runId})` : ''}.` });
}

function pauseJob(id, pause) {
  const name = jobName(id);
  return control(pause ? 'JOB_PAUSE' : 'JOB_RESUME', { jobId: id }, {
    what: name, done: () => (pause ? `${name} is paused: its timer starts nothing until it is resumed. A run already going finishes.` : `${name} is resumed: it runs by its own schedule again.`),
  });
}

async function cancelRun(runId) {
  const r = J.openRuns(list).find((x) => x.id === runId);
  const name = r ? jobName(r.jobId) : 'this run';
  const yes = await confirmDialog('Stop this run?', `${name} (run ${runId}) stops at its next safe point — between days, pages or clusters. A queued run ends at once. Nothing it already finished is undone.`, { yes: 'stop the run', danger: true });
  if (!yes) return null;
  return control('JOB_CANCEL', { runId }, {
    what: name, done: (res) => (res.status === 'cancelled' ? `${name}: it was queued, and is cancelled.` : `${name}: asked to stop; it stops at its next safe point.`),
  });
}

function retryRun(runId) {
  const run = [...((list && list.runs) || []), ...((hist.answer && hist.answer.runs) || []), ...((list && list.jobs) || []).map((j) => j.state && j.state.lastRun)]
    .find((x) => x && x.id === runId);
  const name = run ? jobName(run.jobId) : 'The run';
  return control('JOB_RETRY', { runId }, { what: name, done: (res) => `${name}: tried again${res.runId ? ` as run ${res.runId}` : ''}.` });
}

async function deleteJob(id) {
  const name = jobName(id);
  const yes = await confirmDialog('Delete this schedule?', `"${name}" stops sending and is removed with its settings. Its past runs stay in History.`, { yes: 'delete the schedule', danger: true });
  if (!yes) return null;
  return control('JOB_DELETE', { jobId: id }, { what: name, done: () => `"${name}" is deleted.` });
}

async function createJob() {
  const res = await openCreateJob();
  if (!res) return;
  say(createdToast(res), res.joined ? 'warn' : 'ok');
  kick();
}
