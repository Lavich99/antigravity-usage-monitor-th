/**
 * @fileoverview IDE/CLI 
 *
 * 
 * 1. `~/.gemini/antigravity/conversations` `.db` / `.pb` / `.db-wal` 
 * 2. `.deep_stats_cache.json` IDE / CLI / Standalone 
 * 3. Language Server 4 
 * Schema `trajectory_usage_cache.json` 
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  extractLiveActivity,
  extractModelSteps,
  getMaxMeaningfulStepIndex,
  parseIsoMs,
} from '../speed-metrics.mjs';
import {
  ANNOTATION_DIRS,
  BRAIN_DIR,
  BRAIN_DIRS,
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  CONVERSATIONS_DIR,
  CONVERSATION_DIRS,
  DEEP_STATS_CACHE_CANDIDATES,
  cacheState,
  externalDeepStatsMemo,
  loadJson,
  saveJson,
  trajectoryCache,
} from './config.mjs';
import {
  hasBuiltinNodeSqlite,
  readAnnotationTitleForCascade,
  readLocalSqliteTrajectory,
  readLocalSummaryIndex,
} from './cli-sqlite-reader.mjs';
import { callLsRpc } from './ls-rpc.mjs';
import { formatGenericModelSlug, getBaseModelLabel } from './model-pricing.mjs';
import { PLACEHOLDER_MAP } from './pricing-catalog.mjs';

const CONV_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(db|pb|db-wal)$/i;
const TRANSCRIPT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const dirScanMemo = { sig: '', scannedAtMs: 0, map: null };

function computeDirListStatSig(dirs) {
  let sig = '';
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      const st = statSync(dir);
      sig += `${dir}:${Number(st.mtimeMs || 0)}|`;
    } catch {
      sig += `${dir}:missing|`;
    }
  }
  return sig;
}

/**
 * Scan local Desktop / CLI / IDE conversations and transcript logs, indexed by lowercase `cascadeId`.
 * Uses directory mtime + short TTL memoization and pre-reads annotation directories to cut disk I/O.
 *
 * @returns {Map<string, string[]>}
 */
function discoverLocalConversationFiles() {
  const convDirs =
    Array.isArray(CONVERSATION_DIRS) && CONVERSATION_DIRS.length > 0
      ? CONVERSATION_DIRS
      : [CONVERSATIONS_DIR];
  const brainDirs =
    Array.isArray(BRAIN_DIRS) && BRAIN_DIRS.length > 0 ? BRAIN_DIRS : [BRAIN_DIR];
  const annotationDirs = Array.isArray(ANNOTATION_DIRS) ? ANNOTATION_DIRS : [];

  const dirSig =
    computeDirListStatSig(convDirs) +
    computeDirListStatSig(brainDirs) +
    computeDirListStatSig(annotationDirs);
  const now = Date.now();
  if (
    dirScanMemo.map &&
    dirScanMemo.sig === dirSig &&
    now - dirScanMemo.scannedAtMs < 2000
  ) {
    return dirScanMemo.map;
  }

  const map = new Map();
  for (const dir of convDirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      for (const rawName of readdirSync(dir)) {
        const name = String(rawName || '');
        const m = name.match(CONV_FILE_RE);
        if (!m) continue;
        const cascadeId = m[1].toLowerCase();
        if (!map.has(cascadeId)) map.set(cascadeId, []);
        map.get(cascadeId).push(join(dir, name));
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  for (const dir of brainDirs) {
    if (!dir || !existsSync(dir)) continue;
    try {
      for (const rawName of readdirSync(dir)) {
        const name = String(rawName || '').trim();
        const cascadeId = name.toLowerCase();
        if (!TRANSCRIPT_UUID_RE.test(cascadeId)) continue;
        const transcriptPath = join(dir, name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath)) continue;
        if (!map.has(cascadeId)) map.set(cascadeId, []);
        map.get(cascadeId).push(transcriptPath);
      }
    } catch {
      // Ignore unreadable directory
    }
  }

  if (annotationDirs.length > 0 && map.size > 0) {
    for (const annDir of annotationDirs) {
      if (!annDir || !existsSync(annDir)) continue;
      try {
        const pbtxtFiles = new Set();
        for (const f of readdirSync(annDir)) {
          if (String(f).endsWith('.pbtxt')) {
            pbtxtFiles.add(String(f).slice(0, -6).toLowerCase());
          }
        }
        for (const [cascadeId, fileList] of map.entries()) {
          if (pbtxtFiles.has(cascadeId)) {
            fileList.push(join(annDir, `${cascadeId}.pbtxt`));
          }
        }
      } catch {
        // Ignore annotation scan errors
      }
    }
  }

  dirScanMemo.sig = dirSig;
  dirScanMemo.scannedAtMs = now;
  dirScanMemo.map = map;
  return map;
}

function readConversationMtime(files = []) {
  let mtimeMs = 0;
  for (const nameOrPath of files) {
    try {
      const fullPath = /[\\/]|^[a-zA-Z]:/.test(nameOrPath)
        ? nameOrPath
        : join(CONVERSATIONS_DIR, nameOrPath);
      mtimeMs = Math.max(mtimeMs, Number(statSync(fullPath)?.mtimeMs || 0));
    } catch {
      
    }
  }
  return mtimeMs;
}

/**
 * IDE / Standalone / JetBrains `.deep_stats_cache.json` 
 * (`mtimeMs + size`) Memoize Map 
 *
 * @returns {Map<string, {cascadeId: string, appSource: string, accountName: string, title: string, lastModifiedMs: number, steps: object[]}>}
 */
export function loadExternalDeepStatsCache() {
  const sigParts = [];
  const existingFiles = [];
  for (const candidate of DEEP_STATS_CACHE_CANDIDATES) {
    if (!existsSync(candidate)) continue;
    try {
      const st = statSync(candidate);
      sigParts.push(`${candidate}:${st.mtimeMs || 0}:${st.size || 0}`);
      existingFiles.push(candidate);
    } catch {
      // stat
    }
  }
  if (existingFiles.length === 0) {
    return new Map();
  }
  const sig = sigParts.join('|');
  if (externalDeepStatsMemo.sig === sig && externalDeepStatsMemo.convos.size > 0) {
    return externalDeepStatsMemo.convos;
  }

  const convos = new Map();
  const runtimeDisplayMap = new Map();

  for (const filePath of existingFiles) {
    const raw = loadJson(filePath, null);
    if (!raw || typeof raw.perConvo !== 'object' || !raw.perConvo) continue;
    const fileAccountName = String(raw.accountName || raw.email || '').trim();

    for (const item of Object.values(raw.perConvo)) {
      for (const e of item?.entries || []) {
        const intrinsicDisplay =
          PLACEHOLDER_MAP[e?.modelRuntimeId]?.label ||
          formatGenericModelSlug(e?.modelCanonicalId || e?.model);
        const isSessionDisplayAgg = /^session-display:/i.test(String(e?.modelAggregationId || ''));
        const usableDisplayHint =
          e?.modelDisplayName &&
          !(
            isSessionDisplayAgg &&
            intrinsicDisplay &&
            getBaseModelLabel(e.modelDisplayName) !== getBaseModelLabel(intrinsicDisplay)
          )
            ? e.modelDisplayName
            : '';
        const display =
          usableDisplayHint ||
          intrinsicDisplay ||
          formatGenericModelSlug(e?.modelAggregationId);
        if (!display) continue;
        const base = getBaseModelLabel(display);
        if (e?.modelRuntimeId && !runtimeDisplayMap.has(e.modelRuntimeId)) {
          runtimeDisplayMap.set(e.modelRuntimeId, base);
        }
        if (e?.model && !runtimeDisplayMap.has(e.model)) {
          runtimeDisplayMap.set(e.model, base);
        }
      }
    }

    const titleMap = raw.titleMap || {};
    for (const [fullKey, item] of Object.entries(raw.perConvo)) {
      const rawEntries = item?.entries;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) continue;
      const colonIdx = fullKey.indexOf(':');
      const appSource = item?.appSource || (colonIdx > 0 ? fullKey.slice(0, colonIdx) : 'ide');
      const cascadeId = (colonIdx > 0 ? fullKey.slice(colonIdx + 1) : fullKey).toLowerCase();
      const mapKey = `${appSource}:${cascadeId}`;
      const existing = convos.get(mapKey);
      if (existing && existing.steps.length >= rawEntries.length) continue;

      const itemAccountName = String(
        item?.accountName || item?.email || fileAccountName || ''
      ).trim();

      const steps = [];
      let lastModifiedMs = 0;
      for (let idx = 0; idx < rawEntries.length; idx++) {
        const e = rawEntries[idx];
        const inputTokens = Math.max(0, Math.floor(Number(e?.inp) || 0));
        const cacheReadTokens = Math.max(0, Math.floor(Number(e?.cache) || 0));
        const responseTokens = Math.max(0, Math.floor(Number(e?.out) || 0));
        const thinkingTokens = Math.max(0, Math.floor(Number(e?.reasoning) || 0));
        const outputTokens = responseTokens + thinkingTokens;
        if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) continue;
        const createdAtMs = e?.ts ? Date.parse(e.ts) || 0 : 0;
        if (createdAtMs > lastModifiedMs) lastModifiedMs = createdAtMs;
        const stepIntrinsicLabel =
          PLACEHOLDER_MAP[e?.modelRuntimeId]?.label ||
          formatGenericModelSlug(e?.modelCanonicalId || e?.model);
        const isSessionDisplayAgg = /^session-display:/i.test(String(e?.modelAggregationId || ''));
        const safeStepDisplayName =
          e?.modelDisplayName &&
          !(
            isSessionDisplayAgg &&
            stepIntrinsicLabel &&
            getBaseModelLabel(e.modelDisplayName) !== getBaseModelLabel(stepIntrinsicLabel)
          )
            ? e.modelDisplayName
            : '';
        const resolvedDisplay =
          safeStepDisplayName ||
          stepIntrinsicLabel ||
          runtimeDisplayMap.get(e?.model) ||
          runtimeDisplayMap.get(e?.modelRuntimeId) ||
          formatGenericModelSlug(e?.modelAggregationId) ||
          '';
        const rawUpstreamCandidate = String(e?.model || e?.modelCanonicalId || '').trim();
        const inferredResponseModel =
          /^session:/i.test(String(e?.modelAggregationId || '')) &&
          rawUpstreamCandidate &&
          !/^MODEL_/i.test(rawUpstreamCandidate) &&
          !/\s/.test(rawUpstreamCandidate)
            ? rawUpstreamCandidate
            : '';
        steps.push({
          stepIndex: idx + 1,
          createdAt: e?.ts || '',
          createdAtMs,
          modelKey: e?.modelCanonicalId || e?.model || e?.modelRuntimeId || 'unknown',
          modelDisplayName: resolvedDisplay,
          ...(inferredResponseModel ? { responseModel: inferredResponseModel } : {}),
          apiProvider: e?.provider || '',
          appSource,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          thinkingTokens,
          responseTokens,
        });
      }
      if (steps.length > 0) {
        convos.set(mapKey, {
          cascadeId,
          appSource,
          accountName: itemAccountName,
          title: titleMap[fullKey] || titleMap[cascadeId] || cascadeId.slice(0, 8),
          lastModifiedMs,
          steps,
        });
      }
    }
  }

  externalDeepStatsMemo.sig = sig;
  externalDeepStatsMemo.convos = convos;
  return convos;
}

const MAX_CONCURRENT_RPC = 4;
const LEGACY_MIGRATION_BATCH_SIZE = 8;
const stepFieldChecks = new WeakMap();
const MAX_SUBAGENT_RECONCILE_DEPTH = 4;
const FAILED_RPC_COOLDOWN_MS = 60_000;
const ACTIVE_FAILED_RPC_COOLDOWN_MS = 15_000;
const TRANSCRIPT_TAIL_MAX_BYTES = 96 * 1024;
const MAX_TRANSCRIPT_MEMO_ENTRIES = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failedFetchCooldownMap = new Map();
const liveActivityMemo = new Map();
const transcriptTailMemo = new Map();
const RUNNING_TRAJECTORY_SKIP_MS = 2500;
const ACTIVE_CACHE_FLUSH_INTERVAL_MS = 8000;
const MAX_INCREMENTAL_CACHE_ENTRIES = 3;
const runningRawTrajectoryCache = new Map();
let lastCacheDiskFlushMs = 0;

export function applyIncrementalTrajectoryDelta(
  cachedRaw,
  stepOffset,
  tailSteps,
  genMetaOffset,
  tailGenMeta,
  expectedStepCount = 0
) {
  if (!cachedRaw || !Array.isArray(cachedRaw.rawSteps) || !Array.isArray(tailSteps)) {
    return null;
  }
  const safeStepOffset = Math.max(0, Math.floor(Number(stepOffset) || 0));
  if (safeStepOffset > cachedRaw.rawSteps.length) {
    return null;
  }
  const nextRawSteps = cachedRaw.rawSteps.slice(0, safeStepOffset);
  nextRawSteps.push(...tailSteps);
  if (expectedStepCount > 0 && nextRawSteps.length !== expectedStepCount) {
    return null;
  }

  const prevGenMeta = Array.isArray(cachedRaw.generatorMetadata) ? cachedRaw.generatorMetadata : [];
  const safeGenOffset = Math.max(0, Math.floor(Number(genMetaOffset) || 0));
  if (safeGenOffset > prevGenMeta.length) {
    return null;
  }
  const nextGenMeta = prevGenMeta.slice(0, safeGenOffset);
  if (Array.isArray(tailGenMeta)) {
    nextGenMeta.push(...tailGenMeta);
  }
  return {
    rawSteps: nextRawSteps,
    generatorMetadata: nextGenMeta,
  };
}

function findTranscriptPath(cascadeId) {
  if (!cascadeId) return '';
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return '';
  const dirs = Array.isArray(BRAIN_DIRS) && BRAIN_DIRS.length > 0 ? BRAIN_DIRS : [BRAIN_DIR];
  let bestPath = '';
  let bestMtime = -1;
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, normId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!existsSync(candidate)) continue;
    if (dirs.length === 1) return candidate;
    try {
      const mtime = Number(statSync(candidate)?.mtimeMs || 0);
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = candidate;
      }
    } catch {
      if (!bestPath) bestPath = candidate;
    }
  }
  return bestPath;
}

function inferConversationAppSource(diskFiles = [], extMatch = null) {
  if (extMatch?.appSource && extMatch.appSource !== 'standalone') {
    return extMatch.appSource;
  }
  for (const filePath of Array.isArray(diskFiles) ? diskFiles : []) {
    const s = String(filePath || '');
    if (/[\\/]antigravity-cli(?:[\\/]|$)/i.test(s)) return 'cli';
    if (/[\\/]antigravity-ide(?:[\\/]|$)/i.test(s)) return 'ide';
  }
  return '';
}

function extractOfflineUserTitle(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return '';
  const withoutSummary = rawContent
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*$/i, '');
  const reqMatches = [...withoutSummary.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  const body =
    reqMatches.length > 0
      ? reqMatches[reqMatches.length - 1][1]
      : withoutSummary.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '');
  const firstLine = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!firstLine) return '';
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

function hasLocalSqliteDb(diskFiles = []) {
  return Array.isArray(diskFiles) && diskFiles.some((f) => /\.db$/i.test(String(f || '')));
}

function findBestSqliteDbPath(diskFiles = []) {
  if (!Array.isArray(diskFiles) || diskFiles.length === 0) return '';
  let bestPath = '';
  let bestMtime = -1;
  for (const rawPath of diskFiles) {
    const p = String(rawPath || '').trim();
    if (!/\.db$/i.test(p)) continue;
    const fullPath = /[\\/]|^[a-zA-Z]:/.test(p) ? p : join(CONVERSATIONS_DIR, p);
    if (!existsSync(fullPath)) continue;
    try {
      const mtime = Number(statSync(fullPath)?.mtimeMs || 0);
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestPath = fullPath;
      }
    } catch {
      if (!bestPath) bestPath = fullPath;
    }
  }
  return bestPath;
}

/**
 * Language Server RPC `agy` CLI SQLite
 * (`conversations/<id>.db` + `conversation_summaries.db` + `annotations/<id>.pbtxt`) `transcript.jsonl`
 * `.deep_stats_cache.json` TTFT / 10 
 */
function loadOfflineTranscriptConversation(conv, diskFiles, externalByLower, localSummary = null) {
  const cidLower = String(conv?.cascadeId || '').trim().toLowerCase();
  if (!cidLower) return null;
  const extMatch = externalByLower?.get(cidLower) || null;
  const sqliteDbPath = findBestSqliteDbPath(diskFiles);
  const sqliteTraj = sqliteDbPath ? readLocalSqliteTrajectory(sqliteDbPath) : null;
  const transcriptPath = findTranscriptPath(cidLower);

  const transcriptLines = [];
  if (transcriptPath && existsSync(transcriptPath)) {
    try {
      const raw = readFileSync(transcriptPath, 'utf8');
      if (typeof raw === 'string' && raw.trim()) {
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
              transcriptLines.push(parsed);
            }
          } catch {
            // JSON
          }
        }
      }
    } catch {
      
    }
  }

  if (!sqliteTraj && transcriptLines.length === 0 && !extMatch) {
    return null;
  }

  let firstUserTitle = '';
  const transcriptByStepIdx = new Map();
  for (let rawIdx = 0; rawIdx < transcriptLines.length; rawIdx++) {
    const line = transcriptLines[rawIdx];
    const sIdx = Number.isFinite(Number(line.step_index)) ? Number(line.step_index) : rawIdx;
    transcriptByStepIdx.set(sIdx, line);
    const upperType = String(line.type || '').trim().toUpperCase();
    if (
      !firstUserTitle &&
      (upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (line.userInput && typeof line.userInput === 'object'))
    ) {
      firstUserTitle = extractOfflineUserTitle(
        typeof line.content === 'string' ? line.content : line.userInput?.userResponse || ''
      );
    }
  }

  let steps = [];
  let fromSqlite = false;

  if (sqliteTraj && sqliteTraj.steps.length > 0) {
    fromSqlite = true;
    const sqliteRawSteps = [];
    let maxSqliteStepIdx = -1;
    let modelOrdinal = 0;

    for (const sq of sqliteTraj.steps) {
      const sIdx = Number(sq.metadata?.sourceTrajectoryStepInfo?.stepIndex ?? sq.idx);
      if (Number.isFinite(sIdx) && sIdx > maxSqliteStepIdx) {
        maxSqliteStepIdx = sIdx;
      }
      const tLine = transcriptByStepIdx.get(sIdx) || null;
      if (sq.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
        sqliteRawSteps.push({
          type: sq.type,
          status: sq.status,
          ...(typeof tLine?.content === 'string' ? { content: tLine.content } : {}),
          ...(tLine?.userInput ? { userInput: tLine.userInput } : {}),
          ...(Array.isArray(tLine?.media) ? { media: tLine.media } : {}),
          metadata: sq.metadata,
        });
        continue;
      }

      if (sq.metadata?.modelUsage) {
        const deepStep = extMatch?.steps?.[modelOrdinal] || null;
        modelOrdinal += 1;
        const mu = { ...sq.metadata.modelUsage };
        if (!mu.model) {
          const fallbackModel = String(
            tLine?.model || tLine?.generator_model || deepStep?.modelKey || ''
          ).trim();
          if (fallbackModel) mu.model = fallbackModel;
        }
        if (!mu.responseModel && (tLine?.response_model || deepStep?.responseModel)) {
          mu.responseModel = String(tLine?.response_model || deepStep?.responseModel).trim();
        }
        sqliteRawSteps.push({
          type: sq.type,
          status: sq.status,
          plannerResponse: {
            response: typeof tLine?.content === 'string' ? tLine.content : '',
            thinking: typeof tLine?.thinking === 'string' ? tLine.thinking : '',
            toolCalls: Array.isArray(tLine?.tool_calls) ? tLine.tool_calls : [],
          },
          metadata: {
            ...sq.metadata,
            modelUsage: mu,
          },
        });
      }
    }

    // transcript.jsonl SQLite
    for (const [sIdx, line] of transcriptByStepIdx.entries()) {
      if (sIdx <= maxSqliteStepIdx) continue;
      const upperType = String(line.type || '').trim().toUpperCase();
      if (
        upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (line.userInput && typeof line.userInput === 'object')
      ) {
        sqliteRawSteps.push(line);
      } else if (
        line.input_tokens !== undefined ||
        line.cache_read_tokens !== undefined ||
        line.output_tokens !== undefined
      ) {
        sqliteRawSteps.push({
          type:
            upperType === 'CHECKPOINT' || upperType === 'CORTEX_STEP_TYPE_CHECKPOINT'
              ? 'CORTEX_STEP_TYPE_CHECKPOINT'
              : String(line.type || 'PLANNER_RESPONSE'),
          status: /CANCEL/i.test(String(line.status || ''))
            ? 'CORTEX_STEP_STATUS_CANCELED'
            : 'CORTEX_STEP_STATUS_DONE',
          plannerResponse: {
            response: typeof line.content === 'string' ? line.content : '',
            thinking: typeof line.thinking === 'string' ? line.thinking : '',
            toolCalls: Array.isArray(line.tool_calls) ? line.tool_calls : [],
          },
          metadata: {
            createdAt: String(line.created_at || line.createdAt || ''),
            sourceTrajectoryStepInfo: { stepIndex: sIdx },
            modelUsage: {
              model: String(line.model || line.generator_model || 'unknown').trim() || 'unknown',
              inputTokens: line.input_tokens ?? 0,
              cacheReadTokens: line.cache_read_tokens ?? 0,
              outputTokens: line.output_tokens ?? 0,
            },
          },
        });
      }
    }

    steps = extractModelSteps(sqliteRawSteps, sqliteTraj.generatorMetadata || []);
  }

  if (steps.length === 0 && transcriptLines.length > 0) {
    const syntheticSteps = [];
    let modelOrdinal = 0;

    for (let rawIdx = 0; rawIdx < transcriptLines.length; rawIdx++) {
      const line = transcriptLines[rawIdx];
      const rawType = String(line.type || '').trim();
      const upperType = rawType.toUpperCase();
      if (
        upperType === 'USER_INPUT' ||
        upperType === 'CORTEX_STEP_TYPE_USER_INPUT' ||
        (line.userInput && typeof line.userInput === 'object')
      ) {
        syntheticSteps.push(line);
        continue;
      }

      if (line.metadata?.modelUsage) {
        syntheticSteps.push(line);
        modelOrdinal += 1;
        continue;
      }

      const hasTokenCounts =
        line.input_tokens !== undefined ||
        line.cache_read_tokens !== undefined ||
        line.output_tokens !== undefined;
      if (!hasTokenCounts) continue;

      const deepStep = extMatch?.steps?.[modelOrdinal] || null;
      modelOrdinal += 1;
      const isCheckpoint =
        upperType === 'CHECKPOINT' || upperType === 'CORTEX_STEP_TYPE_CHECKPOINT';
      const rawStatus = String(line.status || '').trim().toUpperCase();
      const mappedStatus = /CANCEL/.test(rawStatus)
        ? 'CORTEX_STEP_STATUS_CANCELED'
        : 'CORTEX_STEP_STATUS_DONE';
      const finishedAt = String(
        line.finished_generating_at ||
          line.finishedGeneratingAt ||
          line.completed_at ||
          line.completedAt ||
          ''
      ).trim();
      const modelKey =
        String(line.model || line.generator_model || deepStep?.modelKey || 'unknown').trim() ||
        'unknown';
      const responseModel = String(line.response_model || deepStep?.responseModel || '').trim();
      const apiProvider = String(line.api_provider || deepStep?.apiProvider || '').trim();
      const modelDisplayName = String(
        line.model_display_name || deepStep?.modelDisplayName || ''
      ).trim();
      const thinkingTokens = Number(line.thinking_tokens ?? deepStep?.thinkingTokens ?? 0) || 0;
      const responseTokens = line.response_tokens ?? deepStep?.responseTokens;

      syntheticSteps.push({
        type: isCheckpoint ? 'CORTEX_STEP_TYPE_CHECKPOINT' : rawType || 'PLANNER_RESPONSE',
        status: mappedStatus,
        plannerResponse: {
          response: typeof line.content === 'string' ? line.content : '',
          thinking: typeof line.thinking === 'string' ? line.thinking : '',
          toolCalls: Array.isArray(line.tool_calls) ? line.tool_calls : [],
          ...(thinkingTokens > 0 ? { thinkingTokens } : {}),
          ...(responseTokens !== undefined ? { responseTokens } : {}),
        },
        metadata: {
          createdAt: String(line.created_at || line.createdAt || deepStep?.createdAt || ''),
          ...(finishedAt ? { finishedGeneratingAt: finishedAt } : {}),
          sourceTrajectoryStepInfo: {
            stepIndex: Number.isFinite(Number(line.step_index)) ? Number(line.step_index) : rawIdx,
          },
          modelUsage: {
            model: modelKey,
            ...(responseModel ? { responseModel } : {}),
            ...(apiProvider ? { apiProvider } : {}),
            inputTokens: line.input_tokens ?? deepStep?.inputTokens ?? 0,
            cacheReadTokens: line.cache_read_tokens ?? deepStep?.cacheReadTokens ?? 0,
            outputTokens: line.output_tokens ?? deepStep?.outputTokens ?? 0,
            ...(thinkingTokens > 0 ? { thinkingOutputTokens: thinkingTokens } : {}),
            ...(responseTokens !== undefined ? { responseOutputTokens: responseTokens } : {}),
          },
          ...(modelDisplayName
            ? { generatorMetadata: [{ chatModel: { modelDisplayName } }] }
            : {}),
        },
      });
    }

    steps = syntheticSteps.length > 0 ? extractModelSteps(syntheticSteps, []) : [];
  }

  if (steps.length === 0 && Array.isArray(extMatch?.steps) && extMatch.steps.length > 0) {
    const extSynthetic = extMatch.steps.map((ds, idx) => ({
      type: 'PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        ...(ds.thinkingTokens > 0 ? { thinkingTokens: ds.thinkingTokens } : {}),
        ...(ds.responseTokens !== undefined ? { responseTokens: ds.responseTokens } : {}),
      },
      metadata: {
        createdAt: ds.createdAt || '',
        sourceTrajectoryStepInfo: { stepIndex: ds.stepIndex ?? idx + 1 },
        modelUsage: {
          model: ds.modelKey || 'unknown',
          ...(ds.responseModel ? { responseModel: ds.responseModel } : {}),
          ...(ds.apiProvider ? { apiProvider: ds.apiProvider } : {}),
          inputTokens: ds.inputTokens || 0,
          cacheReadTokens: ds.cacheReadTokens || 0,
          outputTokens: ds.outputTokens || 0,
          ...(ds.thinkingTokens > 0 ? { thinkingOutputTokens: ds.thinkingTokens } : {}),
          ...(ds.responseTokens !== undefined
            ? { responseOutputTokens: ds.responseTokens }
            : {}),
        },
        ...(ds.modelDisplayName
          ? { generatorMetadata: [{ chatModel: { modelDisplayName: ds.modelDisplayName } }] }
          : {}),
      },
    }));
    steps = extractModelSteps(extSynthetic, []);
  }

  const defaultShortId = cidLower.slice(0, 8);
  const nonShortTitle = (t) => {
    const clean = String(t || '').trim();
    return clean && clean.toLowerCase() !== defaultShortId ? clean : '';
  };
  const annotationTitle = nonShortTitle(readAnnotationTitleForCascade(cidLower));
  const summaryTitle = nonShortTitle(localSummary?.title);
  const currentTitle = nonShortTitle(conv.title);
  const extTitle = nonShortTitle(extMatch?.title);
  const resolvedTitle =
    annotationTitle ||
    summaryTitle ||
    currentTitle ||
    extTitle ||
    firstUserTitle ||
    String(conv.title || '').trim() ||
    conv.cascadeId.slice(0, 8);

  const parentConversationId = String(
    localSummary?.parentConversationId ||
      sqliteTraj?.parentConversationId ||
      conv.parentConversationId ||
      ''
  )
    .trim()
    .toLowerCase();
  const rawRootCid = String(sqliteTraj?.rootConversationId || conv.rootConversationId || '')
    .trim()
    .toLowerCase();
  const rootConversationId =
    rawRootCid && rawRootCid !== cidLower ? rawRootCid : parentConversationId;

  const lastStepMs = steps[steps.length - 1]?.createdAtMs || 0;
  return {
    steps,
    fromSqlite,
    title: resolvedTitle,
    accountName: extMatch?.accountName || '',
    appSource: inferConversationAppSource(diskFiles, extMatch),
    parentConversationId,
    rootConversationId,
    lastModifiedMs: Math.max(
      conv.lastModifiedMs || 0,
      localSummary?.lastModifiedMs || 0,
      extMatch?.lastModifiedMs || 0,
      lastStepMs
    ),
    subagentRefs: [],
  };
}

/**
 * `brain/<cascadeId>/.system_generated/logs/transcript.jsonl` 
 * `mtimeMs + size` 96KB 
 *
 * @param {string} cascadeId
 * @param {number} [maxLines=24]
 * @returns {object[]}
 */
function readTranscriptTailSteps(cascadeId, maxLines = 24) {
  if (!cascadeId) return [];
  const normId = String(cascadeId).trim().toLowerCase();
  if (!UUID_RE.test(normId)) return [];
  const transcriptPath = findTranscriptPath(normId);
  if (!transcriptPath) return [];
  try {
    const st = statSync(transcriptPath);
    const mtimeMs = Number(st?.mtimeMs || 0);
    const size = Number(st?.size || 0);
    const cached = transcriptTailMemo.get(normId);
    if (
      cached &&
      cached.path === transcriptPath &&
      cached.mtimeMs === mtimeMs &&
      cached.size === size &&
      size > 0
    ) {
      return cached.steps;
    }

    let raw = '';
    if (
      size > TRANSCRIPT_TAIL_MAX_BYTES &&
      typeof openSync === 'function' &&
      typeof readSync === 'function' &&
      typeof closeSync === 'function'
    ) {
      const fd = openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.allocUnsafe(TRANSCRIPT_TAIL_MAX_BYTES);
        const bytesRead = readSync(
          fd,
          buf,
          0,
          TRANSCRIPT_TAIL_MAX_BYTES,
          size - TRANSCRIPT_TAIL_MAX_BYTES
        );
        raw = buf.toString('utf8', 0, bytesRead);
        const trimmedRaw = raw.replace(/[\r\n]+$/, '');
        const firstNewline = trimmedRaw.indexOf('\n');
        if (firstNewline >= 0 && !trimmedRaw.trimStart().startsWith('{')) {
          raw = trimmedRaw.slice(firstNewline + 1);
        } else {
          raw = trimmedRaw;
        }
      } finally {
        try {
          closeSync(fd);
        } catch {
          
        }
      }
    } else {
      raw = readFileSync(transcriptPath, 'utf8');
    }

    if (typeof raw !== 'string' || !raw.trim()) {
      transcriptTailMemo.set(normId, { path: transcriptPath, mtimeMs, size, steps: [] });
      return [];
    }
    const lines = raw.trim().split(/\r?\n/);
    const tail = lines.slice(-maxLines);
    const steps = [];
    for (const line of tail) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          steps.push(parsed);
        }
      } catch {
        // JSON
      }
    }
    if (transcriptTailMemo.size >= MAX_TRANSCRIPT_MEMO_ENTRIES && !transcriptTailMemo.has(normId)) {
      const oldestKey = transcriptTailMemo.keys().next().value;
      if (oldestKey !== undefined) transcriptTailMemo.delete(oldestKey);
    }
    transcriptTailMemo.set(normId, { path: transcriptPath, mtimeMs, size, steps });
    return steps;
  } catch {
    return [];
  }
}

function scoreLiveActivitySpecificity(act) {
  if (!act || typeof act !== 'object') return 0;
  const sig = String(act.signature || '');
  if (sig.startsWith('compacting:') || sig.startsWith('compacting-done:')) {
    return 5;
  }
  if (
    sig.startsWith('planner-tool:') ||
    sig.startsWith('step-run:') ||
    sig.startsWith('pending-tool:')
  ) {
    return 4;
  }
  if (
    sig.startsWith('responding:') ||
    sig.startsWith('thinking:') ||
    sig.startsWith('responding-done:') ||
    sig.startsWith('thinking-done:')
  ) {
    return 3;
  }
  if (
    sig.startsWith('post-tool-think:') ||
    sig.startsWith('post-step-tool:')
  ) {
    return 2;
  }
  return 1;
}

function resolveBestLiveActivity(cascadeId, rpcRawSteps, isRunning, fallbackMs) {
  if (!isRunning) return null;
  const hasRpcSteps = Array.isArray(rpcRawSteps) && rpcRawSteps.length > 0;
  const rpcAct = hasRpcSteps ? extractLiveActivity(rpcRawSteps, true, fallbackMs) : null;
  const transcriptSteps = readTranscriptTailSteps(cascadeId);
  const transcriptAct =
    transcriptSteps.length > 0 ? extractLiveActivity(transcriptSteps, true, fallbackMs) : null;

  if (rpcAct && transcriptAct) {
    // 1. Cortex transcript.jsonl CHECKPOINT RPC
    const rpcStepIdx = getMaxMeaningfulStepIndex(rpcRawSteps);
    const transStepIdx = getMaxMeaningfulStepIndex(transcriptSteps);
    if (rpcStepIdx >= 0 && transStepIdx >= 0 && rpcStepIdx !== transStepIdx) {
      return rpcStepIdx > transStepIdx ? rpcAct : transcriptAct;
    }

    // 2. > > >
    const rpcScore = scoreLiveActivitySpecificity(rpcAct);
    const transScore = scoreLiveActivitySpecificity(transcriptAct);
    if (rpcScore !== transScore) {
      return rpcScore > transScore ? rpcAct : transcriptAct;
    }

    // 3. RPC transcript.jsonl
    const rpcMs = Number(rpcAct.startedAtMs || 0);
    const transMs = Number(transcriptAct.startedAtMs || 0);
    if (rpcAct.phase === 'compacting' && rpcMs !== transMs) {
      return rpcMs >= transMs ? rpcAct : transcriptAct;
    }
    return transcriptAct;
  }
  return (
    transcriptAct ||
    rpcAct ||
    liveActivityMemo.get(String(cascadeId || '').toLowerCase()) ||
    extractLiveActivity([], true, fallbackMs)
  );
}

/**
 * `subagentSpec` UI `typeName` `role` 
 * `initialPrompt` `trajectory_usage_cache.json` 
 *
 * @param {object|null|undefined} rawSpec
 * @returns {{ typeName: string, role: string } | null}
 */
function sanitizeSubagentSpec(rawSpec) {
  if (!rawSpec || typeof rawSpec !== 'object') return null;
  const typeName = String(rawSpec.typeName || '').trim();
  const role = String(rawSpec.role || '').trim();
  if (!typeName && !role) return null;
  return { typeName, role };
}

/**
 * `subagentSpec` `typeName` `role` 
 *
 * @param {object|null|undefined} primary
 * @param {object|null|undefined} secondary
 * @returns {{ typeName: string, role: string } | null}
 */
function mergeSubagentSpecs(primary, secondary) {
  const a = sanitizeSubagentSpec(primary);
  const b = sanitizeSubagentSpec(secondary);
  if (!a && !b) return null;
  return {
    typeName: a?.typeName || b?.typeName || '',
    role: a?.role || b?.role || '',
  };
}

/**
 * / (`CORTEX_STEP_TYPE_INVOKE_SUBAGENT`) 
 *
 * @param {object[]} [rawSteps=[]]
 * @returns {Array<{ cascadeId: string, role: string, typeName: string, createdTimeMs: number, spawnOrder: number }>}
 */
function extractSubagentRefsFromSteps(rawSteps = []) {
  const refsMap = new Map();
  let orderCounter = 0;
  for (const st of rawSteps || []) {
    const inv = st?.invokeSubagent;
    if (!inv) continue;
    let toolArgs = {};
    const argsJson = st?.metadata?.toolCall?.argumentsJson;
    if (typeof argsJson === 'string' && argsJson.trim()) {
      try {
        toolArgs = JSON.parse(argsJson);
      } catch {
        // JSON
      }
    }
    const subSpecs = Array.isArray(inv.subagents) ? inv.subagents : [];
    const results = Array.isArray(inv.results) ? inv.results : [];
    const createdTimeMs = parseIsoMs(st?.metadata?.createdAt) || 0;
    const count = Math.max(
      subSpecs.length,
      results.length,
      inv.conversationId || inv.subagentConversationId ? 1 : 0
    );
    for (let idx = 0; idx < count; idx++) {
      const resItem = results[idx] || {};
      const specItem = subSpecs[idx] || (subSpecs.length === 1 ? subSpecs[0] : {}) || {};
      const fallbackInvCid =
        idx === 0 || count === 1 ? inv.conversationId || inv.subagentConversationId || '' : '';
      const cid = String(
        resItem.conversationId ||
          resItem.subagentConversationId ||
          resItem.cascadeId ||
          specItem.conversationId ||
          specItem.subagentConversationId ||
          specItem.cascadeId ||
          fallbackInvCid
      )
        .trim()
        .toLowerCase();
      if (!cid) continue;
      const role = String(specItem.role || toolArgs.Role || toolArgs.role || '').trim();
      const typeName = String(
        specItem.typeName || toolArgs.TypeName || toolArgs.typeName || ''
      ).trim();
      const prev = refsMap.get(cid);
      refsMap.set(cid, {
        cascadeId: cid,
        role: role || prev?.role || '',
        typeName: typeName || prev?.typeName || '',
        createdTimeMs: createdTimeMs || prev?.createdTimeMs || 0,
        spawnOrder: prev ? prev.spawnOrder : orderCounter++,
      });
    }
  }
  return Array.from(refsMap.values());
}

/**
 * `GetCascadeTrajectory` `trajectory.metadata` 
 *
 * @param {object} trajRes
 * @param {object} [fallback={}]
 */
function extractTrajectorySubagentMeta(trajRes, fallback = {}) {
  const meta =
    trajRes?.trajectory?.metadata ||
    trajRes?.trajectory?.trajectoryMetadata ||
    trajRes?.trajectoryMetadata ||
    {};
  const parentConversationId = String(
    meta.parentConversationId || fallback.parentConversationId || ''
  )
    .trim()
    .toLowerCase();
  const rootConversationId = String(
    meta.rootConversationId || fallback.rootConversationId || parentConversationId || ''
  )
    .trim()
    .toLowerCase();
  const subagentSpec = mergeSubagentSpecs(meta.subagentSpec, fallback.subagentSpec);
  const agentScriptName = String(
    meta.agentScript?.name || fallback.agentScriptName || ''
  ).trim();
  const createdTimeMs =
    parseIsoMs(meta.createdAt || meta.createdTime) || fallback.createdTimeMs || 0;
  return {
    parentConversationId,
    rootConversationId,
    subagentSpec,
    agentScriptName,
    createdTimeMs,
  };
}

/**
 * LS `trajectorySummaries` `trajectoryCache` 
 * 4 
 *
 * @param {{
 * summariesObj?: Record<string, object>,
 * currentAccountName?: string|null,
 * requestedConvId?: string,
 * forceRefresh?: boolean
 * }} params
 * @returns {Promise<{
 * conversations: object[],
 * activeConvSummary: object|null,
 * activeCascadeId: string|null
 * }>}
 */
export async function enumerateAndSyncConversations({
  summariesObj = {},
  currentAccountName = '',
  requestedConvId = '',
  forceRefresh = false,
}) {
  const nowSweepMs = Date.now();
  if (forceRefresh) {
    failedFetchCooldownMap.clear();
  } else {
    for (const [k, rec] of failedFetchCooldownMap.entries()) {
      const failedAt = typeof rec === 'number' ? rec : rec?.failedAt || 0;
      const cooldownMs = typeof rec === 'number' ? FAILED_RPC_COOLDOWN_MS : rec?.cooldownMs || FAILED_RPC_COOLDOWN_MS;
      if (nowSweepMs - failedAt >= cooldownMs) {
        failedFetchCooldownMap.delete(k);
      }
    }
  }

  let cacheDirty = cacheState.needsSave;
  const diskConvMap = discoverLocalConversationFiles();

  // summariesObj RPC
  const canonicalIdByLower = new Map();
  const summariesByLower = new Map();
  for (const [rawId, summary] of Object.entries(summariesObj || {})) {
    const lower = String(rawId || '').trim().toLowerCase();
    if (!lower) continue;
    canonicalIdByLower.set(lower, rawId);
    summariesByLower.set(lower, summary);
  }

  for (const rawCacheKey of Object.keys(trajectoryCache)) {
    const lower = String(rawCacheKey || '').trim().toLowerCase();
    if (!lower) continue;
    const existingCanon = canonicalIdByLower.get(lower);
    if (!existingCanon) {
      // UUID
      const normalizedKey = UUID_RE.test(rawCacheKey) ? lower : rawCacheKey;
      if (normalizedKey !== rawCacheKey) {
        trajectoryCache[normalizedKey] = trajectoryCache[rawCacheKey];
        delete trajectoryCache[rawCacheKey];
        cacheDirty = true;
      }
      canonicalIdByLower.set(lower, normalizedKey);
    } else if (existingCanon !== rawCacheKey) {
      const targetEntry = trajectoryCache[existingCanon];
      const dupEntry = trajectoryCache[rawCacheKey];
      if (!targetEntry || (dupEntry?.steps?.length || 0) > (targetEntry?.steps?.length || 0)) {
        trajectoryCache[existingCanon] = dupEntry;
      }
      delete trajectoryCache[rawCacheKey];
      cacheDirty = true;
    }
  }

  for (const diskLowerId of diskConvMap.keys()) {
    if (!canonicalIdByLower.has(diskLowerId)) {
      canonicalIdByLower.set(diskLowerId, diskLowerId);
    }
  }

  // subagentRefs
  for (const entry of Object.values(trajectoryCache)) {
    if (
      entry?.accountName &&
      currentAccountName !== '' &&
      entry.accountName !== currentAccountName
    ) {
      continue;
    }
    for (const ref of entry?.subagentRefs || []) {
      const refCid = String(ref?.cascadeId || '').trim().toLowerCase();
      if (refCid && !canonicalIdByLower.has(refCid)) {
        canonicalIdByLower.set(refCid, refCid);
      }
    }
  }

  const localSummaryByLower = readLocalSummaryIndex();
  const STALE_LOCAL_RUNNING_MAX_AGE_MS = 10 * 60_000;
  const reqLower = String(requestedConvId || '').trim().toLowerCase();
  const rawConversations = [];
  for (const [cidLower, cascadeId] of canonicalIdByLower.entries()) {
    const item = summariesByLower.get(cidLower);
    const localSum = item ? null : localSummaryByLower.get(cidLower) || null;
    const cached = trajectoryCache[cascadeId];
    if (
      cached?.accountName &&
      currentAccountName !== '' &&
      cached.accountName !== currentAccountName
    ) {
      continue;
    }
    const lastModifiedTime = item?.lastModifiedTime || item?.createdTime || '';
    const summaryMtimeMs = parseIsoMs(lastModifiedTime);
    const diskMtimeMs = summaryMtimeMs ? null : readConversationMtime(diskConvMap.get(cidLower));
    const rawMeta = item?.trajectoryMetadata || item?.metadata || {};
    const parentConversationId = String(
      rawMeta.parentConversationId ||
        localSum?.parentConversationId ||
        cached?.parentConversationId ||
        ''
    ).toLowerCase();
    const rootConversationId = String(
      rawMeta.rootConversationId || cached?.rootConversationId || parentConversationId || ''
    ).toLowerCase();
    const localAgentSpec =
      parentConversationId && localSum?.agentName ? { role: localSum.agentName } : null;
    const subagentSpec = mergeSubagentSpecs(
      rawMeta.subagentSpec,
      mergeSubagentSpecs(localAgentSpec, cached?.subagentSpec)
    );
    const agentScriptName = rawMeta.agentScript?.name || cached?.agentScriptName || '';
    const createdTimeMs =
      parseIsoMs(item?.createdTime || rawMeta?.createdAt) || cached?.createdTimeMs || 0;
    const spawnOrder = Number.isFinite(cached?.spawnOrder) ? cached.spawnOrder : null;
    const subagentRefs = Array.isArray(cached?.subagentRefs) ? cached.subagentRefs : null;
    const isSubagent =
      Boolean(parentConversationId) ||
      Boolean(rootConversationId && rootConversationId !== cidLower);
    const latestLocalTouchMs = Math.max(diskMtimeMs || 0, localSum?.lastModifiedMs || 0);
    const localStatus =
      localSum?.status === 'CASCADE_RUN_STATUS_RUNNING' &&
      latestLocalTouchMs > 0 &&
      nowSweepMs - latestLocalTouchMs <= STALE_LOCAL_RUNNING_MAX_AGE_MS
        ? 'CASCADE_RUN_STATUS_RUNNING'
        : 'IDLE';

    if (item) {
      const lastModifiedMs =
        summaryMtimeMs || diskMtimeMs || cached?.lastModifiedMs || 0;
      const rawSummaryStepCount = Number(item?.stepCount || 0);
      const modelStepCount = Array.isArray(cached?.steps)
        ? cached.steps.length
        : rawSummaryStepCount;
      rawConversations.push({
        cascadeId,
        title:
          item?.annotations?.title || item?.summary || cached?.title || cascadeId.slice(0, 8),
        stepCount: modelStepCount,
        rawStepCount: rawSummaryStepCount,
        status: item?.status || '',
        lastModifiedTime,
        lastModifiedMs,
        diskMtimeMs,
        inSummaries: true,
        isSubagent,
        parentConversationId,
        rootConversationId,
        subagentSpec,
        agentScriptName,
        createdTimeMs,
        spawnOrder,
        subagentRefs,
      });
    } else if (cached) {
      const lastStepMs = cached.steps?.[cached.steps.length - 1]?.createdAtMs || 0;
      const cachedStepCount = Number(cached.steps?.length || 0);
      rawConversations.push({
        cascadeId,
        title: localSum?.title || cached.title || cascadeId.slice(0, 8),
        stepCount: cachedStepCount,
        rawStepCount: localSum?.stepCount || cachedStepCount,
        status: localStatus,
        lastModifiedTime: localSum?.lastModifiedTime || '',
        lastModifiedMs: Math.max(
          cached.lastModifiedMs || 0,
          lastStepMs,
          diskMtimeMs || 0,
          localSum?.lastModifiedMs || 0
        ),
        diskMtimeMs,
        inSummaries: false,
        isSubagent,
        parentConversationId,
        rootConversationId,
        subagentSpec,
        agentScriptName,
        createdTimeMs,
        spawnOrder,
        subagentRefs,
      });
    } else {
      rawConversations.push({
        cascadeId,
        title: localSum?.title || cascadeId.slice(0, 8),
        stepCount: 0,
        rawStepCount: localSum?.stepCount || 0,
        status: localStatus,
        lastModifiedTime: localSum?.lastModifiedTime || '',
        lastModifiedMs: Math.max(diskMtimeMs || 0, localSum?.lastModifiedMs || 0),
        diskMtimeMs,
        inSummaries: false,
        needsInitialLoad: true,
        isSubagent,
        parentConversationId,
        rootConversationId,
        subagentSpec,
        agentScriptName,
        createdTimeMs,
        spawnOrder: null,
        subagentRefs: null,
      });
    }
  }

  rawConversations.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  const attemptedFetchIds = new Set();
  const nowPollMs = Date.now();

  function buildConvSig(conv) {
    return conv.inSummaries
      ? `${CACHE_SCHEMA_VERSION}:${conv.rawStepCount ?? conv.stepCount}:${conv.lastModifiedTime}`
      : `${CACHE_SCHEMA_VERSION}:disk:${Math.floor(conv.diskMtimeMs || conv.lastModifiedMs || 0)}`;
  }

  function isFetchInCooldown(conv, sig) {
    if (forceRefresh) return false;
    const key = `${conv.cascadeId.toLowerCase()}::${sig}`;
    const rec = failedFetchCooldownMap.get(key);
    if (!rec) return false;
    const failedAt = typeof rec === 'number' ? rec : rec.failedAt;
    const cooldownMs = typeof rec === 'number' ? FAILED_RPC_COOLDOWN_MS : rec.cooldownMs;
    if (nowPollMs - failedAt >= cooldownMs) {
      failedFetchCooldownMap.delete(key);
      return false;
    }
    return true;
  }

  /**
 * 10 `toolResultsTokens` 
 */
  function hasMissingStepFields(cached) {
    const steps = cached?.steps || [];
    const lastCachedStep = steps[steps.length - 1];
    if (!lastCachedStep) return false;
    if (!Object.prototype.hasOwnProperty.call(lastCachedStep, 'contextBreakdown')) {
      return true;
    }
    const { missingResponseModel, missingToolResultsTokens } = readStepFieldChecks(steps);
    return missingResponseModel || missingToolResultsTokens;
  }

  function readStepFieldChecks(steps) {
    const known = stepFieldChecks.get(steps);
    if (known) return known;
    let missingToolResultsTokens = false;
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i]?.contextBreakdown) {
        missingToolResultsTokens = !Object.prototype.hasOwnProperty.call(
          steps[i].contextBreakdown,
          'toolResultsTokens'
        );
        break;
      }
    }
    const checks = {
      missingResponseModel: steps.some((s) => !Object.prototype.hasOwnProperty.call(s, 'responseModel')),
      missingToolResultsTokens,
      hasIncompleteTiming: steps.some((s) => s.speedReason === 'incomplete_or_invalid_timing'),
    };
    stepFieldChecks.set(steps, checks);
    return checks;
  }

  let lazyExternalByLower = null;

  /**
 * (`trajectory.metadata`) (`invokeSubagent`) 
 *
 * @param {object[]} targetConvs
 */
  async function fetchTrajectoryBatch(targetConvs) {
    for (const c of targetConvs) {
      attemptedFetchIds.add(c.cascadeId.toLowerCase());
    }
    for (let i = 0; i < targetConvs.length; i += MAX_CONCURRENT_RPC) {
      const batch = targetConvs.slice(i, i + MAX_CONCURRENT_RPC);
      await Promise.all(
        batch.map(async (conv) => {
          const sig = buildConvSig(conv);
          const cooldownKey = `${conv.cascadeId.toLowerCase()}::${sig}`;
          const isRunning = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
          const isReq = Boolean(reqLower && conv.cascadeId.toLowerCase() === reqLower);
          const prev = trajectoryCache[conv.cascadeId];
          let partialTailSteps = [];
          let hasTailStepInfo = false;
          try {
            const cidLowerRpc = conv.cascadeId.toLowerCase();
            let rawSteps = null;
            let generatorMeta = null;
            let trajRes = null;
            const memEntry = runningRawTrajectoryCache.get(cidLowerRpc);
            const expectedSteps = Number(conv.rawStepCount || 0);
            if (isRunning && memEntry && expectedSteps >= 80 && !forceRefresh) {
              const stepOffset = Math.max(0, memEntry.rawSteps.length - 4);
              const genMetaOffset = Math.max(0, memEntry.generatorMetadata.length - 4);
              const [stepsRes, genRes] = await Promise.all([
                callLsRpc('GetCascadeTrajectorySteps', { cascadeId: conv.cascadeId, stepOffset }, 3000).catch(() => null),
                callLsRpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: conv.cascadeId, generatorMetadataOffset: genMetaOffset }, 3000).catch(() => null),
              ]);
              if (Array.isArray(stepsRes?.steps) && Array.isArray(genRes?.generatorMetadata)) {
                const merged = applyIncrementalTrajectoryDelta(
                  memEntry,
                  stepOffset,
                  stepsRes.steps,
                  genMetaOffset,
                  genRes.generatorMetadata,
                  expectedSteps
                );
                if (merged) {
                  rawSteps = merged.rawSteps;
                  generatorMeta = merged.generatorMetadata;
                  trajRes = { trajectory: { metadata: memEntry.metadata || {} } };
                  memEntry.rawSteps = rawSteps;
                  memEntry.generatorMetadata = generatorMeta;
                  memEntry.lastRpcAtMs = nowPollMs;
                }
              }
            }
            if (!rawSteps) {
              trajRes = await callLsRpc('GetCascadeTrajectory', { cascadeId: conv.cascadeId });
              if (!Array.isArray(trajRes?.trajectory?.steps)) {
                throw new Error('Trajectory steps unavailable');
              }
              rawSteps = trajRes.trajectory.steps;
              if (Number(trajRes.numTotalSteps) > rawSteps.length) {
                if (rawSteps.length > 0) {
                  partialTailSteps = rawSteps;
                  const tailIdx =
                    rawSteps[rawSteps.length - 1]?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
                  hasTailStepInfo = Number.isFinite(Number(tailIdx));
                }
                throw new Error('Incomplete trajectory; retaining cached usage');
              }
              generatorMeta = trajRes?.trajectory?.generatorMetadata || [];
              if (isRunning) {
                if (runningRawTrajectoryCache.size >= MAX_INCREMENTAL_CACHE_ENTRIES && !runningRawTrajectoryCache.has(cidLowerRpc)) {
                  const oldestKey = runningRawTrajectoryCache.keys().next().value;
                  if (oldestKey !== undefined) runningRawTrajectoryCache.delete(oldestKey);
                }
                runningRawTrajectoryCache.set(cidLowerRpc, {
                  rawSteps,
                  generatorMetadata: generatorMeta,
                  metadata: trajRes?.trajectory?.metadata || trajRes?.trajectory?.trajectoryMetadata || {},
                  lastRpcAtMs: nowPollMs,
                });
              } else {
                runningRawTrajectoryCache.delete(cidLowerRpc);
              }
            } else if (!isRunning) {
              runningRawTrajectoryCache.delete(cidLowerRpc);
            }
            failedFetchCooldownMap.delete(cooldownKey);
            const steps = extractModelSteps(rawSteps, generatorMeta);
            const nextLast = steps[steps.length - 1];

            
            const extractedMeta = extractTrajectorySubagentMeta(trajRes, conv);
            conv.parentConversationId = extractedMeta.parentConversationId;
            conv.rootConversationId = extractedMeta.rootConversationId;
            conv.subagentSpec = extractedMeta.subagentSpec;
            conv.agentScriptName = extractedMeta.agentScriptName;
            conv.createdTimeMs = extractedMeta.createdTimeMs;
            conv.isSubagent =
              Boolean(conv.parentConversationId) ||
              Boolean(
                conv.rootConversationId &&
                  conv.rootConversationId !== conv.cascadeId.toLowerCase()
              );

            const subagentRefs = extractSubagentRefsFromSteps(rawSteps);
            conv.subagentRefs = subagentRefs;

            const lastStepMs = nextLast?.createdAtMs || 0;
            const resolvedLastModMs = Math.max(conv.lastModifiedMs || 0, lastStepMs);
            conv.lastModifiedMs = resolvedLastModMs;
            conv.stepCount = steps.length;

            const liveAct = resolveBestLiveActivity(
              conv.cascadeId,
              rawSteps,
              isRunning,
              resolvedLastModMs || conv.createdTimeMs || 0
            );
            if (liveAct) {
              conv.liveActivity = liveAct;
              liveActivityMemo.set(conv.cascadeId.toLowerCase(), liveAct);
            } else {
              conv.liveActivity = null;
              liveActivityMemo.delete(conv.cascadeId.toLowerCase());
            }

            const cacheEntry = {
              signature: sig,
              accountName: prev?.accountName || currentAccountName || '',
              title: conv.title,
              lastModifiedMs: resolvedLastModMs,
              diskMtimeMs:
                conv.diskMtimeMs ?? readConversationMtime(diskConvMap.get(conv.cascadeId.toLowerCase())),
              wasRunning: isRunning,
              contextLimitTelemetry: true,
              speedClearedTelemetry: true,
              turnRailTelemetry: true,
              contextGroupsTelemetry: true,
              steps,
              subagentRefs,
            };
            if (conv.isSubagent) {
              cacheEntry.parentConversationId = conv.parentConversationId;
              cacheEntry.rootConversationId = conv.rootConversationId;
              if (conv.subagentSpec) cacheEntry.subagentSpec = conv.subagentSpec;
              if (conv.agentScriptName) cacheEntry.agentScriptName = conv.agentScriptName;
              if (conv.createdTimeMs) cacheEntry.createdTimeMs = conv.createdTimeMs;
              if (Number.isFinite(conv.spawnOrder)) cacheEntry.spawnOrder = conv.spawnOrder;
            }

            const metaChanged =
              !Array.isArray(prev?.subagentRefs) ||
              JSON.stringify(prev?.subagentRefs) !== JSON.stringify(subagentRefs) ||
              (prev?.rootConversationId || '') !== (cacheEntry.rootConversationId || '');
            const stepsChanged =
              !prev ||
              Boolean(prev.offlineTranscriptFallback) ||
              prev.signature !== sig ||
              Boolean(prev.wasRunning) !== isRunning ||
              !prev.contextLimitTelemetry ||
              !prev.speedClearedTelemetry ||
              !prev.turnRailTelemetry ||
              !prev.contextGroupsTelemetry ||
              metaChanged ||
              !isDeepStrictEqual(prev.steps, steps);

            if (!stepsChanged) cacheEntry.steps = prev.steps;
            trajectoryCache[conv.cascadeId] = cacheEntry;
            if (stepsChanged) {
              cacheDirty = true;
            }
          } catch (err) {
            let offlineRecovered = false;
            if (!conv.inSummaries && (!prev || prev.offlineTranscriptFallback)) {
              if (!lazyExternalByLower) {
                lazyExternalByLower = new Map();
                for (const ext of loadExternalDeepStatsCache().values()) {
                  const extCid = String(ext?.cascadeId || '').toLowerCase();
                  if (!extCid) continue;
                  if (
                    ext.accountName &&
                    currentAccountName !== '' &&
                    ext.accountName !== currentAccountName
                  ) {
                    continue;
                  }
                  const existingExt = lazyExternalByLower.get(extCid);
                  if (!existingExt || (ext.steps?.length || 0) > (existingExt.steps?.length || 0)) {
                    lazyExternalByLower.set(extCid, ext);
                  }
                }
              }
              const cidLower = conv.cascadeId.toLowerCase();
              const diskFiles = diskConvMap.get(cidLower) || [];
              const offlineFallback = loadOfflineTranscriptConversation(
                conv,
                diskFiles,
                lazyExternalByLower,
                localSummaryByLower.get(cidLower) || null
              );
              if (offlineFallback) {
                offlineRecovered = true;
                conv.title = offlineFallback.title;
                conv.lastModifiedMs = offlineFallback.lastModifiedMs;
                conv.stepCount = offlineFallback.steps.length;
                conv.subagentRefs = offlineFallback.subagentRefs;
                if (offlineFallback.parentConversationId) {
                  conv.parentConversationId = offlineFallback.parentConversationId;
                }
                if (offlineFallback.rootConversationId) {
                  conv.rootConversationId = offlineFallback.rootConversationId;
                }
                conv.isSubagent =
                  Boolean(conv.parentConversationId) ||
                  Boolean(conv.rootConversationId && conv.rootConversationId !== cidLower);
                const resolvedDiskMtime = conv.diskMtimeMs ?? readConversationMtime(diskFiles);
                const offlineEntry = {
                  signature: sig,
                  accountName:
                    prev?.accountName || offlineFallback.accountName || currentAccountName || '',
                  title: offlineFallback.title,
                  ...(offlineFallback.appSource ? { appSource: offlineFallback.appSource } : {}),
                  lastModifiedMs: offlineFallback.lastModifiedMs,
                  diskMtimeMs: resolvedDiskMtime,
                  wasRunning: isRunning,
                  offlineTranscriptFallback: true,
                  ...(offlineFallback.fromSqlite ? { offlineSqliteTelemetry: true } : {}),
                  contextLimitTelemetry: true,
                  speedClearedTelemetry: true,
                  turnRailTelemetry: true,
                  contextGroupsTelemetry: true,
                  steps: offlineFallback.steps,
                  subagentRefs: offlineFallback.subagentRefs,
                };
                if (conv.isSubagent) {
                  offlineEntry.parentConversationId = conv.parentConversationId;
                  offlineEntry.rootConversationId = conv.rootConversationId;
                  if (conv.subagentSpec) offlineEntry.subagentSpec = conv.subagentSpec;
                  if (conv.agentScriptName) offlineEntry.agentScriptName = conv.agentScriptName;
                  if (conv.createdTimeMs) offlineEntry.createdTimeMs = conv.createdTimeMs;
                  if (Number.isFinite(conv.spawnOrder)) offlineEntry.spawnOrder = conv.spawnOrder;
                }
                const changed =
                  !prev ||
                  prev.signature !== sig ||
                  prev.title !== offlineEntry.title ||
                  Boolean(prev.wasRunning) !== isRunning ||
                  Boolean(prev.offlineSqliteTelemetry) !== Boolean(offlineEntry.offlineSqliteTelemetry) ||
                  !isDeepStrictEqual(prev.steps, offlineEntry.steps);
                if (!changed) offlineEntry.steps = prev.steps;
                trajectoryCache[conv.cascadeId] = offlineEntry;
                if (changed) {
                  cacheDirty = true;
                }
              }
            }
            if (
              !offlineRecovered &&
              !(
                !conv.inSummaries &&
                /(?:\(404\)|\bnot_found\b|Language Server address unavailable)/i.test(
                  String(err?.message || '')
                )
              )
            ) {
              console.error(`Failed loading trajectory ${conv.cascadeId}: ${err.message}`);
            }
            if (!(isRunning && (hasTailStepInfo || offlineRecovered))) {
              const cooldownMs =
                isRunning || isReq ? ACTIVE_FAILED_RPC_COOLDOWN_MS : FAILED_RPC_COOLDOWN_MS;
              failedFetchCooldownMap.set(cooldownKey, { failedAt: nowPollMs, cooldownMs });
            }
            if (!isRunning) {
              liveActivityMemo.delete(conv.cascadeId.toLowerCase());
            } else {
              const fallbackLive = resolveBestLiveActivity(
                conv.cascadeId,
                partialTailSteps,
                true,
                conv.lastModifiedMs || conv.createdTimeMs || 0
              );
              conv.liveActivity = fallbackLive;
              if (fallbackLive) {
                liveActivityMemo.set(conv.cascadeId.toLowerCase(), fallbackLive);
              }
            }
            if (
              !offlineRecovered &&
              prev &&
              String(prev.signature || '').startsWith(`${CACHE_SCHEMA_VERSION}:`) &&
              !Array.isArray(prev.subagentRefs)
            ) {
              prev.subagentRefs = [];
              cacheDirty = true;
            }
          }
        })
      );
    }
  }

  // 1 / subagentRefs
  
  const contextTelemetryCascadeId = reqLower || rawConversations[0]?.cascadeId.toLowerCase();
  const selectedRootId = rawConversations.find(
    (c) => c.cascadeId.toLowerCase() === contextTelemetryCascadeId
  )?.rootConversationId || contextTelemetryCascadeId;
  function hasMissingTurnRailFields(cached) {
    const steps = cached?.steps || [];
    const lastCachedStep = steps[steps.length - 1];
    if (!lastCachedStep) return false;
    return !Object.prototype.hasOwnProperty.call(lastCachedStep, 'turnIndex');
  }
  function hasDroppedContextGroups(cached) {
    if (cached?.contextGroupsTelemetry) return false;
    const steps = cached?.steps || [];
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      if (!st || st.isCompactionStep) break;
      if (st.contextBreakdown) {
        const cb = st.contextBreakdown;
        const cbSum =
          Number(cb.totalTokens || 0) ||
          Number(cb.messagesTokens || 0) +
            Number(cb.systemToolsTokens || 0) +
            Number(cb.mcpToolsTokens || 0) +
            Number(cb.skillsTokens || 0) +
            Number(cb.systemPromptTokens || 0) +
            Number(cb.userRulesTokens || 0);
        return Number(st.estimatedContextTokens || 0) > cbSum;
      }
    }
    return false;
  }

  let remainingTimingRefreshes = LEGACY_MIGRATION_BATCH_SIZE;
  const toFetch = rawConversations.filter((conv) => {
    const sig = buildConvSig(conv);
    if (isFetchInCooldown(conv, sig)) return false;
    const isRunning = conv.status === 'CASCADE_RUN_STATUS_RUNNING';
    const cached = trajectoryCache[conv.cascadeId];
    if (!cached || conv.needsInitialLoad) return true;
    const lowerCid = conv.cascadeId.toLowerCase();
    const isSelectedFamily =
      lowerCid === contextTelemetryCascadeId ||
      lowerCid === selectedRootId ||
      Boolean(conv.rootConversationId && conv.rootConversationId.toLowerCase() === selectedRootId);
    if (!cached.contextLimitTelemetry && lowerCid === contextTelemetryCascadeId) return true;
    if (
      (!cached.turnRailTelemetry ||
        hasMissingTurnRailFields(cached) ||
        hasDroppedContextGroups(cached)) &&
      isSelectedFamily
    ) {
      return true;
    }
    const hasCurrentSchema = String(cached.signature || '').startsWith(
      `${CACHE_SCHEMA_VERSION}:`
    );
    if (!hasCurrentSchema) return true;
    if (hasMissingStepFields(cached)) return true;
    const missingSubagentRefs = !Array.isArray(cached.subagentRefs);
    if (!conv.inSummaries) {
      if (isRunning || cached.wasRunning) return true;
      if (
        cached.offlineTranscriptFallback &&
        !cached.offlineSqliteTelemetry &&
        hasBuiltinNodeSqlite() &&
        hasLocalSqliteDb(diskConvMap.get(lowerCid))
      ) {
        return true;
      }
      const localSum = localSummaryByLower.get(lowerCid);
      if (cached.offlineTranscriptFallback && localSum?.title && cached.title !== localSum.title) {
        return true;
      }
      if (missingSubagentRefs && lowerCid === reqLower) {
        return true;
      }
      if (
        conv.diskMtimeMs > 0 &&
        conv.diskMtimeMs > (cached.diskMtimeMs || cached.lastModifiedMs || 0)
      ) return true;
    } else {
      if (
        cached.offlineTranscriptFallback ||
        missingSubagentRefs ||
        cached.signature !== sig ||
        (!isRunning && cached.wasRunning)
      ) {
        return true;
      }
      if (isRunning) {
        if (!cached.wasRunning) return true;
        const lastRpcAt = runningRawTrajectoryCache.get(lowerCid)?.lastRpcAtMs || 0;
        if (nowPollMs - lastRpcAt >= RUNNING_TRAJECTORY_SKIP_MS) {
          return true;
        }
      }
    }
    
    if (!cached.speedClearedTelemetry && readStepFieldChecks(cached.steps).hasIncompleteTiming) {
      if (conv.cascadeId.toLowerCase() === selectedRootId || conv.rootConversationId === selectedRootId) return true;
      if (remainingTimingRefreshes > 0) {
        remainingTimingRefreshes -= 1;
        return true;
      }
    }
    return false;
  });

  await fetchTrajectoryBatch(toFetch);

  /**
 * 2 `subagentRefs` 
 * -> -> 
 */
  async function reconcileParentSubagentRefs() {
    for (let depth = 0; depth < MAX_SUBAGENT_RECONCILE_DEPTH; depth++) {
      const byLowerId = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
      const missingSubagentsToFetch = [];

      for (const parentConv of [...rawConversations]) {
        const parentCached = trajectoryCache[parentConv.cascadeId];
        const refs = parentConv.subagentRefs || parentCached?.subagentRefs || [];
        if (!Array.isArray(refs) || refs.length === 0) continue;

        const parentId = parentConv.cascadeId.toLowerCase();
        const rootId = (
          parentConv.rootConversationId ||
          parentConv.parentConversationId ||
          parentId
        ).toLowerCase();

        for (const ref of refs) {
          const subCid = String(ref?.cascadeId || '').trim().toLowerCase();
          if (!subCid || subCid === parentId) continue;

          const canonSubId = canonicalIdByLower.get(subCid) || subCid;
          canonicalIdByLower.set(subCid, canonSubId);
          let subConv = byLowerId.get(subCid);
          const subCached = trajectoryCache[subConv?.cascadeId || canonSubId];
          if (!subConv) {
            const diskMtimeMs = readConversationMtime(diskConvMap.get(subCid));
            const lastStepMs = subCached?.steps?.[subCached.steps.length - 1]?.createdAtMs || 0;
            const stepCount = Number(subCached?.steps?.length || 0);
            subConv = {
              cascadeId: canonSubId,
              title: ref.role || subCached?.title || canonSubId.slice(0, 8),
              stepCount,
              rawStepCount: stepCount,
              status: 'IDLE',
              lastModifiedTime: '',
              lastModifiedMs: Math.max(
                subCached?.lastModifiedMs || 0,
                lastStepMs,
                diskMtimeMs,
                ref.createdTimeMs || 0
              ),
              diskMtimeMs,
              inSummaries: false,
              needsInitialLoad: !subCached,
              isSubagent: true,
              parentConversationId: parentId,
              rootConversationId: rootId,
              subagentSpec: mergeSubagentSpecs(ref, subCached?.subagentSpec),
              agentScriptName: subCached?.agentScriptName || '',
              createdTimeMs: ref.createdTimeMs || subCached?.createdTimeMs || 0,
              spawnOrder: Number.isFinite(ref.spawnOrder) ? ref.spawnOrder : null,
              subagentRefs: Array.isArray(subCached?.subagentRefs) ? subCached.subagentRefs : null,
            };
            rawConversations.push(subConv);
            byLowerId.set(subCid, subConv);
          } else {
            subConv.isSubagent = true;
            subConv.parentConversationId = subConv.parentConversationId || parentId;
            subConv.rootConversationId = subConv.rootConversationId || rootId;
            subConv.subagentSpec = mergeSubagentSpecs(subConv.subagentSpec, ref);
            if (ref.createdTimeMs && !subConv.createdTimeMs) {
              subConv.createdTimeMs = ref.createdTimeMs;
            }
            if (Number.isFinite(ref.spawnOrder) && !Number.isFinite(subConv.spawnOrder)) {
              subConv.spawnOrder = ref.spawnOrder;
            }
            if (Array.isArray(subCached?.steps)) {
              subConv.stepCount = subCached.steps.length;
            }
          }

          const targetCacheKey = subConv.cascadeId;
          const existingSubCache = trajectoryCache[targetCacheKey];
          const isSelectedSubFamily = rootId === selectedRootId;
          const hasValidSubCache =
            existingSubCache &&
            !(existingSubCache.offlineTranscriptFallback && subConv.inSummaries) &&
            String(existingSubCache.signature || '').startsWith(`${CACHE_SCHEMA_VERSION}:`) &&
            !hasMissingStepFields(existingSubCache) &&
            (!isSelectedSubFamily ||
              (Boolean(existingSubCache.turnRailTelemetry) &&
                !hasMissingTurnRailFields(existingSubCache) &&
                !hasDroppedContextGroups(existingSubCache)));

          if (hasValidSubCache) {
            let subMetaUpdated = false;
            if (existingSubCache.parentConversationId !== subConv.parentConversationId) {
              existingSubCache.parentConversationId = subConv.parentConversationId;
              subMetaUpdated = true;
            }
            if (existingSubCache.rootConversationId !== subConv.rootConversationId) {
              existingSubCache.rootConversationId = subConv.rootConversationId;
              subMetaUpdated = true;
            }
            const nextSpec = sanitizeSubagentSpec(subConv.subagentSpec);
            if (
              nextSpec &&
              JSON.stringify(existingSubCache.subagentSpec || null) !== JSON.stringify(nextSpec)
            ) {
              existingSubCache.subagentSpec = nextSpec;
              subMetaUpdated = true;
            }
            if (
              subConv.createdTimeMs &&
              existingSubCache.createdTimeMs !== subConv.createdTimeMs
            ) {
              existingSubCache.createdTimeMs = subConv.createdTimeMs;
              subMetaUpdated = true;
            }
            if (
              Number.isFinite(subConv.spawnOrder) &&
              existingSubCache.spawnOrder !== subConv.spawnOrder
            ) {
              existingSubCache.spawnOrder = subConv.spawnOrder;
              subMetaUpdated = true;
            }
            if (!Array.isArray(existingSubCache.subagentRefs)) {
              existingSubCache.subagentRefs = [];
              subMetaUpdated = true;
            }
            if (subMetaUpdated) {
              cacheDirty = true;
            }
          } else {
            const subSig = buildConvSig(subConv);
            if (!attemptedFetchIds.has(subCid) && !isFetchInCooldown(subConv, subSig)) {
              missingSubagentsToFetch.push(subConv);
            }
          }
        }
      }

      if (missingSubagentsToFetch.length === 0) break;
      await fetchTrajectoryBatch(missingSubagentsToFetch);
    }
  }

  await reconcileParentSubagentRefs();

  // 3 subagentRefs 8
  const remainingLegacyDiskConvs = rawConversations
    .filter((c) => {
      const sig = buildConvSig(c);
      if (attemptedFetchIds.has(c.cascadeId.toLowerCase()) || isFetchInCooldown(c, sig)) {
        return false;
      }
      const cached = trajectoryCache[c.cascadeId];
      return cached && !Array.isArray(cached.subagentRefs);
    })
    .slice(0, LEGACY_MIGRATION_BATCH_SIZE);

  if (remainingLegacyDiskConvs.length > 0) {
    await fetchTrajectoryBatch(remainingLegacyDiskConvs);
    await reconcileParentSubagentRefs();
  }

  // 4 rootConversationId
  const byId = new Map(rawConversations.map((c) => [c.cascadeId.toLowerCase(), c]));
  for (const conv of rawConversations) {
    if (!conv.isSubagent) continue;
    const cid = conv.cascadeId.toLowerCase();
    let candidate = (conv.rootConversationId || conv.parentConversationId || '').toLowerCase();
    const visited = new Set([cid]);
    while (candidate && !visited.has(candidate)) {
      visited.add(candidate);
      const ancestor = byId.get(candidate);
      if (!ancestor || !ancestor.isSubagent) break;
      const nextUp = (
        ancestor.parentConversationId ||
        ancestor.rootConversationId ||
        ''
      ).toLowerCase();
      if (!nextUp || nextUp === candidate) break;
      candidate = nextUp;
    }
    if (candidate && candidate !== conv.rootConversationId) {
      conv.rootConversationId = candidate;
      const cached = trajectoryCache[conv.cascadeId];
      if (cached && cached.rootConversationId !== candidate) {
        cached.rootConversationId = candidate;
        cacheDirty = true;
      }
    }
  }

  if (cacheDirty) {
    const anyRunning = rawConversations.some((c) => c.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (forceRefresh || !anyRunning || nowPollMs - lastCacheDiskFlushMs >= ACTIVE_CACHE_FLUSH_INTERVAL_MS) {
      cacheState.needsSave = !saveJson(CACHE_FILE, trajectoryCache);
      if (!cacheState.needsSave) {
        lastCacheDiskFlushMs = nowPollMs;
      }
    } else {
      cacheState.needsSave = true;
    }
  }

  // RUNNING RPC
  for (const conv of rawConversations) {
    if (conv.status === 'CASCADE_RUN_STATUS_RUNNING') {
      if (!conv.liveActivity) {
        const fallbackMs = conv.lastModifiedMs || conv.createdTimeMs || 0;
        const resolved = resolveBestLiveActivity(conv.cascadeId, [], true, fallbackMs);
        conv.liveActivity = resolved;
        if (resolved) {
          liveActivityMemo.set(conv.cascadeId.toLowerCase(), resolved);
        }
      }
    } else {
      conv.liveActivity = null;
      liveActivityMemo.delete(conv.cascadeId.toLowerCase());
    }
  }

  // rootConversationId
  const subagentsByRoot = new Map();
  const conversations = [];

  for (const conv of rawConversations) {
    const cid = conv.cascadeId.toLowerCase();
    const rootId = (conv.rootConversationId || conv.parentConversationId || '').toLowerCase();
    const rootTarget = byId.get(rootId);
    if (conv.isSubagent) {
      if (rootId && rootId !== cid && rootTarget && !rootTarget.isSubagent) {
        if (!subagentsByRoot.has(rootId)) {
          subagentsByRoot.set(rootId, []);
        }
        subagentsByRoot.get(rootId).push(conv);
      }
    } else {
      conversations.push(conv);
    }
  }

  for (const rootConv of conversations) {
    const cid = rootConv.cascadeId.toLowerCase();
    const subs = subagentsByRoot.get(cid) || [];
    subs.sort((a, b) => {
      if (
        a.parentConversationId === b.parentConversationId &&
        Number.isFinite(a.spawnOrder) &&
        Number.isFinite(b.spawnOrder) &&
        a.spawnOrder !== b.spawnOrder
      ) {
        return a.spawnOrder - b.spawnOrder;
      }
      const aStart =
        a.createdTimeMs ||
        trajectoryCache[a.cascadeId]?.steps?.[0]?.createdAtMs ||
        a.lastModifiedMs ||
        0;
      const bStart =
        b.createdTimeMs ||
        trajectoryCache[b.cascadeId]?.steps?.[0]?.createdAtMs ||
        b.lastModifiedMs ||
        0;
      return aStart - bStart || String(a.cascadeId).localeCompare(String(b.cascadeId));
    });
    rootConv.subagents = subs;
    rootConv.subagentCount = subs.length;
    rootConv.totalStepCount =
      Number(rootConv.stepCount || 0) +
      subs.reduce((sum, s) => sum + Number(s.stepCount || 0), 0);
    const maxSubModMs = subs.reduce((m, s) => Math.max(m, s.lastModifiedMs || 0), 0);
    rootConv.groupLastModifiedMs = Math.max(rootConv.lastModifiedMs || 0, maxSubModMs);
  }

  conversations.sort(
    (a, b) =>
      (b.groupLastModifiedMs || b.lastModifiedMs || 0) -
      (a.groupLastModifiedMs || a.lastModifiedMs || 0)
  );

  const isNewChatReq = reqLower === '__new__';
  const matchedReqConv =
    reqLower && !isNewChatReq
      ? conversations.find((c) => c.cascadeId.toLowerCase() === reqLower) ||
        conversations.find((c) =>
          (c.subagents || []).some((s) => s.cascadeId.toLowerCase() === reqLower)
        ) ||
        null
      : null;
  const hasExplicitUnknownUuid = Boolean(reqLower && UUID_RE.test(reqLower) && !matchedReqConv);
  const activeConvSummary =
    isNewChatReq || hasExplicitUnknownUuid ? null : matchedReqConv || conversations[0] || null;
  const requestedOwner = trajectoryCache[canonicalIdByLower.get(reqLower)]?.accountName;
  const safeReqId =
    !isNewChatReq &&
    requestedConvId &&
    !/[\\/]|\.\./.test(String(requestedConvId)) &&
    (!requestedOwner || currentAccountName === '' || requestedOwner === currentAccountName)
      ? requestedConvId
      : null;
  const activeCascadeId = isNewChatReq ? '' : activeConvSummary?.cascadeId || safeReqId || null;

  return {
    conversations,
    activeConvSummary,
    activeCascadeId,
  };
}
