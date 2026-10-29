/**
 * Bridge calls for the Volume fields settings (docs/VOLUME.md "Messages").
 *
 * A module of its own so the Config page does not wait on es.js. Hosted, the core reads
 * `defaults.volume` from its own config file and the message needs nothing more. Without a
 * config file (desktop) the core knows only what the UI sends, so each call carries
 * `volume: {defaults, cluster}`; `withVolume` is the one place that decides which.
 */

import { bridge } from './transport.js';
import { isUnknownType } from './volume-config.js';

let hasFile = null;   // Promise<boolean>: does the core read a config file of its own?

/** PING `configHint` is the hosted core's own config path; desktop has none. Asked once. */
export function coreHasConfigFile() {
  if (!hasFile) {
    hasFile = bridge({ type: 'PING' })
      .then((p) => !!(p && p.configHint))
      .catch(() => { hasFile = null; return false; });
  }
  return hasFile;
}

/** Forget what PING said (the tests, and a changed server). */
export function forgetCoreFile() { hasFile = null; }

/**
 * The message with the desktop `volume` payload added when the core has no file of its own.
 * `defaults` is `raw.defaults.volume`, `cluster` that cluster's override, both as saved.
 */
export async function withVolume(msg, defaults, cluster) {
  if (await coreHasConfigFile()) return msg;
  return { ...msg, volume: { defaults: defaults || {}, cluster: cluster || {} } };
}

/** Never throws: `{ok:false, unknown:true}` for an older core, `{ok:false, message}` otherwise. */
async function send(msg) {
  let res;
  try { res = await bridge(msg); } catch (e) { return { ok: false, message: e.message || String(e) }; }
  if (isUnknownType(res)) return { ok: false, unknown: true, message: 'This server does not know Volume fields yet (needs 0.3.45)' };
  return res || { ok: false, message: 'the core did not answer' };
}

/** `{settings, managed:[names], source, overrides:[ids]}` for the page. */
export async function volumeSettings(clusterId, defaults, cluster) {
  return send(await withVolume({ type: 'VOLUME_SETTINGS', ...(clusterId ? { clusterId } : {}) }, defaults, cluster));
}

/** `{indices:{match, skipped}, rows:[{key, tried, resolved, type, note}]}` for one cluster. */
export async function volumeFieldsCheck(clusterId, defaults, cluster) {
  return send(await withVolume({ type: 'VOLUME_FIELDS_CHECK', clusterId }, defaults, cluster));
}
