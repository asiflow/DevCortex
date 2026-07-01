/**
 * Static serving for the built local dashboard.
 *
 * The dashboard ships as a separate package (`@devcortex/local-dashboard`) whose
 * `dist/` is a compiled SPA. We resolve that dist directory at startup and serve
 * it at `/` with history-API (SPA) fallback to `index.html`. Everything here is
 * best-effort: if the dashboard is not installed or not yet built, the daemon
 * still runs and serves a small placeholder page so `/` never 500s.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

import { tryReadFileBuffer, contentTypeFor } from './fs-utils';

const require = createRequire(import.meta.url);

/** A fully-resolved static response the HTTP layer writes verbatim. */
export interface StaticResponse {
  status: number;
  contentType: string;
  body: Buffer | string;
}

/**
 * Resolve the local dashboard's built `dist/` directory, or `null` when the
 * dashboard package is not installed. Resolution order:
 *   1. `DEVCORTEX_DASHBOARD_DIST` env override (absolute or cwd-relative).
 *   2. The package's own `package.json` (its sibling `dist/`).
 *   3. The package's main entry (walk up to its package root, then `dist/`).
 *
 * Returning a path whose `dist/` is not yet built is fine — {@link serveStatic}
 * falls back to the placeholder when `index.html` is absent.
 */
export function resolveDashboardDist(): string | null {
  const override = process.env.DEVCORTEX_DASHBOARD_DIST;
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override.trim());
  }

  try {
    const pkgJson = require.resolve('@devcortex/local-dashboard/package.json');
    return path.join(path.dirname(pkgJson), 'dist');
  } catch {
    // package.json may be excluded from the package's export map; try the main.
  }

  try {
    const entry = require.resolve('@devcortex/local-dashboard');
    const root = findPackageRoot(entry);
    if (root !== null) return path.join(root, 'dist');
  } catch {
    // not installed
  }

  return null;
}

/** Walk up from a resolved module file to the directory containing its package.json. */
function findPackageRoot(fromFile: string): string | null {
  let dir = path.dirname(fromFile);
  // Bound the walk to the filesystem root.
  for (let depth = 0; depth < 64; depth += 1) {
    if (path.basename(dir) === 'node_modules') return null;
    try {
      const pkg = path.join(dir, 'package.json');
      // Synchronous existence via require.resolve keeps this pure to the resolver.
      require.resolve(pkg);
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/**
 * Serve `pathname` from the dashboard `distDir` with SPA fallback. Returns a
 * placeholder when the dashboard is absent (`distDir === null`) or unbuilt
 * (`index.html` missing). Guards against path traversal outside `distDir`.
 */
export async function serveStatic(
  distDir: string | null,
  pathname: string,
): Promise<StaticResponse> {
  if (distDir === null) return placeholder();

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'Bad request path.' };
  }

  const relative = decoded.replace(/^\/+/, '');
  const requested = relative === '' ? 'index.html' : relative;
  const candidate = path.resolve(distDir, requested);

  // Path-traversal guard: the resolved target must stay within distDir.
  if (candidate !== distDir && !candidate.startsWith(distDir + path.sep)) {
    return { status: 403, contentType: 'text/plain; charset=utf-8', body: 'Forbidden.' };
  }

  // 1. Serve the concrete asset when it exists.
  const asset = await tryReadFileBuffer(candidate);
  if (asset !== null) {
    return { status: 200, contentType: contentTypeFor(candidate), body: asset };
  }

  // 2. SPA fallback: any unmatched route resolves to the app shell.
  const shell = await tryReadFileBuffer(path.join(distDir, 'index.html'));
  if (shell !== null) {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: shell };
  }

  // 3. No build present at all → placeholder.
  return placeholder();
}

/** Minimal standalone page shown when the dashboard build is unavailable. */
export function placeholder(): StaticResponse {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DevCortex daemon</title>
    <style>
      body { font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.25rem; color: #1a1a1a; }
      code { background: #f2f2f2; padding: 0.1rem 0.35rem; border-radius: 4px; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    <h1>DevCortex daemon is running</h1>
    <p>The local dashboard build was not found, so this placeholder is served instead.</p>
    <p>The JSON API is live &mdash; try <a href="/api/health">/api/health</a>.</p>
    <p>To see the dashboard, build <code>@devcortex/local-dashboard</code> (or set <code>DEVCORTEX_DASHBOARD_DIST</code> to its built <code>dist</code> directory) and reload.</p>
  </body>
</html>
`;
  return { status: 200, contentType: 'text/html; charset=utf-8', body };
}
