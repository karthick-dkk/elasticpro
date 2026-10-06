/**
 * Page — live log explorer over daily indices (logstash-<source>-YYYY.MM.DD).
 *
 * "Source" is the tenant inside the index name, not a client — a client here is a whole
 * cluster with its own Elasticsearch URL.
 */

import { h, mount, $, clear, activatable } from '../lib/dom.js';
import { num, dt, dur, ago, ymdDots, eachDay, download, downloadBytes, toCsv } from '../lib/fmt.js';
import { state, client, activeClusters, fetchIndices, setDelaySummary } from '../core/state.js';
import { timeHistogram } from '../lib/charts.js';
import { card, empty, pill, table, figure } from './common.js';
import { preflight, measureDelay, summarise, delayCoverage,
         buildDeviceQuery, documentDelays, deviceSnapshot, looksLikeIp,
         thresholds, STATUS } from '../core/log-delay.js';
import { runBounded, cancellation, partialNote } from '../core/fleet.js';
import { reportSheets, reportFilename } from '../core/delay-report.js';
import { navigateTo } from '../core/intent.js';
import { workbook, XLSX_MIME } from '../lib/xlsx.js';
import { toast } from '../ui/menu.js';
import { confirmDialog } from '../ui/modal.js';
import { isSnapshotMode } from '../core/snapshot.js';
import { jsonView } from '../lib/jsonview.js';

let host = null;
let tailTimer = null;

const ui = {
  sourceFilter: 'all',
  from: '', to: '',
  query: '',
  field: 'any',
  term: '',
  view: 'tail',
  /**
   * Which cluster the live tail follows.
   *
   * The page is fleet-wide because the delay view is, but a tail is one stream of one
   * cluster's documents — merging several would produce a list whose order means
   * nothing. So the tail picks one and names it, instead of the page quietly reducing
   * the fleet selection to a single cluster on the way in, which is what it used to do.
   */
  tailClusterId: '',
  size: 200,
  running: false,
  error: null,
  hits: [],
  total: 0,
  tookMs: 0,
  buckets: [],
  resolved: [],
  tail: false,
  expanded: new Set(),
};

/**
 * The delay view's state, which is fleet-wide: every cluster is asked, so every cluster
 * needs its own answer — including "we never got to this one", which is the state that
 * stops a stopped run being read as a clean one.
 */
const delay = {
  running: false,          // the coverage check is in flight
  fetching: false,         // the details fan-out is in flight
  token: null,             // the stop button for whichever of those is running
  cancelled: false,
  progress: { done: 0, total: 0 },
  byCluster: new Map(),    // cluster id -> { state, pre, records, truncated, error, fetchError }
  records: null,           // every cluster's devices, merged
  summary: null,
  error: null,
  at: 0,
  hours: 24,
  status: 'all',
  /**
   * One device, watched live. Null until somebody opens it — this is the only thing on
   * the page that repeats on a timer, and it exists only while its card is on screen.
   */
  watch: null,             // { clusterId, device, docs, snap, error, at, running, seconds }
};

let watchTimer = null;

function isoLocal(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function render(el) {
  host = el;
  if (isSnapshotMode()) { mount(host, snapshotNotice('The log explorer')); return; }
  if (!ui.from) {
    const now = new Date();
    const back = new Date(now.getTime() - 60 * 60 * 1000);
    ui.from = isoLocal(back); ui.to = isoLocal(now);
  }
  draw();
  if (!ui.hits.length && !ui.running) search();
}
export function onData() {}
export function onLeave() { stopTail(); stopWatch(); }

/** The cluster the live tail is following: the chosen one, or the first available. */
function cluster() {
  const active = activeClusters();
  return active.find((c) => c.id === ui.tailClusterId) || active[0] || null;
}

/**
 * The tail's own cluster picker, shown only when there is a choice to make.
 *
 * It sets a page-local field rather than the global selector: changing which cluster is
 * being tailed must not silently narrow the fleet the delay view is measuring.
 */
function tailClusterPicker() {
  const active = activeClusters();
  if (active.length < 2) return null;
  const sel = h('select', { onchange: (e) => { ui.tailClusterId = e.target.value; stopTail(); search(); } },
    ...active.map((c) => h('option', { value: c.id }, c.name)));
  sel.value = (cluster() || {}).id || '';
  return h('label.field', { title: 'A tail follows one cluster at a time' }, 'Tailing', sel);
}

/** Which concrete daily indices does the picked range touch? */
function targetIndices(c) {
  const known = state.indices.get(c.id) || [];
  const fromDay = ui.from.slice(0, 10), toDay = ui.to.slice(0, 10);
  const days = eachDay(fromDay, toDay).map((d) => ymdDots(d, '-'));
  const inRange = known.filter((r) => r.day && days.includes(r.day) &&
    (ui.sourceFilter === 'all' || r.source === ui.sourceFilter));
  if (inRange.length) return { list: inRange.map((r) => r.index), exact: true, days };
  // fall back to a wildcard the cluster resolves itself
  const pat = ui.sourceFilter === 'all' ? c.logIndexPattern : c.logIndexPattern.replace('*', `${ui.sourceFilter}-*`);
  return { list: [pat], exact: false, days };
}

function interval(ms) {
  const target = 60; // aim for ~60 buckets
  const step = ms / target;
  const table = [
    [1000, '1s'], [5000, '5s'], [10000, '10s'], [30000, '30s'], [60000, '1m'], [300000, '5m'],
    [600000, '10m'], [1800000, '30m'], [3600000, '1h'], [10800000, '3h'], [21600000, '6h'], [43200000, '12h'], [86400000, '1d'],
  ];
  for (const [msv, label] of table) if (step <= msv) return label;
  return '7d';
}

async function search({ silent = false } = {}) {
  const c = cluster();
  if (!c) return;
  const cl = client(c.id);
  if (!state.indices.get(c.id)) { try { await fetchIndices(c.id, '*'); } catch (_) {} }

  const t = targetIndices(c);
  ui.resolved = t;
  const gte = new Date(ui.from).toISOString();
  const lte = new Date(ui.to).toISOString();
  const span = new Date(ui.to) - new Date(ui.from);

  const filters = [{ range: { [c.timeField]: { gte, lte, format: 'strict_date_optional_time' } } }];
  const must = ui.query.trim() ? [{ query_string: { query: ui.query.trim(), analyze_wildcard: true, default_field: '*' } }] : [];

  // The field picker, as a second clause rather than text spliced into the Lucene box —
  // a value containing a space or a colon would otherwise change what the query means.
  //
  // Both the field and its .keyword are searched because which one exists depends on the
  // mapping, and `lenient` keeps a field this index does not have from failing the whole
  // search: no hits for that clause is the honest answer, an error is not.
  const term = ui.term.trim();
  if (term) {
    must.push(ui.field === 'any'
      ? { query_string: { query: term, analyze_wildcard: true, default_field: '*', lenient: true } }
      : { query_string: { query: term, analyze_wildcard: true, lenient: true,
                          fields: [ui.field, `${ui.field}.keyword`] } });
  }

  const body = {
    size: Number(ui.size) || 100,
    track_total_hits: 10000,
    sort: [{ [c.timeField]: { order: 'desc', unmapped_type: 'date' } }],
    query: { bool: { filter: filters, must } },
    aggs: { over_time: { date_histogram: { field: c.timeField, fixed_interval: interval(span), min_doc_count: 0,
      extended_bounds: { min: gte, max: lte } } } },
  };

  ui.running = true; ui.error = null;
  if (!silent) draw();
  try {
    const idx = t.list.join(',').slice(0, 3500) || '*';
    const r = await cl.search(idx, body, { qs: 'ignore_unavailable=true&allow_no_indices=true&rest_total_hits_as_int=false', timeoutMs: 45000 });
    ui.hits = (r.hits && r.hits.hits) || [];
    ui.total = (r.hits && r.hits.total && (r.hits.total.value ?? r.hits.total)) || 0;
    ui.totalRelation = (r.hits && r.hits.total && r.hits.total.relation) || 'eq';
    ui.tookMs = r.took || 0;
    ui.buckets = ((r.aggregations && r.aggregations.over_time && r.aggregations.over_time.buckets) || [])
      .map((b) => ({ t: b.key, v: b.doc_count }));
  } catch (e) {
    ui.error = e.message; ui.hits = []; ui.buckets = []; ui.total = 0;
  }
  ui.running = false;
  draw();
}

function startTail() {
  stopTail();
  ui.tail = true;
  tailTimer = setInterval(() => {
    const now = new Date();
    const span = new Date(ui.to) - new Date(ui.from);
    ui.to = isoLocal(now);
    ui.from = isoLocal(new Date(now.getTime() - span));
    search({ silent: true });
  }, Math.max(5, state.defaults.refreshIntervalSec) * 1000);
  search();
}
function stopTail() { ui.tail = false; if (tailTimer) clearInterval(tailTimer); tailTimer = null; }

function quick(label, ms) {
  return h('button.btn.sm', { onclick: () => {
    const now = new Date();
    ui.to = isoLocal(now); ui.from = isoLocal(new Date(now.getTime() - ms));
    search();
  } }, label);
}

function draw() {
  const c = cluster();
  if (isSnapshotMode()) return mount(host, snapshotNotice('The log explorer'));
  // The delay view is fleet-wide and draws its own "no cluster" state, so it is reached
  // before the single-cluster guard the live tail needs.
  if (ui.view === 'delay') return mount(host, viewSwitch(), delayView());
  if (!c) return mount(host, empty('No cluster selected'));
  const known = state.indices.get(c.id) || [];
  const sourceNames = [...new Set(known.filter((r) => r.source).map((r) => r.source))].sort();

  const sel = h('select', { onchange: (e) => { ui.sourceFilter = e.target.value; search(); } },
    h('option', { value: 'all' }, 'All sources'),
    ...sourceNames.map((n) => h('option', { value: n }, n)));
  sel.value = ui.sourceFilter;

  const bar = h('div.toolbar',
    tailClusterPicker(),
    h('label.field', 'Source', sel),
    h('label.field', 'From', h('input', { type: 'datetime-local', value: ui.from, onchange: (e) => { ui.from = e.target.value; } })),
    h('label.field', 'To', h('input', { type: 'datetime-local', value: ui.to, onchange: (e) => { ui.to = e.target.value; } })),
    h('label.field', 'Field', (() => {
      const fields = (c.logSearchFields && c.logSearchFields.length) ? c.logSearchFields : [];
      const f = h('select', { onchange: (e) => { ui.field = e.target.value; if (ui.term.trim()) search(); } },
        h('option', { value: 'any' }, 'Any field'),
        ...fields.map((n) => h('option', { value: n }, n)));
      f.value = ui.field; return f;
    })()),
    h('label.field', 'Value', h('input', { type: 'search', value: ui.term, placeholder: 'web-01, 10.0.*, timeout',
      style: { minWidth: '180px' },
      oninput: (e) => { ui.term = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') search(); } })),
    h('label.field', 'Lucene query', h('input', { type: 'search', value: ui.query, placeholder: 'level:ERROR AND host:web*', style: { minWidth: '220px' },
      oninput: (e) => { ui.query = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') search(); } })),
    h('label.field', 'Rows', h('input', { type: 'number', min: '10', max: '2000', step: '10', value: String(ui.size), style: { width: '84px' },
      onchange: (e) => { ui.size = Number(e.target.value) || 200; } })),
    h('button.btn.primary', { onclick: () => search() }, ui.running ? 'Searching…' : 'Search'),
    h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-end' } },
      quick('15m', 9e5), quick('1h', 36e5), quick('24h', 864e5), quick('7d', 6048e5)),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'flex-end' } },
      h('button.btn.sm', { onclick: () => (ui.tail ? (stopTail(), draw()) : startTail()),
        style: ui.tail ? { borderColor: 'var(--good)', color: 'var(--good)' } : null },
        ui.tail ? '■ Stop live tail' : '▶ Live tail'),
      h('button.btn.sm', { onclick: exportHits, disabled: !ui.hits.length }, 'Export CSV')));

  const resolvedNote = ui.resolved.list
    ? h('div.muted', { style: { fontSize: '11.5px', marginBottom: '10px' } },
        ui.resolved.exact
          ? `Searching ${ui.resolved.list.length} daily ${ui.resolved.list.length === 1 ? 'index' : 'indices'} across ${ui.resolved.days.length} day(s): `
          : `No matching daily indices cached — falling back to pattern `,
        h('code.inline', ui.resolved.list.slice(0, 4).join(', ') + (ui.resolved.list.length > 4 ? ` +${ui.resolved.list.length - 4} more` : '')))
    : null;

  mount(host, viewSwitch(), bar, resolvedNote,
    ui.error ? h('div.banner.err', h('div', h('div.ttl', 'Search failed'), h('div.mono', ui.error))) : null,
    card('Documents over time',
      `${num(ui.total)}${ui.totalRelation === 'gte' ? '+' : ''} matching · query took ${dur(ui.tookMs)}`,
      ui.running && !ui.buckets.length ? h('div.tbl-empty', h('span.spin'), ' searching…')
        : timeHistogram(ui.buckets, { height: 150, yLabel: 'Documents',
            formatX: (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            onSelect: (b) => { const w = ui.buckets.length > 1 ? ui.buckets[1].t - ui.buckets[0].t : 60000;
              ui.from = isoLocal(new Date(b.t)); ui.to = isoLocal(new Date(b.t + w)); search(); } })),
    h('div', { style: { marginTop: '14px' } }, hitsCardWrapper()));
}

/* ------------------------------- log delay ------------------------------- */

/**
 * Two views of the same logs: what is arriving, and whether it is arriving late.
 *
 * One page because they answer the same question at different resolutions — "is this
 * device shipping" and "is it shipping on time" — and jumping between pages to ask both
 * is how one of them stops being asked.
 */
function viewSwitch() {
  const btn = (id, label, title) => h(`button.btn.sm${ui.view === id ? '.primary' : ''}`, {
    title, onclick: () => { ui.view = id; draw(); if (id === 'delay') runPreflight(); },
  }, label);
  return h('div', { style: { display: 'flex', gap: '4px', marginBottom: '10px' } },
    btn('tail', 'Live tail', 'Search and follow documents as they arrive'),
    btn('delay', 'Log delay', 'How far behind real time each device is shipping'));
}
/* ------------------------- the delay view, across the fleet ------------------------- */

/**
 * How many clusters are asked at once.
 *
 * Three, not "all of them": the clusters people point this at are the ones already under
 * load, and the delay query is a terms aggregation with a top_hits per bucket. Four
 * simultaneous copies of that is a noticeable thing to do to somebody's production
 * cluster, and this page exists to watch it, not to be the reason it is slow.
 */
const FAN_OUT = 3;

/** An entry per cluster, in the order the fleet is listed. */
function delayRows() {
  return activeClusters().map((c) => ({ c, d: delay.byCluster.get(c.id) || { state: 'idle' } }));
}

function setEntry(id, patch) {
  delay.byCluster.set(id, { ...(delay.byCluster.get(id) || {}), ...patch });
}

/** Stop a fan-out that is still going. The work already in flight still reports. */
function stopDelay() {
  if (delay.token) delay.token.cancel();
}

/**
 * Ask every cluster whether it can be analysed at all.
 *
 * On demand, never on render: it is one call per cluster, and the analysis it guards is
 * far more than that. Results are drawn as they land, so eight clusters do not look like
 * a hung page for the length of three round trips.
 */
async function runPreflight() {
  const list = activeClusters();
  if (!list.length || delay.running) return;
  const token = cancellation();
  delay.token = token;
  delay.running = true;
  delay.cancelled = false;
  delay.progress = { done: 0, total: list.length };
  delay.byCluster = new Map(list.map((c) => [c.id, { state: 'waiting' }]));
  // A new coverage check invalidates the devices drawn from the last one.
  delay.records = null; delay.summary = null; delay.at = 0;
  draw();

  const out = await runBounded(list, (c) => preflight(client(c.id), c), {
    limit: FAN_OUT,
    token,
    onSettled: (s, p) => {
      setEntry(s.item.id, s.error
        ? { state: 'error', error: s.error.message || String(s.error) }
        : { state: 'checked', pre: s.value });
      delay.progress = { done: p.done, total: p.total };
      if (host && host.isConnected) draw();
    },
  });

  // Naming what was never asked is the whole point of doing this in one place: a cluster
  // that is missing from the coverage table because somebody pressed Stop must not look
  // like a cluster that answered.
  for (const { item } of out.skipped) setEntry(item.id, { state: 'skipped' });
  delay.running = false;
  delay.cancelled = out.cancelled;
  delay.token = null;
  if (host && host.isConnected) draw();
}

/** The clusters the preflight said can actually be measured. */
function analysable() {
  return delayRows().filter(({ d }) => d.pre && d.pre.ok && !d.pre.unknown).map(({ c, d }) => ({ c, pre: d.pre }));
}

/**
 * Run the analysis across every cluster that can take it.
 *
 * Only ever from a click. Each cluster is one aggregation with a document fetch per
 * device, and nothing that expensive should start because a page rendered or a timer
 * fired.
 */
async function fetchDelay() {
  const targets = analysable();
  if (!targets.length || delay.fetching) return;
  const token = cancellation();
  delay.token = token;
  delay.fetching = true;
  delay.cancelled = false;
  delay.error = null;
  delay.progress = { done: 0, total: targets.length };
  for (const { c } of targets) setEntry(c.id, { state: 'fetching', records: null, fetchError: null });
  draw();

  const out = await runBounded(targets, ({ c, pre }) => measureDelay(client(c.id), c, pre, delay.hours), {
    limit: FAN_OUT,
    token,
    onSettled: (s, p) => {
      const id = s.item.c.id;
      if (s.error) {
        const es = s.error.res && s.error.res.json && s.error.res.json.error;
        setEntry(id, { state: 'failed', fetchError: (es && (es.reason || es.type)) || s.error.message || String(s.error) });
      } else {
        setEntry(id, { state: 'done', records: s.value.records, truncated: s.value.truncated });
        // What this run found becomes the cluster's log-delay alert — here, and in Zabbix
        // through the scraper, which measures on its own schedule.
        setDelaySummary(id, summarise(s.value.records));
      }
      delay.progress = { done: p.done, total: p.total };
      mergeDelay();
      if (host && host.isConnected) draw();
    },
  });

  for (const { item } of out.skipped) setEntry(item.c.id, { state: 'not-asked' });
  delay.fetching = false;
  delay.cancelled = out.cancelled;
  delay.token = null;
  delay.at = Date.now();
  mergeDelay();
  if (host && host.isConnected) draw();
}

/**
 * One fleet-wide list of devices, and the arithmetic that describes it.
 *
 * `summarise` is the one definition of what a set of records adds up to — the same
 * function the single-cluster view used — so the fleet total and any per-cluster figure
 * can never disagree about what "median delay" means.
 */
function mergeDelay() {
  const done = delayRows().filter(({ d }) => d.records);
  if (!done.length) { delay.records = null; delay.summary = null; return; }
  const all = [];
  for (const { c, d } of done) for (const r of d.records) all.push({ ...r, cluster: c.name, clusterId: c.id });
  delay.records = all;
  delay.summary = summarise(all);
  delay.summary.truncated = done.reduce((n, { d }) => n + (d.truncated || 0), 0);
}

/**
 * What the fan-out did not cover, in one line, or nothing when it covered everything.
 *
 * The counting is `delayCoverage` in the engine, not here: the coverage line and the
 * table underneath it have to agree about how many clusters answered, and the only way
 * to guarantee that is for there to be one definition of it.
 */
function coverageNote(phase) {
  return partialNote({
    ...delayCoverage(delayRows().map(({ d }) => d), phase),
    cancelled: delay.cancelled,
  });
}

function delayView() {
  const list = activeClusters();
  const can = analysable();
  const busy = delay.running || delay.fetching;
  const head = h('div.toolbar',
    h('span.muted', { style: { fontSize: '11.5px' } },
      'Delay is arrival time minus the time the event actually happened, per device, across every cluster.'),
    h('label.field', 'Window', (() => {
      const sel = h('select', { disabled: busy, onchange: (e) => { delay.hours = Number(e.target.value); } },
        ...[1, 6, 24, 72, 168].map((n) => h('option', { value: String(n) },
          n < 24 ? `${n} hour${n === 1 ? '' : 's'}` : `${n / 24} day${n === 24 ? '' : 's'}`)));
      sel.value = String(delay.hours); return sel;
    })()),
    h('label.field', 'Show', (() => {
      const sel = h('select', { onchange: (e) => { delay.status = e.target.value; draw(); } },
        h('option', { value: 'all' }, 'Every device'),
        h('option', { value: 'unhealthy' }, 'Only unhealthy'));
      sel.value = delay.status; return sel;
    })()),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
      busy
        ? h('span.muted', { style: { fontSize: '11.5px' } },
            `${delay.progress.done} of ${delay.progress.total}…`)
        : null,
      busy
        ? h('button.btn.sm', { id: 'delay-stop', onclick: stopDelay }, 'Stop')
        : h('button.btn.sm', { id: 'delay-check', onclick: runPreflight },
            delay.byCluster.size ? '↻ Re-check the fleet' : `Check ${list.length} cluster(s)`),
      h('button.btn.sm.primary', {
        id: 'delay-fetch',
        disabled: busy || !can.length,
        title: can.length ? '' : 'No cluster has reported that it can be analysed yet',
        onclick: fetchDelay,
      }, delay.records ? '↻ Fetch again' : `Fetch details (${can.length})`),
      // In the toolbar rather than inside the results card. The report was only
      // reachable after a successful fetch, which is exactly backwards: a fleet where
      // nothing can be analysed is the case somebody most needs to hand to someone else.
      h('button.btn.sm', {
        id: 'delay-report',
        disabled: !delay.byCluster.size,
        title: 'A spreadsheet: every device measured, the summary, and every cluster that was not',
        onclick: exportDelayReport,
      }, '\u2913 Report (xlsx)'),
      h('button.btn.sm.ghost', {
        id: 'delay-schedule',
        title: 'Produce this report on a timer while the app is open',
        onclick: scheduleReport,
      }, delaySchedule() ? `\u23F1 ${delaySchedule().everyHours}h` : '\u23F1 Schedule\u2026')));

  if (!list.length) return h('div', head, card('Log delay', '', empty('No cluster selected')));
  if (!delay.byCluster.size) {
    return h('div', head, card('Log delay', `${list.length} cluster(s)`,
      empty('Press Check to see which clusters can be analysed.')));
  }

  return h('div', head,
    // The close-up goes above the fleet table: it is what was just asked for, and
    // scrolling past a hundred devices to find it would make the button feel broken.
    delay.watch ? h('div', { style: { marginBottom: '10px' } }, watchCard()) : null,
    coverageCard(),
    delay.records ? h('div', { style: { marginTop: '10px' } }, resultsCard()) : null);
}

/** Per cluster: can it be measured, by which fields, and if not, what is missing. */
function coverageCard() {
  const rows = delayRows();
  const note = coverageNote('preflight');
  const yes = rows.filter(({ d }) => d.pre && d.pre.ok && !d.pre.unknown).length;

  const stateCell = ({ d }) => {
    if (d.state === 'waiting') return h('span.muted', { style: { fontSize: '11.5px' } }, 'Loading…');
    if (d.state === 'skipped' || d.state === 'not-asked') return pill('never asked', 'grey');
    if (d.state === 'error') return pill('could not ask', 'orange');
    if (!d.pre) return h('span.muted', '—');
    if (d.pre.unknown) return pill('unknown', 'orange');
    return d.pre.ok ? pill('can be analysed', 'green') : pill('cannot be analysed', 'red');
  };

  const why = ({ c, d }) => {
    if (d.state === 'error') return h('span.mono', { style: { fontSize: '11px' } }, d.error);
    if (d.state === 'skipped' || d.state === 'not-asked') {
      return h('span.muted', { style: { fontSize: '11.5px' } },
        'The check was stopped before this cluster was reached — unknown, not empty.');
    }
    if (!d.pre) return h('span.muted', '—');
    if (d.pre.unknown) {
      return h('span', { style: { fontSize: '11.5px' } },
        h('span.mono', d.pre.error || 'no answer'),
        h('span.muted', ' — the fields may be there; the question did not get through.'));
    }
    if (d.pre.ok) {
      const m = (d.pre.metadataMissing || []).length;
      return h('span.muted', { style: { fontSize: '11.5px' } },
        `group by ${d.pre.resolved.device}, event ${d.pre.resolved.eventTime}, arrival ${d.pre.resolved.arrival}`
        + (m ? ` · ${m} context field(s) absent` : ''));
    }
    return h('span', { style: { fontSize: '11.5px' } },
      h('span.muted', 'not mapped in '), h('code.inline', c.logIndexPattern || 'logstash-*'), h('span.muted', ': '),
      h('span.mono', { style: { wordBreak: 'break-all' } }, (d.pre.missing || []).join(', ')));
  };

  const fetchCell = ({ d }) => {
    if (d.state === 'fetching') return h('span.muted', { style: { fontSize: '11.5px' } }, 'Loading…');
    if (d.state === 'failed') return h('span', { title: d.fetchError }, pill('query failed', 'red'));
    if (d.records) return h('span.num', num(d.records.length));
    return h('span.muted', '—');
  };

  const trs = rows.map((r) => h('tr',
    h('td', h('div', { style: { fontWeight: 620 } }, r.c.name),
      h('div.muted.mono', { style: { fontSize: '10.5px' } }, r.c.url)),
    h('td', stateCell(r)),
    h('td.num', fetchCell(r)),
    h('td', { style: { maxWidth: '520px' } }, why(r))));

  return card('Log delay coverage',
    `${yes} of ${rows.length} cluster(s) can be analysed`,
    h('div', { style: { display: 'grid', gap: '10px' } },
      note ? h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, note) : null,
      rows.some(({ d }) => d.pre && !d.pre.ok && !d.pre.unknown)
        ? h('div.muted', { style: { fontSize: '11.5px' } },
            'Set ', h('code.inline', 'delayFields'), ' on a cluster to the names its parser produces. ',
            'Nothing is reported as zero — the analysis simply cannot run there.')
        : null,
      table(['Cluster', 'Preflight', { label: 'Devices', num: true }, 'Detail'], trs)));
}

/* --------------------------- one device, watched live --------------------------- */

/**
 * How often the close-up re-asks. Fifteen seconds, not one: this is the only repeating
 * request the app makes to a cluster, and a device that is forty minutes behind does not
 * become interesting a second sooner for being asked four times as often.
 */
const WATCH_SECONDS = 15;

function stopWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}

/** Close the close-up. The timer goes with it — nothing keeps polling off screen. */
function closeWatch() {
  stopWatch();
  delay.watch = null;
  draw();
}

/**
 * Open the live view of one device.
 *
 * The device may be a hostname or an address, and which field it is looked up by depends
 * on that — see `deviceFieldsFor`. Getting it wrong returns nothing, which on this
 * screen reads as "this device has stopped shipping", so the decision is made in the
 * engine and tested there rather than guessed here.
 */
function watchDevice(clusterId, device) {
  const entry = delay.byCluster.get(clusterId);
  if (!entry || !entry.pre || !entry.pre.ok) return;
  stopWatch();
  delay.watch = { clusterId, device, docs: null, snap: null, error: null, at: 0,
                  running: false, seconds: WATCH_SECONDS, live: true };
  draw();
  pollWatch();
  watchTimer = setInterval(() => {
    // A card that has been closed, or a page that has been left, must not keep asking.
    if (!delay.watch || !delay.watch.live || !host || !host.isConnected) { stopWatch(); return; }
    pollWatch();
  }, WATCH_SECONDS * 1000);
}

/** Pause and resume without losing what is already on screen. */
function toggleWatchLive() {
  if (!delay.watch) return;
  delay.watch.live = !delay.watch.live;
  if (delay.watch.live) pollWatch();
  draw();
}

/** One round trip: the newest documents for this device, and what they add up to. */
async function pollWatch() {
  const w = delay.watch;
  if (!w || w.running) return;
  const c = activeClusters().find((x) => x.id === w.clusterId);
  const entry = delay.byCluster.get(w.clusterId);
  if (!c || !entry || !entry.pre || !entry.pre.ok) { w.error = 'This cluster is no longer available.'; draw(); return; }
  w.running = true;
  if (host && host.isConnected) draw();
  try {
    const body = buildDeviceQuery(entry.pre.resolved, {
      device: w.device, size: 15, fields: (entry.pre.fields || null),
    });
    const res = await client(c.id).search(c.logIndexPattern || 'logstash-*', body,
      { qs: 'ignore_unavailable=true&allow_no_indices=true', timeoutMs: 30000 });
    const docs = documentDelays(((res.hits || {}).hits) || [], entry.pre.resolved, thresholds(c));
    w.docs = docs;
    w.snap = deviceSnapshot(docs, thresholds(c));
    w.total = ((res.hits || {}).total || {}).value ?? null;
    w.error = null;
    w.at = Date.now();
  } catch (e) {
    const es = e.res && e.res.json && e.res.json.error;
    // The previous documents stay on screen: they were true when they were fetched, and
    // blanking them would turn one failed poll into "this device has no data".
    w.error = (es && (es.reason || es.type)) || e.message || String(e);
  } finally {
    w.running = false;
    if (host && host.isConnected) draw();
  }
}

/** The close-up itself: what this one device is doing, document by document. */
function watchCard() {
  const w = delay.watch;
  if (!w) return null;
  const c = activeClusters().find((x) => x.id === w.clusterId);
  const s = w.snap;

  const head = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
    s ? pill(STATUS[s.status].label, STATUS[s.status].cls) : h('span.muted', 'Loading…'),
    s && s.latest !== null
      ? h('b', { style: { fontSize: '15px' } }, fmtDelay(s.latest))
      : h('span.muted', 'no measurable delay'),
    s && s.trend !== 'NO_TREND'
      ? pill(s.trend === 'WORSENING' ? 'getting worse' : 'improving', s.trend === 'WORSENING' ? 'red' : 'green')
      : null,
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' } },
      h('span.muted', { style: { fontSize: '11px' } },
        w.running ? 'Loading…' : w.at ? `updated ${ago(w.at)}` : ''),
      h('button.btn.sm', { id: 'watch-live', onclick: toggleWatchLive },
        w.live ? `⏸ Pause (every ${w.seconds}s)` : '▶ Resume'),
      h('button.btn.sm', { id: 'watch-now', disabled: w.running, onclick: pollWatch }, '↻ Now'),
      h('button.btn.sm.ghost', { id: 'watch-close', onclick: closeWatch }, 'Close')));

  const figures = s ? table([], [
    h('tr', h('td', { style: { color: 'var(--text-muted)', fontSize: '11.5px' } }, 'Newest document'),
      h('td.mono', { style: { fontSize: '12px' } },
        s.latest === null ? 'unknown' : fmtDelay(s.latest))),
    h('tr', h('td', { style: { color: 'var(--text-muted)', fontSize: '11.5px' } }, 'Median of the last ' + s.measurable),
      h('td.mono', { style: { fontSize: '12px' } }, s.median === null ? 'unknown' : fmtDelay(s.median))),
    h('tr', h('td', { style: { color: 'var(--text-muted)', fontSize: '11.5px' } }, 'Range'),
      h('td.mono', { style: { fontSize: '12px' } },
        s.min === null ? 'unknown' : `${fmtDelay(s.min)} … ${fmtDelay(s.max)}`)),
    h('tr', h('td', { style: { color: 'var(--text-muted)', fontSize: '11.5px' } }, 'Documents matched'),
      h('td.mono', { style: { fontSize: '12px' } },
        w.total === null ? 'unknown' : `${num(w.total)} in the window`)),
  ]) : null;

  const rows = (w.docs || []).map((d) => h('tr',
    h('td.mono', { style: { fontSize: '11.5px' } }, d.event ? dt(d.event) : h('span.muted', 'unreadable')),
    h('td.mono', { style: { fontSize: '11.5px' } }, d.arrival ? dt(d.arrival) : h('span.muted', 'unreadable')),
    h('td.num', d.delayMinutes === null
      ? h('span.muted', 'unknown')
      : h('b', { style: { color: d.status === 'CRITICAL' ? 'var(--critical)'
                        : d.status === 'DELAYED' ? 'var(--warning)' : 'inherit' } }, fmtDelay(d.delayMinutes))),
    h('td', pill(STATUS[d.status].label, STATUS[d.status].cls)),
    h('td.mono.muted', { style: { fontSize: '10.5px' } }, d.index)));

  return card(`${w.device} — live`,
    `${c ? c.name : 'unknown cluster'} · ${looksLikeIp(w.device) ? 'matched as an address' : 'matched as a hostname'}`
    + (s && s.unreadable ? ` · ${s.unreadable} of ${s.documents} document(s) unreadable` : ''),
    h('div', { style: { display: 'grid', gap: '10px' } },
      head,
      w.error
        ? h('div.banner.err', { style: { margin: 0, fontSize: '12px' } },
            h('div', h('div.ttl', 'The last poll failed'), h('div.mono', w.error),
              w.docs ? h('div.muted', { style: { fontSize: '11.5px' } },
                'The documents below are from the last poll that worked, not from now.') : null))
        : null,
      figures,
      table(['Event time', 'Arrival', { label: 'Delay', num: true }, 'Status', 'Index'], rows,
        { emptyText: w.running ? 'Loading…' : 'No document matched this device in the index pattern.' })));
}

/** Every device across the fleet, worst first, with why and what to do about it. */
function resultsCard() {
  const s = delay.summary;
  const all = delay.records;
  const rows = delay.status === 'unhealthy'
    ? all.filter((x) => x.status === 'DELAYED' || x.status === 'CRITICAL' || x.status === 'CLOCK_AHEAD')
    : all;

  // Worst first: a critical device at the bottom of an alphabetical list is a device
  // nobody sees.
  const rank = { CRITICAL: 0, DELAYED: 1, CLOCK_AHEAD: 2, ERROR: 3, NO_DATA: 4, OK: 5 };
  const sorted = [...rows].sort((a, b) =>
    (rank[a.status] - rank[b.status]) || ((b.delayMinutes ?? -1e9) - (a.delayMinutes ?? -1e9)));

  const trs = sorted.map((x) => h('tr',
    h('td.muted', { style: { fontSize: '11.5px' } }, x.cluster),
    h('td.mono', x.device),
    h('td', pill(STATUS[x.status].label, STATUS[x.status].cls)),
    h('td.num', x.delayMinutes === null
      ? h('span.muted', 'unknown')
      : h('b', { style: { color: x.status === 'CRITICAL' ? 'var(--critical)'
                        : x.status === 'DELAYED' ? 'var(--warning)' : 'inherit' } },
          fmtDelay(x.delayMinutes))),
    h('td', x.pattern === '-' ? h('span.muted', '—')
      : h('span', { title: x.patternNote }, pill(x.pattern, 'orange'))),
    h('td.num.muted', num(x.docs)),
    h('td.muted', { style: { fontSize: '11.5px' } }, x.arrival ? ago(x.arrival) : '—'),
    h('td.muted', { style: { fontSize: '11.5px', maxWidth: '320px', wordBreak: 'break-word' } },
      x.patternNote || x.reason),
    h('td', h('button.btn.sm', {
      title: `Watch ${x.device} live`,
      onclick: () => watchDevice(x.clusterId, x.device),
    }, 'Watch'))));

  const tile = (k, n) => h('span', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center' } },
    pill(STATUS[k].label, STATUS[k].cls), h('b', num(n)));

  const note = coverageNote('fetch');
  const measured = delayRows().filter(({ d }) => d.records).length;

  return card('Devices across the fleet',
    `${num(s.devices)} device(s) in ${measured} cluster(s) · `
    + `${s.median === null ? 'no measurable delay' : `median ${fmtDelay(s.median)}`}`
    + (delay.at ? ` · fetched ${ago(delay.at)}` : ' · still fetching'),
    h('div', { style: { display: 'grid', gap: '10px' } },
      note ? h('div.banner.warn', { style: { margin: 0, fontSize: '12px' } }, note) : null,
      h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center' } },
        ...Object.entries(s.by).filter(([, n]) => n > 0).map(([k, n]) => tile(k, n))),
      s.truncated
        ? h('div.muted', { style: { fontSize: '11.5px' } },
            `${num(s.truncated)} document(s) fall outside the top 500 devices per cluster — this list is not every device.`)
        : null,
      h('div', { style: { display: 'flex', gap: '6px' } },
        h('button.btn.sm', { id: 'delay-csv', onclick: exportDelayCsv }, 'Export CSV')),
      table(['Cluster', 'Device', 'Status', { label: 'Delay', num: true }, 'Pattern',
             { label: 'Docs', num: true }, 'Last seen', 'What it means', ''],
        trs, { emptyText: delay.status === 'unhealthy' ? 'Every device is within threshold.' : 'No devices returned.' })));
}

/* ------------------------------- the report ------------------------------- */

/**
 * What the fan-out did not cover, as rows for the report's own sheet.
 *
 * The screen says "6 of 9 answered" in a sentence above the table. A spreadsheet has no
 * sentence above the table, so the same fact has to travel as data or it does not
 * travel at all.
 */
function missingClusters() {
  return delayRows()
    .filter(({ d }) => !d.records)
    .map(({ c, d }) => ({
      cluster: c.name,
      reason: d.state === 'failed' ? `query failed: ${d.fetchError || 'no reason given'}`
        : d.state === 'not-asked' ? 'never asked — the run was stopped'
        : d.state === 'error' ? `could not be checked: ${d.error || 'no reason given'}`
        : d.pre && !d.pre.ok && !d.pre.unknown ? `cannot be analysed: ${(d.pre.missing || []).join(', ')} not mapped`
        : d.pre && d.pre.unknown ? `unknown: ${d.pre.error || 'the cluster did not answer'}`
        : 'not measured',
    }));
}

/** The workbook for what is on screen now. */
function buildDelayReport() {
  const measured = delayRows().filter(({ d }) => d.records).length;
  const missing = missingClusters();
  return workbook(reportSheets(delay.records || [], delay.summary || {}, {
    generatedAt: delay.at || Date.now(),
    windowHours: delay.hours,
    measured,
    notMeasured: missing.length,
    missing,
  }));
}

function exportDelayReport() {
  // No records is not a reason to refuse. A fleet where nothing could be analysed is
  // still a finding, and the Not measured sheet is the whole answer: which cluster, and
  // which fields it is missing. Refusing here would leave somebody with a screenful of
  // red and nothing to send on.
  if (!delay.byCluster.size) { toast('Check the fleet first — nothing has been looked at yet', 'warn'); return; }
  try {
    downloadBytes(reportFilename(delay.at || Date.now()), buildDelayReport(), XLSX_MIME);
    toast('Report saved');
  } catch (e) {
    toast(`Could not build the report: ${e.message}`, 'err', 6000);
  }
}

/* ------------------------------ the schedule ------------------------------ */

const SCHEDULE_KEY = 'elasticpro.delayReport.schedule';

/**
 * A saved report schedule, or null.
 *
 * Worth being plain about what this can and cannot be: a browser cannot write a file
 * while nobody is looking at it. So a schedule here does not mean "a spreadsheet appears
 * on disk every night" — it means the app produces one when it is open and the interval
 * has passed. The card says so rather than implying otherwise. Measurements shipped to
 * Elasticsearch are the thing that genuinely runs unattended, and that is the core's
 * scheduler, not this.
 */
function delaySchedule() {
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.everyHours ? s : null;
  } catch (_) { return null; }
}

function saveSchedule(s) {
  try {
    if (s) localStorage.setItem(SCHEDULE_KEY, JSON.stringify(s));
    else localStorage.removeItem(SCHEDULE_KEY);
  } catch (_) { toast('This browser will not remember the schedule', 'warn'); }
}

async function scheduleReport() {
  const cur = delaySchedule();
  const hours = h('select',
    ...[1, 6, 12, 24, 168].map((n) => h('option', { value: String(n) },
      n < 24 ? `every ${n} hour${n === 1 ? '' : 's'}` : n === 24 ? 'once a day' : 'once a week')));
  hours.value = String((cur && cur.everyHours) || 24);

  const ok = await confirmDialog('Schedule this report?',
    h('div', { style: { display: 'grid', gap: '9px', fontSize: '12.5px' } },
      h('label.field', 'Produce it', hours),
      h('div.muted',
        'A browser cannot save a file while nobody is looking at it. The report is built '
        + 'when this page is open and the interval has passed, and the download starts then. '
        + 'For something that runs unattended, ship the measurements to Elasticsearch from '
        + 'the Config page — that is the core\u2019s scheduler and it does not need a tab.'),
      cur ? h('div.muted', `Currently ${cur.everyHours}h. Last produced ${cur.lastAt ? ago(cur.lastAt) : 'never'}.`) : null),
    { yes: cur ? 'Update' : 'Schedule', no: cur ? 'Stop scheduling' : 'Cancel' });

  if (!ok) { if (cur) { saveSchedule(null); toast('Schedule stopped'); draw(); } return; }
  saveSchedule({ everyHours: Number(hours.value) || 24, lastAt: (cur && cur.lastAt) || 0 });
  toast(`Report scheduled — every ${hours.value}h while this page is open`);
  draw();
}

/** Called on each delay-view draw: produce the report if one is due. */
function maybeScheduledReport() {
  const s = delaySchedule();
  if (!s || !delay.records) return;
  const due = (s.lastAt || 0) + s.everyHours * 3600 * 1000;
  if (Date.now() < due) return;
  saveSchedule({ ...s, lastAt: Date.now() });
  exportDelayReport();
}

/**
 * The fleet's devices as a file.
 *
 * The header carries what the table carries, including the clusters that were not
 * measured: a spreadsheet leaves the page behind, and a partial export that does not say
 * it is partial becomes a number in somebody's report.
 */
function exportDelayCsv() {
  if (!delay.records) return;
  const rows = delay.records.map((x) => ({
    cluster: x.cluster,
    device: x.device,
    status: STATUS[x.status].label,
    delay_minutes: x.delayMinutes === null ? '' : x.delayMinutes.toFixed(2),
    pattern: x.pattern === '-' ? '' : x.pattern,
    docs: x.docs,
    last_seen: x.arrival ? dt(x.arrival) : '',
    detail: x.patternNote || x.reason || '',
  }));
  const missed = delayRows().filter(({ d }) => !d.records).map(({ c, d }) => `${c.name} (${d.state})`);
  if (missed.length) {
    rows.push({ cluster: '', device: '', status: '', delay_minutes: '', pattern: '', docs: '',
      last_seen: '', detail: `not measured: ${missed.join('; ')}` });
  }
  download(`log-delay-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`, toCsv(rows));
}
/** Minutes are unreadable past an hour or two. */
function fmtDelay(mins) {
  const sign = mins < 0 ? '-' : '';
  const m = Math.abs(mins);
  if (m < 90) return `${sign}${m.toFixed(m < 10 ? 1 : 0)} min`;
  const h2 = m / 60;
  if (h2 < 48) return `${sign}${h2.toFixed(1)} h`;
  return `${sign}${(h2 / 24).toFixed(1)} d`;
}

const pick = (src, keys) => { for (const k of keys) { const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), src); if (v !== undefined && v !== null) return v; } return undefined; };

function hitRows() {
  const c = cluster();
  const rows = ui.hits.map((hit, i) => {
    const s = hit._source || {};
    const ts = pick(s, [c.timeField, '@timestamp', 'timestamp', 'time']);
    const lvl = pick(s, ['level', 'log.level', 'severity', 'loglevel', 'log_level']);
    const hostName = pick(s, ['host.name', 'host.hostname', 'agent.hostname', 'hostname', 'beat.hostname', 'host']);
    const msg = pick(s, ['message', 'log.message', 'msg', 'event.original', 'full_message']);
    const lvlCls = /err|crit|fatal|alert|emerg/i.test(String(lvl)) ? 'red'
      : /warn/i.test(String(lvl)) ? 'yellow' : /info|notice/i.test(String(lvl)) ? 'green' : 'grey';
    const open = ui.expanded.has(hit._id + i);
    return [
      h('tr', {
        id: `log-row-${hit._id}-${i}`,   // so mount() can restore focus after expanding
        style: { cursor: 'pointer' },
        'aria-expanded': String(open),
        ...activatable(() => { const k = hit._id + i; ui.expanded.has(k) ? ui.expanded.delete(k) : ui.expanded.add(k); mount($('#log-rows'), ...hitRows()); }),
      },
        h('td.mono.nowrap', { style: { fontSize: '11.5px' } }, ts ? dt(new Date(ts).getTime()) : '–'),
        h('td', lvl ? h(`span.pill.${lvlCls}`, h('i.dot'), String(lvl)) : h('span.muted', '–')),
        h('td.mono.trunc', { style: { fontSize: '11.5px', maxWidth: '160px' }, title: String(hostName ?? '') }, String(hostName ?? '–')),
        h('td.mono', { style: { fontSize: '11.5px', maxWidth: '780px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: open ? 'pre-wrap' : 'nowrap' } },
          typeof msg === 'string' ? msg : JSON.stringify(s).slice(0, 400)),
        h('td.mono.muted.trunc', { style: { fontSize: '10.5px', maxWidth: '210px' }, title: hit._index }, hit._index)),
      open ? h('tr', h('td', { colspan: 5, style: { background: 'var(--surface-2)' } }, jsonView(hit._source))) : null,
    ];
  }).flat().filter(Boolean);
  return rows;
}

function exportHits() {
  const c = cluster();
  const data = ui.hits.map((hit) => {
    const s = hit._source || {};
    return {
      time: pick(s, [c.timeField, '@timestamp']) || '',
      index: hit._index,
      level: pick(s, ['level', 'log.level', 'severity']) || '',
      host: pick(s, ['host.name', 'agent.hostname', 'hostname']) || '',
      message: typeof pick(s, ['message', 'log.message', 'msg']) === 'string' ? pick(s, ['message', 'log.message', 'msg']) : JSON.stringify(s),
    };
  });
  download(`logs-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`, toCsv(data), 'text/csv');
}

function hitsCardWrapper() {
  return card(`Log events`, `${ui.hits.length} shown${ui.tail ? ' · live tail on' : ''}`,
    h('div.tbl-wrap', h('table.tbl',
      h('thead', h('tr', h('th', 'Time'), h('th', 'Level'), h('th', 'Host'), h('th', 'Message'), h('th', 'Index'))),
      h('tbody#log-rows', ...(ui.hits.length ? hitRows() : [h('tr', h('td', { colspan: 5 }, empty(ui.running ? 'Searching…' : 'No documents in this range')))])))));
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
