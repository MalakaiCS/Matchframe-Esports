import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { svgComponent } from "./svg-plugin.ts";

// Builds the HUD package into dist/ (manifest, page, assets): the folder the HUD Library installs.
// Relative paths: the HUD server serves installed packages under /huds/<id>/.
export default defineConfig({
  base: "./",
  plugins: [svgComponent(), react()],
  // The weapon icons are inlined into the bundle (about 0.5 MB, loaded once from disk).
  build: { outDir: "dist", assetsInlineLimit: 0, sourcemap: false, target: "chrome103", cssTarget: "chrome103", chunkSizeWarningLimit: 1200 },
  server: {
    port: 5175,
    proxy: {
      "/overlay-ws": { target: "ws://127.0.0.1:37212", ws: true },
      "/overlay-api": "http://127.0.0.1:37212",
      "/assets": "http://127.0.0.1:37212",
    },
  },
});
