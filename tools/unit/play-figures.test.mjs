/**
 * Play's figures, from existing pieces: the status line ("Red · disk 91 % on es-hot-03"),
 * the spotlight's critical-problem tests, the alert order and the last 24 h, and the
 * volume sums — each said with what it covers, unknown never read as 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const St = await import(url('ui/js/play/status.js'));
const V = await import(url('ui/js/play/volume.js'));
const Al = await import(url('ui/js/play/alerts.js'));

const node = (name, used, total) => ({ node: name, 'disk.used': used, 'disk.total': total, 'disk.avail': total - used, shards: 10 });
const cluster = { id: 'c1', name: 'prod' };
const data = (status, nodes) => ({ reachable: true, updatedAt: 1, health: { status, unassigned_shards: 3, number_of_nodes: nodes.length },
  disk: { nodes, percent: 50 }, clusterSettings: null });

test('status line: health word, then the fullest node past its high watermark, and where', () => {
  const s = St.clusterStatus(cluster, data('red', [node('es-hot-03', 91, 100), node('es-hot-01', 40, 100)]), { open: [] });
  assert.equal(s.line, 'Red · disk 91 % on es-hot-03');
  assert.equal(s.tone, 'red');
  const g = St.clusterStatus(cluster, data('green', [node('a', 10, 100), node('b', 12, 100)]), { open: [] });
  assert.equal(g.line, 'Green');
  assert.equal(g.tone, 'green');
  const y = St.clusterStatus(cluster, data('yellow', [node('a', 10, 100), node('b', 12, 100)]), {
    open: [{ level: 'warning', family: 'health', title: 'Cluster health yellow', items: [], since: 1 }] });
  assert.equal(y.line, 'Yellow · 3 unassigned shards');
  const left = St.clusterStatus(cluster, data('green', [node('a', 10, 100), node('b', 12, 100)]), { open: [], nodes: { left: [{ node: 'es-warm-2', since: 1 }] } });
  assert.equal(left.line, 'Green · node left on es-warm-2');
  assert.ok(left.rank > g.rank);
  assert.equal(St.clusterStatus(cluster, null, {}).line, 'No data');
  assert.equal(St.clusterStatus(cluster, { reachable: false, updatedAt: 1 }, {}).line, 'Not answering · offline');
});

test('spotlight tests: only the ones turned on; a ULM cluster with SLM not used is never "no good backup"', () => {
  const now = 100 * 3600000;
  const d = { ...data('red', [node('a', 95, 100), node('b', 10, 100)]), repos: [{ name: 'r' }], snapshots: { r: [] } };
  const all = ['red', 'nodeLeft', 'slmFailed', 'storage', 'unreachable', 'criticalAlert'];
  assert.deepEqual(St.spotlightReasons(cluster, d, { when: all, staleMs: 26 * 3600000, now }).sort(), ['red', 'slmFailed', 'storage']);
  assert.deepEqual(St.spotlightReasons({ ...cluster, type: 'CI' }, d, { when: all, staleMs: 26 * 3600000, now }).sort(), ['red', 'storage']);
  assert.deepEqual(St.spotlightReasons(cluster, d, { when: ['yellow'], staleMs: 1, now }), []);
  assert.deepEqual(St.spotlightReasons(cluster, { reachable: false, updatedAt: 1 }, { when: all, now }), ['unreachable']);
});

test('alerts: open before acknowledged, critical first, then newest; the last 24 h from the history', () => {
  const list = [{ key: 'a', level: 'warning', s: 5 }, { key: 'b', level: 'critical', s: 1 }, { key: 'c', level: 'critical', s: 9, ack: true }, { key: 'd', level: 'critical', s: 3 }];
  assert.deepEqual(Al.alertOrder(list, { acked: (m) => !!m.ack, since: (m) => m.s }).map((m) => m.key), ['d', 'b', 'a', 'c']);
  const now = 10 * 86400000;
  const win = { since: 0, open: [{ key: 'x', clusterId: 'c1', rule: 'disk', start: now - 3600000 }],
    closed: [{ key: 'y', clusterId: 'c1', rule: 'health', start: now - 2 * 86400000, end: now - 3600000 },
      { key: 'z', clusterId: 'gone', rule: 'health', start: now - 1000, end: now - 500 }] };
  const day = Al.lastDay(win, new Set(['c1']), now);
  assert.equal(day.raised, 1);
  assert.equal(day.resolved, 1);
  assert.equal(day.longest.key, 'y', 'an excluded cluster counts nowhere');
  assert.equal(day.partial, false);
});

test('volume: sums over the clusters that have the figure, and what they cover', () => {
  const reply = { settings: { sizeBasis: 'primary' }, cards: { yesterday: { day: '2026-10-30', value: 100, changeVsAvgPct: 25 }, average: { value: 80 }, monthSoFar: { value: 3000 } },
    days: [{ day: '2026-10-30', indices: 4, priBytes: 100, docs: 10, live: true }, { day: '2026-10-29', docs: 5, live: true }, { day: '2026-09-01', docs: 99, live: false }] };
  assert.deepEqual(V.cardsOf(reply), { yesterday: 100, average: 80, month: 3000, change: 25 });
  assert.equal(V.totalEvents(reply), 15);
  assert.equal(V.totalEvents({ days: [{ day: 'x', docs: null, live: true }] }), null, 'nothing counted is unknown');
  assert.deepEqual(V.yesterdayRow(reply), { day: '2026-10-30', indices: 4, size: 100 });
  const f = V.fleetVolume([V.cardsOf(reply), { yesterday: 50, average: null, month: null, change: null }, null]);
  assert.deepEqual(f.yesterday, { value: 150, of: 2 });
  assert.deepEqual(f.average, { value: 80, of: 1 });
  assert.equal(f.change, 25, 'the change only over clusters with both figures');
  assert.deepEqual(V.fleetVolume([null]).yesterday, { value: null, of: 0 });
});
