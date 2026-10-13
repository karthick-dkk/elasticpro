/**
 * The cluster's task list, as the Tasks panel shows it — pure.
 *
 * `GET _tasks?actions=*search*&detailed` answers a tree of nodes → tasks. Each task carries
 * the headers its request arrived with; ours carry `X-Opaque-Id: elasticpro/<install>/
 * <origin>/<cluster>/<n>` (see `opaque_id` in the core), which is how a query of ours is
 * told from a stranger's — a Kibana report, somebody's curl. Cancelling is a write
 * (`POST _tasks/<id>/_cancel`), under both gates; this module only names the path.
 */
export const TASKS_PATH = '/_tasks?actions=*search*&detailed&group_by=none';
export const OUR_PREFIX = 'elasticpro/';

/** A task's opaque id, whichever header case the cluster kept. */
export function opaqueIdOf(task) {
  const h = (task && task.headers) || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === 'x-opaque-id');
  const v = k ? h[k] : null;
  return Array.isArray(v) ? v[0] || '' : (v || '');
}

/** `elasticpro/<install>/<origin>/<cluster>/<n>` → its parts, or null for anything else. */
export function parseOpaqueId(id) {
  if (!id || !id.startsWith(OUR_PREFIX)) return null;
  const [, install, origin, cluster, n] = id.split('/');
  return { install: install || '', origin: origin || '', cluster: cluster || '', n: Number(n) || 0 };
}

/**
 * Rows for the panel, longest-running first. `group_by=none` answers `{tasks: [..]}`; the
 * default shape is `{nodes: {id: {tasks: {id: task}}}}` — both are read.
 */
export function taskRows(res, { nowMs = Date.now() } = {}) {
  const list = [];
  if (res && Array.isArray(res.tasks)) list.push(...res.tasks);
  for (const node of Object.values((res && res.nodes) || {})) {
    for (const [id, t] of Object.entries(node.tasks || {})) list.push({ ...t, node_name: node.name, task_id: id });
  }
  return list.map((t) => {
    const id = t.task_id || (t.node != null && t.id != null ? `${t.node}:${t.id}` : String(t.id || ''));
    const opaque = opaqueIdOf(t);
    const ours = parseOpaqueId(opaque);
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
