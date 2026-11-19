/**
 * @fileoverview Schema / 
 *
 * 
 * - USD / 1M Tokens `input`: , `cache`: , `output`: 
 * - API 
 * - `pricing-catalog.json` JS 
 * - `null` `null`/`0` 
 * - SemVer 2.0 URL GitHub 
 */

import {
  LOCAL_CATALOG_FILE,
  PLUGIN_MANIFEST_FILE,
  cloudSyncState,
  loadJson,
  pluginUpdateState,
} from './config.mjs';

/**
 * 
 */
export const MODEL_PRICING = {};
export const PLACEHOLDER_MAP = {};
export let pricingCatalogRevision = 0;

/**
 * SemVer 2.0 `-prerelease` `+build` 
 *
 * @param {*} v
 * @returns {boolean}
 */
export function isValidSemver(v) {
  return (
    typeof v === 'string' &&
    /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v.trim())
  );
}

/**
 * SemVer 2.0 §10 `+build` §11.4 ASCII 
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} `1` `a > b` `-1` `a < b` `0` 
 */
export function compareSemver(a, b) {
  if (!isValidSemver(a) || !isValidSemver(b)) return 0;
  const parse = (v) => {
    const cleaned = String(v || '')
      .trim()
      .replace(/^v/i, '')
      .replace(/\+.*$/, '');
    const dashIdx = cleaned.indexOf('-');
    const coreStr = dashIdx >= 0 ? cleaned.slice(0, dashIdx) : cleaned;
    const preStr = dashIdx >= 0 ? cleaned.slice(dashIdx + 1) : '';
    const core = coreStr.split('.').map((n) => {
      const parsed = parseInt(n, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    });
    return { core, pre: preStr };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.core.length, pb.core.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa.core[i] || 0;
    const vb = pb.core[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;

  const idsA = pa.pre.split('.');
  const idsB = pb.pre.split('.');
  const minLen = Math.min(idsA.length, idsB.length);
  for (let i = 0; i < minLen; i++) {
    const idA = idsA[i];
    const idB = idsB[i];
    if (idA === idB) continue;
    const numA = /^\d+$/.test(idA);
    const numB = /^\d+$/.test(idB);
    if (numA && numB) {
      const bigA = BigInt(idA);
      const bigB = BigInt(idB);
      if (bigA !== bigB) return bigA > bigB ? 1 : -1;
      continue;
    }
    // SemVer 2.0 §11.4.1
    if (numA && !numB) return -1;
    if (!numA && numB) return 1;
    // SemVer 2.0 §11.4.2 ASCII
    return idA < idB ? -1 : 1;
  }
  if (idsA.length === idsB.length) return 0;
  return idsA.length > idsB.length ? 1 : -1;
}

/**
 * `plugin.json` 
 *
 * @returns {string}
 */
export function readInstalledPluginVersion() {
  const manifest = loadJson(PLUGIN_MANIFEST_FILE, null);
  const ver = typeof manifest?.version === 'string' ? manifest.version.trim() : '';
  return isValidSemver(ver) ? ver.replace(/^v/i, '') : '1.4.4';
}

function normalizeModelFamily(rawFamily) {
  const f = String(rawFamily || '').trim();
  const lower = f.toLowerCase();
  if (lower === 'gemini' || lower === 'google') return 'Gemini';
  if (lower === 'claude' || lower === 'anthropic') return 'Claude';
  if (lower === 'gpt' || lower === 'openai') return 'GPT';
  if (lower === 'other') return 'Other';
  return f;
}

/**
 * 
 * - `input`/`cache`/`output` `number` `Number(null) === 0` `Number("") === 0` 
 * - `<= 10000` `input > 0` `output > 0` 0 $0.00 
 * - `short`/`family` 
 */
function isValidPricingEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (
    typeof entry.input !== 'number' ||
    typeof entry.cache !== 'number' ||
    typeof entry.output !== 'number'
  ) {
    return false;
  }
  const { input, cache, output } = entry;
  if (!Number.isFinite(input) || input < 0 || input > 10000) return false;
  if (!Number.isFinite(cache) || cache < 0 || cache > 10000) return false;
  if (!Number.isFinite(output) || output < 0 || output > 10000) return false;
  if (input === 0 && output === 0) return false;
  if (typeof entry.short !== 'string' || !entry.short.trim()) return false;
  if (typeof entry.family !== 'string' || !entry.family.trim()) return false;
  return true;
}

/**
 * 
 */
function isValidPlaceholderEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.modelId !== 'string' || !entry.modelId.trim()) return false;
  if (typeof entry.label !== 'string' || !entry.label.trim()) return false;
  return true;
}

/**
 * `pricing-catalog.json` 
 * 
 *
 * @param {object} raw
 * @returns {object|null}
 */
export function sanitizeCatalogPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pricing = {};
  let validPricingCount = 0;
  if (raw.pricing && typeof raw.pricing === 'object') {
    for (const [k, v] of Object.entries(raw.pricing)) {
      const key = String(k || '').trim();
      if (!key || !isValidPricingEntry(v)) continue;
      pricing[key] = {
        input: v.input,
        cache: v.cache,
        output: v.output,
        short: String(v.short).trim(),
        family: normalizeModelFamily(v.family),
      };
      validPricingCount++;
    }
  }

  const placeholders = {};
  let validPlaceholderCount = 0;
  if (raw.placeholders && typeof raw.placeholders === 'object') {
    for (const [k, v] of Object.entries(raw.placeholders)) {
      const key = String(k || '').trim();
      if (!key || !isValidPlaceholderEntry(v)) continue;
      placeholders[key] = {
        modelId: String(v.modelId).trim(),
        label: String(v.label).trim(),
      };
      validPlaceholderCount++;
    }
  }

  const rawLatestVer =
    typeof raw.latestPluginVersion === 'string' ? raw.latestPluginVersion.trim() : '';
  const latestPluginVersion = isValidSemver(rawLatestVer)
    ? rawLatestVer.replace(/^v/i, '')
    : null;
  if (validPricingCount === 0 && validPlaceholderCount === 0 && !latestPluginVersion) {
    return null;
  }

  return {
    schemaVersion: Number(raw.schemaVersion || 1),
    catalogVersion:
      typeof raw.catalogVersion === 'string' && raw.catalogVersion.trim()
        ? raw.catalogVersion.trim()
        : null,
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : null,
    latestPluginVersion,
    releaseUrl: '',
    downloadUrl: '',
    archiveFallbackUrl: '',
    hasReleaseUrl: false,
    hasDownloadUrl: false,
    hasArchiveFallbackUrl: false,
    fetchedAtMs: 0,
    sourceUrl: '',
    pricing,
    placeholders,
  };
}

/**
 * `pricing-catalog.json` 
 */
export function rebuildActiveCatalog() {
  const localRaw = loadJson(LOCAL_CATALOG_FILE, null);
  const localCat = sanitizeCatalogPayload(localRaw);

  const nextPricing = localCat ? { ...localCat.pricing } : {};
  const nextPlaceholders = localCat ? { ...localCat.placeholders } : {};
  const activeSource = localCat ? 'local' : 'builtin';
  const catalogVersion = localCat?.catalogVersion || 'builtin';
  const updatedAt = localCat?.updatedAt || null;
  const installedVersion = readInstalledPluginVersion();

  for (const k of Object.keys(MODEL_PRICING)) delete MODEL_PRICING[k];
  Object.assign(MODEL_PRICING, nextPricing);

  for (const k of Object.keys(PLACEHOLDER_MAP)) delete PLACEHOLDER_MAP[k];
  Object.assign(PLACEHOLDER_MAP, nextPlaceholders);
  pricingCatalogRevision += 1;

  cloudSyncState.source = activeSource;
  cloudSyncState.catalogVersion = catalogVersion;
  cloudSyncState.updatedAt = updatedAt;
  cloudSyncState.fetchedAtMs = cloudSyncState.fetchedAtMs || 0;
  cloudSyncState.sourceUrl = '';
  if (!cloudSyncState.latestPluginVersion) {
    cloudSyncState.latestPluginVersion = installedVersion;
  }
  cloudSyncState.downloadUrl = '';
  cloudSyncState.archiveFallbackUrl = '';
}


rebuildActiveCatalog();

/**
 * 
 */
export function getCloudStatus() {
  const currentPluginVersion = readInstalledPluginVersion();
  const latestPluginVersion = isValidSemver(cloudSyncState.latestPluginVersion)
    ? String(cloudSyncState.latestPluginVersion).trim().replace(/^v/i, '')
    : currentPluginVersion;
  const updateAvailable = compareSemver(latestPluginVersion, currentPluginVersion) > 0;
  return {
    currentPluginVersion,
    latestPluginVersion,
    updateAvailable,
    installMode: 'readonly',
    releaseUrl: typeof cloudSyncState.releaseUrl === 'string' ? cloudSyncState.releaseUrl : '',
    downloadUrl: '',
    catalogVersion: cloudSyncState.catalogVersion || 'builtin',
    catalogUpdatedAt: cloudSyncState.updatedAt || null,
    lastSyncedAtMs: cloudSyncState.fetchedAtMs || 0,
    source: cloudSyncState.source || 'local',
    modelCount: Object.keys(MODEL_PRICING).length,
    placeholderCount: Object.keys(PLACEHOLDER_MAP).length,
    isSyncing: Boolean(cloudSyncState.isSyncing),
    lastSyncError: cloudSyncState.lastError || null,
    isUpdating: false,
    lastUpdateResult: pluginUpdateState.lastResult || null,
    lastUpdateError: null,
  };
}
