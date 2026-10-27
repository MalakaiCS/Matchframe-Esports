import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { CloudApp } from "./app.ts";
import { latestInstaller, serveDownload } from "./domain/downloads.ts";
import { Router, json } from "./http/router.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerBillingRoutes } from "./routes/billing.ts";
import { registerDeviceRoutes } from "./routes/devices.ts";
import { registerOrgRoutes } from "./routes/orgs.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
};

export function buildRouter(app: CloudApp): Router {
  const router = new Router({ allowedOrigins: [app.origin], onError: (e, where) => console.error(`[cloud-api] ${where.method} ${where.path}:`, e) });
  router.add("GET", "/v1/health", { summary: "Health" }, async () => {
    await app.sql.query("SELECT 1");
    return { ok: true, version: "0.1.0", database: app.sql.kind, billingConfigured: app.billing.configured, email: app.mailer.kind, signingKeyId: app.kid, signingKeySource: app.signingKeySource, ephemeralSigningKey: app.ephemeralKey };
  });
  router.add("GET", "/v1/downloads", { summary: "Matchframe program for Windows (.exe installer): URL, version, SHA-256" }, async () => {
    // An installer placed in MF_DOWNLOAD_DIR is served by this server; otherwise an external URL may be configured.
    const local = await latestInstaller(app.cfg.downloadDir);
    const windows = local
      ? { url: `/downloads/${local.name}`, sha256: local.sha256, version: local.version, size: local.size }
      : app.cfg.downloads.windowsUrl
        ? { url: app.cfg.downloads.windowsUrl, sha256: app.cfg.downloads.sha256, version: app.cfg.downloads.version, size: null }
        : null;
    return { windows, notesUrl: app.cfg.downloads.notesUrl, version: windows?.version ?? app.cfg.downloads.version };
  });
  registerAuthRoutes(router, app);
  registerOrgRoutes(router, app);
  registerBillingRoutes(router, app);
  registerDeviceRoutes(router, app);
  registerAdminRoutes(router, app);
  router.add("GET", "/v1/openapi.json", { summary: "OpenAPI description of this API" }, () => router.openapi({ title: "Matchframe cloud API", version: "0.1.0" }));
  return router;
}

function serveStatic(webDir: string, pathname: string, res: ServerResponse): boolean {
  const root = resolve(webDir);
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(root, rel);
  if (!file.startsWith(root)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback for client-side routes (not for missing assets).
    if (extname(rel)) return false;
    file = join(root, "index.html");
    if (!existsSync(file)) return false;
  }
  const ext = extname(file);
  const immutable = file.includes(`${join(root, "assets")}`);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ...SECURITY_HEADERS });
  res.end(readFileSync(file));
  return true;
}

export async function startCloudServer(app: CloudApp): Promise<{ server: Server; router: Router; close: () => Promise<void> }> {
  const router = buildRouter(app);
  const server = createServer(async (req, res) => {
    try {
      if (await router.handle(req, res)) return;
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname.startsWith("/v1/")) return json(res, 404, { error: "not_found", message: "no such API route" });
      if ((req.method === "GET" || req.method === "HEAD") && serveDownload(app.cfg.downloadDir, url.pathname, req.method, res)) return;
      if ((req.method === "GET" || req.method === "HEAD") && app.cfg.webDir && serveStatic(app.cfg.webDir, url.pathname, res)) return;
      json(res, 404, { error: "not_found", message: app.cfg.webDir ? "not found" : "website build not configured (MF_CLOUD_WEB_DIR)" });
    } catch (e) {
      console.error("[cloud-api] unhandled", e);
      json(res, 500, { error: "internal" });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(app.cfg.port, app.cfg.host, () => resolveListen());
  });
  return { server, router, close: () => new Promise<void>((r) => server.close(() => r())) };
}
