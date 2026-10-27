import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// Captain veto page only (served by the engine at /captain). The operator console is bundled into
// the Matchframe program and never served to browsers.
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist-captain",
    emptyOutDir: true,
    assetsDir: "captain-assets",
    sourcemap: false,
    target: "chrome120",
    rollupOptions: { input: resolve(import.meta.dirname, "captain.html") },
  },
});
