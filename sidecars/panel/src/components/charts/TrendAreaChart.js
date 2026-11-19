/**
 * @fileoverview (TrendAreaChart).
 * 
 * 1. <= 90 
 * 2. > 90 GitHub 7 × 5 
 * 3. / Token 
 */

import { h, patchAttr, patchClasses, patchStyleVar, patchText } from '../../core/domPatch.js';
import { formatTokensPrecise, formatUsd } from '../../core/formatters.js';
import { getEffectiveLocale, isEnglishLocale, isThaiLocale } from '../../i18n/index.js';
import { SVG_NS } from '../../icons/SvgIcon.js';

const TREND_MONTH_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TREND_MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function getTrendCopy() {
  if (isThaiLocale()) {
    return {
      weekdays: ['จ', '', 'พ', '', 'ศ', '', 'อา'],
      gridAria: 'Heatmap การใช้งานรายวัน',
      less: 'น้อย',
      more: 'มาก',
      callsSuffix: ' ครั้ง',
      inLbl: 'In',
      cacheLbl: 'Cache',
      outLbl: 'Out',
      activeLbl: 'ใช้งาน',
      daysUnit: 'วัน',
      peakLbl: 'สูงสุด',
      formatMonth: (m, year, showYear) => {
        const name = TREND_MONTH_TH[m - 1] || String(m);
        return showYear ? `${name} ${String(year).slice(-2)}` : name;
      },
    };
  }
  if (isEnglishLocale()) {
    return {
      weekdays: ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'],
      gridAria: 'Daily usage heatmap',
      less: 'Less',
      more: 'More',
      callsSuffix: ' calls',
      inLbl: 'In',
      cacheLbl: 'Cache',
      outLbl: 'Out',
      activeLbl: 'Active',
      daysUnit: 'd',
      peakLbl: 'Peak',
      formatMonth: (m, year, showYear) => {
        const name = TREND_MONTH_EN[m - 1] || String(m);
        return showYear ? `${name} '${String(year).slice(-2)}` : name;
      },
    };
  }
  return {
    weekdays: ['Mo', '', 'We', '', 'Fr', '', 'Su'],
    gridAria: 'Daily usage activity heatmap',
    less: 'Less',
    more: 'More',
    callsSuffix: ' calls',
    inLbl: 'In',
    cacheLbl: 'Cache',
    outLbl: 'Out',
    activeLbl: 'Active',
    daysUnit: 'days',
    peakLbl: 'Peak',
    formatMonth: (m, year, showYear) => {
      const name = TREND_MONTH_EN[m - 1] || String(m);
      return showYear ? `${name} '${String(year).slice(-2)}` : name;
    },
  };
}

/** > 90 GitHub */
export const HEATMAP_DAYS_THRESHOLD = 90;

let chartUidCounter = 0;

function safeSlotTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * SVG (`M ... C ...`) 
 * X `0.42` Y 
 * (Overshoot) 
 *
 * @param {Array<{ x: number, y: number }>} points SVG >= 2 
 * @returns {string} SVG `<path>` `d` 
 */
function buildSmoothSplinePath(points) {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpx1 = p0.x + (p1.x - p0.x) * 0.42;
    const cpx2 = p1.x - (p1.x - p0.x) * 0.42;
    d += ` C ${cpx1.toFixed(1)} ${p0.y.toFixed(1)}, ${cpx2.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

/**
 * X 
 *
 * @param {Array<{ label?: string }>} slots
 * @returns {number[]}
 */
function computeTickIndices(slots) {
  const n = slots.length;
  if (n <= 1) return [0];
  if (n <= 8) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const sampleLabel = String(slots[Math.floor(n / 2)]?.label || slots[0]?.label || '');
  const maxTicks = sampleLabel.length > 6 ? 5 : 6;
  const set = new Set();
  for (let k = 0; k < maxTicks; k++) {
    const idx = Math.round((k / (maxTicks - 1)) * (n - 1));
    set.add(idx);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * 5 0 ~ 4 
 *
 * @param {number[]} nonZeroValues Token 
 * @param {number} maxTokens
 * @returns {{ q1: number, q2: number, q3: number, maxTokens: number, count: number }}
 */
function computeHeatmapThresholds(nonZeroValues, maxTokens) {
  const n = nonZeroValues.length;
  if (n === 0 || maxTokens <= 0) {
    return { q1: 0, q2: 0, q3: 0, maxTokens: 0, count: 0 };
  }
  if (n < 4) {
    return {
      q1: maxTokens * 0.25,
      q2: maxTokens * 0.5,
      q3: maxTokens * 0.75,
      maxTokens,
      count: n,
    };
  }
  return {
    q1: nonZeroValues[Math.floor((n - 1) * 0.25)],
    q2: nonZeroValues[Math.floor((n - 1) * 0.5)],
    q3: nonZeroValues[Math.floor((n - 1) * 0.75)],
    maxTokens,
    count: n,
  };
}

function resolveHeatmapLevel(tokens, thresholds) {
  if (tokens <= 0 || thresholds.maxTokens <= 0) return 0;
  if (tokens >= thresholds.maxTokens || tokens > thresholds.q3) return 4;
  if (tokens > thresholds.q2) return 3;
  if (tokens > thresholds.q1) return 2;
  return 1;
}

/**
 * `startMs` `label` 
 *
 * @param {object} slot
 * @returns {{ year: number, month: number, day: number }}
 */
function parseSlotCalendarParts(slot) {
  const sMs = Number(slot?.startMs);
  if (Number.isFinite(sMs) && sMs > 0) {
    const d = new Date(sMs);
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  const m = String(slot?.label || '').match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    return { year: new Date().getFullYear(), month: Number(m[1]), day: Number(m[2]) };
  }
  return { year: new Date().getFullYear(), month: 0, day: 0 };
}

/**
 * 
 *
 * @param {Array<object>} slots
 * @param {number} firstDow 0 = .. 6 = 
 * @param {number} totalWeeks 
 * @returns {Array<{ col: number, text: string }>}
 */
function buildHeatmapMonthTicks(slots, firstDow, totalWeeks) {
  if (!slots.length || totalWeeks <= 0) return [];
  const firstParts = parseSlotCalendarParts(slots[0]);
  const lastParts = parseSlotCalendarParts(slots[slots.length - 1]);
  const crossYear = firstParts.year !== lastParts.year;

  const candidates = [];
  let prevMonthKey = '';

  for (let col = 0; col < totalWeeks; col++) {
    let chosenParts = null;
    for (let row = 0; row < 7; row++) {
      const idx = col * 7 + row - firstDow;
      if (idx < 0 || idx >= slots.length) continue;
      const parts = parseSlotCalendarParts(slots[idx]);
      if (!parts.month) continue;
      const mKey = `${parts.year}-${parts.month}`;
      if (col === 0 && !chosenParts) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
      if (mKey !== prevMonthKey) {
        chosenParts = parts;
        prevMonthKey = mKey;
        break;
      }
    }
    if (chosenParts && chosenParts.month > 0) {
      candidates.push({ col, year: chosenParts.year, month: chosenParts.month });
    }
  }

  const baseMinGap = totalWeeks > 40 ? 4 : 3;
  if (
    candidates.length >= 2 &&
    candidates[0].col === 0 &&
    candidates[1].col - candidates[0].col < baseMinGap
  ) {
    candidates.shift();
  }

  const ticks = [];
  let nextAllowedCol = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (totalWeeks > 16 && c.col >= totalWeeks - 1) continue;
    if (ticks.length > 0 && c.col < nextAllowedCol) continue;
    const showYear = crossYear && (c.month === 1 || ticks.length === 0);
    const text = getTrendCopy().formatMonth(c.month, c.year, showYear);
    ticks.push({ col: c.col, text });
    nextAllowedCol = c.col + (showYear ? baseMinGap + 1 : baseMinGap);
  }
  return ticks;
}

/**
 * <=90 SVG >90 GitHub 
 *
 * @returns {{
 * el: HTMLElement,
 * update: (series?: Array<object>) => void
 * }}
 */
export function createTrendAreaChart() {
  const DEFAULT_VIEW_W = 460;
  const VIEW_H = 120;
  const TOP_Y = 24;
  const BOTTOM_Y = 102;
  const SPAN_Y = BOTTOM_Y - TOP_Y;

  let viewW = DEFAULT_VIEW_W;

  function resolvePlotBounds(w) {
    const leftX = 1;
    const rightX = Math.max(leftX + 20, w - 1);
    return { leftX, rightX, spanX: rightX - leftX };
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
  svg.setAttribute('class', 'trend-svg');
  svg.setAttribute('aria-hidden', 'true');

  // ID SVG url(#...)
  const gradId = `trend-area-grad-${++chartUidCounter}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.setAttribute('id', gradId);
  grad.setAttribute('x1', '0');
  grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '0');
  grad.setAttribute('y2', '1');

  const stop1 = document.createElementNS(SVG_NS, 'stop');
  stop1.setAttribute('offset', '0%');
  stop1.setAttribute('stop-color', 'var(--ctx-cached)');
  stop1.setAttribute('stop-opacity', '0.34');

  const stop2 = document.createElementNS(SVG_NS, 'stop');
  stop2.setAttribute('offset', '100%');
  stop2.setAttribute('stop-color', 'var(--ctx-cached)');
  stop2.setAttribute('stop-opacity', '0.0');

  grad.appendChild(stop1);
  grad.appendChild(stop2);
  defs.appendChild(grad);
  svg.appendChild(defs);

  // 0..viewW
  const hGridGroup = document.createElementNS(SVG_NS, 'g');
  hGridGroup.setAttribute('class', 'trend-grid');
  const hGridLines = [];
  for (const y of [TOP_Y, Math.round((TOP_Y + BOTTOM_Y) / 2), BOTTOM_Y]) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(viewW));
    line.setAttribute('y2', String(y));
    hGridGroup.appendChild(line);
    hGridLines.push(line);
  }
  svg.appendChild(hGridGroup);

  const vGridGroup = document.createElementNS(SVG_NS, 'g');
  vGridGroup.setAttribute('class', 'trend-grid trend-v-grid');
  svg.appendChild(vGridGroup);

  const areaPath = document.createElementNS(SVG_NS, 'path');
  areaPath.setAttribute('fill', `url(#${gradId})`);
  svg.appendChild(areaPath);

  const linePath = document.createElementNS(SVG_NS, 'path');
  linePath.setAttribute('class', 'trend-line');
  linePath.setAttribute('fill', 'none');
  svg.appendChild(linePath);

  const dotsGroup = document.createElementNS(SVG_NS, 'g');
  dotsGroup.setAttribute('class', 'trend-dots-group');
  svg.appendChild(dotsGroup);

  const peakDot = document.createElementNS(SVG_NS, 'circle');
  peakDot.setAttribute('r', '3');
  peakDot.setAttribute('class', 'trend-peak-dot');
  svg.appendChild(peakDot);

  
  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('class', 'trend-hover-line');
  hoverLine.setAttribute('y1', '12');
  hoverLine.setAttribute('y2', String(BOTTOM_Y));
  hoverLine.setAttribute('hidden', 'true');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '3.2');
  hoverDot.setAttribute('class', 'trend-hover-dot');
  hoverDot.setAttribute('hidden', 'true');
  svg.appendChild(hoverDot);

  const peakPill = h('span', { className: 'trend-peak-pill text-mono', text: '0' });

  
  const tipTimeEl = h('span', { className: 'trend-tip-time text-mono' });
  const tipCallsEl = h('span', { className: 'trend-tip-calls text-mono' });
  const tipTokensEl = h('strong', { className: 'trend-tip-tokens text-mono' });
  const tipCostEl = h('span', { className: 'trend-tip-cost text-mono' });
  const tipSubEl = h('div', { className: 'trend-tip-sub text-mono', hidden: true });

  const tooltipEl = h(
    'div',
    { className: 'trend-tooltip', hidden: true },
    [
      h('div', { className: 'trend-tip-head' }, [tipTimeEl, tipCallsEl]),
      h('div', { className: 'trend-tip-main' }, [tipTokensEl, tipCostEl]),
      tipSubEl,
    ]
  );

  
  const xAxisEl = h('div', { className: 'trend-x-axis' });
  const plotStage = h('div', { className: 'trend-plot-stage' }, [peakPill, svg]);

  // GitHub > 90
  const initTrendCopy = getTrendCopy();
  const hmWeekdaySpans = initTrendCopy.weekdays.map((txt) =>
    h('span', { className: 'trend-hm-wday', text: txt })
  );
  const hmWeekdaysEl = h('div', { className: 'trend-hm-weekdays', 'aria-hidden': 'true' }, [
    h('span', { className: 'trend-hm-month-spacer' }),
    ...hmWeekdaySpans,
  ]);
  const hmMonthsEl = h('div', { className: 'trend-hm-months' });
  const hmGridEl = h('div', { className: 'trend-hm-grid', role: 'grid', 'aria-label': initTrendCopy.gridAria });
  const hmTrackEl = h('div', { className: 'trend-hm-track' }, [hmMonthsEl, hmGridEl]);
  const hmScrollEl = h('div', { className: 'trend-hm-scroll' }, [hmTrackEl]);
  const hmBodyEl = h('div', { className: 'trend-heatmap-body' }, [hmWeekdaysEl, hmScrollEl]);

  const hmSummaryEl = h('span', { className: 'trend-hm-summary text-mono', text: '' });
  const hmLessEl = h('span', { text: initTrendCopy.less });
  const hmMoreEl = h('span', { text: initTrendCopy.more });
  const hmLegendEl = h('span', { className: 'trend-hm-legend', 'aria-hidden': 'true' }, [
    hmLessEl,
    h('span', { className: 'trend-hm-swatch lv-0' }),
    h('span', { className: 'trend-hm-swatch lv-1' }),
    h('span', { className: 'trend-hm-swatch lv-2' }),
    h('span', { className: 'trend-hm-swatch lv-3' }),
    h('span', { className: 'trend-hm-swatch lv-4' }),
    hmMoreEl,
  ]);
  const hmFooterEl = h('div', { className: 'trend-hm-footer' }, [hmSummaryEl, hmLegendEl]);
  const heatmapStage = h('div', { className: 'trend-heatmap-stage', hidden: true }, [
    hmBodyEl,
    hmFooterEl,
  ]);

  const chartWrap = h('div', { className: 'trend-chart-wrap' }, [
    plotStage,
    xAxisEl,
    heatmapStage,
    tooltipEl,
  ]);

  let currentSlots = [];
  let currentPts = [];
  let currentIsHeatmap = false;
  let currentHeatmapWeeks = 0;
  let currentCellEls = [];
  let tickElsByIdx = new Map();
  let hoveredIdx = -1;
  let hoveredCellEl = null;
  let lastRenderSig = '';

  function populateTooltipContent(slot) {
    const tc = getTrendCopy();
    patchText(tipTimeEl, slot.fullLabel || slot.label || '--');
    patchText(tipCallsEl, `${Math.max(0, Math.floor(Number(slot.calls) || 0))}${tc.callsSuffix}`);
    const slotTok = safeSlotTokens(slot.tokens);
    patchText(tipTokensEl, `${formatTokensPrecise(slotTok)} tok`);
    const slotCost = Number.isFinite(Number(slot.costUsd)) ? Math.max(0, Number(slot.costUsd)) : 0;
    patchText(
      tipCostEl,
      formatUsd(slotCost, {
        precise: slotCost > 0 && slotCost < 0.1,
      })
    );

    const hasSubBreakdown =
      slotTok > 0 &&
      (slot.inputTokens !== undefined ||
        slot.cacheReadTokens !== undefined ||
        slot.outputTokens !== undefined);
    patchAttr(tipSubEl, 'hidden', !hasSubBreakdown);
    if (hasSubBreakdown) {
      patchText(
        tipSubEl,
        `${tc.inLbl} ${formatTokensPrecise(safeSlotTokens(slot.inputTokens))} · ${tc.cacheLbl} ${formatTokensPrecise(safeSlotTokens(slot.cacheReadTokens))} · ${tc.outLbl} ${formatTokensPrecise(safeSlotTokens(slot.outputTokens))}`
      );
    }
  }

  function showLineHoverAtIndex(idx) {
    if (currentIsHeatmap || idx < 0 || idx >= currentSlots.length || !currentPts[idx]) {
      clearHover();
      return;
    }
    hoveredIdx = idx;
    const slot = currentSlots[idx];
    const pt = currentPts[idx];

    patchAttr(hoverLine, 'hidden', false);
    patchAttr(hoverLine, 'x1', pt.x.toFixed(1));
    patchAttr(hoverLine, 'x2', pt.x.toFixed(1));

    patchAttr(hoverDot, 'hidden', false);
    patchAttr(hoverDot, 'cx', pt.x.toFixed(1));
    patchAttr(hoverDot, 'cy', pt.y.toFixed(1));

    patchAttr(peakPill, 'hidden', true);
    patchClasses(tooltipEl, { 'is-hm-bottom': false, 'is-hm-top': false });
    patchAttr(tooltipEl, 'hidden', false);
    populateTooltipContent(slot);

    const rawPct = (pt.x / viewW) * 100;
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);

    for (const [tIdx, el] of tickElsByIdx.entries()) {
      patchClasses(el, { 'is-hovered': tIdx === idx });
    }
  }

  function showHeatmapHoverAtIndex(idx, cellEl) {
    if (!currentIsHeatmap || idx < 0 || idx >= currentSlots.length) {
      clearHover();
      return;
    }
    const targetCell = cellEl || currentCellEls[idx] || null;
    if (!targetCell) {
      clearHover();
      return;
    }
    hoveredIdx = idx;
    if (hoveredCellEl && hoveredCellEl !== targetCell) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
    }
    hoveredCellEl = targetCell;
    patchClasses(targetCell, { 'is-hovered': true });

    const slot = currentSlots[idx];
    const row = Number(targetCell.getAttribute('data-hm-row') || 0);
    const col = Number(targetCell.getAttribute('data-hm-col') || 0);

    // ~ ~
    patchClasses(tooltipEl, {
      'is-hm-bottom': row <= 3,
      'is-hm-top': row > 3,
    });
    patchAttr(tooltipEl, 'hidden', false);
    populateTooltipContent(slot);

    const wrapRect = chartWrap.getBoundingClientRect();
    const cellRect = targetCell.getBoundingClientRect();
    let rawPct = 50;
    if (
      wrapRect &&
      wrapRect.width > 0 &&
      cellRect &&
      cellRect.width > 0 &&
      cellRect.width < wrapRect.width
    ) {
      rawPct = ((cellRect.left + cellRect.width / 2 - wrapRect.left) / wrapRect.width) * 100;
    } else if (currentHeatmapWeeks > 0) {
      rawPct = ((col + 0.5) / currentHeatmapWeeks) * 100;
    }
    const clampedPct = Math.max(1, Math.min(99, rawPct));
    patchStyleVar(tooltipEl, '--tip-x', `${clampedPct.toFixed(1)}%`);
    patchStyleVar(tooltipEl, '--tip-shift', `-${clampedPct.toFixed(1)}%`);
  }

  function clearHover() {
    hoveredIdx = -1;
    patchAttr(hoverLine, 'hidden', true);
    patchAttr(hoverDot, 'hidden', true);
    patchAttr(tooltipEl, 'hidden', true);
    patchClasses(tooltipEl, { 'is-hm-bottom': false, 'is-hm-top': false });
    if (!currentIsHeatmap) {
      patchAttr(peakPill, 'hidden', false);
    }
    if (hoveredCellEl) {
      patchClasses(hoveredCellEl, { 'is-hovered': false });
      hoveredCellEl = null;
    }
    for (const el of tickElsByIdx.values()) {
      patchClasses(el, { 'is-hovered': false });
    }
  }

  function syncViewWidth() {
    const measured = Math.round(
      plotStage.clientWidth ||
        svg.clientWidth ||
        plotStage.getBoundingClientRect?.()?.width ||
        0
    );
    if (measured >= 160 && measured !== viewW) {
      viewW = measured;
      svg.setAttribute('viewBox', `0 0 ${viewW} ${VIEW_H}`);
      for (const line of hGridLines) {
        line.setAttribute('x1', '0');
        line.setAttribute('x2', String(viewW));
      }
      return true;
    }
    return false;
  }

  function handlePointerMove(e) {
    if (currentIsHeatmap || !currentSlots.length) return;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const relX = ((e.clientX - rect.left) / rect.width) * viewW;
    const { leftX, spanX } = resolvePlotBounds(viewW);
    const ratio = (relX - leftX) / Math.max(1, spanX);
    const idx = Math.max(
      0,
      Math.min(currentSlots.length - 1, Math.round(ratio * (currentSlots.length - 1)))
    );
    showLineHoverAtIndex(idx);
  }

  function findHeatmapCellFromEvent(e) {
    let cur = e?.target || null;
    while (cur && cur !== hmGridEl) {
      const idxAttr = cur.getAttribute?.('data-slot-idx');
      if (idxAttr !== null && idxAttr !== undefined && idxAttr !== '') {
        return { idx: Number(idxAttr), cellEl: cur };
      }
      cur = cur.parentNode || null;
    }
    return null;
  }

  function handleHeatmapPointer(e) {
    if (!currentIsHeatmap || !currentSlots.length) return;
    const hit = findHeatmapCellFromEvent(e);
    if (!hit || !Number.isFinite(hit.idx)) {
      clearHover();
      return;
    }
    if (hit.idx !== hoveredIdx || hit.cellEl !== hoveredCellEl) {
      showHeatmapHoverAtIndex(hit.idx, hit.cellEl);
    }
  }

  function handleHeatmapWheel(e) {
    if (!currentIsHeatmap) return;
    const maxScrollLeft = (hmScrollEl.scrollWidth || 0) - (hmScrollEl.clientWidth || 0);
    if (maxScrollLeft <= 2) return;
    const dy = Number(e.deltaY || 0);
    const dx = Number(e.deltaX || 0);
    if (Math.abs(dy) > Math.abs(dx) && dy !== 0) {
      const prev = hmScrollEl.scrollLeft || 0;
      const next = Math.max(0, Math.min(maxScrollLeft, prev + dy));
      if (next !== prev) {
        hmScrollEl.scrollLeft = next;
        e.preventDefault?.();
      }
    }
  }

  plotStage.addEventListener('mousemove', handlePointerMove);
  plotStage.addEventListener('mouseleave', clearHover);

  hmGridEl.addEventListener('mouseover', handleHeatmapPointer);
  hmGridEl.addEventListener('mousemove', handleHeatmapPointer);
  hmGridEl.addEventListener('click', handleHeatmapPointer);
  hmGridEl.addEventListener('mouseleave', clearHover);
  hmScrollEl.addEventListener('wheel', handleHeatmapWheel);

  let resizeObs = null;
  let onWinResize = null;
  if (typeof ResizeObserver === 'function') {
    resizeObs = new ResizeObserver(() => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    });
    resizeObs.observe(plotStage);
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    onWinResize = () => {
      if (!currentIsHeatmap && syncViewWidth() && currentSlots.length > 0) {
        lastRenderSig = '';
        update(currentSlots);
      }
    };
    window.addEventListener('resize', onWinResize);
  }

  function destroy() {
    resizeObs?.disconnect();
    resizeObs = null;
    if (onWinResize && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onWinResize);
      onWinResize = null;
    }
  }

  /**
 * <=90 / GitHub >90 
 */
  function update(series = []) {
    const slots =
      Array.isArray(series) && series.length >= 1
        ? series
        : [
            { label: '00:00', fullLabel: '00:00 - 01:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '06:00', fullLabel: '06:00 - 07:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '12:00', fullLabel: '12:00 - 13:00', tokens: 0, calls: 0, costUsd: 0 },
            { label: '18:00', fullLabel: '18:00 - 19:00', tokens: 0, calls: 0, costUsd: 0 },
          ];
    currentSlots = slots;

    const isHourly =
      slots[0]?.granularity === 'hour' || String(slots[0]?.label || '').includes(':');
    const useHeatmap = !isHourly && slots.length > HEATMAP_DAYS_THRESHOLD;
    const modeChanged = useHeatmap !== currentIsHeatmap;
    currentIsHeatmap = useHeatmap;

    if (modeChanged) {
      clearHover();
    }
    patchClasses(chartWrap, { 'is-heatmap': useHeatmap });
    patchAttr(plotStage, 'hidden', useHeatmap);
    patchAttr(xAxisEl, 'hidden', useHeatmap);
    patchAttr(heatmapStage, 'hidden', !useHeatmap);

    if (!useHeatmap) {
      syncViewWidth();
    }

    let maxTokens = 0;
    let peakIdx = 0;
    let activeDays = 0;
    const nonZeroVals = [];

    for (let i = 0; i < slots.length; i++) {
      const t = safeSlotTokens(slots[i]?.tokens);
      if (t > 0) {
        activeDays++;
        nonZeroVals.push(t);
      }
      if (t >= maxTokens) {
        maxTokens = t;
        peakIdx = i;
      }
    }

    const tc = getTrendCopy();
    const sig =
      `${getEffectiveLocale()}|${useHeatmap ? 'hm' : `line:${viewW}`}|` +
      slots
        .map(
          (s) =>
            `${s?.startMs || ''}:${s?.label || ''}:${s?.fullLabel || ''}:${safeSlotTokens(s?.tokens)}:${Number(s?.costUsd || 0)}:${Number(s?.calls || 0)}`
        )
        .join('|');

    if (useHeatmap) {
      tc.weekdays.forEach((txt, idx) => {
        if (hmWeekdaySpans[idx]) patchText(hmWeekdaySpans[idx], txt);
      });
      patchAttr(hmGridEl, 'aria-label', tc.gridAria);
      patchText(hmLessEl, tc.less);
      patchText(hmMoreEl, tc.more);
      currentPts = [];
      if (sig !== lastRenderSig) {
        lastRenderSig = sig;
        nonZeroVals.sort((a, b) => a - b);
        const thresholds = computeHeatmapThresholds(nonZeroVals, maxTokens);

        const firstStartMs = Number(slots[0]?.startMs);
        const firstDow =
          Number.isFinite(firstStartMs) && firstStartMs > 0
            ? (new Date(firstStartMs).getDay() + 6) % 7
            : 0;
        const totalCells = firstDow + slots.length;
        const totalWeeks = Math.max(1, Math.ceil(totalCells / 7));
        currentHeatmapWeeks = totalWeeks;

        patchStyleVar(hmBodyEl, '--hm-weeks', String(totalWeeks));
        patchStyleVar(hmBodyEl, '--hm-gap', totalWeeks > 42 ? '1.5px' : '2px');

        
        while (hmMonthsEl.firstChild) hmMonthsEl.removeChild(hmMonthsEl.firstChild);
        const monthTicks = buildHeatmapMonthTicks(slots, firstDow, totalWeeks);
        for (const mt of monthTicks) {
          const mEl = h('span', { className: 'trend-hm-month text-mono', text: mt.text });
          patchStyleVar(mEl, '--hm-col', String(mt.col));
          hmMonthsEl.appendChild(mEl);
        }

        // 7 × N
        while (hmGridEl.firstChild) hmGridEl.removeChild(hmGridEl.firstChild);
        hoveredCellEl = null;
        currentCellEls = new Array(slots.length);

        for (let pad = 0; pad < firstDow; pad++) {
          hmGridEl.appendChild(
            h('span', { className: 'trend-hm-cell is-pad', 'aria-hidden': 'true' })
          );
        }

        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i];
          const tok = safeSlotTokens(slot?.tokens);
          const lv = resolveHeatmapLevel(tok, thresholds);
          const gridPos = firstDow + i;
          const col = Math.floor(gridPos / 7);
          const row = gridPos % 7;
          const cellEl = h('span', {
            className: `trend-hm-cell lv-${lv}`,
            'data-slot-idx': String(i),
            'data-hm-col': String(col),
            'data-hm-row': String(row),
            role: 'gridcell',
          });
          hmGridEl.appendChild(cellEl);
          currentCellEls[i] = cellEl;
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (hmScrollEl.scrollWidth > hmScrollEl.clientWidth) {
              hmScrollEl.scrollLeft = hmScrollEl.scrollWidth;
            }
          });
        }
      }

      const peakSlot = slots[peakIdx];
      const summaryText =
        maxTokens > 0 && peakSlot?.label
          ? `${tc.activeLbl} ${activeDays}/${slots.length} ${tc.daysUnit} · ${tc.peakLbl} ${peakSlot.label} · ${formatTokensPrecise(maxTokens)}`
          : `${tc.activeLbl} 0/${slots.length} ${tc.daysUnit}`;
      patchText(hmSummaryEl, summaryText);

      if (hoveredIdx >= slots.length) {
        clearHover();
      } else if (hoveredIdx >= 0) {
        showHeatmapHoverAtIndex(hoveredIdx, currentCellEls[hoveredIdx]);
      }
      return;
    }

    // --- <= 90 1:1 ---
    currentCellEls = [];
    const { leftX, rightX, spanX } = resolvePlotBounds(viewW);
    const denom = Math.max(1, maxTokens);
    const isSingle = slots.length === 1;
    const pts = slots.map((s, idx) => {
      const tok = safeSlotTokens(s?.tokens);
      const x = isSingle
        ? (leftX + rightX) / 2
        : leftX + (idx / Math.max(1, slots.length - 1)) * spanX;
      const ratio = maxTokens > 0 ? tok / denom : 0;
      const y = BOTTOM_Y - ratio * SPAN_Y;
      return { x, y, tokens: tok };
    });
    currentPts = pts;

    if (sig !== lastRenderSig) {
      lastRenderSig = sig;
      let lineD;
      let areaD;
      if (isSingle) {
        const yStr = pts[0].y.toFixed(1);
        lineD = `M ${leftX.toFixed(1)} ${yStr} L ${rightX.toFixed(1)} ${yStr}`;
        areaD = `${lineD} L ${rightX.toFixed(1)} ${BOTTOM_Y} L ${leftX.toFixed(1)} ${BOTTOM_Y} Z`;
      } else {
        lineD = buildSmoothSplinePath(pts);
        areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${BOTTOM_Y} L ${pts[0].x.toFixed(1)} ${BOTTOM_Y} Z`;
      }
      patchAttr(linePath, 'd', lineD);
      patchAttr(areaPath, 'd', areaD);

      
      const tickIndices = computeTickIndices(slots);
      while (vGridGroup.firstChild) vGridGroup.removeChild(vGridGroup.firstChild);
      while (xAxisEl.firstChild) xAxisEl.removeChild(xAxisEl.firstChild);
      tickElsByIdx = new Map();

      for (let i = 0; i < tickIndices.length; i++) {
        const tIdx = tickIndices[i];
        const pt = pts[tIdx];
        const slot = slots[tIdx];
        if (!pt || !slot) continue;

        if (i > 0 && i < tickIndices.length - 1) {
          const vLine = document.createElementNS(SVG_NS, 'line');
          vLine.setAttribute('x1', pt.x.toFixed(1));
          vLine.setAttribute('y1', '16');
          vLine.setAttribute('x2', pt.x.toFixed(1));
          vLine.setAttribute('y2', String(BOTTOM_Y));
          vGridGroup.appendChild(vLine);
        }

        const isFirst = !isSingle && i === 0;
        const isLast = !isSingle && i === tickIndices.length - 1;
        const pct = isFirst ? 0 : isLast ? 100 : (pt.x / viewW) * 100;
        const tickEl = h('span', {
          className: `trend-x-tick text-mono${isFirst ? ' is-start' : isLast ? ' is-end' : ''}`,
          text: slot.label || '',
          title: slot.fullLabel || slot.label || '',
        });
        patchStyleVar(tickEl, '--tick-x', `${pct.toFixed(2)}%`);
        tickEl.onclick = () => showLineHoverAtIndex(tIdx);
        xAxisEl.appendChild(tickEl);
        tickElsByIdx.set(tIdx, tickEl);
      }

      // <= 36 /
      while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);
      if (pts.length <= 36) {
        for (let i = 0; i < pts.length; i++) {
          if (pts[i].tokens <= 0) continue;
          const dot = document.createElementNS(SVG_NS, 'circle');
          dot.setAttribute('cx', pts[i].x.toFixed(1));
          dot.setAttribute('cy', pts[i].y.toFixed(1));
          dot.setAttribute('r', '2');
          dot.setAttribute('class', 'trend-node-dot');
          dotsGroup.appendChild(dot);
        }
      }
    }

    const peakPt = pts[peakIdx] || { x: viewW / 2, y: BOTTOM_Y };
    patchAttr(peakDot, 'cx', peakPt.x.toFixed(1));
    patchAttr(peakDot, 'cy', peakPt.y.toFixed(1));

    const peakSlot = slots[peakIdx];
    const peakText =
      maxTokens > 0 && peakSlot?.label
        ? `${tc.peakLbl} ${peakSlot.label} · ${formatTokensPrecise(maxTokens)}`
        : formatTokensPrecise(maxTokens);
    patchText(peakPill, peakText);
    const pctLeft = Math.max(12, Math.min(88, (peakPt.x / viewW) * 100));
    patchStyleVar(peakPill, '--peak-x', `${pctLeft.toFixed(1)}%`);

    if (hoveredIdx >= slots.length) {
      clearHover();
    } else if (hoveredIdx >= 0) {
      showLineHoverAtIndex(hoveredIdx);
    }
  }

  return { el: chartWrap, update, destroy };
}
