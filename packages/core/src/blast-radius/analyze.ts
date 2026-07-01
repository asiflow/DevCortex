/**
 * Blast-radius analysis.
 *
 * `analyzeBlastRadius` answers a single question deterministically and
 * tokenlessly: "if these files change, what could break, and what must I prove
 * still works before shipping?"
 *
 * Method:
 *   1. Normalise the changed files to repo-relative POSIX paths.
 *   2. Build the *radius* = every changed file that is a graph node, plus the
 *      transitive `importedBy` closure of each (via `dependentsOf`). Anything in
 *      the radius is a file the change can reach.
 *   3. Project the radius onto product surfaces: routes, components, api,
 *      database (migration/schema) files, auth/billing flags, env vars, tests,
 *      and fragile (risky) areas — all read off the already-built `ProjectGraph`.
 *   4. Derive `requiredChecks` strictly from the surfaces that are actually
 *      affected (auth → auth regression test, billing → webhook signature check,
 *      ...), and a `severity` = the most dangerous affected file kind, escalated
 *      to at least `high` when a changed file matches a protected path.
 *
 * Pure and synchronous over an in-memory graph; the only failure paths are
 * programmer errors (a malformed graph/config or non-string changed files),
 * which throw `DevCortexError('INTERNAL')`, and a malformed protected-path glob,
 * which surfaces as the `ConfigError` thrown by `isProtected`.
 */

import * as path from 'node:path';

import type {
  BlastRadius,
  CortexConfig,
  EnvVar,
  FileNode,
  ProjectGraph,
  RiskLevel,
  RouteNode,
} from '../domain/index';
import { DevCortexError } from '../domain/index';
import { dependentsOf } from '../graph';
import { isProtected } from '../policy';

// --- risk ordering (local; policy/risk-order is intentionally not public) ----

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

/** Risk a single affected file contributes to overall severity, by kind. */
function nodeRisk(node: FileNode): RiskLevel {
  switch (node.kind) {
    case 'migration':
      return 'critical';
    case 'auth':
    case 'billing':
    case 'middleware':
    case 'env':
    case 'schema':
      return 'high';
    case 'config':
    case 'api':
      return 'medium';
    default:
      // Anything else (page, route, component, service, lib, style, test,
      // other) is low unless it carries a security/financial token, in which
      // case the scanner already flagged it risky.
      return node.risky ? 'high' : 'low';
  }
}

// --- helpers ----------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function sortedUnique(items: string[]): string[] {
  return [...new Set(items)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Normalise an input path (absolute or relative, POSIX or Windows) into the
 * repo-relative POSIX form used as graph node keys. Mirrors the normalisation
 * `dependentsOf` performs internally so changed-file lookups line up with it.
 */
function toRepoRel(root: string, file: string): string {
  const f = file.replace(/\\/g, '/');
  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel = f;
  if (f === rootPosix) return '';
  if (f.startsWith(`${rootPosix}/`)) {
    rel = f.slice(rootPosix.length);
  } else if (path.isAbsolute(file)) {
    rel = path.relative(root, file).split(path.sep).join('/');
  }
  return rel.replace(/^\/+/, '').replace(/^\.\//, '');
}

// --- public API -------------------------------------------------------------

/**
 * Compute the blast radius of a set of changed files against the project graph.
 *
 * @throws DevCortexError('INTERNAL') when `graph`, `changedFiles`, or `config`
 *   is structurally invalid (defensive against non-TS callers).
 * @throws ConfigError when a configured protected-path glob is unusable
 *   (propagated from `isProtected`).
 */
export function analyzeBlastRadius(
  graph: ProjectGraph,
  changedFiles: string[],
  config: CortexConfig,
): BlastRadius {
  // 1. Validate inputs (cast through `unknown` so runtime guards survive even
  //    when a JS caller violates the static contract).
  if (!isPlainObject(graph) || !Array.isArray((graph as { files?: unknown }).files)) {
    throw new DevCortexError('INTERNAL', 'analyzeBlastRadius: graph must be a ProjectGraph');
  }
  if (!Array.isArray(changedFiles)) {
    throw new DevCortexError(
      'INTERNAL',
      'analyzeBlastRadius: changedFiles must be an array of strings',
    );
  }
  const risk = isPlainObject(config) ? (config as { risk?: unknown }).risk : undefined;
  if (!isPlainObject(risk) || !Array.isArray((risk as { protectedPaths?: unknown }).protectedPaths)) {
    throw new DevCortexError(
      'INTERNAL',
      'analyzeBlastRadius: config must be a CortexConfig with risk.protectedPaths',
    );
  }

  const root = typeof graph.root === 'string' ? graph.root : '';
  const routes: RouteNode[] = Array.isArray(graph.routes) ? graph.routes : [];
  const envVars: EnvVar[] = Array.isArray(graph.envVars) ? graph.envVars : [];
  const byPath = new Map<string, FileNode>(graph.files.map((f) => [f.path, f]));

  // 2. Normalise changed files.
  const normalizedChanged = new Set<string>();
  for (const cf of changedFiles) {
    if (typeof cf !== 'string') {
      throw new DevCortexError(
        'INTERNAL',
        `analyzeBlastRadius: changedFiles entries must be strings, got ${typeof cf}`,
      );
    }
    const rel = toRepoRel(root, cf);
    if (rel.length > 0) normalizedChanged.add(rel);
  }

  // 3. Build the radius = changed graph nodes ∪ their transitive dependents.
  const radius = new Set<string>();
  for (const cf of normalizedChanged) {
    if (byPath.has(cf)) radius.add(cf);
    for (const dependent of dependentsOf(graph, cf)) radius.add(dependent);
  }

  const radiusNodes: FileNode[] = [];
  for (const p of radius) {
    const node = byPath.get(p);
    if (node !== undefined) radiusNodes.push(node);
  }

  // 4. Project the radius onto product surfaces.
  const affectedComponents = sortedUnique(
    radiusNodes.filter((n) => n.kind === 'component').map((n) => n.path),
  );
  const affectedTests = sortedUnique(
    radiusNodes.filter((n) => n.kind === 'test').map((n) => n.path),
  );
  // Database surfaces: migration + schema files in the radius. (We cannot mine
  // table names tokenlessly without fabricating them, so the file paths are the
  // honest, deterministic representation of the affected DB surface.)
  const affectedTables = sortedUnique(
    radiusNodes.filter((n) => n.kind === 'migration' || n.kind === 'schema').map((n) => n.path),
  );
  const fragileAreas = sortedUnique(radiusNodes.filter((n) => n.risky).map((n) => n.path));

  const affectsAuth = radiusNodes.some((n) => n.kind === 'auth');
  const affectsBilling = radiusNodes.some((n) => n.kind === 'billing');

  // Routes/api via the graph's route table (file → routePath).
  const pageRoutePaths: string[] = [];
  const apiRoutePaths: string[] = [];
  const mappedApiFiles = new Set<string>();
  for (const route of routes) {
    if (!radius.has(route.file)) continue;
    if (route.kind === 'api') {
      apiRoutePaths.push(route.routePath);
      mappedApiFiles.add(route.file);
    } else {
      pageRoutePaths.push(route.routePath);
    }
  }
  // api-kind files with no route mapping (e.g. Express controllers in a
  // non-Next.js repo) still surface as affected api — by file path.
  const apiSurfaces = [...apiRoutePaths];
  for (const node of radiusNodes) {
    if (node.kind === 'api' && !mappedApiFiles.has(node.path)) apiSurfaces.push(node.path);
  }
  const affectedRoutes = sortedUnique(pageRoutePaths);
  const affectedApi = sortedUnique(apiSurfaces);

  const affectedEnvVars = sortedUnique(
    envVars.filter((e) => e.usedIn.some((u) => radius.has(u))).map((e) => e.name),
  );

  // A changed file matching a protected glob escalates severity regardless of
  // whether it is even in the graph.
  const protectedChanged = [...normalizedChanged].some((p) => isProtected(p, config));

  // 5. Severity = max affected-file risk, escalated for protected changes.
  let severity: RiskLevel = 'low';
  for (const node of radiusNodes) severity = maxRisk(severity, nodeRisk(node));
  if (protectedChanged) severity = maxRisk(severity, 'high');

  // 6. Required checks, derived strictly from affected surfaces.
  const checks: string[] = [];
  if (affectsAuth) checks.push('auth regression test');
  if (affectsBilling) {
    checks.push('webhook signature check');
    checks.push('billing flow regression test');
  }
  if (affectedApi.length > 0) checks.push('API contract test for affected endpoints');
  if (affectedRoutes.length > 0) checks.push('route smoke test for affected routes');
  if (affectedTables.length > 0) {
    checks.push('database migration safety check (dry-run + rollback)');
  }
  if (affectedEnvVars.length > 0) checks.push('verify affected env vars are documented and set');
  if (affectedComponents.length > 0) {
    checks.push('component/UI verification for affected components');
  }
  if (fragileAreas.length > 0) checks.push('manual review of fragile areas');
  if (affectedTests.length > 0) checks.push('run affected tests');
  if (protectedChanged) checks.push('extra review: protected path changed');
  const requiredChecks = [...new Set(checks)];

  return {
    changedFiles: sortedUnique([...normalizedChanged]),
    affectedRoutes,
    affectedComponents,
    affectedApi,
    affectedTables,
    affectsAuth,
    affectsBilling,
    affectedEnvVars,
    affectedTests,
    fragileAreas,
    requiredChecks,
    severity,
  };
}
