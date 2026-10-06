/**
 * Putting a freshly-read config into service.
 *
 * Reading the file is the easy half. What makes a config *usable* is everything that
 * happens afterwards: opening the encrypted secrets, finding a credential the operator
 * chose to remember, and reconnecting. Boot did all of that; "Reload from disk" did not,
 * so reloading a config whose secrets are sealed silently dropped every credential.
 *
 * One path, used by boot, Reload from disk, Pick another file, and the focus watcher.
 */

import { state, setConfig, refreshAll, clustersNeedingCredential } from '../core/state.js';
import { unlockSealed } from './config-editor.js';
import { showCredentialDialog, tryVaultCredential } from './credential-dialog.js';
import { isSnapshotMode } from '../core/snapshot.js';

/**
 * @param next    the config just read from disk
 * @param handle  the path to remember, or null for load-once
 * @param opts.prompt  ask for a credential when one is still missing (default true)
 * @param opts.refresh reconnect and refetch afterwards (default true)
 */
export async function applyLoadedConfig(next, handle, { prompt = true, refresh = true } = {}) {
  await setConfig(next, handle);

  // A sealed config re-read from disk arrives locked again. The master password is
  // cached for the session, so this normally reopens it without asking.
  if (state.config && state.config.sealed) await unlockSealed({ quiet: !prompt });

  if (prompt && !isSnapshotMode() && clustersNeedingCredential().length) {
    const fromVault = await tryVaultCredential();
    if (!fromVault && clustersNeedingCredential().length) showCredentialDialog('startup');
  }

  if (refresh) await refreshAll({ force: true });
  return state.config;
}
