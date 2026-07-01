/**
 * DevCortex local daemon (spec §4.1) — assembles the repo watcher, the JSON API,
 * and static dashboard serving into a single 127.0.0.1 HTTP server.
 *
 * `startDaemon(root)` begins watching the repo (keeping `.cortex/graph.json`
 * fresh) and serves:
 *   - `GET /api/*`  → the read-only cognition API (see ./api)
 *   - everything else → the built local dashboard SPA (see ./static-server),
 *     falling back to a placeholder page when the dashboard is not built.
 *
 * Binds 127.0.0.1 only; CORS is restricted to localhost origins so a dashboard
 * dev server (e.g. :5173) can call the API without exposing it off-host.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { loadConfig } from '@devcortex/core';
import type { OperatingMode } from '@devcortex/core';

import { handleApiRequest, isApiPath } from './api';
import type { DaemonContext } from './api';
import { resolveDashboardDist, serveStatic } from './static-server';
import { daemonVersion } from './version';
import { startWatcher } from './watcher';
import type { RepoWatcher } from './watcher';

/** Default port the daemon binds on 127.0.0.1. */
export const DEFAULT_DAEMON_PORT = 7420;

const HOST = '127.0.0.1';
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface StartDaemonOptions {
  /** TCP port to bind (default {@link DEFAULT_DAEMON_PORT}; 0 = ephemeral). */
  port?: number;
  /** debounce window for the repo watcher, in ms */
  debounceMs?: number;
  /** sink for non-fatal watcher/scan/request errors (default: console.error) */
  onError?: (err: unknown) => void;
}

/** A running daemon handle. */
export interface DaemonHandle {
  /** the bound base URL, e.g. http://127.0.0.1:7420 */
  url: string;
  /** the actually-bound port (resolved even when port 0 was requested) */
  port: number;
  /** stop the watcher and HTTP server; resolves once fully closed */
  close(): Promise<void>;
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && LOCAL_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DaemonContext,
  distDir: string | null,
): Promise<void> {
  applyCors(req, res);

  const method = req.method ?? 'GET';
  const pathname = new URL(req.url ?? '/', `http://${HOST}`).pathname;

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: 'GET, HEAD, OPTIONS',
    });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: `Method not allowed: ${method}` } }));
    return;
  }

  if (isApiPath(pathname)) {
    const { status, body } = await handleApiRequest(pathname, ctx);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
    return;
  }

  const staticRes = await serveStatic(distDir, pathname);
  res.writeHead(staticRes.status, { 'Content-Type': staticRes.contentType });
  res.end(method === 'HEAD' ? undefined : staticRes.body);
}

/**
 * Start the DevCortex daemon against `root`. Resolves once the server is
 * listening; the returned handle exposes the bound URL/port and a `close()`.
 */
export async function startDaemon(
  root: string,
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const resolvedRoot = path.resolve(root);
  const onError = options.onError ?? ((err: unknown) => console.error('[devcortex-daemon]', err));

  // Capture the operating mode up front; /api/health falls back to it if config
  // becomes unreadable mid-session. An uninitialized workspace is fine here — the
  // API surfaces a 400 per-route, and /api/health stays live.
  let startupMode: OperatingMode = 'passive';
  try {
    startupMode = (await loadConfig(resolvedRoot)).mode;
  } catch {
    // keep the passive default
  }

  const ctx: DaemonContext = { root: resolvedRoot, startupMode, version: daemonVersion() };
  const distDir = resolveDashboardDist();
  const watcher: RepoWatcher = startWatcher(resolvedRoot, {
    debounceMs: options.debounceMs,
    onError,
  });

  const server: Server = createServer((req, res) => {
    void handle(req, res, ctx, distDir).catch((err) => {
      onError(err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'daemon request failed' } }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (err: unknown): void => reject(err);
    server.once('error', onListenError);
    server.listen(options.port ?? DEFAULT_DAEMON_PORT, HOST, () => {
      server.off('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await watcher.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('daemon failed to bind a TCP port');
  }
  const port = (address as AddressInfo).port;
  const url = `http://${HOST}:${port}`;

  return {
    url,
    port,
    async close(): Promise<void> {
      await watcher.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
