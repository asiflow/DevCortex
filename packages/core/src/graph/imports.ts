/**
 * Import-graph primitives:
 *  - `extractImportSpecifiers` — union of `es-module-lexer` (handles dynamic
 *    `import()` and modern ESM) and a regex fallback (covers `require()` and
 *    TypeScript files where the lexer bails). Never throws on malformed input;
 *    a parse failure degrades to the regex pass.
 *  - `extractSymbols` — best-effort top-level export names.
 *  - `loadTsconfigAliases` / `resolveSpecifier` — resolve a specifier to a
 *    repo-relative POSIX path that actually exists in the scanned file set,
 *    honouring relative imports, TS `.js`→`.ts` ESM rewriting, index files, and
 *    best-effort tsconfig `paths` aliases.
 *
 * The lexer requires `await init` before `parse`; the scanner awaits it once,
 * and this module's lexer call is wrapped so a missing init also degrades to
 * the regex pass rather than throwing.
 */

import { parse } from 'es-module-lexer';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

const STATIC_FROM = /(?:^|[^.\w$])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT = /(?:^|[^.\w$])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /(?:^|[^.\w$])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /(?:^|[^.\w$])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const CANDIDATE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_EXT_REWRITES: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

export interface AliasMap {
  /** absolute baseUrl the alias targets resolve against */
  baseUrl: string;
  exact: Map<string, string[]>;
  wildcard: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

export interface ResolveContext {
  absRoot: string;
  /** set of repo-relative POSIX paths that exist in the scan */
  fileSet: ReadonlySet<string>;
  aliases: AliasMap;
}

function regexSpecifiers(source: string): Set<string> {
  const specs = new Set<string>();
  for (const re of [STATIC_FROM, SIDE_EFFECT, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const spec = match[1];
      if (spec !== undefined && spec.length > 0) specs.add(spec);
    }
  }
  return specs;
}

/** All module specifiers imported by a source file (relative, alias, or bare). */
export function extractImportSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  try {
    const [imports] = parse(source);
    for (const imp of imports) {
      if (imp.n !== undefined && imp.n.length > 0) specs.add(imp.n);
    }
  } catch {
    // es-module-lexer can throw on TS-specific syntax or before init resolves;
    // the regex pass below recovers the specifiers either way.
  }
  for (const spec of regexSpecifiers(source)) specs.add(spec);
  return [...specs];
}

const NAMED_EXPORT = /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_BLOCK = /export\s*\{([^}]*)\}/g;

/** Best-effort top-level exported symbol names. */
export function extractSymbols(source: string): string[] {
  const symbols = new Set<string>();

  NAMED_EXPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_EXPORT.exec(source)) !== null) {
    const name = match[1];
    if (name !== undefined) symbols.add(name);
  }

  EXPORT_BLOCK.lastIndex = 0;
  while ((match = EXPORT_BLOCK.exec(source)) !== null) {
    const block = match[1];
    if (block === undefined) continue;
    for (const rawPart of block.split(',')) {
      const part = rawPart.trim();
      if (part.length === 0) continue;
      const segments = part.split(/\s+as\s+/);
      const exported = (segments.length > 1 ? segments[segments.length - 1] : segments[0])?.trim();
      if (exported === undefined) continue;
      const cleaned = exported.replace(/^type\s+/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) symbols.add(cleaned);
    }
  }

  if (/export\s+default\b/.test(source)) symbols.add('default');

  return [...symbols].sort();
}

function stripJsonComments(input: string): string {
  // Remove block and line comments and trailing commas so JSONC (tsconfig) can
  // be parsed by JSON.parse. Conservative — does not attempt to honour string
  // literals containing comment-like sequences (rare in tsconfig).
  const withoutComments = input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n\r]*/g, '$1');
  return withoutComments.replace(/,(\s*[}\]])/g, '$1');
}

async function readJsonc(absPath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    try {
      const parsed: unknown = JSON.parse(stripJsonComments(raw));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Load tsconfig/jsconfig `paths` aliases (best-effort). Returns an empty alias
 * map (baseUrl = root) when no config is present or it cannot be parsed.
 */
export async function loadTsconfigAliases(absRoot: string): Promise<AliasMap> {
  const empty: AliasMap = { baseUrl: absRoot, exact: new Map(), wildcard: [] };
  const config =
    (await readJsonc(path.join(absRoot, 'tsconfig.json'))) ??
    (await readJsonc(path.join(absRoot, 'jsconfig.json')));
  if (config === null) return empty;

  const compilerOptions = config['compilerOptions'];
  if (!isRecord(compilerOptions)) return empty;

  const baseUrlRaw = compilerOptions['baseUrl'];
  const baseUrl = typeof baseUrlRaw === 'string' ? path.resolve(absRoot, baseUrlRaw) : absRoot;

  const pathsRaw = compilerOptions['paths'];
  const exact = new Map<string, string[]>();
  const wildcard: Array<{ prefix: string; suffix: string; targets: string[] }> = [];

  if (isRecord(pathsRaw)) {
    for (const key of Object.keys(pathsRaw)) {
      const targetsRaw = pathsRaw[key];
      if (!Array.isArray(targetsRaw)) continue;
      const targets = targetsRaw.filter((t): t is string => typeof t === 'string');
      if (targets.length === 0) continue;
      const starIdx = key.indexOf('*');
      if (starIdx === -1) {
        exact.set(key, targets);
      } else {
        wildcard.push({
          prefix: key.slice(0, starIdx),
          suffix: key.slice(starIdx + 1),
          targets,
        });
      }
    }
  }

  wildcard.sort((a, b) => b.prefix.length - a.prefix.length);
  return { baseUrl, exact, wildcard };
}

function aliasCandidates(spec: string, aliases: AliasMap): string[] {
  const exactTargets = aliases.exact.get(spec);
  if (exactTargets !== undefined) {
    return exactTargets.map((t) => path.resolve(aliases.baseUrl, t));
  }
  const out: string[] = [];
  for (const entry of aliases.wildcard) {
    if (
      spec.length >= entry.prefix.length + entry.suffix.length &&
      spec.startsWith(entry.prefix) &&
      spec.endsWith(entry.suffix)
    ) {
      const star = spec.slice(entry.prefix.length, spec.length - entry.suffix.length);
      for (const target of entry.targets) {
        out.push(path.resolve(aliases.baseUrl, target.replace('*', star)));
      }
    }
  }
  return out;
}

function toRepoRel(absRoot: string, absTarget: string): string {
  return path.relative(absRoot, absTarget).split(path.sep).join('/');
}

function matchFile(repoRel: string, fileSet: ReadonlySet<string>): string | null {
  if (repoRel.length === 0 || repoRel.startsWith('..')) return null;

  if (fileSet.has(repoRel)) return repoRel;

  const dotIdx = repoRel.lastIndexOf('.');
  const slashIdx = repoRel.lastIndexOf('/');
  const ext = dotIdx > slashIdx ? repoRel.slice(dotIdx) : '';

  // TS ESM authoring imports `./x.js` but the file on disk is `./x.ts`.
  if (ext.length > 0) {
    const rewrites = JS_EXT_REWRITES[ext];
    if (rewrites !== undefined) {
      const stem = repoRel.slice(0, dotIdx);
      for (const rewrite of rewrites) {
        const candidate = stem + rewrite;
        if (fileSet.has(candidate)) return candidate;
      }
    }
  }

  // Extensionless import → try appending known extensions.
  for (const candidateExt of CANDIDATE_EXTS) {
    const candidate = repoRel + candidateExt;
    if (fileSet.has(candidate)) return candidate;
  }

  // Directory import → index file.
  for (const candidateExt of CANDIDATE_EXTS) {
    const candidate = `${repoRel}/index${candidateExt}`;
    if (fileSet.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Resolve a module specifier imported from `fromRel` into a repo-relative POSIX
 * path that exists in the scan, or `null` for bare/unresolvable specifiers.
 */
export function resolveSpecifier(spec: string, fromRel: string, ctx: ResolveContext): string | null {
  let candidatesAbs: string[];

  if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
    const fromDirAbs = path.dirname(path.join(ctx.absRoot, fromRel));
    candidatesAbs = [path.resolve(fromDirAbs, spec)];
  } else if (spec.startsWith('/')) {
    candidatesAbs = [path.join(ctx.absRoot, spec)];
  } else {
    candidatesAbs = aliasCandidates(spec, ctx.aliases);
    if (candidatesAbs.length === 0) return null; // bare package import
  }

  for (const abs of candidatesAbs) {
    const hit = matchFile(toRepoRel(ctx.absRoot, abs), ctx.fileSet);
    if (hit !== null) return hit;
  }
  return null;
}
