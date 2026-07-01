/**
 * Small, fail-safe filesystem helpers shared by the API and static surfaces.
 * Absence (`ENOENT`) is a normal, expected state (a repo may not have generated
 * a brief or a dashboard build yet); any other I/O error is surfaced as a
 * {@link DaemonError} so it becomes a clean 500 rather than a silent empty body.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { DaemonError } from './errors';

function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === 'string';
}

/** Read a UTF-8 text file, returning `''` when it does not exist. */
export async function readTextOrEmpty(absPath: string): Promise<string> {
  try {
    return await readFile(absPath, 'utf8');
  } catch (err) {
    if (isErrno(err) && err.code === 'ENOENT') return '';
    throw new DaemonError(`Unable to read ${absPath}.`, { cause: err });
  }
}

/**
 * Read a file as a Buffer, returning `null` when it is absent OR is a directory
 * (`ENOENT` / `EISDIR`). Any other error propagates as a {@link DaemonError}.
 * Used by the static server to try a concrete asset before falling back.
 */
export async function tryReadFileBuffer(absPath: string): Promise<Buffer | null> {
  try {
    return await readFile(absPath);
  } catch (err) {
    if (isErrno(err) && (err.code === 'ENOENT' || err.code === 'EISDIR')) return null;
    throw new DaemonError(`Unable to read ${absPath}.`, { cause: err });
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Best-effort MIME type for a filename; unknown extensions fall back to octet-stream. */
export function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}
