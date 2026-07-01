import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { EvidenceError } from '../domain/index';
import type { CortexConfig, ProjectGraph, ShipReport } from '../domain/index';
import {
  verifyFileExists,
  verifyRouteExists,
  verifySymbolExists,
  verifyImportPath,
  verifyCommandResult,
  verifyBuildEvidence,
} from './verifiers';
import { blockUnprovenDone } from './block';

// --- shared fixtures --------------------------------------------------------

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-evidence-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    schemaVersion: 1,
    mode: 'guarded',
    privacy: 'local-only',
    risk: { protectedPaths: [], floors: {} },
    gates: { typecheck: true, lint: true, build: true, test: true, blockUnprovenDone: true },
    stackPacks: [],
    commands: {},
    ...overrides,
  };
}

function graphWithRoutes(): ProjectGraph {
  return {
    schemaVersion: 1,
    root: tmp,
    generatedAt: new Date().toISOString(),
    stack: {
      framework: 'nextjs',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets: [],
    },
    files: [],
    routes: [
      { routePath: '/dashboard', file: 'app/dashboard/page.tsx', kind: 'page' },
      { routePath: '/api/user', file: 'app/api/user/route.ts', kind: 'api' },
    ],
    envVars: [],
    scripts: {},
    riskyFiles: [],
    stats: { fileCount: 0, routeCount: 2, apiCount: 1, testCount: 0, riskyCount: 0 },
  };
}

// --- verifyFileExists -------------------------------------------------------

describe('verifyFileExists', () => {
  it('verifies a real file', async () => {
    const rel = 'present.txt';
    await writeFile(path.join(tmp, rel), 'hi', 'utf8');
    const ev = await verifyFileExists(tmp, rel);
    expect(ev.status).toBe('verified');
    expect(ev.kind).toBe('file');
    expect(ev.id).toMatch(/[0-9a-f-]{36}/);
    expect(() => new Date(ev.createdAt).toISOString()).not.toThrow();
  });

  it('refutes a missing file without throwing', async () => {
    const ev = await verifyFileExists(tmp, 'does-not-exist.txt');
    expect(ev.status).toBe('refuted');
    expect(ev.kind).toBe('file');
  });

  it('refutes a path that is a directory', async () => {
    const dir = 'a-directory';
    await mkdir(path.join(tmp, dir), { recursive: true });
    const ev = await verifyFileExists(tmp, dir);
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('directory');
  });

  it('throws EvidenceError on empty input', async () => {
    await expect(verifyFileExists(tmp, '')).rejects.toBeInstanceOf(EvidenceError);
  });

  it('refuses a path-traversal escape without reading outside the root', async () => {
    // /etc/passwd exists and is readable; if containment failed this would come
    // back "verified". With containment it is refused and never read.
    const ev = await verifyFileExists(tmp, '../../../../../../etc/passwd');
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('outside the project root');
  });

  it('refuses an absolute path that points outside the root', async () => {
    const ev = await verifyFileExists(tmp, '/etc/passwd');
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('outside the project root');
  });
});

// --- verifyRouteExists ------------------------------------------------------

describe('verifyRouteExists', () => {
  it('verifies a route present in the graph', () => {
    const ev = verifyRouteExists(graphWithRoutes(), '/api/user');
    expect(ev.status).toBe('verified');
    expect(ev.kind).toBe('route');
    expect(ev.detail).toContain('app/api/user/route.ts');
  });

  it('refutes a route absent from the graph', () => {
    const ev = verifyRouteExists(graphWithRoutes(), '/nope');
    expect(ev.status).toBe('refuted');
  });

  it('throws EvidenceError on an invalid graph', () => {
    // @ts-expect-error intentionally invalid input to exercise the guard
    expect(() => verifyRouteExists({}, '/x')).toThrow(EvidenceError);
  });
});

// --- verifySymbolExists -----------------------------------------------------

describe('verifySymbolExists', () => {
  const file = 'symbols.ts';

  beforeAll(async () => {
    const src = [
      'export function exportedFn() { return 1; }',
      'export const exportedConst = 2;',
      'export interface ExportedIface { a: number; }',
      'const internalConst = 3;',
      'function internalFn() { return internalConst; }',
      'class InternalClass {}',
      'const reexported = 5;',
      'export { reexported as aliasName };',
      'export default function () { return 0; }',
    ].join('\n');
    await writeFile(path.join(tmp, file), src, 'utf8');
  });

  it('verifies an exported function', async () => {
    const ev = await verifySymbolExists(tmp, file, 'exportedFn');
    expect(ev.status).toBe('verified');
    expect(ev.kind).toBe('symbol');
  });

  it('verifies an exported TS interface (lexer-erased, regex-caught)', async () => {
    const ev = await verifySymbolExists(tmp, file, 'ExportedIface');
    expect(ev.status).toBe('verified');
  });

  it('verifies an aliased re-export', async () => {
    const ev = await verifySymbolExists(tmp, file, 'aliasName');
    expect(ev.status).toBe('verified');
  });

  it('verifies a default export', async () => {
    const ev = await verifySymbolExists(tmp, file, 'default');
    expect(ev.status).toBe('verified');
  });

  it('marks a declared-but-not-exported symbol as partial', async () => {
    const ev = await verifySymbolExists(tmp, file, 'internalConst');
    expect(ev.status).toBe('partial');
    expect(ev.detail).toContain('not exported');
  });

  it('marks an internal class as partial', async () => {
    const ev = await verifySymbolExists(tmp, file, 'InternalClass');
    expect(ev.status).toBe('partial');
  });

  it('refutes an absent symbol', async () => {
    const ev = await verifySymbolExists(tmp, file, 'totallyAbsent');
    expect(ev.status).toBe('refuted');
  });

  it('refutes when the file is missing', async () => {
    const ev = await verifySymbolExists(tmp, 'no-such-file.ts', 'whatever');
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('does not exist');
  });

  it('refuses a path-traversal escape without reading outside the root', async () => {
    const ev = await verifySymbolExists(tmp, '../../../../../../etc/passwd', 'root');
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('outside the project root');
  });
});

// --- verifyImportPath -------------------------------------------------------

describe('verifyImportPath', () => {
  beforeAll(async () => {
    await mkdir(path.join(tmp, 'imp', 'lib'), { recursive: true });
    await writeFile(path.join(tmp, 'imp', 'util.ts'), 'export const x = 1;', 'utf8');
    await writeFile(path.join(tmp, 'imp', 'index.ts'), "import './util';", 'utf8');
    await writeFile(path.join(tmp, 'imp', 'lib', 'index.ts'), 'export const y = 2;', 'utf8');
    await writeFile(path.join(tmp, 'imp', 'rootish.ts'), 'export const z = 3;', 'utf8');
  });

  it('verifies an extensionless relative import', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', './util');
    expect(ev.status).toBe('verified');
    expect(ev.kind).toBe('import');
  });

  it('verifies a TS ESM .js import that resolves to a .ts file', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', './util.js');
    expect(ev.status).toBe('verified');
  });

  it('verifies a directory import resolving to index', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', './lib');
    expect(ev.status).toBe('verified');
  });

  it('verifies a root-absolute import', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', '/imp/rootish');
    expect(ev.status).toBe('verified');
  });

  it('refutes a missing relative import', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', './missing');
    expect(ev.status).toBe('refuted');
  });

  it('verifies a node: builtin', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', 'node:path');
    expect(ev.status).toBe('verified');
    expect(ev.detail).toContain('built-in');
  });

  it('verifies a bare builtin without the node: prefix', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', 'fs');
    expect(ev.status).toBe('verified');
  });

  it('marks an uninstalled bare package as unverified', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', 'definitely-not-a-real-pkg-xyz');
    expect(ev.status).toBe('unverified');
  });

  it('refuses an import whose fromFile escapes the root', async () => {
    const ev = await verifyImportPath(tmp, '../../../../../../etc/passwd', './x');
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('outside the project root');
  });

  it('refuses a relative import that escapes the root', async () => {
    const ev = await verifyImportPath(tmp, 'imp/index.ts', '../../../../../../etc/passwd');
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('outside the project root');
  });
});

// --- verifyCommandResult ----------------------------------------------------

describe('verifyCommandResult', () => {
  it('verifies a command that exits 0', async () => {
    const ev = await verifyCommandResult('exit 0', { cwd: tmp });
    expect(ev.status).toBe('verified');
    expect(ev.kind).toBe('command');
    expect(ev.exitCode).toBe(0);
    expect(ev.command).toBe('exit 0');
  });

  it('refutes a command that exits non-zero without throwing', async () => {
    const ev = await verifyCommandResult('exit 1', { cwd: tmp });
    expect(ev.status).toBe('refuted');
    expect(ev.exitCode).toBe(1);
  });

  it('captures stdout', async () => {
    const ev = await verifyCommandResult('echo cortex-marker', { cwd: tmp });
    expect(ev.status).toBe('verified');
    expect(ev.output).toContain('cortex-marker');
  });

  it('refutes (does not throw) on timeout', async () => {
    const ev = await verifyCommandResult('sleep 5', { cwd: tmp, timeoutMs: 250 });
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('timed out');
  });

  it('kills the whole process group on timeout (grandchildren do not survive)', async () => {
    const sentinel = path.join(tmp, `grandchild-${randomUUID()}.txt`);
    // The top shell backgrounds a grandchild that waits then writes a sentinel,
    // then itself sleeps past the deadline. If only the direct child were
    // killed, the backgrounded grandchild would survive (reparented to init)
    // and write the sentinel; killing the whole process group takes it too.
    const cmd = `sh -c 'sleep 1 && echo alive > "${sentinel}"' & sleep 5`;
    const ev = await verifyCommandResult(cmd, { cwd: tmp, timeoutMs: 250 });
    expect(ev.status).toBe('refuted');
    expect(ev.detail).toContain('timed out');

    // Wait well past the grandchild's own 1s sleep; a survivor would have
    // written the sentinel by now.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(stat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('accepts (clamps) an oversized caller-supplied timeout instead of throwing', async () => {
    const ev = await verifyCommandResult('exit 0', { cwd: tmp, timeoutMs: 60 * 60 * 1000 });
    expect(ev.status).toBe('verified');
    expect(ev.exitCode).toBe(0);
  });

  it('throws EvidenceError on empty command', async () => {
    await expect(verifyCommandResult('', { cwd: tmp })).rejects.toBeInstanceOf(EvidenceError);
  });

  it('throws EvidenceError on a non-positive timeout', async () => {
    await expect(verifyCommandResult('exit 0', { cwd: tmp, timeoutMs: 0 })).rejects.toBeInstanceOf(
      EvidenceError,
    );
  });
});

// --- verifyBuildEvidence ----------------------------------------------------

describe('verifyBuildEvidence', () => {
  it('runs the configured build command (config.commands.build precedence)', async () => {
    const ev = await verifyBuildEvidence(tmp, baseConfig({ commands: { build: 'exit 0' } }));
    expect(ev.status).toBe('verified');
    expect(ev.kind).toBe('build');
    expect(ev.command).toBe('exit 0');
  });

  it('refutes when the configured build command fails', async () => {
    const ev = await verifyBuildEvidence(tmp, baseConfig({ commands: { build: 'exit 2' } }));
    expect(ev.status).toBe('refuted');
    expect(ev.exitCode).toBe(2);
  });

  it('detects and runs the package.json build script when no command is configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devcortex-build-'));
    try {
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'x', version: '1.0.0', scripts: { build: 'exit 0' } }),
        'utf8',
      );
      const ev = await verifyBuildEvidence(dir, baseConfig());
      expect(ev.status).toBe('verified');
      expect(ev.command).toBe('npm run build');
      expect(ev.detail).toContain('package.json scripts.build');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('is unverified when there is no build command to run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devcortex-nobuild-'));
    try {
      const ev = await verifyBuildEvidence(dir, baseConfig());
      expect(ev.status).toBe('unverified');
      expect(ev.kind).toBe('build');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// --- blockUnprovenDone ------------------------------------------------------

describe('blockUnprovenDone', () => {
  function report(overrides: Partial<ShipReport> = {}): ShipReport {
    return {
      status: 'READY',
      passed: [],
      blocked: [],
      warnings: [],
      evidenceIds: ['ev-1'],
      generatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('does not block a READY report backed by evidence', () => {
    const decision = blockUnprovenDone(report());
    expect(decision.blocked).toBe(false);
    expect(decision.reasons).toHaveLength(0);
  });

  it('does not block READY_WITH_WARNINGS backed by evidence', () => {
    const decision = blockUnprovenDone(report({ status: 'READY_WITH_WARNINGS', warnings: ['w'] }));
    expect(decision.blocked).toBe(false);
  });

  it('blocks a NOT_READY report', () => {
    const decision = blockUnprovenDone(report({ status: 'NOT_READY' }));
    expect(decision.blocked).toBe(true);
    expect(decision.reasons.some((r) => r.includes('NOT_READY'))).toBe(true);
  });

  it('blocks and explains failed required checks', () => {
    const decision = blockUnprovenDone(
      report({
        status: 'NOT_READY',
        blocked: [{ name: 'typecheck', passed: false, detail: 'tsc found 3 errors' }],
      }),
    );
    expect(decision.blocked).toBe(true);
    expect(decision.reasons.some((r) => r.includes('typecheck') && r.includes('tsc found 3 errors'))).toBe(
      true,
    );
  });

  it('blocks a "done" claim with zero evidence even when status is READY', () => {
    const decision = blockUnprovenDone(report({ evidenceIds: [] }));
    expect(decision.blocked).toBe(true);
    expect(decision.reasons.some((r) => r.includes('No evidence'))).toBe(true);
  });

  it('throws EvidenceError on a structurally invalid report', () => {
    // @ts-expect-error intentionally invalid input
    expect(() => blockUnprovenDone(null)).toThrow(EvidenceError);
    // @ts-expect-error intentionally invalid status
    expect(() => blockUnprovenDone({ status: 'WAT', blocked: [], evidenceIds: [] })).toThrow(
      EvidenceError,
    );
  });
});
