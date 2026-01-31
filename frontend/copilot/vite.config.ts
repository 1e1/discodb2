import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";

// Light client: no special chunking needed, single small bundle.
// `host: true` so the dev server is reachable from a phone on the same WiFi/AP.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // The canonical, framework-free protocol/Wizard code lives in
      // frontend/shared (DESIGN §3, docs/WIZARD.md). The copilot is a VIEWER,
      // so it imports the shared protocol/data-model + cue schedule + FSM/cue
      // configs through this alias rather than re-declaring them. Mirrors the
      // cockpit's `@shared` alias so both apps consolidate on one source.
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5174,
  },
  preview: {
    host: true,
    port: 4174,
  },
});
