/**
 * Page — accounts: who can sign in, and what they may do.
 *
 * Admin only, and the core enforces that independently — every message this page sends
 * is refused for anyone else regardless of whether the tab was rendered. See
 * `required_role()` in crates/elasticpro-core/src/auth.rs.
 *
 * API tokens appear only on the hosted build. The desktop app talks to its core over
 * local IPC and has no socket to serve an API on, so offering to mint a token there would
 * be offering something that cannot be used.
 */

import { h, mount } from '../lib/dom.js';
import { bridge } from '../core/transport.js';
import { card, pill, statTile, empty, table } from './common.js';
import { modal, field, text, select, val, confirmDialog } from '../ui/modal.js';
import { clusters, activeClusters, state } from '../core/state.js';
import { fetchClusterUsers, createDialog, removeClusterUser, editDialog } from '../ui/cluster-users.js';
import { ICON, toast } from '../ui/menu.js';

const MIN_PASSWORD = 10;   // must match auth::MIN_PASSWORD

let host = null;
const ui = { users: [], tokens: [], caller: null, apiTokens: false, err: '', freshSecret: null,
  logins: [], lockAfter: 5, lockMinutes: 15, failedOnly: false,
  activity: [], activityFile: null, activityUser: '', activityFailed: false, activityErr: '',
  // The Zabbix role map (hosted only): what the core holds, the shipped defaults, the role
  // names Zabbix lists when its API is paired, and why it could not when it is not.
  roleMap: null, roleDefaults: null, zabbixRoles: [], roleMapNote: '', roleMapErr: '', roleMapSaving: false };
/** Cluster accounts are read per cluster, on demand — one call each, not on every render. */
const cu = { byCluster: {}, loading: new Set() };

export function render(el) {
  host = el;
  el.classList.add('dense');
  draw();
  load();
  // One _security/user call per cluster, on arrival rather than on every render. A
  // cluster with security off answers with an error, which is cached the same way — it
  // should be asked once, not on a loop.
  clusters().forEach((c) => { if (!cu.byCluster[c.id] && !cu.loading.has(c.id)) loadClusterUsers(c.id); });
}
export function onData() { /* accounts do not change when cluster data does */ }

async function load() {
  const who = await bridge({ type: 'WHOAMI' });
  ui.caller = (who && who.caller) || null;
  ui.apiTokens = !!(who && who.apiTokens);

  const res = await bridge({ type: 'USER_LIST' });
  if (res && res.ok) { ui.users = res.users || []; ui.err = ''; }
  else ui.err = (res && res.message) || 'Could not read the account list.';

  const lg = await bridge({ type: 'USER_LOGINS' });
  if (lg && lg.ok) { ui.logins = lg.logins || []; ui.lockAfter = lg.lockAfter || ui.lockAfter; ui.lockMinutes = lg.lockMinutes || ui.lockMinutes; }

  await loadActivity(false);

  if (ui.apiTokens) {
    const t = await bridge({ type: 'TOKEN_LIST' });
    ui.tokens = (t && t.ok && t.tokens) || [];
    await loadRoleMap();
  }
  draw();
}

const ROLE_HELP = {
  admin: 'Everything: accounts, secrets, the config, removing clusters, and writing to clusters.',
  operator: 'Runs the fleet: every cluster read-only (GET and searches), alerts, silences, automation, and adding, changing or switching off a cluster — not removing one, not its credential, not accounts or the rest of the config.',
  user: 'Read-only: clusters and the REST console (GET and searches). No Automation or Config.',
  guest: 'The dashboard only — no index names.',
};

/* ------------------------------- the Zabbix role map ------------------------------- */

/** What a Zabbix role may become here. `none` is a Zabbix role that is not signed in at all. */
export const ROLE_TARGETS = [['admin', 'admin — manage'], ['operator', 'operator — operate'], ['user', 'user — view'], ['guest', 'guest — dashboard'], ['none', 'none — not signed in']];
/** Zabbix's user types, which the map falls back to when a role name is not listed. */
export const ZABBIX_TYPES = [[1, 'Zabbix User'], [2, 'Zabbix Admin'], [3, 'Zabbix Super admin']];

async function loadRoleMap() {
  const r = await bridge({ type: 'ZABBIX_ROLEMAP_GET' });
  if (!r || !r.ok) { ui.roleMapErr = (r && r.message) || 'Could not read the role map.'; return; }
  ui.roleMap = { names: { ...(r.roleMap && r.roleMap.names) }, types: { ...(r.roleMap && r.roleMap.types) } };
  ui.roleDefaults = r.defaults || null;
  ui.zabbixRoles = Array.isArray(r.zabbixRoles) ? r.zabbixRoles : [];
  ui.roleMapNote = r.zabbixError || '';
  ui.roleMapErr = '';
}

/**
 * The names the card lists: every name the map holds, and every role Zabbix has (when its
 * API is paired), once each, A–Z. A role Zabbix has but the map does not is "by user type".
 */
export function roleMapNames(map, zabbixRoles) {
  const seen = new Map();
  for (const z of zabbixRoles || []) if (z && z.name) seen.set(String(z.name), Number(z.type) || 0);
  for (const n of Object.keys((map && map.names) || {})) if (!seen.has(n)) seen.set(n, 0);
  return [...seen.entries()].map(([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The message the Save button sends, from what the card shows: the three types, each with
 * a role; the names that have one (a name left "by user type" is not written).
 */
export function roleMapMessage(types, names) {
  const out = { names: {}, types: {} };
  for (const [t] of ZABBIX_TYPES) if (types[t]) out.types[String(t)] = types[t];
  for (const [n, v] of Object.entries(names)) if (v) out.names[n] = v;
  return out;
}

function roleMapCard() {
  if (!ui.roleMap) {
    return card('Zabbix role map', 'what a Zabbix sign-in becomes here',
      h('div.muted', ui.roleMapErr || 'Loading…'));
  }
  const map = ui.roleMap;
  const names = roleMapNames(map, ui.zabbixRoles);
  const typeOf = (t) => map.types[String(t)] || (ui.roleDefaults && ui.roleDefaults.types && ui.roleDefaults.types[String(t)]) || 'none';
  const typeRows = ZABBIX_TYPES.map(([t, label]) => h('tr',
    h('td', h('b', label), h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, `user type ${t}`)),
    h('td', select(`rm-type-${t}`, typeOf(t), ROLE_TARGETS)),
    h('td.muted', { style: { fontSize: '11px' } }, 'when the role name below is not listed, or the Zabbix module is older than 2.1.13')));
  const nameRows = names.map((z, i) => h('tr', { 'data-role-name': z.name },
    h('td', h('b', z.name), z.type ? h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, `a ${(ZABBIX_TYPES.find(([t]) => t === z.type) || [])[1] || `type ${z.type}`} role`) : null),
    h('td', select(`rm-name-${i}`, map.names[z.name] || '', [['', z.type ? `by user type (${typeOf(z.type)})` : 'by user type'], ...ROLE_TARGETS])),
    h('td', { style: { textAlign: 'right' } },
      map.names[z.name] !== undefined && !ui.zabbixRoles.some((r) => r.name === z.name)
        ? h('button.btn.sm.ghost', { title: `Forget ${z.name}; its holders go by user type`, onclick: () => { delete map.names[z.name]; draw(); } }, '×')
        : null)));
  const addRow = h('tr',
    h('td', h('input#rm-new-name', { type: 'text', placeholder: 'a Zabbix role name', 'aria-label': 'Zabbix role name', style: { width: '100%' } })),
    h('td', select('rm-new-target', 'operator', ROLE_TARGETS)),
    h('td', { style: { textAlign: 'right' } }, h('button.btn.sm', { onclick: () => {
      const n = val('rm-new-name').trim();
      if (!n) return;
      readRoleMapFromPage();
      map.names[n] = val('rm-new-target');
      draw();
    } }, 'Add')));
  const defaults = ui.roleDefaults && ui.roleDefaults.types
    ? ZABBIX_TYPES.map(([t, l]) => `${l} → ${ui.roleDefaults.types[String(t)]}`).join(', ') : '';
  return card('Zabbix role map', 'what a Zabbix sign-in becomes here — applied at the next sign-in; an account pinned above keeps its pin',
    h('div',
      ui.roleMapErr ? h('div', { style: { color: 'var(--critical)', fontSize: '12px', marginBottom: '6px' } }, ui.roleMapErr) : null,
      table(['Zabbix role', 'Becomes', ''], [...typeRows, ...nameRows, addRow]),
      h('div.muted', { style: { fontSize: '11.5px', marginTop: '6px' } },
        defaults ? `Shipped: ${defaults}. ` : '',
        'A role name wins over its user type when the Zabbix module sends it (modules 2.1.13 on). ',
        ui.roleMapNote ? h('span', { title: ui.roleMapNote }, 'Zabbix’s role names could not be listed (hover for why) — type them. ') : null)),
    [h('button.btn.sm.primary', { disabled: ui.roleMapSaving, onclick: saveRoleMap }, ui.roleMapSaving ? 'Working…' : 'Save role map')]);
}

/** What the card's selects say now, into ui.roleMap, so a redraw keeps unsaved choices. */
function readRoleMapFromPage() {
  const map = ui.roleMap;
  if (!map || !host) return;
  for (const [t] of ZABBIX_TYPES) { const v = val(`rm-type-${t}`); if (v) map.types[String(t)] = v; }
  roleMapNames(map, ui.zabbixRoles).forEach((z, i) => {
    const el = host.querySelector(`#rm-name-${i}`);
    if (!el) return;
    if (el.value) map.names[z.name] = el.value; else delete map.names[z.name];
  });
}

async function saveRoleMap() {
  readRoleMapFromPage();
  ui.roleMapSaving = true; draw();
  const res = await bridge({ type: 'ZABBIX_ROLEMAP_SET', roleMap: roleMapMessage(ui.roleMap.types, ui.roleMap.names) });
  ui.roleMapSaving = false;
  if (!res || !res.ok) {
    ui.roleMapErr = (res && res.message) || 'The core refused the role map.';
    toast('Role map not saved', 'err', 9000, { detail: [ui.roleMapErr] });
  } else {
    toast('Role map saved', 'ok', 5000, { detail: ['It applies to the next Zabbix sign-in. Accounts pinned here keep their role.'] });
    await loadRoleMap();
  }
  draw();
}

/** What each role may do, in the words an admin chooses by: view, write, manage. */
const ACCESS = { admin: 'manage', operator: 'operate', user: 'view', guest: 'dashboard' };

function roleCell(role) {
  const cls = role === 'admin' ? 'red' : role === 'operator' ? 'yellow' : role === 'user' ? '' : 'grey';
  return h('span', { title: ROLE_HELP[role] || '' }, pill(ACCESS[role] || role, cls),
    h('span.muted', { style: { marginLeft: '5px', fontSize: '11px' } }, role));
}

const when = (sec) => (sec ? new Date(sec * 1000).toLocaleString() : '');

/** Active, locked (by an admin or by itself, and until when) or blocked. */
function statusCell(u) {
  if (u.disabled) return h('span', { title: 'Every request is refused until an admin unblocks it. Their session stays open.' }, pill('blocked', 'red'));
  if (u.locked) return h('span', { title: 'No new sign-in until an admin unlocks it.' }, pill('locked', 'yellow'));
  if (u.lockedUntil) {
    return h('span', { title: `${u.failedLogins} wrong passwords in a row` }, pill('locked', 'yellow'),
      h('span.muted', { style: { marginLeft: '5px', fontSize: '11px' } }, `until ${new Date(u.lockedUntil * 1000).toLocaleTimeString()}`));
  }
  return pill('active', 'green');
}

function signInCell(u) {
  return h('div', { style: { fontSize: '11.5px' } },
    h('div', u.lastLogin ? when(u.lastLogin) : h('span.muted', 'never')),
    u.failedLogins ? h('div', { style: { color: 'var(--critical)' } },
      `${u.failedLogins} failed${u.lastFailed ? ` · last ${when(u.lastFailed)}` : ''}`) : null);
}

/**
 * What the role editor says about a Zabbix account's role, and whether to offer handing it
 * back. One definition, used by the dialog and the origin cell's tooltip, so the two cannot
 * tell an admin different things. `null` for a local account: there is nothing to follow.
 *
 * Zabbix sets the role at each sign-in until an admin changes it here; the core then pins
 * it (`role_pinned`, auth.rs) and later sign-ins keep it. Nothing about this is kept in the
 * browser — it is the account's own field, read from USER_LIST.
 */
export function zabbixRoleNote(u) {
  if (!u || u.source !== 'zabbix') return null;
  return u.rolePinned
    ? { pinned: true, text: 'Pinned here. Zabbix sign-ins no longer change it.' }
    : { pinned: false, text: 'Follows Zabbix at each sign-in — the role map on this page says what each Zabbix role becomes. Changing it here pins it.' };
}

/**
 * Where an account comes from, and what it may see. A Zabbix account's groups are rewritten
 * from Zabbix at every sign-in, and so is its role unless an admin pinned it here — saying
 * which is the difference between an admin editing it and wondering why the edit did not stick.
 */
export function originCell(u) {
  if (u.source !== 'zabbix') return h('span.muted', { style: { fontSize: '11.5px' } }, 'local');
  const scope = Array.isArray(u.scope)
    ? (u.scope.length ? `clusters for: ${u.scope.join(', ')}` : 'in no mapped Zabbix group — sees no clusters')
    : 'every cluster';
  const note = zabbixRoleNote(u);
  // note.text ends in a full stop, so the scope that follows starts a sentence of its own.
  const sees = scope.charAt(0).toUpperCase() + scope.slice(1);
  return h('span', { title: `Signed in through Zabbix. Groups follow Zabbix at each sign-in. Role: ${note.text} ${sees}.` },
    pill('zabbix', ''),
    note.pinned ? h('span.role-pinned', { style: { marginLeft: '4px' } }, pill('pinned', 'grey')) : null,
    h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, scope));
}

/* ------------------------- the cluster's own accounts ------------------------- */

/**
 * Elasticsearch accounts, per cluster.
 *
 * Kept firmly apart from the list above, because two different things are called "user"
 * here: an ElasticPro account signs in to this app and its role decides which pages it
 * sees; an Elasticsearch account signs in to a cluster and its roles decide which indices
 * it can read. Neither implies the other, and showing them in one table would suggest
 * they do.
 */
function clusterUsersCard() {
  const all = clusters();
  if (!all.length) return card('Cluster users', 'no clusters configured', empty('Add a cluster first.'));
  // One cluster selected: its accounts, in full, with the controls to manage them.
  // "All": which accounts exist where, which is the question you ask across a fleet.
  if (state.selected === 'all' && all.length > 1) return clusterUserMatrix(all);
  const c = activeClusters()[0] || all[0];
  return clusterUserDetail(c);
}

/** Every account on the selected cluster, with edit and remove. */
function clusterUserDetail(c) {
  const got = cu.byCluster[c.id];
  const reload = () => loadClusterUsers(c.id);
  const refreshBtn = h('button.btn.sm.ghost',
    { onclick: reload, title: `Re-read the accounts on ${c.name}` },
    cu.loading.has(c.id) ? 'Loading…' : ICON.refresh);

  let body;
  if (!got) {
    body = empty(cu.loading.has(c.id) ? 'Reading accounts…' : 'Not read yet.');
  } else if (got.error) {
    body = h('div',
      h('div', { style: { fontSize: '12px', color: 'var(--warning)' } }, got.error),
      got.fix ? h('div.muted', { style: { fontSize: '11.5px', marginTop: '4px' } }, got.fix) : null);
  } else {
    const trs = got.users.map((u) => h('tr',
      h('td', h('b', u.name),
        u.reserved ? h('span.muted', { style: { marginLeft: '6px', fontSize: '10.5px' } }, '(built-in)') : null,
        !u.enabled ? h('span.muted', { style: { marginLeft: '6px', fontSize: '10.5px' } }, '(disabled)') : null),
      h('td', h('span.mono', { style: { fontSize: '11px' } }, (u.roles || []).join(', ') || '–')),
      h('td.muted', { style: { fontSize: '11.5px' } }, u.fullName || u.email || ''),
      h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
        h('button.btn.sm.ghost', {
          // Built-ins are refused here rather than at the cluster: Elasticsearch answers a
          // reserved-account write with a 400 about a metadata field, which explains
          // nothing to the person who clicked.
          disabled: u.reserved,
          title: u.reserved ? 'Built-in accounts cannot be edited' : `Edit ${u.name} on ${c.name}`,
          onclick: () => editDialog(c.id, u, { onDone: reload }),
        }, ICON.edit),
        h('button.btn.sm.ghost', {
          disabled: u.reserved,
          style: { marginLeft: '4px' },
          title: u.reserved ? 'Built-in accounts cannot be removed' : `Remove ${u.name} from ${c.name}`,
          onclick: () => removeClusterUser(c.id, u.name, { onDone: reload }),
        }, ICON.delete))));
    body = table(['Name', 'Roles', '', ''], trs, {
      emptyText: empty('No accounts are defined on this cluster.', {
        detail: 'Only native-realm accounts appear here. Accounts from an LDAP, SAML or '
              + 'file realm are managed where that realm lives, not in Elasticsearch.',
      }),
    });
  }

  const count = got && !got.error ? `${got.users.length} account${got.users.length === 1 ? '' : 's'}` : c.url;
  // Title stays "Cluster users" — which cluster belongs in the subtitle, and the title is
  // what the page contract (and behaviour-check) identifies this card by.
  return card('Cluster users', `${c.name} · ${count}`, body,
    [refreshBtn,
     h('button.btn.sm.primary', {
       onclick: () => createDialog({ preselect: [c.id], onDone: reload }),
     }, '+ Create')]);
}

/**
 * Which account exists on which cluster.
 *
 * A cell is YES, NO, or neither: a cluster that refused the read, or has not answered
 * yet, cannot contribute a NO. NO here means "asked, and it is not there" — rendering an
 * unread cluster as NO would invent an absence, and absence is exactly what this table is
 * used to act on.
 */
function clusterUserMatrix(all) {
  const names = new Set();
  for (const c of all) {
    const got = cu.byCluster[c.id];
    if (got && !got.error) got.users.forEach((u) => names.add(u.name));
  }
  const sorted = [...names].sort((a, b) => a.localeCompare(b));

  const known = (c) => {
    const got = cu.byCluster[c.id];
    return got && !got.error ? new Set(got.users.map((u) => u.name)) : null;
  };
  const sets = all.map((c) => ({ c, set: known(c) }));
  const unreadable = sets.filter((x) => !x.set).map((x) => x.c.name);

  const trs = sorted.map((name) => h('tr',
    h('td', h('b', name)),
    ...sets.map(({ set }) => h('td', { style: { textAlign: 'center' } },
      set === null
        ? h('span.muted', { title: 'This cluster could not be read — not the same as absent' }, '—')
        : set.has(name)
          ? h('span', { style: { color: 'var(--ok, #2e7d32)', fontWeight: '600' }, title: 'Present on this cluster' }, 'YES')
          : h('span', { style: { color: 'var(--warning)', fontWeight: '600' }, title: 'Not present on this cluster' }, 'NO')))));

  return card('Cluster users',
    `all clusters · ${sorted.length} account${sorted.length === 1 ? '' : 's'} across ${all.length} clusters`,
    h('div',
      unreadable.length
        ? h('div.muted', { style: { fontSize: '11.5px', marginBottom: '8px' } },
            `Could not read: ${unreadable.join(', ')} — those columns show “—”, not NO.`)
        : null,
      table(['User', ...all.map((c) => c.name)], trs, {
        emptyText: empty('No accounts read yet.', {
          detail: 'Select a single cluster to read and manage its accounts, or refresh below.',
        }),
      })),
    [h('button.btn.sm.ghost', { onclick: () => all.forEach((c) => loadClusterUsers(c.id)), title: 'Re-read every cluster' },
       cu.loading.size ? 'Loading…' : ICON.refresh),
     h('button.btn.sm.primary', {
       onclick: () => createDialog({ onDone: () => all.forEach((c) => loadClusterUsers(c.id)) }),
     }, '+ Create')]);
}

async function loadClusterUsers(id) {
  cu.loading.add(id); draw();
  cu.byCluster[id] = await fetchClusterUsers(id);
  cu.loading.delete(id); draw();
}

/** A labelled rule between two groups of cards that are about different things. */
function sectionBreak(title, sub) {
  return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', margin: '18px 0 2px' } },
    h('h3', { style: { margin: 0, fontSize: '13px', letterSpacing: '.02em' } }, title),
    h('span.muted', { style: { fontSize: '11.5px' } }, sub),
    h('div', { style: { flex: 1, borderBottom: '1px solid var(--border)', marginBottom: '4px' } }));
}

function draw() {
  if (!host || !host.isConnected) return;
  const admins = ui.users.filter((u) => u.role === 'admin' && !u.disabled).length;

  mount(host,
    ui.err ? h('div.banner.err', { role: 'alert' }, h('div', h('div.ttl', 'Accounts'), h('div', ui.err))) : null,

    h('div.grid.c4', { style: { marginBottom: '10px' } },
      statTile('Accounts', String(ui.users.length), 'who can sign in'),
      statTile('Administrators', String(admins), admins === 1 ? 'the only one — cannot be removed' : 'full control'),
      statTile('Operators', String(ui.users.filter((u) => u.role === 'operator').length), 'run the fleet: clusters, alerts, automation'),
      statTile('Read-only', String(ui.users.filter((u) => u.role === 'user' || u.role === 'guest').length),
        `${ui.users.filter((u) => u.role === 'guest').length} of them guests`)),

    h('div.toolbar',
      h('button.btn.sm.primary', { onclick: () => editUser(null) }, '+ New ElasticPro user'),
      h('button.btn.sm', { onclick: load }, '↻ Reload'),
      h('div', { style: { marginLeft: 'auto' } },
        h('span.muted', { style: { fontSize: '11px' } },
          ui.caller ? `signed in as ${ui.caller.name}` : ''))),

    sectionBreak('On this installation', 'who can sign in to ElasticPro, and the tokens that stand in for them'),

    h('div', { style: { marginTop: '10px' } },
      card('ElasticPro users', `${ui.users.length} who can sign in to this app`,
        table(['Name', 'Access', 'Status', 'Origin', 'Last sign-in', ''], ui.users.map((u) => h('tr',
          h('td', h('b', u.name),
            h('div.muted', { style: { fontSize: '11px' } }, u.createdAt ? `created ${new Date(u.createdAt * 1000).toISOString().slice(0, 10)}` : '')),
          h('td', roleCell(u.role)),
          h('td', statusCell(u)),
          h('td', originCell(u)),
          h('td', signInCell(u)),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button.btn.sm', { onclick: () => editUser(u) }, 'Edit'),
            isSelf(u) ? null : h('button.btn.sm.ghost', { style: { marginLeft: '6px' },
              title: u.locked || u.lockedUntil ? 'Let them sign in again' : 'No new sign-in until you unlock it; an open session carries on',
              onclick: () => setFlag(u, 'locked', !(u.locked || u.lockedUntil)) }, u.locked || u.lockedUntil ? 'Unlock' : 'Lock'),
            isSelf(u) ? null : h('button.btn.sm.ghost', { style: { marginLeft: '6px' },
              title: u.disabled ? 'Let them work again' : 'Refuse everything they do from now on, signed in or not',
              onclick: () => setFlag(u, 'blocked', !u.disabled) }, u.disabled ? 'Unblock' : 'Block'),
            // A Zabbix account has no password here; offering to set one would be offering
            // a second way in that the core refuses anyway.
            u.source === 'zabbix' ? null
              : h('button.btn.sm.ghost', { style: { marginLeft: '6px' }, onclick: () => setPassword(u) }, 'Password'),
            h('button.btn.sm.ghost', {
              style: { marginLeft: '6px' },
              title: isSelf(u) ? 'You cannot remove the account you are signed in as' : `Remove ${u.name}`,
              disabled: isSelf(u),
              onclick: () => removeUser(u),
            }, '×')))),
          { emptyText: 'No accounts yet.' }))),

    h('div', { style: { marginTop: '10px' } }, loginsCard()),
    h('div', { style: { marginTop: '10px' } }, activityCard()),

    ui.apiTokens ? h('div', { style: { marginTop: '10px' } }, tokensCard()) : notHostedNote(),
    // Zabbix signs people in only on the hosted build; elsewhere there is nothing to map.
    ui.apiTokens ? h('div', { style: { marginTop: '10px' } }, roleMapCard()) : null,

    // A visible line between the two, because everything above it is a credential for
    // this app and everything below it is a credential for a cluster. They are stored in
    // different places, they are changed in different places, and the only thing they
    // have in common is the word "user".
    sectionBreak('On the clusters', 'accounts that sign in to Elasticsearch itself'),
    h('div', { style: { marginTop: '10px' } }, clusterUsersCard()),
  );
}

/**
 * Every sign-in attempt the core has seen since it started, newest first, with the error
 * code a refused one carried. A wrong password is listed under the name that was typed,
 * real or not — a run of them against one name is what a lockout is for.
 */
function loginsCard() {
  const rows = ui.failedOnly ? ui.logins.filter((e) => !e.ok) : ui.logins;
  const failed = ui.logins.filter((e) => !e.ok).length;
  return card('Sign-in activity', `${ui.logins.length} attempts since the core started · ${failed} refused · `
      + `${ui.lockAfter} wrong passwords in a row lock an account for ${ui.lockMinutes} minutes`,
    h('div', { style: { maxHeight: '320px', overflowY: 'auto' } },
      table(['When', 'Name', 'Via', 'Result'], rows.slice(0, 200).map((e) => h('tr',
        h('td.muted', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, when(e.at)),
        h('td', h('b', e.name || '—')),
        h('td.muted', e.via === 'zabbix' ? 'Zabbix' : 'password'),
        h('td', e.ok ? pill('signed in', 'green')
          : h('span', pill(e.code || 'refused', 'red'), h('span.muted', { style: { marginLeft: '6px', fontSize: '11.5px' } }, LOGIN_KIND[e.kind] || e.kind))))),
        { emptyText: ui.failedOnly ? 'No refused sign-in.' : 'No sign-in since the core started.' })),
    [h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12px' } },
      h('input', { type: 'checkbox', checked: ui.failedOnly, onchange: (e) => { ui.failedOnly = e.target.checked; draw(); } }),
      'Refused only')]);
}

/** The core's activity record, newest first. Filtered there, so the filters see all 1000 it keeps. */
async function loadActivity(redraw = true) {
  const res = await bridge({ type: 'ACTIVITY_LIST', limit: 300, user: ui.activityUser.trim() || undefined, failedOnly: ui.activityFailed });
  if (res && res.ok) { ui.activity = res.events || []; ui.activityFile = res.file || null; ui.activityErr = ''; }
  else ui.activityErr = (res && res.message) || 'Could not read the activity record.';
  if (redraw) draw();
}

/**
 * What people did, reads included: every request to a cluster, sign-ins and refusals. The
 * same events are appended to a file as JSON lines for a SIEM; this is the last few hundred.
 */
function activityCard() {
  const where = ui.activityFile
    ? h('span', 'Written as JSON lines to ', h('code', ui.activityFile), ' for SIEM forwarding.')
    : h('span', 'Not written to a file here (ELASTICPRO_ACTIVITY_LOG is off or there is no data directory).');
  return card('User activity', `${ui.activity.length} shown, newest first · kept in memory since the core started`,
    h('div',
      ui.activityErr ? h('div.muted', { style: { color: 'var(--red, #c0392b)' } }, ui.activityErr) : null,
      h('div', { style: { maxHeight: '360px', overflowY: 'auto' } },
        table(['When', 'User', 'Action', 'Cluster', 'Request', 'Result', 'Source IP'], ui.activity.map((e) => {
          const ev = e.event || {};
          const req = e.http && e.http.request ? `${e.http.request.method} ${(e.url && e.url.path) || ''}` : '';
          return h('tr',
            h('td.muted', { style: { fontSize: '11.5px', whiteSpace: 'nowrap' } }, e['@timestamp'] ? new Date(e['@timestamp']).toLocaleString() : ''),
            h('td', h('b', (e.user && e.user.name) || '—'), e.user && e.user.target ? h('span.muted', ` → ${e.user.target.name}`) : null),
            h('td', ev.action || ''),
            h('td.muted', (e.elasticpro && e.elasticpro.cluster) || ''),
            h('td', { style: { fontFamily: 'var(--mono, monospace)', fontSize: '11.5px', wordBreak: 'break-all' }, title: (e.url && e.url.query) || '' }, req),
            h('td', ev.outcome === 'success' ? pill('ok', 'green')
              : h('span', { title: ev.reason || '' }, pill((e.error && e.error.code) || 'failed', 'red'))),
            h('td.muted', (e.source && e.source.ip) || ''));
        }), { emptyText: ui.activityFailed ? 'No failed action.' : 'Nothing recorded yet.' })),
      h('div.muted', { style: { fontSize: '11.5px', marginTop: '6px' } }, where)),
    [h('input', { type: 'search', placeholder: 'user', value: ui.activityUser, 'aria-label': 'Filter by user', style: { width: '120px' },
        onchange: (e) => { ui.activityUser = e.target.value; loadActivity(); } }),
     h('label', { style: { display: 'inline-flex', gap: '5px', alignItems: 'center', fontSize: '12px' } },
       h('input', { type: 'checkbox', checked: ui.activityFailed, onchange: (e) => { ui.activityFailed = e.target.checked; loadActivity(); } }),
       'Failures only'),
     h('button.btn.sm.ghost', { onclick: () => loadActivity() }, 'Refresh')]);
}

const LOGIN_KIND = {
  bad_credentials: 'wrong name or password',
  locked: 'account locked',
  disabled: 'account blocked',
  rate_limited: 'too many wrong passwords — slowed down',
  name_taken: 'a local account has that name',
  io_error: 'could not save the account',
};

/** Lock / unlock (sign-in) or block / unblock (everything). */
async function setFlag(u, which, on) {
  if (on) {
    const lock = which === 'locked';
    const ok = await confirmDialog(`${lock ? 'Lock' : 'Block'} ${u.name}?`,
      lock ? 'They cannot sign in until you unlock the account. A session they already have open carries on.'
        : 'Everything they do is refused from now on, signed in or not, until you unblock the account. Nobody is signed out.',
      { yes: lock ? 'lock' : 'block', danger: !lock });
    if (!ok) return;
  }
  const res = await bridge({ type: which === 'locked' ? 'USER_SET_LOCKED' : 'USER_SET_BLOCKED', name: u.name, [which]: on });
  const verb = which === 'locked' ? (on ? 'locked' : 'unlocked') : (on ? 'blocked' : 'unblocked');
  if (!res || !res.ok) toast(`Could not change ${u.name}`, 'err', 9000, { detail: [(res && res.message) || 'The server refused it.'] });
  else toast(`${u.name} ${verb}`, 'ok', 4000);
  await load();
}

function isSelf(u) {
  return !!(ui.caller && u.name.toLowerCase() === String(ui.caller.name).toLowerCase());
}

function notHostedNote() {
  return h('div', { style: { marginTop: '10px' } },
    h('div.banner',
      h('div',
        h('div.ttl', 'API tokens are not available on this build'),
        h('div',
          'A token is only useful to something that can make an HTTP request to this core. '
          + 'The desktop app talks to its core over local IPC and has no socket to serve one on, '
          + 'so tokens — including the one Zabbix would use — belong to the hosted deployment.'))));
}

function tokensCard() {
  return h('div', { style: { marginTop: '10px' } },
    ui.freshSecret
      ? h('div.banner', { style: { marginBottom: '10px' }, role: 'alert' },
          h('div',
            h('div.ttl', `Token "${ui.freshSecret.name}" created — copy it now`),
            h('div', { style: { marginBottom: '6px' } },
              'This is the only time it is shown. It is stored as a hash, so it cannot be shown again.'),
            h('code.inline', { style: { userSelect: 'all', wordBreak: 'break-all' } }, ui.freshSecret.secret),
            h('div', { style: { marginTop: '8px' } },
              h('button.btn.sm', { onclick: () => { ui.freshSecret = null; draw(); } }, 'I have copied it'))))
      : null,
    card('API tokens', 'for Zabbix and scripts — not people',
      table(['Name', 'Role', 'Created', 'Last used', ''], ui.tokens.map((t) => h('tr',
        h('td', h('b', t.name)),
        h('td', roleCell(t.role)),
        h('td.muted', { style: { fontSize: '11.5px' } }, t.createdAt ? new Date(t.createdAt * 1000).toISOString().slice(0, 10) : ''),
        h('td.muted', { style: { fontSize: '11.5px' } }, t.lastUsed ? new Date(t.lastUsed * 1000).toISOString().slice(0, 16).replace('T', ' ') : 'never'),
        h('td', { style: { textAlign: 'right' } },
          h('button.btn.sm.ghost', { onclick: () => revokeToken(t) }, 'Revoke')))),
        { emptyText: 'No tokens yet.' }),
      h('button.btn.sm.primary', { onclick: newToken }, '+ New token')));
}

/* ---------------------------------- actions ---------------------------------- */

/** Hand a pinned Zabbix account's role back to Zabbix, from its next sign-in. */
async function followZabbix(u, ctx) {
  const res = await bridge({ type: 'USER_UNPIN_ROLE', name: u.name });
  if (!res || !res.ok) throw new Error((res && res.message) || 'The server refused it.');
  toast(`${u.name} follows Zabbix again`, 'ok', 5000,
    { detail: ['its role is set from Zabbix at its next sign-in; until then it stays ' + u.role] });
  ctx.done(true);
  await load();
}

export function editUser(existing) {
  const isNew = !existing;
  const note = zabbixRoleNote(existing);
  // The dialog's context exists only once modal() has drawn the buttons; the "Follow Zabbix
  // again" button in the body is drawn before that, so it reaches the context through here.
  let dlg = null;
  const roleHint = note
    ? h('span.role-note', note.text,
      note.pinned
        ? h('button.btn.sm.ghost', { type: 'button', style: { marginLeft: '6px' },
          title: 'Zabbix sets this account’s role again from its next sign-in',
          onclick: (e) => { e.preventDefault(); if (dlg) dlg.run(e.target, () => followZabbix(existing, dlg)); } }, 'Follow Zabbix again')
        : null)
    : null;
  modal(
    isNew ? 'New account' : `Edit ${existing.name}`,
    isNew ? 'They sign in with this name and password.'
      : note
        ? 'This account signs in through Zabbix. What they may do changes at once, in any session they have open.'
        : 'What they may do changes at once, in any session they have open. Nobody is signed out.',
    [
      isNew ? field('User name', text('acct-name', '')) : null,
      isNew
        ? field('Password', text('acct-pw', '', { type: 'password' }), `At least ${MIN_PASSWORD} characters.`)
        : null,
      field('Access', select('acct-role', existing ? existing.role : 'user', [
        ['user', 'View (user) — read-only clusters and REST console; no Automation or Config'],
        ['operator', 'Operate (operator) — every cluster read-only, alerts and silences, no cluster changes'],
        ['admin', 'Manage (admin) — everything: cluster changes, accounts, secrets, config'],
        ['guest', 'Dashboard (guest) — the dashboard only, no index names'],
      ]), roleHint),
    ].filter(Boolean),
    (ctx) => { dlg = ctx; return [
      h('button.btn', { onclick: () => ctx.done(false) }, 'Cancel'),
      h('button.btn.primary', {
        // ctx.run + ctx.msg: a refusal belongs in the dialog the operator is looking at.
        // ui.err draws the page's banner behind the open dialog, where nobody sees it.
        onclick: (e) => ctx.run(e.target, async () => {
          const name = isNew ? val('acct-name') : existing.name;
          const role = val('acct-role');
          if (isNew && !name.trim()) throw new Error('Give the account a name.');
          if (isNew && val('acct-pw').length < MIN_PASSWORD) {
            throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
          }
          const res = isNew
            ? await bridge({ type: 'USER_ADD', name, password: val('acct-pw'), role })
            : await bridge({ type: 'USER_SET_ROLE', name, role });
          if (!res || !res.ok) throw new Error((res && res.message) || 'The server refused it.');
          toast(isNew ? `Account ${name} created` : `${name} is now ${role}`, 'ok', 5000,
            { detail: [isNew ? `access: ${role}` : 'their open sessions have it now',
              ...(res.pinned ? ['pinned: Zabbix sign-ins no longer change it'] : [])] });
          ctx.done(true);
          await load();
        }),
      }, isNew ? 'Create' : 'Save'),
    ]; },
  );
}

function setPassword(u) {
  modal(`New password for ${u.name}`,
    isSelf(u) ? 'You stay signed in.' : 'They are signed out of any session they have open.',
    [field('Password', text('acct-newpw', '', { type: 'password' }), `At least ${MIN_PASSWORD} characters.`)],
    (ctx) => [
      h('button.btn', { onclick: () => ctx.done(false) }, 'Cancel'),
      h('button.btn.primary', {
        onclick: (e) => ctx.run(e.target, async () => {
          if (val('acct-newpw').length < MIN_PASSWORD) {
            throw new Error(`The password needs at least ${MIN_PASSWORD} characters.`);
          }
          const res = await bridge({ type: 'USER_SET_PASSWORD', name: u.name, password: val('acct-newpw') });
          if (!res || !res.ok) throw new Error((res && res.message) || 'The server refused it.');
          toast(`Password set for ${u.name}`, 'ok', 5000,
            { detail: [isSelf(u) ? 'you stay signed in' : 'their open sessions end now'] });
          ctx.done(true);
          await load();
        }),
      }, 'Set password'),
    ]);
}

async function removeUser(u) {
  if (!(await confirmDialog(`Remove the account "${u.name}"?`,
    'They are signed out at once and can no longer sign in. Nothing they did is undone.',
    { yes: 'remove', danger: true }))) return;
  const res = await bridge({ type: 'USER_REMOVE', name: u.name });
  if (!res || !res.ok) toast(`Could not remove ${u.name}`, 'err', 9000, { detail: [(res && res.message) || 'The server refused it.'] });
  else toast(`Account ${u.name} removed`, 'ok', 5000, { detail: ['any session it had is closed'] });
  await load();
}

function newToken() {
  modal('New API token', 'For Zabbix or a script. A token can never be an administrator.',
    [
      field('Name', text('tok-name', ''), 'How you will recognise it later, e.g. "zabbix".'),
      field('Role', select('tok-role', 'guest', [
        ['guest', 'guest — cluster health only'],
        ['user', 'user — read-only across every page'],
      ]), 'The automation scrape needs "user"; a health-only dashboard needs "guest".'),
      field('Expires after (days)', text('tok-ttl', '', { type: 'number' }), 'Leave blank for no expiry.'),
    ],
    (ctx) => [
      h('button.btn', { onclick: () => ctx.done(false) }, 'Cancel'),
      h('button.btn.primary', {
        onclick: (e) => ctx.run(e.target, async () => {
          const ttl = Number(val('tok-ttl'));
          if (!val('tok-name').trim()) throw new Error('Give the token a name.');
          const res = await bridge({
            type: 'TOKEN_CREATE',
            name: val('tok-name'),
            role: val('tok-role'),
            ...(ttl > 0 ? { expiresDays: ttl } : {}),
          });
          if (!res || !res.ok) throw new Error((res && res.message) || 'The server refused it.');
          ui.freshSecret = { name: val('tok-name'), secret: res.secret };
          toast(`Token ${val('tok-name')} created`, 'ok', 6000,
            { detail: ['the secret is on the page — it is shown once'] });
          ctx.done(true);
          await load();
        }),
      }, 'Create token'),
    ]);
}

async function revokeToken(t) {
  if (!(await confirmDialog(`Revoke the token "${t.name}"?`,
    'Anything using it stops working at once. A revoked token cannot be restored.',
    { yes: 'revoke', danger: true }))) return;
  const res = await bridge({ type: 'TOKEN_REVOKE', id: t.id });
  if (!res || !res.ok) toast(`Could not revoke ${t.name}`, 'err', 9000, { detail: [(res && res.message) || 'The server refused it.'] });
  else toast(`Token ${t.name} revoked`, 'ok', 5000, { detail: ['anything using it stops now'] });
  await load();
}
