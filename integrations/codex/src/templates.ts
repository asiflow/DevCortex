// ============================================================================
// DevCortex Codex CLI integration — AGENTS.md / config.toml templates.
//
// Pure, deterministic builders plus a delimited-block merge primitive. They
// produce the exact text `installCodex` writes into a target repository:
//   - AGENTS.md            — a clearly-delimited DevCortex instruction block that
//                            Codex CLI reads as project documentation.
//   - .codex/config.toml   — a delimited block registering the `devcortex-mcp`
//                            stdio MCP server (project-scoped Codex settings).
//
// Codex has no shell-hook lifecycle (unlike Claude Code), so this integration is
// purely instruction + MCP registration. There are no generated shim scripts.
//
// Determinism is load-bearing: `installCodex` compares freshly-built content
// against what is already on disk to decide "unchanged" vs "would change", so
// every builder here MUST be a stable pure function of its inputs. Merging is
// done by splicing a uniquely-delimited managed block, which keeps every byte of
// the user's own content in both files untouched.
// ============================================================================

import { ConfigError } from '@devcortex/core';

// --- Identity / location constants ------------------------------------------

/** Name under which the DevCortex MCP server is registered in config.toml. */
export const DEVCORTEX_MCP_SERVER_NAME = 'devcortex-mcp';
/** Executable that launches the stdio MCP server (see @devcortex/mcp-server bin). */
export const DEVCORTEX_MCP_COMMAND = 'devcortex-mcp';
/** The DevCortex CLI binary the AGENTS.md instructions reference. */
export const DEVCORTEX_CLI_BIN = 'devcortex';

/** POSIX-relative path of the Codex agent-instructions file (repo root). */
export const AGENTS_FILE_PATH = 'AGENTS.md';
/** POSIX-relative path of the project-scoped Codex config file. */
export const CODEX_CONFIG_PATH = '.codex/config.toml';

// --- Managed-block delimiters -----------------------------------------------
//
// Each generated file carries exactly one DevCortex-owned region bracketed by a
// unique BEGIN/END marker pair. Merging replaces only the bytes between (and
// including) these markers, so foreign content is preserved verbatim and a
// re-install is byte-for-byte idempotent. The markers are HTML comments in
// Markdown (invisible when rendered) and `#` comments in TOML (ignored by the
// parser).

/** BEGIN marker for the DevCortex block inside AGENTS.md. */
export const AGENTS_BLOCK_BEGIN = '<!-- DEVCORTEX:BEGIN -->';
/** END marker for the DevCortex block inside AGENTS.md. */
export const AGENTS_BLOCK_END = '<!-- DEVCORTEX:END -->';
/** BEGIN marker for the DevCortex block inside .codex/config.toml. */
export const CODEX_BLOCK_BEGIN = '# DEVCORTEX:BEGIN';
/** END marker for the DevCortex block inside .codex/config.toml. */
export const CODEX_BLOCK_END = '# DEVCORTEX:END';

// --- Block builders ---------------------------------------------------------

/**
 * Builds the DevCortex AGENTS.md instruction block, including its BEGIN/END
 * markers, WITHOUT a trailing newline. Codex CLI concatenates every AGENTS.md
 * from the project root down to the working directory and feeds it to the model
 * as project documentation, so this block instructs the agent to preflight
 * risky work, respect protected paths, and ship on evidence.
 */
export function buildAgentsBlock(): string {
  return [
    AGENTS_BLOCK_BEGIN,
    '## DevCortex',
    '',
    'DevCortex is the local, tokenless cognitive layer for this repository. It',
    'tracks the project graph, protected paths, prior decisions, known failures,',
    'and an evidence ledger, and it gates "done" on real evidence. Follow this',
    'workflow on every task.',
    '',
    '**1. Preflight before risky work.** Before edits that touch schemas,',
    'migrations, auth, deletes, public APIs, or anything with a wide blast radius,',
    'run:',
    '',
    `    ${DEVCORTEX_CLI_BIN} preflight "<one-line description of the task>"`,
    '',
    'Read the CORTEX PREFLIGHT block it prints (blast radius, protected paths,',
    'related decisions, known failures) and let it shape your plan.',
    '',
    '**2. Respect protected paths.** Never edit or delete a path DevCortex marks',
    'as protected without an explicit, stated reason. If a change genuinely',
    'requires touching a protected path, call it out and justify it before',
    'proceeding.',
    '',
    '**3. Ship on evidence, not claims.** Before you report a task complete, run:',
    '',
    `    ${DEVCORTEX_CLI_BIN} ship`,
    '',
    'Do not say "done", "fixed", or "it works" until this reports READY. If it',
    'reports NOT_READY, resolve the listed gaps (tests, typecheck, evidence) and',
    're-run. Evidence over claims — a green ship report is the definition of done.',
    '',
    'DevCortex fails open: if any DevCortex command errors, it degrades to passive',
    'mode and never blocks your work.',
    AGENTS_BLOCK_END,
  ].join('\n');
}

/**
 * Builds the DevCortex .codex/config.toml block, including its BEGIN/END
 * markers, WITHOUT a trailing newline.
 *
 * The block registers the DevCortex stdio MCP server under the canonical Codex
 * `[mcp_servers.<name>]` table so Codex CLI can call DevCortex tools (project
 * graph, preflight context, protected-path policy, evidence + ship gate) without
 * spending model tokens on background cognition. It is intentionally portable:
 * no absolute paths are embedded, because Codex launches project-local MCP
 * servers at the project root and the server resolves its repo from
 * `--root` / `DEVCORTEX_ROOT` / cwd. Writing this into the PROJECT-scoped
 * `.codex/config.toml` (rather than the global `~/.codex/config.toml`) is what
 * scopes the registration and settings to this repository.
 */
export function buildCodexConfigBlock(): string {
  return [
    CODEX_BLOCK_BEGIN,
    '# DevCortex managed block — do not edit by hand.',
    `# Regenerate with \`${DEVCORTEX_CLI_BIN} install codex\`; delete this whole block to uninstall.`,
    '#',
    '# Project-scoped Codex configuration for this repository.',
    '#',
    '# Registers the DevCortex stdio MCP server so Codex CLI can call DevCortex',
    '# tools (project graph, preflight context, protected-path policy, evidence +',
    '# ship gate) without spending model tokens on background cognition. Codex',
    '# launches this project-local server at the project root; the server resolves',
    '# the repo from --root / DEVCORTEX_ROOT / cwd, so no path configuration is',
    '# required here (keeping the file portable across clones and machines).',
    `[mcp_servers.${DEVCORTEX_MCP_SERVER_NAME}]`,
    `command = "${DEVCORTEX_MCP_COMMAND}"`,
    'args = []',
    CODEX_BLOCK_END,
  ].join('\n');
}

// --- Delimited-block merge --------------------------------------------------

/**
 * Splices a uniquely-delimited managed `block` into `existing` text, returning
 * the new file content. The three cases:
 *
 *   1. `existing` is null/blank → the block becomes the whole file.
 *   2. `existing` has no BEGIN marker → the block is appended after the user's
 *      content, separated by a blank line (nothing of theirs is lost).
 *   3. `existing` already has a managed block → the region between (and
 *      including) the markers is replaced with the fresh block; everything
 *      before and after is preserved byte-for-byte.
 *
 * Idempotent: re-splicing an identical block reproduces identical bytes. `block`
 * must include its own BEGIN/END markers and must NOT end with a newline.
 *
 * @throws {ConfigError} when a BEGIN marker is present without a matching END
 *   marker after it — a truncated/hand-corrupted block we refuse to overwrite.
 */
export function mergeDelimitedBlock(
  existing: string | null,
  block: string,
  beginMarker: string,
  endMarker: string,
): string {
  if (existing === null || existing.trim() === '') {
    return `${block}\n`;
  }

  const beginIdx = existing.indexOf(beginMarker);
  if (beginIdx === -1) {
    // No DevCortex block yet: append after the user's content, preserving it.
    const trimmed = existing.replace(/\s+$/, '');
    return `${trimmed}\n\n${block}\n`;
  }

  const endIdx = existing.indexOf(endMarker, beginIdx + beginMarker.length);
  if (endIdx === -1) {
    throw new ConfigError(
      `Existing file contains a DevCortex begin marker ("${beginMarker}") without a matching ` +
        `end marker ("${endMarker}"); refusing to overwrite a malformed managed block.`,
    );
  }

  const before = existing.slice(0, beginIdx);
  const after = existing.slice(endIdx + endMarker.length);
  return `${before}${block}${after}`;
}

/** Computes the desired AGENTS.md content given its current on-disk text. */
export function mergeAgentsDoc(existing: string | null): string {
  return mergeDelimitedBlock(existing, buildAgentsBlock(), AGENTS_BLOCK_BEGIN, AGENTS_BLOCK_END);
}

/** Computes the desired .codex/config.toml content given its current text. */
export function mergeCodexConfig(existing: string | null): string {
  return mergeDelimitedBlock(
    existing,
    buildCodexConfigBlock(),
    CODEX_BLOCK_BEGIN,
    CODEX_BLOCK_END,
  );
}
