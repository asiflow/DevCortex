/**
 * Workspace initialization — materialize the full `.cortex/` tree for a repo and
 * report whether one already exists.
 *
 * `initWorkspace` writes `config.yaml` (from `defaultConfig(stack)` with the
 * requested mode), `graph.json` (from a supplied or freshly scanned graph), the
 * three generated markdown docs, and the empty ledger directories. `isInitialized`
 * is the shared predicate the init guard and surfaces use.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';

import type { CortexConfig, ProjectGraph } from '../domain/index';
import { DevCortexError, WorkspaceError } from '../domain/index';
import { scanProject } from '../graph/index';

import { defaultConfig, saveConfig } from './config';
import { renderArchitectureMap, renderProjectBrief, renderQualityConstitution } from './docs';
import { saveGraph } from './graph-store';
import type { InitOptions } from './paths';
import { workspacePaths } from './paths';

/**
 * Report whether a DevCortex workspace exists at `root` — i.e. whether the
 * `.cortex/` directory is present. Pure read: never creates anything.
 *
 * @throws DevCortexError `INTERNAL` when the `.cortex` path cannot be inspected
 *   for a reason other than absence (e.g. a permission error).
 */
export async function isInitialized(root: string): Promise<boolean> {
  const { cortexDir } = workspacePaths(root);
  try {
    const stats = await stat(cortexDir);
    return stats.isDirectory();
  } catch (err) {
    if (isErrnoException(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return false;
    }
    throw new DevCortexError('INTERNAL', `Unable to determine workspace state at ${cortexDir}.`, {
      cause: err,
    });
  }
}

/**
 * Create the full `.cortex/` workspace tree at `root`:
 *
 * - `config.yaml` — `defaultConfig(opts.stack)` with `mode` overridden to
 *   `opts.mode`, written atomically and schema-validated.
 * - `graph.json` — `opts.graph` when supplied, otherwise a fresh `scanProject`.
 * - `project.md` / `architecture.md` / `quality-constitution.md` — real docs
 *   derived from the stack + graph + config (read back by the MCP `get_*` tools).
 * - empty `memory/` `features/` `decisions/` `evidence/` `ship-reports/` `runs/`
 *   `cache/` directories.
 *
 * @returns the absolute paths of every directory and file created (or rewritten
 *   under `force`).
 * @throws WorkspaceError `WORKSPACE_EXISTS` when `.cortex/` already exists and
 *   `opts.force` is not set.
 * @throws DevCortexError when a directory or generated doc cannot be written;
 *   `ConfigError` / `SchemaValidationError` / `ScanError` propagate from the
 *   config, graph and scan steps respectively.
 */
export async function initWorkspace(
  root: string,
  opts: InitOptions,
): Promise<{ created: string[] }> {
  const paths = workspacePaths(root);

  if (opts.force !== true && (await isInitialized(root))) {
    throw new WorkspaceError(
      'WORKSPACE_EXISTS',
      `A DevCortex workspace already exists at ${paths.cortexDir}. Re-run with \`force\` to overwrite it.`,
    );
  }

  const config: CortexConfig = { ...defaultConfig(opts.stack), mode: opts.mode };
  const graph: ProjectGraph = opts.graph ?? (await scanProject(paths.root));

  // Directory tree first, so every subsequent write lands in an existing dir.
  // mkdir(recursive) is idempotent, which is what makes force-overwrite safe.
  const dirs = [
    paths.cortexDir,
    paths.memoryDir,
    paths.featuresDir,
    paths.decisionsDir,
    paths.evidenceDir,
    paths.shipReportsDir,
    paths.runsDir,
    paths.cacheDir,
  ];
  for (const dir of dirs) {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      throw new DevCortexError('INTERNAL', `Unable to create workspace directory ${dir}.`, {
        cause: err,
      });
    }
  }

  // config.yaml + graph.json go through the validated (and, for config, atomic)
  // writers so a malformed payload can never reach disk.
  await saveConfig(root, config);
  await saveGraph(root, graph);

  // Generated, human-readable docs the MCP get_* tools surface verbatim.
  await writeDoc(paths.projectMd, renderProjectBrief(graph, config));
  await writeDoc(paths.architectureMd, renderArchitectureMap(graph));
  await writeDoc(paths.qualityConstitution, renderQualityConstitution(config, graph.stack));

  return {
    created: [
      ...dirs,
      paths.config,
      paths.graph,
      paths.projectMd,
      paths.architectureMd,
      paths.qualityConstitution,
    ],
  };
}

/**
 * Write a generated doc into the already-created `.cortex/` directory, surfacing
 * any I/O failure as a DevCortexError. (The docs are regenerated wholesale on
 * every `scan`/`init`, so a partial overwrite is never load-bearing — unlike
 * `config.yaml`, which uses an atomic temp-and-rename write.)
 */
async function writeDoc(filePath: string, contents: string): Promise<void> {
  try {
    await writeFile(filePath, contents, 'utf8');
  } catch (err) {
    throw new DevCortexError('INTERNAL', `Unable to write workspace doc ${filePath}.`, {
      cause: err,
    });
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
