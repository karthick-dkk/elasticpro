/** Percentages (lib/fmt.js pct, the one definition): all and none only when exactly so. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const at = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
const { pct, sharePct, diskUseText } = await at('ui/js/lib/fmt.js');
const L = await at('ui/js/core/logdelay-report.js');

test('100 % with one missing and 0 % with one present are never said', () => {
  assert.equal(sharePct(1999, 2000), '>99.9%');
  assert.equal(sharePct(199, 200), '99.5%');
  assert.equal(sharePct(2000, 2000), '100%');
  assert.equal(sharePct(1, 5000), '<0.1%');
  assert.equal(sharePct(1, 250), '0.4%');
  assert.equal(sharePct(0, 250), '0%');
  assert.equal(pct(99.97), '>99.9%');
  assert.equal(pct(0.02, 1, ' '), '<0.1 %');
  assert.equal(pct(12.34), '12.3%');
  assert.equal(pct(104.2, 0), '104%');
  assert.equal(pct(null), '–');
  assert.equal(sharePct(null, 10), '–');
  assert.equal(sharePct(1, 0), '–');
});

test('Log Delay and the disk text use it', () => {
  assert.equal(L.pctText(99.98), '>99.9 %');
  assert.equal(L.pctText(0.01), '<0.1 %');
  assert.equal(L.pctText(null), '—');
  assert.match(diskUseText({ percent: 99.8, used: 998, total: 1000 }), /^99\.8 %/);
});
