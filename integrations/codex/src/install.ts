// ============================================================================
// DevCortex Codex CLI installer.
//
// `installCodex(targetRoot, { force })` writes / merges the DevCortex Codex
// integration into a target repository:
//   - `AGENTS.md`           — a delimited DevCortex instruction block Codex CLI
//                             reads as project documentation.
//   - `.codex/config.toml`  — a delimited block registering the `devcortex-mcp`
//                             stdio MCP server (project-scoped Codex settings).
//
// Confirm-before-overwrite: if any pre-existing target file would change and
// `force` is not set, NOTHING is written and a plan describing the changes is
// returned instead. A fresh install (no conflicting files) applies directly.
//
// Merging is non-destructive: only the DevCortex-delimited block in each file is
// created or replaced; every other byte the user wrote is preserved. The one
// hard failure is a hand-corrupted managed block (BEGIN without END), which
// throws a ConfigError rather than being silently clobbered.
// ============================================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DevCortexError } from '@devcortex/core';
import { AGENTS_FILE_PATH, CODEX_CONFIG_PATH, mergeAgentsDoc, mergeCodexConfig } from './templates';

// --- Public result types ----------------------------------------------------

export interface InstallCodexOptions {
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

type ManagedRole = 'agents' | 'codex';

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

// --- Desired-state computation ----------------------------------------------

async function buildAgentsManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, AGENTS_FILE_PATH);
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);
  return {
    absPath,
    relPath,
    role: 'agents',
    // mergeAgentsDoc throws ConfigError on a corrupt managed block.
    desired: mergeAgentsDoc(current),
    exists: current !== null,
    current,
  };
}

async function buildCodexManagedFile(root: string): Promise<ManagedFile> {
  const absPath = join(root, ...CODEX_CONFIG_PATH.split('/'));
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);
  return {
    absPath,
    relPath,
    role: 'codex',
    // mergeCodexConfig throws ConfigError on a corrupt managed block.
    desired: mergeCodexConfig(current),
    exists: current !== null,
    current,
  };
}

async function computeManagedFiles(root: string): Promise<ManagedFile[]> {
  return Promise.all([buildAgentsManagedFile(root), buildCodexManagedFile(root)]);
}

// --- Action classification ---------------------------------------------------

function wouldChange(file: ManagedFile): boolean {
  return file.exists && file.current !== file.desired;
}

/** Label for a file whose content is being created or changed. */
function changeAction(file: ManagedFile): InstallChangeAction {
  return file.exists ? 'merge' : 'create';
}

function planReason(file: ManagedFile): string {
  if (!file.exists) return `${file.relPath} does not exist yet and would be created`;
  return `${file.relPath} already exists and its DevCortex block would be merged; re-run with { force: true } to apply`;
}

// --- Public entry point ------------------------------------------------------

/**
 * Installs (or plans the installation of) the DevCortex Codex CLI integration
 * into `targetRoot`: the AGENTS.md instruction block and the `.codex/config.toml`
 * MCP registration.
 *
 * @throws {ConfigError} when an existing AGENTS.md / .codex/config.toml carries a
 *   corrupt DevCortex managed block (a BEGIN marker with no matching END).
 * @throws {DevCortexError} on unexpected filesystem failures or an empty target
 *   root.
 */
export async function installCodex(
  targetRoot: string,
  options: InstallCodexOptions = {},
): Promise<InstallResult> {
  if (typeof targetRoot !== 'string' || targetRoot.trim() === '') {
    throw new DevCortexError('INTERNAL', 'installCodex requires a non-empty target root path.');
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
