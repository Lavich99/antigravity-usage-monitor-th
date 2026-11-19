/**
 * @fileoverview View 2: ConsumptionView ( ).
 * 5 Token 
 * 1. 3+3 Token/ 
 * USD/CNY / / 4 (`FourSegmentBar`) 
 * 2. `TrendAreaChart` SVG 
 * 3. Token 4 / / / / 
 * 4. Token 
 * 5. 12 4 Token / 
 */

import { defineComponent } from '../core/component.js';
import {
  h,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchStyleVar,
  patchText,
} from '../core/domPatch.js';
import {
  formatCnyApprox,
  formatDateSpanBadge,
  formatTokensPrecise,
  formatUsd,
  mergeModelsByDisplayName,
  normalizeModelDisplayMode,
  normalizeOrchestratorIdDisplayMode,
} from '../core/formatters.js';
import { i18nStore, isEnglishLocale, t } from '../i18n/index.js';
import { createSvgIcon } from '../icons/SvgIcon.js';
import { fetchTelemetry, telemetryStore } from '../store/telemetryStore.js';
import { getVisibleMonitorView, uiStore } from '../store/uiStore.js';
import {
  createTrendAreaChart,
  HEATMAP_DAYS_THRESHOLD,
} from '../components/charts/TrendAreaChart.js';
import { CustomDateTimePicker } from '../components/ui/CustomDateTimePicker.js';
import { CustomScrollbar } from '../components/ui/CustomScrollbar.js';
import { createFourSegmentBar } from '../components/ui/FourSegmentBar.js';
import { SegmentedControl } from '../components/ui/SegmentedControl.js';

/** */
function getConsumptionTimeRangeOptions() {
  return [
    { value: 'today', label: t('cons.rangeToday') },
    { value: '24h', label: t('cons.range24h') },
    { value: '7d', label: t('cons.range7d') },
    { value: '14d', label: t('cons.range14d') },
    { value: '30d', label: t('cons.range30d') },
    { value: 'all', label: t('cons.rangeAll') },
    { value: 'custom', label: t('cons.rangeCustom') },
  ];
}

export const ConsumptionView = defineComponent({
  name: 'ConsumptionView',
  setup({ onCleanup }) {
    // --- ---
    let draftStartMs = telemetryStore.getState().customStartMs;
    let draftEndMs = telemetryStore.getState().customEndMs;
    let hasUncommittedCustomDraft = false;

    const timeFilterSwitch = SegmentedControl({
      ariaLabel: t('cons.rangeAria'),
      modelValue: telemetryStore.getState().selectedTimeRange,
      options: getConsumptionTimeRangeOptions(),
      onUpdateModelValue: (nextRange) => {
        if (nextRange === 'custom') {
          const st = telemetryStore.getState();
          draftStartMs = st.customStartMs;
          draftEndMs = st.customEndMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(draftStartMs);
          endPicker.setValue(draftEndMs);
        } else {
          hasUncommittedCustomDraft = false;
        }
        telemetryStore.setState({ selectedTimeRange: nextRange });
        fetchTelemetry({ force: false });
      },
    });

    const startPicker = CustomDateTimePicker({
      modelValue: draftStartMs,
      onUpdateModelValue: (ms) => {
        draftStartMs = ms;
        hasUncommittedCustomDraft = true;
        startPicker.setValue(ms);
      },
    });

    const endPicker = CustomDateTimePicker({
      modelValue: draftEndMs,
      onUpdateModelValue: (ms) => {
        draftEndMs = ms;
        hasUncommittedCustomDraft = true;
        endPicker.setValue(ms);
      },
    });

    const applyCustomBtnLabel = h('span', { text: t('cons.applyFilter') });
    const applyCustomBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-primary',
        style: 'height: 26px; padding: 0 10px;',
        onClick: () => {
          const sMs = Number(draftStartMs || 0);
          const eMs = Number(draftEndMs || 0);
          const minMs = sMs > 0 && eMs > 0 ? Math.min(sMs, eMs) : sMs;
          const maxMs = sMs > 0 && eMs > 0 ? Math.max(sMs, eMs) : eMs;
          draftStartMs = minMs;
          draftEndMs = maxMs;
          hasUncommittedCustomDraft = false;
          startPicker.setValue(minMs);
          endPicker.setValue(maxMs);
          telemetryStore.setState({
            selectedTimeRange: 'custom',
            customStartMs: minMs,
            customEndMs: maxMs,
          });
          fetchTelemetry({ force: true });
        },
      },
      [createSvgIcon('check', { size: 12 }), applyCustomBtnLabel]
    );

    const rangeToSpan = h('span', { className: 'text-muted', text: t('cons.rangeTo') });
    const customRangeBar = h(
      'div',
      {
        style:
          'display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 8px; background: var(--surface-subtle); border: 1px solid var(--border-hairline); border-radius: var(--radius-xs);',
        hidden: true,
      },
      [
        startPicker.el,
        rangeToSpan,
        endPicker.el,
        applyCustomBtn,
      ]
    );

    // --- Section 1: ( 3 + 3 / / + 4 ) ---
    const dateSpanBadge = h('span', { className: 'cons-badge text-mono', text: '-- ~ --' });
    const heroTotalTokens = h('strong', { className: 'cons-hero-num text-mono', text: '0' });
    const heroTotalCalls = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.callsCount', { calls: 0 }) });
    const heroCostUsd = h('strong', { className: 'cons-hero-cost text-mono', text: '$0.00' });
    const heroCostCny = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: formatCnyApprox(0) });

    const cacheHitPctEl = h('strong', { className: 'cons-hero-cache text-mono', text: '0%' });
    const cacheTokensEl = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.cacheHitTokens', { tokens: 0 }) });

    const inputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-input); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const inputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const inputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.uncachedInput') });

    const cacheSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-cached); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const cacheMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const cacheSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.savedCost', { cost: '$0.00' }) });

    const outputSharePct = h('span', { className: 'text-mono', style: 'color: var(--ctx-output); font-weight: 600; font-size: var(--fs-base-sm);', text: '0%' });
    const outputMainTokens = h('strong', { className: 'cons-mid-num text-mono', text: '0' });
    const outputSubText = h('span', { className: 'text-muted text-mono', style: 'font-size: var(--fs-md);', text: t('cons.replyAndThink', { resp: 0, think: 0 }) });

    const overviewSegBar = createFourSegmentBar();
    const overviewTitleSpan = h('span', { text: t('cons.overviewTitle') });
    const totalTokensLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.totalTokens') });
    const estCostLabel = h('span', { className: 'text-muted', style: 'font-size: var(--fs-md);', text: t('cons.estCost') });
    const cacheHitRateLabel = h('span', { text: t('cons.cacheHitRate') });
    const newInputLabel = h('span', { text: t('cons.newInput') });
    const cacheReadLabel = h('span', { text: t('cons.cacheRead') });
    const outputUsageLabel = h('span', { text: t('cons.outputUsage') });

    const overviewPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header cons-overview-head' }, [
        h('span', { className: 'panel-title' }, [
          overviewTitleSpan,
          dateSpanBadge,
        ]),
        timeFilterSwitch.el,
      ]),
      customRangeBar,
      h('div', { className: 'cons-box cons-unified-matrix' }, [
        h('div', { className: 'cons-split-3' }, [
          h('div', { className: 'cons-col' }, [
            totalTokensLabel,
            h('div', { className: 'cons-baseline' }, [heroTotalTokens, heroTotalCalls]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            estCostLabel,
            h('div', { className: 'cons-baseline' }, [heroCostUsd, heroCostCny]),
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('span', { className: 'legend-left', style: 'font-size: var(--fs-md);' }, [
              h('span', { className: 'dot-swatch seg-cached' }),
              cacheHitRateLabel,
            ]),
            h('div', { className: 'cons-baseline' }, [cacheHitPctEl, cacheTokensEl]),
          ]),
        ]),
        h('div', { className: 'cons-split-3 cons-matrix-bottom' }, [
          h('div', { className: 'cons-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-input' }),
                newInputLabel,
              ]),
              inputSharePct,
            ]),
            inputMainTokens,
            inputSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-cached' }),
                cacheReadLabel,
              ]),
              cacheSharePct,
            ]),
            cacheMainTokens,
            cacheSubText,
          ]),
          h('div', { className: 'cons-col is-bordered-col' }, [
            h('div', { className: 'cons-sub-head' }, [
              h('span', { className: 'legend-left cons-sub-label' }, [
                h('span', { className: 'dot-swatch seg-output' }),
                outputUsageLabel,
              ]),
              outputSharePct,
            ]),
            outputMainTokens,
            outputSubText,
          ]),
        ]),
      ]),
      overviewSegBar.el,
    ]);

    // --- Section 2: ( SVG + / + ) ---
    const trendTitleSpan = h('span', { text: t('cons.trendTitle') });
    const trendRangeBadge = h('span', { className: 'cons-badge', text: t('cons.allTime') });
    const trendGranularityHint = h('span', {
      className: 'text-muted text-mono',
      style: 'font-size: var(--fs-sm);',
      text: t('cons.trendPointsHintHourly', { points: 0 }),
    });
    const trendChart = createTrendAreaChart();

    const trendPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          trendTitleSpan,
          trendRangeBadge,
        ]),
        trendGranularityHint,
      ]),
      trendChart.el,
    ]);

    // --- Section 3: ---
    const modelsTitleSpan = h('span', { className: 'panel-title', text: t('cons.topModels') });
    const modelsListEl = h('div', { className: 'cons-item-list' });
    const modelsPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        modelsTitleSpan,
      ]),
      modelsListEl,
    ]);

    // --- Section 4: ---
    const sourcesTitleSpan = h('span', { className: 'panel-title', text: t('cons.clientSources') });
    const sourcesListEl = h('div', { className: 'cons-item-list' });
    const sourcesPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        sourcesTitleSpan,
      ]),
      sourcesListEl,
    ]);

    // --- Section 5: (12 4 ) ---
    const monthlyTitleSpan = h('span', { className: 'panel-title', text: t('cons.monthlyTitle') });
    const monthlyYearBadge = h('span', { className: 'cons-badge text-mono', text: '2026' });
    const monthlyCols = Array.from({ length: 12 }, (_, idx) => {
      const costText = h('span', { className: 'month-cost text-mono', text: '' });
      const barThink = h('div', { className: 'month-seg seg-thinking' });
      const barOut = h('div', { className: 'month-seg seg-output' });
      const barCache = h('div', { className: 'month-seg seg-cached' });
      const barIn = h('div', { className: 'month-seg seg-input' });
      const stackWrap = h('div', { className: 'month-stack' }, [
        barThink,
        barOut,
        barCache,
        barIn,
      ]);
      const zeroDot = h('span', { className: 'month-zero-dot' });
      const monthLabel = h('span', { className: 'month-label', text: t('cons.monthLabel', { m: idx + 1 }) });
      const tokText = h('span', { className: 'month-tok text-mono', text: '' });

      const colEl = h('div', { className: 'month-col' }, [
        costText,
        h('div', { className: 'month-bar-well' }, [stackWrap, zeroDot]),
        monthLabel,
        tokText,
      ]);
      return {
        el: colEl,
        costText,
        stackWrap,
        zeroDot,
        barThink,
        barOut,
        barCache,
        barIn,
        monthLabel,
        tokText,
      };
    });

    const legInputSpan = h('span', { text: t('cons.legInput') });
    const legCacheSpan = h('span', { text: t('cons.legCache') });
    const legOutputSpan = h('span', { text: t('cons.legOutput') });
    const legThinkingSpan = h('span', { text: t('cons.legThinking') });

    const monthlyPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        monthlyTitleSpan,
        monthlyYearBadge,
      ]),
      h(
        'div',
        { className: 'monthly-grid' },
        monthlyCols.map((c) => c.el)
      ),
      h('div', { className: 'monthly-legend' }, [
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-input' }),
          legInputSpan,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-cached' }),
          legCacheSpan,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-output' }),
          legOutputSpan,
        ]),
        h('span', { className: 'legend-left' }, [
          h('span', { className: 'dot-swatch seg-thinking' }),
          legThinkingSpan,
        ]),
      ]),
    ]);

    const scrollInner = h(
      'div',
      {
        style: 'display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-3);',
      },
      [
        overviewPanel,
        trendPanel,
        modelsPanel,
        sourcesPanel,
        monthlyPanel,
      ]
    );

    const viewScrollbar = CustomScrollbar({
      contentEl: scrollInner,
      className: 'view-pane',
    });

    /**
 * DOM 4 
 */
    function createBreakdownItemRow() {
      const nameEl = h('strong', { className: 'cons-row-title' });
      const pctBadge = h('span', { className: 'cons-share-pill text-mono', text: '0%' });
      const totalTokEl = h('span', { className: 'cons-row-tok text-mono' });
      const costEl = h('strong', { className: 'cons-row-cost text-mono' });
      const segBar = createFourSegmentBar();

      const inLbl = h('span', { text: t('cons.footInput') });
      const cacheLbl = h('span', { text: t('cons.footCache') });
      const outLbl = h('span', { text: t('cons.footOutput') });
      const thinkLbl = h('span', { text: t('cons.footThinking') });
      const callsLbl = h('span', { text: t('cons.footCalls') });

      const inVal = h('strong', { className: 'text-mono' });
      const cacheVal = h('strong', { className: 'text-mono' });
      const outVal = h('strong', { className: 'text-mono' });
      const thinkVal = h('strong', { className: 'text-mono' });
      const callsVal = h('strong', { className: 'text-mono' });

      const rowEl = h('div', { className: 'cons-item-row' }, [
        h('div', { className: 'panel-header' }, [
          nameEl,
          h('span', { className: 'cons-row-metrics' }, [
            pctBadge,
            totalTokEl,
            costEl,
          ]),
        ]),
        segBar.el,
        h('div', { className: 'cons-item-foot' }, [
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-input' }),
            inLbl,
            inVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-cached' }),
            cacheLbl,
            cacheVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-output' }),
            outLbl,
            outVal,
          ]),
          h('span', { className: 'legend-left' }, [
            h('span', { className: 'dot-swatch seg-thinking' }),
            thinkLbl,
            thinkVal,
          ]),
          h('span', { className: 'legend-left' }, [
            callsLbl,
            callsVal,
          ]),
        ]),
      ]);

      return {
        el: rowEl,
        refs: {
          nameEl,
          pctBadge,
          totalTokEl,
          costEl,
          segBar,
          inLbl,
          cacheLbl,
          outLbl,
          thinkLbl,
          callsLbl,
          inVal,
          cacheVal,
          outVal,
          thinkVal,
          callsVal,
        },
      };
    }

    /**
 * 4 
 */
    function updateBreakdownItemRow(refs, item, grandTotalTokens, showTokensInHeader = true) {
      patchText(refs.inLbl, t('cons.footInput'));
      patchText(refs.cacheLbl, t('cons.footCache'));
      patchText(refs.outLbl, t('cons.footOutput'));
      patchText(refs.thinkLbl, t('cons.footThinking'));
      patchText(refs.callsLbl, t('cons.footCalls'));
      const displayLabel = item.label || item.name || item.shortName || '—';
      patchText(refs.nameEl, displayLabel);
      patchAttr(refs.nameEl, 'title', item.title || displayLabel);
      const total = Number(item.totalTokens || 0);
      const share = grandTotalTokens > 0 ? +((total / grandTotalTokens) * 100).toFixed(1) : 0;
      patchText(refs.pctBadge, `${share.toFixed(1)}%`);
      patchText(refs.totalTokEl, showTokensInHeader ? formatTokensPrecise(total) : '');
      patchAttr(refs.totalTokEl, 'hidden', !showTokensInHeader);
      const costVal = Number(item.costUsd || 0);
      const callsCount = Number(item.calls || 0);
      const isAllUnpriced =
        callsCount > 0 && Number(item.unpricedCalls || 0) >= callsCount && !(costVal > 0);
      patchText(
        refs.costEl,
        formatUsd(isAllUnpriced ? null : costVal, {
          precise: costVal > 0 && costVal < 0.1,
        })
      );

      const responseTok =
        item.responseTokens != null
          ? Number(item.responseTokens)
          : Math.max(0, Number(item.outputTokens || 0) - Number(item.thinkingTokens || 0));
      const thinkingTok = Number(item.thinkingTokens || 0);

      refs.segBar.update({
        inputTokens: Number(item.inputTokens || 0),
        cacheReadTokens: Number(item.cacheReadTokens || 0),
        responseTokens: responseTok,
        thinkingTokens: thinkingTok,
      });

      patchText(refs.inVal, formatTokensPrecise(item.inputTokens || 0));
      patchText(refs.cacheVal, formatTokensPrecise(item.cacheReadTokens || 0));
      patchText(refs.outVal, formatTokensPrecise(responseTok));
      patchText(refs.thinkVal, formatTokensPrecise(thinkingTok));
      patchText(refs.callsVal, String(Number(item.calls || 0)));
    }

    let latestSlice = null;
    let isDirty = false;

    let lastRenderedUsage = '';

    /**
 * 5 
 */
    function renderConsumptionData(slice) {
      if (!slice) return;
      const cons = slice.consumption || {};
      const preset =
        slice.range !== 'custom' && cons.presets?.[slice.range]
          ? cons.presets[slice.range]
          : null;
      const acct = preset?.account || cons.account || {};
      const rangeInfo = cons.selectedRange || {};
      const dateSpan = formatDateSpanBadge(rangeInfo.startMs, rangeInfo.endMs);
      const now = new Date();
      const currentMonthIdx = now.getMonth();
      const monthlyYear = cons.monthlyYear || now.getFullYear();
      const locale = i18nStore.getState().locale;
      
      const signature = JSON.stringify([
        locale, slice.range, slice.customStartMs, slice.customEndMs, slice.modelDisplayMode,
        slice.showUpstreamModel, slice.orchestratorIdMode, dateSpan,
        preset?.label || rangeInfo.label, acct,
        cons.trendSeries, slice.modelBreakdown, cons.sourcesBreakdown,
        monthlyYear, currentMonthIdx, cons.monthlySeries,
      ]);
      if (signature === lastRenderedUsage) return;
      drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear });
      lastRenderedUsage = signature;
    }

    function drawConsumptionData(slice, { cons, preset, acct, rangeInfo, dateSpan, currentMonthIdx, monthlyYear }) {
      timeFilterSwitch.setValue(slice.range);
      patchAttr(customRangeBar, 'hidden', slice.range !== 'custom');
      if (!hasUncommittedCustomDraft) {
        draftStartMs = slice.customStartMs;
        draftEndMs = slice.customEndMs;
        startPicker.setValue(draftStartMs);
        endPicker.setValue(draftEndMs);
      }

      // 1. 4
      patchText(dateSpanBadge, dateSpan);
      const totalTokens = Number(acct.totalTokens || 0);
      const inputTokens = Number(acct.inputTokens || 0);
      const cacheTokens = Number(acct.cacheReadTokens || 0);
      const outputTokens = Number(acct.outputTokens || 0);
      const responseTokens = Number(acct.responseTokens || 0);
      const thinkingTokens = Number(acct.thinkingTokens || 0);
      const costUsd = Number(acct.costUsd || 0);
      const savedCostUsd = Number(acct.savedCostUsd || 0);

      patchText(heroTotalTokens, formatTokensPrecise(totalTokens));
      patchText(heroTotalCalls, t('cons.callsCount', { calls: acct.calls || 0 }));
      patchText(heroCostUsd, formatUsd(costUsd));
      patchText(heroCostCny, formatCnyApprox(costUsd));

      patchText(cacheHitPctEl, `${Number(acct.cacheHitPct ?? 0).toFixed(1)}%`);
      patchText(cacheTokensEl, t('cons.cacheHitTokens', { tokens: formatTokensPrecise(cacheTokens) }));

      let inPct = 0;
      let cachePct = 0;
      let outPct = 0;
      if (totalTokens > 0) {
        const rawTenths = [
          (inputTokens / totalTokens) * 1000,
          (cacheTokens / totalTokens) * 1000,
          (outputTokens / totalTokens) * 1000,
        ];
        const floored = rawTenths.map((v) => Math.max(0, Math.floor(v)));
        const rem = Math.max(0, 1000 - (floored[0] + floored[1] + floored[2]));
        const order = [0, 1, 2].sort(
          (a, b) => rawTenths[b] - floored[b] - (rawTenths[a] - floored[a])
        );
        for (let k = 0; k < rem && k < 3; k++) {
          floored[order[k]] += 1;
        }
        inPct = +(floored[0] / 10).toFixed(1);
        cachePct = +(floored[1] / 10).toFixed(1);
        outPct = +(floored[2] / 10).toFixed(1);
      }

      patchText(inputSharePct, `${inPct}%`);
      patchText(inputMainTokens, formatTokensPrecise(inputTokens));
      patchText(inputSubText, t('cons.uncachedInput'));

      patchText(cacheSharePct, `${cachePct}%`);
      patchText(cacheMainTokens, formatTokensPrecise(cacheTokens));
      patchText(
        cacheSubText,
        t('cons.savedCost', {
          cost: formatUsd(savedCostUsd, { precise: savedCostUsd > 0 && savedCostUsd < 0.01 }),
        })
      );

      patchText(outputSharePct, `${outPct}%`);
      patchText(outputMainTokens, formatTokensPrecise(outputTokens));
      patchText(
        outputSubText,
        t('cons.replyAndThink', {
          resp: formatTokensPrecise(responseTokens),
          think: formatTokensPrecise(thinkingTokens),
        })
      );

      overviewSegBar.update({
        inputTokens,
        cacheReadTokens: cacheTokens,
        responseTokens,
        thinkingTokens,
      });

      // 2. SVG / GitHub >90
      const rangeBadgeText = isEnglishLocale()
        ? getConsumptionTimeRangeOptions().find((o) => o.value === slice.range)?.label ||
          t('cons.allTime')
        : preset?.label || rangeInfo.label || t('cons.allTime');
      patchText(trendRangeBadge, rangeBadgeText);
      const trendSeries = cons.trendSeries || [];
      const isHourlyTrend =
        trendSeries[0]?.granularity === 'hour' ||
        (trendSeries[0]?.label || '').includes(':');
      const isHeatmapTrend = !isHourlyTrend && trendSeries.length > HEATMAP_DAYS_THRESHOLD;
      patchText(
        trendGranularityHint,
        isHeatmapTrend
          ? t('cons.trendHeatmapHint', { days: trendSeries.length })
          : isHourlyTrend
            ? t('cons.trendPointsHintHourly', { points: trendSeries.length || 0 })
            : t('cons.trendPointsHintDaily', { points: trendSeries.length || 0 })
      );
      trendChart.update(trendSeries);

      // 3. Token
      const localeSig = i18nStore.getState().locale;
      const displaySettings = {
        modelDisplayMode: normalizeModelDisplayMode(
          slice.modelDisplayMode,
          slice.showUpstreamModel
        ),
        showUpstreamModel: Boolean(slice.showUpstreamModel),
        orchestratorIdMode: slice.orchestratorIdMode,
      };
      const models = mergeModelsByDisplayName(slice.modelBreakdown || [], displaySettings, {
        preferLabelInShort: true,
      }).sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
      const modelsTotalTok = models.reduce((s, m) => s + Number(m.totalTokens || 0), 0);

      patchKeyedList(modelsListEl, models, {
        keyFn: (m) => m.displayText || m.label || m.shortName,
        sigFn: (m) =>
          `${localeSig}:${m.displayText}:${m.displayTitle}:${m.totalTokens}:${m.costUsd}:${m.unpricedCalls}:${m.calls}:${modelsTotalTok}`,
        createRow: createBreakdownItemRow,
        updateRow: (refs, m) =>
          updateBreakdownItemRow(
            refs,
            { ...m, label: m.displayText, title: m.displayTitle },
            modelsTotalTok,
            true
          ),
      });

      
      const sources = cons.sourcesBreakdown || [];
      const sourcesTotalTok = sources.reduce((s, x) => s + Number(x.totalTokens || 0), 0);
      patchKeyedList(sourcesListEl, sources, {
        keyFn: (s) => s.name,
        sigFn: (s) => `${localeSig}:${s.name}:${s.totalTokens}:${s.costUsd}:${s.unpricedCalls}:${s.calls}:${sourcesTotalTok}`,
        createRow: createBreakdownItemRow,
        updateRow: (refs, s) => updateBreakdownItemRow(refs, s, sourcesTotalTok, true),
      });

      // 5. 12 8%
      patchText(monthlyYearBadge, String(monthlyYear));
      const monthlySeries = cons.monthlySeries || [];
      const maxMonthTokens = Math.max(
        1,
        ...monthlySeries.map((m) => Number(m.totalTokens || 0))
      );

      for (let i = 0; i < 12; i++) {
        const col = monthlyCols[i];
        const m = monthlySeries[i] || { totalTokens: 0, costUsd: 0 };
        const mTot = Number(m.totalTokens || 0);
        const hasData = mTot > 0;

        patchClasses(col.monthLabel, { 'is-current': i === currentMonthIdx });
        patchAttr(col.stackWrap, 'hidden', !hasData);
        patchAttr(col.zeroDot, 'hidden', hasData);

        if (!hasData) {
          patchText(col.costText, '');
          patchText(col.tokText, '');
        } else {
          const cVal = Number(m.costUsd || 0);
          patchText(
            col.costText,
            cVal >= 10 ? `$${Math.round(cVal)}` : `$${cVal.toFixed(2)}`
          );
          patchText(col.tokText, formatTokensPrecise(mTot));

          const totalHeightPct = Math.max(8, Math.min(100, (mTot / maxMonthTokens) * 100));
          patchStyleVar(col.stackWrap, '--bar-h', `${totalHeightPct.toFixed(1)}%`);

          const inPctM = (Number(m.inputTokens || 0) / mTot) * 100;
          const cachePctM = (Number(m.cacheReadTokens || 0) / mTot) * 100;
          const outPctM = (Number(m.responseTokens || 0) / mTot) * 100;
          const thinkPctM = (Number(m.thinkingTokens || 0) / mTot) * 100;

          patchStyleVar(col.barIn, '--seg-h', `${inPctM.toFixed(1)}%`);
          patchStyleVar(col.barCache, '--seg-h', `${cachePctM.toFixed(1)}%`);
          patchStyleVar(col.barOut, '--seg-h', `${outPctM.toFixed(1)}%`);
          patchStyleVar(col.barThink, '--seg-h', `${thinkPctM.toFixed(1)}%`);
        }
      }

      viewScrollbar.refresh();
    }

    const unsub = telemetryStore.subscribe(
      (st) => ({
        range: st.selectedTimeRange,
        customStartMs: st.customStartMs,
        customEndMs: st.customEndMs,
        consumption: st.telemetry?.consumption,
        modelBreakdown: st.telemetry?.modelBreakdown,
        modelDisplayMode: normalizeModelDisplayMode(
          st.telemetry?.settings?.modelDisplayMode,
          st.telemetry?.settings?.showUpstreamModel
        ),
        showUpstreamModel: Boolean(st.telemetry?.settings?.showUpstreamModel),
        orchestratorIdMode: normalizeOrchestratorIdDisplayMode(
          st.telemetry?.settings?.orchestratorIdMode
        ),
      }),
      (slice) => {
        latestSlice = slice;
        if (getVisibleMonitorView() !== 'consumption') {
          isDirty = true;
          return;
        }
        isDirty = false;
        renderConsumptionData(slice);
      }
    );

    const unsubView = uiStore.subscribe(
      getVisibleMonitorView,
      (activeView) => {
        if (activeView === 'consumption' && isDirty) {
          isDirty = false;
          if (latestSlice) {
            renderConsumptionData(latestSlice);
          }
        }
      }
    );

    function syncStaticLocaleLabels() {
      timeFilterSwitch.setProps({
        ariaLabel: t('cons.rangeAria'),
        options: getConsumptionTimeRangeOptions(),
      });
      patchText(applyCustomBtnLabel, t('cons.applyFilter'));
      patchText(rangeToSpan, t('cons.rangeTo'));
      patchText(overviewTitleSpan, t('cons.overviewTitle'));
      patchText(totalTokensLabel, t('cons.totalTokens'));
      patchText(estCostLabel, t('cons.estCost'));
      patchText(cacheHitRateLabel, t('cons.cacheHitRate'));
      patchText(newInputLabel, t('cons.newInput'));
      patchText(cacheReadLabel, t('cons.cacheRead'));
      patchText(outputUsageLabel, t('cons.outputUsage'));
      patchText(trendTitleSpan, t('cons.trendTitle'));
      patchText(modelsTitleSpan, t('cons.topModels'));
      patchText(sourcesTitleSpan, t('cons.clientSources'));
      patchText(monthlyTitleSpan, t('cons.monthlyTitle'));
      for (let i = 0; i < 12; i++) {
        patchText(monthlyCols[i].monthLabel, t('cons.monthLabel', { m: i + 1 }));
      }
      patchText(legInputSpan, t('cons.legInput'));
      patchText(legCacheSpan, t('cons.legCache'));
      patchText(legOutputSpan, t('cons.legOutput'));
      patchText(legThinkingSpan, t('cons.legThinking'));
    }

    const unsubI18n = i18nStore.subscribe(
      (st) => st.locale,
      () => {
        syncStaticLocaleLabels();
        if (getVisibleMonitorView() === 'consumption' && latestSlice) {
          isDirty = false;
          renderConsumptionData(latestSlice);
        } else {
          isDirty = true;
        }
      }
    );

    onCleanup(() => {
      unsub();
      unsubView();
      unsubI18n();
      trendChart.destroy?.();
      timeFilterSwitch.destroy();
      startPicker.destroy();
      endPicker.destroy();
      viewScrollbar.destroy();
    });

    return {
      el: viewScrollbar.el,
      refs: { timeFilterSwitch, startPicker, endPicker, viewScrollbar },
    };
  },
});
