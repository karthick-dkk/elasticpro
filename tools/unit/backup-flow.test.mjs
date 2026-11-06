/** Backup and restore, the page's messages and words (ui/js/core/backup-flow.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS } from '../../ui/js/core/backup-rules.js';
import {
  DEFAULT_TICKED, createMessage, scheduleMessage, restoreMessage, confirmText, refusalWords, appliedLine, itemName,
  needsPassword, unknownSectionsLine,
} from '../../ui/js/core/backup-flow.js';

test('a create message: sections, the password rule, and the password only when credentials are on', () => {
  assert.equal(createMessage({ ticked: [], withCredentials: false }).problem, 'Tick at least one thing to include');
  assert.deepEqual(createMessage({ ticked: SECTIONS.map((s) => s.id), withCredentials: false }).message, { type: 'BACKUP_CREATE' });
  const some = createMessage({ ticked: ['play', 'clusters', 'nope'], withCredentials: false }).message;
  assert.deepEqual(some.sections, ['clusters', 'play']);
  assert.ok(!('password' in some));
  assert.match(createMessage({ ticked: DEFAULT_TICKED, withCredentials: true, password: '', repeat: '' }).problem, /12 characters/);
  assert.equal(createMessage({ ticked: DEFAULT_TICKED, withCredentials: true, password: 'short', repeat: 'short' }).problem, 'At least 12 characters');
  assert.equal(createMessage({ ticked: DEFAULT_TICKED, withCredentials: true, password: 'twelve-chars!', repeat: 'twelve-chars?' }).problem, 'The two passwords differ');
  const ok = createMessage({ ticked: DEFAULT_TICKED, withCredentials: true, password: 'twelve-chars!', repeat: 'twelve-chars!' }).message;
  assert.equal(ok.password, 'twelve-chars!');
  assert.ok(Array.isArray(ok.sections) && !ok.sections.includes('versions'));
  assert.ok(!('password' in createMessage({ ticked: DEFAULT_TICKED, withCredentials: false, password: 'twelve-chars!', repeat: 'x' }).message));
});

test('a schedule message carries the four fields and refuses bad ones', () => {
  assert.deepEqual(scheduleMessage({ enabled: true, every: 'week', at: '03:30', keep: '7' }).message,
    { type: 'BACKUP_SCHEDULE_SET', schedule: { enabled: true, every: 'week', at: '03:30', keep: 7 } });
  assert.ok(scheduleMessage({ enabled: true, every: 'hour', at: '03:30', keep: 7 }).problem);
  assert.ok(scheduleMessage({ enabled: true, every: 'day', at: '25:00', keep: 7 }).problem);
  assert.ok(scheduleMessage({ enabled: true, every: 'day', at: '02:00', keep: 0 }).problem);
  assert.ok(scheduleMessage({ enabled: true, every: 'day', at: '02:00', keep: 91 }, 90).problem);
});

test('a preview or restore message: file or name, mode, and skip beats a typed password', () => {
  assert.ok(restoreMessage('BACKUP_PREVIEW', { source: null }).problem);
  assert.deepEqual(restoreMessage('BACKUP_PREVIEW', { source: { file: '{}' }, password: 'pw' }).message, { type: 'BACKUP_PREVIEW', file: '{}', password: 'pw' });
  assert.deepEqual(restoreMessage('BACKUP_PREVIEW', { source: { name: 'a.epbak' }, password: 'pw', skipCredentials: true }).message,
    { type: 'BACKUP_PREVIEW', name: 'a.epbak', skipCredentials: true });
  assert.ok(restoreMessage('BACKUP_RESTORE', { source: { name: 'a.epbak' }, mode: 'x' }).problem);
  assert.deepEqual(restoreMessage('BACKUP_RESTORE', { source: { name: 'a.epbak' }, mode: 'merge' }).message, { type: 'BACKUP_RESTORE', name: 'a.epbak', mode: 'merge' });
});

test('the confirm text names what Replace removes and what it keeps anyway', () => {
  const preview = [
    { id: 'clusters', present: true, add: ['a'], change: ['b'], same: 1, onlyHere: ['x', 'y', 'z', 'w'], keptAnyway: [] },
    { id: 'requests', present: true, add: [], change: [], same: 0, onlyHere: [], keptAnyway: ['policy'] },
    { id: 'play', present: false },
  ];
  const r = confirmText('replace', preview);
  assert.equal(r.danger, true);
  assert.equal(r.removes, 4);
  assert.equal(r.lines[0], 'Clusters and their settings: 4 removed (x, y, z, and 1 more)');
  assert.match(r.lines[1], /kept anyway \(policy\)/);
  const m = confirmText('merge', preview);
  assert.equal(m.danger, false);
  assert.match(m.lines[0], /1 added and 1 changed/);
  assert.match(confirmText('replace', [{ id: 'play', present: true, onlyHere: [] }]).lines[0], /nothing will be removed/);
});

test('refusals are said in plain words with their codes', () => {
  assert.match(refusalWords({ kind: 'bad_password' }), /not the password.*EP-309/);
  assert.match(refusalWords({ kind: 'weak_password' }), /EP-308/);
  assert.match(refusalWords({ kind: 'newer_format' }), /Upgrade/);
  assert.match(refusalWords({ kind: 'tampered' }), /EP-314/);
  assert.match(refusalWords({ kind: 'no_server_key' }), /no key/);
  assert.match(refusalWords({ kind: 'too_large' }), /16 MB/);
  assert.equal(refusalWords({ kind: 'weird', message: 'because' }), 'because');
  assert.equal(needsPassword({ kind: 'password_needed' }), true);
  assert.equal(needsPassword({ kind: 'corrupt' }), false);
  assert.match(appliedLine({ id: 'clusters', added: 2, changed: 1, removed: 0 }), /^Clusters and their settings: 2 added, 1 changed$/);
  assert.equal(appliedLine({ id: 'play' }), 'Play: displays, watch rules, exclusions: no change');
  assert.equal(itemName({ name: 'es-1' }), 'es-1');
  assert.match(unknownSectionsLine({ unknownSections: ['x'] }), /left alone/);
});
