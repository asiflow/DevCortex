/**
 * The daemon JSON API — the exact contract both the daemon and any client
 * (local dashboard, editor extension) implement. Every route is a read over the
 * `.cortex/` workspace via `@devcortex/core`; nothing here mutates project state.
 *
 * Routes (all under `http://127.0.0.1:<port>`, all `application/json`):
 *   GET /api/health        -> { ok, root, mode, version }
 *   GET /api/brief         -> { markdown }
 *   GET /api/architecture  -> { markdown }
 *   GET /api/graph         -> ProjectGraph
 *   GET /api/features      -> FeatureRecord[]
 *   GET /api/decisions     -> DecisionRecord[]
 *   GET /api/memory        -> MemoryItem[]
 *   GET /api/runs          -> RunRecord[]
 *   GET /api/ship-reports  -> { name, markdown }[]
 *   GET /api/ready-score   -> { score, status, passed, blocked, warnings }
 */
import {
  DecisionLedger,
  FeatureLedger,
  MemoryLedger,
  isDevCortexError,
  listRuns,
  loadConfig,
  loadGraph,
  saveGraph,
  scanProject,
  workspacePaths,
} from '@devcortex/core';
import type { OperatingMode, ProjectGraph } from '@devcortex/core';

import { readTextOrEmpty } from './fs-utils';
import { DEFAULT_SHIP_REPORT_LIMIT, listShipReports, readyScore } from './ship-reports';

/** Immutable per-server context threaded into every request handler. */
export interface DaemonContext {
  /** absolute, resolved repo root the daemon operates on */
  root: string;
  /** operating mode captured at startup, used as a fallback if config re-read fails */
  startupMode: OperatingMode;
  /** this daemon package's version, surfaced by `/api/health` */
  version: string;
}

/** A resolved JSON response: HTTP status + a JSON-serializable body. */
export interface JsonResponse {
  status: number;
  body: unknown;
}

/** Return the cached graph, scanning + caching one on demand if none exists. */
async function ensureGraph(root: string): Promise<ProjectGraph> {
  const cached = await loadGraph(root);
  if (cached !== null) return cached;
  const fresh = await scanProject(root);
  await saveGraph(root, fresh);
  return fresh;
}

type RouteHandler = (ctx: DaemonContext) => Promise<unknown>;

const ROUTES: Record<string, RouteHandler> = {
  '/api/health': async (ctx) => {
    // Health must stay live even if config becomes unreadable mid-session; fall
    // back to the mode captured at startup.
    let mode = ctx.startupMode;
    try {
      mode = (await loadConfig(ctx.root)).mode;
    } catch {
      // keep startup mode
    }
    return { ok: true, root: ctx.root, mode, version: ctx.version };
  },
  '/api/brief': async (ctx) => ({
    markdown: await readTextOrEmpty(workspacePaths(ctx.root).projectMd),
  }),
  '/api/architecture': async (ctx) => ({
    markdown: await readTextOrEmpty(workspacePaths(ctx.root).architectureMd),
  }),
  '/api/graph': async (ctx) => ensureGraph(ctx.root),
  '/api/features': async (ctx) => new FeatureLedger(ctx.root).all(),
  '/api/decisions': async (ctx) => new DecisionLedger(ctx.root).all(),
  '/api/memory': async (ctx) => new MemoryLedger(ctx.root).all(),
  '/api/runs': async (ctx) => listRuns(ctx.root),
  '/api/ship-reports': async (ctx) => listShipReports(ctx.root, DEFAULT_SHIP_REPORT_LIMIT),
  '/api/ready-score': async (ctx) => readyScore(ctx.root),
};

/** True when a pathname belongs to the JSON API surface. */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Resolve one API request to a {@link JsonResponse}. Unknown `/api/*` paths
 * return a structured 404; engine failures surface their stable `code` in the
 * error body so clients can react programmatically.
 */
export async function handleApiRequest(pathname: string, ctx: DaemonContext): Promise<JsonResponse> {
  const handler = ROUTES[pathname];
  if (handler === undefined) {
    return {
      status: 404,
      body: { error: { code: 'INTERNAL', message: `Unknown API route: ${pathname}` } },
    };
  }

  try {
    const body = await handler(ctx);
    return { status: 200, body };
  } catch (err) {
    const code = isDevCortexError(err) ? err.code : 'INTERNAL';
    const message = err instanceof Error ? err.message : String(err);
    // A missing/uninitialized workspace is a client-actionable 400; everything
    // else is a genuine server-side failure (500).
    const status = code === 'WORKSPACE_NOT_INITIALIZED' || code === 'CONFIG_NOT_FOUND' ? 400 : 500;
    return { status, body: { error: { code, message } } };
  }
}
