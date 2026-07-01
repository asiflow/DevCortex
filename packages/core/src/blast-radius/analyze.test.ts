/**
 * Blast-radius engine tests.
 *
 * Two complementary fixtures, per the design's testing strategy:
 *   1. An inline, hand-wired `ProjectGraph` with a known import topology — lets
 *      us assert the transitive-dependent walk, surface projection, auth/billing
 *      flags, required-check derivation, severity, and input validation exactly.
 *   2. A real tiny Next.js repo scanned from a fresh tmpdir via `scanProject` —
 *      proves the analysis works end-to-end on the actual graph the scanner
 *      produces (alias-free relative imports, route detection, env detection,
 *      a SQL migration), not just on a mock.
 *
 * Tests import the module under test directly (`./analyze`) and build the scan
 * fixture under `os.tmpdir()` — never the repo's own `fixtures/`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  CortexConfig,
  EnvVar,
  FileKind,
  FileNode,
  ProjectGraph,
  RouteNode,
} from '../domain/index';
import { DevCortexError, isDevCortexError } from '../domain/index';

import { analyzeBlastRadius } from './analyze';
import { scanProject } from '../graph';

// ---------------------------------------------------------------------------
// builders for the inline graph
// ---------------------------------------------------------------------------

function makeFile(p: string, kind: FileKind, overrides: Partial<FileNode> = {}): FileNode {
  return {
    path: p,
    kind,
    imports: [],
    importedBy: [],
    symbols: [],
    risky: false,
    tags: [],
    ...overrides,
  };
}

function makeGraph(opts: {
  files: FileNode[];
  routes?: RouteNode[];
  envVars?: EnvVar[];
  root?: string;
}): ProjectGraph {
  const { files } = opts;
  const routes = opts.routes ?? [];
  const riskyFiles = files
    .filter((f) => f.risky)
    .map((f) => f.path)
    .sort();
  return {
    schemaVersion: 1,
    root: opts.root ?? '/repo',
    generatedAt: '2026-06-30T00:00:00.000Z',
    stack: {
      framework: 'nextjs',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets: [],
    },
    files,
    routes,
    envVars: opts.envVars ?? [],
    scripts: {},
    riskyFiles,
    stats: {
      fileCount: files.length,
      routeCount: routes.length,
      apiCount: routes.filter((r) => r.kind === 'api').length,
      testCount: files.filter((f) => f.kind === 'test').length,
      riskyCount: riskyFiles.length,
    },
  };
}

function makeConfig(protectedPaths: string[] = []): CortexConfig {
  return {
    schemaVersion: 1,
    mode: 'guarded',
    privacy: 'local-only',
    risk: { protectedPaths, floors: {} },
    gates: { typecheck: true, lint: true, build: true, test: true, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
  };
}

/**
 * Inline topology:
 *   db ← auth ← { middleware, dashboard-page }
 *   db ← auth ← auth.test
 *   db ← billing ← api/user route
 *   db ← db.test
 *   Button (leaf component, no deps)
 *   format (leaf lib, no deps — used to isolate protected-path escalation)
 */
function buildInlineGraph(): ProjectGraph {
  const files: FileNode[] = [
    makeFile('src/lib/db.ts', 'lib', {
      importedBy: ['src/lib/auth.ts', 'src/lib/billing.ts', 'src/lib/db.test.ts'],
    }),
    makeFile('src/lib/auth.ts', 'auth', {
      risky: true,
      imports: ['src/lib/db.ts'],
      importedBy: ['middleware.ts', 'src/app/dashboard/page.tsx', 'src/lib/auth.test.ts'],
    }),
    makeFile('src/lib/billing.ts', 'billing', {
      risky: true,
      imports: ['src/lib/db.ts'],
      importedBy: ['src/app/api/user/route.ts'],
    }),
    makeFile('middleware.ts', 'middleware', { risky: true, imports: ['src/lib/auth.ts'] }),
    makeFile('src/app/dashboard/page.tsx', 'page', { imports: ['src/lib/auth.ts'] }),
    makeFile('src/app/api/user/route.ts', 'api', { imports: ['src/lib/billing.ts'] }),
    makeFile('src/lib/auth.test.ts', 'test', { imports: ['src/lib/auth.ts'] }),
    makeFile('src/lib/db.test.ts', 'test', { imports: ['src/lib/db.ts'] }),
    makeFile('src/components/Button.tsx', 'component'),
    makeFile('src/util/format.ts', 'lib'),
  ];
  const routes: RouteNode[] = [
    { routePath: '/dashboard', file: 'src/app/dashboard/page.tsx', kind: 'page' },
    { routePath: '/api/user', file: 'src/app/api/user/route.ts', kind: 'api' },
  ];
  const envVars: EnvVar[] = [
    { name: 'AUTH_SECRET', usedIn: ['src/lib/auth.ts'], documented: true },
    { name: 'STRIPE_SECRET_KEY', usedIn: ['src/lib/billing.ts'], documented: false },
    { name: 'DATABASE_URL', usedIn: ['src/lib/db.ts'], documented: false },
  ];
  return makeGraph({ files, routes, envVars });
}

// ---------------------------------------------------------------------------
// inline-graph tests
// ---------------------------------------------------------------------------

describe('analyzeBlastRadius — inline graph topology', () => {
  const graph = buildInlineGraph();
  const config = makeConfig();

  it('propagates transitively from a deep dependency to every dependent surface', () => {
    const br = analyzeBlastRadius(graph, ['src/lib/db.ts'], config);

    // auth + billing both reachable from db → flags set.
    expect(br.affectsAuth).toBe(true);
    expect(br.affectsBilling).toBe(true);

    // routes/api projected from the dependents that are route files.
    expect(br.affectedRoutes).toEqual(['/dashboard']);
    expect(br.affectedApi).toEqual(['/api/user']);

    // tests in the radius.
    expect(br.affectedTests).toEqual(['src/lib/auth.test.ts', 'src/lib/db.test.ts']);

    // every risky file reachable from db.
    expect(br.fragileAreas).toEqual([
      'middleware.ts',
      'src/lib/auth.ts',
      'src/lib/billing.ts',
    ]);

    // env vars used by any file in the radius.
    expect(br.affectedEnvVars).toEqual(['AUTH_SECRET', 'DATABASE_URL', 'STRIPE_SECRET_KEY']);

    // no component or db-schema files in this radius.
    expect(br.affectedComponents).toEqual([]);
    expect(br.affectedTables).toEqual([]);

    // severity is high (auth/billing/middleware are high; nothing critical).
    expect(br.severity).toBe('high');

    // required checks derived from the affected surfaces.
    expect(br.requiredChecks).toContain('auth regression test');
    expect(br.requiredChecks).toContain('webhook signature check');
    expect(br.requiredChecks).toContain('billing flow regression test');
    expect(br.requiredChecks).toContain('API contract test for affected endpoints');
    expect(br.requiredChecks).toContain('route smoke test for affected routes');
    expect(br.requiredChecks).toContain('run affected tests');
    // no migration/schema surface → no DB check.
    expect(br.requiredChecks).not.toContain('database migration safety check (dry-run + rollback)');
  });

  it('limits the radius to a leaf with no dependents', () => {
    const br = analyzeBlastRadius(graph, ['src/components/Button.tsx'], config);
    expect(br.affectsAuth).toBe(false);
    expect(br.affectsBilling).toBe(false);
    expect(br.affectedComponents).toEqual(['src/components/Button.tsx']);
    expect(br.affectedRoutes).toEqual([]);
    expect(br.affectedApi).toEqual([]);
    expect(br.fragileAreas).toEqual([]);
    expect(br.severity).toBe('low');
    expect(br.requiredChecks).toEqual(['component/UI verification for affected components']);
  });

  it('flags billing (not auth) for a billing-only change and reaches its api route', () => {
    const br = analyzeBlastRadius(graph, ['src/lib/billing.ts'], config);
    expect(br.affectsBilling).toBe(true);
    expect(br.affectsAuth).toBe(false);
    expect(br.affectedApi).toEqual(['/api/user']);
    expect(br.affectedRoutes).toEqual([]);
    expect(br.affectedEnvVars).toEqual(['STRIPE_SECRET_KEY']);
    expect(br.severity).toBe('high');
    expect(br.requiredChecks).toContain('webhook signature check');
  });

  it('escalates severity to high when a benign changed file matches a protected path', () => {
    const protectedConfig = makeConfig(['**/format.ts']);
    const br = analyzeBlastRadius(graph, ['src/util/format.ts'], protectedConfig);
    // format.ts is a non-risky lib with no dependents — low on its own merits.
    const baseline = analyzeBlastRadius(graph, ['src/util/format.ts'], makeConfig());
    expect(baseline.severity).toBe('low');
    // ...but protected → escalated to high, with an explicit review check.
    expect(br.severity).toBe('high');
    expect(br.requiredChecks).toContain('extra review: protected path changed');
  });

  it('normalizes an absolute changed-file path against the graph root', () => {
    const abs = `${graph.root}/src/lib/db.ts`;
    const br = analyzeBlastRadius(graph, [abs], config);
    expect(br.changedFiles).toEqual(['src/lib/db.ts']);
    expect(br.affectsAuth).toBe(true);
    expect(br.severity).toBe('high');
  });

  it('returns an empty, low-severity radius for no changed files', () => {
    const br = analyzeBlastRadius(graph, [], config);
    expect(br.changedFiles).toEqual([]);
    expect(br.affectedRoutes).toEqual([]);
    expect(br.affectedComponents).toEqual([]);
    expect(br.affectedApi).toEqual([]);
    expect(br.affectedTables).toEqual([]);
    expect(br.affectedEnvVars).toEqual([]);
    expect(br.affectedTests).toEqual([]);
    expect(br.fragileAreas).toEqual([]);
    expect(br.affectsAuth).toBe(false);
    expect(br.affectsBilling).toBe(false);
    expect(br.requiredChecks).toEqual([]);
    expect(br.severity).toBe('low');
  });

  it('contributes nothing for a changed file that is not in the graph', () => {
    const br = analyzeBlastRadius(graph, ['does/not/exist.ts'], config);
    expect(br.changedFiles).toEqual(['does/not/exist.ts']);
    expect(br.severity).toBe('low');
    expect(br.affectsAuth).toBe(false);
    expect(br.affectedRoutes).toEqual([]);
    expect(br.fragileAreas).toEqual([]);
  });

  it('normalizes, de-duplicates and sorts the echoed changed-file list', () => {
    const br = analyzeBlastRadius(
      graph,
      ['./src/lib/billing.ts', 'src/lib/auth.ts', 'src/lib/auth.ts'],
      config,
    );
    expect(br.changedFiles).toEqual(['src/lib/auth.ts', 'src/lib/billing.ts']);
  });
});

// ---------------------------------------------------------------------------
// input validation
// ---------------------------------------------------------------------------

describe('analyzeBlastRadius — input validation', () => {
  const graph = buildInlineGraph();
  const config = makeConfig();

  it('throws DevCortexError(INTERNAL) when changedFiles is not an array', () => {
    let caught: unknown;
    try {
      analyzeBlastRadius(graph, 'src/lib/db.ts' as unknown as string[], config);
    } catch (err) {
      caught = err;
    }
    expect(isDevCortexError(caught)).toBe(true);
    expect(isDevCortexError(caught) && caught.code).toBe('INTERNAL');
  });

  it('throws DevCortexError when a changed-file entry is not a string', () => {
    expect(() => analyzeBlastRadius(graph, [42 as unknown as string], config)).toThrow(
      DevCortexError,
    );
  });

  it('throws DevCortexError when the graph is malformed', () => {
    expect(() =>
      analyzeBlastRadius(null as unknown as ProjectGraph, ['src/lib/db.ts'], config),
    ).toThrow(DevCortexError);
  });

  it('throws DevCortexError when the config has no risk.protectedPaths', () => {
    expect(() =>
      analyzeBlastRadius(graph, ['src/lib/db.ts'], {} as unknown as CortexConfig),
    ).toThrow(DevCortexError);
  });
});

// ---------------------------------------------------------------------------
// scanned real-repo fixture
// ---------------------------------------------------------------------------

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'br-fixture-app',
    private: true,
    scripts: { build: 'next build', test: 'vitest run' },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', stripe: '^14.0.0' },
    devDependencies: { typescript: '^5.7.0' },
  }),
  '.env.example': '# documented\nAUTH_SECRET=\n',
  'middleware.ts': `import { requireUser } from './src/lib/auth';

export function middleware() {
  return requireUser();
}
`,
  'src/lib/db.ts': `export function query(...args: unknown[]) {
  const url = process.env.DATABASE_URL;
  return [url, ...args];
}
`,
  'src/lib/auth.ts': `import { query } from './db';

export function requireUser() {
  return query(process.env.AUTH_SECRET);
}
`,
  'src/lib/billing.ts': `import { query } from './db';

export function createCheckout() {
  return query(process.env.STRIPE_SECRET_KEY);
}
`,
  'src/lib/auth.test.ts': `import { requireUser } from './auth';

export const ok = typeof requireUser === 'function';
`,
  'src/app/dashboard/page.tsx': `import { requireUser } from '../../lib/auth';

export default function Dashboard() {
  requireUser();
  return null;
}
`,
  'src/app/api/user/route.ts': `import { createCheckout } from '../../../lib/billing';

export function GET() {
  createCheckout();
  return new Response('ok');
}
`,
  'src/components/Button.tsx': `export function Button() {
  return null;
}
`,
  'prisma/migrations/0001_init/migration.sql': `CREATE TABLE users (id text primary key);
`,
};

describe('analyzeBlastRadius — scanned Next.js fixture', () => {
  let tmp: string;
  let graph: ProjectGraph;
  const config = makeConfig();

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'devcortex-blast-'));
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const abs = path.join(tmp, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    graph = await scanProject(tmp);
  });

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('detects the scanned import topology (sanity check on the fixture)', () => {
    // db is imported by auth + billing → both depend on it transitively.
    const dependents = new Set(
      graph.files.flatMap((f) => (f.imports.includes('src/lib/db.ts') ? [f.path] : [])),
    );
    expect(dependents.has('src/lib/auth.ts')).toBe(true);
    expect(dependents.has('src/lib/billing.ts')).toBe(true);
    expect(graph.stack.framework).toBe('nextjs');
  });

  it('propagates a low-level lib change up to auth, billing, routes, and env', () => {
    const br = analyzeBlastRadius(graph, ['src/lib/db.ts'], config);

    expect(br.affectsAuth).toBe(true);
    expect(br.affectsBilling).toBe(true);
    expect(br.affectedRoutes).toContain('/dashboard');
    expect(br.affectedApi).toContain('/api/user');
    expect(br.affectedTests).toContain('src/lib/auth.test.ts');
    expect(br.fragileAreas).toEqual(
      expect.arrayContaining(['middleware.ts', 'src/lib/auth.ts', 'src/lib/billing.ts']),
    );
    expect(br.affectedEnvVars).toEqual(expect.arrayContaining(['AUTH_SECRET', 'STRIPE_SECRET_KEY']));
    expect(br.requiredChecks).toContain('auth regression test');
    expect(br.requiredChecks).toContain('webhook signature check');
    expect(br.severity).toBe('high');
  });

  it('treats a SQL migration change as a critical database surface', () => {
    const br = analyzeBlastRadius(graph, ['prisma/migrations/0001_init/migration.sql'], config);
    expect(br.affectedTables).toContain('prisma/migrations/0001_init/migration.sql');
    expect(br.severity).toBe('critical');
    expect(br.requiredChecks).toContain('database migration safety check (dry-run + rollback)');
  });

  it('scopes a component-only change to that component at low severity', () => {
    const br = analyzeBlastRadius(graph, ['src/components/Button.tsx'], config);
    expect(br.affectedComponents).toContain('src/components/Button.tsx');
    expect(br.affectsAuth).toBe(false);
    expect(br.affectsBilling).toBe(false);
    expect(br.severity).toBe('low');
  });

  it('escalates to high when the scanned changed file is on a protected path', () => {
    const protectedConfig = makeConfig(['**/components/**']);
    const br = analyzeBlastRadius(graph, ['src/components/Button.tsx'], protectedConfig);
    expect(br.severity).toBe('high');
    expect(br.requiredChecks).toContain('extra review: protected path changed');
  });
});
