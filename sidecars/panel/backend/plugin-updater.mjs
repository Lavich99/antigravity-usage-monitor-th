/**
 * @fileoverview Offline pricing catalog reload + optional Read-Only GitHub Release notifier.
 * Strictly points to Lavich99/antigravity-usage-monitor-th releases/latest (GET only).
 * Never downloads archives, runs git, or modifies installed plugin files.
 */

import {
  LS_ADDR,
  cloudSyncState,
  loadSettings,
  lsRuntimeEndpoint,
  pluginUpdateState,
} from './config.mjs';
import {
  compareSemver,
  getCloudStatus,
  isValidSemver,
  readInstalledPluginVersion,
  rebuildActiveCatalog,
} from './pricing-catalog.mjs';

export const RELEASE_REPO_SLUG = 'Lavich99/antigravity-usage-monitor-th';
export const RELEASE_CHECK_API_URL = `https://api.github.com/repos/${RELEASE_REPO_SLUG}/releases/latest`;
export const RELEASE_PAGE_URL = `https://github.com/${RELEASE_REPO_SLUG}/releases/latest`;
const RELEASE_PAGE_PREFIX = `https://github.com/${RELEASE_REPO_SLUG}/releases/`;
const RELEASE_CHECK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const RELEASE_CHECK_TIMEOUT_MS = 8000;

let customSidecarRestartHandler = null;
let backgroundCheckTimer = null;

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

export function sanitizeReleaseUrl(rawUrl) {
  const s = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (s.startsWith(RELEASE_PAGE_PREFIX)) return s;
  return RELEASE_PAGE_URL;
}

export function clearReleaseUpdateState() {
  const installed = readInstalledPluginVersion();
  cloudSyncState.latestPluginVersion = installed;
  cloudSyncState.releaseUrl = '';
  cloudSyncState.lastError = null;
  cloudSyncState.lastAttemptMs = 0;
  cloudSyncState.isSyncing = false;
  cloudSyncState.inFlight = null;
}

/**
 * Read-Only check against GitHub Releases API for Lavich99/antigravity-usage-monitor-th.
 * Never downloads or modifies any local files.
 *
 * @param {{ force?: boolean, fetchImpl?: typeof fetch }} [options]
 */
export async function checkReleaseUpdateReadOnly({ force = false, fetchImpl = globalThis.fetch } = {}) {
  const now = Date.now();
  if (!force && cloudSyncState.lastAttemptMs > 0 && now - cloudSyncState.lastAttemptMs < RELEASE_CHECK_COOLDOWN_MS) {
    return getCloudStatus();
  }
  if (cloudSyncState.inFlight) {
    return cloudSyncState.inFlight;
  }
  if (typeof fetchImpl !== 'function') {
    cloudSyncState.lastError = 'Fetch API unavailable';
    return getCloudStatus();
  }

  const installedVersion = readInstalledPluginVersion();
  cloudSyncState.isSyncing = true;
  cloudSyncState.lastAttemptMs = now;
  cloudSyncState.lastError = null;

  const task = (async () => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), RELEASE_CHECK_TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(RELEASE_CHECK_API_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `antigravity-usage-monitor-th/${installedVersion}`,
        },
        signal: controller?.signal,
      });

      if (res.status === 404) {
        // Repo has no published release yet — treat as up-to-date without alarming the user.
        cloudSyncState.latestPluginVersion = installedVersion;
        cloudSyncState.releaseUrl = RELEASE_PAGE_URL;
        cloudSyncState.fetchedAtMs = Date.now();
        cloudSyncState.lastError = null;
        return getCloudStatus();
      }

      if (!res.ok) {
        cloudSyncState.lastError = `HTTP ${res.status}`;
        return getCloudStatus();
      }

      const data = await res.json();
      const rawTag = typeof data?.tag_name === 'string' ? data.tag_name.trim() : '';
      if (isValidSemver(rawTag)) {
        cloudSyncState.latestPluginVersion = rawTag.replace(/^v/i, '');
      } else {
        cloudSyncState.latestPluginVersion = installedVersion;
      }
      cloudSyncState.releaseUrl = sanitizeReleaseUrl(data?.html_url);
      cloudSyncState.fetchedAtMs = Date.now();
      cloudSyncState.lastError = null;
      return getCloudStatus();
    } catch (err) {
      cloudSyncState.lastError =
        err?.name === 'AbortError' ? 'Request timed out' : String(err?.message || 'Network check failed');
      return getCloudStatus();
    } finally {
      if (timer) clearTimeout(timer);
      cloudSyncState.isSyncing = false;
      cloudSyncState.inFlight = null;
    }
  })();

  cloudSyncState.inFlight = task;
  return task;
}

export function startBackgroundUpdateNotifier() {
  if (backgroundCheckTimer) return;
  if (lsRuntimeEndpoint.addr === 'test.invalid') return;

  const runIfEnabled = () => {
    try {
      const settings = loadSettings();
      if (settings?.pluginUpdateMode !== 'off') {
        void checkReleaseUpdateReadOnly({ force: false });
      }
    } catch {
      // Ignore background check errors
    }
  };

  const bootTimer = setTimeout(runIfEnabled, 4000);
  bootTimer.unref?.();

  backgroundCheckTimer = setInterval(runIfEnabled, RELEASE_CHECK_COOLDOWN_MS);
  backgroundCheckTimer.unref?.();
}

export async function performPluginUpdate() {
  const status = getCloudStatus();
  const hasNewer = compareSemver(status.latestPluginVersion, status.currentPluginVersion) > 0;
  const releaseUrl = sanitizeReleaseUrl(status.releaseUrl);
  const result = {
    ok: false,
    skipped: true,
    upToDate: !hasNewer,
    mode: 'readonly',
    reason: hasNewer ? 'manual_download_required' : 'up_to_date',
    previousVersion: status.currentPluginVersion,
    currentVersion: status.currentPluginVersion,
    latestVersion: status.latestPluginVersion,
    releaseUrl,
    message: hasNewer
      ? `Read-Only mode: download v${status.latestPluginVersion} manually from GitHub Releases`
      : 'Already up to date (Read-Only mode)',
    updatedAtMs: Date.now(),
  };
  pluginUpdateState.isUpdating = false;
  pluginUpdateState.inFlightIsAuto = false;
  pluginUpdateState.lastError = null;
  pluginUpdateState.lastResult = result;
  return result;
}

export async function syncCloudCatalog({ force = false, checkRelease = false, fetchImpl = globalThis.fetch } = {}) {
  rebuildActiveCatalog();
  const settings = loadSettings();
  const shouldCheckRelease = Boolean(checkRelease) || settings?.pluginUpdateMode !== 'off';
  if (shouldCheckRelease) {
    return checkReleaseUpdateReadOnly({ force, fetchImpl });
  }
  cloudSyncState.fetchedAtMs = Date.now();
  cloudSyncState.sourceUrl = '';
  cloudSyncState.isSyncing = false;
  cloudSyncState.lastError = null;
  return getCloudStatus();
}
