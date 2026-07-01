// ============================================================================
// Daemon lifecycle commands: `daemon start` (detached background), `daemon stop`,
// `daemon status`, and `dashboard` (start-if-needed + print the URL).
//
// The daemon (@devcortex/daemon) watches the repo and serves the JSON API + the
// local dashboard on 127.0.0.1, writing a pidfile under `.cortex/cache/` that
// these commands read to manage its process. It depends on the dashboard package
// and resolves its built `dist/` automatically, so no dashboard path is needed.
// ============================================================================

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { DevCortexError, workspacePaths } from '@devcortex/core';

import type { CommandResult, GlobalOptions } from './runtime';

const nodeRequire = createRequire(import.meta.url);

/** Default port the daemon binds on 127.0.0.1 (mirrors @devcortex/daemon). */
const DEFAULT_DAEMON_PORT = 7420;

interface PidInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
}

function pidfilePath(root: string): string {
  return path.join(workspacePaths(root).cacheDir, 'daemon.pid');
}

async function readPidInfo(root: string): Promise<PidInfo | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pidfilePath(root), 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as PidInfo).pid === 'number' &&
      typeof (parsed as PidInfo).port === 'number' &&
      typeof (parsed as PidInfo).url === 'string'
    ) {
      const info = parsed as PidInfo;
      return {
        pid: info.pid,
        port: info.port,
        url: info.url,
        root: typeof info.root === 'string' ? info.root : root,
      };
    }
  } catch {
    // absent or corrupt pidfile → treat as not running
  }
  return null;
}

/** True when a process with `pid` is alive (signal 0 probes without killing). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the built daemon executable (`@devcortex/daemon` bin → dist/main.js). */
function resolveDaemonBin(): string {
  const pkgJson = nodeRequire.resolve('@devcortex/daemon/package.json');
  return path.join(path.dirname(pkgJson), 'dist', 'main.js');
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Poll the pidfile until the spawned daemon reports itself alive (~5s max). */
async function waitForRunning(root: string, attempts = 50): Promise<PidInfo | null> {
  for (let i = 0; i < attempts; i += 1) {
    const info = await readPidInfo(root);
    if (info !== null && isAlive(info.pid)) return info;
    await delay(100);
  }
  return null;
}

function renderDaemon(state: string, info: PidInfo): string {
  return [
    'CORTEX DAEMON',
    '─'.repeat(56),
    `Status     ${state}`,
    `URL        ${info.url}`,
    `Dashboard  ${info.url}/`,
    `API        ${info.url}/api/health`,
    `PID        ${info.pid}`,
    '',
    'Stop with: devcortex daemon stop',
  ].join('\n');
}

export async function cmdDaemonStart(
  g: GlobalOptions,
  opts: { port?: number },
): Promise<CommandResult> {
  const existing = await readPidInfo(g.root);
  if (existing !== null && isAlive(existing.pid)) {
    return {
      data: { status: 'already-running', ...existing },
      human: renderDaemon('already running', existing),
    };
  }

  const port = opts.port ?? DEFAULT_DAEMON_PORT;
  const child = spawn(process.execPath, [resolveDaemonBin(), '--root', g.root, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const info = await waitForRunning(g.root);
  if (info === null) {
    throw new DevCortexError(
      'INTERNAL',
      `The daemon did not come up on port ${port}. Is the port already in use? ` +
        `Try 'devcortex daemon start --port <n>'.`,
    );
  }
  return { data: { status: 'started', ...info }, human: renderDaemon('started', info) };
}

export async function cmdDaemonStop(g: GlobalOptions): Promise<CommandResult> {
  const info = await readPidInfo(g.root);
  if (info === null || !isAlive(info.pid)) {
    return { data: { status: 'not-running' }, human: 'DevCortex daemon is not running.' };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    // process exited between the liveness check and the signal
  }
  return {
    data: { status: 'stopped', pid: info.pid },
    human: `DevCortex daemon stopped (pid ${info.pid}).`,
  };
}

export async function cmdDaemonStatus(g: GlobalOptions): Promise<CommandResult> {
  const info = await readPidInfo(g.root);
  if (info === null || !isAlive(info.pid)) {
    return {
      data: { running: false },
      human: 'DevCortex daemon: not running. Start it with `devcortex daemon start`.',
    };
  }
  return { data: { running: true, ...info }, human: renderDaemon('running', info) };
}

export async function cmdDashboard(
  g: GlobalOptions,
  opts: { port?: number },
): Promise<CommandResult> {
  const started = await cmdDaemonStart(g, opts);
  const data = started.data as { url?: string };
  const url = typeof data.url === 'string' ? data.url : `http://127.0.0.1:${opts.port ?? DEFAULT_DAEMON_PORT}`;
  return {
    data: started.data,
    human: [
      'CORTEX DASHBOARD',
      '─'.repeat(56),
      `Open  ${url}/`,
      '',
      'The daemon is serving the dashboard + API on 127.0.0.1.',
      'Stop with: devcortex daemon stop',
    ].join('\n'),
  };
}
