/**
 * @fileoverview Antigravity IDE / 2.0 / CLI (`bridge-daemon.mjs`) 
 *
 * `mcp-entry.mjs` `--standalone` 
 * 1. `agy` (`daemon/hub_*.json` / `--hub` / `remote-control`) `language_server` 
 * 2. / IDE CDP 
 * 3. `USAGE_MONITOR_STANDALONE_PORT` `settings.json` `standalonePort` `1024..65535` 
 * Web 
 * 4. `SHUTDOWN_DISPOSE` 
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bootBundleVersion,
  bootWindowBridgeRuntime,
  setStandalonePortListener,
} from './backend/api-actions.mjs';
import {
  computeRuntimeCodeVersion,
  loadSettings,
  normalizeStandalonePort,
} from './backend/config.mjs';
import {
  createStandaloneWebServer,
  parseStandaloneCliArgs,
} from './backend/standalone-server.mjs';
import { runStandaloneCli } from './standalone.mjs';

export function startBridgeDaemon() {
  let shuttingDown = false;
  let sawShutdownDispose = false;
  let stdinBuf = '';
  let standaloneController = null;
  let activeStandalonePort = 0;
  let reconcileChain = Promise.resolve();

  const envArgs = parseStandaloneCliArgs([], process.env, { defaultPort: 0 });
  const envPinnedPort = envArgs.portExplicit ? normalizeStandalonePort(envArgs.port) : null;

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
      // stat
    }
  }, 3000);
  driftWatchTimer.unref?.();

  function resolveDesiredStandalonePort(settingsOverride = null) {
    if (envPinnedPort !== null) {
      return envPinnedPort;
    }
    const settings = settingsOverride || loadSettings();
    return normalizeStandalonePort(settings?.standalonePort);
  }

  function scheduleStandaloneReconcile(targetPort) {
    reconcileChain = reconcileChain
      .then(async () => {
        if (shuttingDown) return;
        const nextPort = normalizeStandalonePort(targetPort);
        if (nextPort === activeStandalonePort && standaloneController) {
          return;
        }
        if (standaloneController) {
          const prev = standaloneController;
          standaloneController = null;
          activeStandalonePort = 0;
          await prev.stop().catch(() => {});
        }
        if (nextPort <= 0 || shuttingDown) {
          return;
        }
        try {
          const srv = createStandaloneWebServer({
            host: envArgs.host,
            port: nextPort,
            token: envArgs.token,
            onRestart: triggerRestart,
            skipStartupDiscovery: true,
          });
          const status = await srv.start();
          standaloneController = srv;
          activeStandalonePort = nextPort;
          console.error(`[usage-monitor] Auto-hosted standalone Web UI at ${status.url}`);
        } catch (err) {
          if (err?.code === 'EADDRINUSE') {
            console.error(
              `[usage-monitor] Standalone port ${nextPort} already in use; keeping existing listener.`
            );
          } else {
            console.error(`[usage-monitor] Auto-hosted standalone server skipped: ${err.message}`);
          }
        }
      })
      .catch(() => {});
  }

  setStandalonePortListener((updatedPort) => {
    if (envPinnedPort === null) {
      scheduleStandaloneReconcile(updatedPort);
    }
  });
  scheduleStandaloneReconcile(resolveDesiredStandalonePort());

  async function shutdown({ disposeWindows = false, exitCode = 0 } = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(driftWatchTimer);
    setStandalonePortListener(null);
    const forceTimer = setTimeout(() => {
      process.exit(exitCode);
    }, 1500);
    forceTimer.unref?.();
    try {
      await Promise.allSettled([
        controller?.stop?.({ disposeWindows }),
        standaloneController?.stop?.(),
      ]);
    } catch {
      
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
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes('--standalone') || cliArgs.includes('--help') || cliArgs.includes('-h')) {
    void runStandaloneCli(cliArgs);
  } else {
    startBridgeDaemon();
  }
}
