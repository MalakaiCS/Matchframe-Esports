import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { basename, join } from "node:path";

/** Windows installers published from MF_DOWNLOAD_DIR: `MatchframeEsports-Setup-<version>.exe`. */
const INSTALLER = /^MatchframeEsports-Setup-(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\.exe$/;

export interface LocalDownload {
  file: string;
  name: string;
  version: string;
  size: number;
  sha256: string;
}

const hashCache = new Map<string, { size: number; mtimeMs: number; sha256: string }>();

function sha256Of(file: string, size: number, mtimeMs: number): Promise<string> {
  const hit = hashCache.get(file);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return Promise.resolve(hit.sha256);
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("error", reject)
      .on("end", () => {
        const sha256 = h.digest("hex");
        hashCache.set(file, { size, mtimeMs, sha256 });
        resolve(sha256);
      });
  });
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split(".").map(Number);
  const pb = b.split(/[-+]/)[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return a.length - b.length;
}

/** The newest installer in the download directory (by version), with its SHA-256. */
export async function latestInstaller(dir: string | null): Promise<LocalDownload | null> {
  if (!dir || !existsSync(dir)) return null;
  const found = readdirSync(dir)
    .map((name) => ({ name, m: INSTALLER.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => compareVersions(b.m[1]!, a.m[1]!))[0];
  if (!found) return null;
  const file = join(dir, found.name);
  const st = statSync(file);
  return { file, name: found.name, version: found.m[1]!, size: st.size, sha256: await sha256Of(file, st.size, st.mtimeMs) };
}

/** Serves `/downloads/<installer>` from the download directory (only installer file names). */
export function serveDownload(dir: string | null, pathname: string, method: string, res: ServerResponse): boolean {
  if (!dir || !pathname.startsWith("/downloads/")) return false;
  const name = basename(decodeURIComponent(pathname.slice("/downloads/".length)));
  if (!INSTALLER.test(name)) return false;
  const file = join(dir, name);
  if (!existsSync(file)) return false;
  const st = statSync(file);
  res.writeHead(200, {
    "content-type": "application/vnd.microsoft.portable-executable",
    "content-length": String(st.size),
    "content-disposition": `attachment; filename="${name}"`,
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}
