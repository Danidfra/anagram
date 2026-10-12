import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [
    svelte({ configFile: false, dynamicCompileOptions: () => ({ generate: 'client' }) }),
  ],
  ssr: { resolve: { conditions: ['browser'] } },
  resolve: {
    conditions: ['browser'],
    alias: { src: fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Bound worker contention: the IndexedDB migration tests share the host CPU.
  test: {
    server: { deps: { inline: ['svelte'] } },
    maxWorkers: 4,
    include: ['tests/unit/**/*.spec.ts', 'tests/unit/**/*.spec.svelte.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
