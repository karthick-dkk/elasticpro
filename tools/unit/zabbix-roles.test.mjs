/**
 * Zabbix › roles from user groups and Zabbix users (core/zabbix-roles.js): the chip diff the
 * save bar names, the message Save sends, the preview as the card words it, and the rows of
 * the people table. docs/ROLES.md is the contract.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../..');
const Z = await import(pathToFileURL(path.join(ROOT, 'ui/js/core/zabbix-roles.js')).href);

const MAP = { groups: { admin: ['ElasticPro admins', { id: '7', name: 'Zabbix administrators' }], operator: ['NOC leads'], user: ['NOC'], guest: [] }, unmapped: 'zabbixRole' };

test('a group is a name or {id, name}; matched by id when both have one, else by name', () => {
  const d = Z.draftOf(MAP);
  assert.deepEqual(d.groups.admin, [{ id: null, name: 'ElasticPro admins' }, { id: '7', name: 'Zabbix administrators' }]);
  assert.deepEqual(Z.normGroup({ usrgrpid: '3', name: 'NOC' }), { id: '3', name: 'NOC' });
  assert.ok(Z.sameGroup({ id: '7', name: 'old name' }, { id: '7', name: 'new name' }));
  assert.ok(!Z.sameGroup({ id: null, name: 'NOC' }, { id: null, name: 'noc' }), 'exactly, as Zabbix compares them');
  assert.equal(Z.draftOf({ unmapped: 'none' }).unmapped, 'none');
  assert.equal(Z.draftOf(null).unmapped, 'zabbixRole');
});

test('chip edits become one change each, and the map message', () => {
  const saved = Z.draftOf(MAP);
  let d = Z.addGroup(saved, 'user', { id: '9', name: 'Client A team' });
  d = Z.removeGroup(d, 'operator', { id: null, name: 'NOC leads' });
  d = { ...d, unmapped: 'none' };
  const texts = Z.mapChanges(saved, d).map((c) => c.text);
  assert.deepEqual(texts, ['Operator: − NOC leads', 'User: + Client A team', 'In none of these: no access']);
  assert.deepEqual(Z.mapChanges(saved, Z.cloneDraft(saved)), []);
  const msg = Z.mapMessage(d);
  assert.deepEqual(msg.groups.user, ['NOC', { id: '9', name: 'Client A team' }]);
  assert.deepEqual(msg.groups.operator, []);
  assert.deepEqual(msg.groups.admin, ['ElasticPro admins', { id: '7', name: 'Zabbix administrators' }]);
  assert.equal(msg.unmapped, 'none');
});

test('a group under one role cannot be added under another; moving it reads as a move', () => {
  const saved = Z.draftOf(MAP);
  assert.equal(Z.addGroup(saved, 'guest', { name: 'NOC' }), saved);
  const moved = Z.addGroup(Z.removeGroup(saved, 'user', { name: 'NOC' }), 'guest', { name: 'NOC' });
  assert.deepEqual(Z.mapChanges(saved, moved).map((c) => c.text), ['NOC moved from User to Guest']);
});

test('"+ Add group" offers the live groups not yet under a role; a saved entry Zabbix lacks is unknown', () => {
  const live = [{ usrgrpid: '7', name: 'Zabbix administrators' }, { usrgrpid: '3', name: 'NOC' }, { usrgrpid: '12', name: 'Auditors', disabled: true }];
  const d = Z.draftOf(MAP);
  assert.deepEqual(Z.availableGroups(live, d).map((g) => g.name), ['Auditors']);
  assert.equal(Z.groupKnown({ id: null, name: 'NOC' }, live), true);
  assert.equal(Z.groupKnown({ id: null, name: 'NOC leads' }, live), false);
  assert.equal(Z.groupKnown({ id: '7', name: 'renamed' }, live), true, 'by id');
  assert.equal(Z.groupKnown({ id: null, name: 'NOC' }, null), null, 'Zabbix not asked: unknown is not "missing"');
  assert.deepEqual(Z.availableGroups(null, d), []);
});

test('the preview: changes, administrators after, and a plain refusal on lockout', () => {
  const ok = Z.previewView({ ok: true, adminsAfter: 2, lockout: false, groupsFrom: 'zabbix', changes: [
    { account: 'd.new@zabbix', username: 'd.new', from: 'user', to: 'none', source: 'unmapped', via: null },
    { account: 'a@zabbix', username: 'a', from: 'user', to: 'operator', source: 'group', via: 'NOC leads' }] });
  assert.equal(ok.headline, '2 people change at their next sign-in.');
  assert.equal(ok.adminsAfter, 2);
  assert.deepEqual(ok.rows.map((r) => `${r.username} ${r.from}>${r.to} ${r.why}`),
    ['d.new User>No access in none of the mapped groups', 'a User>Operator via NOC leads']);
  assert.equal(ok.rows[0].toNone, true);
  assert.equal(Z.previewView({ ok: true, adminsAfter: 1, changes: [] }).headline, 'Nobody’s role changes at their next sign-in.');
  assert.match(Z.previewView({ ok: true, adminsAfter: 1, changes: [{ account: 'x@zabbix', username: 'x', from: 'user', to: 'guest' }] }).headline, /^1 person changes/);
  const lock = Z.previewView({ ok: true, adminsAfter: 0, lockout: true, changes: [] });
  assert.equal(lock.lockout, true);
  assert.match(lock.headline, /^Refused: .*nobody able to sign in as an administrator/);
  const last = Z.previewView({ ok: true, adminsAfter: 1, groupsFrom: 'lastSignIn', zabbixError: 'no user.get', changes: [] });
  assert.ok(last.notes.some((n) => /last sign-in/.test(n)) && last.notes.includes('no user.get'));
  assert.equal(Z.previewView({ ok: false, message: 'bad map (EP-1)' }).failed, true);
});

test('a refused save says plainly what it was, then the core’s own words', () => {
  assert.match(Z.refusalText({ kind: 'last_admin', message: 'x (EP-109)' }), /^Not saved: this would leave nobody able to sign in as an administrator\. x \(EP-109\)$/);
  assert.equal(Z.refusalText({ kind: 'bad_message', message: 'a group belongs to one role' }), 'a group belongs to one role');
});

const U = (o) => ({ account: `${o.username}@zabbix`, groups: [], byHand: null, pinned: false, noAccess: false, inForce: 'user', fromGroups: null, ...o });

test('by-hand changes: a role, No access, and Reset, as the bar and the messages say them', () => {
  const users = [U({ username: 'a.kumar' }), U({ username: 'b.singh', pinned: true, byHand: 'operator', inForce: 'operator' }), U({ username: 'c.ops', pinned: true, byHand: 'none', inForce: 'none' })];
  const hand = new Map([['a.kumar@zabbix', 'admin'], ['b.singh@zabbix', ''], ['c.ops@zabbix', 'none']]);
  assert.deepEqual(Z.handChanges(users, hand).map((c) => c.text), ['a.kumar: Admin by hand', 'b.singh: back to the groups (Reset)']);
  assert.deepEqual(Z.handMessage('a.kumar@zabbix', 'none'), { type: 'USER_SET_ROLE', name: 'a.kumar@zabbix', role: 'none' });
  assert.deepEqual(Z.handMessage('b.singh@zabbix', ''), { type: 'USER_UNPIN_ROLE', name: 'b.singh@zabbix' });
  assert.deepEqual(Z.handChanges(users, new Map()), []);
  assert.equal(Z.handOf(users[2]), 'none');
  assert.equal(Z.handOf(users[0]), '');
  const all = Z.allChanges(Z.draftOf(MAP), Z.addGroup(Z.draftOf(MAP), 'guest', { name: 'Auditors' }), users, hand);
  assert.equal(all.length, 3);
});

test('role from groups: the highest, the Zabbix role fallback, none, and not known yet', () => {
  const two = U({ username: 'a', fromGroups: { role: 'operator', source: 'group', via: 'NOC leads', matched: [{ group: 'NOC leads', role: 'operator' }, { group: 'NOC', role: 'user' }] } });
  assert.deepEqual(Z.fromGroupsView(two), { role: 'operator', text: 'Operator', note: 'highest of User, Operator' });
  const one = U({ username: 'b', fromGroups: { role: 'user', source: 'group', via: 'NOC', matched: [{ group: 'NOC', role: 'user' }] } });
  assert.equal(Z.fromGroupsView(one).note, '');
  const zr = U({ username: 'c', zabbixRole: 'User role', fromGroups: { role: 'user', source: 'zabbixRole', matched: [] } });
  assert.equal(Z.fromGroupsView(zr).note, 'from Zabbix role User role');
  assert.equal(Z.fromGroupsView(U({ username: 'd', fromGroups: { role: null, source: 'unmapped', matched: [] } })).role, 'none');
  assert.equal(Z.fromGroupsView(U({ username: 'e' })).role, null, 'unknown is not a role');
});

test('badges: pinned, gone, unverifiable, and what a sync did', () => {
  const kinds = (u) => Z.userBadges(u).map((b) => b.kind);
  assert.deepEqual(kinds(U({ username: 'a', pinned: true, byHand: 'operator' })), ['pinned']);
  assert.deepEqual(kinds(U({ username: 'a', gone: true })), ['gone']);
  assert.equal(Z.userBadges(U({ username: 'a', gone: true }))[0].text, 'not in Zabbix any more');
  assert.equal(Z.userBadges(U({ username: 'a', unverifiable: true, absentSyncs: 2 }))[0].text, 'absent 2 syncs');
  assert.equal(Z.userBadges(U({ username: 'a', unverifiable: true, absentSyncs: 1 }))[0].text, 'absent 1 sync');
  assert.equal(Z.userBadges(U({ username: 'a', pinned: true, byHand: 'none' }))[0].text, 'no access by hand');
  assert.deepEqual(kinds(U({ username: 'a', noAccess: true })), ['sync-noaccess']);
  const sc = Z.syncChangeView(U({ username: 'a', syncChange: { at: 1762345678, from: 'operator', to: 'user', why: 'the highest of their Zabbix user groups now gives user (NOC)' } }));
  assert.equal(sc.text, 'lowered at sync: Operator → User');
  assert.match(sc.why, /NOC/);
  assert.equal(Z.syncChangeView(U({ username: 'a' })), null);
});

test('the table: filter by name or group, the Set by hand toggle, people per role', () => {
  const users = [
    U({ username: 'a.kumar', groups: [{ name: 'NOC', role: 'user' }, { name: 'NOC leads', role: 'operator' }], inForce: 'operator' }),
    U({ username: 'b.singh', groups: [{ name: 'Client A team', role: 'user' }], pinned: true, byHand: 'operator', inForce: 'operator' }),
    U({ username: 'd.new', groups: [{ name: 'Zabbix users', role: null }], inForce: 'user' })];
  assert.deepEqual(Z.filterUsers(users, 'noc', 'all', new Map()).map((u) => u.username), ['a.kumar']);
  assert.deepEqual(Z.filterUsers(users, 'SINGH', 'all', new Map()).map((u) => u.username), ['b.singh']);
  assert.deepEqual(Z.filterUsers(users, '', 'hand', new Map()).map((u) => u.username), ['b.singh']);
  assert.deepEqual(Z.filterUsers(users, '', 'hand', new Map([['d.new@zabbix', 'guest']])).map((u) => u.username), ['b.singh', 'd.new']);
  assert.deepEqual(Z.groupChips(users[2]), [{ name: 'Zabbix users', mapped: false }]);
  assert.deepEqual(Z.peopleByRole(users), { admin: 0, operator: 2, user: 1, guest: 0 });
});

test('a token that cannot read users is said so, with the fix; other reasons are not dressed up', () => {
  const tp = Z.usersTokenProblem('Zabbix refused user.get: no permission to call the method');
  assert.match(tp, /cannot read users \(user\.get\)/);
  assert.match(tp, /2\.1\.20/);
  assert.equal(Z.usersTokenProblem(''), null);
  assert.equal(Z.usersTokenProblem('the Zabbix API is not paired (Config → Zabbix)'), null);
  assert.match(Z.groupsFromNote({ groupsFrom: 'lastSignIn', zabbixError: 'Zabbix refused user.get: permission denied' }), /2\.1\.20/);
  assert.match(Z.groupsFromNote({ groupsFrom: 'lastSignIn', zabbixError: 'the Zabbix API is not paired' }), /last sign-in said: the Zabbix API is not paired/);
  assert.equal(Z.groupsFromNote({ groupsFrom: 'zabbix' }), '');
});
