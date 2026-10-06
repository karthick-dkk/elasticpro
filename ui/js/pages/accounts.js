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
const ui = { users: [], tokens: [], caller: null, apiTokens: false, err: '', freshSecret: null };
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

  if (ui.apiTokens) {
    const t = await bridge({ type: 'TOKEN_LIST' });
    ui.tokens = (t && t.ok && t.tokens) || [];
  }
  draw();
}

const ROLE_HELP = {
  admin: 'Everything: accounts, secrets, the config, and writing to clusters.',
  operator: 'Every cluster, and may write to them behind the write unlock — but no accounts, secrets or config.',
  user: 'Read-only across every page.',
  guest: 'The dashboard only — no index names.',
};

function roleCell(role) {
  const cls = role === 'admin' ? 'red' : role === 'operator' ? 'yellow' : role === 'user' ? '' : 'grey';
  return h('span', { title: ROLE_HELP[role] || '' }, pill(role, cls));
}

/**
 * Where an account comes from, and what it may see. A Zabbix account's role and groups are
 * rewritten from Zabbix at every sign-in, so saying so here is the difference between an
 * admin editing it and wondering why the edit did not stick.
 */
function originCell(u) {
  if (u.source !== 'zabbix') return h('span.muted', { style: { fontSize: '11.5px' } }, 'local');
  const scope = Array.isArray(u.scope)
    ? (u.scope.length ? `clusters for: ${u.scope.join(', ')}` : 'in no mapped Zabbix group — sees no clusters')
    : 'every cluster';
  return h('span', { title: `Signed in through Zabbix. Role and groups follow Zabbix at each sign-in. ${scope}.` },
    pill('zabbix', ''),
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
      statTile('Operators', String(ui.users.filter((u) => u.role === 'operator').length), 'write to clusters, no admin'),
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
        table(['Name', 'Role', 'Origin', 'Created', ''], ui.users.map((u) => h('tr',
          h('td', h('b', u.name), u.disabled ? h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, '(disabled)') : null),
          h('td', roleCell(u.role)),
          h('td', originCell(u)),
          h('td.muted', { style: { fontSize: '11.5px' } }, u.createdAt ? new Date(u.createdAt * 1000).toISOString().slice(0, 10) : ''),
          h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
            h('button.btn.sm', { onclick: () => editUser(u) }, 'Edit'),
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

    ui.apiTokens ? h('div', { style: { marginTop: '10px' } }, tokensCard()) : notHostedNote(),

    // A visible line between the two, because everything above it is a credential for
    // this app and everything below it is a credential for a cluster. They are stored in
    // different places, they are changed in different places, and the only thing they
    // have in common is the word "user".
    sectionBreak('On the clusters', 'accounts that sign in to Elasticsearch itself'),
    h('div', { style: { marginTop: '10px' } }, clusterUsersCard()),
  );
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

function editUser(existing) {
  const isNew = !existing;
  modal(
    isNew ? 'New account' : `Edit ${existing.name}`,
    isNew ? 'They sign in with this name and password.'
      : existing.source === 'zabbix'
        ? 'This account signs in through Zabbix, and Zabbix sets its role again at every sign-in. Change the Zabbix user’s role to change it for good.'
        : 'Changing the role signs them out immediately.',
    [
      isNew ? field('User name', text('acct-name', '')) : null,
      isNew
        ? field('Password', text('acct-pw', '', { type: 'password' }), `At least ${MIN_PASSWORD} characters.`)
        : null,
      field('Role', select('acct-role', existing ? existing.role : 'user', [
        ['admin', 'admin — everything: accounts, secrets, config and writes'],
        ['operator', 'operator — every cluster, may write, no administration'],
        ['user', 'user — read-only across every page'],
        ['guest', 'guest — the dashboard only, no index names'],
      ])),
    ].filter(Boolean),
    (ctx) => [
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
            { detail: [isNew ? `role: ${role}` : 'their open sessions end now'] });
          ctx.done(true);
          await load();
        }),
      }, isNew ? 'Create' : 'Save'),
    ],
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
