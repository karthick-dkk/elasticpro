/**
 * The app never uses the browser's own alert(), confirm() or prompt(). They are unstyled,
 * title themselves with the server's address, block the page, and are refused outright in
 * some frames (Zabbix). Messages are toasts; questions are the app's own dialogs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const UI = path.resolve(import.meta.dirname, '../../ui/js');
const files = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));

test('no alert(), confirm() or prompt() anywhere in the UI', () => {
  const hits = [];
  for (const f of files(UI)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      if (/(^|[^.\w$])(window\.)?(alert|confirm|prompt)\s*\(/.test(code)) hits.push(`${path.relative(UI, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
