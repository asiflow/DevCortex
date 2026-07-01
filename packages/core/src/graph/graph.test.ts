import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FileNode, ProjectGraph, RouteNode } from '../domain/index';
import { isDevCortexError } from '../domain/index';

import { scanProject, relevantFiles, dependentsOf } from './index';
import { classifyFile } from './classify';
import { detectRoutes } from './routes';
import { extractEnvRefs } from './env';
import { extractSymbols, extractImportSpecifiers } from './imports';

// ---------------------------------------------------------------------------
// Fixture: a tiny but real Next.js (App + Pages router) TypeScript repo built
// in a fresh tmpdir. Never the repo's own fixtures/ (built concurrently).
// ---------------------------------------------------------------------------

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'fixture-app',
    private: true,
    scripts: { dev: 'next dev', build: 'next build', test: 'vitest run' },
    dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0', stripe: '^14.0.0' },
    devDependencies: { typescript: '^5.7.0' },
  }),
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  // tsconfig with a comment + trailing comma to exercise the JSONC reader
  'tsconfig.json': `{
    // path aliases for the import resolver
    "compilerOptions": {
      "baseUrl": ".",
      "paths": { "@/*": ["./src/*"] },
    }
  }`,
  'next.config.mjs': 'export default {};\n',
  'vercel.json': '{}\n',
  Dockerfile: 'FROM node:20-alpine\n',
  '.env.example': '# documented env\nAUTH_SECRET=\nNEXT_PUBLIC_API_URL=\n',
  'middleware.ts': `import { requireUser } from './src/lib/auth';

export function middleware() {
  const guard = process.env.AUTH_SECRET;
  return requireUser(guard);
}
`,
  'src/app/layout.tsx': `export default function Layout() {
  return null;
}
`,
  'src/app/page.tsx': `export default function Page() {
  const url = process.env.NEXT_PUBLIC_API_URL;
  return url ?? null;
}
`,
  'src/app/dashboard/page.tsx': `export default function Dashboard() {
  return null;
}
`,
  'src/app/(marketing)/about/page.tsx': `export default function About() {
  return null;
}
`,
  'src/app/blog/[slug]/page.tsx': `export default function BlogPost() {
  return null;
}
`,
  'src/app/api/user/route.ts': `export function GET() {
  return new Response('ok');
}
`,
  'src/pages/legacy.tsx': `export default function Legacy() {
  return null;
}
`,
  'src/pages/api/health.ts': `export default function handler() {
  return { ok: true };
}
`,
  'src/pages/_app.tsx': `export default function App() {
  return null;
}
`,
  'src/lib/db.ts': `export function query(...args: unknown[]) {
  return args;
}
`,
  'src/lib/auth.ts': `import { query } from '@/lib/db';

export function requireUser(secret?: string) {
  const dbUrl = process.env.DATABASE_URL;
  return query(secret, process.env.AUTH_SECRET, dbUrl);
}
`,
  'src/lib/billing.ts': `import { query } from './db';

export function createCheckout() {
  const key = process.env.STRIPE_SECRET_KEY;
  return query(key);
}
`,
  'src/components/Button.tsx': `export function Button() {
  return null;
}
`,
  // mutual cycle to prove dependentsOf is cycle-safe
  'src/lib/a.ts': `import './b';
export const a = 1;
`,
  'src/lib/b.ts': `import './a';
export const b = 2;
`,
  'src/lib/math.test.ts': `export const ok = true;
`,
};

let tmp: string;
let graph: ProjectGraph;

async function writeFixture(root: string): Promise<void> {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

function node(g: ProjectGraph, p: string): FileNode {
  const found = g.files.find((f) => f.path === p);
  if (found === undefined) throw new Error(`fixture node not found: ${p}`);
  return found;
}

function hasRoute(routes: RouteNode[], routePath: string, kind: RouteNode['kind']): boolean {
  return routes.some((r) => r.routePath === routePath && r.kind === kind);
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'devcortex-graph-'));
  await writeFixture(tmp);
  graph = await scanProject(tmp);
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('scanProject — stack detection', () => {
  it('detects a Next.js TypeScript pnpm app with deployment targets', () => {
    expect(graph.stack.framework).toBe('nextjs');
    expect(graph.stack.language).toBe('typescript');
    expect(graph.stack.packageManager).toBe('pnpm');
    expect(graph.stack.monorepo).toBe(false);
    expect(graph.stack.frameworkVersion).toBe('15.0.0');
    expect(graph.stack.deploymentTargets).toContain('vercel');
    expect(graph.stack.deploymentTargets).toContain('docker');
  });

  it('extracts npm scripts from package.json', () => {
    expect(graph.scripts.dev).toBe('next dev');
    expect(graph.scripts.build).toBe('next build');
    expect(graph.scripts.test).toBe('vitest run');
  });

  it('records absolute root and a schema version', () => {
    expect(graph.root).toBe(path.resolve(tmp));
    expect(graph.schemaVersion).toBeGreaterThanOrEqual(1);
    expect(typeof graph.generatedAt).toBe('string');
  });
});

describe('scanProject — file classification + risky flags', () => {
  it('classifies security/financial/structural surfaces and flags them risky', () => {
    expect(node(graph, 'middleware.ts').kind).toBe('middleware');
    expect(node(graph, 'middleware.ts').risky).toBe(true);
    expect(node(graph, 'src/lib/auth.ts').kind).toBe('auth');
    expect(node(graph, 'src/lib/auth.ts').risky).toBe(true);
    expect(node(graph, 'src/lib/billing.ts').kind).toBe('billing');
    expect(node(graph, 'src/lib/billing.ts').risky).toBe(true);
    expect(node(graph, '.env.example').kind).toBe('env');
    expect(node(graph, '.env.example').risky).toBe(true);
  });

  it('classifies routes, pages, components, libs and tests', () => {
    expect(node(graph, 'src/app/api/user/route.ts').kind).toBe('api');
    expect(node(graph, 'src/app/page.tsx').kind).toBe('page');
    expect(node(graph, 'src/app/layout.tsx').kind).toBe('route');
    expect(node(graph, 'src/components/Button.tsx').kind).toBe('component');
    expect(node(graph, 'src/components/Button.tsx').risky).toBe(false);
    expect(node(graph, 'src/lib/db.ts').kind).toBe('lib');
    expect(node(graph, 'src/lib/math.test.ts').kind).toBe('test');
  });

  it('lists every risky file and keeps riskyCount consistent', () => {
    for (const p of [
      'middleware.ts',
      'src/lib/auth.ts',
      'src/lib/billing.ts',
      '.env.example',
      'package.json',
      'tsconfig.json',
      'next.config.mjs',
      'vercel.json',
      'Dockerfile',
    ]) {
      expect(graph.riskyFiles).toContain(p);
    }
    expect(graph.riskyFiles.length).toBe(9);
    expect(graph.stats.riskyCount).toBe(graph.riskyFiles.length);
  });
});

describe('scanProject — import graph + alias resolution', () => {
  it('resolves tsconfig path aliases (@/lib/db → src/lib/db.ts)', () => {
    expect(node(graph, 'src/lib/auth.ts').imports).toContain('src/lib/db.ts');
  });

  it('resolves relative imports', () => {
    expect(node(graph, 'src/lib/billing.ts').imports).toContain('src/lib/db.ts');
    expect(node(graph, 'middleware.ts').imports).toContain('src/lib/auth.ts');
  });

  it('populates importedBy bidirectionally', () => {
    expect(node(graph, 'src/lib/db.ts').importedBy).toEqual(
      expect.arrayContaining(['src/lib/auth.ts', 'src/lib/billing.ts']),
    );
    expect(node(graph, 'src/lib/auth.ts').importedBy).toContain('middleware.ts');
  });

  it('extracts best-effort top-level symbols', () => {
    expect(node(graph, 'src/lib/db.ts').symbols).toContain('query');
    expect(node(graph, 'src/lib/billing.ts').symbols).toContain('createCheckout');
  });

  it('ignores bare package specifiers (react/next are not repo files)', () => {
    for (const imp of node(graph, 'src/app/page.tsx').imports) {
      expect(imp.startsWith('src/') || imp.includes('/')).toBe(true);
    }
    // page.tsx imports nothing local
    expect(node(graph, 'src/app/page.tsx').imports).toEqual([]);
  });
});

describe('dependentsOf — transitive importedBy closure', () => {
  it('walks the full transitive closure', () => {
    expect(dependentsOf(graph, 'src/lib/db.ts')).toEqual([
      'middleware.ts',
      'src/lib/auth.ts',
      'src/lib/billing.ts',
    ]);
  });

  it('is cycle-safe (a ⇄ b does not loop)', () => {
    expect(dependentsOf(graph, 'src/lib/a.ts')).toEqual(['src/lib/b.ts']);
    expect(dependentsOf(graph, 'src/lib/b.ts')).toEqual(['src/lib/a.ts']);
  });

  it('normalizes an absolute path input', () => {
    const abs = path.join(graph.root, 'src/lib/db.ts');
    expect(dependentsOf(graph, abs)).toEqual([
      'middleware.ts',
      'src/lib/auth.ts',
      'src/lib/billing.ts',
    ]);
  });

  it('returns [] for an unknown file', () => {
    expect(dependentsOf(graph, 'does/not/exist.ts')).toEqual([]);
  });
});

describe('scanProject — route detection', () => {
  it('detects App Router pages, api handlers and layouts', () => {
    expect(hasRoute(graph.routes, '/', 'page')).toBe(true);
    expect(hasRoute(graph.routes, '/dashboard', 'page')).toBe(true);
    expect(hasRoute(graph.routes, '/about', 'page')).toBe(true); // route group stripped
    expect(hasRoute(graph.routes, '/blog/:slug', 'page')).toBe(true); // dynamic normalized
    expect(hasRoute(graph.routes, '/api/user', 'api')).toBe(true);
    expect(hasRoute(graph.routes, '/', 'layout')).toBe(true);
  });

  it('detects Pages Router pages and api', () => {
    expect(hasRoute(graph.routes, '/legacy', 'page')).toBe(true);
    expect(hasRoute(graph.routes, '/api/health', 'api')).toBe(true);
  });

  it('ignores underscore-prefixed pages (_app)', () => {
    expect(graph.routes.some((r) => r.file.endsWith('_app.tsx'))).toBe(false);
  });

  it('computes apiCount from api routes', () => {
    expect(graph.stats.apiCount).toBe(2);
    expect(graph.stats.routeCount).toBe(graph.routes.length);
  });
});

describe('scanProject — env vars', () => {
  it('marks referenced vars documented iff present in .env.example', () => {
    const find = (n: string) => graph.envVars.find((e) => e.name === n);
    const authSecret = find('AUTH_SECRET');
    expect(authSecret).toBeDefined();
    expect(authSecret?.documented).toBe(true);
    expect(authSecret?.usedIn).toEqual(
      expect.arrayContaining(['middleware.ts', 'src/lib/auth.ts']),
    );

    expect(find('DATABASE_URL')?.documented).toBe(false);
    expect(find('STRIPE_SECRET_KEY')?.documented).toBe(false);
    expect(find('NEXT_PUBLIC_API_URL')?.documented).toBe(true);
  });
});

describe('relevantFiles — task-aware ranking', () => {
  it('ranks billing files highest for a billing task', () => {
    const results = relevantFiles(graph, 'add stripe subscription billing webhook');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.path).toBe('src/lib/billing.ts');
    expect(results.some((f) => f.path === 'src/components/Button.tsx')).toBe(false);
  });

  it('ranks auth files highest for an auth task', () => {
    const results = relevantFiles(graph, 'fix user login authentication session');
    expect(results[0]?.path).toBe('src/lib/auth.ts');
  });

  it('returns [] for an empty / signal-free task', () => {
    expect(relevantFiles(graph, '')).toEqual([]);
    expect(relevantFiles(graph, 'the and to for')).toEqual([]);
  });
});

describe('scanProject — options + stats + error handling', () => {
  it('honors maxFiles', async () => {
    const limited = await scanProject(tmp, { maxFiles: 3 });
    expect(limited.files.length).toBe(3);
  });

  it('honors extra ignore globs', async () => {
    const ignored = await scanProject(tmp, { ignore: ['**/components/**'] });
    expect(ignored.files.some((f) => f.path.includes('components/'))).toBe(false);
  });

  it('computes consistent stats', () => {
    expect(graph.stats.fileCount).toBe(graph.files.length);
    expect(graph.stats.testCount).toBe(1);
    expect(graph.stats.fileCount).toBe(Object.keys(FILES).length);
  });

  it('throws a ScanError for a non-existent root', async () => {
    await expect(scanProject(path.join(tmp, 'nope-does-not-exist'))).rejects.toSatisfy(
      (err: unknown) => isDevCortexError(err) && err.code === 'SCAN_FAILED',
    );
  });
});

// --- pure-function units (no fixture / no init needed for these) ------------

describe('classifyFile — unit', () => {
  it('classifies by path + name heuristics', () => {
    expect(classifyFile('prisma/schema.prisma').kind).toBe('schema');
    const migration = classifyFile('prisma/migrations/0001_init/migration.sql');
    expect(migration.kind).toBe('migration');
    expect(migration.risky).toBe(true);
    expect(classifyFile('next.config.mjs').kind).toBe('config');
    expect(classifyFile('src/styles/globals.css').kind).toBe('style');
    expect(classifyFile('src/lib/utils.ts').kind).toBe('lib');
    expect(classifyFile('README.md').kind).toBe('other');
  });

  it('flags security-token files risky even when kind is lib', () => {
    const sec = classifyFile('src/lib/security.ts');
    expect(sec.kind).toBe('lib');
    expect(sec.risky).toBe(true);
  });

  it('does not misclassify author as auth (token-boundary matching)', () => {
    expect(classifyFile('src/lib/author.ts').risky).toBe(false);
    expect(classifyFile('src/lib/author.ts').kind).toBe('lib');
  });
});

describe('detectRoutes — unit', () => {
  it('handles both routers and dynamic/group segments', () => {
    const routes = detectRoutes([
      'src/app/page.tsx',
      'src/app/blog/[slug]/page.tsx',
      'src/app/(marketing)/about/page.tsx',
      'src/app/api/user/route.ts',
      'src/app/layout.tsx',
      'src/pages/_app.tsx',
      'src/pages/legacy.tsx',
      'src/pages/api/health.ts',
    ]);
    expect(hasRoute(routes, '/blog/:slug', 'page')).toBe(true);
    expect(hasRoute(routes, '/about', 'page')).toBe(true);
    expect(hasRoute(routes, '/api/user', 'api')).toBe(true);
    expect(hasRoute(routes, '/api/health', 'api')).toBe(true);
    expect(routes.some((r) => r.file.endsWith('_app.tsx'))).toBe(false);
  });
});

describe('extractEnvRefs / extractSymbols / extractImportSpecifiers — unit', () => {
  it('finds dot and bracket env refs', () => {
    const refs = extractEnvRefs("const a = process.env.FOO; const b = process.env['BAR'];");
    expect(refs).toEqual(expect.arrayContaining(['FOO', 'BAR']));
  });

  it('extracts a range of export forms', () => {
    const syms = extractSymbols(
      `export function f() {}
       export const g = 1;
       export default class H {}
       export { a, b as c };
       export type T = number;`,
    );
    expect(syms).toEqual(expect.arrayContaining(['f', 'g', 'H', 'default', 'a', 'c', 'T']));
  });

  it('extracts specifiers from static, dynamic, side-effect, and require forms', () => {
    const specs = extractImportSpecifiers(
      `import x from './a';
       import './b';
       const y = await import('./c');
       const z = require('./d');
       export { q } from './e';`,
    );
    expect(specs).toEqual(expect.arrayContaining(['./a', './b', './c', './d', './e']));
  });
});
