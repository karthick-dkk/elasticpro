/**
 * One word per state.
 *
 * "Asking…", "Checking…", "Loading…", "checking…", "loading…", "waiting…", "fetching…" —
 * seven spellings of one state across the pages, in two capitalisations. Each was
 * individually reasonable, which is why it drifted: nobody writing one of them was
 * looking at the other six.
 *
 * The rule is about states, not about vocabulary:
 *
 *   * **Loading…** — data has not arrived yet. Always this, never a synonym.
 *   * **Working…** — an action the person started is running. A different state: the
 *     app is changing something rather than waiting on something.
 *   * **A named verb** — "Measuring…", "Checking for dangling indices…". Allowed only
 *     when it says something a generic word would lose: that this is slow, or that it
 *     is many calls, or exactly what is being done.
 *
 * So what is banned is a *bare* one-word wait that is a synonym for loading.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const UI = path.join(ROOT, 'ui/js');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

/** A bare one-word wait string: 'loading…', 'Checking…', and so on. */
const BARE_WAIT = /'([A-Za-z]+)(?:…|\\u2026)'/g;
const SYNONYMS = ['loading', 'checking', 'asking', 'fetching', 'waiting', 'querying', 'reading'];
const ALLOWED = ['Loading…', 'Working…'];

test('a bare wait is always "Loading…", never a synonym', () => {
  const offenders = [];
  for (const file of jsFiles(UI)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(BARE_WAIT)) {
      const word = m[1];
      if (!SYNONYMS.includes(word.toLowerCase())) continue;
      if (ALLOWED.includes(`${word}…`)) continue;
      offenders.push(`${path.relative(ROOT, file)}: '${word}…'`);
    }
  }
  assert.deepEqual(offenders, [],
    `these say something other than "Loading…" for the same state:\n  ${offenders.join('\n  ')}`);
});

test('the loading word is actually used somewhere, so the rule is not vacuous', () => {
  // A check that can only pass by finding nothing is a check that passes when the code
  // is deleted. This one has to see the real string to be worth having.
  const found = jsFiles(UI).filter((f) => fs.readFileSync(f, 'utf8').includes("'Loading…'"));
  assert.ok(found.length >= 5,
    `only ${found.length} file(s) use 'Loading…' — the standard is not actually applied`);
});

test('capitalisation is consistent', () => {
  const lower = [];
  for (const file of jsFiles(UI)) {
    const src = fs.readFileSync(file, 'utf8');
    if (/'loading…'/.test(src)) lower.push(path.relative(ROOT, file));
  }
  assert.deepEqual(lower, [], `lower-case "loading…" in: ${lower.join(', ')}`);
});
