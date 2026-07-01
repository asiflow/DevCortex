// ============================================================================
// Safe MCP Manager (§7.19) — host `.mcp.json` configuration I/O.
//
// `.mcp.json` at the repo root is the MCP host's project-scoped server config
// (`{ "mcpServers": { "<id>": { command, args, env } } }`). The manager reads,
// merges, and writes it while:
//  - preserving every foreign top-level key and every foreign server entry
//    (DevCortex governs, it does not clobber a user's hand-authored servers);
//  - writing new entries with a DEFAULT-READ-ONLY posture — env values are
//    always empty placeholders (never real secrets), and a namespaced
//    `devcortex` annotation records which tool scopes auto-approve (reads) vs
//    require approval (writes/destructive), so the read-only intent survives on
//    disk and is enforceable by the firewall;
//  - writing atomically (temp file + rename) so a crash never truncates config.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { DevCortexError, SchemaValidationError } from '../domain';
import type { McpServerSpec, McpTrust } from '../domain';
import { workspacePaths } from '../workspace';

// --- shapes -----------------------------------------------------------------

/**
 * DevCortex governance annotation embedded in a managed server entry. Hosts
 * ignore unknown keys, so this rides alongside the standard fields without
 * breaking the host, while making the read-only posture explicit and auditable.
 */
export interface DevcortexAnnotation {
  managedBy: 'devcortex';
  posture: 'read-only';
  trust: McpTrust;
  /** tool identifiers safe to auto-run (read + non-destructive) */
  autoApprove: string[];
  /** tool identifiers that must pause for approval (write or destructive) */
  requireApproval: string[];
  /** repo-relative path of the recorded McpServerSpec under .cortex/mcp/ */
  specPath: string;
}

/** A single server entry in `.mcp.json`. Foreign keys are preserved verbatim. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  devcortex?: DevcortexAnnotation;
  [key: string]: unknown;
}

/** The parsed `.mcp.json` document. Foreign top-level keys are preserved. */
export interface McpJson {
  mcpServers: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// --- paths ------------------------------------------------------------------

/** Absolute path of the host `.mcp.json` for a repo root. */
export function mcpJsonPath(root: string): string {
  return path.join(workspacePaths(root).root, '.mcp.json');
}

// --- read -------------------------------------------------------------------

/**
 * Read and normalise `<root>/.mcp.json`.
 *
 * A missing file is not an error — it yields an empty, well-formed document so
 * callers can merge into it unconditionally. A present-but-malformed file (not
 * JSON, not an object, or a non-object `mcpServers`) throws
 * {@link SchemaValidationError} rather than silently discarding a user's config.
 */
export async function readMcpJson(root: string): Promise<McpJson> {
  const file = mcpJsonPath(root);

  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { mcpServers: {} };
    }
    throw new DevCortexError('INTERNAL', `Unable to read MCP host config at ${file}.`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SchemaValidationError(`The MCP host config at ${file} is not valid JSON.`, {
      cause: err,
    });
  }

  if (!isRecord(parsed)) {
    throw new SchemaValidationError(`The MCP host config at ${file} must be a JSON object.`);
  }

  const rawServers = parsed['mcpServers'];
  if (rawServers !== undefined && !isRecord(rawServers)) {
    throw new SchemaValidationError(
      `The "mcpServers" field in ${file} must be an object of server entries.`,
    );
  }

  const servers: Record<string, McpServerEntry> = {};
  if (isRecord(rawServers)) {
    for (const [id, entry] of Object.entries(rawServers)) {
      if (!isRecord(entry)) {
        throw new SchemaValidationError(
          `The server entry "${id}" in ${file} must be an object.`,
        );
      }
      servers[id] = entry as McpServerEntry;
    }
  }

  // Preserve foreign top-level keys; overwrite the normalised mcpServers.
  return { ...parsed, mcpServers: servers };
}

// --- write ------------------------------------------------------------------

/**
 * Atomically write `data` to `<root>/.mcp.json` (temp file + rename in the same
 * directory), pretty-printed with a trailing newline.
 *
 * @throws DevCortexError `INTERNAL` when the file cannot be written.
 */
export async function writeMcpJson(root: string, data: McpJson): Promise<void> {
  const file = mcpJsonPath(root);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.mcp.${randomUUID()}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw new DevCortexError('INTERNAL', `Unable to write MCP host config to ${file}.`, {
      cause: err,
    });
  }
}

// --- entry construction -----------------------------------------------------

/**
 * Build the `.mcp.json` entry for a catalog `spec`, applying the default
 * read-only posture: the launch command/args are parsed from the spec's
 * `installCommand`, every required secret is written as an EMPTY env placeholder
 * (never a value), and a `devcortex` annotation records the read/approval split.
 *
 * `specPath` is the repo-relative location of the recorded McpServerSpec, so an
 * auditor can trace the host entry back to the governed spec.
 */
export function buildServerEntry(spec: McpServerSpec, specPath: string): McpServerEntry {
  const { command, args } = parseInstallCommand(spec.installCommand);

  const env: Record<string, string> = {};
  for (const name of spec.secretsRequired) {
    // Placeholder only — the user fills these in; DevCortex never writes secrets.
    env[name] = '';
  }

  const autoApprove: string[] = [];
  const requireApproval: string[] = [];
  for (const tool of spec.tools) {
    const identifier = `${spec.id}.${tool.name}`;
    if (tool.access === 'write' || tool.destructive) {
      requireApproval.push(identifier);
    } else {
      autoApprove.push(identifier);
    }
  }

  const annotation: DevcortexAnnotation = {
    managedBy: 'devcortex',
    posture: 'read-only',
    trust: spec.trust,
    autoApprove,
    requireApproval,
    specPath,
  };

  const entry: McpServerEntry = { devcortex: annotation };
  if (command !== undefined) {
    entry.command = command;
    entry.args = args;
  }
  if (Object.keys(env).length > 0) {
    entry.env = env;
  }
  return entry;
}

/**
 * Split an install command string into `{ command, args }`. An absent command
 * yields `{ command: undefined, args: [] }` (e.g. a purely hosted server the
 * user wires up manually). Extra whitespace is collapsed.
 */
export function parseInstallCommand(installCommand: string | undefined): {
  command: string | undefined;
  args: string[];
} {
  if (installCommand === undefined) {
    return { command: undefined, args: [] };
  }
  const parts = installCommand.trim().split(/\s+/u).filter((part) => part.length > 0);
  const [command, ...args] = parts;
  return { command, args };
}

// --- helpers ----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
