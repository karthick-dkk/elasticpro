/** The resources widget's wiring, and its controller (test/view.test.php) run with PHP. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.resolve(import.meta.dirname, '..');

test('the manifest names the widget, its controller and the Columns action', () => {
  const m = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
  assert.equal(m.id, 'ep_resources');
  assert.equal(m.widget.js_class, 'WidgetEpResources');
  const js = fs.readFileSync(path.join(HERE, 'assets/js/class.widget.js'), 'utf8');
  assert.ok(js.includes('class WidgetEpResources extends CWidget'));
  assert.ok(js.includes('EpColumns.init') && js.includes('EpExport.bind'));
  assert.ok(m.actions['widget.ep_resources.view']);
  assert.equal(m.actions['widget.ep_resources.columns'].class, 'ColumnsSave');
});

test('the view offers what the controller sends: expand, type filter, columns, servers export', () => {
  const v = fs.readFileSync(path.join(HERE, 'views/widget.view.php'), 'utf8');
  for (const hook of ['data-ep-expand', 'data-ep-expand-all', 'data-ep-type-filter', 'data-ep-columns', "'csv-servers'", 'data-parent', "setVar('ep_meta'"]) {
    assert.ok(v.includes(hook), hook);
  }
});

test('WidgetView against a fake Zabbix (PHP)', (t) => {
  const local = spawnSync('php', ['test/view.test.php'], { cwd: HERE, encoding: 'utf8' });
  const r = local.error
    ? spawnSync('docker', ['run', '--rm', '-v', `${HERE}:/m:ro`, '-w', '/m', 'php:8.4-cli-alpine', 'php', 'test/view.test.php'], { encoding: 'utf8' })
    : local;
  if (r.error || /Cannot connect to the Docker daemon/.test(r.stderr || '')) { t.skip('no php and no docker here — run test/view.test.php where PHP is'); return; }
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
