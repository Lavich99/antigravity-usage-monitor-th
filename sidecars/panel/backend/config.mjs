/**
 * @fileoverview JSON 
 *
 * 
 * 1. (`PLUGIN_ROOT`) (`HERE`) (`DATA_DIR`) 
 * 2. Language Server RPC (`LS_ADDR` / `LS_BASE_URL` / `CSRF_TOKEN`) GitHub 
 * 3. JSON (`loadJson` / `saveJson`) (`loadSettings`) 
 * 4. ES Module VM 
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferCompactionStepModels, normalizeCachedStep } from '../speed-metrics.mjs';
import { writeTrajectoryCacheFile } from './trajectory-cache-file.mjs';
import {
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_SETTINGS_SCHEMA,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  FONT_SCALE_KEYS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  MODEL_DISPLAY_MODES,
  ORCHESTRATOR_ID_MODES,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  PLUGIN_UPDATE_MODES,
  POPOVER_WIDTH_MODES,
  QUOTA_DISPLAY_MODES,
  STEP_TABLE_COLUMN_KEYS,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  WINDOW_MOUNT_MODES,
  createDefaultSettingsObject,
  normalizeFontScale,
  normalizeFullSettings,
  normalizeHoverModules,
  normalizeLanguageSetting,
  normalizeCustomModelPricing,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeQuotaDisplayMode,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
} from './settings-schema.mjs';

export {
  DEFAULT_HOVER_MODULES,
  DEFAULT_OVERVIEW_METRICS,
  DEFAULT_OVERVIEW_MODULES,
  DEFAULT_POPOVER_WIDTH,
  DEFAULT_SETTINGS_SCHEMA,
  DEFAULT_STEP_TABLE_COLUMNS,
  DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  DEFAULT_TOPBAR_SLOTS,
  FONT_SCALE_KEYS,
  MAX_POPOVER_WIDTH,
  MAX_TOPBAR_SLOTS,
  MIN_POPOVER_WIDTH,
  MIN_TOPBAR_SLOTS,
  MODEL_DISPLAY_MODES,
  ORCHESTRATOR_ID_MODES,
  OVERVIEW_METRIC_KEYS,
  OVERVIEW_MODULE_KEYS,
  PLUGIN_UPDATE_MODES,
  POPOVER_WIDTH_MODES,
  QUOTA_DISPLAY_MODES,
  STEP_TABLE_COLUMN_KEYS,
  SUPPORTED_LANGUAGES,
  THEME_ACCENT_KEYS,
  TOPBAR_SLOT_KEYS,
  WINDOW_MOUNT_MODES,
  createDefaultSettingsObject,
  normalizeFontScale,
  normalizeFullSettings,
  normalizeHoverModules,
  normalizeLanguageSetting,
  normalizeCustomModelPricing,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdMode,
  normalizeOverviewMetrics,
  normalizeOverviewModules,
  normalizePluginUpdateMode,
  normalizePopoverWidth,
  normalizePopoverWidthMode,
  normalizeQuotaDisplayMode,
  normalizeStandalonePort,
  normalizeStepTableColumns,
  normalizeStepTokenComboFormat,
  normalizeThemeAccent,
  normalizeTopbarCapsuleSlots,
  normalizeWeeklyLimitMode,
  normalizeWindowMountMode,
  parseStepTokenComboSegments,
} from './settings-schema.mjs';

/**
 * `sidecars/panel` 
 * - Node ESM `sidecars/panel/backend/config.mjs` `sidecars/panel` 
 * - `backend-harness.mjs` `fileURLToPath` `.../sidecars/panel/main.mjs` `sidecars/panel` 
 */
const rawModuleDir = dirname(fileURLToPath(import.meta.url));
export const HERE = /[\\/]backend$/i.test(rawModuleDir) ? dirname(rawModuleDir) : rawModuleDir;
export const PLUGIN_ROOT = dirname(dirname(HERE));
export const PLUGIN_MANIFEST_FILE = join(PLUGIN_ROOT, 'plugin.json');
export const LOCAL_CATALOG_FILE = join(PLUGIN_ROOT, 'pricing-catalog.json');

function resolveGeminiBaseDir() {
  const envGemini = String(process.env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  return envGemini || join(homedir(), '.gemini');
}

function dedupeDirCandidates(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item || '').trim();
    if (!clean) continue;
    const key = process.platform === 'win32' ? clean.toLowerCase() : clean;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function resolveProductDataRoots() {
  const geminiBase = resolveGeminiBaseDir();
  const explicitAppDir = String(
    process.env.USAGE_MONITOR_APP_DATA_DIR || process.env.ANTIGRAVITY_APP_DATA_DIR || ''
  ).trim();
  const customRoot = explicitAppDir
    ? /[\\/]|^[a-zA-Z]:/.test(explicitAppDir)
      ? explicitAppDir
      : join(geminiBase, explicitAppDir)
    : '';
  return dedupeDirCandidates([
    customRoot,
    join(geminiBase, 'antigravity'),
    join(geminiBase, 'antigravity-cli'),
    join(geminiBase, 'antigravity-ide'),
    join(geminiBase, 'antigravity-idea'),
  ]);
}

/**
 * Antigravity `~/.gemini/antigravity/sidecar_data/usage-monitor/panel/data` 
 * Antigravity IDE `agy` CLI `~/.gemini/antigravity-cli` 
 * CLI `~/.gemini/antigravity-cli/sidecar_data/usage-monitor/panel/data` 
 * 
 */
function resolveDefaultDataDir() {
  const explicitDataDir = String(process.env.USAGE_MONITOR_DATA_DIR || '').trim();
  if (explicitDataDir) {
    return explicitDataDir;
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  if (String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid') {
    return join(HERE, '.data');
  }
  const geminiBase = resolveGeminiBaseDir();
  const antigravityRoot = join(geminiBase, 'antigravity');
  const cliRoot = join(geminiBase, 'antigravity-cli');
  const panelDataDir = join(antigravityRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  const legacyDataDir = join(antigravityRoot, 'sidecar_data', 'usage-monitor', 'data');
  const cliPanelDataDir = join(cliRoot, 'sidecar_data', 'usage-monitor', 'panel', 'data');
  if (existsSync(panelDataDir)) return panelDataDir;
  if (existsSync(legacyDataDir)) return legacyDataDir;
  if (existsSync(cliPanelDataDir)) return cliPanelDataDir;
  if (existsSync(antigravityRoot)) return panelDataDir;
  if (
    process.env.USAGE_MONITOR_PLUGIN_DATA &&
    !process.env.USAGE_MONITOR_PLUGIN_DATA.includes('${')
  ) {
    return process.env.USAGE_MONITOR_PLUGIN_DATA;
  }
  if (existsSync(cliRoot)) return cliPanelDataDir;
  return join(HERE, '.data');
}

export const DATA_DIR = resolveDefaultDataDir();
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const CACHE_FILE = join(DATA_DIR, 'trajectory_usage_cache.json');
export const CLI_STATUS_SNAPSHOT_FILE = join(DATA_DIR, 'cli-status-snapshot.json');

/**
 * Desktop / CLI / IDE 
 */
export const PRODUCT_DATA_ROOTS = resolveProductDataRoots();
export const CONVERSATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'conversations'));
export const BRAIN_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'brain'));
export const ANNOTATION_DIRS = PRODUCT_DATA_ROOTS.map((root) => join(root, 'annotations'));
export const DAEMON_DIRS = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'daemon'),
  ...PRODUCT_DATA_ROOTS.map((root) => join(root, 'daemon')),
]);
export const CONVERSATIONS_DIR = CONVERSATION_DIRS[0];
export const BRAIN_DIR = BRAIN_DIRS[0];
export const DEEP_STATS_CACHE_CANDIDATES = dedupeDirCandidates([
  join(resolveGeminiBaseDir(), 'antigravity-ide', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-cli', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity', 'brain', '.deep_stats_cache.json'),
  join(resolveGeminiBaseDir(), 'antigravity-idea', 'brain', '.deep_stats_cache.json'),
  ...BRAIN_DIRS.map((dir) => join(dir, '.deep_stats_cache.json')),
]);

/**
 * Antigravity Language Server Connect RPC Token / 
 */
const rawLsAddr = String(process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
const LS_PROTOCOL = /^https:\/\//i.test(rawLsAddr) ? 'https' : 'http';
export const LS_ADDR = rawLsAddr.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
export const LS_BASE_URL = LS_ADDR ? `${LS_PROTOCOL}://${LS_ADDR}` : '';
export const CSRF_TOKEN =
  process.env.ANTIGRAVITY_CSRF_TOKEN || process.env.ANTIGRAVITY_SERVER_CSRF_TOKEN;

export const lsRuntimeEndpoint = {
  addr: LS_ADDR,
  baseUrl: LS_BASE_URL,
  csrfToken: CSRF_TOKEN || '',
  isDynamic: false,
};

/**
 * Language Server / Hub RPC CSRF 
 *
 * @param {string} nextAddr
 * @param {string} nextCsrfToken
 * @param {{ isDynamic?: boolean }} [opts]
 */
export function setLsRuntimeEndpoint(nextAddr, nextCsrfToken, { isDynamic = true } = {}) {
  const raw = String(nextAddr || '').trim();
  const proto = /^https:\/\//i.test(raw) ? 'https' : 'http';
  const cleanAddr = raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  lsRuntimeEndpoint.addr = cleanAddr;
  lsRuntimeEndpoint.baseUrl = cleanAddr ? `${proto}://${cleanAddr}` : '';
  lsRuntimeEndpoint.csrfToken = String(nextCsrfToken || '').trim();
  lsRuntimeEndpoint.isDynamic = Boolean(cleanAddr && isDynamic);
}

/** Schema */
export const CACHE_SCHEMA_VERSION = 'v10-model-identity';

/**
 * Plain Object 
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * JSON `fallback` 
 *
 * @param {string} filePath 
 * @param {*} fallback 
 * @returns {*}
 */
export function loadJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * JSON `DATA_DIR` 
 *
 * @param {string} filePath 
 * @param {*} data 
 * @returns {boolean} 
 */
export function saveJson(filePath, data) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    if (filePath === CACHE_FILE) {
      writeTrajectoryCacheFile(filePath, data);
    } else {
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    }
    return true;
  } catch (err) {
    console.error(`Failed writing ${filePath}: ${err.message}`);
    return false;
  }
}

/**
 * Schema 
 */
export function loadSettings() {
  return normalizeFullSettings(loadJson(SETTINGS_FILE, {}));
}

/**
 * 1 `null` 
 *
 * @param {number} value
 * @returns {number|null}
 */
export function roundMetric(value) {
  return Number.isFinite(value) ? +value.toFixed(1) : null;
}

/**
 * 
 *
 * @returns {string}
 */
export function computeRuntimeCodeVersion() {
  let maxMtime = 0;
  const candidates = [
    join(HERE, 'app.js'),
    join(HERE, 'styles.css'),
    join(HERE, 'main.mjs'),
    join(HERE, 'standalone.mjs'),
    join(HERE, 'bridge-daemon.mjs'),
    join(HERE, 'mcp-entry.mjs'),
    join(HERE, 'cli-statusline.mjs'),
    join(HERE, 'speed-metrics.mjs'),
    LOCAL_CATALOG_FILE,
  ];
  const backendDir = join(HERE, 'backend');
  try {
    if (existsSync(backendDir)) {
      for (const name of readdirSync(backendDir)) {
        if (name.endsWith('.mjs') || name.endsWith('.js')) {
          candidates.push(join(backendDir, name));
        }
      }
    }
  } catch {
    
  }
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const mtime = Math.floor(statSync(file).mtimeMs || 0);
        if (mtime > maxMtime) maxMtime = mtime;
      }
    } catch {
      // stat
    }
  }
  return String(maxMtime || Date.now());
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

const loadedTrajectoryCache = loadJson(CACHE_FILE, {});
let initialCacheMigrated =
  loadedTrajectoryCache !== null &&
  loadedTrajectoryCache !== undefined &&
  !isPlainObject(loadedTrajectoryCache);

const safeCacheEntries = [];
if (isPlainObject(loadedTrajectoryCache)) {
  for (const [id, entry] of Object.entries(loadedTrajectoryCache)) {
    if (!id || !isPlainObject(entry)) {
      initialCacheMigrated = true;
      continue;
    }
    const rawSteps = Array.isArray(entry.steps) ? entry.steps : [];
    if (!Array.isArray(entry.steps)) {
      initialCacheMigrated = true;
    }
    const objectSteps = rawSteps.filter((s) => isPlainObject(s));
    if (objectSteps.length !== rawSteps.length) {
      initialCacheMigrated = true;
    }
    const normalizedSteps = objectSteps.map((s) => {
      const norm = normalizeCachedStep(s);
      if (norm !== s) initialCacheMigrated = true;
      return norm;
    });
    const finalSteps = inferCompactionStepModels(normalizedSteps);
    for (let i = 0; i < finalSteps.length; i++) {
      if (finalSteps[i] !== normalizedSteps[i]) {
        initialCacheMigrated = true;
        break;
      }
    }
    safeCacheEntries.push([
      id,
      {
        ...entry,
        steps: finalSteps,
      },
    ]);
  }
}

/**
 * `cascadeId -> { signature, accountName, title, lastModifiedMs, diskMtimeMs, wasRunning, steps }`
 */
export const trajectoryCache = Object.fromEntries(safeCacheEntries);

/**
 * Memo 
 */
export const cacheState = {
  needsSave: initialCacheMigrated,
};

export const externalDeepStatsMemo = {
  sig: '',
  convos: new Map(),
};

export const localSummaryMemo = {
  sig: '',
  byId: new Map(),
};

/** */
export const inFlightRequests = new Map();

/** 10 */
export const quotaSummaryCache = {
  ts: 0,
  lastAttemptTs: 0,
  accountName: '',
  accountGeneration: 0,
  data: null,
  error: null,
};

/** */
export const cloudSyncState = {
  catalogVersion: 'builtin',
  updatedAt: null,
  fetchedAtMs: 0,
  lastAttemptMs: 0,
  source: 'local',
  sourceUrl: '',
  latestPluginVersion: null,
  releaseUrl: '',
  downloadUrl: '',
  archiveFallbackUrl: '',
  isSyncing: false,
  lastError: null,
  inFlight: null,
};

/** */
export const pluginUpdateState = {
  isUpdating: false,
  inFlightIsAuto: false,
  lastAutoAttemptVersion: '',
  lastResult: null,
  lastError: null,
  inFlight: null,
};

/**
 * Memo 
 *
 * @returns {boolean} 
 */
export function clearRuntimeCaches() {
  for (const key of Object.keys(trajectoryCache)) {
    delete trajectoryCache[key];
  }
  cacheState.needsSave = false;
  externalDeepStatsMemo.sig = '';
  externalDeepStatsMemo.convos.clear();
  localSummaryMemo.sig = '';
  localSummaryMemo.byId.clear();
  quotaSummaryCache.ts = 0;
  quotaSummaryCache.lastAttemptTs = 0;
  quotaSummaryCache.accountName = '';
  quotaSummaryCache.accountGeneration += 1;
  quotaSummaryCache.data = null;
  quotaSummaryCache.error = null;
  return saveJson(CACHE_FILE, {});
}
