import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DevCortexError } from '../domain/index';
import type { CortexConfig, ProjectGraph, RouteNode, EnvVar } from '../domain/index';
import { EvidenceLedger } from '../ledgers';
import { workspacePaths } from '../workspace/paths';

import { runQualityGate, generateShipReport } from './gates';

// --- fixtures ---------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-gates-'));
});

afterEach(async () => {
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

function baseGraph(routes: RouteNode[] = [], envVars: EnvVar[] = []): ProjectGraph {
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
    routes,
    envVars,
    scripts: {},
    riskyFiles: [],
    stats: { fileCount: 0, routeCount: routes.length, apiCount: 0, testCount: 0, riskyCount: 0 },
  };
}

/** Write a real file under the tmp repo so a route's backing file resolves. */
async function touch(relPath: string): Promise<void> {
  const abs = path.join(tmp, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, '// fixture\nexport default function Page() { return null; }\n', 'utf8');
}

// --- runQualityGate: command checks -----------------------------------------

describe('runQualityGate — command gates', () => {
  it('passes when every enabled command exits 0', async () => {
    const config = baseConfig({
      commands: { typecheck: 'exit 0', lint: 'exit 0', build: 'exit 0', test: 'exit 0' },
    });
    const { result, evidence } = await runQualityGate(tmp, config, baseGraph());

    expect(result.gate).toBe('quality');
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.checks.map((c) => c.name).sort()).toEqual(['build', 'lint', 'test', 'typecheck']);

    // One evidence item per check, each backing a real exit-0 command.
    expect(evidence).toHaveLength(4);
    for (const item of evidence) {
      expect(item.kind).toBe('command');
      expect(item.status).toBe('verified');
      expect(item.exitCode).toBe(0);
    }
    // Each check references its evidence item by id.
    for (const check of result.checks) {
      expect(check.evidenceId).toBeDefined();
      expect(evidence.some((e) => e.id === check.evidenceId)).toBe(true);
    }
  });

  it('fails the gate when a required command exits non-zero', async () => {
    const config = baseConfig({
      commands: { typecheck: 'exit 0', lint: 'exit 0', build: 'exit 0', test: 'exit 1' },
    });
    const { result, evidence } = await runQualityGate(tmp, config, baseGraph());

    expect(result.passed).toBe(false);
    const testCheck = result.checks.find((c) => c.name === 'test');
    expect(testCheck?.passed).toBe(false);
    expect(result.checks.filter((c) => c.passed)).toHaveLength(3);

    const testEvidence = evidence.find((e) => e.id === testCheck?.evidenceId);
    expect(testEvidence?.status).toBe('refuted');
    expect(testEvidence?.exitCode).toBe(1);
  });

  it('skips disabled gates entirely', async () => {
    const config = baseConfig({
      gates: { typecheck: true, lint: false, build: true, test: true, blockUnprovenDone: true },
      // lint command present but should be ignored because the gate is disabled.
      commands: { typecheck: 'exit 0', lint: 'exit 1', build: 'exit 0', test: 'exit 0' },
    });
    const { result } = await runQualityGate(tmp, config, baseGraph());

    expect(result.checks.some((c) => c.name === 'lint')).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(result.passed).toBe(true);
  });

  it('produces no check for an enabled-but-unconfigured gate (no command to run)', async () => {
    const config = baseConfig({
      // typecheck enabled but no command configured.
      commands: { lint: 'exit 0', build: 'exit 0', test: 'exit 0' },
    });
    const { result, evidence } = await runQualityGate(tmp, config, baseGraph());

    expect(result.checks.some((c) => c.name === 'typecheck')).toBe(false);
    expect(result.checks).toHaveLength(3);
    expect(evidence).toHaveLength(3);
    expect(result.passed).toBe(true);
  });
});

// --- runQualityGate: soft route + env checks --------------------------------

describe('runQualityGate — soft route + env checks', () => {
  it('adds soft checks that do not affect the required gate verdict', async () => {
    await touch('app/dashboard/page.tsx');
    const routes: RouteNode[] = [
      { routePath: '/dashboard', file: 'app/dashboard/page.tsx', kind: 'page' },
      { routePath: '/ghost', file: 'app/ghost/page.tsx', kind: 'page' }, // missing on disk
    ];
    const envVars: EnvVar[] = [
      { name: 'DATABASE_URL', usedIn: ['lib/db.ts'], documented: true },
      { name: 'SECRET_KEY', usedIn: ['lib/auth.ts'], documented: false },
    ];
    const config = baseConfig({ commands: { build: 'exit 0' }, gates: { typecheck: false, lint: false, build: true, test: false, blockUnprovenDone: true } });

    const { result, evidence } = await runQualityGate(tmp, config, baseGraph(routes, envVars));

    // 1 required (build) + 2 routes + 2 env = 5 checks / 5 evidence.
    expect(result.checks).toHaveLength(5);
    expect(evidence).toHaveLength(5);

    const dashboard = result.checks.find((c) => c.name === 'route:/dashboard');
    const ghost = result.checks.find((c) => c.name === 'route:/ghost');
    expect(dashboard?.passed).toBe(true);
    expect(ghost?.passed).toBe(false);

    const documented = result.checks.find((c) => c.name === 'env:DATABASE_URL');
    const undocumented = result.checks.find((c) => c.name === 'env:SECRET_KEY');
    expect(documented?.passed).toBe(true);
    expect(undocumented?.passed).toBe(false);

    // Required build check passed, so the gate passes despite soft failures.
    expect(result.passed).toBe(true);

    const ghostEvidence = evidence.find((e) => e.id === ghost?.evidenceId);
    expect(ghostEvidence?.kind).toBe('file');
    expect(ghostEvidence?.status).toBe('refuted');
    const envEvidence = evidence.find((e) => e.id === undocumented?.evidenceId);
    expect(envEvidence?.kind).toBe('env');
    expect(envEvidence?.status).toBe('refuted');
  });
});

// --- runQualityGate: input validation ---------------------------------------

describe('runQualityGate — input validation', () => {
  it('throws a DevCortexError on an empty root', async () => {
    await expect(runQualityGate('', baseConfig(), baseGraph())).rejects.toBeInstanceOf(
      DevCortexError,
    );
  });

  it('throws a DevCortexError on a malformed graph', async () => {
    // routes is not an array.
    const bad = { ...baseGraph(), routes: undefined } as unknown as ProjectGraph;
    await expect(runQualityGate(tmp, baseConfig(), bad)).rejects.toBeInstanceOf(DevCortexError);
  });
});

// --- generateShipReport -----------------------------------------------------

describe('generateShipReport', () => {
  it('reports READY when all required checks pass and there are no warnings', async () => {
    await touch('app/home/page.tsx');
    const routes: RouteNode[] = [{ routePath: '/home', file: 'app/home/page.tsx', kind: 'page' }];
    const envVars: EnvVar[] = [{ name: 'NEXT_PUBLIC_URL', usedIn: ['app/home/page.tsx'], documented: true }];
    const config = baseConfig({
      commands: { typecheck: 'exit 0', lint: 'exit 0', build: 'exit 0', test: 'exit 0' },
    });
    const ledger = new EvidenceLedger(tmp);
    const report = await generateShipReport(tmp, config, baseGraph(routes, envVars), {
      evidence: ledger,
    });

    expect(report.status).toBe('READY');
    expect(report.blocked).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
    expect(report.suggestedPrompt).toBeUndefined();
    expect(report.passed.length).toBe(6); // 4 commands + 1 route + 1 env

    // Every evidence item was persisted, and ids agree with the ledger.
    expect(report.evidenceIds).toHaveLength(6);
    const persisted = await ledger.all();
    expect(persisted).toHaveLength(6);
    const persistedIds = new Set(persisted.map((e) => e.id));
    for (const id of report.evidenceIds) expect(persistedIds.has(id)).toBe(true);
    // Each passed check's evidenceId resolves to a real ledger entry.
    for (const check of report.passed) {
      expect(check.evidenceId).toBeDefined();
      expect(await ledger.get(check.evidenceId as string)).toBeDefined();
    }
  });

  it('reports NOT_READY and a suggestedPrompt when a required check fails', async () => {
    const config = baseConfig({
      commands: { typecheck: 'exit 0', lint: 'exit 0', build: 'exit 1', test: 'exit 0' },
    });
    const ledger = new EvidenceLedger(tmp);
    const report = await generateShipReport(tmp, config, baseGraph(), { evidence: ledger });

    expect(report.status).toBe('NOT_READY');
    expect(report.blocked.map((c) => c.name)).toContain('build');
    expect(report.suggestedPrompt).toBeDefined();
    expect(report.suggestedPrompt).toContain('NOT_READY');
    expect(report.suggestedPrompt).toContain('build');

    // Even a failed (refuted) command produces evidence that is recorded.
    expect(report.evidenceIds.length).toBeGreaterThan(0);
    expect(await ledger.all()).toHaveLength(report.evidenceIds.length);
  });

  it('reports READY_WITH_WARNINGS when required pass but a soft check fails', async () => {
    const routes: RouteNode[] = [
      { routePath: '/broken', file: 'app/broken/page.tsx', kind: 'page' }, // missing
    ];
    const config = baseConfig({
      commands: { typecheck: 'exit 0', lint: 'exit 0', build: 'exit 0', test: 'exit 0' },
    });
    const ledger = new EvidenceLedger(tmp);
    const report = await generateShipReport(tmp, config, baseGraph(routes), { evidence: ledger });

    expect(report.status).toBe('READY_WITH_WARNINGS');
    expect(report.blocked).toHaveLength(0);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes('/broken'))).toBe(true);
    expect(report.suggestedPrompt).toBeDefined();
    expect(report.suggestedPrompt).toContain('READY_WITH_WARNINGS');
  });

  it('warns about an enabled-but-unconfigured gate', async () => {
    const config = baseConfig({
      // typecheck enabled, no command -> warning note; others pass.
      commands: { lint: 'exit 0', build: 'exit 0', test: 'exit 0' },
    });
    const ledger = new EvidenceLedger(tmp);
    const report = await generateShipReport(tmp, config, baseGraph(), { evidence: ledger });

    expect(report.status).toBe('READY_WITH_WARNINGS');
    expect(report.warnings.some((w) => w.includes('typecheck gate is enabled'))).toBe(true);
    expect(report.suggestedPrompt).toBeDefined();
  });

  it('persists a markdown ship report under .cortex/ship-reports/', async () => {
    const config = baseConfig({
      commands: { typecheck: 'exit 0', lint: 'exit 0', build: 'exit 0', test: 'exit 1' },
    });
    const ledger = new EvidenceLedger(tmp);
    const report = await generateShipReport(tmp, config, baseGraph(), { evidence: ledger });

    const dir = workspacePaths(tmp).shipReportsDir;
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const first = files[0];
    expect(first).toBeDefined();
    expect(first?.endsWith('.md')).toBe(true);

    const md = await readFile(path.join(dir, first as string), 'utf8');
    expect(md).toContain('# DevCortex Ship Report');
    expect(md).toContain(`**Status:** ${report.status}`);
    expect(md).toContain('## Blocked (required failures)');
    expect(md).toContain('## Suggested next prompt');
    // The blocked test check is rendered in the report body.
    expect(md).toContain('test');
  });

  it('throws a DevCortexError when the ledger bundle has no EvidenceLedger', async () => {
    const config = baseConfig({ commands: { build: 'exit 0' } });
    await expect(
      // @ts-expect-error — exercising the runtime guard with an invalid bundle
      generateShipReport(tmp, config, baseGraph(), {}),
    ).rejects.toBeInstanceOf(DevCortexError);
  });
});
