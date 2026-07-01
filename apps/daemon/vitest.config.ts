import { defineConfig } from 'vitest/config';

// The daemon suite is integration-first: each test boots a real HTTP server on
// an ephemeral port against a freshly initialized mkdtemp workspace, then makes
// real `fetch` calls. Scans + watcher debounce need generous wall-clock budgets.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
