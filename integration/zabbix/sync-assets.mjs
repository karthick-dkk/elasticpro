#!/usr/bin/env node
/**
 * Copies shared/ into every module — Zabbix loads a module's files from its own folder, so each
 * carries a copy. Edit shared/, then run this; the tests fail while any copy differs.
 *
 *   node sync-assets.mjs
 *
 * JavaScript goes to <widget>/assets/js/. PHP goes to <module>/lib/, with its namespace
 * rewritten to the module's own (EpShared → Modules\<Namespace>\Lib), so two modules never
 * declare the same class.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHARED = ['ep-xlsx.js', 'ep-export.js', 'ep-columns.js'];
export const SHARED_CSS = ['ep-widget.css'];
export const WIDGETS = ['capacity-widget', 'volume-widget', 'resources-widget'];
export const SHARED_PHP = ['Store.php', 'Roles.php', 'ColumnSettings.php', 'Forecast.php', 'ClientTypes.php'];
export const SHARED_ACTIONS = { 'ColumnsSave.php': ['resources-widget', 'capacity-widget', 'volume-widget'] };
export const PHP_MODULES = { 'clients-module': 'EpClients', 'resources-widget': 'EpResources', 'capacity-widget': 'EpCapacity', 'volume-widget': 'EpVolume' };

/** The shared PHP file as it sits in a module. */
export function phpFor(source, namespace) {
  return source.replace(/^namespace EpShared\\Actions;$/m, `namespace Modules\\${namespace}\\Actions;`)
    .replace(/^use EpShared\\/m, `use Modules\\${namespace}\\Lib\\`)
    .replace(/^namespace EpShared;$/m, `namespace Modules\\${namespace}\\Lib;`)
    .replace(' * Shared: ../../sync-assets.mjs copies this into each module, under that module\'s namespace.',
      ' * Copied from ../../shared/php by ../../sync-assets.mjs — edit it there.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const w of WIDGETS) {
    if (!fs.existsSync(path.join(HERE, w))) continue;
    for (const f of SHARED) {
      if (fs.existsSync(path.join(HERE, 'shared', f))) fs.copyFileSync(path.join(HERE, 'shared', f), path.join(HERE, w, 'assets', 'js', f));
    }
    for (const f of SHARED_CSS) fs.copyFileSync(path.join(HERE, 'shared', f), path.join(HERE, w, 'assets', 'css', f));
  }
  for (const [dir, ns] of Object.entries(PHP_MODULES)) {
    if (!fs.existsSync(path.join(HERE, dir))) continue;
    fs.mkdirSync(path.join(HERE, dir, 'lib'), { recursive: true });
    for (const f of SHARED_PHP) {
      fs.writeFileSync(path.join(HERE, dir, 'lib', f), phpFor(fs.readFileSync(path.join(HERE, 'shared', 'php', f), 'utf8'), ns));
    }
    console.log(`${dir}: ${SHARED_PHP.join(', ')}`);
  }
  for (const [f, dirs] of Object.entries(SHARED_ACTIONS)) {
    for (const dir of dirs) {
      if (!fs.existsSync(path.join(HERE, dir))) continue;
      fs.writeFileSync(path.join(HERE, dir, 'actions', f), phpFor(fs.readFileSync(path.join(HERE, 'shared', 'php', 'actions', f), 'utf8'), PHP_MODULES[dir]));
    }
  }
}
