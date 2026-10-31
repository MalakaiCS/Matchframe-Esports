import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { svgComponent } from "../hud-template/svg-plugin.ts";

const here = dirname(fileURLToPath(import.meta.url));

// One HUD package per mode: `vite build --mode vector` writes dist/vector, `--mode lineup` dist/lineup
// (manifest, page and assets: the folders the HUD Library installs). Relative paths: the HUD server
// serves installed packages under /huds/<id>/.
export default defineConfig(({ mode }) => {
  const hud = mode === "lineup" ? "lineup" : "vector";
  return {
    root: resolve(here, "designs", hud),
    base: "./",
    plugins: [svgComponent(), react()],
    build: { outDir: resolve(here, "dist", hud), emptyOutDir: true, assetsInlineLimit: 0, sourcemap: false, target: "chrome103", cssTarget: "chrome103", chunkSizeWarningLimit: 1200 },
    server: {
      port: hud === "lineup" ? 5177 : 5176,
      fs: { allow: [resolve(here, "..", "..")] },
      proxy: {
        "/overlay-ws": { target: "ws://127.0.0.1:37212", ws: true },
        "/overlay-api": "http://127.0.0.1:37212",
        "/assets": "http://127.0.0.1:37212",
      },
    },
  };
});
