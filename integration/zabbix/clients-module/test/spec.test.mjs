/**
 * Runs test/spec.test.php (the Clients page's form rules and macros) with PHP — local php, or
 * a php:8.4-cli container — and skips, saying so, when neither is available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.resolve(import.meta.dirname, '..');

test('ClientSpec (PHP)', (t) => {
  const local = spawnSync('php', ['test/spec.test.php'], { cwd: HERE, encoding: 'utf8' });
  const r = local.error
    ? spawnSync('docker', ['run', '--rm', '-v', `${HERE}:/m:ro`, '-w', '/m', 'php:8.4-cli-alpine', 'php', 'test/spec.test.php'], { encoding: 'utf8' })
    : local;
  if (r.error || /Cannot connect to the Docker daemon/.test(r.stderr || '')) { t.skip('no php and no docker here — run test/spec.test.php where PHP is'); return; }
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
