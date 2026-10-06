/**
 * The widgets' export (ep-export.js) and spreadsheet writer (ep-xlsx.js), run as the
 * browser runs them — plain scripts on a window — and every widget's copy of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(HERE, '..');
const ctx = { window: {}, TextEncoder, Uint8Array, Uint32Array, DataView, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, 'ep-xlsx.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(HERE, 'ep-export.js'), 'utf8'), ctx);
const X = ctx.window.EpExport;
const plain = (v) => JSON.parse(JSON.stringify(v));   // built inside the sandbox

test('CSV: quoted where needed, unknown left empty, never a formula', () => {
  const csv = X.csv(['Cluster Name', 'ES URL', 'ES Used % (%)'], [['acme, inc', '=HYPERLINK("x")', 81.5], ['lab', 'http://es', null]]);
  assert.equal(csv, 'Cluster Name,ES URL,ES Used % (%)\r\n"acme, inc","\'=HYPERLINK(""x"")",81.5\r\nlab,http://es,\r\n');
});

test('Excel: numbers stay numbers, unknowns stay empty, text that looks like a formula is text', () => {
  const rows = X.xlsxRows(['A', 'B'], [[1.5, null], ['+cmd', 'ok']]);
  assert.deepEqual(plain(rows), [['A', 'B'], [1.5, null], ["'+cmd", 'ok']]);
  const bytes = ctx.window.EpXlsx.workbook([{ name: 'Sheet', rows }]);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4b, 'a ZIP, as an .xlsx is');
  assert.match(Buffer.from(bytes).toString('latin1'), /<c r="A2"><v>1\.5<\/v><\/c><c r="B2"\/>/, 'a number, then an empty cell — not a zero');
});

test('the file is named for what it is and when it was taken', () => {
  assert.equal(X.filename('volume-report', 'xlsx', new Date(2026, 8, 26, 9, 5)), 'volume-report-2026-09-26_0905.xlsx');
});

test('every widget carries the shared scripts exactly', async () => {
  const { SHARED, WIDGETS } = await import(pathToFileURL(path.join(ROOT, 'sync-assets.mjs')).href);
  for (const w of WIDGETS) {
    for (const f of SHARED) {
      assert.equal(fs.readFileSync(path.join(ROOT, w, 'assets/js', f), 'utf8'), fs.readFileSync(path.join(HERE, f), 'utf8'),
        `${w}/assets/js/${f} differs from shared/ — run: node sync-assets.mjs`);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, w, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.assets.js.slice(0, SHARED.length), SHARED, `${w}: the shared scripts must load before the widget's own`);
  }
});

test('the spreadsheet writer is still ElasticPro’s ui/js/lib/xlsx.js', (t) => {
  const original = path.resolve(ROOT, '../../ui/js/lib/xlsx.js');
  if (!fs.existsSync(original)) { t.skip('ui/js/lib/xlsx.js not found — run from the ElasticPro repository'); return; }
  const strip = (s) => s.replace(/^export (function|const)/gm, '$1').trim();
  assert.ok(fs.readFileSync(path.join(HERE, 'ep-xlsx.js'), 'utf8').includes(strip(fs.readFileSync(original, 'utf8'))),
    'copy drifted: re-copy ui/js/lib/xlsx.js into shared/ep-xlsx.js');
});

test('the modules use only Zabbix constants confirmed to exist in Zabbix 7.0', () => {
  // PHP's syntax check cannot see an undefined constant; Zabbix finds it at run time, as a
  // widget stuck loading. ZBX_STYLE_NOTHING_TO_SHOW was one: it does not exist in 7.0.
  // Confirmed against include/defines.inc.php of Zabbix 7.0.31. Add one here only after checking it there.
  const CONFIRMED = new Set(['API_OUTPUT_COUNT', 'INTERFACE_PRIMARY', 'INTERFACE_TYPE_AGENT', 'INTERFACE_USE_DNS', 'INTERFACE_USE_IP',
    'ITEM_STATE_NORMAL', 'ITEM_VALUE_TYPE_FLOAT', 'ITEM_VALUE_TYPE_UINT64', 'USER_TYPE_SUPER_ADMIN', 'USER_TYPE_ZABBIX_ADMIN', 'USER_TYPE_ZABBIX_USER', 'TAG_OPERATOR_EQUAL', 'ZBX_REPORT_PERIOD_WEEK', 'ZBX_REPORT_CYCLE_WEEKLY', 'ZBX_REPORT_STATUS_ENABLED', 'ZBX_WIDGET_FIELD_TYPE_GROUP', 'GROUP_GUI_ACCESS_DISABLED', 'PERM_READ', 'MEDIA_STATUS_ACTIVE', 'MEDIA_TYPE_EMAIL', 'MEDIA_TYPE_STATUS_ACTIVE', 'EVENT_SOURCE_TRIGGERS', 'ACTION_STATUS_ENABLED', 'ACTION_PAUSE_SUPPRESSED_TRUE', 'CONDITION_EVAL_TYPE_AND_OR', 'ZBX_CONDITION_TYPE_HOST_GROUP', 'CONDITION_OPERATOR_EQUAL', 'OPERATION_TYPE_MESSAGE', 'OPERATION_TYPE_RECOVERY_MESSAGE', 'ZBX_MACRO_TYPE_SECRET',
    'ZBX_MACRO_TYPE_VAULT', 'ZBX_STYLE_BTN_ALT', 'ZBX_STYLE_LIST_TABLE', 'ZBX_TEXTAREA_SMALL_WIDTH', 'ZBX_TEXTAREA_STANDARD_WIDTH',
    'ZBX_TEXTAREA_TINY_WIDTH', 'HOST_INVENTORY_AUTOMATIC', 'HOST_INVENTORY_DISABLED', 'ZBX_MONITORED_BY_SERVER',
    'ZBX_MONITORED_BY_PROXY', 'ZBX_MONITORED_BY_PROXY_GROUP', 'ZBX_SIDEBAR_VIEW_MODE_COMPACT', 'ZBX_TM_TASK_CHECK_NOW',
    'ITEM_STATE_NOTSUPPORTED', 'HOST_STATUS_MONITORED', 'HOST_STATUS_NOT_MONITORED', 'MAINTENANCE_TYPE_NORMAL', 'MAINTENANCE_TYPE_NODATA',
    'TIMEPERIOD_TYPE_ONETIME', 'TRIGGER_VALUE_TRUE', 'TRIGGER_SEVERITY_HIGH']);
  const used = new Set();
  const scan = (dir) => {
    for (const f of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!['test', 'assets'].includes(f.name)) scan(p); continue; }
      if (!f.name.endsWith('.php')) continue;
      for (const m of fs.readFileSync(p, 'utf8').matchAll(/\b(ZBX_[A-Z_]+|ITEM_[A-Z0-9_]+|USER_TYPE_[A-Z_]+|INTERFACE_[A-Z_]+|API_OUTPUT_[A-Z_]+|HOST_INVENTORY_[A-Z_]+|HOST_STATUS_[A-Z_]+|MAINTENANCE_[A-Z_]+|TIMEPERIOD_[A-Z_]+|TRIGGER_[A-Z_]+)\b/g)) {
        used.add(`${path.relative(ROOT, p)}: ${m[1]}`);
      }
    }
  };
  for (const w of ['capacity-widget', 'volume-widget', 'resources-widget', 'clients-module']) scan(path.join(ROOT, w));
  const unknown = [...used].filter((u) => !CONFIRMED.has(u.split(': ')[1]));
  assert.deepEqual(unknown, []);
});

test('every module has the shared styles, PHP and the Columns action, as sync-assets.mjs writes them', async () => {
  const { WIDGETS, SHARED_CSS, SHARED_PHP, SHARED_ACTIONS, PHP_MODULES, phpFor } = await import(pathToFileURL(path.join(ROOT, 'sync-assets.mjs')).href);
  for (const w of WIDGETS) {
    for (const f of SHARED_CSS) {
      assert.equal(fs.readFileSync(path.join(ROOT, w, 'assets/css', f), 'utf8'), fs.readFileSync(path.join(HERE, f), 'utf8'), `${w}/assets/css/${f} — run: node sync-assets.mjs`);
    }
  }
  for (const [m, ns] of Object.entries(PHP_MODULES)) {
    for (const f of SHARED_PHP) {
      assert.equal(fs.readFileSync(path.join(ROOT, m, 'lib', f), 'utf8'), phpFor(fs.readFileSync(path.join(HERE, 'php', f), 'utf8'), ns), `${m}/lib/${f} — run: node sync-assets.mjs`);
    }
  }
  for (const [f, mods] of Object.entries(SHARED_ACTIONS)) {
    for (const m of mods) {
      const copy = fs.readFileSync(path.join(ROOT, m, 'actions', f), 'utf8');
      assert.equal(copy, phpFor(fs.readFileSync(path.join(HERE, 'php/actions', f), 'utf8'), PHP_MODULES[m]), `${m}/actions/${f} — run: node sync-assets.mjs`);
      assert.match(copy, new RegExp(`namespace Modules\\\\${PHP_MODULES[m]}\\\\Actions;`));
      assert.doesNotMatch(copy, /EpShared/);
      const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, m, 'manifest.json'), 'utf8'));
      const [name, action] = Object.entries(manifest.actions).find(([, a]) => a.class === 'ColumnsSave') || [];
      assert.ok(action, `${m}: manifest lacks the ColumnsSave action`);
      assert.equal(action.layout, 'layout.json');
      // The controller hands the dialog a token for exactly that action; Zabbix checks it by name.
      assert.ok(fs.readFileSync(path.join(ROOT, m, 'actions/WidgetView.php'), 'utf8').includes(`CCsrfTokenHelper::get('${name}')`), `${m}: token for ${name}`);
    }
  }
});
