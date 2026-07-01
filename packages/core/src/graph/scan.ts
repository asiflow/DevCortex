/**
 * `scanProject` — walk a repository into a `ProjectGraph`: detect the stack,
 * classify every file, build a bidirectional import graph, detect routes, env
 * vars (and whether each is documented in `.env.example`), risky files, and
 * summary stats.
 *
 * Failure model: invalid root or an unexpected internal error throws
 * `ScanError`. Per-file read or parse failures degrade gracefully (the file is
 * still recorded, tagged `scan:unreadable`) so one bad file never aborts the
 * whole scan — DevCortex is fail-safe by design.
 */

import fg from 'fast-glob';
import { init } from 'es-module-lexer';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';

import type { EnvVar, FileNode, GraphStats, ProjectGraph, RouteNode } from '../domain/index';
import { ScanError, isDevCortexError } from '../domain/index';
import { detectStack } from './detect';
import { classifyFile } from './classify';
import {
  extractImportSpecifiers,
  extractSymbols,
  loadTsconfigAliases,
  resolveSpecifier,
  type AliasMap,
} from './imports';
import { detectRoutes } from './routes';
import { extractEnvRefs, parseEnvKeys } from './env';

export interface ScanOptions {
  /** extra ignore globs, merged with the built-in defaults */
  ignore?: string[];
  /** hard cap on the number of files analysed (default 10000) */
  maxFiles?: number;
}

const GRAPH_SCHEMA_VERSION = 1;
const DEFAULT_MAX_FILES = 10000;

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.next/**',
  '**/.git/**',
  '**/.cortex/**',
  '**/coverage/**',
  '**/build/**',
  '**/.turbo/**',
];

const JS_TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

const ENV_EXAMPLE_BASENAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults',
  '.env.local.example',
]);

function extOf(posixPath: string): string {
  const base = posixPath.slice(posixPath.lastIndexOf('/') + 1);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}

function baseOf(posixPath: string): string {
  return posixPath.slice(posixPath.lastIndexOf('/') + 1).toLowerCase();
}

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function readDocumentedEnv(absRoot: string, relFiles: string[]): Promise<Set<string>> {
  const documented = new Set<string>();
  for (const rel of relFiles) {
    if (!ENV_EXAMPLE_BASENAMES.has(baseOf(rel))) continue;
    try {
      const content = await readFile(path.join(absRoot, rel), 'utf8');
      for (const key of parseEnvKeys(content)) documented.add(key);
    } catch {
      // unreadable example file — simply leave those keys undocumented.
    }
  }
  return documented;
}

async function readSources(
  absRoot: string,
  relFiles: string[],
): Promise<{ sources: Map<string, string>; unreadable: Set<string> }> {
  const sources = new Map<string, string>();
  const unreadable = new Set<string>();
  await Promise.all(
    relFiles.map(async (rel) => {
      if (!JS_TS_EXTS.has(extOf(rel))) return;
      try {
        sources.set(rel, await readFile(path.join(absRoot, rel), 'utf8'));
      } catch {
        unreadable.add(rel);
      }
    }),
  );
  return { sources, unreadable };
}

function buildFileNodes(
  relFiles: string[],
  unreadable: Set<string>,
): Map<string, FileNode> {
  const nodes = new Map<string, FileNode>();
  for (const rel of relFiles) {
    const { kind, risky, tags } = classifyFile(rel);
    const finalTags = unreadable.has(rel) ? [...new Set([...tags, 'scan:unreadable'])].sort() : tags;
    nodes.set(rel, {
      path: rel,
      kind,
      imports: [],
      importedBy: [],
      symbols: [],
      risky,
      tags: finalTags,
    });
  }
  return nodes;
}

function populateImportsAndEnv(
  nodes: Map<string, FileNode>,
  sources: Map<string, string>,
  ctx: { absRoot: string; fileSet: ReadonlySet<string>; aliases: AliasMap },
): Map<string, Set<string>> {
  const envUsage = new Map<string, Set<string>>();

  for (const [rel, source] of sources) {
    const node = nodes.get(rel);
    if (node === undefined) continue;

    node.symbols = extractSymbols(source);

    const resolved = new Set<string>();
    for (const spec of extractImportSpecifiers(source)) {
      const hit = resolveSpecifier(spec, rel, ctx);
      if (hit !== null && hit !== rel) resolved.add(hit);
    }
    node.imports = [...resolved].sort();

    for (const name of extractEnvRefs(source)) {
      let set = envUsage.get(name);
      if (set === undefined) {
        set = new Set<string>();
        envUsage.set(name, set);
      }
      set.add(rel);
    }
  }

  // bidirectional importedBy
  for (const node of nodes.values()) {
    for (const dep of node.imports) {
      const target = nodes.get(dep);
      if (target !== undefined) target.importedBy.push(node.path);
    }
  }
  for (const node of nodes.values()) node.importedBy.sort(byPath);

  return envUsage;
}

/** Scan a repository at `root` into a structured `ProjectGraph`. */
export async function scanProject(root: string, opts: ScanOptions = {}): Promise<ProjectGraph> {
  const absRoot = path.resolve(root);

  try {
    const info = await stat(absRoot).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new ScanError(`scan root is not a directory: ${absRoot}`, { details: { root: absRoot } });
    }

    await init;

    const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])];
    const found = await fg(['**/*'], {
      cwd: absRoot,
      ignore,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      suppressErrors: true,
      absolute: false,
    });

    let relFiles = found.map((f) => f.replace(/\\/g, '/')).sort(byPath);
    const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    if (relFiles.length > maxFiles) relFiles = relFiles.slice(0, maxFiles);
    const fileSet = new Set(relFiles);

    const [{ stack, scripts }, aliases, documented, { sources, unreadable }] = await Promise.all([
      detectStack(absRoot, relFiles),
      loadTsconfigAliases(absRoot),
      readDocumentedEnv(absRoot, relFiles),
      readSources(absRoot, relFiles),
    ]);

    const nodes = buildFileNodes(relFiles, unreadable);
    const envUsage = populateImportsAndEnv(nodes, sources, { absRoot, fileSet, aliases });

    const files: FileNode[] = [...nodes.values()].sort((a, b) => byPath(a.path, b.path));
    const routes: RouteNode[] = stack.framework === 'nextjs' ? detectRoutes(relFiles) : [];

    const envVars: EnvVar[] = [...envUsage.entries()]
      .map(([name, set]) => ({ name, usedIn: [...set].sort(byPath), documented: documented.has(name) }))
      .sort((a, b) => byPath(a.name, b.name));

    const riskyFiles = files
      .filter((f) => f.risky)
      .map((f) => f.path)
      .sort(byPath);

    const stats: GraphStats = {
      fileCount: files.length,
      routeCount: routes.length,
      apiCount: routes.filter((r) => r.kind === 'api').length,
      testCount: files.filter((f) => f.kind === 'test').length,
      riskyCount: riskyFiles.length,
    };

    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      root: absRoot,
      generatedAt: new Date().toISOString(),
      stack,
      files,
      routes,
      envVars,
      scripts,
      riskyFiles,
      stats,
    };
  } catch (err) {
    if (isDevCortexError(err)) throw err;
    throw new ScanError(`failed to scan project at ${absRoot}`, { cause: err });
  }
}
