/**
 * The green dot on the page menu's Snapshots entry: a snapshot is running on the chosen
 * cluster (or on any cluster, under "All"). Plain rules over the core's SNAPSHOT_RUNNING
 * answer (docs/HANDBOOK.md "Snapshot running — the message contract"); no DOM, no transport.
 *
 * The shell sends `bridge({ type: 'SNAPSHOT_RUNNING' })` and hands the answer here with the
 * picker's selection. Never a fetch: the core answers from the fleet cache's `snapshot_status`
 * dataset, which the request policy decides whether to poll — so under Client basis the
 * reading is fresh only while the Snapshots page is open (and for the watch window after),
 * and on other pages the answer is `unknown`, which draws no dot. Unknown is not "none".
 */

/**
 * One definition of what the answer says about `selected` ('all', one cluster id, or a list):
 *   state   'running' — at least one running snapshot on a selected cluster that is known;
 *           'none'    — every selected cluster is known and none runs one;
 *           'unknown' — no running one is known, and at least one selected cluster is not known
 *                       (not fetched yet, stale, the last fetch failed); `unknown` lists them.
 *   running [{cluster, repository, snapshot, state, started, elapsedMs}] on the selected clusters
 *   unknown [cluster ids] among the selected ones, with `why` per id
 */
export function snapshotRunning(reply, selected) {
  if (!reply || reply.ok !== true || !reply.clusters || typeof reply.clusters !== 'object') {
    return { state: 'unknown', running: [], unknown: [], why: {}, offered: false };
  }
  const all = Object.keys(reply.clusters);
  const ids = selected === 'all' || selected == null ? all
    : (Array.isArray(selected) ? selected : [selected]).filter((id) => all.includes(id));
  const running = (Array.isArray(reply.running) ? reply.running : []).filter((s) => ids.includes(s.cluster));
  const unknown = ids.filter((id) => !(reply.clusters[id] && reply.clusters[id].known === true));
  const why = Object.fromEntries(unknown.map((id) => [id, (reply.clusters[id] && reply.clusters[id].why) || 'not known']));
  const state = running.length ? 'running' : ids.length && !unknown.length ? 'none' : 'unknown';
  return { state, running, unknown, why, offered: true };
}

/** "backups/daily-2026.11.05 on client-a (since 14:02)". `names` maps cluster id → shown name. */
function line(s, names, now) {
  const where = (names && names[s.cluster]) || s.cluster;
  const since = s.started ? ` (since ${new Date(s.started).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })})` : '';
  const long = s.started && now - s.started > 6 * 3600 * 1000 ? ' — running for over 6 h' : '';
  return `${s.repository}/${s.snapshot} on ${where}${since}${long}`;
}

/**
 * The dot itself: `{tone: 'green', count, title}` while something runs on the selection, else
 * null — a state the core does not know draws nothing rather than a guess.
 */
export function snapshotDot(reply, selected, { names = {}, now = Date.now() } = {}) {
  const r = snapshotRunning(reply, selected);
  if (r.state !== 'running') return null;
  const n = r.running.length;
  const head = n === 1 ? 'A snapshot is running' : `${n} snapshots are running`;
  const shown = r.running.slice(0, 4).map((s) => line(s, names, now));
  const more = n > 4 ? ` (+${n - 4} more)` : '';
  return { tone: 'green', count: n, title: `${head}: ${shown.join('; ')}${more}` };
}

/**
 * The sentence for a tooltip or the Snapshots page header when there is no dot: what is known
 * and what is not, and — under a policy that fetches nothing unasked — why. `null` when the
 * core did not offer the reading at all (an older core).
 */
export function snapshotNote(reply, selected) {
  const r = snapshotRunning(reply, selected);
  if (!r.offered) return null;
  if (r.state === 'running') return `${r.running.length} running`;
  if (r.state === 'none') return 'No snapshot is running.';
  const first = r.unknown[0];
  const reason = first ? r.why[first] : 'not known';
  const where = r.unknown.length === 1 ? `on ${first}` : `on ${r.unknown.length} clusters`;
  const policy = reply.effectiveClass === 'onDemand'
    ? ' Under this request policy it is read only while the Snapshots page is open.' : '';
  return `Whether a snapshot is running is not known ${where} (${reason}).${policy}`;
}
