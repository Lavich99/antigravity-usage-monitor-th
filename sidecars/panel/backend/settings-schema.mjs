/**
 * @fileoverview Schema 
 *
 * / / 
 * `settings.json` 3 `'none'` `enableWindowOverlay` `autoUpdatePlugin` 
 */

import { isContextWindowSettingId, isContextWindowOption } from './context-windows.mjs';

export const SUPPORTED_LANGUAGES = Object.freeze(['auto', 'th-TH', 'en-US']);

export const THEME_ACCENT_KEYS = Object.freeze([
  'host',
  'blue',
  'emerald',
  'amber',
  'violet',
  'cyan',
  'rose',
]);

export const FONT_SCALE_KEYS = Object.freeze(['sm', 'md', 'lg', 'xl']);

export const TOPBAR_SLOT_KEYS = Object.freeze([
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_cycle',
  'gemini_5h',
  'gemini_weekly',
  'claude_cycle',
  'claude_5h',
  'claude_weekly',
]);

export const DEFAULT_TOPBAR_SLOTS = Object.freeze(['gemini_cycle', 'context']);
export const MIN_TOPBAR_SLOTS = 1;
export const MAX_TOPBAR_SLOTS = 2;

export const OVERVIEW_MODULE_KEYS = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_OVERVIEW_MODULES = Object.freeze([
  'metrics',
  'context',
  'quotas',
  'live_tasks',
]);

export const DEFAULT_HOVER_MODULES = Object.freeze(['context', 'quotas']);

export const OVERVIEW_METRIC_KEYS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'context_usage',
  'quota_tightest',
]);

export const DEFAULT_OVERVIEW_METRICS = Object.freeze([
  'tps',
  'ttft',
  'avg_tps',
  'step_cost',
]);

export const STEP_TABLE_COLUMN_KEYS = Object.freeze([
  'step',
  'time',
  'model',
  'tps',
  'ttft',
  'duration',
  'tokens_combo',
  'tokens_io_cache',
  'tokens_custom',
  'input_tokens',
  'cache_tokens',
  'output_tokens',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TABLE_COLUMNS = Object.freeze([
  'step',
  'model',
  'tps',
  'tokens_combo',
  'cache',
  'cost',
]);

export const DEFAULT_STEP_TOKEN_COMBO_FORMAT = 'context:in:cache';

export const STEP_TOKEN_SEGMENT_ALIASES = Object.freeze({
  context: 'context',
  ctx: 'context',
  in: 'in',
  new: 'in',
  input: 'in',
  out: 'out',
  output: 'out',
  cache: 'cache',
  cached: 'cache',
  cache_read: 'cache',
  cacheread: 'cache',
  think: 'think',
  thinking: 'think',
  reply: 'reply',
  body: 'reply',
  resp: 'reply',
  response: 'reply',
  text: 'reply',
  total: 'total',
  all: 'total',
  sum: 'total',
});

export const PLUGIN_UPDATE_MODES = Object.freeze(['off', 'manual', 'auto']);

export const MODEL_DISPLAY_MODES = Object.freeze(['short', 'upstream', 'upstream_compact']);

export const ORCHESTRATOR_ID_MODES = Object.freeze(['compact', 'full']);

export const WINDOW_MOUNT_MODES = Object.freeze(['dual', 'composer', 'sidebar']);

export const POPOVER_WIDTH_MODES = Object.freeze(['auto', 'custom']);
export const QUOTA_DISPLAY_MODES = Object.freeze(['left', 'used']);
export const MIN_POPOVER_WIDTH = 440;
export const MAX_POPOVER_WIDTH = 1080;
export const DEFAULT_POPOVER_WIDTH = 550;

function isSchemaPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function schemaSanitizePositiveNum(val, fallback) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

/**
 * `'zh-CN'` `'auto'` `'en-US'` 
 *
 * @param {unknown} lang
 * @returns {'auto'|'zh-CN'|'en-US'}
 */
export function normalizeLanguageSetting(lang) {
  const raw = String(lang ?? '').trim();
  if (!raw) return 'th-TH';
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'system') return 'auto';
  if (lower === 'en' || lower === 'en-us' || lower.startsWith('en-')) return 'en-US';
  return 'th-TH';
}

/**
 * `'host'` 
 *
 * @param {unknown} accent
 * @returns {'host'|'blue'|'emerald'|'amber'|'violet'|'cyan'|'rose'}
 */
export function normalizeThemeAccent(accent) {
  const clean = String(accent ?? '').trim().toLowerCase();
  return THEME_ACCENT_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'host';
}

/**
 * `'md'` 100% 
 *
 * @param {unknown} scale
 * @returns {'sm'|'md'|'lg'|'xl'}
 */
export function normalizeFontScale(scale) {
  const clean = String(scale ?? '').trim().toLowerCase();
  return FONT_SCALE_KEYS.includes(clean) ? /** @type {any} */ (clean) : 'sm';
}

/**
 * `'dual'` + | `'composer'` + | `'sidebar'` 
 * `enableWindowOverlay` `'composer'` 
 *
 * @param {unknown} mode
 * @param {unknown} [legacyEnableOverlay]
 * @returns {'dual'|'composer'|'sidebar'}
 */
export function normalizeWindowMountMode(mode, legacyEnableOverlay) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'composer' || m === 'input') return 'composer';
  if (m === 'sidebar' || m === 'sidebar_only' || m === 'off') return 'sidebar';
  if (m === 'dual' || m === 'topbar') return 'dual';
  if (legacyEnableOverlay === false) return 'sidebar';
  return 'composer';
}

/**
 * `'short'` | `'upstream_compact'` ID | `'upstream'` ID 
 * `showUpstreamModel` `'short'` 
 *
 * @param {unknown} mode
 * @param {unknown} [legacyShowUpstream]
 * @returns {'short'|'upstream_compact'|'upstream'}
 */
export function normalizeModelDisplayMode(mode, legacyShowUpstream) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'upstream' || m === 'raw' || m === 'full') return 'upstream';
  if (m === 'upstream_compact' || m === 'compact_upstream' || m === 'trimmed') {
    return 'upstream_compact';
  }
  if (m === 'short') return 'short';
  if (legacyShowUpstream === true) return 'upstream';
  return 'short';
}

/**
 * Orchestrator ID `'compact'` vs `'full'` ID `'compact'` 
 *
 * @param {unknown} mode
 * @returns {'compact'|'full'}
 */
export function normalizeOrchestratorIdMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'full' ? 'full' : 'compact';
}

/**
 * `'auto'` | `'custom'` `'auto'` 
 *
 * @param {unknown} mode
 * @returns {'auto'|'custom'}
 */
export function normalizePopoverWidthMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'custom' || m === 'fixed' ? 'custom' : 'auto';
}

export function normalizeQuotaDisplayMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  return m === 'used' ? 'used' : 'left';
}

/**
 * `440..1080` `580` 
 *
 * @param {unknown} width
 * @returns {number}
 */
export function normalizePopoverWidth(width) {
  const num = Number(width);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_POPOVER_WIDTH;
  return Math.max(MIN_POPOVER_WIDTH, Math.min(MAX_POPOVER_WIDTH, Math.round(num)));
}

/**
 * Token `:` `/` `,` `|` 1~4 
 *
 * @param {unknown} raw
 * @returns {Array<'context'|'in'|'out'|'cache'|'think'|'reply'|'total'>}
 */
export function parseStepTokenComboSegments(raw) {
  const str = String(raw ?? '').trim();
  const out = [];
  const seen = new Set();
  if (str) {
    for (const part of str.split(/[:/,|]+/)) {
      const key = part.trim().toLowerCase();
      if (!key) continue;
      const mapped = Object.prototype.hasOwnProperty.call(STEP_TOKEN_SEGMENT_ALIASES, key)
        ? STEP_TOKEN_SEGMENT_ALIASES[key]
        : null;
      if (!mapped || seen.has(mapped)) continue;
      seen.add(mapped);
      out.push(/** @type {any} */ (mapped));
      if (out.length >= 4) break;
    }
  }
  return out.length > 0 ? out : ['context', 'in', 'cache'];
}

/**
 * Token `'context:new:cache'` -> `'context:in:cache'` 
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStepTokenComboFormat(raw) {
  return parseStepTokenComboSegments(raw).join(':');
}

/**
 * `autoUpdatePlugin` `'manual'` 
 *
 * @param {unknown} mode
 * @param {unknown} [legacyAutoUpdate]
 * @returns {'off'|'manual'|'auto'}
 */
export function normalizePluginUpdateMode(mode, legacyAutoUpdate) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'manual' || m === 'notify' || m === 'auto') return 'manual';
  if (m === 'off') return 'off';
  if (legacyAutoUpdate === true) return 'manual';
  return 'off';
}

/**
 * `'tokens'` / `'cost'` `'custom_tokens'` / `'custom_cost'` 
 *
 * @param {unknown} mode
 * @returns {'official'|'custom_tokens'|'custom_cost'}
 */
export function normalizeWeeklyLimitMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'custom_tokens' || m === 'tokens') return 'custom_tokens';
  if (m === 'custom_cost' || m === 'cost') return 'custom_cost';
  return 'official';
}

/**
 * / 1~5 3 `'none'` 
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeTopbarCapsuleSlots(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_TOPBAR_SLOTS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!val || val === 'none') continue;
    const mapped = val === 'step_cost' ? 'cost' : val;
    if (!TOPBAR_SLOT_KEYS.includes(mapped) || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
    if (out.length >= MAX_TOPBAR_SLOTS) break;
  }
  if (out.length < MIN_TOPBAR_SLOTS) {
    return ['context'];
  }
  return out;
}

/**
 * 1~4 4 
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out.length > 0 ? out : ['metrics'];
}

/**
 * 0~4 3 `[]` 
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeHoverModules(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_HOVER_MODULES];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!OVERVIEW_MODULE_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= OVERVIEW_MODULE_KEYS.length) break;
  }
  return out;
}

/**
 * 1~4 4 
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeOverviewMetrics(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_OVERVIEW_METRICS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const rawVal = String(item ?? '').trim();
    const val = rawVal === 'cost' ? 'step_cost' : rawVal;
    if (!OVERVIEW_METRIC_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= 4) break;
  }
  return out.length > 0 ? out : ['tps'];
}

/**
 * 2~12 7 
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeStepTableColumns(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_STEP_TABLE_COLUMNS];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const val = String(item ?? '').trim();
    if (!STEP_TABLE_COLUMN_KEYS.includes(val) || seen.has(val)) continue;
    seen.add(val);
    out.push(val);
    if (out.length >= STEP_TABLE_COLUMN_KEYS.length) break;
  }
  if (out.length < 2) {
    for (const fallbackCol of ['step', 'model', 'tps']) {
      if (!seen.has(fallbackCol)) {
        seen.add(fallbackCol);
        out.push(fallbackCol);
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

export function normalizeModelContextWindows(value) {
  return Object.fromEntries(
    Object.entries(isSchemaPlainObject(value) ? value : {}).filter(
      ([id, option]) => isContextWindowSettingId(id) && isContextWindowOption(option)
    )
  );
}

const CUSTOM_MODEL_KEY_MAX = 128;
const CUSTOM_MODEL_ENTRY_MAX = 64;
const ALLOWED_MODEL_FAMILIES = new Set(['Gemini', 'Claude', 'GPT', 'Other']);

export function normalizeCustomModelPricing(value) {
  if (!isSchemaPlainObject(value)) return {};
  const out = {};
  let count = 0;
  for (const [rawKey, entry] of Object.entries(value)) {
    if (count >= CUSTOM_MODEL_ENTRY_MAX) break;
    const key = String(rawKey || '').trim().slice(0, CUSTOM_MODEL_KEY_MAX);
    if (!key || !isSchemaPlainObject(entry)) continue;
    const inPrice = Number(entry.input);
    const cachePrice = entry.cache == null || entry.cache === '' ? +(inPrice * 0.1).toFixed(4) : Number(entry.cache);
    const outPrice = Number(entry.output);
    if (
      !Number.isFinite(inPrice) || inPrice < 0 ||
      !Number.isFinite(cachePrice) || cachePrice < 0 ||
      !Number.isFinite(outPrice) || outPrice < 0
    ) {
      continue;
    }
    const rawShort = String(entry.short || '').trim().slice(0, 48);
    const rawFamily = String(entry.family || '').trim();
    const family = ALLOWED_MODEL_FAMILIES.has(rawFamily) ? rawFamily : 'Other';
    out[key] = {
      input: +inPrice.toFixed(6),
      cache: +cachePrice.toFixed(6),
      output: +outPrice.toFixed(6),
      short: rawShort || key,
      family,
    };
    count += 1;
  }
  return out;
}

export const DEFAULT_SETTINGS_SCHEMA = Object.freeze({
  language: 'th-TH',
  themeAccent: 'host',
  fontScale: 'sm',
  weeklyTokenBudget: 150000000,
  weeklyCostBudget: 100,
  weeklyLimitMode: 'official',
  modelDisplayMode: 'short',
  showUpstreamModel: false,
  orchestratorIdMode: 'compact',
  pluginUpdateMode: 'off',
  autoUpdatePlugin: false,
  windowMountMode: 'composer',
  enableWindowOverlay: true,
  moveComposerPermissionLeft: true,
  popoverWidthMode: 'auto',
  popoverWidth: DEFAULT_POPOVER_WIDTH,
  showTopbarMultiSession: false,
  quotaDisplayMode: 'left',
  topbarCapsuleSlots: DEFAULT_TOPBAR_SLOTS,
  hoverModules: DEFAULT_HOVER_MODULES,
  overviewModules: DEFAULT_OVERVIEW_MODULES,
  overviewMetrics: DEFAULT_OVERVIEW_METRICS,
  showStepTurnRail: true,
  showStepAgentBadge: true,
  showStepSpeedColor: true,
  stepTokenComboFormat: DEFAULT_STEP_TOKEN_COMBO_FORMAT,
  stepTableColumns: DEFAULT_STEP_TABLE_COLUMNS,
  contextWindowRiskAccepted: true,
  modelContextWindows: Object.freeze({}),
  customModelPricing: Object.freeze({}),
});

/**
 * Create a deep-copied default settings object.
 */
export function createDefaultSettingsObject() {
  return {
    language: DEFAULT_SETTINGS_SCHEMA.language,
    themeAccent: DEFAULT_SETTINGS_SCHEMA.themeAccent,
    fontScale: DEFAULT_SETTINGS_SCHEMA.fontScale,
    weeklyTokenBudget: DEFAULT_SETTINGS_SCHEMA.weeklyTokenBudget,
    weeklyCostBudget: DEFAULT_SETTINGS_SCHEMA.weeklyCostBudget,
    weeklyLimitMode: DEFAULT_SETTINGS_SCHEMA.weeklyLimitMode,
    modelDisplayMode: DEFAULT_SETTINGS_SCHEMA.modelDisplayMode,
    showUpstreamModel: DEFAULT_SETTINGS_SCHEMA.showUpstreamModel,
    orchestratorIdMode: DEFAULT_SETTINGS_SCHEMA.orchestratorIdMode,
    pluginUpdateMode: DEFAULT_SETTINGS_SCHEMA.pluginUpdateMode,
    autoUpdatePlugin: DEFAULT_SETTINGS_SCHEMA.autoUpdatePlugin,
    windowMountMode: DEFAULT_SETTINGS_SCHEMA.windowMountMode,
    enableWindowOverlay: DEFAULT_SETTINGS_SCHEMA.enableWindowOverlay,
    moveComposerPermissionLeft: DEFAULT_SETTINGS_SCHEMA.moveComposerPermissionLeft,
    popoverWidthMode: DEFAULT_SETTINGS_SCHEMA.popoverWidthMode,
    popoverWidth: DEFAULT_SETTINGS_SCHEMA.popoverWidth,
    showTopbarMultiSession: DEFAULT_SETTINGS_SCHEMA.showTopbarMultiSession,
    quotaDisplayMode: DEFAULT_SETTINGS_SCHEMA.quotaDisplayMode,
    topbarCapsuleSlots: [...DEFAULT_TOPBAR_SLOTS],
    hoverModules: [...DEFAULT_HOVER_MODULES],
    overviewModules: [...DEFAULT_OVERVIEW_MODULES],
    overviewMetrics: [...DEFAULT_OVERVIEW_METRICS],
    showStepTurnRail: DEFAULT_SETTINGS_SCHEMA.showStepTurnRail,
    showStepAgentBadge: DEFAULT_SETTINGS_SCHEMA.showStepAgentBadge,
    showStepSpeedColor: DEFAULT_SETTINGS_SCHEMA.showStepSpeedColor,
    stepTokenComboFormat: DEFAULT_SETTINGS_SCHEMA.stepTokenComboFormat,
    stepTableColumns: [...DEFAULT_STEP_TABLE_COLUMNS],
    contextWindowRiskAccepted: DEFAULT_SETTINGS_SCHEMA.contextWindowRiskAccepted,
    modelContextWindows: {},
    customModelPricing: {},
  };
}

/**
 * 
 *
 * @param {unknown} rawInput
 */
export function normalizeFullSettings(rawInput) {
  const safeRaw = isSchemaPlainObject(rawInput) ? rawInput : {};
  const pluginUpdateMode = normalizePluginUpdateMode(
    safeRaw.pluginUpdateMode,
    safeRaw.autoUpdatePlugin
  );
  const windowMountMode = normalizeWindowMountMode(
    safeRaw.windowMountMode,
    safeRaw.enableWindowOverlay
  );
  const modelDisplayMode = normalizeModelDisplayMode(
    safeRaw.modelDisplayMode,
    safeRaw.showUpstreamModel
  );
  return {
    language: normalizeLanguageSetting(safeRaw.language),
    themeAccent: normalizeThemeAccent(safeRaw.themeAccent),
    fontScale: normalizeFontScale(safeRaw.fontScale),
    weeklyTokenBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyTokenBudget ?? safeRaw.weeklyTokenLimit,
      DEFAULT_SETTINGS_SCHEMA.weeklyTokenBudget
    ),
    weeklyCostBudget: schemaSanitizePositiveNum(
      safeRaw.weeklyCostBudget,
      DEFAULT_SETTINGS_SCHEMA.weeklyCostBudget
    ),
    weeklyLimitMode: normalizeWeeklyLimitMode(safeRaw.weeklyLimitMode),
    modelDisplayMode,
    showUpstreamModel: modelDisplayMode !== 'short',
    orchestratorIdMode: normalizeOrchestratorIdMode(safeRaw.orchestratorIdMode),
    pluginUpdateMode,
    autoUpdatePlugin: pluginUpdateMode === 'auto',
    windowMountMode,
    enableWindowOverlay: windowMountMode !== 'sidebar',
    moveComposerPermissionLeft:
      safeRaw.moveComposerPermissionLeft === undefined
        ? DEFAULT_SETTINGS_SCHEMA.moveComposerPermissionLeft
        : safeRaw.moveComposerPermissionLeft === true,
    popoverWidthMode: normalizePopoverWidthMode(safeRaw.popoverWidthMode),
    popoverWidth: normalizePopoverWidth(safeRaw.popoverWidth),
    showTopbarMultiSession:
      safeRaw.showTopbarMultiSession === undefined
        ? DEFAULT_SETTINGS_SCHEMA.showTopbarMultiSession
        : safeRaw.showTopbarMultiSession !== false,
    quotaDisplayMode: normalizeQuotaDisplayMode(safeRaw.quotaDisplayMode),
    topbarCapsuleSlots: normalizeTopbarCapsuleSlots(safeRaw.topbarCapsuleSlots),
    hoverModules: normalizeHoverModules(safeRaw.hoverModules),
    overviewModules: normalizeOverviewModules(safeRaw.overviewModules),
    overviewMetrics: normalizeOverviewMetrics(safeRaw.overviewMetrics),
    showStepTurnRail:
      safeRaw.showStepTurnRail === undefined
        ? DEFAULT_SETTINGS_SCHEMA.showStepTurnRail
        : safeRaw.showStepTurnRail === true,
    showStepAgentBadge:
      safeRaw.showStepAgentBadge === undefined
        ? DEFAULT_SETTINGS_SCHEMA.showStepAgentBadge
        : safeRaw.showStepAgentBadge !== false,
    showStepSpeedColor:
      safeRaw.showStepSpeedColor === undefined
        ? DEFAULT_SETTINGS_SCHEMA.showStepSpeedColor
        : safeRaw.showStepSpeedColor === true,
    stepTokenComboFormat: normalizeStepTokenComboFormat(safeRaw.stepTokenComboFormat),
    stepTableColumns: normalizeStepTableColumns(safeRaw.stepTableColumns),
    contextWindowRiskAccepted:
      safeRaw.contextWindowRiskAccepted === undefined
        ? DEFAULT_SETTINGS_SCHEMA.contextWindowRiskAccepted
        : safeRaw.contextWindowRiskAccepted === true,
    modelContextWindows: normalizeModelContextWindows(safeRaw.modelContextWindows),
    customModelPricing: normalizeCustomModelPricing(safeRaw.customModelPricing),
  };
}

