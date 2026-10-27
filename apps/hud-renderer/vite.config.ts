import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// The weapon silhouettes for the killfeed are the Pro CS2 HUD's icon set (Lexogrine, MIT), rendered
// inline with the same small SVG plugin.
import { svgComponent } from "../hud-template/svg-plugin.ts";

// Built HUD is served by the engine's overlay server under /hud/ (entry page at /overlay/:id/:variant).
export default defineConfig({
  base: "/hud/",
  plugins: [svgComponent(), react()],
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
