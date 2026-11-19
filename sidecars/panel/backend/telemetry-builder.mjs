/**
 * @fileoverview 
 *
 * 
 * 1. 
 * 2. `buildOfficialQuotaPools` 
 * 3. `enumerateAndSyncConversations` 
 * 4. `enrichActiveConversationSteps` `extractActiveContextTelemetry` 10 
 * 5. `aggregateMultiWindowUsage` JSON 
 */

import { isDeepStrictEqual } from 'node:util';
import {
  extractLiveActivity,
  parseIsoMs,
  speedMetric,
  summarizeSpeed,
  summarizeTtft,
} from '../speed-metrics.mjs';
import {
  CLI_STATUS_SNAPSHOT_FILE,
  computeRuntimeCodeVersion,
  inFlightRequests,
  loadSettings,
  lsRuntimeEndpoint,
  roundMetric,
  saveJson,
  trajectoryCache,
} from './config.mjs';
import { getContextWindowGroups, getContextWindowModels } from './context-windows.mjs';
import { enumerateAndSyncConversations } from './local-scanner.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';
import { callLsRpc, getContextModelCatalog, getOfficialQuotaSummary } from './ls-rpc.mjs';
import {
  computeStepCost,
  createStepModelResolver,
  formatUpstreamModelId,
  isArgonModelIdentifier,
  isCarbonModelIdentifier,
  resolveModelInfo,
} from './model-pricing.mjs';
import { getCloudStatus, pricingCatalogRevision } from './pricing-catalog.mjs';
import { buildOfficialQuotaPools } from './quota-pools.mjs';
import {
  aggregateMultiWindowUsage,
  buildScopedModelBreakdown,
  getNextMondayResetIso,
} from './usage-aggregator.mjs';

const MAX_RECENT_CONVERSATIONS = 30;
const POOL_PRIORITY_ORDER = ['Gemini', 'Argon', 'Carbon', 'Claude & GPT'];
const inFlightTelemetrySources = new Map();
const trajectoryModelFacts = new WeakMap();
let lastMainPreparation = null;
let lastCliSnapshotSig = '';

function buildDiscoveredModelsList(
  clientConfigs,
  dynamicModelMap,
  modelBreakdown,
  customPricingMap,
  reportedContextLimits
) {
  const byId = new Map();
  const upsert = (entry) => {
    const id = String(entry?.modelId || '').trim();
    if (!id || id === 'unknown') return;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, entry);
    } else if (!prev.pricing && entry.pricing) {
      byId.set(id, { ...prev, ...entry });
    }
  };
  const seenLabels = new Set();
  const recordLabels = (label, shortName) => {
    const l = String(label || '').trim().toLowerCase();
    const s = String(shortName || '').trim().toLowerCase();
    if (l) seenLabels.add(l);
    if (s) seenLabels.add(s);
  };
  for (const cfg of Array.isArray(clientConfigs) ? clientConfigs : []) {
    const rawKey = cfg?.modelOrAlias?.model || cfg?.modelId || '';
    const info = resolveModelInfo(rawKey, dynamicModelMap, '', cfg?.label || '', '', customPricingMap);
    const id = cfg?.modelId && cfg.modelId !== rawKey ? cfg.modelId : info.modelId || rawKey;
    const resolvedLabel = info.label || cfg?.label || id;
    const resolvedShort = info.shortName || cfg?.label || id;
    recordLabels(resolvedLabel, resolvedShort);
    upsert({
      modelId: id,
      rawKey: rawKey && rawKey !== id ? rawKey : '',
      label: resolvedLabel,
      shortName: resolvedShort,
      family: info.family || 'Other',
      pricing: info.pricing || null,
      isCustomPrice: Boolean(info.isCustomPrice),
      hasCatalogPrice: Boolean(info.pricing && !info.isCustomPrice),
      contextLimit: reportedContextLimits?.get(id)?.tokens || null,
    });
  }
  const orderedBreakdown = Array.isArray(modelBreakdown)
    ? [...modelBreakdown].sort((a, b) => {
        const aMachine = Boolean(a && (a.rawModel || a.modelId) && !/\s/.test(String(a.rawModel || a.modelId)));
        const bMachine = Boolean(b && (b.rawModel || b.modelId) && !/\s/.test(String(b.rawModel || b.modelId)));
        return Number(bMachine) - Number(aMachine);
      })
    : [];
  for (const mb of orderedBreakdown) {
    if (!mb?.modelId && !mb?.rawModel) continue;
    const id = mb.modelId || mb.rawModel;
    const labelNorm = String(mb?.label || '').trim().toLowerCase();
    const shortNorm = String(mb?.modelShort || '').trim().toLowerCase();
    const info = resolveModelInfo(
      mb.rawModel || id,
      dynamicModelMap,
      '',
      mb.label || '',
      mb.modelUpstream || '',
      customPricingMap
    );
    const canonicalId = info.modelId || id;
    const resolvedLabel = info.label || mb.label || id;
    const resolvedShort = info.shortName || mb.modelShort || mb.label || id;
    const resolvedLabelNorm = String(resolvedLabel || '').trim().toLowerCase();
    const resolvedShortNorm = String(resolvedShort || '').trim().toLowerCase();
    const isDisplayFallback =
      !byId.has(canonicalId) && (/\s/.test(canonicalId) || canonicalId === resolvedLabel);
    if (
      isDisplayFallback &&
      ((labelNorm && seenLabels.has(labelNorm)) ||
        (shortNorm && seenLabels.has(shortNorm)) ||
        (resolvedLabelNorm && seenLabels.has(resolvedLabelNorm)) ||
        (resolvedShortNorm && seenLabels.has(resolvedShortNorm)))
    ) {
      continue;
    }
    if ((labelNorm && seenLabels.has(labelNorm)) || (shortNorm && seenLabels.has(shortNorm))) {
      if (!byId.has(canonicalId)) continue;
    }
    upsert({
      modelId: canonicalId,
      rawKey: mb.rawModel && mb.rawModel !== canonicalId ? mb.rawModel : '',
      label: resolvedLabel,
      shortName: resolvedShort,
      family: info.family || mb.family || 'Other',
      pricing: info.pricing || null,
      isCustomPrice: Boolean(info.isCustomPrice),
      hasCatalogPrice: Boolean(info.pricing && !info.isCustomPrice),
      contextLimit: reportedContextLimits?.get(canonicalId)?.tokens || null,
    });
    recordLabels(resolvedLabel, resolvedShort);
  }
  for (const [k, custom] of Object.entries(customPricingMap || {})) {
    const kNorm = String(k || '').trim().toLowerCase();
    const customShortNorm = String(custom?.short || '').trim().toLowerCase();
    if (!byId.has(k) && ((kNorm && seenLabels.has(kNorm)) || (customShortNorm && seenLabels.has(customShortNorm)))) {
      for (const existing of byId.values()) {
        const eLabelNorm = String(existing?.label || '').trim().toLowerCase();
        const eShortNorm = String(existing?.shortName || '').trim().toLowerCase();
        if (
          !existing.pricing &&
          ((kNorm && (eLabelNorm === kNorm || eShortNorm === kNorm)) ||
            (customShortNorm && (eLabelNorm === customShortNorm || eShortNorm === customShortNorm)))
        ) {
          existing.pricing = { input: custom.input, cache: custom.cache, output: custom.output };
          existing.isCustomPrice = true;
          existing.hasCatalogPrice = false;
        }
      }
      continue;
    }
    upsert({
      modelId: k,
      rawKey: '',
      label: custom.short || k,
      shortName: custom.short || k,
      family: custom.family || 'Other',
      pricing: { input: custom.input, cache: custom.cache, output: custom.output },
      isCustomPrice: true,
      hasCatalogPrice: false,
      contextLimit: reportedContextLimits?.get(k)?.tokens || null,
    });
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aUnpriced = a.pricing ? 1 : 0;
    const bUnpriced = b.pricing ? 1 : 0;
    if (aUnpriced !== bUnpriced) return aUnpriced - bUnpriced;
    return String(a.label || a.modelId).localeCompare(String(b.label || b.modelId));
  });
}

function roundSessionCost(val) {
  if (!Number.isFinite(val) || val <= 0) return 0;
  return val < 0.01 ? +val.toFixed(4) : +val.toFixed(2);
}

function findTrajectoryCacheEntry(cascadeId) {
  if (!cascadeId) return null;
  if (trajectoryCache[cascadeId]) return trajectoryCache[cascadeId];
  const targetLower = String(cascadeId).toLowerCase();
  for (const [k, v] of Object.entries(trajectoryCache)) {
    if (k.toLowerCase() === targetLower) return v;
  }
  return null;
}

function rememberModelContextLimit(limits, step) {
  const previous = limits.get(step.modelKey);
  if (!previous || step.createdAtMs > previous.at) {
    limits.set(step.modelKey, { tokens: step.reportedContextLimitTokens, at: step.createdAtMs });
  }
}

function readTrajectoryModelFacts(steps) {
  const cached = trajectoryModelFacts.get(steps);
  if (cached) return cached;
  const upstream = new Map();
  const limits = new Map();
  let sortableLimits = true;
  for (const step of steps) {
    if (step?.modelKey && step.modelKey !== 'unknown' && step.responseModel) {
      upstream.set(step.modelKey, step.responseModel);
    }
    if (!step?.isCompactionStep && step?.reportedContextLimitTokens > 0) {
      sortableLimits &&= Number.isFinite(step.createdAtMs);
      rememberModelContextLimit(limits, step);
    }
  }
  const result = { upstream, limits: sortableLimits ? limits : null };
  trajectoryModelFacts.set(steps, result);
  return result;
}

/** */
function buildKnownUpstreamModelMap(contextLimits, currentAccountName) {
  const knownUpstreamByModelKey = new Map();
  for (const entry of Object.values(trajectoryCache)) {
    if (!entry?.steps?.length) continue;
    const facts = readTrajectoryModelFacts(entry.steps);
    for (const [key, model] of facts.upstream) knownUpstreamByModelKey.set(key, model);
    if (entry.subagentSpec || (entry.accountName && entry.accountName !== currentAccountName)) continue;
    if (facts.limits) {
      for (const [key, limit] of facts.limits) {
        const previous = contextLimits.get(key);
        if (!previous || limit.at > previous.at) contextLimits.set(key, limit);
      }
    } else {
      for (const step of entry.steps) {
        if (!step?.isCompactionStep && step?.reportedContextLimitTokens > 0) {
          rememberModelContextLimit(contextLimits, step);
        }
      }
    }
  }
  return knownUpstreamByModelKey;
}

/**
 * 
 * JSON 
 *
 * @param {object[]} activeSteps 
 * @param {ReturnType<typeof createStepModelResolver>} resolveStepModel 
 * @param {Map<string, string>} sharedUpstreamMap 
 * @param {object} agentFields 
 */
function enrichActiveConversationSteps(
  activeSteps,
  resolveStepModel,
  sharedUpstreamMap,
  agentFields
) {
  const sessionSpeed = summarizeSpeed(activeSteps);
  const sessionTtft = summarizeTtft(activeSteps);
  let sessionCostUsd = 0;
  let sessionUnpricedCalls = 0;
  let sessionInputTokens = 0;
  let sessionCacheReadTokens = 0;
  let sessionOutputTokens = 0;

  const knownUpstreamByModelKey = sharedUpstreamMap;
  const enrichedActiveSteps = activeSteps.map((st) => {
    const mInfo = resolveStepModel(st);
    const costUsd = computeStepCost(st, mInfo.pricing);
    const metric = speedMetric(st);

    sessionCostUsd += costUsd ?? 0;
    if (costUsd === null) sessionUnpricedCalls++;
    sessionInputTokens += st.inputTokens;
    sessionCacheReadTokens += st.cacheReadTokens;
    const outputTokens = resolveStepOutputTokens(st);
    sessionOutputTokens += outputTokens;

    const tokPerSec = metric.value;
    const totalPrompt = st.inputTokens + st.cacheReadTokens;
    const cacheHitPct = totalPrompt > 0 ? (st.cacheReadTokens / totalPrompt) * 100 : 0;

    const inCostUsd = mInfo.pricing ? (st.inputTokens / 1_000_000) * mInfo.pricing.input : null;
    const cacheCostUsd = mInfo.pricing
      ? (st.cacheReadTokens / 1_000_000) * mInfo.pricing.cache
      : null;
    const outCostUsd = mInfo.pricing ? (st.outputTokens / 1_000_000) * mInfo.pricing.output : null;
    const resolvedResponseModel =
      st.responseModel ||
      (st.modelKey && st.modelKey !== 'unknown'
        ? knownUpstreamByModelKey.get(st.modelKey) || ''
        : '');
    const rawUpstreamModel =
      resolvedResponseModel ||
      (mInfo.modelId && mInfo.modelId !== 'unknown' ? mInfo.modelId : mInfo.shortName);
    const annotatedUpstreamModel = formatUpstreamModelId(rawUpstreamModel, mInfo);
    const modelUpstream = st.isCompactionStep
      ? `${annotatedUpstreamModel}·Compact`
      : annotatedUpstreamModel;

    const {
      viewableDelaySec: _viewableDelaySec,
      ttftSource: _ttftSource,
      speedBasis: _speedBasis,
      ...serializedStep
    } = st;

    return {
      ...serializedStep,
      responseModel: st.responseModel || '',
      modelUpstream,
      modelLabel: st.isCompactionStep ? `${mInfo.label} [Auto-Compact]` : mInfo.label,
      modelShort: st.isCompactionStep ? `${mInfo.shortName}·Compact` : mInfo.shortName,
      family: mInfo.family,
      tokPerSec: roundMetric(tokPerSec),
      selectedSpeedReason: metric.reason,
      ttftSec: st.nativeTtftSec,
      cacheHitPct: +cacheHitPct.toFixed(1),
      costUsd: costUsd === null ? null : +costUsd.toFixed(4),
      inCostUsd: inCostUsd === null ? null : +inCostUsd.toFixed(4),
      cacheCostUsd: cacheCostUsd === null ? null : +cacheCostUsd.toFixed(4),
      outCostUsd: outCostUsd === null ? null : +outCostUsd.toFixed(4),
      contextTokens: totalPrompt + outputTokens,
      ...agentFields,
    };
  });

  
  let maxTurnIndex = 0;
  const promptByTurn = new Map();
  for (const st of enrichedActiveSteps) {
    const tIdx = st.turnIndex;
    if (!Number.isInteger(tIdx) || tIdx <= 0) continue;
    if (tIdx > maxTurnIndex) maxTurnIndex = tIdx;
    if (st.turnPrompt && (st.isTurnStart || !promptByTurn.has(tIdx))) {
      promptByTurn.set(tIdx, st.turnPrompt);
    }
  }
  for (const st of enrichedActiveSteps) {
    const tIdx = st.turnIndex;
    if (!Number.isInteger(tIdx) || tIdx <= 0) {
      st.turnIndex = null;
      st.isTurnStart = false;
      st.isLatestTurn = false;
      st.turnPrompt = '';
      continue;
    }
    st.isTurnStart = Boolean(st.isTurnStart);
    st.isLatestTurn = tIdx === maxTurnIndex;
    st.turnPrompt = promptByTurn.get(tIdx) || '';
  }

  const latestEnriched =
    enrichedActiveSteps.length > 0 ? enrichedActiveSteps[enrichedActiveSteps.length - 1] : null;
  const sessionAvgTokPerSec = roundMetric(sessionSpeed.avgTokPerSec);

  return {
    enrichedActiveSteps,
    latestEnriched,
    sessionSpeed,
    sessionTtft,
    sessionAvgTokPerSec,
    sessionCostUsd,
    sessionUnpricedCalls,
    sessionInputTokens,
    sessionCacheReadTokens,
    sessionOutputTokens,
  };
}

const CONTEXT_CHANNEL_KEYS = [
  'userInput',
  'assistant',
  'toolResults',
  'subagent',
  'checkpoint',
  'systemTools',
  'mcpTools',
  'skills',
  'systemPrompt',
  'userRules',
];

function resolveStepOutputTokens(st) {
  const explicitOut = Number(st?.outputTokens || 0);
  if (explicitOut > 0) return explicitOut;
  return Number(st?.thinkingTokens || 0) + Number(st?.responseTokens || 0);
}

/**
 * Hamilton 
 * 0 Token `targetTotal` 
 */
function scaleBucketsExact(buckets, keys, targetTotal) {
  const safeTarget = Math.max(0, Math.round(Number(targetTotal || 0)));
  const out = {};
  let currentSum = 0;
  for (const k of keys) {
    const val = Math.max(0, Number(buckets[k] || 0));
    out[k] = val;
    currentSum += val;
  }
  if (safeTarget === 0 || currentSum <= 0) {
    for (const k of keys) out[k] = 0;
    return out;
  }
  if (currentSum === safeTarget) {
    for (const k of keys) out[k] = Math.round(out[k]);
    return out;
  }
  const remainders = [];
  let assigned = 0;
  for (const k of keys) {
    const rawVal = out[k];
    if (rawVal <= 0) {
      out[k] = 0;
      continue;
    }
    const exact = (rawVal * safeTarget) / currentSum;
    const floored = Math.floor(exact);
    out[k] = floored;
    assigned += floored;
    remainders.push({ key: k, rem: exact - floored, orig: rawVal });
  }
  let diff = safeTarget - assigned;
  if (diff > 0 && remainders.length > 0) {
    remainders.sort((a, b) => b.rem - a.rem || b.orig - a.orig);
    for (let i = 0; i < diff; i++) {
      out[remainders[i % remainders.length].key] += 1;
    }
  }
  return out;
}

/**
 * 10 
 *
 * `chatStartMetadata.contextWindowMetadata` 
 * 1. API `inputTokens + cacheReadTokens` 10 
 * 2. `outputTokens` `assistantTokens` 
 * `contextTokens` 
 *
 * @param {object[]} enrichedActiveSteps
 * @param {object|null} latestEnriched
 * @param {number} sessionInputTokens
 * @param {number} sessionCacheReadTokens
 */
function extractActiveContextTelemetry(
  enrichedActiveSteps,
  latestEnriched,
  sessionInputTokens,
  sessionCacheReadTokens
) {
  let latestBreakdown = latestEnriched?.contextBreakdown || null;
  let breakdownIdx = latestBreakdown ? enrichedActiveSteps.length - 1 : -1;
  if (!latestBreakdown && !latestEnriched?.isCompactionStep) {
    for (let i = enrichedActiveSteps.length - 1; i >= 0; i--) {
      if (enrichedActiveSteps[i]?.isCompactionStep) {
        break;
      }
      if (enrichedActiveSteps[i]?.contextBreakdown) {
        latestBreakdown = enrichedActiveSteps[i].contextBreakdown;
        breakdownIdx = i;
        break;
      }
    }
  }
  const rawMessages = Number(latestBreakdown?.messagesTokens || 0);
  const hasGranularMsgBreakdown =
    Boolean(latestBreakdown) &&
    Object.prototype.hasOwnProperty.call(latestBreakdown, 'toolResultsTokens');
  let channels = {
    userInput: hasGranularMsgBreakdown
      ? Number(latestBreakdown?.userInputTokens || 0)
      : rawMessages,
    assistant: Number(latestBreakdown?.assistantTokens || 0),
    toolResults: Number(latestBreakdown?.toolResultsTokens || 0),
    subagent: Number(latestBreakdown?.subagentTokens || 0),
    checkpoint: Number(latestBreakdown?.checkpointTokens || 0),
    systemTools: Number(latestBreakdown?.systemToolsTokens || 0),
    mcpTools: Number(latestBreakdown?.mcpToolsTokens || 0),
    skills: Number(latestBreakdown?.skillsTokens || 0),
    systemPrompt: Number(latestBreakdown?.systemPromptTokens || 0),
    userRules: Number(latestBreakdown?.userRulesTokens || 0),
  };
  const msgSubtotal =
    channels.userInput +
    channels.assistant +
    channels.toolResults +
    channels.subagent +
    channels.checkpoint;
  if (rawMessages > msgSubtotal) {
    channels.userInput += rawMessages - msgSubtotal;
  }
  const rawBreakdownTotal = CONTEXT_CHANNEL_KEYS.reduce((sum, k) => sum + channels[k], 0);

  if (
    latestBreakdown &&
    breakdownIdx >= 0 &&
    !latestEnriched?.isCompactionStep &&
    rawBreakdownTotal > 0
  ) {
    const bdStep = enrichedActiveSteps[breakdownIdx];
    const bdPromptTokens =
      Number(bdStep?.inputTokens || 0) + Number(bdStep?.cacheReadTokens || 0);
    const bdOutTokens = resolveStepOutputTokens(bdStep);
    // API cacheReadTokens
    if (bdPromptTokens >= rawBreakdownTotal * 0.5) {
      channels = scaleBucketsExact(channels, CONTEXT_CHANNEL_KEYS, bdPromptTokens);
      channels.assistant += bdOutTokens;
      let runningTotal = bdPromptTokens + bdOutTokens;

      for (let m = breakdownIdx + 1; m < enrichedActiveSteps.length; m++) {
        const stepM = enrichedActiveSteps[m];
        if (!stepM || stepM.isCompactionStep) break;
        const mPrompt =
          Number(stepM.inputTokens || 0) + Number(stepM.cacheReadTokens || 0);
        const mOut = resolveStepOutputTokens(stepM);
        if (mPrompt >= runningTotal * 0.5) {
          if (mPrompt > runningTotal) {
            const delta = mPrompt - runningTotal;
            if (enrichedActiveSteps[m - 1]?.hasToolCalls) {
              channels.toolResults += delta;
            } else {
              channels.userInput += delta;
            }
          } else if (mPrompt < runningTotal) {
            channels = scaleBucketsExact(channels, CONTEXT_CHANNEL_KEYS, mPrompt);
          }
          channels.assistant += mOut;
          runningTotal = mPrompt + mOut;
        }
      }
    }
  }

  const ctxUserInput = channels.userInput;
  const ctxAssistant = channels.assistant;
  const ctxToolResults = channels.toolResults;
  const ctxSubagent = channels.subagent;
  const ctxCheckpoint = channels.checkpoint;
  const ctxMessages =
    ctxUserInput + ctxAssistant + ctxToolResults + ctxSubagent + ctxCheckpoint;
  const ctxSystemTools = channels.systemTools;
  const ctxMcpTools = channels.mcpTools;
  const ctxSkills = channels.skills;
  const ctxSystemPrompt = channels.systemPrompt;
  const ctxUserRules = channels.userRules;
  const ctxBreakdownTotal =
    ctxMessages + ctxSystemTools + ctxMcpTools + ctxSkills + ctxSystemPrompt + ctxUserRules;

  const ctxCached = latestEnriched?.cacheReadTokens || 0;
  const ctxFreshInput = latestEnriched?.inputTokens || 0;
  const ctxThinking = latestEnriched?.thinkingTokens || 0;
  const ctxResponse = latestEnriched?.responseTokens || 0;
  const ctxOut = resolveStepOutputTokens(latestEnriched);
  const ctxTotal =
    ctxBreakdownTotal > 0 ? ctxBreakdownTotal : ctxCached + ctxFreshInput + ctxOut;
  const compactionLimitTokens = Number(latestEnriched?.maxContextBudgetTokens || 256000);
  const compactionUsedTokens = Number(
    ctxTotal || latestEnriched?.estimatedContextTokens || ctxCached + ctxFreshInput
  );
  const compactionUsedPct =
    compactionLimitTokens > 0
      ? Math.min(100, +((compactionUsedTokens / compactionLimitTokens) * 100).toFixed(2))
      : 0;

  const ctxLimit = compactionLimitTokens;
  const ctxPct = ctxLimit > 0 ? Math.min(100, +((ctxTotal / ctxLimit) * 100).toFixed(2)) : 0;

  const latestPromptTokens = ctxCached + ctxFreshInput;
  const latestCacheHitPct =
    latestPromptTokens > 0 ? +((ctxCached / latestPromptTokens) * 100).toFixed(1) : 0;
  const sessionPromptTokens = sessionCacheReadTokens + sessionInputTokens;
  const sessionCacheHitPct =
    sessionPromptTokens > 0 ? +((sessionCacheReadTokens / sessionPromptTokens) * 100).toFixed(1) : 0;

  return {
    latestCacheHitPct,
    sessionCacheHitPct,
    context: {
      totalTokens: ctxTotal,
      limitTokens: ctxLimit,
      usedPct: ctxPct,
      compactionUsedTokens,
      compactionLimitTokens,
      compactionUsedPct,
      messagesTokens: ctxMessages,
      userInputTokens: ctxUserInput,
      assistantTokens: ctxAssistant,
      toolResultsTokens: ctxToolResults,
      subagentTokens: ctxSubagent,
      checkpointTokens: ctxCheckpoint,
      systemToolsTokens: ctxSystemTools,
      mcpToolsTokens: ctxMcpTools,
      skillsTokens: ctxSkills,
      systemPromptTokens: ctxSystemPrompt,
      userRulesTokens: ctxUserRules,
      cachedTokens: ctxCached,
      freshInputTokens: ctxFreshInput,
      thinkingTokens: ctxThinking,
      responseTokens: ctxResponse,
    },
  };
}

function prepareAgentSteps(rawSteps, resolveStepModel, upstream, agentFields, reuseInputs) {
  for (const [key, model] of readTrajectoryModelFacts(rawSteps).upstream) upstream.set(key, model);
  const previous = lastMainPreparation;
  if (reuseInputs && previous?.rawSteps === rawSteps &&
    isDeepStrictEqual(previous.inputs, reuseInputs) && isDeepStrictEqual(previous.upstream, upstream)) {
    const prepared = previous.prepared.deref();
    if (prepared) return prepared;
  }
  const enrichedRes = enrichActiveConversationSteps(rawSteps, resolveStepModel, upstream, agentFields);
  const taggedSteps = enrichedRes.enrichedActiveSteps;
  const prepared = {
    enrichedRes,
    recentSteps: taggedSteps.slice().reverse(),
    ctxRes: extractActiveContextTelemetry(taggedSteps, enrichedRes.latestEnriched,
      enrichedRes.sessionInputTokens, enrichedRes.sessionCacheReadTokens),
    modelBreakdown: buildScopedModelBreakdown(taggedSteps, resolveStepModel),
  };
  
  if (reuseInputs) {
    lastMainPreparation = { rawSteps, inputs: reuseInputs, upstream, prepared: new WeakRef(prepared) };
  }
  return prepared;
}

/**
 * 
 */
function buildAgentUnitTelemetry({
  agentId,
  cascadeId,
  isMain,
  index,
  shortLabel,
  badgeText,
  role,
  typeName,
  agentLabel,
  status,
  rawSteps,
  liveActivity = null,
  fallbackLastModMs,
  resolveStepModel,
  knownUpstreamByModelKey,
  includeRecentSteps = true,
  reuseInputs = null,
}) {
  const { enrichedRes, ctxRes, modelBreakdown, recentSteps } = prepareAgentSteps(
    rawSteps,
    resolveStepModel,
    knownUpstreamByModelKey,
    {
      agentId,
      agentCascadeId: cascadeId,
      agentLabel,
      agentBadge: badgeText,
      agentRole: role,
      agentIndex: index,
      isSubagent: !isMain,
    },
    reuseInputs
  );
  const taggedSteps = enrichedRes.enrichedActiveSteps;
  const lastModifiedMs =
    enrichedRes.latestEnriched?.createdAtMs || fallbackLastModMs || 0;
  const isRunning = status === 'CASCADE_RUN_STATUS_RUNNING';
  const resolvedLiveActivity = isRunning
    ? liveActivity ||
      extractLiveActivity([], true, lastModifiedMs || fallbackLastModMs || 0)
    : null;

  return {
    enrichedRes,
    taggedSteps,
    recentSteps,
    ctxRes,
    telemetryUnit: {
      agentId,
      cascadeId,
      isMain,
      index,
      shortLabel,
      badgeText,
      role,
      typeName,
      isRunning,
      status: status || 'IDLE',
      liveActivity: resolvedLiveActivity,
      stepCount: taggedSteps.length,
      latestTokPerSec: enrichedRes.latestEnriched?.tokPerSec ?? null,
      latestTtftSec: enrichedRes.latestEnriched?.ttftSec ?? null,
      latestSpeedReason: enrichedRes.latestEnriched?.selectedSpeedReason ?? null,
      avgTokPerSec: enrichedRes.sessionAvgTokPerSec,
      speedSummary: enrichedRes.sessionSpeed,
      ttftSummary: enrichedRes.sessionTtft,
      latestStepCostUsd: enrichedRes.latestEnriched?.costUsd ?? null,
      sessionCostUsd: roundSessionCost(enrichedRes.sessionCostUsd),
      sessionUnpricedCalls: enrichedRes.sessionUnpricedCalls,
      inputTokens: enrichedRes.sessionInputTokens,
      cacheReadTokens: enrichedRes.sessionCacheReadTokens,
      outputTokens: enrichedRes.sessionOutputTokens,
      totalTokens:
        enrichedRes.sessionInputTokens +
        enrichedRes.sessionCacheReadTokens +
        enrichedRes.sessionOutputTokens,
      latestPromptTokens: enrichedRes.latestEnriched
        ? Number(enrichedRes.latestEnriched.inputTokens || 0) +
          Number(enrichedRes.latestEnriched.cacheReadTokens || 0)
        : 0,
      latestCacheHitPct: ctxRes.latestCacheHitPct,
      sessionCacheHitPct: ctxRes.sessionCacheHitPct,
      activeModelShort: enrichedRes.latestEnriched?.modelShort || 'Unknown Model',
      activeModelLabel: enrichedRes.latestEnriched?.modelLabel || 'Unknown Model',
      activeModelUpstream:
        enrichedRes.latestEnriched?.modelUpstream ||
        enrichedRes.latestEnriched?.modelShort ||
        'Unknown Model',
      context: ctxRes.context,
      ...(includeRecentSteps ? { recentSteps } : {}),
      modelBreakdown,
      lastModifiedMs,
    },
  };
}

const TURN_END_QUOTA_COOLDOWN_MS = 3000;
const TURN_END_QUOTA_MIN_CACHE_AGE_MS = 1500;
const quotaTurnTracker = new Map();

export function evaluateSmartTurnEndQuotaRefresh(trackerState, isAnyRunningNow, initialQuotaInfo, nowMs = Date.now()) {
  const prevRunning = Boolean(trackerState?.wasAnyRunning);
  const lastRefreshAt = Number(trackerState?.lastRefreshAtMs || 0);
  const justFinishedTurn = prevRunning && !isAnyRunningNow;
  const shouldRefresh = Boolean(
    justFinishedTurn &&
    initialQuotaInfo?.fromCache === true &&
    nowMs - Number(initialQuotaInfo.fetchedAtMs || 0) >= TURN_END_QUOTA_MIN_CACHE_AGE_MS &&
    nowMs - lastRefreshAt >= TURN_END_QUOTA_COOLDOWN_MS
  );
  return {
    shouldRefresh,
    nextState: {
      wasAnyRunning: Boolean(isAnyRunningNow),
      lastRefreshAtMs: shouldRefresh ? nowMs : lastRefreshAt,
    },
  };
}

async function readTelemetrySources(requestedConvId, forceQuotaRefresh, currentAccountName, accountScope, userStatus) {
  let [allTrajRes, officialQuotaInfo, contextModelCatalog] = await Promise.all([
    callLsRpc('GetAllCascadeTrajectories', {}).catch(() => ({})),
    userStatus ? getOfficialQuotaSummary(forceQuotaRefresh, currentAccountName) : null,
    getContextModelCatalog(),
  ]);

  const sessions = await enumerateAndSyncConversations({
    summariesObj: allTrajRes?.trajectorySummaries || {},
    currentAccountName: accountScope,
    requestedConvId,
    forceRefresh: forceQuotaRefresh,
  });

  if (userStatus && !forceQuotaRefresh) {
    const trackerKey = currentAccountName || '__default__';
    const isAnyRunningNow = Array.isArray(sessions?.conversations)
      ? sessions.conversations.some((c) => c?.status === 'CASCADE_RUN_STATUS_RUNNING' || c?.isRunning === true)
      : false;
    const { shouldRefresh, nextState } = evaluateSmartTurnEndQuotaRefresh(
      quotaTurnTracker.get(trackerKey),
      isAnyRunningNow,
      officialQuotaInfo,
      Date.now()
    );
    quotaTurnTracker.set(trackerKey, nextState);
    if (shouldRefresh) {
      officialQuotaInfo = await getOfficialQuotaSummary(true, currentAccountName);
    }
  }

  return { officialQuotaInfo, contextModelCatalog, sessions };
}

function getTelemetrySources(requestedConvId, forceQuotaRefresh, currentAccountName, accountScope, userStatus) {
  const read = () => readTelemetrySources(
    requestedConvId, forceQuotaRefresh, currentAccountName, accountScope, userStatus
  );
  if (forceQuotaRefresh) return read();
  const key = JSON.stringify([requestedConvId || '', accountScope, Boolean(userStatus)]);
  const existing = inFlightTelemetrySources.get(key);
  if (existing) return existing;
  const pending = read().finally(() => {
    inFlightTelemetrySources.delete(key);
  });
  inFlightTelemetrySources.set(key, pending);
  return pending;
}

/**
 * 
 *
 * @param {string} requestedConvId ID 
 * @param {boolean} [forceQuotaRefresh=false] 
 * @param {{ range?: string, startMs?: number, endMs?: number }} [filterOpts={}] 
 * @returns {Promise<object>}
 */
export async function buildTelemetryPayloadInternal(
  requestedConvId,
  forceQuotaRefresh = false,
  filterOpts = {}
) {
  const settings = loadSettings();
  let userStatus = await callLsRpc('GetUserStatus', {})
    .then((data) => data?.userStatus)
    .catch(() => null);
  if (
    !userStatus &&
    lsRuntimeEndpoint.addr !== 'test.invalid' &&
    (!lsRuntimeEndpoint.baseUrl || lsRuntimeEndpoint.isDynamic)
  ) {
    const prevBaseUrl = lsRuntimeEndpoint.baseUrl;
    const prevCsrf = lsRuntimeEndpoint.csrfToken;
    await ensureLsEndpointDiscovered({
      force: true,
      respectCooldown: !forceQuotaRefresh,
    });
    if (
      lsRuntimeEndpoint.baseUrl &&
      (lsRuntimeEndpoint.baseUrl !== prevBaseUrl || lsRuntimeEndpoint.csrfToken !== prevCsrf)
    ) {
      userStatus = await callLsRpc('GetUserStatus', {})
        .then((data) => data?.userStatus)
        .catch(() => null);
    }
  }
  const currentAccountName = userStatus?.email || userStatus?.name || '';
  const accountStatus = currentAccountName ? 'signedIn' :
    userStatus && !userStatus.userTier && !userStatus.planStatus ? 'signedOut' : 'unknown';
  const accountScope = accountStatus === 'signedOut' ? null : currentAccountName;
  const { officialQuotaInfo, contextModelCatalog, sessions } = await getTelemetrySources(
    requestedConvId, forceQuotaRefresh, currentAccountName, accountScope, userStatus
  );
  const { conversations, activeConvSummary, activeCascadeId } = sessions;

  const officialQuota = officialQuotaInfo?.data || null;
  const clientConfigs = userStatus?.cascadeModelConfigData?.clientModelConfigs || [];

  
  const { dynamicModelMap, quotaPoolsMap } = buildOfficialQuotaPools(
    officialQuota,
    clientConfigs
  );

  const resolveStepModel = createStepModelResolver(
    dynamicModelMap,
    settings.customModelPricing
  );

  // 3. Compute metrics, 10-channel context breakdown, and model summary for active root session + subagents
  const reportedContextLimits = new Map();
  const knownUpstreamByModelKey = buildKnownUpstreamModelMap(reportedContextLimits, currentAccountName);
  const activeEntry = findTrajectoryCacheEntry(activeCascadeId);
  const activeSteps = activeEntry?.steps || [];
  const subagentSummaries = activeConvSummary?.subagents || [];
  if (subagentSummaries.length) lastMainPreparation = null;
  const modelInputs = {
    catalogRevision: pricingCatalogRevision,
    dynamicModelMap,
    customModelPricing: settings.customModelPricing || {},
  };
  const mainUnit = buildAgentUnitTelemetry({
    agentId: 'main',
    cascadeId: activeCascadeId,
    isMain: true,
    index: 0,
    shortLabel: 'Main Agent',
    badgeText: 'Main',
    role: 'Main Agent',
    typeName: 'root',
    agentLabel: 'Main Agent',
    status: activeConvSummary?.status || 'IDLE',
    rawSteps: activeSteps,
    liveActivity: activeConvSummary?.liveActivity || null,
    fallbackLastModMs: activeConvSummary?.lastModifiedMs || activeEntry?.lastModifiedMs || 0,
    resolveStepModel,
    knownUpstreamByModelKey,
    includeRecentSteps: false,
    reuseInputs: subagentSummaries.length ? null : { ...modelInputs, activeCascadeId, accountScope },
  });

  const enrichedActiveSteps = mainUnit.taggedSteps;
  const {
    latestEnriched,
    sessionSpeed,
    sessionTtft,
    sessionAvgTokPerSec,
    sessionCostUsd,
    sessionUnpricedCalls,
    sessionInputTokens,
    sessionCacheReadTokens,
    sessionOutputTokens,
  } = mainUnit.enrichedRes;
  const { latestCacheHitPct, sessionCacheHitPct, context } = mainUnit.ctxRes;
  const mainAgentTelemetry = mainUnit.telemetryUnit;
  const mainModelBreakdown = mainAgentTelemetry.modelBreakdown;

  const activeFamilyCascadeIds = new Set(activeCascadeId ? [activeCascadeId.toLowerCase()] : []);
  const subAgentTelemetries = [];
  const allCombinedRawSteps = subagentSummaries.length ? activeSteps.slice() : [];
  const allCombinedEnrichedSteps = subagentSummaries.length ? enrichedActiveSteps.slice() : [];
  let totalRawSessionCostUsd = sessionCostUsd;
  let totalFamilyInputTokens = sessionInputTokens;
  let totalFamilyCacheReadTokens = sessionCacheReadTokens;
  let totalFamilyOutputTokens = sessionOutputTokens;

  for (let idx = 0; idx < subagentSummaries.length; idx++) {
    const subSum = subagentSummaries[idx];
    const subCid = subSum.cascadeId;
    activeFamilyCascadeIds.add(String(subCid || '').toLowerCase());
    const subEntry = findTrajectoryCacheEntry(subCid);
    const subRawSteps = subEntry?.steps || [];
    for (const step of subRawSteps) allCombinedRawSteps.push(step);

    const subSpec = subSum.subagentSpec || subEntry?.subagentSpec || null;
    const rawRole =
      subSpec?.role || subSum.agentScriptName || subEntry?.agentScriptName || subSpec?.typeName || '';
    const subIndex = idx + 1;
    const shortLabel = `Subagent #${subIndex}`;
    const badgeText = `Sub ${subIndex}`;
    const roleLabel = rawRole || 'Subagent';
    const typeName = subSpec?.typeName || '';

    const subUnit = buildAgentUnitTelemetry({
      agentId: subCid,
      cascadeId: subCid,
      isMain: false,
      index: subIndex,
      shortLabel,
      badgeText,
      role: roleLabel,
      typeName,
      agentLabel: rawRole ? `${shortLabel} · ${rawRole}` : shortLabel,
      status: subSum.status || 'IDLE',
      rawSteps: subRawSteps,
      liveActivity: subSum.liveActivity || null,
      fallbackLastModMs: subSum.lastModifiedMs || subEntry?.lastModifiedMs || 0,
      resolveStepModel,
      knownUpstreamByModelKey,
      includeRecentSteps: true,
    });

    for (const step of subUnit.taggedSteps) allCombinedEnrichedSteps.push(step);
    totalRawSessionCostUsd += subUnit.enrichedRes.sessionCostUsd;
    totalFamilyInputTokens += subUnit.enrichedRes.sessionInputTokens;
    totalFamilyCacheReadTokens += subUnit.enrichedRes.sessionCacheReadTokens;
    totalFamilyOutputTokens += subUnit.enrichedRes.sessionOutputTokens;
    subAgentTelemetries.push(subUnit.telemetryUnit);
  }

  const allAgents = [mainAgentTelemetry, ...subAgentTelemetries];
  let aggregatedTelemetry = mainAgentTelemetry;

  if (subAgentTelemetries.length > 0) {
    allCombinedRawSteps.sort(
      (a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0) || (a.stepIndex || 0) - (b.stepIndex || 0)
    );
    allCombinedEnrichedSteps.sort(
      (a, b) =>
        (a.createdAtMs || 0) - (b.createdAtMs || 0) ||
        (a.agentIndex || 0) - (b.agentIndex || 0) ||
        (a.stepIndex || 0) - (b.stepIndex || 0)
    );

    
    const mainTurnByIdx = new Map();
    let maxRootTurn = 0;
    for (const mSt of enrichedActiveSteps) {
      const tIdx = mSt.turnIndex;
      if (!Number.isInteger(tIdx) || tIdx <= 0) continue;
      if (tIdx > maxRootTurn) maxRootTurn = tIdx;
      if (!mainTurnByIdx.has(tIdx) || mSt.isTurnStart) {
        mainTurnByIdx.set(tIdx, {
          turnIndex: tIdx,
          startMs: mSt.createdAtMs || 0,
          prompt: mSt.turnPrompt || '',
        });
      }
    }
    const mainTurns = Array.from(mainTurnByIdx.values()).sort(
      (a, b) => a.turnIndex - b.turnIndex
    );
    if (mainTurns.length > 0) {
      const seenRootStarts = new Set();
      for (const st of allCombinedEnrichedSteps) {
        let matched = null;
        if (!st.isSubagent && Number.isInteger(st.turnIndex) && st.turnIndex > 0) {
          matched = mainTurnByIdx.get(st.turnIndex) || null;
        } else {
          const ts = st.createdAtMs || 0;
          for (let k = mainTurns.length - 1; k >= 0; k--) {
            if (ts >= mainTurns[k].startMs) {
              matched = mainTurns[k];
              break;
            }
          }
          if (!matched) matched = mainTurns[0];
        }
        if (matched) {
          st.rootTurnIndex = matched.turnIndex;
          st.isRootLatestTurn = matched.turnIndex === maxRootTurn;
          st.rootTurnPrompt = matched.prompt || '';
          if (!seenRootStarts.has(matched.turnIndex)) {
            seenRootStarts.add(matched.turnIndex);
            st.isRootTurnStart = true;
          } else {
            st.isRootTurnStart = false;
          }
        }
      }
    }
    const combinedSpeed = summarizeSpeed(allCombinedRawSteps);
    const combinedTtft = summarizeTtft(allCombinedRawSteps);
    const combinedAvgTokPerSec = roundMetric(combinedSpeed.avgTokPerSec);
    const combinedModelBreakdown = buildScopedModelBreakdown(
      allCombinedEnrichedSteps,
      resolveStepModel
    );

    const runningAgent = allAgents.find((a) => a.isRunning);
    const latestActiveAgent =
      runningAgent ||
      allAgents
        .slice()
        .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0] ||
      mainAgentTelemetry;

    const agentsWithSteps = allAgents.filter((a) => a.stepCount > 0);
    const latestMetricAgent =
      latestActiveAgent.stepCount > 0
        ? latestActiveAgent
        : agentsWithSteps.find((a) => a.isRunning) ||
          agentsWithSteps
            .slice()
            .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0] ||
          latestActiveAgent;

    const totalCostUsd = roundSessionCost(totalRawSessionCostUsd);
    const totalUnpricedCalls = allAgents.reduce(
      (sum, a) => sum + (a.sessionUnpricedCalls || 0),
      0
    );
    const totalFamilyPromptTokens = totalFamilyInputTokens + totalFamilyCacheReadTokens;
    const combinedSessionCacheHitPct =
      totalFamilyPromptTokens > 0
        ? +((totalFamilyCacheReadTokens / totalFamilyPromptTokens) * 100).toFixed(1)
        : 0;

    const runningSubs = subAgentTelemetries.filter((a) => a.isRunning);
    const primaryRunningSub = runningSubs
      .slice()
      .sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0))[0];
    const activeActivityAgent =
      primaryRunningSub || (mainAgentTelemetry.isRunning ? mainAgentTelemetry : null);
    const aggregatedLiveActivity = activeActivityAgent?.liveActivity
      ? {
          ...activeActivityAgent.liveActivity,
          agentId: activeActivityAgent.agentId,
          agentBadge: activeActivityAgent.badgeText,
          agentShortLabel: activeActivityAgent.shortLabel,
          agentRole: activeActivityAgent.role,
          agentIndex: activeActivityAgent.index,
          isMain: Boolean(activeActivityAgent.isMain),
          parallelCount: runningSubs.length > 1 ? runningSubs.length : 1,
        }
      : null;

    aggregatedTelemetry = {
      agentId: 'all',
      cascadeId: activeCascadeId,
      isMain: false,
      index: -1,
      shortLabel: 'All Summary',
      badgeText: 'All',
      role: `Main + ${subAgentTelemetries.length} Subagents`,
      typeName: 'all',
      activeAgentId: latestActiveAgent.agentId,
      activeAgentShortLabel: latestActiveAgent.shortLabel,
      activeAgentBadge: latestActiveAgent.badgeText,
      activeAgentRole: latestActiveAgent.role,
      isRunning: allAgents.some((a) => a.isRunning),
      status: allAgents.some((a) => a.isRunning) ? 'CASCADE_RUN_STATUS_RUNNING' : 'IDLE',
      liveActivity: aggregatedLiveActivity,
      stepCount: allCombinedEnrichedSteps.length,
      latestTokPerSec: latestMetricAgent.latestTokPerSec,
      latestTtftSec: latestMetricAgent.latestTtftSec,
      latestSpeedReason: latestMetricAgent.latestSpeedReason,
      avgTokPerSec: combinedAvgTokPerSec,
      speedSummary: combinedSpeed,
      ttftSummary: combinedTtft,
      latestStepCostUsd: latestMetricAgent.latestStepCostUsd,
      sessionCostUsd: totalCostUsd,
      sessionUnpricedCalls: totalUnpricedCalls,
      inputTokens: totalFamilyInputTokens,
      cacheReadTokens: totalFamilyCacheReadTokens,
      outputTokens: totalFamilyOutputTokens,
      totalTokens: totalFamilyInputTokens + totalFamilyCacheReadTokens + totalFamilyOutputTokens,
      latestPromptTokens: latestMetricAgent.latestPromptTokens ?? 0,
      latestCacheHitPct: latestMetricAgent.latestCacheHitPct,
      sessionCacheHitPct: combinedSessionCacheHitPct,
      activeModelShort: latestMetricAgent.activeModelShort,
      activeModelLabel: latestMetricAgent.activeModelLabel,
      activeModelUpstream: latestMetricAgent.activeModelUpstream,
      context: latestMetricAgent.context,
      modelBreakdown: combinedModelBreakdown,
      lastModifiedMs: latestActiveAgent.lastModifiedMs,
    };
  }

  // 4. quota-pools.mjs Other Claude & GPT
  const latestFamilyStep =
    allCombinedEnrichedSteps.length > 0
      ? allCombinedEnrichedSteps[allCombinedEnrichedSteps.length - 1]
      : latestEnriched;
  const hasResolvedStepModel = Boolean(
    latestFamilyStep && latestFamilyStep.modelKey && latestFamilyStep.modelKey !== 'unknown'
  );
  const latestIsCarbon = hasResolvedStepModel
    ? isCarbonModelIdentifier(
        latestFamilyStep.modelKey,
        latestFamilyStep.responseModel,
        latestFamilyStep.modelUpstream,
        latestFamilyStep.modelLabel
      )
    : false;
  const latestIsArgon = hasResolvedStepModel
    ? isArgonModelIdentifier(
        latestFamilyStep.modelKey,
        latestFamilyStep.responseModel,
        latestFamilyStep.modelUpstream,
        latestFamilyStep.modelLabel
      )
    : false;
  const rawActiveFamily = latestFamilyStep?.family || 'Other';
  let fallbackOfficialPoolKey = 'Unknown';
  if (!hasResolvedStepModel) {
    for (const pk of POOL_PRIORITY_ORDER) {
      const candidate = quotaPoolsMap.get(pk);
      if (candidate?.isAvailable && (candidate.has5h || candidate.hasWeekly)) {
        fallbackOfficialPoolKey = pk;
        break;
      }
    }
    if (fallbackOfficialPoolKey === 'Unknown') {
      for (const [pk, candidate] of quotaPoolsMap.entries()) {
        if (candidate?.isAvailable && (candidate.has5h || candidate.hasWeekly)) {
          fallbackOfficialPoolKey = pk;
          break;
        }
      }
    }
  }
  const activePoolKey = !hasResolvedStepModel
    ? fallbackOfficialPoolKey
    : latestIsCarbon && quotaPoolsMap.has('Carbon')
      ? 'Carbon'
      : latestIsArgon && quotaPoolsMap.has('Argon')
        ? 'Argon'
        : rawActiveFamily === 'Gemini'
          ? 'Gemini'
          : ['Claude', 'GPT', 'Other'].includes(rawActiveFamily)
            ? 'Claude & GPT'
            : 'Unknown';
  const matchedActivePool = quotaPoolsMap.get(activePoolKey) || null;
  const activeLive5h = matchedActivePool?.has5h
    ? {
        remainingPct: matchedActivePool.remainingPct,
        remainingIntPct: matchedActivePool.remainingIntPct,
        usedPct: matchedActivePool.usedPct,
        resetTime: matchedActivePool.resetTime,
      }
    : null;
  const activeLiveWeekly = matchedActivePool?.hasWeekly
    ? {
        remainingPct: matchedActivePool.weeklyRemainingPct,
        remainingIntPct: matchedActivePool.weeklyRemainingIntPct,
        usedPct: matchedActivePool.weeklyUsedPct,
        resetTime: matchedActivePool.weeklyResetTime,
      }
    : null;

  // Gemini -> Argon -> Carbon -> Claude & GPT
  // consumption.presets.week / 5h
  let accountFiveHourResetMs = 0;
  let accountWeeklyResetMs = 0;
  for (const pk of POOL_PRIORITY_ORDER) {
    const pool = quotaPoolsMap.get(pk);
    if (!pool) continue;
    if (!accountFiveHourResetMs && pool.resetTime) {
      accountFiveHourResetMs = parseIsoMs(pool.resetTime);
    }
    if (!accountWeeklyResetMs && pool.weeklyResetTime) {
      accountWeeklyResetMs = parseIsoMs(pool.weeklyResetTime);
    }
  }
  const cycleAnchors = {
    fiveHourResetMs: accountFiveHourResetMs || parseIsoMs(activeLive5h?.resetTime),
    weeklyResetMs: accountWeeklyResetMs || parseIsoMs(activeLiveWeekly?.resetTime),
  };

  // 5. + + + + +
  const {
    selectedWindow,
    trendStartMs,
    trendEndMs,
    finalizedSelectedSession,
    finalizedSelectedAccount,
    finalizedPresets,
    trendSeries,
    sourcesBreakdown,
    currentYear,
    monthlySeries,
    weekBucket,
    modelBreakdown,
    poolCycleStats,
    poolsWeeklySummary,
  } = aggregateMultiWindowUsage({
    filterOpts,
    cycleAnchors,
    currentAccountName: accountScope,
    activeCascadeId,
    activeFamilyCascadeIds,
    resolveStepModel,
    quotaPoolsMap,
    modelInputs,
  });

  const emptyCycleSummary = () => ({
    calls: 0,
    tokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  });
  for (const [pk, poolObj] of quotaPoolsMap.entries()) {
    const pStats = poolCycleStats?.get(pk);
    poolObj.cycle5h = pStats?.cycle5h || emptyCycleSummary();
    poolObj.cycleWeekly = pStats?.cycleWeekly || emptyCycleSummary();
  }

  
  const familyPoolQuota = quotaPoolsMap.get(activePoolKey);
  const activePoolLabel = familyPoolQuota?.poolLabel || activePoolKey;
  const activePoolQuota = familyPoolQuota || {
    poolKey: activePoolKey,
    poolLabel: activePoolKey === 'Unknown' ? 'Unknown' : activePoolKey,
    poolName:
      activePoolKey === 'Carbon'
        ? 'Gemini 4 Carbon Pool'
        : activePoolKey === 'Argon'
          ? 'Gemini 4 Argon Pool'
          : activePoolKey === 'Gemini'
            ? 'Gemini Pool'
            : activePoolKey === 'Claude & GPT'
              ? 'Claude & GPT Pool'
              : activePoolKey && activePoolKey !== 'Unknown'
                ? `${activePoolKey} Pool`
                : 'Unknown Pool',
    family: activePoolKey,
    isAvailable: Boolean(activeLive5h || activeLiveWeekly),
    has5h: Boolean(activeLive5h),
    hasWeekly: Boolean(activeLiveWeekly),
    remainingPct: activeLive5h?.remainingPct ?? null,
    remainingIntPct: activeLive5h?.remainingIntPct ?? null,
    usedPct: activeLive5h?.usedPct ?? null,
    resetTime: activeLive5h?.resetTime || null,
    weeklyRemainingPct: activeLiveWeekly?.remainingPct ?? null,
    weeklyRemainingIntPct: activeLiveWeekly?.remainingIntPct ?? null,
    weeklyUsedPct: activeLiveWeekly?.usedPct ?? null,
    weeklyResetTime: activeLiveWeekly?.resetTime || null,
    cycle5h: emptyCycleSummary(),
    cycleWeekly: emptyCycleSummary(),
    models: [],
  };

  const fallbackWeeklyPct =
    settings.weeklyLimitMode === 'custom_cost'
      ? weekBucket.unpricedCalls > 0
        ? null
        : Math.min(
            100,
            +((weekBucket.costUsd / Math.max(1, settings.weeklyCostBudget)) * 100).toFixed(1)
          )
      : Math.min(
          100,
          +((weekBucket.totalTokens / Math.max(1000, settings.weeklyTokenBudget)) * 100).toFixed(1)
        );

  const isCustomWeeklyMode =
    settings.weeklyLimitMode === 'custom_tokens' || settings.weeklyLimitMode === 'custom_cost';
  const useOfficialWeekly = Boolean(activeLiveWeekly) && !isCustomWeeklyMode;

  const weeklyUsedPct = useOfficialWeekly
    ? activeLiveWeekly.usedPct
    : isCustomWeeklyMode
      ? fallbackWeeklyPct
      : null;
  const weeklyRemainingPct = useOfficialWeekly
    ? activeLiveWeekly.remainingPct
    : isCustomWeeklyMode && fallbackWeeklyPct !== null
      ? +(100 - fallbackWeeklyPct).toFixed(1)
      : null;
  const weeklyRemainingIntPct = useOfficialWeekly
    ? activeLiveWeekly.remainingIntPct
    : isCustomWeeklyMode && fallbackWeeklyPct !== null
      ? Math.max(0, Math.floor(100 - fallbackWeeklyPct))
      : null;

  const g1CreditEntry = (userStatus?.userTier?.availableCredits || []).find(
    (c) => c?.creditType === 'GOOGLE_ONE_AI'
  );
  const realAiCredits = Number(g1CreditEntry?.creditAmount || 0);
  const uiBundleVersion = computeRuntimeCodeVersion();

  const rawTierName = userStatus?.userTier?.name || '';
  const inferredPlanFallback = /\bfree\b/i.test(rawTierName)
    ? 'Free'
    : /\bultra\b/i.test(rawTierName)
      ? 'Ultra'
      : 'Pro';
  const resolvedPlanName = userStatus?.planStatus?.planInfo?.planName || inferredPlanFallback;

  // RPC
  const quickStatsMemo = new Map();
  const getConversationQuickStats = (rootConv) => {
    const cidKey = String(rootConv?.cascadeId || '').toLowerCase();
    if (cidKey && quickStatsMemo.has(cidKey)) {
      return quickStatsMemo.get(cidKey);
    }
    const rootEntry = findTrajectoryCacheEntry(rootConv?.cascadeId);
    const rootSteps = rootEntry?.steps || [];
    const rawSubs = Array.isArray(rootConv?.subagents) ? rootConv.subagents : [];

    let totalCost = 0;
    let unpricedCalls = 0;
    let totalTokens = 0;
    const allConvSteps = [];
    const accumulateStepsQuick = (steps) => {
      for (const st of steps) {
        allConvSteps.push(st);
        totalTokens +=
          Number(st?.inputTokens || 0) +
          Number(st?.cacheReadTokens || 0) +
          resolveStepOutputTokens(st);
        const mInfo = resolveStepModel(st);
        const c = computeStepCost(st, mInfo.pricing);
        if (c === null) unpricedCalls += 1;
        else totalCost += c;
      }
    };
    accumulateStepsQuick(rootSteps);

    const lastRootStep = rootSteps.length > 0 ? rootSteps[rootSteps.length - 1] : null;
    let bestMetricStep = lastRootStep;
    let bestMetricRunning = rootConv?.status === 'CASCADE_RUN_STATUS_RUNNING' && Boolean(lastRootStep);

    for (const subSum of rawSubs) {
      const subEntry = findTrajectoryCacheEntry(subSum?.cascadeId);
      const subSteps = subEntry?.steps || [];
      if (subSteps.length === 0) continue;
      accumulateStepsQuick(subSteps);
      const lastSub = subSteps[subSteps.length - 1];
      const subRunning = subSum?.status === 'CASCADE_RUN_STATUS_RUNNING';
      if (
        !bestMetricStep ||
        (subRunning && !bestMetricRunning) ||
        (subRunning === bestMetricRunning &&
          (lastSub.createdAtMs || 0) >= (bestMetricStep.createdAtMs || 0))
      ) {
        bestMetricStep = lastSub;
        bestMetricRunning = subRunning;
      }
    }

    let contextUsedPct = null;
    let contextLimitTokens = null;
    let contextTotalTokens = null;
    let contextBreakdown = null;
    if (lastRootStep) {
      const limitTokens = Number(lastRootStep.maxContextBudgetTokens || 256000);
      const cb = lastRootStep.contextBreakdown;
      if (cb) {
        const hasGranular = Object.prototype.hasOwnProperty.call(cb, 'toolResultsTokens');
        contextBreakdown = {
          assistantTokens: Number(cb.assistantTokens || 0),
          toolResultsTokens: Number(cb.toolResultsTokens || 0),
          userInputTokens: hasGranular
            ? Number(cb.userInputTokens || 0)
            : Number(cb.messagesTokens || 0),
          messagesTokens: Number(cb.messagesTokens || 0),
          subagentTokens: Number(cb.subagentTokens || 0),
          checkpointTokens: Number(cb.checkpointTokens || 0),
          systemPromptTokens: Number(cb.systemPromptTokens || 0),
          systemToolsTokens: Number(cb.systemToolsTokens || 0),
          mcpToolsTokens: Number(cb.mcpToolsTokens || 0),
          skillsTokens: Number(cb.skillsTokens || 0),
          userRulesTokens: Number(cb.userRulesTokens || 0),
        };
      }
      const cbTotal = cb
        ? Number(cb.messagesTokens || 0) +
          Number(cb.systemToolsTokens || 0) +
          Number(cb.mcpToolsTokens || 0) +
          Number(cb.skillsTokens || 0) +
          Number(cb.systemPromptTokens || 0) +
          Number(cb.userRulesTokens || 0)
        : 0;
      const apiPrompt =
        Number(lastRootStep.inputTokens || 0) + Number(lastRootStep.cacheReadTokens || 0);
      const apiOut = resolveStepOutputTokens(lastRootStep);
      const fallbackTotal = apiPrompt + apiOut;
      const estTotal = Math.max(cbTotal, Number(lastRootStep.estimatedContextTokens || 0));
      const hasAlignedApiPrompt =
        !lastRootStep.isCompactionStep &&
        apiPrompt > 0 &&
        (estTotal === 0 || apiPrompt >= estTotal * 0.5);
      const usedTokens = Number(
        hasAlignedApiPrompt
          ? fallbackTotal
          : cbTotal > 0
            ? cbTotal
            : lastRootStep.estimatedContextTokens || fallbackTotal
      );
      contextLimitTokens = limitTokens;
      contextTotalTokens = usedTokens;
      contextUsedPct =
        limitTokens > 0 ? Math.min(100, +((usedTokens / limitTokens) * 100).toFixed(2)) : 0;
    }

    let modelShort = '';
    let modelUpstream = '';
    let latestTokPerSec = null;
    let latestTtftSec = null;
    let latestStepCostUsd = null;
    let latestPromptTokens = 0;
    let latestCacheHitPct = null;
    if (bestMetricStep) {
      const mInfo = resolveStepModel(bestMetricStep);
      const resolvedResp =
        bestMetricStep.responseModel ||
        (bestMetricStep.modelKey && bestMetricStep.modelKey !== 'unknown'
          ? knownUpstreamByModelKey.get(bestMetricStep.modelKey) || ''
          : '');
      modelShort = mInfo.shortName || '';
      const rawQuickUpstream =
        resolvedResp ||
        (mInfo.modelId && mInfo.modelId !== 'unknown' ? mInfo.modelId : mInfo.shortName) ||
        '';
      modelUpstream = formatUpstreamModelId(rawQuickUpstream, mInfo);
      latestTokPerSec = roundMetric(speedMetric(bestMetricStep).value);
      latestTtftSec =
        bestMetricStep.nativeTtftSec != null && Number.isFinite(Number(bestMetricStep.nativeTtftSec))
          ? +Number(bestMetricStep.nativeTtftSec).toFixed(2)
          : null;
      const stepCost = computeStepCost(bestMetricStep, mInfo.pricing);
      latestStepCostUsd = stepCost === null ? null : +stepCost.toFixed(4);
      const inTok = Math.max(0, Number(bestMetricStep.inputTokens || 0));
      const cacheTok = Math.max(0, Number(bestMetricStep.cacheReadTokens || 0));
      latestPromptTokens = inTok + cacheTok;
      latestCacheHitPct =
        latestPromptTokens > 0 ? +((cacheTok / latestPromptTokens) * 100).toFixed(1) : 0;
    }
    const quickSpeedSummary = summarizeSpeed(allConvSteps);
    const avgTokPerSec = roundMetric(quickSpeedSummary.avgTokPerSec);

    const stats = {
      modelShort,
      modelUpstream,
      latestTokPerSec,
      latestTtftSec,
      avgTokPerSec,
      latestStepCostUsd,
      latestPromptTokens,
      latestCacheHitPct,
      totalTokens,
      contextUsedPct,
      contextLimitTokens,
      contextTotalTokens,
      contextBreakdown,
      sessionCostUsd: roundSessionCost(totalCost),
      sessionUnpricedCalls: unpricedCalls,
    };
    if (cidKey) {
      quickStatsMemo.set(cidKey, stats);
    }
    return stats;
  };

  
  const runningConversations = [];
  for (const rootConv of conversations) {
    const isMainRunning = rootConv.status === 'CASCADE_RUN_STATUS_RUNNING';
    const rawSubs = Array.isArray(rootConv.subagents) ? rootConv.subagents : [];
    const hasRunningSub = rawSubs.some((s) => s.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (!isMainRunning && !hasRunningSub) {
      continue;
    }

    const rootEntry = findTrajectoryCacheEntry(rootConv.cascadeId);
    const rootFallbackMs =
      rootConv.lastModifiedMs || rootEntry?.lastModifiedMs || rootConv.createdTimeMs || 0;

    const subItems = rawSubs.map((subSum, idx) => {
      const subCid = subSum.cascadeId;
      const subEntry = findTrajectoryCacheEntry(subCid);
      const subSpec = subSum.subagentSpec || subEntry?.subagentSpec || null;
      const rawRole =
        subSpec?.role ||
        subSum.agentScriptName ||
        subEntry?.agentScriptName ||
        subSpec?.typeName ||
        '';
      const subIndex = idx + 1;
      const badgeText = `Sub ${subIndex}`;
      const shortLabel = `Subagent #${subIndex}`;
      const role = rawRole || shortLabel;
      const isSubRunning = subSum.status === 'CASCADE_RUN_STATUS_RUNNING';
      const stepCount = Number(subSum.stepCount ?? subEntry?.steps?.length ?? 0);
      const subModMs = subSum.lastModifiedMs || subEntry?.lastModifiedMs || 0;
      const liveActivity = isSubRunning
        ? subSum.liveActivity || extractLiveActivity([], true, subModMs)
        : {
            phase: 'done',
            label: 'Done',
            detail: '',
            stepProgress: '',
            startedAtMs: subModMs,
            signature: `done:${stepCount}`,
          };
      return {
        cascadeId: subCid,
        index: subIndex,
        badgeText,
        shortLabel,
        role,
        typeName: subSpec?.typeName || '',
        isRunning: isSubRunning,
        status: subSum.status || 'IDLE',
        stepCount,
        lastModifiedMs: subModMs,
        liveActivity,
      };
    });

    const mainLiveAct = isMainRunning
      ? rootConv.liveActivity || extractLiveActivity([], true, rootFallbackMs)
      : null;

    const runningSubCount = subItems.filter((s) => s.isRunning).length;
    if (
      isMainRunning &&
      (mainLiveAct?.toolName === 'invoke_subagent' ||
        mainLiveAct?.label === 'Subagent' ||
        mainLiveAct?.label === 'Starting subagent') &&
      runningSubCount === 0
    ) {
      const pendingIndex = subItems.length + 1;
      const pendingRole = mainLiveAct.detail || 'Subagent';
      subItems.push({
        cascadeId: `${rootConv.cascadeId}:pending-sub-${pendingIndex}`,
        index: pendingIndex,
        badgeText: `Sub ${pendingIndex}`,
        shortLabel: `Subagent #${pendingIndex}`,
        role: pendingRole,
        typeName: '',
        isRunning: true,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        stepCount: 0,
        lastModifiedMs: rootFallbackMs,
        liveActivity: {
          phase: 'thinking',
          label: 'Starting',
          detail: '',
          stepProgress: '',
          startedAtMs: mainLiveAct.startedAtMs || 0,
          signature: `spawning-sub:${pendingIndex}:${pendingRole}`,
        },
      });
    }

    const runningSubList = subItems.filter((s) => s.isRunning);
    const resolvedMainActivity =
      mainLiveAct ||
      (runningSubList.length > 0
        ? {
            phase: 'waiting',
            label: 'Waiting for subagent',
            detail: runningSubList.map((s) => s.role).join(', '),
            stepProgress: '',
            startedAtMs: runningSubList[0]?.liveActivity?.startedAtMs || rootFallbackMs,
            signature: `wait-subs:${runningSubList.length}:${runningSubList[0]?.cascadeId || ''}`,
          }
        : extractLiveActivity([], true, rootFallbackMs));

    const qStats = getConversationQuickStats(rootConv);
    runningConversations.push({
      cascadeId: rootConv.cascadeId,
      title: rootConv.title || rootConv.cascadeId.slice(0, 8),
      isCurrentSelected:
        Boolean(activeCascadeId) &&
        rootConv.cascadeId.toLowerCase() === String(activeCascadeId).toLowerCase(),
      isMainRunning,
      isRunning: true,
      status: isMainRunning ? rootConv.status : 'CASCADE_RUN_STATUS_RUNNING',
      stepCount: Number(rootConv.stepCount || 0),
      totalStepCount: Number(rootConv.totalStepCount || rootConv.stepCount || 0),
      lastModifiedMs: rootConv.groupLastModifiedMs || rootConv.lastModifiedMs || 0,
      mainActivity: resolvedMainActivity,
      subagentCount: subItems.length,
      runningSubagentCount: runningSubList.length,
      subagents: subItems,
      modelShort: qStats.modelShort,
      modelUpstream: qStats.modelUpstream,
      latestTokPerSec: qStats.latestTokPerSec,
      contextUsedPct: qStats.contextUsedPct,
      contextLimitTokens: qStats.contextLimitTokens,
      contextTotalTokens: qStats.contextTotalTokens,
      sessionCostUsd: qStats.sessionCostUsd,
      sessionUnpricedCalls: qStats.sessionUnpricedCalls,
    });
  }

  const finalPayload = {
    timestamp: new Date().toISOString(),
    uiBundleVersion,
    settings,
    contextWindowModels: getContextWindowGroups(getContextWindowModels(clientConfigs, contextModelCatalog)).map((group) => {
      const latest = group.members.reduce((previous, id) => {
        const reported = reportedContextLimits.get(id);
        return reported && (!previous || reported.at > previous.at) ? reported : previous;
      }, null);
      return { ...group, reportedLimitTokens: latest?.tokens ?? null };
    }),
    cloudStatus: getCloudStatus(),
    account: {
      status: accountStatus,
      email: userStatus?.email || '',
      name: userStatus?.name || '',
      tierName: rawTierName || 'Google AI',
      planName: resolvedPlanName,
      aiCredits: realAiCredits > 0 ? realAiCredits : null,
      totalConversations: conversations.length,
    },
    runningConversations,
    conversations: conversations.slice(0, MAX_RECENT_CONVERSATIONS).map((c) => {
      const qStats = getConversationQuickStats(c);
      const rawSubs = Array.isArray(c.subagents) ? c.subagents : [];
      const runningSubCount = rawSubs.filter((s) => s.status === 'CASCADE_RUN_STATUS_RUNNING').length;
      return {
        cascadeId: c.cascadeId,
        title: c.title,
        stepCount: c.stepCount,
        subagentCount: c.subagentCount || 0,
        runningSubagentCount: runningSubCount,
        totalStepCount: c.totalStepCount || c.stepCount || 0,
        isRunning: c.status === 'CASCADE_RUN_STATUS_RUNNING' || runningSubCount > 0,
        status: c.status,
        lastModifiedTime: c.lastModifiedTime,
        lastModifiedMs: c.groupLastModifiedMs || c.lastModifiedMs,
        modelShort: qStats.modelShort,
        modelUpstream: qStats.modelUpstream,
        latestTokPerSec: qStats.latestTokPerSec,
        latestTtftSec: qStats.latestTtftSec,
        avgTokPerSec: qStats.avgTokPerSec,
        latestStepCostUsd: qStats.latestStepCostUsd,
        latestPromptTokens: qStats.latestPromptTokens,
        latestCacheHitPct: qStats.latestCacheHitPct,
        totalTokens: qStats.totalTokens,
        contextUsedPct: qStats.contextUsedPct,
        contextLimitTokens: qStats.contextLimitTokens,
        contextTotalTokens: qStats.contextTotalTokens,
        contextBreakdown: qStats.contextBreakdown || null,
        sessionCostUsd: qStats.sessionCostUsd,
        sessionUnpricedCalls: qStats.sessionUnpricedCalls,
      };
    }),
    activeConversation: {
      cascadeId: activeCascadeId,
      title: activeConvSummary?.title || 'Current Session',
      isRunning: activeConvSummary?.status === 'CASCADE_RUN_STATUS_RUNNING',
      status: activeConvSummary?.status || 'IDLE',
      liveActivity: mainAgentTelemetry.liveActivity || null,
      stepCount: enrichedActiveSteps.length,
      hasSubagents: subAgentTelemetries.length > 0,
      subagentCount: subAgentTelemetries.length,
      totalStepsAllAgents: subAgentTelemetries.length
        ? allCombinedEnrichedSteps.length
        : enrichedActiveSteps.length,
      latestTokPerSec: latestEnriched?.tokPerSec ?? null,
      latestTtftSec: latestEnriched?.ttftSec ?? null,
      latestSpeedReason: latestEnriched?.selectedSpeedReason ?? null,
      avgTokPerSec: sessionAvgTokPerSec,
      speedSummary: sessionSpeed,
      ttftSummary: sessionTtft,
      latestStepCostUsd: latestEnriched?.costUsd ?? null,
      sessionCostUsd: roundSessionCost(sessionCostUsd),
      sessionUnpricedCalls,
      inputTokens: sessionInputTokens,
      cacheReadTokens: sessionCacheReadTokens,
      outputTokens: sessionOutputTokens,
      totalTokens: sessionInputTokens + sessionCacheReadTokens + sessionOutputTokens,
      latestPromptTokens: latestEnriched
        ? Number(latestEnriched.inputTokens || 0) + Number(latestEnriched.cacheReadTokens || 0)
        : 0,
      latestCacheHitPct,
      sessionCacheHitPct,
      activeModelShort: latestEnriched?.modelShort || 'Unknown Model',
      activeModelLabel: latestEnriched?.modelLabel || 'Unknown Model',
      activeModelUpstream:
        latestEnriched?.modelUpstream || latestEnriched?.modelShort || 'Unknown Model',
      context,
      recentSteps: mainUnit.recentSteps,
      modelBreakdown: mainModelBreakdown,
      agents: allAgents,
      aggregated: aggregatedTelemetry,
    },
    consumption: {
      selectedRange: {
        key: selectedWindow.key,
        label: selectedWindow.label,
        startMs: trendStartMs,
        endMs: trendEndMs,
      },
      session: finalizedSelectedSession,
      account: finalizedSelectedAccount,
      presets: finalizedPresets,
      trendSeries,
      sourcesBreakdown,
      monthlyYear: currentYear,
      monthlySeries,
    },
    quotas: {
      meta: {
        fetchedAtMs: officialQuotaInfo?.fetchedAtMs || 0,
        hasOfficialData: Boolean(officialQuotaInfo?.data),
        isStale: Boolean(officialQuotaInfo?.isStale),
        refreshFailed: Boolean(officialQuotaInfo?.refreshFailed),
        error: officialQuotaInfo?.error || null,
        errorMessage: officialQuotaInfo?.error || null,
      },
      activePool: activePoolQuota,
      pools: Array.from(quotaPoolsMap.values()).sort((a, b) => {
        const order = { Gemini: 0, Argon: 1, Carbon: 2, 'Claude & GPT': 3 };
        return (order[a.family] ?? 99) - (order[b.family] ?? 99);
      }),
      weekly: {
        isOfficial: useOfficialWeekly,
        poolFamily: activePoolKey,
        title: isCustomWeeklyMode
          ? 'Weekly Budget (Local)'
          : `Weekly Limit (${activePoolLabel && activePoolLabel !== 'Unknown' ? activePoolLabel : 'Active'})`,
        calls: !isCustomWeeklyMode && poolsWeeklySummary ? poolsWeeklySummary.calls : weekBucket.calls,
        tokens:
          !isCustomWeeklyMode && poolsWeeklySummary
            ? poolsWeeklySummary.tokens
            : weekBucket.totalTokens,
        costUsd:
          !isCustomWeeklyMode && poolsWeeklySummary
            ? poolsWeeklySummary.costUsd
            : weekBucket.costUsd,
        unpricedCalls:
          !isCustomWeeklyMode && poolsWeeklySummary
            ? poolsWeeklySummary.unpricedCalls
            : weekBucket.unpricedCalls,
        usedPct: weeklyUsedPct,
        remainingPct: weeklyRemainingPct,
        remainingIntPct: weeklyRemainingIntPct,
        resetTime: useOfficialWeekly
          ? activeLiveWeekly.resetTime
          : isCustomWeeklyMode
            ? getNextMondayResetIso()
            : null,
      },
    },
    modelBreakdown,
    discoveredModels: buildDiscoveredModelsList(
      clientConfigs,
      dynamicModelMap,
      modelBreakdown,
      settings.customModelPricing,
      reportedContextLimits
    ),
  };

  if (lsRuntimeEndpoint.addr !== 'test.invalid' && settings.enableCliStatusLine !== false) {
    try {
      const snap = buildCliStatusSnapshot(finalPayload, Date.now());
      const snapSig = JSON.stringify({ ...snap, updatedAtMs: 0 });
      if (snapSig !== lastCliSnapshotSig) {
        lastCliSnapshotSig = snapSig;
        saveJson(CLI_STATUS_SNAPSHOT_FILE, snap);
      }
    } catch {
      // Snapshot write is best-effort and must never block telemetry
    }
  }

  return finalPayload;
}

export function buildCliStatusSnapshot(finalPayload, updatedAtMs = Date.now()) {
  const ac = finalPayload?.activeConversation || {};
  const capSource = ac.aggregated || ac;
  const ctx = ac.context || {};
  const limitTok = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
  const totalTok = Number(ctx.totalTokens || 0);
  const usedPctVal =
    limitTok > 0 ? Math.min(100, +((totalTok / limitTok) * 100).toFixed(2)) : 0;

  const runningList = Array.isArray(finalPayload?.runningConversations)
    ? finalPayload.runningConversations
    : [];

  return {
    updatedAtMs,
    runningCount: runningList.length,
    runningSubCount: runningList.reduce(
      (acc, item) => acc + Number(item?.runningSubagentCount || 0),
      0
    ),
    hasWaiting: runningList.some((item) => item?.mainActivity?.phase === 'waiting'),
    quotas: finalPayload?.quotas || null,
    activeConversation: {
      cascadeId: ac.cascadeId || '',
      isRunning: Boolean(capSource.isRunning || ac.isRunning),
      stepCount: Number(capSource.stepCount ?? ac.stepCount ?? 0),
      usedPct: usedPctVal,
      latestTokPerSec: capSource.latestTokPerSec ?? ac.latestTokPerSec ?? null,
      avgTokPerSec: capSource.avgTokPerSec ?? ac.avgTokPerSec ?? null,
      latestTtftSec: capSource.latestTtftSec ?? ac.latestTtftSec ?? null,
      latestStepCostUsd: capSource.latestStepCostUsd ?? ac.latestStepCostUsd ?? null,
      sessionCostUsd: capSource.sessionCostUsd ?? ac.sessionCostUsd ?? null,
      latestCacheHitPct: capSource.latestCacheHitPct ?? ac.latestCacheHitPct ?? null,
      latestPromptTokens: Number(capSource.latestPromptTokens ?? ac.latestPromptTokens ?? 0),
      totalTokens: Number(capSource.totalTokens ?? ac.totalTokens ?? 0),
    },
  };
}

/**
 * In-Flight Deduplication 
 *
 * @param {string} requestedConvId
 * @param {boolean} [forceQuotaRefresh=false]
 * @param {{ range?: string, startMs?: number, endMs?: number }} [filterOpts={}]
 * @returns {Promise<object>}
 */
export function buildTelemetryPayload(
  requestedConvId,
  forceQuotaRefresh = false,
  filterOpts = {}
) {
  const rangeSig = `${filterOpts.range || 'all'}:${filterOpts.startMs || 0}:${filterOpts.endMs || 0}`;
  const key = `${requestedConvId || '__auto__'}::${forceQuotaRefresh ? 'force' : 'normal'}::${rangeSig}`;
  if (inFlightRequests.has(key)) {
    return inFlightRequests.get(key);
  }
  const p = buildTelemetryPayloadInternal(requestedConvId, forceQuotaRefresh, filterOpts).finally(
    () => {
      inFlightRequests.delete(key);
    }
  );
  inFlightRequests.set(key, p);
  return p;
}
