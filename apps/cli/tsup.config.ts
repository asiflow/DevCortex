import { defineConfig } from 'tsup';

// The CLI ships to npm as a SELF-CONTAINED binary. The `@devcortex/*` workspace
// packages are never published individually, and the CLI's npm deps (commander,
// picocolors, zod) are bundled too — so `npx devcortex` works with zero
// transitive installs. esbuild bundles each package's own resolved `zod`, so the
// intentional zod 3 (core) / zod 4 (mcp, claude-code) split is preserved by
// module path — the two majors coexist in the bundle without crossing.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: false,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  banner: { js: '#!/usr/bin/env node' },
  // Bundle ONLY the `@devcortex/*` workspace packages — they are never published
  // to npm, so they must be inlined. Every real npm dependency (yaml, zod,
  // commander, picocolors, …) stays external and is declared in package.json, so
  // `npx devcortex` installs them normally and each loads in its native
  // (ESM/CJS) format — no interop conflict.
  noExternal: [/^@devcortex\//],
});
