import adapter from '@sveltejs/adapter-static';
import { readFileSync } from 'node:fs';
const appVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;
const buildId = `${appVersion}-${process.env.GITHUB_SHA || Date.now()}`;
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig(({ command }) => ({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: 'index.html' }),
      serviceWorker: { register: false },
      paths: { relative: false },
      version: { name: buildId },
    }),
    {
      name: 'anagram-build-info',
      generateBundle() {
        if (this.environment.name === 'client')
          this.emitFile({
            type: 'asset',
            fileName: 'build-info.json',
            source: JSON.stringify({ appVersion, bundleId: buildId }),
          });
      },
    },
  ],
  define: {
    'process.env': JSON.stringify({
      APP_VERSION: appVersion,
      APP_BUNDLE_ID: buildId,
      APP_ENABLE_APP_SHELL: command === 'build',
      APP_IROH_RELAY_URL: process.env.APP_IROH_RELAY_URL,
    }),
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/build/**', '**/test-results/**', '**/playwright-report/**'],
    },
  },
  clearScreen: false,
}));
