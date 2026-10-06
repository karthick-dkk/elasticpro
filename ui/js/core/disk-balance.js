/**
 * Is this cluster's data spread evenly enough, and would moving shards actually help?
 *
 * Two different questions get confused here. A cluster can be *full* — every node near the
 * watermark — which no amount of relocation fixes; and it can be *skewed* — one node heavy
 * while others idle — which relocation does fix. The verdict below distinguishes them,
 * because the remedy is different: buy disk, or rebalance.
 *
 * Thresholds come from the cluster's own watermark settings where it reports them, rather
 * than assuming Elasticsearch's defaults, which are routinely changed.
 */

/** Elasticsearch's defaults, used only when the cluster does not report its own. */
const FALLBACK = { low: 85, high: 90, flood: 95 };

/** A spread this wide between the fullest and emptiest data node is worth acting on. */
export const SPREAD_WATCH = 10;
export const SPREAD_ACT = 20;

/** "85%", "0.85", "50gb" — only a percentage can be compared against a node's usage. */
function pctSetting(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (s.endsWith('%')) { const n = parseFloat(s); return isFinite(n) ? n : null; }
  const n = parseFloat(s);
  // A bare ratio is a fraction of the disk; anything with a byte unit is not a percentage
  // and cannot be turned into one without knowing each node's disk size.
  if (isFinite(n) && n > 0 && n <= 1 && !/[a-z]/i.test(s)) return n * 100;
  return null;
}

/** Watermarks as the cluster actually has them, with a note when they are assumed. */
export function watermarks(settings) {
  const flat = {};
  const walk = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${prefix}${k}.`);
      else flat[`${prefix}${k}`] = v;
    }
  };
  for (const scope of ['persistent', 'transient', 'defaults']) walk((settings || {})[scope]);

  const pick = (name) => {
    // later scopes must not override earlier ones: persistent beats transient beats default
    for (const scope of ['persistent', 'transient', 'defaults']) {
      const s = (settings || {})[scope];
      if (!s) continue;
      const flatScope = {};
      walk(s);
      const direct = s[`cluster.routing.allocation.disk.watermark.${name}`];
      const nested = s.cluster && s.cluster.routing && s.cluster.routing.allocation
        && s.cluster.routing.allocation.disk && s.cluster.routing.allocation.disk.watermark;
      const v = direct !== undefined ? direct : nested ? nested[name] : undefined;
      const p = pctSetting(v);
      if (p !== null) return { value: p, raw: String(v), source: scope };
    }
    return null;
  };

  const low = pick('low'), high = pick('high'), flood = pick('flood_stage');
  return {
    low: low ? low.value : FALLBACK.low,
    high: high ? high.value : FALLBACK.high,
    flood: flood ? flood.value : FALLBACK.flood,
    assumed: !low && !high && !flood,
    raw: { low: low && low.raw, high: high && high.raw, flood: flood && flood.raw },
  };
}

/**
 * The two switches that decide whether Elasticsearch will move anything at all.
 *
 * Left turned off after maintenance — a common and easily forgotten step — a cluster stays
 * skewed for ever no matter how uneven it gets, so they are worth reading before advising
 * anybody to rebalance.
 */
export function allocationSettings(settings) {
  const read = (key) => {
    for (const scope of ['persistent', 'transient', 'defaults']) {
      const s = (settings || {})[scope];
      if (!s) continue;
      const flat = s[key];
      if (flat !== undefined) return { value: String(flat), source: scope };
      const parts = key.split('.');
      let cur = s;
      for (const p of parts) { cur = cur && cur[p]; if (cur === undefined) break; }
      if (cur !== undefined) return { value: String(cur), source: scope };
    }
    return null;
  };
  const alloc = read('cluster.routing.allocation.enable');
  const rebal = read('cluster.routing.rebalance.enable');
  return {
    allocation: alloc ? alloc.value : 'all',
    allocationSource: alloc ? alloc.source : 'assumed',
    rebalance: rebal ? rebal.value : 'all',
    rebalanceSource: rebal ? rebal.source : 'assumed',
    // "all" is the only value that lets Elasticsearch move data on its own.
    allocationOn: !alloc || alloc.value === 'all',
    rebalanceOn: !rebal || rebal.value === 'all',
    known: !!(alloc || rebal),
  };
}

/**
 * @param data      the cluster's state.data entry
 * @param settings  the response of _cluster/settings?include_defaults=true
 */
export function diskBalance(data = {}, settings = null) {
  const wm = watermarks(settings);
  const alloc = allocationSettings(settings);
  const rows = ((data.disk && data.disk.nodes) || []).filter((r) => r.node && r.node !== 'UNASSIGNED');

  const nodes = rows.map((r) => {
    const used = Number(r['disk.used']) || 0;
    const total = Number(r['disk.total']) || 0;
    return {
      name: r.node,
      used, total,
      avail: Number(r['disk.avail']) || 0,
      indices: Number(r['disk.indices']) || 0,
      shards: Number(r.shards) || 0,
      pct: total > 0 ? (used / total) * 100 : NaN,
    };
  }).filter((n) => isFinite(n.pct));

  const base = {
    watermarks: wm, settings: alloc, nodes, dataNodes: nodes.length,
    unassigned: (data.disk && data.disk.unassignedShards) || 0,
    applicable: nodes.length > 1,
  };

  // Relocation is meaningless with one node to relocate between.
  if (nodes.length < 2) {
    return { ...base, verdict: 'single-node', reasons: nodes.length ? ['Only one data node — there is nowhere to move a shard to.'] : ['No allocation data.'], suggestions: [] };
  }

  const byPct = [...nodes].sort((a, b) => b.pct - a.pct);
  const fullest = byPct[0], emptiest = byPct[byPct.length - 1];
  const spread = fullest.pct - emptiest.pct;

  const byShards = [...nodes].sort((a, b) => b.shards - a.shards);
  const shardSpread = byShards[0].shards - byShards[byShards.length - 1].shards;
  const avgShards = nodes.reduce((s, n) => s + n.shards, 0) / nodes.length;

  const aboveFlood = nodes.filter((n) => n.pct >= wm.flood);
  const aboveHigh = nodes.filter((n) => n.pct >= wm.high && n.pct < wm.flood);
  const aboveLow = nodes.filter((n) => n.pct >= wm.low && n.pct < wm.high);
  const headroom = emptiest.pct < wm.low;   // is there anywhere useful to move data to?

  const reasons = [];
  let verdict = 'ok';

  // Say this first: while either switch is off, nothing else in this panel can happen.
  if (!alloc.allocationOn || !alloc.rebalanceOn) {
    const off = [!alloc.allocationOn ? `allocation is "${alloc.allocation}"` : null,
                 !alloc.rebalanceOn ? `rebalancing is "${alloc.rebalance}"` : null].filter(Boolean).join(' and ');
    reasons.push(`${off} — Elasticsearch will not move shards on its own until that is set back to "all".`);
    verdict = 'watch';
  }

  if (aboveFlood.length) {
    verdict = 'critical';
    reasons.push(`${aboveFlood.map((n) => n.name).join(', ')} at or above the flood stage (${wm.flood}%). Elasticsearch makes indices with a shard there read-only.`);
  }
  if (aboveHigh.length) {
    if (verdict !== 'critical') verdict = 'required';
    reasons.push(`${aboveHigh.map((n) => n.name).join(', ')} above the high watermark (${wm.high}%). Elasticsearch will try to move shards away.`);
  }
  if (base.unassigned) {
    if (verdict === 'ok' || verdict === 'watch') verdict = 'required';
    reasons.push(`${base.unassigned} shard(s) unassigned — they may have nowhere to go.`);
  }
  if (spread >= SPREAD_ACT && headroom) {
    if (verdict === 'ok' || verdict === 'watch') verdict = 'required';
    reasons.push(`${spread.toFixed(1)} points between ${fullest.name} (${fullest.pct.toFixed(1)}%) and ${emptiest.name} (${emptiest.pct.toFixed(1)}%), and the emptiest node has room.`);
  } else if (spread >= SPREAD_WATCH) {
    if (verdict === 'ok') verdict = 'watch';
    reasons.push(`${spread.toFixed(1)} points between the fullest and emptiest node.`);
  }
  if (aboveLow.length && verdict === 'ok') {
    verdict = 'watch';
    reasons.push(`${aboveLow.map((n) => n.name).join(', ')} above the low watermark (${wm.low}%). New shards will avoid them.`);
  }
  // Everything full is not a balance problem, and saying "rebalance" would be wrong.
  const allFull = nodes.every((n) => n.pct >= wm.high);
  if (allFull) {
    reasons.push('Every data node is above the high watermark — this is a capacity problem, not a balance one. Moving shards will not help.');
  }
  if (!reasons.length) reasons.push(`Evenly spread: ${spread.toFixed(1)} points between the fullest and emptiest node, none above the low watermark.`);

  return {
    ...base,
    fullest, emptiest, spread, shardSpread, avgShards,
    aboveFlood, aboveHigh, aboveLow, headroom, allFull,
    verdict, reasons,
    // Reallocation only helps when something is skewed AND there is somewhere to put it.
    reallocationHelps: !allFull && (spread >= SPREAD_WATCH || aboveHigh.length > 0 || aboveFlood.length > 0) && headroom,
    suggestions: suggestions({ verdict, allFull, aboveFlood, aboveHigh, fullest, emptiest, spread, unassigned: base.unassigned, wm, alloc }),
  };
}

/**
 * The requests an operator would actually reach for, in the order they would reach for
 * them — diagnose first, then the reversible fix, then the one that costs money.
 */
/**
 * The single action that matters most right now. Everything else in `suggestions` is
 * context; this is the one to do first, and it is what the alert carries.
 */
export function primaryAction(b) {
  if (!b.applicable) return null;
  const s = b.suggestions || [];
  const find = (re) => s.find((x) => re.test(x.title));
  if (!b.settings.allocationOn || !b.settings.rebalanceOn) return find(/Re-enable allocation/);
  if (b.aboveFlood.length) return find(/read-only block/);
  if (b.allFull) return find(/oldest indices to delete/);
  if (b.unassigned) return find(/why a shard is unassigned/);
  if (b.reallocationHelps) return find(/Move one shard/);
  return find(/where the data actually sits/) || null;
}

function suggestions({ verdict, allFull, aboveFlood, aboveHigh, fullest, emptiest, spread, unassigned, wm, alloc }) {
  const out = [];
  const add = (s) => out.push(s);

  add({
    title: 'See where the data actually sits',
    why: 'Disk and shard count per node, before changing anything.',
    method: 'GET', path: '/_cat/allocation?v&s=disk.percent:desc&bytes=gb',
  });

  if (unassigned) {
    add({
      title: 'Ask why a shard is unassigned',
      why: 'Names the exact decider that refused it — usually a watermark or an allocation filter.',
      method: 'GET', path: '/_cluster/allocation/explain?pretty',
      body: '{\n  "index": "REPLACE-index-name",\n  "shard": 0,\n  "primary": false\n}',
    });
    add({
      title: 'Retry allocations that gave up',
      why: 'A shard that failed its retry limit stays unassigned until asked again, even once the cause is fixed.',
      method: 'POST', path: '/_cluster/reroute?retry_failed=true', write: true,
    });
  }

  if (aboveFlood.length) {
    add({
      title: 'Clear the flood-stage read-only block',
      why: 'Indices are left read-only after a flood-stage trip and do NOT recover on their own, even once disk is freed. Free space first, or this immediately re-trips.',
      method: 'PUT', path: '/_all/_settings', write: true,
      body: '{\n  "index.blocks.read_only_allow_delete": null\n}',
    });
  }

  if (alloc && (!alloc.allocationOn || !alloc.rebalanceOn)) {
    add({
      title: 'Re-enable allocation and rebalancing',
      why: `Currently allocation="${alloc.allocation}", rebalance="${alloc.rebalance}". Until both are "all", Elasticsearch will not move a shard however uneven the cluster gets.`,
      method: 'PUT', path: '/_cluster/settings', write: true,
      body: '{\n  "transient": {\n    "cluster.routing.allocation.enable": "all",\n    "cluster.routing.rebalance.enable": "all"\n  }\n}',
    });
  }

  if (!allFull && (aboveHigh.length || aboveFlood.length || spread >= SPREAD_WATCH)) {
    add({
      title: 'Confirm rebalancing is switched on',
      why: 'A cluster left with rebalancing disabled after maintenance will stay skewed for ever.',
      method: 'GET', path: '/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=**.rebalance**,**.allocation.enable',
    });
    add({
      title: 'Re-enable allocation and rebalancing',
      why: 'Only if the setting above shows either turned off.',
      method: 'PUT', path: '/_cluster/settings', write: true,
      body: '{\n  "transient": {\n    "cluster.routing.allocation.enable": "all",\n    "cluster.routing.rebalance.enable": "all"\n  }\n}',
    });
    if (fullest && emptiest) {
      add({
        title: `Move one shard from ${fullest.name} to ${emptiest.name}`,
        why: 'Elasticsearch rebalances on its own; do this only when it will not, and pick the shard from _cat/shards first.',
        method: 'POST', path: '/_cluster/reroute', write: true,
        body: `{\n  "commands": [\n    {\n      "move": {\n        "index": "REPLACE-index-name",\n        "shard": 0,\n        "from_node": "${fullest.name}",\n        "to_node": "${emptiest.name}"\n      }\n    }\n  ]\n}`,
      });
      add({
        title: `List the biggest shards on ${fullest.name}`,
        why: 'To choose which one to move.',
        method: 'GET', path: `/_cat/shards?v&s=store:desc&h=index,shard,prirep,state,store,node&bytes=gb`,
      });
    }
  }

  if (allFull || aboveFlood.length || aboveHigh.length) {
    add({
      title: 'Raise the watermarks — temporary relief only',
      why: 'Buys time to delete or add disk. It does not create space, and leaving it raised means the next trip is a full disk.',
      method: 'PUT', path: '/_cluster/settings', write: true,
      body: `{\n  "persistent": {\n    "cluster.routing.allocation.disk.watermark.low": "${Math.min(97, Math.round(wm.low + 3))}%",\n    "cluster.routing.allocation.disk.watermark.high": "${Math.min(98, Math.round(wm.high + 3))}%",\n    "cluster.routing.allocation.disk.watermark.flood_stage": "${Math.min(99, Math.round(wm.flood + 2))}%"\n  }\n}`,
    });
    add({
      title: 'Find the oldest indices to delete or snapshot',
      why: 'The only thing that actually creates space.',
      method: 'GET', path: '/_cat/indices?v&s=creation.date:asc&h=index,creation.date.string,store.size,docs.count&bytes=gb',
    });
  }

  return out;
}

/** One line an operator can act on, for the alert. */
export function balanceHeadline(b) {
  if (b.verdict === 'critical') return `disk at flood stage on ${b.aboveFlood.map((n) => n.name).join(', ')} — indices are read-only`;
  if (b.verdict === 'required') {
    if (b.allFull) return 'every data node above the high watermark — capacity, not balance';
    if (b.aboveHigh.length) return `${b.aboveHigh.map((n) => n.name).join(', ')} above the high watermark`;
    if (b.unassigned) return `${b.unassigned} shard(s) unassigned`;
    return `disk skewed by ${b.spread.toFixed(1)} points across ${b.dataNodes} nodes`;
  }
  if (b.verdict === 'watch') return `disk spread ${b.spread.toFixed(1)} points across ${b.dataNodes} nodes`;
  return 'disk evenly spread';
}
