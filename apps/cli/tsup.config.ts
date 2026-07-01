import { defineConfig } from 'tsup';

// The CLI is a single-entry executable. `@devcortex/core` and
// `@devcortex/claude-code` stay external (declared runtime dependencies,
// resolved from node_modules), so we only bundle the CLI's own sources.
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
});
