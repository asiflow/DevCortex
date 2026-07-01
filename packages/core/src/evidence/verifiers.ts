/**
 * Claim verifiers — turn assertions about a repository into structured
 * `EvidenceItem`s with a definite status (verified | partial | refuted |
 * unverified). These are the anti-hallucination primitives: a negative result
 * is *evidence*, not an error, so the verifiers NEVER throw on a "false" claim.
 * They throw a `DevCortexError` (`EvidenceError`) only on a genuine internal
 * failure — an unreadable file for a non-ENOENT reason, a process that cannot be
 * spawned, or malformed input that makes the question unanswerable.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { init, parse } from 'es-module-lexer';

import { EvidenceError } from '../domain/index';
import type {
  CortexConfig,
  EvidenceItem,
  EvidenceKind,
  EvidenceStatus,
  ProjectGraph,
} from '../domain/index';

// --- options ----------------------------------------------------------------

export interface CommandOptions {
  /** working directory the command runs in */
  cwd: string;
  /** wall-clock kill deadline in milliseconds (default 120_000) */
  timeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const BUILD_TIMEOUT_MS = 600_000;
/** Ceiling for a caller-supplied command timeout; see {@link verifyCommandResult}. */
const MAX_COMMAND_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 4_000;
const CAPTURE_HARD_CAP = 1_000_000;

const CANDIDATE_EXTS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.node',
];

/** TS ESM authors import `./x.js` while the file on disk is `./x.ts`. */
const JS_EXT_REWRITES: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const NODE_BUILTINS = new Set(builtinModules);

const NAMED_EXPORT =
  /export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_BLOCK = /export\s*\{([^}]*)\}/g;

// --- shared helpers ---------------------------------------------------------

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EvidenceError(`${name} must be a non-empty string`);
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface EvidenceFields {
  claim: string;
  status: EvidenceStatus;
  kind: EvidenceKind;
  detail: string;
  command?: string;
  exitCode?: number;
  output?: string;
}

function makeEvidence(fields: EvidenceFields): EvidenceItem {
  const item: EvidenceItem = {
    id: randomUUID(),
    claim: fields.claim,
    status: fields.status,
    kind: fields.kind,
    detail: fields.detail,
    createdAt: new Date().toISOString(),
  };
  if (fields.command !== undefined) item.command = fields.command;
  if (fields.exitCode !== undefined) item.exitCode = fields.exitCode;
  if (fields.output !== undefined) item.output = fields.output;
  return item;
}

function truncateOutput(raw: string): string {
  if (raw.length <= MAX_OUTPUT_CHARS) return raw;
  const head = raw.slice(0, MAX_OUTPUT_CHARS);
  return `${head}\n…[truncated ${raw.length - MAX_OUTPUT_CHARS} chars]`;
}

async function isFileAt(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

async function isDirAt(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

// --- path containment -------------------------------------------------------

/** True when `absPath` is `absRoot` itself or lives inside it. */
function isWithinRoot(absRoot: string, absPath: string): boolean {
  return absPath === absRoot || absPath.startsWith(absRoot + path.sep);
}

/**
 * Resolve `relPath` against `root` and confirm the result stays inside `root`.
 * Returns the contained absolute path, or `null` when the path escapes the root
 * — a `"../../etc/passwd"`-style traversal, or an absolute path pointing outside
 * the repo. These verifiers run behind the MCP boundary where the path is
 * caller-supplied, so an escaping path is refused without ever touching the
 * filesystem.
 */
function resolveWithinRoot(root: string, relPath: string): string | null {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, relPath);
  return isWithinRoot(absRoot, abs) ? abs : null;
}

// --- verifyFileExists -------------------------------------------------------

/** Verify that `relPath` (relative to `root`) is a real file on disk. */
export async function verifyFileExists(root: string, relPath: string): Promise<EvidenceItem> {
  assertNonEmpty(root, 'root');
  assertNonEmpty(relPath, 'relPath');

  const claim = `File "${relPath}" exists`;
  const abs = resolveWithinRoot(root, relPath);
  if (abs === null) {
    return makeEvidence({
      claim,
      status: 'refuted',
      kind: 'file',
      detail: `Refusing to read "${relPath}": resolves outside the project root`,
    });
  }

  let stats;
  try {
    stats = await stat(abs);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return makeEvidence({ claim, status: 'refuted', kind: 'file', detail: `No file at ${abs}` });
    }
    throw new EvidenceError(`Failed to stat "${abs}"`, { cause: err });
  }

  if (stats.isFile()) {
    return makeEvidence({ claim, status: 'verified', kind: 'file', detail: `File present at ${abs}` });
  }
  if (stats.isDirectory()) {
    return makeEvidence({
      claim,
      status: 'refuted',
      kind: 'file',
      detail: `${abs} exists but is a directory, not a file`,
    });
  }
  return makeEvidence({
    claim,
    status: 'partial',
    kind: 'file',
    detail: `${abs} exists but is not a regular file`,
  });
}

// --- verifyRouteExists ------------------------------------------------------

/** Verify that `routePath` is present in the scanned graph's route table. */
export function verifyRouteExists(graph: ProjectGraph, routePath: string): EvidenceItem {
  if (!isRecord(graph) || !Array.isArray(graph.routes)) {
    throw new EvidenceError('verifyRouteExists requires a ProjectGraph with a routes array');
  }
  assertNonEmpty(routePath, 'routePath');

  const claim = `Route "${routePath}" exists in the project graph`;
  const match = graph.routes.find((route) => route.routePath === routePath);

  if (match !== undefined) {
    return makeEvidence({
      claim,
      status: 'verified',
      kind: 'route',
      detail: `Route "${routePath}" resolves to ${match.file} (${match.kind})`,
    });
  }

  return makeEvidence({
    claim,
    status: 'refuted',
    kind: 'route',
    detail: `No route "${routePath}" among ${graph.routes.length} known route(s)`,
  });
}

// --- verifySymbolExists -----------------------------------------------------

async function collectExportNames(source: string): Promise<Set<string>> {
  const names = new Set<string>();

  try {
    await init;
    const [, exportsList] = parse(source);
    for (const exported of exportsList) {
      if (exported.n.length > 0) names.add(exported.n);
    }
  } catch {
    // es-module-lexer can bail on TS-specific syntax or wasm init issues; the
    // regex passes below recover the export names either way.
  }

  NAMED_EXPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NAMED_EXPORT.exec(source)) !== null) {
    const name = match[1];
    if (name !== undefined) names.add(name);
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
      if (/^[A-Za-z_$][\w$]*$/.test(cleaned)) names.add(cleaned);
    }
  }

  if (/(?:^|[^.\w$])export\s+default\b/.test(source)) names.add('default');

  return names;
}

function isDeclaredLocally(source: string, symbol: string): boolean {
  const declaration = new RegExp(
    `(?:^|[^.\\w$])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|const|let|var|interface|type|enum)\\s+${escapeRegExp(symbol)}\\b`,
  );
  return declaration.test(source);
}

/**
 * Verify that `symbol` is defined in the source file at `relPath`. An exported
 * symbol is `verified`; a symbol declared but not exported is `partial`; an
 * absent symbol (or missing file) is `refuted`.
 */
export async function verifySymbolExists(
  root: string,
  relPath: string,
  symbol: string,
): Promise<EvidenceItem> {
  assertNonEmpty(root, 'root');
  assertNonEmpty(relPath, 'relPath');
  assertNonEmpty(symbol, 'symbol');

  const claim = `Symbol "${symbol}" is defined in "${relPath}"`;
  const abs = resolveWithinRoot(root, relPath);
  if (abs === null) {
    return makeEvidence({
      claim,
      status: 'refuted',
      kind: 'symbol',
      detail: `Refusing to read "${relPath}": resolves outside the project root`,
    });
  }

  let source: string;
  try {
    source = await readFile(abs, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return makeEvidence({
        claim,
        status: 'refuted',
        kind: 'symbol',
        detail: `Cannot find symbol: file ${abs} does not exist`,
      });
    }
    if (isErrnoException(err) && err.code === 'EISDIR') {
      return makeEvidence({
        claim,
        status: 'refuted',
        kind: 'symbol',
        detail: `${abs} is a directory, not a source file`,
      });
    }
    throw new EvidenceError(`Failed to read "${abs}"`, { cause: err });
  }

  const exportNames = await collectExportNames(source);
  if (exportNames.has(symbol)) {
    return makeEvidence({
      claim,
      status: 'verified',
      kind: 'symbol',
      detail: `"${symbol}" is exported from ${relPath}`,
    });
  }

  if (isDeclaredLocally(source, symbol)) {
    return makeEvidence({
      claim,
      status: 'partial',
      kind: 'symbol',
      detail: `"${symbol}" is declared in ${relPath} but is not exported`,
    });
  }

  return makeEvidence({
    claim,
    status: 'refuted',
    kind: 'symbol',
    detail: `"${symbol}" is neither exported nor declared in ${relPath}`,
  });
}

// --- verifyImportPath -------------------------------------------------------

async function resolveTargetFile(base: string): Promise<string | null> {
  if (await isFileAt(base)) return base;

  const ext = path.extname(base);
  if (ext.length > 0) {
    const rewrites = JS_EXT_REWRITES[ext];
    if (rewrites !== undefined) {
      const stem = base.slice(0, base.length - ext.length);
      for (const rewrite of rewrites) {
        const candidate = stem + rewrite;
        if (await isFileAt(candidate)) return candidate;
      }
    }
  }

  for (const candidateExt of CANDIDATE_EXTS) {
    const candidate = base + candidateExt;
    if (await isFileAt(candidate)) return candidate;
  }

  if (await isDirAt(base)) {
    for (const candidateExt of CANDIDATE_EXTS) {
      const candidate = path.join(base, `index${candidateExt}`);
      if (await isFileAt(candidate)) return candidate;
    }
  }

  return null;
}

function packageNameOf(spec: string): string {
  const parts = spec.split('/');
  const first = parts[0] ?? spec;
  if (first.startsWith('@')) {
    const second = parts[1];
    return second !== undefined ? `${first}/${second}` : first;
  }
  return first;
}

async function resolveBarePackage(
  absRoot: string,
  fromDir: string,
  pkgName: string,
): Promise<string | null> {
  const checked = new Set<string>();
  let dir = path.resolve(fromDir);

  for (;;) {
    if (!checked.has(dir)) {
      checked.add(dir);
      const candidate = path.join(dir, 'node_modules', pkgName);
      if (await isDirAt(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const rootCandidate = path.join(absRoot, 'node_modules', pkgName);
  if (!checked.has(absRoot) && (await isDirAt(rootCandidate))) return rootCandidate;

  return null;
}

/**
 * Verify that an import specifier from `fromFile` points at a real target.
 * Relative/absolute specifiers must resolve to a file on disk (`verified` /
 * `refuted`); Node built-ins are `verified`; bare package specifiers resolve via
 * `node_modules` walk-up, and an un-found package is `unverified` (absence from
 * an uninstalled tree is not proof the dependency does not exist).
 */
export async function verifyImportPath(
  root: string,
  fromFile: string,
  importPath: string,
): Promise<EvidenceItem> {
  assertNonEmpty(root, 'root');
  assertNonEmpty(fromFile, 'fromFile');
  assertNonEmpty(importPath, 'importPath');

  const absRoot = path.resolve(root);
  const claim = `Import "${importPath}" from "${fromFile}" resolves to a real target`;

  const absFrom = resolveWithinRoot(absRoot, fromFile);
  if (absFrom === null) {
    return makeEvidence({
      claim,
      status: 'refuted',
      kind: 'import',
      detail: `Refusing to resolve imports from "${fromFile}": it resolves outside the project root`,
    });
  }
  const fromDir = path.dirname(absFrom);

  if (importPath.startsWith('node:') || NODE_BUILTINS.has(importPath)) {
    return makeEvidence({
      claim,
      status: 'verified',
      kind: 'import',
      detail: `"${importPath}" is a Node.js built-in module`,
    });
  }

  const isRelative =
    importPath === '.' ||
    importPath === '..' ||
    importPath.startsWith('./') ||
    importPath.startsWith('../');

  if (isRelative || importPath.startsWith('/')) {
    const base = importPath.startsWith('/')
      ? path.join(absRoot, importPath)
      : path.resolve(fromDir, importPath);
    if (!isWithinRoot(absRoot, base)) {
      return makeEvidence({
        claim,
        status: 'refuted',
        kind: 'import',
        detail: `Refusing to resolve "${importPath}": it resolves outside the project root`,
      });
    }
    const resolved = await resolveTargetFile(base);
    if (resolved !== null) {
      return makeEvidence({
        claim,
        status: 'verified',
        kind: 'import',
        detail: `Resolved "${importPath}" to ${resolved}`,
      });
    }
    return makeEvidence({
      claim,
      status: 'refuted',
      kind: 'import',
      detail: `No file resolves "${importPath}" from ${fromDir}`,
    });
  }

  const pkgName = packageNameOf(importPath);
  const found = await resolveBarePackage(absRoot, fromDir, pkgName);
  if (found !== null) {
    return makeEvidence({
      claim,
      status: 'verified',
      kind: 'import',
      detail: `Package "${pkgName}" found at ${found}`,
    });
  }

  return makeEvidence({
    claim,
    status: 'unverified',
    kind: 'import',
    detail: `Bare specifier "${importPath}" not found in node_modules; cannot confirm or refute without an installed dependency tree`,
  });
}

// --- command execution ------------------------------------------------------

function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  kind: EvidenceKind,
  claim: string,
): Promise<EvidenceItem> {
  return new Promise<EvidenceItem>((resolve, reject) => {
    let child: ChildProcess;
    try {
      // `detached` puts the child in its own process group so a timeout can
      // SIGKILL the whole group (see `killGroup`), not just the top-level shell.
      child = spawn(cmd, { cwd, shell: true, windowsHide: true, detached: true });
    } catch (err) {
      reject(new EvidenceError(`Failed to spawn command: ${cmd}`, { cause: err }));
      return;
    }

    const chunks: string[] = [];
    let total = 0;
    const capture = (buf: Buffer): void => {
      if (total >= CAPTURE_HARD_CAP) return;
      let text = buf.toString('utf8');
      if (total + text.length > CAPTURE_HARD_CAP) {
        text = text.slice(0, CAPTURE_HARD_CAP - total);
      }
      total += text.length;
      chunks.push(text);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let timedOut = false;
    let settled = false;

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        // Negative pid targets the whole process group (the child leads its own
        // group via `detached`), so grandchildren a shell command spawned die
        // with it instead of being orphaned past the deadline.
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Group signalling is unsupported on some platforms (e.g. Windows) or
        // the group is already gone; fall back to killing just the child.
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new EvidenceError(`Command failed to execute: ${cmd}`, { cause: err }));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = truncateOutput(chunks.join(''));

      if (timedOut) {
        resolve(
          makeEvidence({
            claim,
            status: 'refuted',
            kind,
            detail: `Command timed out after ${timeoutMs}ms and was killed (signal ${signal ?? 'SIGKILL'})`,
            command: cmd,
            output,
          }),
        );
        return;
      }

      const exitCode = code ?? -1;
      const verified = exitCode === 0;
      resolve(
        makeEvidence({
          claim,
          status: verified ? 'verified' : 'refuted',
          kind,
          detail: verified
            ? 'Command exited 0'
            : code === null
              ? `Command terminated by signal ${signal ?? 'unknown'}`
              : `Command exited with code ${code}`,
          command: cmd,
          exitCode,
          output,
        }),
      );
    });
  });
}

/**
 * Run a shell command and verify it exits 0. The command is `verified` iff it
 * exits cleanly with code 0; a non-zero exit or a timeout is `refuted` (not an
 * error). The captured stdout+stderr is truncated and attached as `output`.
 *
 * TRUST BOUNDARY: this executes an arbitrary shell string in `opts.cwd`. The
 * capability is intentional — the gates run a target repo's own configured
 * typecheck/lint/build/test commands — but it means whoever controls the
 * command string (or the target repo's `.cortex` config that supplies it) gets
 * arbitrary code execution. Only ever point this at repositories you trust.
 * Containment: the child runs in its own process group and the whole group is
 * SIGKILL'd on timeout (so grandchildren cannot outlive the deadline), and the
 * caller-supplied timeout is clamped to {@link MAX_COMMAND_TIMEOUT_MS}.
 */
export async function verifyCommandResult(cmd: string, opts: CommandOptions): Promise<EvidenceItem> {
  assertNonEmpty(cmd, 'cmd');
  if (!isRecord(opts)) {
    throw new EvidenceError('verifyCommandResult requires an options object with a cwd');
  }
  assertNonEmpty(opts.cwd, 'opts.cwd');

  const requested = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    throw new EvidenceError('opts.timeoutMs must be a positive, finite number');
  }
  // Clamp to a sane ceiling so a caller cannot pin a runaway command open far
  // longer than any real gate needs behind the MCP boundary.
  const timeoutMs = Math.min(requested, MAX_COMMAND_TIMEOUT_MS);

  return runCommand(cmd, opts.cwd, timeoutMs, 'command', `Command "${cmd}" exits 0`);
}

// --- verifyBuildEvidence ----------------------------------------------------

interface DetectedCommand {
  command: string;
  via: string;
}

async function detectPackageManager(root: string): Promise<string> {
  if (await isFileAt(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await isFileAt(path.join(root, 'yarn.lock'))) return 'yarn';
  if (await isFileAt(path.join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

async function detectBuildCommand(root: string): Promise<DetectedCommand | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(root, 'package.json'), 'utf8');
  } catch {
    return null;
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(pkg)) return null;

  const scripts = pkg['scripts'];
  if (!isRecord(scripts)) return null;

  const build = scripts['build'];
  if (typeof build !== 'string' || build.trim().length === 0) return null;

  const pm = await detectPackageManager(root);
  return { command: `${pm} run build`, via: `package.json scripts.build via ${pm}` };
}

/**
 * Verify that the project builds. Uses `config.commands.build` when set,
 * otherwise the detected `package.json` build script (run with the detected
 * package manager). Emits `build`-kind evidence; if no build command is
 * configured or detectable the result is `unverified` (there is nothing to run).
 */
export async function verifyBuildEvidence(
  root: string,
  config: CortexConfig,
): Promise<EvidenceItem> {
  assertNonEmpty(root, 'root');
  if (!isRecord(config)) {
    throw new EvidenceError('verifyBuildEvidence requires a CortexConfig');
  }

  const claim = 'Project build succeeds';
  const configured = isRecord(config.commands) ? config.commands.build : undefined;

  let buildCmd: string | undefined =
    typeof configured === 'string' && configured.trim().length > 0 ? configured : undefined;
  let provenance = '';

  if (buildCmd === undefined) {
    const detected = await detectBuildCommand(root);
    if (detected === null) {
      return makeEvidence({
        claim,
        status: 'unverified',
        kind: 'build',
        detail:
          'No build command configured (config.commands.build) and no "build" script detected in package.json — nothing to run.',
      });
    }
    buildCmd = detected.command;
    provenance = ` (${detected.via})`;
  }

  const evidence = await runCommand(buildCmd, root, BUILD_TIMEOUT_MS, 'build', claim);
  if (provenance.length > 0) {
    evidence.detail = `${evidence.detail}${provenance}`;
  }
  return evidence;
}
