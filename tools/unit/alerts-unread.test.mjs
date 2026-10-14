/**
 * A cluster with no data yet is unknown, not unreachable.
 *
 * Regression: ISSUE-003 — for the moments after sign-in, before any cluster's data arrived,
 * alerts() raised a critical "Cluster unreachable" for every cluster (the Clusters summary
 * said "2 critical: Cluster unreachable" beside "none unreachable so far").
 * Found by /qa on 2026-10-14
 * Report: .gstack/qa-reports/run-20261014T120616Z/qa-report-192-168-64-13-2026-10-14.md
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const st = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/state.js')).href);

const config = () => ({ clusters: [
  { id: 'a', name: 'a', url: 'http://a:9200', enabled: true, source: 'file' },
  { id: 'b', name: 'b', url: 'http://b:9200', enabled: true, source: 'file' },
], raw: {} });

test('no data at all raises nothing — unknown is not unreachable', () => {
  st.state.config = config(); st.state.data = new Map();
  assert.deepEqual(st.alerts().filter((x) => x.key.endsWith(':unreachable')).map((x) => x.key), []);
});

test('a cluster that was tried and failed is still unreachable', () => {
  st.state.config = config();
  st.state.data = new Map([['a', { reachable: false, error: { message: 'refused' }, updatedAt: 1 }]]);
  assert.deepEqual(st.alerts().filter((x) => x.key.endsWith(':unreachable')).map((x) => x.key), ['a:unreachable']);
});
