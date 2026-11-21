#!/usr/bin/env node
/**
 * Unit tests for the parts of the UI that are just arithmetic.
 *
 *   node tools/unit-check.mjs
 *
 * `check-ui` resolves imports, `render-check` draws pages and `behaviour-check` drives
 * them. All three need a browser-shaped world; two of them need a live bridge and a mock
 * cluster. None of that is any use for asserting that a delay of -45 minutes classifies
 * as CLOCK_AHEAD, and the cost of the setup is why fine-grained cases never get written.
 *
 * So: pure modules only. No DOM, no network, no fixtures. Anything that needs those
 * belongs in one of the other three. node:test is stdlib, so this adds no dependency —
 * which is the constraint that rules out every off-the-shelf runner.
 */

import { run } from 'node:test';
import { tap } from 'node:test/reporters';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findJsdom, jsdomRequired } from './lib/jsdom-app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tools', 'unit');
const files = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(DIR, f))
  : [];

if (!files.length) {
  console.log('unit-check: no test files in tools/unit — nothing to run.');
  process.exit(0);
}

// A few files build DOM nodes and import jsdom. Without it they fail outright; say why up front,
// and with CI set or --require-jsdom stop here with that reason instead of a page of stack traces.
const domFiles = files.filter((f) => /from 'jsdom'|import\('jsdom'\)/.test(fs.readFileSync(f, 'utf8')));
if (domFiles.length && !findJsdom([ROOT, process.cwd()]).entry) {
  const names = domFiles.map((f) => path.basename(f)).join(', ');
  if (jsdomRequired()) {
    console.error(`unit-check: jsdom not found — FAILED (required: CI is set or --require-jsdom was passed); ${domFiles.length} file(s) need it: ${names}  (npm i jsdom)`);
    process.exit(1);
  }
  console.error(`unit-check: jsdom not found — ${domFiles.length} file(s) that build DOM nodes will fail: ${names}  (npm i jsdom)`);
}

let failed = 0;
const stream = run({ files, concurrency: true });
stream.on('test:fail', () => { failed++; });
stream.compose(tap).pipe(process.stdout);
stream.on('end', () => {
  if (failed) {
    console.error(`\nunit-check: ${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\nok: ${files.length} unit file(s) passed`);
});
