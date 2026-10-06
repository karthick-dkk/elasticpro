/** The capacity widget's column list, and its Columns / Type-filter wiring. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');

test('every column the widget draws is one the master template defines', () => {
  const cols = JSON.parse(fs.readFileSync(path.join(HERE, 'columns.json'), 'utf8'));
  assert.equal(cols.template, 'ElasticPro client master');
  assert.equal(cols.columns.length, 31);
  // When storage fills is read the Cluster Management way (shared Forecast), not as a raw figure.
  assert.deepEqual(cols.columns.filter((c) => c.kind === 'forecast').map((c) => c.key), ['ep.es.storage.full_in']);
  assert.equal(cols.warn, 80);
  assert.equal(cols.high, 90);
  // Requested and purchased columns are marked, so 0 can be shown as "not set".
  assert.deepEqual(cols.columns.filter((c) => c.kind === 'requested').map((c) => c.label),
    ['Cust.Purchased Storage', 'Cust.Purchased Devices', 'ES CPU Requested', 'ES Mem Requested', 'Parser CPU Requested', 'Parser Mem Requested',
     'Forwarder Mem Requested', 'Forwarder CPU Requested', 'Forwarder Requested / Storage']);
});

test('its family keys are the master template\'s: families es, parser and fwd exist in the default roles', () => {
  const cols = JSON.parse(fs.readFileSync(path.join(HERE, 'columns.json'), 'utf8')).columns;
  const roles = fs.readFileSync(path.join(HERE, '..', 'shared/php/Roles.php'), 'utf8');
  for (const c of cols.filter((c) => c.key && !c.key.startsWith('ep.delay') && !c.key.startsWith('ep.es.storage') && !c.key.startsWith('ep.devices'))) {
    const m = c.key.match(/^ep\.([a-z_]+)\.(servers|cpu|mem|disk)\.(requested|allocated|usage|used)$/);
    assert.ok(m, c.key);
    assert.match(roles, new RegExp(`'id' => '${m[1]}'`), `family ${m[1]} is not a default family`);
  }
});

test('the controller applies the column settings and hands the dialog its meta', () => {
  const php = fs.readFileSync(path.join(HERE, 'actions/WidgetView.php'), 'utf8');
  assert.match(php, /ColumnSettings::load\('capacity'\)/);
  assert.match(php, /'types' =>/);
  const view = fs.readFileSync(path.join(HERE, 'views/widget.view.php'), 'utf8');
  for (const hook of ['data-ep-type-filter', 'data-ep-columns', "setVar('ep_meta'", "'data-type'"]) assert.ok(view.includes(hook), hook);
  assert.ok(fs.readFileSync(path.join(HERE, 'assets/js/class.widget.js'), 'utf8').includes('EpColumns.init'));
});
