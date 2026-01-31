import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    svelte(),
    // PWA: cache the app SHELL (built JS/CSS/HTML + worker) so the cockpit loads
    // offline once visited, with an explicit "new version available → refresh"
    // flow so we NEVER serve a stale build silently (DESIGN §6 / P3).
    //
    // registerType:'prompt' (not autoUpdate): a long-running in-car session must
    // not be reloaded out from under the operator. virtual:pwa-register (wired in
    // src/pwa.ts) surfaces a non-blocking banner; the operator chooses when to
    // updateServiceWorker() and reload. Workbox cleans up outdated precaches and
    // claims clients so the next reload is always the fresh shell, never stale.
    VitePWA({
      registerType: 'prompt',
      injectRegister: null, // we register manually in src/pwa.ts
      workbox: {
        // The heavy parser/analysis Web Worker is a hashed asset too; precache
        // the whole built shell. globPatterns covers JS/CSS/HTML/worker/icons.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: false, // honour the prompt flow: don't activate until asked
      },
      manifest: {
        name: 'discodb2 cockpit',
        short_name: 'cockpit',
        description: 'discodb2 — heavy CAN reverse-engineering cockpit (buffer, decode, analysis, Wizard host).',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      // Dev: keep the SW off by default so HMR/devtools stay simple; enable on
      // demand by flipping enabled to true.
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      // The canonical, framework-free protocol/analysis/Wizard code lives in
      // frontend/shared (DESIGN §3, docs/WIZARD.md). The cockpit is the Wizard
      // HOST, so it imports the shared runExperiment / cue schedule / FSM /
      // configs directly via this alias rather than re-implementing them.
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Backend WS lives at ws://<host>:8765/ws (DESIGN §3.1). The frontend
    // connects directly to that URL (configurable in the UI), so no proxy is
    // strictly required, but we expose one for same-origin convenience in dev.
    proxy: {
      '/ws': {
        target: 'ws://localhost:8765',
        ws: true,
      },
      '/health': {
        target: 'http://localhost:8765',
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
});
