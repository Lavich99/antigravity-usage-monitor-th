/**
 * @fileoverview Pure offline pricing catalog reload & sidecar restart scheduler.
 * External GitHub catalog sync and self-update downloaders have been stripped.
 */

import {
  LS_ADDR,
  cloudSyncState,
  lsRuntimeEndpoint,
  pluginUpdateState,
} from './config.mjs';
import {
  getCloudStatus,
  readInstalledPluginVersion,
  rebuildActiveCatalog,
} from './pricing-catalog.mjs';

let customSidecarRestartHandler = null;

export function setSidecarRestartHandler(handler) {
  customSidecarRestartHandler = typeof handler === 'function' ? handler : null;
}

export function scheduleSidecarRestart(delayMs = 350) {
  const activeAddr = lsRuntimeEndpoint.addr || LS_ADDR;
  if (!activeAddr || activeAddr === 'test.invalid') return;
  if (typeof customSidecarRestartHandler === 'function') {
    const fn = customSidecarRestartHandler;
    setTimeout(() => {
      try {
        fn();
      } catch {
        // Ignore custom reload errors
      }
    }, delayMs);
    return;
  }
  if (typeof process?.exit !== 'function') return;
  setTimeout(() => {
    try {
      process.exit(0);
    } catch {
      // Ignore exit errors
    }
  }, delayMs);
}

export async function performPluginUpdate() {
  const previousVersion = readInstalledPluginVersion();
  const result = {
    ok: false,
    skipped: true,
    upToDate: true,
    mode: 'local',
    reason: 'offline_disabled',
    previousVersion,
    currentVersion: previousVersion,
    message: 'Offline mode: network update is disabled',
    updatedAtMs: Date.now(),
  };
  pluginUpdateState.isUpdating = false;
  pluginUpdateState.inFlightIsAuto = false;
  pluginUpdateState.lastError = null;
  pluginUpdateState.lastResult = result;
  return result;
}

export async function syncCloudCatalog() {
  rebuildActiveCatalog();
  cloudSyncState.fetchedAtMs = Date.now();
  cloudSyncState.lastAttemptMs = cloudSyncState.fetchedAtMs;
  cloudSyncState.sourceUrl = '';
  cloudSyncState.isSyncing = false;
  cloudSyncState.lastError = null;
  return getCloudStatus();
}
