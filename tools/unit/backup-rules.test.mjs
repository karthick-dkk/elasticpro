/**
 * Backup and restore, the pure helpers (ui/js/core/backup-rules.js). The section ids and labels
 * are read back out of the core (crates/elasticpro-core/src/backup/mod.rs), so the table the page
 * draws and the one the core answers with are one definition.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SECTIONS, MIN_PASSWORD, sectionLabel, shortLabel, kindLabel, holdsLabel, passwordProblem, previewRows,
  onlyHereTotal, modeCaption, credentialsCaption, scheduleLine, bytesLabel, downloadName,
} from '../../ui/js/core/backup-rules.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const rust = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/backup/mod.rs'), 'utf8');

test('the sections, their labels, their order and the password rule are the core\'s', () => {
  const ids = [...rust.matchAll(/Section::(\w+) => "([a-z]+)",/g)].map((m) => m[2]);
  const labels = [...rust.matchAll(/Section::(\w+) => "([^"]+)",\n/g)].filter((m) => m[2].includes(' ')).map((m) => m[2]);
  assert.deepEqual(SECTIONS.map((s) => s.id), ids);
  assert.deepEqual(SECTIONS.map((s) => s.label), labels);
  assert.equal(MIN_PASSWORD, Number(rust.match(/pub const MIN_PASSWORD: usize = (\d+);/)[1]));
  for (const [kind, label] of [['manual', 'by hand'], ['scheduled', 'scheduled'], ['before-restore', 'before a restore']]) {
    assert.ok(rust.includes(`"${label}"`), `${kind} label in the core`);
    assert.equal(kindLabel(kind), label);
  }
});

test('labels fall back to the id and shorten to their first words', () => {
  assert.equal(sectionLabel('play'), 'Play: displays, watch rules, exclusions');
  assert.equal(sectionLabel('teleport'), 'teleport');
  assert.equal(shortLabel('clusters'), 'Clusters');
  assert.equal(shortLabel('trust'), 'Jump hosts');
  assert.equal(shortLabel('alerts'), 'Alert triggers');
  assert.equal(shortLabel('reports'), 'Reports');
  assert.equal(kindLabel('odd'), 'odd');
});

test('the Holds column says everything or the sections, and whether credentials are in', () => {
  assert.equal(holdsLabel(SECTIONS.map((s) => s.id), 'server'), 'everything · credentials encrypted');
  assert.equal(holdsLabel(['clusters', 'play'], 'none'), 'Clusters, Play · no credentials');
  assert.equal(holdsLabel(['clusters'], 'password'), 'Clusters · credentials encrypted');
  assert.equal(holdsLabel([], 'none'), 'nothing · no credentials');
  assert.equal(holdsLabel(undefined, undefined), 'nothing · no credentials');
});

test('the backup password is optional, at least twelve characters, and typed twice', () => {
  assert.equal(passwordProblem('', ''), null, 'empty = no credentials, allowed');
  assert.equal(passwordProblem('', 'x'), 'Type the password in the first box too');
  assert.equal(passwordProblem('short', 'short'), 'At least 12 characters');
  assert.equal(passwordProblem('long-enough-123', 'long-enough-124'), 'The two passwords differ');
  assert.equal(passwordProblem('long-enough-123', 'long-enough-123'), null);
  assert.equal(passwordProblem('long-enough-123'), null, 'no repeat box: not compared');
  assert.equal(passwordProblem('ééééééééééé', 'ééééééééééé'), 'At least 12 characters', 'counted in characters, 11 here');
  assert.equal(passwordProblem('éééééééééééé', 'éééééééééééé'), null);
});

test('the What changes table counts per present section and names the missing ones', () => {
  const preview = [
    { id: 'clusters', present: true, add: ['Beta', 'Gamma'], change: ['Alpha'], same: 3, onlyHere: ['Delta', 'Eps', 'Zeta'], keptAnyway: [] },
    { id: 'requests', present: true, add: [], change: [], same: 0, onlyHere: [], keptAnyway: ['defaults', 'policy'] },
    { id: 'alerts', present: true, add: [], change: ['trigger:t1', 'trigger:t2'], same: 0, onlyHere: [] },
    { id: 'play', present: false },
  ];
  const { rows, missing } = previewRows(preview);
  assert.deepEqual(rows.map((r) => [r.label, r.add, r.change, r.onlyHere, r.keptAnyway]), [
    ['Clusters and their settings', 2, 1, 3, 0],
    ['Request policy and Defaults', 0, 0, 0, 2],
    ['Alert triggers and Automation rules', 0, 2, 0, 0],
  ]);
  assert.deepEqual(rows[1].items.keptAnyway, ['defaults', 'policy'], 'what a Replace keeps is named, not counted as removed');
  assert.deepEqual(rows[0].items.add, ['Beta', 'Gamma']);
  assert.deepEqual(missing, ['play']);
  assert.equal(onlyHereTotal(preview), 3);
  assert.equal(modeCaption('merge', preview), 'Merge · add and update; what is only here now stays');
  assert.equal(modeCaption('replace', preview), 'Replace everything · the 3 items only here now are removed');
  assert.equal(modeCaption('replace', [{ id: 'play', present: true, onlyHere: ['x'] }]), 'Replace everything · the 1 item only here now is removed');
  assert.equal(modeCaption('replace', []), 'Replace everything · nothing is only here now');
  assert.deepEqual(previewRows(undefined), { rows: [], missing: [] });
});

test('the credentials caption follows the core\'s state word', () => {
  assert.match(credentialsCaption({ state: 'none' }), /no credentials/);
  assert.equal(credentialsCaption({ state: 'opened', count: 1 }), '1 credential will be restored, re-sealed under this server\'s key.');
  assert.match(credentialsCaption({ state: 'opened', count: 4 }), /^4 credentials/);
  assert.match(credentialsCaption({ state: 'locked', kind: 'password_needed' }), /Type the backup password/);
  assert.match(credentialsCaption({ state: 'locked', kind: 'server_key' }), /another server/);
  assert.match(credentialsCaption({ state: 'skipped' }), /left out on purpose/);
  assert.equal(credentialsCaption(undefined), '');
});

test('the schedule line says last and next in the person\'s day', () => {
  const now = new Date(2026, 10, 5, 9, 0).getTime();
  const last = new Date(2026, 10, 5, 2, 0).getTime();
  const next = new Date(2026, 10, 6, 2, 0).getTime();
  assert.equal(scheduleLine({ enabled: true, last: { ok: true, at: last, bytes: 412 * 1024 }, next }, now),
    'Last: ok today 02:00 · 412 KB · next tomorrow 02:00');
  assert.equal(scheduleLine({ enabled: true, last: { ok: false, at: last, message: 'disk full' }, next }, now),
    'Last: failed today 02:00 · disk full · next tomorrow 02:00');
  assert.equal(scheduleLine({ enabled: false, last: null }, now), 'Last: not yet · next: off');
  assert.equal(scheduleLine(null), '');
});

test('sizes and download names', () => {
  assert.equal(bytesLabel(0), '0 B');
  assert.equal(bytesLabel(900), '900 B');
  assert.equal(bytesLabel(412 * 1024), '412 KB');
  assert.equal(bytesLabel(1.25 * 1024 * 1024), '1.3 MB');
  assert.equal(bytesLabel(NaN), '—');
  assert.equal(downloadName(new Date(2026, 10, 5, 2, 0, 0).getTime(), 'scheduled'), 'elasticpro-backup-20261105-020000-scheduled.epbak');
  assert.equal(downloadName(new Date(2026, 10, 4, 18, 42, 7).getTime()), 'elasticpro-backup-20261104-184207-manual.epbak');
});
