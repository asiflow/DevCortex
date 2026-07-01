import { defineConfig } from 'tsup';

// Two entry points from a single build pass (one `clean`, no output race):
//   - `src/index.ts` → the programmatic library (`startDaemon`, types).
//   - `src/main.ts`  → the `devcortex-daemon` executable.
//
// `main.ts` carries its own `#!/usr/bin/env node` shebang as its first source
// line; esbuild preserves a leading hashbang on the entry file, so the built
// `dist/main.js` is directly runnable while `dist/index.js` stays a clean import
// target. `@devcortex/core` and `chokidar` are declared dependencies and are
// externalized automatically (resolved from node_modules at runtime).
export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
});
