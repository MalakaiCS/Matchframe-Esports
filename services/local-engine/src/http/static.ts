import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Resolves a request path inside root; returns null for traversal attempts or missing files. */
export function safeResolve(root: string, requestPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  const rootAbs = resolve(root);
  const full = resolve(rootAbs, "." + sep + normalize(rel).replace(/^([/\\])+/, ""));
  if (full !== rootAbs && !full.startsWith(rootAbs + sep)) return null;
  if (!existsSync(full)) return null;
  const st = statSync(full);
  if (st.isDirectory()) {
    const idx = join(full, "index.html");
    return existsSync(idx) ? idx : null;
  }
  return full;
}

export function serveFile(res: ServerResponse, file: string, headers: Record<string, string> = {}): void {
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": mimeFor(file),
    "content-length": String(body.length),
    "x-content-type-options": "nosniff",
    "cache-control": file.endsWith(".html") ? "no-store" : "public, max-age=300",
    ...headers,
  });
  res.end(body);
}

/** Serves a static directory with SPA fallback to index.html. Returns true if handled. */
export function serveStatic(res: ServerResponse, root: string | null, urlPath: string, opts: { spa?: boolean; headers?: Record<string, string> } = {}): boolean {
  if (!root || !existsSync(root)) return false;
  const file = safeResolve(root, urlPath);
  if (file) {
    serveFile(res, file, opts.headers);
    return true;
  }
  if (opts.spa && !extname(urlPath)) {
    const idx = join(root, "index.html");
    if (existsSync(idx)) {
      serveFile(res, idx, opts.headers);
      return true;
    }
  }
  return false;
}

/**
 * CSP for browser-source overlays: no remote code, no remote connections beyond this engine.
 * Overlay pages may frame same-origin pages only (the library output page frames its HUD), and
 * may be framed only by `frameAncestors` (none by default).
 */
export function overlayCsp(selfOrigin: string, frameAncestors: string[] = []): string {
  const ws = selfOrigin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${ws}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
    "form-action 'none'",
  ].join("; ");
}
