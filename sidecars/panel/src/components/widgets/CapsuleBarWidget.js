/**
 * @fileoverview Shared Decoupled Capsule Bar Primitives & Widget (`CapsuleBarWidget.js`).
 * Powers both the live host window capsule (`WindowOverlayShell.js`) and the
 * real-UI structure preview (`SettingsStructureTab.js`), ensuring 100% DOM/CSS parity.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { t } from '../../i18n/index.js';
import { createSvgIcon, SVG_NS } from '../../icons/SvgIcon.js';
import { resolveCapsuleMetricPresentation } from '../../registries/metricRegistry.js';
import {
  normalizeClientQuotaDisplayMode,
  normalizeClientTopbarSlots,
  normalizeClientWindowMountMode,
  resolveScopedConversation,
} from '../../store/telemetryStore.js';

export const RING_RADIUS = 5.2;
export const RING_CIRCUMFERENCE = +(2 * Math.PI * RING_RADIUS).toFixed(2);

/**
 * Create a single reusable capsule metric slot node (`0..4`) with an optional SVG context ring.
 */
export function createCapsuleSlotNode(slotIndex, initialMetric) {
  const ringSvg = document.createElementNS(SVG_NS, 'svg');
  ringSvg.setAttribute('viewBox', '0 0 14 14');
  ringSvg.setAttribute('class', 'wm-ring-svg');
  ringSvg.setAttribute('aria-hidden', 'true');

  const ringTrack = document.createElementNS(SVG_NS, 'circle');
  ringTrack.setAttribute('cx', '7');
  ringTrack.setAttribute('cy', '7');
  ringTrack.setAttribute('r', String(RING_RADIUS));
  ringTrack.setAttribute('class', 'wm-ring-track');

  const ringFill = document.createElementNS(SVG_NS, 'circle');
  ringFill.setAttribute('cx', '7');
  ringFill.setAttribute('cy', '7');
  ringFill.setAttribute('r', String(RING_RADIUS));
  ringFill.setAttribute('class', 'wm-ring-fill');
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUMFERENCE));

  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

  const ringSegs = [];
  for (let i = 0; i < 10; i += 1) {
    const segCircle = document.createElementNS(SVG_NS, 'circle');
    segCircle.setAttribute('cx', '7');
    segCircle.setAttribute('cy', '7');
    segCircle.setAttribute('r', String(RING_RADIUS));
    segCircle.setAttribute('class', 'wm-ring-seg');
    segCircle.setAttribute('hidden', '');
    ringSvg.appendChild(segCircle);
    ringSegs.push(segCircle);
  }

  const isNone = initialMetric === 'none';
  const isCtx = initialMetric === 'context';
  const isQuota =
    initialMetric === 'quota_auto' ||
    initialMetric === 'gemini_5h' ||
    initialMetric === 'gemini_weekly' ||
    initialMetric === 'claude_5h' ||
    initialMetric === 'claude_weekly';
  const isRingSlot = isCtx || isQuota;
  const textSpan = h('span', {
    className: isCtx
      ? 'wm-slot-text wm-ctx-pct'
      : isQuota
        ? 'wm-slot-text wm-ctx-pct wm-quota-text'
        : 'wm-slot-text',
    text: isNone
      ? ''
      : isRingSlot
        ? '--%'
        : initialMetric === 'tps'
          ? '-- t/s'
          : initialMetric === 'ttft'
            ? '--s'
            : '--',
  });
  const el = h(
    'span',
    {
      className: isNone
        ? 'wm-cap-slot'
        : isCtx
          ? 'wm-cap-slot wm-ctx-seg'
          : isQuota
            ? 'wm-cap-slot wm-ctx-seg wm-seg-quota'
            : initialMetric === 'tps'
              ? 'wm-cap-slot wm-seg-speed'
              : initialMetric === 'ttft'
                ? 'wm-cap-slot wm-seg-metric'
                : 'wm-cap-slot wm-seg-cost',
      hidden: isNone,
      'data-slot-idx': String(slotIndex),
      'data-metric': initialMetric,
      'data-vis-rank': isNone ? '' : String(slotIndex + 1),
    },
    isRingSlot ? [ringSvg, textSpan] : [textSpan]
  );

  return {
    el,
    ringSvg,
    ringFill,
    ringSegs,
    textSpan,
    ringMounted: isRingSlot,
  };
}

const CAPSULE_NUM_ANIM_MS = 420;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cancelSlotNumberAnim(slot) {
  if (slot?._numAnim?.rafId && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(slot._numAnim.rafId);
  }
  if (slot?._numAnim) {
    slot._numAnim.rafId = 0;
  }
}

export function cancelCapsuleSlotAnimations(capsuleSlots) {
  if (!Array.isArray(capsuleSlots)) return;
  for (const slot of capsuleSlots) {
    cancelSlotNumberAnim(slot);
    if (slot) slot._numAnim = null;
  }
}

function syncAnimatedSlotText(slot, metricKey, targetText, animSpec) {
  if (!animSpec || !Number.isFinite(Number(animSpec.value)) || typeof animSpec.format !== 'function') {
    cancelSlotNumberAnim(slot);
    slot._numAnim = null;
    patchText(slot.textSpan, targetText);
    return;
  }
  const targetVal = Number(animSpec.value);
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const canRaf = !reducedMotion && typeof globalThis.requestAnimationFrame === 'function';
  const prev = slot._numAnim;

  if (!canRaf || !prev || prev.metric !== metricKey) {
    cancelSlotNumberAnim(slot);
    slot._numAnim = {
      metric: metricKey,
      currentVal: targetVal,
      fromVal: targetVal,
      targetVal,
      targetText,
      format: animSpec.format,
      startMs: 0,
      durationMs: CAPSULE_NUM_ANIM_MS,
      rafId: 0,
    };
    patchText(slot.textSpan, targetText);
    return;
  }

  prev.targetText = targetText;
  prev.format = animSpec.format;

  if (Math.abs(targetVal - prev.targetVal) < 1e-4) {
    if (!prev.rafId) {
      prev.currentVal = targetVal;
      patchText(slot.textSpan, targetText);
    }
    return;
  }

  cancelSlotNumberAnim(slot);
  prev.fromVal = prev.currentVal;
  prev.targetVal = targetVal;
  prev.startMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  prev.durationMs = CAPSULE_NUM_ANIM_MS;

  const step = (frameNow) => {
    if (slot.el.isConnected === false || slot._numAnim !== prev) {
      prev.rafId = 0;
      return;
    }
    const now = Number.isFinite(frameNow) ? frameNow : Date.now();
    const elapsed = Math.max(0, now - prev.startMs);
    const progress = prev.durationMs > 0 ? Math.min(1, elapsed / prev.durationMs) : 1;
    const eased = easeInOutCubic(progress);
    const val = prev.fromVal + (prev.targetVal - prev.fromVal) * eased;
    prev.currentVal = val;
    patchText(slot.textSpan, progress >= 1 ? prev.targetText : prev.format(val));
    if (progress < 1) {
      prev.rafId = globalThis.requestAnimationFrame(step);
    } else {
      prev.currentVal = prev.targetVal;
      prev.rafId = 0;
    }
  };
  prev.rafId = globalThis.requestAnimationFrame(step);
}

/**
 * Patch 5 pre-allocated capsule slots and 4 separators in-place via `metricRegistry`.
 */
export function syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx) {
  let visRank = 0;
  const visRanks = [0, 0, 0, 0, 0];
  for (let i = 0; i < capsuleSlots.length; i += 1) {
    const slot = capsuleSlots[i];
    const metricKey = i < slotKeys.length ? slotKeys[i] : 'none';
    const pres = resolveCapsuleMetricPresentation(metricKey, slotCtx, RING_CIRCUMFERENCE);
    if (pres.hidden) {
      cancelSlotNumberAnim(slot);
      slot._numAnim = null;
      patchAttr(slot.el, 'hidden', true);
      patchAttr(slot.el, 'data-metric', 'none');
      patchAttr(slot.el, 'data-vis-rank', '');
      continue;
    }
    visRank += 1;
    visRanks[i] = visRank;
    patchAttr(slot.el, 'hidden', false);
    patchAttr(slot.el, 'data-metric', pres.metric);
    patchAttr(slot.el, 'data-vis-rank', String(visRank));

    if (pres.showRing && !slot.ringMounted) {
      slot.el.insertBefore(slot.ringSvg, slot.textSpan);
      slot.ringMounted = true;
    } else if (!pres.showRing && slot.ringMounted) {
      slot.ringSvg.remove();
      slot.ringMounted = false;
    }

    const toneCls =
      pres.toneClass || (pres.danger ? 'tone-danger' : pres.warn ? 'tone-warn' : '');
    const fullSegClass = `${pres.segClass}${pres.running ? ' state-running' : ''}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.el, 'class', fullSegClass);
    const fullTextClass = `${pres.textClass}${toneCls ? ` ${toneCls}` : ''}`;
    patchAttr(slot.textSpan, 'class', fullTextClass);
    syncAnimatedSlotText(slot, pres.metric, pres.text, pres.animSpec);

    if (pres.showRing) {
      const segList = Array.isArray(pres.ringSegments) ? pres.ringSegments : null;
      if (segList && segList.length > 0) {
        patchAttr(slot.ringFill, 'hidden', true);
        for (let k = 0; k < slot.ringSegs.length; k += 1) {
          const segNode = slot.ringSegs[k];
          if (k < segList.length) {
            const seg = segList[k];
            patchAttr(segNode, 'hidden', false);
            patchAttr(segNode, 'class', `wm-ring-seg ${seg.cls}`);
            segNode.setAttribute('stroke-dasharray', seg.dashArray);
            segNode.setAttribute('stroke-dashoffset', seg.dashOffset);
          } else {
            patchAttr(segNode, 'hidden', true);
          }
        }
      } else {
        patchAttr(slot.ringFill, 'hidden', false);
        for (let k = 0; k < slot.ringSegs.length; k += 1) {
          patchAttr(slot.ringSegs[k], 'hidden', true);
        }
        slot.ringFill.setAttribute('stroke-dashoffset', String(pres.dashOffset));
        patchClasses(slot.ringFill, { 'tone-warn': pres.warn, 'tone-danger': pres.danger });
      }
    }
  }

  for (let s = 0; s < capsuleSeps.length; s += 1) {
    const sepEl = capsuleSeps[s];
    const nextRank = visRanks[s + 1] || 0;
    const showSep = nextRank >= 2;
    patchAttr(sepEl, 'hidden', !showSep);
    patchAttr(sepEl, 'data-sep-for-rank', showSep ? String(nextRank) : '');
  }
}

/**
 * Standalone Capsule Bar Preview Widget mounting the real `.wm-multi-btn` and `.wm-capsule-btn`
 * inside a contextual host bar (`dual` titlebar, `composer` toolbar, or `sidebar` disabled state).
 */
export const CapsuleBarWidget = defineComponent({
  name: 'CapsuleBarWidget',
  setup() {
    const multiDot = h('span', { className: 'wm-multi-dot' });
    const multiLabel = h('span', {
      className: 'wm-multi-label',
      text: t('capsule.multiZero'),
    });
    const multiBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-multi-btn',
        tabindex: '-1',
        'aria-hidden': 'true',
      },
      [multiDot, multiLabel]
    );

    const capsuleSlots = [
      createCapsuleSlotNode(0, 'tps'),
      createCapsuleSlotNode(1, 'ttft'),
      createCapsuleSlotNode(2, 'context'),
      createCapsuleSlotNode(3, 'none'),
      createCapsuleSlotNode(4, 'none'),
    ];
    const capsuleSeps = [
      h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
      h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    ];

    const capsuleBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-capsule-btn',
        tabindex: '-1',
        'aria-hidden': 'true',
      },
      [
        capsuleSlots[0].el,
        capsuleSeps[0],
        capsuleSlots[1].el,
        capsuleSeps[1],
        capsuleSlots[2].el,
        capsuleSeps[2],
        capsuleSlots[3].el,
        capsuleSeps[3],
        capsuleSlots[4].el,
      ]
    );

    const capsuleCluster = h('div', { className: 'preview-capsule-cluster' }, [
      multiBtn,
      capsuleBtn,
    ]);

    // Contextual host chrome affordances for Titlebar vs Composer vs Sidebar-only
    const titlebarLeftMock = h('div', { className: 'preview-host-left is-titlebar' }, [
      h('span', { className: 'preview-win-title', text: 'Antigravity' }),
    ]);
    const composerLeftMock = h(
      'div',
      { className: 'preview-host-left is-composer', hidden: true },
      [
        h('span', { className: 'preview-composer-chip' }, [
          h('span', { text: 'Auto' }),
          createSvgIcon('chevron-down', { size: 10 }),
        ]),
        h('span', { className: 'preview-composer-chip' }, [
          h('span', { text: 'Carbon (High)' }),
          createSvgIcon('chevron-down', { size: 10 }),
        ]),
      ]
    );

    const titlebarRightMock = h('div', { className: 'preview-win-controls', 'aria-hidden': 'true' }, [
      h('span', { className: 'preview-win-dot' }),
      h('span', { className: 'preview-win-dot' }),
      h('span', { className: 'preview-win-dot' }),
    ]);
    const composerSendMock = h(
      'span',
      { className: 'preview-composer-send', 'aria-hidden': 'true', hidden: true },
      [createSvgIcon('arrow-up', { size: 11 })]
    );

    const hostBarEl = h(
      'div',
      { className: 'preview-capsule-bar', 'data-mount-mode': 'composer' },
      [titlebarLeftMock, composerLeftMock, capsuleCluster, titlebarRightMock, composerSendMock]
    );

    const sidebarHintEl = h('div', {
      className: 'preview-sidebar-note',
      hidden: true,
      text: t('settings.str.previewMountSidebarHint'),
    });

    const rootEl = h('div', { className: 'capsule-preview-widget' }, [hostBarEl, sidebarHintEl]);

    function update({ data } = {}) {
      const settings = data?.settings || {};
      const mountMode = normalizeClientWindowMountMode(
        settings.windowMountMode,
        settings.enableWindowOverlay
      );
      const showMulti = settings.showTopbarMultiSession !== false;
      const quotaDisplayMode = normalizeClientQuotaDisplayMode(settings.quotaDisplayMode);
      const slotKeys = normalizeClientTopbarSlots(settings.topbarCapsuleSlots);

      const isComposer = mountMode === 'composer';
      const isSidebar = mountMode === 'sidebar';
      patchAttr(hostBarEl, 'data-mount-mode', mountMode);
      patchClasses(hostBarEl, {
        'is-composer': isComposer,
        'is-sidebar-only': isSidebar,
      });

      patchAttr(titlebarLeftMock, 'hidden', isComposer);
      patchAttr(titlebarRightMock, 'hidden', isComposer);
      patchAttr(composerLeftMock, 'hidden', !isComposer);
      patchAttr(composerSendMock, 'hidden', !isComposer);
      patchAttr(sidebarHintEl, 'hidden', !isSidebar);
      patchText(sidebarHintEl, t('settings.str.previewMountSidebarHint'));

      patchAttr(multiBtn, 'hidden', !showMulti);

      if (!data) {
        patchClasses(multiBtn, { 'is-running': false, 'is-waiting': false });
        patchText(multiLabel, t('capsule.multiZero'));
        syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, {
          hasTelemetry: false,
          quotaDisplayMode,
        });
        return;
      }

      const { scopedConv, ctxAgent, aggregated } = resolveScopedConversation(
        data,
        'all',
        'auto'
      );
      const activeConv = data.activeConversation || {};
      const capActive = scopedConv || aggregated || activeConv;
      const ctx = ctxAgent?.context || capActive.context || activeConv.context || {};
      const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
      const totalTokens = Number(ctx.totalTokens || 0);
      const usedPct =
        limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(1)) : 0;
      const dashOffset = +(
        RING_CIRCUMFERENCE *
        (1 - Math.max(0, Math.min(100, usedPct)) / 100)
      ).toFixed(2);

      const rawRunningList = Array.isArray(data.runningConversations)
        ? data.runningConversations
        : [];
      const runningCount = rawRunningList.length;
      const runningSubCount = rawRunningList.reduce(
        (acc, item) => acc + Number(item.runningSubagentCount || 0),
        0
      );
      const hasWaiting = rawRunningList.some((item) => item.mainActivity?.phase === 'waiting');

      patchClasses(multiBtn, {
        'is-running': runningCount > 0 && !hasWaiting,
        'is-waiting': runningCount > 0 && hasWaiting,
      });
      const multiBtnText =
        runningCount > 0
          ? runningSubCount > 0
            ? t('capsule.multiRunningWithSubs', { count: runningCount, subs: runningSubCount })
            : t('capsule.multiRunning', { count: runningCount })
          : t('capsule.multiZero');
      patchText(multiLabel, multiBtnText);

      const isRunning = Boolean(aggregated?.isRunning || activeConv.isRunning);
      const capInTok = Math.max(0, Number(capActive.inputTokens || 0));
      const capCacheTok = Math.max(0, Number(capActive.cacheReadTokens || 0));
      const capOutTok = Math.max(0, Number(capActive.outputTokens || 0));
      const sessionTokens =
        Number(capActive.stepCount || 0) > 0 ||
        capActive.totalTokens != null ||
        capInTok + capCacheTok + capOutTok > 0
          ? Math.max(0, Number(capActive.totalTokens ?? capInTok + capCacheTok + capOutTok))
          : null;

      patchClasses(capsuleBtn, { 'is-running': isRunning });
      syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, {
        hasTelemetry: true,
        context: ctx,
        usedPct,
        dashOffset,
        isRunning,
        tps: capActive.latestTokPerSec ?? null,
        avgTps: capActive.avgTokPerSec ?? null,
        ttft: capActive.latestTtftSec ?? null,
        stepCost: capActive.latestStepCostUsd ?? null,
        sessionCost: capActive.sessionCostUsd ?? null,
        cacheHitPct:
          Number(capActive.stepCount || 0) > 0
            ? capActive.latestCacheHitPct ?? capActive.sessionCacheHitPct ?? null
            : null,
        latestPromptTokens: capActive.latestPromptTokens ?? null,
        sessionTokens,
        quotas: data.quotas,
        quotaDisplayMode,
      });
    }

    return {
      el: rootEl,
      refs: {
        update,
        multiBtn,
        capsuleBtn,
        capsuleSlots,
        capsuleSeps,
        hostBarEl,
      },
    };
  },
});
