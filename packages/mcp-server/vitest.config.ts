import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // MCP tools shell out to real commands (verify_command / verify_build) and
    // scan real fixtures, so give the contract test room beyond the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
