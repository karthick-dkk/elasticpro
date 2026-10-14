/**
 * Reading a cluster's native-realm users — core/security-users.js.
 *
 * Regression: ISSUE-001 — an answer that was not a user map (a fixture's generic
 * {"acknowledged":true}, a proxy's error page parsed as JSON) made the Accounts page show
 * "Cannot read properties of undefined (reading 'localeCompare')".
 * Found by /qa on 2026-10-14
 * Report: .gstack/qa-reports/run-20261014T120616Z/qa-report-192-168-64-13-2026-10-14.md
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { usersFromSecurityResponse } = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/security-users.js')).href);

test('a real answer lists the users, sorted, with their roles', () => {
  const r = usersFromSecurityResponse({
    kibana_system: { username: 'kibana_system', roles: ['kibana_system'], enabled: true, metadata: { _reserved: true } },
    analyst: { username: 'analyst', roles: ['log-reader'], enabled: false, full_name: 'A N' },
  });
  assert.equal(r.error, null);
  assert.deepEqual(r.users.map((u) => [u.name, u.enabled, u.reserved]), [['analyst', false, false], ['kibana_system', true, true]]);
});

test('a user without a username field is named by its key', () => {
  assert.deepEqual(usersFromSecurityResponse({ bob: { roles: [] } }).users.map((u) => u.name), ['bob']);
});

test('an answer that is not a user map is said to be one — never a crash, never "no users"', () => {
  const r = usersFromSecurityResponse({ acknowledged: true, url: '/_security/user' });
  assert.equal(r.users, null, 'unknown, not an empty list');
  assert.match(r.error, /not with a list of users/);
  assert.equal(usersFromSecurityResponse({}).users.length, 0, 'an empty map is genuinely no users');
  assert.match(usersFromSecurityResponse(null).error, /not with a list of users/);
  assert.match(usersFromSecurityResponse([1, 2]).error, /not with a list of users/);
});
