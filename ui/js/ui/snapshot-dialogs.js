/**
 * Snapshot, restore and repository dialogs.
 *
 * Every action here changes the cluster, so each one goes through `ensureWrites()` first:
 * the operator must have unlocked writes for the session, and each request carries
 * `allowWrites`. The core refuses it otherwise — see core/writes.js and the Rust guard.
 */

import { h, mount, $ } from '../lib/dom.js';
import { bytes, num, dt, dur, ago, download, healthClass } from '../lib/fmt.js';
import { modal, confirmDialog, nameList, field, text, select, checkbox, val, checked } from './modal.js';
import { toast } from './menu.js';
import { trackTask, snapshotPoll, restorePoll, restoredNames } from './tasks.js';
import { ensureWrites } from '../core/writes.js';
import { client, state as appState, parseIndexName, coveredDays } from '../core/state.js';
import { currentUser, loadCurrentUser } from '../core/acks.js';
import { evidenceRows, evidenceHeader, evidenceCsv, evidenceText, coverLine, NO_DATE } from '../core/snapshot-evidence.js';

/** `manual-2026.09.09-141530` — sortable, and obviously not an SLM snapshot. */
export function suggestedSnapshotName(prefix = 'manual') {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${prefix}-${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ------------------------------ index picker ------------------------------- */

/**
 * "All indices" or an explicit list. Returns a node plus `value()`, which gives the
 * string Elasticsearch wants (`*`, or a comma-separated list).
 */
function indexPicker(names, { allLabel = 'All indices (*)' } = {}) {
  const state = { mode: 'all', chosen: new Set(), filter: '' };
  const listBox = h('div', {
    style: { maxHeight: '210px', overflow: 'auto', border: '1px solid var(--border)',
             borderRadius: '6px', padding: '6px', display: 'none' },
  });
  const count = h('span.muted', { style: { fontSize: '11px' } }, '');

  function visible() {
    const f = state.filter.trim().toLowerCase();
    return f ? names.filter((n) => n.toLowerCase().includes(f)) : names;
  }
  function drawList() {
    const rows = visible().slice(0, 500).map((n) =>
      h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', padding: '1px 0', cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: state.chosen.has(n), style: { cursor: 'pointer' },
          onchange: (e) => { if (e.target.checked) state.chosen.add(n); else state.chosen.delete(n); drawCount(); } }),
        h('span.mono', { style: { wordBreak: 'break-all' } }, n)));
    mount(listBox, rows.length ? h('div', ...rows) : h('div.muted', { style: { fontSize: '12px', padding: '6px' } }, 'No index matches'),
      visible().length > 500
        ? h('div.muted', { style: { fontSize: '11px', padding: '4px' } }, `…and ${visible().length - 500} more — narrow the filter`)
        : null);
    drawCount();
  }
  function drawCount() {
    mount(count, state.mode === 'all'
      ? `every index in the cluster (${num(names.length)})`
      : `${num(state.chosen.size)} of ${num(names.length)} selected`);
  }

  const filterRow = h('div', { style: { display: 'none', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
    h('input', { type: 'search', placeholder: 'filter indices…', style: { flex: '1' },
      oninput: (e) => { state.filter = e.target.value; drawList(); } }),
    h('button.btn.sm', { type: 'button', onclick: () => { visible().forEach((n) => state.chosen.add(n)); drawList(); } }, 'Select shown'),
    h('button.btn.sm.ghost', { type: 'button', onclick: () => { state.chosen.clear(); drawList(); } }, 'Clear'));

  const modeSel = select('sd-index-mode', 'all', [['all', allLabel], ['pick', 'Choose indices…']]);
  modeSel.onchange = (e) => {
    state.mode = e.target.value;
    const showing = state.mode === 'pick';
    listBox.style.display = showing ? 'block' : 'none';
    filterRow.style.display = showing ? 'flex' : 'none';
    if (showing) drawList(); else drawCount();
  };

  drawList();
  drawCount();

  return {
    node: h('div', { style: { display: 'grid', gap: '6px' } },
      field('Indices', modeSel), filterRow, listBox, count),
    value() { return state.mode === 'all' ? '*' : [...state.chosen].join(','); },
    isEmpty() { return state.mode === 'pick' && state.chosen.size === 0; },
  };
}

/* ----------------------------- create snapshot ----------------------------- */

export async function createSnapshotDialog(cluster, repos, preselectedRepo) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let names = [];
  try {
    names = (await cl.indexNames('*')).map((r) => r.index).filter(Boolean).sort();
  } catch (_) { /* the picker still offers "all indices" */ }

  const picker = indexPicker(names);
  const body = [
    field('Repository', select('sd-repo', preselectedRepo || (repos[0] && repos[0].name) || '',
      repos.map((r) => [r.name, `${r.name} (${r.type})`]))),
    field('Snapshot name', text('sd-name', suggestedSnapshotName(), { mono: true }),
      'Lower case, no spaces. Must not already exist in the repository.'),
    picker.node,
    h('div', { style: { display: 'grid', gap: '7px', marginTop: '2px' } },
      checkbox('sd-ignore', 'Ignore unavailable indices', true,
        'Skip indices that are missing or closed instead of failing the whole snapshot.'),
      checkbox('sd-global', 'Include global state', false,
        'Cluster settings, templates and ILM/SLM policies. Off keeps the snapshot to data only.'),
      checkbox('sd-partial', 'Allow partial snapshot', false,
        'Continue even when some shards are unavailable. The result is marked PARTIAL.')),
  ];

  return modal(`Create a snapshot on ${cluster.name}`, 'Runs in the background — the list refreshes when it is accepted.', body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const repo = val('sd-repo');
        const name = val('sd-name').trim();
        if (!repo) throw new Error('Pick a repository.');
        if (!name) throw new Error('Give the snapshot a name.');
        if (name !== name.toLowerCase()) throw new Error('Elasticsearch requires a lower-case snapshot name.');
        if (picker.isEmpty()) throw new Error('Choose at least one index, or switch back to "All indices".');
        await cl.createSnapshot(repo, name, {
          indices: picker.value(),
          ignore_unavailable: checked('sd-ignore'),
          include_global_state: checked('sd-global'),
          partial: checked('sd-partial'),
        });
        // Accepted, not complete. createSnapshot returns once the cluster has taken the
        // request; the copy runs in the background and can still fail or come back
        // PARTIAL. Saying "created" here would be a claim about an outcome nobody has.
        trackTask({ title: 'Snapshot started', cluster,
          detail: [`${repo} / ${name}`, picker.value() === '*' ? 'all indices' : String(picker.value())],
          poll: snapshotPoll(cluster, repo, name), everyMs: 5000, timeoutMs: 6 * 3600e3 });
        ctx.done({ repo, name });
      }) }, 'Create snapshot'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '620px' });
}

/* ---------------------------- snapshot details ----------------------------- */

export async function snapshotDetailsDialog(cluster, repo, snapshotId, { onChanged } = {}) {
  // The same drawer as the index list, with the version, global state and the actions.
  const choice = await snapshotIndicesDialog(cluster, repo, { id: snapshotId }, { details: true });
  if (choice === 'restore') return restoreSnapshotDialog(cluster, repo, snapshotId, { onChanged });
  if (choice === 'delete') return deleteSnapshot(cluster, repo, snapshotId, { onChanged });
  return false;
}

/* ---------------------------- restore snapshot ----------------------------- */

export async function restoreSnapshotDialog(cluster, repo, snapshotId, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let names = [];
  try {
    const j = await cl.snapshotDetail(repo, snapshotId);
    names = (((j.snapshots || [])[0] || {}).indices || []).slice().sort();
  } catch (_) { /* fall back to "all indices in the snapshot" */ }

  const picker = indexPicker(names, { allLabel: 'Every index in the snapshot (*)' });
  const body = [
    h('div.banner.warn', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'Restoring writes to the cluster'),
        h('div', 'An index that already exists must be closed first, or renamed below. Restoring under a new name is the safe default.'))),
    picker.node,
    field('Rename pattern', text('sd-rpat', '(.+)', { mono: true }), 'Regular expression matched against each index name.'),
    field('Rename replacement', text('sd-rrep', 'restored-$1', { mono: true }),
      'Leave both empty to restore under the original names (the index must not already exist and be open).'),
    h('div', { style: { display: 'grid', gap: '7px' } },
      checkbox('sd-rignore', 'Ignore unavailable indices', true),
      checkbox('sd-raliases', 'Include aliases', true),
      checkbox('sd-rglobal', 'Include global state', false,
        'Overwrites cluster settings, templates and policies with the snapshot’s. Rarely what you want.')),
  ];

  const res = await modal(`Restore ${snapshotId}`, `from ${repo} · ${cluster.name}`, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        if (picker.isEmpty()) throw new Error('Choose at least one index, or switch back to every index.');
        const pat = val('sd-rpat').trim();
        const rep = val('sd-rrep').trim();
        if (!!pat !== !!rep) throw new Error('Give both a rename pattern and a replacement, or neither.');
        const b = {
          indices: picker.value(),
          ignore_unavailable: checked('sd-rignore'),
          include_aliases: checked('sd-raliases'),
          include_global_state: checked('sd-rglobal'),
        };
        if (pat) { b.rename_pattern = pat; b.rename_replacement = rep; }
        await cl.restoreSnapshot(repo, snapshotId, b);
        const chosen = picker.value() === '*' || !picker.value() ? names : String(picker.value()).split(',').filter(Boolean);
        const target = restoredNames(chosen, pat, rep);
        trackTask({ title: 'Restore started', cluster,
          detail: [`from ${repo} / ${snapshotId}`,
            `${target.length} ${target.length === 1 ? 'index' : 'indices'}: ${target.slice(0, 3).join(', ')}${target.length > 3 ? ` +${target.length - 3} more` : ''}`],
          poll: target.length ? restorePoll(cluster, target) : null, timeoutMs: 6 * 3600e3 });
        ctx.done(true);
      }) }, 'Restore'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '620px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* --------------------- restore indices found by a search --------------------- */

/**
 * The newest copy of one index that can actually be restored from: a SUCCESS snapshot.
 * A PARTIAL or FAILED one may not hold this index whole, so it is never offered.
 */
export function restoreSourceOf(found) {
  return (found.snapshots || []).find((x) => x.state === 'SUCCESS') || null;
}

/**
 * Group what was ticked by the snapshot each index comes from: one restore request per
 * snapshot, because a restore reads from exactly one.
 */
export function restorePlan(items) {
  const groups = new Map();
  for (const it of items) {
    const src = restoreSourceOf(it);
    if (!src) continue;
    const k = `${src.repo}\u0000${src.snapshot}`;
    if (!groups.has(k)) groups.set(k, { repo: src.repo, snapshot: src.snapshot, indices: [] });
    groups.get(k).indices.push(it.index);
  }
  return [...groups.values()];
}

/**
 * Restore several indices at once, each from its own newest good snapshot.
 *
 * An index that still exists and is open cannot be restored over, so when any ticked
 * index is live the rename defaults to restored-<name>: nothing on the cluster is touched.
 * Indices that are only in snapshots come back under their own names.
 */
export async function restoreIndicesDialog(cluster, items, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const plan = restorePlan(items);
  if (!plan.length) { toast('None of these has a successful snapshot to restore from', 'err'); return false; }
  const cl = client(cluster.id);
  const anyLive = items.some((it) => it.alsoLive && restoreSourceOf(it));
  const total = plan.reduce((n, g) => n + g.indices.length, 0);

  const rows = items.filter((it) => restoreSourceOf(it)).map((it) => {
    const src = restoreSourceOf(it);
    return h('tr',
      h('td.mono', { style: { whiteSpace: 'nowrap' } }, it.index),
      h('td.mono.muted', { style: { fontSize: '11.5px' } }, `${src.repo} / ${src.snapshot}`),
      h('td', it.alsoLive
        ? h('span.pill.yellow', h('i.dot'), 'exists live')
        : h('span.pill.grey', h('i.dot'), 'snapshot only')));
  });

  const body = [
    h('div.banner.warn', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'Restoring writes to the cluster'),
        h('div', anyLive
          ? 'Some of these still exist on the cluster, so they are restored under a new name by default — the live index is left as it is.'
          : 'None of these exists on the cluster now; they come back under their original names.'))),
    h('div', { style: { fontSize: '12px' } }, h('b', `${total} ${total === 1 ? 'index' : 'indices'}`),
      h('span.muted', ` from ${plan.length} snapshot${plan.length === 1 ? '' : 's'} (the newest successful copy of each)`)),
    h('div.tbl-wrap', { style: { maxHeight: 'min(45vh, 420px)', overflow: 'auto' } },
      h('table.tbl', h('thead', h('tr', h('th', 'Index'), h('th', 'From snapshot'), h('th', 'Now'))), h('tbody', ...rows))),
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' } },
      field('Rename pattern', text('ri-rpat', anyLive ? '(.+)' : '', { mono: true }), 'Regular expression matched against each index name.'),
      field('Rename replacement', text('ri-rrep', anyLive ? 'restored-$1' : '', { mono: true }), 'Leave both empty to restore under the original names.')),
    h('div', { style: { display: 'grid', gap: '7px' } },
      checkbox('ri-ignore', 'Ignore unavailable indices', true),
      checkbox('ri-aliases', 'Include aliases', false, 'Off by default: a restored copy taking over a live alias would move traffic to it.')),
  ];

  const res = await modal(`Restore ${total} ${total === 1 ? 'index' : 'indices'}`, `${cluster.name}`, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const pat = val('ri-rpat').trim();
        const rep = val('ri-rrep').trim();
        if (!!pat !== !!rep) throw new Error('Give both a rename pattern and a replacement, or neither.');
        const failed = [];
        const startedNames = [];
        let started = 0;
        for (const g of plan) {
          const b = {
            indices: g.indices.join(','),
            ignore_unavailable: checked('ri-ignore'),
            include_aliases: checked('ri-aliases'),
            include_global_state: false,
          };
          if (pat) { b.rename_pattern = pat; b.rename_replacement = rep; }
          try { await cl.restoreSnapshot(g.repo, g.snapshot, b); started += g.indices.length; startedNames.push(...g.indices); }
          catch (err) { failed.push(`${g.snapshot}: ${err.message}`); }
        }
        if (failed.length && !started) {
          toast('Restore failed to start', 'err', 12000, { meta: cluster.name, detail: failed.slice(0, 3) });
          throw new Error(failed.join('; '));
        }
        if (failed.length) {
          toast(`Restore: ${failed.length} snapshot(s) failed to start`, 'err', 12000, { meta: cluster.name, detail: failed.slice(0, 3) });
        }
        const target = restoredNames(startedNames, pat, rep);
        trackTask({ title: 'Restore started', cluster,
          detail: [`${target.length} ${target.length === 1 ? 'index' : 'indices'} from ${plan.length} snapshot${plan.length === 1 ? '' : 's'}`,
            `${target.slice(0, 3).join(', ')}${target.length > 3 ? ` +${target.length - 3} more` : ''}`],
          poll: restorePoll(cluster, target), timeoutMs: 6 * 3600e3 });
        ctx.done(true);
      }) }, `Restore ${total}`),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '980px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ----------------------------- delete snapshot ----------------------------- */

export async function deleteSnapshot(cluster, repo, snapshotId, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const ok = await confirmDialog(`Delete snapshot ${snapshotId}?`,
    `From repository "${repo}" on ${cluster.name}.\n\n` +
    'The snapshot, and the data only it holds, are removed from the repository. Indices in ' +
    'the cluster are not touched. This cannot be undone.',
    { yes: 'delete', danger: true });
  if (!ok) return false;
  try {
    await client(cluster.id).deleteSnapshot(repo, snapshotId);
    toast('Snapshot deleted', 'ok', 7000, { meta: cluster.name, detail: [`${repo} / ${snapshotId}`] });
    if (onChanged) await onChanged();
    return true;
  } catch (e) {
    toast('Snapshot delete failed', 'err', 12000, { meta: cluster.name, detail: [`${repo} / ${snapshotId}`, e.message] });
    return false;
  }
}

/* --------------------------- delete a live index --------------------------- */

/**
 * Delete indices from the CLUSTER — the usual "it is safely in a snapshot, reclaim the
 * disk" step. The snapshot copy is untouched; this only removes the live index.
 */
export async function deleteIndicesDialog(cluster, repo, snapshotId, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let inSnapshot = [];
  try {
    const j = await cl.snapshotDetail(repo, snapshotId);
    inSnapshot = (((j.snapshots || [])[0] || {}).indices || []).slice().sort();
  } catch (e) {
    toast("Could not read the snapshot's index list", 'err', 10000, { meta: cluster.name, detail: [e.message] });
    return false;
  }

  // Only offer indices that still exist in the cluster, with their size.
  let live = new Map();
  try {
    for (const r of await cl.indexNames('*')) live.set(r.index, r);
  } catch (_) { /* sizes are a nicety, not a requirement */ }

  const present = inSnapshot.filter((n) => live.size === 0 || live.has(n));
  const gone = inSnapshot.length - present.length;
  const chosen = new Set();
  const totalEl = h('div.muted', { style: { fontSize: '11.5px' } }, '');

  function refreshTotal() {
    let b = 0;
    chosen.forEach((n) => { const r = live.get(n); if (r) b += Number(r['store.size']) || 0; });
    mount(totalEl, chosen.size
      ? `${num(chosen.size)} index/indices selected${b ? ` · ${bytes(b)} reclaimed` : ''}`
      : 'nothing selected');
  }

  const rows = present.map((n) => {
    const r = live.get(n) || {};
    return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', padding: '2px 0', cursor: 'pointer' } },
      h('input', { type: 'checkbox', style: { cursor: 'pointer' },
        onchange: (e) => { if (e.target.checked) chosen.add(n); else chosen.delete(n); refreshTotal(); } }),
      h('span.mono', { style: { flex: '1', wordBreak: 'break-all' } }, n),
      r['store.size'] ? h('span.muted', { style: { fontSize: '11px' } }, bytes(Number(r['store.size']))) : null);
  });
  refreshTotal();

  const body = [
    h('div.banner.warn', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'This deletes indices from the cluster, not from the snapshot'),
        h('div', `Everything listed is held in "${snapshotId}", so it can be restored from ${repo} later. ` +
                 'Deleting frees the disk the live index uses. This cannot be undone.'))),
    gone ? h('div.muted', { style: { fontSize: '11.5px' } },
      `${num(gone)} index/indices in the snapshot no longer exist in the cluster and are not listed.`) : null,
    h('div', { style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
      h('button.btn.sm', { type: 'button', onclick: (e) => {
        e.target.closest('.modal-body').querySelectorAll('input[type=checkbox]').forEach((cb) => {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
        });
      } }, 'Select all'),
      h('button.btn.sm.ghost', { type: 'button', onclick: (e) => {
        e.target.closest('.modal-body').querySelectorAll('input[type=checkbox]').forEach((cb) => {
          if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
        });
      } }, 'Clear')),
    h('div', { style: { maxHeight: '230px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px', padding: '7px' } },
      rows.length ? rows : h('div.muted', { style: { fontSize: '12px' } }, 'No index from this snapshot is still in the cluster.')),
    totalEl,
  ];

  const res = await modal(`Delete indices held in ${snapshotId}`, `${cluster.name} · snapshot stays in ${repo}`, body,
    (ctx) => [
      h('button.btn.danger', { onclick: (e) => ctx.run(e.target, async () => {
        if (!chosen.size) throw new Error('Select at least one index.');
        const list = [...chosen];
        const go = await confirmDialog(`Delete ${list.length} index/indices from ${cluster.name}?`,
          h('div', h('div', `They remain in snapshot "${snapshotId}" and can be restored from ${repo}. ` +
                            'Removing them from the cluster cannot be undone.'), nameList(list)),
          { yes: `delete ${list.length === 1 ? 'it' : `all ${list.length}`}`, danger: true });
        if (!go) return;
        const failed = [];
        for (const n of list) {
          try { await cl.deleteIndex(n); } catch (err) { failed.push(`${n}: ${err.message}`); }
        }
        if (failed.length) {
          const ok = list.length - failed.length;
          toast(ok ? `Deleted ${ok}, ${failed.length} failed` : `Delete failed: ${failed.length} ${failed.length === 1 ? 'index' : 'indices'}`,
            'err', 12000, { meta: cluster.name, detail: failed.slice(0, 3) });
          throw new Error(`${failed.length} failed — ${failed[0]}`);
        }
        toast(`Deleted: ${list.length} ${list.length === 1 ? 'index' : 'indices'}`, 'ok', 8000, { meta: cluster.name,
          detail: [`${list.slice(0, 4).join(', ')}${list.length > 4 ? ` +${list.length - 4} more` : ''}`,
                   `still restorable from ${repo} / ${snapshotId}`] });
        ctx.done(list.length);
      }) }, 'Delete selected indices'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '980px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ------------------------------- repositories ------------------------------ */

const REPO_TYPES = [
  ['fs', 'Shared file system (fs)'],
  ['s3', 'AWS S3 (s3)'],
  ['azure', 'Azure (azure)'],
  ['gcs', 'Google Cloud Storage (gcs)'],
  ['url', 'Read-only URL (url)'],
];

export async function createRepositoryDialog(cluster, pathRepo = []) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);
  const settingsHost = h('div', { style: { display: 'grid', gap: '10px' } });

  function drawSettings(type) {
    if (type === 'fs') {
      mount(settingsHost,
        field('Location', text('sd-loc', pathRepo[0] || '', { mono: true, placeholder: '/mnt/es-backups' }),
          pathRepo.length
            ? `Must sit inside path.repo on every node: ${pathRepo.join(', ')}`
            : 'Must sit inside a path.repo directory registered in elasticsearch.yml on every node.'),
        checkbox('sd-compress', 'Compress metadata', true));
    } else if (type === 'url') {
      mount(settingsHost, field('URL', text('sd-loc', '', { mono: true, placeholder: 'file:/mnt/es-backups' }),
        'Read-only. The URL must be listed in repositories.url.allowed_urls.'));
    } else if (type === 's3') {
      mount(settingsHost,
        field('Bucket', text('sd-loc', '', { mono: true, placeholder: 'my-es-backups' })),
        field('Base path', text('sd-base', '', { mono: true, placeholder: 'prod/cluster-a' }), 'Optional prefix inside the bucket.'),
        field('Client', text('sd-client', 'default', { mono: true }), 'The s3.client.<name> credentials in the keystore.'),
        checkbox('sd-compress', 'Compress metadata', true));
    } else if (type === 'azure') {
      mount(settingsHost,
        field('Container', text('sd-loc', '', { mono: true })),
        field('Base path', text('sd-base', '', { mono: true })),
        field('Client', text('sd-client', 'default', { mono: true })),
        checkbox('sd-compress', 'Compress metadata', true));
    } else {
      mount(settingsHost,
        field('Bucket', text('sd-loc', '', { mono: true })),
        field('Base path', text('sd-base', '', { mono: true })),
        field('Client', text('sd-client', 'default', { mono: true })),
        checkbox('sd-compress', 'Compress metadata', true));
    }
  }

  const typeSel = select('sd-type', 'fs', REPO_TYPES);
  typeSel.onchange = (e) => drawSettings(e.target.value);
  drawSettings('fs');

  const body = [
    field('Name', text('sd-rname', '', { mono: true, placeholder: 'daily-backups' })),
    field('Type', typeSel),
    settingsHost,
    h('div.muted', { style: { fontSize: '11.5px' } },
      'The plugin for the chosen type must already be installed, and the repository is verified on every node when it is registered.'),
  ];

  return modal(`Add a snapshot repository to ${cluster.name}`, null, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const name = val('sd-rname').trim();
        const type = val('sd-type');
        const loc = val('sd-loc').trim();
        if (!name) throw new Error('Give the repository a name.');
        if (!loc) throw new Error(type === 'fs' ? 'Give the location on disk.' : 'Give the bucket, container or URL.');
        const settings = {};
        if (type === 'fs') settings.location = loc;
        else if (type === 'url') settings.url = loc;
        else if (type === 'azure') settings.container = loc;
        else settings.bucket = loc;
        const base = val('sd-base');
        const cli = val('sd-client');
        if (base && base.trim()) settings.base_path = base.trim();
        if (cli && cli.trim() && type !== 'fs' && type !== 'url') settings.client = cli.trim();
        if ($('#sd-compress')) settings.compress = checked('sd-compress');
        await cl.createRepository(name, { type, settings });
        ctx.done({ name });
      }) }, 'Add repository'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '620px' });
}

export async function deleteRepository(cluster, name, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const ok = await confirmDialog(`Remove repository ${name}?`,
    `From ${cluster.name}.\n\n` +
    'Elasticsearch stops using it, and every snapshot in it disappears from this app. The files ' +
    'on disk or in the bucket are left alone, so the repository can be registered again later — ' +
    'but any SLM policy writing to it will start failing.',
    { yes: 'remove', danger: true, typeToConfirm: name });
  if (!ok) return false;
  try {
    await client(cluster.id).deleteRepository(name);
    if (onChanged) await onChanged();
    return true;
  } catch (e) {
    toast('Repository delete failed', 'err', 12000, { meta: cluster.name, detail: [name, e.message] });
    return false;
  }
}

export async function verifyRepository(cluster, name) {
  if (!(await ensureWrites())) return;
  try {
    const r = await client(cluster.id).verifyRepository(name);
    const nodes = Object.keys(r.nodes || {}).length;
    toast('Repository verified', 'ok', 7000, { meta: cluster.name, detail: [`${name} — reachable from ${nodes || 0} node(s)`] });
  } catch (e) {
    toast('Repository verification failed', 'err', 12000, { meta: cluster.name, detail: [name, e.message] });
  }
}

export async function cleanupRepository(cluster, name, { onChanged } = {}) {
  if (!(await ensureWrites())) return;
  const ok = await confirmDialog(`Clean up repository ${name}?`,
    'Removes data in the repository that no snapshot references any more. Existing snapshots are ' +
    'not affected. On a large repository this can run for a long time.',
    { yes: 'clean up' });
  if (!ok) return;
  try {
    const r = await client(cluster.id).cleanupRepository(name);
    const res = r.results || {};
    toast('Repository cleanup completed', 'ok', 9000, { meta: cluster.name, detail: [name, `${num(res.deleted_blobs || 0)} blob(s), ${bytes(res.deleted_bytes || 0)} freed`] });
    if (onChanged) await onChanged();
  } catch (e) {
    toast('Repository cleanup failed', 'err', 12000, { meta: cluster.name, detail: [name, e.message] });
  }
}

/* ---------------------- what is inside one snapshot ------------------------- */

/**
 * The indices a snapshot holds, as evidence for an audit.
 *
 * A snapshot's name tells you when it ran; this tells you what is in it — which is the
 * question actually asked when someone wants to know whether a given day can be restored,
 * and the one an auditor asks to see written down. So it opens wide, leads with which
 * cluster and which snapshot, dates every index by the data inside it (read from its name
 * by parseIndexName, the one reader of index names), and exports or copies the same
 * header and rows it shows (core/snapshot-evidence.js builds all three).
 *
 * It opens at once on the listing row already in memory, then reads the snapshot detail
 * for the per-index shard outcome — which the listing does not carry. Until that answers,
 * or if it cannot, per-index status reads "unknown", never "ok".
 */
/**
 * The snapshot drawer: cluster, snapshot facts and every index with the day its data
 * covers. Opened from the index count as audit evidence, and from Details — which adds
 * the version, global state and the Restore / Delete actions (opts.details). Resolves with
 * 'restore' | 'delete' | null.
 */
export async function snapshotIndicesDialog(cluster, repo, snap, opts = {}) {
  const cl = client(cluster.id);
  const reSrc = (cl && cl.c && cl.c.indexNameRegex) || cluster.indexNameRegex;
  const dayOf = (n) => parseIndexName(n, reSrc).day;
  const generatedAt = Date.now();
  // The signed-in account where there is one; otherwise the name this machine records
  // acknowledgements under (Alerts page), read from storage if that page has not been open.
  let user = (appState.caller && appState.caller.name) || currentUser() || '';

  // What is known so far: the listing row. `failures` stays null until the detail says.
  const ev = {
    names: snap.indexNames || null,
    failures: null,
    detailError: '',
    loading: true,
    state: snap.status,
    start: snap.start, end: snap.end,
    duration: snap.duration,
    shards: { successful: snap.successful, failed: snap.failed, total: snap.total },
    version: '', globalState: null,
  };
  const filter = { text: '' };

  const headHost = h('div.ev-head');
  const tableHost = h('div.ev-table');
  const count = h('span.muted', { style: { fontSize: '11.5px' } }, '');
  const filterBox = h('input', { type: 'search', placeholder: 'filter these indices…', 'aria-label': 'Filter indices',
    style: { flex: '1', minWidth: '180px' },
    oninput: (e) => { filter.text = e.target.value; paintTable(); } });

  const facts = () => {
    const names = ev.names || [];
    const cover = ev.names ? coveredDays(names, reSrc) : null;
    const header = evidenceHeader({
      cluster: cluster.name, url: cluster.url, repository: repo, snapshot: snap.id,
      state: ev.state, taken: ev.start, ended: ev.end,
      takenText: ev.start ? dt(ev.start) : '', endedText: ev.end ? dt(ev.end) : '',
      durationText: typeof ev.duration === 'string' ? ev.duration : ev.duration != null ? dur(ev.duration) : '',
      shards: ev.shards,
      indexCount: ev.names ? names.length : (snap.indices ?? null),
      cover: coverLine(cover, { named: !!ev.names }),
      generatedAt, generatedText: dt(generatedAt), user,
    });
    return { header, cover, rows: evidenceRows(names, dayOf, ev.failures) };
  };

  const statusCell = (r) => (r.status === 'failed'
    ? h('span.pill.red', { title: r.detail }, h('i.dot'), `${r.failedShards} failed`)
    : r.status === 'ok' ? h('span.pill.green', h('i.dot'), 'ok')
    : h('span.muted', { title: ev.loading ? 'Reading the snapshot detail…' : `The snapshot detail could not be read${ev.detailError ? `: ${ev.detailError}` : ''}` },
        ev.loading ? 'Loading…' : 'unknown'));

  function paintHead() {
    const { header } = facts();
    const f = Object.fromEntries(header.map((x) => [x.key, x.value]));
    const st = String(ev.state || '').toUpperCase();
    mount(headHost,
      h('div.ev-band',
        h('div.ev-band-k', 'Cluster'),
        h('div.ev-cluster', cluster.name),
        f.url && f.url !== '–' ? h('div.ev-url.mono', { title: 'Cluster address' }, f.url) : null),
      h('div.ev-title', h('span.mono', repo), h('span.muted', ' / '), h('span.mono', { style: { fontWeight: 650 } }, snap.id),
        h(`span.pill.${healthClass(st)}`, { style: { marginLeft: '8px' } }, h('i.dot'), st || 'UNKNOWN')),
      h('dl.ev-kv.two',
        ...[['Taken → ended', `${f.taken} → ${f.ended}`], ['Duration', f.duration], ['Shards', f.shards],
            ['Indices', f.indices], ['Data inside', f.covers],
            ...(opts.details ? [['Version', ev.version || '–'],
              ['Global state', ev.globalState === null ? '–' : ev.globalState ? 'included' : 'not included']] : []),
            ['Evidence generated', f.generated]]
          .flatMap(([k, v]) => [h('dt', k), h('dd', v)])),
      ev.detailError
        ? h('div.muted', { style: { fontSize: '11.5px' } },
            `Per-index shard status is unknown — the snapshot detail could not be read: ${ev.detailError}`)
        : null);
  }

  function paintTable() {
    if (!ev.names) {
      mount(tableHost, h('div.muted', { style: { padding: '14px', fontSize: '12.5px' } },
        ev.loading ? 'Reading the index list…' : `The index list could not be read${ev.detailError ? `: ${ev.detailError}` : ''}.`));
      mount(count, '');
      return;
    }
    const { rows } = facts();
    const q = filter.text.trim().toLowerCase();
    const shown = q ? rows.filter((r) => r.index.toLowerCase().includes(q) || (r.day || '').includes(q)) : rows;
    mount(count, `${num(shown.length)} of ${num(rows.length)} indices`);
    mount(tableHost, h('table.tbl',
      h('thead', h('tr', h('th.num', { style: { width: '48px' } }, '#'), h('th', 'Index'),
        h('th', { style: { width: '150px' } }, 'Data date'), h('th', { style: { width: '130px' } }, 'Shards'))),
      h('tbody', ...(shown.length ? shown.map((r) => h('tr',
        h('td.num.muted', String(r.n)),
        h('td.mono', { style: { wordBreak: 'break-all' } }, r.index),
        h('td.nowrap', r.day ? h('span.mono', r.day) : h('span.muted', { title: 'The index name carries no date the naming pattern can read' }, NO_DATE)),
        h('td', statusCell(r))))
        : [h('tr', h('td', { colspan: 4 }, h('div.muted', { style: { padding: '8px', fontSize: '12px' } },
            rows.length ? 'No index matches that text.' : 'This snapshot holds no indices.')))]))));
  }

  const paint = () => { paintHead(); paintTable(); };
  paint();
  if (!user) {
    loadCurrentUser().then((who) => { if (who && !user) { user = who; if (headHost.isConnected) paintHead(); } }).catch(() => {});
  }

  const body = [
    headHost,
    h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } }, filterBox, count),
    tableHost,
  ];

  const p = modal(opts.details ? snap.id : `Indices in ${snap.id}`,
    `${opts.details ? 'Snapshot details' : 'Snapshot evidence'} · ${repo} · ${cluster.name}`, body, (ctx) => [
    h('button.btn.sm', {
      title: 'Save the header and every index (not only the filtered ones) as CSV',
      onclick: () => {
        const { header, rows } = facts();
        download(`snapshot-evidence-${cluster.name}-${repo}-${snap.id}.csv`.replace(/[^\w.-]+/g, '_'),
          evidenceCsv(header, rows), 'text/csv');
      },
    }, 'Export CSV'),
    h('button.btn.sm', {
      title: 'Copy the header and every index as plain text',
      onclick: async () => {
        const { header, rows } = facts();
        const txt = evidenceText(header, rows);
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('this window has no clipboard access');
          await navigator.clipboard.writeText(txt);
          toast('Evidence copied', 'ok', 2600, { meta: cluster.name, detail: [`${snap.id} · ${num(rows.length)} indices`] });
        } catch (e) {
          toast('Could not copy the evidence', 'err', 9000, { meta: cluster.name, detail: [e && e.message ? e.message : String(e), 'Use Export CSV instead.'] });
        }
      },
    }, 'Copy as text'),
    h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '8px' } },
      opts.details ? h('button.btn.primary', { onclick: () => ctx.done('restore') }, 'Restore…') : null,
      opts.details ? h('button.btn.danger', { onclick: () => ctx.done('delete') }, 'Delete snapshot…') : null,
      h('button.btn', { onclick: () => ctx.done(null) }, 'Close')),
  ], { width: 'min(860px, 100vw)', cls: 'evidence drawer' });

  // The detail: per-index shard outcome, exact times, and the names when the row came
  // from the _cat listing (which does not name the indices).
  (async () => {
    try {
      if (!cl || typeof cl.snapshotDetail !== 'function') throw new Error('no connection to this cluster');
      const j = await cl.snapshotDetail(repo, snap.id);
      const s = (j.snapshots || [])[0];
      if (!s) throw new Error('the cluster returned no such snapshot');
      ev.failures = s.failures || [];
      if (s.indices) ev.names = s.indices;
      if (s.state) ev.state = s.state;
      const t = (ms, str) => ms || (str ? Date.parse(str) : 0) || 0;
      ev.start = t(s.start_time_in_millis, s.start_time) || ev.start;
      ev.end = t(s.end_time_in_millis, s.end_time) || ev.end;
      if (s.duration_in_millis != null) ev.duration = s.duration_in_millis;
      if (s.shards) ev.shards = { successful: s.shards.successful, failed: s.shards.failed, total: s.shards.total };
      ev.version = s.version || '';
      ev.globalState = s.include_global_state === true;
    } catch (e) {
      ev.detailError = e && e.message ? e.message : String(e);
    }
    ev.loading = false;
    if (headHost.isConnected) paint();
  })();

  return p;
}
