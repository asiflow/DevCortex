// ============================================================================
// DevCortex GitHub Actions installer.
//
// `installGithubActions(targetRoot, { force })` writes the DevCortex CI
// integration into a target repository:
//   - `.github/workflows/devcortex.yml`
//       CI workflow running the five named DevCortex checks (spec §4.8).
//   - `.github/actions/devcortex-ship-check/action.yml`
//       Composite action wrapping `devcortex ship`.
//
// Both files are DevCortex-owned wholesale (reserved paths/names), so — unlike
// the Codex/Claude installers that merge into shared config — this installer
// generates each file's content in full rather than splicing a managed block.
//
// Confirm-before-overwrite: if any pre-existing target file would change and
// `force` is not set, NOTHING is written and a plan describing the changes is
// returned instead. A fresh install (no conflicting files) applies directly, and
// re-running an already-installed integration is a byte-level no-op (idempotent).
// ============================================================================

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DevCortexError } from '@devcortex/core';
import {
  buildShipCheckActionYaml,
  buildWorkflowYaml,
  SHIP_CHECK_ACTION_PATH,
  WORKFLOW_PATH,
} from './templates';

// --- Public result types ----------------------------------------------------

export interface InstallGithubActionsOptions {
  /** Overwrite pre-existing files instead of returning a plan. */
  force?: boolean;
}

export type InstallFileAction = 'create' | 'overwrite' | 'unchanged';
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

type ManagedRole = 'workflow' | 'action';

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

/**
 * The DevCortex-owned files this installer manages, each with the pure builder
 * that produces its exact on-disk bytes.
 */
const MANAGED_SPECS: readonly {
  role: ManagedRole;
  /** POSIX-relative path (slash-separated) inside the target repo. */
  relPosixPath: string;
  build: () => string;
}[] = [
  { role: 'workflow', relPosixPath: WORKFLOW_PATH, build: buildWorkflowYaml },
  { role: 'action', relPosixPath: SHIP_CHECK_ACTION_PATH, build: buildShipCheckActionYaml },
];

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

async function buildManagedFile(
  root: string,
  spec: (typeof MANAGED_SPECS)[number],
): Promise<ManagedFile> {
  const absPath = join(root, ...spec.relPosixPath.split('/'));
  const relPath = relative(root, absPath) || absPath;
  const current = await readFileIfExists(absPath);
  return {
    absPath,
    relPath,
    role: spec.role,
    desired: spec.build(),
    exists: current !== null,
    current,
  };
}

async function computeManagedFiles(root: string): Promise<ManagedFile[]> {
  return Promise.all(MANAGED_SPECS.map((spec) => buildManagedFile(root, spec)));
}

// --- Action classification ---------------------------------------------------

function wouldChange(file: ManagedFile): boolean {
  return file.exists && file.current !== file.desired;
}

/** Label for a file whose content is being created or changed. */
function changeAction(file: ManagedFile): InstallChangeAction {
  return file.exists ? 'overwrite' : 'create';
}

function planReason(file: ManagedFile): string {
  if (!file.exists) return `${file.relPath} does not exist yet and would be created`;
  return `${file.relPath} already exists and would be overwritten; re-run with { force: true } to apply`;
}

// --- Public entry point ------------------------------------------------------

/**
 * Installs (or plans the installation of) the DevCortex GitHub Actions
 * integration into `targetRoot`: the CI workflow and the composite ship-check
 * action.
 *
 * @throws {DevCortexError} on an empty target root or unexpected filesystem
 *   failures.
 */
export async function installGithubActions(
  targetRoot: string,
  options: InstallGithubActionsOptions = {},
): Promise<InstallResult> {
  if (typeof targetRoot !== 'string' || targetRoot.trim() === '') {
    throw new DevCortexError(
      'INTERNAL',
      'installGithubActions requires a non-empty target root path.',
    );
  }

  const force = options.force ?? false;
  const root = resolve(targetRoot);
  const files = await computeManagedFiles(root);

  // Confirm-before-overwrite: any pre-existing file that would change blocks an
  // implicit apply. Emit a plan covering every create/overwrite, write nothing.
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
