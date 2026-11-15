/**
 * The Indices page's name search (ui/js/core/index-match.js): plain text is "contains", `*` and
 * `?` are an anchored glob, commas are "any of", and `!` or the toggle turn it round.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { indexQuery } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/index-match.js')).href);

const NAMES = ['logstash-alpha-2026.09.09', 'logstash-beta-2026.09.10', 'metrics-2026.09', '.kibana_1', 'Logs-A.b+c'];
const pick = (text, opts) => NAMES.filter(indexQuery(text, opts).test);

test('nothing typed matches every name, the toggle on or off', () => {
  for (const t of ['', '  ', '!', ' , ,', '!,']) {
    assert.deepEqual(pick(t), NAMES, `"${t}"`);
    assert.deepEqual(pick(t, { not: true }), NAMES, `"${t}" inverted`);
    assert.equal(indexQuery(t).active, false);
  }
});

test('plain text is "contains", case-insensitive, as before', () => {
  assert.deepEqual(pick('BETA'), ['logstash-beta-2026.09.10']);
  assert.deepEqual(pick('2026.09'), NAMES.slice(0, 3));
});

test('* and ? are a glob over the whole name; regex characters are only themselves', () => {
  assert.deepEqual(pick('logstash-*'), NAMES.slice(0, 2));
  assert.deepEqual(pick('*-2026.09'), ['metrics-2026.09'], 'anchored at the end too');
  assert.deepEqual(pick('metrics-2026.0?'), ['metrics-2026.09']);
  assert.deepEqual(pick('metrics-2026?09'), ['metrics-2026.09'], '? is any one character');
  assert.deepEqual(pick('metrics-2026.?'), [], '? is exactly one character');
  assert.deepEqual(pick('logs-a.b+c*'), ['Logs-A.b+c'], '. and + are literal');
  assert.deepEqual(pick('logs-a?b+c'), ['Logs-A.b+c']);
  assert.deepEqual(pick('logs-a.b+?'), ['Logs-A.b+c']);
  assert.deepEqual(pick('metrics.2026*'), [], 'a dot in the pattern is a dot, not any character');
});

test('comma-separated: any of them', () => {
  assert.deepEqual(pick('metrics-*, .kib'), ['metrics-2026.09', '.kibana_1']);
});

test('a leading ! or the toggle: the names matching none of them; both is still "not matching"', () => {
  const rest = ['metrics-2026.09', '.kibana_1', 'Logs-A.b+c'];
  assert.deepEqual(pick('!logstash-*'), rest);
  assert.deepEqual(pick('logstash-*', { not: true }), rest);
  assert.deepEqual(pick('!logstash-*', { not: true }), rest);
  assert.deepEqual(pick('! logstash-*, metrics'), ['.kibana_1', 'Logs-A.b+c']);
  // every name is in exactly one of the two lists
  for (const t of ['logstash-*', 'beta', '*.09*,kib']) assert.equal(pick(t).length + pick(t, { not: true }).length, NAMES.length, t);
});

test('the label says what is shown', () => {
  assert.equal(indexQuery('logstash-*', { not: true }).label, 'not matching logstash-*');
  assert.equal(indexQuery('!a, b').label, 'not matching a, b');
  assert.equal(indexQuery('a').label, 'matching a');
  assert.equal(indexQuery('').label, '');
});
