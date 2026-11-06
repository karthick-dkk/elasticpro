/**
 * Config-Management › Zabbix › "ElasticPro roles from Zabbix user groups" and "Zabbix users":
 * the arithmetic. docs/ROLES.md is the contract; the cards are ui/zabbix-roles.js.
 *
 * Pure: no DOM, no network. A draft is `{groups: {admin: [{id, name}], operator: [...], ...},
 * unmapped}` — `id` is null for a group the file lists by name only. What the draft says is
 * compared with what the core holds, and the difference is what the save bar names and what
 * Save sends. Group names and user names are the server's strings: only ever shown as text.
 */

export const ROLES = ['admin', 'operator', 'user', 'guest'];
export const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', user: 'User', guest: 'Guest', none: 'No access' };
/** What each role may do, as the board words it. */
export const ROLE_MAY = {
  admin: 'Everything, including Config and Accounts',
  operator: 'Add and edit clusters, automations, pause polling',
  user: 'Every page, no changes',
  guest: 'Clusters page only',
};
export const UNMAPPED_OPTIONS = [
  ['zabbixRole', 'the role from their Zabbix user role (Super admin → Admin, Admin → Operator, User → User)'],
  ['none', 'no access'],
];

export const roleLabel = (r) => ROLE_LABEL[r] || (r ? String(r) : 'No access');

/* ------------------------------------ the group map ------------------------------------ */

/** A group as the core sends it (a name, or `{id, name}`, or Zabbix's `{usrgrpid, name}`) as `{id, name}`. */
export function normGroup(e) {
  if (e && typeof e === 'object') {
    const id = e.id != null && e.id !== '' ? String(e.id) : e.usrgrpid != null && e.usrgrpid !== '' ? String(e.usrgrpid) : null;
    return { id, name: String(e.name == null ? '' : e.name).trim() };
  }
  return { id: null, name: String(e == null ? '' : e).trim() };
}

/** The same group: by id when both sides have one, else by name — exactly, as Zabbix compares them. */
export function sameGroup(a, b) {
  if (a.id && b.id) return a.id === b.id;
  return a.name === b.name;
}

/** The draft a roleMap answer starts from. */
export function draftOf(roleMap) {
  const g = (roleMap && roleMap.groups) || {};
  const groups = {};
  for (const r of ROLES) groups[r] = (Array.isArray(g[r]) ? g[r] : []).map(normGroup).filter((x) => x.name);
  return { groups, unmapped: roleMap && roleMap.unmapped === 'none' ? 'none' : 'zabbixRole' };
}

export const cloneDraft = (d) => draftOf({ groups: d.groups, unmapped: d.unmapped });

/** The role a group sits under in the draft, or null. */
export function roleOfGroup(draft, g) {
  return ROLES.find((r) => draft.groups[r].some((x) => sameGroup(x, g))) || null;
}

/** `g` added under `role`; a group already under any role is not added twice (the core refuses that). */
export function addGroup(draft, role, g) {
  const group = normGroup(g);
  if (!ROLES.includes(role) || !group.name || roleOfGroup(draft, group)) return draft;
  const next = cloneDraft(draft);
  next.groups[role].push(group);
  return next;
}

export function removeGroup(draft, role, g) {
  const next = cloneDraft(draft);
  next.groups[role] = next.groups[role].filter((x) => !sameGroup(x, g));
  return next;
}

/** The live Zabbix groups that are not under any role yet: what "+ Add group" offers. */
export function availableGroups(live, draft) {
  return (Array.isArray(live) ? live : [])
    .map((z) => ({ id: z.usrgrpid != null ? String(z.usrgrpid) : null, name: String(z.name || ''), disabled: !!z.disabled }))
    .filter((z) => z.name && !roleOfGroup(draft, z))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Is a saved entry in Zabbix's live list? `null` when the list could not be read: nothing is known. */
export function groupKnown(g, live) {
  if (!Array.isArray(live)) return null;
  return live.some((z) => sameGroup(g, { id: z.usrgrpid != null ? String(z.usrgrpid) : null, name: String(z.name || '') }));
}

/** The map as ZABBIX_ROLEMAP_SET / _PREVIEW takes it: a name when no id is known, else `{id, name}`. */
export function mapMessage(draft) {
  const groups = {};
  for (const r of ROLES) groups[r] = draft.groups[r].map((g) => (g.id ? { id: g.id, name: g.name } : g.name));
  return { groups, unmapped: draft.unmapped };
}

/** The chip diff as the save bar names it: one change per group added or removed, and the unmapped rule. */
export function mapChanges(saved, draft) {
  const out = [];
  if (!saved || !draft) return out;
  for (const r of ROLES) {
    for (const g of draft.groups[r]) {
      if (!saved.groups[r].some((x) => sameGroup(x, g))) {
        const was = roleOfGroup(saved, g);
        out.push({ key: `rm:${r}:+${g.name}`, label: `${roleLabel(r)} groups`,
          text: was ? `${g.name} moved from ${roleLabel(was)} to ${roleLabel(r)}` : `${roleLabel(r)}: + ${g.name}` });
      }
    }
    for (const g of saved.groups[r]) {
      if (!draft.groups[r].some((x) => sameGroup(x, g)) && !roleOfGroup(draft, g)) {
        out.push({ key: `rm:${r}:-${g.name}`, label: `${roleLabel(r)} groups`, text: `${roleLabel(r)}: − ${g.name}` });
      }
    }
  }
  if (saved.unmapped !== draft.unmapped) {
    out.push({ key: 'rm:unmapped', label: 'In none of these',
      text: `In none of these: ${draft.unmapped === 'none' ? 'no access' : 'role from their Zabbix user role'}` });
  }
  return out;
}

/* ------------------------------------ the preview ------------------------------------ */

/** What "Preview who changes" answers, as the card shows it. */
export function previewView(res) {
  if (!res || res.ok === false) return { failed: true, message: (res && res.message) || 'The preview could not be made.' };
  const adminsAfter = Number.isFinite(res.adminsAfter) ? res.adminsAfter : null;
  const rows = (res.changes || []).map((c) => ({
    account: String(c.account || ''), username: String(c.username || c.account || ''),
    from: roleLabel(c.from), to: roleLabel(c.to),
    why: c.via ? `via ${c.via}` : c.source === 'zabbixRole' ? 'from their Zabbix user role' : c.source === 'unmapped' ? 'in none of the mapped groups' : '',
    toNone: c.to === 'none' || c.to == null,
  }));
  const lockout = !!res.lockout;
  const n = rows.length;
  const headline = lockout
    ? 'Refused: this map would leave nobody able to sign in as an administrator, so it would not be saved.'
    : n === 0 ? 'Nobody’s role changes at their next sign-in.'
      : `${n} ${n === 1 ? 'person changes' : 'people change'} at their next sign-in.`;
  const notes = [];
  if (res.groupsFrom === 'lastSignIn') {
    notes.push('Judged on the groups each person had at their last sign-in: Zabbix could not be asked.');
  }
  if (res.zabbixError) notes.push(String(res.zabbixError));
  notes.push('Unsaved changes made by hand are not included.');
  notes.push('Pinned people (No access included) never appear: a role set by hand wins over the map. People whose groups were never recorded cannot be judged and are left out.');
  return { failed: false, lockout, headline, adminsAfter, rows, notes };
}

/** Did the server's map change under an edit in progress? (`before` and `after` are drafts.) */
export const mapsDiffer = (before, after) => !!before && !!after && mapChanges(before, after).length > 0;

/** The sentence for a refused save, plainly. The core's own message follows it (it carries the code). */
export function refusalText(res) {
  const m = String((res && res.message) || 'The core refused it.');
  if (res && res.kind === 'last_admin') {
    return `Not saved: this would leave nobody able to sign in as an administrator. ${m}`;
  }
  return m;
}

/* ------------------------------------ the people ------------------------------------ */

/** A saved by-hand value: '' (follow the groups), a role, or 'none'. */
export const handOf = (u) => (u && u.pinned ? (u.byHand || u.inForce || '') : '');

export const HAND_OPTIONS = [['', '— use the groups'], ['admin', 'Admin'], ['operator', 'Operator'], ['user', 'User'], ['guest', 'Guest'], ['none', 'No access']];

/** The by-hand changes: `hand` is Map account → value for the rows the admin touched. */
export function handChanges(users, hand) {
  const out = [];
  for (const u of users || []) {
    if (!hand.has(u.account)) continue;
    const want = hand.get(u.account);
    if (want === handOf(u)) continue;
    out.push({ key: `zu:${u.account}`, account: u.account, label: u.username,
      text: want === '' ? `${u.username}: back to the groups (Reset)` : `${u.username}: ${roleLabel(want)} by hand` });
  }
  return out;
}

/** The core message that makes one by-hand change. */
export function handMessage(account, want) {
  return want === '' ? { type: 'USER_UNPIN_ROLE', name: account } : { type: 'USER_SET_ROLE', name: account, role: want };
}

/** A person's groups for the table: each with whether the map knows it. */
export function groupChips(u) {
  return (u.groups || []).map((g) => ({ name: String(g.name || ''), mapped: g.role != null }));
}

/** "Operator (highest of User, Operator)", "User (from Zabbix role User)", or why there is none. */
export function fromGroupsView(u) {
  const f = u.fromGroups;
  if (!f) return { role: null, text: 'not known yet', note: 'signed in before groups were recorded; known after the next sign-in' };
  if (f.role == null) return { role: 'none', text: 'No access', note: 'in none of the mapped groups' };
  if (f.source === 'zabbixRole') return { role: f.role, text: roleLabel(f.role), note: `from Zabbix role ${u.zabbixRole || ''}`.trim() };
  const roles = [...new Set((f.matched || []).map((m) => m.role))].reverse();
  return { role: f.role, text: roleLabel(f.role), note: roles.length > 1 ? `highest of ${roles.map(roleLabel).join(', ')}` : '' };
}

/** The badges a row carries, in the order they matter. `tone` is a pill class. */
export function userBadges(u) {
  const out = [];
  if (u.gone) out.push({ kind: 'gone', text: 'not in Zabbix any more', tone: 'red', title: 'Zabbix no longer lists this person. Their sessions ended; Reset clears the mark, and so does a sign-in from the instance that knows them.' });
  if (u.pinned) out.push({ kind: 'pinned', text: u.byHand === 'none' ? 'no access by hand' : 'pinned', tone: 'blue', title: 'A role set by hand stays through sign-ins and syncs until Reset.' });
  if (u.unverifiable) {
    const n = Number(u.absentSyncs) || 0;
    out.push({ kind: 'unverifiable', text: `absent ${n} ${n === 1 ? 'sync' : 'syncs'}`, tone: 'yellow',
      title: 'The Zabbix list in use cannot vouch for this person (the sync token sees only some users). Their role is kept; after 3 absent syncs their sessions end.' });
  }
  if (u.noAccess && !u.pinned && !u.gone) out.push({ kind: 'sync-noaccess', text: 'no access from a sync', tone: 'red', title: 'A sync imposed this; the next sign-in that gives a role lifts it, or Reset.' });
  return out;
}

/** "lowered at sync: Operator → User" with the core's reason, or null. */
export function syncChangeView(u) {
  const c = u.syncChange;
  if (!c) return null;
  return { text: `lowered at sync: ${roleLabel(c.from)} → ${roleLabel(c.to)}`, why: String(c.why || ''), at: c.at ? c.at * 1000 : 0 };
}

/** The table's rows after the filter and the All / Set by hand toggle. */
export function filterUsers(users, query, mode, hand) {
  const q = String(query || '').trim().toLowerCase();
  return (users || []).filter((u) => {
    if (mode === 'hand' && !(handOf(u) !== '' || (hand && hand.get(u.account)))) return false;
    if (!q) return true;
    return u.username.toLowerCase().includes(q) || (u.groups || []).some((g) => String(g.name).toLowerCase().includes(q));
  });
}

/** How many people hold each role today, for the role rows. */
export function peopleByRole(users) {
  const n = { admin: 0, operator: 0, user: 0, guest: 0 };
  for (const u of users || []) if (n[u.inForce] != null) n[u.inForce] += 1;
  return n;
}

/**
 * Why the people could not be read live, when that is the token's doing: the live read needs
 * `user.get`, which a site paired before modules 2.1.20 lacks. `null` when Zabbix answered or
 * the reason is something else (it is shown as the core said it).
 */
export function usersTokenProblem(zabbixError) {
  const e = String(zabbixError || '');
  if (!e) return null;
  if (/not paired/i.test(e)) return null;
  if (/user\.get|permission|not authori[sz]ed|access denied/i.test(e)) {
    return 'The paired Zabbix token cannot read users (user.get), so each person’s groups are as their last sign-in said. Pair again with Zabbix modules 2.1.20 or newer, or add user.get to the ElasticPro sync role in Zabbix.';
  }
  return null;
}

/** The note under the Zabbix users header when groups are not live: the reason, never a guess. */
export function groupsFromNote(res) {
  if (!res || res.groupsFrom !== 'lastSignIn') return '';
  return usersTokenProblem(res.zabbixError)
    || `Groups are as each person’s last sign-in said: ${res.zabbixError || 'Zabbix could not be asked'}.`;
}

/**
 * The by-hand and map changes together, for the save bar (the section's `changes()`).
 * `saved`/`draft` are the maps; `users`/`hand` the people.
 */
export function allChanges(saved, draft, users, hand) {
  return [...mapChanges(saved, draft), ...handChanges(users, hand)];
}
