/**
 * @fileoverview (WindowOverlayShell.js).
 *
 * Shadow Host (`z-0` / `overflow: hidden`) 
 * 1. `#ag-usage-monitor-capsule` `[class*="@container/titlebar"]` 
 * `wide` -> `compact` -> `minimal` -> `ring-only` 
 * 2. `#ag-usage-monitor-portal` `document.body` `App()` 
 * DOM 
 */

import { App } from '../../App.js';
import { applyAppearanceToRoot } from '../../core/appearance.js';
import {
  h,
  isEventInside,
  patchAttr,
  patchClasses,
  patchKeyedList,
  patchText,
} from '../../core/domPatch.js';
import { formatElapsedSec } from '../../core/formatters.js';
import { deliverCdpBridgeResponses, getWindowBridgeConfig } from '../../core/httpClient.js';
import { getEffectiveLocale, i18nStore, setI18nLanguage, t, translateLiveActivityText } from '../../i18n/index.js';
import { createSvgIcon, patchSvgIcon } from '../../icons/SvgIcon.js';
import {
  RING_CIRCUMFERENCE,
  cancelCapsuleSlotAnimations,
  createCapsuleSlotNode,
  syncCapsuleSlotNodes,
} from '../widgets/CapsuleBarWidget.js';
import { createDynamicWidgetHost } from '../../registries/widgetRegistry.js';
import {
  DEFAULT_CLIENT_HOVER_MODULES,
  extractHostRouteCascadeId,
  fetchTelemetry,
  formatAgentBadgeText,
  getAgentBadgeClass,
  normalizeClientHoverModules,
  normalizeClientPopoverWidth,
  normalizeClientPopoverWidthMode,
  normalizeClientQuotaDisplayMode,
  normalizeClientTopbarSlots,
  normalizeClientUpdateMode,
  normalizeClientWindowMountMode,
  resolveScopedConversation,
  resolveSelectedModelContextLimit,
  startAsyncTelemetryLoop,
  stopAsyncTelemetryLoop,
  telemetryStore,
  triggerPluginUpdate,
} from '../../store/telemetryStore.js';
import { uiStore } from '../../store/uiStore.js';

const CAPSULE_HOST_ID = 'ag-usage-monitor-capsule';
const PORTAL_HOST_ID = 'ag-usage-monitor-portal';
const COMPOSER_LAYOUT_STYLE_ID = 'ag-usage-monitor-composer-layout-style';
const COMPOSER_LAYOUT_STYLE_CSS = `
[data-wm-composer-row="1"] {
  justify-content: flex-start !important;
}
[data-wm-composer-left="1"] {
  flex: 0 1 auto !important;
  order: 1 !important;
  min-width: 0 !important;
}
[data-wm-composer-right="1"] {
  display: contents !important;
}
[data-wm-composer-perm="1"] {
  order: 2 !important;
  margin-left: 2px !important;
  margin-right: 0 !important;
}
[data-wm-composer-row="1"] > .wm-capsule-host[data-dock="composer"][data-composer-perm-left="1"],
[data-wm-composer-right="1"] > .wm-capsule-host[data-dock="composer"][data-composer-perm-left="1"] {
  order: 3 !important;
  margin-left: auto !important;
  margin-right: 4px !important;
}
[data-wm-composer-actions="1"] {
  order: 4 !important;
}
`.trim();

function syncComposerLayoutStyleElement(enabled) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById?.(COMPOSER_LAYOUT_STYLE_ID) || null;
  if (!enabled) {
    if (existing) {
      try {
        existing.remove?.();
      } catch {
        // ignore remove errors
      }
    }
    return;
  }
  if (existing) return;
  const headOrRoot = document.head || document.documentElement || document.body;
  if (!headOrRoot || typeof document.createElement !== 'function') return;
  const styleEl = document.createElement('style');
  styleEl.id = COMPOSER_LAYOUT_STYLE_ID;
  styleEl.textContent = COMPOSER_LAYOUT_STYLE_CSS;
  headOrRoot.appendChild(styleEl);
}
const SPLIT_CASCADE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOATING_CARD_WIDTH = 522;
const POPOVER_BASE_WIDTH = 540;
const POPOVER_MAX_AUTO_WIDTH = 960;
const MULTI_PANEL_WIDTH = 464;

function isAnyOverlayHostNode(node) {
  if (!node) return false;
  if (
    node.id === CAPSULE_HOST_ID ||
    node.id === PORTAL_HOST_ID ||
    node.classList?.contains?.('wm-capsule-host') ||
    node.classList?.contains?.('wm-portal-host')
  ) {
    return true;
  }
  return Boolean(node.closest?.('.wm-capsule-host, .wm-portal-host'));
}

function resolveNodeCascadeId(node) {
  let cur = node;
  while (cur) {
    const cid = String(cur.getAttribute?.('data-cascade-id') || '').trim();
    if (SPLIT_CASCADE_UUID_RE.test(cid)) return cid;
    cur = cur.parentElement || cur.parentNode;
  }
  return '';
}

function findVisibleConversationViews() {
  if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
    return [];
  }
  const out = [];
  let raw = document.querySelectorAll('[data-testid="conversation-view"]');
  if (!raw || raw.length === 0) {
    raw = document.querySelectorAll('[data-testid="conversation-view"][data-cascade-id]');
  }
  for (const el of raw) {
    if (!el || el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') continue;
    if (el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.width <= 80 || r.height <= 80) continue;
    }
    const rawCid = String(el.getAttribute?.('data-cascade-id') || '').trim();
    const cascadeId = SPLIT_CASCADE_UUID_RE.test(rawCid) ? rawCid : '__new__';
    out.push({ el, cascadeId });
  }
  return out;
}

/**
 * Hysteresis 
 * `showMulti === false` 76px 
 * 3 4..5 `wide` 
 *
 * @param {number} availWidth
 * @param {'wide'|'compact'|'minimal'|'ring-only'} currentMode
 * @param {{ showMulti?: boolean, hasUpdate?: boolean, slotCount?: number }} [options]
 * @returns {'wide'|'compact'|'minimal'|'ring-only'}
 */
export function computeCapsuleLayoutMode(availWidth, currentMode = 'wide', options = undefined) {
  if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
  const showMulti = options?.showMulti !== false;
  const updateReserve = options?.hasUpdate ? 52 : 0;
  const slotCount = Number(options?.slotCount || 3);
  const isTwoSlotOrFewer = slotCount <= 2;
  const extraSlotWidth = slotCount > 3 ? (slotCount - 3) * 58 : 0;
  const wideKeep = isTwoSlotOrFewer ? 172 : 256 + extraSlotWidth;
  const wideEnter = isTwoSlotOrFewer ? 188 : 272 + extraSlotWidth;
  const minimalCut = isTwoSlotOrFewer ? 132 : 196;
  const compactEnter = isTwoSlotOrFewer ? 148 : 212;
  const baseEffWidth = showMulti ? availWidth : availWidth + 76;
  const effWidth = baseEffWidth - updateReserve;
  if (currentMode === 'wide') {
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < minimalCut) return 'minimal';
    if (effWidth < wideKeep) return 'compact';
    return 'wide';
  }
  if (currentMode === 'compact') {
    if (effWidth >= wideEnter) return 'wide';
    if (baseEffWidth < 78) return 'ring-only';
    if (effWidth < minimalCut) return 'minimal';
    return 'compact';
  }
  if (currentMode === 'minimal') {
    if (effWidth >= wideEnter) return 'wide';
    if (effWidth >= compactEnter) return 'compact';
    if (baseEffWidth < 78) return 'ring-only';
    return 'minimal';
  }
  if (effWidth >= wideEnter) return 'wide';
  if (effWidth >= compactEnter) return 'compact';
  if (baseEffWidth >= 92) return 'minimal';
  return 'ring-only';
}

function findIdeWorkbenchTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const workbench = document.querySelector('.monaco-workbench');
    if (!workbench?.querySelector) return null;
    const partTitlebar = workbench.querySelector('.part.titlebar');
    if (!partTitlebar?.querySelector) return null;
    if (partTitlebar.getBoundingClientRect) {
      const pr = partTitlebar.getBoundingClientRect();
      if (pr.width <= 0 || pr.height <= 0) return null;
    }
    const container =
      partTitlebar.querySelector(':scope > .titlebar-container') ||
      partTitlebar.querySelector('.titlebar-container');
    const rightGroup =
      container?.querySelector?.(':scope > .titlebar-right') ||
      container?.querySelector?.('.titlebar-right');
    if (!container || !rightGroup) return null;
    const actionToolbar =
      rightGroup.querySelector?.(':scope > .action-toolbar-container') ||
      rightGroup.querySelector?.('.action-toolbar-container') ||
      null;
    return {
      kind: 'ide-titlebar',
      workbench,
      titlebar: container,
      targetContainer: rightGroup,
      actionToolbar,
    };
  } catch {
    return null;
  }
}

function findHostTitlebar() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const tb = document.querySelector('[class*="@container/titlebar"]');
    if (tb?.getBoundingClientRect) {
      const r = tb.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
    }
    return tb;
  } catch {
    return null;
  }
}

const COMPOSER_EXCLUDED_ANCESTOR_SELECTOR =
  '.part.titlebar, .part.statusbar, .quick-input-widget, .suggest-widget, .find-widget, .scm-editor, .search-view, [class*="@container/titlebar"]';
const COMPOSER_MODEL_LABEL_RE =
  /\b(?:gemini|claude|gpt|argon|carbon|hydrogen|helix|neon|flash|sonnet|opus|haiku|orchestrator|llama|deepseek|qwen|mistral|model_placeholder|placeholder_m\d+|o[134](?:-\w+)?)\b/i;
const COMPOSER_MODEL_ATTR_RE =
  /\bmodel[-_\s]?(?:select|picker|switch|selector|menu|name)\b/i;
const COMPOSER_MODE_EXACT_RE = /^(?:auto)$/i;
const COMPOSER_MODE_TEXT_RE =
  /^(?:auto|ask|manual|supervised|autonomous|always\s*allow|turbo|safe|yolo|plan|act|review|confirm|normal|fast)(?:\s*mode)?$/i;
const COMPOSER_MODE_ATTR_RE =
  /\b(?:auto(?:nomy|matic)?|execution[-_]?mode|agent[-_]?mode|permission|approval|hitl|policy|mode[-_]?selector|mode[-_]?picker)\b/i;
const COMPOSER_ICON_FONT_CLASS_RE =
  /\b(?:codicon|material-symbols(?:-\w+)?|material-icons(?:-\w+)?|lucide(?:-\w+)?)\b/i;

function querySimpleSelectorList(root, selectors) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const seen = new Set();
  const out = [];
  for (const sel of selectors) {
    let list = [];
    try {
      list = root.querySelectorAll(sel) || [];
    } catch {
      list = [];
    }
    for (const item of list) {
      if (item && !seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

function extractVisibleButtonText(node, isRoot = true) {
  if (!node) return '';
  const tag = String(node.tagName || node.nodeName || '').toLowerCase();
  if (tag === 'svg' || tag === 'style' || tag === 'script') return '';
  if (!isRoot) {
    if (node.getAttribute?.('aria-hidden') === 'true') return '';
    const cls = String(node.className || '');
    if (cls && COMPOSER_ICON_FONT_CLASS_RE.test(cls)) return '';
  }
  if (tag === '#text' || node.nodeType === 3) {
    return String(node.nodeValue ?? node.textContent ?? '');
  }
  const childNodes = node.childNodes || node.children;
  if (!childNodes || childNodes.length === 0) {
    return String(node.textContent || '');
  }
  let acc = '';
  for (const ch of childNodes) {
    acc += ` ${extractVisibleButtonText(ch, false)}`;
  }
  return acc;
}

function cleanComposerButtonText(btn) {
  const raw = extractVisibleButtonText(btn, true)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  return raw.replace(/^[⌃⌄▾▴∨∧^<>›‹+\s]+|[⌃⌄▾▴∨∧^<>›‹\s]+$/g, '').trim();
}

function isComposerModelButtonItem(item) {
  if (!item) return false;
  if (item.cleanText && COMPOSER_MODEL_LABEL_RE.test(item.cleanText)) return true;
  if (item.attrText && COMPOSER_MODEL_ATTR_RE.test(item.attrText)) return true;
  return false;
}

function hasExcludedComposerAncestor(el) {
  if (!el) return false;
  if (typeof el.closest === 'function') {
    try {
      if (el.closest(COMPOSER_EXCLUDED_ANCESTOR_SELECTOR)) return true;
    } catch {
      
    }
  }
  let cur = el.parentElement || el.parentNode;
  while (cur) {
    const cls = String(cur.className || '');
    if (
      cls.includes('@container/titlebar') ||
      cls.includes('quick-input-widget') ||
      cls.includes('suggest-widget') ||
      cls.includes('find-widget') ||
      cls.includes('scm-editor') ||
      cls.includes('search-view') ||
      (cls.includes('part') && (cls.includes('titlebar') || cls.includes('statusbar')))
    ) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return false;
}

function isNodeHiddenByStyle(el) {
  if (!el) return true;
  if (el.hasAttribute?.('hidden') || el.getAttribute?.('aria-hidden') === 'true') return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      if (cs?.display === 'none' || cs?.visibility === 'hidden') return true;
    } catch {
      
    }
  }
  return false;
}

function getInFlowHostChildren(container, capsuleNode, portalNode) {
  const rawChildren = container?.children || [];
  const out = [];
  for (const ch of rawChildren) {
    if (!ch || ch === capsuleNode || ch === portalNode) continue;
    if (isAnyOverlayHostNode(ch)) continue;
    if (ch.hasAttribute?.('hidden')) continue;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        const cs = window.getComputedStyle(ch);
        if (cs?.display === 'none') continue;
        if (cs?.position === 'absolute' || cs?.position === 'fixed') continue;
      } catch {
        
      }
    }
    out.push(ch);
  }
  return out;
}

function isHorizontalFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\b(?:inline-)?flex\b/.test(cls) && !/\bflex-col\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const cs = window.getComputedStyle(el);
      const disp = String(cs?.display || '');
      const dir = String(cs?.flexDirection || 'row');
      if (disp.includes('flex') && !dir.startsWith('column')) return true;
    } catch {
      
    }
  }
  return false;
}

function isSpaceDistributedFlexContainer(el) {
  if (!el) return false;
  const cls = String(el.className || '');
  if (/\bjustify-(?:between|around|evenly)\b/.test(cls)) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const jc = String(window.getComputedStyle(el)?.justifyContent || '');
      if (jc.includes('space-between') || jc.includes('space-around') || jc.includes('space-evenly')) {
        return true;
      }
    } catch {
      
    }
  }
  return false;
}

function buildComposerDockDescriptor(autoBtn, composerCard, bottomRowBtns, capsuleNode, portalNode, patchedNode) {
  if (!autoBtn || !composerCard) return null;
  let item = autoBtn;
  while (
    (item.parentElement || item.parentNode) &&
    (item.parentElement || item.parentNode) !== composerCard &&
    (item.parentElement || item.parentNode) !== document.body
  ) {
    const parent = item.parentElement || item.parentNode;
    const hostSiblings = getInFlowHostChildren(parent, capsuleNode, portalNode);
    if (hostSiblings.length >= 2) break;
    const grandParent = parent.parentElement || parent.parentNode;
    const parentCls = String(parent.className || '');
    const parentInlineMl = String(parent.style?.marginLeft || '').trim();
    const isSingleClusterInSplitRow =
      !/\b(?:relative|ml-auto|ms-auto)\b/.test(parentCls) &&
      parentInlineMl !== 'auto' &&
      isHorizontalFlexContainer(parent) &&
      grandParent &&
      isSpaceDistributedFlexContainer(grandParent) &&
      getInFlowHostChildren(grandParent, capsuleNode, portalNode).length >= 2;
    if (isSingleClusterInSplitRow) {
      break;
    }
    item = parent;
  }

  const anchorNode = item;
  const targetContainer = anchorNode.parentElement || anchorNode.parentNode;
  if (!targetContainer) return null;

  const hostChildren = getInFlowHostChildren(targetContainer, capsuleNode, portalNode);
  const anchorIdx = hostChildren.indexOf(anchorNode);
  const isFirstHostChild = anchorIdx <= 0;

  let needsAutoMarginTransfer = false;
  let patchMarginNode = null;

  if (!isFirstHostChild) {
    const cls = String(anchorNode.className || '');
    const inlineMl = String(anchorNode.style?.marginLeft || '').trim();
    let computedLargeMl = false;
    if (
      patchedNode !== anchorNode &&
      typeof window !== 'undefined' &&
      typeof window.getComputedStyle === 'function'
    ) {
      try {
        const mlPx = parseFloat(window.getComputedStyle(anchorNode)?.marginLeft) || 0;
        const prevSib = hostChildren[anchorIdx - 1];
        const aRect = anchorNode.getBoundingClientRect?.();
        const pRect = prevSib?.getBoundingClientRect?.();
        if (mlPx > 24 && aRect && pRect && aRect.left - pRect.right >= mlPx - 6) {
          computedLargeMl = true;
        }
      } catch {
        
      }
    }

    if (
      /\b(?:ml-auto|ms-auto)\b/.test(cls) ||
      inlineMl === 'auto' ||
      patchedNode === anchorNode ||
      computedLargeMl
    ) {
      needsAutoMarginTransfer = true;
      patchMarginNode = anchorNode;
    } else if (isSpaceDistributedFlexContainer(targetContainer)) {
      needsAutoMarginTransfer = true;
    }
  }

  const autoRect = anchorNode.getBoundingClientRect?.() || autoBtn.getBoundingClientRect?.();
  let leftClusterRightEdge = 0;
  if (autoRect && Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry.btn === autoBtn || anchorNode.contains?.(entry.btn)) continue;
      if (entry.rect.left < autoRect.left - 2 && entry.rect.right <= autoRect.left + 4) {
        if (entry.rect.right > leftClusterRightEdge) {
          leftClusterRightEdge = entry.rect.right;
        }
      }
    }
  }

  let permLayout = null;
  const cleanPermText = cleanComposerButtonText(autoBtn);
  const permAttrText = `${autoBtn.getAttribute?.('data-testid') || ''} ${autoBtn.getAttribute?.('aria-label') || ''} ${autoBtn.getAttribute?.('title') || ''}`;
  const isPermissionBtn = Boolean(
    autoBtn.getAttribute?.('data-testid') === 'permissions-selector-trigger' ||
      COMPOSER_MODE_EXACT_RE.test(cleanPermText) ||
      COMPOSER_MODE_TEXT_RE.test(cleanPermText) ||
      COMPOSER_MODE_ATTR_RE.test(permAttrText)
  );
  if (isPermissionBtn && anchorIdx >= 0) {
    const trailingInTarget = hostChildren.slice(anchorIdx + 1);
    const parentRow = targetContainer.parentElement || targetContainer.parentNode;
    if (
      targetContainer !== composerCard &&
      parentRow &&
      parentRow !== document.body &&
      isHorizontalFlexContainer(parentRow) &&
      trailingInTarget.length >= 1
    ) {
      const rowChildren = getInFlowHostChildren(parentRow, capsuleNode, portalNode);
      const tcIdx = rowChildren.indexOf(targetContainer);
      if (tcIdx >= 1) {
        permLayout = {
          kind: 'nested-right',
          rowEl: parentRow,
          leftNodes: rowChildren.slice(0, tcIdx),
          rightEl: targetContainer,
          permEl: anchorNode,
          actionEls: trailingInTarget,
        };
      }
    } else if (
      isHorizontalFlexContainer(targetContainer) &&
      anchorIdx >= 1 &&
      trailingInTarget.length >= 1
    ) {
      permLayout = {
        kind: 'flat-row',
        rowEl: targetContainer,
        leftNodes: hostChildren.slice(0, anchorIdx),
        rightEl: null,
        permEl: anchorNode,
        actionEls: trailingInTarget,
      };
    }
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer,
    actionToolbar: patchMarginNode,
    anchorNode,
    needsAutoMarginTransfer,
    leftClusterRightEdge,
    permLayout,
  };
}

function buildComposerRightEndDockDescriptor(
  leftAnchorBtn,
  composerCard,
  bottomRowBtns,
  capsuleNode,
  portalNode
) {
  if (!leftAnchorBtn || !composerCard) return null;
  const cardRect = composerCard.getBoundingClientRect?.();
  const minRowWidth = cardRect && cardRect.width > 0 ? cardRect.width * 0.65 : 180;
  let toolbarRow = null;
  let cur = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
  for (let d = 0; d < 8 && cur && cur !== composerCard && cur !== document.body; d += 1) {
    const r = cur.getBoundingClientRect?.();
    if (r && r.width >= minRowWidth && r.height > 0 && r.height <= 60 && isHorizontalFlexContainer(cur)) {
      toolbarRow = cur;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  if (!toolbarRow) {
    const p = leftAnchorBtn.parentElement || leftAnchorBtn.parentNode;
    if (!p || !isHorizontalFlexContainer(p)) return null;
    toolbarRow = p;
  }

  let leftClusterRightEdge = 0;
  if (Array.isArray(bottomRowBtns)) {
    for (const entry of bottomRowBtns) {
      if (entry?.rect?.right > leftClusterRightEdge) {
        leftClusterRightEdge = entry.rect.right;
      }
    }
  }

  const rowChildren = getInFlowHostChildren(toolbarRow, capsuleNode, portalNode);
  const lastChild = rowChildren.length >= 2 ? rowChildren[rowChildren.length - 1] : null;
  if (
    lastChild &&
    !lastChild.contains?.(leftAnchorBtn) &&
    isHorizontalFlexContainer(lastChild) &&
    getInFlowHostChildren(lastChild, capsuleNode, portalNode).length === 0
  ) {
    return {
      kind: 'composer',
      workbench: null,
      titlebar: composerCard,
      targetContainer: lastChild,
      actionToolbar: null,
      anchorNode: null,
      needsAutoMarginTransfer: false,
      leftClusterRightEdge,
    };
  }

  return {
    kind: 'composer',
    workbench: null,
    titlebar: composerCard,
    targetContainer: toolbarRow,
    actionToolbar: null,
    anchorNode: null,
    needsAutoMarginTransfer: true,
    leftClusterRightEdge,
  };
}

function collectComposerBottomButtons(container, editorEl, editorRect, capsuleNode, portalNode) {
  const rawBtns = querySimpleSelectorList(container, ['button', '[role="button"]', '[aria-haspopup]']);
  const hostBtns = [];
  for (const btn of rawBtns) {
    if (!btn || btn === editorEl || editorEl?.contains?.(btn)) continue;
    if (editorEl && btn.contains?.(editorEl)) continue;
    if (
      isAnyOverlayHostNode(btn) ||
      capsuleNode?.contains?.(btn) ||
      portalNode?.contains?.(btn)
    ) {
      continue;
    }
    if (isNodeHiddenByStyle(btn)) continue;
    // / role="button"
    let nestedInBtn = false;
    let p = btn.parentElement || btn.parentNode;
    while (p && p !== container) {
      const pTag = String(p.tagName || '').toLowerCase();
      if (pTag === 'button') {
        nestedInBtn = true;
        break;
      }
      if (
        (p.getAttribute?.('role') === 'button' || p.hasAttribute?.('aria-haspopup')) &&
        !(editorEl && p.contains?.(editorEl))
      ) {
        const pr = p.getBoundingClientRect?.();
        if (pr && pr.height > 0 && pr.height <= 48 && pr.width > 0 && pr.width <= 360) {
          nestedInBtn = true;
          break;
        }
      }
      p = p.parentElement || p.parentNode;
    }
    if (nestedInBtn) continue;

    const br = btn.getBoundingClientRect?.();
    if (!br || br.width <= 0 || br.height <= 0 || br.height > 48) continue;
    const centerY = (br.top + br.bottom) / 2;
    if (editorRect && centerY < editorRect.top - 4) continue;
    hostBtns.push({
      btn,
      rect: br,
      centerY,
      centerX: (br.left + br.right) / 2,
      cleanText: cleanComposerButtonText(btn),
      attrText: `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim(),
    });
  }
  if (hostBtns.length === 0) return [];
  let maxCenterY = -Infinity;
  for (const item of hostBtns) {
    if (item.centerY > maxCenterY) maxCenterY = item.centerY;
  }
  const bottomBand = hostBtns.filter((item) => Math.abs(item.centerY - maxCenterY) <= 22);
  bottomBand.sort((a, b) => a.rect.left - b.rect.left);
  return bottomBand;
}

function pickAutoButtonFromRow(bottomRowBtns, containerRect, options = undefined) {
  if (!Array.isArray(bottomRowBtns) || bottomRowBtns.length === 0) return null;
  const requireModelForFallback = Boolean(options?.requireModelForFallback);
  const rightSplitX = containerRect ? containerRect.left + containerRect.width * 0.35 : 0;
  const rightFirst = [
    ...bottomRowBtns.filter((b) => b.centerX >= rightSplitX),
    ...bottomRowBtns.filter((b) => b.centerX < rightSplitX),
  ];

  // Tier 1: Auto /
  for (const item of rightFirst) {
    if (COMPOSER_MODE_EXACT_RE.test(item.cleanText)) {
      return { btn: item.btn, tier: 1 };
    }
  }

  // Tier 2: /
  for (const item of rightFirst) {
    if (isComposerModelButtonItem(item)) continue;
    if (
      (item.cleanText && COMPOSER_MODE_TEXT_RE.test(item.cleanText)) ||
      (item.attrText && COMPOSER_MODE_ATTR_RE.test(item.attrText))
    ) {
      return { btn: item.btn, tier: 2 };
    }
  }

  const hasModelBtn = bottomRowBtns.some(isComposerModelButtonItem);

  // Tier 3: Antigravity IDE Auto /
  if (bottomRowBtns.length >= 2 && (!requireModelForFallback || hasModelBtn)) {
    let maxGap = -Infinity;
    let splitIdx = -1;
    for (let i = 1; i < bottomRowBtns.length; i += 1) {
      const gap = bottomRowBtns[i].rect.left - bottomRowBtns[i - 1].rect.right;
      if (gap > maxGap) {
        maxGap = gap;
        splitIdx = i;
      }
    }
    if (splitIdx >= 1 && maxGap >= 16) {
      return { btn: bottomRowBtns[splitIdx].btn, tier: 3 };
    }
  }

  // Tier 4:
  if (hasModelBtn && containerRect && containerRect.width >= 200) {
    const lastItem = bottomRowBtns[bottomRowBtns.length - 1];
    if (lastItem.rect.right <= containerRect.left + containerRect.width * 0.72) {
      return { btn: null, leftAnchorBtn: lastItem.btn, tier: 4 };
    }
  }

  return null;
}

function resolveComposerEditorRect(ed) {
  const er = ed?.getBoundingClientRect?.();
  if (er && er.width >= 80 && er.height >= 12) return er;
  let cur = ed;
  for (let d = 0; d < 6 && cur; d += 1) {
    if (String(cur.className || '').includes('monaco-editor')) {
      const mr = cur.getBoundingClientRect?.();
      if (mr && mr.width >= 80 && mr.height >= 12) return mr;
      break;
    }
    cur = cur.parentElement || cur.parentNode;
  }
  return er || null;
}

function findHostComposerAutoTarget(
  capsuleNode = null,
  portalNode = null,
  patchedNode = null,
  scopeRoot = null
) {
  try {
    if (typeof document === 'undefined') {
      return null;
    }
    const queryRoot = scopeRoot || document;
    if (typeof queryRoot.querySelectorAll !== 'function') {
      return null;
    }
    const capEl = capsuleNode || document.getElementById?.(CAPSULE_HOST_ID) || null;
    const porEl = portalNode || document.getElementById?.(PORTAL_HOST_ID) || null;
    const activeRouteId = extractHostRouteCascadeId();

    // 1. Auto /
    const rawEditors = querySimpleSelectorList(queryRoot, [
      'textarea',
      '[contenteditable]',
      '[role="textbox"]',
      '[data-lexical-editor]',
      '.ProseMirror',
      '.monaco-editor',
    ]);
    const scoredEditors = [];
    for (const ed of rawEditors) {
      if (!ed || capEl?.contains?.(ed) || porEl?.contains?.(ed) || isAnyOverlayHostNode(ed)) continue;
      if (ed.hasAttribute?.('contenteditable')) {
        const ce = String(ed.getAttribute('contenteditable') || '').trim().toLowerCase();
        if (ce === 'false' && ed.getAttribute?.('role') !== 'textbox') continue;
      }
      if (isNodeHiddenByStyle(ed) || hasExcludedComposerAncestor(ed)) continue;
      const er = resolveComposerEditorRect(ed);
      if (!er || er.width < 100 || er.height < 12 || er.height > 540) continue;

      let score = Math.min(1200, er.width) + Math.max(0, er.bottom) * 0.2;
      if (activeRouteId) {
        let anc = ed.parentElement || ed.parentNode;
        while (anc) {
          const cid = anc.getAttribute?.('data-cascade-id');
          if (cid) {
            score += cid === activeRouteId ? 4000 : -2000;
            break;
          }
          anc = anc.parentElement || anc.parentNode;
        }
      }
      if (
        document.activeElement &&
        (ed === document.activeElement || ed.contains?.(document.activeElement))
      ) {
        score += 1000;
      }
      scoredEditors.push({ ed, rect: er, score });
    }
    scoredEditors.sort((a, b) => b.score - a.score);

    for (const { ed, rect: er } of scoredEditors) {
      const isMonacoCandidate = String(ed.className || '').includes('monaco-editor') ||
        String(ed.className || '').includes('inputarea');
      let tier3Candidate = null;
      let tier4Candidate = null;
      let cur = ed.parentElement || ed.parentNode;
      for (let depth = 0; depth < 18 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        const tag = String(cur.tagName || '').toLowerCase();
        if (tag === 'main' || String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (cr && cr.height > 680) break;
        if (cr && cr.width >= 180 && cr.height > 0) {
          const bottomRowBtns = collectComposerBottomButtons(cur, ed, er, capEl, porEl);
          const picked = pickAutoButtonFromRow(bottomRowBtns, cr, {
            requireModelForFallback: isMonacoCandidate,
          });
          if (picked) {
            if (picked.tier <= 2) {
              const desc = buildComposerDockDescriptor(
                picked.btn,
                cur,
                bottomRowBtns,
                capEl,
                porEl,
                patchedNode
              );
              if (desc) return desc;
            } else if (picked.tier === 3 && !tier3Candidate) {
              tier3Candidate = { btn: picked.btn, card: cur, bottomRowBtns };
            } else if (picked.tier === 4 && !tier4Candidate) {
              tier4Candidate = { leftAnchorBtn: picked.leftAnchorBtn, card: cur, bottomRowBtns };
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
      if (tier3Candidate) {
        const desc = buildComposerDockDescriptor(
          tier3Candidate.btn,
          tier3Candidate.card,
          tier3Candidate.bottomRowBtns,
          capEl,
          porEl,
          patchedNode
        );
        if (desc) return desc;
      }
      if (tier4Candidate) {
        const desc = buildComposerRightEndDockDescriptor(
          tier4Candidate.leftAnchorBtn,
          tier4Candidate.card,
          tier4Candidate.bottomRowBtns,
          capEl,
          porEl
        );
        if (desc) return desc;
      }
    }

    // 2. Auto
    const vh = Number(window.innerHeight || 800);
    const allBtns = querySimpleSelectorList(queryRoot, ['button', '[role="button"]', '[aria-haspopup]']);
    let modelToolbarFallback = null;
    for (const btn of allBtns) {
      if (!btn || capEl?.contains?.(btn) || porEl?.contains?.(btn) || isAnyOverlayHostNode(btn)) continue;
      if (isNodeHiddenByStyle(btn) || hasExcludedComposerAncestor(btn)) continue;
      const br = btn.getBoundingClientRect?.();
      if (!br || br.width <= 0 || br.height <= 0 || br.height > 48 || (!scopeRoot && br.top < vh * 0.12)) continue;
      const clean = cleanComposerButtonText(btn);
      const attr = `${btn.getAttribute?.('data-testid') || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('title') || ''}`.trim();
      const itemProbe = { cleanText: clean, attrText: attr };
      const isModeBtn =
        COMPOSER_MODE_EXACT_RE.test(clean) ||
        (!isComposerModelButtonItem(itemProbe) &&
          ((clean && COMPOSER_MODE_TEXT_RE.test(clean)) || (attr && COMPOSER_MODE_ATTR_RE.test(attr))));
      const isModelBtn = isComposerModelButtonItem(itemProbe);
      if (!isModeBtn && !isModelBtn) continue;

      let cur = btn.parentElement || btn.parentNode;
      for (let depth = 0; depth < 12 && cur; depth += 1) {
        if (cur === document.body || cur === document.documentElement) break;
        if (String(cur.className || '').includes('monaco-workbench')) break;
        const cr = cur.getBoundingClientRect?.();
        if (!cr || cr.height > 560) break;
        if (cr.width >= 200) {
          const rowBtns = collectComposerBottomButtons(cur, null, null, capEl, porEl);
          if (isModeBtn) {
            const hasModelSibling = rowBtns.some((b) => b.btn !== btn && isComposerModelButtonItem(b));
            if (hasModelSibling) {
              const desc = buildComposerDockDescriptor(btn, cur, rowBtns, capEl, porEl, patchedNode);
              if (desc) return desc;
            }
          } else if (isModelBtn && !modelToolbarFallback) {
            const picked = pickAutoButtonFromRow(rowBtns, cr, { requireModelForFallback: true });
            if (picked) {
              const desc =
                picked.tier <= 3 && picked.btn
                  ? buildComposerDockDescriptor(picked.btn, cur, rowBtns, capEl, porEl, patchedNode)
                  : picked.tier === 4 && picked.leftAnchorBtn
                    ? buildComposerRightEndDockDescriptor(
                        picked.leftAnchorBtn,
                        cur,
                        rowBtns,
                        capEl,
                        porEl
                      )
                    : null;
              if (desc) {
                if (picked.tier <= 2) return desc;
                modelToolbarFallback = desc;
                break;
              }
            }
          }
        }
        cur = cur.parentElement || cur.parentNode;
      }
    }
    if (modelToolbarFallback) return modelToolbarFallback;
  } catch {
    
  }
  return null;
}

function isImmediatelyBeforeNode(node, refNode) {
  if (!node || !refNode) return false;
  if (node.nextElementSibling !== undefined) {
    return node.nextElementSibling === refNode;
  }
  if (node.nextSibling !== undefined) {
    return node.nextSibling === refNode;
  }
  const parent = node.parentElement || node.parentNode;
  if (!parent?.children) return false;
  const idx = Array.prototype.indexOf.call(parent.children, node);
  return idx >= 0 && parent.children[idx + 1] === refNode;
}

function isIdeExtensionChatFrame() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.__AGUsageMonitorBridge?.isIdeChatFrame === true) return true;
    return /[?&]extension(?:View|Variant)=/i.test(String(window.location?.search || ''));
  } catch {
    return false;
  }
}

function buildFlowTitlebarDescriptor(titlebar) {
  if (!titlebar) return null;
  let targetContainer = titlebar;
  try {
    const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
    if (rightGroup && rightGroup !== titlebar.firstElementChild) {
      targetContainer = rightGroup;
    }
  } catch {
    
  }
  return {
    kind: 'flow',
    workbench: null,
    titlebar,
    targetContainer,
    actionToolbar: null,
    cascadeId: resolveNodeCascadeId(targetContainer) || resolveNodeCascadeId(titlebar),
  };
}

function findSecondarySplitDockTargets(primaryDock, mountMode, portalNode = null) {
  if (
    typeof document === 'undefined' ||
    typeof document.querySelectorAll !== 'function' ||
    isIdeExtensionChatFrame() ||
    !primaryDock ||
    mountMode === 'sidebar'
  ) {
    return [];
  }

  const usedContainers = new Set([primaryDock.targetContainer].filter(Boolean));
  const usedTitlebars = new Set([primaryDock.titlebar].filter(Boolean));
  const out = [];

  // 1. If Antigravity Split View renders multiple @container/titlebar headers (one per split pane)
  if (mountMode !== 'composer') {
    const titlebars = document.querySelectorAll('[class*="@container/titlebar"]');
    for (const tb of titlebars) {
      if (!tb || usedTitlebars.has(tb) || isAnyOverlayHostNode(tb)) continue;
      if (tb.getBoundingClientRect) {
        const r = tb.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
      }
      const desc = buildFlowTitlebarDescriptor(tb);
      if (!desc || !desc.targetContainer || usedContainers.has(desc.targetContainer)) continue;
      usedTitlebars.add(tb);
      usedContainers.add(desc.targetContainer);
      out.push({ keyNode: desc.targetContainer, ...desc });
    }
  }

  // 2. For visible split conversation panes without their own docked capsule, dock on each pane's composer
  const convViews = findVisibleConversationViews();
  if (convViews.length >= 2) {
    for (const { el: convViewEl, cascadeId } of convViews) {
      let alreadyHasCapsule = false;
      for (const container of usedContainers) {
        if (convViewEl.contains?.(container)) {
          alreadyHasCapsule = true;
          break;
        }
      }
      if (alreadyHasCapsule) continue;
      const compDock = findHostComposerAutoTarget(null, portalNode, null, convViewEl);
      if (compDock && compDock.targetContainer && !usedContainers.has(compDock.targetContainer)) {
        usedContainers.add(compDock.targetContainer);
        out.push({
          keyNode: compDock.targetContainer,
          ...compDock,
          cascadeId,
        });
      }
    }
  }

  return out;
}

function resolveActiveDockTarget(options = undefined) {
  const settings = telemetryStore.getState().telemetry?.settings;
  const rawMode =
    settings?.windowMountMode ??
    (typeof window !== 'undefined' ? window.__AGUsageMonitorBridge?.mountMode : undefined);
  const mountMode =
    options?.mountMode ||
    normalizeClientWindowMountMode(rawMode, settings?.enableWindowOverlay);
  if (isIdeExtensionChatFrame()) {
    if (mountMode !== 'composer') return null;
    return findHostComposerAutoTarget(
      options?.capsuleNode || null,
      options?.portalNode || null,
      options?.patchedNode || null
    );
  }
  if (mountMode === 'composer') {
    let scopeRoot = null;
    const convViews = findVisibleConversationViews();
    if (convViews.length >= 2) {
      const capEl = options?.capsuleNode || null;
      const pinnedView =
        (capEl && convViews.find((v) => v.el?.contains?.(capEl))) || convViews[0];
      scopeRoot = pinnedView?.el || null;
    }
    const composerTarget =
      (scopeRoot &&
        findHostComposerAutoTarget(
          options?.capsuleNode || null,
          options?.portalNode || null,
          options?.patchedNode || null,
          scopeRoot
        )) ||
      findHostComposerAutoTarget(
        options?.capsuleNode || null,
        options?.portalNode || null,
        options?.patchedNode || null
      );
    if (composerTarget) {
      const resolvedCid =
        resolveNodeCascadeId(composerTarget.targetContainer) ||
        resolveNodeCascadeId(composerTarget.titlebar);
      const routeCid = !resolvedCid ? extractHostRouteCascadeId() : '';
      return {
        ...composerTarget,
        cascadeId: resolvedCid || (routeCid === '__new__' ? '__new__' : ''),
      };
    }
  }
  const titlebar = findHostTitlebar();
  return buildFlowTitlebarDescriptor(titlebar);
}

function findNativeTopRightAnchor() {
  try {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
      return null;
    }
    const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
    if (auxToggle?.closest) {
      return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
    }
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const btn of candidates) {
      const text = String(btn.textContent || '').trim();
      if (
        (text === 'Open IDE' || text.includes('Open IDE')) &&
        btn.getBoundingClientRect?.().top < 52
      ) {
        return btn.closest?.('div.flex.items-center, div.absolute.right-0') || btn;
      }
    }
    return document.querySelector('div.absolute.right-0.top-0');
  } catch {
    return null;
  }
}

function getLeftSidebarRightEdge(vw) {
  try {
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      if (document.querySelector('.monaco-workbench')) {
        return 0;
      }
      const navEl = document.querySelector('div[role="navigation"]');
      if (navEl?.getBoundingClientRect) {
        const nr = navEl.getBoundingClientRect();
        if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 280) {
          return Math.ceil(nr.right);
        }
      }
    }
  } catch {
    
  }
  return 0;
}

/**
 * `window.__AGUsageMonitorOverlay` 
 */
export function mountWindowOverlay() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  
  let carryOverTelemetry = null;
  let carryOverTooltipOpen = false;
  let carryOverPopoverOpen = false;
  let carryOverMultiHoverOpen = false;
  let carryOverMultiPinnedOpen = false;
  let carryOverPointer = null;
  try {
    const prevOv = window.__AGUsageMonitorOverlay;
    carryOverTelemetry = prevOv?.getTelemetrySnapshot?.() || null;
    carryOverTooltipOpen = Boolean(prevOv?.isHoverOpen?.());
    carryOverPopoverOpen = Boolean(prevOv?.isOpen?.());
    carryOverMultiHoverOpen = Boolean(prevOv?.isMultiHoverOpen?.());
    carryOverMultiPinnedOpen = Boolean(prevOv?.isMultiPinnedOpen?.());
    carryOverPointer = prevOv?.getLastPointer?.() || null;
    prevOv?.dispose?.();
  } catch {
    
  }
  try {
    document.getElementById(CAPSULE_HOST_ID)?.remove?.();
    document.getElementById(PORTAL_HOST_ID)?.remove?.();
    if (typeof document.querySelectorAll === 'function') {
      for (const stale of document.querySelectorAll('.wm-split-capsule')) {
        stale?.remove?.();
      }
    }
  } catch {
    
  }

  const bridgeConfig = getWindowBridgeConfig();
  const bundleVersion = String(bridgeConfig?.bundleVersion || '');
  const stylesCss = String(bridgeConfig?.stylesCss || '');
  const seedTelemetry =
    (bridgeConfig?.initialTelemetry && typeof bridgeConfig.initialTelemetry === 'object'
      ? bridgeConfig.initialTelemetry
      : null) || carryOverTelemetry;
  if (bridgeConfig?.initialTelemetry) {
    delete bridgeConfig.initialTelemetry;
  }
  if (seedTelemetry) {
    setI18nLanguage(seedTelemetry?.settings?.language);
    telemetryStore.setState({
      telemetry: seedTelemetry,
      minuteTick: Math.floor(Date.now() / 30000),
      syncState: 'idle',
    });
  } else {
    setI18nLanguage(telemetryStore.getState().telemetry?.settings?.language);
  }

  let disposed = false;
  let popoverOpen = false;
  let tooltipOpen = false;
  let multiOpen = false;
  let multiPinned = false;
  let hoverLeaveTimer = null;
  let multiLeaveTimer = null;
  const manualSubExpandMap = new Map();
  const multiTimersMap = new Map();
  let multiLiveTickTimer = null;
  let hasPointerCoords = Boolean(
    carryOverPointer &&
      Number.isFinite(carryOverPointer.x) &&
      Number.isFinite(carryOverPointer.y)
  );
  let lastPointerX = hasPointerCoords ? carryOverPointer.x : -1;
  let lastPointerY = hasPointerCoords ? carryOverPointer.y : -1;
  let layoutMode = 'wide';
  let observedTitlebar = null;
  let dockRafId = 0;
  let lastObservedRouteId = extractHostRouteCascadeId();
  const splitCapsulesMap = new Map();
  let activeAnchorSurface = null;

  function setActiveCapsuleAnchor(surface) {
    if (surface) activeAnchorSurface = surface;
  }

  function getActiveAnchorSurface() {
    return activeAnchorSurface || primarySurface;
  }

  function getAllCapsuleSurfaces() {
    return [primarySurface, ...splitCapsulesMap.values()];
  }

  function recordPointerCoords(e) {
    if (e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
      hasPointerCoords = true;
    }
  }

  function isPointerStillInCapsule() {
    const surf = getActiveAnchorSurface();
    if (!hasPointerCoords || document.hidden || !surf?.capsuleBtn?.getBoundingClientRect) {
      return false;
    }
    const r = surf.capsuleBtn.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    let rightBound = r.right;
    if (!surf.topbarUpdateBtn.hasAttribute('hidden') && surf.topbarUpdateBtn.getBoundingClientRect) {
      const ur = surf.topbarUpdateBtn.getBoundingClientRect();
      if (ur.width > 0 && ur.height > 0) {
        rightBound = Math.max(rightBound, ur.right);
      }
    }
    return (
      lastPointerX >= r.left - 1 &&
      lastPointerX <= rightBound + 1 &&
      lastPointerY >= r.top - 1 &&
      lastPointerY <= r.bottom + 1
    );
  }

  function isPointerInMultiZone() {
    const surf = getActiveAnchorSurface();
    if (!hasPointerCoords || document.hidden || surf?.multiBtn?.hasAttribute?.('hidden')) {
      return false;
    }
    const bridgePad = multiOpen ? 12 : 1;
    if (surf.multiBtn.getBoundingClientRect) {
      const mr = surf.multiBtn.getBoundingClientRect();
      if (
        mr.width > 0 &&
        mr.height > 0 &&
        lastPointerX >= mr.left - 1 &&
        lastPointerX <= mr.right + 1 &&
        lastPointerY >= mr.top - bridgePad &&
        lastPointerY <= mr.bottom + bridgePad
      ) {
        return true;
      }
    }
    if (multiOpen && multiPanelEl.getBoundingClientRect) {
      const pr = multiPanelEl.getBoundingClientRect();
      if (
        pr.width > 0 &&
        pr.height > 0 &&
        lastPointerX >= pr.left - 1 &&
        lastPointerX <= pr.right + 1 &&
        lastPointerY >= pr.top - 8 &&
        lastPointerY <= pr.bottom + 12
      ) {
        return true;
      }
    }
    return false;
  }

  function scheduleMultiHoverClose() {
    if (multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
    }
    multiLeaveTimer = setTimeout(() => {
      multiLeaveTimer = null;
      if (disposed || multiPinned || !multiOpen) return;
      const surf = getActiveAnchorSurface();
      let nativeHover = false;
      try {
        nativeHover = Boolean(
          surf?.multiBtn?.matches?.(':hover') || multiPanelEl.matches?.(':hover')
        );
      } catch {
        nativeHover = false;
      }
      if (nativeHover || isPointerInMultiZone()) {
        return;
      }
      setMultiOpen(false);
    }, 90);
  }

  function bindMultiElapsedTimer(timerKey, sig, rawStartMs, targetEl) {
    const now = Date.now();
    const prev = multiTimersMap.get(timerKey);
    let startMs = prev?.startMs || 0;
    if (!prev || prev.sig !== sig) {
      const validRaw = Number(rawStartMs || 0);
      startMs = validRaw > 0 && validRaw <= now + 2000 ? validRaw : now;
    } else if (startMs <= 0 && Number(rawStartMs) > 0 && Number(rawStartMs) <= now + 2000) {
      startMs = Number(rawStartMs);
    }
    multiTimersMap.set(timerKey, { sig, startMs, el: targetEl });
    const elapsedSec = Math.max(0, (now - startMs) / 1000);
    patchText(targetEl, formatElapsedSec(elapsedSec));
  }

  function tickMultiElapsedDisplay() {
    const now = Date.now();
    for (const entry of multiTimersMap.values()) {
      if (!entry?.el) continue;
      const elapsedSec = entry.startMs > 0 ? Math.max(0, (now - entry.startMs) / 1000) : 0;
      patchText(entry.el, formatElapsedSec(elapsedSec));
    }
  }

  function pauseMultiLiveTicker() {
    if (multiLiveTickTimer) {
      clearInterval(multiLiveTickTimer);
      multiLiveTickTimer = null;
    }
  }

  function stopMultiLiveTicker() {
    pauseMultiLiveTicker();
    multiTimersMap.clear();
  }

  function ensureMultiLiveTicker() {
    if (multiTimersMap.size === 0) {
      stopMultiLiveTicker();
      return;
    }
    if (!multiLiveTickTimer) {
      multiLiveTickTimer = setInterval(tickMultiElapsedDisplay, 1000);
    }
  }

  function inspectSessionInMonitor(cascadeId) {
    if (!cascadeId || cascadeId === 'current') return;
    uiStore.setState({
      activeView: 'overview',
      selectedAgentScope: 'all',
      ctxInspectorAgentId: 'auto',
    });
    telemetryStore.setState({ selectedConversationId: cascadeId });
    void fetchTelemetry({ force: false });
    setMultiOpen(false);
    setPopoverOpen(true);
  }

  // --- 1. / Shadow Host Split View ---
  let isTopbarUpdating = false;

  function createCapsuleSurfaceInstance({ isPrimary = false } = {}) {
    const hostEl = document.createElement('div');
    if (isPrimary) {
      hostEl.id = CAPSULE_HOST_ID;
      hostEl.className = 'wm-capsule-host';
    } else {
      hostEl.className = 'wm-capsule-host wm-split-capsule';
    }
    hostEl.setAttribute('data-dock', 'fixed');
    hostEl.setAttribute('data-layout', 'wide');
    
    hostEl.addEventListener?.('mousedown', (e) => e.stopPropagation?.());
    hostEl.addEventListener?.('click', (e) => e.stopPropagation?.());
    hostEl.addEventListener?.('keydown', (e) => {
      if (e?.key !== 'Escape') {
        e.stopPropagation?.();
      }
    });
    const shadow = hostEl.attachShadow({ mode: 'open' });
    const styleNode = document.createElement('style');
    styleNode.textContent = stylesCss;
    shadow.appendChild(styleNode);

    const surface = {
      isPrimary,
      capsuleHost: hostEl,
      multiBtn: null,
      multiLabel: null,
      capsuleBtn: null,
      capsuleSlots: null,
      capsuleSeps: null,
      topbarUpdateBtn: null,
      topbarUpdateIcon: null,
      topbarUpdateLabel: null,
      updateDot: null,
      layoutMode: 'wide',
      lastSlotCount: 3,
      lastShowMulti: true,
      lastShowUpdate: false,
      cascadeId: '',
      dockTarget: null,
      patchedActionToolbar: null,
      patchedActionToolbarPrevMargin: '',
      appliedComposerPermLayout: null,
    };

    const mDot = h('span', { className: 'wm-multi-dot' });
    const mLabel = h('span', { className: 'wm-multi-label', text: t('capsule.multiZero') });
    const mBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-multi-btn',
        'aria-label': t('capsule.ariaMulti'),
        'aria-expanded': 'false',
        onClick: (e) => {
          e.stopPropagation();
          const sameAnchor = getActiveAnchorSurface() === surface;
          setActiveCapsuleAnchor(surface);
          if (multiOpen && multiPinned && sameAnchor) {
            setMultiOpen(false);
          } else {
            setMultiOpen(true, { pinned: true });
          }
        },
        onContextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          void fetchTelemetry({ force: true });
        },
        onMouseenter: (e) => {
          recordPointerCoords(e);
          setActiveCapsuleAnchor(surface);
          if (multiLeaveTimer) {
            clearTimeout(multiLeaveTimer);
            multiLeaveTimer = null;
          }
          if (!popoverOpen && !multiPinned) {
            setMultiOpen(true, { pinned: false });
          }
        },
        onMouseleave: (e) => {
          recordPointerCoords(e);
          if (!multiPinned) {
            scheduleMultiHoverClose();
          }
        },
      },
      [mDot, mLabel]
    );

    const slots = [
      createCapsuleSlotNode(0, 'tps'),
      createCapsuleSlotNode(1, 'ttft'),
      createCapsuleSlotNode(2, 'context'),
      createCapsuleSlotNode(3, 'none'),
      createCapsuleSlotNode(4, 'none'),
    ];
    const seps = [
      h('span', { className: 'wm-sep wm-sep-speed', 'data-sep-for-rank': '2' }),
      h('span', { className: 'wm-sep wm-sep-quota', 'data-sep-for-rank': '3' }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
      h('span', { className: 'wm-sep', 'data-sep-for-rank': '', hidden: true }),
    ];

    const uDot = h('span', { className: 'wm-update-dot', hidden: true });
    const uIcon = createSvgIcon('arrow-down', { size: 10 });
    const uLabel = h('span', {
      className: 'wm-update-label',
      text: t('capsule.newVersion'),
    });
    const uBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-update-btn',
        hidden: true,
        'aria-label': t('capsule.ariaUpdateTitle'),
        title: t('capsule.ariaUpdateTitle'),
        onClick: async (e) => {
          e.stopPropagation();
          setActiveCapsuleAnchor(surface);
          if (isTopbarUpdating) return;
          const cs = telemetryStore.getState().telemetry?.cloudStatus;
          const targetUrl =
            cs?.releaseUrl ||
            'https://github.com/Lavich99/antigravity-usage-monitor-th/releases/latest';
          if (typeof window !== 'undefined' && typeof window.open === 'function') {
            window.open(targetUrl, '_blank', 'noopener,noreferrer');
          } else {
            uiStore.setState({ activeView: 'settings' });
            setPopoverOpen(true);
          }
        },
        onMouseenter: (e) => {
          recordPointerCoords(e);
          setActiveCapsuleAnchor(surface);
          if (hoverLeaveTimer) {
            clearTimeout(hoverLeaveTimer);
            hoverLeaveTimer = null;
          }
          if (!popoverOpen && !multiPinned) {
            if (multiOpen) {
              setMultiOpen(false);
            }
            setTooltipOpen(true);
          }
        },
        onMouseleave: (e) => {
          recordPointerCoords(e);
          if (hoverLeaveTimer) {
            clearTimeout(hoverLeaveTimer);
          }
          hoverLeaveTimer = setTimeout(() => {
            hoverLeaveTimer = null;
            if (disposed || popoverOpen) return;
            let nativeHover = false;
            try {
              nativeHover = Boolean(cBtn.matches?.(':hover') || uBtn.matches?.(':hover'));
            } catch {
              nativeHover = false;
            }
            if (nativeHover || isPointerStillInCapsule()) {
              return;
            }
            setTooltipOpen(false);
          }, 40);
        },
      },
      [uIcon, uLabel]
    );

    const cBtn = h(
      'button',
      {
        type: 'button',
        className: 'wm-capsule-btn',
        'aria-label': t('capsule.ariaMonitor'),
        'aria-expanded': 'false',
        onClick: (e) => {
          e.stopPropagation();
          const sameAnchor = getActiveAnchorSurface() === surface;
          setActiveCapsuleAnchor(surface);
          const targetCid = String(surface.cascadeId || '').trim();
          const curActiveCid = String(
            telemetryStore.getState().telemetry?.activeConversation?.cascadeId || ''
          ).trim();
          if (targetCid && targetCid.toLowerCase() !== curActiveCid.toLowerCase()) {
            telemetryStore.setState({ selectedConversationId: targetCid });
            void fetchTelemetry({ force: false });
            setPopoverOpen(true);
            return;
          }
          setPopoverOpen(sameAnchor ? !popoverOpen : true);
        },
        onContextmenu: (e) => {
          e.preventDefault();
          e.stopPropagation();
          void fetchTelemetry({ force: true });
        },
        onMouseenter: (e) => {
          recordPointerCoords(e);
          const prevAnchor = getActiveAnchorSurface();
          setActiveCapsuleAnchor(surface);
          if (hoverLeaveTimer) {
            clearTimeout(hoverLeaveTimer);
            hoverLeaveTimer = null;
          }
          if (!popoverOpen && !multiPinned) {
            if (multiOpen) {
              setMultiOpen(false);
            }
            if (tooltipOpen && prevAnchor !== surface) {
              renderHoverWidgets();
              positionFloatingElements();
            }
            setTooltipOpen(true);
          }
        },
        onMouseleave: (e) => {
          recordPointerCoords(e);
          if (hoverLeaveTimer) {
            clearTimeout(hoverLeaveTimer);
          }
          hoverLeaveTimer = setTimeout(() => {
            hoverLeaveTimer = null;
            if (disposed || popoverOpen) return;
            let nativeHover = false;
            try {
              nativeHover = Boolean(cBtn.matches?.(':hover') || uBtn.matches?.(':hover'));
            } catch {
              nativeHover = false;
            }
            if (nativeHover || isPointerStillInCapsule()) {
              return;
            }
            setTooltipOpen(false);
          }, 40);
        },
      },
      [
        slots[0].el,
        seps[0],
        slots[1].el,
        seps[1],
        slots[2].el,
        seps[2],
        slots[3].el,
        seps[3],
        slots[4].el,
        uDot,
      ]
    );

    shadow.appendChild(mBtn);
    shadow.appendChild(cBtn);
    shadow.appendChild(uBtn);

    surface.multiBtn = mBtn;
    surface.multiLabel = mLabel;
    surface.capsuleBtn = cBtn;
    surface.capsuleSlots = slots;
    surface.capsuleSeps = seps;
    surface.topbarUpdateBtn = uBtn;
    surface.topbarUpdateIcon = uIcon;
    surface.topbarUpdateLabel = uLabel;
    surface.updateDot = uDot;
    return surface;
  }

  const primarySurface = createCapsuleSurfaceInstance({ isPrimary: true });
  activeAnchorSurface = primarySurface;
  const {
    capsuleHost,
    multiBtn,
    multiLabel,
    capsuleBtn,
    capsuleSlots,
    capsuleSeps,
    topbarUpdateBtn,
    topbarUpdateIcon,
    topbarUpdateLabel,
    updateDot,
  } = primarySurface;
  let { lastSlotCount, lastShowMulti, lastShowUpdate } = primarySurface;

  // --- 2. Body Portal Shadow Host ---
  const portalHost = document.createElement('div');
  portalHost.id = PORTAL_HOST_ID;
  portalHost.className = 'wm-portal-host';
  const portalShadow = portalHost.attachShadow({ mode: 'open' });

  const portalStyleEl = document.createElement('style');
  portalStyleEl.textContent = stylesCss;
  portalShadow.appendChild(portalStyleEl);

  const initialSettings = telemetryStore.getState().telemetry?.settings;
  applyAppearanceToRoot(capsuleHost, initialSettings, { includeFontScale: false });
  applyAppearanceToRoot(portalHost, initialSettings, { includeFontScale: true });

  // widgetRegistry hoverModules 0..4
  const hoverUpdateVerText = h('span', { text: t('capsule.hoverNewVerGeneric') });
  const hoverUpdateHintText = h('span', {
    className: 'wm-hover-update-hint',
    text: t('capsule.hoverUpdateHintTopbarGeneric'),
  });
  const hoverUpdateBar = h(
    'div',
    {
      className: 'wm-hover-update-bar',
      hidden: true,
    },
    [
      h('span', { className: 'wm-hover-update-left' }, [
        createSvgIcon('arrow-down', { size: 11 }),
        hoverUpdateVerText,
      ]),
      hoverUpdateHintText,
    ]
  );

  const hoverWidgetsContainer = h('div', { className: 'wm-hover-widgets' });
  const hoverWidgetHost = createDynamicWidgetHost({
    containerEl: hoverWidgetsContainer,
    mode: 'hover',
    isVisibleFn: () => Boolean(tooltipOpen && !disposed),
    initialModuleKeys: DEFAULT_CLIENT_HOVER_MODULES,
  });

  const hoverTipEl = h(
    'div',
    {
      className: 'wm-hover-tip',
      hidden: true,
    },
    [hoverUpdateBar, hoverWidgetsContainer]
  );

  
  function createMultiLiveSubRow() {
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
      refs: { rowEl, subBadge, subRole, subSummary, subElapsed },
    };
  }

  function createMultiLiveTaskCard() {
    const dotIcon = createSvgIcon('dot', { size: 11 });
    patchClasses(dotIcon, { 'is-pulsing': true });
    const dotWrap = h('span', { className: 'live-activity-dot' }, [dotIcon]);
    const titleEl = h('strong', { className: 'live-task-title', text: t('live.currentSession') });
    const hereTagEl = h('span', {
      className: 'wm-session-tag is-here',
      hidden: true,
      text: t('multi.hereTag'),
    });
    const metricsEl = h('span', {
      className: 'wm-task-metrics text-mono',
      hidden: true,
      text: '',
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
      h('div', { className: 'live-task-title-wrap' }, [dotWrap, titleEl, hereTagEl]),
      h('div', { className: 'live-task-header-right' }, [metricsEl, subToggleBtn, elapsedEl]),
    ]);

    const mainBadge = h('span', {
      className: 'agent-badge badge-main',
      hidden: true,
      text: t('fmt.mainBadge'),
    });
    const mainPhase = h('strong', { className: 'live-activity-phase', text: t('live.thinking') });
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
        hereTagEl,
        metricsEl,
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

  const multiPinBadge = h('span', {
    className: 'wm-pin-badge',
    hidden: true,
    text: t('multi.pinned'),
  });
  const multiRunningMetaEl = h('span', {
    className: 'panel-meta text-mono',
    text: t('multi.loading'),
  });
  const multiEmptyTextEl = h('span', { text: t('multi.empty') });
  const multiEmptyEl = h('div', { className: 'wm-multi-empty' }, [
    h('span', { className: 'wm-multi-empty-left' }, [
      h('span', { className: 'wm-idle-dot' }),
      multiEmptyTextEl,
    ]),
  ]);
  const multiRunningListEl = h('div', {
    className: 'live-activity-list',
    hidden: true,
    'aria-live': 'polite',
  });

  const multiTitleTextEl = h('span', { text: t('multi.title') });
  const multiHeaderEl = h('div', { className: 'panel-header wm-multi-header' }, [
    h('span', { className: 'panel-title' }, [
      createSvgIcon('pulse', { size: 13 }),
      multiTitleTextEl,
      multiPinBadge,
    ]),
    multiRunningMetaEl,
  ]);

  const multiPanelEl = h(
    'div',
    {
      className: 'wm-multi-panel',
      role: 'dialog',
      'aria-label': t('multi.ariaDialog'),
      hidden: true,
      onMouseenter: (e) => {
        recordPointerCoords(e);
        if (multiLeaveTimer) {
          clearTimeout(multiLeaveTimer);
          multiLeaveTimer = null;
        }
      },
      onMouseleave: (e) => {
        recordPointerCoords(e);
        if (!multiPinned) {
          scheduleMultiHoverClose();
        }
      },
    },
    [multiHeaderEl, multiEmptyEl, multiRunningListEl]
  );

  
  uiStore.setState({ monitorVisible: false });
  const appInstance = App();
  const popoverEl = h(
    'div',
    {
      className: 'wm-popover-panel',
      role: 'dialog',
      'aria-label': t('capsule.ariaMonitor'),
      hidden: true,
    },
    [appInstance.el]
  );

  portalShadow.appendChild(multiPanelEl);
  portalShadow.appendChild(hoverTipEl);
  portalShadow.appendChild(popoverEl);
  (document.body || document.documentElement).appendChild(portalHost);

  // --- 3. IDE ---
  let patchedActionToolbar = null;
  let patchedActionToolbarPrevMargin = '';
  let observedWorkbench = null;
  let themeObserver = null;
  const mirroredThemeVars = new Map();
  let mirroredHostFont = '';
  let mirroredHostMonoFont = '';

  function restorePatchedActionToolbar() {
    if (!patchedActionToolbar) return;
    try {
      if (patchedActionToolbar.style) {
        patchedActionToolbar.style.marginLeft = patchedActionToolbarPrevMargin;
      }
    } catch {
      
    }
    patchedActionToolbar = null;
    patchedActionToolbarPrevMargin = '';
  }

  function syncWorkbenchThemeVars() {
    if (disposed) return null;
    try {
      if (
        typeof document === 'undefined' ||
        typeof document.querySelector !== 'function' ||
        typeof window.getComputedStyle !== 'function'
      ) {
        return null;
      }
      const workbenchEl = document.querySelector('.monaco-workbench');
      const rootCs = document.documentElement
        ? window.getComputedStyle(document.documentElement)
        : null;
      const bodyCs = document.body ? window.getComputedStyle(document.body) : null;
      const workbenchCs = workbenchEl ? window.getComputedStyle(workbenchEl) : null;
      const hostFont = String(
        bodyCs?.fontFamily ||
          workbenchCs?.fontFamily ||
          rootCs?.fontFamily ||
          rootCs?.getPropertyValue?.('--vscode-font-family') ||
          ''
      ).trim();
      if (hostFont && hostFont !== mirroredHostFont) {
        portalHost.style.setProperty?.('--ag-host-font-family', hostFont);
        for (const s of getAllCapsuleSurfaces()) {
          s.capsuleHost.style.setProperty?.('--ag-host-font-family', hostFont);
        }
        mirroredHostFont = hostFont;
      }
      const hostMonoFont = String(
        rootCs?.getPropertyValue?.('--vscode-editor-font-family') ||
          workbenchCs?.getPropertyValue?.('--vscode-editor-font-family') ||
          bodyCs?.getPropertyValue?.('--font-mono') ||
          ''
      ).trim();
      if (hostMonoFont && hostMonoFont !== mirroredHostMonoFont) {
        portalHost.style.setProperty?.('--ag-host-font-mono', hostMonoFont);
        for (const s of getAllCapsuleSurfaces()) {
          s.capsuleHost.style.setProperty?.('--ag-host-font-mono', hostMonoFont);
        }
        mirroredHostMonoFont = hostMonoFont;
      }
      const nativeRootBg = String(
        rootCs?.getPropertyValue?.('--background') ||
          bodyCs?.getPropertyValue?.('--background') ||
          ''
      ).trim();
      if (nativeRootBg) {
        if (mirroredThemeVars.size > 0) {
          for (const k of mirroredThemeVars.keys()) {
            portalHost.style.removeProperty?.(k);
            for (const s of getAllCapsuleSurfaces()) {
              s.capsuleHost.style.removeProperty?.(k);
            }
          }
          mirroredThemeVars.clear();
        }
        return workbenchEl || document.documentElement || null;
      }

      const themeSourceEl = workbenchEl || document.documentElement || document.body;
      if (!themeSourceEl) return null;
      const wbCs = window.getComputedStyle(themeSourceEl);
      const pick = (...names) => {
        for (const name of names) {
          const val = String(wbCs?.getPropertyValue?.(name) || '').trim();
          if (val) return val;
        }
        return '';
      };

      const nextVars = [
        [
          '--background',
          pick('--vscode-sideBar-background', '--vscode-editor-background', '--vscode-panel-background'),
        ],
        [
          '--card',
          pick(
            '--vscode-editorWidget-background',
            '--vscode-sideBar-background',
            '--vscode-editor-background'
          ),
        ],
        ['--foreground', pick('--vscode-foreground', '--vscode-editor-foreground')],
        [
          '--muted-foreground',
          pick('--vscode-descriptionForeground', '--vscode-sideBarTitle-foreground'),
        ],
        [
          '--border',
          pick(
            '--vscode-widget-border',
            '--vscode-panel-border',
            '--vscode-commandCenter-border',
            '--vscode-contrastBorder'
          ),
        ],
        [
          '--primary',
          pick('--vscode-textLink-foreground', '--vscode-button-background', '--vscode-focusBorder'),
        ],
        ['--destructive', pick('--vscode-errorForeground', '--vscode-editorError-foreground')],
      ];

      for (const [cssVar, val] of nextVars) {
        const prevVal = mirroredThemeVars.get(cssVar) || '';
        if (val) {
          if (prevVal !== val || splitCapsulesMap.size > 0) {
            portalHost.style.setProperty?.(cssVar, val);
            for (const s of getAllCapsuleSurfaces()) {
              s.capsuleHost.style.setProperty?.(cssVar, val);
            }
            mirroredThemeVars.set(cssVar, val);
          }
        } else if (prevVal) {
          if (typeof portalHost.style.removeProperty === 'function') {
            portalHost.style.removeProperty(cssVar);
          } else {
            portalHost.style.setProperty?.(cssVar, '');
          }
          for (const s of getAllCapsuleSurfaces()) {
            if (typeof s.capsuleHost.style.removeProperty === 'function') {
              s.capsuleHost.style.removeProperty(cssVar);
            } else {
              s.capsuleHost.style.setProperty?.(cssVar, '');
            }
          }
          mirroredThemeVars.delete(cssVar);
        }
      }
      return themeSourceEl;
    } catch {
      return null;
    }
  }

  function ensureWorkbenchThemeObserved() {
    const wb = syncWorkbenchThemeVars();
    if (wb && wb !== observedWorkbench && themeObserver) {
      observedWorkbench = wb;
      try {
        themeObserver.observe(wb, { attributes: true, attributeFilter: ['class', 'style'] });
      } catch {
        
      }
    }
  }

  function resolveRuntimeDockTarget() {
    return resolveActiveDockTarget({
      capsuleNode: capsuleHost,
      portalNode: portalHost,
      patchedNode: patchedActionToolbar,
    });
  }

  function isDockPlacementSynced(dock) {
    const curDockAttr = capsuleHost.getAttribute('data-dock');
    if (!capsuleHost.isConnected || !portalHost.isConnected) return false;
    if (!dock) {
      if (isIdeExtensionChatFrame()) {
        return curDockAttr === 'pending-composer' && capsuleHost.style.display === 'none';
      }
      return curDockAttr === 'fixed';
    }
    if (capsuleHost.style.display === 'none') return false;
    if (!dock.targetContainer?.contains?.(capsuleHost) || curDockAttr !== dock.kind) return false;
    if ((primarySurface.cascadeId || '') !== (dock.cascadeId || '')) return false;
    const curTel = telemetryStore.getState().telemetry;
    const wantPermLeft = Boolean(curTel?.settings?.moveComposerPermissionLeft);
    if (dock.kind === 'composer') {
      if (dock.anchorNode) {
        if (!isImmediatelyBeforeNode(capsuleHost, dock.anchorNode)) return false;
      } else {
        const lastEl =
          dock.targetContainer.lastElementChild !== undefined
            ? dock.targetContainer.lastElementChild
            : dock.targetContainer.children?.[dock.targetContainer.children.length - 1] ||
              dock.targetContainer.lastChild;
        if (lastEl !== capsuleHost) return false;
      }
      const expectPermAttr = wantPermLeft && Boolean(dock.permLayout) ? '1' : null;
      if ((capsuleHost.getAttribute?.('data-composer-perm-left') || null) !== expectPermAttr) {
        return false;
      }
      if (expectPermAttr === '1' && dock.permLayout?.permEl?.getAttribute?.('data-wm-composer-perm') !== '1') {
        return false;
      }
    }
    const rawMountMode =
      curTel?.settings?.windowMountMode ??
      (typeof window !== 'undefined' ? window.__AGUsageMonitorBridge?.mountMode : undefined);
    const curMountMode = normalizeClientWindowMountMode(
      rawMountMode,
      curTel?.settings?.enableWindowOverlay
    );
    const secTargets = findSecondarySplitDockTargets(dock, curMountMode, portalHost);
    if (secTargets.length !== splitCapsulesMap.size) return false;
    for (const target of secTargets) {
      const surf = splitCapsulesMap.get(target.keyNode);
      if (!surf || !surf.capsuleHost?.isConnected) return false;
      if (!target.targetContainer?.contains?.(surf.capsuleHost)) return false;
      if ((surf.cascadeId || '') !== (target.cascadeId || '')) return false;
      if (target.kind === 'composer') {
        const secExpectPerm = wantPermLeft && Boolean(target.permLayout) ? '1' : null;
        if ((surf.capsuleHost.getAttribute?.('data-composer-perm-left') || null) !== secExpectPerm) {
          return false;
        }
      }
    }
    return true;
  }

  function updateFixedFallbackPosition() {
    const dockMode = capsuleHost.getAttribute('data-dock');
    if (dockMode === 'flow' || dockMode === 'composer') {
      capsuleHost.style.top = '';
      capsuleHost.style.right = '';
      return;
    }
    try {
      const vw = Number(window.innerWidth || 1280);
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      capsuleHost.style.top = '7px';
      capsuleHost.style.right = `${rightOffset}px`;
    } catch {
      
    }
  }

  function measureAvailableTitlebarWidth(dockTarget, hostNode = capsuleHost) {
    try {
      const titlebar = dockTarget?.titlebar || null;
      if (dockTarget?.kind === 'composer' && titlebar?.getBoundingClientRect) {
        const movePermLeft = Boolean(telemetryStore.getState().telemetry?.settings?.moveComposerPermissionLeft);
        if (movePermLeft && dockTarget.permLayout?.rowEl?.getBoundingClientRect) {
          const pl = dockTarget.permLayout;
          const rowRect = pl.rowEl.getBoundingClientRect();
          if (rowRect.width > 0) {
            let leftUsed = 0;
            for (const ln of pl.leftNodes || []) {
              const lr = ln?.getBoundingClientRect?.();
              if (!lr) continue;
              // flex-1 wrapper spans unused empty space before CSS reorder applies; sum its visible children instead
              if (ln.children?.length > 0 && pl.kind === 'nested-right') {
                let childSum = 0;
                for (const ch of ln.children) {
                  const cr = ch?.getBoundingClientRect?.();
                  if (cr && cr.width > 0) childSum += cr.width;
                }
                leftUsed += childSum > 0 ? childSum : lr.width;
              } else {
                leftUsed += Math.max(0, lr.width);
              }
            }
            const permW = Math.max(0, pl.permEl?.getBoundingClientRect?.()?.width || 0);
            let actionsW = 0;
            for (const act of pl.actionEls || []) {
              actionsW += Math.max(0, act?.getBoundingClientRect?.()?.width || 0);
            }
            return rowRect.width - leftUsed - permW - actionsW - 24;
          }
        }
        const cRect = titlebar.getBoundingClientRect();
        const aRect = dockTarget.anchorNode?.getBoundingClientRect?.();
        if (cRect.width > 0) {
          const leftEdge =
            Number.isFinite(dockTarget.leftClusterRightEdge) &&
            dockTarget.leftClusterRightEdge > cRect.left + 12
              ? dockTarget.leftClusterRightEdge
              : cRect.left + 12;
          const leftOccupied = Math.max(12, leftEdge - cRect.left);
          if (aRect && aRect.width > 0) {
            const rightOccupied = Math.max(aRect.width + 8, cRect.right - aRect.left);
            return cRect.width - leftOccupied - rightOccupied - 16;
          }
          if (!dockTarget.anchorNode) {
            return cRect.width - leftOccupied - 28;
          }
        }
      }

      if (dockTarget?.kind === 'ide-titlebar' && titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          let leftContentWidth = 12;
          const leftGroup =
            titlebar.querySelector?.(':scope > .titlebar-left') ||
            titlebar.querySelector?.('.titlebar-left');
          if (leftGroup) {
            let leftSum = 0;
            if (typeof window.getComputedStyle === 'function') {
              leftSum += parseFloat(window.getComputedStyle(leftGroup).paddingLeft) || 0;
            }
            if (leftGroup.children) {
              for (const child of leftGroup.children) {
                if (child?.getBoundingClientRect) {
                  leftSum += Math.max(0, child.getBoundingClientRect().width);
                }
              }
            }
            leftContentWidth = Math.min(Math.round(tbRect.width * 0.45), Math.max(12, leftSum));
          }

          let minCenterWidth = 0;
          const centerGroup =
            titlebar.querySelector?.(':scope > .titlebar-center') ||
            titlebar.querySelector?.('.titlebar-center');
          if (centerGroup?.getBoundingClientRect) {
            const cr = centerGroup.getBoundingClientRect();
            if (cr.width > 0 && cr.height > 0) {
              minCenterWidth = Math.min(220, Math.ceil(cr.width));
            }
          }

          let rightSiblingsWidth = 0;
          let hasVisibleWindowControls = false;
          const rightGroup = dockTarget.targetContainer;
          if (rightGroup?.children) {
            for (const child of rightGroup.children) {
              if (child === hostNode || isAnyOverlayHostNode(child) || !child?.getBoundingClientRect) continue;
              const cw = Math.max(0, child.getBoundingClientRect().width);
              rightSiblingsWidth += cw;
              if (cw > 0 && child.classList?.contains?.('window-controls-container')) {
                hasVisibleWindowControls = true;
              }
            }
          }
          if (!hasVisibleWindowControls && navigator?.windowControlsOverlay?.visible) {
            const wcoRect = navigator.windowControlsOverlay.getTitlebarAreaRect?.();
            if (wcoRect && wcoRect.width > 0 && tbRect.right > wcoRect.right + 4) {
              rightSiblingsWidth += tbRect.right - wcoRect.right;
            }
          }

          return tbRect.width - leftContentWidth - minCenterWidth - rightSiblingsWidth - 28;
        }
      }

      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : tbRect.left < 168
              ? 168 - tbRect.left
              : 12;
          const minTitleWidth = 180;
          let siblingButtonsWidth = 64;
          let rightPad = 8;
          const rightGroup = hostNode.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen =
              typeof document.querySelector === 'function' &&
              Boolean(document.querySelector('[data-testid="aux-pane-sash"]'));
            const root =
              typeof document.querySelector === 'function'
                ? document.querySelector('div.h-screen.w-screen')
                : null;
            const rightClusterVar =
              root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== hostNode && !isAnyOverlayHostNode(child) && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) siblingButtonsWidth = sum + 8;
            }
          }
          return tbRect.width - contentStart - minTitleWidth - rightPad - siblingButtonsWidth;
        }
      }
      if (window.innerWidth) {
        return window.innerWidth - 360;
      }
    } catch {
      
    }
    return 320;
  }

  function positionFloatingElements() {
    const surf = getActiveAnchorSurface();
    const anchorBtn = surf?.capsuleBtn || capsuleBtn;
    const anchorMulti = surf?.multiBtn || multiBtn;
    const anchorHost = surf?.capsuleHost || capsuleHost;
    const anchorUpd = surf?.topbarUpdateBtn || topbarUpdateBtn;
    if (disposed || !anchorBtn.getBoundingClientRect) return;
    try {
      const bRect = anchorBtn.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const vw = Number(window.innerWidth || 1280);
      const vh = Number(window.innerHeight || 800);
      const navRight = getLeftSidebarRightEdge(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;
      const defaultCardW = Math.min(FLOATING_CARD_WIDTH, Math.max(280, vw - 24));
      const defaultMultiW = Math.min(MULTI_PANEL_WIDTH, Math.max(280, vw - 24));
      const isDockComposer = anchorHost.getAttribute('data-dock') === 'composer';

      if (multiOpen) {
        const mRect = anchorMulti.getBoundingClientRect?.() || bRect;
        const anchorRect = mRect.width > 0 || mRect.height > 0 ? mRect : bRect;
        const rawW =
          Number(multiPanelEl.offsetWidth) ||
          Number(multiPanelEl.getBoundingClientRect?.().width) ||
          defaultMultiW;
        const panelW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const panelH =
          Number(multiPanelEl.offsetHeight) ||
          Number(multiPanelEl.getBoundingClientRect?.().height) ||
          320;
        const spaceBelowMulti = vh - anchorRect.bottom - 12;
        const spaceAboveMulti = anchorRect.top - 16;
        const openMultiAbove =
          (isDockComposer && spaceAboveMulti > spaceBelowMulti) ||
          (anchorRect.bottom + 6 + panelH > vh - 8 && spaceAboveMulti > spaceBelowMulti);

        let top;
        let maxMultiH;
        if (openMultiAbove) {
          maxMultiH = Math.max(180, Math.floor(anchorRect.top - 20));
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
          const effMultiH = Math.min(Number(multiPanelEl.offsetHeight) || panelH, maxMultiH);
          top = Math.max(12, Math.round(anchorRect.top - effMultiH - 8));
        } else {
          top = Math.max(38, Math.round(anchorRect.bottom + 6));
          maxMultiH = Math.max(240, vh - top - 12);
          multiPanelEl.style.maxHeight = `${maxMultiH}px`;
        }
        patchClasses(multiPanelEl, { 'is-above': openMultiAbove });
        let left = Math.round(anchorRect.left);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        multiPanelEl.style.top = `${top}px`;
        multiPanelEl.style.left = `${left}px`;
      }

      const rightAnchorEdge =
        !anchorUpd.hasAttribute('hidden') && anchorUpd.getBoundingClientRect
          ? Math.max(bRect.right, anchorUpd.getBoundingClientRect().right || 0)
          : bRect.right;

      if (popoverOpen) {
        const maxPopCardW = Math.max(280, vw - minLeft - 12);
        const curSettings = telemetryStore.getState().telemetry?.settings;
        const popWidthMode = normalizeClientPopoverWidthMode(curSettings?.popoverWidthMode);
        let desiredPopW = Math.min(POPOVER_BASE_WIDTH, maxPopCardW);
        if (popWidthMode === 'custom') {
          desiredPopW = Math.min(
            normalizeClientPopoverWidth(curSettings?.popoverWidth),
            maxPopCardW
          );
        } else if (typeof popoverEl.querySelectorAll === 'function') {
          const panes = popoverEl.querySelectorAll('.table-viewport.is-step-table');
          for (const pane of panes) {
            let anc = pane;
            let inHiddenTree = false;
            while (anc && anc !== popoverEl) {
              if (anc.hasAttribute?.('hidden')) {
                inHiddenTree = true;
                break;
              }
              anc = anc.parentElement || anc.parentNode;
            }
            if (inHiddenTree) continue;
            const tableEl = pane.querySelector?.('.steps-data-table') || pane.firstElementChild;
            if (!tableEl) continue;
            const paneClientW = Number(pane.clientWidth || 0);
            const curPopW = Number(
              popoverEl.offsetWidth ||
                popoverEl.getBoundingClientRect?.().width ||
                POPOVER_BASE_WIDTH
            );
            let naturalTableW = 0;
            if (tableEl.style) {
              const prevW = tableEl.style.width || '';
              tableEl.style.width = 'max-content';
              naturalTableW = Math.ceil(
                Number(
                  tableEl.getBoundingClientRect?.().width ||
                    tableEl.scrollWidth ||
                    tableEl.offsetWidth ||
                    0
                )
              );
              tableEl.style.width = prevW;
            } else {
              naturalTableW = Math.ceil(Number(tableEl.scrollWidth || tableEl.offsetWidth || 0));
            }
            if (naturalTableW > 0) {
              const chromeW =
                paneClientW > 0 && curPopW >= paneClientW
                  ? Math.max(24, curPopW - paneClientW)
                  : 34;
              desiredPopW = Math.max(
                desiredPopW,
                Math.min(POPOVER_MAX_AUTO_WIDTH, maxPopCardW, naturalTableW + chromeW + 4)
              );
            }
          }
        }
        popoverEl.style.setProperty?.('--wm-popover-w', `${desiredPopW}px`);
        popoverEl.style.width = `${desiredPopW}px`;

        const rawW =
          Number(popoverEl.offsetWidth) ||
          Number(popoverEl.getBoundingClientRect?.().width) ||
          desiredPopW;
        const panelW = Math.min(rawW, maxPopCardW);
        const spaceBelowPop = vh - bRect.bottom - 12;
        const spaceAbovePop = bRect.top - 16;
        const openPopAbove =
          (isDockComposer && spaceAbovePop > spaceBelowPop) ||
          (spaceBelowPop < 360 && spaceAbovePop > spaceBelowPop);

        let top;
        if (openPopAbove) {
          const maxPopH = Math.max(240, Math.floor(bRect.top - 20));
          const targetPopH = Math.min(588, maxPopH);
          popoverEl.style.height = `${targetPopH}px`;
          popoverEl.style.maxHeight = `${maxPopH}px`;
          const actualPopH = Math.min(Number(popoverEl.offsetHeight) || targetPopH, maxPopH);
          top = Math.max(12, Math.round(bRect.top - actualPopH - 8));
        } else {
          popoverEl.style.height = '';
          top = Math.max(38, Math.min(vh - 140, Math.round(bRect.bottom + 6)));
          popoverEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(popoverEl, { 'is-above': openPopAbove });
        let left = Math.round(rightAnchorEdge - panelW);
        left = Math.min(left, vw - panelW - 12);
        left = Math.max(minLeft, left);
        popoverEl.style.top = `${top}px`;
        popoverEl.style.left = `${left}px`;
      }

      if (tooltipOpen && !popoverOpen && !multiOpen) {
        const rawW =
          Number(hoverTipEl.offsetWidth) ||
          Number(hoverTipEl.getBoundingClientRect?.().width) ||
          defaultCardW;
        const tipW = Math.min(rawW, Math.max(280, vw - minLeft - 12));
        const tipH =
          Number(hoverTipEl.offsetHeight) ||
          Number(hoverTipEl.getBoundingClientRect?.().height) ||
          480;
        const spaceBelowTip = vh - bRect.bottom - 12;
        const spaceAboveTip = bRect.top - 16;
        const openTipAbove =
          (isDockComposer && spaceAboveTip > spaceBelowTip) ||
          (bRect.bottom + 6 + tipH > vh - 8 && spaceAboveTip > spaceBelowTip);

        let top;
        if (openTipAbove) {
          const maxTipH = Math.max(220, Math.floor(bRect.top - 20));
          hoverTipEl.style.maxHeight = `${maxTipH}px`;
          const effTipH = Math.min(Number(hoverTipEl.offsetHeight) || tipH, maxTipH);
          top = Math.max(12, Math.round(bRect.top - effTipH - 8));
        } else {
          top = Math.max(38, Math.round(bRect.bottom + 6));
          hoverTipEl.style.maxHeight = `${Math.max(240, vh - top - 12)}px`;
        }
        patchClasses(hoverTipEl, { 'is-above': openTipAbove });
        let left = Math.round(rightAnchorEdge - tipW);
        left = Math.min(left, vw - tipW - 12);
        left = Math.max(minLeft, left);
        hoverTipEl.style.top = `${top}px`;
        hoverTipEl.style.left = `${left}px`;
      }
    } catch {
      
    }
  }

  function updateSurfaceResponsiveLayout(surface, dockTargetOverride = undefined) {
    if (disposed || !surface) return;
    const dockTarget =
      dockTargetOverride !== undefined
        ? dockTargetOverride
        : surface.isPrimary
          ? resolveRuntimeDockTarget()
          : surface.dockTarget;
    const avail = measureAvailableTitlebarWidth(dockTarget, surface.capsuleHost);
    const curTel = telemetryStore.getState().telemetry;
    const showMulti = curTel?.settings?.showTopbarMultiSession !== false;
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpdate = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    const slotCount = normalizeClientTopbarSlots(curTel?.settings?.topbarCapsuleSlots).length;
    const nextMode = computeCapsuleLayoutMode(avail, surface.layoutMode || 'wide', {
      showMulti,
      hasUpdate,
      slotCount,
    });
    if (nextMode !== surface.layoutMode) {
      surface.layoutMode = nextMode;
      surface.capsuleHost.setAttribute('data-layout', nextMode);
      if (surface.isPrimary) {
        layoutMode = nextMode;
      }
    }
  }

  function updateResponsiveLayout(dockOverride = undefined) {
    if (disposed) return;
    updateSurfaceResponsiveLayout(primarySurface, dockOverride);
    for (const splitSurf of splitCapsulesMap.values()) {
      updateSurfaceResponsiveLayout(splitSurf, splitSurf.dockTarget);
    }
    if (capsuleHost.getAttribute('data-dock') === 'fixed') {
      updateFixedFallbackPosition();
    }
    if (popoverOpen || tooltipOpen || multiOpen) {
      positionFloatingElements();
    }
  }

  let resizeObserver = null;

  function restoreSurfaceActionToolbar(surface) {
    if (!surface?.patchedActionToolbar) return;
    try {
      if (surface.patchedActionToolbar.style) {
        surface.patchedActionToolbar.style.marginLeft = surface.patchedActionToolbarPrevMargin || '';
      }
    } catch {
      
    }
    surface.patchedActionToolbar = null;
    surface.patchedActionToolbarPrevMargin = '';
  }

  function clearSurfaceComposerPermLayout(surface) {
    const prev = surface?.appliedComposerPermLayout;
    if (!prev) return;
    const others = getAllCapsuleSurfaces().filter((s) => s && s !== surface && s.appliedComposerPermLayout);
    const isOwnedByOther = (key, node) =>
      Boolean(
        node &&
          others.some((s) => {
            const p = s.appliedComposerPermLayout;
            if (!p) return false;
            if (Array.isArray(p[key])) return p[key].includes(node);
            return p[key] === node;
          })
      );
    try {
      if (!isOwnedByOther('rowEl', prev.rowEl)) {
        prev.rowEl?.removeAttribute?.('data-wm-composer-row');
      }
      for (const ln of prev.leftNodes || []) {
        if (!isOwnedByOther('leftNodes', ln)) {
          ln?.removeAttribute?.('data-wm-composer-left');
        }
      }
      if (!isOwnedByOther('rightEl', prev.rightEl)) {
        prev.rightEl?.removeAttribute?.('data-wm-composer-right');
      }
      if (!isOwnedByOther('permEl', prev.permEl)) {
        prev.permEl?.removeAttribute?.('data-wm-composer-perm');
      }
      for (const act of prev.actionEls || []) {
        if (!isOwnedByOther('actionEls', act)) {
          act?.removeAttribute?.('data-wm-composer-actions');
        }
      }
    } catch {
      // ignore attribute cleanup error
    }
    surface.appliedComposerPermLayout = null;
  }

  function syncSurfaceComposerPermLayout(surface, permLayout, enabled) {
    if (!enabled || !permLayout) {
      clearSurfaceComposerPermLayout(surface);
      patchAttr(surface.capsuleHost, 'data-composer-perm-left', null);
      return false;
    }
    const prev = surface.appliedComposerPermLayout;
    const sameNodes =
      prev &&
      prev.rowEl === permLayout.rowEl &&
      prev.rightEl === permLayout.rightEl &&
      prev.permEl === permLayout.permEl;
    if (!sameNodes) {
      clearSurfaceComposerPermLayout(surface);
    }
    syncComposerLayoutStyleElement(true);
    try {
      permLayout.rowEl?.setAttribute?.('data-wm-composer-row', '1');
      for (const ln of permLayout.leftNodes || []) {
        ln?.setAttribute?.('data-wm-composer-left', '1');
      }
      permLayout.rightEl?.setAttribute?.('data-wm-composer-right', '1');
      permLayout.permEl?.setAttribute?.('data-wm-composer-perm', '1');
      for (const act of permLayout.actionEls || []) {
        act?.setAttribute?.('data-wm-composer-actions', '1');
      }
      surface.appliedComposerPermLayout = permLayout;
      patchAttr(surface.capsuleHost, 'data-composer-perm-left', '1');
      return true;
    } catch {
      clearSurfaceComposerPermLayout(surface);
      patchAttr(surface.capsuleHost, 'data-composer-perm-left', null);
      return false;
    }
  }

  function refreshComposerLayoutStyleGlobalState() {
    const anyActive = getAllCapsuleSurfaces().some((s) => Boolean(s?.appliedComposerPermLayout));
    syncComposerLayoutStyleElement(anyActive);
  }

  function disposeSecondarySplitSurface(keyNode, surface) {
    cancelCapsuleSlotAnimations(surface?.capsuleSlots);
    restoreSurfaceActionToolbar(surface);
    clearSurfaceComposerPermLayout(surface);
    if (activeAnchorSurface === surface) {
      activeAnchorSurface = primarySurface;
      if (tooltipOpen) {
        setTooltipOpen(false);
      } else if (popoverOpen) {
        positionFloatingElements();
      }
    }
    try {
      surface.capsuleHost?.remove?.();
    } catch {
      // ignore remove error
    }
    if (keyNode !== undefined) {
      splitCapsulesMap.delete(keyNode);
    }
    refreshComposerLayoutStyleGlobalState();
  }

  function dockCapsuleSurfaceIntoTarget(surface, dockTarget) {
    const hostEl = surface.capsuleHost;
    if (hostEl.style.display === 'none') {
      hostEl.style.display = '';
    }
    surface.dockTarget = dockTarget;
    surface.cascadeId = String(dockTarget.cascadeId || '');
    const { kind, titlebar, targetContainer, actionToolbar } = dockTarget;
    const wantPermLeft = Boolean(
      telemetryStore.getState().telemetry?.settings?.moveComposerPermissionLeft
    );
    if (kind === 'composer') {
      if (surface.patchedActionToolbar !== actionToolbar) {
        restoreSurfaceActionToolbar(surface);
        if (actionToolbar?.style) {
          surface.patchedActionToolbar = actionToolbar;
          surface.patchedActionToolbarPrevMargin = actionToolbar.style.marginLeft || '';
          actionToolbar.style.marginLeft = '0px';
        }
      }
      if (dockTarget.anchorNode) {
        if (
          (hostEl.parentElement || hostEl.parentNode) !== targetContainer ||
          !isImmediatelyBeforeNode(hostEl, dockTarget.anchorNode)
        ) {
          targetContainer.insertBefore(hostEl, dockTarget.anchorNode);
        }
      } else {
        const lastEl =
          targetContainer.lastElementChild !== undefined
            ? targetContainer.lastElementChild
            : targetContainer.children?.[targetContainer.children.length - 1] ||
              targetContainer.lastChild;
        if (
          (hostEl.parentElement || hostEl.parentNode) !== targetContainer ||
          lastEl !== hostEl
        ) {
          targetContainer.appendChild(hostEl);
        }
      }
      patchAttr(hostEl, 'data-dock', 'composer');
      patchAttr(
        hostEl,
        'data-composer-push',
        dockTarget.needsAutoMarginTransfer ? '1' : null
      );
      syncSurfaceComposerPermLayout(surface, dockTarget.permLayout, wantPermLeft);
    } else {
      clearSurfaceComposerPermLayout(surface);
      patchAttr(hostEl, 'data-composer-perm-left', null);
      restoreSurfaceActionToolbar(surface);
      if (hostEl.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(hostEl, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(hostEl);
        }
      }
      patchAttr(hostEl, 'data-dock', 'flow');
      patchAttr(hostEl, 'data-composer-push', null);
    }
    if (hostEl.style.top) hostEl.style.top = '';
    if (hostEl.style.right) hostEl.style.right = '';
  }

  function syncSecondarySplitCapsules(primaryDock) {
    const curSettings = telemetryStore.getState().telemetry?.settings;
    const rawMountMode =
      curSettings?.windowMountMode ??
      (typeof window !== 'undefined' ? window.__AGUsageMonitorBridge?.mountMode : undefined);
    const curMountMode = normalizeClientWindowMountMode(
      rawMountMode,
      curSettings?.enableWindowOverlay
    );
    const secondaryTargets = findSecondarySplitDockTargets(primaryDock, curMountMode, portalHost);
    const nextKeys = new Set(secondaryTargets.map((t) => t.keyNode));

    for (const [keyNode, surf] of [...splitCapsulesMap.entries()]) {
      if (!nextKeys.has(keyNode) || !keyNode?.isConnected) {
        disposeSecondarySplitSurface(keyNode, surf);
      }
    }

    let splitNeedsRender = false;
    for (const target of secondaryTargets) {
      let surf = splitCapsulesMap.get(target.keyNode);
      if (!surf) {
        splitNeedsRender = true;
        surf = createCapsuleSurfaceInstance({ isPrimary: false });
        if (mirroredHostFont) {
          surf.capsuleHost.style.setProperty?.('--ag-host-font-family', mirroredHostFont);
        }
        if (mirroredHostMonoFont) {
          surf.capsuleHost.style.setProperty?.('--ag-host-font-mono', mirroredHostMonoFont);
        }
        for (const [cssVar, val] of mirroredThemeVars.entries()) {
          surf.capsuleHost.style.setProperty?.(cssVar, val);
        }
        splitCapsulesMap.set(target.keyNode, surf);
      } else if ((surf.cascadeId || '') !== String(target.cascadeId || '')) {
        splitNeedsRender = true;
      }
      dockCapsuleSurfaceIntoTarget(surf, target);
      if (resizeObserver && target.titlebar) {
        try {
          resizeObserver.observe(target.titlebar);
        } catch {
          // ignore resize observe errors
        }
      }
    }
    if (splitNeedsRender && telemetryStore.getState().telemetry) {
      renderCapsuleTelemetry();
    }
  }

  function ensureCapsuleDocked() {
    if (disposed) return false;
    const bodyOrDoc = document.body || document.documentElement;
    if (bodyOrDoc && !portalHost.isConnected) {
      bodyOrDoc.appendChild(portalHost);
    }
    ensureWorkbenchThemeObserved();

    const dockTarget = resolveRuntimeDockTarget();
    if (dockTarget) {
      dockCapsuleSurfaceIntoTarget(primarySurface, dockTarget);
      patchedActionToolbar = primarySurface.patchedActionToolbar;
      patchedActionToolbarPrevMargin = primarySurface.patchedActionToolbarPrevMargin;

      if (observedTitlebar !== dockTarget.titlebar) {
        observedTitlebar = dockTarget.titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            if (dockTarget.titlebar) resizeObserver.observe(dockTarget.titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch {
          
        }
      }
      syncSecondarySplitCapsules(dockTarget);
      refreshComposerLayoutStyleGlobalState();
    } else if (isIdeExtensionChatFrame()) {
      for (const [keyNode, surf] of [...splitCapsulesMap.entries()]) {
        disposeSecondarySplitSurface(keyNode, surf);
      }
      restorePatchedActionToolbar();
      clearSurfaceComposerPermLayout(primarySurface);
      patchAttr(capsuleHost, 'data-composer-perm-left', null);
      refreshComposerLayoutStyleGlobalState();
      primarySurface.patchedActionToolbar = null;
      primarySurface.patchedActionToolbarPrevMargin = '';
      if (popoverOpen) setPopoverOpen(false);
      if (multiOpen) setMultiOpen(false);
      if (tooltipOpen) setTooltipOpen(false);
      if (bodyOrDoc && (capsuleHost.parentElement || capsuleHost.parentNode) !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      capsuleHost.style.display = 'none';
      patchAttr(capsuleHost, 'data-dock', 'pending-composer');
      patchAttr(capsuleHost, 'data-composer-push', null);
    } else if (bodyOrDoc) {
      for (const [keyNode, surf] of [...splitCapsulesMap.entries()]) {
        disposeSecondarySplitSurface(keyNode, surf);
      }
      if (capsuleHost.style.display === 'none') {
        capsuleHost.style.display = '';
      }
      restorePatchedActionToolbar();
      clearSurfaceComposerPermLayout(primarySurface);
      patchAttr(capsuleHost, 'data-composer-perm-left', null);
      refreshComposerLayoutStyleGlobalState();
      primarySurface.patchedActionToolbar = null;
      primarySurface.patchedActionToolbarPrevMargin = '';
      if (capsuleHost.parentElement !== bodyOrDoc) {
        bodyOrDoc.appendChild(capsuleHost);
      }
      patchAttr(capsuleHost, 'data-dock', 'fixed');
      patchAttr(capsuleHost, 'data-composer-push', null);
      updateFixedFallbackPosition();
    }

    updateResponsiveLayout(dockTarget);
    return Boolean(capsuleHost.isConnected && portalHost.isConnected);
  }

  function scheduleDockSync() {
    if (disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (dockRafId) return;
      dockRafId = requestAnimationFrame(() => {
        dockRafId = 0;
        ensureCapsuleDocked();
      });
    } else {
      ensureCapsuleDocked();
    }
  }

  function refreshActiveViewScrollbars() {
    const activeView = uiStore.getState().activeView;
    const refs = appInstance.refs;
    if (activeView === 'overview') {
      refs?.overviewView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'consumption') {
      refs?.consumptionView?.refs?.viewScrollbar?.refresh();
    } else if (activeView === 'steps') {
      refs?.stepsView?.refs?.stepsScroll?.refresh();
      refs?.stepsView?.refs?.modelsScroll?.refresh();
    } else if (activeView === 'settings') {
      refs?.settingsView?.refs?.viewScrollbar?.refresh();
    }
  }

  function setMultiOpen(nextOpen, { pinned = false, instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen && multiLeaveTimer) {
      clearTimeout(multiLeaveTimer);
      multiLeaveTimer = null;
    }
    if (targetOpen) {
      setTooltipOpen(false);
      if (pinned && popoverOpen) {
        setPopoverOpen(false);
      }
    }
    const nextPinned = targetOpen ? Boolean(pinned) : false;
    const stateChanged = multiOpen !== targetOpen || multiPinned !== nextPinned;
    multiOpen = targetOpen;
    multiPinned = nextPinned;
    patchClasses(multiBtn, { 'is-open': multiOpen && multiPinned });
    patchAttr(multiBtn, 'aria-expanded', multiOpen ? 'true' : 'false');
    patchAttr(multiPinBadge, 'hidden', !multiPinned);
    if (!stateChanged) return;
    patchClasses(multiPanelEl, { 'is-instant': Boolean(instant && multiOpen) });
    patchAttr(multiPanelEl, 'hidden', !multiOpen);
    if (multiOpen) {
      renderCapsuleTelemetry();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      pauseMultiLiveTicker();
    }
  }

  function canOpenHoverTooltip() {
    const curTel = telemetryStore.getState().telemetry;
    const hoverMods = normalizeClientHoverModules(curTel?.settings?.hoverModules);
    const curUpdateMode = normalizeClientUpdateMode(
      curTel?.settings?.pluginUpdateMode,
      curTel?.settings?.autoUpdatePlugin
    );
    const hasUpd = Boolean(curTel?.cloudStatus?.updateAvailable) && curUpdateMode !== 'off';
    return hoverMods.length > 0 || hasUpd;
  }

  function setTooltipOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(
      nextOpen && !popoverOpen && !(multiOpen && multiPinned) && canOpenHoverTooltip()
    );
    if (targetOpen && hoverLeaveTimer) {
      clearTimeout(hoverLeaveTimer);
      hoverLeaveTimer = null;
    }
    if (targetOpen && multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
    if (tooltipOpen === targetOpen) return;
    tooltipOpen = targetOpen;
    patchClasses(hoverTipEl, { 'is-instant': Boolean(instant && targetOpen) });
    patchAttr(hoverTipEl, 'hidden', !tooltipOpen);
    if (tooltipOpen) {
      renderHoverWidgets();
      hoverWidgetHost.resumeTickers();
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => positionFloatingElements());
      }
    } else {
      hoverWidgetHost.pauseTickers();
    }
  }

  function setPopoverOpen(nextOpen, { instant = false } = {}) {
    const targetOpen = Boolean(nextOpen);
    if (targetOpen) {
      setTooltipOpen(false);
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
    if (popoverOpen === targetOpen) return;
    popoverOpen = targetOpen;
    patchClasses(capsuleBtn, { 'is-open': popoverOpen });
    patchClasses(popoverEl, { 'is-instant': Boolean(instant && popoverOpen) });
    patchAttr(capsuleBtn, 'aria-expanded', popoverOpen ? 'true' : 'false');
    patchAttr(popoverEl, 'hidden', !popoverOpen);
    uiStore.setState({ monitorVisible: popoverOpen && !document.hidden }, { sync: true });
    if (popoverOpen) {
      positionFloatingElements();
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => {
          positionFloatingElements();
          refreshActiveViewScrollbars();
        });
      } else {
        refreshActiveViewScrollbars();
      }
    }
  }

  function applyCapsuleSlots(slotKeys, slotCtx) {
    syncCapsuleSlotNodes(capsuleSlots, capsuleSeps, slotKeys, slotCtx);
  }

  function renderMultiRunningPanel(rawRunningList, runningCount, runningSubCount, hostRouteConversationId) {
    if (manualSubExpandMap.size > 0) {
      const runningIds = new Set(rawRunningList.map((item) => item.cascadeId));
      for (const id of manualSubExpandMap.keys()) {
        if (!runningIds.has(id)) manualSubExpandMap.delete(id);
      }
    }
    if (!multiOpen || document.hidden) return;
    const localeKey = getEffectiveLocale();
    const hostRouteLower = String(
      hostRouteConversationId || extractHostRouteCascadeId() || ''
    ).toLowerCase();

    patchText(
      multiRunningMetaEl,
      runningCount > 0
        ? runningSubCount > 0
          ? t('multi.metaWithSubs', { main: runningCount, subs: runningSubCount })
          : t('multi.metaMainOnly', { main: runningCount })
        : t('multi.allIdle')
    );
    patchAttr(multiEmptyEl, 'hidden', runningCount > 0);
    patchAttr(multiRunningListEl, 'hidden', runningCount === 0);

    if (runningCount === 0) {
      stopMultiLiveTicker();
      patchKeyedList(multiRunningListEl, [], {});
    } else {
      const activeTimerKeys = new Set();
      for (const item of rawRunningList) {
        activeTimerKeys.add(`main:${item.cascadeId}`);
        const subCount = Number(item.subagentCount || item.subagents?.length || 0);
        const runSubs = Number(item.runningSubagentCount || 0);
        const isExp = manualSubExpandMap.has(item.cascadeId)
          ? manualSubExpandMap.get(item.cascadeId)
          : runSubs > 0;
        if (subCount > 0 && isExp) {
          for (const sub of item.subagents || []) {
            if (sub?.isRunning) {
              activeTimerKeys.add(`sub:${sub.cascadeId}`);
            }
          }
        }
      }

      patchKeyedList(multiRunningListEl, rawRunningList, {
        keyFn: (item) => item.cascadeId,
        sigFn: (item) => {
          const runSubs = Number(item.runningSubagentCount || 0);
          const isExp = manualSubExpandMap.has(item.cascadeId)
            ? manualSubExpandMap.get(item.cascadeId)
            : runSubs > 0;
          const isHere =
            Boolean(hostRouteLower) &&
            String(item.cascadeId || '').toLowerCase() === hostRouteLower;
          const subSig = (item.subagents || [])
            .map(
              (s) =>
                `${s.cascadeId}:${s.isRunning}:${s.stepCount}:${s.liveActivity?.signature || ''}:${s.liveActivity?.startedAtMs || 0}`
            )
            .join('|');
          return `${localeKey}:${item.cascadeId}:${item.title}:${isHere}:${item.isMainRunning}:${item.subagentCount}:${runSubs}:${isExp}:${item.latestTokPerSec ?? ''}:${item.contextUsedPct ?? ''}:${item.mainActivity?.signature || ''}:${item.mainActivity?.startedAtMs || 0}:${subSig}`;
        },
        createRow: createMultiLiveTaskCard,
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

          const convTitle =
            item.title || item.cascadeId?.slice(0, 8) || t('live.currentSession');
          patchText(refs.titleEl, convTitle);
          patchAttr(refs.titleEl, 'title', t('multi.inspectSessionTitle', { title: convTitle }));
          refs.titleEl.onclick = (e) => {
            e.stopPropagation();
            inspectSessionInMonitor(item.cascadeId);
          };

          const isHere =
            Boolean(hostRouteLower) &&
            String(item.cascadeId || '').toLowerCase() === hostRouteLower;
          patchText(refs.hereTagEl, t('multi.hereTag'));
          patchAttr(refs.hereTagEl, 'hidden', !isHere);

          const metricParts = [];
          if (Number.isFinite(item.latestTokPerSec) && item.latestTokPerSec > 0) {
            metricParts.push(
              `${item.latestTokPerSec >= 100 ? Math.round(item.latestTokPerSec) : item.latestTokPerSec.toFixed(1)} t/s`
            );
          }
          if (item.contextUsedPct != null && Number.isFinite(Number(item.contextUsedPct))) {
            metricParts.push(`${Math.round(Number(item.contextUsedPct))}%`);
          }
          const metricsStr = metricParts.join(' · ');
          patchAttr(refs.metricsEl, 'hidden', !metricsStr);
          if (metricsStr) {
            patchText(refs.metricsEl, metricsStr);
          }

          const subCount = Number(item.subagentCount || item.subagents?.length || 0);
          const runSubCount = Number(item.runningSubagentCount || 0);
          const isExpanded = manualSubExpandMap.has(item.cascadeId)
            ? manualSubExpandMap.get(item.cascadeId)
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
            refs.subToggleBtn.onclick = (e) => {
              e.stopPropagation();
              manualSubExpandMap.set(item.cascadeId, !isExpanded);
              renderCapsuleTelemetry();
              if (multiOpen) {
                positionFloatingElements();
              }
            };
          }

          const mainTimerKey = `main:${item.cascadeId}`;
          activeTimerKeys.add(mainTimerKey);
          bindMultiElapsedTimer(
            mainTimerKey,
            `${item.cascadeId}:${act.signature || act.label}`,
            act.startedAtMs,
            refs.elapsedEl
          );

          patchText(refs.mainPhase, translateLiveActivityText(act.label) || t('live.thinking'));
          const progText = act.stepProgress ? `[${act.stepProgress}]` : '';
          patchAttr(refs.mainProgress, 'hidden', !progText);
          if (progText) {
            patchText(refs.mainProgress, progText);
          }

          const detailStr = translateLiveActivityText(act.detail || '');
          patchAttr(refs.mainSep, 'hidden', !detailStr);
          patchAttr(refs.mainDetail, 'hidden', !detailStr);
          patchText(refs.mainDetail, detailStr);

          const showSubs = subCount > 0 && isExpanded;
          patchAttr(refs.subListEl, 'hidden', !showSubs);
          if (showSubs) {
            const subItems = item.subagents || [];
            patchKeyedList(refs.subListEl, subItems, {
              keyFn: (sub) => sub.cascadeId,
              sigFn: (sub) =>
                `${localeKey}:${sub.cascadeId}:${sub.role}:${sub.isRunning}:${sub.stepCount}:${sub.liveActivity?.signature || ''}:${sub.isRunning ? multiTimersMap.has(`sub:${sub.cascadeId}`) : true}`,
              createRow: createMultiLiveSubRow,
              updateRow: (subRefs, sub) => {
                const subAct = sub.liveActivity || {
                  phase: sub.isRunning ? 'thinking' : 'done',
                  label: sub.isRunning ? t('live.thinking') : t('live.done'),
                  detail: '',
                  stepProgress: '',
                  startedAtMs: sub.lastModifiedMs || 0,
                };
                patchClasses(subRefs.rowEl, { 'is-done': !sub.isRunning });
                const subBadgeCls = getAgentBadgeClass(sub.index || 1, false);
                patchAttr(subRefs.subBadge, 'class', `agent-badge ${subBadgeCls}`);
                patchText(subRefs.subBadge, formatAgentBadgeText(sub));
                patchText(subRefs.subRole, sub.role || sub.shortLabel || t('fmt.subAgent'));

                const subProg = subAct.stepProgress ? ` [${subAct.stepProgress}]` : '';
                const translatedSubLabel = translateLiveActivityText(subAct.label) || t('live.running');
                const translatedSubDetail = translateLiveActivityText(subAct.detail || '');
                const summaryText = sub.isRunning
                  ? `${translatedSubLabel}${subProg}${translatedSubDetail ? ` · ${translatedSubDetail}` : ''}`
                  : t('live.doneWithSteps', { steps: sub.stepCount || 0 });
                patchText(subRefs.subSummary, summaryText);

                const subTimerKey = `sub:${sub.cascadeId}`;
                if (sub.isRunning) {
                  activeTimerKeys.add(subTimerKey);
                  bindMultiElapsedTimer(
                    subTimerKey,
                    `${sub.cascadeId}:${subAct.signature || subAct.label}`,
                    subAct.startedAtMs || sub.lastModifiedMs,
                    subRefs.subElapsed
                  );
                } else {
                  multiTimersMap.delete(subTimerKey);
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

      for (const k of [...multiTimersMap.keys()]) {
        if (!activeTimerKeys.has(k)) {
          multiTimersMap.delete(k);
        }
      }
      ensureMultiLiveTicker();
      tickMultiElapsedDisplay();
    }
  }

  function findConversationSummary(telemetry, targetCid) {
    const cidLower = String(targetCid || '').trim().toLowerCase();
    if (!cidLower || !telemetry) return null;
    const convs = Array.isArray(telemetry.conversations) ? telemetry.conversations : [];
    const found = convs.find((c) => String(c?.cascadeId || '').toLowerCase() === cidLower);
    if (found) return found;
    const running = Array.isArray(telemetry.runningConversations) ? telemetry.runningConversations : [];
    return running.find((c) => String(c?.cascadeId || '').toLowerCase() === cidLower) || null;
  }

  let quotaCyclePhase = '5h';
  let quotaCycleInterval = null;
  let quotaCycleFadeTimer = null;
  let selectedModelSyncTimer = null;

  function detectSelectedModelForSurface(surface, telemetry) {
    if (!telemetry || !Array.isArray(telemetry.contextWindowModels) || !telemetry.contextWindowModels.length) {
      return null;
    }
    const hostEl = surface?.capsuleHost;
    const scopeRoot =
      surface?.paneEl ||
      hostEl?.closest?.('[data-cascade-id], form, [class*="composer"]') ||
      hostEl?.parentElement?.parentElement ||
      document.body;
    if (!scopeRoot || typeof scopeRoot.querySelectorAll !== 'function') return null;

    const btns = scopeRoot.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < btns.length; i += 1) {
      const btn = btns[i];
      if (!btn || isAnyOverlayHostNode(btn)) continue;
      if (btn.getAttribute?.('data-testid') === 'permissions-selector-trigger') continue;
      const text = cleanComposerButtonText(btn);
      if (!text || text.length < 3 || text.length > 80) continue;
      const resolved = resolveSelectedModelContextLimit(text, telemetry);
      if (resolved) return resolved;
    }
    return null;
  }

  function applySelectedModelLimitToSlotCtx(slotCtx, selectedModel, totalTokens) {
    if (!selectedModel || !(selectedModel.limitTokens > 0)) return slotCtx;
    const limitTokens = selectedModel.limitTokens;
    const usedTokens = Math.max(0, Number(totalTokens || 0));
    const usedPct = Math.min(100, +((usedTokens / limitTokens) * 100).toFixed(2));
    const dashOffset = +(RING_CIRCUMFERENCE * (1 - usedPct / 100)).toFixed(2);
    const nextCtx = slotCtx.context
      ? { ...slotCtx.context, totalTokens: usedTokens, limitTokens, compactionLimitTokens: limitTokens, usedPct }
      : { totalTokens: usedTokens, limitTokens, compactionLimitTokens: limitTokens, usedPct };
    return {
      ...slotCtx,
      context: nextCtx,
      usedPct,
      dashOffset,
    };
  }

  function buildSlotContextForSurface(telemetry, surface, activeSlotCtx) {
    if (!telemetry) return { hasTelemetry: false };
    const selectedModel = detectSelectedModelForSurface(surface, telemetry);
    const targetCid = String(surface?.cascadeId || '').trim();
    const activeCid = String(telemetry.activeConversation?.cascadeId || '').trim();
    if (!targetCid || (targetCid !== '__new__' && activeCid && targetCid.toLowerCase() === activeCid.toLowerCase())) {
      const baseTotal = Number(activeSlotCtx.context?.totalTokens || 0);
      return applySelectedModelLimitToSlotCtx(
        { ...activeSlotCtx, quotaCyclePhase },
        selectedModel,
        baseTotal
      );
    }
    const conv = targetCid === '__new__' ? null : findConversationSummary(telemetry, targetCid);
    const quotaDisplayMode = normalizeClientQuotaDisplayMode(telemetry.settings?.quotaDisplayMode);
    if (!conv) {
      const emptyLimit = selectedModel?.limitTokens || 256000;
      return {
        hasTelemetry: true,
        context: {
          totalTokens: 0,
          limitTokens: emptyLimit,
          compactionLimitTokens: emptyLimit,
          usedPct: 0,
        },
        usedPct: 0,
        dashOffset: RING_CIRCUMFERENCE,
        isRunning: false,
        tps: null,
        avgTps: null,
        ttft: null,
        stepCost: null,
        sessionCost: null,
        cacheHitPct: null,
        latestPromptTokens: null,
        sessionTokens: null,
        quotas: telemetry.quotas,
        quotaDisplayMode,
        quotaCyclePhase,
      };
    }
    const baseLimit = Number(conv.contextLimitTokens || 256000);
    const basePct = Number.isFinite(Number(conv.contextUsedPct))
      ? Math.max(0, Math.min(100, Number(conv.contextUsedPct)))
      : 0;
    const baseTotal = Number(conv.contextTotalTokens ?? Math.round((basePct / 100) * baseLimit));
    const dashOffset = +(RING_CIRCUMFERENCE * (1 - basePct / 100)).toFixed(2);
    const baseSlotCtx = {
      hasTelemetry: true,
      context: conv.contextBreakdown || conv.context || null,
      usedPct: basePct,
      dashOffset,
      isRunning: Boolean(conv.isRunning),
      tps: conv.latestTokPerSec ?? null,
      avgTps: conv.avgTokPerSec ?? null,
      ttft: conv.latestTtftSec ?? null,
      stepCost: conv.latestStepCostUsd ?? null,
      sessionCost: conv.sessionCostUsd ?? null,
      cacheHitPct:
        Number(conv.stepCount || 0) > 0 ? conv.latestCacheHitPct ?? null : null,
      latestPromptTokens: conv.latestPromptTokens ?? null,
      sessionTokens: conv.totalTokens ?? null,
      quotas: telemetry.quotas,
      quotaDisplayMode,
      quotaCyclePhase,
    };
    return applySelectedModelLimitToSlotCtx(baseSlotCtx, selectedModel, baseTotal);
  }

  function renderHoverWidgets() {
    const { telemetry, minuteTick } = telemetryStore.getState();
    let hoverData = telemetry;
    const anchorSurface = getActiveAnchorSurface();
    const anchorCid = String(anchorSurface?.cascadeId || '').trim();
    const activeCid = String(telemetry?.activeConversation?.cascadeId || '').trim();
    const selectedModel = detectSelectedModelForSurface(anchorSurface, telemetry);
    if (telemetry && anchorCid === '__new__') {
      const emptyLimit = selectedModel?.limitTokens || 256000;
      hoverData = {
        ...telemetry,
        activeConversation: {
          cascadeId: '__new__',
          title: t('live.currentSession'),
          isRunning: false,
          stepCount: 0,
          hasSubagents: false,
          agents: [],
          latestTokPerSec: null,
          latestTtftSec: null,
          avgTokPerSec: null,
          latestStepCostUsd: null,
          sessionCostUsd: 0,
          latestCacheHitPct: null,
          latestPromptTokens: 0,
          totalTokens: 0,
          activeModelShort: selectedModel?.label || '',
          activeModelUpstream: selectedModel?.label || '',
          context: {
            totalTokens: 0,
            limitTokens: emptyLimit,
            compactionLimitTokens: emptyLimit,
            usedPct: 0,
          },
        },
      };
    } else if (
      telemetry &&
      anchorCid &&
      (!activeCid || anchorCid.toLowerCase() !== activeCid.toLowerCase())
    ) {
      const conv = findConversationSummary(telemetry, anchorCid);
      if (conv) {
        const baseLimit = Number(conv.contextLimitTokens || 256000);
        const basePct = Number(conv.contextUsedPct || 0);
        const ctxTotal = Number(conv.contextTotalTokens ?? Math.round((basePct / 100) * baseLimit));
        const ctxLimit = selectedModel?.limitTokens || baseLimit;
        const ctxPct =
          ctxLimit > 0 ? Math.min(100, +((ctxTotal / ctxLimit) * 100).toFixed(2)) : 0;
        hoverData = {
          ...telemetry,
          activeConversation: {
            cascadeId: conv.cascadeId,
            title: conv.title || anchorCid.slice(0, 8),
            isRunning: Boolean(conv.isRunning),
            stepCount: Number(conv.stepCount || 0),
            hasSubagents: false,
            agents: [],
            latestTokPerSec: conv.latestTokPerSec ?? null,
            latestTtftSec: conv.latestTtftSec ?? null,
            avgTokPerSec: conv.avgTokPerSec ?? null,
            latestStepCostUsd: conv.latestStepCostUsd ?? null,
            sessionCostUsd: conv.sessionCostUsd ?? null,
            latestCacheHitPct: conv.latestCacheHitPct ?? null,
            latestPromptTokens: conv.latestPromptTokens ?? 0,
            totalTokens: conv.totalTokens ?? 0,
            activeModelShort: selectedModel?.label || conv.modelShort || '',
            activeModelUpstream: selectedModel?.label || conv.modelUpstream || conv.modelShort || '',
            context: {
              ...(conv.contextBreakdown || conv.context || {}),
              totalTokens: ctxTotal,
              limitTokens: ctxLimit,
              compactionLimitTokens: ctxLimit,
              usedPct: ctxPct,
            },
          },
        };
      }
    } else if (telemetry && selectedModel && selectedModel.limitTokens > 0 && telemetry.activeConversation) {
      const ac = telemetry.activeConversation;
      const acCtx = ac.context || {};
      const ctxTotal = Math.max(0, Number(acCtx.totalTokens || 0));
      const ctxLimit = selectedModel.limitTokens;
      const ctxPct = Math.min(100, +((ctxTotal / ctxLimit) * 100).toFixed(2));
      hoverData = {
        ...telemetry,
        activeConversation: {
          ...ac,
          activeModelShort: ac.activeModelShort || selectedModel.label,
          context: {
            ...acCtx,
            totalTokens: ctxTotal,
            limitTokens: ctxLimit,
            compactionLimitTokens: ctxLimit,
            usedPct: ctxPct,
          },
        },
      };
    }
    hoverWidgetHost.update({
      moduleKeys: normalizeClientHoverModules(telemetry?.settings?.hoverModules),
      data: hoverData,
      minuteTick: Number(minuteTick || Math.floor(Date.now() / 30000)),
    });
  }

  // --- 4. / ---
  function renderCapsuleTelemetry() {
    if (disposed) return;
    const telSt = telemetryStore.getState();
    const uiSt = uiStore.getState();
    const telemetry = telSt.telemetry;

    setI18nLanguage(telemetry?.settings?.language);
    for (const s of getAllCapsuleSurfaces()) {
      applyAppearanceToRoot(s.capsuleHost, telemetry?.settings, { includeFontScale: false });
    }
    applyAppearanceToRoot(portalHost, telemetry?.settings, { includeFontScale: true });

    const showMulti = telemetry?.settings?.showTopbarMultiSession !== false;
    for (const s of getAllCapsuleSurfaces()) {
      patchAttr(s.multiBtn, 'hidden', !showMulti);
      patchAttr(s.capsuleHost, 'data-multi', showMulti ? 'on' : 'off');
    }
    if (!showMulti && multiOpen) {
      setMultiOpen(false);
    }

    const slotKeys = normalizeClientTopbarSlots(telemetry?.settings?.topbarCapsuleSlots);
    const layoutInputsChanged =
      showMulti !== lastShowMulti || slotKeys.length !== lastSlotCount;
    if (layoutInputsChanged) {
      lastShowMulti = showMulti;
      lastSlotCount = slotKeys.length;
      updateResponsiveLayout();
    }

    if (!telemetry) {
      for (const s of getAllCapsuleSurfaces()) {
        patchClasses(s.multiBtn, { 'is-running': false, 'is-waiting': false });
        patchText(s.multiLabel, t('capsule.multiZero'));
        syncCapsuleSlotNodes(s.capsuleSlots, s.capsuleSeps, slotKeys, { hasTelemetry: false });
      }
      patchText(multiRunningMetaEl, t('multi.loading'));
      stopMultiLiveTicker();
      return;
    }

    const { agents, scopedConv: overviewScopedConv, ctxAgent, aggregated } =
      resolveScopedConversation(telemetry, 'all', uiSt.ctxInspectorAgentId);
    const { scopedConv: capsuleScopedConv } = resolveScopedConversation(
      telemetry,
      uiSt.selectedAgentScope,
      uiSt.ctxInspectorAgentId
    );
    const activeConv = telemetry.activeConversation || {};
    const overviewActive = overviewScopedConv || activeConv;
    const ctx = ctxAgent?.context || overviewActive.context || activeConv.context || {};
    const limitTokens = Number(ctx.compactionLimitTokens || ctx.limitTokens || 256000);
    const totalTokens = Number(ctx.totalTokens || 0);
    const usedPct =
      limitTokens > 0 ? Math.min(100, +((totalTokens / limitTokens) * 100).toFixed(2)) : 0;
    const dashOffset = +(
      RING_CIRCUMFERENCE *
      (1 - Math.max(0, Math.min(100, usedPct)) / 100)
    ).toFixed(2);
    // --- 4a. ---
    const rawRunningList =
      Array.isArray(telemetry.runningConversations) && telemetry.runningConversations.length > 0
        ? telemetry.runningConversations
        : activeConv.isRunning || aggregated?.isRunning
          ? [
              {
                cascadeId: activeConv.cascadeId || 'current',
                title: activeConv.title || t('live.currentSession'),
                isCurrentSelected: true,
                isMainRunning: Boolean(activeConv.isRunning),
                isRunning: true,
                mainActivity: activeConv.liveActivity || aggregated?.liveActivity || null,
                subagentCount: Math.max(0, (agents?.length || 1) - 1),
                runningSubagentCount: (agents || []).filter((a) => !a.isMain && a.isRunning).length,
                latestTokPerSec: overviewActive.latestTokPerSec ?? null,
                contextUsedPct: usedPct,
                subagents: (agents || [])
                  .filter((a) => !a.isMain)
                  .map((s, idx) => ({
                    cascadeId: s.cascadeId || s.agentId,
                    index: s.index || idx + 1,
                    badgeText: s.badgeText || t('fmt.subBadge', { index: idx + 1 }),
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

    const runningCount = rawRunningList.length;
    const runningSubCount = rawRunningList.reduce(
      (acc, item) => acc + Number(item.runningSubagentCount || 0),
      0
    );
    const hasWaiting = rawRunningList.some((item) => item.mainActivity?.phase === 'waiting');

    const multiBtnText =
      runningCount > 0
        ? runningSubCount > 0
          ? t('capsule.multiRunningWithSubs', { count: runningCount, subs: runningSubCount })
          : t('capsule.multiRunning', { count: runningCount })
        : t('capsule.multiZero');
    for (const s of getAllCapsuleSurfaces()) {
      patchClasses(s.multiBtn, {
        'is-running': runningCount > 0 && !hasWaiting,
        'is-waiting': runningCount > 0 && hasWaiting,
      });
      patchText(s.multiLabel, multiBtnText);
    }

    renderMultiRunningPanel(rawRunningList, runningCount, runningSubCount, telSt.hostRouteConversationId);

    // --- 4b. 1..5 ---
    const isRunning = Boolean(aggregated?.isRunning || activeConv.isRunning);
    const capActive = capsuleScopedConv || aggregated || activeConv || {};
    const tps =
      capsuleScopedConv?.latestTokPerSec ??
      aggregated?.latestTokPerSec ??
      activeConv.latestTokPerSec ??
      null;
    const avgTps =
      capsuleScopedConv?.avgTokPerSec ??
      aggregated?.avgTokPerSec ??
      activeConv.avgTokPerSec ??
      null;
    const ttft =
      capsuleScopedConv?.latestTtftSec ??
      aggregated?.latestTtftSec ??
      activeConv.latestTtftSec ??
      null;
    const capsuleStepCost =
      capsuleScopedConv?.latestStepCostUsd ??
      aggregated?.latestStepCostUsd ??
      activeConv.latestStepCostUsd ??
      null;
    const sessionCost =
      capsuleScopedConv?.sessionCostUsd ??
      aggregated?.sessionCostUsd ??
      activeConv.sessionCostUsd ??
      null;
    const cacheHitPct =
      Number(capActive.stepCount || 0) > 0
        ? capActive.latestCacheHitPct ?? capActive.sessionCacheHitPct ?? null
        : null;
    const latestPromptTokens = capActive.latestPromptTokens ?? null;
    const capInTok = Math.max(0, Number(capActive.inputTokens || 0));
    const capCacheTok = Math.max(0, Number(capActive.cacheReadTokens || 0));
    const capOutTok = Math.max(0, Number(capActive.outputTokens || 0));
    const sessionTokens =
      Number(capActive.stepCount || 0) > 0 ||
      capActive.totalTokens != null ||
      capInTok + capCacheTok + capOutTok > 0
        ? Math.max(0, Number(capActive.totalTokens ?? capInTok + capCacheTok + capOutTok))
        : null;

    const activeSlotCtx = {
      hasTelemetry: true,
      context: ctx,
      usedPct,
      dashOffset,
      isRunning,
      tps,
      avgTps,
      ttft,
      stepCost: capsuleStepCost,
      sessionCost,
      cacheHitPct,
      latestPromptTokens,
      sessionTokens,
      quotas: telemetry.quotas,
      quotaDisplayMode: normalizeClientQuotaDisplayMode(telemetry.settings?.quotaDisplayMode),
      quotaCyclePhase,
    };
    for (const s of getAllCapsuleSurfaces()) {
      const sCtx = buildSlotContextForSurface(telemetry, s, activeSlotCtx);
      patchClasses(s.capsuleBtn, { 'is-running': Boolean(sCtx.isRunning) });
      syncCapsuleSlotNodes(s.capsuleSlots, s.capsuleSeps, slotKeys, sCtx);
    }

    const updateMode = normalizeClientUpdateMode(
      telemetry.settings?.pluginUpdateMode,
      telemetry.settings?.autoUpdatePlugin
    );
    const showUpdatePrompt =
      Boolean(telemetry.cloudStatus?.updateAvailable) && updateMode !== 'off';
    const latestVer = telemetry.cloudStatus?.latestPluginVersion || '';
    for (const s of getAllCapsuleSurfaces()) {
      patchAttr(s.updateDot, 'hidden', !showUpdatePrompt);
      patchAttr(s.topbarUpdateBtn, 'hidden', !showUpdatePrompt);
      if (showUpdatePrompt) {
        if (!isTopbarUpdating) {
          patchText(s.topbarUpdateLabel, latestVer ? `v${latestVer}` : t('capsule.newVersion'));
        }
        patchAttr(s.topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      }
    }
    patchAttr(hoverUpdateBar, 'hidden', !showUpdatePrompt);
    if (showUpdatePrompt) {
      patchText(
        hoverUpdateVerText,
        latestVer
          ? t('capsule.hoverNewVer', { ver: latestVer })
          : t('capsule.hoverNewVerGeneric')
      );
      const isComposerDock = getActiveAnchorSurface().capsuleHost.getAttribute('data-dock') === 'composer';
      patchText(
        hoverUpdateHintText,
        latestVer
          ? isComposerDock
            ? t('capsule.hoverUpdateHintComposer', { ver: latestVer })
            : t('capsule.hoverUpdateHintTopbar', { ver: latestVer })
          : isComposerDock
            ? t('capsule.hoverUpdateHintComposerGeneric')
            : t('capsule.hoverUpdateHintTopbarGeneric')
      );
    }
    if (showUpdatePrompt !== lastShowUpdate) {
      lastShowUpdate = showUpdatePrompt;
      updateResponsiveLayout();
    }

    // --- 0 ---
    const hoverModuleKeys = normalizeClientHoverModules(telemetry.settings?.hoverModules);
    patchAttr(hoverWidgetsContainer, 'hidden', hoverModuleKeys.length === 0);
    if (hoverModuleKeys.length === 0 && !showUpdatePrompt && tooltipOpen) {
      setTooltipOpen(false);
    }
    if (tooltipOpen) {
      renderHoverWidgets();
      positionFloatingElements();
    }
  }

  let lastAppliedMountMode = normalizeClientWindowMountMode(
    telemetryStore.getState().telemetry?.settings?.windowMountMode,
    telemetryStore.getState().telemetry?.settings?.enableWindowOverlay
  );
  let lastAppliedPermLeft = Boolean(
    telemetryStore.getState().telemetry?.settings?.moveComposerPermissionLeft
  );

  const unsubStore = telemetryStore.subscribe(
    (st) => ({
      syncState: st.syncState,
      telemetry: st.telemetry,
      minuteTick: st.minuteTick,
      selectedConversationId: st.selectedConversationId,
    }),
    (slice) => {
      const nextMountMode = normalizeClientWindowMountMode(
        slice.telemetry?.settings?.windowMountMode,
        slice.telemetry?.settings?.enableWindowOverlay
      );
      const nextPermLeft = Boolean(slice.telemetry?.settings?.moveComposerPermissionLeft);
      if (slice.telemetry?.settings?.enableWindowOverlay === false || nextMountMode === 'sidebar') {
        if (popoverOpen) setPopoverOpen(false);
        if (multiOpen) setMultiOpen(false);
      } else if (nextMountMode !== lastAppliedMountMode || nextPermLeft !== lastAppliedPermLeft) {
        lastAppliedMountMode = nextMountMode;
        lastAppliedPermLeft = nextPermLeft;
        ensureCapsuleDocked();
      }
      lastAppliedMountMode = nextMountMode;
      lastAppliedPermLeft = nextPermLeft;
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
      }
    }
  );

  const unsubUiScope = uiStore.subscribe(
    (st) => ({
      selectedAgentScope: st.selectedAgentScope,
      ctxInspectorAgentId: st.ctxInspectorAgentId,
      activeView: st.activeView,
      stepsSubTab: st.stepsSubTab,
      settingsSubTab: st.settingsSubTab,
      settingsStructureTab: st.settingsStructureTab,
    }),
    () => {
      renderCapsuleTelemetry();
      if (popoverOpen) {
        positionFloatingElements();
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!disposed && popoverOpen) {
              positionFloatingElements();
              refreshActiveViewScrollbars();
            }
          });
        }
      }
    }
  );

  const unsubI18n = i18nStore.subscribe(
    (st) => st.locale,
    () => {
      for (const s of getAllCapsuleSurfaces()) {
        patchAttr(s.multiBtn, 'aria-label', t('capsule.ariaMulti'));
        patchAttr(s.capsuleBtn, 'aria-label', t('capsule.ariaMonitor'));
        patchAttr(s.topbarUpdateBtn, 'aria-label', t('capsule.ariaUpdateTitle'));
        patchAttr(s.topbarUpdateBtn, 'title', t('capsule.ariaUpdateTitle'));
      }
      patchAttr(multiPanelEl, 'aria-label', t('multi.ariaDialog'));
      patchAttr(popoverEl, 'aria-label', t('capsule.ariaMonitor'));
      patchText(multiPinBadge, t('multi.pinned'));
      patchText(multiEmptyTextEl, t('multi.empty'));
      patchText(multiTitleTextEl, t('multi.title'));
      renderCapsuleTelemetry();
    }
  );

  // --- 5. ---
  function syncHostRouteIfChanged() {
    if (disposed) return;
    const currentRouteId = extractHostRouteCascadeId();
    if (currentRouteId === lastObservedRouteId) return;
    lastObservedRouteId = currentRouteId;
    const st = telemetryStore.getState();
    const patch = { hostRouteConversationId: currentRouteId };
    if (currentRouteId && st.selectedConversationId && st.selectedConversationId !== currentRouteId) {
      patch.selectedConversationId = '';
    }
    uiStore.setState({ selectedAgentScope: 'all', ctxInspectorAgentId: 'auto' });
    telemetryStore.setState(patch);
    void fetchTelemetry({ force: false });
  }

  const onDocMouseDown = (e) => {
    const insideAnyCapsule = getAllCapsuleSurfaces().some((s) => isEventInside(e, s.capsuleHost));
    if (popoverOpen && !isEventInside(e, popoverEl) && !insideAnyCapsule) {
      setPopoverOpen(false);
    }
    if (multiOpen && !isEventInside(e, multiPanelEl) && !insideAnyCapsule) {
      setMultiOpen(false);
    }
  };

  const onDocKeyDown = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      if (popoverOpen) {
        setPopoverOpen(false);
      }
      if (multiOpen) {
        setMultiOpen(false);
      }
    }
  };

  const onWindowPointerMove = (e) => recordPointerCoords(e);
  const onWindowBlur = () => {
    hasPointerCoords = false;
    if (tooltipOpen) {
      setTooltipOpen(false);
    }
    if (multiOpen && !multiPinned) {
      setMultiOpen(false);
    }
  };
  const onWindowResize = () => updateResponsiveLayout();
  const onPopState = () => syncHostRouteIfChanged();
  const onDocFocusIn = () => syncHostRouteIfChanged();
  const onVisibilityChange = () => {
    if (document.hidden) {
      uiStore.setState({ monitorVisible: false });
      pauseMultiLiveTicker();
      hasPointerCoords = false;
      if (tooltipOpen) {
        setTooltipOpen(false);
      }
      if (multiOpen && !multiPinned) {
        setMultiOpen(false);
      }
      return;
    }
    if (!document.hidden && !disposed) {
      uiStore.setState({ monitorVisible: popoverOpen });
      if (multiOpen) renderCapsuleTelemetry();
      syncHostRouteIfChanged();
      void fetchTelemetry({ force: false });
    }
  };

  let hostDomObserver = null;
  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout());
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined') {
      themeObserver = new MutationObserver(() => {
        syncWorkbenchThemeVars();
      });
      if (document.head) {
        themeObserver.observe(document.head, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      if (document.body) {
        hostDomObserver = new MutationObserver((records) => {
          if (
            Array.isArray(records) &&
            records.length > 0 &&
            records.every((r) => isAnyOverlayHostNode(r?.target))
          ) {
            return;
          }
          syncHostRouteIfChanged();
          if (!observedWorkbench) {
            ensureWorkbenchThemeObserved();
          }
          const dock = resolveRuntimeDockTarget();
          if (!isDockPlacementSynced(dock)) {
            scheduleDockSync();
          }
          scheduleSelectedModelSync();
        });
        hostDomObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-cascade-id', 'data-selected'],
        });
      }
    }
  } catch {
    
  }

  document.addEventListener?.('mousedown', onDocMouseDown, true);
  document.addEventListener?.('keydown', onDocKeyDown);
  document.addEventListener?.('focusin', onDocFocusIn);
  document.addEventListener?.('visibilitychange', onVisibilityChange);
  window.addEventListener?.('pointermove', onWindowPointerMove, { passive: true });
  window.addEventListener?.('blur', onWindowBlur);
  window.addEventListener?.('resize', onWindowResize);
  window.addEventListener?.('popstate', onPopState);
  navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);

  function scheduleSelectedModelSync() {
    if (disposed) return;
    if (selectedModelSyncTimer) clearTimeout(selectedModelSyncTimer);
    selectedModelSyncTimer = setTimeout(() => {
      selectedModelSyncTimer = null;
      if (disposed) return;
      const telemetry = telemetryStore.getState().telemetry;
      if (!telemetry) return;
      let changed = false;
      for (const s of getAllCapsuleSurfaces()) {
        const m = detectSelectedModelForSurface(s, telemetry);
        const sig = m ? `${m.groupId}:${m.limitTokens}` : '';
        if (s._lastDetectedModelSig !== sig) {
          s._lastDetectedModelSig = sig;
          changed = true;
        }
      }
      if (changed) {
        renderCapsuleTelemetry();
      }
    }, 120);
  }

  function startQuotaCycleTicker() {
    if (quotaCycleInterval) return;
    const CYCLE_HOLD_MS = 6000;
    quotaCycleInterval = setInterval(() => {
      if (disposed || tooltipOpen || popoverOpen) return;
      const reducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      if (reducedMotion) return;

      const surfaces = getAllCapsuleSurfaces();
      let hasCyclable = false;
      for (const s of surfaces) {
        for (const slot of s.capsuleSlots || []) {
          if (slot && slot.canCycle && !slot.el?.hasAttribute?.('hidden')) {
            hasCyclable = true;
            break;
          }
        }
        if (hasCyclable) break;
      }
      if (!hasCyclable) return;

      quotaCyclePhase = quotaCyclePhase === '5h' ? 'weekly' : '5h';
      renderCapsuleTelemetry();
    }, CYCLE_HOLD_MS);
  }

  startQuotaCycleTicker();

  const watchdogTimer = setInterval(() => {
    if (disposed) return;
    syncHostRouteIfChanged();
    ensureWorkbenchThemeObserved();
    scheduleSelectedModelSync();
    const dock = resolveRuntimeDockTarget();
    if (!isDockPlacementSynced(dock)) {
      ensureCapsuleDocked();
    }
  }, 1200);

  ensureCapsuleDocked();
  renderCapsuleTelemetry();
  const allowMultiCarryOver =
    telemetryStore.getState().telemetry?.settings?.showTopbarMultiSession !== false;
  if (carryOverPopoverOpen) {
    setPopoverOpen(true, { instant: true });
  } else if (carryOverMultiPinnedOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: true, instant: true });
  } else if (carryOverMultiHoverOpen && allowMultiCarryOver) {
    setMultiOpen(true, { pinned: false, instant: true });
  } else if (carryOverTooltipOpen) {
    setTooltipOpen(true, { instant: true });
  }
  const stopPolling = startAsyncTelemetryLoop(2000);

  const handle = {
    bundleVersion,
    ensureAlive() {
      if (disposed) return false;
      return ensureCapsuleDocked();
    },
    syncHostRoute() {
      if (disposed) return false;
      syncHostRouteIfChanged();
      return true;
    },
    updateBridge(nextBridge) {
      if (disposed || !nextBridge || typeof nextBridge !== 'object') return false;
      const port = Number(nextBridge.port || 0);
      const token = String(nextBridge.token || '');
      if (!Number.isInteger(port) || port <= 0 || !token) return false;
      const cur = window.__AGUsageMonitorBridge || {};
      const portChanged = Number(cur.port || 0) !== port || String(cur.token || '') !== token;
      cur.port = port;
      cur.token = token;
      if (portChanged) {
        cur.transportMode = 'http';
      }
      window.__AGUsageMonitorBridge = cur;
      void fetchTelemetry({ force: false });
      return true;
    },
    getTelemetrySnapshot() {
      return telemetryStore.getState().telemetry;
    },
    getLastPointer() {
      return hasPointerCoords ? { x: lastPointerX, y: lastPointerY } : null;
    },
    deliverRpc(responses) {
      if (disposed) return 0;
      return deliverCdpBridgeResponses(responses);
    },
    open() {
      setPopoverOpen(true);
    },
    close() {
      setPopoverOpen(false);
    },
    toggle() {
      setPopoverOpen(!popoverOpen);
    },
    openMulti(pinned = true) {
      setMultiOpen(true, { pinned: Boolean(pinned) });
    },
    closeMulti() {
      setMultiOpen(false);
    },
    isOpen: () => popoverOpen,
    isHoverOpen: () => tooltipOpen,
    isMultiOpen: () => multiOpen,
    isMultiHoverOpen: () => Boolean(multiOpen && !multiPinned),
    isMultiPinnedOpen: () => Boolean(multiOpen && multiPinned),
    getLayoutMode: () => layoutMode,
    getDockKind: () => String(capsuleHost.getAttribute('data-dock') || ''),
    getMountMode: () => lastAppliedMountMode,
    applyMountMode(nextMode) {
      if (disposed) return false;
      const normalized = normalizeClientWindowMountMode(nextMode, nextMode !== 'sidebar');
      if (typeof window !== 'undefined' && window.__AGUsageMonitorBridge) {
        window.__AGUsageMonitorBridge.mountMode = normalized;
      }
      const curTel = telemetryStore.getState().telemetry;
      if (curTel?.settings) {
        telemetryStore.setState({
          telemetry: {
            ...curTel,
            settings: {
              ...curTel.settings,
              windowMountMode: normalized,
              enableWindowOverlay: normalized !== 'sidebar',
            },
          },
        });
      }
      lastAppliedMountMode = normalized;
      return ensureCapsuleDocked();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdogTimer);
      if (quotaCycleInterval) {
        clearInterval(quotaCycleInterval);
        quotaCycleInterval = null;
      }
      if (quotaCycleFadeTimer) {
        clearTimeout(quotaCycleFadeTimer);
        quotaCycleFadeTimer = null;
      }
      if (selectedModelSyncTimer) {
        clearTimeout(selectedModelSyncTimer);
        selectedModelSyncTimer = null;
      }
      if (hoverLeaveTimer) {
        clearTimeout(hoverLeaveTimer);
        hoverLeaveTimer = null;
      }
      if (multiLeaveTimer) {
        clearTimeout(multiLeaveTimer);
        multiLeaveTimer = null;
      }
      stopMultiLiveTicker();
      if (dockRafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dockRafId);
        dockRafId = 0;
      }
      stopPolling();
      stopAsyncTelemetryLoop();
      unsubStore();
      unsubUiScope();
      unsubI18n();
      try {
        resizeObserver?.disconnect();
      } catch {}
      try {
        hostDomObserver?.disconnect();
      } catch {}
      try {
        themeObserver?.disconnect();
      } catch {}
      document.removeEventListener?.('mousedown', onDocMouseDown, true);
      document.removeEventListener?.('keydown', onDocKeyDown);
      document.removeEventListener?.('focusin', onDocFocusIn);
      document.removeEventListener?.('visibilitychange', onVisibilityChange);
      window.removeEventListener?.('pointermove', onWindowPointerMove);
      window.removeEventListener?.('blur', onWindowBlur);
      window.removeEventListener?.('resize', onWindowResize);
      window.removeEventListener?.('popstate', onPopState);
      navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
      restorePatchedActionToolbar();
      cancelCapsuleSlotAnimations(primarySurface.capsuleSlots);
      clearSurfaceComposerPermLayout(primarySurface);
      for (const [keyNode, surf] of [...splitCapsulesMap.entries()]) {
        disposeSecondarySplitSurface(keyNode, surf);
      }
      syncComposerLayoutStyleElement(false);
      try {
        hoverWidgetHost.destroy();
      } catch {}
      try {
        appInstance.destroy();
      } catch {}
      try {
        capsuleHost.remove();
      } catch {}
      try {
        portalHost.remove();
      } catch {}
      if (window.__AGUsageMonitorOverlay === handle) {
        delete window.__AGUsageMonitorOverlay;
      }
    },
  };

  window.__AGUsageMonitorOverlay = handle;
  return handle;
}
