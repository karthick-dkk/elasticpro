/**
 * The client form's name preview (views/js/ep.clients.edit.js) against the same table the PHP
 * naming is held to (names.json) — so what the page shows is what Zabbix gets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.resolve(import.meta.dirname, '..');
const Form = createRequire(import.meta.url)(path.join(HERE, 'views/js/ep.clients.edit.js'));
const R = (id, short) => ({ id, short, label: id });
const families = [
  { id: 'es', label: 'ES', roles: [R('es_data', 'ES-Data'), R('es_data_hot', 'ES-Data-Hot'), R('es_data_warm', 'ES-Data-Warm'), R('es_coord', 'ES-Coord'), R('es_master', 'ES-Master')] },
  { id: 'parser', label: 'Parser', roles: [R('parser', 'Parser'), R('s3_parser', 'S3-Parser')] },
  { id: 'fwd', label: 'Forwarder', roles: [R('forwarder', 'Forwarder')] },
  { id: 'engine', label: 'Engine', roles: [R('engine', 'Engine'), R('ueba', 'UEBA'), R('aiml', 'AIML')] },
  { id: 'single', label: 'Single node', roles: [R('single_node', 'Single-Node')] },
];

test('the preview names servers as the PHP does, case by case', () => {
  const table = JSON.parse(fs.readFileSync(path.join(HERE, 'test/names.json'), 'utf8')).cases;
  for (const c of table) assert.equal(Form.serverBase(families, c.roles), c.base, c.roles.join('+'));
});

test('an existing host keeps a name that fits; the rest take the next number', () => {
  const servers = [{ ip: '10.0.0.1', roles: ['es_data_hot'] }, { ip: '10.0.0.2', roles: ['es_data_hot'] }, { ip: '10.0.0.3', roles: ['engine', 'aiml'] }];
  const existing = { '10.0.0.2': 'karthi-ES-Data-Hot-4', '10.0.0.3': 'vm old name' };
  assert.deepEqual(Form.names('karthi', families, servers, existing), ['karthi-ES-Data-Hot-5', 'karthi-ES-Data-Hot-4', 'karthi-Engine-AIML-1']);
});

test('the view reads this file, and the file follows the roles the page is given', () => {
  const view = fs.readFileSync(path.join(HERE, 'views/ep.clients.edit.php'), 'utf8');
  assert.match(view, /readfile\(__DIR__\.'\/js\/ep\.clients\.edit\.js'\)/);
  assert.match(view, /name="servers" id="servers"/);
});
