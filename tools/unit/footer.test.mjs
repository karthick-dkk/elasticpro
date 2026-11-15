/**
 * The footer (app.js appFooter): its version is the running core's and nothing else — no version
 * literal anywhere in the shell, and "ElasticPro" alone before PING answers (the owner, 2026-11-15).
 * The DOM side is in behaviour-check.mjs; this reads the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');

test('the shell writes no version number: the footer reads PING', () => {
  // Comments name the releases a route or a message came in; code never writes a version next to the name.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /ElasticPro v?\d/, 'a version written next to the name');
  assert.doesNotMatch(code.slice(code.indexOf('function appFooter'), code.indexOf('function paintFooter')), /\d+\.\d+\.\d+/, 'a version literal in the footer');
  const foot = src.slice(src.indexOf('function footerVersion'), src.indexOf('function paintFooter'));
  assert.match(foot, /coreInfo\.version/, 'the footer reads the core’s version');
  assert.match(foot, /return v \? `ElasticPro \$\{v\}` : 'ElasticPro'/, 'the version when the core said one, "ElasticPro" alone before — never a placeholder');
});

test('the footer is in the flow (no fixed position) and not on Play', () => {
  const css = fs.readFileSync(path.join(ROOT, 'ui/css/app.css'), 'utf8');
  const block = css.slice(css.indexOf('.app-foot {'), css.indexOf('html.play .app-foot'));
  assert.doesNotMatch(block, /position:\s*(fixed|sticky|absolute)/, 'the footer must not be positioned over the page');
  assert.match(css, /html\.play \.app-foot \{ display: none; \}/);
  assert.match(block, /#4b5563/, 'the owner’s grey, the same in every theme');
});
