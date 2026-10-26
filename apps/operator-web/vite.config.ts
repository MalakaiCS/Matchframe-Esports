import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The engine serves the built UI at http://127.0.0.1:<api port>/ (MATCHFRAME_OPERATOR_UI_DIR or apps/operator-web/dist).
// In development the Vite server proxies the API, the operator WebSocket and uploaded assets to the engine.
const apiPort = process.env.MATCHFRAME_API_PORT ?? "37211";
const target = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Uploaded logos/sponsor media are served by the engine under /assets/; keep the UI bundle elsewhere.
    assetsDir: "ui-assets",
    sourcemap: false,
    target: "chrome120",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target,
        ws: true,
        // The engine rejects mutations from foreign origins; present the engine's own origin in dev.
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("origin", target));
          proxy.on("proxyReqWs", (req) => req.setHeader("origin", target));
        },
      },
      "/assets": target,
    },
  },
});
