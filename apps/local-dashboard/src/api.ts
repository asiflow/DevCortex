// ============================================================================
// Typed client for the DevCortex daemon HTTP API.
//
// IMPORTANT: response *shapes* are imported TYPE-ONLY from @devcortex/core. No
// runtime code from @devcortex/core is ever pulled into the browser bundle —
// `import type` is erased at build time (verbatimModuleSyntax enforces this).
//
// The bespoke endpoint envelopes (health, ready-score, ship-report, markdown)
// are not part of the core domain contract, so they are declared here and kept
// in lockstep with the daemon by hand.
// ============================================================================

import type {
  ProjectGraph,
  FeatureRecord,
  DecisionRecord,
  MemoryItem,
  RunRecord,
} from '@devcortex/core';

// --- bespoke endpoint envelopes --------------------------------------------

export interface HealthResponse {
  ok: boolean;
  root: string;
  mode: string;
  version: string;
}

export interface MarkdownResponse {
  markdown: string;
}

/** Summary emitted by GET /api/ready-score. */
export interface ReadyScore {
  score: number;
  status: string;
  passed: number;
  blocked: number;
  warnings: number;
  /** ISO timestamp of the reflected ship report, or null when none exists. */
  generatedAt: string | null;
  /** Filename of the reflected report, or null. */
  reportName: string | null;
  /** True when a tracked file changed after the report — the verdict may be stale. */
  stale: boolean;
}

/** One recent ship report from GET /api/ship-reports. */
export interface ShipReportEntry {
  name: string;
  markdown: string;
}

// re-export the core shapes the UI binds to, so panels import from one module.
export type {
  ProjectGraph,
  FeatureRecord,
  DecisionRecord,
  MemoryItem,
  RunRecord,
};

// --- error model ------------------------------------------------------------

/** Every failure the client can surface, so the UI can render one shape. */
export class ApiError extends Error {
  /** HTTP status when the request completed, or null for transport failures. */
  readonly status: number | null;
  readonly endpoint: string;

  constructor(message: string, endpoint: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.endpoint = endpoint;
    this.status = status;
  }
}

// --- base URL resolution ----------------------------------------------------

const API_BASE = (import.meta.env.VITE_DEVCORTEX_API ?? '').replace(/\/+$/, '');

function endpointUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// --- core fetch -------------------------------------------------------------

interface FetchOptions {
  signal?: AbortSignal;
}

async function getJson<T>(path: string, options: FetchOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpointUrl(path), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options.signal,
    });
  } catch (cause) {
    // Aborts must propagate unchanged so callers can ignore them.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw cause;
    }
    throw new ApiError(
      'Cannot reach the DevCortex daemon. Is it running?',
      path,
      null,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      `Daemon responded with ${response.status} ${response.statusText}`.trim(),
      path,
      response.status,
    );
  }

  try {
    // response.json() is typed `any` by the DOM lib; assigning to T needs no
    // cast. The daemon is a trusted local process emitting these exact shapes,
    // and re-validating here would require importing core's zod schemas into
    // the browser bundle — which is explicitly forbidden.
    const data: T = await response.json();
    return data;
  } catch {
    throw new ApiError('Daemon returned a malformed JSON response.', path, response.status);
  }
}

// --- endpoint methods -------------------------------------------------------

export const api = {
  health: (o?: FetchOptions): Promise<HealthResponse> => getJson('/api/health', o),
  brief: (o?: FetchOptions): Promise<MarkdownResponse> => getJson('/api/brief', o),
  architecture: (o?: FetchOptions): Promise<MarkdownResponse> => getJson('/api/architecture', o),
  graph: (o?: FetchOptions): Promise<ProjectGraph> => getJson('/api/graph', o),
  features: (o?: FetchOptions): Promise<FeatureRecord[]> => getJson('/api/features', o),
  decisions: (o?: FetchOptions): Promise<DecisionRecord[]> => getJson('/api/decisions', o),
  memory: (o?: FetchOptions): Promise<MemoryItem[]> => getJson('/api/memory', o),
  runs: (o?: FetchOptions): Promise<RunRecord[]> => getJson('/api/runs', o),
  shipReports: (o?: FetchOptions): Promise<ShipReportEntry[]> => getJson('/api/ship-reports', o),
  readyScore: (o?: FetchOptions): Promise<ReadyScore> => getJson('/api/ready-score', o),
} as const;

export type DashboardApi = typeof api;
