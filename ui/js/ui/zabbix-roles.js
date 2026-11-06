/**
 * Config-Management › Zabbix: "ElasticPro roles from Zabbix user groups" and "Zabbix users"
 * (the approved board of 2026-11-06). docs/ROLES.md is the contract; the arithmetic is
 * core/zabbix-roles.js.
 *
 * Nothing here has a Save button. Chips added and removed, the "In none of these" rule and a
 * role set by hand are edits to a working copy; the page's one save bar names them
 * (zabbixRolesChanges) and its Save runs saveZabbixRoles: the map first (one
 * ZABBIX_ROLEMAP_SET, refused whole on `last_admin`), then each person's change.
 * "Preview who changes" asks ZABBIX_ROLEMAP_PREVIEW about the draft and writes nothing.
 *
 * Both cards exist only when the core knows the group map (ZABBIX_ROLEMAP_GET answers with
 * `groupMapSaved`): an older core answers an unknown message, and the page draws neither.
 * Group and user names are the server's strings and go in as text nodes only.
 */

import { h } from '../lib/dom.js';
import { ago } from '../lib/fmt.js';
import { bridge } from '../core/transport.js';
import { card, pill } from '../pages/common.js';
import { toast } from './menu.js';
import * as Z from '../core/zabbix-roles.js';

const st = {
  supported: false, loaded: false, error: '',
  res: null,            // the last ZABBIX_ROLEMAP_GET
  saved: null,          // the map as the core holds it (a draft shape)
  draft: null,          // the map as edited
  usersRes: null,       // the last ZABBIX_USERS
  hand: new Map(),      // account → value, for rows the admin touched
  filter: '', mode: 'all',
  preview: null, previewBusy: false,
  refusal: '', handRefusal: '', serverChanged: false, busy: false,
};

/** The core knows the group map (docs/ROLES.md): both cards are drawn. */
export const zabbixRolesSupported = () => st.supported;

const usersOf = () => (st.usersRes && st.usersRes.users) || [];

/** What the save bar says: the chip diff and the by-hand changes, as [{key, label, text}]. */
export function zabbixRolesChanges() {
  if (!st.draft) return [];
  return Z.allChanges(st.saved, st.draft, usersOf(), st.hand);
}

/** Throw away the edits (the bar's Discard). */
export function discardZabbixRoles() {
  if (st.saved) st.draft = Z.cloneDraft(st.saved);
  st.hand = new Map();
  st.preview = null; st.refusal = ''; st.handRefusal = ''; st.serverChanged = false;
}

/** Forget everything (tests, and a change of who is signed in). */
export function forgetZabbixRoles() {
  Object.assign(st, { supported: false, loaded: false, error: '', res: null, saved: null, draft: null, usersRes: null,
    hand: new Map(), filter: '', mode: 'all', preview: null, previewBusy: false, refusal: '', handRefusal: '', serverChanged: false, busy: false });
}

/**
 * Ask the core for the map and the people. Edits in progress are kept: only what the core
 * says is refreshed, so a sync landing mid-edit does not undo the admin's chips.
 */
export async function loadZabbixRoles(redraw) {
  const [map, users] = await Promise.all([bridge({ type: 'ZABBIX_ROLEMAP_GET' }), bridge({ type: 'ZABBIX_USERS' })]);
  if (map && map.ok && typeof map.groupMapSaved === 'boolean') {
    st.supported = true; st.error = '';
    st.res = map;
    const fresh = Z.draftOf(map.roleMap);
    const editing = st.draft && Z.mapChanges(st.saved, st.draft).length > 0;
    if (editing && Z.mapsDiffer(st.saved, fresh)) { st.serverChanged = true; st.preview = null; }
    st.saved = fresh;
    if (!editing) st.draft = Z.cloneDraft(fresh);
  } else if (map && map.ok === false && !['unknown_message', 'unknown', 'not_supported', 'unsupported', 'bad_message', 'forbidden'].includes(map.kind)) {
    // A transient failure (no answer, a restart) on a core that knew the map: say so, keep what was drawn.
    st.error = map.message || 'The role map could not be read.';
  }
  if (users && users.ok) st.usersRes = users;
  else if (users && users.ok === false && st.supported) st.usersRes = { ok: false, users: usersOf(), message: users.message };
  st.loaded = true;
  if (redraw) redraw();
}

/* ------------------------------------ saving ------------------------------------ */

/**
 * The bar's Save for this section: true when everything was saved. The map goes first and
 * alone; refused (last_admin), nothing else is sent and the refusal stays on the card.
 */
export async function saveZabbixRoles(redraw) {
  if (st.busy || !st.draft) return false;
  st.busy = true; st.refusal = ''; st.handRefusal = '';
  let all = true;
  try {
    if (Z.mapChanges(st.saved, st.draft).length) {
      const res = await bridge({ type: 'ZABBIX_ROLEMAP_SET', roleMap: Z.mapMessage(st.draft) });
      if (!res || !res.ok) {
        st.refusal = Z.refusalText(res);
        toast('Roles from Zabbix user groups not saved', 'err', 12000, { key: 'zabbix-roles', detail: [st.refusal] });
        if (redraw) redraw();
        return false;
      }
      st.saved = Z.draftOf(res.roleMap);
      st.draft = Z.cloneDraft(st.saved);
      st.preview = null; st.serverChanged = false;
      toast('Roles from Zabbix user groups saved', 'ok', 6000, { key: 'zabbix-roles',
        detail: ['It applies from each person’s next sign-in; nobody’s open session changes.', `Administrators after: ${res.adminsAfter}`] });
    }
    const failed = [];
    for (const c of Z.handChanges(usersOf(), st.hand)) {
      const res = await bridge(Z.handMessage(c.account, st.hand.get(c.account)));
      if (res && res.ok) st.hand.delete(c.account);
      else failed.push(`${c.label}: ${(res && res.message) || 'the core refused it'}`);
    }
    if (failed.length) {
      all = false;
      st.handRefusal = failed.join(' · ');
      toast(`${failed.length} role${failed.length === 1 ? '' : 's'} set by hand not saved`, 'err', 12000, { key: 'zabbix-hand', detail: failed });
    }
  } finally {
    st.busy = false;
  }
  await loadZabbixRoles(redraw);
  return all;
}

/* ------------------------------------ the preview ------------------------------------ */

async function runPreview(redraw) {
  st.previewBusy = true; st.preview = null; redraw();
  let res;
  try { res = await bridge({ type: 'ZABBIX_ROLEMAP_PREVIEW', roleMap: Z.mapMessage(st.draft) }); } catch (e) { res = { ok: false, message: e.message || String(e) }; }
  st.previewBusy = false;
  st.preview = Z.previewView(res);
  redraw();
}

function previewPanel() {
  const p = st.preview;
  if (!p) return null;
  if (p.failed) return h('div.zr-preview.zr-bad', { 'data-zr': 'preview' }, p.message);
  return h('div.zr-preview', { 'data-zr': 'preview', class: p.lockout ? 'zr-bad' : '' },
    h('div', h('b', p.headline), p.adminsAfter != null ? h('span.muted', ` Administrators able to sign in after: ${p.adminsAfter}.`) : null),
    p.rows.length ? h('ul.zr-changes', ...p.rows.map((r) => h('li',
      h('b', r.username), ` ${r.from} → `, h('b', { class: r.toNone ? 'zr-none' : '' }, r.to),
      r.why ? h('span.muted', ` · ${r.why}`) : null))) : null,
    ...p.notes.map((n) => h('div.muted.zr-note', n)));
}

/* ------------------------------------ the roles card ------------------------------------ */

const ROLE_TONE = { admin: 'red', operator: 'yellow', user: 'blue', guest: 'grey', none: 'red' };
const rolePill = (r) => h(`span.pill.${ROLE_TONE[r] || 'grey'}`, h('i.dot'), Z.roleLabel(r));

function chip(role, g, redraw) {
  const known = Z.groupKnown(g, st.res && st.res.zabbixGroups);
  return h('span.zr-chip', { 'data-group': g.name, class: known === false ? 'zr-unknown' : '' },
    h('span', g.name),
    known === false ? h('span.zr-warn', { title: 'Zabbix does not list a user group like this: it may have been renamed or deleted. Nobody gets this role through it until the name matches again.' }, 'unknown group') : null,
    h('button.zr-x', { type: 'button', 'aria-label': `Remove ${g.name} from ${Z.roleLabel(role)}`,
      onclick: () => { st.draft = Z.removeGroup(st.draft, role, g); st.preview = null; redraw(); } }, '×'));
}

/** "+ Add group": a pick from Zabbix's groups, or typed when Zabbix cannot be asked. */
function adder(role, redraw) {
  const live = st.res && st.res.zabbixGroups;
  const add = (g) => { st.draft = Z.addGroup(st.draft, role, g); st.preview = null; redraw(); };
  if (Array.isArray(live)) {
    const avail = Z.availableGroups(live, st.draft);
    const sel = h('select.zr-add', { 'aria-label': `Add a Zabbix user group to ${Z.roleLabel(role)}`, 'data-role': role, disabled: !avail.length,
      title: avail.length ? '' : 'Every Zabbix user group is already under a role',
      onchange: (e) => { const g = avail[Number(e.target.value)]; e.target.value = ''; if (g) add({ id: g.id, name: g.name }); } },
    h('option', { value: '' }, '+ Add group'),
    ...avail.map((g, i) => h('option', { value: String(i) }, g.disabled ? `${g.name} (disabled in Zabbix)` : g.name)));
    return sel;
  }
  // Zabbix could not list its groups: a typed name is matched exactly, as Zabbix compares them.
  const input = h('input.zr-type', { type: 'text', placeholder: '+ Add group by name', 'aria-label': `Add a Zabbix user group to ${Z.roleLabel(role)} by name`,
    'data-role': role, spellcheck: false, autocomplete: 'off',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = e.target.value.trim(); if (v) add({ name: v }); } } });
  return h('span.zr-typed', input, h('button.btn.sm.ghost', { type: 'button', onclick: () => { const v = input.value.trim(); if (v) add({ name: v }); } }, 'Add'));
}

function rolesCard(redraw) {
  const counts = Z.peopleByRole(usersOf());
  const haveUsers = st.usersRes && st.usersRes.ok;
  const res = st.res || {};
  const rows = Z.ROLES.map((r) => h('tr', { 'data-role-row': r },
    h('td', rolePill(r)),
    h('td.zr-groups', ...st.draft.groups[r].map((g) => chip(r, g, redraw)), adder(r, redraw)),
    h('td.zr-num', { title: 'People holding this role today' }, haveUsers ? String(counts[r]) : '–'),
    h('td.muted', Z.ROLE_MAY[r])));
  const none = h('tr.zr-none-row', { 'data-role-row': 'unmapped' },
    h('td', h('b', 'In none of these')),
    h('td', { colSpan: 3 }, h('label.cm-inline', h('span', 'Give them'),
      h('select', { 'aria-label': 'In none of these', 'data-zr': 'unmapped', onchange: (e) => { st.draft = { ...Z.cloneDraft(st.draft), unmapped: e.target.value }; st.preview = null; redraw(); } },
        ...Z.UNMAPPED_OPTIONS.map(([v, l]) => h('option', { value: v, selected: st.draft.unmapped === v }, l))))));
  const actions = [h('button.btn.sm', { type: 'button', 'data-zr': 'preview-btn', disabled: st.previewBusy || st.busy,
    onclick: () => runPreview(redraw) }, st.previewBusy ? 'Working…' : 'Preview who changes')];
  const el = card('ElasticPro roles from Zabbix user groups',
    'read at every sign-in and every sync · ElasticPro never changes Zabbix group membership',
    h('div',
      !res.groupMapSaved && !Z.mapChanges(st.saved, st.draft).length
        ? h('div.zr-banner', 'No group is mapped yet: people get the role from their Zabbix user role (the older role-name map, under Accounts) until a group is listed here and saved.') : null,
      res.zabbixGroupsError ? h('div.zr-banner', { 'data-zr': 'groups-error' }, `Zabbix’s user groups could not be listed (${res.zabbixGroupsError}). Type a group’s name exactly as Zabbix has it.`) : null,
      st.error ? h('div.zr-banner.zr-bad', st.error) : null,
      st.serverChanged ? h('div.zr-banner', { 'data-zr': 'server-changed' }, 'The role map changed on the server while you were editing — your edit is shown against the new map.') : null,
      st.refusal ? h('div.zr-banner.zr-bad', { role: 'alert', 'data-zr': 'refusal' }, st.refusal) : null,
      h('div.tbl-wrap', h('table.tbl.zr-tbl',
        h('thead', h('tr', h('th', { style: { width: '120px' } }, 'ElasticPro role'), h('th', 'Zabbix user groups'),
          h('th', { style: { width: '70px' } }, 'People'), h('th', { style: { width: '300px' } }, 'What the role may do'))),
        h('tbody', ...rows, none))),
      previewPanel(),
      h('div.zr-foot',
        h('span', 'Someone in several mapped groups gets the ', h('b', 'highest'), ' role.'),
        h('span', 'Which clusters they see still comes from their Zabbix user group’s host-group rights.'),
        h('span', 'A role set per person below wins over all of this.'))),
    actions);
  el.dataset.track = 'zabbix-roles';
  el.dataset.trackLabel = 'Roles from Zabbix groups';
  el.classList.add('zr-card');
  return el;
}

/* ------------------------------------ the users card ------------------------------------ */

function userRow(u, redraw) {
  const from = Z.fromGroupsView(u);
  const want = st.hand.has(u.account) ? st.hand.get(u.account) : Z.handOf(u);
  const sc = Z.syncChangeView(u);
  const badges = Z.userBadges(u);
  const sel = h('select.zr-hand', { 'aria-label': `Role set by hand for ${u.username}`, 'data-account': u.account,
    onchange: (e) => { st.hand.set(u.account, e.target.value); redraw(); } },
  ...Z.HAND_OPTIONS.map(([v, l]) => h('option', { value: v, selected: want === v }, l)));
  const pinnedNow = want !== '';
  return h('tr', { 'data-user': u.account, class: [pinnedNow ? 'zr-pinned' : '', u.gone ? 'zr-gone' : ''].join(' ').trim() },
    h('td', h('b', u.username), ...badges.map((b) => h(`span.zr-badge.${b.tone}`, { 'data-badge': b.kind, title: b.title }, b.text)),
      sc ? h('div.zr-sync', { 'data-badge': 'syncChange', title: sc.why }, h('span.zr-badge.yellow', sc.text), h('span.muted', ` ${sc.why}`)) : null),
    h('td.zr-gcell', ...Z.groupChips(u).map((g, i) => h('span', { class: g.mapped ? '' : 'muted' }, i ? ', ' : '', g.name,
      g.mapped ? null : h('span.muted.zr-small', ' (not mapped)'))), u.groups && u.groups.length ? null : h('span.muted', 'none recorded')),
    h('td', from.role ? Z.roleLabel(from.role) : h('span.muted', from.text), from.role && from.note ? h('span.muted.zr-small', ` (${from.note})`) : null),
    h('td.zr-handcell', sel,
      pinnedNow ? h('button.btn.sm.zr-reset', { type: 'button', title: 'Back to the groups: the next sign-in follows the map', 'aria-label': `Reset ${u.username}`,
        onclick: () => { st.hand.set(u.account, ''); redraw(); } }, 'Reset') : null),
    h('td', rolePill(u.inForce === 'none' || u.noAccess ? 'none' : u.inForce),
      Z.handOf(u) !== '' && u.pinned ? h('span.muted.zr-small', ' set by hand') : null),
    h('td.muted', u.lastSignIn ? ago(u.lastSignIn * 1000) : 'never'));
}

function usersBody(redraw) {
  const rows = Z.filterUsers(usersOf(), st.filter, st.mode, st.hand);
  if (!rows.length) {
    return [h('tr', h('td.muted', { colSpan: 6 }, usersOf().length ? 'No one matches.' : 'Nobody has signed in from Zabbix yet.'))];
  }
  return rows.map((u) => userRow(u, redraw));
}

function usersCard(redraw) {
  const r = st.usersRes || {};
  const users = usersOf();
  const handN = users.filter((u) => Z.handOf(u) !== '').length;
  const tokenProblem = Z.usersTokenProblem(r.zabbixError);
  const note = Z.groupsFromNote(r);
  const tbody = h('tbody', ...usersBody(redraw));
  const count = h('span.cm-toolbar-note', `${users.length} ${users.length === 1 ? 'person' : 'people'}`);
  const refilter = () => { tbody.replaceChildren(...usersBody(redraw)); };
  const seg = (id, label) => h('button', { type: 'button', 'aria-pressed': String(st.mode === id), 'data-mode': id,
    onclick: () => { st.mode = id; redraw(); } }, label);
  const el = card('Zabbix users',
    `${r.total != null ? r.total : users.length} people have signed in from Zabbix · ${r.byHand != null ? r.byHand : handN} with a role set by hand`,
    h('div',
      st.handRefusal ? h('div.zr-banner.zr-bad', { role: 'alert', 'data-zr': 'hand-refusal' }, st.handRefusal) : null,
      r.ok === false ? h('div.zr-banner.zr-bad', `The people could not be read: ${r.message || 'no answer'}`) : null,
      tokenProblem ? h('div.zr-banner', { 'data-zr': 'token-problem' }, tokenProblem)
        : note ? h('div.zr-banner', { 'data-zr': 'groups-from' }, note) : null,
      h('div.cm-toolbar',
        h('input', { type: 'search', 'aria-label': 'Filter people', placeholder: 'Filter people', value: st.filter, 'data-zr': 'filter',
          oninput: (e) => { st.filter = e.target.value; refilter(); } }),
        h('div.cm-seg', { role: 'group', 'aria-label': 'Show' }, seg('all', `All ${users.length}`), seg('hand', `Set by hand ${handN}`)),
        count),
      h('div.tbl-wrap', h('table.tbl.zr-tbl',
        h('thead', h('tr', h('th', 'Person'), h('th', 'Zabbix user groups'), h('th', 'Role from groups'),
          h('th', { style: { width: '190px' } }, 'Set by hand'), h('th', 'Role in force'), h('th', 'Last sign-in'))),
        tbody)),
      h('div.zr-foot', 'A role set by hand stays through sign-ins and syncs until someone presses Reset. Changes here wait for the save bar.')));
  el.dataset.track = 'zabbix-roles';
  el.dataset.trackLabel = 'Zabbix users';
  el.classList.add('zr-card');
  return el;
}

/** Both cards, or null when the core does not know the group map (or nothing was loaded yet). */
export function zabbixRolesCards(redraw) {
  if (!st.supported || !st.draft) return null;
  return [rolesCard(redraw), usersCard(redraw)];
}
