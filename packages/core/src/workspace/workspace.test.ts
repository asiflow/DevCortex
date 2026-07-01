/**
 * Workspace tests — real filesystem round-trips against a freshly mkdtemp'd repo
 * root. No mocks: config + graph are written as real YAML/JSON on disk and read
 * back through the production zod-validated paths. Error branches (missing file,
 * unreadable path, malformed payload, schema-invalid payload, unwritable target)
 * are each driven by a concrete on-disk condition.
 */
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, SchemaValidationError, isDevCortexError } from '../domain/index';
import { CortexConfigSchema, ProjectGraphSchema } from '../domain/index';
import type { CortexConfig, DetectedStack, ProjectGraph, WorkspaceError } from '../domain/index';

import {
  CONFIG_SCHEMA_VERSION,
  defaultConfig,
  loadConfig,
  saveConfig,
} from './config';
import { loadGraph, saveGraph } from './graph-store';
import { initWorkspace, isInitialized } from './init';
import { workspacePaths } from './paths';

// --- fixtures ----------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-workspace-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sampleStack: DetectedStack = {
  framework: 'nextjs',
  language: 'typescript',
  packageManager: 'pnpm',
  frameworkVersion: '15.0.0',
  monorepo: false,
  deploymentTargets: ['vercel'],
};

function sampleGraph(overrides: Partial<ProjectGraph> = {}): ProjectGraph {
  return {
    schemaVersion: 1,
    root,
    generatedAt: '2026-06-30T00:00:00.000Z',
    stack: sampleStack,
    files: [
      {
        path: 'src/auth/jwt.ts',
        kind: 'auth',
        imports: ['jsonwebtoken'],
        importedBy: ['src/middleware.ts'],
        symbols: ['verify'],
        risky: true,
        tags: ['auth'],
      },
    ],
    routes: [{ routePath: '/api/health', file: 'src/app/api/health/route.ts', kind: 'api' }],
    envVars: [{ name: 'JWT_PUBLIC_KEY', usedIn: ['src/auth/jwt.ts'], documented: true }],
    scripts: { build: 'tsc -p .', test: 'vitest run' },
    riskyFiles: ['src/auth/jwt.ts'],
    stats: { fileCount: 1, routeCount: 1, apiCount: 1, testCount: 0, riskyCount: 1 },
    ...overrides,
  };
}

// --- defaultConfig -----------------------------------------------------------

describe('defaultConfig', () => {
  it('produces a config that validates against CortexConfigSchema', () => {
    const config = defaultConfig();
    expect(CortexConfigSchema.safeParse(config).success).toBe(true);
  });

  it('uses conservative, fail-safe defaults', () => {
    const config = defaultConfig();
    expect(config.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(config.mode).toBe('passive');
    expect(config.privacy).toBe('local-only');
    expect(config.gates).toEqual({
      typecheck: true,
      lint: true,
      build: true,
      test: true,
      blockUnprovenDone: true,
    });
    expect(config.commands).toEqual({});
    expect(config.stackPacks).toEqual([]);
  });

  it('floors the security-sensitive task types to at least high', () => {
    const { floors } = defaultConfig().risk;
    for (const taskType of ['auth', 'billing', 'database', 'security', 'devops'] as const) {
      expect(floors[taskType]).toBe('high');
    }
  });

  it('seeds a non-empty protected-paths list', () => {
    const { protectedPaths } = defaultConfig().risk;
    expect(protectedPaths.length).toBeGreaterThan(0);
    expect(protectedPaths).toContain('**/.env');
  });

  it('ignores the reserved stack argument without altering defaults', () => {
    expect(defaultConfig(sampleStack)).toEqual(defaultConfig());
  });

  it('returns a fresh protectedPaths array each call (no shared mutable state)', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a.risk.protectedPaths).not.toBe(b.risk.protectedPaths);
    a.risk.protectedPaths.push('**/leak/**');
    expect(b.risk.protectedPaths).not.toContain('**/leak/**');
  });
});

// --- saveConfig / loadConfig -------------------------------------------------

describe('saveConfig + loadConfig', () => {
  it('round-trips a config through disk', async () => {
    const config = defaultConfig();
    await saveConfig(root, config);
    expect(await loadConfig(root)).toEqual(config);
  });

  it('writes a managed-file banner and creates the .cortex directory', async () => {
    await saveConfig(root, defaultConfig());
    const raw = await readFile(workspacePaths(root).config, 'utf8');
    expect(raw.startsWith('# DevCortex workspace config')).toBe(true);
    expect(raw).toContain('CortexConfigSchema');
  });

  it('persists edits made to the config', async () => {
    const config: CortexConfig = {
      ...defaultConfig(),
      mode: 'guarded',
      commands: { typecheck: 'tsc --noEmit', test: 'vitest run' },
    };
    await saveConfig(root, config);
    const loaded = await loadConfig(root);
    expect(loaded.mode).toBe('guarded');
    expect(loaded.commands).toEqual({ typecheck: 'tsc --noEmit', test: 'vitest run' });
  });

  it('throws CONFIG_NOT_FOUND when no config exists', async () => {
    await expect(loadConfig(root)).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
    await loadConfig(root).catch((err: unknown) => {
      expect(isDevCortexError(err)).toBe(true);
    });
  });

  it('throws ConfigError (CONFIG_INVALID) on unparseable YAML', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.cortexDir, { recursive: true });
    await writeFile(paths.config, 'mode: [unterminated', 'utf8');
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(root)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('throws ConfigError (CONFIG_INVALID) on valid YAML that fails the schema', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.cortexDir, { recursive: true });
    await writeFile(paths.config, 'schemaVersion: 1\nmode: not-a-mode\n', 'utf8');
    const err = await loadConfig(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).details).toBeDefined();
  });

  it('throws ConfigError when the config path cannot be read (not ENOENT)', async () => {
    const paths = workspacePaths(root);
    // Make the config path a directory so readFile fails with EISDIR.
    await mkdir(paths.config, { recursive: true });
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigError);
  });

  it('refuses to write an invalid config and never touches disk', async () => {
    const bad = { ...defaultConfig(), mode: 'nope' } as unknown as CortexConfig;
    await expect(saveConfig(root, bad)).rejects.toBeInstanceOf(ConfigError);
    await expect(loadConfig(root)).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });

  it('throws ConfigError when the config cannot be written', async () => {
    const paths = workspacePaths(root);
    // Pre-create the config path as a directory so the atomic rename fails.
    await mkdir(paths.config, { recursive: true });
    await expect(saveConfig(root, defaultConfig())).rejects.toBeInstanceOf(ConfigError);
  });

  it('writes atomically and leaves no temp file behind on success', async () => {
    const config: CortexConfig = { ...defaultConfig(), mode: 'autopilot' };
    await saveConfig(root, config);
    expect(await loadConfig(root)).toEqual(config);
    // The atomic write renames its temp file over the target; nothing else lingers.
    const entries = await readdir(workspacePaths(root).cortexDir);
    expect(entries).toEqual(['config.yaml']);
  });

  it('leaves no temp debris when the atomic rename fails', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.config, { recursive: true }); // forces the rename to fail
    await expect(saveConfig(root, defaultConfig())).rejects.toBeInstanceOf(ConfigError);
    // config.yaml is the pre-created directory; no `*.tmp` sibling survived.
    const debris = (await readdir(paths.cortexDir)).filter((name) => name.endsWith('.tmp'));
    expect(debris).toEqual([]);
  });
});

// --- saveGraph / loadGraph ---------------------------------------------------

describe('saveGraph + loadGraph', () => {
  it('returns null when no graph cache exists', async () => {
    expect(await loadGraph(root)).toBeNull();
  });

  it('round-trips a project graph through disk', async () => {
    const graph = sampleGraph();
    await saveGraph(root, graph);
    expect(await loadGraph(root)).toEqual(graph);
  });

  it('writes pretty-printed JSON terminated by a newline', async () => {
    await saveGraph(root, sampleGraph());
    const raw = await readFile(workspacePaths(root).graph, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "schemaVersion": 1');
    // round-trips back through the schema
    expect(ProjectGraphSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  });

  it('throws SchemaValidationError on malformed JSON', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.cortexDir, { recursive: true });
    await writeFile(paths.graph, 'not json {', 'utf8');
    await expect(loadGraph(root)).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(loadGraph(root)).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION' });
  });

  it('throws SchemaValidationError on valid JSON that fails the schema', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.cortexDir, { recursive: true });
    await writeFile(paths.graph, JSON.stringify({ schemaVersion: 1 }), 'utf8');
    const err = await loadGraph(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect((err as SchemaValidationError).details).toBeDefined();
  });

  it('throws SchemaValidationError when the graph path cannot be read (not ENOENT)', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.graph, { recursive: true });
    await expect(loadGraph(root)).rejects.toBeInstanceOf(SchemaValidationError);
  });

  it('refuses to write an invalid graph and leaves no cache behind', async () => {
    const bad = { ...sampleGraph(), stats: { fileCount: 'lots' } } as unknown as ProjectGraph;
    await expect(saveGraph(root, bad)).rejects.toBeInstanceOf(SchemaValidationError);
    expect(await loadGraph(root)).toBeNull();
  });

  it('throws SchemaValidationError when the graph cannot be written', async () => {
    const paths = workspacePaths(root);
    await mkdir(paths.graph, { recursive: true });
    await expect(saveGraph(root, sampleGraph())).rejects.toBeInstanceOf(SchemaValidationError);
  });
});

// --- isInitialized -----------------------------------------------------------

describe('isInitialized', () => {
  it('returns false for a repo with no .cortex directory', async () => {
    expect(await isInitialized(root)).toBe(false);
  });

  it('returns false when a parent path component is a file (ENOTDIR)', async () => {
    // Make `root` itself a file: stat'ing `<root>/.cortex` then fails ENOTDIR.
    const fileRoot = path.join(root, 'not-a-dir');
    await writeFile(fileRoot, 'x', 'utf8');
    expect(await isInitialized(fileRoot)).toBe(false);
  });

  it('returns true once the .cortex directory exists', async () => {
    await mkdir(workspacePaths(root).cortexDir, { recursive: true });
    expect(await isInitialized(root)).toBe(true);
  });
});

// --- initWorkspace -----------------------------------------------------------

describe('initWorkspace', () => {
  /** A fresh opts object with a pre-scanned graph (no real scan needed). */
  function initOpts(
    overrides: Partial<{ mode: CortexConfig['mode']; force: boolean; graph: ProjectGraph }> = {},
  ) {
    return {
      mode: overrides.mode ?? ('guarded' as const),
      stack: sampleStack,
      graph: overrides.graph ?? sampleGraph(),
      ...(overrides.force !== undefined ? { force: overrides.force } : {}),
    };
  }

  it('creates the full .cortex tree and reports every created path', async () => {
    const { created } = await initWorkspace(root, initOpts());
    const paths = workspacePaths(root);

    // Every empty ledger directory exists, is a directory, and is empty.
    for (const dir of [
      paths.memoryDir,
      paths.featuresDir,
      paths.decisionsDir,
      paths.evidenceDir,
      paths.shipReportsDir,
      paths.runsDir,
      paths.cacheDir,
    ]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect(await readdir(dir)).toEqual([]);
      expect(created).toContain(dir);
    }

    // config + graph + the three docs exist on disk and are reported.
    for (const file of [
      paths.config,
      paths.graph,
      paths.projectMd,
      paths.architectureMd,
      paths.qualityConstitution,
    ]) {
      expect((await stat(file)).isFile()).toBe(true);
      expect(created).toContain(file);
    }
    expect(created).toContain(paths.cortexDir);
    expect(await isInitialized(root)).toBe(true);
  });

  it('writes config from defaultConfig(stack) with the requested mode', async () => {
    await initWorkspace(root, initOpts({ mode: 'guarded' }));
    expect(await loadConfig(root)).toEqual({ ...defaultConfig(sampleStack), mode: 'guarded' });
  });

  it('caches the supplied graph verbatim at graph.json', async () => {
    const graph = sampleGraph();
    await initWorkspace(root, initOpts({ graph }));
    expect(await loadGraph(root)).toEqual(graph);
  });

  it('generates real, stack/graph-derived docs the MCP get_* tools read back', async () => {
    await initWorkspace(root, initOpts({ mode: 'guarded' }));
    const paths = workspacePaths(root);
    const project = await readFile(paths.projectMd, 'utf8');
    const architecture = await readFile(paths.architectureMd, 'utf8');
    const quality = await readFile(paths.qualityConstitution, 'utf8');

    // Project brief carries the stack + a real route pulled from the graph.
    expect(project).toContain('# Project Brief');
    expect(project).toContain('nextjs');
    expect(project).toContain('/api/health');

    // Architecture map surfaces the risky auth file + the documented env var.
    expect(architecture).toContain('# Architecture Map');
    expect(architecture).toContain('src/auth/jwt.ts');
    expect(architecture).toContain('JWT_PUBLIC_KEY');

    // Quality constitution reflects the chosen mode + a security risk floor.
    expect(quality).toContain('# Quality Constitution');
    expect(quality).toContain('guarded');
    expect(quality).toContain('auth');
  });

  it('throws WORKSPACE_EXISTS when .cortex already exists and force is not set', async () => {
    await initWorkspace(root, initOpts());
    const err = await initWorkspace(root, initOpts()).catch((e: unknown) => e);
    expect(isDevCortexError(err)).toBe(true);
    expect((err as WorkspaceError).code).toBe('WORKSPACE_EXISTS');
  });

  it('throws WORKSPACE_EXISTS even when only a bare .cortex directory exists', async () => {
    await mkdir(workspacePaths(root).cortexDir, { recursive: true });
    await expect(initWorkspace(root, initOpts())).rejects.toMatchObject({
      code: 'WORKSPACE_EXISTS',
    });
  });

  it('overwrites an existing workspace when force is set', async () => {
    await initWorkspace(root, initOpts({ mode: 'passive' }));
    expect((await loadConfig(root)).mode).toBe('passive');

    const { created } = await initWorkspace(root, initOpts({ mode: 'autopilot', force: true }));
    expect(created.length).toBeGreaterThan(0);
    expect((await loadConfig(root)).mode).toBe('autopilot');
    expect((await loadGraph(root))).not.toBeNull();
  });
});
