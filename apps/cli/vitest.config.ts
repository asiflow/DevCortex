import { defineConfig } from 'vitest/config';

// The CLI suite is integration-first: it builds the real binary and runs it as
// a child process against a fixture copy. Real processes (scan, gate commands)
// need generous wall-clock budgets.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
