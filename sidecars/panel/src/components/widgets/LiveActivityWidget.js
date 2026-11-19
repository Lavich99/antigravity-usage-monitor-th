/**
 * @fileoverview Standalone decoupled Live Running Tasks Widget (`LiveActivityWidget.js`).
 * Displays active multi-session running conversations & collapsible subagent activity
 * with an isolated 1s elapsed timer lifecycle.
 */

import { defineComponent } from '../../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import { formatElapsedSec } from '../../core/formatters.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { getEffectiveLocale, t, translateLiveActivityText } from '../../i18n/index.js';
import {
  fetchTelemetry,
  formatAgentBadgeText,
  getAgentBadgeClass,
  resolveScopedConversation,
  telemetryStore,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

export const LiveActivityWidget = defineComponent({
  name: 'LiveActivityWidget',
  setup({ props, onCleanup }) {
    const interactive = props.interactive !== false;
    const preview = Boolean(props.preview);
    const getCtxAgentId =
      typeof props.getCtxAgentId === 'function'
        ? props.getCtxAgentId
        : () => uiStore.getState().ctxInspectorAgentId;
    const isVisibleFn =
      typeof props.isVisibleFn === 'function' ? props.isVisibleFn : () => true;

    const liveActivityBar = h('div', {
      className: 'live-activity-list',
      hidden: true,
      'aria-live': 'polite',
    });

    const expandedTaskConvIds = new Set();
    const activityTimersMap = new Map();
    let liveTickTimer = null;
    let latestData = null;

    function bindLiveElapsedTimer(timerKey, sig, rawStartMs, targetEl) {
      const now = Date.now();
      const prev = activityTimersMap.get(timerKey);
      let startMs = prev?.startMs || 0;
      if (!prev || prev.sig !== sig) {
        const validRaw = Number(rawStartMs || 0);
        startMs = validRaw > 0 && validRaw <= now + 2000 ? validRaw : now;
      } else if (startMs <= 0 && Number(rawStartMs) > 0 && Number(rawStartMs) <= now + 2000) {
        startMs = Number(rawStartMs);
      }
      activityTimersMap.set(timerKey, { sig, startMs, el: targetEl });
      const elapsedSec = Math.max(0, (now - startMs) / 1000);
      patchText(targetEl, formatElapsedSec(elapsedSec));
    }

    function updateLiveElapsedDisplay() {
      const now = Date.now();
      for (const entry of activityTimersMap.values()) {
        if (!entry?.el) continue;
        const elapsedSec = entry.startMs > 0 ? Math.max(0, (now - entry.startMs) / 1000) : 0;
        patchText(entry.el, formatElapsedSec(elapsedSec));
      }
    }

    function pauseTicker() {
      if (liveTickTimer) {
        clearInterval(liveTickTimer);
        liveTickTimer = null;
      }
    }

    function stopLiveTicker() {
      pauseTicker();
      activityTimersMap.clear();
    }

    function ensureLiveTicker() {
      if (!isVisibleFn() || activityTimersMap.size === 0) {
        pauseTicker();
        return;
      }
      if (!liveTickTimer) {
        liveTickTimer = setInterval(updateLiveElapsedDisplay, 1000);
      }
    }

    function resumeTicker() {
      if (activityTimersMap.size > 0) {
        updateLiveElapsedDisplay();
        ensureLiveTicker();
      }
    }

    function createLiveTaskCard() {
      const dotIcon = createSvgIcon('dot', { size: 11 });
      patchClasses(dotIcon, { 'is-pulsing': true });
      const dotWrap = h('span', { className: 'live-activity-dot' }, [dotIcon]);
      const titleEl = h('strong', {
        className: 'live-task-title',
        text: t('live.currentSession'),
      });
      const subToggleBtn = h('button', {
        type: 'button',
        className: 'live-sub-toggle',
        hidden: true,
        text: t('live.subToggleIdle', { total: 0, arrow: '▸' }),
      });
      const elapsedEl = h('span', {
        className: 'live-activity-elapsed text-mono',
        text: '0s',
      });

      const headerEl = h('div', { className: 'live-task-header' }, [
        h('div', { className: 'live-task-title-wrap' }, [dotWrap, titleEl]),
        h('div', { className: 'live-task-header-right' }, [subToggleBtn, elapsedEl]),
      ]);

      const mainBadge = h('span', {
        className: 'agent-badge badge-main',
        hidden: true,
        text: t('fmt.mainBadge'),
      });
      const mainPhase = h('strong', {
        className: 'live-activity-phase',
        text: t('live.thinking'),
      });
      const mainProgress = h('span', {
        className: 'live-activity-progress text-mono',
        hidden: true,
        text: '',
      });
      const mainSep = h('span', { className: 'live-activity-sep', hidden: true, text: '·' });
      const mainDetail = h('span', {
        className: 'live-activity-detail',
        hidden: true,
        text: '',
      });

      const mainRowEl = h('div', { className: 'live-task-main-row' }, [
        mainBadge,
        mainPhase,
        mainProgress,
        mainSep,
        mainDetail,
      ]);

      const subListEl = h('div', { className: 'live-sub-list', hidden: true });
      const cardEl = h('div', { className: 'live-task-card' }, [headerEl, mainRowEl, subListEl]);

      return {
        el: cardEl,
        refs: {
          cardEl,
          dotIcon,
          titleEl,
          subToggleBtn,
          elapsedEl,
          mainBadge,
          mainPhase,
          mainProgress,
          mainSep,
          mainDetail,
          subListEl,
        },
      };
    }

    function createLiveSubRow() {
      const subBadge = h('span', {
        className: 'agent-badge badge-sub-1',
        text: t('fmt.subBadge', { index: 1 }),
      });
      const subRole = h('span', { className: 'live-sub-role', text: t('fmt.subAgent') });
      const subSummary = h('span', { className: 'live-sub-summary', text: '' });
      const subElapsed = h('span', { className: 'live-sub-elapsed text-mono', text: '0s' });

      const rowEl = h('div', { className: 'live-sub-row' }, [
        h('div', { className: 'live-sub-left' }, [subBadge, subRole, subSummary]),
        subElapsed,
      ]);

      return {
        el: rowEl,
        refs: {
          rowEl,
          subBadge,
          subRole,
          subSummary,
          subElapsed,
        },
      };
    }

    function update({ data } = {}) {
      latestData = data || null;
      if (!data) {
        patchAttr(liveActivityBar, 'hidden', true);
        stopLiveTicker();
        return;
      }

      const { agents, aggregated } = resolveScopedConversation(
        data,
        'all',
        getCtxAgentId()
      );

      const rawRunningList =
        Array.isArray(data.runningConversations) && data.runningConversations.length > 0
          ? data.runningConversations
          : data.activeConversation?.isRunning || aggregated?.isRunning
            ? [
                {
                  cascadeId: data.activeConversation?.cascadeId || 'current',
                  title: data.activeConversation?.title || t('live.currentSession'),
                  isCurrentSelected: true,
                  isMainRunning: Boolean(data.activeConversation?.isRunning),
                  isRunning: true,
                  mainActivity:
                    data.activeConversation?.liveActivity || aggregated?.liveActivity || null,
                  subagentCount: Math.max(0, agents.length - 1),
                  runningSubagentCount: agents.filter((a) => !a.isMain && a.isRunning).length,
                  subagents: agents
                    .filter((a) => !a.isMain)
                    .map((s, idx) => ({
                      cascadeId: s.cascadeId || s.agentId,
                      index: s.index || idx + 1,
                      badgeText: formatAgentBadgeText({ ...s, index: s.index || idx + 1 }),
                      shortLabel: s.shortLabel || `${t('fmt.subAgent')} #${idx + 1}`,
                      role: s.role || `${t('fmt.subAgent')} #${idx + 1}`,
                      isRunning: Boolean(s.isRunning),
                      stepCount: Number(s.stepCount || 0),
                      lastModifiedMs: s.lastModifiedMs || 0,
                      liveActivity: s.liveActivity || {
                        phase: s.isRunning ? 'thinking' : 'done',
                        label: s.isRunning ? t('live.thinking') : t('live.done'),
                        detail: '',
                        stepProgress: '',
                        startedAtMs: s.lastModifiedMs || 0,
                        signature: `${s.agentId}:${s.stepCount || 0}`,
                      },
                    })),
                },
              ]
            : [];

      const hasRunningTasks = rawRunningList.length > 0;
      patchAttr(liveActivityBar, 'hidden', !hasRunningTasks);
      if (!hasRunningTasks) {
        stopLiveTicker();
        expandedTaskConvIds.clear();
        return;
      }

      const activeTimerKeys = new Set();
      for (const item of rawRunningList) {
        activeTimerKeys.add(`main:${item.cascadeId}`);
        for (const sub of item.subagents || []) {
          if (sub?.isRunning) {
            activeTimerKeys.add(`sub:${sub.cascadeId}`);
          }
        }
      }

      const runningIdsSet = new Set(rawRunningList.map((item) => item.cascadeId));
      for (const id of [...expandedTaskConvIds]) {
        if (!runningIdsSet.has(id)) {
          expandedTaskConvIds.delete(id);
        }
      }

      const locale = getEffectiveLocale();
      patchKeyedList(liveActivityBar, rawRunningList, {
        keyFn: (item) => item.cascadeId,
        sigFn: (item) => {
          const isExp = interactive
            ? expandedTaskConvIds.has(item.cascadeId)
            : Number(item.runningSubagentCount || 0) > 0;
          const subSig = (item.subagents || [])
            .map(
              (s) =>
                `${s.cascadeId}:${s.isRunning}:${s.stepCount}:${s.liveActivity?.signature || ''}:${s.liveActivity?.startedAtMs || 0}`
            )
            .join('|');
          return `${locale}:${item.cascadeId}:${item.title}:${item.isMainRunning}:${item.subagentCount}:${item.runningSubagentCount}:${isExp}:${item.mainActivity?.signature || ''}:${item.mainActivity?.startedAtMs || 0}:${subSig}`;
        },
        createRow: createLiveTaskCard,
        updateRow: (refs, item) => {
          const act = item.mainActivity || {
            phase: 'thinking',
            label: t('live.thinking'),
            detail: '',
            stepProgress: '',
            startedAtMs: item.lastModifiedMs || 0,
            signature: `fallback:${item.lastModifiedMs || 0}`,
          };

          const isWaiting = act.phase === 'waiting';
          const isCompacting = act.phase === 'compacting';
          patchClasses(refs.cardEl, {
            'is-waiting': isWaiting,
            'is-compacting': isCompacting,
          });
          patchClasses(refs.dotIcon, { 'is-pulsing': true });

          const convTitle = item.title || item.cascadeId?.slice(0, 8) || t('live.currentSession');
          patchText(refs.titleEl, convTitle);
          if (interactive && !preview) {
            patchAttr(refs.titleEl, 'title', t('live.switchSessionTitle', { title: convTitle }));
            refs.titleEl.onclick = () => {
              if (item.cascadeId && item.cascadeId !== 'current') {
                uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
                telemetryStore.setState({ selectedConversationId: item.cascadeId });
                fetchTelemetry({ force: false });
              }
            };
          }

          const subCount = Number(item.subagentCount || item.subagents?.length || 0);
          const runSubCount = Number(item.runningSubagentCount || 0);
          const isExpanded = interactive
            ? expandedTaskConvIds.has(item.cascadeId)
            : runSubCount > 0;
          patchText(refs.mainBadge, t('fmt.mainBadge'));
          patchAttr(refs.mainBadge, 'hidden', subCount === 0);
          patchAttr(refs.subToggleBtn, 'hidden', subCount === 0);
          if (subCount > 0) {
            const arrow = isExpanded ? '▾' : '▸';
            const toggleText =
              runSubCount > 0
                ? t('live.subToggleRunning', { run: runSubCount, total: subCount, arrow })
                : t('live.subToggleIdle', { total: subCount, arrow });
            patchText(refs.subToggleBtn, toggleText);
            patchClasses(refs.subToggleBtn, { 'is-expanded': isExpanded });
            if (interactive) {
              patchAttr(
                refs.subToggleBtn,
                'title',
                isExpanded ? t('live.subCollapseTitle') : t('live.subExpandTitle')
              );
              refs.subToggleBtn.onclick = (e) => {
                e.stopPropagation();
                if (expandedTaskConvIds.has(item.cascadeId)) {
                  expandedTaskConvIds.delete(item.cascadeId);
                } else {
                  expandedTaskConvIds.add(item.cascadeId);
                }
                if (latestData) update({ data: latestData });
              };
            }
          }

          const mainTimerKey = `main:${item.cascadeId}`;
          activeTimerKeys.add(mainTimerKey);
          bindLiveElapsedTimer(
            mainTimerKey,
            `${item.cascadeId}:${act.signature || act.label}`,
            act.startedAtMs,
            refs.elapsedEl
          );

          const translatedActLabel = translateLiveActivityText(act.label) || t('live.thinking');
          patchText(refs.mainPhase, translatedActLabel);
          const progText = act.stepProgress ? `[${act.stepProgress}]` : '';
          patchAttr(refs.mainProgress, 'hidden', !progText);
          if (progText) {
            patchText(refs.mainProgress, progText);
          }

          const detailStr = translateLiveActivityText(act.detail || '');
          patchAttr(refs.mainSep, 'hidden', !detailStr);
          patchAttr(refs.mainDetail, 'hidden', !detailStr);
          patchText(refs.mainDetail, detailStr);

          if (interactive) {
            const fullTooltip = `[${convTitle}] ${t('fmt.mainAgent')} · ${translatedActLabel}${progText ? ` ${progText}` : ''}${detailStr ? ` · ${detailStr}` : ''}`;
            patchAttr(refs.cardEl, 'title', fullTooltip);
          }

          const showSubs = subCount > 0 && isExpanded;
          patchAttr(refs.subListEl, 'hidden', !showSubs);
          if (showSubs) {
            const subItems = item.subagents || [];
            patchKeyedList(refs.subListEl, subItems, {
              keyFn: (sub) => sub.cascadeId,
              sigFn: (sub) =>
                `${locale}:${sub.cascadeId}:${sub.role}:${sub.isRunning}:${sub.stepCount}:${sub.liveActivity?.signature || ''}:${sub.isRunning ? activityTimersMap.has(`sub:${sub.cascadeId}`) : true}`,
              createRow: createLiveSubRow,
              updateRow: (subRefs, sub) => {
                const subAct = sub.liveActivity || {
                  phase: sub.isRunning ? 'thinking' : 'done',
                  label: sub.isRunning ? t('live.thinking') : t('live.done'),
                  detail: '',
                  stepProgress: '',
                  startedAtMs: sub.lastModifiedMs || 0,
                };
                patchClasses(subRefs.rowEl, { 'is-done': !sub.isRunning });

                const badgeCls = getAgentBadgeClass(sub.index || 1, false);
                const subBadgeText = formatAgentBadgeText({
                  ...sub,
                  isMain: false,
                  index: sub.index || 1,
                });
                patchAttr(subRefs.subBadge, 'class', `agent-badge ${badgeCls}`);
                patchText(subRefs.subBadge, subBadgeText);

                const roleText = sub.role || sub.shortLabel || t('fmt.subAgent');
                patchText(subRefs.subRole, roleText);

                const rawSubLabel = sub.isRunning
                  ? translateLiveActivityText(subAct.label || '')
                  : translateLiveActivityText(subAct.label || '') || t('live.done');
                const subProg = subAct.stepProgress ? ` [${subAct.stepProgress}]` : '';
                const translatedSubDetail = translateLiveActivityText(subAct.detail || '');
                const summaryStr = [`${rawSubLabel}${subProg}`.trim(), translatedSubDetail]
                  .filter(Boolean)
                  .join(' ');
                patchAttr(subRefs.subSummary, 'hidden', !summaryStr);
                patchText(subRefs.subSummary, summaryStr);

                if (interactive) {
                  patchAttr(
                    subRefs.rowEl,
                    'title',
                    `[${subBadgeText}] ${roleText}${summaryStr ? ` ${summaryStr}` : ''}`
                  );
                }

                if (sub.isRunning) {
                  const subTimerKey = `sub:${sub.cascadeId}`;
                  activeTimerKeys.add(subTimerKey);
                  bindLiveElapsedTimer(
                    subTimerKey,
                    `${sub.cascadeId}:${subAct.signature || subAct.label}`,
                    subAct.startedAtMs,
                    subRefs.subElapsed
                  );
                } else {
                  activityTimersMap.delete(`sub:${sub.cascadeId}`);
                  patchText(
                    subRefs.subElapsed,
                    t('header.convMetaSteps', { count: sub.stepCount || 0 })
                  );
                }
              },
            });
          }
        },
      });

      for (const key of [...activityTimersMap.keys()]) {
        if (!activeTimerKeys.has(key)) {
          activityTimersMap.delete(key);
        }
      }
      updateLiveElapsedDisplay();
      ensureLiveTicker();
    }

    onCleanup(() => {
      stopLiveTicker();
    });

    return {
      el: liveActivityBar,
      refs: {
        update,
        pauseTicker,
        resumeTicker,
        stopLiveTicker,
      },
    };
  },
});
