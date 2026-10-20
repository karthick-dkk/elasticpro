/** The live tail never stacks searches: a tick while the last one is out is skipped. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { tailTick } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/tail.js')).href);

test('a slow search under a fast tail: one search at a time', async () => {
  let running = false;
  let started = 0;
  const search = () => { running = true; started++; setTimeout(() => { running = false; }, 50); };
  const ticks = [];
  for (let i = 0; i < 6; i++) { ticks.push(tailTick(() => running, search)); await new Promise((r) => setTimeout(r, 20)); }
  assert.ok(started >= 2 && started <= 3, `searches started: ${started}`);
  assert.ok(ticks.includes(false), 'some ticks were skipped');
});
