import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
  // The built file is an executable stdio MCP server registered as the
  // `devcortex-mcp` bin; prepend a Node shebang so it can be run directly.
  banner: { js: '#!/usr/bin/env node' },
});
