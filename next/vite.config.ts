import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { pwaPlugin } from './vite-plugins/pwa.ts';

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaPlugin({ template: 'pwa/sw.template.js' })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Tests read the repository's real SQL migrations (one level above this app) to build a database.
  server: { fs: { allow: ['..'] } },
  build: {
    sourcemap: false, // enable (as 'hidden') when error reporting is wired up in M4
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    hookTimeout: 30_000,
    testTimeout: 15_000,
  },
});
