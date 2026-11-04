/**
 * Config › History store: the pure helpers. What disables the Write history switch, how a
 * privilege that was not checked reads, and which destination the delay card defaults to.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const H = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/history-store.js')).href);

test('Write history is blocked with the setting that fixes it, and never when armed', () => {
  assert.equal(H.armReason({ permitted: false, permitHint: 'set HISTORY_STORE_WRITES=true in config.txt' }), 'set HISTORY_STORE_WRITES=true in config.txt');
  assert.match(H.armReason({ permitted: false }), /HISTORY_STORE_WRITES=true in config\.txt/);
  assert.equal(H.armReason({ permitted: true, armBlocked: 'test the connection first' }), 'test the connection first');
  assert.equal(H.armReason({ permitted: true, armBlocked: null }), '');
  assert.equal(H.armReason({ permitted: false, armed: true }), '', 'turning it off is always allowed');
});

test('a privilege that was not checked is not "no"', () => {
  const t = { privileges: { create_doc: true, create_index: false, read: null }, securityEnabled: true };
  const lines = H.privilegeLines(t, 'ep');
  assert.deepEqual(lines, ['create_doc on ep-*: yes', 'create_index on ep-*: no', 'read on ep-*: not checked']);
  const open = H.privilegeLines({ privileges: { create_doc: null, create_index: null, read: null }, securityEnabled: false }, '');
  assert.ok(open.includes('security is not enabled on the store'));
  assert.match(open[0], /elasticpro-history-\*: not checked/);
  const tpl = H.privilegeLines({ privileges: { create_doc: true, create_index: true, read: true, manage_index_templates: false } }, 'ep');
  assert.equal(tpl[3], 'manage_index_templates (cluster): no');
});

test('the test headline carries the version and cluster, or the failure message', () => {
  assert.equal(H.testHeadline(null), 'not tested yet');
  assert.equal(H.testHeadline({ ok: true, version: '8.15.0', clusterName: 'hist' }), 'ok, version 8.15.0, cluster hist');
  assert.match(H.testHeadline({ ok: false, message: 'connection refused' }), /connection refused/);
  assert.equal(H.testIsStale({ ok: true, current: false }), true);
  assert.equal(H.testIsStale({ ok: true, current: true }), false);
});

test('a secret is never shown, only whether one is held', () => {
  assert.match(H.secretHint({ passwordSet: true }), /set/);
  assert.match(H.secretHint({ passwordSet: true, passwordStale: true }), /type the password again/);
  assert.equal(H.secretHint({ passwordSet: false }), '');
});

test('the delay destination defaults to the monitored cluster', () => {
  assert.equal(H.destinationOf({}), 'cluster');
  assert.equal(H.destinationOf(undefined), 'cluster');
  assert.equal(H.destinationOf({ destination: 'history' }), 'history');
  assert.equal(H.destinationWarning({ destination: 'cluster' }, { configured: false }), '');
  assert.match(H.destinationWarning({ destination: 'history' }, { configured: false }), /not configured/);
  assert.match(H.destinationWarning({ destination: 'history' }, { configured: true, permitted: false, armed: false }), /HISTORY_STORE_WRITES/);
  assert.match(H.destinationWarning({ destination: 'history' }, { configured: true, permitted: true, armed: false }), /switched off/);
  assert.equal(H.destinationWarning({ destination: 'history' }, { configured: true, permitted: true, armed: true }), '');
});

test('an unreachable store is one line, and only when it was asked and did not answer', () => {
  assert.equal(H.historyUnreachableLine(null), '');
  assert.equal(H.historyUnreachableLine({ reachable: true }), '');
  assert.equal(H.historyUnreachableLine({ reachable: false, from: '2026-01-01', to: '2026-01-31' }),
    'Days 2026-01-01 to 2026-01-31: in the history store · not reachable');
  assert.equal(H.fromHistory({ source: 'history' }), true);
  assert.equal(H.fromHistory({ source: 'cluster' }), false);
});

test('index names follow the prefix', () => {
  assert.deepEqual(H.indexNames(''), ['elasticpro-history-volume-YYYY.MM', 'elasticpro-history-capacity-YYYY.MM', 'elasticpro-history-delay-YYYY.MM']);
});
