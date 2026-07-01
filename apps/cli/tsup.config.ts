import { defineConfig } from 'tsup';

// The CLI ships to npm as a SELF-CONTAINED binary. The `@devcortex/*` workspace
// packages are never published individually, and the CLI's npm deps (commander,
// picocolors, zod) are bundled too — so `npx devcortex` works with zero
// transitive installs. esbuild bundles each package's own resolved `zod`, so the
// intentional zod 3 (core) / zod 4 (mcp, claude-code) split is preserved by
// module path — the two majors coexist in the bundle without crossing.
export default defineConfig({
  // Two bundles ship in the package: the CLI, and the daemon that `devcortex
  // dashboard` / `daemon start` spawns as a detached process. Bundling the daemon
  // as a sibling (dist/daemon.js) means the CLI can spawn it by relative path in a
  // global npm install, where `@devcortex/daemon` isn't a resolvable module.
  entry: { cli: 'src/cli.ts', daemon: '../daemon/src/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  // Keep each entry a standalone file (no shared chunk to resolve at runtime);
  // cli.js and daemon.js each inline what they need.
  splitting: false,
  outDir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
  // Bundle ONLY the `@devcortex/*` workspace packages — they are never published
  // to npm, so they must be inlined. Every real npm dependency (yaml, zod,
  // commander, picocolors, chokidar, …) stays external and is declared in
  // package.json, so `npx devcortex` installs them normally and each loads in its
  // native (ESM/CJS) format — no interop conflict.
  noExternal: [/^@devcortex\//],
  // Ship the dashboard SPA next to the CLI (dist/dashboard/) so the daemon can
  // serve it from a global install; the CLI points the daemon at it via
  // DEVCORTEX_DASHBOARD_DIST. (clean: true wipes dist first, so this runs after.)
  onSuccess: 'rm -rf dist/dashboard && cp -R ../local-dashboard/dist dist/dashboard',
});
