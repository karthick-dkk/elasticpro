/**
 * The cluster's own accounts, and creating them across several clusters at once.
 *
 * Two different things are called "user" in this app and conflating them is the whole
 * reason this is a separate module. An ElasticPro account signs in to this app and its
 * role decides which pages it gets. An Elasticsearch account signs in to a cluster and
 * its roles decide which indices it can read. They live in different stores, and one
 * never implies the other.
 *
 * Creating is fanned out because that is how the drift happens: the same analyst is meant
 * to exist on eleven clusters, gets made by hand on nine of them, and the two that were
 * missed are found during an incident.
 */

import { h } from '../lib/dom.js';
import { client, clusters } from '../core/state.js';
import { modal, field, text, select, val, confirmDialog } from './modal.js';
import { toast } from './menu.js';
import { TASKS, taskById, missingFields, preview, runTask, ROLE_PRESETS, presetValues } from '../core/tasks.js';
import { ensureWrites } from '../core/writes.js';

/**
 * Read the native-realm accounts from one cluster.
 *
 * A cluster with security switched off refuses this outright, and one on LDAP or SAML
 * answers with only its built-ins. Both are reported as what they are: an empty list
 * would say "this cluster has no users", which is a different and untrue statement.
 */
export async function fetchClusterUsers(clusterId) {
  const cl = client(clusterId);
  if (!cl) return { users: null, error: 'not connected', fix: null };
  try {
    const res = await cl.securityUsers();
    const users = Object.values(res || {}).map((u) => ({
      name: u.username,
      roles: u.roles || [],
      enabled: u.enabled !== false,
      fullName: u.full_name || '',
      email: u.email || '',
      reserved: !!(u.metadata && u.metadata._reserved),
    })).sort((a, b) => a.name.localeCompare(b.name));
    return { users, error: null, fix: null };
  } catch (e) {
    // Elasticsearch puts the reason in the body; the thrown message is only the status
    // line. Reading the status line alone turned "security is switched off on this
    // cluster" into "HTTP 500 Internal Server Error", which sends you looking for a fault
    // in the app instead of at a setting in elasticsearch.yml.
    const es = e.res && e.res.json && e.res.json.error;
    const reason = (es && (es.reason || es.type)) || e.message || String(e);

    if (/security must be explicitly enabled|xpack\.security\.enabled/i.test(reason)) {
      return {
        users: null,
        error: 'Security is switched off on this cluster, so it has no accounts of its own.',
        fix: 'Set xpack.security.enabled: true in elasticsearch.yml and restart the node.',
      };
    }
    if (/no handler found for uri/i.test(reason)) {
      return {
        users: null,
        error: 'This build of Elasticsearch has no security API.',
        fix: 'The native realm needs a distribution with X-Pack — OSS builds do not have one.',
      };
    }
    if (/security_exception|unauthorized|403/i.test(reason)) {
      return {
        users: null,
        error: 'This account may not read the native realm.',
        fix: 'Reading users needs the manage_security privilege.',
      };
    }
    return { users: null, error: reason, fix: null };
  }
}

/**
 * Create a user, a role or an API key on one or more clusters.
 *
 * Nothing is asked for until the kind is chosen: a role does not need a password and a key
 * does not need roles, and a form showing every field of all three is a form where most of
 * the boxes are wrong for whatever you are doing.
 */
export async function createDialog({ preselect = [], onDone } = {}) {
  const all = clusters();
  if (!all.length) { toast('No clusters configured', 'warn'); return; }

  let task = TASKS[0];
  const chosen = new Set(preselect.length ? preselect : all.map((c) => c.id));

  // The roles each cluster already has, so a new user or key picks from what exists rather
  // than typing a name that may not — a role reference that does not exist grants nothing.
  const roleMap = new Map();          // role → Set of cluster ids that have it
  const builtIn = new Set();
  let rolesReadable = false;
  await Promise.all(all.map(async (c) => {
    try {
      const res = await client(c.id).securityRoles();
      rolesReadable = true;
      for (const [name, def] of Object.entries(res || {})) {
        if (!roleMap.has(name)) roleMap.set(name, new Set());
        roleMap.get(name).add(c.id);
        if (def && def.metadata && def.metadata._reserved) builtIn.add(name);
      }
    } catch { /* this cluster will not list its roles; the others still can */ }
  }));
  const pickedRoles = new Set();

  const rolePicker = () => {
    const filter = text('cu-role-filter', '', { placeholder: 'filter roles…' });
    const list = h('div', { style: { display: 'grid', gap: '2px', maxHeight: '170px', overflowY: 'auto',
      border: '1px solid var(--border)', borderRadius: '6px', padding: '6px 8px' } });
    const draw = () => {
      while (list.firstChild) list.removeChild(list.firstChild);
      const q = filter.value.trim().toLowerCase();
      // Your own roles first, the built-in ones after them.
      const names = [...roleMap.keys()].filter((r) => !q || r.toLowerCase().includes(q))
        .sort((a, b) => (builtIn.has(a) - builtIn.has(b)) || a.localeCompare(b));
      for (const r of names) {
        const on = [...chosen].filter((id) => roleMap.get(r).has(id)).length;
        const missing = chosen.size - on;
        list.append(h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: pickedRoles.has(r),
            onchange: (e) => { if (e.target.checked) pickedRoles.add(r); else pickedRoles.delete(r); } }),
          h('span.mono', { style: { fontSize: '11.5px' } }, r),
          builtIn.has(r) ? h('span.pill.grey', { style: { fontSize: '10px' } }, 'built-in') : null,
          missing ? h('span.muted', { style: { fontSize: '10.5px' }, title: 'A role that does not exist on a cluster grants nothing there' },
            `missing on ${missing} of ${chosen.size} selected`) : null));
      }
      if (!names.length) list.append(h('div.muted', { style: { fontSize: '12px' } }, q ? 'no role matches' : 'no roles found'));
    };
    filter.oninput = draw;
    draw();
    rerenderRoles = draw;
    return h('div', { style: { display: 'grid', gap: '5px' } }, filter, list);
  };
  let rerenderRoles = () => {};

  const fieldBox = h('div', { style: { display: 'grid', gap: '8px' } });
  const drawFields = () => {
    while (fieldBox.firstChild) fieldBox.removeChild(fieldBox.firstChild);
    // A new role starts from a preset with real values in the boxes, not blank.
    if (task.id === 'security-role') {
      const logs = () => all.filter((c) => chosen.has(c.id)).map((c) => c.logIndexPattern);
      const presetSel = select('cu-preset', ROLE_PRESETS[0].id, ROLE_PRESETS.map((p) => [p.id, `${p.label} \u2014 ${p.why}`]));
      presetSel.onchange = () => {
        const v = presetValues(ROLE_PRESETS.find((p) => p.id === presetSel.value), logs());
        for (const [k, x] of Object.entries(v)) { const el = fieldBox.querySelector(`#cu-${k}`); if (el) el.value = x; }
      };
      fieldBox.append(field('Start from', presetSel, 'fills the boxes below with a working role; change anything before creating'));
      const start = presetValues(ROLE_PRESETS[0], logs());
      for (const f of task.fields) {
        fieldBox.append(field(f.label, text(`cu-${f.name}`, start[f.name] || '', { placeholder: f.placeholder || '' }), f.hint));
      }
      return;
    }
    for (const f of task.fields) {
      if (f.name === 'roles' && rolesReadable && roleMap.size) {
        fieldBox.append(field(f.label, rolePicker(),
          task.id === 'security-user' ? 'tick the roles this account gets — they already exist on the cluster'
            : 'tick roles to limit the key to them; none ticked inherits everything the caller can do'));
        continue;
      }
      fieldBox.append(field(f.label,
        text(`cu-${f.name}`, '', {
          type: f.type === 'password' ? 'password' : 'text',
          placeholder: f.placeholder || '',
        }),
        f.name === 'roles' && !rolesReadable
          ? 'The clusters would not list their roles, so type them. A name that does not exist grants nothing.'
          : f.hint));
    }
  };

  const kindSel = select('cu-kind', task.id, TASKS.map((t) => [t.id, t.title]));
  kindSel.onchange = () => { task = taskById(kindSel.value) || TASKS[0]; drawFields(); };
  drawFields();

  const clusterBox = h('div', { style: { display: 'grid', gap: '3px', maxHeight: '160px', overflowY: 'auto' } },
    ...all.map((c) => h('label', { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: chosen.has(c.id),
        onchange: (e) => { if (e.target.checked) chosen.add(c.id); else chosen.delete(c.id); rerenderRoles(); } }),
      h('span', c.name),
      h('span.mono.muted', { style: { fontSize: '10.5px' } }, c.url))));

  const res = await modal('Create on a cluster', 'pick what to create — the fields follow from it', [
    field('Create', kindSel),
    fieldBox,
    field('Apply to', clusterBox),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const values = {};
      for (const f of task.fields) values[f.name] = val(`cu-${f.name}`);
      // Ticked roles, when the list could be read.
      if (task.fields.some((f) => f.name === 'roles') && !document.getElementById('cu-roles')) {
        values.roles = [...pickedRoles].join(', ');
      }
      const missing = missingFields(task, values);
      if (missing.length) throw new Error(`Fill in ${missing.join(', ')}.`);
      const picked = all.filter((c) => chosen.has(c.id));
      if (!picked.length) throw new Error('Pick at least one cluster.');
      if (!(await ensureWrites())) return null;

      const shown = preview(task, values);
      const ok = await confirmDialog(`${task.title} on ${picked.length} cluster(s)?`,
        `${shown.method} ${shown.path}\n\n${picked.map((c) => `  ${c.name}`).join('\n')}\n\n`
        + 'Each cluster is done in turn; one refusing does not stop the rest.',
        { yes: `run on ${picked.length}`, danger: true });
      if (!ok) return null;

      const out = await runTask(task, values, picked.map((c) => c.id));
      // The password existed for the length of this call and no longer.
      for (const k of Object.keys(values)) values[k] = '';
      return { task, out };
    }) }, 'Create'),
    h('button.btn', { onclick: () => ctx.close(null) }, 'Cancel'),
  ], { width: '620px' });

  if (!res) return;
  const okN = res.out.filter((r) => r.ok).length;
  toast(`${res.task.title}: ${okN} applied, ${res.out.length - okN} failed`,
    okN === res.out.length ? 'ok' : 'err', 5000);
  await report(res.task, res.out);
  if (onDone) onDone();
}

/** What each cluster said. An API key is shown here because it is shown nowhere else. */
async function report(task, res) {
  const rows = res.map((r) => {
    const c = clusters().find((x) => x.id === r.clusterId);
    return h('div', { style: { display: 'flex', gap: '8px', fontSize: '12px', alignItems: 'baseline' } },
      h('span', { style: { width: '14px' } }, r.ok ? '✓' : '✗'),
      h('b', { style: { minWidth: '120px' } }, c ? c.name : r.clusterId),
      h('span.muted', r.message));
  });
  const keys = res.filter((r) => r.ok && r.kept && r.kept.encoded);
  await modal(`${task.title} — result`, `${res.filter((r) => r.ok).length} of ${res.length} applied`, [
    h('div', { style: { display: 'grid', gap: '4px' } }, ...rows),
    keys.length
      ? h('div', { style: { marginTop: '10px' } },
          h('div.banner.warn', { style: { margin: 0 } },
            h('div', h('div.ttl', 'Copy these keys now'),
              h('div', { style: { fontSize: '12px' } },
                'Elasticsearch will not show them again. Nothing here stores them.'))),
          ...keys.map((r) => {
            const c = clusters().find((x) => x.id === r.clusterId);
            return h('div', { style: { marginTop: '6px' } },
              h('div.muted', { style: { fontSize: '11px' } }, c ? c.name : r.clusterId),
              h('pre.mono', { style: { fontSize: '11px', margin: 0, padding: '8px', background: 'var(--surface-2)',
                                       borderRadius: '4px', overflowX: 'auto', userSelect: 'all' } }, r.kept.encoded));
          }))
      : null,
  ], (ctx) => [h('button.btn.primary', { onclick: () => ctx.close(true) }, 'Done')], { width: '640px' });
}

/** Remove one account from one cluster. */
export async function removeClusterUser(clusterId, name, { onDone } = {}) {
  const c = clusters().find((x) => x.id === clusterId);
  const ok = await confirmDialog(`Remove "${name}" from ${c ? c.name : clusterId}?`,
    'This deletes the account on that cluster only. Anything signing in with it stops working.',
    { yes: 'remove it', danger: true });
  if (!ok) return;
  if (!(await ensureWrites())) return;
  try {
    const r = await client(clusterId).deleteSecurityUser(name);
    if (!r.ok) throw new Error(r.message || r.kind || `HTTP ${r.status}`);
    toast(`Removed ${name} from ${c ? c.name : clusterId}`);
    if (onDone) onDone();
  } catch (e) {
    toast(`Could not remove ${name}: ${e.message}`, 'err', 5000);
  }
}

/**
 * Edit one account on one cluster: roles, full name, email.
 *
 * Roles are the field that matters — they decide which indices the account can read —
 * so they are offered as the cluster's actual role list rather than a free-text box
 * where a typo creates a role reference that does not exist and silently grants nothing.
 * If the role list cannot be read (a cluster that allows reading users but not roles),
 * the form falls back to text so the edit is still possible, and says so.
 *
 * A built-in account is refused here rather than at the cluster: Elasticsearch answers a
 * reserved-user edit with a 400 whose message is about the metadata field, which explains
 * nothing to the person who clicked Edit.
 */
export async function editDialog(clusterId, user, { onDone } = {}) {
  const c = clusters().find((x) => x.id === clusterId);
  const where = c ? c.name : clusterId;
  if (user.reserved) {
    toast(`${user.name} is a built-in account and cannot be edited`, 'warn', 4000);
    return;
  }

  let roleNames = null;
  try {
    const res = await client(clusterId).securityRoles();
    roleNames = Object.keys(res || {}).sort();
  } catch {
    roleNames = null;   // fall back to free text below
  }

  const current = new Set(user.roles || []);
  const roleBox = roleNames && roleNames.length
    ? h('div', { style: { display: 'grid', gap: '3px', maxHeight: '190px', overflowY: 'auto' } },
        ...roleNames.map((r) => h('label',
          { style: { display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' } },
          h('input', { type: 'checkbox', checked: current.has(r),
            onchange: (e) => { if (e.target.checked) current.add(r); else current.delete(r); } }),
          h('span.mono', { style: { fontSize: '11.5px' } }, r))))
    : text('cu-roles', (user.roles || []).join(', '), { placeholder: 'role names, comma separated' });

  const fullName = text('cu-full', user.fullName || '', { placeholder: 'optional' });
  const email = text('cu-email', user.email || '', { placeholder: 'optional' });

  await modal(`Edit ${user.name}`, `on ${where}`, [
    field('Roles', roleBox,
      roleNames && roleNames.length
        ? 'What this account may do on this cluster.'
        : 'The cluster would not list its roles, so these are typed. A name that does not exist grants nothing.'),
    field('Full name', fullName),
    field('Email', email),
  ], (ctx) => [
    h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
      const roles = roleNames && roleNames.length
        ? [...current]
        : String(val(roleBox) || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!roles.length) throw new Error('An account with no roles can sign in and do nothing — give it at least one.');
      if (!(await ensureWrites())) return;
      // full_name/email are sent even when blank: PUT replaces the document, so omitting
      // a field the operator cleared would silently put the old value back.
      const r = await client(clusterId).updateSecurityUser(user.name, {
        roles,
        full_name: String(val(fullName) || ''),
        email: String(val(email) || ''),
      });
      if (!r.ok) throw new Error(r.message || r.kind || `HTTP ${r.status}`);
      toast(`Updated ${user.name} on ${where}`);
      ctx.close(true);
      if (onDone) onDone();
    }) }, 'Save'),
  ], { width: '520px' });
}
