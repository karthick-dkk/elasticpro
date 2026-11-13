/**
 * Zabbix hosts held for review: the words and the side-by-side the review dialog and the
 * Zabbix tab show. No DOM, no network.
 *
 * A host is held when it is at the address of a cluster that exists already — a config-file
 * cluster, or another Zabbix host in use. "The same address" is the core's to decide
 * (zbx_conflicts.rs url_identity: scheme, host and port, a default port written out, no
 * trailing slash or case); every entry carries it as `identity`, and nothing here compares
 * addresses itself.
 */

/** The three answers, in the order the dialog offers them. */
export const DECISIONS = [
  { id: 'skip', label: 'Skip', help: 'The Zabbix host stays out. The existing cluster stays exactly as it is.' },
  { id: 'update', label: 'Update', help: 'The Zabbix host takes the existing cluster over.' },
  { id: 'keepBoth', label: 'Keep both', help: 'Both are clusters, each with its own id. They are the same Elasticsearch, so it is polled twice.' },
];

/** What Update does to this entry's existing cluster, in words. */
export function updateMeans(entry) {
  return entry && entry.existing && entry.existing.kind === 'zabbix'
    ? 'The Zabbix host takes the existing cluster over: the Zabbix host in use now is no longer built (Zabbix is not changed).'
    : 'The Zabbix host takes the existing cluster over: the config-file cluster is set aside, kept in the file but no longer used (the file is not changed).';
}

/** The rows compared side by side: [key, label]. */
export const FIELDS = [
  ['name', 'Name'], ['url', 'Address'], ['via', 'Route'], ['tags', 'Tags'],
  ['username', 'User'], ['tls', 'Certificates'], ['enabled', 'Polled'],
  // The address macros as Zabbix holds them, before they were made into the address above.
  ['macros', 'Zabbix macros'],
];

/** A value as a person reads it. Not set is a dash, never a guess. */
export function show(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (typeof v === 'object') return String(v.name || v.id || JSON.stringify(v));
  return String(v);
}

/** The existing cluster and the Zabbix host, field by field, and which fields differ. */
export function sideBySide(entry) {
  const old = (entry && entry.existing && entry.existing.values) || {};
  const nu = (entry && entry.zabbix) || {};
  return FIELDS.map(([key, label]) => {
    const a = show(old[key]);
    const b = show(nu[key]);
    return { key, label, old: a, new: b, differs: a !== b };
  });
}

/** The fields Zabbix changed since the decision was made (state `changed`). */
export function changedSinceDecided(entry) {
  const was = (entry && entry.decidedValues) || {};
  const now = (entry && entry.zabbix) || {};
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])];
  return keys.filter((k) => show(was[k]) !== show(now[k])).sort();
}

export function decisionLabel(d) {
  const x = DECISIONS.find((o) => o.id === d);
  return x ? x.label : '—';
}

/** The existing side, named. */
export function existingLabel(entry) {
  const e = (entry && entry.existing) || {};
  const name = (e.values && e.values.name) || e.id || '';
  return e.kind === 'zabbix' ? `Zabbix host ${name}` : `config-file cluster ${name}`;
}

/** `pending`, `changed` (decided, then Zabbix moved: asked again), `decided`. */
export function stateLabel(entry) {
  switch (entry && entry.state) {
    case 'pending': return 'Waiting for review';
    case 'changed': return `${decisionLabel(entry.decision)} — Zabbix changed since, review again`;
    case 'decided': return decisionLabel(entry.decision);
    default: return '—';
  }
}

export const needsReview = (list) => (list || []).filter((e) => e && e.state !== 'decided').length;

/** The preview's counts, and one line saying them. */
export function previewSummary(p) {
  const n = (k) => (p && Array.isArray(p[k]) ? p[k].length : 0);
  const counts = { add: n('add'), change: n('change'), remove: n('remove'), hold: n('hold'), create: n('wouldCreate') };
  const parts = [`${counts.add} to add`, `${counts.change} to change`, `${counts.remove} to remove`, `${counts.hold} held for review`];
  if (counts.create) parts.push(`${counts.create} Zabbix host${counts.create === 1 ? '' : 's'} to create`);
  const unchanged = p && Number.isFinite(p.unchanged) ? p.unchanged : 0;
  return { ...counts, unchanged, line: `${parts.join(' · ')} · ${unchanged} unchanged` };
}
