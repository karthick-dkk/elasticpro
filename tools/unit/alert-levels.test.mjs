/**
 * The High level (approved 2026-11-01): critical > high > warning, everywhere a level is
 * sorted, counted, filtered, coloured, sent to Zabbix or blinked on Play.
 *
 *   critical  unchanged — red health, a node left, disk past the high watermark, not answering
 *   high      log delay over 60 min, JVM heap over 85 %, an SLM policy whose last run failed
 *   warning   everything else
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage', 'navigator', 'matchMedia']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
globalThis.indexedDB = undefined;
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

const L = await import(url('ui/js/core/alert-levels.js'));
const R = await import(url('ui/js/core/alert-rules.js'));
const T = await import(url('ui/js/core/alert-tuning.js'));
const G = await import(url('ui/js/core/alert-groups.js'));
const Z = await import(url('ui/js/core/zabbix-alerts.js'));
const H = await import(url('ui/js/core/alert-history.js'));
const st = await import(url('ui/js/core/state.js'));
const acks = await import(url('ui/js/core/acks.js'));
const { DEFAULTS } = await import(url('ui/js/core/config.js'));
const St = await import(url('ui/js/play/status.js'));
const Al = await import(url('ui/js/play/alerts.js'));
const Sp = await import(url('ui/js/play/spotlight.js'));
const Ld = await import(url('ui/js/play/logdelay.js'));
const V = await import(url('ui/js/play/volume.js'));
// The core's shipped levels as LOGDELAY_SETTINGS_GET reports them (test data; the UI keeps none).
const DEFAULT_THRESHOLDS = { noDelayUnder: 15, delayFrom: 30, criticalOver: 60 };

/* ------------------------------- the levels themselves ------------------------------- */

test('three levels, worst first: critical > high > warning; an unknown level ranks as a warning', () => {
  assert.deepEqual(L.LEVELS, ['critical', 'high', 'warning']);
  assert.ok(L.levelRank('critical') > L.levelRank('high') && L.levelRank('high') > L.levelRank('warning'));
  assert.equal(L.levelRank('nonsense'), L.levelRank('warning'));
  assert.equal(L.worstLevel('warning', 'high'), 'high');
  assert.equal(L.worstLevel('high', 'critical'), 'critical');
  assert.equal(L.worstOf([{ level: 'warning' }, { level: 'high' }]), 'high');
  assert.equal(L.worstOf([]), null);
  const sorted = [{ level: 'warning' }, { level: 'critical' }, { level: 'high' }].sort(L.byLevel).map((a) => a.level);
  assert.deepEqual(sorted, ['critical', 'high', 'warning']);
});

test('counts: High is counted, at its own level, and the three add up to the total', () => {
  const list = [{ level: 'critical' }, { level: 'high' }, { level: 'high' }, { level: 'warning' }, { level: undefined }];
  assert.deepEqual(T.alertCounts(list), { total: 5, critical: 1, high: 2, warning: 2 });
  assert.deepEqual(L.countLevels([]), { total: 0, critical: 0, high: 0, warning: 0 });
  assert.equal(L.toneOfCounts({ critical: 0, high: 1, warning: 3 }), 'orange');
  assert.equal(L.toneOfCounts({ critical: 1, high: 1, warning: 0 }), 'red');
  assert.equal(L.toneOfCounts({ critical: 0, high: 0, warning: 0 }), '');
});

/* ------------------------------ which rule is which level ------------------------------ */

test('the registry: what moved to High, and every critical rule left as it was', () => {
  const level = Object.fromEntries(R.ALERT_RULES.map((r) => [r.id, r.level]));
  // Moved: slm-fail critical → high; log-delay critical → high (past the red line); heap is new, high.
  assert.equal(level['slm-fail'], 'high');
  assert.equal(level['log-delay'], 'high');
  assert.equal(level.heap, 'high');
  assert.equal(R.HEAP_HIGH_PERCENT, 85);
  // Unchanged critical.
  for (const id of ['unreachable', 'health', 'disk', 'capacity', 'no-master', 'master-changed', 'repo']) {
    assert.equal(level[id], 'critical', `${id} stays critical`);
  }
  // Unchanged warning.
  for (const id of ['disk-balance', 'disk-unaccounted', 'ilm', 'slm-mode', 'slm-stale', 'automation', 'volume']) {
    assert.equal(level[id], 'warning', `${id} stays a warning`);
  }
});

const policy = (id) => ({ id, last_failure: { time: Date.now() - 1000, details: 'repository_exception' } });
const nodeRow = (name, heap) => ({ name, 'heap.percent': heap === null ? '' : String(heap), cpu: '10', master: '-' });

beforeEach(async () => {
  st.state.defaults = { ...DEFAULTS };
  st.state.config = { clusters: [{ id: 'c1', name: 'prod', url: 'http://es:9200', enabled: true }] };
  st.state.selected = 'all';
  st.state.clients = new Map([['c1', { state: 'online' }]]);
  st.state.data = new Map([['c1', { reachable: true, health: { status: 'green', unassigned_shards: 0 }, repos: [], snapshots: {}, slm: [], nodes: [] }]]);
  await acks.unacknowledge('c1:slm-fail');
  await acks.unacknowledge('c1:heap');
  st.invalidateAlerts();
});

test('state: a failed SLM run is raised High', () => {
  st.state.data.get('c1').slm = [policy('daily')];
  const [a] = st.alerts().filter((x) => x.key.startsWith('c1:slm-fail'));
  assert.equal(a.level, 'high');
});

/** One node reading: a new node list, as each fetch makes — the same values or not. */
const reading = (rows) => { st.state.data.get('c1').nodes = rows.map((r) => ({ ...r })); return st.alerts().filter((x) => x.key === 'c1:heap'); };

test('state: JVM heap over 85 % on two readings in a row is one High alert naming the nodes; 85 or unread is not', () => {
  const rows = [nodeRow('es-1', 91), nodeRow('es-2', 85), nodeRow('es-3', null), nodeRow('es-4', 88)];
  assert.equal(reading(rows).length, 0, 'one reading over the line is not an alert yet');
  const heap = reading(rows);
  assert.equal(heap.length, 1);
  assert.equal(heap[0].level, 'high');
  assert.deepEqual(heap[0].heapNodes.map((n) => n.name), ['es-1', 'es-4'], 'worst first; 85 % is not over 85; unread is not 0');
  assert.match(heap[0].detail, /es-1 91%, es-4 88%/);
  // Recomputing without a new reading (a redraw) is not a reading: still raised, not doubly so.
  assert.equal(st.alerts().filter((x) => x.key === 'c1:heap').length, 1);
  const [m] = st.openAlertsNow().filter((x) => x.family === 'heap');
  assert.deepEqual(m.items.map((i) => [i.label, i.value, i.level]), [['es-1', '91%', 'high'], ['es-4', '88%', 'high']]);
  assert.equal(m.count, 'on 2 nodes');

  // Held between 80 and 85; cleared below 80.
  assert.deepEqual(reading([nodeRow('es-1', 82), nodeRow('es-2', null)])[0].heapNodes.map((n) => n.name), ['es-1'], 'held above the clear line');
  assert.equal(reading([nodeRow('es-1', 79), nodeRow('es-2', null)]).length, 0, 'cleared below 80');
});

test('heap hysteresis: 86, 84, 86, 84 is not four alerts; once raised it holds until under 80', () => {
  const run = (seq) => {
    let s = null, opened = 0, wasUp = false;
    const states = seq.map((pct) => { s = T.heapStep(s, pct); if (s.raised && !wasUp) opened++; wasUp = s.raised; return s.raised; });
    return { opened, states };
  };
  assert.equal(run([86, 84, 86, 84]).opened, 0, 'never two readings in a row over 85: nothing raised, not four episodes');
  const flap = run([86, 86, 84, 86, 84, 86, 81]);
  assert.equal(flap.opened, 1, 'raised once and held through the flapping');
  assert.deepEqual(flap.states, [false, true, true, true, true, true, true]);
  assert.deepEqual(run([86, 86, 79, 86]).states, [false, true, false, false], 'under 80 clears; one reading over starts the count again');
  assert.deepEqual(run([86, NaN, 86]).states, [false, false, true], 'a reading with no heap figure changes nothing');
  assert.equal(R.HEAP_CLEAR_PERCENT, 80);
  assert.equal(R.HEAP_RAISE_READINGS, 2);
  // The same flapping through the rule itself: one alert, open throughout.
  const seen = [86, 86, 84, 86, 84].map((pct) => reading([nodeRow('es-1', pct)]).length);
  assert.deepEqual(seen, [0, 1, 1, 1, 1]);
});

test('state: an acknowledged High leaves every count; a held one was never in them', async () => {
  st.state.data.get('c1').slm = [policy('daily')];
  reading([nodeRow('es-1', 95)]);
  reading([nodeRow('es-1', 95)]);
  st.invalidateAlerts();
  assert.deepEqual(st.openAlertCounts(), { total: 2, critical: 0, high: 2, warning: 0 });
  const m = st.openAlertsNow().find((x) => x.family === 'heap');
  await acks.acknowledgeItems(m.key, m.items.map((i) => i.id));
  st.invalidateAlerts();
  assert.deepEqual(st.openAlertCounts(), { total: 1, critical: 0, high: 1, warning: 0 });
  // Held alerts are never counted, whatever their level.
  const held = G.holdUnreachable([
    { key: 'c1:unreachable', level: 'critical', clusterId: 'c1', family: 'unreachable', state: 'open', items: [], since: 1 },
    { key: 'c1:heap', level: 'high', clusterId: 'c1', family: 'heap', state: 'open', items: [], since: 1, members: [{ cached: true }] }]);
  const sum = G.summaryOf(held, 1);
  assert.equal(sum.high, 0, 'a held High is in no count');
  assert.equal(sum.critical, 1, 'the unreachable line counts once, as critical');
});

/* ------------------------------ Alerts page: filter, sort ------------------------------ */

const merged = (key, level, extra = {}) => ({ key, clusterId: key.split(':')[0], family: key.split(':')[1], level, state: 'open',
  title: key, count: '', detail: '', items: [], since: 1, cluster: { id: key.split(':')[0], name: key.split(':')[0] }, ...extra });

test('Alerts page: the filter has a High of its own; Warning is only warnings', () => {
  const list = [merged('a:disk', 'critical'), merged('a:slm-fail', 'high'), merged('b:heap', 'high'), merged('b:ilm', 'warning')];
  assert.deepEqual(G.filterAlerts(list, { level: 'high' }).map((m) => m.key), ['a:slm-fail', 'b:heap']);
  assert.deepEqual(G.filterAlerts(list, { level: 'warning' }).map((m) => m.key), ['b:ilm']);
  assert.deepEqual(G.filterAlerts(list, { level: 'critical' }).map((m) => m.key), ['a:disk']);
  assert.equal(G.filterAlerts(list, { level: 'all' }).length, 4);
  const sum = G.summaryOf(list, 3);
  assert.deepEqual([sum.critical, sum.high, sum.warning, sum.open], [1, 2, 1, 4]);
});

test('Alerts page: critical, then high, then warning — in a group, flat, and between groups', () => {
  const list = [merged('a:ilm', 'warning'), merged('a:slm-fail', 'high'), merged('a:disk', 'critical'),
    merged('b:heap', 'high'), merged('c:ilm', 'warning'), merged('c:health', 'warning')];
  const flat = G.groupAlerts(list, 'none')[0].alerts.map((m) => m.level);
  assert.deepEqual(flat, ['critical', 'high', 'high', 'warning', 'warning', 'warning']);
  const groups = G.groupAlerts(list, 'cluster');
  assert.deepEqual(groups.map((g) => g.id), ['a', 'b', 'c'], 'a critical group, then a High one, then warnings (even with more alerts)');
  assert.deepEqual(groups[0].alerts.map((m) => m.level), ['critical', 'high', 'warning']);
  assert.deepEqual([groups[0].critical, groups[0].high, groups[0].warning], [1, 1, 1]);
});

test('history keeps the worst level an episode reached', () => {
  const mem = new Map();
  const h = H.createHistory({ storage: { get: () => mem.get('k') || null, set: (v) => mem.set('k', v) } });
  const m = (level) => [{ key: 'c1:log-delay', clusterId: 'c1', rule: 'log-delay', level, items: [] }];
  h.observe(m('warning'), 1000);
  h.observe(m('high'), 2000);
  h.observe(m('warning'), 3000);
  const w = h.window(0, 4000);
  assert.equal(w.open[0].level, 'high');
});

/* ----------------------------------------- Zabbix ----------------------------------------- */

test('Zabbix: High reaches the critical trigger (priority HIGH) and says [High]; the templates are not changed', () => {
  const v = Z.zabbixAlertValues([
    { key: 'c:slm-fail:daily', level: 'high', title: 'daily failed', detail: 'on 09-01' },
    { key: 'c:ilm', level: 'warning', title: 'ilm error' },
    { key: 'c:disk', level: 'critical', title: 'disk 95%' },
    { key: 'c:log-delay', level: 'high', title: 'late' },
    { key: 'c:log-delay', level: 'critical', title: 'later' },
  ]);
  assert.deepEqual(v['slm-fail'], { level: 2, detail: 'critical: [High] daily failed — on 09-01' });
  assert.match(v['slm-fail'].detail, /^critical: /, 'the existing trigger regexp ^critical: still matches');
  assert.deepEqual(v.ilm, { level: 1, detail: 'warning: ilm error' });
  assert.deepEqual(v.disk, { level: 2, detail: 'critical: disk 95%' }, 'critical is sent exactly as before');
  assert.equal(v['log-delay'].detail, 'critical: later | late', 'the worst sets the word, and is named first');
  assert.deepEqual(Z.LEVEL_VALUE, { warning: 1, high: 2, critical: 2 });
  // Heap is the cluster-health template's (its own per-node JVM heap triggers): never sent twice.
  assert.ok(!Z.ZABBIX_ALERT_RULES.includes('heap'));
  assert.ok(Z.COVERED_BY_ZABBIX.heap);
  const tpl = fs.readFileSync(path.join(ROOT, 'deploy/zabbix/template-elasticpro-alerts.yaml'), 'utf8');
  assert.ok(!/\^high: /.test(tpl), 'no High trigger yet: a "high: " detail would raise nothing');
  for (const r of R.ALERT_RULES) {
    assert.ok(Z.ZABBIX_ALERT_RULES.includes(r.id) || Z.COVERED_BY_ZABBIX[r.id], `${r.id} reaches Zabbix one way or the other`);
  }
});

/* ------------------------------------------ Play ------------------------------------------ */

const node = (name, used, total) => ({ node: name, 'disk.used': used, 'disk.total': total, 'disk.avail': total - used, shards: 10 });
const cluster = { id: 'c1', name: 'prod' };
const data = (status, nodes) => ({ reachable: true, updatedAt: 1, health: { status, unassigned_shards: 0, number_of_nodes: nodes.length },
  disk: { nodes, percent: 50 }, clusterSettings: null });
const open = (level, family, title) => ({ level, family, title, items: [], since: 1 });
const easy = [node('a', 10, 100), node('b', 12, 100)];

test('Play status: a High cluster is orange and says "High"; rank critical > high > warning', () => {
  const hi = St.clusterStatus(cluster, data('green', easy), { open: [open('high', 'slm-fail', 'Last SLM run failed')] });
  assert.equal(hi.tone, 'orange');
  assert.equal(hi.word, 'High');
  assert.equal(hi.line, 'High · Last SLM run failed');
  const warn = St.clusterStatus(cluster, data('green', easy), { open: [open('warning', 'ilm', 'ILM')] });
  const crit = St.clusterStatus(cluster, data('green', easy), { open: [open('critical', 'capacity', 'Disk capacity changed')] });
  const red = St.clusterStatus(cluster, data('red', easy), { open: [open('high', 'heap', 'heap')] });
  assert.equal(warn.tone, 'yellow');
  assert.equal(crit.tone, 'red');
  assert.equal(red.tone, 'red', 'red health outranks a High alert');
  assert.ok(crit.rank > hi.rank && hi.rank > warn.rank);
  // Tone first: a green-health cluster with one High alert sorts above a yellow-health cluster
  // with nothing open, and above one with no data.
  const yellowQuiet = St.clusterStatus(cluster, data('yellow', easy), { open: [] });
  const noData = St.clusterStatus(cluster, null, {});
  const warnMany = St.clusterStatus(cluster, data('yellow', easy), { open: Array.from({ length: 40 }, (_, i) => open('warning', 'ilm', `w${i}`)) });
  assert.ok(hi.rank > yellowQuiet.rank, 'High on green outranks yellow health');
  assert.ok(hi.rank > warnMany.rank, 'no number of warnings lifts a yellow tile above a High one');
  assert.ok(yellowQuiet.rank > noData.rank && noData.rank > St.clusterStatus(cluster, data('green', easy), { open: [] }).rank, 'yellow > no data > green');
  assert.equal(St.worstAlert([open('warning', 'ilm', 'w'), open('high', 'heap', 'h'), open('warning', 'x', 'x')]).title, 'h');
});

test('Play blinks: critical → blink-crit, High → blink-high, a node that left wins', () => {
  const crit = { tone: 'red' }, high = { tone: 'orange' }, warn = { tone: 'yellow' };
  assert.equal(St.tileBlink(crit, false), 'blink-crit');
  assert.equal(St.tileBlink(high, false), 'blink-high');
  assert.equal(St.tileBlink(warn, false), '');
  assert.equal(St.tileBlink(crit, true), 'pl-blink');
  assert.equal(St.tileBlink(high, true), 'pl-blink');
  // The node table: one definition of a node's critical disk — the high watermark.
  const f = St.fullestOf(data('green', [node('a', 91, 100), node('b', 20, 100)]));
  assert.equal(St.nodeDiskCritical(91, f), true);
  assert.equal(St.nodeDiskCritical(f.high - 0.1, f), false);
  assert.equal(St.nodeDiskCritical(NaN, f), false);
  assert.equal(Sp.nodeRowBlink(true), '.blink-crit');
  assert.equal(Sp.nodeRowBlink(false), '');
  // Log delay: red is classify's CRITICAL, strictly over the red line.
  assert.equal(Ld.delayRowBlink(61, DEFAULT_THRESHOLDS), '.blink-crit');
  assert.equal(Ld.delayRowBlink(60, DEFAULT_THRESHOLDS), '');
  assert.equal(Ld.delayRowBlink(null, DEFAULT_THRESHOLDS), '', 'unmeasured is not red');
  // Volume: days of disk left under the slide's red line.
  assert.equal(V.runwayTone(V.RUNWAY_RED_DAYS - 1), 'red');
  assert.equal(V.runwayBlink(V.RUNWAY_RED_DAYS - 1), '.blink-crit');
  assert.equal(V.runwayBlink(V.RUNWAY_RED_DAYS), '');
  assert.equal(V.runwayTone(20), 'yellow');
  assert.equal(V.runwayBlink(null), '');
});

test('heap colour: a cell over the High line is orange, the alert\'s colour, and its tooltip says the line', async () => {
  const O = await import(url('ui/js/pages/overview.js'));
  assert.equal(O.heapLevel(86), 'over');
  assert.equal(O.heapLevel(95), 'over', 'past 90 too: the cell says what the alert says');
  assert.equal(O.heapLevel(85), 'low');
  assert.equal(O.heapLevel(50), 'ok');
  assert.match(O.HEAP_TITLE, /over 85 %/);
  const css = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');
  assert.match(css, /\.cl-mini i\.over \{ background: var\(--high\); \}/);
  assert.match(css, /\.pl-bar i\.orange \{ background: var\(--tv-orange\); \}/);
});

test('Play CSS: the blink rates, colour-only keyframes, and a steady highlight for reduced motion', () => {
  const css = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');
  assert.match(css, /\.pl-tile\.blink-crit\s*\{\s*animation:\s*pl-blink-crit 1\.2s/);
  assert.match(css, /\.pl-tile\.blink-high\s*\{\s*animation:\s*pl-blink-high 2\.4s/);
  assert.match(css, /tr\.blink-crit > td, \.pl-root td\.blink-crit \{ animation: pl-blink-cell 1\.2s/);
  for (const k of ['pl-blink-crit', 'pl-blink-high', 'pl-blink-cell']) {
    const body = css.slice(css.indexOf(`@keyframes ${k}`), css.indexOf('}\n}', css.indexOf(`@keyframes ${k}`)));
    assert.ok(body.length > 0, `${k} keyframes`);
    assert.ok(!/width|height|margin|padding|transform|top|left/.test(body.replace(/background/g, '')), `${k} animates colour only`);
  }
  const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  for (const sel of ['.pl-tile.blink-crit', '.pl-tile.blink-high', '.pl-blink', 'tr.blink-crit > td']) {
    assert.ok(reduce.includes(sel), `${sel} is held still under prefers-reduced-motion`);
  }
  assert.match(reduce, /animation: none/);
  assert.match(css, /--tv-orange:\s*#ff8c42/);
  assert.match(css, /\.pl-arow\.high \{/);
  assert.match(css, /\.pl-nodes td\.pl-node \{ border-left: \.3em solid transparent; \}/, 'every node row keeps the bar, so columns stay put');
});

test('Play Alerts slide: HIGH rows, ordered between critical and warning; Open now counts High', () => {
  const list = [merged('a:ilm', 'warning'), merged('a:slm-fail', 'high'), merged('b:disk', 'critical')];
  const ctx = {
    now: 10, tz: null, merged: list, clusters: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
    acked: () => null, openSince: (m) => m.since, takeover: null, sharedAcks: false, heldBy: new Map(), afterMount: () => {},
  };
  const el = Al.render(ctx);
  const rows = [...el.querySelectorAll('.pl-arow')];
  assert.deepEqual(rows.map((r) => r.querySelector('.pl-sev').textContent), ['CRIT', 'HIGH', 'WARN']);
  assert.ok(rows[1].classList.contains('high'));
  const kpis = Object.fromEntries([...el.querySelectorAll('.pl-aside .pl-kpi')].map((k) => [k.querySelector('.pl-k').textContent, k]));
  assert.deepEqual(['Critical', 'High', 'Warning', 'Acknowledged'].map((k) => kpis[k] && kpis[k].querySelector('.pl-v').textContent), ['1', '1', '1', '0']);
  assert.ok(kpis.High.classList.contains('orange'));
});
