/**
 * Safe MCP Manager tests (§7.19).
 *
 * Deterministic, no mocks: the catalog + recommender are pure, and every
 * persistence test runs against a freshly mkdtemp'd repo root whose `.mcp.json`
 * and `.cortex/mcp/<id>.json` are read back from disk and re-validated with the
 * owning zod schema.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { McpServerSpecSchema, PolicyViolationError, isDevCortexError } from '../domain/index';
import type {
  DetectedStack,
  FileNode,
  Framework,
  Language,
  PackageManager,
  ProjectGraph,
} from '../domain/index';
import { defaultPolicy, savePolicy } from '../mcp-firewall/index';

import {
  auditMcp,
  installMcpSafely,
  listMcp,
  mcpCatalog,
  mcpJsonPath,
  mcpSpecPath,
  recommendMcp,
} from './index';

// --- fixtures ----------------------------------------------------------------

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-mcp-manager-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface GraphKnobs {
  framework?: Framework;
  language?: Language;
  packageManager?: PackageManager;
  deploymentTargets?: string[];
  envVars?: string[];
  scripts?: Record<string, string>;
  files?: Array<{ path: string; tags?: string[] }>;
}

function makeGraph(knobs: GraphKnobs = {}): ProjectGraph {
  const stack: DetectedStack = {
    framework: knobs.framework ?? 'unknown',
    language: knobs.language ?? 'unknown',
    packageManager: knobs.packageManager ?? 'unknown',
    monorepo: false,
    deploymentTargets: knobs.deploymentTargets ?? [],
  };
  const files: FileNode[] = (knobs.files ?? []).map((file) => ({
    path: file.path,
    kind: 'other',
    imports: [],
    importedBy: [],
    symbols: [],
    risky: false,
    tags: file.tags ?? [],
  }));
  return {
    schemaVersion: 1,
    root: '/repo',
    generatedAt: '2026-07-01T00:00:00.000Z',
    stack,
    files,
    routes: [],
    envVars: (knobs.envVars ?? []).map((name) => ({ name, usedIn: [], documented: false })),
    scripts: knobs.scripts ?? {},
    riskyFiles: [],
    stats: { fileCount: files.length, routeCount: 0, apiCount: 0, testCount: 0, riskyCount: 0 },
  };
}

const REQUIRED_IDS = [
  'filesystem',
  'github',
  'playwright',
  'postgres',
  'stripe-docs',
  'vercel',
  'docker',
  'cloud-logs',
] as const;

async function readMcpFile(repo: string): Promise<{
  mcpServers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}> {
  const raw = await readFile(mcpJsonPath(repo), 'utf8');
  return JSON.parse(raw) as { mcpServers: Record<string, Record<string, unknown>> };
}

// --- catalog integrity -------------------------------------------------------

describe('mcpCatalog', () => {
  it('curates at least 8 servers', () => {
    expect(mcpCatalog.length).toBeGreaterThanOrEqual(8);
  });

  it('has unique ids', () => {
    const ids = mcpCatalog.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes every required well-known server', () => {
    const ids = new Set(mcpCatalog.map((spec) => spec.id));
    for (const id of REQUIRED_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('validates every entry against the persisted-artifact schema', () => {
    for (const spec of mcpCatalog) {
      const result = McpServerSpecSchema.safeParse(spec);
      expect(result.success, `${spec.id} failed schema`).toBe(true);
    }
  });

  it('gives every server at least one tool and honest read/write markers', () => {
    for (const spec of mcpCatalog) {
      expect(spec.tools.length, `${spec.id} has no tools`).toBeGreaterThan(0);
      for (const tool of spec.tools) {
        expect(['read', 'write']).toContain(tool.access);
        // A read tool must never be flagged destructive (destructive implies mutation).
        if (tool.access === 'read') {
          expect(tool.destructive, `${spec.id}.${tool.name} read+destructive`).toBe(false);
        }
      }
    }
  });

  it('curates only trusted/community sources (unknown is a runtime-only state)', () => {
    for (const spec of mcpCatalog) {
      expect(['trusted', 'community']).toContain(spec.trust);
    }
  });

  it('never lists secret VALUES — secretsRequired holds env-var NAMES only', () => {
    for (const spec of mcpCatalog) {
      for (const name of spec.secretsRequired) {
        expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/u);
      }
    }
  });
});

// --- recommend ---------------------------------------------------------------

describe('recommendMcp', () => {
  it('ranks stripe-docs first for a billing task on a stripe repo', () => {
    const graph = makeGraph({ envVars: ['STRIPE_SECRET_KEY'] });
    const ranked = recommendMcp('add stripe billing and subscription webhooks', graph);
    expect(ranked[0]?.id).toBe('stripe-docs');
  });

  it('recommends playwright first for a browser e2e task', () => {
    const ranked = recommendMcp('write an e2e browser test that clicks a button and screenshots', makeGraph());
    expect(ranked[0]?.id).toBe('playwright');
  });

  it('recommends vercel for a nextjs repo deploying to vercel', () => {
    const graph = makeGraph({ framework: 'nextjs', deploymentTargets: ['vercel'] });
    const ranked = recommendMcp('deploy to production', graph);
    expect(ranked[0]?.id).toBe('vercel');
  });

  it('surfaces the universal staples for an empty task on a bare repo', () => {
    const ranked = recommendMcp('', makeGraph());
    const ids = ranked.map((spec) => spec.id);
    expect(ids).toContain('git');
    expect(ids).toContain('filesystem');
  });

  it('picks up the docker server from a Dockerfile in the graph', () => {
    const graph = makeGraph({ files: [{ path: 'Dockerfile' }] });
    const ranked = recommendMcp('containerize the service', graph);
    expect(ranked.map((spec) => spec.id)).toContain('docker');
  });

  it('is deterministic for identical inputs', () => {
    const graph = makeGraph({ envVars: ['DATABASE_URL'] });
    const a = recommendMcp('run a database migration query', graph);
    const b = recommendMcp('run a database migration query', graph);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
    expect(a.map((s) => s.id)).toContain('postgres');
  });
});

// --- listMcp -----------------------------------------------------------------

describe('listMcp', () => {
  it('reports nothing installed and the full catalog as recommended on a fresh repo', async () => {
    const { installed, recommended } = await listMcp(root);
    expect(installed).toEqual([]);
    expect(recommended.length).toBe(mcpCatalog.length);
    expect(recommended.map((spec) => spec.id)).toEqual(
      expect.arrayContaining(['filesystem', 'github']),
    );
  });

  it('moves an installed server out of the recommended set', async () => {
    await installMcpSafely(root, 'filesystem', {});
    const { installed, recommended } = await listMcp(root);
    expect(installed.map((spec) => spec.id)).toContain('filesystem');
    expect(recommended.map((spec) => spec.id)).not.toContain('filesystem');
  });
});

// --- installMcpSafely --------------------------------------------------------

describe('installMcpSafely', () => {
  it('writes a read-only .mcp.json entry and records the spec', async () => {
    const result = await installMcpSafely(root, 'filesystem', {});
    expect(result.status).toBe('installed');

    const json = await readMcpFile(root);
    const entry = json.mcpServers['filesystem'];
    expect(entry).toBeDefined();
    expect(entry?.['command']).toBe('npx');
    const annotation = entry?.['devcortex'] as Record<string, unknown>;
    expect(annotation['posture']).toBe('read-only');
    expect(annotation['autoApprove']).toContain('filesystem.read_file');
    expect(annotation['requireApproval']).toContain('filesystem.write_file');

    const specRaw = await readFile(mcpSpecPath(root, 'filesystem'), 'utf8');
    const spec = JSON.parse(specRaw);
    expect(spec.id).toBe('filesystem');
    expect(McpServerSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('writes empty env placeholders, never secret values', async () => {
    await installMcpSafely(root, 'github', {});
    const json = await readMcpFile(root);
    const env = json.mcpServers['github']?.['env'] as Record<string, string>;
    expect(env['GITHUB_PERSONAL_ACCESS_TOKEN']).toBe('');
  });

  it('confirms before overwrite: a second install without force writes nothing', async () => {
    await installMcpSafely(root, 'filesystem', {});
    const before = await readFile(mcpJsonPath(root), 'utf8');

    const result = await installMcpSafely(root, 'filesystem', {});
    expect(result.status).toBe('exists');
    expect(result.plan.wouldOverwrite).toBe(true);

    const after = await readFile(mcpJsonPath(root), 'utf8');
    expect(after).toBe(before);
  });

  it('overwrites when force is set', async () => {
    await installMcpSafely(root, 'filesystem', {});
    const result = await installMcpSafely(root, 'filesystem', { force: true });
    expect(result.status).toBe('updated');
  });

  it('preserves foreign servers and foreign top-level keys', async () => {
    await writeFile(
      mcpJsonPath(root),
      `${JSON.stringify(
        { $schema: 'https://example/schema', mcpServers: { custom: { command: 'node', args: ['server.js'] } } },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await installMcpSafely(root, 'git', {});
    const json = await readMcpFile(root);
    expect(json['$schema']).toBe('https://example/schema');
    expect(json.mcpServers['custom']?.['command']).toBe('node');
    expect(json.mcpServers['git']).toBeDefined();
  });

  it('refuses unknown ids with a PolicyViolationError', async () => {
    await expect(installMcpSafely(root, 'definitely-not-real', {})).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
    const err = await installMcpSafely(root, 'definitely-not-real', {}).catch((e: unknown) => e);
    expect(isDevCortexError(err) && err.code).toBe('POLICY_VIOLATION');
  });
});

// --- auditMcp ----------------------------------------------------------------

describe('auditMcp', () => {
  it('returns no findings for a repo with no MCP servers', async () => {
    const { findings } = await auditMcp(root);
    expect(findings).toEqual([]);
  });

  it('flags a write/destructive/secret-requiring server', async () => {
    await installMcpSafely(root, 'github', {});
    const { findings } = await auditMcp(root);
    const joined = findings.join('\n');

    expect(joined).toContain('github');
    expect(findings.some((f) => f.startsWith('[secrets]'))).toBe(true);
    expect(
      findings.some((f) => f.startsWith('[write]') || f.startsWith('[destructive]')),
    ).toBe(true);
  });

  it('flags an ungoverned, unknown-trust server wired in by hand', async () => {
    await writeFile(
      mcpJsonPath(root),
      `${JSON.stringify(
        { mcpServers: { mystery: { command: 'node', args: ['x.js'], env: { SECRET_KEY: '' } } } },
        null,
        2,
      )}\n`,
      'utf8',
    );
    const { findings } = await auditMcp(root);
    expect(findings.some((f) => f.startsWith('[unknown-trust]') && f.includes('mystery'))).toBe(true);
  });

  it('flags a policy gap when the firewall would allow a write tool', async () => {
    await installMcpSafely(root, 'github', {});
    await savePolicy(root, { ...defaultPolicy(), allow: ['*'] });
    const { findings } = await auditMcp(root);
    expect(findings.some((f) => f.startsWith('[policy-gap]'))).toBe(true);
  });
});
