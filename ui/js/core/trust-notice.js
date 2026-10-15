/**
 * One notice for everything `defaults.tls: insecure` let through.
 *
 * With the switch on, the core accepts any certificate and any jump-host key, and lists
 * what it accepted that would otherwise have stopped (PINS → `accepted`). Ten clusters on
 * self-signed certificates are one fact, not ten notifications: this folds the list into a
 * single bell entry, keyed, so it is updated in place rather than repeated, and it pops
 * up again only when something new joins the list.
 */

export const NOTICE_KEY = 'tls-accepted';

/** What identifies the list: a new certificate or key changes it, a re-read does not. */
export function acceptedSignature(accepted) {
  return (accepted || []).map((a) => `${a.kind}|${a.target}|${a.fingerprint}`).sort().join('\n');
}

/** Entries in `now` that `before` (a signature) did not have. */
export function newSince(beforeSig, accepted) {
  const seen = new Set(String(beforeSig || '').split('\n').filter(Boolean));
  return (accepted || []).filter((a) => !seen.has(`${a.kind}|${a.target}|${a.fingerprint}`));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param accepted [{ kind: 'certificate'|'host_key', target, fingerprint, subject, reason, clusters: [{id,name}] }]
 * @returns null when there is nothing to say, else { message, detail: [lines] }
 */
export function acceptedNotice(accepted) {
  const list = accepted || [];
  if (!list.length) return null;
  const certs = list.filter((a) => a.kind === 'certificate');
  const keys = list.filter((a) => a.kind === 'host_key');
  const clusterNames = new Set(certs.flatMap((a) => (a.clusters || []).map((c) => c.name)));
  const parts = [];
  if (certs.length) {
    parts.push(clusterNames.size
      ? `${plural(certs.length, 'certificate')} on ${plural(clusterNames.size, 'cluster')}`
      : plural(certs.length, 'certificate'));
  }
  if (keys.length) parts.push(plural(keys.length, 'jump-host key'));
  const message = `Accepted without checking: ${parts.join(' and ')} — Config → Defaults → Certificates is set to insecure`;
  const detail = list.map((a) => {
    const who = (a.clusters || []).map((c) => c.name).join(', ');
    const what = a.kind === 'host_key' ? `SSH key of jump host ${a.target}` : `certificate of ${a.target}${a.subject ? ` (${a.subject})` : ''}`;
    return `${what}${who ? ` — ${who}` : ''}: ${a.reason}`;
  });
  return { message, detail };
}
