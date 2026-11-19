/**
 * @fileoverview Reactive lightweight i18n engine (`th-TH` / `en-US` / `auto`).
 * Default language is `'th-TH'`.
 */

import { createReactiveStore } from '../core/reactive.js';
import { I18N_MESSAGES_EN_US } from './en-US.js';
import { I18N_MESSAGES_TH_TH } from './th-TH.js';

export const I18N_DICTIONARIES = Object.freeze({
  'th-TH': I18N_MESSAGES_TH_TH,
  'en-US': I18N_MESSAGES_EN_US,
});

export function normalizeI18nLanguage(raw) {
  const val = String(raw ?? '').trim();
  if (val === 'auto') return 'auto';
  if (/^en(?:-|$)/i.test(val)) return 'en-US';
  return 'th-TH';
}

export function detectHostSystemLocale() {
  try {
    if (typeof navigator !== 'undefined' && navigator.language) {
      const lang = String(navigator.language).toLowerCase();
      if (lang.startsWith('en')) return 'en-US';
      return 'th-TH';
    }
  } catch {
    // Ignore environment navigator read errors
  }
  return 'th-TH';
}

export const i18nStore = createReactiveStore({
  language: 'th-TH',
  locale: 'th-TH',
});

export function setI18nLanguage(rawLang) {
  const language = normalizeI18nLanguage(rawLang);
  const locale = language === 'auto' ? detectHostSystemLocale() : language;
  const cur = i18nStore.getState();
  if (cur.language !== language || cur.locale !== locale) {
    i18nStore.setState({ language, locale });
  }
  return locale;
}

export function getEffectiveLocale() {
  return i18nStore.getState().locale || 'th-TH';
}

export function isThaiLocale() {
  return getEffectiveLocale() === 'th-TH';
}

export function isEnglishLocale() {
  return getEffectiveLocale() === 'en-US';
}

const LIVE_ACTIVITY_LABELS = Object.freeze({
  Thinking: { th: 'กำลังคิด', en: 'Thinking' },
  Responding: { th: 'กำลังพิมพ์คำตอบ', en: 'Responding' },
  'Running command': { th: 'กำลังรันคำสั่ง', en: 'Running command' },
  'Reading file': { th: 'กำลังอ่านไฟล์', en: 'Reading file' },
  'Editing file': { th: 'กำลังแก้ไขไฟล์', en: 'Editing file' },
  'Writing file': { th: 'กำลังเขียนไฟล์', en: 'Writing file' },
  'Searching code': { th: 'กำลังค้นหาโค้ด', en: 'Searching code' },
  'Finding files': { th: 'กำลังค้นหาไฟล์', en: 'Finding files' },
  'Reading webpage': { th: 'กำลังอ่านหน้าเว็บ', en: 'Reading webpage' },
  'Searching web': { th: 'กำลังค้นหาเว็บ', en: 'Searching web' },
  'Invoking subagent': { th: 'กำลังเรียก Subagent', en: 'Invoking subagent' },
  'Messaging subagent': { th: 'กำลังคุยกับ Subagent', en: 'Messaging subagent' },
  'Managing subagents': { th: 'กำลังจัดการ Subagent', en: 'Managing subagents' },
  'Background task': { th: 'งานเบื้องหลัง', en: 'Background task' },
  'Scheduled task': { th: 'งานตั้งเวลา', en: 'Scheduled task' },
  'Waiting for user choice': { th: 'รอผู้ใช้เลือก', en: 'Waiting for user choice' },
  'Searching marketplace': { th: 'กำลังค้นหา Marketplace', en: 'Searching marketplace' },
  'Calling MCP tool': { th: 'กำลังเรียก MCP', en: 'Calling MCP tool' },
  'Running tool': { th: 'กำลังรัน Tool', en: 'Running tool' },
  'Compacting context': { th: 'กำลังทำ Compact Context', en: 'Compacting context' },
  'Compaction done, resuming': { th: 'Compact เสร็จแล้ว กำลังคิดต่อ', en: 'Compaction done, resuming' },
  Done: { th: 'เสร็จแล้ว', en: 'Done' },
  Starting: { th: 'กำลังเริ่มต้น', en: 'Starting' },
  'Waiting for subagent': { th: 'รอ Subagent ทำงาน', en: 'Waiting for subagent' },
});

export function translateLiveActivityText(rawText) {
  const text = String(rawText ?? '');
  if (!text) return '';
  const locale = getEffectiveLocale();
  const langKey = locale === 'en-US' ? 'en' : 'th';
  if (text.startsWith('Waiting approval · ')) {
    const inner = text.slice('Waiting approval · '.length);
    const prefix = langKey === 'en' ? 'Waiting approval · ' : 'รอยืนยัน · ';
    const mappedInner = LIVE_ACTIVITY_LABELS[inner]?.[langKey] || inner;
    return `${prefix}${mappedInner}`;
  }
  return LIVE_ACTIVITY_LABELS[text]?.[langKey] || text;
}

/**
 * Translate a message key with optional `{name}` variable interpolation.
 *
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @returns {string}
 */
export function t(key, vars = undefined) {
  const locale = getEffectiveLocale();
  const dict = I18N_DICTIONARIES[locale] || I18N_MESSAGES_TH_TH;
  const template = dict[key] ?? I18N_MESSAGES_TH_TH[key] ?? I18N_MESSAGES_EN_US[key] ?? key;
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''
  );
}
