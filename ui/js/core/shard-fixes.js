/**
 * Why a shard is unassigned, in words, and what to do about it — the one mapping behind the "i"
 * on an unassigned shard row (pages/shards.js). Pure; tested in tools/unit/shard-fixes.test.mjs.
 *
 * The facts come from `GET _cluster/allocation/explain` for that shard: the reason code
 * Elasticsearch recorded when the shard became unassigned (`unassigned_info.reason`), its own
 * sentence (`allocate_explanation`), and every node's deciders that said NO with their words.
 * This file adds only what each code means and the fix it usually takes; it never invents a
 * cause — a code it does not know is shown as the code, with the cluster's words alone.
 */

/** The reason codes Elasticsearch records (UnassignedInfo.Reason), each in words with its usual fix. */
export const REASONS = Object.freeze({
  INDEX_CREATED: { title: 'Index just created', cause: 'The index was created and its shards have not been placed yet.',
    fix: 'Usually nothing: placement follows within seconds. If it stays, look at the deciders below — allocation may be switched off, or no node may take it.' },
  CLUSTER_RECOVERED: { title: 'Cluster recovered', cause: 'The cluster state was restored on a full restart and this shard has not been placed again yet.',
    fix: 'Wait for recovery to finish; `cluster.routing.allocation.node_initial_primaries_recoveries` bounds how many recover at once. If a primary stays unassigned, its data node has not rejoined.' },
  INDEX_REOPENED: { title: 'Index reopened', cause: 'The index was closed and reopened; its shards are being placed again.',
    fix: 'Usually nothing: placement follows. If it stays, read the deciders below.' },
  DANGLING_INDEX_IMPORTED: { title: 'Dangling index imported', cause: 'A node brought in an index the cluster state did not know about, and the copy has not been placed yet.',
    fix: 'Wait for the import to finish; if it stays unassigned, the only copy may be on a node that is not back.' },
  NEW_INDEX_RESTORED: { title: 'Restored from a snapshot', cause: 'The index was restored from a snapshot and this shard is still to be recovered from the repository.',
    fix: 'Wait for the restore; `GET _cat/recovery` shows its progress. A shard that fails to restore says so in the deciders below (the repository may be unreachable).' },
  EXISTING_INDEX_RESTORED: { title: 'Restored over an existing index', cause: 'A closed index was restored from a snapshot and its shards are being recovered.',
    fix: 'Wait for the restore; `GET _cat/recovery` shows its progress.' },
  REPLICA_ADDED: { title: 'Replica added', cause: 'The number of replicas was raised and the new copy has not been placed yet.',
    fix: 'Usually nothing. If no node can take it (one node, or every node already holds a copy), lower `index.number_of_replicas` or add a data node.' },
  ALLOCATION_FAILED: { title: 'Allocation failed', cause: 'Elasticsearch tried to place this shard and the attempt failed; after `index.allocation.max_retries` (5) it stops trying on its own.',
    fix: 'Read the failure in the deciders below (a full disk, a corrupt shard, a missing repository), fix that, then Retry failed allocations.' },
  NODE_LEFT: { title: 'Node left', cause: 'The node holding this copy left the cluster; for a replica, Elasticsearch waits `index.unassigned.node_left.delayed_timeout` (1 m by default) for it to come back before placing a new copy.',
    fix: 'Bring the node back, or wait for the delay to pass and the copy to be rebuilt elsewhere. A primary with no other copy needs its node back — or a restore from a snapshot.' },
  NODE_RESTARTING: { title: 'Node restarting', cause: 'The node holding this copy is in a planned restart (node shutdown API) and the shard waits for it.',
    fix: 'Nothing until the node is back; the shard is placed again when the restart finishes or `index.unassigned.node_left.delayed_timeout` passes.' },
  REROUTE_CANCELLED: { title: 'Reroute cancelled', cause: 'An explicit allocation of this shard was cancelled with a reroute command.',
    fix: 'Retry failed allocations, or move it to a chosen node from the row.' },
  REINITIALIZED: { title: 'Reinitialised', cause: 'The shard was moved from started back to initialising (for example, a shadow replica becoming a primary).',
    fix: 'Usually nothing: it initialises again.' },
  REALLOCATED_REPLICA: { title: 'Better replica copy found', cause: 'A node with a more complete copy of this replica was found, and the shard is being placed there instead.',
    fix: 'Nothing: the shard is placed on the node with the better copy.' },
  PRIMARY_FAILED: { title: 'Primary failed', cause: 'The primary this replica copied from failed, so the replica was unassigned while a new primary is chosen.',
    fix: 'Wait for a new primary to be elected from the in-sync copies; if none is, the index needs a restore from a snapshot.' },
  FORCED_EMPTY_PRIMARY: { title: 'Empty primary forced', cause: 'An operator forced an empty primary for this shard (`allocate_empty_primary`): its data was given up.',
    fix: 'Nothing to place; the data is gone unless a snapshot holds it.' },
  MANUAL_ALLOCATION: { title: 'Manual allocation', cause: 'The shard was allocated by an explicit reroute command and is not placed yet.',
    fix: 'Read the deciders below if the chosen node refuses it.' },
});

/**
 * The deciders whose NO usually names the fix by itself, matched on the decider's name. Checked
 * in this order; the first that said NO on any node gives the fix.
 */
export const DECIDERS = Object.freeze([
  { match: /disk_threshold/, title: 'Disk watermark', fix: 'Every node that could hold it is past `cluster.routing.allocation.disk.watermark.high` (90 % by default). Free disk — delete or snapshot-and-delete old indices, or move shards to an emptier node — then Retry failed allocations.' },
  { match: /awareness/, title: 'Allocation awareness', fix: 'The awareness rule (`cluster.routing.allocation.awareness.attributes`) forbids a second copy in the same zone or rack. Add a node in another zone, or relax the rule for this index.' },
  { match: /^filter$|filter/, title: 'Allocation filtering', fix: 'An `index.routing.allocation.include/exclude/require` or cluster-level filter leaves no node this shard may go to. Change the filter (Settings… on the Indices page) or add a node that matches it.' },
  { match: /same_shard/, title: 'Same shard', fix: 'Every node already holds a copy of this shard, so a further replica has nowhere to go. Lower `index.number_of_replicas` to the number of data nodes minus one, or add a data node.' },
  { match: /max_retry/, title: 'Retries exhausted', fix: 'The shard failed `index.allocation.max_retries` times and Elasticsearch stopped trying. Fix what the failure says (see the node decisions), then Retry failed allocations.' },
  { match: /enable/, title: 'Allocation switched off', fix: '`cluster.routing.allocation.enable` (or the index\'s own `index.routing.allocation.enable`) does not allow this kind of shard to be placed. Switch allocation back on (the Shard allocation card) once the maintenance it was off for is over.' },
  { match: /shards_limit/, title: 'Shards per node limit', fix: '`index.routing.allocation.total_shards_per_node` or `cluster.routing.allocation.total_shards_per_node` is reached on every node. Raise the limit or add a node.' },
  { match: /throttling/, title: 'Recoveries throttled', fix: 'Only so many recoveries run at once (`cluster.routing.allocation.node_concurrent_recoveries`). Nothing to fix; it is queued.' },
  { match: /replica_after_primary_active/, title: 'Primary not active', fix: 'A replica is placed only once its primary is started. Fix the primary first.' },
  { match: /snapshot_in_progress/, title: 'Snapshot in progress', fix: 'The shard is being snapshotted and is not moved until that finishes.' },
  { match: /node_version/, title: 'Node version', fix: 'A shard is never copied from a newer node to an older one. Finish the rolling upgrade.' },
]);

/** The deciders that said NO, flattened: `[{node, decider, explanation}]`. */
export function refusals(answer) {
  const out = [];
  for (const n of (answer && Array.isArray(answer.node_allocation_decisions)) ? answer.node_allocation_decisions : []) {
    if (!n || typeof n !== 'object') continue;
    const node = n.node_name || n.node_id || '';
    for (const d of Array.isArray(n.deciders) ? n.deciders : []) {
      if (d && String(d.decision || '').toUpperCase() === 'NO') out.push({ node, decider: String(d.decider || ''), explanation: String(d.explanation || '') });
    }
  }
  return out;
}

/**
 * The fix for a reason code and the deciders that refused it. The decider that names the fix wins
 * over the code's general one — "node left" explains how it got here, "disk watermark" explains why
 * it stays. null when neither the code nor a decider is known.
 */
export function fixFor(reason, deciderNames = []) {
  for (const d of DECIDERS) {
    if (deciderNames.some((name) => d.match.test(String(name || '')))) return { title: d.title, fix: d.fix };
  }
  const r = REASONS[String(reason || '').toUpperCase()];
  return r ? { title: r.title, fix: r.fix } : null;
}

/**
 * One explain answer in words: `reason` (the code), `title` and `cause` (what the code means —
 * the code itself when unknown), `explanation` (the cluster's own sentence), `details`
 * (`unassigned_info.details`, often the failure text), `deciders` (the refusals), `fix`
 * (`fixFor`, null when nothing is known), and `shard` ({index, shard, primary}).
 */
export function explainInWords(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const info = answer.unassigned_info || {};
  const reason = String(info.reason || '').toUpperCase();
  const known = REASONS[reason];
  const deciders = refusals(answer);
  return {
    shard: { index: answer.index, shard: answer.shard, primary: !!answer.primary },
    reason: reason || null,
    title: known ? known.title : reason ? reason.replace(/_/g, ' ').toLowerCase() : 'reason not recorded',
    cause: known ? known.cause : reason ? `Elasticsearch recorded the reason ${reason}, which this page has no words for.` : 'The explain answer carries no unassigned reason.',
    explanation: String(answer.allocate_explanation || answer.explanation || ''),
    details: String(info.details || ''),
    canAllocate: answer.can_allocate ? String(answer.can_allocate) : null,
    deciders,
    fix: fixFor(reason, deciders.map((d) => d.decider)),
  };
}

/** The body `GET _cluster/allocation/explain` takes for one shard — what the REST console is opened with. */
export function explainBody(index, shard, primary) {
  return { index, shard: Number(shard), primary: !!primary };
}
