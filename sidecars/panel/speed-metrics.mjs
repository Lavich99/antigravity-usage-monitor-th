/**
 * TPS TTFT 
 *
 * 
 * 1. 
 * 2. 
 */

/** */
export const MEASUREMENT_VERSION = 4;

/** */
export const MODEL_IDENTITY_VERSION = 1;

/** 0.5 */
export const MIN_SPEED_DURATION_SECONDS = 0.5;

/** Mean TPS Token 50 Tokens */
export const MIN_MEAN_OUTPUT_TOKENS = 50;

/**
 * ISO-8601 
 * `Date.parse` 
 *
 * @param {unknown} value ISO-8601 
 * @returns {number} 0
 */
export function parseIsoMs(value) {
  if (typeof value !== 'string' || !value) {
    return 0;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return 0;
  }
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (!fraction) {
    return ms;
  }
  return Math.floor(ms / 1000) * 1000 + Number(`0.${fraction[1]}`) * 1000;
}

/**
 * Protobuf Duration `"0.85s"` 
 *
 * @param {unknown} value 
 * @returns {number | null} null
 */
function duration(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?s$/.test(value)) {
    return null;
  }
  const n = Number(value.slice(0, -1));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * 
 *
 * @param {unknown} value Token 
 * @returns {boolean} 
 */
function validCount(value) {
  const isNumericType =
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value));
  if (!isNumericType) {
    return false;
  }
  const num = Number(value);
  return Number.isSafeInteger(num) && num >= 0;
}

/**
 * Token NaN Infinity / 0 
 *
 * @param {unknown} value
 * @returns {number}
 */
function safeTokenCount(value) {
  if (validCount(value)) {
    return Number(value);
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) {
    const num = Number(value.trim());
    if (Number.isFinite(num) && num >= 0) {
      return Math.floor(num);
    }
  }
  return 0;
}

/**
 * ISO-8601 `BigInt` 
 *
 * `BigInt` `Number` 
 * Unix `1.7e18` IEEE-754 `Number.MAX_SAFE_INTEGER` `9e15` 
 * `Number` `499,999,999 ns` 499.999999ms `0.500s` 
 * `MIN_SPEED_DURATION_SECONDS` 0.5s `BigInt` `Number` 
 *
 * @param {unknown} value ISO-8601 
 * @returns {bigint | null} BigInt null
 */
function timestampNs(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/
  );
  if (!match) {
    return null;
  }
  const ms = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(ms)) {
    return null;
  }
  const nanosPart = BigInt((match[2] || '').padEnd(9, '0'));
  return BigInt(ms) * 1_000_000n + nanosPart;
}

/**
 * 
 * `BigInt` `end - start` `1e9` 499.999ms 0.5s 
 *
 * @param {unknown} startValue `createdAt` 
 * @param {unknown} endValue `finishedGeneratingAt` `completedAt` 
 * @returns {number | null} null
 */
function requestDuration(startValue, endValue) {
  const start = timestampNs(startValue);
  const end = timestampNs(endValue);
  if (start === null || end === null || start <= 0n || end < start) {
    return null;
  }
  return Number(end - start) / 1e9;
}

/**
 * 
 *
 * @param {number} start 
 * @param {number} end 
 * @returns {number | null} null
 */
function elapsed(start, end) {
  return start > 0 && end >= start ? (end - start) / 1000 : null;
}

/**
 * UTF-8 Token 3 UTF-8 1 Token 
 *
 * @param {unknown} text 
 * @returns {number} Token 
 */
function estimateUtf8Tokens(text) {
  if (typeof text !== 'string' || !text) {
    return 0;
  }
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/**
 * Prompt Section 
 *
 * @param {unknown} name 
 * @returns {'skills' | 'userRules' | 'mcpTools' | 'systemPrompt'} 
 */
function classifyPromptSection(name, type = '') {
  const key = String(name || type || '')
    .trim()
    .toLowerCase()
    .replace(/^token_type_/, '')
    .replace(/[\s-]+/g, '_');
  if (key === 'skills' || key === 'skill') {
    return 'skills';
  }
  if (
    key === 'user_rules' ||
    key === 'user_rule' ||
    key === 'rules' ||
    key === 'rule'
  ) {
    return 'userRules';
  }
  if (
    key === 'mcp_servers' ||
    key === 'mcp_tools' ||
    key === 'mcp' ||
    key.startsWith('mcp_')
  ) {
    return 'mcpTools';
  }
  return 'systemPrompt';
}

/**
 * MCP Model Context Protocol 
 *
 * @param {unknown} name 
 * @param {unknown} [source=''] 
 * @param {unknown} [type=''] 
 * @returns {boolean} MCP 
 */
function isMcpToolItem(name, source = '', type = '') {
  const n = String(name || '').trim().toLowerCase();
  const src = String(source || '').toUpperCase();
  const t = String(type || '').toUpperCase();
  return (
    src.includes('MCP') ||
    t.includes('MCP') ||
    n.startsWith('mcp_') ||
    n.startsWith('mcp-') ||
    n === 'call_mcp_tool' ||
    n === 'list_mcp_resources' ||
    n === 'read_mcp_resource'
  );
}

/**
 * `TOKEN_TYPE_CHAT_MESSAGES` `"391: CHECKPOINT"` `"404: GENERIC"` 
 *
 * @param {object} child
 * @returns {'checkpoint'|'assistant'|'subagent'|'userInput'|'toolResults'}
 */
function classifyChatMessageChild(child) {
  const rawName = String(child?.name || child?.type || '').trim().toUpperCase();
  const stepType = rawName.replace(/^\d+:\s*/, '');
  if (stepType.includes('CHECKPOINT') || stepType.includes('SUMMARY')) {
    return 'checkpoint';
  }
  if (
    stepType.includes('PLANNER_RESPONSE') ||
    stepType.includes('ASSISTANT') ||
    stepType.includes('MODEL')
  ) {
    return 'assistant';
  }
  if (stepType.includes('SYSTEM_MESSAGE') || stepType.includes('SUBAGENT')) {
    return 'subagent';
  }
  if (stepType.includes('USER_INPUT') || stepType === 'USER') {
    return 'userInput';
  }
  // GENERIC, VIEW_FILE, RUN_COMMAND, CODE_ACTION
  return 'toolResults';
}

/**
 * `messagePrompts` 5 
 *
 * @param {object} m
 * @returns {'toolResults'|'checkpoint'|'subagent'|'assistant'|'userInput'}
 */
function classifyMessagePrompt(m) {
  const text = String(m?.prompt ?? m?.content ?? '');
  const src = String(m?.source || '').toUpperCase();
  if (src.includes('TOOL')) {
    return 'toolResults';
  }
  if (text.startsWith('<CONTEXT_SUMMARY>')) {
    return 'checkpoint';
  }
  if (text.includes('<SYSTEM_MESSAGE>')) {
    return 'subagent';
  }
  if (src.includes('SYSTEM') || src.includes('ASSISTANT') || src.includes('MODEL')) {
    return 'assistant';
  }
  return 'userInput';
}

/**
 * `chatModel` 10 Token 
 * - `systemPromptTokens` 
 * - `userRulesTokens` / 
 * - `skillsTokens` Skills 
 * - `systemToolsTokens` 
 * - `mcpToolsTokens` MCP 
 * - `checkpointTokens` Checkpoint 
 * - `userInputTokens` 
 * - `assistantTokens` 
 * - `subagentTokens` 
 * - `toolResultsTokens` 
 *
 * @param {object} chat `generatorMetadata.chatModel` 
 * @returns {object | null} Token null
 */
export function extractContextBreakdown(chat) {
  if (!chat || typeof chat !== 'object') {
    return null;
  }
  const tb = chat?.chatStartMetadata?.contextWindowMetadata?.tokenBreakdown;
  const groups = Array.isArray(tb?.groups) ? tb.groups : [];
  const promptSections = Array.isArray(chat?.promptSections)
    ? chat.promptSections
    : [];
  const tools = Array.isArray(chat?.tools) ? chat.tools : [];
  const messagePrompts = Array.isArray(chat?.messagePrompts)
    ? chat.messagePrompts
    : [];

  if (
    !groups.length &&
    !promptSections.length &&
    !tools.length &&
    !messagePrompts.length
  ) {
    return null;
  }

  let userInputTokens = 0;
  let assistantTokens = 0;
  let toolResultsTokens = 0;
  let subagentTokens = 0;
  let checkpointTokens = 0;
  let systemToolsTokens = 0;
  let mcpToolsTokens = 0;
  let skillsTokens = 0;
  let systemPromptTokens = 0;
  let userRulesTokens = 0;

  let hasPromptGroup = false;
  let hasToolsGroup = false;
  let hasMessagesGroup = false;

  // tokenBreakdown.groups 10
  for (const g of groups) {
    const gType = String(g?.type || '').toUpperCase();
    const gName = String(g?.name || '').trim().toLowerCase();
    const gSource = String(g?.source || '').toUpperCase();
    const gTokens = Math.max(0, Number(g?.numTokens || 0));
    const children = Array.isArray(g?.children) ? g.children : [];

    if (gType === 'TOKEN_TYPE_SYSTEM_PROMPT' || gName === 'system prompt') {
      hasPromptGroup = true;
      if (children.length > 0) {
        let childSum = 0;
        for (const c of children) {
          const tok = Math.max(0, Number(c?.numTokens || 0));
          childSum += tok;
          const bucket = classifyPromptSection(c?.name ?? c?.title, c?.type);
          if (bucket === 'skills') {
            skillsTokens += tok;
          } else if (bucket === 'userRules') {
            userRulesTokens += tok;
          } else if (bucket === 'mcpTools') {
            mcpToolsTokens += tok;
          } else {
            systemPromptTokens += tok;
          }
        }
        if (gTokens > childSum) {
          systemPromptTokens += gTokens - childSum;
        }
      } else {
        systemPromptTokens += gTokens;
      }
    } else if (
      gType === 'TOKEN_TYPE_SKILLS' ||
      gName === 'skills' ||
      gName === 'skill'
    ) {
      hasPromptGroup = true;
      skillsTokens += gTokens;
    } else if (
      gType === 'TOKEN_TYPE_RULES' ||
      gType === 'TOKEN_TYPE_USER_RULES' ||
      gName === 'rules' ||
      gName === 'user rules' ||
      gName === 'user_rules'
    ) {
      hasPromptGroup = true;
      userRulesTokens += gTokens;
    } else if (
      gType === 'TOKEN_TYPE_SUBAGENTS' ||
      gType === 'TOKEN_TYPE_PLUGINS' ||
      gName === 'subagents' ||
      gName === 'plugins' ||
      gName === 'featured plugins' ||
      gName === 'featured_plugins'
    ) {
      hasPromptGroup = true;
      systemPromptTokens += gTokens;
    } else if (
      gType === 'TOKEN_TYPE_TOOLS' ||
      gName === 'tools' ||
      gType.includes('MCP') ||
      gSource.includes('MCP')
    ) {
      hasToolsGroup = true;
      if (children.length > 0) {
        let childSum = 0;
        for (const c of children) {
          const tok = Math.max(0, Number(c?.numTokens || 0));
          childSum += tok;
          if (
            isMcpToolItem(c?.name, c?.source || g?.source, c?.type || g?.type)
          ) {
            mcpToolsTokens += tok;
          } else {
            systemToolsTokens += tok;
          }
        }
        if (gTokens > childSum) {
          if (isMcpToolItem(g?.name, g?.source, g?.type)) {
            mcpToolsTokens += gTokens - childSum;
          } else {
            systemToolsTokens += gTokens - childSum;
          }
        }
      } else if (isMcpToolItem(g?.name, g?.source, g?.type)) {
        mcpToolsTokens += gTokens;
      } else {
        systemToolsTokens += gTokens;
      }
    } else if (
      gType === 'TOKEN_TYPE_CHAT_MESSAGES' ||
      gName === 'chat messages' ||
      gName === 'messages'
    ) {
      hasMessagesGroup = true;
      if (children.length > 0) {
        let childSum = 0;
        for (const c of children) {
          const tok = Math.max(0, Number(c?.numTokens || 0));
          childSum += tok;
          const msgBucket = classifyChatMessageChild(c);
          if (msgBucket === 'checkpoint') {
            checkpointTokens += tok;
          } else if (msgBucket === 'assistant') {
            assistantTokens += tok;
          } else if (msgBucket === 'subagent') {
            subagentTokens += tok;
          } else if (msgBucket === 'userInput') {
            userInputTokens += tok;
          } else {
            toolResultsTokens += tok;
          }
        }
        if (gTokens > childSum) {
          userInputTokens += gTokens - childSum;
        }
      } else if (messagePrompts.length > 0) {
        const mpBuckets = {
          userInput: 0,
          assistant: 0,
          toolResults: 0,
          subagent: 0,
          checkpoint: 0,
        };
        let mpSum = 0;
        for (const m of messagePrompts) {
          const text = String(m?.prompt ?? m?.content ?? '');
          const tok =
            Number.isFinite(Number(m?.numTokens)) && Number(m?.numTokens) >= 0
              ? Number(m.numTokens)
              : estimateUtf8Tokens(text);
          const bucketKey = classifyMessagePrompt(m);
          mpBuckets[bucketKey] += tok;
          mpSum += tok;
        }
        if (gTokens > 0 && mpSum > 0) {
          const keys = ['userInput', 'assistant', 'toolResults', 'subagent', 'checkpoint'];
          const scaled = {};
          let assigned = 0;
          let largestKey = 'userInput';
          for (const k of keys) {
            if (mpBuckets[k] > mpBuckets[largestKey]) largestKey = k;
            scaled[k] = mpBuckets[k] > 0 ? Math.floor((mpBuckets[k] * gTokens) / mpSum) : 0;
            assigned += scaled[k];
          }
          scaled[largestKey] += Math.max(0, gTokens - assigned);
          userInputTokens += scaled.userInput;
          assistantTokens += scaled.assistant;
          toolResultsTokens += scaled.toolResults;
          subagentTokens += scaled.subagent;
          checkpointTokens += scaled.checkpoint;
        } else if (mpSum > 0) {
          userInputTokens += mpBuckets.userInput;
          assistantTokens += mpBuckets.assistant;
          toolResultsTokens += mpBuckets.toolResults;
          subagentTokens += mpBuckets.subagent;
          checkpointTokens += mpBuckets.checkpoint;
        } else if (gTokens > 0) {
          userInputTokens += gTokens;
        }
      } else if (gTokens > 0) {
        userInputTokens += gTokens;
      }
    } else if (gTokens > 0) {
      // tokenBreakdown.groups
      hasPromptGroup = true;
      const fallbackBucket = classifyPromptSection(g?.name, g?.type);
      if (fallbackBucket === 'skills') {
        skillsTokens += gTokens;
      } else if (fallbackBucket === 'userRules') {
        userRulesTokens += gTokens;
      } else if (fallbackBucket === 'mcpTools') {
        mcpToolsTokens += gTokens;
      } else {
        systemPromptTokens += gTokens;
      }
    }
  }

  // A groups promptSections token UTF-8 byteLength / 3
  if (!hasPromptGroup && promptSections.length > 0) {
    for (const s of promptSections) {
      const tok =
        Number.isFinite(Number(s?.numTokens)) && Number(s?.numTokens) >= 0
          ? Number(s.numTokens)
          : estimateUtf8Tokens(s?.content ?? s?.text ?? '');
      const bucket = classifyPromptSection(s?.title ?? s?.name);
      if (bucket === 'skills') {
        skillsTokens += tok;
      } else if (bucket === 'userRules') {
        userRulesTokens += tok;
      } else if (bucket === 'mcpTools') {
        mcpToolsTokens += tok;
      } else {
        systemPromptTokens += tok;
      }
    }
  }

  // B groups tools JSON Schema
  if (!hasToolsGroup && tools.length > 0) {
    for (const t of tools) {
      const rawText = `${t?.name || ''}${t?.description || ''}${t?.jsonSchemaString || ''}`;
      const tok =
        Number.isFinite(Number(t?.numTokens)) && Number(t?.numTokens) >= 0
          ? Number(t.numTokens)
          : estimateUtf8Tokens(rawText);
      if (isMcpToolItem(t?.name, t?.source, t?.type)) {
        mcpToolsTokens += tok;
      } else {
        systemToolsTokens += tok;
      }
    }
  }

  // C groups messagePrompts
  if (!hasMessagesGroup && messagePrompts.length > 0) {
    for (const m of messagePrompts) {
      const text = String(m?.prompt ?? m?.content ?? '');
      const tok =
        Number.isFinite(Number(m?.numTokens)) && Number(m?.numTokens) >= 0
          ? Number(m.numTokens)
          : estimateUtf8Tokens(text);
      const bucketKey = classifyMessagePrompt(m);
      if (bucketKey === 'toolResults') {
        toolResultsTokens += tok;
      } else if (bucketKey === 'checkpoint') {
        checkpointTokens += tok;
      } else if (bucketKey === 'subagent') {
        subagentTokens += tok;
      } else if (bucketKey === 'assistant') {
        assistantTokens += tok;
      } else {
        userInputTokens += tok;
      }
    }
  }

  const messagesTokens =
    userInputTokens +
    assistantTokens +
    toolResultsTokens +
    subagentTokens +
    checkpointTokens;

  const totalTokens =
    messagesTokens +
    systemToolsTokens +
    mcpToolsTokens +
    skillsTokens +
    systemPromptTokens +
    userRulesTokens;

  return {
    messagesTokens,
    userInputTokens,
    assistantTokens,
    toolResultsTokens,
    subagentTokens,
    checkpointTokens,
    systemToolsTokens,
    mcpToolsTokens,
    skillsTokens,
    systemPromptTokens,
    userRulesTokens,
    totalTokens,
  };
}

/**
 * 
 *
 * 
 * 1. ** 5 ** 
 * 5 `0` `unknown` `MODEL_UNSPECIFIED` `MODEL_UNKNOWN` 
 * - 1 `usage.model` `modelUsage` `retryInfos[0].usage` 
 * - 2 `chat.usage.model` `generatorMetadata.chatModel.usage` 
 * - 3 `chat.model` `chatModel` 
 * - 4 `metadata.generatorModel` `metadata` 
 * - 5 `chat.responseModel` 
 * 2. ** `timingReason` / `speedReason` ** 
 * - `'canceled'` 
 * - `'incomplete_or_invalid_timing'` `totalDurationSec` / 
 * - `'invalid_output_tokens'` `outputTokens` 
 * - `'short_timing'` `MIN_SPEED_DURATION_SECONDS` 0.5s 
 * - `'inconsistent_timing'` `nativeTtftSec` `totalDurationSec + 0.01s` 
 * - `'compaction'` / `'short_sample'` `CORTEX_STEP_TYPE_CHECKPOINT` 
 * `MIN_MEAN_OUTPUT_TOKENS` 50 Tokens `speedSampleEligible` 
 * 3. ** ** 
 * `contextBreakdown` `chatModel` 
 * `generatorMetadata` `latestBreakdownChat` 
 * 
 *
 * @param {Array<object>} [rawSteps=[]] Cortex 
 * @param {Array<object>} [generatorMetadata=[]] 
 * @returns {Array<object>} 
 */
export function extractModelSteps(rawSteps = [], generatorMetadata = []) {
  const genByStep = new Map();
  const orchestratorExecModels = new Set();
  const collectOrchestratorExecModel = (pc) => {
    const execModel = pc?.planExecuteConfig?.executionModel;
    if (
      typeof execModel === 'string' &&
      execModel.trim() &&
      /orchestrator|MODEL_PLACEHOLDER_M(?:667|681)\b/i.test(
        `${pc?.modelName || ''} ${pc?.planModel || ''}`
      )
    ) {
      orchestratorExecModels.add(execModel.trim());
    }
  };
  let latestBreakdownChat = null;
  let latestBreakdownStepIdx = -1;

  for (const gm of generatorMetadata || []) {
    collectOrchestratorExecModel(gm?.plannerConfig);
    if (!gm?.chatModel) {
      continue;
    }
    let gmMaxIdx = -1;
    for (const index of gm?.stepIndices || []) {
      const numIdx = Number(index);
      genByStep.set(numIdx, gm);
      if (Number.isFinite(numIdx) && numIdx > gmMaxIdx) {
        gmMaxIdx = numIdx;
      }
    }
    if (extractContextBreakdown(gm.chatModel)) {
      latestBreakdownChat = gm.chatModel;
      latestBreakdownStepIdx = gmMaxIdx;
    }
  }

  const result = [];
  let lastCompactionStepIdx = -1;
  let turnCounter = 0;
  let activeTurnIndex = null;
  let pendingTurnPrompts = [];
  let hasUnconsumedTurn = false;

  const isUserTurnBoundary = (step) => {
    if (!step || typeof step !== 'object') return false;
    const t = String(step.type || '').trim().toUpperCase();
    if (t === 'CORTEX_STEP_TYPE_USER_INPUT' || t === 'USER_INPUT') {
      return true;
    }
    return Boolean(step.userInput && typeof step.userInput === 'object');
  };

  const extractUserTurnPrompt = (step) => {
    const ui = step?.userInput;
    let raw = '';
    if (typeof ui?.userResponse === 'string' && ui.userResponse.trim()) {
      raw = ui.userResponse;
    } else if (Array.isArray(ui?.items)) {
      raw = ui.items
        .map((it) => (typeof it?.text === 'string' ? it.text : ''))
        .filter(Boolean)
        .join('\n');
    } else if (typeof step?.content === 'string' && step.content.trim()) {
      const withoutSummary = step.content
        .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
        .replace(/<SYSTEM_MESSAGE>[\s\S]*$/i, '');
      const reqMatches = [...withoutSummary.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
      raw =
        reqMatches.length > 0
          ? reqMatches[reqMatches.length - 1][1]
          : withoutSummary.replace(/<ADDITIONAL_METADATA>[\s\S]*$/i, '');
    }
    const cleaned = String(raw || '')
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    const mediaArr = Array.isArray(ui?.media)
      ? ui.media
      : Array.isArray(step?.media)
        ? step.media
        : [];
    const hasMedia = mediaArr.length > 0;
    if (!cleaned) {
      return hasMedia ? '[Media/Attachment]' : '';
    }
    const withMedia = hasMedia ? `${cleaned} [Attachment]` : cleaned;
    return withMedia.length > 180 ? `${withMedia.slice(0, 179)}…` : withMedia;
  };

  rawSteps.forEach((s, index) => {
    if (isUserTurnBoundary(s)) {
      const promptText = extractUserTurnPrompt(s);
      if (!hasUnconsumedTurn) {
        hasUnconsumedTurn = true;
        pendingTurnPrompts = promptText ? [promptText] : [];
      } else if (
        promptText &&
        pendingTurnPrompts[pendingTurnPrompts.length - 1] !== promptText
      ) {
        pendingTurnPrompts.push(promptText);
      }
    }

    const m = s?.metadata;
    const u = m?.modelUsage || m?.retryInfos?.[0]?.usage;
    if (!u) {
      return;
    }

    let stepIsTurnStart = false;
    let stepTurnPrompt = '';
    if (hasUnconsumedTurn) {
      turnCounter += 1;
      activeTurnIndex = turnCounter;
      stepIsTurnStart = true;
      const joinedPrompt = pendingTurnPrompts.join('\n').trim();
      stepTurnPrompt =
        joinedPrompt.length > 180 ? `${joinedPrompt.slice(0, 179)}…` : joinedPrompt;
      hasUnconsumedTurn = false;
      pendingTurnPrompts = [];
    }

    const stepIndex = m.sourceTrajectoryStepInfo?.stepIndex ?? index;
    if (Array.isArray(m.generatorMetadata)) {
      for (const g of m.generatorMetadata) {
        collectOrchestratorExecModel(g?.plannerConfig);
      }
    }
    const inlineChat = Array.isArray(m.generatorMetadata)
      ? m.generatorMetadata.find((g) => g?.chatModel)
      : null;
    const gm = inlineChat || genByStep.get(Number(stepIndex));
    const chat = gm?.chatModel;
    const p = s.plannerResponse || {};
    const isCompactionStep = isCheckpointStep(s);
    if (isCompactionStep && Number.isFinite(Number(stepIndex))) {
      lastCompactionStepIdx = Math.max(lastCompactionStepIdx, Number(stepIndex));
    }

    const inputTokens = safeTokenCount(u.inputTokens);
    const cacheReadTokens = safeTokenCount(u.cacheReadTokens);
    const outputTokens = safeTokenCount(u.outputTokens);
    const rawThinkingTok = safeTokenCount(
      p.thinkingTokens ??
        u.thinkingOutputTokens ??
        chat?.usage?.thinkingOutputTokens ??
        0
    );
    const rawResponseTok =
      p.responseTokens ??
      u.responseOutputTokens ??
      chat?.usage?.responseOutputTokens;
    const thinkingTokens =
      rawResponseTok !== undefined && rawResponseTok !== null
        ? rawThinkingTok
        : Math.min(outputTokens, rawThinkingTok);
    const responseTokens =
      rawResponseTok !== undefined && rawResponseTok !== null
        ? safeTokenCount(rawResponseTok)
        : Math.max(0, outputTokens - thinkingTokens);

    const start = parseIsoMs(m.createdAt);
    // CLEARED
    const isCleared = s.status === 'CORTEX_STEP_STATUS_CLEARED';
    const measuredDuration = requestDuration(
      m.createdAt,
      m.finishedGeneratingAt || (isCleared ? null : m.completedAt)
    );
    const explicitlyIncomplete = Boolean(
      s.status && s.status !== 'CORTEX_STEP_STATUS_DONE' && !isCleared
    );
    const complete = !explicitlyIncomplete && measuredDuration !== null;
    const totalDurationSec = complete ? measuredDuration : null;
    const nativeTtftSec = duration(chat?.timeToFirstToken);

    // streamingDuration / thinkingDuration
    // streamingDuration
    const nativeStreamSec = duration(chat?.streamingDuration);
    const thinkingDurationSec = duration(p.thinkingDuration);

    // Token
    let timingReason = null;
    if (s.status === 'CORTEX_STEP_STATUS_CANCELED') {
      timingReason = 'canceled';
    } else if (!complete || !(totalDurationSec > 0)) {
      timingReason = 'incomplete_or_invalid_timing';
    } else if (!validCount(u.outputTokens)) {
      timingReason = 'invalid_output_tokens';
    } else if (totalDurationSec < MIN_SPEED_DURATION_SECONDS) {
      timingReason = 'short_timing';
    } else if (
      nativeTtftSec !== null &&
      nativeTtftSec > totalDurationSec + 0.01
    ) {
      timingReason = 'inconsistent_timing';
    }

    const totalTokPerSec =
      timingReason === null ? outputTokens / totalDurationSec : null;
    const shortOutputSample =
      totalTokPerSec !== null && outputTokens < MIN_MEAN_OUTPUT_TOKENS;
    const speedReason =
      timingReason ||
      (isCompactionStep
        ? 'compaction'
        : shortOutputSample
          ? 'short_sample'
          : null);

    const context = chat?.chatStartMetadata?.contextWindowMetadata;
    const contextBreakdown = extractContextBreakdown(chat);

    
    // Checkpoint inferCompactionStepModels
    const isValidModelValue = (value) =>
      typeof value === 'string' &&
      value.trim() &&
      !/^(?:0|unknown|MODEL_(?:UNSPECIFIED|UNKNOWN))$/i.test(value.trim());

    const modelCandidates = [
      ['usage.model', u.model],
      ['chat.usage.model', chat?.usage?.model],
      ['chat.model', chat?.model],
      ['metadata.generatorModel', m.generatorModel],
      ['chat.responseModel', chat?.responseModel],
    ];
    const identity = modelCandidates.find(([, value]) =>
      isValidModelValue(value)
    );
    const rawResponseModel = [
      chat?.responseModel,
      u?.responseModel,
      m?.responseModel,
    ].find(isValidModelValue);

    const resolvedModelKey = identity ? identity[1].trim() : 'unknown';
    const rawDisplayName = chat?.modelDisplayName || '';
    const isGenericWorkerDisplay =
      !rawDisplayName ||
      /\borchestrator\b/i.test(rawDisplayName) ||
      /^gemini\s+(?:flash|pro)(?:\s+worker)?$/i.test(rawDisplayName.trim());
    const resolvedDisplayName =
      (orchestratorExecModels.has(resolvedModelKey) ||
        /^gemini-flash-worker-agy$/i.test(rawResponseModel || '')) &&
      isGenericWorkerDisplay
        ? 'Orchestrator Worker (Hydrogen)'
        : rawDisplayName;

    result.push({
      stepIndex,
      isCompactionStep,
      modelKey: resolvedModelKey,
      modelSource: identity?.[0] || 'unavailable',
      responseModel: rawResponseModel ? rawResponseModel.trim() : '',
      modelIdentityVersion: MODEL_IDENTITY_VERSION,
      modelDisplayName: resolvedDisplayName,
      apiProvider: u.apiProvider || chat?.usage?.apiProvider || '',
      createdAt: m.createdAt || null,
      createdAtMs: Math.floor(start),
      hasVisibleText:
        String(p.modifiedResponse || p.response || '').trim().length > 0,
      hasToolCalls: Array.isArray(p.toolCalls) && p.toolCalls.length > 0,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      estimatedContextTokens: Number(
        context?.estimatedTokensUsed || contextBreakdown?.totalTokens || 0
      ),
      maxContextBudgetTokens: Number(context?.maxContextTokens || 256000),
      ...(context?.maxContextTokens > 0 ? { reportedContextLimitTokens: Number(context.maxContextTokens) } : {}),
      contextBreakdown,
      measurementVersion: MEASUREMENT_VERSION,
      isComplete: complete,
      nativeTtftSec,
      nativeStreamSec,
      viewableDelaySec: elapsed(start, parseIsoMs(m.viewableAt)),
      ttftSec: nativeTtftSec,
      ttftSource: nativeTtftSec === null ? 'unavailable' : 'native',
      thinkingDurationSec,
      totalDurationSec,
      totalTokPerSec,
      speedBasis: totalTokPerSec === null ? 'unavailable' : 'request_total',
      speedSampleEligible:
        totalTokPerSec !== null && !shortOutputSample && !isCompactionStep,
      speedReason,
      turnIndex: activeTurnIndex,
      isTurnStart: stepIsTurnStart,
      ...(stepIsTurnStart && stepTurnPrompt ? { turnPrompt: stepTurnPrompt } : {}),
    });
  });

  // contextBreakdown generatorMetadata
  if (
    result.length > 0 &&
    !result[result.length - 1].isCompactionStep &&
    !result[result.length - 1].contextBreakdown &&
    latestBreakdownChat &&
    (lastCompactionStepIdx < 0 || latestBreakdownStepIdx > lastCompactionStepIdx)
  ) {
    const lastStep = result[result.length - 1];
    const fallbackBreakdown = extractContextBreakdown(latestBreakdownChat);
    const fallbackCtx =
      latestBreakdownChat?.chatStartMetadata?.contextWindowMetadata;
    lastStep.contextBreakdown = fallbackBreakdown;
    if (!lastStep.estimatedContextTokens) {
      lastStep.estimatedContextTokens = Number(
        fallbackCtx?.estimatedTokensUsed || fallbackBreakdown?.totalTokens || 0
      );
    }
    if (fallbackCtx?.maxContextTokens) {
      lastStep.maxContextBudgetTokens = Number(fallbackCtx.maxContextTokens);
    }
  }

  return inferCompactionStepModels(result);
}

/**
 * `isCompactionStep` 
 *
 * 4 `isExplicitDonor` 
 * - ** 1 Provider ** `idx - 1 -> 0` `apiProvider` 
 * - ** 2 Provider ** `idx + 1 -> steps.length - 1` `apiProvider` 
 * - ** 3 ** Provider 
 * - ** 4 ** 
 *
 * `modelKey` `modelSource` `'inferred_compaction'` `responseModel` `modelDisplayName` 
 *
 * @param {Array<object>} steps 
 * @returns {Array<object>} 
 */
export function inferCompactionStepModels(steps) {
  if (!Array.isArray(steps) || steps.length < 2) {
    return steps;
  }

  const isExplicitDonor = (step) =>
    Boolean(
      step &&
        step.modelKey &&
        step.modelKey !== 'unknown' &&
        step.modelSource !== 'inferred_compaction' &&
        step.modelSource !== 'legacy_unverified'
    );

  const isProviderCompatible = (target, donor) =>
    !target.apiProvider ||
    !donor.apiProvider ||
    target.apiProvider === donor.apiProvider;

  return steps.map((step, idx) => {
    if (!step?.isCompactionStep) {
      return step;
    }
    const needsModel = !step.modelKey || step.modelKey === 'unknown';
    const needsUpstream =
      step.modelSource === 'inferred_compaction' && !step.responseModel;
    if (!needsModel && !needsUpstream) {
      return step;
    }

    const canDonate = (cand) => {
      if (!isExplicitDonor(cand)) return false;
      if (!needsModel) {
        return cand.modelKey === step.modelKey && Boolean(cand.responseModel);
      }
      return true;
    };

    let donor = null;

    // 1 API Provider
    for (let j = idx - 1; j >= 0; j--) {
      if (canDonate(steps[j]) && isProviderCompatible(step, steps[j])) {
        donor = steps[j];
        break;
      }
    }
    // 2 API Provider
    if (!donor) {
      for (let j = idx + 1; j < steps.length; j++) {
        if (canDonate(steps[j]) && isProviderCompatible(step, steps[j])) {
          donor = steps[j];
          break;
        }
      }
    }
    
    if (!donor) {
      for (let j = idx - 1; j >= 0; j--) {
        if (canDonate(steps[j])) {
          donor = steps[j];
          break;
        }
      }
    }
    
    if (!donor) {
      for (let j = idx + 1; j < steps.length; j++) {
        if (canDonate(steps[j])) {
          donor = steps[j];
          break;
        }
      }
    }

    if (!donor) {
      return step;
    }

    const nextModelKey = needsModel ? donor.modelKey : step.modelKey;
    const nextModelSource = needsModel ? 'inferred_compaction' : step.modelSource;
    const donorSameModel = donor.modelKey === nextModelKey;
    const nextResponseModel =
      step.responseModel || (donorSameModel ? donor.responseModel || '' : '');
    const nextDisplayName =
      step.modelDisplayName || (donorSameModel ? donor.modelDisplayName || '' : '');

    if (
      nextModelKey === step.modelKey &&
      nextModelSource === step.modelSource &&
      nextResponseModel === (step.responseModel || '') &&
      nextDisplayName === (step.modelDisplayName || '')
    ) {
      return step;
    }

    return {
      ...step,
      modelKey: nextModelKey,
      modelSource: nextModelSource,
      responseModel: nextResponseModel,
      modelDisplayName: nextDisplayName,
    };
  });
}

/**
 * 
 *
 * 
 * 1. ** `v9` `MODEL_PLACEHOLDER_M418` ** 
 * `v9` Argon `MODEL_PLACEHOLDER_M418` `MODEL_PLACEHOLDER_M418` 
 * Token `MODEL_PLACEHOLDER_M418` 
 * `modelKey: 'unknown'` `modelSource: 'legacy_unverified'` `legacyModelKey` 
 * 2. ** ** 
 * `measurementVersion` `MEASUREMENT_VERSION` Token 
 * `speedReason: 'legacy_cache'` 
 *
 * @param {object} step 
 * @returns {object} 
 */
export function normalizeCachedStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    return null;
  }
  if (step.modelIdentityVersion !== MODEL_IDENTITY_VERSION) {
    const ambiguous =
      !step.modelKey || step.modelKey === 'MODEL_PLACEHOLDER_M418';
    step = {
      ...step,
      modelIdentityVersion: MODEL_IDENTITY_VERSION,
      ...(ambiguous
        ? {
            legacyModelKey: step.modelKey || null,
            modelKey: 'unknown',
            modelDisplayName: '',
            modelSource: 'legacy_unverified',
          }
        : { modelSource: 'legacy_explicit' }),
    };
  }

  const DEAD_V3_KEYS = [
    'phaseDurationSec',
    'phaseTokPerSec',
    'phaseReason',
    'answerStartDelaySec',
    'streamDurationSec',
    'streamTokens',
    'streamTokPerSec',
  ];
  const hasDeadV3Key = DEAD_V3_KEYS.some((k) => Object.prototype.hasOwnProperty.call(step, k));
  if (hasDeadV3Key) {
    step = { ...step };
    for (const k of DEAD_V3_KEYS) {
      delete step[k];
    }
  }

  const safeIn = safeTokenCount(step.inputTokens);
  const safeCache = safeTokenCount(step.cacheReadTokens);
  const safeOut = safeTokenCount(step.outputTokens);
  const safeThink = safeTokenCount(step.thinkingTokens);
  const safeResp =
    step.responseTokens !== undefined && step.responseTokens !== null
      ? safeTokenCount(step.responseTokens)
      : Math.max(0, safeOut - safeThink);

  if (
    step.inputTokens !== safeIn ||
    step.cacheReadTokens !== safeCache ||
    step.outputTokens !== safeOut ||
    step.thinkingTokens !== safeThink ||
    step.responseTokens !== safeResp
  ) {
    step = {
      ...step,
      inputTokens: safeIn,
      cacheReadTokens: safeCache,
      outputTokens: safeOut,
      thinkingTokens: safeThink,
      responseTokens: safeResp,
    };
  }

  if (step.measurementVersion === MEASUREMENT_VERSION) {
    return step;
  }

  return {
    ...step,
    measurementVersion: null,
    isComplete: false,
    nativeTtftSec: null,
    nativeStreamSec: null,
    viewableDelaySec: null,
    ttftSec: null,
    ttftSource: 'unavailable',
    thinkingDurationSec: null,
    totalDurationSec: null,
    totalTokPerSec: null,
    speedBasis: 'unavailable',
    speedSampleEligible: false,
    speedReason: 'legacy_cache',
  };
}

/**
 * 
 *
 * @param {object} step 
 * @returns {{ value: number | null, tokens: number, seconds: number, eligible: boolean, reason: string | null }}
 */
export function speedMetric(step) {
  const missing = (reason) => ({
    value: null,
    tokens: 0,
    seconds: 0,
    eligible: false,
    reason,
  });

  if (step.measurementVersion !== MEASUREMENT_VERSION) {
    return missing('legacy_cache');
  }
  if (
    !step.isComplete ||
    !Number.isFinite(step.totalTokPerSec) ||
    !(step.totalDurationSec >= MIN_SPEED_DURATION_SECONDS)
  ) {
    const reason = step.speedReason || 'incomplete_or_invalid_timing';
    return missing(step.isCompactionStep && reason === 'incomplete_or_invalid_timing'
      ? 'compaction_timing_unavailable'
      : reason);
  }

  return {
    value: step.totalTokPerSec,
    tokens: step.outputTokens,
    seconds: step.totalDurationSec,
    eligible: step.speedSampleEligible === true && !step.isCompactionStep,
    reason: step.speedReason,
  };
}

/**
 * 
 *
 * @returns {{ tokens: number, seconds: number, sampleCount: number, excludedCount: number, excludedReasons: Record<string, number> }}
 */
export function createSpeedAccumulator() {
  return {
    tokens: 0,
    seconds: 0,
    sampleCount: 0,
    excludedCount: 0,
    excludedReasons: {},
  };
}

/**
 * 
 *
 * @param {ReturnType<typeof createSpeedAccumulator>} acc 
 * @param {object} step 
 */
export function accumulateSpeed(acc, step) {
  if (step.isCompactionStep) {
    return;
  }
  const metric = speedMetric(step);
  if (metric.eligible) {
    acc.tokens += metric.tokens;
    acc.seconds += metric.seconds;
    acc.sampleCount++;
  } else {
    acc.excludedCount++;
    acc.excludedReasons[metric.reason] =
      (acc.excludedReasons[metric.reason] || 0) + 1;
  }
}

/**
 * ` Tokens / ` 
 *
 * @param {ReturnType<typeof createSpeedAccumulator>} acc 
 * @returns {ReturnType<typeof createSpeedAccumulator> & { avgTokPerSec: number | null }}
 */
export function finishSpeed(acc) {
  return {
    ...acc,
    avgTokPerSec: acc.seconds > 0 ? acc.tokens / acc.seconds : null,
  };
}

/**
 * 
 *
 * @param {Array<object>} steps 
 * @returns {ReturnType<typeof finishSpeed>}
 */
export function summarizeSpeed(steps) {
  const acc = createSpeedAccumulator();
  for (const step of steps) {
    accumulateSpeed(acc, step);
  }
  return finishSpeed(acc);
}

/**
 * TTFT 
 * `0 <= nativeTtftSec <= totalDurationSec + 0.01` 
 *
 * @param {Array<object>} steps 
 * @returns {{ sampleCount: number, avgSec: number | null }}
 */
export function summarizeTtft(steps) {
  const values = steps
    .filter(
      (s) =>
        !s.isCompactionStep &&
        s.measurementVersion === MEASUREMENT_VERSION &&
        s.isComplete &&
        Number.isFinite(s.totalDurationSec) &&
        Number.isFinite(s.nativeTtftSec) &&
        s.nativeTtftSec >= 0 &&
        s.nativeTtftSec <= s.totalDurationSec + 0.01
    )
    .map((s) => s.nativeTtftSec);

  const avgSec = values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;

  return {
    sampleCount: values.length,
    avgSec,
  };
}

/** Connect RPC transcript.jsonl */
const LIVE_TERMINAL_STATUSES = new Set([
  'CORTEX_STEP_STATUS_DONE',
  'CORTEX_STEP_STATUS_CLEARED',
  'CORTEX_STEP_STATUS_ERROR',
  'CORTEX_STEP_STATUS_CANCELED',
  'CORTEX_STEP_STATUS_CANCELLED',
  'DONE',
  'CLEARED',
  'ERROR',
  'CANCELED',
  'CANCELLED',
]);

/**
 * 
 *
 * @param {unknown} status
 * @returns {boolean}
 */
function isWaitingStepStatus(status) {
  const s = String(status || '').toUpperCase();
  return (
    s.includes('WAIT') ||
    s.includes('CONFIRM') ||
    s.includes('APPROV') ||
    s.includes('BLOCKED')
  );
}

/**
 * 
 *
 * @param {object} step
 * @returns {boolean}
 */
function isRawStepComplete(step) {
  if (!step || typeof step !== 'object') return true;
  if (typeof step.status === 'string' && step.status.trim()) {
    return LIVE_TERMINAL_STATUSES.has(step.status.trim().toUpperCase());
  }
  return Boolean(
    step.metadata?.completedAt ||
      step.metadata?.finishedGeneratingAt ||
      step.completed_at ||
      step.completedAt
  );
}

function getRawStepStartMs(step) {
  const m = step?.metadata || {};
  return Math.floor(
    parseIsoMs(m.createdAt || m.viewableAt || step?.created_at || step?.createdAt) || 0
  );
}

function getRawStepFinishMs(step) {
  const m = step?.metadata || {};
  const explicitEnd = parseIsoMs(
    m.completedAt || m.finishedGeneratingAt || step?.completed_at || step?.completedAt
  );
  if (explicitEnd > 0) return Math.floor(explicitEnd);
  if (typeof step?.content === 'string') {
    const mCompleted = step.content.match(/^Completed At:\s*(\S+)/m);
    if (mCompleted && mCompleted[1]) {
      const parsed = parseIsoMs(mCompleted[1]);
      if (parsed > 0) return Math.floor(parsed);
    }
  }
  return 0;
}

function getRawStepEndMs(step) {
  const finishMs = getRawStepFinishMs(step);
  if (finishMs > 0) return finishMs;
  const m = step?.metadata || {};
  return Math.floor(
    parseIsoMs(m.viewableAt || m.createdAt || step?.created_at || step?.createdAt) || 0
  );
}

function getStepStableId(step, fallbackIdx) {
  const idx =
    step?.step_index ??
    step?.stepIndex ??
    step?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
  return idx !== undefined && idx !== null ? idx : fallbackIdx;
}

/**
 * `transcript.jsonl` JSON 
 *
 * @param {unknown} val
 * @returns {unknown}
 */
function unwrapArgValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // JSON
    }
  }
  return trimmed
    .replace(/^"+|"+$/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, '');
}

function unwrapArgString(val) {
  const unwrapped = unwrapArgValue(val);
  if (typeof unwrapped === 'string') return unwrapped.trim();
  if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return String(unwrapped);
  return '';
}

/**
 * Windows `file://` URI 
 *
 * @param {unknown} rawPath
 * @returns {string}
 */
function shortBasename(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return '';
  let cleaned = unwrapArgString(rawPath).replace(/^file:\/\/\/?/i, '');
  try {
    if (cleaned.includes('%')) {
      cleaned = decodeURIComponent(cleaned);
    }
  } catch {
 // URI 
  }
  cleaned = cleaned.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/**
 * Markdown 
 *
 * @param {unknown} rawText
 * @param {number} [maxLen=52]
 * @param {boolean} [takeLastLine=false]
 * @returns {string}
 */
function cleanSingleLineSnippet(rawText, maxLen = 52, takeLastLine = false) {
  if (typeof rawText !== 'string' || !rawText.trim()) return '';
  const lines = rawText
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^[#>*\-\d.\s]+/, '')
        .replace(/[`*_~]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  if (lines.length === 0) return '';
  const target = takeLastLine ? lines[lines.length - 1] : lines[0];
  return target.length > maxLen ? `${target.slice(0, maxLen - 1)}…` : target;
}

/**
 * JSON 
 *
 * @param {string} rawJson
 * @param {string[]} keys
 * @returns {string}
 */
function extractPartialJsonStringField(rawJson, keys) {
  if (typeof rawJson !== 'string' || !rawJson) return '';
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`, 'i');
    const m = rawJson.match(re);
    if (m && m[1]) {
      return m[1]
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, '')
        .trim();
    }
  }
  return '';
}

function getStepPlannerToolCalls(step) {
  if (Array.isArray(step?.plannerResponse?.toolCalls)) {
    return step.plannerResponse.toolCalls;
  }
  if (Array.isArray(step?.tool_calls)) {
    return step.tool_calls;
  }
  if (Array.isArray(step?.toolCalls)) {
    return step.toolCalls;
  }
  return [];
}

function getStepResponseText(step) {
  const p = step?.plannerResponse || {};
  return String(p.modifiedResponse || p.response || step?.content || '').trim();
}

function getStepThinkingText(step) {
  const p = step?.plannerResponse || {};
  return String(p.rawThinking || p.thinking || step?.thinking || '').trim();
}

function isPlannerStep(step) {
  const t = String(step?.type || '').toUpperCase();
  return (
    t === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' ||
    t === 'PLANNER_RESPONSE' ||
    Boolean(step?.plannerResponse) ||
    Array.isArray(step?.tool_calls)
  );
}

function isCheckpointStep(step) {
  const t = String(step?.type || '').toUpperCase();
  if (
    t === 'CORTEX_STEP_TYPE_CHECKPOINT' ||
    t === 'CHECKPOINT' ||
    t.includes('CHECKPOINT') ||
    Boolean(step?.checkpoint && typeof step.checkpoint === 'object')
  ) {
    return true;
  }
  if (t.includes('SYSTEM') && typeof step?.content === 'string') {
    return /^\s*#\s*Resuming from a compaction\b/i.test(step.content);
  }
  return false;
}

function isAuxiliaryMetaStep(step) {
  const t = String(step?.type || '').toUpperCase();
  return t.includes('MEMENTO') || t.includes('EPHEMERAL');
}

/**
 * JSON 
 *
 * @param {object|null|undefined} rawToolCall
 * @param {object|null|undefined} [fallbackStep=null]
 * @returns {{ toolName: string, isAskUser: boolean, label: string, detail: string }}
 */
export function summarizeToolCall(rawToolCall, fallbackStep = null) {
  const stepToolCall = fallbackStep?.metadata?.toolCall || {};
  const stepType = String(fallbackStep?.type || '').toUpperCase();
  let rawName = String(
    rawToolCall?.name ||
      rawToolCall?.toolName ||
      rawToolCall?.function?.name ||
      stepToolCall?.name ||
      ''
  ).trim();

  if (!rawName) {
    if (
      stepType.includes('RUN_COMMAND') ||
      stepType.includes('COMMAND_STATUS') ||
      fallbackStep?.runCommand
    ) {
      rawName = 'run_command';
    } else if (stepType.includes('INVOKE_SUBAGENT') || fallbackStep?.invokeSubagent) {
      rawName = 'invoke_subagent';
    } else if (
      stepType.includes('VIEW_FILE') ||
      stepType.includes('READ_FILE') ||
      fallbackStep?.viewFile ||
      fallbackStep?.readFile
    ) {
      rawName = 'read_file';
    } else if (
      stepType.includes('CODE_ACTION') ||
      stepType.includes('EDIT_FILE') ||
      fallbackStep?.codeAction ||
      fallbackStep?.editFile
    ) {
      rawName = 'edit_file';
    } else if (stepType.includes('GREP_SEARCH') || fallbackStep?.grepSearch) {
      rawName = 'grep_search';
    } else if (stepType.includes('FIND_BY_NAME') || fallbackStep?.findByName) {
      rawName = 'find_by_name';
    } else if (stepType.includes('SEARCH_WEB') || fallbackStep?.searchWeb) {
      rawName = 'search_web';
    }
  }

  const nameLower = rawName.toLowerCase().replace(/^default_api:/, '');
  let args = {};
  let rawArgsStr = '';

  const candidateArgs =
    rawToolCall?.args ??
    rawToolCall?.arguments ??
    rawToolCall?.argumentsJson ??
    rawToolCall?.function?.arguments ??
    stepToolCall?.argumentsJson;

  if (candidateArgs && typeof candidateArgs === 'object') {
    args = candidateArgs;
  } else if (typeof candidateArgs === 'string' && candidateArgs.trim()) {
    rawArgsStr = candidateArgs.trim();
    try {
      const parsed = JSON.parse(rawArgsStr);
      if (parsed && typeof parsed === 'object') args = parsed;
    } catch {
 // JSON 
    }
  }

  const stepPayload =
    fallbackStep?.runCommand ||
    fallbackStep?.commandStatus ||
    fallbackStep?.viewFile ||
    fallbackStep?.readFile ||
    fallbackStep?.viewFileOutline ||
    fallbackStep?.viewCodeItem ||
    fallbackStep?.codeAction ||
    fallbackStep?.editFile ||
    fallbackStep?.replaceFileContent ||
    fallbackStep?.writeToFile ||
    fallbackStep?.grepSearch ||
    fallbackStep?.findByName ||
    fallbackStep?.listDir ||
    fallbackStep?.searchWeb ||
    fallbackStep?.readUrlContent ||
    null;

  const pickField = (keys) => {
    for (const k of keys) {
      const fromArgs = unwrapArgString(args?.[k]);
      if (fromArgs) return fromArgs;
      const camelKey = k.charAt(0).toLowerCase() + k.slice(1);
      const fromArgsCamel = unwrapArgString(args?.[camelKey]);
      if (fromArgsCamel) return fromArgsCamel;
      if (stepPayload && typeof stepPayload === 'object') {
        const fromStep = unwrapArgString(stepPayload[k] ?? stepPayload[camelKey]);
        if (fromStep) return fromStep;
      }
    }
    return extractPartialJsonStringField(rawArgsStr, keys);
  };

  if (
    nameLower === 'run_command' ||
    nameLower === 'command_status' ||
    nameLower === 'send_command_input'
  ) {
    const summary = pickField(['toolSummary', 'Description', 'Summary']);
    const cmd = pickField(['CommandLine', 'Command', 'command']);
    const cmdSnippet = cleanSingleLineSnippet(cmd, 48);
    const detail =
      summary && cmdSnippet && summary !== cmdSnippet
        ? `${summary} (${cmdSnippet})`
        : summary || cmdSnippet || '';
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Running command',
      detail,
    };
  }

  if (
    nameLower === 'read_file' ||
    nameLower === 'view_file' ||
    nameLower === 'view_file_outline' ||
    nameLower === 'view_code_item' ||
    nameLower === 'read_notebook'
  ) {
    const file = shortBasename(
      pickField(['Path', 'AbsolutePath', 'AbsolutePathUri', 'FilePath', 'File', 'Uri'])
    );
    const startLine = pickField(['StartLine', 'startLine']);
    const endLine = pickField(['EndLine', 'endLine']);
    const rangeSuffix =
      startLine && endLine
        ? `:${startLine}-${endLine}`
        : startLine
          ? `:${startLine}+`
          : '';
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Reading file',
      detail: file ? `${file}${rangeSuffix}` : '',
    };
  }

  if (
    nameLower === 'edit_file' ||
    nameLower === 'replace_file_content' ||
    nameLower === 'multi_replace_file_content' ||
    nameLower === 'edit_notebook'
  ) {
    const file = shortBasename(
      pickField(['Path', 'TargetFile', 'AbsolutePath', 'AbsolutePathUri', 'FilePath', 'Uri'])
    );
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Editing file',
      detail: file || '',
    };
  }

  if (nameLower === 'write_file' || nameLower === 'write_to_file') {
    const file = shortBasename(
      pickField(['Path', 'TargetFile', 'AbsolutePath', 'AbsolutePathUri', 'FilePath', 'Uri'])
    );
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Writing file',
      detail: file || '',
    };
  }

  if (nameLower === 'grep_search' || nameLower === 'ripgrep') {
    const query = pickField(['Query', 'Pattern', 'query']);
    const searchPath = shortBasename(pickField(['SearchPath', 'DirectoryPath', 'Path']));
    const detail =
      query && searchPath
        ? `${cleanSingleLineSnippet(query, 32)} (${searchPath})`
        : cleanSingleLineSnippet(query, 48) || searchPath || '';
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Searching code',
      detail,
    };
  }

  if (nameLower === 'find_by_name' || nameLower === 'list_dir') {
    const pattern = pickField(['Pattern', 'Query']);
    const dir = shortBasename(pickField(['SearchDirectory', 'DirectoryPath', 'Path']));
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Finding files',
      detail: pattern && dir ? `${pattern} (${dir})` : pattern || dir || '',
    };
  }

  if (nameLower === 'search_web' || nameLower === 'read_url_content' || nameLower === 'fetch_url') {
    const isUrl = nameLower.includes('url');
    const target = pickField(['query', 'Query', 'Url', 'url']);
    return {
      toolName: nameLower,
      isAskUser: false,
      label: isUrl ? 'Reading webpage' : 'Searching web',
      detail: cleanSingleLineSnippet(target, 52) || '',
    };
  }

  if (nameLower === 'invoke_subagent') {
    const subSpec = fallbackStep?.invokeSubagent?.subagents?.[0] || {};
    const role =
      pickField(['Role', 'role']) ||
      String(subSpec.role || '').trim() ||
      pickField(['TypeName', 'typeName']) ||
      String(subSpec.typeName || '').trim();
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Invoking subagent',
      detail: role || '',
    };
  }

  if (nameLower === 'send_message') {
    const recipient = pickField(['Recipient', 'recipient']);
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Messaging subagent',
      detail: recipient ? recipient.slice(0, 8) : '',
    };
  }

  if (nameLower === 'manage_subagents' || nameLower === 'define_subagent') {
    const subName = pickField(['Name', 'Action', 'action']);
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Managing subagents',
      detail: subName || '',
    };
  }

  if (nameLower === 'manage_task') {
    const action = pickField(['Action', 'action']);
    const taskId = pickField(['TaskId', 'taskId']);
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Background task',
      detail: taskId ? `${action || 'status'} (${taskId})` : action || '',
    };
  }

  if (nameLower === 'schedule') {
    const dur = pickField(['DurationSeconds']);
    const cron = pickField(['CronExpression']);
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Scheduled task',
      detail: dur ? `${dur}s` : cron || '',
    };
  }

  if (nameLower === 'ask_question') {
    const rawQuestions = unwrapArgValue(args?.questions);
    const qText =
      (Array.isArray(rawQuestions) ? rawQuestions[0]?.question : '') ||
      extractPartialJsonStringField(
        typeof args?.questions === 'string' ? args.questions : rawArgsStr,
        ['question']
      );
    return {
      toolName: nameLower,
      isAskUser: true,
      label: 'Waiting for user choice',
      detail: cleanSingleLineSnippet(qText, 50) || '',
    };
  }

  if (nameLower === 'search_marketplace' || nameLower === 'list_plugin_accounts') {
    const rawQueries = unwrapArgValue(args?.queries);
    const q = Array.isArray(rawQueries) ? rawQueries.join(', ') : '';
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Searching marketplace',
      detail: cleanSingleLineSnippet(q, 48) || '',
    };
  }

  if (isMcpToolItem(nameLower)) {
    const mcpClean = nameLower.replace(/^mcp[_-]/i, '').replace(/_/g, ' · ');
    return {
      toolName: nameLower,
      isAskUser: false,
      label: 'Calling MCP tool',
      detail: mcpClean || '',
    };
  }

  return {
    toolName: nameLower || 'tool',
    isAskUser: false,
    label: 'Running tool',
    detail: nameLower || '',
  };
}

/**
 * (`rawSteps` `GetCascadeTrajectory` `transcript.jsonl`) 
 *
 * Agent 
 * 1. “ ” 
 * 2. (`!isRawStepComplete(lastStep)`) 
 * - `CHECKPOINT` “ ” 
 * - `PLANNER_RESPONSE` `toolCalls -> response -> thinking -> ` 
 * - `status` “ ” `PLANNER_RESPONSE` `[m/n]` 
 * 3. (`DONE`) `RUNNING` 
 * - `PLANNER_RESPONSE` `N` `M < N` `M + 1` 
 * - `M >= N` `USER_INPUT` 
 *
 * @param {Array<object>} [rawSteps=[]]
 * @param {boolean} [isRunning=false]
 * @param {number} [fallbackStartMs=0]
 * @returns {{
 *   phase: 'thinking' | 'responding' | 'tool' | 'waiting' | 'compacting',
 *   label: string,
 *   detail: string,
 *   stepProgress: string,
 *   startedAtMs: number,
 *   signature: string
 * } | null}
 */
export function getMaxMeaningfulStepIndex(rawSteps = []) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) return -1;
  let idx = rawSteps.length - 1;
  while (idx > 0 && isAuxiliaryMetaStep(rawSteps[idx]) && isRawStepComplete(rawSteps[idx])) {
    idx--;
  }
  const numId = Number(getStepStableId(rawSteps[idx], idx));
  return Number.isFinite(numId) ? numId : idx;
}

export function extractLiveActivity(rawSteps = [], isRunning = false, fallbackStartMs = 0) {
  if (!isRunning) return null;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    const startMs = Math.floor(fallbackStartMs || 0);
    return {
      phase: 'thinking',
      label: 'Thinking',
      detail: '',
      stepProgress: '',
      startedAtMs: startMs,
      signature: `init:0`,
    };
  }

  const hasBracketPrefix = (text) => /^\[\d+\s*\/\s*\d+\]/.test(String(text || '').trim());

  let lastPlannerIdx = -1;
  let lastUserIdx = -1;
  let lastCheckpointIdx = -1;
  for (let i = rawSteps.length - 1; i >= 0; i--) {
    const st = rawSteps[i];
    const t = String(st?.type || '').toUpperCase();
    if (lastCheckpointIdx === -1 && isCheckpointStep(st)) {
      lastCheckpointIdx = i;
    }
    if (lastPlannerIdx === -1 && isPlannerStep(st)) {
      lastPlannerIdx = i;
    }
    if (lastUserIdx === -1 && t.includes('USER_INPUT')) {
      lastUserIdx = i;
    }
    if (lastPlannerIdx !== -1 && lastUserIdx !== -1 && lastCheckpointIdx !== -1) break;
  }

 // MEMENTO / EPHEMERAL_MESSAGE / 
  let lastIdx = rawSteps.length - 1;
  while (lastIdx > 0 && isAuxiliaryMetaStep(rawSteps[lastIdx]) && isRawStepComplete(rawSteps[lastIdx])) {
    lastIdx--;
  }
  const lastStep = rawSteps[lastIdx];
  const lastStepId = getStepStableId(lastStep, lastIdx);
  const lastComplete = isRawStepComplete(lastStep);

 // A 
  if (!lastComplete) {
    const prevStepEndMs =
      lastIdx > 0
        ? getRawStepFinishMs(rawSteps[lastIdx - 1]) || getRawStepEndMs(rawSteps[lastIdx - 1])
        : 0;
    const startMs =
      getRawStepStartMs(lastStep) || prevStepEndMs || Math.floor(fallbackStartMs || 0);

    if (isCheckpointStep(lastStep)) {
      return {
        phase: 'compacting',
        label: 'Compacting context',
        detail: '',
        stepProgress: '',
        startedAtMs: startMs,
        signature: `compacting:${lastStepId}`,
      };
    }

    if (isPlannerStep(lastStep)) {
      const tools = getStepPlannerToolCalls(lastStep);
      const respText = getStepResponseText(lastStep);
      const thinkText = getStepThinkingText(lastStep);

      if (tools.length > 0) {
        const activeTool = tools[tools.length - 1];
        const info = summarizeToolCall(activeTool, lastStep);
        const stepProgress =
          tools.length > 1 && !hasBracketPrefix(info.detail) ? `${tools.length}/${tools.length}` : '';
        const phase = info.isAskUser ? 'waiting' : 'tool';
        return {
          phase,
          label: info.label,
          detail: info.detail,
          stepProgress,
          startedAtMs: startMs,
          signature: `planner-tool:${lastStepId}:${tools.length}:${info.label}:${info.detail}`,
        };
      }

      if (respText.length > 0) {
        const snippet = cleanSingleLineSnippet(respText, 52, true);
        return {
          phase: 'responding',
          label: 'Responding',
          detail: snippet,
          stepProgress: '',
          startedAtMs: startMs,
          signature: `responding:${lastStepId}:${snippet}`,
        };
      }

      if (thinkText.length > 0) {
        const snippet = cleanSingleLineSnippet(thinkText, 52, true);
        return {
          phase: 'thinking',
          label: 'Thinking',
          detail: snippet,
          stepProgress: '',
          startedAtMs: startMs,
          signature: `thinking:${lastStepId}:${snippet}`,
        };
      }

      return {
        phase: 'thinking',
        label: 'Thinking',
        detail: '',
        stepProgress: '',
        startedAtMs: startMs,
        signature: `waiting-ttft:${lastStepId}`,
      };
    }

 // PLANNER_RESPONSE 
    let matchedPlannerTool = null;
    let stepProgress = '';
    if (lastPlannerIdx >= 0 && lastPlannerIdx > lastUserIdx && lastPlannerIdx > lastCheckpointIdx) {
      const pTools = getStepPlannerToolCalls(rawSteps[lastPlannerIdx]);
      const toolStepsAfterPlanner = [];
      for (let k = lastPlannerIdx + 1; k <= lastIdx; k++) {
        const kt = String(rawSteps[k]?.type || '').toUpperCase();
        if (!kt.includes('CHECKPOINT') && !kt.includes('MEMENTO') && !kt.includes('EPHEMERAL')) {
          toolStepsAfterPlanner.push(rawSteps[k]);
        }
      }
      const toolIdx = toolStepsAfterPlanner.length - 1;
      if (toolIdx >= 0 && toolIdx < pTools.length) {
        matchedPlannerTool = pTools[toolIdx];
        if (pTools.length > 1) {
          stepProgress = `${toolIdx + 1}/${pTools.length}`;
        }
      }
    }

    const info = summarizeToolCall(matchedPlannerTool, lastStep);
    if (hasBracketPrefix(info.detail)) {
      stepProgress = '';
    }
    const waiting = isWaitingStepStatus(lastStep?.status) || info.isAskUser;
    const resolvedStartMs = startMs || prevStepEndMs || 0;
    const label = waiting && !info.isAskUser ? `Waiting approval · ${info.label}` : info.label;

    return {
      phase: waiting ? 'waiting' : 'tool',
      label,
      detail: info.detail,
      stepProgress,
      startedAtMs: resolvedStartMs,
      signature: `step-run:${lastStepId}:${waiting}:${label}:${stepProgress}:${info.detail}`,
    };
  }

 // A2 (DONE) transcript.jsonl CHECKPOINT
 // RPC 
  if (lastCheckpointIdx >= 0 && lastCheckpointIdx > lastPlannerIdx && lastCheckpointIdx > lastUserIdx) {
    let hasPostCheckpointToolStep = false;
    for (let k = lastCheckpointIdx + 1; k <= lastIdx; k++) {
      const kt = String(rawSteps[k]?.type || '').toUpperCase();
      if (
        !isCheckpointStep(rawSteps[k]) &&
        !isAuxiliaryMetaStep(rawSteps[k]) &&
        !kt.includes('GENERIC') &&
        !kt.includes('SYSTEM')
      ) {
        hasPostCheckpointToolStep = true;
        break;
      }
    }
    if (!hasPostCheckpointToolStep) {
      const cpStep = rawSteps[lastCheckpointIdx];
      const cpStepId = getStepStableId(cpStep, lastCheckpointIdx);
      const prevBeforeCpMs =
        lastCheckpointIdx > 0
          ? getRawStepFinishMs(rawSteps[lastCheckpointIdx - 1]) ||
            getRawStepEndMs(rawSteps[lastCheckpointIdx - 1])
          : 0;
      const cpFinishMs = getRawStepFinishMs(cpStep);
      const cpStartMs =
        cpFinishMs ||
        getRawStepStartMs(cpStep) ||
        prevBeforeCpMs ||
        Math.floor(fallbackStartMs || 0);
      return {
        phase: 'compacting',
        label: 'Compacting context',
        detail: cpFinishMs > 0 ? 'Compaction done, resuming' : '',
        stepProgress: '',
        startedAtMs: cpStartMs,
        signature: cpFinishMs > 0 ? `compacting-done:${cpStepId}` : `compacting:${cpStepId}`,
      };
    }
  }

 // B (DONE) RUNNING PLANNER_RESPONSE 
  if (lastPlannerIdx >= 0 && lastPlannerIdx > lastUserIdx && lastPlannerIdx > lastCheckpointIdx) {
    const plannerStep = rawSteps[lastPlannerIdx];
    const plannerStepId = getStepStableId(plannerStep, lastPlannerIdx);
    const pTools = getStepPlannerToolCalls(plannerStep);
    const toolStepsAfterPlanner = [];
    for (let k = lastPlannerIdx + 1; k <= lastIdx; k++) {
      const kt = String(rawSteps[k]?.type || '').toUpperCase();
      if (!kt.includes('CHECKPOINT') && !kt.includes('MEMENTO') && !kt.includes('EPHEMERAL')) {
        toolStepsAfterPlanner.push(rawSteps[k]);
      }
    }
    const completedAfterPlanner = toolStepsAfterPlanner.length;

 // B1 PLANNER_RESPONSE N (completedAfterPlanner < N)
    if (pTools.length > 0 && completedAfterPlanner < pTools.length) {
      const currentTool = pTools[completedAfterPlanner];
      const info = summarizeToolCall(currentTool, null);
      const stepProgress =
        pTools.length > 1 && !hasBracketPrefix(info.detail)
          ? `${completedAfterPlanner + 1}/${pTools.length}`
          : '';
 // transcript.jsonl 
      const startMs =
        getRawStepFinishMs(lastStep) ||
        getRawStepFinishMs(plannerStep) ||
        getRawStepEndMs(lastStep) ||
        getRawStepEndMs(plannerStep) ||
        0;
      const phase = info.isAskUser ? 'waiting' : 'tool';

      return {
        phase,
        label: info.label,
        detail: info.detail,
        stepProgress,
        startedAtMs: startMs,
        signature: `pending-tool:${plannerStepId}:${completedAfterPlanner}:${info.label}:${stepProgress}:${info.detail}`,
      };
    }

 // B2 / 
    if (pTools.length > 0 && completedAfterPlanner >= pTools.length) {
      const infos = pTools.map((t, idx) =>
        summarizeToolCall(t, toolStepsAfterPlanner[idx] || lastStep)
      );
      const lastToolInfo = infos[infos.length - 1];
      const allSameLabel = infos.every((x) => x.label === lastToolInfo.label);
      const detailsList = infos.map((x) => x.detail).filter(Boolean);
      const combinedDetail =
        infos.length > 1 && allSameLabel
          ? cleanSingleLineSnippet(detailsList.join(', '), 64)
          : lastToolInfo.detail || cleanSingleLineSnippet(detailsList.join(', '), 64);
      const stepProgress =
        pTools.length > 1 && !hasBracketPrefix(combinedDetail)
          ? `${pTools.length}/${pTools.length}`
          : '';
      const startMs = getRawStepFinishMs(lastStep) || getRawStepEndMs(lastStep) || 0;
      return {
        phase: 'thinking',
        label: lastToolInfo.label,
        detail: combinedDetail,
        stepProgress,
        startedAtMs: startMs,
        signature: `post-tool-think:${lastStepId}:${lastToolInfo.label}:${combinedDetail}`,
      };
    }

 // B2.5 Connect RPC plannerResponse.toolCalls / 
    if (lastIdx > lastPlannerIdx) {
      const stepTypeUpper = String(lastStep?.type || '').toUpperCase();
      if (!stepTypeUpper.includes('USER_INPUT') && !stepTypeUpper.includes('GENERIC')) {
        const lastInfo = summarizeToolCall(null, lastStep);
        if (lastInfo.toolName !== 'tool' || lastInfo.detail) {
          const startMs = getRawStepFinishMs(lastStep) || getRawStepEndMs(lastStep) || 0;
          return {
            phase: 'thinking',
            label: lastInfo.label,
            detail: lastInfo.detail,
            stepProgress: '',
            startedAtMs: startMs,
            signature: `post-step-tool:${lastStepId}:${lastInfo.label}:${lastInfo.detail}`,
          };
        }
      }
    }

 // B3 PLANNER_RESPONSE RUNNING 
    if (lastPlannerIdx === lastIdx) {
      const respText = getStepResponseText(plannerStep);
      const thinkText = getStepThinkingText(plannerStep);
      const startMs = getRawStepFinishMs(plannerStep) || getRawStepStartMs(plannerStep) || 0;
      if (respText.length > 0) {
        const snippet = cleanSingleLineSnippet(respText, 52, true);
        if (snippet) {
          return {
            phase: 'responding',
            label: 'Responding',
            detail: snippet,
            stepProgress: '',
            startedAtMs: startMs,
            signature: `responding-done:${lastStepId}:${snippet}`,
          };
        }
      }
      if (thinkText.length > 0) {
        const snippet = cleanSingleLineSnippet(thinkText, 52, true);
        if (snippet) {
          return {
            phase: 'thinking',
            label: 'Thinking',
            detail: snippet,
            stepProgress: '',
            startedAtMs: startMs,
            signature: `thinking-done:${lastStepId}:${snippet}`,
          };
        }
      }
    }
  }

  // Last step is USER_INPUT or finished normal step
  const startMs = getRawStepFinishMs(lastStep) || getRawStepStartMs(lastStep) || 0;
  return {
    phase: 'thinking',
    label: 'Thinking',
    detail: '',
    stepProgress: '',
    startedAtMs: startMs,
    signature: `post-step-think:${lastStepId}`,
  };
}

