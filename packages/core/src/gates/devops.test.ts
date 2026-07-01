import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DevCortexError } from '../domain/index';
import type { CortexConfig, EnvVar, FileKind, FileNode, ProjectGraph } from '../domain/index';

import { diagnoseDocker, diagnoseK8s } from './commander';
import { runDevopsGate } from './devops';

// --- fixtures ---------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'devcortex-devops-'));
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

function baseGraph(
  files: FileNode[] = [],
  envVars: EnvVar[] = [],
  scripts: Record<string, string> = {},
  deploymentTargets: string[] = [],
): ProjectGraph {
  return {
    schemaVersion: 1,
    root: tmp,
    generatedAt: new Date().toISOString(),
    stack: {
      framework: 'node',
      language: 'typescript',
      packageManager: 'pnpm',
      monorepo: false,
      deploymentTargets,
    },
    files,
    routes: [],
    envVars,
    scripts,
    riskyFiles: [],
    stats: { fileCount: files.length, routeCount: 0, apiCount: 0, testCount: 0, riskyCount: 0 },
  };
}

/** Write a real file under the tmp repo so the gate can read it. */
async function seed(relPath: string, content: string): Promise<void> {
  const abs = path.join(tmp, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

// --- root Dockerfile + undocumented env var ---------------------------------

describe('runDevopsGate — flags a root Dockerfile and an undocumented env var', () => {
  it('fails the docker and env-vars checks with backing evidence', async () => {
    // Single-stage image that runs as root and copies the whole context in.
    await seed(
      'Dockerfile',
      [
        'FROM node:latest',
        'WORKDIR /app',
        'COPY . .',
        'RUN npm install',
        'CMD ["node", "server.js"]',
        '',
      ].join('\n'),
    );

    // DATABASE_URL is referenced but there is no .env.example documenting it.
    const graph = baseGraph(
      [fileNode('src/db.ts', 'service')],
      [{ name: 'DATABASE_URL', usedIn: ['src/db.ts'], documented: false }],
    );

    const { result, evidence } = await runDevopsGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('devops');
    expect(result.passed).toBe(false);

    // One evidence item per check, and every check links to a real evidence item.
    expect(evidence).toHaveLength(result.checks.length);
    for (const check of result.checks) {
      expect(check.evidenceId).toBeDefined();
      expect(evidence.some((e) => e.id === check.evidenceId)).toBe(true);
    }

    // Docker check fails on the root user.
    const docker = result.checks.find((c) => c.name === 'docker');
    expect(docker?.passed).toBe(false);
    const dockerEvidence = evidence.find((e) => e.id === docker?.evidenceId);
    expect(dockerEvidence?.status).toBe('refuted');
    expect(dockerEvidence?.detail).toContain('root');

    // Env-vars check fails on the undocumented variable.
    const envVars = result.checks.find((c) => c.name === 'env-vars');
    expect(envVars?.passed).toBe(false);
    const envEvidence = evidence.find((e) => e.id === envVars?.evidenceId);
    expect(envEvidence?.status).toBe('refuted');
    expect(envEvidence?.detail).toContain('DATABASE_URL');
  });
});

// --- clean project passes ---------------------------------------------------

describe('runDevopsGate — a clean project passes the required checks', () => {
  it('passes every required check with a hardened Dockerfile and documented env', async () => {
    await seed('.dockerignore', '.env\n.env.*\nnode_modules\n');
    await seed(
      'Dockerfile',
      [
        'FROM node:20-alpine AS build',
        'WORKDIR /app',
        'COPY package.json ./',
        'RUN npm ci',
        '',
        'FROM node:20-alpine AS runtime',
        'WORKDIR /app',
        'COPY --from=build /app ./',
        'USER node',
        'CMD ["node", "server.js"]',
        '',
      ].join('\n'),
    );
    await seed('.env.example', 'DATABASE_URL=\nAPI_TOKEN=\n');

    const graph = baseGraph(
      [fileNode('src/db.ts', 'service')],
      [
        { name: 'DATABASE_URL', usedIn: ['src/db.ts'], documented: true },
        { name: 'API_TOKEN', usedIn: ['src/db.ts'], documented: true },
      ],
    );

    const { result, evidence } = await runDevopsGate(tmp, graph, baseConfig());

    expect(result.gate).toBe('devops');
    expect(result.passed).toBe(true);

    // Required checks all pass.
    const required = ['env-vars', 'docker', 'secrets-exposure', 'k8s-nonroot'];
    for (const name of required) {
      const check = result.checks.find((c) => c.name === name);
      expect(check?.passed, `${name} should pass`).toBe(true);
    }

    // Docker is applicable and clean (verified), env-vars documented (verified).
    const docker = result.checks.find((c) => c.name === 'docker');
    const dockerEvidence = evidence.find((e) => e.id === docker?.evidenceId);
    expect(dockerEvidence?.status).toBe('verified');
    const envVars = result.checks.find((c) => c.name === 'env-vars');
    const envEvidence = evidence.find((e) => e.id === envVars?.evidenceId);
    expect(envEvidence?.status).toBe('verified');
  });
});

// --- k8s runAsNonRoot -------------------------------------------------------

describe('runDevopsGate — k8s workloads must enforce runAsNonRoot', () => {
  it('fails k8s-nonroot for a Deployment without a securityContext', async () => {
    await seed(
      'k8s/deploy.yaml',
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: api',
        'spec:',
        '  replicas: 2',
        '  template:',
        '    spec:',
        '      containers:',
        '        - name: api',
        '          image: registry.example.com/api:1.2.3',
        '',
      ].join('\n'),
    );

    const graph = baseGraph([], [], {}, ['kubernetes']);
    const { result, evidence } = await runDevopsGate(tmp, graph, baseConfig());

    const k8s = result.checks.find((c) => c.name === 'k8s-nonroot');
    expect(k8s?.passed).toBe(false);
    const k8sEvidence = evidence.find((e) => e.id === k8s?.evidenceId);
    expect(k8sEvidence?.status).toBe('refuted');
    expect(k8sEvidence?.detail).toContain('Deployment/api');
    expect(k8sEvidence?.detail).toContain('runAsNonRoot');
    expect(result.passed).toBe(false);
  });

  it('passes k8s-nonroot for a Deployment that enforces runAsNonRoot', async () => {
    await seed(
      'k8s/deploy.yaml',
      [
        'apiVersion: apps/v1',
        'kind: Deployment',
        'metadata:',
        '  name: api',
        'spec:',
        '  template:',
        '    spec:',
        '      securityContext:',
        '        runAsNonRoot: true',
        '        runAsUser: 1000',
        '      containers:',
        '        - name: api',
        '          image: registry.example.com/api:1.2.3',
        '',
      ].join('\n'),
    );

    const graph = baseGraph([], [], {}, ['kubernetes']);
    const { result } = await runDevopsGate(tmp, graph, baseConfig());

    const k8s = result.checks.find((c) => c.name === 'k8s-nonroot');
    expect(k8s?.passed).toBe(true);
  });
});

// --- commander diagnostics stand alone --------------------------------------

describe('DevOps Commander — diagnostics are independently callable', () => {
  it('diagnoseDocker flags a secret COPY into the image', async () => {
    await seed(
      'Dockerfile',
      ['FROM node:20-alpine', 'WORKDIR /app', 'COPY .env.production ./', 'USER node', ''].join('\n'),
    );

    const diag = await diagnoseDocker(tmp);
    expect(diag.applicable).toBe(true);
    expect(diag.ok).toBe(false);
    expect(diag.findings.some((f) => f.severity === 'error' && /secret-bearing/.test(f.message))).toBe(
      true,
    );
  });

  it('diagnoseK8s is not applicable when there are no manifests', async () => {
    const diag = await diagnoseK8s(tmp);
    expect(diag.applicable).toBe(false);
    expect(diag.ok).toBe(true);
  });
});

// --- input validation of the gate itself ------------------------------------

describe('runDevopsGate — input validation', () => {
  it('throws a DevCortexError on an empty root', async () => {
    await expect(runDevopsGate('', baseGraph(), baseConfig())).rejects.toBeInstanceOf(DevCortexError);
  });

  it('throws a DevCortexError on a malformed graph', async () => {
    const bad = { ...baseGraph(), files: undefined } as unknown as ProjectGraph;
    await expect(runDevopsGate(tmp, bad, baseConfig())).rejects.toBeInstanceOf(DevCortexError);
  });
});
