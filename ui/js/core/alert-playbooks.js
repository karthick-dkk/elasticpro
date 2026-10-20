/**
 * How to fix each alert: a likely cause and the steps, written once per rule.
 *
 * Keyed by the rule id (alert-rules.js ALERT_RULES), so a rule cannot be added without
 * saying what to do about it — a test fails if one has no entry. A playbook is text that
 * points: each step may carry links to the page (and the problem in it) that answers it,
 * and a request that PREPARES the REST console — filled in, not sent.
 *
 * Reads are plain `GET`s. A request that changes something carries `write: true` and is
 * labelled so: it opens in the console for the person to read, edit and send, and the
 * console's own guard still decides whether it may go (Writes::decide — the unlock and a
 * deliberate Send). Nothing here ever sends anything.
 *
 * Thresholds are the ones the alert used (the app's settings) and, for disk, the cluster's
 * own watermarks when it reports them; when it does not, the text says "the cluster's
 * watermark" rather than quoting a default as if it were measured.
 */

import { ALERT_RULES } from './alert-rules.js';

/**
 * @typedef {{ text:string, links?:Array<{label:string, page:string, focus?:object}>,
 *             request?:{label?:string, method:string, path:string, body?:string, write?:boolean} }} Step
 * @typedef {{ cause:string, steps:Step[] }} Playbook
 */

const first = (m, key) => (m.items.find((i) => i[key]) || {})[key] || null;
const names = (m, n = 3) => m.items.slice(0, n).map((i) => i.label).join(', ') + (m.items.length > n ? ` and ${m.items.length - n} more` : '');
const pctOr = (v, fallback) => (Number.isFinite(v) ? `${Math.round(v)}%` : fallback);
const read = (path, label) => ({ method: 'GET', path, label });
const write = (method, path, body, label) => ({ method, path, ...(body ? { body } : {}), write: true, label });

/**
 * ctx: { defaults, watermarks:{low,high,flood,assumed}, siblings: Map<ruleId, merged>, cluster:{name} }
 * Each builder returns a Playbook for the merged alert `m`.
 */
export const PLAYBOOKS = {
  unreachable: (m) => ({
    cause: 'ElasticPro did not get an answer. The node may be down, the network or an SSH jump host in between may be, or the credential may have changed.',
    steps: [
      { text: 'Open its card: Retry and Diagnose say whether it is the network, TLS, the credential or the jump host.',
        links: [{ label: 'Its card on Clusters', page: 'overview', focus: { section: 'unreachable' } }] },
      { text: 'If Diagnose reports a refused or timed-out connection, check the Elasticsearch service and the firewall on the node itself.' },
      { text: 'If only ElasticPro cannot reach it, check the jump host tunnel and the certificate it presents. Everything else about this cluster on screen is stale until it answers.' },
    ],
  }),

  health: (m, ctx) => {
    const red = /red/.test(m.title);
    const disk = ctx.siblings.get('disk') || ctx.siblings.get('disk-balance');
    return {
      cause: red
        ? 'A primary shard is unassigned, so some data is missing from searches until it is allocated.'
        : 'A replica shard has nowhere to go. Data is complete, but one more node failure would lose some of it.',
      steps: [
        { text: 'See which shards are unassigned and the reason Elasticsearch gives for each.',
          links: [{ label: 'Unassigned shards', page: 'shards', focus: { section: 'unassigned' } }] },
        { text: 'Ask the cluster why the first one is not allocated: it names the exact decider that refused it.',
          request: read('/_cluster/allocation/explain?pretty', 'Prepare the explain request in the REST console') },
        disk ? { text: 'A disk alert is open on this cluster. A node past the high watermark takes no new shards, which is the usual reason replicas stay unassigned. Fix that first.',
          links: [{ label: 'Disk per node', page: 'shards', focus: { section: 'disk' } }] }
          : { text: 'If a node is missing, bring it back: shards it held are allocated again once it rejoins.',
              request: read('/_cat/nodes?v&h=name,ip,node.role,master,uptime', 'Prepare the node list in the REST console') },
        { text: 'If the reason is ALLOCATION_FAILED, retry the allocations Elasticsearch gave up on.',
          request: write('POST', '/_cluster/reroute?retry_failed=true', '', 'Prepare the retry in the REST console') },
      ],
    };
  },

  disk: (m, ctx) => {
    const wm = ctx.watermarks || {};
    const hi = wm.assumed ? 'the cluster\'s high watermark' : `the high watermark (${pctOr(wm.high)})`;
    const fl = wm.assumed ? 'the flood stage' : `the flood stage (${pctOr(wm.flood)})`;
    const ilm = ctx.siblings.get('ilm');
    const where = names(m);
    return {
      cause: `Data is arriving faster than it is moved to cheaper nodes or deleted. At ${hi} Elasticsearch stops placing shards on a node; at ${fl} it makes the indices on it read-only, and writes fail.`,
      steps: [
        { text: `See which indices hold the space on ${where}.`,
          links: [{ label: 'Disk per node', page: 'shards', focus: { section: 'disk' } }],
          request: read('/_cat/indices?v&s=store.size:desc&h=index,store.size,pri,rep,creation.date.string', 'Prepare the largest-indices request in the REST console') },
        ilm
          ? { text: `Check that indices roll over and move on: ${ilm.items.length} ${ilm.items.length === 1 ? 'index is' : 'indices are'} stuck in ILM on this cluster (alert on this page).`,
              links: [{ label: 'ILM errors', page: 'indices', focus: { ilm: true } }] }
          : { text: 'Check that indices roll over and move on to the warm and delete phases on schedule.',
              request: read('/*/_ilm/explain?only_managed=true&filter_path=indices.*.phase,indices.*.step', 'Prepare the ILM explain request in the REST console') },
        { text: 'Delete or close what is no longer needed, or add disk or a data node. The Indices page checks the snapshots before it deletes.',
          links: [{ label: 'Indices', page: 'indices' }] },
        { text: 'If indices were made read-only at the flood stage, release them once there is space.',
          request: write('PUT', '/_all/_settings', '{\n  "index.blocks.read_only_allow_delete": null\n}', 'Prepare the release in the REST console') },
        { text: `Short term: allocation stops at ${hi}, so the cluster turns yellow until space is freed.` },
      ],
    };
  },

  'disk-balance': (m, ctx) => ({
    cause: 'One node is filling while others have room. That is a placement problem: moving shards fixes it, adding disk does not.',
    steps: [
      { text: 'See each node\'s disk and which shards it holds.', links: [{ label: 'Disk per node', page: 'shards', focus: { section: 'disk' } }] },
      { text: 'Check that Elasticsearch is allowed to rebalance. Left off after maintenance, a cluster stays skewed however uneven it gets.',
        request: read('/_cluster/settings?include_defaults=true&filter_path=*.cluster.routing.allocation.*', 'Prepare the allocation settings in the REST console') },
      { text: `Move a large shard from the fullest node to the emptiest. The Nodes page does it with a confirmation; you choose which.`,
        links: [{ label: 'Nodes & shards', page: 'shards', focus: { section: 'nodes' } }] },
      { text: ctx.watermarks && !ctx.watermarks.assumed
        ? `Elasticsearch moves shards by itself once a node passes the high watermark (${pctOr(ctx.watermarks.high)}).`
        : 'Elasticsearch moves shards by itself once a node passes the cluster\'s high watermark.' },
    ],
  }),

  'disk-unaccounted': () => ({
    cause: 'Elasticsearch holds more on disk than the index list accounts for: a dangling index, orphaned shard directories, or files that are not Elasticsearch\'s at all.',
    steps: [
      { text: 'List dangling indices: indices found on a node\'s disk that the cluster state does not know about.',
        request: read('/_dangling?pretty', 'Prepare the dangling list in the REST console') },
      { text: 'Compare the disk per node with what the indices add up to.', links: [{ label: 'Disk per node', page: 'shards', focus: { section: 'disk' } }] },
      { text: 'Import or delete a dangling index by its UUID, after checking it is not wanted. The request is prepared with a placeholder you must replace.',
        request: write('DELETE', '/_dangling/INDEX-UUID?accept_data_loss=true', '', 'Prepare the delete in the REST console') },
      { text: 'If there are none, look at the data path on the node for files that are not Elasticsearch\'s (old logs, a copied snapshot).' },
    ],
  }),

  capacity: (m) => ({
    cause: 'The total size of the storage changed with the same number of nodes. Growing is usually somebody extending a volume; shrinking is a data path or mount that went missing.',
    steps: [
      { text: 'Compare each node\'s disk total and free space.', links: [{ label: 'Disk per node', page: 'shards', focus: { section: 'disk' } }],
        request: read('/_cat/allocation?v', 'Prepare the allocation table in the REST console') },
      { text: m.level === 'critical'
        ? 'It fell: check the mounts and data paths on the affected node (df -h, and that every path in path.data is mounted).'
        : 'It grew: confirm it was planned, and that the new space is on the data path Elasticsearch uses.' },
      { text: 'The alert clears on its own after a while; the figure becomes the new baseline.' },
    ],
  }),

  'no-master': () => ({
    cause: 'No node holds the master role, so the cluster cannot accept changes to its state. Usually fewer than half of the master-eligible nodes can see each other.',
    steps: [
      { text: 'See which nodes answer and which are master-eligible.', links: [{ label: 'Nodes', page: 'shards', focus: { section: 'nodes' } }],
        request: read('/_cat/nodes?v&h=name,ip,node.role,master,uptime', 'Prepare the node list in the REST console') },
      { text: 'Check that a majority of the master-eligible nodes are running and can reach each other on the transport port.' },
      { text: 'Read the log of a master-eligible node for "master not discovered" and what it is waiting for.' },
    ],
  }),

  'master-changed': () => ({
    cause: 'The previous master left, was cut off or was restarted, and problems in that window start there.',
    steps: [
      { text: 'See which node is master now and which restarted (uptime).', links: [{ label: 'Nodes', page: 'shards', focus: { section: 'nodes' } }],
        request: read('/_cat/nodes?v&h=name,ip,node.role,master,uptime', 'Prepare the node list in the REST console') },
      { text: 'Find out why the old master left: its log around the time shown under Related.' },
      { text: 'A re-election on a cluster that is green again is routine. Other alerts that started after it are listed under Related.' },
    ],
  }),

  ilm: (m, ctx) => {
    const idx = first(m, 'index');
    const disk = ctx.siblings.get('disk') || ctx.siblings.get('disk-balance');
    return {
      cause: disk
        ? 'Lifecycle steps failed on these indices. A disk alert is open on this cluster: a full node refuses the shards a rollover or shrink needs, so the step errors.'
        : 'Lifecycle management stopped on these indices at a failed step, so they will not roll over or be deleted. The reason is in the step\'s error.',
      steps: [
        { text: 'See the indices in an error step.', links: [{ label: 'Indices in ILM error', page: 'indices', focus: { ilm: true } }] },
        { text: `Read why the first one failed${idx ? ` (${idx})` : ''}: the step_info holds the reason.`,
          request: read(`/${idx || 'INDEX-NAME'}/_ilm/explain?pretty`, 'Prepare the ILM explain request in the REST console') },
        { text: 'Fix the cause: a missing rollover alias, a full disk, a policy that no longer exists.' },
        { text: 'Then retry the failed step. The request is prepared; you review it and send it.',
          request: write('POST', `/${idx || 'INDEX-NAME'}/_ilm/retry`, '', 'Prepare the retry in the REST console') },
      ],
    };
  },

  'slm-mode': () => ({
    cause: 'Snapshot lifecycle management is stopped, so scheduled snapshots are not being taken. Somebody stopped it, often for maintenance, and it was not started again.',
    steps: [
      { text: 'Confirm the mode.', request: read('/_slm/status', 'Prepare the SLM status in the REST console'),
        links: [{ label: 'SLM policies', page: 'snapshots', focus: { view: 'summary', section: 'policies' } }] },
      { text: 'Start it again if it should be running. Prepared, not sent.',
        request: write('POST', '/_slm/start', '', 'Prepare the start in the REST console') },
    ],
  }),

  'slm-fail': (m) => {
    const p = first(m, 'policy');
    return {
      cause: 'The most recent scheduled snapshot did not succeed. The failure message names the cause: a repository that cannot be written, a missing index, or a node that dropped out.',
      steps: [
        { text: `Read the failure${p ? ` of ${p}` : ''}.`, links: [{ label: 'SLM policies', page: 'snapshots', focus: { view: 'summary', section: 'policies' } }],
          request: read(`/_slm/policy/${p || 'POLICY'}?human`, 'Prepare the policy in the REST console') },
        { text: 'If it names the repository, verify the repository is writable from every node. Prepared, not sent.',
          request: write('POST', '/_snapshot/REPOSITORY/_verify', '', 'Prepare the verify in the REST console') },
        { text: 'Run the policy once more after fixing it, instead of waiting for the schedule.',
          request: write('POST', `/_slm/policy/${p || 'POLICY'}/_execute`, '', 'Prepare the run in the REST console') },
      ],
    };
  },

  'slm-stale': (m, ctx) => {
    const p = first(m, 'policy');
    const repo = ctx.siblings.get('repo');
    return {
      cause: repo
        ? 'Backups have stopped. A repository problem is open on this cluster, which is the likely reason no snapshot completed.'
        : 'Backups have stopped running rather than started failing: the schedule, SLM itself or a retention rule may have changed.',
      steps: [
        { text: `Check when ${p || 'the policy'} last ran and when it is next due.`,
          links: [{ label: 'SLM policies', page: 'snapshots', focus: { view: 'summary', section: 'policies' } }],
          request: read(`/_slm/policy/${p || 'POLICY'}?human`, 'Prepare the policy in the REST console') },
        repo ? { text: 'Fix the repository first.', links: [{ label: 'Repositories', page: 'snapshots', focus: { view: 'summary', section: 'repos' } }] }
             : { text: 'Check that SLM is running.', request: read('/_slm/status', 'Prepare the SLM status in the REST console') },
        { text: 'Take a snapshot now by running the policy. Prepared, not sent.',
          request: write('POST', `/_slm/policy/${p || 'POLICY'}/_execute`, '', 'Prepare the run in the REST console') },
        { text: `It counts as stale after ${ctx.defaults && ctx.defaults.snapshotStaleHours ? `${ctx.defaults.snapshotStaleHours} h` : 'the configured number of hours'} without a success (Config → alert rules).` },
      ],
    };
  },

  repo: (m) => {
    const r = first(m, 'repo') || (m.items[0] && m.items[0].label);
    return {
      cause: 'A snapshot repository is unreadable, empty, or its recent snapshots failed. For a cloud bucket the usual cause is a changed credential or policy (a 403), or a bucket that was moved or emptied.',
      steps: [
        { text: `Open the repositories and read the error for ${r || 'the repository'}.`,
          links: [{ label: 'Repositories', page: 'snapshots', focus: { view: 'summary', section: 'repos' } }],
          request: read(`/_snapshot/${r || 'REPOSITORY'}`, 'Prepare the repository settings in the REST console') },
        { text: 'Check the bucket or mount outside Elasticsearch: the credential, its permissions, that the path still exists.' },
        { text: 'Verify it from every node once fixed. Prepared, not sent.',
          request: write('POST', `/_snapshot/${r || 'REPOSITORY'}/_verify`, '', 'Prepare the verify in the REST console') },
      ],
    };
  },

  'log-delay': () => ({
    cause: 'Logs arrive behind real time: the device is shipping late, its clock is wrong, or the cluster is ingesting slower than they come in.',
    steps: [
      { text: 'See the late devices, worst first.', links: [{ label: 'Late devices', page: 'logs', focus: { view: 'delay' } }] },
      { text: 'On the worst device, check the shipper (Filebeat, Logstash, a syslog relay): a growing queue or a stopped service.' },
      { text: 'A negative delay means the device clock is ahead; fix its time source.' },
      { text: 'If many devices are late at once, check whether the cluster is rejecting writes.',
        request: read('/_cat/thread_pool/write?v&h=node_name,active,queue,rejected', 'Prepare the write thread pool in the REST console') },
    ],
  }),

  automation: (m) => ({
    cause: 'A rule you set to notify found indices that match it. Nothing ran: the work waits for a person.',
    steps: [
      { text: 'Open the rule to see what it matched and what it would do.', links: [{ label: 'The rule', page: 'automation', focus: { rule: first(m, 'automationRule') } }] },
      { text: 'Run it through its normal confirmation if the proposal is right, or edit the rule if it is not.' },
    ],
  }),

  volume: (m) => {
    const f = first(m, 'field');
    return {
      cause: 'One value of a field is producing far more documents than its recent average: a device in a loop, a new source, or a real surge.',
      steps: [
        { text: `See the daily volume for ${f || 'that field'} and which value moved.`, links: [{ label: 'Field volume', page: 'volume', focus: f ? { field: f } : null }] },
        { text: 'Find the source of that value and check whether it is behaving: a restarted shipper replaying old logs looks like this.' },
        { text: 'If it is real and stays, the capacity figures will change: check the storage plan.', links: [{ label: 'Volume report', page: 'volume' }] },
      ],
    };
  },
};

/** Rule ids with no playbook — empty when every rule has one. For the test. */
export function rulesWithoutPlaybook() {
  return ALERT_RULES.filter((r) => typeof PLAYBOOKS[r.id] !== 'function').map((r) => r.id);
}

/**
 * The playbook for a merged alert. An alert of no registered rule gets a short generic one
 * that says so, rather than nothing.
 */
export function playbookFor(m, ctx = {}) {
  const c = { siblings: new Map(), defaults: {}, watermarks: null, ...ctx };
  const make = PLAYBOOKS[m.family];
  if (!make) {
    return { cause: 'ElasticPro has no written playbook for this kind of alert.',
      steps: [{ text: 'Open the page that answers it and read the detail above.' }] };
  }
  return make(m, c);
}
