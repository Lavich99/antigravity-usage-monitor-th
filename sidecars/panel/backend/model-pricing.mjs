/**
 * @fileoverview API 
 *
 * 
 * 1. (`dynamicModelMap`) (`PLACEHOLDER_MAP`)
 * (`responseModel`) 
 * 2. `pricing: null` `costUsd: null` 
 * 
 */

import { MODEL_PRICING, PLACEHOLDER_MAP } from './pricing-catalog.mjs';

/**
 * API `'Gemini'` | `'Claude'` | `'GPT'` | `'Other'` 
 * `ANTHROPIC`/`CLAUDE` `OPENAI`/`GPT` `o1`/`o3`/`o4` 
 * `API_PROVIDER_GOOGLE_VERTEX_ANTHROPIC` `GOOGLE` `'Gemini'` 
 *
 * @param {string} [rawModelKey=''] 
 * @param {string} [modelId=''] ID
 * @param {string} [apiProvider=''] API 
 * @returns {'Gemini'|'Claude'|'GPT'|'Other'}
 */
function inferFamilyFromProviderOrKey(rawModelKey = '', modelId = '', apiProvider = '') {
  const prov = String(apiProvider || '').toUpperCase();
  if (prov.includes('ANTHROPIC') || prov.includes('CLAUDE')) return 'Claude';
  if (prov.includes('OPENAI') || prov.includes('GPT')) return 'GPT';
  if (prov.includes('GEMINI') || prov.includes('GOOGLE')) return 'Gemini';

  const combined = `${rawModelKey} ${modelId}`.toUpperCase();
  if (
    combined.includes('ANTHROPIC') ||
    combined.includes('CLAUDE') ||
    combined.includes('FABLE') ||
    combined.includes('SONNET') ||
    combined.includes('OPUS') ||
    combined.includes('HAIKU')
  ) {
    return 'Claude';
  }
  if (
    combined.includes('GPT') ||
    combined.includes('OPENAI') ||
    /\bO[134](?:[-_\s]|$)/.test(combined)
  ) {
    return 'GPT';
  }
  if (
    combined.includes('GEMINI') ||
    combined.includes('CARBON') ||
    combined.includes('ARGON') ||
    combined.includes('HYDROGEN') ||
    combined.includes('NEON') ||
    combined.includes('ORCHESTRATOR') ||
    combined.includes('HELIX') ||
    combined.includes('FLASH') ||
    combined.includes('GOOGLE')
  ) {
    return 'Gemini';
  }
  return 'Other';
}

/**
 * Gemini 4 Argon M417/M418/M419 M681 Orchestrator (Argon) 
 *
 * @param {...string} parts 
 * @returns {boolean}
 */
export function isArgonModelIdentifier(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(text) &&
    !/\bargon\b|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text)
  ) {
    return false;
  }
  return /argon|MODEL_PLACEHOLDER_M(?:41[789]|681)\b/i.test(text);
}

/**
 * Gemini 4 Carbon M427/M429/M437/M438 M667 Orchestrator (Carbon) 
 *
 * @param {...string} parts 
 * @returns {boolean}
 */
export function isCarbonModelIdentifier(...parts) {
  const text = parts.filter(Boolean).join(' ');
  if (/\bcarbon\b|gemini-4-carbon|MODEL_PLACEHOLDER_M(?:42[79]|43[78]|667)\b/i.test(text)) {
    return true;
  }
  if (/\bhydrogen\b|\bneon\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678]|53[2-7])\b/i.test(text)) {
    return false;
  }
  return /\bgemini-pro-orchestrator(?:-carbon)?(?=$|[^a-z0-9-])/i.test(text);
}

/**
 * `(XHigh)` `(High)` `(Medium)` `(Thinking)` 
 * `(Carbon)` / `(Argon)` `Orchestrator (Carbon)` `Orchestrator (Argon)` 
 *
 * @param {string} [label='']
 * @returns {string}
 */
export function getBaseModelLabel(label = '') {
  return (
    String(label || '')
      .replace(/\bFlash-Lite\b/gi, 'Flash Lite')
      .replace(/\s*\((?:Max|XHigh|High|Medium|Low|Thinking|Extra Low|Tiered|Preview)\)\s*$/i, '')
      .trim() || String(label || 'Unknown Model')
  );
}

const SLUG_TIER_LABELS = {
  xhigh: 'XHigh',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  'extra-low': 'Extra Low',
  tiered: 'Tiered',
};

/**
 * `gemini-3.1-pro` `gemini-3.5-flash-lite` `gemini-4-carbon` 
 * `$` `gemini-3.1-pro-ultra-v2` 
 *
 * @param {string} [slug='']
 * @returns {string}
 */
export function formatGenericModelSlug(slug = '') {
  const s = String(slug || '')
    .trim()
    .replace(/^session-display:/i, '');
  if (!s || /^MODEL_PLACEHOLDER_/i.test(s)) return '';
  if (/^gemini-4-argon-(?:f|disabled)$/i.test(s)) return 'Gemini 4 Argon';
  if (/^gemini-3\.8-flash-n$/i.test(s)) return 'Gemini 3.8 Flash';
  if (/^gemini-3\.7-flash-safety-le$/i.test(s)) return 'Gemini 3.7 Flash';
  if (/^gemini-3-flash-(?:[abd]|agent)$/i.test(s)) return 'Gemini 3.5 Flash';
  if (/^gemini-3-flash-c$/i.test(s)) return 'Gemini 3 Flash';
  if (/^gemini-pro-(?:default|agent|b)$/i.test(s)) return 'Gemini 3.1 Pro';
  const m = s.match(
    /^gemini-(\d+(?:\.\d+)?)-(pro|flash|argon|carbon|hydrogen|helix|neon)(?:-(lite))?(?:-(xhigh|high|medium|low|extra-low|tiered|preview))?$/i
  );
  if (m) {
    const ver = m[1];
    const tier = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
    const lite = m[3] ? ' Lite' : '';
    const suffixKey = m[4] ? m[4].toLowerCase() : '';
    const tierSuffix = SLUG_TIER_LABELS[suffixKey] ? ` (${SLUG_TIER_LABELS[suffixKey]})` : '';
    return `Gemini ${ver} ${tier}${lite}${tierSuffix}`;
  }
  const codenameMatch = s.match(/^gemini-(hydrogen|helix|neon)$/i);
  if (codenameMatch) {
    const codename =
      codenameMatch[1].charAt(0).toUpperCase() + codenameMatch[1].slice(1).toLowerCase();
    return `Gemini ${codename}`;
  }
  if (/^gemini-flash-worker-agy$/i.test(s)) {
    return 'Orchestrator Worker (Hydrogen)';
  }
  const claudeM = s.match(
    /^claude-(?:(\d+(?:[.-]\d+)?)-)?(sonnet|opus|haiku)(?:-(\d+(?:[.-]\d+)?))?(?:-\d{8})?(?:-(thinking|xhigh|high|medium|low|fast))?$/i
  );
  if (claudeM) {
    const ver = (claudeM[1] || claudeM[3] || '').replace('-', '.');
    const tier = claudeM[2].charAt(0).toUpperCase() + claudeM[2].slice(1).toLowerCase();
    const suf = claudeM[4] ? ` (${SLUG_TIER_LABELS[claudeM[4].toLowerCase()] || claudeM[4]})` : '';
    return `Claude ${ver ? `${ver} ` : ''}${tier}${suf}`.trim();
  }
  const gptM = s.match(/^(gpt-\d+(?:\.\d+)?|o[1-9]\d*)(?:-([a-z0-9]+))?(?:-(xhigh|high|medium|low))?$/i);
  if (gptM) {
    const base = gptM[1].toUpperCase();
    const variant = gptM[2]
      ? ` ${gptM[2].charAt(0).toUpperCase() + gptM[2].slice(1).toLowerCase()}`
      : '';
    const tier = gptM[3]
      ? ` (${SLUG_TIER_LABELS[gptM[3].toLowerCase()] || gptM[3]})`
      : '';
    return `${base}${variant}${tier}`.trim();
  }
  if (/^[a-z0-9][a-z0-9._-]{2,}$/i.test(s) && s.includes('-')) {
    const cleaned = s.replace(/-\d{8}$/, '');
    return cleaned
      .split('-')
      .filter(Boolean)
      .map((part) => {
        if (/^(?:gpt|oss|llm|ai)$/i.test(part)) return part.toUpperCase();
        if (/^o\d+$/i.test(part)) return part.toLowerCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }
  return '';
}

function lookupPricingMapEntry(mapObj, keys) {
  if (!mapObj || typeof mapObj !== 'object') return null;
  for (const k of keys) {
    if (k && mapObj[k]) return mapObj[k];
  }
  return null;
}

/**
 * Resolve model metadata and USD/1M pricing using dynamic catalog, custom user overrides,
 * static placeholder map, and heuristic future-model slug formatting.
 */
export function resolveModelInfo(
  rawModelKey,
  dynamicModelMap = new Map(),
  apiProvider = '',
  modelDisplayName = '',
  responseModel = '',
  customPricingMap = null
) {
  const dynEntry =
    dynamicModelMap && typeof dynamicModelMap.get === 'function'
      ? dynamicModelMap.get(rawModelKey)
      : null;
  const staticPh = PLACEHOLDER_MAP[rawModelKey] || null;

  const dynValidModelId =
    dynEntry?.modelId && dynEntry.modelId !== rawModelKey ? dynEntry.modelId : '';
  const mergedModelId = dynValidModelId || staticPh?.modelId || dynEntry?.modelId || '';
  const mergedLabel = dynEntry?.label || staticPh?.label || '';

  const cleanResponseModel =
    responseModel && responseModel !== 'unknown' ? String(responseModel).trim() : '';
  const cleanRawFallback =
    rawModelKey && rawModelKey !== 'unknown' ? rawModelKey : cleanResponseModel;
  const isWorkerSlot =
    rawModelKey === 'MODEL_PLACEHOLDER_M669' ||
    /^gemini-flash-worker-agy$/i.test(cleanResponseModel);
  const isVagueGenericDisplay = Boolean(
    modelDisplayName &&
      (/^gemini\s+(?:flash|pro)(?:\s+worker)?$/i.test(modelDisplayName.trim()) ||
        (isWorkerSlot && /^gemini\s+4\s+hydrogen$/i.test(modelDisplayName.trim())))
  );
  const effectiveDisplayName =
    modelDisplayName &&
    ((mergedLabel &&
      (/\borchestrator\b/i.test(modelDisplayName) || isVagueGenericDisplay) &&
      !/\borchestrator\b/i.test(mergedLabel)) ||
      (isVagueGenericDisplay && /^gemini-flash-worker-agy$/i.test(cleanResponseModel)))
      ? ''
      : modelDisplayName;
  const derivedDisplay =
    effectiveDisplayName ||
    mergedLabel ||
    formatGenericModelSlug(rawModelKey) ||
    formatGenericModelSlug(cleanResponseModel) ||
    cleanRawFallback ||
    'Unknown Model';

  const tieredSlug = derivedDisplay
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .trim()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const tieredDashedSlug = tieredSlug.replace(/\./g, '-');

  const baseLabel = getBaseModelLabel(derivedDisplay);
  const canonicalSlug = baseLabel.toLowerCase().replace(/\s+/g, '-');
  const dashedSlug = canonicalSlug.replace(/\./g, '-');
  const modelId =
    mergedModelId ||
    (rawModelKey && rawModelKey !== 'unknown' ? rawModelKey : cleanResponseModel) ||
    'unknown';

  const isOpaqueOrchestratorResp = Boolean(
    cleanResponseModel && /\borchestrator\b/i.test(cleanResponseModel)
  );
  const lookupKeys = [
    modelId,
    rawModelKey,
    cleanResponseModel && !isOpaqueOrchestratorResp ? cleanResponseModel : '',
    tieredSlug,
    tieredDashedSlug,
    canonicalSlug,
    dashedSlug,
    derivedDisplay,
    baseLabel,
    cleanResponseModel && isOpaqueOrchestratorResp ? cleanResponseModel : '',
  ];

  const customMatch = lookupPricingMapEntry(customPricingMap, lookupKeys);
  if (customMatch) {
    const inferred = inferFamilyFromProviderOrKey(rawModelKey, modelId, apiProvider);
    const customFamily =
      customMatch.family && customMatch.family !== 'Other' ? customMatch.family : inferred;
    return {
      rawModel: rawModelKey,
      modelId,
      label: derivedDisplay,
      baseLabel,
      shortName: customMatch.short || derivedDisplay,
      family: customFamily,
      pricing: {
        input: Number(customMatch.input || 0),
        cache: Number(customMatch.cache || 0),
        output: Number(customMatch.output || 0),
        short: customMatch.short || derivedDisplay,
        family: customFamily,
      },
      isCustomPrice: true,
      isEstimatedPrice: false,
    };
  }

  const explicitPricing =
    MODEL_PRICING[modelId] ||
    MODEL_PRICING[rawModelKey] ||
    (cleanResponseModel && !isOpaqueOrchestratorResp
      ? MODEL_PRICING[cleanResponseModel]
      : null) ||
    MODEL_PRICING[tieredSlug] ||
    MODEL_PRICING[tieredDashedSlug] ||
    MODEL_PRICING[canonicalSlug] ||
    MODEL_PRICING[dashedSlug] ||
    (cleanResponseModel && isOpaqueOrchestratorResp
      ? MODEL_PRICING[cleanResponseModel]
      : null);

  if (explicitPricing) {
    return {
      rawModel: rawModelKey,
      modelId,
      label: derivedDisplay,
      baseLabel,
      shortName: explicitPricing.short,
      family: explicitPricing.family,
      pricing: explicitPricing,
      isCustomPrice: false,
      isEstimatedPrice: false,
    };
  }

  const inferredFamily = inferFamilyFromProviderOrKey(rawModelKey, modelId, apiProvider);
  return {
    rawModel: rawModelKey,
    modelId,
    label: derivedDisplay,
    baseLabel,
    shortName: derivedDisplay,
    family: inferredFamily,
    pricing: null,
    isCustomPrice: false,
    isEstimatedPrice: true,
  };
}

/** Cache resolved model metadata and pricing per telemetry request. */
export function createStepModelResolver(dynamicModelMap, customPricingMap = null) {
  const models = new Map();
  return (step) => {
    const { modelKey, apiProvider = '', modelDisplayName = '', responseModel = '' } = step;
    if (
      typeof modelKey !== 'string' ||
      typeof apiProvider !== 'string' ||
      typeof modelDisplayName !== 'string' ||
      typeof responseModel !== 'string'
    ) {
      return resolveModelInfo(
        modelKey,
        dynamicModelMap,
        apiProvider,
        modelDisplayName,
        responseModel,
        customPricingMap
      );
    }
    let providers = models.get(modelKey);
    if (!providers) models.set(modelKey, (providers = new Map()));
    let names = providers.get(apiProvider);
    if (!names) providers.set(apiProvider, (names = new Map()));
    let responses = names.get(modelDisplayName);
    if (!responses) names.set(modelDisplayName, (responses = new Map()));
    let info = responses.get(responseModel);
    if (!info) {
      info = resolveModelInfo(
        modelKey,
        dynamicModelMap,
        apiProvider,
        modelDisplayName,
        responseModel,
        customPricingMap
      );
      responses.set(responseModel, info);
    }
    return info;
  };
}

/**
 * Orchestrator ID `gemini-pro-orchestrator (carbon-4)` 
 * ID `gemini-3.8-flash-n` `gemini-4-hydrogen` 
 *
 * @param {string} [rawUpstream='']
 * @param {ReturnType<typeof resolveModelInfo>|null} [mInfo=null]
 * @returns {string}
 */
export function formatUpstreamModelId(rawUpstream = '', mInfo = null) {
  const s = String(rawUpstream || '').trim();
  if (!s || !/(?:orchestrator|-worker-agy\b)/i.test(s) || /\([^)]+\)\s*$/.test(s)) {
    return s;
  }
  const metaText = `${mInfo?.rawModel || ''} ${mInfo?.modelId || ''} ${mInfo?.shortName || ''} ${mInfo?.label || ''} ${s}`;
  if (
    /\bhydrogen\b|\bgemini-flash-worker-agy\b|MODEL_PLACEHOLDER_M(?:669|52[5678])\b/i.test(
      metaText
    )
  ) {
    return `${s} (hydrogen-4)`;
  }
  if (/\bneon\b|MODEL_PLACEHOLDER_M53[2-7]\b/i.test(metaText)) {
    return /-neon\b/i.test(s) ? s : `${s} (neon-4)`;
  }
  if (isArgonModelIdentifier(mInfo?.rawModel, mInfo?.modelId, mInfo?.label, s)) {
    return `${s} (argon-4)`;
  }
  if (isCarbonModelIdentifier(mInfo?.rawModel, mInfo?.modelId, mInfo?.label, s)) {
    return `${s} (carbon-4)`;
  }
  return s;
}

/**
 * API `pricing === null` `null` 
 * NaN 0 
 *
 * @param {{ inputTokens: number, cacheReadTokens: number, outputTokens: number }} step
 * @param {{ input: number, cache: number, output: number } | null} pricing
 * @returns {number|null}
 */
export function computeStepCost(step, pricing) {
  if (!pricing) return null;
  const safeTok = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const inCost = (safeTok(step?.inputTokens) / 1_000_000) * pricing.input;
  const cacheCost = (safeTok(step?.cacheReadTokens) / 1_000_000) * pricing.cache;
  const outCost = (safeTok(step?.outputTokens) / 1_000_000) * pricing.output;
  return inCost + cacheCost + outCost;
}
