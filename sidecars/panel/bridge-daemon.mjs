/**
 * @fileoverview Antigravity App Background CDP Bridge Daemon (`bridge-daemon.mjs`).
 * Spawned silently via `mcp-entry.mjs` to keep the Antigravity Desktop App CDP bridge alive.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootBundleVersion, bootWindowBridgeRuntime } from './backend/api-actions.mjs';
import { computeRuntimeCodeVersion } from './backend/config.mjs';

export function startBridgeDaemon() {
  let shuttingDown = false;
  let sawShutdownDispose = false;
  let stdinBuf = '';

  const triggerRestart = () => {
    void shutdown({ disposeWindows: false, exitCode: 0 });
  };

  const controller = bootWindowBridgeRuntime({
    allowDynamicLs: true,
    onRestart: triggerRestart,
  });

  const driftWatchTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      const diskVersion = String(computeRuntimeCodeVersion() || '');
      if (bootBundleVersion && diskVersion && diskVersion !== String(bootBundleVersion)) {
        triggerRestart();
      }
    } catch {
      // Ignore stat errors during updates
    }
  }, 3000);
  driftWatchTimer.unref?.();

  async function shutdown({ disposeWindows = false, exitCode = 0 } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(driftWatchTimer);
    const forceTimer = setTimeout(() => {
      process.exit(exitCode);
    }, 1500);
    forceTimer.unref?.();
    try {
      await Promise.allSettled([controller?.stop?.({ disposeWindows })]);
    } catch {
      // Ignore shutdown errors
    } finally {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    }
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuf += String(chunk || '');
    if (stdinBuf.includes('SHUTDOWN_DISPOSE')) {
      sawShutdownDispose = true;
      void shutdown({ disposeWindows: true, exitCode: 0 });
    } else if (stdinBuf.length > 4096) {
      stdinBuf = stdinBuf.slice(-1024);
    }
  });

  process.stdin.on('end', () => {
    void shutdown({ disposeWindows: sawShutdownDispose, exitCode: 0 });
  });
  process.stdin.on('close', () => {
    void shutdown({ disposeWindows: sawShutdownDispose, exitCode: 0 });
  });
  process.on('SIGTERM', () => {
    void shutdown({ disposeWindows: true, exitCode: 0 });
  });
  process.on('SIGINT', () => {
    void shutdown({ disposeWindows: true, exitCode: 0 });
  });

  process.stdin.resume();
  return controller;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startBridgeDaemon();
}
