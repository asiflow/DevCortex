/**
 * Stack detection: framework, language, package manager, monorepo flag,
 * deployment targets, and npm scripts — derived from manifests and the scanned
 * file list. Pure of side effects beyond reading well-known root manifest files.
 *
 * Framework precedence (per spec): next → nextjs, vite, express, react,
 * fastapi (python manifests), else node.
 */

import type { DetectedStack, Framework, Language, PackageManager } from '../domain/index';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

async function readText(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

async function readPackageJson(absRoot: string): Promise<Record<string, unknown> | null> {
  const raw = await readText(path.join(absRoot, 'package.json'));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function baseNameOf(posixPath: string): string {
  const idx = posixPath.lastIndexOf('/');
  return (idx === -1 ? posixPath : posixPath.slice(idx + 1)).toLowerCase();
}

function cleanVersion(range: string | undefined): string | undefined {
  if (range === undefined) return undefined;
  const cleaned = range.replace(/^[\^~>=<\s]+/, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface StackDetection {
  stack: DetectedStack;
  scripts: Record<string, string>;
}

export async function detectStack(absRoot: string, relFiles: string[]): Promise<StackDetection> {
  const fileSet = new Set(relFiles);
  const baseNames = new Set(relFiles.map(baseNameOf));

  const hasFile = (rel: string): boolean => fileSet.has(rel);
  const hasBase = (name: string): boolean => baseNames.has(name.toLowerCase());
  const hasConfig = (prefix: string): boolean =>
    relFiles.some((f) => {
      const b = baseNameOf(f);
      return b === `${prefix}.js` || b === `${prefix}.mjs` || b === `${prefix}.cjs` || b === `${prefix}.ts`;
    });

  const pkg = await readPackageJson(absRoot);
  const deps: Record<string, string> = pkg
    ? { ...asStringRecord(pkg['dependencies']), ...asStringRecord(pkg['devDependencies']) }
    : {};
  const scripts = pkg ? asStringRecord(pkg['scripts']) : {};

  // --- python manifests -----------------------------------------------------
  const pythonManifest =
    hasBase('requirements.txt') ||
    hasBase('pyproject.toml') ||
    hasBase('pipfile') ||
    hasBase('setup.py') ||
    hasBase('setup.cfg');

  let pyText = '';
  if (pythonManifest) {
    for (const name of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
      if (hasFile(name)) {
        const t = await readText(path.join(absRoot, name));
        if (t !== null) pyText += `\n${t}`;
      }
    }
  }
  const fastapiDetected = /fastapi/i.test(pyText);
  const poetryProject = /\[tool\.poetry\]/.test(pyText) || hasFile('poetry.lock');

  // --- framework ------------------------------------------------------------
  let framework: Framework;
  let frameworkVersion: string | undefined;
  if (pkg !== null) {
    if ('next' in deps || hasConfig('next.config')) {
      framework = 'nextjs';
      frameworkVersion = cleanVersion(deps['next']);
    } else if ('vite' in deps || hasConfig('vite.config')) {
      framework = 'vite';
      frameworkVersion = cleanVersion(deps['vite']);
    } else if ('express' in deps) {
      framework = 'express';
      frameworkVersion = cleanVersion(deps['express']);
    } else if ('react' in deps) {
      framework = 'react';
      frameworkVersion = cleanVersion(deps['react']);
    } else {
      framework = 'node';
    }
  } else if (fastapiDetected) {
    framework = 'fastapi';
  } else {
    framework = 'node';
  }

  // --- language -------------------------------------------------------------
  let language: Language;
  if (hasFile('tsconfig.json') || relFiles.some((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith('.d.ts'))) {
    language = 'typescript';
  } else if (relFiles.some((f) => /\.(js|jsx|mjs|cjs)$/.test(f))) {
    language = 'javascript';
  } else if (pythonManifest || relFiles.some((f) => f.endsWith('.py'))) {
    language = 'python';
  } else if (hasFile('go.mod') || relFiles.some((f) => f.endsWith('.go'))) {
    language = 'go';
  } else {
    language = 'unknown';
  }

  // --- package manager (by lockfile) ---------------------------------------
  let packageManager: PackageManager;
  if (hasFile('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (hasFile('yarn.lock')) packageManager = 'yarn';
  else if (hasFile('bun.lockb') || hasFile('bun.lock')) packageManager = 'bun';
  else if (hasFile('package-lock.json')) packageManager = 'npm';
  else if (poetryProject) packageManager = 'poetry';
  else if (hasFile('Pipfile.lock') || hasFile('Pipfile') || hasFile('requirements.txt')) packageManager = 'pip';
  else packageManager = 'unknown';

  // --- monorepo -------------------------------------------------------------
  const workspaces = pkg ? pkg['workspaces'] : undefined;
  const hasWorkspaces = Array.isArray(workspaces) || isRecord(workspaces);
  const monorepo = hasFile('pnpm-workspace.yaml') || hasFile('turbo.json') || hasFile('lerna.json') || hasWorkspaces;

  // --- deployment targets ---------------------------------------------------
  const deploymentTargets: string[] = [];
  if (hasFile('vercel.json')) deploymentTargets.push('vercel');
  if (hasFile('netlify.toml')) deploymentTargets.push('netlify');
  const hasDocker = relFiles.some((f) => {
    const b = baseNameOf(f);
    return b === 'dockerfile' || b.startsWith('dockerfile.') || b.endsWith('.dockerfile');
  });
  if (hasDocker || hasBase('docker-compose.yml') || hasBase('docker-compose.yaml')) {
    deploymentTargets.push('docker');
  }
  const hasK8s =
    relFiles.some((f) => /(^|\/)(k8s|kubernetes|manifests|charts)\//.test(f) && /\.ya?ml$/.test(f)) ||
    hasBase('chart.yaml') ||
    hasBase('skaffold.yaml') ||
    hasBase('kustomization.yaml') ||
    hasBase('kustomization.yml');
  if (hasK8s) deploymentTargets.push('kubernetes');

  const stack: DetectedStack = {
    framework,
    language,
    packageManager,
    monorepo,
    deploymentTargets,
    ...(frameworkVersion !== undefined ? { frameworkVersion } : {}),
  };

  return { stack, scripts };
}
