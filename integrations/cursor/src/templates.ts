// ============================================================================
// DevCortex Cursor integration — project-rule (.mdc) / MCP templates.
//
// Pure, deterministic builders. They produce the exact byte content that
// `installCursor` writes into a target repository:
//   - `.cursor/rules/devcortex.mdc` — a Cursor project rule in MDC format
//     (YAML frontmatter + rule body) embedding the DevCortex discipline.
//   - `.cursor/mcp.json`            — registers the `devcortex-mcp` stdio server.
//
// Keeping these side-effect-free makes them trivially testable and lets the CLI
// / other surfaces reuse them without touching the filesystem.
//
// Determinism is load-bearing: `installCursor` compares freshly-built content
// against what is already on disk to decide "unchanged" vs "would change", so
// every builder here MUST be a stable pure function of its inputs.
// ============================================================================

// --- Identity / location constants -----------------------------------------

/** Name under which the DevCortex MCP server is registered in `.cursor/mcp.json`. */
export const DEVCORTEX_MCP_SERVER_NAME = 'devcortex-mcp';
/** Executable that launches the stdio MCP server (see @devcortex/mcp-server bin). */
export const DEVCORTEX_MCP_COMMAND = 'devcortex-mcp';
/** The DevCortex CLI binary the discipline rule references. */
export const DEVCORTEX_CLI_BIN = 'devcortex';

/** POSIX-relative directory holding Cursor project rules inside the target repo. */
export const CURSOR_RULES_DIR = '.cursor/rules';
/** POSIX-relative path of the DevCortex Cursor project rule (MDC format). */
export const CURSOR_RULE_PATH = '.cursor/rules/devcortex.mdc';
/** POSIX-relative path of the Cursor MCP server registry file. */
export const CURSOR_MCP_PATH = '.cursor/mcp.json';
/** Logical name of the DevCortex rule (the `.mdc` file's stem). */
export const CURSOR_RULE_NAME = 'devcortex';

/**
 * One-line summary Cursor surfaces in its rule picker. Kept short and stable so
 * regenerating the rule is byte-idempotent.
 */
export const CURSOR_RULE_DESCRIPTION =
  'DevCortex engineering discipline for Cursor: run preflight before risky edits, ' +
  'honor protected paths, gate done with verify and ship, and back every claim with evidence.';

/**
 * `alwaysApply: true` makes this a Cursor "Always" rule — injected into every
 * request's context regardless of which files are open, which is what the
 * DevCortex discipline needs to be effective.
 */
export const CURSOR_RULE_ALWAYS_APPLY = true;

// --- MCP registry shapes ----------------------------------------------------

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

// --- Cursor rule (.mdc) shapes ----------------------------------------------

/** Parsed representation of the DevCortex rule's YAML frontmatter. */
export interface CursorRuleFrontmatter {
  description: string;
  alwaysApply: boolean;
}

// --- MCP builders -----------------------------------------------------------

/** The single MCP server entry that registers the DevCortex stdio server. */
export function buildMcpServerEntry(): McpServerEntry {
  return { command: DEVCORTEX_MCP_COMMAND, args: [], env: {} };
}

/** A standalone `.cursor/mcp.json` body registering only the DevCortex server. */
export function buildMcpConfig(): McpConfig {
  return { mcpServers: { [DEVCORTEX_MCP_SERVER_NAME]: buildMcpServerEntry() } };
}

// --- Merge helpers (operate on already-parsed objects) ----------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merges the DevCortex MCP server registration into an existing `.cursor/mcp.json`
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

// --- Cursor rule (.mdc) builders --------------------------------------------

/**
 * Escapes a string as a YAML double-quoted scalar. Double-quoted scalars are
 * the only YAML flow style that can represent every possible string safely, so
 * frontmatter stays valid regardless of the description's characters.
 */
function yamlDoubleQuoted(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** The frontmatter object Cursor reads to decide how/when to apply the rule. */
export function buildCursorRuleFrontmatter(): CursorRuleFrontmatter {
  return { description: CURSOR_RULE_DESCRIPTION, alwaysApply: CURSOR_RULE_ALWAYS_APPLY };
}

/**
 * Serialises the frontmatter to the exact YAML block (without the surrounding
 * `---` fences) that the rule file embeds. Deterministic key order.
 */
export function serializeCursorFrontmatter(frontmatter: CursorRuleFrontmatter): string {
  return [
    `description: ${yamlDoubleQuoted(frontmatter.description)}`,
    `alwaysApply: ${frontmatter.alwaysApply ? 'true' : 'false'}`,
  ].join('\n');
}

/**
 * The Markdown rule body embedding the DevCortex discipline. Written so a Cursor
 * agent, reading it as always-on context, mirrors the same lifecycle DevCortex
 * enforces through hooks on Claude Code: preflight before risky edits, respect
 * protected paths, prove "done" with verify/ship, and prefer evidence over
 * claims. The `devcortex-mcp` MCP server exposes these as callable tools.
 */
export function buildCursorRuleBody(): string {
  return [
    '# DevCortex Engineering Discipline',
    '',
    'DevCortex is the local-first cognitive layer for this repository. Follow this',
    'discipline on every task. The `devcortex` CLI and the `devcortex-mcp` MCP',
    'server (registered in `.cursor/mcp.json`) expose these steps as tools — prefer',
    'calling them over guessing.',
    '',
    '## 1. Preflight before risky edits',
    '',
    'Before editing code, changing dependencies, running migrations, or touching',
    'infrastructure, gather context first. Run `devcortex preflight` (or the',
    "`preflight` MCP tool) to load the project graph, blast radius, and known",
    'failures for the area you are about to change. Understand the impact before',
    'you mutate anything.',
    '',
    '## 2. Honor protected paths',
    '',
    'Some paths are protected by DevCortex policy (secrets, generated artifacts,',
    'migrations, CI, infra). Never edit a protected path silently. Run',
    '`devcortex guard` (or the `guard` MCP tool) on the change first; if it reports',
    'a protected-path violation, stop and get explicit human approval before',
    'proceeding. Do not work around the guard.',
    '',
    '## 3. Gate "done" with verify and ship',
    '',
    'A task is not done because the code looks right. Before you claim completion:',
    '',
    '- Run `devcortex verify` to run the quality gates for the changed area.',
    '- Run `devcortex ship` to produce the ship report and confirm every gate',
    '  passes. If `ship` blocks on unproven work, the task is NOT done — resolve',
    '  the blocking gate, do not override it.',
    '',
    'Record evidence for what you changed (`devcortex record-evidence` / the',
    '`record-evidence` MCP tool) so the ship check can see proof, not assertions.',
    '',
    '## 4. Evidence over claims',
    '',
    'Never state that something works, is fixed, is deployed, or is tested unless',
    'you have observed it. Cite the concrete evidence: the file and line you',
    'changed, the exact command you ran, and its real output. "It should work" is',
    'not evidence. If you have not verified a claim, say so explicitly instead of',
    'asserting it.',
    '',
    '## Summary',
    '',
    'Preflight -> guard protected paths -> implement -> record evidence ->',
    'verify -> ship. Evidence gates every "done".',
    '',
  ].join('\n');
}

/**
 * The complete `.cursor/rules/devcortex.mdc` file: `---`-fenced YAML frontmatter
 * followed by the Markdown rule body. Ends with a single trailing newline so the
 * on-disk form is canonical and byte-idempotent.
 */
export function buildCursorRule(): string {
  const frontmatter = serializeCursorFrontmatter(buildCursorRuleFrontmatter());
  const body = buildCursorRuleBody();
  return `---\n${frontmatter}\n---\n\n${body}`.replace(/\n*$/, '\n');
}
