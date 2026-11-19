/**
 * @fileoverview Preferences Tab 3: `SettingsOtherTab.js` (" ").
 * Houses Model Identifier Formatting, Per-Model Context Windows,
 * Local Trajectory Cache Rebuild, and Two-Step Factory Preference Reset.
 */

import { defineComponent } from '../../core/component.js';
import { h, patchAttr, patchClasses, patchText } from '../../core/domPatch.js';
import { createSvgIcon } from '../../icons/SvgIcon.js';
import { setI18nLanguage, t } from '../../i18n/index.js';
import {
  normalizeClientModelDisplayMode,
  normalizeClientOrchestratorIdMode,
  rebuildTrajectoryCache,
  resetAllSettings,
  saveModelContextWindow,
  saveSettingsPatch,
} from '../../store/telemetryStore.js';
import { CustomSelect } from '../../components/ui/CustomSelect.js';

function getStepModelDisplayOptions() {
  return [
    { value: 'short', label: t('settings.oth.modelShort') },
    { value: 'upstream', label: t('settings.oth.modelUpstream') },
    { value: 'upstream_compact', label: t('settings.oth.modelUpstreamCompact') },
  ];
}

function getOrchestratorIdDisplayOptions() {
  return [
    { value: 'compact', label: t('settings.oth.orchCompact') },
    { value: 'full', label: t('settings.oth.orchFull') },
  ];
}

export const SettingsOtherTab = defineComponent({
  name: 'SettingsOtherTab',
  setup({ onCleanup, getProps }) {
    let draftModelDisplayMode = 'short';
    let draftOrchestratorIdMode = 'compact';
    let draftContextRiskAccepted = false;
    let acceptingContextRisk = false;
    let latestSettings = null;
    let contextWindowModels = [];
    let discoveredModels = [];
    let contextModelId = '';
    let savingContextWindow = false;
    let contextFeedback = '';
    let modelTimer = null;
    let customPriceTimer = null;
    let maintTimer = null;
    let resetConfirmTimer = null;
    let resetConfirmArmed = false;
    let isRebuilding = false;
    let isResetting = false;

    const modelStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    const maintStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });

    function showModelFeedback(text, autoClearMs = 1500) {
      if (modelTimer) {
        clearTimeout(modelTimer);
        modelTimer = null;
      }
      patchText(modelStatusText, text);
      if (text && autoClearMs > 0) {
        modelTimer = setTimeout(() => {
          modelTimer = null;
          patchText(modelStatusText, '');
        }, autoClearMs);
      }
    }

    function showMaintFeedback(text, autoClearMs = 2500) {
      if (maintTimer) {
        clearTimeout(maintTimer);
        maintTimer = null;
      }
      patchText(maintStatusText, text);
      if (text && autoClearMs > 0) {
        maintTimer = setTimeout(() => {
          maintTimer = null;
          patchText(maintStatusText, '');
        }, autoClearMs);
      }
    }

    // --- Card 1: ---
    const modelCardTitleEl = h('span', { text: t('settings.oth.modelTitle') });
    const modelFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.modelFormat'),
    });
    const orchFormatLabelEl = h('span', {
      className: 'form-label',
      text: t('settings.oth.orchFormat'),
    });

    const stepModelSelect = CustomSelect({
      modelValue: 'short',
      icon: 'table',
      options: getStepModelDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientModelDisplayMode(val);
        draftModelDisplayMode = nextMode;
        stepModelSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({
            modelDisplayMode: nextMode,
            showUpstreamModel: nextMode !== 'short',
          });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const orchestratorIdSelect = CustomSelect({
      modelValue: 'compact',
      icon: 'layers',
      options: getOrchestratorIdDisplayOptions(),
      onUpdateModelValue: async (val) => {
        const nextMode = normalizeClientOrchestratorIdMode(val);
        draftOrchestratorIdMode = nextMode;
        orchestratorIdSelect.setValue(nextMode);
        showModelFeedback(t('settings.saving'), 0);
        try {
          await saveSettingsPatch({ orchestratorIdMode: nextMode });
          showModelFeedback(t('settings.saved'), 1500);
        } catch {
          if (latestSettings) renderSettings(latestSettings);
          showModelFeedback(t('settings.saveFailed'), 2500);
        }
      },
    });

    const modelPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          modelCardTitleEl,
        ]),
        modelStatusText,
      ]),
      h('div', { className: 'form-row' }, [modelFormatLabelEl, stepModelSelect.el]),
      h('div', { className: 'form-row' }, [orchFormatLabelEl, orchestratorIdSelect.el]),
    ]);

    // --- Card 2: ---
    const baselineTitleEl = h('span', { text: t('settings.oth.baselineTitle') });
    const ctxModelLabel = h('span', { className: 'form-label' });
    const ctxWindowLabel = h('span', { className: 'form-label' });
    const ctxHint = h('span', { className: 'settings-hint-text' });
    const ctxStatus = h('span', { className: 'text-muted', role: 'status' });
    const ctxModelSelect = CustomSelect({
      className: 'settings-context-model',
      options: [],
      onUpdateModelValue: (id) => {
        if (!draftContextRiskAccepted || savingContextWindow) return;
        contextModelId = id;
        contextFeedback = '';
        renderContextWindows();
      },
    });
    const ctxWindowSelect = CustomSelect({
      options: [],
      onUpdateModelValue: async (value) => {
        if (!draftContextRiskAccepted || savingContextWindow || !contextModelId) return;
        savingContextWindow = true;
        contextFeedback = 'settings.saving';
        renderContextWindows();
        try {
          const modelContextWindows = await saveModelContextWindow(contextModelId, value || null);
          latestSettings = { ...latestSettings, modelContextWindows };
          contextFeedback = 'settings.saved';
        } catch {
          contextFeedback = 'settings.saveFailed';
        } finally {
          savingContextWindow = false;
          renderContextWindows();
        }
      },
    });
    const ctxModelRow = h('div', { className: 'form-row' }, [ctxModelLabel, ctxModelSelect.el]);
    const ctxWindowRow = h('div', { className: 'form-row' }, [ctxWindowLabel, ctxWindowSelect.el]);
    const ctxControlsBody = h('div', { className: 'ctx-controls-body is-locked' }, [
      ctxModelRow,
      ctxWindowRow,
      h('div', { className: 'form-row' }, [ctxHint]),
    ]);

    const ctxRiskTitleEl = h('strong', {
      className: 'ctx-risk-title',
      text: t('settings.oth.ctxRiskTitle'),
    });
    const ctxRiskBodyEl = h('p', {
      className: 'ctx-risk-desc',
      text: t('settings.oth.ctxRiskBody'),
    });
    const ctxRiskAcceptBtnText = h('span', { text: t('settings.oth.ctxRiskAcceptBtn') });
    const ctxRiskAcceptBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary btn-danger-confirm ctx-risk-accept-btn',
        onClick: async () => {
          if (acceptingContextRisk || draftContextRiskAccepted) return;
          acceptingContextRisk = true;
          draftContextRiskAccepted = true;
          latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: true };
          contextFeedback = 'settings.saving';
          renderContextWindows();
          try {
            await saveSettingsPatch({ contextWindowRiskAccepted: true });
            contextFeedback = 'settings.saved';
          } catch {
            draftContextRiskAccepted = false;
            latestSettings = { ...(latestSettings || {}), contextWindowRiskAccepted: false };
            contextFeedback = 'settings.saveFailed';
          } finally {
            acceptingContextRisk = false;
            renderContextWindows();
          }
        },
      },
      [createSvgIcon('warning', { size: 12 }), ctxRiskAcceptBtnText]
    );
    const ctxRiskMask = h(
      'div',
      {
        className: 'ctx-risk-mask',
        role: 'region',
        'aria-label': t('settings.oth.ctxRiskTitle'),
      },
      [
        h('div', { className: 'ctx-risk-head' }, [
          createSvgIcon('warning', { size: 14, className: 'ctx-risk-icon' }),
          ctxRiskTitleEl,
        ]),
        ctxRiskBodyEl,
        ctxRiskAcceptBtn,
      ]
    );
    const ctxRiskStage = h('div', { className: 'ctx-risk-stage' }, [ctxControlsBody, ctxRiskMask]);

    function renderContextWindows() {
      const unlocked = Boolean(draftContextRiskAccepted);
      if (!unlocked) {
        ctxModelSelect.close();
        ctxWindowSelect.close();
      }
      patchClasses(ctxControlsBody, { 'is-locked': !unlocked });
      patchAttr(ctxControlsBody, 'inert', !unlocked);
      patchAttr(ctxControlsBody, 'aria-hidden', unlocked ? null : 'true');
      patchAttr(ctxRiskMask, 'hidden', unlocked);
      patchAttr(ctxRiskMask, 'aria-label', t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskTitleEl, t('settings.oth.ctxRiskTitle'));
      patchText(ctxRiskBodyEl, t('settings.oth.ctxRiskBody'));
      patchText(ctxRiskAcceptBtnText, t('settings.oth.ctxRiskAcceptBtn'));
      patchAttr(ctxRiskAcceptBtn, 'disabled', acceptingContextRisk);

      const saved = latestSettings?.modelContextWindows || {};
      const models = new Map(contextWindowModels.map((model) => [model.id, model]));
      const knownIds = new Set(contextWindowModels.flatMap(({ id, members = [] }) => [id, ...members]));
      for (const id of Object.keys(saved)) {
        if (!knownIds.has(id)) models.set(id, { id, label: id.replace(/^model:/, ''), options: [] });
      }
      if (!models.has(contextModelId)) contextModelId = '';
      const mixed = '\u0000mixed';
      const getSelection = ({ id, members = [] }) => {
        const legacy = new Set(members.map((member) => saved[member]).filter(Boolean));
        return saved[id] || (legacy.size > 1 ? mixed : legacy.values().next().value) || '';
      };
      const formatLimit = (value) => /^\d+$/.test(value) ? t('settings.oth.ctxTokens', { count: Number(value).toLocaleString() }) : value;
      const isAvailable = (model, value) => model.options.some(({ name }) => name === value) ||
        (/^[1-9]\d*$/.test(value) && Number(value) <= model.capacity);
      const current = models.get(contextModelId);
      const options = current?.options || [];
      const selected = current ? getSelection(current) : '';
      const choices = [
        { value: '', label: t('settings.oth.ctxDefault') },
        ...options.map(({ name, expensive, tokens }) => ({
          value: name,
          label: tokens ? formatLimit(name) :
            (expensive ? t('settings.oth.ctxExpensive', { name }) : name),
        })),
      ];
      if (selected && !choices.some((item) => item.value === selected)) {
        let label = t('settings.oth.ctxMixed');
        if (selected !== mixed) {
          const name = formatLimit(selected);
          label = isAvailable(current, selected) ? name : t('settings.oth.ctxUnavailable', { name });
        }
        choices.push({ value: selected, label, disabled: true });
      }
      ctxModelSelect.setProps({
        modelValue: contextModelId,
        options: [
          { value: '', label: t('settings.oth.ctxChooseModel') },
          ...[...models.values()].map((model) => {
            const value = getSelection(model);
            let meta = t('settings.oth.ctxDefault');
            if (value === mixed) meta = t('settings.oth.ctxMixed');
            else if (value) {
              const name = formatLimit(value);
              if (!isAvailable(model, value)) meta = t('settings.oth.ctxUnavailable', { name });
              else if (/^\d+$/.test(value) && model.reportedLimitTokens && Number(value) !== model.reportedLimitTokens) {
                meta = t('settings.oth.ctxConfiguredReported', {
                  name,
                  reported: formatLimit(String(model.reportedLimitTokens)),
                });
              } else meta = t('settings.oth.ctxConfigured', { name });
            }
            else if (model.reportedLimitTokens) meta = t('settings.oth.ctxDefaultReported', { name: formatLimit(String(model.reportedLimitTokens)) });
            return { value: model.id, label: model.label, meta };
          }),
        ],
      });
      ctxWindowSelect.setProps({ modelValue: selected, options: choices });
      patchAttr(ctxModelSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow);
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'disabled', !unlocked || savingContextWindow || (!options.length && !selected));
      patchAttr(ctxModelSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxModel'));
      patchAttr(ctxWindowSelect.refs.triggerBtn, 'aria-label', t('settings.oth.ctxBaselineLabel'));
      patchAttr(ctxModelRow, 'hidden', !models.size);
      patchAttr(ctxWindowRow, 'hidden', !contextModelId);
      patchText(ctxModelLabel, t('settings.oth.ctxModel'));
      patchText(ctxWindowLabel, t('settings.oth.ctxBaselineLabel'));
      const hint = !models.size ? 'ctxNoModels' : selected === mixed ? 'ctxMixedHint' :
        contextModelId && !options.length ? 'ctxNoOptions' : 'ctxBaselineHint';
      const reported = current?.reportedLimitTokens;
      patchText(ctxHint, [t(`settings.oth.${hint}`), reported &&
        t('settings.oth.ctxReported', { name: formatLimit(String(reported)) })].filter(Boolean).join(' '));
      patchText(ctxStatus, contextFeedback ? t(contextFeedback) : '');
      getProps().onLayoutChange?.();
    }

    const baselinePanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('layers', { size: 13 }),
          baselineTitleEl,
        ]),
        ctxStatus,
      ]),
      ctxRiskStage,
    ]);
    renderContextWindows();

    // --- Card 3: ---
    const maintTitleEl = h('span', { text: t('settings.oth.maintTitle') });
    const cacheLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.cacheLabel'),
    });
    const cacheDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.cacheDesc'),
    });

    const rebuildBtnText = h('span', { text: t('settings.oth.rebuildBtn') });
    const rebuildCacheBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isRebuilding) return;
          isRebuilding = true;
          patchAttr(rebuildCacheBtn, 'disabled', true);
          patchText(rebuildBtnText, t('settings.oth.rebuildingBtn'));
          showMaintFeedback(t('settings.oth.rebuildingBtn'), 0);
          try {
            const res = await rebuildTrajectoryCache();
            if (res?.ok !== false) {
              showMaintFeedback(t('settings.oth.rebuildDone'), 2800);
            } else {
              showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
            }
          } catch {
            showMaintFeedback(t('settings.oth.rebuildFailed'), 3000);
          } finally {
            isRebuilding = false;
            patchAttr(rebuildCacheBtn, 'disabled', false);
            patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
          }
        },
      },
      [createSvgIcon('refresh', { size: 12 }), rebuildBtnText]
    );

    const resetLabelEl = h('span', {
      className: 'settings-action-title',
      text: t('settings.oth.resetLabel'),
    });
    const resetDescEl = h('span', {
      className: 'settings-action-desc',
      text: t('settings.oth.resetDesc'),
    });

    const resetBtnText = h('span', { text: t('settings.oth.resetAllBtn') });

    function disarmResetConfirm() {
      resetConfirmArmed = false;
      if (resetConfirmTimer) {
        clearTimeout(resetConfirmTimer);
        resetConfirmTimer = null;
      }
      patchClasses(resetAllBtn, { 'btn-danger-confirm': false });
      if (!isResetting) {
        patchText(resetBtnText, t('settings.oth.resetAllBtn'));
      }
    }

    const resetAllBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          if (isResetting) return;
          if (!resetConfirmArmed) {
            resetConfirmArmed = true;
            patchClasses(resetAllBtn, { 'btn-danger-confirm': true });
            patchText(resetBtnText, t('settings.oth.resetConfirmBtn'));
            if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
            resetConfirmTimer = setTimeout(() => {
              disarmResetConfirm();
            }, 3000);
            return;
          }

          disarmResetConfirm();
          isResetting = true;
          patchAttr(resetAllBtn, 'disabled', true);
          patchText(resetBtnText, t('settings.oth.resettingBtn'));
          showMaintFeedback(t('settings.oth.resettingBtn'), 0);
          try {
            const res = await resetAllSettings();
            setI18nLanguage(res?.settings?.language || 'th-TH');
            showMaintFeedback(t('settings.oth.resetAllDone'), 2800);
          } catch {
            showMaintFeedback(t('settings.saveFailed'), 2800);
          } finally {
            isResetting = false;
            patchAttr(resetAllBtn, 'disabled', false);
            patchText(resetBtnText, t('settings.oth.resetAllBtn'));
          }
        },
      },
      [resetBtnText]
    );

    const maintPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('refresh', { size: 13 }),
          maintTitleEl,
        ]),
        maintStatusText,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [cacheLabelEl, cacheDescEl]),
        rebuildCacheBtn,
      ]),
      h('div', { className: 'settings-action-block' }, [
        h('div', { className: 'settings-action-info' }, [resetLabelEl, resetDescEl]),
        resetAllBtn,
      ]),
    ]);

    // --- Card 4: Custom Offline Model Pricing (Future-Model Ready) ---
    const customPriceTitleEl = h('span', { text: t('settings.oth.customPriceTitle') });
    const customPriceHintEl = h('span', {
      className: 'settings-hint-text',
      text: t('settings.oth.customPriceHint'),
    });
    const customPriceStatusText = h('span', {
      className: 'text-muted',
      style: 'font-size: var(--fs-md);',
      text: '',
    });
    function showCustomPriceFeedback(text, autoClearMs = 2000) {
      if (customPriceTimer) {
        clearTimeout(customPriceTimer);
        customPriceTimer = null;
      }
      patchText(customPriceStatusText, text);
      if (text && autoClearMs > 0) {
        customPriceTimer = setTimeout(() => {
          customPriceTimer = null;
          patchText(customPriceStatusText, '');
        }, autoClearMs);
      }
    }

    const cpModelIdLabel = h('span', { className: 'form-label', text: t('settings.oth.customPriceModelId') });
    const cpShortLabel = h('span', { className: 'form-label', text: t('settings.oth.customPriceShort') });
    const cpFamilyLabel = h('span', { className: 'form-label', text: t('settings.oth.customPriceFamily') });
    const cpInLabel = h('span', { className: 'form-label', text: t('settings.oth.customPriceIn') });
    const cpCacheLabel = h('span', { className: 'form-label', text: t('settings.oth.customPriceCache') });
    const cpOutLabel = h('span', { className: 'form-label', text: t('settings.oth.customPriceOut') });

    const cpModelIdInput = h('input', {
      type: 'text',
      className: 'custom-price-input text-mono',
      placeholder: 'gemini-5-pro / MODEL_PLACEHOLDER_...',
    });
    const cpShortInput = h('input', {
      type: 'text',
      className: 'custom-price-input',
      placeholder: 'Gemini 5 Pro',
    });
    let cpFamilyValue = 'Gemini';
    const cpFamilySelect = CustomSelect({
      modelValue: 'Gemini',
      options: [
        { value: 'Gemini', label: 'Gemini' },
        { value: 'Claude', label: 'Claude' },
        { value: 'GPT', label: 'GPT' },
        { value: 'Other', label: 'Other' },
      ],
      onUpdateModelValue: (val) => {
        cpFamilyValue = val || 'Other';
        cpFamilySelect.setValue(cpFamilyValue);
      },
    });
    const cpInInput = h('input', { type: 'number', min: '0', step: '0.01', className: 'custom-price-input text-mono', placeholder: '1.25' });
    const cpCacheInput = h('input', { type: 'number', min: '0', step: '0.01', className: 'custom-price-input text-mono', placeholder: '0.125' });
    const cpOutInput = h('input', { type: 'number', min: '0', step: '0.01', className: 'custom-price-input text-mono', placeholder: '10.00' });

    const cpSaveBtnText = h('span', { text: t('settings.oth.customPriceSave') });
    const cpSaveBtn = h(
      'button',
      {
        type: 'button',
        className: 'btn-secondary',
        onClick: async () => {
          const key = String(cpModelIdInput.value || '').trim();
          const inVal = Number(cpInInput.value);
          const cacheVal = cpCacheInput.value === '' ? +(inVal * 0.1).toFixed(4) : Number(cpCacheInput.value);
          const outVal = Number(cpOutInput.value);
          if (
            !key ||
            !Number.isFinite(inVal) || inVal < 0 ||
            !Number.isFinite(cacheVal) || cacheVal < 0 ||
            !Number.isFinite(outVal) || outVal < 0
          ) {
            showCustomPriceFeedback(t('settings.oth.customPriceInvalid'), 2500);
            return;
          }
          const nextMap = {
            ...(latestSettings?.customModelPricing || {}),
            [key]: {
              input: +inVal.toFixed(6),
              cache: +cacheVal.toFixed(6),
              output: +outVal.toFixed(6),
              short: String(cpShortInput.value || '').trim() || key,
              family: cpFamilyValue || 'Other',
            },
          };
          showCustomPriceFeedback(t('settings.saving'), 0);
          try {
            await saveSettingsPatch({ customModelPricing: nextMap });
            latestSettings = { ...(latestSettings || {}), customModelPricing: nextMap };
            cpModelIdInput.value = '';
            cpShortInput.value = '';
            cpInInput.value = '';
            cpCacheInput.value = '';
            cpOutInput.value = '';
            renderCustomPricing();
            showCustomPriceFeedback(t('settings.saved'), 1800);
          } catch {
            showCustomPriceFeedback(t('settings.saveFailed'), 2500);
          }
        },
      },
      [cpSaveBtnText]
    );

    const cpDetectedHeader = h('span', { className: 'form-label' });
    const cpDetectedList = h('div', { className: 'custom-price-list' });
    const cpSavedHeader = h('span', { className: 'form-label' });
    const cpSavedList = h('div', { className: 'custom-price-list' });

    function fillCustomPriceForm({ modelId = '', shortName = '', family = 'Other', pricing = null }) {
      cpModelIdInput.value = modelId;
      cpShortInput.value = shortName || modelId;
      cpFamilyValue = ['Gemini', 'Claude', 'GPT', 'Other'].includes(family) ? family : 'Other';
      cpFamilySelect.setValue(cpFamilyValue);
      cpInInput.value = pricing?.input != null ? String(pricing.input) : '';
      cpCacheInput.value = pricing?.cache != null ? String(pricing.cache) : '';
      cpOutInput.value = pricing?.output != null ? String(pricing.output) : '';
      cpInInput.focus?.();
    }

    function replaceNodeChildren(parent, nodes) {
      while (parent.firstChild) parent.removeChild(parent.firstChild);
      for (const node of nodes) {
        if (node) parent.appendChild(node);
      }
    }

    function renderCustomPricing() {
      const unpriced = (discoveredModels || []).filter((m) => m && !m.pricing);
      patchText(
        cpDetectedHeader,
        unpriced.length > 0
          ? t('settings.oth.customPriceDetected', { count: unpriced.length })
          : t('settings.oth.customPriceAllPriced')
      );
      replaceNodeChildren(
        cpDetectedList,
        unpriced.map((m) =>
          h('div', { className: 'custom-price-row' }, [
            h('div', { className: 'custom-price-row-info' }, [
              h('span', { className: 'custom-price-row-title', text: m.label || m.modelId }),
              h('span', {
                className: 'custom-price-row-meta text-mono',
                text: `${m.modelId} · ${m.family || 'Other'}`,
              }),
            ]),
            h('div', { className: 'custom-price-row-actions' }, [
              h(
                'button',
                {
                  type: 'button',
                  className: 'btn-secondary custom-price-mini-btn',
                  text: t('settings.oth.customPriceConfigure'),
                  onClick: () => fillCustomPriceForm(m),
                }
              ),
            ]),
          ])
        )
      );

      const savedEntries = Object.entries(latestSettings?.customModelPricing || {});
      patchText(cpSavedHeader, t('settings.oth.customPriceSavedList', { count: savedEntries.length }));
      if (savedEntries.length === 0) {
        replaceNodeChildren(cpSavedList, [
          h('span', { className: 'settings-hint-text', text: t('settings.oth.customPriceEmpty') }),
        ]);
      } else {
        replaceNodeChildren(
          cpSavedList,
          savedEntries.map(([id, p]) =>
            h('div', { className: 'custom-price-row' }, [
              h('div', { className: 'custom-price-row-info' }, [
                h('span', { className: 'custom-price-row-title', text: `${p.short || id} (${id})` }),
                h('span', {
                  className: 'custom-price-row-meta text-mono',
                  text: `In $${p.input} · Cache $${p.cache} · Out $${p.output} / 1M · ${p.family || 'Other'}`,
                }),
              ]),
              h('div', { className: 'custom-price-row-actions' }, [
                h('button', {
                  type: 'button',
                  className: 'btn-secondary custom-price-mini-btn',
                  text: t('settings.oth.customPriceEdit'),
                  onClick: () =>
                    fillCustomPriceForm({ modelId: id, shortName: p.short || id, family: p.family, pricing: p }),
                }),
                h('button', {
                  type: 'button',
                  className: 'btn-secondary custom-price-mini-btn',
                  text: t('settings.oth.customPriceDelete'),
                  onClick: async () => {
                    const nextMap = { ...(latestSettings?.customModelPricing || {}) };
                    delete nextMap[id];
                    showCustomPriceFeedback(t('settings.saving'), 0);
                    try {
                      await saveSettingsPatch({ customModelPricing: nextMap });
                      latestSettings = { ...(latestSettings || {}), customModelPricing: nextMap };
                      renderCustomPricing();
                      showCustomPriceFeedback(t('settings.saved'), 1500);
                    } catch {
                      showCustomPriceFeedback(t('settings.saveFailed'), 2500);
                    }
                  },
                }),
              ]),
            ])
          )
        );
      }
      getProps()?.onLayoutChange?.();
    }

    const customPricingPanel = h('section', { className: 'panel' }, [
      h('div', { className: 'panel-header' }, [
        h('span', { className: 'panel-title' }, [
          createSvgIcon('sliders', { size: 13 }),
          customPriceTitleEl,
        ]),
        customPriceStatusText,
      ]),
      customPriceHintEl,
      h('div', { className: 'form-row' }, [cpDetectedHeader, cpDetectedList]),
      h('div', { className: 'custom-price-grid' }, [
        h('div', { className: 'custom-price-field' }, [cpModelIdLabel, cpModelIdInput]),
        h('div', { className: 'custom-price-field' }, [cpShortLabel, cpShortInput]),
      ]),
      h('div', { className: 'form-row' }, [cpFamilyLabel, cpFamilySelect.el]),
      h('div', { className: 'custom-price-rates-grid' }, [
        h('div', { className: 'custom-price-field' }, [cpInLabel, cpInInput]),
        h('div', { className: 'custom-price-field' }, [cpCacheLabel, cpCacheInput]),
        h('div', { className: 'custom-price-field' }, [cpOutLabel, cpOutInput]),
      ]),
      h('div', { className: 'form-row' }, [cpSaveBtn]),
      h('div', { className: 'form-row' }, [cpSavedHeader, cpSavedList]),
    ]);

    const rootEl = h('div', { className: 'settings-tab-stack' }, [
      modelPanel,
      customPricingPanel,
      baselinePanel,
      maintPanel,
    ]);

    function renderSettings(settings, models = contextWindowModels, discovered = discoveredModels) {
      if (!settings) return;
      latestSettings = settings;
      contextWindowModels = models;
      discoveredModels = Array.isArray(discovered) ? discovered : [];
      draftModelDisplayMode = normalizeClientModelDisplayMode(
        settings.modelDisplayMode,
        settings.showUpstreamModel
      );
      draftOrchestratorIdMode = normalizeClientOrchestratorIdMode(settings.orchestratorIdMode);
      if (!acceptingContextRisk) {
        draftContextRiskAccepted = Boolean(settings.contextWindowRiskAccepted);
      }
      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
      renderContextWindows();
      renderCustomPricing();
    }

    function refreshLabels() {
      patchText(modelCardTitleEl, t('settings.oth.modelTitle'));
      patchText(modelFormatLabelEl, t('settings.oth.modelFormat'));
      patchText(orchFormatLabelEl, t('settings.oth.orchFormat'));
      patchText(customPriceTitleEl, t('settings.oth.customPriceTitle'));
      patchText(customPriceHintEl, t('settings.oth.customPriceHint'));
      patchText(cpModelIdLabel, t('settings.oth.customPriceModelId'));
      patchText(cpShortLabel, t('settings.oth.customPriceShort'));
      patchText(cpFamilyLabel, t('settings.oth.customPriceFamily'));
      patchText(cpInLabel, t('settings.oth.customPriceIn'));
      patchText(cpCacheLabel, t('settings.oth.customPriceCache'));
      patchText(cpOutLabel, t('settings.oth.customPriceOut'));
      patchText(cpSaveBtnText, t('settings.oth.customPriceSave'));
      renderCustomPricing();
      patchText(baselineTitleEl, t('settings.oth.baselineTitle'));
      renderContextWindows();
      patchText(maintTitleEl, t('settings.oth.maintTitle'));
      patchText(cacheLabelEl, t('settings.oth.cacheLabel'));
      patchText(cacheDescEl, t('settings.oth.cacheDesc'));
      patchText(resetLabelEl, t('settings.oth.resetLabel'));
      patchText(resetDescEl, t('settings.oth.resetDesc'));

      if (!isRebuilding) {
        patchText(rebuildBtnText, t('settings.oth.rebuildBtn'));
      }
      if (!isResetting) {
        patchText(
          resetBtnText,
          resetConfirmArmed ? t('settings.oth.resetConfirmBtn') : t('settings.oth.resetAllBtn')
        );
      }

      stepModelSelect.setProps({
        modelValue: draftModelDisplayMode,
        options: getStepModelDisplayOptions(),
      });
      orchestratorIdSelect.setProps({
        modelValue: draftOrchestratorIdMode,
        options: getOrchestratorIdDisplayOptions(),
      });
    }

    onCleanup(() => {
      if (modelTimer) clearTimeout(modelTimer);
      if (customPriceTimer) clearTimeout(customPriceTimer);
      if (maintTimer) clearTimeout(maintTimer);
      if (resetConfirmTimer) clearTimeout(resetConfirmTimer);
      stepModelSelect.destroy();
      orchestratorIdSelect.destroy();
      cpFamilySelect.destroy();
      ctxModelSelect.destroy();
      ctxWindowSelect.destroy();
    });

    return {
      el: rootEl,
      refs: {
        stepModelSelect,
        orchestratorIdSelect,
        ctxModelSelect,
        ctxWindowSelect,
        rebuildCacheBtn,
        resetAllBtn,
        renderSettings,
        refreshLabels,
      },
    };
  },
});
