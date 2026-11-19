/**
 * @fileoverview Decoupled Metric Registry (`metricRegistry.js`).
 * Centralizes presentation & option metadata for:
 * 1. Topbar / Composer Capsule Slots (1..5 items out of 13 metrics)
 * 2. Live Overview / Hover First-Row Metric Matrix (1..4 items out of 9 metrics)
 */

import {
  formatCachePct,
  formatMetric,
  formatTokens,
  formatUsd,
  getCacheToneClass,
  getSpeedToneClass,
  getStepCostToneClass,
  getTtftToneClass,
  resolveModelDisplayInfo,
  sampleSummary,
  speedReasonText,
} from '../core/formatters.js';
import { isEnglishLocale, isThaiLocale, t } from '../i18n/index.js';

export const CAPSULE_METRIC_KEYS = Object.freeze([
  'gemini_5h',
  'context',
  'tps',
  'ttft',
  'avg_tps',
  'cost',
  'session_cost',
  'cache_hit',
  'session_tokens',
  'quota_auto',
  'gemini_weekly',
  'claude_5h',
  'claude_weekly',
]);

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

const THIRD_PARTY_FAMILY_RE = /claude|gpt|anthropic|openai|3p|sonnet|opus|haiku/i;

export function getCapsuleMetricOptions() {
  return CAPSULE_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`capMetric.${key}`),
  }));
}

export function getOverviewMetricOptions() {
  return OVERVIEW_METRIC_KEYS.map((key) => ({
    value: key,
    label: t(`ovMetric.${key}`),
  }));
}

export function resolveQuotaCapsuleSummary(quotas) {
  if (!quotas) return null;
  const activePool = quotas.activePool;
  const weekly = quotas.weekly;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const candidates = [];
  const defaultPoolName = 'Active Pool';
  const wkTag = 'Wk';

  if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
    candidates.push({
      pct: Number(activePool.remainingPct),
      label: activePool.poolLabel || activePool.family || defaultPoolName,
      windowTag: '5h',
    });
  }
  if (activePool && Number.isFinite(Number(activePool.weeklyRemainingPct))) {
    candidates.push({
      pct: Number(activePool.weeklyRemainingPct),
      label: activePool.poolLabel || activePool.family || defaultPoolName,
      windowTag: wkTag,
    });
  }
  if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
    candidates.push({
      pct: Number(weekly.remainingPct),
      label: weekly.poolFamily || (isThaiLocale() ? 'รายสัปดาห์' : 'Weekly'),
      windowTag: wkTag,
    });
  }
  if (!candidates.length && pools.length > 0) {
    for (const p of pools) {
      const pLabel = p?.poolLabel || p?.family || defaultPoolName;
      if (p && Number.isFinite(Number(p.remainingPct))) {
        candidates.push({ pct: Number(p.remainingPct), label: pLabel, windowTag: '5h' });
      }
      if (p && Number.isFinite(Number(p.weeklyRemainingPct))) {
        candidates.push({ pct: Number(p.weeklyRemainingPct), label: pLabel, windowTag: wkTag });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.pct - b.pct);
  const tightest = candidates[0];
  const runnerUp = candidates.length > 1 ? candidates[1] : null;
  const rounded = Math.max(0, Math.min(100, Math.round(tightest.pct)));
  const exactPct = Math.max(0, Math.min(100, +Number(tightest.pct).toFixed(2)));
  const runnerPct = runnerUp ? Math.max(0, Math.min(100, Math.round(runnerUp.pct))) : null;
  const subLabelText = runnerUp
    ? runnerUp.label === tightest.label
      ? `${tightest.label} ${tightest.windowTag} · ${runnerUp.windowTag} ${runnerPct}%`
      : `${tightest.label} ${tightest.windowTag} · ${runnerUp.label} ${runnerUp.windowTag} ${runnerPct}%`
    : `${tightest.label} · ${tightest.windowTag}`;
  return {
    roundedPct: rounded,
    exactPct,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
    subLabelText,
    detailText: candidates
      .map((c) => {
        const cPct = Math.max(0, Math.min(100, Math.round(c.pct)));
        return `${c.label} ${c.windowTag} ${t('capsule.quotaLeft', { pct: cPct })}`;
      })
      .join(' · '),
  };
}

/**
 * Gemini Claude & GPT 5h 
 *
 * @param {object|null|undefined} quotas
 * @param {'gemini_5h'|'gemini_weekly'|'claude_5h'|'claude_weekly'} slotKey
 * @returns {{ roundedPct: number, shortText: string } | null}
 */
export function resolveSpecificQuotaSlotSummary(quotas, slotKey) {
  if (!quotas) return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const activePool = quotas.activePool || null;
  const isClaude = slotKey.startsWith('claude_');
  const isWeekly = slotKey.endsWith('_weekly');
  let rawPct = null;

  if (isClaude) {
    const claudePool =
      pools.find((p) => p?.poolKey === 'Claude & GPT') ||
      pools.find((p) => THIRD_PARTY_FAMILY_RE.test(String(p?.poolKey || p?.poolLabel || '')));
    const cand = isWeekly ? claudePool?.weeklyRemainingPct : claudePool?.remainingPct;
    if (cand != null && Number.isFinite(Number(cand))) {
      rawPct = Number(cand);
    } else if (
      activePool &&
      THIRD_PARTY_FAMILY_RE.test(String(activePool.family || activePool.poolLabel || ''))
    ) {
      const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
      if (fb != null && Number.isFinite(Number(fb))) {
        rawPct = Number(fb);
      }
    }
  } else {
    const stdGemini =
      pools.find((p) => p?.poolKey === 'Gemini') ||
      pools.find(
        (p) =>
          /gemini/i.test(String(p?.poolKey || p?.poolLabel || '')) &&
          !/carbon|argon/i.test(String(p?.poolKey || ''))
      );
    const geminiFamilyPools = pools.filter((p) =>
      /gemini|carbon|argon/i.test(String(p?.poolKey || p?.poolLabel || ''))
    );
    const primaryCand = isWeekly ? stdGemini?.weeklyRemainingPct : stdGemini?.remainingPct;
    if (primaryCand != null && Number.isFinite(Number(primaryCand))) {
      rawPct = Number(primaryCand);
    } else {
      const familyVals = geminiFamilyPools
        .map((p) => (isWeekly ? p?.weeklyRemainingPct : p?.remainingPct))
        .filter((v) => v != null && Number.isFinite(Number(v)))
        .map(Number);
      if (familyVals.length > 0) {
        rawPct = Math.min(...familyVals);
      } else if (
        activePool &&
        !THIRD_PARTY_FAMILY_RE.test(String(activePool.family || activePool.poolLabel || ''))
      ) {
        const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
        if (fb != null && Number.isFinite(Number(fb))) {
          rawPct = Number(fb);
        }
      }
      if (
        rawPct == null &&
        isWeekly &&
        quotas.weekly &&
        !THIRD_PARTY_FAMILY_RE.test(String(quotas.weekly.poolFamily || '')) &&
        quotas.weekly.remainingPct != null &&
        Number.isFinite(Number(quotas.weekly.remainingPct))
      ) {
        rawPct = Number(quotas.weekly.remainingPct);
      }
    }
  }

  if (rawPct == null || !Number.isFinite(rawPct)) return null;
  const rounded = Math.max(0, Math.min(100, Math.round(rawPct)));
  const exactPct = Math.max(0, Math.min(100, +Number(rawPct).toFixed(2)));
  return {
    roundedPct: rounded,
    exactPct,
    shortText: t('capsule.quotaLeft', { pct: rounded }),
  };
}

export function formatCompactCapsuleCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '--';
  const val = Math.max(0, Number(costUsd));
  if (val === 0) return '$0.00';
  if (val < 0.001) return '<$0.001';
  if (val < 1) return `$${val.toFixed(3)}`;
  if (val < 100) return `$${val.toFixed(2)}`;
  return `$${Math.round(val)}`;
}

export function formatCapsulePctText(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return '--%';
  return `${Math.max(0, Math.min(100, num)).toFixed(2)}%`;
}

function formatCapsuleTpsText(val) {
  const num = Number(val);
  return `${num >= 100 ? Math.round(num) : num.toFixed(1)} t/s`;
}

function formatCapsuleIntPctText(val) {
  return `${Math.round(Number(val || 0))}%`;
}

export function formatCompactCapsuleTtft(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) return '--s';
  const val = Number(ttftSec);
  if (val < 1) return `${val.toFixed(2)}s`;
  if (val < 100) return `${val.toFixed(1)}s`;
  return `${Math.round(val)}s`;
}

const CTX_RING_SEGMENT_DEFS = [
  { key: 'assistant', cls: 'seg-assistant', getVal: (c) => Number(c.assistantTokens || 0) },
  { key: 'toolResults', cls: 'seg-tool-results', getVal: (c) => Number(c.toolResultsTokens || 0) },
  {
    key: 'userInput',
    cls: 'seg-user-input',
    getVal: (c) => Number(c.userInputTokens ?? c.messagesTokens ?? 0),
  },
  { key: 'subagent', cls: 'seg-subagent-msg', getVal: (c) => Number(c.subagentTokens || 0) },
  { key: 'checkpoint', cls: 'seg-checkpoint', getVal: (c) => Number(c.checkpointTokens || 0) },
  { key: 'systemPrompt', cls: 'seg-system-prompt', getVal: (c) => Number(c.systemPromptTokens || 0) },
  { key: 'systemTools', cls: 'seg-system-tools', getVal: (c) => Number(c.systemToolsTokens || 0) },
  { key: 'mcpTools', cls: 'seg-mcp-tools', getVal: (c) => Number(c.mcpToolsTokens || 0) },
  { key: 'skills', cls: 'seg-skills', getVal: (c) => Number(c.skillsTokens || 0) },
  { key: 'userRules', cls: 'seg-user-rules', getVal: (c) => Number(c.userRulesTokens || 0) },
];

export function resolveContextRingSegments(contextData, usedPct, ringCircumference) {
  if (!contextData || typeof contextData !== 'object') return null;
  const pct = Math.max(0, Math.min(100, Number(usedPct || 0)));
  if (!(pct > 0) || !(ringCircumference > 0)) return null;

  const active = [];
  let totalVal = 0;
  for (let i = 0; i < CTX_RING_SEGMENT_DEFS.length; i += 1) {
    const def = CTX_RING_SEGMENT_DEFS[i];
    const val = Math.max(0, Number(def.getVal(contextData) || 0));
    if (val > 0) {
      totalVal += val;
      active.push({ cls: def.cls, val, defaultOrder: i });
    }
  }
  if (!(totalVal > 0) || active.length === 0) return null;

  active.sort((a, b) => b.val - a.val || a.defaultOrder - b.defaultOrder);
  const totalArc = ringCircumference * (pct / 100);
  const gapStr = (ringCircumference + 2).toFixed(2);
  let cumOffset = 0;
  return active.map((seg) => {
    const segArc = totalArc * (seg.val / totalVal);
    const out = {
      cls: seg.cls,
      dashArray: `${segArc.toFixed(2)} ${gapStr}`,
      dashOffset: (-cumOffset).toFixed(2),
    };
    cumOffset += segArc;
    return out;
  });
}

/**
 * / 
 *
 * @param {string} metricKey
 * @param {object} slotCtx
 * @param {number} ringCircumference
 */
export function resolveCapsuleMetricPresentation(metricKey, slotCtx, ringCircumference) {
  if (!metricKey || metricKey === 'none') {
    return {
      hidden: true,
      metric: 'none',
      segClass: 'wm-cap-slot',
      textClass: 'wm-slot-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: '',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  if (metricKey === 'context') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'context',
        segClass: 'wm-cap-slot wm-ctx-seg',
        textClass: 'wm-slot-text wm-ctx-pct',
        showRing: true,
        dashOffset: ringCircumference,
        text: '--%',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const isDanger = slotCtx.usedPct >= 88;
    const isWarn = !isDanger && slotCtx.usedPct >= 70;
    const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
    const ringSegments = resolveContextRingSegments(
      slotCtx.context,
      slotCtx.usedPct,
      ringCircumference
    );
    return {
      hidden: false,
      metric: 'context',
      segClass: 'wm-cap-slot wm-ctx-seg',
      textClass: 'wm-slot-text wm-ctx-pct',
      showRing: true,
      ringSegments,
      dashOffset: slotCtx.dashOffset,
      text: formatCapsulePctText(slotCtx.usedPct),
      animSpec: Number.isFinite(Number(slotCtx.usedPct))
        ? { value: Math.max(0, Math.min(100, Number(slotCtx.usedPct))), format: formatCapsulePctText }
        : null,
      toneClass,
      running: false,
      warn: isWarn,
      danger: isDanger,
    };
  }

  if (metricKey === 'tps') {
    if (!slotCtx.hasTelemetry) {
      return {
        hidden: false,
        metric: 'tps',
        segClass: 'wm-cap-slot wm-seg-speed',
        textClass: 'wm-slot-text wm-speed-text',
        showRing: false,
        dashOffset: ringCircumference,
        text: '-- t/s',
        toneClass: '',
        running: false,
        warn: false,
        danger: false,
      };
    }
    const hasValidTps = Number.isFinite(slotCtx.tps) && slotCtx.tps > 0;
    const toneClass = hasValidTps ? getSpeedToneClass(slotCtx.tps) : '';
    const tpsText = hasValidTps
      ? formatCapsuleTpsText(slotCtx.tps)
      : slotCtx.isRunning
        ? t('capsule.tpsRunning')
        : t('capsule.tpsIdle');
    return {
      hidden: false,
      metric: 'tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: tpsText,
      animSpec: hasValidTps ? { value: Number(slotCtx.tps), format: formatCapsuleTpsText } : null,
      toneClass,
      running: Boolean(slotCtx.isRunning),
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'avg_tps') {
    const avgVal = slotCtx.hasTelemetry ? slotCtx.avgTps : null;
    const valid = Number.isFinite(avgVal) && avgVal > 0;
    const toneClass = valid ? getSpeedToneClass(avgVal) : '';
    return {
      hidden: false,
      metric: 'avg_tps',
      segClass: 'wm-cap-slot wm-seg-speed',
      textClass: 'wm-slot-text wm-speed-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatCapsuleTpsText(avgVal) : '-- t/s',
      animSpec: valid ? { value: Number(avgVal), format: formatCapsuleTpsText } : null,
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'ttft') {
    const val = slotCtx.hasTelemetry ? slotCtx.ttft : null;
    const valid = val != null && Number.isFinite(Number(val)) && Number(val) >= 0;
    const numVal = valid ? Number(val) : 0;
    const toneClass = valid ? getTtftToneClass(numVal) : '';
    return {
      hidden: false,
      metric: 'ttft',
      segClass: 'wm-cap-slot wm-seg-ttft',
      textClass: 'wm-slot-text wm-ttft-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatCompactCapsuleTtft(numVal) : '--s',
      animSpec: valid ? { value: numVal, format: formatCompactCapsuleTtft } : null,
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const costVal = !slotCtx.hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const toneClass =
      metricKey === 'cost' && slotCtx.hasTelemetry && costVal != null
        ? getStepCostToneClass(costVal)
        : '';
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-seg-cost',
      textClass: 'wm-slot-text wm-cost-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: slotCtx.hasTelemetry ? formatCompactCapsuleCost(costVal) : '--',
      animSpec:
        slotCtx.hasTelemetry && costVal != null && Number.isFinite(Number(costVal)) && Number(costVal) >= 0.001
          ? { value: Number(costVal), format: formatCompactCapsuleCost }
          : null,
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'cache_hit') {
    const cachePct = slotCtx.hasTelemetry ? slotCtx.cacheHitPct : null;
    const valid = cachePct != null && Number.isFinite(Number(cachePct));
    const numVal = valid ? Number(cachePct) : 0;
    const toneClass = valid ? getCacheToneClass(numVal, slotCtx.latestPromptTokens) : '';
    return {
      hidden: false,
      metric: 'cache_hit',
      segClass: 'wm-cap-slot wm-seg-cache',
      textClass: 'wm-slot-text wm-cache-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatCapsuleIntPctText(numVal) : '--%',
      animSpec: valid ? { value: numVal, format: formatCapsuleIntPctText } : null,
      toneClass,
      running: false,
      warn: toneClass === 'tone-warn',
      danger: toneClass === 'tone-danger',
    };
  }

  if (metricKey === 'session_tokens') {
    const tokVal = slotCtx.hasTelemetry ? slotCtx.sessionTokens : null;
    const valid = tokVal != null && Number.isFinite(Number(tokVal)) && Number(tokVal) >= 0;
    return {
      hidden: false,
      metric: 'session_tokens',
      segClass: 'wm-cap-slot wm-seg-tokens',
      textClass: 'wm-slot-text wm-tokens-text',
      showRing: false,
      dashOffset: ringCircumference,
      text: valid ? formatTokens(Number(tokVal)) : '--',
      animSpec: valid ? { value: Number(tokVal), format: formatTokens } : null,
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }

  const quotaSum = !slotCtx.hasTelemetry
    ? null
    : metricKey === 'quota_auto'
      ? resolveQuotaCapsuleSummary(slotCtx.quotas)
      : resolveSpecificQuotaSlotSummary(slotCtx.quotas, metricKey);
  const quotaMode = slotCtx.quotaDisplayMode === 'used' ? 'used' : 'left';
  if (!quotaSum) {
    return {
      hidden: false,
      metric: metricKey,
      segClass: 'wm-cap-slot wm-ctx-seg wm-seg-quota',
      textClass: 'wm-slot-text wm-ctx-pct wm-quota-text',
      showRing: true,
      dashOffset: ringCircumference,
      text: '--%',
      toneClass: '',
      running: false,
      warn: false,
      danger: false,
    };
  }
  const remainingPct = Math.max(0, Math.min(100, quotaSum.exactPct ?? quotaSum.roundedPct));
  const displayPct = Math.max(
    0,
    Math.min(100, +(quotaMode === 'used' ? 100 - remainingPct : remainingPct).toFixed(2))
  );
  const quotaDashOffset = +(ringCircumference * (1 - displayPct / 100)).toFixed(2);
  const isDanger = remainingPct <= 15;
  const isWarn = !isDanger && remainingPct <= 30;
  const toneClass = isDanger ? 'tone-danger' : isWarn ? 'tone-warn' : '';
  return {
    hidden: false,
    metric: metricKey,
    segClass: 'wm-cap-slot wm-ctx-seg wm-seg-quota',
    textClass: 'wm-slot-text wm-ctx-pct wm-quota-text',
    showRing: true,
    dashOffset: quotaDashOffset,
    text: formatCapsulePctText(displayPct),
    animSpec: { value: displayPct, format: formatCapsulePctText },
    toneClass,
    running: false,
    warn: isWarn,
    danger: isDanger,
  };
}

function translateRawAgentBadge(rawBadge) {
  if (!rawBadge) return '';
  const str = String(rawBadge).trim();
  if (str === 'Main') return t('fmt.mainBadge');
  const m = str.match(/^Sub\s*(\d+)$/i);
  if (m) return t('fmt.subBadge', { index: m[1] });
  if (str.toLowerCase() === 'sub') return t('fmt.subBadgeShort');
  return str;
}

/**
 * 
 *
 * @param {string} metricKey
 * @param {{ active?: object, ctx?: object, quotas?: object, settings?: object, hasSubagents?: boolean }} cellCtx
 */
export function resolveOverviewMetricCell(metricKey, cellCtx = {}) {
  const active = cellCtx.active || {};
  const ctx = cellCtx.ctx || active.context || {};
  const quotas = cellCtx.quotas || {};
  const settings = cellCtx.settings || {};
  const hasSubagents = Boolean(cellCtx.hasSubagents);
  const hasAnySteps = Number(active.stepCount || 0) > 0;

  if (metricKey === 'tps') {
    const activeModelDisplay = resolveModelDisplayInfo(active, settings, {
      fallback: t('fmt.unknownModel'),
    }).text;
    const reason = speedReasonText(active.latestSpeedReason);
    const badgeStr = translateRawAgentBadge(active.activeAgentBadge);
    const modelAndAgent =
      hasSubagents && badgeStr ? `[${badgeStr}] ${activeModelDisplay}` : activeModelDisplay;
    const hasSpeed = Number.isFinite(active.latestTokPerSec) && Number(active.latestTokPerSec) > 0;
    const speedTone = hasAnySteps && hasSpeed ? getSpeedToneClass(active.latestTokPerSec) : '';
    return {
      key: 'tps',
      label: t('ovMetric.tps'),
      icon: 'dot',
      iconSize: 10,
      isPulsing: Boolean(active.isRunning),
      valueText: formatMetric(active.latestTokPerSec, ' tok/s'),
      valueClass: speedTone ? `cell-value ${speedTone}` : 'cell-value',
      subText: reason
        ? !hasSpeed
          ? `${reason} · ${modelAndAgent}`
          : `${modelAndAgent} · ${reason}`
        : modelAndAgent,
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'ttft') {
    const ttftTone = hasAnySteps ? getTtftToneClass(active.latestTtftSec) : '';
    return {
      key: 'ttft',
      label: t('ovMetric.ttft'),
      icon: 'clock',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.latestTtftSec, 's'),
      valueClass: ttftTone ? `cell-value ${ttftTone}` : 'cell-value',
      subText: t('ovMetric.subAvgTtft', {
        val: formatMetric(active.ttftSummary?.avgSec, 's'),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'avg_tps') {
    const hasAvgSpeed = Number.isFinite(active.avgTokPerSec) && Number(active.avgTokPerSec) > 0;
    const avgSpeedTone = hasAnySteps && hasAvgSpeed ? getSpeedToneClass(active.avgTokPerSec) : '';
    return {
      key: 'avg_tps',
      label: t('ovMetric.avg_tps'),
      icon: 'pulse',
      iconSize: 11,
      isPulsing: false,
      valueText: formatMetric(active.avgTokPerSec, ' tok/s'),
      valueClass: avgSpeedTone ? `cell-value ${avgSpeedTone}` : 'cell-value',
      subText: t('ovMetric.subValidSamples', {
        samples: sampleSummary(active.speedSummary),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'step_cost' || metricKey === 'session_cost') {
    const stepCost = active.latestStepCostUsd;
    const sessCost = Number(active.sessionCostUsd || 0);
    const stepCnt = Number(active.stepCount || 0);
    const isAllUnpriced =
      stepCnt > 0 && Number(active.sessionUnpricedCalls || 0) >= stepCnt && !(sessCost > 0);
    const stepCostText =
      !hasAnySteps && stepCost == null ? '—' : formatUsd(stepCost, { precise: true });
    const totalCostText =
      !hasAnySteps && active.sessionCostUsd == null
        ? '—'
        : formatUsd(isAllUnpriced ? null : sessCost, {
            precise: sessCost > 0 && sessCost < 0.1,
          });

    if (metricKey === 'step_cost') {
      const costTone = hasAnySteps ? getStepCostToneClass(stepCost) : '';
      return {
        key: 'step_cost',
        label: t('ovMetric.step_cost'),
        icon: 'bolt',
        iconSize: 11,
        isPulsing: false,
        valueText: stepCostText,
        valueClass: costTone ? `cell-value ${costTone}` : 'cell-value',
        subText: t('ovMetric.subTotalCost', { cost: totalCostText }),
        subClass: 'cell-sub',
      };
    }

    return {
      key: 'session_cost',
      label: t('ovMetric.session_cost'),
      icon: 'bolt',
      iconSize: 11,
      isPulsing: false,
      valueText: totalCostText,
      valueClass: 'cell-value',
      subText: t('ovMetric.subStepCost', { cost: stepCostText }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'cache_hit') {
    const latestCache = active.latestCacheHitPct;
    const avgCache = active.sessionCacheHitPct ?? active.latestCacheHitPct;
    const hasLatest = hasAnySteps && latestCache != null && Number.isFinite(Number(latestCache));
    const hasAvg = hasAnySteps && avgCache != null && Number.isFinite(Number(avgCache));
    const cacheTone = hasLatest ? getCacheToneClass(latestCache, active.latestPromptTokens) : '';
    return {
      key: 'cache_hit',
      label: t('ovMetric.cache_hit'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: hasLatest ? formatCachePct(latestCache) : '—',
      valueClass: cacheTone ? `cell-value ${cacheTone}` : 'cell-value',
      subText: t('ovMetric.subAvgCache', {
        val: hasAvg ? formatCachePct(avgCache) : '—',
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'session_tokens') {
    const inTok = Math.max(0, Number(active.inputTokens || 0));
    const cacheTok = Math.max(0, Number(active.cacheReadTokens || 0));
    const outTok = Math.max(0, Number(active.outputTokens || 0));
    const totalTok = Math.max(0, Number(active.totalTokens ?? inTok + cacheTok + outTok));
    return {
      key: 'session_tokens',
      label: t('ovMetric.session_tokens'),
      icon: 'chart-bar',
      iconSize: 11,
      isPulsing: false,
      valueText: !hasAnySteps && !totalTok ? '—' : formatTokens(totalTok),
      valueClass: 'cell-value',
      subText: t('ovMetric.subInOutTokens', {
        inTok: formatTokens(inTok + cacheTok),
        outTok: formatTokens(outTok),
      }),
      subClass: 'cell-sub',
    };
  }

  if (metricKey === 'context_usage') {
    const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
    const totalTokens = Number(ctx.totalTokens || 0);
    const usedPct =
      limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
    const toneCls =
      usedPct >= 88
        ? 'cell-value tone-danger'
        : usedPct >= 70
          ? 'cell-value tone-warn'
          : 'cell-value';
    return {
      key: 'context_usage',
      label: t('ovMetric.context_usage'),
      icon: 'layers',
      iconSize: 11,
      isPulsing: false,
      valueText: `${usedPct}%`,
      valueClass: toneCls,
      subText: t('ovMetric.subCtxRatio', {
        used: formatTokens(totalTokens),
        limit: formatTokens(limitTokens),
      }),
      subClass: 'cell-sub',
    };
  }

  const quotaSum = resolveQuotaCapsuleSummary(quotas);
  const quotaToneCls =
    quotaSum && quotaSum.roundedPct <= 15
      ? 'cell-value tone-danger'
      : quotaSum && quotaSum.roundedPct <= 30
        ? 'cell-value tone-warn'
        : 'cell-value';
  return {
    key: 'quota_tightest',
    label: t('ovMetric.quota_tightest'),
    icon: 'pulse',
    iconSize: 11,
    isPulsing: false,
    valueText: quotaSum ? quotaSum.shortText : '—',
    valueClass: quotaToneCls,
    subText: quotaSum
      ? t('ovMetric.subQuotaPool', { label: quotaSum.subLabelText })
      : t('ovMetric.subQuotaPending'),
    subClass: 'cell-sub',
  };
}
