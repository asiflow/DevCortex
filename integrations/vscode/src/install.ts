// ============================================================================
// DevCortex VS Code installer.
//
// `installVscode(targetRoot, { force })` writes / merges the DevCortex VS Code
// configuration into a target repository's `.vscode/` directory:
//   - `.vscode/tasks.json`    — VS Code tasks (schema 2.0.0) running the
//                                DevCortex CLI (init / scan / preflight /
//                                verify / ship). Merged: foreign tasks survive.
//   - `.vscode/mcp.json`      — registers the `devcortex-mcp` stdio server in
//                                VS Code's native MCP registry. Merged: foreign
//                                servers survive.
//   - `.vscode/settings.json` — a top-level `devcortex` configuration section.
//                                Merged: every other workspace setting survives.
//
// Confirm-before-overwrite: if any pre-existing target file would change and
// `force` is not set, NOTHING is written and a plan describing the changes is
// returned instead. A fresh install (no conflicting files) applies directly.
//
// This is an install-time operation invoked deliberately by the user, so it is
// strict: a malformed existing `.vscode/*.json` (invalid JSON, or a `tasks` /
// `servers` key with the wrong shape) throws a DevCortexError rather than being
// silently overwritten.
// ============================================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError, DevCortexError } from '@devcortex/core';
import {
  buildMcpConfig,
  buildSettingsConfig,
  buildTasksConfig,
  mergeMcpConfig,
  mergeSettings,
  mergeTasksConfig,
  VSCODE_MCP_PATH,
  VSCODE_SETTINGS_PATH,
  VSCODE_TASKS_PATH,
} from './templates';

// --- Public result types ----------------------------------------------------

export interface InstallVscodeOptions {
  /** Overwrite/merge pre-existing files instead of returning a plan. */
  force?: boolean;
}

export type InstallFileAction = 'create' | 'merge' | 'unchanged';
export type InstallChangeAction = Exclude<InstallFileAction, 'unchanged'>;

export interface InstalledFile {
  /** Absolute path of the file. */
  path: string;
  action: InstallFileAction;
}

export interface InstallPlanItem {
  /** Absolute path of the file that would be created or changed. */
  path: string;
  action: InstallChangeAction;
  reason: string;
}

export type InstallResult =
  | { status: 'applied'; root: string; files: InstalledFile[] }
  | { status: 'plan'; root: string; plan: InstallPlanItem[]; reason: string };

// --- Internal model ----------------------------------------------------------

type ManagedRole = 'tasks' | 'mcp' | 'settings';

interface ManagedFile {
  absPath: string;
  /** Path relative to root, for human-readable messages. */
  relPath: string;
  role: ManagedRole;
  /** Exact bytes that should be on disk. */
  desired: string;
  exists: boolean;
  current: string | null;
}

// --- Boundary validation schemas (zod) --------------------------------------
//
// We validate only the SHAPE we merge into: `tasks` (tasks.json) and `servers`
// (mcp.json) must, if present, be an array / object respectively. `looseObject`
// preserves every other key so merging never drops unrelated user config.
// `settings.json` needs no sub-shape check — the DevCortex section fully owns its
// one key — so it is validated only as a JSON object by `parseJsonObject`.

const tasksFileSchema = z.looseObject({
  version: z.string().optional(),
  tasks: z.array(z.unknown()).optional(),
});

const mcpFileSchema = z.looseObject({
  servers: z.record(z.string(), z.unknown()).optional(),
});

// --- Filesystem helpers ------------------------------------------------------

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

async function readFileIfExists(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return null;
    throw new DevCortexError('INTERNAL', `Failed to read ${absPath}.`, { cause: err });
  }
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Failed to create directory ${dir}.`, { cause: err });
  }
}

async function writeManagedFile(file: ManagedFile): Promise<void> {
  await ensureDir(dirname(file.absPath));
  try {
    await writeFile(file.absPath, file.desired, { encoding: 'utf8', mode: 0o644 });
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Failed to write ${file.absPath}.`, { cause: err });
  }
}

// --- JSON parsing / serialisation -------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, relPath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Existing ${relPath} is not valid JSON; refusing to overwrite it.`, {
      cause: err,
    });
  }
  if (!isPlainObject(value)) {
    const found = Array.isArray(value) ? 'array' : typeof value;
    throw new ConfigError(`Existing ${relPath} must be a JSON object but is a ${found}.`);
  }
  return value;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** Canonical on-disk JSON form: 2-space indent, trailing newline. */
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// --- Desired-state computation ----------------------------------------------

async function buildTasksManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, ...VSCODE_TASKS_PATH.split('/'));
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);

  let desiredObject: Record<string, unknown>;
  if (current === null) {
    desiredObject = buildTasksConfig() as unknown as Record<string, unknown>;
  } else {
    const parsed = parseJsonObject(current, relPath);
    const validated = tasksFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw new ConfigError(
        `Existing ${relPath} has an invalid \`tasks\` shape; refusing to overwrite it (${formatZodIssues(
          validated.error,
        )}).`,
        { details: validated.error.issues },
      );
    }
    desiredObject = mergeTasksConfig(parsed);
  }

  return {
    absPath,
    relPath,
    role: 'tasks',
    desired: serializeJson(desiredObject),
    exists: current !== null,
    current,
  };
}

async function buildMcpManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, ...VSCODE_MCP_PATH.split('/'));
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);

  let desiredObject: Record<string, unknown>;
  if (current === null) {
    desiredObject = buildMcpConfig() as unknown as Record<string, unknown>;
  } else {
    const parsed = parseJsonObject(current, relPath);
    const validated = mcpFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw new ConfigError(
        `Existing ${relPath} has an invalid \`servers\` shape; refusing to overwrite it (${formatZodIssues(
          validated.error,
        )}).`,
        { details: validated.error.issues },
      );
    }
    desiredObject = mergeMcpConfig(parsed);
  }

  return {
    absPath,
    relPath,
    role: 'mcp',
    desired: serializeJson(desiredObject),
    exists: current !== null,
    current,
  };
}

async function buildSettingsManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, ...VSCODE_SETTINGS_PATH.split('/'));
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);

  const desiredObject =
    current === null ? buildSettingsConfig() : mergeSettings(parseJsonObject(current, relPath));

  return {
    absPath,
    relPath,
    role: 'settings',
    desired: serializeJson(desiredObject),
    exists: current !== null,
    current,
  };
}

async function computeManagedFiles(root: string): Promise<ManagedFile[]> {
  return Promise.all([
    buildTasksManagedFile(root),
    buildMcpManagedFile(root),
    buildSettingsManagedFile(root),
  ]);
}

// --- Action classification ---------------------------------------------------

function wouldChange(file: ManagedFile): boolean {
  return file.exists && file.current !== file.desired;
}

/**
 * Label for a file whose content is being created or changed. Every VS Code
 * managed file is merged (never overwritten wholesale): foreign tasks, foreign
 * MCP servers, and foreign settings are always preserved.
 */
function changeAction(file: ManagedFile): InstallChangeAction {
  return file.exists ? 'merge' : 'create';
}

function planReason(file: ManagedFile): string {
  if (!file.exists) return `${file.relPath} does not exist yet and would be created`;
  return `${file.relPath} already exists and would be merged; re-run with { force: true } to apply`;
}

// --- Public entry point ------------------------------------------------------

/**
 * Installs (or plans the installation of) the DevCortex VS Code integration into
 * `targetRoot`: the `.vscode/tasks.json` CLI tasks, the `.vscode/mcp.json`
 * `devcortex-mcp` registration, and the `devcortex` section of
 * `.vscode/settings.json`.
 *
 * @throws {ConfigError} when an existing `.vscode/*.json` is not valid JSON or a
 *   merged key (`tasks` / `servers`) has an incompatible shape (never silently
 *   overwritten).
 * @throws {DevCortexError} on unexpected filesystem failures or an empty target
 *   root.
 */
export async function installVscode(
  targetRoot: string,
  options: InstallVscodeOptions = {},
): Promise<InstallResult> {
  if (typeof targetRoot !== 'string' || targetRoot.trim() === '') {
    throw new DevCortexError('INTERNAL', 'installVscode requires a non-empty target root path.');
  }

  const force = options.force ?? false;
  const root = resolve(targetRoot);
  const files = await computeManagedFiles(root);

  // Confirm-before-overwrite: any pre-existing file that would change blocks an
  // implicit apply. Emit a plan covering every create/merge, write nothing.
  const conflicts = files.filter(wouldChange);
  if (!force && conflicts.length > 0) {
    const plan: InstallPlanItem[] = [];
    for (const file of files) {
      if (!file.exists || wouldChange(file)) {
        plan.push({ path: file.absPath, action: changeAction(file), reason: planReason(file) });
      }
    }
    return {
      status: 'plan',
      root,
      plan,
      reason: `${conflicts.length} existing file(s) would change. Pass { force: true } to apply.`,
    };
  }

  // Apply: write everything whose content differs from disk; report unchanged
  // files without rewriting them (idempotent).
  const written: InstalledFile[] = [];
  for (const file of files) {
    if (file.exists && file.current === file.desired) {
      written.push({ path: file.absPath, action: 'unchanged' });
      continue;
    }
    await writeManagedFile(file);
    written.push({ path: file.absPath, action: changeAction(file) });
  }

  return { status: 'applied', root, files: written };
}
