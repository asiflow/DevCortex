// ============================================================================
// Shared CLI runtime: global-option resolution, workspace loading, ledger
// bundles, output emission, and clean error rendering.
//
// Every command is a pure-ish function `(ctx) => Promise<CommandResult>`; this
// module owns the imperative shell (reading argv globals, talking to the
// filesystem via @devcortex/core, writing stdout/stderr, setting exit codes) so
// the command bodies stay focused on composing the engine.
// ============================================================================

import path from 'node:path';

import type { Command } from 'commander';
import pc from 'picocolors';

import {
  DecisionLedger,
  EvidenceLedger,
  FeatureLedger,
  isDevCortexError,
  loadConfig,
  loadGraph,
  MemoryLedger,
  saveGraph,
  scanProject,
  workspacePaths,
} from '@devcortex/core';
import type { ContextLedgers, CortexConfig, ProjectGraph, ShipLedgers } from '@devcortex/core';

// --- Exit-code contract (spec section 6) ------------------------------------

export const EXIT_OK = 0;
export const EXIT_INTERNAL_ERROR = 1;
/** A clean "not ready" gate result (ship NOT_READY / verify failing). */
export const EXIT_NOT_READY = 2;
/**
 * A deliberate, explained policy block emitted by the PreToolUse `guard` hook.
 * Shares the value of {@link EXIT_NOT_READY}: exit code 2 is DevCortex's single
 * "intentional gate" signal that the generated hook shim honours (it keys on
 * `status -eq 2`). Every other non-zero exit is an internal failure and fails open.
 */
export const EXIT_BLOCK = 2;

// --- Result + context shapes ------------------------------------------------

export interface GlobalOptions {
  /** Absolute, resolved repo root the command operates on. */
  root: string;
  /** True when `--json` was passed: emit machine-readable output only. */
  json: boolean;
}

export interface CommandResult {
  /** Machine-readable payload printed under `--json`. */
  data: unknown;
  /** Pre-rendered, colour-styled human output. */
  human: string;
  /** Process exit code; defaults to {@link EXIT_OK}. */
  exitCode?: number;
}

/** The full ledger bundle the compilers and ship report consume. */
export interface Ledgers extends ContextLedgers, ShipLedgers {
  memory: MemoryLedger;
  feature: FeatureLedger;
  decision: DecisionLedger;
  evidence: EvidenceLedger;
}

// --- Global option resolution -----------------------------------------------

/**
 * Resolve the global `--cwd` / `--json` options from anywhere in the command
 * tree. The flags are registered on the program AND every command (no defaults)
 * so they work whether placed before or after the subcommand — exactly how the
 * Claude Code hooks invoke them (`devcortex preflight --json`). We walk the
 * command chain and OR `--json`, preferring the most specific explicit `--cwd`.
 */
export function readGlobals(command: Command): GlobalOptions {
  let json = false;
  let cwd: string | undefined;

  let current: Command | null = command;
  while (current !== null) {
    const opts = current.opts();
    if (opts.json === true) json = true;
    const cwdOpt: unknown = opts.cwd;
    if (cwd === undefined && typeof cwdOpt === 'string' && cwdOpt.trim().length > 0) {
      cwd = cwdOpt;
    }
    current = current.parent;
  }

  return { root: path.resolve(cwd ?? process.cwd()), json };
}

// --- Workspace + graph loading ----------------------------------------------

/**
 * Load the workspace config, surfacing a clean "run init first" error when the
 * repo has no `.cortex/`. (`loadConfig` already throws `CONFIG_NOT_FOUND` with a
 * helpful message; this is a single, typed entry point for every command.)
 */
export async function requireConfig(root: string): Promise<CortexConfig> {
  return loadConfig(root);
}

/**
 * Return the cached project graph, scanning + caching one on demand when no
 * cache exists yet (the normal state right after `init` if the cache was
 * cleared). Always returns a validated, current graph.
 */
export async function loadOrScanGraph(root: string): Promise<ProjectGraph> {
  const cached = await loadGraph(root);
  if (cached !== null) return cached;
  const fresh = await scanProject(root);
  await saveGraph(root, fresh);
  return fresh;
}

/** Construct the four file-backed ledgers rooted at the workspace. */
export function makeLedgers(root: string): Ledgers {
  return {
    memory: new MemoryLedger(root),
    feature: new FeatureLedger(root),
    decision: new DecisionLedger(root),
    evidence: new EvidenceLedger(root),
  };
}

/** Repo-relative POSIX label for an absolute workspace path, for messages. */
export function relWorkspacePath(root: string, absPath: string): string {
  const rel = path.relative(root, absPath);
  return rel === '' ? absPath : rel.split(path.sep).join('/');
}

export { workspacePaths };

// --- Output + error emission ------------------------------------------------

/** Print a successful command result and set the process exit code. */
export function emit(result: CommandResult, json: boolean): void {
  const text = json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.human}\n`;
  process.stdout.write(text);
  process.exitCode = result.exitCode ?? EXIT_OK;
}

/**
 * Render a thrown value as a clean, single-line message — never a stack dump.
 * Under `--json` it is a structured `{ ok: false, error }` object so hooks/CI
 * can parse failures too.
 */
export function renderError(err: unknown, json: boolean): string {
  const code = isDevCortexError(err) ? err.code : 'INTERNAL';
  const message =
    err instanceof Error && typeof err.message === 'string' && err.message.length > 0
      ? err.message
      : String(err);
  if (json) {
    return JSON.stringify({ ok: false, error: { code, message } }, null, 2);
  }
  const suffix = code !== 'INTERNAL' ? pc.dim(`  [${code}]`) : '';
  return `${pc.red('✖')} ${message}${suffix}`;
}

/** Print an error to stderr and mark the process as failed (exit 1). */
export function fail(err: unknown, json: boolean): void {
  process.stderr.write(`${renderError(err, json)}\n`);
  process.exitCode = EXIT_INTERNAL_ERROR;
}

// --- Host-hook I/O (Claude Code PreToolUse / PostToolUse) --------------------

/**
 * The slice of a Claude Code hook payload DevCortex consumes, normalized from the
 * raw `{ tool_name, tool_input: { file_path?, command? }, tool_response? }` shape
 * Claude Code writes to the hook's stdin. Every field is optional: a hook must
 * tolerate any payload (or none) and fail open rather than assume a shape.
 */
export interface HookPayload {
  /** the tool being invoked / observed, e.g. "Edit" | "Write" | "Bash" */
  toolName?: string;
  /** absolute target path for file-mutating tools (Edit / Write) */
  filePath?: string;
  /** the shell command for the Bash tool */
  command?: string;
  /** PostToolUse only: the tool's own result object (stdout / stderr / exit code) */
  toolResponse?: Record<string, unknown>;
}

/** Outcome of a host hook: whether to block, the machine payload, and an explanation. */
export interface HookOutcome {
  /** true → emit the deliberate-block exit code (2) the shim propagates */
  blocked: boolean;
  /** machine-readable payload printed to stdout under `--json` */
  data: unknown;
  /** human explanation; on a block this is surfaced to the host agent via stderr */
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the hook payload from stdin and normalize it to a {@link HookPayload}.
 * Resolves to `{}` for empty / whitespace input; THROWS on malformed JSON so the
 * caller's fail-open wrapper degrades to passive. Stdin is read to EOF with a
 * bounded safety timeout so a hook can never hang the host agent.
 */
export async function readHookPayload(): Promise<HookPayload> {
  const raw = await readStdin();
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};

  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) return {};

  const payload: HookPayload = {};
  const toolName = parsed.tool_name;
  if (typeof toolName === 'string' && toolName.trim().length > 0) payload.toolName = toolName;

  const toolInput = parsed.tool_input;
  if (isRecord(toolInput)) {
    const filePath = toolInput.file_path;
    if (typeof filePath === 'string' && filePath.trim().length > 0) payload.filePath = filePath;
    const command = toolInput.command;
    if (typeof command === 'string' && command.trim().length > 0) payload.command = command;
  }

  const toolResponse = parsed.tool_response;
  if (isRecord(toolResponse)) payload.toolResponse = toolResponse;

  return payload;
}

/** Read process stdin to EOF as UTF-8, with a bounded safety timeout. */
function readStdin(timeoutMs = 5000): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // A TTY means no piped payload (interactive run): there is nothing to read.
    if (stdin.isTTY === true) {
      resolve('');
      return;
    }

    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.off('end', finish);
      stdin.off('error', finish);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();

    stdin.on('data', onData);
    stdin.on('end', finish);
    stdin.on('error', finish);
  });
}

/**
 * Emit a host-hook outcome: the JSON payload (under `--json`) or the human message
 * to stdout, and — on a block — the explanation to stderr (which Claude Code
 * surfaces to the model on the exit-2 block) plus the {@link EXIT_BLOCK} exit code.
 * A non-block always exits 0.
 */
export function emitHookOutcome(outcome: HookOutcome, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(outcome.data, null, 2)}\n`);
  } else if (outcome.message !== undefined && outcome.message.length > 0) {
    process.stdout.write(`${outcome.message}\n`);
  }

  if (outcome.blocked) {
    if (outcome.message !== undefined && outcome.message.length > 0) {
      process.stderr.write(`${outcome.message}\n`);
    }
    process.exitCode = EXIT_BLOCK;
    return;
  }
  process.exitCode = EXIT_OK;
}
