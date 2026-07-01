// ============================================================================
// DevCortex Claude Code integration — settings / MCP / hook-shim templates.
//
// Pure, deterministic builders. They produce the exact data structures and
// shell scripts that `installClaude` writes into a target repository. Keeping
// them side-effect-free makes them trivially testable and lets the CLI / other
// surfaces reuse them without touching the filesystem.
//
// Determinism is load-bearing: `installClaude` compares freshly-built content
// against what is already on disk to decide "unchanged" vs "would change", so
// every builder here MUST be a stable pure function of its inputs.
// ============================================================================

// --- Identity / location constants -----------------------------------------

/** Name under which the DevCortex MCP server is registered in `.mcp.json`. */
export const DEVCORTEX_MCP_SERVER_NAME = 'devcortex-mcp';
/** Executable that launches the stdio MCP server (see @devcortex/mcp-server bin). */
export const DEVCORTEX_MCP_COMMAND = 'devcortex-mcp';
/** The DevCortex CLI binary the hook shims invoke. */
export const DEVCORTEX_CLI_BIN = 'devcortex';

/** POSIX-relative location of the generated hook shims inside the target repo. */
export const HOOK_SHIM_DIR = '.claude/hooks';
/** POSIX-relative path of the Claude Code project settings file. */
export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';
/** POSIX-relative path of the MCP server registry file. */
export const MCP_CONFIG_PATH = '.mcp.json';

/**
 * Substring used to recognise a hook command that DevCortex previously installed.
 * Every generated settings command points at a shim under {@link HOOK_SHIM_DIR}
 * named `devcortex-*`, so this marker uniquely identifies our own groups during
 * an idempotent merge.
 */
export const DEVCORTEX_HOOK_MARKER = `${HOOK_SHIM_DIR}/devcortex-`;

/** Claude Code tool matcher for the code-mutating tools we guard / observe. */
export const MUTATING_TOOL_MATCHER = 'Edit|Write|Bash';

// --- Hook lifecycle model ---------------------------------------------------

export const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * Declarative description of one DevCortex hook: which Claude Code event it
 * binds to, the shim file it writes, the CLI command that shim wraps, and
 * whether the shim is permitted to propagate a deliberate block (exit 2) or
 * must always fail open (exit 0).
 */
export interface HookShimSpec {
  event: HookEvent;
  /** File name written under {@link HOOK_SHIM_DIR}. */
  fileName: string;
  /** CLI invocation the shim wraps (passed verbatim to `sh`). */
  cliCommand: string;
  /** Tool-name matcher; only set for tool-scoped events (PreToolUse/PostToolUse). */
  matcher?: string;
  /**
   * When true the shim propagates exit code 2 — a deliberate, explained policy
   * block. When false the shim ALWAYS exits 0 (pure passive observation).
   */
  canBlock: boolean;
  /** Human description embedded in the generated shim header. */
  description: string;
}

/**
 * The complete DevCortex hook set, per spec section 8:
 *  - UserPromptSubmit → `devcortex preflight --json` (inject CORTEX PREFLIGHT)
 *  - PreToolUse (Edit|Write|Bash) → guarded-mode protected-path check
 *  - PostToolUse (Edit|Write|Bash) → evidence recording + graph delta
 *  - Stop → `devcortex ship --json` (emit SHIP STATUS, block unproven done)
 */
export const HOOK_SHIMS: readonly HookShimSpec[] = [
  {
    event: 'UserPromptSubmit',
    fileName: 'devcortex-preflight.sh',
    cliCommand: `${DEVCORTEX_CLI_BIN} preflight --json`,
    canBlock: false,
    description: 'Injects a compact CORTEX PREFLIGHT context block before each user prompt.',
  },
  {
    event: 'PreToolUse',
    fileName: 'devcortex-guard.sh',
    cliCommand: `${DEVCORTEX_CLI_BIN} guard --json`,
    matcher: MUTATING_TOOL_MATCHER,
    canBlock: true,
    description: 'Guarded-mode protected-path check before Edit / Write / Bash tool calls.',
  },
  {
    event: 'PostToolUse',
    fileName: 'devcortex-postuse.sh',
    cliCommand: `${DEVCORTEX_CLI_BIN} record-evidence --json`,
    matcher: MUTATING_TOOL_MATCHER,
    canBlock: false,
    description: 'Records evidence and a project-graph delta after Edit / Write / Bash tool calls.',
  },
  {
    event: 'Stop',
    fileName: 'devcortex-ship.sh',
    cliCommand: `${DEVCORTEX_CLI_BIN} ship --json`,
    canBlock: true,
    description: 'Emits CORTEX SHIP STATUS and blocks unproven "done" when configured.',
  },
];

// --- Claude Code settings.json shapes ---------------------------------------

export interface ClaudeHookCommand {
  type: 'command';
  command: string;
}

export interface ClaudeHookGroup {
  /** Optional tool-name regex; omitted for non-tool events. */
  matcher?: string;
  hooks: ClaudeHookCommand[];
}

/** Map of Claude Code event name -> ordered list of matcher groups. */
export type ClaudeHooks = Record<string, ClaudeHookGroup[]>;

// --- MCP registry shapes ----------------------------------------------------

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

// --- Builders ---------------------------------------------------------------

/**
 * The shell command string placed in `settings.json` for a given shim. Uses
 * `$CLAUDE_PROJECT_DIR` (set by Claude Code to the project root) and quotes the
 * path so directories containing spaces still resolve.
 */
export function hookShimCommand(spec: HookShimSpec): string {
  return `"$CLAUDE_PROJECT_DIR/${HOOK_SHIM_DIR}/${spec.fileName}"`;
}

/**
 * Builds the DevCortex `hooks` fragment for `settings.json`: one matcher group
 * per managed event, each invoking the corresponding fail-open shim.
 */
export function buildSettingsHooks(): ClaudeHooks {
  const hooks: ClaudeHooks = {};
  for (const spec of HOOK_SHIMS) {
    const group: ClaudeHookGroup =
      spec.matcher !== undefined
        ? { matcher: spec.matcher, hooks: [{ type: 'command', command: hookShimCommand(spec) }] }
        : { hooks: [{ type: 'command', command: hookShimCommand(spec) }] };
    (hooks[spec.event] ??= []).push(group);
  }
  return hooks;
}

/** The single MCP server entry that registers the DevCortex stdio server. */
export function buildMcpServerEntry(): McpServerEntry {
  return { command: DEVCORTEX_MCP_COMMAND, args: [], env: {} };
}

/** A standalone `.mcp.json` body registering only the DevCortex server. */
export function buildMcpConfig(): McpConfig {
  return { mcpServers: { [DEVCORTEX_MCP_SERVER_NAME]: buildMcpServerEntry() } };
}

/**
 * Generates a hook shim shell script.
 *
 * FAIL-OPEN CONTRACT (binding, spec section 8): any internal DevCortex failure
 * — crash, missing binary, or any non-zero exit other than a deliberate block —
 * degrades to passive mode (exit 0) so the host agent is never blocked by a
 * DevCortex malfunction. Shims whose {@link HookShimSpec.canBlock} is true
 * additionally propagate exit code 2 (an intentional, explained policy block,
 * which Claude Code honours); all others always exit 0.
 */
export function buildHookShim(spec: HookShimSpec): string {
  const header: string[] = [
    '#!/usr/bin/env sh',
    `# DevCortex Claude Code hook — ${spec.event}`,
    '#',
    `# ${spec.description}`,
    '#',
    '# AUTO-GENERATED by `devcortex install claude`. Safe to delete or regenerate.',
    '#',
    '# FAIL-OPEN CONTRACT: any internal DevCortex failure (crash, missing binary,',
    '# or non-zero exit) degrades to passive mode (exit 0) so the host agent is',
    '# never blocked by a DevCortex malfunction.',
  ];

  const body: string[] = [];

  if (spec.canBlock) {
    header.push(
      '# Only a deliberate, explained policy block (exit code 2, which Claude Code',
      '# honours) is propagated.',
    );
    body.push(
      'set -u',
      '',
      '# Run the DevCortex CLI; stdin/stdout/stderr pass through to the host agent.',
      spec.cliCommand,
      'status=$?',
      '',
      '# Propagate ONLY an intentional block (exit 2). Any other non-zero exit is an',
      '# internal failure and MUST fail open so the agent is never blocked spuriously.',
      'if [ "$status" -eq 2 ]; then',
      '  exit 2',
      'fi',
      'exit 0',
    );
  } else {
    body.push(
      'set -u',
      '',
      '# Run the DevCortex CLI; stdin/stdout/stderr pass through to the host agent.',
      '# `|| true` swallows every failure so this passive hook can never block.',
      `${spec.cliCommand} || true`,
      'exit 0',
    );
  }

  return `${[...header, '', ...body].join('\n')}\n`;
}

// --- Merge helpers (operate on already-parsed objects) ----------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a hook group was previously installed by DevCortex. */
export function isDevCortexHookGroup(group: unknown): boolean {
  if (!isPlainObject(group)) return false;
  const { hooks } = group;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      isPlainObject(h) && typeof h.command === 'string' && h.command.includes(DEVCORTEX_HOOK_MARKER),
  );
}

/**
 * Merges DevCortex hooks into an existing Claude Code settings object,
 * returning a new object. Non-DevCortex content (other events, other groups,
 * unrelated top-level keys) is preserved untouched. Re-running the merge is a
 * no-op at the byte level: previously-installed DevCortex groups are stripped
 * and re-appended deterministically, so the function is idempotent.
 */
export function mergeSettings(existing: Record<string, unknown>): Record<string, unknown> {
  const fresh = buildSettingsHooks();
  const result: Record<string, unknown> = { ...existing };

  const existingHooks = isPlainObject(result.hooks) ? result.hooks : {};
  const mergedHooks: Record<string, unknown> = {};

  // 1. Carry over every existing event in original order, stripping any group
  //    DevCortex installed previously. Unrecognised (non-array) values are
  //    preserved verbatim so we never silently drop user data.
  for (const [event, groups] of Object.entries(existingHooks)) {
    mergedHooks[event] = Array.isArray(groups)
      ? groups.filter((g) => !isDevCortexHookGroup(g))
      : groups;
  }

  // 2. Append our fresh group for each managed event (always last → stable).
  for (const event of HOOK_EVENTS) {
    const carried = mergedHooks[event];
    const base = Array.isArray(carried) ? carried : [];
    const freshGroups = fresh[event] ?? [];
    mergedHooks[event] = [...base, ...freshGroups];
  }

  result.hooks = mergedHooks;
  return result;
}

/**
 * Merges the DevCortex MCP server registration into an existing `.mcp.json`
 * object, returning a new object. Other servers and top-level keys are
 * preserved; the DevCortex entry is set deterministically (idempotent).
 */
export function mergeMcpConfig(existing: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const existingServers = isPlainObject(result.mcpServers) ? result.mcpServers : {};
  result.mcpServers = {
    ...existingServers,
    [DEVCORTEX_MCP_SERVER_NAME]: buildMcpServerEntry(),
  };
  return result;
}
