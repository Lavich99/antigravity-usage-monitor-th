/**
 * @fileoverview Antigravity Usage Monitor Sidecar HTTP 
 *
 * 
 * - `/` `/app.js` `/styles.css` 
 * - Loopback JSON API 
 * - `node:worker_threads` `./backend/sidecar-worker.mjs` 
 * `SidecarApp` 
 * V8 Isolate Worker 
 */

import { Worker } from 'node:worker_threads';
import { Response, SidecarApp } from 'sidecar_sdk';
import {
  bootWindowBridgeRuntime,
  dispatchBridgeApiRequest,
  isLocalHostRequest,
  readLocalAsync,
} from './backend/api-actions.mjs';

const app = new SidecarApp();

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

const isTestHarnessEnv =
  String(process?.env?.ANTIGRAVITY_LS_ADDRESS || '').trim() === 'test.invalid' ||
  typeof Worker !== 'function';

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

let activeWorker = null;
let workerSwapPromise = null;
let rpcSeq = 0;
const pendingWorkerRpcs = new Map();

function createBackendWorkerInstance() {
  const workerUrl = new URL('./backend/sidecar-worker.mjs', import.meta.url);
  const worker = new Worker(workerUrl);

  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'reload_request') {
      if (worker === activeWorker) {
        void reloadBackendWorker();
      }
      return;
    }
    if (msg.type === 'api_result' || msg.type === 'shutdown_ack') {
      const pending = pendingWorkerRpcs.get(msg.id);
      if (!pending) return;
      pendingWorkerRpcs.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.type === 'shutdown_ack' || msg.ok) {
        pending.resolve(msg.response ?? true);
      } else {
        pending.reject(new Error(msg.error || 'Backend worker error'));
      }
    }
  });

  worker.on('exit', () => {
    for (const [id, entry] of pendingWorkerRpcs.entries()) {
      if (entry.worker === worker) {
        pendingWorkerRpcs.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error('Backend worker exited during request'));
      }
    }
    if (activeWorker === worker) {
      activeWorker = null;
      if (!workerSwapPromise) {
        setTimeout(() => {
          if (!activeWorker && !workerSwapPromise) {
            activeWorker = createBackendWorkerInstance();
          }
        }, 120).unref?.();
      }
    }
  });

  worker.on('error', () => {
    // exit
  });

  return worker;
}

function sendWorkerMessage(worker, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      pendingWorkerRpcs.delete(id);
      reject(new Error('Backend worker request timeout'));
    }, timeoutMs);
    timer.unref?.();
    pendingWorkerRpcs.set(id, { worker, timer, resolve, reject });
    try {
      worker.postMessage({ ...payload, id });
    } catch (err) {
      pendingWorkerRpcs.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function stopWorkerGracefully(worker) {
  if (!worker) return;
  try {
    await sendWorkerMessage(worker, { type: 'shutdown' }, 1200);
  } catch {
    // Isolate
  }
  try {
    await worker.terminate();
  } catch {
    
  }
}

function reloadBackendWorker() {
  if (workerSwapPromise) return workerSwapPromise;
  workerSwapPromise = (async () => {
    const prev = activeWorker;
    activeWorker = null;
    await stopWorkerGracefully(prev);
    activeWorker = createBackendWorkerInstance();
    return activeWorker;
  })().finally(() => {
    workerSwapPromise = null;
  });
  return workerSwapPromise;
}

async function ensureActiveWorker() {
  if (workerSwapPromise) {
    return workerSwapPromise;
  }
  if (!activeWorker) {
    activeWorker = createBackendWorkerInstance();
  }
  return activeWorker;
}

async function forwardApiCall(pathname, method, data) {
  if (isTestHarnessEnv) {
    return dispatchBridgeApiRequest(pathname, method, data);
  }
  const upperMethod = String(method || 'GET').toUpperCase();
  try {
    const worker = await ensureActiveWorker();
    return await sendWorkerMessage(worker, { type: 'api', pathname, method: upperMethod, data });
  } catch (err) {
    if (upperMethod === 'GET') {
      const retryWorker = await ensureActiveWorker();
      return sendWorkerMessage(retryWorker, { type: 'api', pathname, method: upperMethod, data });
    }
    throw err;
  }
}

async function handleProtectedApi(pathname, method, data, req) {
  if (!isLocalHostRequest(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden host or origin' }), {
      status: 403,
      contentType: 'application/json',
    });
  }
  const out = await forwardApiCall(pathname, method, data);
  return new Response(out.body, {
    status: out.status,
    contentType: out.contentType,
    headers: out.headers,
  });
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

app.page(
  '/',
  async () =>
    new Response(await readLocalAsync('index.html'), {
      contentType: 'text/html; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

app.page(
  '/app.js',
  async () =>
    new Response(await readLocalAsync('app.js'), {
      contentType: 'application/javascript; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

app.page(
  '/styles.css',
  async () =>
    new Response(await readLocalAsync('styles.css'), {
      contentType: 'text/css; charset=utf-8',
      headers: NO_STORE_HEADERS,
    })
);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.api('/api/telemetry', (data, req) => handleProtectedApi('/api/telemetry', 'GET', data, req), 'GET');
app.api('/api/settings', (data, req) => handleProtectedApi('/api/settings', 'POST', data, req));
app.api('/api/context-window', (data, req) => handleProtectedApi('/api/context-window', 'POST', data, req));
app.api('/api/settings/reset', (_data, req) => handleProtectedApi('/api/settings/reset', 'POST', undefined, req));
app.api('/api/cache/rebuild', (_data, req) => handleProtectedApi('/api/cache/rebuild', 'POST', undefined, req));
app.api('/api/cloud-sync', (_data, req) => handleProtectedApi('/api/cloud-sync', 'POST', undefined, req));
app.api('/api/plugin-update', (_data, req) => handleProtectedApi('/api/plugin-update', 'POST', undefined, req));

app.run();
if (isTestHarnessEnv) {
  bootWindowBridgeRuntime({ allowDynamicLs: false });
} else {
  void ensureActiveWorker();
}
