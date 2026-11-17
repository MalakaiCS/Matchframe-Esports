import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

// services/cloud-api serves the built site from apps/cloud-web/dist (MF_CLOUD_WEB_DIR) on the same
// origin as the API. In development Vite proxies /v1 to a locally running API (`pnpm cloud`).
const target = process.env.MF_CLOUD_API ?? "http://127.0.0.1:8080";

const here = dirname(fileURLToPath(import.meta.url));
/** The Stage HUD as built by apps/hud-designs (`pnpm --filter @matchframe/hud-designs build`). */
const STAGE_DIST = resolve(here, "..", "hud-designs", "dist", "stage");
/** What the site's live demo needs from it: the page, its hashed files and their licences (not the package's manifest, thumbnail or README). */
const STAGE_FILES = ["index.html", "assets", "OFL-fonts.txt", "OFL-Antonio.txt", "third-party-licenses"];

/** The HUD page without the player-cam script, which only the program's HUD server has (the demo shows its stand-in cam). */
const demoPage = (html: string) => html.replace(/\s*<!--[^>]*-->\s*<script src="\/hud-runtime\/cams\.js"><\/script>/, "").replace(/\s*<script src="\/hud-runtime\/[^"]*"><\/script>/g, "");

/**
 * The Stage HUD's live demo at /demo/stage/ (Home and /stage-hud frame /demo/stage/index.html?demo=…):
 * copied into dist/demo/stage when the site is built, served from apps/hud-designs/dist/stage in
 * development. The build fails when the HUD hasn't been built, rather than shipping a broken demo.
 */
function stageDemo(): Plugin {
  let outDir = "";
  return {
    name: "matchframe-stage-demo",
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use("/demo/stage/", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "/").split("?")[0]!).replace(/^\/+/, "") || "index.html";
        const file = resolve(STAGE_DIST, path);
        if (!file.startsWith(STAGE_DIST) || !existsSync(file) || statSync(file).isDirectory()) return next();
        const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".txt": "text/plain" };
        res.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
        res.end(extname(file) === ".html" ? demoPage(readFileSync(file, "utf8")) : readFileSync(file));
      });
    },
    closeBundle() {
      if (!outDir) return;
      if (!existsSync(join(STAGE_DIST, "index.html"))) throw new Error(`The Stage HUD demo needs ${STAGE_DIST}: run \`pnpm --filter @matchframe/hud-designs build\` first.`);
      const to = join(outDir, "demo", "stage");
      mkdirSync(to, { recursive: true });
      for (const name of STAGE_FILES) {
        const from = join(STAGE_DIST, name);
        if (!existsSync(from)) continue;
        if (name === "index.html") writeFileSync(join(to, name), demoPage(readFileSync(from, "utf8")));
        else cpSync(from, join(to, name), { recursive: true });
      }
      const size = (p: string): number => (statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + size(join(p, f)), 0) : statSync(p).size);
      console.log(`Stage HUD demo copied to ${to} (${Math.round(size(to) / 1024)} kB)`);
    },
  };
}

export default defineConfig({
  base: "/",
  plugins: [react(), stageDemo()],
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
