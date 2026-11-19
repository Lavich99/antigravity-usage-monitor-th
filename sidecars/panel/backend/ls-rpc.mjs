/**
 * @fileoverview Antigravity Language Server Connect RPC 
 *
 * 
 * 1. Language Server CSRF Connect RPC (`callLsRpc`) 
 * 2. `RetrieveUserQuotaSummary` 10 
 * `language_server.exe` 3 
 */

import { lsRuntimeEndpoint, quotaSummaryCache } from './config.mjs';
import { ensureLsEndpointDiscovered } from './ls-discovery.mjs';

const QUOTA_CACHE_TTL_MS = 10_000;
const QUOTA_RETRY_COOLDOWN_MS = 5_000;
const QUOTA_COLD_RETRY_COOLDOWN_MS = 1_500;
let contextModelCatalog = null;

export function getContextModelCatalog() {
  const { baseUrl, csrfToken } = lsRuntimeEndpoint;
  if (!contextModelCatalog || contextModelCatalog.baseUrl !== baseUrl || contextModelCatalog.csrfToken !== csrfToken ||
      Date.now() >= contextModelCatalog.expiresAt) {
    contextModelCatalog = {
      baseUrl,
      csrfToken,
      expiresAt: Date.now() + 30000,
      promise: callLsRpc('GetAvailableModels', {}, 1500).then((data) => data?.response?.models).catch(() => null),
    };
  }
  return contextModelCatalog.promise;
}

async function postLsRpcOnce(baseUrl, csrfToken, method, body, timeoutMs) {
  return fetch(`${baseUrl}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-codeium-csrf-token': csrfToken || '',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * `LanguageServerService` RPC 
 *
 * @param {string} method RPC `'GetUserStatus'` `'GetCascadeTrajectory'` 
 * @param {object} [body={}] JSON 
 * @param {number} [timeoutMs=5000] 
 * @returns {Promise<object>}
 */
export async function callLsRpc(method, body = {}, timeoutMs = 5000) {
  if (!lsRuntimeEndpoint.baseUrl && lsRuntimeEndpoint.addr !== 'test.invalid') {
    await ensureLsEndpointDiscovered({ force: false });
  }
  if (!lsRuntimeEndpoint.baseUrl) {
    throw new Error('Language Server address (ANTIGRAVITY_LS_ADDRESS) is not configured');
  }

  const prevAddr = lsRuntimeEndpoint.addr;
  const prevToken = lsRuntimeEndpoint.csrfToken;
  let res;
  try {
    res = await postLsRpcOnce(
      lsRuntimeEndpoint.baseUrl,
      lsRuntimeEndpoint.csrfToken,
      method,
      body,
      timeoutMs
    );
  } catch (netErr) {
    if (lsRuntimeEndpoint.addr !== 'test.invalid') {
      const refreshed = await ensureLsEndpointDiscovered({ force: true });
      if (
        refreshed &&
        (lsRuntimeEndpoint.addr !== prevAddr || lsRuntimeEndpoint.csrfToken !== prevToken)
      ) {
        res = await postLsRpcOnce(
          lsRuntimeEndpoint.baseUrl,
          lsRuntimeEndpoint.csrfToken,
          method,
          body,
          timeoutMs
        );
      } else {
        throw netErr;
      }
    } else {
      throw netErr;
    }
  }

  if (!res.ok && (res.status === 401 || res.status === 403) && lsRuntimeEndpoint.addr !== 'test.invalid') {
    const refreshed = await ensureLsEndpointDiscovered({ force: true });
    if (
      refreshed &&
      (lsRuntimeEndpoint.addr !== prevAddr || lsRuntimeEndpoint.csrfToken !== prevToken)
    ) {
      res = await postLsRpcOnce(
        lsRuntimeEndpoint.baseUrl,
        lsRuntimeEndpoint.csrfToken,
        method,
        body,
        timeoutMs
      );
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`RPC ${method} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * `RetrieveUserQuotaSummary` 
 *
 * 
 * - 10 
 * - 5 2 
 * - TTL `forceRefresh = true` 
 * LS `{ forceRefresh: true }` `language_server.exe` 3 
 *
 * @param {boolean} [forceRefresh=false] 
 * @param {string} [accountName=''] 
 * @returns {Promise<{data: object|null, fetchedAtMs: number, isStale: boolean, refreshFailed: boolean, error: string|null, fromCache: boolean}>}
 */
export async function getOfficialQuotaSummary(forceRefresh = false, accountName = '') {
  if (quotaSummaryCache.accountName !== accountName) {
    Object.assign(quotaSummaryCache, {
      accountName,
      accountGeneration: quotaSummaryCache.accountGeneration + 1,
      ts: 0,
      lastAttemptTs: 0,
      data: null,
      error: null,
    });
  }
  const generation = quotaSummaryCache.accountGeneration;
  const now = Date.now();
  if (!forceRefresh && quotaSummaryCache.data && now - quotaSummaryCache.ts < QUOTA_CACHE_TTL_MS) {
    return {
      data: quotaSummaryCache.data,
      fetchedAtMs: quotaSummaryCache.ts,
      isStale: false,
      refreshFailed: false,
      error: null,
      fromCache: true,
    };
  }
  const activeCooldownMs = quotaSummaryCache.data ? QUOTA_RETRY_COOLDOWN_MS : QUOTA_COLD_RETRY_COOLDOWN_MS;
  if (
    !forceRefresh &&
    quotaSummaryCache.lastAttemptTs > 0 &&
    now - quotaSummaryCache.lastAttemptTs < activeCooldownMs &&
    quotaSummaryCache.error
  ) {
    return {
      data: quotaSummaryCache.data,
      fetchedAtMs: quotaSummaryCache.ts || 0,
      isStale: Boolean(quotaSummaryCache.data),
      refreshFailed: true,
      error: quotaSummaryCache.error,
      fromCache: true,
    };
  }

  quotaSummaryCache.lastAttemptTs = now;
  const extractQuotaPayload = (rpcRes) => (rpcRes?.response !== undefined ? rpcRes.response : rpcRes);
  const hasQuotaGroupsOrBuckets = (p) =>
    Boolean(p && typeof p === 'object' && !Array.isArray(p) && ((Array.isArray(p.groups) && p.groups.length > 0) || (Array.isArray(p.buckets) && p.buckets.length > 0)));

  try {
    let res = null;
    if (!forceRefresh && !quotaSummaryCache.data) {
      res = await callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: false }, 3000).catch(() => null);
      if (!hasQuotaGroupsOrBuckets(extractQuotaPayload(res))) {
        res = null;
      }
    }
    if (!res) {
      try {
        res = await callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: true }, 6000);
      } catch (forceErr) {
        if (!quotaSummaryCache.data) {
          const fallbackRes = await callLsRpc('RetrieveUserQuotaSummary', { forceRefresh: false }, 2000).catch(() => null);
          if (hasQuotaGroupsOrBuckets(extractQuotaPayload(fallbackRes))) {
            res = fallbackRes;
          } else {
            throw forceErr;
          }
        } else {
          throw forceErr;
        }
      }
    }
    const { userStatus } = await callLsRpc('GetUserStatus', {}, 2000);
    if ((userStatus?.email || userStatus?.name || '') !== accountName) return {};
    if (generation !== quotaSummaryCache.accountGeneration) return {};
    const payload = extractQuotaPayload(res);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const normalized =
        Array.isArray(payload.groups) || Array.isArray(payload.buckets)
          ? payload
          : { ...payload, groups: [] };
      quotaSummaryCache.ts = now;
      quotaSummaryCache.data = normalized;
      quotaSummaryCache.error = null;
      return {
        data: normalized,
        fetchedAtMs: now,
        isStale: false,
        refreshFailed: false,
        error: null,
        fromCache: false,
      };
    }
    quotaSummaryCache.error = 'Quota summary empty';
  } catch (err) {
    if (generation !== quotaSummaryCache.accountGeneration) return {};
    console.error(`RetrieveUserQuotaSummary failed: ${err.message}`);
    quotaSummaryCache.error = err.message;
  }
  return {
    data: quotaSummaryCache.data,
    fetchedAtMs: quotaSummaryCache.ts || 0,
    isStale: Boolean(quotaSummaryCache.data),
    refreshFailed: true,
    error: quotaSummaryCache.error || 'Quota RPC unavailable',
    fromCache: false,
  };
}
