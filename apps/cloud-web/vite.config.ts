import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// services/cloud-api serves the built site from apps/cloud-web/dist (MF_CLOUD_WEB_DIR) on the same
// origin as the API. In development Vite proxies /v1 to a locally running API (`pnpm cloud`).
const target = process.env.MF_CLOUD_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The API serves dist/assets/* with immutable caching; keep Vite's hashed asset folder.
    assetsDir: "assets",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5174,
    proxy: {
      "/v1": {
        target,
        // The API refuses cookie-authenticated mutations from foreign origins; present its own origin in dev.
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => req.setHeader("origin", target));
        },
      },
    },
  },
});
