/**
 * The request policy (Config → Requests), as plain data: presets, bounds and the form's
 * arithmetic. No DOM here, so the rules are tested once and both the Config page and the
 * Request Centre use the same ones.
 *
 * The core is the authority — it clamps whatever it is sent. The bounds are repeated here
 * only so the form can say what it did to a value before the core does it silently.
 * Keep them equal to Policy::normalised() in crates/elasticpro-core/src/fleet/policy.rs.
 */

/** Every dataset the poller knows, in the order a person reads them. */
export const DATASET_LABELS = {
  health: 'Health',
  nodes: 'Nodes & disk',
  ilm_errors: 'ILM errors',
  policies: 'Policies, repositories & settings',
  ilm_assign: 'ILM assignment',
  snapshots: 'Snapshots (listing)',
  snapshots_full: 'Snapshots (full)',
  indices: 'Indices',
  shards: 'Shards & tasks',
};
export const DATASETS = Object.keys(DATASET_LABELS);

export const MODES = ['background', 'hybrid', 'on-demand'];

export const BOUNDS = {
  interval: { min: 30, max: 86400 },
  healthInterval: { min: 60, max: 86400 },
  watchMinutes: { min: 1, max: 240 },
  global: { min: 1, max: 256 },
  perCluster: { min: 1, max: 8 },
  tunnel: { min: 1, max: 32 },
  timeoutMs: { min: 1000, max: 600000 },
};

export const intervalBounds = (dataset) => (dataset === 'health' ? BOUNDS.healthInterval : BOUNDS.interval);

/**
 * Used only when the core has not said what it ships (an older core). The core's own
 * `defaults` always wins, because the health interval there can come from the environment.
 */
export const FALLBACK_DEFAULTS = {
  mode: 'background',
  intervalsSec: { health: 180, nodes: 300, ilm_errors: 900, policies: 3600, ilm_assign: 3600,
                  snapshots: 1800, snapshots_full: 1800, indices: 600, shards: 300 },
  watchMinutes: 15,
  concurrency: { global: 16, perCluster: 2, tunnel: 6 },
  timeoutMs: 30000,
  paused: { all: false, clusters: [] },
};

export const PRESETS = [
  { id: 'background', label: 'Background — the core keeps every cluster fresh' },
  { id: 'hybrid', label: 'Hybrid — health in the background, the rest when a page looks' },
  { id: 'client', label: 'Client basis — nothing until a page asks, one request per cluster at a time' },
];

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));
const whole = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v)
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

/** Within bounds, unknown datasets dropped, the paused list tidy — what the core would store. */
export function normalisePolicy(p, defaults = FALLBACK_DEFAULTS) {
  const d = defaults || FALLBACK_DEFAULTS;
  const src = p || {};
  const pick = (v, fallback, b) => clamp(whole(v) ?? fallback, b);
  const iv = src.intervalsSec || {};
  const div = d.intervalsSec || FALLBACK_DEFAULTS.intervalsSec;
  const intervalsSec = {};
  for (const ds of DATASETS) {
    intervalsSec[ds] = pick(iv[ds], div[ds] ?? FALLBACK_DEFAULTS.intervalsSec[ds], intervalBounds(ds));
  }
  const c = src.concurrency || {};
  const dc = d.concurrency || FALLBACK_DEFAULTS.concurrency;
  const seen = new Set();
  const clusters = ((src.paused && src.paused.clusters) || [])
    .filter((id) => typeof id === 'string' && id.trim() !== '' && !seen.has(id) && seen.add(id));
  return {
    mode: MODES.includes(src.mode) ? src.mode : (MODES.includes(d.mode) ? d.mode : 'background'),
    intervalsSec,
    watchMinutes: pick(src.watchMinutes, d.watchMinutes ?? 15, BOUNDS.watchMinutes),
    concurrency: {
      global: pick(c.global, dc.global ?? 16, BOUNDS.global),
      perCluster: pick(c.perCluster, dc.perCluster ?? 2, BOUNDS.perCluster),
      tunnel: pick(c.tunnel, dc.tunnel ?? 6, BOUNDS.tunnel),
    },
    timeoutMs: pick(src.timeoutMs, d.timeoutMs ?? 30000, BOUNDS.timeoutMs),
    paused: { all: !!(src.paused && src.paused.all), clusters },
  };
}

/**
 * A preset changes how the poller behaves, never what is paused: pressing "Client basis"
 * must not quietly resume a cluster somebody stopped by hand.
 */
export function applyPreset(policy, id, defaults = FALLBACK_DEFAULTS) {
  const base = normalisePolicy(defaults, FALLBACK_DEFAULTS);
  const paused = normalisePolicy(policy, defaults).paused;
  if (id === 'background') return { ...base, paused };
  if (id === 'hybrid') return { ...base, mode: 'hybrid', paused };
  if (id === 'client') {
    return { ...base, mode: 'on-demand', concurrency: { ...base.concurrency, perCluster: 1, global: 4 }, paused };
  }
  throw new Error(`no preset "${id}"`);
}

/** Which preset this policy is exactly, or null for a hand-made one. */
export function activePreset(policy, defaults = FALLBACK_DEFAULTS) {
  const strip = (p) => JSON.stringify({ ...normalisePolicy(p, defaults), paused: null });
  const now = strip(policy);
  const hit = PRESETS.find((x) => strip(applyPreset(policy, x.id, defaults)) === now);
  return hit ? hit.id : null;
}

const FIELD_NAMES = {
  watchMinutes: 'Watch window (minutes)',
  global: 'Concurrency — all clusters',
  perCluster: 'Concurrency — per cluster',
  tunnel: 'Concurrency — per jump host',
  timeoutMs: 'Timeout (ms)',
};

/**
 * What the form says, as a policy, with every value the form could not keep named.
 * `values` = {mode, intervalsSec: {ds: text}, watchMinutes, global, perCluster, tunnel,
 * timeoutMs, pausedAll, pausedClusters: []}. A field left empty or not a number takes the
 * shipped value; one out of bounds is clamped. Either way the person is told.
 */
export function fromForm(values, defaults = FALLBACK_DEFAULTS) {
  const v = values || {};
  const d = normalisePolicy(defaults, FALLBACK_DEFAULTS);
  const problems = [];
  const read = (raw, name, b, fallback, unit) => {
    const n = whole(raw);
    if (n === null) {
      problems.push(`${name}: "${raw ?? ''}" is not a number — using the shipped ${fallback}${unit}`);
      return fallback;
    }
    if (n < b.min || n > b.max) {
      const to = clamp(n, b);
      problems.push(`${name}: ${n}${unit} is outside ${b.min}–${b.max}${unit} — saved as ${to}${unit}`);
      return to;
    }
    return n;
  };
  const intervalsSec = {};
  for (const ds of DATASETS) {
    intervalsSec[ds] = read((v.intervalsSec || {})[ds], `${DATASET_LABELS[ds]} interval`, intervalBounds(ds), d.intervalsSec[ds], ' s');
  }
  if (v.mode !== undefined && !MODES.includes(v.mode)) problems.push(`Mode: "${v.mode}" is not one of ${MODES.join(', ')} — using ${d.mode}`);
  const policy = normalisePolicy({
    mode: MODES.includes(v.mode) ? v.mode : d.mode,
    intervalsSec,
    watchMinutes: read(v.watchMinutes, FIELD_NAMES.watchMinutes, BOUNDS.watchMinutes, d.watchMinutes, ''),
    concurrency: {
      global: read(v.global, FIELD_NAMES.global, BOUNDS.global, d.concurrency.global, ''),
      perCluster: read(v.perCluster, FIELD_NAMES.perCluster, BOUNDS.perCluster, d.concurrency.perCluster, ''),
      tunnel: read(v.tunnel, FIELD_NAMES.tunnel, BOUNDS.tunnel, d.concurrency.tunnel, ''),
    },
    timeoutMs: read(v.timeoutMs, FIELD_NAMES.timeoutMs, BOUNDS.timeoutMs, d.timeoutMs, ' ms'),
    paused: { all: !!v.pausedAll, clusters: v.pausedClusters || [] },
  }, defaults);
  return { policy, problems };
}

/** A new policy with one cluster paused or resumed; the order of the rest is kept. */
export function togglePaused(policy, clusterId, paused) {
  const p = policy || {};
  const was = (p.paused && p.paused.clusters) || [];
  // Pausing one already paused leaves it where it was rather than moving it last.
  const clusters = paused ? (was.includes(clusterId) ? [...was] : [...was, clusterId])
    : was.filter((id) => id !== clusterId);
  return { ...p, paused: { all: !!(p.paused && p.paused.all), clusters } };
}

/** A new policy with every request paused, or resumed. */
export function setPausedAll(policy, all) {
  const p = policy || {};
  return { ...p, paused: { clusters: [...((p.paused && p.paused.clusters) || [])], all: !!all } };
}

export function isPaused(policy, clusterId) {
  const p = (policy && policy.paused) || {};
  return !!p.all || (p.clusters || []).includes(clusterId);
}

export function describeMode(mode) {
  switch (mode) {
    case 'background': return 'The core keeps every cluster fresh on its own schedule, whether or not anybody is looking.';
    case 'hybrid': return 'Only health is fetched in the background; everything else is fetched while a page shows it, and for the watch window after.';
    case 'on-demand': return 'The core fetches nothing on its own: opening a page sends exactly what that page shows, for that cluster.';
    default: return 'The core did not say which mode is running.';
  }
}
