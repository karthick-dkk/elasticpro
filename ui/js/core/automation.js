/**
 * Automation — rules that watch continuously and propose work.
 *
 * The split is deliberate. The expensive part of Elasticsearch housekeeping is the
 * checking: comparing every dated index against every snapshot in every repository, over
 * and over, to answer "is this one safe to delete yet". The dangerous part is the deletion,
 * which takes one click. So this automates the checking and leaves the click to a person.
 *
 * A rule never writes. It returns a proposal, the page renders it, and the operator runs it
 * through the same confirmation dialogs and the same two-gate write guard as a manual
 * action. Nothing here can act unattended.
 *
 * Arming (running a rule without a human) is designed for and switched off — see canArm().
 */

import { state, activeClusters } from './state.js';
import { parseRetention } from './volume.js';
import { verifyIndicesInSnapshots, coverageLabel } from './snapshot-verify.js';
import { diskBalance } from './disk-balance.js';
import { loadRules, evaluateUserRule, describeRule, ACTIONS as USER_ACTIONS } from './user-rules.js';

/** UTC, because index names carry a UTC date and "today" must mean the same thing. */
const daysAgoUtc = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * Why arming is unavailable.
 *
 * The hosted write unlock is a single switch shared by every signed-in user until RBAC
 * lands, so arming a rule today would let any one person's unlock authorise a robot to
 * delete indices on everyone's behalf. The seam is here so phase 2 has somewhere to plug
 * in; the answer stays no until then.
 *
 * @returns {{ok:false, reason:string}}
 */
export function canArm() {
  return {
    ok: false,
    reason: 'Arming needs per-user roles. The write unlock is currently one switch shared by '
          + 'every signed-in user, so an armed rule would run under whoever unlocked writes '
          + 'last. Planned for the RBAC phase.',
  };
}

/* ---------------------------------- the rules ---------------------------------- */

/**
 * A rule is `{ id, title, why, action, severity, armable, evaluate }`.
 *
 * `evaluate` returns one of:
 *   null                                    nothing to do
 *   { skipped: 'reason' }                   cannot run here, and why
 *   { targets, evidence, blocked, note }    a proposal
 *
 * `targets` is what the operator would act on. `blocked` is what the rule deliberately
 * refused to propose, with the reason — that list is the point of the feature, not a
 * footnote.
 */
export const RULES = [
  {
    id: 'retention-expired-and-backed-up',
    title: 'Delete indices past retention that are safely in a snapshot',
    why: 'An index older than the retention policy is costing disk for data you said you do '
       + 'not need. Deleting it is only safe once a successful snapshot holds it.',
    action: 'delete',
    severity: 'normal',
    armable: true,
    needsIndices: true,

    async evaluate({ cluster, data, indices }) {
      // The policy the report already resolves: config first, then the ILM delete phase.
      const ret = parseRetention(cluster.liveRetention)
        || (data.appliedIlm ? parseRetention(data.appliedIlm.deleteAfter) : null);
      if (!ret) {
        return { skipped: 'no retention policy — set liveRetention on the cluster, or give the indices an ILM delete phase' };
      }

      const dated = indices.filter((i) => i.day);
      if (!dated.length) return { skipped: 'no indices carry a date in their name' };

      // Strictly older than the window. An index dated exactly on the boundary is still
      // inside the policy.
      const cutoff = daysAgoUtc(ret.days);
      const newest = dated.reduce((a, b) => (a.day > b.day ? a : b)).day;

      const expired = dated.filter((i) => i.day < cutoff
        // Never the newest day: that is almost certainly still being written to.
        && i.day !== newest
        // Never an index that is already closed or red — those need a human first.
        && i.status !== 'close');
      if (!expired.length) return null;

      const names = expired.map((i) => i.index);
      const verdicts = await verifyIndicesInSnapshots(cluster, names);

      // Unknown is not safe. If any repository could not be read, this rule proposes
      // nothing at all for this cluster rather than proposing a subset that happens to be
      // provable — the unreadable repository might be the one holding the rest.
      const unreadable = [...verdicts.values()].flatMap((v) => v.unverified || []);
      if (unreadable.length) {
        return {
          skipped: `a repository could not be read (${[...new Set(unreadable)].join('; ')}), so `
                 + 'coverage is unknown and nothing is proposed',
        };
      }

      const targets = [];
      const blocked = [];
      for (const i of expired) {
        const v = verdicts.get(i.index);
        const label = coverageLabel(v);
        if (v && v.covered) {
          targets.push({ name: i.index, size: i.size, detail: label.text, day: i.day });
        } else {
          blocked.push({ name: i.index, reason: label.text, cls: label.cls, size: i.size, day: i.day });
        }
      }
      if (!targets.length && !blocked.length) return null;

      const freed = targets.reduce((s, t) => s + (t.size || 0), 0);
      return {
        targets,
        blocked,
        note: `retention ${ret.label}, so anything dated before ${cutoff}`,
        evidence: `${targets.length} of ${expired.length} expired indices have a successful snapshot`,
        freed,
      };
    },
  },

  {
    id: 'ilm-error-retry',
    title: 'Retry indices stuck in an ILM error step',
    why: 'An index in the ERROR step has stopped moving through its lifecycle: it will not '
       + 'roll over, shrink or delete until the step is retried.',
    action: 'ilm-retry',
    severity: 'normal',
    armable: true,
    needsIndices: false,

    async evaluate({ data }) {
      const names = Object.keys(data.ilmErrors || {});
      if (!names.length) return null;
      return {
        targets: names.map((n) => ({
          name: n,
          detail: (data.ilmErrors[n] && data.ilmErrors[n].step) || 'ERROR step',
        })),
        blocked: [],
        evidence: `${names.length} index/indices reported by _ilm/explain?only_errors`,
      };
    },
  },

  {
    id: 'unassigned-shards-retry',
    title: 'Retry allocation for unassigned shards',
    why: 'Shards that failed to allocate stay unassigned until the failure is retried. When '
       + 'the cause has passed — a node came back, disk was freed — a retry is all it needs.',
    action: 'reroute-retry',
    severity: 'normal',
    armable: true,
    needsIndices: false,

    async evaluate({ data }) {
      // diskBalance already decides whether a cluster has anywhere to put a shard, using
      // the cluster's own reported watermarks. Asking it beats a second copy of that logic.
      const bal = diskBalance(data, data.clusterSettings);
      const n = Number(bal.unassigned) || 0;
      if (!n) return null;

      const full = bal.nodes.filter((x) => x.pct >= bal.watermarks.high);
      if (bal.nodes.length && full.length === bal.nodes.length) {
        return {
          skipped: `${n} shard(s) unassigned, but every data node is above the `
                 + `${bal.watermarks.high}% high watermark — a retry has nowhere to put them, `
                 + 'this needs capacity',
        };
      }
      return {
        targets: [{ name: `${n} unassigned shard${n === 1 ? '' : 's'}`, detail: 'cluster-wide retry' }],
        blocked: [],
        evidence: 'POST /_cluster/reroute?retry_failed=true',
      };
    },
  },
];

/**
 * One malformed rule must not take out the list.
 *
 * Rules are stored in clusters.yaml and can be edited by hand, so activeRules() may be
 * handed something the builder would never have produced. Losing every rule — and with it
 * the whole Automation page — because one of them is half-written is the worse failure.
 * evaluateUserRule() already validates and skips; this covers the description, which runs
 * first and so crashed first.
 */
function safeDescribe(u) {
  try {
    return describeRule(u);
  } catch (e) {
    return `This automation could not be read (${e.message || e}). Edit or remove it.`;
  }
}

/**
 * A user-written rule, wearing the same shape as a built-in one.
 *
 * Everything downstream — the runner, the proposal list, the page — then treats the two
 * identically, so writing your own rule adds no rendering code and no second code path.
 */
function asRule(u) {
  return {
    id: `user:${u.id}`,
    title: u.name || '(unnamed automation)',
    why: safeDescribe(u),
    action: u.action === 'propose-delete' ? 'delete'
      : u.action === 'propose-close' ? 'close' : 'notify',
    severity: u.notify && u.notify.level === 'critical' ? 'critical' : 'normal',
    armable: false,
    needsIndices: true,
    user: u,
    evaluate: (ctx) => evaluateUserRule(u, ctx),
  };
}

/** Built-ins first, then whatever the operator has written. */
export function activeRules() {
  return [...RULES, ...loadRules().map(asRule)];
}

/* --------------------------------- the engine ---------------------------------- */

/** clusterId -> { at, results: [{rule, proposal|skipped|null, error}] } */
const results = new Map();
let running = false;
let lastRun = 0;

export function isRunning() { return running; }
export function lastRunAt() { return lastRun; }
export function resultsFor(clusterId) { return results.get(clusterId) || null; }
export function clearAutomation(clusterId) {
  if (clusterId) results.delete(clusterId); else results.clear();
}

/** Every proposal across every cluster, flattened for a badge or a worklist. */
export function allProposals() {
  const out = [];
  for (const [clusterId, r] of results) {
    for (const item of r.results) {
      if (item.proposal && (item.proposal.targets || []).length) {
        out.push({ clusterId, clusterName: r.clusterName, rule: item.rule, ...item.proposal });
      }
    }
  }
  return out;
}

/** Everything a rule deliberately refused to propose — the safety story, not a footnote. */
export function allBlocked() {
  const out = [];
  for (const [clusterId, r] of results) {
    for (const item of r.results) {
      for (const b of (item.proposal && item.proposal.blocked) || []) {
        out.push({ clusterId, clusterName: r.clusterName, rule: item.rule, ...b });
      }
    }
  }
  return out;
}

/**
 * Evaluate every rule against every reachable cluster.
 *
 * Read-only by construction: rules receive data and return descriptions. The retention
 * rule's snapshot listings are the only network calls made here, and only when they are
 * not already sitting in `data.snapshots` from state.js's own refresh — see
 * snapshot-verify.js's verifyIndicesInSnapshots for the reuse.
 */
export async function runAutomation({ onProgress } = {}) {
  if (running) return;
  running = true;
  try {
    for (const cluster of activeClusters()) {
      const data = state.data.get(cluster.id) || {};
      if (!data.reachable) {
        results.set(cluster.id, {
          at: Date.now(), clusterName: cluster.name,
          results: activeRules().map((rule) => ({ rule, skipped: 'cluster unreachable' })),
        });
        continue;
      }
      const indices = state.indices.get(cluster.id) || [];
      const out = [];
      for (const rule of activeRules()) {
        if (rule.needsIndices && !indices.length) {
          out.push({ rule, skipped: 'no index list loaded for this cluster yet' });
          continue;
        }
        try {
          const r = await rule.evaluate({ cluster, data, indices });
          if (!r) out.push({ rule, proposal: null });
          else if (r.skipped) out.push({ rule, skipped: r.skipped });
          else out.push({ rule, proposal: r });
        } catch (e) {
          out.push({ rule, error: e.message || String(e) });
        }
      }
      results.set(cluster.id, { at: Date.now(), clusterName: cluster.name, results: out });
      if (onProgress) onProgress(cluster);
    }
    lastRun = Date.now();
  } finally {
    running = false;
  }
}

/** Unused by the app; exported so a rule can be exercised on its own in a test. */
export function ruleById(id) { return RULES.find((r) => r.id === id) || null; }

/**
 * Notify, the in-app half.
 *
 * alerts() in state.js is synchronous, and evaluating a rule can need a snapshot listing,
 * so nothing is computed here — this reads the last run. A rule that has never run raises
 * nothing, which is the honest answer rather than a stale one.
 */
export function automationAlerts(clusterById) {
  const out = [];
  for (const [clusterId, r] of results) {
    for (const item of r.results) {
      const u = item.rule.user;
      if (!u || !u.notify || !u.notify.alert) continue;
      const p = item.proposal;
      if (!p || !p.targets.length) continue;
      const cluster = clusterById(clusterId);
      if (!cluster) continue;
      out.push({
        key: `${clusterId}:automation:${u.id}`,
        level: u.notify.level === 'critical' ? 'critical' : 'warning',
        cluster,
        title: `${u.name}`,
        detail: `${p.targets.length} match${p.targets.length === 1 ? '' : 'es'} on ${cluster.name}`
              + (p.blocked && p.blocked.length ? ` · ${p.blocked.length} held back` : '')
              + ` — ${(USER_ACTIONS[u.action] || {}).label || u.action}`,
      });
    }
  }
  return out;
}
