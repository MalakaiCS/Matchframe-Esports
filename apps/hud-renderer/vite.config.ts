import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built HUD is served by the engine's overlay server under /hud/ (entry page at /overlay/:id/:variant).
export default defineConfig({
  base: "/hud/",
  plugins: [react()],
  build: { outDir: "dist", assetsInlineLimit: 0, sourcemap: false, target: "chrome103" },
  server: {
    port: 5174,
    proxy: {
      "/overlay-ws": { target: "ws://127.0.0.1:37212", ws: true },
      "/overlay-api": "http://127.0.0.1:37212",
      "/assets": "http://127.0.0.1:37212",
    },
  },
});
