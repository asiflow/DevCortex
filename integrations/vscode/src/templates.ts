// ============================================================================
// DevCortex VS Code integration — tasks / MCP / settings templates.
//
// Pure, deterministic builders. They produce the exact data structures that
// `installVscode` writes into a target repository's `.vscode/` directory:
//   - `.vscode/tasks.json`    — VS Code tasks (schema 2.0.0) that run the
//                                DevCortex CLI (init / scan / preflight /
//                                verify / ship).
//   - `.vscode/mcp.json`      — VS Code MCP registry (the `servers` schema, with
//                                `type: "stdio"`) registering `devcortex-mcp`.
//   - `.vscode/settings.json` — a single top-level `devcortex` section holding
//                                the integration's declared configuration.
//
// This is a LIGHTWEIGHT adapter: it does not depend on (or assume) any published
// VS Code extension. It wires the same DevCortex CLI + stdio MCP server the other
// host adapters use into the surfaces VS Code reads natively (task runner, MCP
// registry, workspace settings).
//
// Keeping these side-effect-free makes them trivially testable and lets the CLI
// / other surfaces reuse them without touching the filesystem.
//
// Determinism is load-bearing: `installVscode` compares freshly-built content
// against what is already on disk to decide "unchanged" vs "would change", so
// every builder here MUST be a stable pure function of its inputs.
// ============================================================================

// --- Identity / location constants -----------------------------------------

/** Name under which the DevCortex MCP server is registered in `.vscode/mcp.json`. */
export const DEVCORTEX_MCP_SERVER_NAME = 'devcortex-mcp';
/** Executable that launches the stdio MCP server (see @devcortex/mcp-server bin). */
export const DEVCORTEX_MCP_COMMAND = 'devcortex-mcp';
/** The DevCortex CLI binary the generated tasks invoke. */
export const DEVCORTEX_CLI_BIN = 'devcortex';

/** POSIX-relative directory holding VS Code workspace config inside the target repo. */
export const VSCODE_DIR = '.vscode';
/** POSIX-relative path of the VS Code tasks file. */
export const VSCODE_TASKS_PATH = '.vscode/tasks.json';
/** POSIX-relative path of the VS Code MCP server registry file. */
export const VSCODE_MCP_PATH = '.vscode/mcp.json';
/** POSIX-relative path of the VS Code workspace settings file. */
export const VSCODE_SETTINGS_PATH = '.vscode/settings.json';

/** The only schema version VS Code's `tasks.json` task-array format supports. */
export const VSCODE_TASKS_VERSION = '2.0.0';

/**
 * Label prefix that marks a task as DevCortex-managed. Every generated task's
 * `label` begins with this string, so a merge can strip exactly our own tasks
 * (and no user tasks) before re-appending the fresh set — the basis for
 * byte-level idempotency.
 */
export const DEVCORTEX_TASK_LABEL_PREFIX = 'DevCortex: ';

/**
 * Top-level key under which the DevCortex configuration section lives in
 * `.vscode/settings.json`. This one key IS the "DevCortex section": merging
 * sets it and leaves every other user setting untouched.
 */
export const DEVCORTEX_SETTINGS_KEY = 'devcortex';

// --- Task model -------------------------------------------------------------

/**
 * Declarative description of one DevCortex VS Code task: the CLI subcommand it
 * runs, the human-facing label suffix, and the detail line VS Code shows in the
 * task picker.
 */
export interface DevCortexTaskSpec {
  /** DevCortex CLI subcommand this task runs (verified to exist in the CLI). */
  command: string;
  /** Title-cased suffix appended after {@link DEVCORTEX_TASK_LABEL_PREFIX}. */
  labelSuffix: string;
  /** One-line description VS Code surfaces in the task picker. */
  detail: string;
}

/**
 * The complete DevCortex task set (spec §4.7): the five lifecycle CLI commands
 * surfaced as VS Code tasks. Order is stable so regenerating is byte-idempotent.
 */
export const DEVCORTEX_TASK_SPECS: readonly DevCortexTaskSpec[] = [
  {
    command: 'init',
    labelSuffix: 'Init',
    detail: 'Initialize DevCortex in this repository (creates .devcortex and the project graph).',
  },
  {
    command: 'scan',
    labelSuffix: 'Scan',
    detail: 'Re-scan the repository and refresh the DevCortex project graph.',
  },
  {
    command: 'preflight',
    labelSuffix: 'Preflight',
    detail: 'Load blast radius, protected paths, and known failures before risky edits.',
  },
  {
    command: 'verify',
    labelSuffix: 'Verify',
    detail: 'Run the DevCortex quality gates for the changed area.',
  },
  {
    command: 'ship',
    labelSuffix: 'Ship',
    detail: 'Produce the DevCortex ship report and block unproven "done".',
  },
];

// --- VS Code tasks.json shapes ----------------------------------------------

export interface VscodeTaskPresentation {
  reveal: 'always' | 'silent' | 'never';
  panel: 'shared' | 'dedicated' | 'new';
  clear: boolean;
}

export interface VscodeTask {
  label: string;
  type: 'shell';
  command: string;
  args: string[];
  problemMatcher: string[];
  detail: string;
  presentation: VscodeTaskPresentation;
}

export interface VscodeTasksConfig {
  version: string;
  tasks: VscodeTask[];
}

// --- VS Code mcp.json shapes ------------------------------------------------
//
// VS Code's native MCP config uses a top-level `servers` map (NOT the
// `mcpServers` map used by Claude Code / Cursor), and each stdio server carries
// an explicit `type: "stdio"` discriminator.

export interface VscodeMcpServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
}

export interface VscodeMcpConfig {
  servers: Record<string, VscodeMcpServerEntry>;
}

// --- VS Code settings.json (DevCortex section) shape ------------------------

export interface DevCortexSettingsSection {
  enabled: boolean;
  cli: string;
  mcpServer: string;
  commands: string[];
  discipline: string;
}

// --- Task builders ----------------------------------------------------------

/** Presentation applied to every generated task: reveal terminal, reuse panel. */
function buildTaskPresentation(): VscodeTaskPresentation {
  return { reveal: 'always', panel: 'shared', clear: true };
}

/** Builds a single VS Code task from its declarative spec. */
export function buildDevCortexTask(spec: DevCortexTaskSpec): VscodeTask {
  return {
    label: `${DEVCORTEX_TASK_LABEL_PREFIX}${spec.labelSuffix}`,
    type: 'shell',
    command: DEVCORTEX_CLI_BIN,
    args: [spec.command],
    // Empty matcher list stops VS Code prompting to pick a problem matcher.
    problemMatcher: [],
    detail: spec.detail,
    presentation: buildTaskPresentation(),
  };
}

/** The full ordered list of DevCortex-managed VS Code tasks. */
export function buildDevCortexTasks(): VscodeTask[] {
  return DEVCORTEX_TASK_SPECS.map(buildDevCortexTask);
}

/** A standalone `.vscode/tasks.json` body containing only the DevCortex tasks. */
export function buildTasksConfig(): VscodeTasksConfig {
  return { version: VSCODE_TASKS_VERSION, tasks: buildDevCortexTasks() };
}

// --- MCP builders -----------------------------------------------------------

/** The single MCP server entry that registers the DevCortex stdio server. */
export function buildMcpServerEntry(): VscodeMcpServerEntry {
  return { type: 'stdio', command: DEVCORTEX_MCP_COMMAND, args: [] };
}

/** A standalone `.vscode/mcp.json` body registering only the DevCortex server. */
export function buildMcpConfig(): VscodeMcpConfig {
  return { servers: { [DEVCORTEX_MCP_SERVER_NAME]: buildMcpServerEntry() } };
}

// --- Settings builders ------------------------------------------------------

/**
 * The DevCortex configuration section written under the `devcortex` key of
 * `.vscode/settings.json`. Declarative and self-documenting: it records that the
 * integration is active, which CLI + MCP server back it, which lifecycle
 * commands are wired as tasks, and the discipline the integration enforces.
 */
export function buildDevCortexSettingsSection(): DevCortexSettingsSection {
  return {
    enabled: true,
    cli: DEVCORTEX_CLI_BIN,
    mcpServer: DEVCORTEX_MCP_SERVER_NAME,
    commands: DEVCORTEX_TASK_SPECS.map((spec) => spec.command),
    discipline:
      'Preflight before risky edits, honor protected paths, gate done with verify and ship, ' +
      'and back every claim with evidence.',
  };
}

/** A standalone `.vscode/settings.json` body containing only the DevCortex section. */
export function buildSettingsConfig(): Record<string, unknown> {
  return { [DEVCORTEX_SETTINGS_KEY]: buildDevCortexSettingsSection() };
}

// --- Merge helpers (operate on already-parsed objects) ----------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when a task object was previously installed by DevCortex. */
export function isDevCortexTask(task: unknown): boolean {
  return (
    isPlainObject(task) &&
    typeof task.label === 'string' &&
    task.label.startsWith(DEVCORTEX_TASK_LABEL_PREFIX)
  );
}

/**
 * Merges the DevCortex tasks into an existing `.vscode/tasks.json` object,
 * returning a new object. Foreign tasks and unrelated top-level keys are
 * preserved; any previously-installed DevCortex tasks are stripped and the fresh
 * set is appended (always last → stable), so re-running is a byte-level no-op.
 *
 * A pre-existing `version` string is preserved (VS Code only understands the
 * 2.0.0 task-array schema, but we never silently rewrite the user's declared
 * value); absent, it defaults to {@link VSCODE_TASKS_VERSION}.
 */
export function mergeTasksConfig(existing: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };

  const version = typeof result.version === 'string' ? result.version : VSCODE_TASKS_VERSION;
  const foreignTasks = Array.isArray(result.tasks)
    ? result.tasks.filter((task) => !isDevCortexTask(task))
    : [];

  result.version = version;
  result.tasks = [...foreignTasks, ...buildDevCortexTasks()];
  return result;
}

/**
 * Merges the DevCortex MCP server registration into an existing `.vscode/mcp.json`
 * object, returning a new object. Other servers, the `inputs` array, and any
 * other top-level keys are preserved; the DevCortex entry is set deterministically
 * (idempotent).
 */
export function mergeMcpConfig(existing: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...existing };
  const existingServers = isPlainObject(result.servers) ? result.servers : {};
  result.servers = {
    ...existingServers,
    [DEVCORTEX_MCP_SERVER_NAME]: buildMcpServerEntry(),
  };
  return result;
}

/**
 * Merges the DevCortex section into an existing `.vscode/settings.json` object,
 * returning a new object. Every user setting is preserved; only the top-level
 * `devcortex` key is set (deterministic → idempotent).
 */
export function mergeSettings(existing: Record<string, unknown>): Record<string, unknown> {
  return { ...existing, [DEVCORTEX_SETTINGS_KEY]: buildDevCortexSettingsSection() };
}
