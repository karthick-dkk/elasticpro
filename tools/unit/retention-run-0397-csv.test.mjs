/**
 * The Capacity CSV says what the Live retention cell says beside its number (0.3.97 review):
 * where the count starts and which older days were left out. An export for auditors must not
 * hide what the screen names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Event', 'CustomEvent', 'customElements', 'localStorage', 'navigator']) {
  try { globalThis[k] = k === 'window' ? dom.window : dom.window[k]; } catch (_) { /* read-only in this Node */ }
}
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const V = await at('ui/js/core/volume.js');
const CAP = await at('ui/js/reports/capacity.js');
const T = await at('ui/js/reports/table.js');

const TODAY = '2026-11-26';
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const run = []; for (let t = Date.parse('2026-10-01T00:00:00Z'); t <= Date.parse(`${TODAY}T00:00:00Z`); t += DAY) run.push(iso(t));
const LIVE = [...Array.from({ length: 5 }, (_, i) => ({ index: `logstash-app${i}-2025.05.03`, day: '2025-05-03', size: 10 })),
  ...run.map((d) => ({ index: `logstash-${d.replaceAll('-', '.')}`, day: d, size: 100 }))];

test('Live retention in the CSV: the number, where it starts, and the left-out days in the same words as the cell', () => {
  const def = CAP.capacityDefs().find((d) => d.key === 'liveRetention');
  const held = V.liveHeldDays(LIVE, {}, TODAY);
  const { headers, rows } = T.layoutCsv([def], null, [{ held }, { held: V.liveHeldDays(LIVE.slice(5), {}, TODAY) }, { held: { days: 30, from: null, source: 'ILM' } }, { held: null }]);
  assert.deepEqual(headers, ['Live retention (days)', 'Live retention from', 'Live retention older days left out']);
  assert.deepEqual(Object.values(rows[0]), [57, '2026-10-01', '5 indices on 1 older day (2025-05-03) left out: 515 days with no index before 2026-10-01']);
  assert.deepEqual(Object.values(rows[1]), [57, '2026-10-01', 'none']);
  assert.deepEqual(Object.values(rows[2]), [30, 'ILM delete age', null], 'ILM: nothing is left out, so nothing is said');
  assert.deepEqual(Object.values(rows[3]), [null, null, null], 'not measured stays blank');
});
