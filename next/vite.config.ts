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
    rolldownOptions: {
      output: {
        // Third-party code changes far less often than ours. Keeping it in its own files means a
        // release that touches only app code leaves these cached in the browser, and no single file
        // is big enough to delay parsing on a phone. (The service worker precaches all of them, so
        // offline behaviour is unchanged.)
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 40,
            },
            {
              name: 'vendor-router',
              test: /node_modules[\\/](react-router|react-router-dom)[\\/]/,
              priority: 30,
            },
            { name: 'vendor-supabase', test: /node_modules[\\/]@supabase[\\/]/, priority: 30 },
            { name: 'vendor-data', test: /node_modules[\\/](@tanstack|dexie)[\\/]/, priority: 30 },
            {
              name: 'vendor-forms',
              test: /node_modules[\\/](zod|react-hook-form|@hookform)[\\/]/,
              priority: 30,
            },
            { name: 'vendor', test: /node_modules[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
