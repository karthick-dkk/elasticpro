/**
 * One notice for everything that was let through without checking — and none at all when
 * the operator chose that.
 *
 * `defaults.tls: insecure` (the Config page, or config.txt, which wins) is a deliberate,
 * standing decision by the person running the install. Telling them every minute, or on
 * every page load, what they asked for is noise, and it had piled up as a column of
 * identical toasts. So while the switch is on there is no toast and no bell entry; what
 * was accepted stays listed where it belongs, Config → Jump hosts & trust.
 *
 * Anything accepted *without* that switch (not a state the core produces today, but the
 * list is the core's to fill) is news once: it is announced when the set of certificates
 * and keys is new to this browser, and not again while the set is the same. A rotated
 * certificate or an added cluster is a different set and is announced.
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

/** localStorage key for the last set announced; per browser, a convenience not a record. */
export const SEEN_KEY = 'elasticpro.tlsAcceptedSeen';

/** The set last announced in this browser ('' when none, or storage is unavailable). */
export function readSeen(storage) {
  try { return String(storage.getItem(SEEN_KEY) || ''); } catch (_) { return ''; }
}
export function writeSeen(storage, sig) {
  try { storage.setItem(SEEN_KEY, sig); } catch (_) { /* private window: announced again next load, once */ }
}

/**
 * What, if anything, to tell the person this pass.
 *
 * @param o.deliberate  the operator turned insecure on (core PINS acceptAll, or defaults.tls)
 * @param o.accepted    the core's list
 * @param o.seenSig     acceptedSignature of what was last announced
 * @returns null (say nothing, bell untouched) or { message, detail, sig }
 */
export function noticeToShow({ deliberate = false, accepted = [], seenSig = '' } = {}) {
  if (deliberate) return null;
  const notice = acceptedNotice(accepted);
  if (!notice) return null;
  if (!newSince(seenSig, accepted).length) return null;
  return { ...notice, sig: acceptedSignature(accepted) };
}
