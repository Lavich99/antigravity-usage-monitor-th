/**
 * @fileoverview Antigravity CLI / Desktop SQLite Protobuf 
 *
 * `agy` CLI Language Server `daemon/hub_*.json` LS 
 * `~/.gemini/antigravity-cli` 
 * 1. `<product>/annotations/<cascadeId>.pbtxt` UTF-8 / 
 * 2. Node 22.5+ `node:sqlite` `<product>/conversation_summaries.db` 
 * 3. `<product>/conversations/<cascadeId>.db` `steps.metadata` `gen_metadata.data` Protobuf 
 * TTFT / Token 10 
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseIsoMs } from '../speed-metrics.mjs';
import { ANNOTATION_DIRS, PRODUCT_DATA_ROOTS, localSummaryMemo } from './config.mjs';

let sqliteResolved = false;
let sqliteDatabaseSyncCtor = null;

/**
 * Node `node:sqlite` `DatabaseSync` 
 * Node 22 CLI MCP `null` 
 *
 * @returns {Function | null}
 */
export function getNodeSqliteDatabaseSync() {
  if (sqliteResolved) return sqliteDatabaseSyncCtor;
  sqliteResolved = true;
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    return null;
  }
  const origEmitWarning = process.emitWarning;
  try {
    if (typeof origEmitWarning === 'function') {
      process.emitWarning = function filteredSqliteWarning(warning, ...rest) {
        const msg = typeof warning === 'string' ? warning : String(warning?.message || '');
        if (/SQLite is an experimental feature/i.test(msg)) return;
        return origEmitWarning.call(this, warning, ...rest);
      };
    }
    const mod = process.getBuiltinModule('node:sqlite');
    sqliteDatabaseSyncCtor = typeof mod?.DatabaseSync === 'function' ? mod.DatabaseSync : null;
  } catch {
    sqliteDatabaseSyncCtor = null;
  } finally {
    if (typeof origEmitWarning === 'function') {
      process.emitWarning = origEmitWarning;
    }
  }
  return sqliteDatabaseSyncCtor;
}

/**
 * `node:sqlite` 
 *
 * @returns {boolean}
 */
export function hasBuiltinNodeSqlite() {
  return Boolean(getNodeSqliteDatabaseSync());
}

/**
 * Protobuf Text Format (`prototext`) UTF-8 `\ddd` / `\xHH` 
 *
 * @param {string} raw
 * @returns {string}
 */
function unescapePbtxtString(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  if (!raw.includes('\\')) return raw;
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\' || i + 1 >= raw.length) {
      const encoded = Buffer.from(ch, 'utf8');
      for (let b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
      continue;
    }
    const next = raw[++i];
    if (next >= '0' && next <= '7') {
      let oct = next;
      if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      bytes.push(parseInt(oct, 8) & 0xff);
    } else if ((next === 'x' || next === 'X') && i + 2 < raw.length) {
      const hex = raw.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        bytes.push(next.charCodeAt(0));
      }
    } else if (next === 'u' && i + 4 < raw.length) {
      const uHex = raw.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(uHex)) {
        const encoded = Buffer.from(String.fromCharCode(parseInt(uHex, 16)), 'utf8');
        for (let b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
        i += 4;
      } else {
        bytes.push(next.charCodeAt(0));
      }
    } else if (next === 'n') {
      bytes.push(0x0a);
    } else if (next === 'r') {
      bytes.push(0x0d);
    } else if (next === 't') {
      bytes.push(0x09);
    } else {
      const encoded = Buffer.from(next, 'utf8');
      for (let b = 0; b < encoded.length; b++) bytes.push(encoded[b]);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * `annotations/<cascadeId>.pbtxt` `title` 
 *
 * @param {string} rawText
 * @returns {string}
 */
export function parseAnnotationPbtxtTitle(rawText) {
  if (typeof rawText !== 'string' || !rawText) return '';
  const dq = rawText.match(/(?:^|\r?\n)\s*title\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (dq) {
    return unescapePbtxtString(dq[1]).trim();
  }
  const sq = rawText.match(/(?:^|\r?\n)\s*title\s*:\s*'((?:\\.|[^'\\])*)'/);
  if (sq) {
    return unescapePbtxtString(sq[1]).trim();
  }
  return '';
}

/**
 * ID `annotations/<cascadeId>.pbtxt` 
 *
 * @param {string} cascadeId
 * @param {string[]} [annotationDirs=ANNOTATION_DIRS]
 * @returns {string}
 */
export function readAnnotationTitleForCascade(cascadeId, annotationDirs = ANNOTATION_DIRS) {
  const normId = String(cascadeId || '').trim().toLowerCase();
  if (!normId) return '';
  const dirs = Array.isArray(annotationDirs) ? annotationDirs : [];
  for (const dir of dirs) {
    if (!dir) continue;
    const filePath = join(dir, `${normId}.pbtxt`);
    if (!existsSync(filePath)) continue;
    try {
      const title = parseAnnotationPbtxtTitle(readFileSync(filePath, 'utf8'));
      if (title) return title;
    } catch {
 // 
    }
  }
  return '';
}

function normalizeSqliteIsoTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/^(\d{4}-\d{2}-\d{2})\s+/, '$1T');
}

/**
 * `conversation_summaries.db` 
 * `.db` `.db-wal` `mtimeMs + size` Memoize I/O 
 *
 * @param {string[]} [productRoots=PRODUCT_DATA_ROOTS]
 * @returns {Map<string, {
 *   cascadeId: string,
 *   title: string,
 *   status: string,
 *   parentConversationId: string,
 *   agentName: string,
 *   stepCount: number,
 *   lastModifiedTime: string,
 *   lastModifiedMs: number,
 *   appDataDir: string
 * }>}
 */
export function readLocalSummaryIndex(productRoots = PRODUCT_DATA_ROOTS) {
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return new Map();
  const roots = Array.isArray(productRoots) ? productRoots : [];
  const sigParts = [];
  const targets = [];

  for (const root of roots) {
    if (!root) continue;
    const dbPath = join(root, 'conversation_summaries.db');
    if (!existsSync(dbPath)) continue;
    try {
      const st = statSync(dbPath);
      let walPart = '0:0';
      const walPath = `${dbPath}-wal`;
      if (existsSync(walPath)) {
        try {
          const wst = statSync(walPath);
          walPart = `${wst.mtimeMs || 0}:${wst.size || 0}`;
        } catch {
 // wal 
        }
      }
      sigParts.push(`${dbPath}:${st.mtimeMs || 0}:${st.size || 0}:${walPart}`);
      targets.push({ rootName: basename(root).toLowerCase(), dbPath });
    } catch {
 // 
    }
  }

  if (targets.length === 0) {
    localSummaryMemo.sig = '';
    localSummaryMemo.byId.clear();
    return localSummaryMemo.byId;
  }

  const sig = sigParts.join('|');
  if (localSummaryMemo.sig === sig && localSummaryMemo.byId.size > 0) {
    return localSummaryMemo.byId;
  }

  const nextMap = new Map();
  for (const { rootName, dbPath } of targets) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT
             conversation_id,
             title,
             status,
             parent_conversation_id,
             agent_name,
             not_fully_idle,
             killed,
             step_count,
             last_modified_time,
             app_data_dir
           FROM conversation_summaries`
        )
        .all();
      for (const row of rows || []) {
        const cidLower = String(row?.conversation_id || '').trim().toLowerCase();
        if (!cidLower) continue;
        const appDataDir = String(row?.app_data_dir || '').trim().toLowerCase();
        const isNativeRootRow = Boolean(appDataDir && appDataDir === rootName);
        const lastModifiedTime = normalizeSqliteIsoTime(row?.last_modified_time);
        const lastModifiedMs = parseIsoMs(lastModifiedTime);
        const rawStatus = String(row?.status || '').trim();
        const isRunning =
          !Number(row?.killed) &&
          (rawStatus === 'CASCADE_RUN_STATUS_RUNNING' ||
            (Number(row?.not_fully_idle) > 0 && rawStatus !== 'CASCADE_RUN_STATUS_IDLE'));
        const entry = {
          cascadeId: cidLower,
          title: String(row?.title || '').trim(),
          status: isRunning ? 'CASCADE_RUN_STATUS_RUNNING' : rawStatus || 'CASCADE_RUN_STATUS_IDLE',
          parentConversationId: String(row?.parent_conversation_id || '').trim().toLowerCase(),
          agentName: String(row?.agent_name || '').trim(),
          stepCount: Math.max(0, Math.floor(Number(row?.step_count) || 0)),
          lastModifiedTime,
          lastModifiedMs,
          appDataDir,
          isNativeRootRow,
        };
        const prev = nextMap.get(cidLower);
        if (
          !prev ||
          (entry.isNativeRootRow && !prev.isNativeRootRow) ||
          (entry.isNativeRootRow === prev.isNativeRootRow &&
            entry.lastModifiedMs >= prev.lastModifiedMs)
        ) {
          nextMap.set(cidLower, entry);
        }
      }
    } catch {
 // SQLite 
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
 // 
        }
      }
    }
  }

  localSummaryMemo.sig = sig;
  localSummaryMemo.byId = nextMap;
  return nextMap;
}

// ---------------------------------------------------------------------------
// Protobuf Wire O(1) Prompt 
// ---------------------------------------------------------------------------

function readProtoVarint(buf, state) {
  let result = 0n;
  let shift = 0n;
  while (state.off < buf.length) {
    const byte = BigInt(buf[state.off++]);
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return result;
    shift += 7n;
    if (shift > 70n) throw new Error('Invalid protobuf varint');
  }
  throw new Error('Unexpected EOF in protobuf varint');
}

function skipProtoField(buf, state, wireType) {
  if (wireType === 0) {
    readProtoVarint(buf, state);
  } else if (wireType === 1) {
    state.off += 8;
  } else if (wireType === 2) {
    const len = Number(readProtoVarint(buf, state));
    state.off += len;
  } else if (wireType === 5) {
    state.off += 4;
  } else {
    throw new Error(`Unsupported protobuf wireType: ${wireType}`);
  }
  if (state.off > buf.length) {
    throw new Error('Protobuf field length out of bounds');
  }
}

function decodeProtoTimestampIso(buf) {
  const st = { off: 0 };
  let seconds = 0n;
  let nanos = 0n;
  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      seconds = BigInt.asIntN(64, readProtoVarint(buf, st));
    } else if (fn === 2 && wt === 0) {
      nanos = BigInt.asIntN(32, readProtoVarint(buf, st));
    } else {
      skipProtoField(buf, st, wt);
    }
  }
  if (seconds <= 0n) return '';
  const baseIso = new Date(Number(seconds) * 1000).toISOString();
  const prefix = baseIso.slice(0, 19);
  if (nanos > 0n && nanos < 1_000_000_000n) {
    const frac = String(nanos).padStart(9, '0').replace(/0+$/, '');
    return frac ? `${prefix}.${frac}Z` : `${prefix}Z`;
  }
  return `${prefix}Z`;
}

function decodeProtoDurationStr(buf) {
  const st = { off: 0 };
  let seconds = 0n;
  let nanos = 0n;
  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      seconds = BigInt.asIntN(64, readProtoVarint(buf, st));
    } else if (fn === 2 && wt === 0) {
      nanos = BigInt.asIntN(32, readProtoVarint(buf, st));
    } else {
      skipProtoField(buf, st, wt);
    }
  }
  if (seconds < 0n || nanos < 0n) return '';
  if (nanos === 0n) return `${seconds}s`;
  const frac = String(nanos).padStart(9, '0').replace(/0+$/, '');
  return frac ? `${seconds}.${frac}s` : `${seconds}s`;
}

function decodeProtoModelEnumInt(val) {
  const n = Number(val);
  if (Number.isInteger(n) && n >= 1000 && n < 10000) {
    return `MODEL_PLACEHOLDER_M${n - 1000}`;
  }
  return '';
}

function decodeProtoTokenTypeEnum(val) {
  switch (Number(val)) {
    case 1:
      return 'TOKEN_TYPE_SYSTEM_PROMPT';
    case 2:
      return 'TOKEN_TYPE_TOOLS';
    case 3:
      return 'TOKEN_TYPE_RULES';
    case 4:
      return 'TOKEN_TYPE_MCP_TOOLS';
    case 5:
      return 'TOKEN_TYPE_SKILLS';
    case 6:
      return 'TOKEN_TYPE_SUBAGENTS';
    case 7:
      return 'TOKEN_TYPE_CHAT_MESSAGES';
    default:
      return '';
  }
}

function decodeProtoStepTypeEnum(val) {
  switch (Number(val)) {
    case 14:
      return 'CORTEX_STEP_TYPE_USER_INPUT';
    case 15:
      return 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
    case 17:
      return 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
    case 23:
      return 'CORTEX_STEP_TYPE_CHECKPOINT';
    case 101:
      return 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE';
    default:
      return 'CORTEX_STEP_TYPE_GENERIC';
  }
}

function decodeProtoStepStatusEnum(val) {
  switch (Number(val)) {
    case 2:
      return 'CORTEX_STEP_STATUS_RUNNING';
    case 3:
      return 'CORTEX_STEP_STATUS_DONE';
    case 5:
      return 'CORTEX_STEP_STATUS_CLEARED';
    case 6:
      return 'CORTEX_STEP_STATUS_CANCELED';
    case 7:
      return 'CORTEX_STEP_STATUS_ERROR';
    case 8:
      return 'CORTEX_STEP_STATUS_GENERATING';
    default:
      return 'CORTEX_STEP_STATUS_DONE';
  }
}

function decodeProtoModelUsage(buf) {
  const st = { off: 0 };
  let model = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let apiProviderNum = 0;
  let thinkingOutputTokens;
  let responseOutputTokens;

  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      model = decodeProtoModelEnumInt(readProtoVarint(buf, st));
    } else if (fn === 1 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      model = buf.subarray(st.off, st.off + len).toString('utf8');
      st.off += len;
    } else if (fn === 2 && wt === 0) {
      inputTokens = Number(readProtoVarint(buf, st));
    } else if (fn === 3 && wt === 0) {
      outputTokens = Number(readProtoVarint(buf, st));
    } else if (fn === 5 && wt === 0) {
      cacheReadTokens = Number(readProtoVarint(buf, st));
    } else if (fn === 6 && wt === 0) {
      apiProviderNum = Number(readProtoVarint(buf, st));
    } else if (fn === 9 && wt === 0) {
      thinkingOutputTokens = Number(readProtoVarint(buf, st));
    } else if (fn === 10 && wt === 0) {
      responseOutputTokens = Number(readProtoVarint(buf, st));
    } else {
      skipProtoField(buf, st, wt);
    }
  }

  return {
    ...(model ? { model } : {}),
    ...(apiProviderNum === 24 ? { apiProvider: 'API_PROVIDER_GOOGLE_GEMINI' } : {}),
    inputTokens,
    cacheReadTokens,
    outputTokens,
    ...(thinkingOutputTokens !== undefined ? { thinkingOutputTokens } : {}),
    ...(responseOutputTokens !== undefined ? { responseOutputTokens } : {}),
  };
}

function decodeProtoTokenBreakdownGroup(buf, depth = 0) {
  const st = { off: 0 };
  let name = '';
  let type = '';
  let numTokens = 0;
  const children = [];

  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      name = buf.subarray(st.off, st.off + len).toString('utf8');
      st.off += len;
    } else if (fn === 2 && wt === 0) {
      type = decodeProtoTokenTypeEnum(readProtoVarint(buf, st));
    } else if (fn === 4 && wt === 0) {
      numTokens = Number(readProtoVarint(buf, st));
    } else if (fn === 5 && wt === 2 && depth < 2) {
      const len = Number(readProtoVarint(buf, st));
      const sub = buf.subarray(st.off, st.off + len);
      st.off += len;
      children.push(decodeProtoTokenBreakdownGroup(sub, depth + 1));
    } else {
      skipProtoField(buf, st, wt);
    }
  }

  return {
    name,
    ...(type ? { type } : {}),
    numTokens,
    ...(children.length > 0 ? { children } : {}),
  };
}

function decodeProtoContextWindowMeta(buf) {
  const st = { off: 0 };
  let estimatedTokensUsed = 0;
  let maxContextTokens = 0;
  const groups = [];

  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 0) {
      estimatedTokensUsed = Number(readProtoVarint(buf, st));
    } else if (fn === 4 && wt === 0) {
      maxContextTokens = Number(readProtoVarint(buf, st));
    } else if (fn === 3 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      const tbBuf = buf.subarray(st.off, st.off + len);
      st.off += len;
      const tbSt = { off: 0 };
      while (tbSt.off < tbBuf.length) {
        const tbTag = Number(readProtoVarint(tbBuf, tbSt));
        const tbFn = tbTag >>> 3;
        const tbWt = tbTag & 7;
        if (tbFn === 1 && tbWt === 2) {
          const gLen = Number(readProtoVarint(tbBuf, tbSt));
          const gBuf = tbBuf.subarray(tbSt.off, tbSt.off + gLen);
          tbSt.off += gLen;
          groups.push(decodeProtoTokenBreakdownGroup(gBuf, 0));
        } else {
          skipProtoField(tbBuf, tbSt, tbWt);
        }
      }
    } else {
      skipProtoField(buf, st, wt);
    }
  }

  return {
    ...(estimatedTokensUsed > 0 ? { estimatedTokensUsed } : {}),
    ...(maxContextTokens > 0 ? { maxContextTokens } : {}),
    ...(groups.length > 0 ? { tokenBreakdown: { groups } } : {}),
  };
}

function decodeProtoMapStringEntry(buf) {
  const st = { off: 0 };
  let key = '';
  let val = '';
  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      key = buf.subarray(st.off, st.off + len).toString('utf8');
      st.off += len;
    } else if (fn === 2 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      val = buf.subarray(st.off, st.off + len).toString('utf8');
      st.off += len;
    } else {
      skipProtoField(buf, st, wt);
    }
  }
  return [key, val];
}

function decodeProtoChatModelMeta(buf) {
  const st = { off: 0 };
  let model = '';
  let usage = null;
  let contextWindowMetadata = null;
  let timeToFirstToken = '';
  let streamingDuration = '';
  let responseModel = '';
  let modelDisplayName = '';
  const extraMeta = {};

  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 3 && wt === 0) {
      const enumStr = decodeProtoModelEnumInt(readProtoVarint(buf, st));
      if (enumStr && !model) model = enumStr;
    } else if (fn === 4 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      usage = decodeProtoModelUsage(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 9 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      const csBuf = buf.subarray(st.off, st.off + len);
      st.off += len;
      const csSt = { off: 0 };
      while (csSt.off < csBuf.length) {
        const csTag = Number(readProtoVarint(csBuf, csSt));
        const csFn = csTag >>> 3;
        const csWt = csTag & 7;
        if (csFn === 10 && csWt === 2) {
          const cwLen = Number(readProtoVarint(csBuf, csSt));
          contextWindowMetadata = decodeProtoContextWindowMeta(
            csBuf.subarray(csSt.off, csSt.off + cwLen)
          );
          csSt.off += cwLen;
        } else {
          skipProtoField(csBuf, csSt, csWt);
        }
      }
    } else if (fn === 11 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      timeToFirstToken = decodeProtoDurationStr(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 12 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      streamingDuration = decodeProtoDurationStr(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 19 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      responseModel = buf.subarray(st.off, st.off + len).toString('utf8').trim();
      st.off += len;
    } else if (fn === 20 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      const [k, v] = decodeProtoMapStringEntry(buf.subarray(st.off, st.off + len));
      st.off += len;
      if (k && v) extraMeta[k] = v;
    } else if (fn === 21 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      modelDisplayName = buf.subarray(st.off, st.off + len).toString('utf8').trim();
      st.off += len;
    } else {
      skipProtoField(buf, st, wt);
    }
  }

  if (extraMeta.model_enum) {
    model = extraMeta.model_enum.trim();
    if (usage && !usage.model) {
      usage.model = model;
    }
  }
  if (extraMeta.used_claude === 'true' && usage && !usage.apiProvider) {
    usage.apiProvider = 'API_PROVIDER_ANTHROPIC';
  }

  return {
    chatModel: {
      ...(model ? { model } : {}),
      ...(usage ? { usage } : {}),
      ...(contextWindowMetadata ? { chatStartMetadata: { contextWindowMetadata } } : {}),
      ...(timeToFirstToken ? { timeToFirstToken } : {}),
      ...(streamingDuration ? { streamingDuration } : {}),
      ...(responseModel ? { responseModel } : {}),
      ...(modelDisplayName ? { modelDisplayName } : {}),
    },
    extraMeta,
  };
}

function decodeProtoGeneratorMeta(buf) {
  const st = { off: 0 };
  const stepIndices = [];
  let chatDecoded = null;

  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 2 && wt === 0) {
      stepIndices.push(Number(readProtoVarint(buf, st)));
    } else if (fn === 2 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      const end = st.off + len;
      while (st.off < end) {
        stepIndices.push(Number(readProtoVarint(buf, st)));
      }
    } else if (fn === 1 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      chatDecoded = decodeProtoChatModelMeta(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else {
      skipProtoField(buf, st, wt);
    }
  }

  if (!chatDecoded) return null;
  return {
    stepIndices,
    chatModel: chatDecoded.chatModel,
    extraMeta: chatDecoded.extraMeta,
  };
}

function decodeProtoStepMeta(buf, fallbackIdx) {
  const st = { off: 0 };
  let createdAt = '';
  let viewableAt = '';
  let finishedGeneratingAt = '';
  let completedAt = '';
  let modelUsage = null;
  let generatorModel = '';
  let stepIndex = fallbackIdx;

  while (st.off < buf.length) {
    const tag = Number(readProtoVarint(buf, st));
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 1 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      createdAt = decodeProtoTimestampIso(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 6 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      viewableAt = decodeProtoTimestampIso(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 7 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      finishedGeneratingAt = decodeProtoTimestampIso(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 32 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      completedAt = decodeProtoTimestampIso(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 9 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      modelUsage = decodeProtoModelUsage(buf.subarray(st.off, st.off + len));
      st.off += len;
    } else if (fn === 11 && wt === 0) {
      generatorModel = decodeProtoModelEnumInt(readProtoVarint(buf, st));
    } else if (fn === 20 && wt === 2) {
      const len = Number(readProtoVarint(buf, st));
      const siBuf = buf.subarray(st.off, st.off + len);
      st.off += len;
      const siSt = { off: 0 };
      while (siSt.off < siBuf.length) {
        const siTag = Number(readProtoVarint(siBuf, siSt));
        const siFn = siTag >>> 3;
        const siWt = siTag & 7;
        if (siFn === 2 && siWt === 0) {
          stepIndex = Number(readProtoVarint(siBuf, siSt));
        } else {
          skipProtoField(siBuf, siSt, siWt);
        }
      }
    } else {
      skipProtoField(buf, st, wt);
    }
  }

  return {
    ...(createdAt ? { createdAt } : {}),
    ...(viewableAt ? { viewableAt } : {}),
    ...(finishedGeneratingAt ? { finishedGeneratingAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(generatorModel ? { generatorModel } : {}),
    sourceTrajectoryStepInfo: { stepIndex },
    ...(modelUsage ? { modelUsage } : {}),
  };
}

/**
 * SQLite `<product>/conversations/<cascadeId>.db` 
 * `steps.metadata` `gen_metadata.data` `step_payload` 
 *
 * @param {string} dbFilePath
 * @returns {{
 *   steps: Array<{ idx: number, type: string, status: string, metadata: object }>,
 *   generatorMetadata: Array<{ stepIndices: number[], chatModel: object }>,
 *   rootConversationId: string,
 *   parentConversationId: string
 * } | null}
 */
export function readLocalSqliteTrajectory(dbFilePath) {
  if (!dbFilePath || !existsSync(dbFilePath)) return null;
  const DatabaseSync = getNodeSqliteDatabaseSync();
  if (!DatabaseSync) return null;

  let db = null;
  try {
    db = new DatabaseSync(dbFilePath, { readOnly: true });
    const genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    const generatorMetadata = [];
    const genByStep = new Map();
    let rootConversationId = '';
    let parentConversationId = '';

    for (const row of genRows || []) {
      if (!row?.data) continue;
      try {
        const decoded = decodeProtoGeneratorMeta(Buffer.from(row.data));
        if (!decoded) continue;
        const gmItem = {
          stepIndices: decoded.stepIndices,
          chatModel: decoded.chatModel,
        };
        generatorMetadata.push(gmItem);
        for (const sIdx of decoded.stepIndices) {
          genByStep.set(Number(sIdx), gmItem);
        }
        if (!rootConversationId && decoded.extraMeta?.root_cascade_id) {
          rootConversationId = String(decoded.extraMeta.root_cascade_id).trim().toLowerCase();
        }
        if (!parentConversationId && decoded.extraMeta?.parent_cascade_id) {
          parentConversationId = String(decoded.extraMeta.parent_cascade_id).trim().toLowerCase();
        }
      } catch {
 // generatorMetadata
      }
    }

    const stepRows = db
      .prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC')
      .all();
    const steps = [];
    for (const row of stepRows || []) {
      const idx = Number.isFinite(Number(row?.idx)) ? Number(row.idx) : steps.length;
      const type = decodeProtoStepTypeEnum(row?.step_type);
      const status = decodeProtoStepStatusEnum(row?.status);
      let metadata = { sourceTrajectoryStepInfo: { stepIndex: idx } };
      if (row?.metadata && row.metadata.byteLength > 0) {
        try {
          metadata = decodeProtoStepMeta(Buffer.from(row.metadata), idx);
        } catch {
 // 
        }
      }
      const stepIdx = metadata.sourceTrajectoryStepInfo?.stepIndex ?? idx;
      const gm = genByStep.get(Number(stepIdx));
      if (metadata.modelUsage && gm?.chatModel?.model && !metadata.modelUsage.model) {
        metadata.modelUsage.model = gm.chatModel.model;
      }
      steps.push({ idx, type, status, metadata });
    }

    if (steps.length === 0 && generatorMetadata.length === 0) {
      return null;
    }
    return {
      steps,
      generatorMetadata,
      rootConversationId,
      parentConversationId,
    };
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
 // 
      }
    }
  }
}
