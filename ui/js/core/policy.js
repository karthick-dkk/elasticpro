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

/** Keep its threshold equal to AUTO_HYBRID_ABOVE in policy.rs. */
export const AUTO_HYBRID_ABOVE = 25;
export const MODES = ['auto', 'background', 'hybrid', 'on-demand'];

/**
 * "Client basis", what the core ships: nothing until a page asks, one request per cluster
 * at a time. The one definition on this side; the core's is CLIENT_BASIS_* in policy.rs and
 * tools/unit/policy.test.mjs holds the two together.
 */
export const CLIENT_BASIS = { mode: 'on-demand', perCluster: 1, global: 4 };
/** What the Automatic, Background and Hybrid presets run with (CLASSIC_* in policy.rs). */
export const CLASSIC = { perCluster: 2, global: 16 };

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
 * The poller's concurrency fields and the request-gate cap each one sits under, with the
 * config.txt key that sets the cap. The core clamps the poller's share under the gate's
 * limits (Policy::normalised() reads gate::limits()); POLICY_GET reports them as `gate`.
 */
export const GATE_CAPS = {
  global: { gate: 'global', setting: 'ES_CONCURRENCY' },
  perCluster: { gate: 'perCluster', setting: 'ES_PER_CLUSTER' },
  tunnel: { gate: 'perJump', setting: 'ES_PER_JUMP_HOST' },
};

/**
 * BOUNDS as this core will keep them: each concurrency maximum lowered to the request
 * gate's cap when the core reported one. The one definition of what the form may hold —
 * the inputs, normalisePolicy and fromForm all read it. An older core that reports no gate
 * leaves BOUNDS as they are; each entry says whether its maximum is the gate's (`gate`).
 */
export function boundsUnder(gate) {
  const out = { ...BOUNDS };
  for (const [field, { gate: key, setting }] of Object.entries(GATE_CAPS)) {
    const cap = gate && Number.isInteger(gate[key]) && gate[key] >= 1 ? gate[key] : null;
    if (cap !== null && cap < BOUNDS[field].max) out[field] = { ...BOUNDS[field], max: cap, gate: setting };
  }
  return out;
}

/**
 * Used only when the core has not said what it ships (an older core). The core's own
 * `defaults` always wins, because the health interval there can come from the environment.
 */
export const FALLBACK_DEFAULTS = {
  mode: CLIENT_BASIS.mode,
  intervalsSec: { health: 180, nodes: 300, ilm_errors: 900, policies: 3600, ilm_assign: 3600,
                  snapshots: 1800, snapshots_full: 1800, indices: 600, shards: 300 },
  watchMinutes: 15,
  concurrency: { global: CLIENT_BASIS.global, perCluster: CLIENT_BASIS.perCluster, tunnel: 6 },
  timeoutMs: 30000,
  paused: { all: false, clusters: [] },
};

export const PRESETS = [
  { id: 'client', name: 'Client basis', label: 'Client basis (recommended) — nothing until a page asks, one request per cluster at a time' },
  { id: 'auto', name: 'Automatic', label: `Automatic — background up to ${AUTO_HYBRID_ABOVE} clusters, hybrid above` },
  { id: 'background', name: 'Background', label: 'Background — the core keeps every cluster fresh' },
  { id: 'hybrid', name: 'Hybrid', label: 'Hybrid — health in the background, the rest when a page looks' },
];

/* ------------------------------ what a policy costs ------------------------------ */

/**
 * The datasets fetched only while a page looks at them, whatever the mode: the poller never
 * keeps them for every cluster. Keep equal to Dataset::class() in
 * crates/elasticpro-core/src/fleet/catalogue.rs (tools/unit/policy.test.mjs reads it).
 */
export const ON_DEMAND_ALWAYS = ['indices', 'shards', 'snapshots_full'];
const ON_DEMAND_WORDS = { indices: 'indices', shards: 'shards', snapshots_full: 'full snapshot listings' };
/** Nothing asked the core for this long and it polls health only (IDLE_MS in scheduler.rs). */
export const IDLE_MINUTES = 10;
/** A cluster that does not answer gets one health probe this often and nothing else
 *  (UNREACHABLE_PROBE_MS in catalogue.rs). */
export const UNREACHABLE_PROBE_SEC = 120;

/** The mode that runs for a fleet of `clusters`: `auto` is background up to AUTO_HYBRID_ABOVE,
 *  hybrid above. Config::resolved_mode in scheduler.rs. */
export function resolvedMode(mode, clusters) {
  if (mode !== 'auto') return mode;
  return clusters > AUTO_HYBRID_ABOVE ? 'hybrid' : 'background';
}

/** 'background' (fetched on its interval for every cluster) or 'onDemand' (only while a page
 *  looks at it). Config::effective_class in scheduler.rs. */
export function effectiveClass(dataset, mode, clusters) {
  const m = resolvedMode(mode, clusters);
  if (m === 'background') return ON_DEMAND_ALWAYS.includes(dataset) ? 'onDemand' : 'background';
  if (m === 'hybrid') return dataset === 'health' ? 'background' : 'onDemand';
  return 'onDemand';
}

/** 180 → "3 min", 3600 → "1 h", 90 → "90 s". */
export function everyText(sec) {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

const MODE_NAMES = { 'on-demand': 'Client basis', hybrid: 'Hybrid', background: 'Background' };

/**
 * What a policy does to the clusters: requests a minute when nobody is looking and when a
 * page is open. The one definition; Config › Requests shows it for every preset and for a
 * hand-made policy.
 *
 * Lower bounds, worked out from the policy's own intervals: every poll counts as one request,
 * and a poll can take more (health is two, policies seven, snapshots one per repository).
 * What the core does that this follows (scheduler.rs plan()):
 *   - only datasets of the 'background' effective class are fetched on their interval;
 *     indices, shards and full snapshot listings never are (ON_DEMAND_ALWAYS);
 *   - when no page has asked the core for anything for IDLE_MINUTES it polls health only;
 *   - a cluster that does not answer gets one health probe every UNREACHABLE_PROBE_SEC,
 *     and nothing else; under Client basis not even that;
 *   - a paused cluster gets nothing, and "pause all" stops everything.
 *
 * @param policy  a normalised policy (normalisePolicy / applyPreset)
 * @param o.clusters     how many clusters the core polls (what `auto` resolves against)
 * @param o.paused       how many of them the policy pauses
 * @param o.unreachable  how many of the rest do not answer now
 * @returns {{ mode, auto, why, idle: {perMinute, text}, open: {perMinute, text} }}
 *   perMinute is the bound itself (not rounded), null where it depends on the page.
 */
export function policyEffect(policy, { clusters = 0, paused = 0, unreachable = 0 } = {}) {
  const p = policy || {};
  const iv = p.intervalsSec || FALLBACK_DEFAULTS.intervalsSec;
  const watch = p.watchMinutes || FALLBACK_DEFAULTS.watchMinutes;
  const mode = resolvedMode(p.mode || CLIENT_BASIS.mode, clusters);
  const auto = p.mode === 'auto';
  const why = auto ? `Background up to ${AUTO_HYBRID_ABOVE} clusters, Hybrid above: with ${clusters} it runs as ${MODE_NAMES[mode]}.` : null;
  const out = (idle, open) => ({ mode, auto, why, idle, open });
  const active = p.paused && p.paused.all ? 0 : Math.max(0, clusters - paused);
  if (!clusters) return out({ perMinute: 0, text: 'no requests: no clusters are configured.' }, { perMinute: 0, text: 'nothing to ask.' });
  if (!active) return out({ perMinute: 0, text: 'no requests: every cluster is paused.' }, { perMinute: 0, text: 'nothing new starts until requests are resumed.' });
  const down = Math.min(Math.max(0, unreachable), active);
  const up = active - down;
  const pageOnly = `what that page shows, for the clusters on it, kept fresh while it is open and for ${watch} min after`;
  if (mode === 'on-demand') {
    return out({ perMinute: 0, text: 'no requests.' }, { perMinute: null, text: `only ${pageOnly}.` });
  }
  const perMin = (sec) => 60 / sec;
  const probes = down * perMin(UNREACHABLE_PROBE_SEC);
  const health = up * perMin(iv.health) + probes;
  const downNote = down ? `, and a probe every ${everyText(UNREACHABLE_PROBE_SEC)} × ${down} not answering` : '';
  const healthText = `${atLeast(health)} (health every ${everyText(iv.health)} × ${up}${downNote})`;
  if (mode === 'hybrid') {
    return out({ perMinute: health, text: `${healthText}.` },
      { perMinute: health, text: `the same health, plus ${pageOnly}.` });
  }
  const scheduled = DATASETS.filter((ds) => effectiveClass(ds, mode, clusters) === 'background');
  const full = up * scheduled.reduce((s, ds) => s + perMin(iv[ds]), 0) + probes;
  const fullText = `${atLeast(full)} (${scheduled.length} datasets kept fresh for each of ${up} cluster${up === 1 ? '' : 's'}${downNote})`;
  const words = ON_DEMAND_ALWAYS.map((ds) => ON_DEMAND_WORDS[ds]);
  const later = `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
  return out(
    { perMinute: health, text: `${healthText} once no page has asked for ${IDLE_MINUTES} min; ${atLeast(full)} until then.` },
    { perMinute: full, text: `${fullText}; pages read what is already fetched, and ${later} are fetched when a page asks.` });
}

/**
 * The "Fine-tune" fold's one line, collapsed: the concurrency, the timeout and what the
 * intervals do under this mode. "All clusters 4 · per cluster 1 · per jump host 6 ·
 * timeout 30 s · intervals only while a page watches".
 */
export function fineTuneSummary(policy, clusters = 0) {
  const p = policy || {};
  const c = p.concurrency || FALLBACK_DEFAULTS.concurrency;
  const ms = p.timeoutMs || FALLBACK_DEFAULTS.timeoutMs;
  const iv = p.intervalsSec || FALLBACK_DEFAULTS.intervalsSec;
  const mode = resolvedMode(p.mode || CLIENT_BASIS.mode, clusters);
  const scheduled = DATASETS.filter((ds) => effectiveClass(ds, mode, clusters) === 'background').length;
  const intervals = mode === 'on-demand' ? 'intervals only while a page watches'
    : mode === 'hybrid' ? `health every ${everyText(iv.health)}, the rest while a page watches`
    : `${scheduled} datasets on a schedule, health every ${everyText(iv.health)}`;
  return [`All clusters ${c.global}`, `per cluster ${c.perCluster}`, `per jump host ${c.tunnel}`,
    `timeout ${ms % 1000 ? `${ms} ms` : `${ms / 1000} s`}`, intervals].join(' \u00b7 ');
}

/** "at least 16 a minute", or per hour below one a minute. A lower bound is rounded down. */
function atLeast(perMinute) {
  const down = (x) => Math.floor(x + 1e-9);
  return perMinute >= 1 || perMinute === 0 ? `at least ${down(perMinute)} a minute` : `at least ${down(perMinute * 60)} an hour`;
}

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));
const whole = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v)
  : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

/**
 * Within bounds, unknown datasets dropped, the paused list tidy — what the core would store.
 * `bounds` is boundsUnder(the core's gate) when it reported one.
 */
export function normalisePolicy(p, defaults = FALLBACK_DEFAULTS, bounds = BOUNDS) {
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
    mode: MODES.includes(src.mode) ? src.mode : (MODES.includes(d.mode) ? d.mode : CLIENT_BASIS.mode),
    intervalsSec,
    watchMinutes: pick(src.watchMinutes, d.watchMinutes ?? 15, BOUNDS.watchMinutes),
    concurrency: {
      global: pick(c.global, dc.global ?? 16, bounds.global),
      perCluster: pick(c.perCluster, dc.perCluster ?? 2, bounds.perCluster),
      tunnel: pick(c.tunnel, dc.tunnel ?? 6, bounds.tunnel),
    },
    timeoutMs: pick(src.timeoutMs, d.timeoutMs ?? 30000, BOUNDS.timeoutMs),
    paused: { all: !!(src.paused && src.paused.all), clusters },
  };
}

/**
 * A preset changes how the poller behaves, never what is paused: pressing "Client basis"
 * must not quietly resume a cluster somebody stopped by hand.
 */
export function applyPreset(policy, id, defaults = FALLBACK_DEFAULTS, bounds = BOUNDS) {
  const base = normalisePolicy(defaults, FALLBACK_DEFAULTS, bounds);
  const paused = normalisePolicy(policy, defaults, bounds).paused;
  // The classic presets run with the classic concurrency, not the shipped one: the shipped
  // policy is Client basis, whose one-at-a-time limit would quietly throttle "Background".
  const classic = { ...base.concurrency, ...CLASSIC };
  const withMode = (mode) => normalisePolicy({ ...base, mode, concurrency: classic, paused }, defaults, bounds);
  if (id === 'auto' || id === 'background' || id === 'hybrid') return withMode(id);
  if (id === 'client') {
    return normalisePolicy({ ...base, mode: CLIENT_BASIS.mode, concurrency: { ...base.concurrency, perCluster: CLIENT_BASIS.perCluster, global: CLIENT_BASIS.global }, paused }, defaults, bounds);
  }
  throw new Error(`no preset "${id}"`);
}

/** Which preset this policy is exactly, or null for a hand-made one. */
export function activePreset(policy, defaults = FALLBACK_DEFAULTS, bounds = BOUNDS) {
  const strip = (p) => JSON.stringify({ ...normalisePolicy(p, defaults, bounds), paused: null });
  const now = strip(policy);
  const hit = PRESETS.find((x) => strip(applyPreset(policy, x.id, defaults, bounds)) === now);
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
export function fromForm(values, defaults = FALLBACK_DEFAULTS, bounds = BOUNDS) {
  const v = values || {};
  const d = normalisePolicy(defaults, FALLBACK_DEFAULTS, bounds);
  const problems = [];
  const read = (raw, name, b, fallback, unit) => {
    const n = whole(raw);
    if (n === null) {
      problems.push(`${name}: "${raw ?? ''}" is not a number — using the shipped ${fallback}${unit}`);
      return fallback;
    }
    if (n > b.max && b.gate) {
      problems.push(`${name}: ${n}${unit} is more than this core's request gate allows (${b.max}, set by ${b.gate} in config.txt) — saved as ${b.max}${unit}`);
      return b.max;
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
      global: read(v.global, FIELD_NAMES.global, bounds.global, d.concurrency.global, ''),
      perCluster: read(v.perCluster, FIELD_NAMES.perCluster, bounds.perCluster, d.concurrency.perCluster, ''),
      tunnel: read(v.tunnel, FIELD_NAMES.tunnel, bounds.tunnel, d.concurrency.tunnel, ''),
    },
    timeoutMs: read(v.timeoutMs, FIELD_NAMES.timeoutMs, BOUNDS.timeoutMs, d.timeoutMs, ' ms'),
    paused: { all: !!v.pausedAll, clusters: v.pausedClusters || [] },
  }, defaults, bounds);
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
    case 'auto': return `Background up to ${AUTO_HYBRID_ABOVE} clusters, hybrid above — so a large fleet is not polled for everything all the time.`;
    case 'background': return 'The core keeps every cluster fresh on its own schedule, whether or not anybody is looking.';
    case 'hybrid': return 'Only health is fetched in the background; everything else is fetched while a page shows it, and for the watch window after.';
    case 'on-demand': return 'The core fetches nothing on its own: opening a page sends exactly what that page shows, for the clusters on it — and that is kept fresh for the watch window after.';
    default: return 'The core did not say which mode is running.';
  }
}
