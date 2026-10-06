#!/usr/bin/env node
/**
 * Evaluate the automation rules with no browser and print a document Zabbix can poll.
 *
 * The rules only ever ran when someone had the Automation page open, which makes a
 * notification close to useless: it arrives when you have already found the problem
 * yourself. This runs the same rules on a schedule and leaves the answer somewhere a
 * monitoring system can fetch it.
 *
 * It imports ui/js/core/automation.js rather than restating any of the rules, so there is
 * one definition of "safe to delete" and the scrape cannot drift away from the page. The
 * core modules touch no DOM, so this needs no jsdom — only a base URL for the relative
 * /bridge path the UI's transport posts to.
 *
 *   node tools/elasticpro-scrape.mjs --config clusters.yaml
 *   node tools/elasticpro-scrape.mjs --config clusters.yaml --out /var/lib/elasticpro/state.json
 *   node tools/elasticpro-scrape.mjs --config clusters.yaml --format sender | zabbix_sender -z zbx -i -
 *
 * Options:
 *   --config PATH     the same clusters.yaml the app loads          (required)
 *   --bridge URL      elasticpro-bridge base URL       (default http://127.0.0.1:8765)
 *   --out PATH        write here instead of stdout, atomically
 *   --format json     one JSON document, shaped for a Zabbix HTTP agent item  (default)
 *   --format sender   "<host> <key> <value>" lines for zabbix_sender
 *   --host NAME       host name used by --format sender   (default elasticpro)
 *   --token SECRET    an API token (elasticpro_…) minted on the Accounts page; sent as
 *                     Authorization: Bearer. Prefer a file over the command line, where
 *                     the secret would be visible in ps output.
 *   --token-file PATH the same token, read from a file (a Docker secret). Also
 *                     $ELASTICPRO_TOKEN_FILE. Wins over $ELASTICPRO_TOKEN and --token; a file that
 *                     is named but missing or empty stops the run instead of scraping as
 *                     nobody.
 *   --auth-user NAME  sent as X-Auth-User. Only names the run in the audit log — the
 *                     hosted bridge trusts that header because nginx sets it, so it is
 *                     not authentication. Use --token where the core issues one.
 *   --send HOST:PORT  push each cluster's client storage plan to its own Zabbix host on the
 *                     server's trapper port (10051), for the "ElasticPro client plan"
 *                     template. Needs no zabbix_sender: see tools/zabbix-sender.mjs.
 *   --measure-repos   also measure what the snapshot repositories hold (one _status call
 *                     per snapshot) — the plan's "backup storage store upto" needs it.
 *   --repo-cache PATH remember measured snapshot sizes between runs; a snapshot never
 *                     changes size once taken, so later runs only ask about new ones.
 *   --memory PATH     what one run has to hand the next: who was master, how big the disk
 *                     was, and the last log-delay measurement. Without it every run starts
 *                     from nothing, and "master moved" or "capacity changed" can never fire
 *                     — there is no earlier reading to have changed from.
 *   --delay-every MIN measure log delay at most this often (default 15). One aggregation
 *                     per cluster; runs in between reuse the last measurement.
 *   --indices-every MIN  list a cluster's indices at most this often (default 30). This
 *                     script is normally run on a schedule (cron, a systemd timer) much
 *                     tighter than that, so without a limit every run would re-list every
 *                     index on every cluster — the same call the Indices page makes —
 *                     just to feed the retention rule and the volume report. Requires
 *                     --memory (below): with no memory file there is nowhere to remember
 *                     the last listing, so every run fetches fresh, same as before this
 *                     flag existed.
 *
 * Exit status is 0 whenever the scrape produced a document, even if clusters were
 * unreachable — an unreachable cluster is a fact to report, not a reason to report
 * nothing. Only a failure to produce a document at all exits non-zero.
 *
 * This reads. It never writes to Elasticsearch: rules return descriptions of work, and
 * running that work still needs a person in the app, behind the same two-gate write guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFreshEnough } from './lib/refetch-interval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui', 'js');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const bridgeUrl = arg('--bridge', 'http://127.0.0.1:8765').replace(/\/+$/, '');
const configPath = arg('--config', '');
const outPath = arg('--out', '');
const format = arg('--format', 'json');
const zbxHost = arg('--host', 'elasticpro');
const authUser = arg('--auth-user', '');
// A file first (a Docker secret, $ELASTICPRO_TOKEN_FILE or --token-file): not in `docker inspect`
// or /proc/<pid>/environ. Then the environment, then the command line, where the secret is
// visible to anyone who can run ps. A file named but unreadable is an error, not a silent
// fall back to no token — that would scrape as nobody and report every cluster forbidden.
const tokenFile = process.env.ELASTICPRO_TOKEN_FILE || arg('--token-file', '');
let token = '';
if (tokenFile) {
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch (e) {
    console.error(`elasticpro-scrape: cannot read the API token file ${tokenFile}: ${e.message || e}`);
    process.exit(2);
  }
  if (!token) {
    console.error(`elasticpro-scrape: the API token file ${tokenFile} is empty`);
    process.exit(2);
  }
} else {
  token = process.env.ELASTICPRO_TOKEN || arg('--token', '');
}
const sendTo = arg('--send', '');
const measureRepos = process.argv.includes('--measure-repos');
const repoCachePath = arg('--repo-cache', '');
const memoryPath = arg('--memory', '');
const delayEveryMs = (Number(arg('--delay-every', '15')) || 15) * 60000;
const indicesEveryMs = (Number(arg('--indices-every', '30')) || 30) * 60000;

if (!configPath) {
  console.error('elasticpro-scrape: --config <clusters.yaml> is required');
  console.error('  see the header of this file for the full option list');
  process.exit(2);
}
if (format !== 'json' && format !== 'sender') {
  console.error(`elasticpro-scrape: --format must be json or sender, not ${format}`);
  process.exit(2);
}

/*
 * The whole of the browser shim.
 *
 * transport.js posts to the relative path /bridge, which is meaningless without a document
 * base, so relative URLs are resolved against the bridge. The hosted bridge also demands
 * X-Auth-User. Nothing else is needed: no jsdom, no DOM, no localStorage.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  if (typeof input === 'string' && input.startsWith('/')) input = bridgeUrl + input;
  const headers = { ...(init.headers || {}) };
  // A token is an identity the core issued and can revoke; the user header is only a name
  // nginx vouched for. The bridge prefers the token when both are present.
  if (token) headers.Authorization = `Bearer ${token}`;
  if (authUser) headers['X-Auth-User'] = authUser;
  return realFetch(input, { ...init, headers });
};

const { parseConfigText } = await import(path.join(UI, 'core/config.js'));
const { state, setConfig, fetchOverview, fetchIndices, activeClusters } =
  await import(path.join(UI, 'core/state.js'));
const { runAutomation, resultsFor, activeRules } = await import(path.join(UI, 'core/automation.js'));
const { client, alerts, setDelaySummary, delaySummaryFor } = await import(path.join(UI, 'core/state.js'));
const { preflight, measureDelay, summarise, delayItemValues } = await import(path.join(UI, 'core/log-delay.js'));
const { zabbixAlertValues, ZABBIX_ALERT_RULES } = await import(path.join(UI, 'core/zabbix-alerts.js'));
const { volumeReport, clientPlanValues, measureRepoBytes } = await import(path.join(UI, 'core/volume.js'));

/* ---------------------------------- gather ---------------------------------- */

const started = Date.now();
const problems = [];

let config;
try {
  config = parseConfigText(fs.readFileSync(configPath, 'utf8'), path.basename(configPath));
} catch (e) {
  console.error(`elasticpro-scrape: cannot read ${configPath}: ${e.message || e}`);
  process.exit(2);
}

// A sealed secret needs a master password only a person can type. Saying so beats scraping
// every cluster as unreachable and letting the monitoring system infer an outage.
if (config.sealed) {
  problems.push('config holds sealed (enc:v1:) credentials, which a headless run cannot '
              + 'unlock — give this run a config whose secrets are readable to it');
}

await setConfig(config, null);

// The last run's readings, put back where the app keeps its own between refreshes, so the
// comparisons alerts() makes — master, capacity — have something to compare with.
const REMEMBERED = ['master', 'masterChangedFrom', 'masterChangedAt', 'capacity'];
let memory = { clusters: {} };
if (memoryPath) {
  try { memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8')); memory.clusters ||= {}; }
  catch { /* first run: nothing to compare with yet */ }
}
for (const c of activeClusters()) {
  const m = memory.clusters[c.id];
  if (!m) continue;
  if (m.prev) state.data.set(c.id, { ...m.prev });
  if (m.delay) setDelaySummary(c.id, m.delay.summary, m.delay.at);
  // Seed last run's index list so a cluster whose interval has not elapsed yet (below)
  // still has one for the rest of this run — the retention rule and the volume report
  // both need it, and "not fetched this run" must not mean "no indices".
  if (m.indices && Array.isArray(m.indices.rows)) state.indices.set(c.id, m.indices.rows);
}

// Listing every index on every cluster is the same expensive call whether a person opens
// the Indices page or this runs on a five-minute cron — and unlike the page, this asks
// for every cluster every time it runs. --indices-every throttles that; --memory is what
// carries "when did we last ask" and the list itself across runs, the same way it already
// does for master/capacity and log delay above. No --memory: no way to remember, so this
// behaves exactly as it did before the flag existed and fetches every run.
const indicesFetchedNow = new Set();
for (const c of activeClusters()) {
  try { await fetchOverview(c.id); }
  catch (e) { problems.push(`${c.name}: overview failed — ${e.message || e}`); }

  const remembered = memory.clusters[c.id] && memory.clusters[c.id].indices;
  const usable = remembered && Array.isArray(remembered.rows);
  if (usable && isFreshEnough(remembered, started, indicesEveryMs)) continue;   // state.indices already holds `remembered.rows`, seeded above

  try {
    await fetchIndices(c.id, '*');
    indicesFetchedNow.add(c.id);
  } catch (e) { problems.push(`${c.name}: index list failed — ${e.message || e}`); }
}

// Log delay, when the last measurement is old enough. A cluster whose logs carry no event
// time cannot be measured; that is its answer, not a fault, and it is left unmeasured.
// Only a measurement taken in this run is sent to Zabbix — resending the last one every
// minute would put fifteen copies of one reading into its history.
const measuredNow = new Set();
for (const c of activeClusters()) {
  const data = state.data.get(c.id) || {};
  const last = delaySummaryFor(c.id);
  if (!data.reachable || (last && started - last.at < delayEveryMs)) continue;
  try {
    const pre = await preflight(client(c.id), c);
    if (!pre.ok || pre.unknown) continue;
    const r = await measureDelay(client(c.id), c, pre, 24);
    const sum = summarise(r.records);
    // Only what the alert reads is kept; the device list stays in the app.
    setDelaySummary(c.id, { devices: sum.devices, by: sum.by, median: sum.median,
      worst: sum.worst && { device: sum.worst.device, delayMinutes: sum.worst.delayMinutes } }, started);
    measuredNow.add(c.id);
  } catch (e) { problems.push(`${c.name}: log delay not measured — ${e.message || e}`); }
}

await runAutomation();

/* ------------------------------ the client plan ------------------------------ */

// The Volume report's Client plan, one row per client (cluster), from the same
// CLIENT_COLUMNS the page draws — a figure in Zabbix and on the page are one calculation.
const repoCache = new Map();
if (repoCachePath) {
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(repoCachePath, 'utf8')))) repoCache.set(k, v); }
  catch { /* first run, or unreadable: measure afresh */ }
}
const plan = [];
for (const c of activeClusters()) {
  const data = state.data.get(c.id) || {};
  let repoBytes = null;
  if (measureRepos && data.reachable) {
    try {
      const m = await measureRepoBytes(client(c.id), data, { cache: repoCache });
      repoBytes = m.total;
      if (m.failed) problems.push(`${c.name}: ${m.failed} snapshot size(s) could not be read; backup figures count ${m.counted}`);
    } catch (e) { problems.push(`${c.name}: repository measurement failed — ${e.message || e}`); }
  }
  const r = volumeReport(c, data, state.indices.get(c.id) || [], repoBytes);
  plan.push({ id: c.id, name: c.name, reachable: !!data.reachable, values: clientPlanValues(r),
              zabbixHost: (c.zabbix && c.zabbix.host) || null,
              delay: measuredNow.has(c.id) ? delayItemValues((delaySummaryFor(c.id) || {}).summary) : [],
              // The same alerts() the Alerts page lists, as the rules Zabbix raises.
              alerts: zabbixAlertValues(alerts().filter((a) => a.cluster && a.cluster.id === c.id)) });
}
if (memoryPath) {
  const next = { clusters: {} };
  for (const c of activeClusters()) {
    const d = state.data.get(c.id) || {};
    const prevIndices = memory.clusters[c.id] && memory.clusters[c.id].indices;
    next.clusters[c.id] = {
      prev: Object.fromEntries(REMEMBERED.filter((k) => d[k] != null).map((k) => [k, d[k]])),
      delay: delaySummaryFor(c.id),
      // Refetched this run: remember it with THIS run's time. Skipped as still fresh:
      // carry the earlier entry forward unchanged, so staleness is measured from when the
      // list was actually fetched, not from every run that merely reused it.
      indices: indicesFetchedNow.has(c.id)
        ? { at: started, rows: state.indices.get(c.id) || [] }
        : (prevIndices || null),
    };
  }
  const tmp = `${memoryPath}.tmp-${process.pid}`;
  try { fs.writeFileSync(tmp, JSON.stringify(next)); fs.renameSync(tmp, memoryPath); }
  catch (e) { problems.push(`cannot write ${memoryPath}: ${e.message || e}`); }
}
if (repoCachePath) {
  try { fs.writeFileSync(repoCachePath, JSON.stringify(Object.fromEntries(repoCache))); }
  catch (e) { problems.push(`cannot write ${repoCachePath}: ${e.message || e}`); }
}

/* ----------------------------------- shape ----------------------------------- */

const clusters = [];
const ruleRows = [];

for (const c of activeClusters()) {
  const data = state.data.get(c.id) || {};
  const r = resultsFor(c.id);
  const rules = [];

  for (const item of (r && r.results) || []) {
    const p = item.proposal;
    const proposed = (p && p.targets && p.targets.length) || 0;
    const held = (p && p.blocked && p.blocked.length) || 0;
    const row = {
      id: item.rule.id,
      title: item.rule.title,
      action: item.rule.action,
      user: !!item.rule.user,
      state: item.error ? 'error' : item.skipped ? 'skipped' : proposed ? 'proposed' : 'clean',
      proposed,
      held,
      freedBytes: (p && p.freed) || 0,
      detail: item.error || item.skipped || (p && (p.evidence || p.note)) || '',
      targets: p ? (p.targets || []).map((t) => t.name) : [],
      // What the rule refused to propose is the point of the feature, not a footnote: an
      // index past retention with no good snapshot is the one you most need to hear about.
      heldBack: p ? (p.blocked || []).map((b) => ({ name: b.name, reason: b.reason })) : [],
    };
    rules.push(row);
    ruleRows.push({ clusterId: c.id, clusterName: c.name, ...row });
  }

  clusters.push({
    id: c.id,
    name: c.name,
    reachable: !!data.reachable,
    health: (data.health && data.health.status) || 'unknown',
    proposed: rules.reduce((s, x) => s + x.proposed, 0),
    held: rules.reduce((s, x) => s + x.held, 0),
    freedBytes: rules.reduce((s, x) => s + x.freedBytes, 0),
    errors: rules.filter((x) => x.state === 'error').length,
    rules,
  });
}

const totals = {
  clusters: clusters.length,
  unreachable: clusters.filter((c) => !c.reachable).length,
  proposed: clusters.reduce((s, c) => s + c.proposed, 0),
  held: clusters.reduce((s, c) => s + c.held, 0),
  freedBytes: clusters.reduce((s, c) => s + c.freedBytes, 0),
  errors: clusters.reduce((s, c) => s + c.errors, 0),
  rulesEvaluated: activeRules().length,
};

const doc = {
  ok: problems.length === 0 && totals.unreachable === 0 && totals.errors === 0,
  generated: new Date(started).toISOString(),
  // Epoch seconds so a trigger can fuzzytime() this and alert when the scrape itself stops
  // running. A scraper that has died looks exactly like a healthy fleet otherwise.
  generatedEpoch: Math.floor(started / 1000),
  durationMs: Date.now() - started,
  source: path.basename(configPath),
  problems,
  totals,
  clusters,
  // The client storage plan, per client: { key: value }, null where it is unknown.
  plan: Object.fromEntries(plan.map((p) => [p.id, {
    name: p.name, reachable: p.reachable,
    values: Object.fromEntries(p.values.map((v) => [v.key, v.value])),
    alerts: p.alerts,
  }])),
  discovery: {
    clusters: clusters.map((c) => ({ '{#CLUSTER.ID}': c.id, '{#CLUSTER.NAME}': c.name })),
    rules: ruleRows.map((x) => ({
      '{#CLUSTER.ID}': x.clusterId,
      '{#CLUSTER.NAME}': x.clusterName,
      '{#RULE.ID}': x.id,
      '{#RULE.TITLE}': x.title,
      '{#RULE.ACTION}': x.action,
    })),
  },
};

/* ------------------------------------ emit ----------------------------------- */

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
let text;

if (format === 'sender') {
  const lines = [
    `${zbxHost} elasticpro.scrape.ok ${doc.ok ? 1 : 0}`,
    `${zbxHost} elasticpro.scrape.epoch ${doc.generatedEpoch}`,
    `${zbxHost} elasticpro.proposed ${totals.proposed}`,
    `${zbxHost} elasticpro.held ${totals.held}`,
    `${zbxHost} elasticpro.freed.bytes ${totals.freedBytes}`,
    `${zbxHost} elasticpro.errors ${totals.errors}`,
    `${zbxHost} elasticpro.unreachable ${totals.unreachable}`,
  ];
  for (const c of clusters) {
    lines.push(`${zbxHost} elasticpro.cluster.reachable[${c.id}] ${c.reachable ? 1 : 0}`);
    lines.push(`${zbxHost} elasticpro.cluster.proposed[${c.id}] ${c.proposed}`);
    lines.push(`${zbxHost} elasticpro.cluster.held[${c.id}] ${c.held}`);
    lines.push(`${zbxHost} elasticpro.cluster.freed.bytes[${c.id}] ${c.freedBytes}`);
  }
  for (const x of ruleRows) {
    lines.push(`${zbxHost} elasticpro.rule.proposed[${x.clusterId},${x.id}] ${x.proposed}`);
    lines.push(`${zbxHost} elasticpro.rule.held[${x.clusterId},${x.id}] ${x.held}`);
    lines.push(`${zbxHost} elasticpro.rule.detail[${x.clusterId},${x.id}] ${q(x.detail)}`);
  }
  lines.push(`${zbxHost} elasticpro.discovery.clusters ${q(JSON.stringify(doc.discovery.clusters))}`);
  lines.push(`${zbxHost} elasticpro.discovery.rules ${q(JSON.stringify(doc.discovery.rules))}`);
  text = `${lines.join('\n')}\n`;
} else {
  text = `${JSON.stringify(doc, null, 2)}\n`;
}

if (outPath) {
  // Written to a temporary file beside the target and renamed, because a web server or an
  // agent reading this path must never catch a half-written document.
  const tmp = `${outPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, outPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* it may never have been created */ }
    console.error(`elasticpro-scrape: cannot write ${outPath}: ${e.message || e}`);
    process.exit(2);
  }
  console.error(`elasticpro-scrape: wrote ${outPath} — ${totals.proposed} proposed, `
    + `${totals.held} held, ${totals.unreachable}/${totals.clusters} unreachable`);
} else {
  process.stdout.write(text);
}

/* ------------------------------ push to Zabbix ------------------------------ */

if (sendTo) {
  // Each cluster's plan goes to its own Zabbix host — the host that is that cluster — so
  // Zabbix's permissions on that host decide who sees it, the same way they decide who
  // sees the cluster in ElasticPro. A cluster with no Zabbix host has nowhere to go;
  // it is named rather than sent to some shared host where everybody could read it.
  // Unknown values are not sent: a gap in Zabbix is the truth, a zero would be a
  // measurement nobody took.
  const at = Math.floor(started / 1000);
  const values = [];
  const homeless = [];
  for (const p of plan) {
    if (!p.zabbixHost) { homeless.push(p.name); continue; }
    values.push({ host: p.zabbixHost, key: 'elasticpro.plan.epoch', value: at, clock: at });
    values.push({ host: p.zabbixHost, key: 'elasticpro.plan.reachable', value: p.reachable ? 1 : 0, clock: at });
    for (const v of p.values) {
      if (v.value === null || v.key === 'name') continue;
      values.push({ host: p.zabbixHost, key: `elasticpro.plan[${v.key}]`, value: v.value, clock: at });
    }
    // Log delay, when it was measured this run: template "ElasticPro log delay".
    for (const d of p.delay) values.push({ host: p.zabbixHost, key: `elasticpro.delay[${d.key}]`, value: d.value, clock: at });
    // Every rule, every run — 0 included — so a trigger resolves the run its condition does.
    for (const rule of ZABBIX_ALERT_RULES) {
      const a = p.alerts[rule];
      values.push({ host: p.zabbixHost, key: `elasticpro.alert[${rule}]`, value: a.level, clock: at });
      values.push({ host: p.zabbixHost, key: `elasticpro.alert.detail[${rule}]`, value: a.detail, clock: at });
    }
  }
  if (homeless.length) {
    problems.push(`no Zabbix host for ${homeless.join(', ')} — its client plan is not sent `
      + '(turn on zabbix.createHosts, or give it a host with the cluster template)');
  }
  if (values.length) {
    try {
      const { send } = await import(path.join(ROOT, 'tools', 'zabbix-sender.mjs'));
      const r = await send(sendTo, values);
      console.error(`elasticpro-scrape: sent to Zabbix ${sendTo} — processed ${r.processed ?? '?'}, `
        + `failed ${r.failed ?? '?'} of ${r.total ?? values.length}`
        + (r.failed ? ' (a failed value is an item the host does not have: link the "ElasticPro client plan" template)' : ''));
    } catch (e) {
      console.error(`elasticpro-scrape: could not send to Zabbix at ${sendTo}: ${e.message || e}`);
    }
  }
}

for (const p of problems) console.error(`elasticpro-scrape: ${p}`);
