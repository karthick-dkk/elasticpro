/**
 * The cluster's task list, as the Tasks panel shows it — pure.
 *
 * `GET _tasks?…&detailed` answers a tree of nodes → tasks. Each task carries the headers
 * its request arrived with; ours carry `X-Opaque-Id: elasticpro/<install>/<origin>/
 * <cluster>/<n>` (see `opaque_id` in the core), which is how a query of ours is told from
 * a stranger's — a Kibana report, somebody's curl. Cancelling is a write
 * (`POST _tasks/<id>/_cancel`), under both gates; this module only names the path.
 *
 * Which listing to read and what our ids start with are the core's (tasks.rs), sent with
 * every REQUEST_LOG reply as `tasks: {path, prefix, instance, previousInstance}` — one
 * definition, which the core's own task reaper reads too. `contractOf` takes them from it.
 */

/** `{path, prefix, instance, previous}` from a REQUEST_LOG reply, or null from a core that does not say. */
export function contractOf(log) {
  const t = log && log.tasks;
  if (!t || typeof t.path !== 'string' || typeof t.prefix !== 'string' || !t.prefix) return null;
  return { path: t.path, prefix: t.prefix, instance: t.instance || '', previous: t.previousInstance || '' };
}

/** A task's opaque id, whichever header case the cluster kept. */
export function opaqueIdOf(task) {
  const h = (task && task.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === 'x-opaque-id');
  const v = k ? h[k] : null;
  return Array.isArray(v) ? v[0] || '' : (v || '');
}

/** `<prefix><install>/<origin>/<cluster>/<n>` → its parts, or null for anything else. */
export function parseOpaqueId(id, prefix) {
  if (!id || !prefix || !id.startsWith(prefix)) return null;
  const [install, origin, cluster, n] = id.slice(prefix.length).split('/');
  return { install: install || '', origin: origin || '', cluster: cluster || '', n: Number(n) || 0 };
}

/**
 * Rows for the panel, longest-running first. `group_by=none` answers `{tasks: [..]}`; the
 * default shape is `{nodes: {id: {tasks: {id: task}}}}` — both are read.
 */
export function taskRows(res, { nowMs = Date.now(), contract = null } = {}) {
  const prefix = contract ? contract.prefix : '';
  const list = [];
  if (res && Array.isArray(res.tasks)) list.push(...res.tasks);
  for (const node of Object.values((res && res.nodes) || {})) {
    for (const [id, t] of Object.entries(node.tasks || {})) list.push({ ...t, node_name: node.name, task_id: id });
  }
  return list.map((t) => {
    const id = t.task_id || (t.node != null && t.id != null ? `${t.node}:${t.id}` : String(t.id || ''));
    const opaque = opaqueIdOf(t);
    const ours = parseOpaqueId(opaque, prefix);
    const runningMs = typeof t.running_time_in_nanos === 'number' ? Math.round(t.running_time_in_nanos / 1e6)
      : (typeof t.start_time_in_millis === 'number' ? Math.max(0, nowMs - t.start_time_in_millis) : null);
    return {
      id,
      node: t.node_name || t.node || '',
      action: t.action || '',
      description: t.description || '',
      runningMs,
      opaqueId: opaque,
      ours: !!ours,
      origin: ours ? ours.origin : '',
      // This run's, the run before's (left running across a restart), or another install's.
      run: !ours ? '' : ours.install === (contract && contract.instance) ? 'this'
        : ours.install === (contract && contract.previous) ? 'previous' : 'other',
      cancellable: t.cancellable !== false,
      cancelled: t.cancelled === true,
    };
  }).sort((a, b) => (b.runningMs || 0) - (a.runningMs || 0));
}

export function cancelPath(taskId) {
  return `/_tasks/${encodeURIComponent(taskId)}/_cancel`;
}

/** What a 403 on the task list or a cancel means, in the privilege's name. */
export function privilegeHint(status, what) {
  if (status !== 403) return '';
  return what === 'cancel'
    ? 'This credential lacks the cluster privilege "manage", which _cancel needs. The task keeps running.'
    : 'This credential lacks the cluster privilege "monitor", which _tasks needs.';
}
