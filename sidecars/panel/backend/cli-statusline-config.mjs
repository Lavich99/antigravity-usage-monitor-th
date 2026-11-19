/**
 * @fileoverview Antigravity CLI (`agy`) (`statusLine`) ANSI 
 *
 * 
 * 1. `~/.gemini/antigravity-cli/settings.json` `statusLine` 
 * - `~/.gemini/antigravity-cli` 
 * - `statusLine.command` `cli-statusline.mjs` 
 * - `stack_with_default: false` `? for shortcuts` `auto · Model · effort` 
 * 2. 13 `TOPBAR_SLOT_KEYS` Windows `cmd.exe` (CP936) /
 * PowerShell / Windows Terminal / macOS / Linux 24-bit ANSI CSI SGR 
 * OSC Bubble Tea 
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HERE,
  lsRuntimeEndpoint,
  normalizeLanguageSetting,
  normalizeQuotaDisplayMode,
  normalizeTopbarCapsuleSlots,
} from './config.mjs';

const CLI_STATUS_THIRD_PARTY_FAMILY_RE = /claude|gpt|anthropic|openai|3p|sonnet|opus|haiku/i;

// 24-bit ANSI SGR CLI SGR
const SGR_RESET = '\x1b[0m';
const SGR_BOLD = '\x1b[1m';
const SGR_FG_BRIGHT = '\x1b[38;2;226;232;240m';
const SGR_FG_NORMAL = '\x1b[38;2;203;213;225m';
const SGR_FG_MUTED = '\x1b[38;2;148;163;184m';
const SGR_FG_DIM = '\x1b[38;2;120;133;155m';
const SGR_FG_CHROME = '\x1b[38;2;136;142;150m';
const SGR_FG_SEP = '\x1b[38;2;90;100;116m';
const SGR_FG_DOT_IDLE = '\x1b[38;2;100;116;139m';
const SGR_FG_ACCENT = '\x1b[38;2;96;165;250m';
const SGR_FG_GOOD = '\x1b[38;2;52;211;153m';
const SGR_FG_INFO = '\x1b[38;2;56;189;248m';
const SGR_FG_WARN = '\x1b[38;2;251;191;36m';
const SGR_FG_DANGER = '\x1b[38;2;248;113;113m';
const SGR_FG_MODE_AUTO = '\x1b[38;2;234;179;8m';
const SGR_FG_MODE_VIOLET = '\x1b[38;2;192;132;252m';

function isCliStatusPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * `~/.gemini/antigravity-cli/settings.json` `ANTIGRAVITY_GEMINI_DIR` 
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [homeDir=homedir()]
 * @returns {string}
 */
export function resolveCliSettingsPath(env = process.env, homeDir = homedir()) {
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  return join(geminiBase, 'antigravity-cli', 'settings.json');
}

/**
 * `cli-statusline.mjs` `HERE` 
 *
 * @param {{ env?: Record<string, string|undefined>, homeDir?: string, fallbackHere?: string }} [options]
 * @returns {string}
 */
export function resolvePreferredCliStatusLineScriptPath({
  env = process.env,
  homeDir = homedir(),
  fallbackHere = HERE,
} = {}) {
  const geminiBase = String(env?.ANTIGRAVITY_GEMINI_DIR || '').trim() || join(homeDir, '.gemini');
  const installedCandidate = join(
    geminiBase,
    'config',
    'plugins',
    'usage-monitor',
    'sidecars',
    'panel',
    'cli-statusline.mjs'
  );
  if (existsSync(installedCandidate)) {
    return installedCandidate;
  }
  return join(fallbackHere, 'cli-statusline.mjs');
}

/**
 * `PATH` `node` 
 *
 * @param {Record<string, string|undefined>} [env=process.env]
 * @param {string} [platform=process.platform]
 * @returns {boolean}
 */
export function detectNodeOnSystemPath(env = process.env, platform = process.platform) {
  const rawPath = String(env?.PATH || env?.Path || env?.path || '').trim();
  if (!rawPath) return false;
  const binNames = platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  const sep = platform === 'win32' ? ';' : delimiter;
  for (const rawDir of rawPath.split(sep)) {
    const cleanDir = rawDir.trim().replace(/^"+|"+$/g, '');
    if (!cleanDir) continue;
    for (const bin of binNames) {
      try {
        if (existsSync(join(cleanDir, bin))) return true;
      } catch {
        
      }
    }
  }
  return false;
}

function toPercentEncodedFileUrl(winOrPosixPath) {
  const clean = String(winOrPosixPath || '').trim().replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(clean)) {
    const encoded = clean
      .split('/')
      .map((seg, idx) => (idx === 0 ? seg : encodeURIComponent(seg)))
      .join('/');
    return `file:///${encoded}#autorun`;
  }
  try {
    return `${pathToFileURL(clean).href}#autorun`;
  } catch {
    return `file://${encodeURI(clean)}#autorun`;
  }
}

/**
 * `statusLine.command` 
 * - Windows `agy.exe` Go `exec.Command("cmd", "/c", command)` Go `syscall.EscapeArg`
 * `command` `"` `\"` `cmd.exe` `\"` `node.exe` 
 * `argv[1]` Windows `command` `"` 
 * - `node C:/.../cli-statusline.mjs` 
 * - `node --input-type=module -e import('file:///C:/...%20.../cli-statusline.mjs#autorun')` 
 * - macOS / Linux `sh -c` 
 *
 * @param {string} scriptPath
 * @param {{ platform?: string, execPath?: string, nodeOnPath?: boolean }} [options]
 * @returns {string}
 */
export function buildCliStatusLineCommand(
  scriptPath,
  {
    platform = process.platform,
    execPath = process.execPath,
    nodeOnPath = true,
  } = {}
) {
  const normScript = String(scriptPath || '').trim().replace(/\\/g, '/');
  if (platform === 'win32') {
    const normExec = String(execPath || 'node').trim().replace(/\\/g, '/');
    const runner = nodeOnPath || /\s/.test(normExec) ? 'node' : normExec;
    if (!/\s/.test(normScript)) {
      return `${runner} ${normScript}`;
    }
    const fileUrl = toPercentEncodedFileUrl(normScript).replace(/'/g, '%27');
    return `${runner} --input-type=module -e import('${fileUrl}')`;
  }
  if (nodeOnPath) {
    return `node "${normScript.replace(/"/g, '\\"')}"`;
  }
  const escapedExec = String(execPath || 'node').replace(/"/g, '\\"');
  const escapedScript = normScript.replace(/"/g, '\\"');
  return `"${escapedExec}" "${escapedScript}"`;
}

/**
 * `statusLine.command` `cli-statusline.mjs` 
 *
 * @param {unknown} cmd
 * @returns {boolean}
 */
export function isManagedCliStatusLineCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  return /(?:^|[\\/\s"'])cli-statusline\.mjs(?:#autorun)?(?:["')\s]|$)/i.test(trimmed);
}

/**
 * `statusLine` 
 *
 * @param {unknown} rawObj
 * @param {{ enabled?: boolean, command?: string, stackWithDefault?: boolean }} [options]
 */
export function applyCliStatusLineToSettingsObject(
  rawObj,
  { enabled = true, command = '', stackWithDefault = false } = {}
) {
  const baseObj = isCliStatusPlainObject(rawObj) ? rawObj : {};
  const existing = baseObj.statusLine;

  if (isCliStatusPlainObject(existing)) {
    const existingCmd = typeof existing.command === 'string' ? existing.command.trim() : '';
    if (existingCmd && !isManagedCliStatusLineCommand(existingCmd)) {
      return {
        changed: false,
        preservedCustom: true,
        reason: 'custom_command_preserved',
        object: baseObj,
      };
    }
  } else if (existing !== undefined && existing !== null) {
    return {
      changed: false,
      preservedCustom: true,
      reason: 'custom_statusline_preserved',
      object: baseObj,
    };
  }

  if (!enabled) {
    if (!Object.prototype.hasOwnProperty.call(baseObj, 'statusLine')) {
      return {
        changed: false,
        alreadyRemoved: true,
        object: baseObj,
      };
    }
    const nextObj = { ...baseObj };
    delete nextObj.statusLine;
    return {
      changed: true,
      removed: true,
      object: nextObj,
    };
  }

  const cleanCmd = String(command || '').trim();
  if (!cleanCmd) {
    return {
      changed: false,
      reason: 'empty_command',
      object: baseObj,
    };
  }

  const prevBlock = isCliStatusPlainObject(existing) ? existing : {};
  const desiredPadding =
    Number.isInteger(prevBlock.padding) && prevBlock.padding >= 0 ? prevBlock.padding : 0;
  const desiredStack = typeof stackWithDefault === 'boolean' ? stackWithDefault : false;

  const nextStatusLine = {
    ...prevBlock,
    type: 'command',
    command: cleanCmd,
    enabled: true,
    padding: desiredPadding,
    stack_with_default: desiredStack,
  };

  const unchanged =
    isCliStatusPlainObject(existing) &&
    existing.type === nextStatusLine.type &&
    existing.command === nextStatusLine.command &&
    existing.enabled === nextStatusLine.enabled &&
    existing.padding === nextStatusLine.padding &&
    existing.stack_with_default === nextStatusLine.stack_with_default;

  if (unchanged) {
    return {
      changed: false,
      alreadyConfigured: true,
      object: baseObj,
    };
  }

  return {
    changed: true,
    configured: true,
    object: {
      ...baseObj,
      statusLine: nextStatusLine,
    },
  };
}

/**
 * `~/.gemini/antigravity-cli/settings.json` `statusLine` 
 *
 * @param {{
 *   enabled?: boolean,
 *   env?: Record<string, string|undefined>,
 *   homeDir?: string,
 *   scriptPath?: string,
 *   platform?: string,
 *   execPath?: string,
 *   nodeOnPath?: boolean,
 * }} [options]
 */
export function ensureCliStatusLineConfigured({
  enabled = true,
  env = process.env,
  homeDir = homedir(),
  scriptPath = '',
  platform = process.platform,
  execPath = process.execPath,
  nodeOnPath,
} = {}) {
  if (
    lsRuntimeEndpoint.addr === 'test.invalid' &&
    String(env?.USAGE_MONITOR_ALLOW_TEST_CLI_SETTINGS || '') !== '1'
  ) {
    return { checked: false, updated: false, reason: 'test_sandbox_skipped' };
  }

  const settingsPath = resolveCliSettingsPath(env, homeDir);
  try {
    const cliDir = dirname(settingsPath);
    if (!existsSync(cliDir)) {
      return { checked: true, updated: false, reason: 'cli_dir_missing', settingsPath };
    }

    let currentObj = {};
    let eol = platform === 'win32' ? '\r\n' : '\n';
    if (existsSync(settingsPath)) {
      const rawText = readFileSync(settingsPath, 'utf8');
      if (rawText.includes('\r\n')) eol = '\r\n';
      else if (rawText.includes('\n')) eol = '\n';
      const trimmed = rawText.replace(/^\uFEFF/, '').trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (!isCliStatusPlainObject(parsed)) {
            return { checked: true, updated: false, reason: 'non_object_json', settingsPath };
          }
          currentObj = parsed;
        } catch {
          return { checked: true, updated: false, reason: 'invalid_json', settingsPath };
        }
      }
    } else if (!enabled) {
      return { checked: true, updated: false, alreadyRemoved: true, settingsPath };
    }

    const resolvedScript =
      scriptPath || resolvePreferredCliStatusLineScriptPath({ env, homeDir });
    const hasNodePath =
      typeof nodeOnPath === 'boolean' ? nodeOnPath : detectNodeOnSystemPath(env, platform);
    const command = buildCliStatusLineCommand(resolvedScript, {
      platform,
      execPath,
      nodeOnPath: hasNodePath,
    });

    const applied = applyCliStatusLineToSettingsObject(currentObj, { enabled, command });
    if (!applied.changed) {
      return {
        checked: true,
        updated: false,
        ...applied,
        command,
        settingsPath,
      };
    }

    const serialized = `${JSON.stringify(applied.object, null, 2).replace(/\n/g, eol)}${eol}`;
    const tmpPath = `${settingsPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, settingsPath);
    } catch {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
 // 
      }
      writeFileSync(settingsPath, serialized, 'utf8');
    }

    return {
      checked: true,
      updated: true,
      ...applied,
      command,
      settingsPath,
    };
  } catch (err) {
    return {
      checked: true,
      updated: false,
      reason: 'io_error',
      error: err?.message || String(err),
      settingsPath,
    };
  }
}

// ---------------------------------------------------------------------------
// ANSI `metricRegistry.js` 1:1 
// ---------------------------------------------------------------------------

function cliStatusSpeedSgr(tokPerSec) {
  if (tokPerSec == null || !Number.isFinite(Number(tokPerSec)) || Number(tokPerSec) <= 0) {
    return SGR_FG_MUTED;
  }
  const v = Number(tokPerSec);
  if (v >= 60) return SGR_FG_GOOD;
  if (v >= 35) return SGR_FG_INFO;
  if (v >= 20) return SGR_FG_WARN;
  return SGR_FG_DANGER;
}

function cliStatusCacheSgr(cacheHitPct, promptTokens = null) {
  if (cacheHitPct == null || !Number.isFinite(Number(cacheHitPct))) return SGR_FG_MUTED;
  const v = Number(cacheHitPct);
  if (promptTokens != null && Number(promptTokens) <= 0 && v <= 0) return SGR_FG_MUTED;
  if (v >= 85) return SGR_FG_GOOD;
  if (v >= 65) return SGR_FG_INFO;
  if (v >= 30) return SGR_FG_WARN;
  return SGR_FG_DANGER;
}

function cliStatusCostSgr(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return SGR_FG_NORMAL;
  const v = Number(costUsd);
  if (v >= 0.3) return SGR_FG_DANGER;
  if (v >= 0.15) return SGR_FG_WARN;
  return SGR_FG_NORMAL;
}

function cliStatusTtftSgr(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) {
    return SGR_FG_MUTED;
  }
  const v = Number(ttftSec);
  if (v >= 30) return SGR_FG_DANGER;
  if (v >= 18) return SGR_FG_WARN;
  return SGR_FG_NORMAL;
}

function cliFormatCompactCost(costUsd) {
  if (costUsd == null || !Number.isFinite(Number(costUsd))) return '--';
  const val = Math.max(0, Number(costUsd));
  if (val === 0) return '$0.00';
  if (val < 0.001) return '<$0.001';
  if (val < 1) return `$${val.toFixed(3)}`;
  if (val < 100) return `$${val.toFixed(2)}`;
  return `$${Math.round(val)}`;
}

function cliFormatCompactTtft(ttftSec) {
  if (ttftSec == null || !Number.isFinite(Number(ttftSec)) || Number(ttftSec) < 0) return '--s';
  const val = Number(ttftSec);
  if (val < 1) return `${val.toFixed(2)}s`;
  if (val < 100) return `${val.toFixed(1)}s`;
  return `${Math.round(val)}s`;
}

function cliFormatTokens(num) {
  const n = Number(num || 0);
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function cliResolveQuotaPct(quotas, slotKey) {
  if (!quotas || typeof quotas !== 'object') return null;
  const pools = Array.isArray(quotas.pools) ? quotas.pools : [];
  const activePool = quotas.activePool || null;
  const weekly = quotas.weekly || null;

  if (slotKey === 'quota_auto') {
    const candidates = [];
    if (activePool && Number.isFinite(Number(activePool.remainingPct))) {
      candidates.push(Number(activePool.remainingPct));
    }
    if (activePool && Number.isFinite(Number(activePool.weeklyRemainingPct))) {
      candidates.push(Number(activePool.weeklyRemainingPct));
    }
    if (!candidates.length && weekly && Number.isFinite(Number(weekly.remainingPct))) {
      candidates.push(Number(weekly.remainingPct));
    }
    if (!candidates.length && pools.length > 0) {
      for (const p of pools) {
        if (p && Number.isFinite(Number(p.remainingPct))) candidates.push(Number(p.remainingPct));
        if (p && Number.isFinite(Number(p.weeklyRemainingPct))) {
          candidates.push(Number(p.weeklyRemainingPct));
        }
      }
    }
    if (!candidates.length) return null;
    return Math.max(0, Math.min(100, Math.round(Math.min(...candidates))));
  }

  const isClaude = slotKey.startsWith('claude_');
  const isWeekly = slotKey.endsWith('_weekly');
  let rawPct = null;

  if (isClaude) {
    const claudePool =
      pools.find((p) => p?.poolKey === 'Claude & GPT') ||
      pools.find((p) =>
        CLI_STATUS_THIRD_PARTY_FAMILY_RE.test(String(p?.poolKey || p?.poolLabel || ''))
      );
    const cand = isWeekly ? claudePool?.weeklyRemainingPct : claudePool?.remainingPct;
    if (cand != null && Number.isFinite(Number(cand))) {
      rawPct = Number(cand);
    } else if (
      activePool &&
      CLI_STATUS_THIRD_PARTY_FAMILY_RE.test(String(activePool.family || activePool.poolLabel || ''))
    ) {
      const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
      if (fb != null && Number.isFinite(Number(fb))) rawPct = Number(fb);
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
        !CLI_STATUS_THIRD_PARTY_FAMILY_RE.test(
          String(activePool.family || activePool.poolLabel || '')
        )
      ) {
        const fb = isWeekly ? activePool.weeklyRemainingPct : activePool.remainingPct;
        if (fb != null && Number.isFinite(Number(fb))) rawPct = Number(fb);
      }
      if (
        rawPct == null &&
        isWeekly &&
        weekly &&
        !CLI_STATUS_THIRD_PARTY_FAMILY_RE.test(String(weekly.poolFamily || '')) &&
        weekly.remainingPct != null &&
        Number.isFinite(Number(weekly.remainingPct))
      ) {
        rawPct = Number(weekly.remainingPct);
      }
    }
  }

  if (rawPct == null || !Number.isFinite(rawPct)) return null;
  return Math.max(0, Math.min(100, Math.round(rawPct)));
}

/**
 * CSI SGR CJK 2 `●`/`◎`/`·` ASCII 1 
 *
 * @param {string} rawStr
 * @returns {number}
 */
export function cliDisplayWidth(rawStr) {
  const plain = String(rawStr || '').replace(/\x1b\[[0-9;]*m/g, '');
  let cols = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) || 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0x0300 && cp <= 0x036f)) {
      continue;
    }
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0x33bf) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    cols += isWide ? 2 : 1;
  }
  return cols;
}

/**
 * CLI `"Gemini 4 Hydrogen (Medium)"` `"Gemini 4 Hydrogen"` + `"medium"` 
 * `agy` `stripEffortSuffix` 
 *
 * @param {unknown} rawModelName
 * @param {unknown} [rawEffort]
 * @returns {{ modelName: string, effort: string }}
 */
export function parseCliModelAndEffort(rawModelName, rawEffort = '') {
  const cleanModel = String(rawModelName || '').trim();
  let modelName = cleanModel;
  let inferredEffort = '';
  const suffixMatch = cleanModel.match(/^(.*?)\s*\((minimal|low|medium|high|max|xhigh)\)\s*$/i);
  if (suffixMatch) {
    modelName = suffixMatch[1].trim();
    inferredEffort = suffixMatch[2].toLowerCase();
  }
  const explicitEffort = String(rawEffort || '')
    .trim()
    .replace(/^EFFORT_/i, '')
    .toLowerCase();
  return {
    modelName,
    effort: explicitEffort || inferredEffort,
  };
}

function normalizeCliCycleMode(rawMode) {
  const trimmed = String(rawMode || '')
    .trim()
    .replace(/^(?:AGENT_MODE_|PERMISSION_MODE_)/i, '')
    .toLowerCase();
  if (!trimmed || trimmed === 'none' || trimmed === 'default' || trimmed === 'unspecified') {
    return '';
  }
  return trimmed.replace(/_/g, '-');
}

function cliModeSgr(normMode) {
  if (normMode === 'auto') return SGR_FG_MODE_AUTO;
  if (normMode === 'plan') return SGR_FG_ACCENT;
  if (normMode === 'accept-edits' || normMode === 'edit') return SGR_FG_GOOD;
  if (normMode === 'best-of-n' || normMode === 'battle') return SGR_FG_MODE_VIOLET;
  return SGR_FG_CHROME;
}

function cliBuildLeftSegment({ vimMode = '', short = false, useColor = true } = {}) {
  const cleanVim = String(vimMode || '').trim().toUpperCase();
  const baseText = short
    ? '?'
    : cleanVim
      ? `${cleanVim} · ? for shortcuts`
      : '? for shortcuts';
  if (!useColor) return baseText;
  return `${SGR_FG_CHROME}${baseText}${SGR_RESET}`;
}

function cliBuildRightSegment({
  cycleMode = '',
  modelDisplayName = '',
  modelEffort = '',
  includeEffort = true,
  useColor = true,
} = {}) {
  const normMode = normalizeCliCycleMode(cycleMode);
  const { modelName, effort } = parseCliModelAndEffort(modelDisplayName, modelEffort);
  const plainParts = [];
  const styledParts = [];

  if (normMode) {
    plainParts.push(normMode);
    styledParts.push(useColor ? `${cliModeSgr(normMode)}${normMode}${SGR_RESET}` : normMode);
  }
  if (modelName) {
    plainParts.push(modelName);
    styledParts.push(useColor ? `${SGR_FG_CHROME}${modelName}${SGR_RESET}` : modelName);
  }
  if (includeEffort && effort) {
    plainParts.push(effort);
    styledParts.push(useColor ? `${SGR_FG_CHROME}${effort}${SGR_RESET}` : effort);
  }
  if (plainParts.length === 0) return '';
  if (!useColor) return plainParts.join(' · ');
  const dotSep = `${SGR_FG_CHROME} · ${SGR_RESET}`;
  return styledParts.join(dotSep);
}

function cliComposeBalancedThreeColumn(leftStr, centerStr, rightStr, maxWidth) {
  const lw = cliDisplayWidth(leftStr);
  const cw = cliDisplayWidth(centerStr);
  const rw = cliDisplayWidth(rightStr);
  if (leftStr && rightStr) {
    const free = maxWidth - lw - cw - rw;
    if (free < 4) return '';
    const leftGap = Math.floor(free / 2);
    const rightGap = free - leftGap;
    return `${leftStr}${' '.repeat(leftGap)}${centerStr}${' '.repeat(rightGap)}${rightStr}`;
  }
  if (leftStr && !rightStr) {
    if (lw + cw + 2 > maxWidth) return '';
    const idealCenterStart = Math.max(lw + 2, Math.floor((maxWidth - cw) / 2));
    const leftGap = Math.min(maxWidth - lw - cw, idealCenterStart - lw);
    return `${leftStr}${' '.repeat(leftGap)}${centerStr}`;
  }
  if (!leftStr && rightStr) {
    const free = maxWidth - cw - rw;
    if (free < 2) return '';
    return `${centerStr}${' '.repeat(free)}${rightStr}`;
  }
  return cw <= maxWidth ? centerStr : '';
}

/**
 * SGR 
 */
function cliRenderSingleSlot(metricKey, slotCtx, { isEn = false, isTh = false, useColor = true, slotSet, quotaDisplayMode = 'left' } = {}) {
  const hasTelemetry = slotCtx.hasTelemetry !== false;

  if (metricKey === 'context') {
    const valid = hasTelemetry && slotCtx.usedPct != null && Number.isFinite(Number(slotCtx.usedPct));
    const pctNum = valid ? Math.max(0, Math.min(100, Math.round(Number(slotCtx.usedPct)))) : null;
    const textVal = pctNum != null ? `${pctNum}%` : '--%';
    if (!useColor) {
      return `◎ ${textVal}`;
    }
    const isDanger = pctNum != null && pctNum >= 88;
    const isWarn = !isDanger && pctNum != null && pctNum >= 70;
    const ringColor = isDanger
      ? SGR_FG_DANGER
      : isWarn
        ? SGR_FG_WARN
        : pctNum != null
          ? SGR_FG_ACCENT
          : SGR_FG_MUTED;
    const valColor = isDanger
      ? `${SGR_BOLD}${SGR_FG_DANGER}`
      : isWarn
        ? `${SGR_BOLD}${SGR_FG_WARN}`
        : pctNum != null
          ? `${SGR_BOLD}${SGR_FG_BRIGHT}`
          : SGR_FG_MUTED;
    return `${ringColor}◎ ${valColor}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'tps') {
    const valid = hasTelemetry && Number.isFinite(Number(slotCtx.tps)) && Number(slotCtx.tps) > 0;
    const numVal = valid ? Number(slotCtx.tps) : 0;
    const textVal = valid
      ? `${numVal >= 100 ? Math.round(numVal) : numVal.toFixed(1)} t/s`
      : slotCtx.isRunning
        ? isTh
          ? 'กำลังรัน...'
          : 'Gen...'
        : 'Idle';
    if (!useColor) return textVal;
    const color = valid
      ? `${SGR_BOLD}${cliStatusSpeedSgr(numVal)}`
      : slotCtx.isRunning
        ? SGR_FG_INFO
        : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'avg_tps') {
    const valid =
      hasTelemetry && Number.isFinite(Number(slotCtx.avgTps)) && Number(slotCtx.avgTps) > 0;
    const numVal = valid ? Number(slotCtx.avgTps) : 0;
    const needPrefix = slotSet?.has('tps');
    const prefix = needPrefix ? (isTh ? 'เฉลี่ย ' : 'avg ') : '';
    const textVal = valid
      ? `${prefix}${numVal >= 100 ? Math.round(numVal) : numVal.toFixed(1)} t/s`
      : `${prefix}-- t/s`;
    if (!useColor) return textVal;
    const color = valid ? cliStatusSpeedSgr(numVal) : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'ttft') {
    const valid =
      hasTelemetry && slotCtx.ttft != null && Number.isFinite(Number(slotCtx.ttft)) && Number(slotCtx.ttft) >= 0;
    const textVal = valid ? cliFormatCompactTtft(Number(slotCtx.ttft)) : '--s';
    if (!useColor) return textVal;
    const color = valid ? cliStatusTtftSgr(Number(slotCtx.ttft)) : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'cost' || metricKey === 'session_cost') {
    const rawVal = !hasTelemetry
      ? null
      : metricKey === 'session_cost'
        ? slotCtx.sessionCost
        : slotCtx.stepCost;
    const needPrefix =
      metricKey === 'session_cost' && slotSet?.has('cost')
        ? isTh
          ? 'รวม '
          : 'sum '
        : '';
    const textVal = `${needPrefix}${hasTelemetry ? cliFormatCompactCost(rawVal) : '--'}`;
    if (!useColor) return textVal;
    const color =
      metricKey === 'cost' && hasTelemetry && rawVal != null
        ? cliStatusCostSgr(rawVal)
        : rawVal != null
          ? SGR_FG_NORMAL
          : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'cache_hit') {
    const valid =
      hasTelemetry && slotCtx.cacheHitPct != null && Number.isFinite(Number(slotCtx.cacheHitPct));
    const numVal = valid ? Math.max(0, Math.min(100, Math.round(Number(slotCtx.cacheHitPct)))) : 0;
    const prefix = isTh ? 'Cache ' : 'cache ';
    const textVal = valid ? `${prefix}${numVal}%` : `${prefix}--%`;
    if (!useColor) return textVal;
    const color = valid
      ? cliStatusCacheSgr(Number(slotCtx.cacheHitPct), slotCtx.latestPromptTokens)
      : SGR_FG_MUTED;
    return `${color}${textVal}${SGR_RESET}`;
  }

  if (metricKey === 'session_tokens') {
    const valid =
      hasTelemetry &&
      slotCtx.sessionTokens != null &&
      Number.isFinite(Number(slotCtx.sessionTokens)) &&
      Number(slotCtx.sessionTokens) >= 0;
    const textVal = valid ? `${cliFormatTokens(Number(slotCtx.sessionTokens))} tok` : '-- tok';
    if (!useColor) return textVal;
    return `${valid ? SGR_FG_NORMAL : SGR_FG_MUTED}${textVal}${SGR_RESET}`;
  }

  const quotaPct = hasTelemetry ? cliResolveQuotaPct(slotCtx.quotas, metricKey) : null;
  const shownPct =
    quotaPct != null ? (quotaDisplayMode === 'used' ? 100 - quotaPct : quotaPct) : null;
  const textVal =
    shownPct != null
      ? quotaDisplayMode === 'used'
        ? isTh
          ? `ใช้ ${shownPct}%`
          : `${shownPct}% used`
        : isTh
          ? `เหลือ ${shownPct}%`
          : `${shownPct}% left`
      : isTh
        ? 'โควต้า --'
        : 'Quota --';
  if (!useColor) return textVal;
  const isDanger = quotaPct != null && quotaPct <= 15;
  const isWarn = !isDanger && quotaPct != null && quotaPct <= 30;
  const color = isDanger
    ? `${SGR_BOLD}${SGR_FG_DANGER}`
    : isWarn
      ? `${SGR_BOLD}${SGR_FG_WARN}`
      : SGR_FG_MUTED;
  return `${color}${textVal}${SGR_RESET}`;
}

/**
 * CLI `terminalWidth > 0` + + 
 *
 * @param {{
 *   hasTelemetry?: boolean,
 *   usedPct?: number|null,
 *   isRunning?: boolean,
 *   hasWaiting?: boolean,
 *   runningCount?: number,
 *   runningSubCount?: number,
 *   tps?: number|null,
 *   avgTps?: number|null,
 *   ttft?: number|null,
 *   stepCost?: number|null,
 *   sessionCost?: number|null,
 *   cacheHitPct?: number|null,
 *   latestPromptTokens?: number|null,
 *   sessionTokens?: number|null,
 *   quotas?: object|null,
 * }} slotCtx
 * @param {{
 *   slots?: string[],
 *   showMultiSession?: boolean,
 *   language?: string,
 *   color?: boolean,
 *   terminalWidth?: number,
 *   cycleMode?: string,
 *   modelDisplayName?: string,
 *   modelEffort?: string,
 *   vimMode?: string,
 * }} [options]
 * @returns {string}
 */
export function formatCliStatusLineCapsule(slotCtx = {}, options = {}) {
  const slots = normalizeTopbarCapsuleSlots(options.slots);
  const showMulti = options.showMultiSession !== false;
  const normLang = normalizeLanguageSetting(options.language);
  const quotaDisplayMode = normalizeQuotaDisplayMode(options.quotaDisplayMode);
  const isTh = normLang === 'th-TH';
  const isEn = normLang === 'en-US';
  const useColor = options.color !== false;
  const slotSet = new Set(slots);

  const runningCount = Math.max(0, Math.floor(Number(slotCtx.runningCount) || 0));
  const runningSubCount = Math.max(0, Math.floor(Number(slotCtx.runningSubCount) || 0));
  const hasWaiting = Boolean(slotCtx.hasWaiting);

  let multiCore = '';
  if (showMulti) {
    const labelText =
      runningCount > 0
        ? runningSubCount > 0
          ? isTh
            ? `${runningCount} Active · ${runningSubCount} Sub`
            : `${runningCount} active · ${runningSubCount} sub`
          : isTh
            ? `${runningCount} Active`
            : `${runningCount} active`
        : isTh
          ? '0 Active'
          : '0 active';
    if (!useColor) {
      multiCore = `● ${labelText}`;
    } else {
      const dotSgr =
        runningCount > 0
          ? hasWaiting
            ? SGR_FG_WARN
            : SGR_FG_GOOD
          : SGR_FG_DOT_IDLE;
      const textSgr = runningCount > 0 ? SGR_FG_NORMAL : SGR_FG_DIM;
      multiCore = `${dotSgr}● ${textSgr}${labelText}${SGR_RESET}`;
    }
  }

  const renderedSlots = slots.map((key) =>
    cliRenderSingleSlot(key, slotCtx, { isEn, isTh, useColor, slotSet, quotaDisplayMode })
  );
  const sep = useColor ? `${SGR_FG_SEP} | ${SGR_RESET}` : ' | ';
  const slotsBody = renderedSlots.join(sep);
  const fullCapsule = multiCore ? `${multiCore}   ${slotsBody}` : slotsBody;

  const rawWidth = Number(options.terminalWidth);
  if (!Number.isFinite(rawWidth) || rawWidth <= 0) {
    return fullCapsule;
  }

 // 1 `agy` Windows `conhost`/`cmd.exe` 
  const maxWidth = Math.max(1, Math.floor(rawWidth) - 1);
  const compactCapsule = multiCore ? `${multiCore}  ${slotsBody}` : slotsBody;
  const fullLeft = cliBuildLeftSegment({ vimMode: options.vimMode, short: false, useColor });
  const shortLeft = cliBuildLeftSegment({ vimMode: '', short: true, useColor });
  const fullRight = cliBuildRightSegment({
    cycleMode: options.cycleMode,
    modelDisplayName: options.modelDisplayName,
    modelEffort: options.modelEffort,
    includeEffort: true,
    useColor,
  });
  const compactRight = cliBuildRightSegment({
    cycleMode: options.cycleMode,
    modelDisplayName: options.modelDisplayName,
    modelEffort: options.modelEffort,
    includeEffort: false,
    useColor,
  });

  const tier1 = cliComposeBalancedThreeColumn(fullLeft, fullCapsule, fullRight, maxWidth);
  if (tier1) return tier1;

  const tier2 = cliComposeBalancedThreeColumn(shortLeft, fullCapsule, fullRight, maxWidth);
  if (tier2) return tier2;

  const tier3 = cliComposeBalancedThreeColumn(shortLeft, compactCapsule, compactRight, maxWidth);
  if (tier3) return tier3;

  const tier4 = cliComposeBalancedThreeColumn('', compactCapsule, compactRight, maxWidth);
  if (tier4) return tier4;

  if (cliDisplayWidth(fullCapsule) <= maxWidth) {
    return fullCapsule;
  }
  return slotsBody;
}
