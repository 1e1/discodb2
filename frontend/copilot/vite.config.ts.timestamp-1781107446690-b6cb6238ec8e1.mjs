// vite.config.ts
import { defineConfig } from "file:///app/frontend/copilot/node_modules/vite/dist/node/index.js";
import { svelte } from "file:///app/frontend/copilot/node_modules/@sveltejs/vite-plugin-svelte/src/index.js";
import { fileURLToPath } from "node:url";
var __vite_injected_original_import_meta_url = "file:///app/frontend/copilot/vite.config.ts";
var vite_config_default = defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // The canonical, framework-free protocol/Wizard code lives in
      // frontend/shared (DESIGN §3, docs/WIZARD.md). The copilot is a VIEWER,
      // so it imports the shared protocol/data-model + cue schedule + FSM/cue
      // configs through this alias rather than re-declaring them. Mirrors the
      // cockpit's `@shared` alias so both apps consolidate on one source.
      "@shared": fileURLToPath(new URL("../shared", __vite_injected_original_import_meta_url))
    }
  },
  server: {
    host: true,
    port: 5174
  },
  preview: {
    host: true,
    port: 4174
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvYXBwL2Zyb250ZW5kL2NvcGlsb3RcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9hcHAvZnJvbnRlbmQvY29waWxvdC92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vYXBwL2Zyb250ZW5kL2NvcGlsb3Qvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tIFwidml0ZVwiO1xuaW1wb3J0IHsgc3ZlbHRlIH0gZnJvbSBcIkBzdmVsdGVqcy92aXRlLXBsdWdpbi1zdmVsdGVcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcblxuLy8gTGlnaHQgY2xpZW50OiBubyBzcGVjaWFsIGNodW5raW5nIG5lZWRlZCwgc2luZ2xlIHNtYWxsIGJ1bmRsZS5cbi8vIGBob3N0OiB0cnVlYCBzbyB0aGUgZGV2IHNlcnZlciBpcyByZWFjaGFibGUgZnJvbSBhIHBob25lIG9uIHRoZSBzYW1lIFdpRmkvQVAuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbc3ZlbHRlKCldLFxuICByZXNvbHZlOiB7XG4gICAgYWxpYXM6IHtcbiAgICAgIC8vIFRoZSBjYW5vbmljYWwsIGZyYW1ld29yay1mcmVlIHByb3RvY29sL1dpemFyZCBjb2RlIGxpdmVzIGluXG4gICAgICAvLyBmcm9udGVuZC9zaGFyZWQgKERFU0lHTiBcdTAwQTczLCBkb2NzL1dJWkFSRC5tZCkuIFRoZSBjb3BpbG90IGlzIGEgVklFV0VSLFxuICAgICAgLy8gc28gaXQgaW1wb3J0cyB0aGUgc2hhcmVkIHByb3RvY29sL2RhdGEtbW9kZWwgKyBjdWUgc2NoZWR1bGUgKyBGU00vY3VlXG4gICAgICAvLyBjb25maWdzIHRocm91Z2ggdGhpcyBhbGlhcyByYXRoZXIgdGhhbiByZS1kZWNsYXJpbmcgdGhlbS4gTWlycm9ycyB0aGVcbiAgICAgIC8vIGNvY2twaXQncyBgQHNoYXJlZGAgYWxpYXMgc28gYm90aCBhcHBzIGNvbnNvbGlkYXRlIG9uIG9uZSBzb3VyY2UuXG4gICAgICBcIkBzaGFyZWRcIjogZmlsZVVSTFRvUGF0aChuZXcgVVJMKFwiLi4vc2hhcmVkXCIsIGltcG9ydC5tZXRhLnVybCkpLFxuICAgIH0sXG4gIH0sXG4gIHNlcnZlcjoge1xuICAgIGhvc3Q6IHRydWUsXG4gICAgcG9ydDogNTE3NCxcbiAgfSxcbiAgcHJldmlldzoge1xuICAgIGhvc3Q6IHRydWUsXG4gICAgcG9ydDogNDE3NCxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFpUCxTQUFTLG9CQUFvQjtBQUM5USxTQUFTLGNBQWM7QUFDdkIsU0FBUyxxQkFBcUI7QUFGb0gsSUFBTSwyQ0FBMkM7QUFNbk0sSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsU0FBUyxDQUFDLE9BQU8sQ0FBQztBQUFBLEVBQ2xCLFNBQVM7QUFBQSxJQUNQLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUFNTCxXQUFXLGNBQWMsSUFBSSxJQUFJLGFBQWEsd0NBQWUsQ0FBQztBQUFBLElBQ2hFO0FBQUEsRUFDRjtBQUFBLEVBQ0EsUUFBUTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBLEVBQ1I7QUFBQSxFQUNBLFNBQVM7QUFBQSxJQUNQLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxFQUNSO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
