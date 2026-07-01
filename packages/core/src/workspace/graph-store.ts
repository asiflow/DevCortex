/**
 * Typed, schema-validated read/write of the cached project graph at
 * `.cortex/graph.json`. The graph is produced by the `graph/` module and cached
 * here; this layer only persists and validates it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectGraph } from '../domain/index';
import { ProjectGraphSchema, SchemaValidationError } from '../domain/index';

import { workspacePaths } from './paths';

/**
 * Load the cached {@link ProjectGraph}.
 *
 * @returns the validated graph, or `null` when no cache exists yet (the normal
 *   state immediately after `init`, before the first scan).
 * @throws SchemaValidationError `SCHEMA_VALIDATION` when the cache exists but is
 *   not valid JSON or fails `ProjectGraphSchema`.
 */
export async function loadGraph(root: string): Promise<ProjectGraph | null> {
  const paths = workspacePaths(root);

  let raw: string;
  try {
    raw = await readFile(paths.graph, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return null;
    }
    throw new SchemaValidationError(`Unable to read project graph at ${paths.graph}.`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SchemaValidationError(`Project graph at ${paths.graph} is not valid JSON.`, {
      cause: err,
    });
  }

  const result = ProjectGraphSchema.safeParse(parsed);
  if (!result.success) {
    throw new SchemaValidationError(`Project graph at ${paths.graph} failed validation.`, {
      details: result.error.issues,
      cause: result.error,
    });
  }

  return result.data;
}

/**
 * Validate and persist `graph` to `.cortex/graph.json` as pretty-printed JSON.
 * Validation happens before writing so a malformed graph never reaches disk.
 *
 * @throws SchemaValidationError `SCHEMA_VALIDATION` when `graph` fails
 *   `ProjectGraphSchema` or the file cannot be written.
 */
export async function saveGraph(root: string, graph: ProjectGraph): Promise<void> {
  const paths = workspacePaths(root);

  const result = ProjectGraphSchema.safeParse(graph);
  if (!result.success) {
    throw new SchemaValidationError('Refusing to write an invalid project graph.', {
      details: result.error.issues,
      cause: result.error,
    });
  }

  try {
    await mkdir(path.dirname(paths.graph), { recursive: true });
    await writeFile(paths.graph, `${JSON.stringify(result.data, null, 2)}\n`, 'utf8');
  } catch (err) {
    throw new SchemaValidationError(`Unable to write project graph to ${paths.graph}.`, {
      cause: err,
    });
  }
}

/** Narrow an unknown thrown value to a Node `errno` exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}
