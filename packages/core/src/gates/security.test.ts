import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DevCortexError } from '../domain/index';
import type { CortexConfig, EnvVar, FileKind, FileNode, ProjectGraph } from '../domain/index';

import { runSecurityGate } from './security';

// --- fixtures ---------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-security-'));
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

function fileNode(relPath: string, kind: FileKind, tags: string[] = []): FileNode {
  return { path: relPath, kind, imports: [], importedBy: [], symbols: [], risky: false, tags };
}

function baseGraph(files: FileNode[] = [], envVars: EnvVar[] = []): ProjectGraph {
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
    files,
    routes: [],
    envVars,
    scripts: {},
    riskyFiles: [],
    stats: {
      fileCount: files.length,
      routeCount: 0,
      apiCount: 0,
      testCount: 0,
      riskyCount: 0,
    },
  };
}

/** Write a real file under the tmp repo so the gate can read it. */
async function seed(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmp, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// A fake AWS access key id (AK' + 'IA + 16 uppercase alnum) — never a real secret.
const FAKE_AWS_KEY = 'AK' + 'IA1234567890ABCDEF';

// --- hardcoded secret + unverified webhook ----------------------------------

describe('runSecurityGate — flags a hardcoded secret and an unverified webhook', () => {
  it('fails the secrets and webhook-signature checks with backing evidence', async () => {
    await seed(
      'src/config/keys.ts',
      `export const config = {\n  awsAccessKeyId: '${FAKE_AWS_KEY}',\n};\n`,
    );
    await seed(
      'app/api/webhooks/stripe/route.ts',
      [
        'export async function POST(req: Request) {',
        '  const event = await req.json();',
        '  await handleEvent(event);',
        "  return new Response('ok');",
        '}',
        '',
      ].join('\n'),
    );

    const graph = baseGraph([
      fileNode('src/config/keys.ts', 'config'),
      fileNode('app/api/webhooks/stripe/route.ts', 'api', ['webhook', 'stripe']),
    ]);

    const { result, evidence } = await runSecurityGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('security');
    expect(result.passed).toBe(false);

    // One evidence item per check, and every check links to a real evidence item.
    expect(evidence).toHaveLength(result.checks.length);
    for (const check of result.checks) {
      expect(check.evidenceId).toBeDefined();
      expect(evidence.some((e) => e.id === check.evidenceId)).toBe(true);
    }

    const secrets = result.checks.find((c) => c.name === 'secrets');
    expect(secrets?.passed).toBe(false);
    const secretsEvidence = evidence.find((e) => e.id === secrets?.evidenceId);
    expect(secretsEvidence?.status).toBe('refuted');
    expect(secretsEvidence?.detail).toContain('src/config/keys.ts');
    expect(secretsEvidence?.detail).toContain('AWS access key id');
    // The secret value itself is NEVER echoed into evidence.
    expect(secretsEvidence?.detail).not.toContain(FAKE_AWS_KEY);

    const webhook = result.checks.find((c) => c.name === 'webhook-signature');
    expect(webhook?.passed).toBe(false);
    const webhookEvidence = evidence.find((e) => e.id === webhook?.evidenceId);
    expect(webhookEvidence?.status).toBe('refuted');
    expect(webhookEvidence?.detail).toContain('app/api/webhooks/stripe/route.ts');
  });
});

// --- clean project passes ---------------------------------------------------

describe('runSecurityGate — a clean project passes', () => {
  it('passes every required check when no source defect is present', async () => {
    await seed(
      'src/lib/format.ts',
      'export function titleCase(value: string): string {\n  return value.replace(/\\b\\w/g, (c) => c.toUpperCase());\n}\n',
    );

    const graph = baseGraph(
      [fileNode('src/lib/format.ts', 'lib')],
      [{ name: 'NEXT_PUBLIC_SITE_URL', usedIn: ['src/lib/format.ts'], documented: true }],
    );

    const { result, evidence } = await runSecurityGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('security');
    expect(result.passed).toBe(true);

    // Every REQUIRED heuristic check passed.
    const required = result.checks.filter((c) => c.name !== 'dependency-audit');
    expect(required.every((c) => c.passed)).toBe(true);
    // The passing checks are backed by `verified` evidence.
    for (const check of required) {
      const item = evidence.find((e) => e.id === check.evidenceId);
      expect(item?.status).toBe('verified');
    }

    // The advisory dependency-audit is present, soft (no lockfile in tmp), and non-blocking.
    const audit = result.checks.find((c) => c.name === 'dependency-audit');
    expect(audit).toBeDefined();
    expect(audit?.passed).toBe(true);
    const auditEvidence = evidence.find((e) => e.id === audit?.evidenceId);
    expect(auditEvidence?.status).toBe('unverified');
  });
});

// --- individual detectors ---------------------------------------------------

describe('runSecurityGate — detector coverage', () => {
  it('flags a wildcard Access-Control-Allow-Origin without echoing surrounding code', async () => {
    await seed(
      'src/server/cors.ts',
      "export function apply(res: { setHeader(k: string, v: string): void }) {\n  res.setHeader('Access-Control-Allow-Origin', '*');\n}\n",
    );
    const graph = baseGraph([fileNode('src/server/cors.ts', 'service')]);

    const { result } = await runSecurityGate(tmp, graph, baseConfig());

    const cors = result.checks.find((c) => c.name === 'cors');
    expect(cors?.passed).toBe(false);
    expect(cors?.detail).toContain('src/server/cors.ts');
    expect(result.passed).toBe(false);
  });

  it('flags an api route that reads the body without a schema, but not a validated one', async () => {
    await seed(
      'app/api/users/route.ts',
      'export async function POST(req: Request) {\n  const body = await req.json();\n  return Response.json(body);\n}\n',
    );
    await seed(
      'app/api/safe/route.ts',
      'import { z } from "zod";\nconst UserSchema = z.object({ name: z.string() });\nexport async function POST(req: Request) {\n  const parsed = UserSchema.parse(await req.json());\n  return Response.json(parsed);\n}\n',
    );
    const graph = baseGraph([
      fileNode('app/api/users/route.ts', 'api'),
      fileNode('app/api/safe/route.ts', 'api'),
    ]);

    const { result } = await runSecurityGate(tmp, graph, baseConfig());

    const inputValidation = result.checks.find((c) => c.name === 'input-validation');
    expect(inputValidation?.passed).toBe(false);
    expect(inputValidation?.detail).toContain('app/api/users/route.ts');
    expect(inputValidation?.detail).not.toContain('app/api/safe/route.ts');
  });

  it('flags a NEXT_PUBLIC_ secret env var but not a publishable key', async () => {
    const graph = baseGraph(
      [],
      [
        { name: 'NEXT_PUBLIC_STRIPE_SECRET_KEY', usedIn: ['src/pay.ts'], documented: true },
        { name: 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', usedIn: ['src/pay.ts'], documented: true },
      ],
    );

    const { result } = await runSecurityGate(tmp, graph, baseConfig());

    const check = result.checks.find((c) => c.name === 'client-secret-env');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('NEXT_PUBLIC_STRIPE_SECRET_KEY');
    expect(check?.detail).not.toContain('PUBLISHABLE');
  });
});

// --- input validation of the gate itself ------------------------------------

describe('runSecurityGate — input validation', () => {
  it('throws a DevCortexError on an empty root', async () => {
    await expect(runSecurityGate('', baseGraph(), baseConfig())).rejects.toBeInstanceOf(
      DevCortexError,
    );
  });

  it('throws a DevCortexError on a malformed graph', async () => {
    const bad = { ...baseGraph(), files: undefined } as unknown as ProjectGraph;
    await expect(runSecurityGate(tmp, bad, baseConfig())).rejects.toBeInstanceOf(DevCortexError);
  });
});
