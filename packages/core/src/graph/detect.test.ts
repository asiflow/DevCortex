/**
 * Stack-detection unit tests — drive `detectStack` directly against a real
 * temp-dir repo. Each case writes only the manifest/lockfiles it needs and
 * passes the matching relative file list, so every framework / language /
 * package-manager / deployment-target / monorepo branch is exercised in
 * isolation (no scanProject indirection).
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectStack } from './detect';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'devcortex-detect-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write each file (creating parent dirs) and return the posix relative paths. */
async function setup(files: Record<string, string>): Promise<string[]> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return Object.keys(files);
}

const PKG = (obj: Record<string, unknown>): string => JSON.stringify(obj);

// --- framework ---------------------------------------------------------------

describe('detectStack — framework', () => {
  it('detects Next.js by dependency and cleans the version range', async () => {
    const files = await setup({
      'package.json': PKG({ dependencies: { next: '^15.1.0', react: '18.0.0' } }),
    });
    const { stack } = await detectStack(root, files);
    expect(stack.framework).toBe('nextjs');
    expect(stack.frameworkVersion).toBe('15.1.0');
  });

  it('detects Next.js by config file even without a next dependency', async () => {
    const files = await setup({
      'package.json': PKG({ dependencies: {} }),
      'next.config.mjs': 'export default {};',
    });
    const { stack } = await detectStack(root, files);
    expect(stack.framework).toBe('nextjs');
    expect(stack.frameworkVersion).toBeUndefined();
  });

  it('detects Vite by dependency', async () => {
    const files = await setup({ 'package.json': PKG({ devDependencies: { vite: '~5.4.0' } }) });
    const { stack } = await detectStack(root, files);
    expect(stack.framework).toBe('vite');
    expect(stack.frameworkVersion).toBe('5.4.0');
  });

  it('detects Vite by config file', async () => {
    const files = await setup({
      'package.json': PKG({ dependencies: {} }),
      'vite.config.ts': 'export default {};',
    });
    expect((await detectStack(root, files)).stack.framework).toBe('vite');
  });

  it('detects Express', async () => {
    const files = await setup({ 'package.json': PKG({ dependencies: { express: '4.21.0' } }) });
    const { stack } = await detectStack(root, files);
    expect(stack.framework).toBe('express');
    expect(stack.frameworkVersion).toBe('4.21.0');
  });

  it('detects React (when not Next/Vite/Express)', async () => {
    const files = await setup({ 'package.json': PKG({ dependencies: { react: '>=19.0.0' } }) });
    const { stack } = await detectStack(root, files);
    expect(stack.framework).toBe('react');
    expect(stack.frameworkVersion).toBe('19.0.0');
  });

  it('falls back to node when a package.json has no known framework', async () => {
    const files = await setup({ 'package.json': PKG({ dependencies: { lodash: '4.0.0' } }) });
    expect((await detectStack(root, files)).stack.framework).toBe('node');
  });

  it('detects FastAPI from python manifests when there is no package.json', async () => {
    const files = await setup({
      'requirements.txt': 'fastapi==0.115.0\nuvicorn\n',
    });
    const { stack } = await detectStack(root, files);
    expect(stack.framework).toBe('fastapi');
    expect(stack.language).toBe('python');
  });

  it('falls back to node when there is neither a package.json nor fastapi', async () => {
    const files = await setup({ 'main.py': 'print("hi")' });
    expect((await detectStack(root, files)).stack.framework).toBe('node');
  });

  it('treats a malformed package.json as absent', async () => {
    const files = await setup({ 'package.json': '{ not valid json' });
    // no framework deps readable -> python manifest absent -> node
    expect((await detectStack(root, files)).stack.framework).toBe('node');
  });
});

// --- language ----------------------------------------------------------------

describe('detectStack — language', () => {
  it('detects TypeScript via tsconfig.json', async () => {
    const files = await setup({ 'tsconfig.json': '{}', 'package.json': PKG({}) });
    expect((await detectStack(root, files)).stack.language).toBe('typescript');
  });

  it('detects TypeScript via .ts files but ignores .d.ts-only', async () => {
    const tsOnly = await detectStack(root, await setup({ 'src/a.ts': '' }));
    expect(tsOnly.stack.language).toBe('typescript');
  });

  it('does not treat a lone .d.ts file as TypeScript source', async () => {
    const files = await setup({ 'types/global.d.ts': '', 'src/a.js': '' });
    expect((await detectStack(root, files)).stack.language).toBe('javascript');
  });

  it('detects JavaScript via .mjs files', async () => {
    expect((await detectStack(root, await setup({ 'index.mjs': '' }))).stack.language).toBe(
      'javascript',
    );
  });

  it('detects Python via .py files', async () => {
    expect((await detectStack(root, await setup({ 'app/main.py': '' }))).stack.language).toBe(
      'python',
    );
  });

  it('detects Go via go.mod', async () => {
    expect((await detectStack(root, await setup({ 'go.mod': 'module x' }))).stack.language).toBe(
      'go',
    );
  });

  it('detects Go via .go files', async () => {
    expect((await detectStack(root, await setup({ 'cmd/main.go': '' }))).stack.language).toBe('go');
  });

  it('returns unknown when no language signal is present', async () => {
    expect((await detectStack(root, await setup({ 'README.md': '#' }))).stack.language).toBe(
      'unknown',
    );
  });
});

// --- package manager ---------------------------------------------------------

describe('detectStack — package manager', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['pnpm', { 'pnpm-lock.yaml': '' }, 'pnpm'],
    ['yarn', { 'yarn.lock': '' }, 'yarn'],
    ['bun (lockb)', { 'bun.lockb': '' }, 'bun'],
    ['bun (lock)', { 'bun.lock': '' }, 'bun'],
    ['npm', { 'package-lock.json': '{}' }, 'npm'],
    ['pip via Pipfile.lock', { 'Pipfile.lock': '{}' }, 'pip'],
    ['pip via requirements.txt', { 'requirements.txt': 'flask\n' }, 'pip'],
  ];

  for (const [label, files, expected] of cases) {
    it(`detects ${label}`, async () => {
      expect((await detectStack(root, await setup(files))).stack.packageManager).toBe(expected);
    });
  }

  it('detects poetry via [tool.poetry] in pyproject.toml', async () => {
    const files = await setup({ 'pyproject.toml': '[tool.poetry]\nname = "x"\n' });
    expect((await detectStack(root, files)).stack.packageManager).toBe('poetry');
  });

  it('detects poetry via poetry.lock', async () => {
    const files = await setup({ 'poetry.lock': '', 'pyproject.toml': '[project]\nname="x"\n' });
    expect((await detectStack(root, files)).stack.packageManager).toBe('poetry');
  });

  it('returns unknown when no lockfile or python manifest is present', async () => {
    const files = await setup({ 'package.json': PKG({}) });
    expect((await detectStack(root, files)).stack.packageManager).toBe('unknown');
  });
});

// --- monorepo ----------------------------------------------------------------

describe('detectStack — monorepo', () => {
  it('flags monorepo via pnpm-workspace.yaml', async () => {
    const files = await setup({ 'pnpm-workspace.yaml': 'packages:\n  - a' });
    expect((await detectStack(root, files)).stack.monorepo).toBe(true);
  });

  it('flags monorepo via turbo.json', async () => {
    expect((await detectStack(root, await setup({ 'turbo.json': '{}' }))).stack.monorepo).toBe(true);
  });

  it('flags monorepo via lerna.json', async () => {
    expect((await detectStack(root, await setup({ 'lerna.json': '{}' }))).stack.monorepo).toBe(true);
  });

  it('flags monorepo via a package.json workspaces array', async () => {
    const files = await setup({ 'package.json': PKG({ workspaces: ['packages/*'] }) });
    expect((await detectStack(root, files)).stack.monorepo).toBe(true);
  });

  it('flags monorepo via a package.json workspaces object', async () => {
    const files = await setup({ 'package.json': PKG({ workspaces: { packages: ['packages/*'] } }) });
    expect((await detectStack(root, files)).stack.monorepo).toBe(true);
  });

  it('is not a monorepo for a plain single package', async () => {
    expect((await detectStack(root, await setup({ 'package.json': PKG({}) }))).stack.monorepo).toBe(
      false,
    );
  });
});

// --- deployment targets ------------------------------------------------------

describe('detectStack — deployment targets', () => {
  it('detects vercel + netlify', async () => {
    const files = await setup({ 'vercel.json': '{}', 'netlify.toml': '' });
    const { stack } = await detectStack(root, files);
    expect(stack.deploymentTargets).toEqual(expect.arrayContaining(['vercel', 'netlify']));
  });

  it('detects docker via a Dockerfile', async () => {
    expect(
      (await detectStack(root, await setup({ Dockerfile: 'FROM node' }))).stack.deploymentTargets,
    ).toContain('docker');
  });

  it('detects docker via a suffixed dockerfile name', async () => {
    const files = await setup({ 'deploy/api.dockerfile': 'FROM node' });
    expect((await detectStack(root, files)).stack.deploymentTargets).toContain('docker');
  });

  it('detects docker via docker-compose', async () => {
    const files = await setup({ 'docker-compose.yml': 'services: {}' });
    expect((await detectStack(root, files)).stack.deploymentTargets).toContain('docker');
  });

  it('detects kubernetes via a k8s manifest directory', async () => {
    const files = await setup({ 'k8s/deployment.yaml': 'kind: Deployment' });
    expect((await detectStack(root, files)).stack.deploymentTargets).toContain('kubernetes');
  });

  it('detects kubernetes via a Helm Chart.yaml', async () => {
    const files = await setup({ 'Chart.yaml': 'name: app' });
    expect((await detectStack(root, files)).stack.deploymentTargets).toContain('kubernetes');
  });

  it('detects kubernetes via kustomization.yml', async () => {
    const files = await setup({ 'kustomization.yml': 'resources: []' });
    expect((await detectStack(root, files)).stack.deploymentTargets).toContain('kubernetes');
  });

  it('reports no deployment targets for a bare project', async () => {
    expect(
      (await detectStack(root, await setup({ 'package.json': PKG({}) }))).stack.deploymentTargets,
    ).toEqual([]);
  });
});

// --- scripts -----------------------------------------------------------------

describe('detectStack — scripts', () => {
  it('returns the package.json scripts map', async () => {
    const files = await setup({
      'package.json': PKG({ scripts: { build: 'tsc', test: 'vitest run' } }),
    });
    expect((await detectStack(root, files)).scripts).toEqual({ build: 'tsc', test: 'vitest run' });
  });

  it('returns an empty scripts map when there is no package.json', async () => {
    expect((await detectStack(root, await setup({ 'main.py': '' }))).scripts).toEqual({});
  });
});
