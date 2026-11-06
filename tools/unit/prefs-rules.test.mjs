/**
 * "Your settings" rules — core/prefs-rules.js: the account's value wins, the browser's is the
 * fallback, unknown is null and not a default, the migration carries over only what the
 * account lacks, and the choice lists are the core's (user_prefs.rs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const R = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/prefs-rules.js')).href);

test('the choice lists are the core\'s, one definition each side', () => {
  const rs = fs.readFileSync(path.join(ROOT, 'crates/elasticpro-core/src/user_prefs.rs'), 'utf8');
  const list = (name) => [...rs.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\];`))[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(R.MENUS, list('MENUS'));
  assert.deepEqual(R.THEMES, list('THEMES'));
  assert.deepEqual(R.OPENS_ON, list('OPENS_ON'));
  // And the themes are the ones app.js draws.
  const app = fs.readFileSync(path.join(ROOT, 'ui/js/app.js'), 'utf8');
  const drawn = [...app.matchAll(/\{ id: '([a-z-]+)',\s+label: '[^']*' \}/g)].map((m) => m[1]);
  assert.deepEqual(drawn, R.THEMES);
});

test('an answer is read defensively: unset stays null, an unknown spelling is null, no answer is unsupported', () => {
  assert.deepEqual(R.readAnswer(null), { supported: false, prefs: null });
  assert.deepEqual(R.readAnswer({ ok: false, kind: 'bad_message' }), { supported: false, prefs: null });
  assert.deepEqual(R.readAnswer({ ok: true }), { supported: false, prefs: null }, 'an older core answering ok without prefs is not a store');
  const a = R.readAnswer({ ok: true, user: 'ann', prefs: { menu: null, theme: 'warm', opensOn: 'neon' } });
  assert.deepEqual(a, { supported: true, user: 'ann', prefs: { menu: null, theme: 'warm', opensOn: null } });
});

test('effective: account, then browser, then the shipped default — and says which', () => {
  const e = R.effective({ menu: null, theme: 'warm', opensOn: null }, { theme: 'dark', menu: 'left' });
  assert.deepEqual(e, { menu: 'left', theme: 'warm', opensOn: 'last', source: { menu: 'browser', theme: 'account', opensOn: 'default' } });
  const none = R.effective(null, null);
  assert.deepEqual(none, { ...R.DEFAULTS, source: { menu: 'default', theme: 'default', opensOn: 'default' } });
  assert.equal(R.effective(null, { theme: 'bogus' }).theme, 'system', 'a browser value the core would refuse is not applied');
});

test('the migration carries the browser\'s choice to an account that has none, and only then', () => {
  assert.deepEqual(R.migrationPatch({ menu: null, theme: null, opensOn: null }, { theme: 'dark-blue' }), { theme: 'dark-blue' });
  assert.equal(R.migrationPatch({ menu: null, theme: 'warm', opensOn: null }, { theme: 'dark-blue' }), null, 'never overwrites the account');
  assert.deepEqual(R.migrationPatch(null, { theme: 'system' }), { theme: 'system' }, 'an explicit "system" is a choice too');
  assert.equal(R.migrationPatch(null, null), null);
  assert.equal(R.migrationPatch(null, { theme: undefined }), null);
  assert.equal(R.migrationPatch(null, { theme: 'neon' }), null, 'a value the core refuses is not sent');
  // Once per browser: a second person on a shared browser does not get the first one's choices.
  assert.equal(R.migrationPatch({ menu: null, theme: null, opensOn: null }, { theme: 'dark-blue', menu: 'left' }, { migrated: true }), null,
    'the browser copy went to an account after it had already been handed over once');
  assert.deepEqual(R.migrationPatch(null, { menu: 'left' }, { migrated: false }), { menu: 'left' });
});

test('a change is checked before it is sent', () => {
  assert.deepEqual(R.changePatch('theme', 'warm'), { theme: 'warm' });
  assert.deepEqual(R.changePatch('menu', null), { menu: null });
  assert.throws(() => R.changePatch('theme', 'neon'), /not one of system, light/);
  assert.throws(() => R.changePatch('font', 'mono'), /no such setting/);
});
