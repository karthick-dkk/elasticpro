/**
 * What the server's config.txt manages.
 *
 * A key with a value in config.txt wins over the Config page, so the UI must (a) apply it
 * last wherever it computes the effective defaults and (b) show it read-only with the
 * reason. The core says which in its PING reply (`managedDefaults`, `managedZabbixOptions`);
 * every PING goes through `es.js` `workerStatus`, which hands the reply to `setManaged`, so
 * this is the one place the set is held and every consumer reads it from here.
 *
 * Names are the UI's own (`DEFAULTS` in config.js), not config.txt's.
 */

/** The reason shown beside a locked field. */
export const MANAGED_NOTE = 'managed by config.txt';

let defaults = {};
let zabbixOptions = {};

/**
 * Take the managed set from a PING reply. A reply without it (signed out, an older core, a
 * failed call) leaves what is held alone: it says nothing about config.txt, and clearing on
 * it would unlock fields the server still manages.
 */
export function setManaged(ping) {
  if (!ping || ping.ok !== true || typeof ping.managedDefaults !== 'object' || !ping.managedDefaults) return;
  defaults = { ...ping.managedDefaults };
  zabbixOptions = { ...(ping.managedZabbixOptions || {}) };
}

/** `{ diskWarnPercent: 70, ... }` — only the managed ones. A copy. */
export function managedDefaults() { return { ...defaults }; }

/** `{ createHosts: true, ... }` — only the managed `zabbix:` options. A copy. */
export function managedZabbixOptions() { return { ...zabbixOptions }; }

export function isManagedDefault(key) { return Object.prototype.hasOwnProperty.call(defaults, key); }
export function isManagedZabbixOption(key) { return Object.prototype.hasOwnProperty.call(zabbixOptions, key); }
