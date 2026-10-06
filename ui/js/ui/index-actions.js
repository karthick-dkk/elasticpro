/**
 * Index management — open, close, delete, move a shard, change replicas, maintenance.
 *
 * Every one of these changes the cluster, so each goes through `ensureWrites()` and each
 * request carries `allowWrites`. Nothing here happens on a timer or a page load: an
 * operator has to click it, and destructive actions name what they will affect first.
 */

import { trackTask, shardMovePoll } from './tasks.js';
import { h, mount, $ } from '../lib/dom.js';
import { bytes, num } from '../lib/fmt.js';
import { modal, confirmDialog, nameList, field, text, select, checkbox, val, checked } from './modal.js';
import { toast } from './menu.js';
import { ensureWrites } from '../core/writes.js';
import { client, state } from '../core/state.js';
import { verifyIndicesInSnapshots, coverageLabel } from '../core/snapshot-verify.js';
import { pill } from '../pages/common.js';

/** Run one action per index, collecting failures rather than stopping at the first. */
async function forEachIndex(cl, names, fn) {
  const failed = [];
  for (const n of names) {
    try { await fn(n); } catch (e) { failed.push(`${n}: ${e.message}`); }
  }
  return failed;
}

function listFor(names, max = 12) {
  return names.slice(0, max).join('\n') + (names.length > max ? `\n…and ${names.length - max} more` : '');
}

/* ------------------------------- open / close ------------------------------- */

export async function openIndices(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;
  const ok = await confirmDialog(
    `Open ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', h('div', `On ${cluster.name}. Opening restores the shards to memory and makes them searchable again.`),
      nameList(names)),
    { yes: 'open' });
  if (!ok) return false;
  const failed = await forEachIndex(client(cluster.id), names, (n) => client(cluster.id).openIndex(n));
  report('open', names.length, failed, { cluster, names });
  if (onChanged) await onChanged();
  return true;
}

export async function closeIndices(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;
  const ok = await confirmDialog(
    `Close ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', h('div', `On ${cluster.name}. A closed index keeps its data on disk but cannot be searched ` +
                      'or written to. It can be reopened at any time.'),
      nameList(names)),
    { yes: 'close' });
  if (!ok) return false;
  const failed = await forEachIndex(client(cluster.id), names, (n) => client(cluster.id).closeIndex(n));
  report('close', names.length, failed, { cluster, names });
  if (onChanged) await onChanged();
  return true;
}

/* ---------------------------------- delete ---------------------------------- */

/**
 * Delete live indices, after checking each one is held in a SUCCESSFUL snapshot.
 *
 * Two confirmations and no third thing to operate. It used to put a checkbox on every
 * row and demand the count typed back, which sounds careful and is not: a list of forty
 * tickboxes is a list nobody reads, and typing "40" is a reflex, not a decision. What
 * makes this safe is that the second question is asked *only* when the answer matters —
 * when some of what is going has no snapshot behind it — and it names exactly those.
 *
 * So: the first dialog is the deletion itself, with the snapshot status of every index
 * shown but not editable. The second appears only if something would be lost for good,
 * and it lists what. Everything selected is deleted, or nothing is — no partial outcome
 * that depends on which boxes were left ticked.
 */
export async function deleteIndices(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;

  const total = names.reduce((s, n) => {
    const row = (state.indices.get(cluster.id) || []).find((r) => r.index === n);
    return s + ((row && row.size) || 0);
  }, 0);

  // Verify first. This is one listing per repository, so it is quick even for many indices.
  let coverage = null, verifyError = null;
  try { coverage = await verifyIndicesInSnapshots(cluster, names); }
  catch (e) { verifyError = e.message || String(e); }

  const covered = names.filter((n) => coverage && coverage.get(n) && coverage.get(n).covered);
  const uncovered = names.filter((n) => !covered.includes(n));
  const unverified = coverage ? [...new Set(names.flatMap((n) => coverage.get(n).unverified))] : [];

  const rowFor = (n) => {
    const v = coverage && coverage.get(n);
    const lbl = coverageLabel(v);
    const safe = v && v.covered;
    return h('tr',
      h('td.mono', { style: { fontSize: '12px', whiteSpace: 'nowrap' } }, n),
      h('td', pill(lbl.text, lbl.cls)),
      h('td.muted', { style: { fontSize: '11px' } },
        safe ? `${v.best.repo} · ${new Date(v.best.end || v.best.start).toISOString().slice(0, 16).replace('T', ' ')}`
             : v && v.all.length ? `${v.all.length} snapshot(s), none successful for this index` : ''));
  };

  const body = [
    h('div.banner.err', { style: { margin: '0 0 4px' } },
      h('div', h('div.ttl', 'This cannot be undone'),
        h('div', `The data is removed from ${cluster.name}. Each index was checked against every ` +
                 'snapshot repository; only a snapshot in state SUCCESS with no failure on that index counts.'))),
    verifyError
      ? h('div.banner.warn', { style: { margin: 0 } }, h('div', h('div.ttl', 'Could not verify snapshots'), h('div.mono', verifyError)))
      : null,
    unverified.length
      ? h('div.banner.warn', { style: { margin: 0 } },
          h('div', h('div.ttl', `${unverified.length} repository/repositories could not be read`),
            h('div.mono', { style: { fontSize: '11px' } }, unverified.join('; ')),
            h('div', 'An index may be held there without this check seeing it. Treat "NOT in any snapshot" as "unknown" for those.')))
      : null,
    h('div', { style: { display: 'flex', gap: '10px', fontSize: '12.5px', alignItems: 'baseline', flexWrap: 'wrap' } },
      h('b', `${num(names.length)} index/indices`), total ? h('span.muted', `${bytes(total)} on disk`) : null,
      h('span', { style: { color: 'var(--good)' } }, `${covered.length} in a snapshot`),
      uncovered.length ? h('span', { style: { color: 'var(--critical)', fontWeight: 640 } }, `${uncovered.length} with no snapshot`) : null),
    h('div.tbl-wrap', { style: { maxHeight: 'min(60vh, 520px)', overflow: 'auto' } },
      h('table.tbl', h('thead', h('tr', h('th', 'Index'), h('th', 'Snapshot copy'), h('th', 'Newest good copy'))),
        h('tbody', ...names.map(rowFor)))),
  ].filter(Boolean);

  const ok = await confirmDialog(
    `Delete ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', { style: { display: 'grid', gap: '8px' } }, ...body),
    { yes: `delete ${names.length === 1 ? 'it' : 'them'}`, danger: true, width: '980px' });
  if (!ok) return false;

  // The second question, asked only when it means something. An index with a good
  // snapshot can be restored; one without cannot, and that is the whole difference
  // between a routine cleanup and losing log data.
  if (uncovered.length) {
    const sure = await confirmDialog(
      `${uncovered.length} of these ${uncovered.length === 1 ? 'has' : 'have'} no snapshot`,
      h('div', { style: { display: 'grid', gap: '8px' } },
        h('div.banner.err', { style: { margin: 0 } },
          h('div', h('div.ttl', uncovered.length === 1
              ? 'This index is held in no successful snapshot'
              : `These ${uncovered.length} indices are held in no successful snapshot`),
            h('div', 'Deleting them destroys the only copy. There is nothing to restore from '
                   + 'afterwards, on this cluster or anywhere else.'))),
        nameList(uncovered),
        covered.length
          ? h('div.muted', { style: { fontSize: '12px' } },
              `The other ${covered.length} do have a snapshot and can be restored.`)
          : null),
      { yes: `delete all ${names.length}`, no: 'cancel', danger: true });
    if (!sure) return false;
  }

  const failed = await forEachIndex(client(cluster.id), names, (n) => client(cluster.id).deleteIndex(n));
  report('delete', names.length, failed, { cluster, names, uncovered: uncovered.length });
  if (onChanged) await onChanged();
  return true;
}

/* ------------------------------ move a shard -------------------------------- */

/**
 * `_cluster/reroute` with a `move` command — the real "move an index to another node".
 * Elasticsearch moves shards, not indices, so the dialog picks the shard.
 */
export async function moveShardDialog(cluster, indexName, { onChanged } = {}) {
  if (!(await ensureWrites())) return false;
  const cl = client(cluster.id);

  let shards = [];
  try {
    shards = (await cl.shardsOf(indexName)).filter((r) => r.state === 'STARTED');
  } catch (e) {
    toast(`Could not list the shards of ${indexName}`, 'err', 10000, { meta: cluster.name, detail: [e.message] });
    return false;
  }
  if (!shards.length) {
    toast(`${indexName} has no started shard to move`, 'warn', 8000, { meta: cluster.name, detail: ['Only STARTED shards can be relocated.'] });
    return false;
  }

  const d = state.data.get(cluster.id) || {};
  const nodes = (d.nodes || []).map((n) => n.name).filter(Boolean);
  const shardOpts = shards.map((r) => [
    `${r.shard}|${r.prirep}|${r.node}`,
    `shard ${r.shard} ${r.prirep === 'p' ? 'primary' : 'replica'} · on ${r.node} · ${bytes(Number(r.store) || 0)}`,
  ]);

  const targetHost = h('div');
  function drawTarget() {
    const cur = (val('ia-shard') || '').split('|')[2];
    const options = nodes.filter((n) => n !== cur);
    mount(targetHost, field('Move to node',
      options.length
        ? select('ia-tonode', options[0], options.map((n) => [n, n]))
        : h('div.muted', { style: { fontSize: '12px' } }, 'No other node is available to move this shard to.')));
  }

  const shardSel = select('ia-shard', shardOpts[0][0], shardOpts);
  shardSel.onchange = drawTarget;

  const body = [
    h('div.muted', { style: { fontSize: '12px' } },
      'Elasticsearch relocates shards, not whole indices. Moving copies the shard to the target node and ' +
      'removes it from the source once the copy is complete — the index stays available throughout.'),
    field('Index', text('ia-index', indexName, { mono: true, style: { pointerEvents: 'none', opacity: '.7' } })),
    field('Shard', shardSel),
    targetHost,
  ];
  drawTarget();

  const res = await modal(`Move a shard of ${indexName}`, cluster.name, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const [shard, , fromNode] = (val('ia-shard') || '').split('|');
        const toNode = val('ia-tonode');
        if (!toNode) throw new Error('There is no other node to move this shard to.');
        const go = await confirmDialog('Move this shard?',
          `${indexName} shard ${shard}\n\nfrom  ${fromNode}\nto    ${toNode}\n\n` +
          'The shard is copied to the target node and removed from the source once the copy ' +
          'completes. The index stays available, but the copy uses disk and network on both nodes.',
          { yes: 'move' });
        if (!go) return;
        await cl.reroute([{ move: { index: indexName, shard: Number(shard), from_node: fromNode, to_node: toNode } }]);
        // Accepted, not finished: the cluster copies the shard in the background, and a
        // toast saying "moved" would be claiming something that has not happened yet.
        trackTask({ title: 'Shard move started', cluster,
          detail: [`${indexName} shard ${shard}`, `${fromNode} → ${toNode}`],
          poll: shardMovePoll(cluster, [{ index: indexName, shard, to: toNode }]) });
        ctx.done({ shard, fromNode, toNode });
      }) }, 'Move shard'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '580px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ------------------------------ index settings ------------------------------ */

export async function indexSettingsDialog(cluster, names, { onChanged } = {}) {
  if (!names.length || !(await ensureWrites())) return false;
  const cl = client(cluster.id);
  const one = names.length === 1 ? names[0] : null;

  let current = {};
  if (one) {
    try {
      const j = await cl.indexSettings(one);
      current = (j[one] && j[one].settings) || {};
    } catch (_) { /* fall back to blank fields */ }
  }

  const body = [
    names.length > 1
      ? h('div.banner.warn', { style: { margin: '0 0 4px' } },
          h('div', h('div.ttl', `Applies to all ${names.length} selected indices`), h('div', listFor(names, 6))))
      : null,
    field('Number of replicas', text('ia-rep', current['index.number_of_replicas'] ?? '', { placeholder: '1' }),
      'Applied immediately. The shard count of an existing index cannot be changed — split or shrink it instead.'),
    field('Refresh interval', text('ia-refresh', current['index.refresh_interval'] ?? '', { placeholder: '1s, 30s, -1' }),
      '-1 disables refreshes, which speeds up heavy indexing.'),
    field('Total shards per node', text('ia-tspn', current['index.routing.allocation.total_shards_per_node'] ?? '', { placeholder: 'unset' })),
    h('div', { style: { display: 'grid', gap: '7px' } },
      checkbox('ia-ro', 'Read-only (index.blocks.write)', String(current['index.blocks.write']) === 'true',
        'Blocks writes but still allows deleting the index.')),
    h('div.muted', { style: { fontSize: '11.5px' } }, 'Leave a field empty to leave that setting untouched.'),
  ];

  const res = await modal(one ? `Settings for ${one}` : `Settings for ${names.length} indices`, cluster.name, body,
    (ctx) => [
      h('button.btn.primary', { onclick: (e) => ctx.run(e.target, async () => {
        const settings = {};
        const rep = val('ia-rep').trim();
        const refresh = val('ia-refresh').trim();
        const tspn = val('ia-tspn').trim();
        if (rep !== '') {
          if (!/^\d+$/.test(rep)) throw new Error('Replicas must be a whole number.');
          settings['index.number_of_replicas'] = Number(rep);
        }
        if (refresh !== '') settings['index.refresh_interval'] = refresh;
        if (tspn !== '') {
          if (!/^-?\d+$/.test(tspn)) throw new Error('Total shards per node must be a whole number.');
          settings['index.routing.allocation.total_shards_per_node'] = Number(tspn);
        }
        settings['index.blocks.write'] = checked('ia-ro');
        if (!Object.keys(settings).length) throw new Error('Nothing to change.');
        const failed = await forEachIndex(cl, names, (n) => cl.updateIndexSettings(n, settings));
        if (failed.length) throw new Error(`${failed.length} failed — ${failed[0]}`);
        ctx.done(names.length);
      }) }, 'Apply'),
      h('button.btn', { onclick: () => ctx.done(null) }, 'Cancel'),
    ], { width: '600px' });

  if (res && onChanged) await onChanged();
  return !!res;
}

/* ------------------------------- maintenance -------------------------------- */

const MAINTENANCE = {
  refresh: { label: 'Refresh', verb: 'refresh', call: (cl, n) => cl.refreshIndex(n),
    note: 'Makes recent writes searchable. Cheap.' },
  flush: { label: 'Flush', verb: 'flush', call: (cl, n) => cl.flushIndex(n),
    note: 'Writes the transaction log to disk.' },
  clear: { label: 'Clear cache', verb: 'clear the cache of', call: (cl, n) => cl.clearIndexCache(n),
    note: 'Frees query and field-data cache. Later queries are slower until it warms up again.' },
  forcemerge: { label: 'Force merge', verb: 'force merge', call: (cl, n) => cl.forceMergeIndex(n, 1),
    note: 'Merges to one segment. Very expensive on a large index and should only be run on indices that are no longer written to. It starts in the background.' },
};

export async function maintenance(cluster, names, kind, { onChanged } = {}) {
  const spec = MAINTENANCE[kind];
  if (!spec || !names.length || !(await ensureWrites())) return false;
  const ok = await confirmDialog(`${spec.label} ${names.length === 1 ? names[0] : `${names.length} indices`}?`,
    h('div', h('div', `On ${cluster.name}. ${spec.note}`), nameList(names)),
    { yes: spec.label.toLowerCase() });
  if (!ok) return false;
  const cl = client(cluster.id);
  const failed = await forEachIndex(cl, names, (n) => spec.call(cl, n));
  report(spec.verb, names.length, failed, { cluster, names });
  if (onChanged) await onChanged();
  return true;
}

export const MAINTENANCE_KINDS = Object.entries(MAINTENANCE).map(([k, v]) => [k, v.label]);

/**
 * Say what happened, every time.
 *
 * This used to be silent on success and a modal alert on failure, which is the wrong way
 * round twice over: an action that changed a cluster and said nothing leaves you
 * re-reading the table to work out whether it worked, and a modal for a partial failure
 * blocks the page to tell you something you then have to remember.
 *
 * Success is a toast that names the count and the cluster. Failure is a toast too, held
 * longer because it is the one worth reading, and it names what failed rather than only
 * how many.
 */
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

function report(what, total, failed, opts = {}) {
  // Maintenance verbs come through here too ("force merge", "clear the cache of"), so
  // the fallback has to read as English rather than bolting "ed" onto a phrase.
  const past = {
    open: 'opened', close: 'closed', delete: 'deleted', move: 'moved',
    refresh: 'refreshed', flush: 'flushed',
    'clear the cache of': 'had their cache cleared', 'force merge': 'force-merged',
  }[what] || `${what}ed`;
  const where = opts.cluster ? ` on ${opts.cluster.name}` : '';
  const ok = total - failed.length;

  const noun = (n) => `${num(n)} ${n === 1 ? 'index' : 'indices'}`;
  const listOf = (xs) => xs.slice(0, 4).join(', ') + (xs.length > 4 ? ` +${xs.length - 4} more` : '');
  const card = { meta: opts.cluster ? opts.cluster.name : '' };
  const done = (opts.names || []).filter((n) => !failed.some((f) => String(f).startsWith(`${n}:`) || f === n));
  if (!failed.length) {
    toast(`${cap(past)}: ${noun(ok)}`, 'ok', 7000, { ...card, detail: [
      done.length ? listOf(done) : '',
      what === 'delete' && opts.uncovered ? `${opts.uncovered} had no snapshot — gone for good` : '',
      what === 'delete' && !opts.uncovered ? 'each one is still restorable from its snapshot' : '',
    ] });
    return;
  }
  toast(ok ? `${cap(past)}: ${noun(ok)} — ${failed.length} failed` : `Nothing ${past} — ${failed.length} failed`,
    'err', 12000, { ...card, detail: [...failed.slice(0, 3), failed.length > 3 ? `and ${failed.length - 3} more` : ''] });
}
