/**
 * @fileoverview Async HTTP client with AbortController cancellation for stale
 * polling requests, concurrent GET deduplication, and dual-mode transport
 * (Sidecar Webview `window.sidecar.fetch` + Main Window Loopback Bridge).
 */

const inFlightGets = new Map();
const activeControllers = new Map();

/**
 * `port` `token` `bundleVersion` `stylesCss` 
 *
 * @returns {{ port: number, token: string, bundleVersion?: string, stylesCss?: string } | null}
 */
export function getWindowBridgeConfig() {
  if (typeof window === 'undefined') return null;
  const br = window.__AGUsageMonitorBridge;
  const port = Number(br?.port || 0);
  if (br && Number.isInteger(port) && port > 0 && typeof br.token === 'string' && br.token) {
    return br;
  }
  return null;
}

/**
 * Webview 
 *
 * @returns {boolean}
 */
export function isWindowOverlayMode() {
  if (typeof window === 'undefined') return false;
  if (window.sidecar?.fetch) return false;
  return Boolean(getWindowBridgeConfig());
}

/**
 * Sidecar CDP `Runtime.evaluate` RPC CSP/ HTTP 
 *
 * @param {Array<{ id: string, ok: boolean, status?: number, data?: any, error?: string }>} responses
 * @returns {number}
 */
export function deliverCdpBridgeResponses(responses) {
  const br = getWindowBridgeConfig();
  if (!br || !(br.rpcPending instanceof Map) || !Array.isArray(responses)) return 0;
  let delivered = 0;
  for (const item of responses) {
    const entry = br.rpcPending.get(item?.id);
    if (!entry) continue;
    br.rpcPending.delete(item.id);
    delivered += 1;
    if (item.ok) {
      entry.resolve(item.data);
    } else {
      entry.reject(new Error(item.error || `HTTP ${item.status || 500}`));
    }
  }
  return delivered;
}

function callViaCdpBridge(bridge, path, { method, body, signal, cdpTimeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
      return;
    }
    if (!Array.isArray(bridge.rpcQueue)) bridge.rpcQueue = [];
    if (!(bridge.rpcPending instanceof Map)) bridge.rpcPending = new Map();

    const reqId = `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const cleanupQueueItem = () => {
      if (!Array.isArray(bridge.rpcQueue)) return;
      const idx = bridge.rpcQueue.findIndex((item) => item?.id === reqId);
      if (idx >= 0) bridge.rpcQueue.splice(idx, 1);
    };

    const timeoutId = setTimeout(() => {
      bridge.rpcPending.delete(reqId);
      cleanupQueueItem();
      reject(new Error('CDP bridge timeout'));
    }, cdpTimeoutMs);

    const onAbort = () => {
      clearTimeout(timeoutId);
      bridge.rpcPending.delete(reqId);
      cleanupQueueItem();
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    bridge.rpcPending.set(reqId, {
      resolve: (data) => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    });

    if (bridge.rpcQueue.length >= 16) {
      const dropped = bridge.rpcQueue.shift();
      if (dropped?.id) {
        const stale = bridge.rpcPending.get(dropped.id);
        bridge.rpcPending.delete(dropped.id);
        stale?.reject(new Error('CDP queue superseded'));
      }
    }
    bridge.rpcQueue.push({ id: reqId, path, method, body });
  });
}

export async function callSidecarApi(path, { method = 'GET', body, abortKey = '', cdpTimeoutMs = 3500 } = {}) {
  const upperMethod = method.toUpperCase();
  const dedupKey = upperMethod === 'GET' && !abortKey ? path : '';

  if (dedupKey && inFlightGets.has(dedupKey)) {
    return inFlightGets.get(dedupKey);
  }

  let signal;
  let requestController = null;
  if (abortKey && typeof AbortController !== 'undefined') {
    const prev = activeControllers.get(abortKey);
    if (prev) {
      prev.abort();
    }
    requestController = new AbortController();
    activeControllers.set(abortKey, requestController);
    signal = requestController.signal;
  }

  const execHttpOnce = async (activeBridge) => {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const fetchFn = sidecar?.fetch
      ? sidecar.fetch.bind(sidecar)
      : typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : globalThis.fetch.bind(globalThis);
    const requestUrl = activeBridge ? `http://127.0.0.1:${activeBridge.port}${path}` : path;
    const headers = {};
    if (body !== undefined || !activeBridge) {
      headers['Content-Type'] = 'application/json';
    }
    if (activeBridge) {
      headers['X-Usage-Monitor-Token'] = activeBridge.token;
    }
    const res = await fetchFn(requestUrl, {
      method: upperMethod,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    const data = await res.json().catch(() => ({}));
    if (signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (activeBridge) {
      activeBridge.transportMode = 'http';
    }
    return data;
  };

  const fallbackViaCdpWithRecovery = async (initialBridge) => {
    initialBridge.transportMode = 'cdp';
    try {
      return await callViaCdpBridge(initialBridge, path, {
        method: upperMethod,
        body,
        signal,
        cdpTimeoutMs,
      });
    } catch (cdpErr) {
      if (signal?.aborted || cdpErr?.name === 'AbortError') {
        throw cdpErr;
      }
      // CDP HTTP
      const latestBridge = getWindowBridgeConfig() || initialBridge;
      latestBridge.transportMode = 'http';
      return execHttpOnce(latestBridge);
    }
  };

  const runRequest = async () => {
    const sidecar = typeof window !== 'undefined' ? window.sidecar : null;
    const bridge = !sidecar?.fetch ? getWindowBridgeConfig() : null;
    if (bridge && bridge.transportMode === 'cdp') {
      return fallbackViaCdpWithRecovery(bridge);
    }

    try {
      return await execHttpOnce(bridge);
    } catch (fetchErr) {
      if (signal?.aborted || fetchErr?.name === 'AbortError') {
        throw fetchErr;
      }
      if (!bridge) {
        // Webview Worker 180ms
        if (upperMethod === 'GET') {
          await new Promise((r) => setTimeout(r, 180));
          if (!signal?.aborted) {
            return execHttpOnce(null);
          }
        }
        throw fetchErr;
      }
      // CSP connect-src HTTP CDP
      return fallbackViaCdpWithRecovery(bridge);
    }
  };

  const promise = runRequest().finally(() => {
    if (dedupKey) {
      inFlightGets.delete(dedupKey);
    }
    if (abortKey && requestController && activeControllers.get(abortKey) === requestController) {
      activeControllers.delete(abortKey);
    }
  });

  if (dedupKey) {
    inFlightGets.set(dedupKey, promise);
  }
  return promise;
}
