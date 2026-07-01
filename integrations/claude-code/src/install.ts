// ============================================================================
// DevCortex Claude Code installer.
//
// `installClaude(targetRoot, { force })` writes / merges the DevCortex hook
// configuration into a target repository:
//   - `.claude/settings.json`  — lifecycle hooks (merged, never clobbering the
//                                 user's own hooks or unrelated settings)
//   - `.mcp.json`              — registers the `devcortex-mcp` stdio server
//   - `.claude/hooks/*.sh`     — fail-open shim scripts the settings point at
//
// Confirm-before-overwrite: if any pre-existing target file would change and
// `force` is not set, NOTHING is written and a plan describing the changes is
// returned instead. A fresh install (no conflicting files) applies directly.
//
// This is an install-time operation invoked deliberately by the user, so it is
// strict: malformed existing config throws a DevCortexError rather than being
// silently overwritten. (The fail-open contract applies to the generated hook
// shims at runtime, not to this installer.)
// ============================================================================

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ConfigError, DevCortexError } from '@devcortex/core';
import type { HookShimSpec } from './templates';
import {
  buildHookShim,
  buildMcpConfig,
  HOOK_SHIMS,
  mergeMcpConfig,
  mergeSettings,
} from './templates';

// --- Public result types ----------------------------------------------------

export interface InstallClaudeOptions {
  /** Overwrite/merge pre-existing files instead of returning a plan. */
  force?: boolean;
}

export type InstallFileAction = 'create' | 'merge' | 'overwrite' | 'unchanged';
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

type ManagedRole = 'settings' | 'mcp' | 'shim';

interface ManagedFile {
  absPath: string;
  /** Path relative to root, for human-readable messages. */
  relPath: string;
  role: ManagedRole;
  /** Exact bytes that should be on disk. */
  desired: string;
  exists: boolean;
  current: string | null;
  /** POSIX mode bits to write with (shims are executable). */
  mode: number;
}

// --- Boundary validation schemas (zod) --------------------------------------
//
// We validate only the SHAPE we touch: `hooks` (settings) and `mcpServers`
// (mcp) must, if present, be objects. `looseObject` preserves every other key
// so merging never drops unrelated user configuration.

const settingsFileSchema = z.looseObject({
  hooks: z.record(z.string(), z.unknown()).optional(),
});

const mcpFileSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional(),
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
    await writeFile(file.absPath, file.desired, { encoding: 'utf8', mode: file.mode });
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Failed to write ${file.absPath}.`, { cause: err });
  }
  // `writeFile`'s mode only applies on creation; force the executable bit when
  // overwriting a pre-existing shim that may have a non-executable mode.
  if ((file.mode & 0o111) !== 0) {
    try {
      await chmod(file.absPath, file.mode);
    } catch (err) {
      throw new DevCortexError('INTERNAL', `Failed to set mode on ${file.absPath}.`, {
        cause: err,
      });
    }
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

async function buildSettingsManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, '.claude', 'settings.json');
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);

  let desiredObject: Record<string, unknown>;
  if (current === null) {
    desiredObject = mergeSettings({});
  } else {
    const parsed = parseJsonObject(current, relPath);
    const validated = settingsFileSchema.safeParse(parsed);
    if (!validated.success) {
      throw new ConfigError(
        `Existing ${relPath} has an invalid \`hooks\` shape; refusing to overwrite it (${formatZodIssues(
          validated.error,
        )}).`,
        { details: validated.error.issues },
      );
    }
    desiredObject = mergeSettings(parsed);
  }

  return {
    absPath,
    relPath,
    role: 'settings',
    desired: serializeJson(desiredObject),
    exists: current !== null,
    current,
    mode: 0o644,
  };
}

async function buildMcpManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, '.mcp.json');
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
        `Existing ${relPath} has an invalid \`mcpServers\` shape; refusing to overwrite it (${formatZodIssues(
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
    mode: 0o644,
  };
}

async function buildShimManagedFile(root: string, spec: HookShimSpec): Promise<ManagedFile> {
  const absPath = join(root, '.claude', 'hooks', spec.fileName);
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);
  return {
    absPath,
    relPath,
    role: 'shim',
    desired: buildHookShim(spec),
    exists: current !== null,
    current,
    mode: 0o755,
  };
}

async function computeManagedFiles(root: string): Promise<ManagedFile[]> {
  const [settings, mcp, ...shims] = await Promise.all([
    buildSettingsManagedFile(root),
    buildMcpManagedFile(root),
    ...HOOK_SHIMS.map((spec) => buildShimManagedFile(root, spec)),
  ]);
  return [settings, mcp, ...shims];
}

// --- Action classification ---------------------------------------------------

function wouldChange(file: ManagedFile): boolean {
  return file.exists && file.current !== file.desired;
}

/** Label for a file whose content is being created or changed. */
function changeAction(file: ManagedFile): InstallChangeAction {
  if (!file.exists) return 'create';
  return file.role === 'shim' ? 'overwrite' : 'merge';
}

function planReason(file: ManagedFile): string {
  if (!file.exists) return `${file.relPath} does not exist yet and would be created`;
  const verb = file.role === 'shim' ? 'overwritten' : 'merged';
  return `${file.relPath} already exists and would be ${verb}; re-run with { force: true } to apply`;
}

// --- Public entry point ------------------------------------------------------

/**
 * Installs (or plans the installation of) the DevCortex Claude Code hooks and
 * MCP registration into `targetRoot`.
 *
 * @throws {ConfigError} when an existing `.claude/settings.json` / `.mcp.json`
 *   is not valid JSON or has an incompatible shape (never silently overwritten).
 * @throws {DevCortexError} on unexpected filesystem failures.
 */
export async function installClaude(
  targetRoot: string,
  options: InstallClaudeOptions = {},
): Promise<InstallResult> {
  if (typeof targetRoot !== 'string' || targetRoot.trim() === '') {
    throw new DevCortexError('INTERNAL', 'installClaude requires a non-empty target root path.');
  }

  const force = options.force ?? false;
  const root = resolve(targetRoot);
  const files = await computeManagedFiles(root);

  // Confirm-before-overwrite: any pre-existing file that would change blocks an
  // implicit apply. Emit a plan covering every create/merge/overwrite, write
  // nothing.
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
