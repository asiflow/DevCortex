import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  dts: false,
  sourcemap: true,
  clean: true,
  // The built file is an executable stdio MCP server registered as the
  // `devcortex-mcp` bin; prepend a Node shebang so it can be run directly.
  banner: { js: '#!/usr/bin/env node' },
  // Ship to npm as a self-contained server: bundle the `@devcortex/*` workspace
  // packages (never published individually) plus zod (esbuild keeps core's zod 3
  // and this package's zod 4 by module path). Real npm deps — the MCP SDK and
  // core's CJS deps (yaml, fast-glob, …) — stay external and are declared, so
  // each loads in its native format with no ESM/CJS interop break.
  noExternal: [/^@devcortex\//],
});
