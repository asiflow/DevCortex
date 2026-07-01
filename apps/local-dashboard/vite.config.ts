/// <reference types="node" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The dashboard is served BY the DevCortex daemon in production (same origin), so
// the runtime API base is a relative "/api" path. During local development the
// Vite dev server proxies "/api" to the daemon process. Override the daemon
// target with VITE_DEVCORTEX_DAEMON when it does not listen on the default port.
const DAEMON_DEV_TARGET = process.env.VITE_DEVCORTEX_DAEMON ?? 'http://127.0.0.1:4823';

export default defineConfig({
  // Relative base so the built bundle can be mounted at any path by the daemon.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: DAEMON_DEV_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
