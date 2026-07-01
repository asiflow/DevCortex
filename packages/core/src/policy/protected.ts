/**
 * Protected-path matching.
 *
 * A path is "protected" when it matches any glob in `config.risk.protectedPaths`.
 * Protected paths are the files whose edits DevCortex treats as inherently
 * high/critical risk (auth, billing, middleware, migrations, env, etc.). The
 * match is purely path-based — it never touches the filesystem — so it is safe
 * to call on hypothetical or not-yet-existing paths.
 */
import picomatch from 'picomatch';
import type { CortexConfig } from '../domain/index';
import { ConfigError } from '../domain/index';

/**
 * True when `path` matches any configured protected glob.
 *
 * Matching rules:
 * - Paths are normalised to POSIX separators and a leading `./` is stripped.
 * - Patterns containing a `/` are matched against the full repo-relative path.
 * - Patterns with no `/` are matched against the full path AND the basename, so
 *   a pattern like `middleware.ts` protects both `middleware.ts` and
 *   `src/app/middleware.ts` (picomatch's own `basename` option is not used
 *   because it silently breaks multi-segment `**` patterns).
 * - Dotfiles (`.env`, ...) are matched (`{ dot: true }`).
 *
 * @throws ConfigError when a configured pattern is not a usable glob string.
 */
export function isProtected(path: string, config: CortexConfig): boolean {
  if (typeof path !== 'string' || path.length === 0) {
    return false;
  }

  const normalized = normalizePath(path);

  for (const pattern of config.risk.protectedPaths) {
    // Defensive: config is zod-validated to be string[] at the disk boundary,
    // but a hand-constructed CortexConfig could still smuggle a non-string in.
    if (typeof pattern !== 'string') {
      throw new ConfigError(`protectedPaths entry is not a string: ${String(pattern)}`, {
        details: { pattern },
      });
    }
    if (pattern.trim().length === 0) {
      // An empty pattern protects nothing; skip it rather than letting
      // picomatch throw on the empty string.
      continue;
    }

    let matcher: (input: string) => boolean;
    try {
      matcher = picomatch(pattern, { dot: true });
    } catch (cause) {
      throw new ConfigError(`Invalid protected-path glob: ${pattern}`, { cause });
    }

    if (matcher(normalized)) {
      return true;
    }
    if (!pattern.includes('/') && matcher(basenameOf(normalized))) {
      return true;
    }
  }

  return false;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function basenameOf(path: string): string {
  const segments = path.split('/');
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? path : last;
}
