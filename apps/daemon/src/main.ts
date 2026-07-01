#!/usr/bin/env node
/**
 * `devcortex-daemon` executable — parses args, starts the daemon, writes a
 * best-effort pidfile under `.cortex/cache/`, and shuts down cleanly on
 * SIGINT/SIGTERM.
 *
 * Usage: devcortex-daemon [--root <dir>] [--port <n>]
 *   --root  repo to watch/serve (default: cwd)
 *   --port  TCP port on 127.0.0.1 (default: $DEVCORTEX_DAEMON_PORT or 7420)
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { workspacePaths } from '@devcortex/core';

import { DEFAULT_DAEMON_PORT, startDaemon } from './index';

interface Args {
  root: string;
  port: number;
}

function parseArgs(argv: string[]): Args {
  let root = process.cwd();
  const envPort = process.env.DEVCORTEX_DAEMON_PORT;
  let port = envPort !== undefined ? Number(envPort) : DEFAULT_DAEMON_PORT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--root') {
      const value = argv[i + 1];
      if (value !== undefined) {
        root = value;
        i += 1;
      }
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else if (arg === '--port') {
      const value = argv[i + 1];
      if (value !== undefined) {
        port = Number(value);
        i += 1;
      }
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) port = DEFAULT_DAEMON_PORT;
  return { root: path.resolve(root), port };
}

async function main(): Promise<void> {
  const { root, port } = parseArgs(process.argv.slice(2));
  const handle = await startDaemon(root, { port });

  const pidfile = path.join(workspacePaths(root).cacheDir, 'daemon.pid');
  try {
    await mkdir(path.dirname(pidfile), { recursive: true });
    await writeFile(
      pidfile,
      JSON.stringify({ pid: process.pid, port: handle.port, url: handle.url, root }, null, 2),
      'utf8',
    );
  } catch {
    // pidfile is best-effort; the daemon runs regardless.
  }

  process.stdout.write(
    `DevCortex daemon listening at ${handle.url}\n` +
      `  root:      ${root}\n` +
      `  dashboard: ${handle.url}/\n` +
      `  API:       ${handle.url}/api/health\n`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\nDevCortex daemon shutting down (${signal})...\n`);
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => {
        void rm(pidfile, { force: true })
          .catch(() => undefined)
          .finally(() => process.exit(0));
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `devcortex-daemon failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
