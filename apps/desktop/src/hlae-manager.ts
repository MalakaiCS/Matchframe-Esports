import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import type { LaunchResult } from "./game-launch.ts";
import { t } from "./i18n.ts";

/**
 * HLAE kept up to date by the program (ADR-084). CS2 updates often break HLAE until advancedfx
 * ships a new build, so the operator shouldn't have to find and install it by hand:
 *
 * - **Get HLAE** downloads the latest official release from advancedfx's GitHub releases, checks
 *   it against the SHA-256 GitHub gives for the file, unpacks it into `<userData>/hlae-program/<version>`
 *   and selects its HLAE.exe for the HLAE launch mode.
 * - **Updates:** while that HLAE is the one in use, the program looks for a newer release when it
 *   starts and before Start CS2 (at most every 30 minutes), and straight away when HLAE fails to
 *   start CS2. Never while CS2 is running. The version before is kept.
 *
 * HLAE is MIT-licensed and is not in MatchFrame's installer: it is fetched from its own releases.
 */

export const HLAE_RELEASES_API = "https://api.github.com/repos/advancedfx/advancedfx/releases/latest";
const DOWNLOAD_PREFIX = "https://github.com/advancedfx/advancedfx/releases/download/";
/** How long a release check is trusted before Start CS2 or the program's start asks again. */
export const CHECK_EVERY_MS = 30 * 60_000;
/** Checks asked for on purpose (a failed start, the button) still wait this long between them. */
export const FORCED_CHECK_MS = 60_000;
const MAX_ZIP_BYTES = 300 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 800 * 1024 * 1024;
const HOOK = "x64/AfxHookSource2.dll";

export interface HlaeRelease {
  version: string;
  tag: string;
  publishedAt: string | null;
  zip: { name: string; url: string; size: number; sha256: string };
}

export interface ManagedHlae {
  version: string;
  dir: string;
  exe: string;
  installedAt: string;
}

export type HlaeBusy = "checking" | "downloading" | "installing";

export interface HlaeStatus {
  /** The HLAE the program installed, if any. */
  managed: ManagedHlae | null;
  /** The launch mode uses the program's HLAE (not one the operator chose elsewhere). */
  inUse: boolean;
  autoUpdate: boolean;
  busy: HlaeBusy | null;
  busyVersion: string | null;
  percent: number | null;
  /** The latest release seen on GitHub, and when. */
  latest: string | null;
  checkedAt: string | null;
  /** Why the last check or install failed (cleared by the next one that works). */
  error: string | null;
}

export type HlaeUpdate =
  | { updated: true; from: string | null; to: string }
  | { updated: false; reason: "not_in_use" | "off" | "cs2_running" | "latest"; version: string | null }
  | { updated: false; reason: "error"; error: string; version: string | null };

export interface HlaeSettings {
  hlaePath: string | null;
  hlaeManaged: ManagedHlae | null;
  hlaeAutoUpdate: boolean;
}

export interface HlaeManagerDeps {
  /** `<userData>/hlae-program`. */
  root: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  read: () => HlaeSettings;
  write: (patch: Partial<HlaeSettings>) => void;
  cs2Running: () => Promise<boolean>;
}

/** "v2.193.0" → "2.193.0"; null for anything that isn't a plain version tag. */
export function parseHlaeVersion(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const m = /^v?(\d+(?:\.\d+){1,3})$/.exec(tag.trim());
  return m ? m[1]! : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The release's HLAE ZIP (`hlae_2_193_0.zip`), its address and GitHub's SHA-256 for it; or why it can't be used. */
export function pickHlaeRelease(json: unknown): { release: HlaeRelease } | { problem: string } {
  const r = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const version = parseHlaeVersion(r.tag_name);
  if (!version || r.draft === true || r.prerelease === true) return { problem: t("hlae.noRelease") };
  const tag = String(r.tag_name);
  const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
  const zips = assets.filter((a) => typeof a.name === "string" && /^hlae[_-]?\d+(?:[_.]\d+)+\.zip$/i.test(a.name) && typeof a.browser_download_url === "string" && a.browser_download_url.startsWith(`${DOWNLOAD_PREFIX}${tag}/`));
  const wanted = version.replace(/\./g, "_");
  const zip = zips.find((a) => String(a.name).toLowerCase() === `hlae_${wanted}.zip`) ?? zips[0];
  if (!zip) return { problem: t("hlae.noZip", { version }) };
  const digest = typeof zip.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(zip.digest) : null;
  if (!digest) return { problem: t("hlae.noDigest", { version }) };
  const size = typeof zip.size === "number" ? zip.size : 0;
  if (size > MAX_ZIP_BYTES) return { problem: t("hlae.tooLarge", { version }) };
  return {
    release: {
      version,
      tag,
      publishedAt: typeof r.published_at === "string" ? r.published_at : null,
      zip: { name: String(zip.name), url: String(zip.browser_download_url), size, sha256: digest[1]!.toLowerCase() },
    },
  };
}

/**
 * Unpacks HLAE's ZIP into `dest`: the folder holding HLAE.exe (the ZIP may have a top folder) with
 * its `x64\AfxHookSource2.dll`. Refuses names that leave the folder. Returns HLAE.exe's path.
 */
export function unpackHlae(zip: Uint8Array, dest: string, version: string): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch (e) {
    throw new Error(t("hlae.badZip", { version, error: e instanceof Error ? e.message : String(e) }), { cause: e });
  }
  const entries = Object.entries(files).map(([name, data]) => ({ name: name.replace(/\\/g, "/"), data }));
  for (const { name } of entries) {
    if (name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) throw new Error(t("hlae.unsafeZip", { version, name }));
  }
  const exe = entries
    .filter((e) => !e.name.endsWith("/") && (e.name.split("/").pop() ?? "").toLowerCase() === "hlae.exe")
    .sort((a, b) => a.name.length - b.name.length)[0];
  const prefix = exe ? exe.name.slice(0, exe.name.length - "hlae.exe".length) : "";
  const lower = new Set(entries.map((e) => e.name.toLowerCase()));
  if (!exe || !lower.has(`${prefix}${HOOK}`.toLowerCase())) throw new Error(t("hlae.missingFiles", { version }));
  const mine = entries.filter((e) => e.name.startsWith(prefix) && !e.name.endsWith("/"));
  if (mine.reduce((n, e) => n + e.data.length, 0) > MAX_UNPACKED_BYTES) throw new Error(t("hlae.tooLarge", { version }));
  for (const e of mine) {
    const rel = e.name.slice(prefix.length);
    const out = join(dest, ...rel.split("/"));
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, e.data);
  }
  return join(dest, exe.name.slice(prefix.length));
}

const samePath = (a: string | null, b: string | null) => !!a && !!b && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

export function createHlaeManager(deps: HlaeManagerDeps) {
  const now = deps.now ?? Date.now;
  let busy: HlaeBusy | null = null;
  let busyVersion: string | null = null;
  let percent: number | null = null;
  let latest: HlaeRelease | null = null;
  let checkedAt: number | null = null;
  let error: string | null = null;
  // One check or install at a time; callers arriving meanwhile share it.
  let running: Promise<unknown> | null = null;

  const inUse = (s = deps.read()) => !!s.hlaeManaged && samePath(s.hlaePath, s.hlaeManaged.exe);

  function status(): HlaeStatus {
    const s = deps.read();
    return {
      managed: s.hlaeManaged,
      inUse: inUse(s),
      autoUpdate: s.hlaeAutoUpdate,
      busy,
      busyVersion,
      percent,
      latest: latest?.version ?? null,
      checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
      error,
    };
  }

  function serial<T>(job: () => Promise<T>): Promise<T> {
    const prev = running ?? Promise.resolve();
    const next = prev.then(job, job);
    // The queue only waits for the job; its failure goes to the caller, never unhandled from here.
    const settled: Promise<unknown> = next.then(
      () => undefined,
      () => undefined,
    );
    running = settled;
    void settled.then(() => {
      if (running === settled) running = null;
    });
    return next;
  }

  async function latestRelease(force: boolean): Promise<HlaeRelease> {
    const age = checkedAt === null ? Infinity : now() - checkedAt;
    if (latest && age < (force ? FORCED_CHECK_MS : CHECK_EVERY_MS)) return latest;
    busy = "checking";
    try {
      let res: Response;
      try {
        res = await deps.fetch(HLAE_RELEASES_API, { headers: { accept: "application/vnd.github+json", "user-agent": "MatchFrame-Esports" }, signal: AbortSignal.timeout(15_000) });
      } catch (e) {
        throw new Error(t("hlae.noGithub", { error: e instanceof Error ? e.message : String(e) }), { cause: e });
      }
      if (res.status === 403 || res.status === 429) throw new Error(t("hlae.rateLimited"));
      if (!res.ok) throw new Error(t("hlae.githubHttp", { status: res.status }));
      const picked = pickHlaeRelease(await res.json());
      if ("problem" in picked) throw new Error(picked.problem);
      latest = picked.release;
      checkedAt = now();
      return latest;
    } finally {
      busy = null;
    }
  }

  async function download(release: HlaeRelease): Promise<Buffer> {
    const { version } = release;
    busy = "downloading";
    busyVersion = version;
    percent = release.zip.size ? 0 : null;
    let res: Response;
    try {
      res = await deps.fetch(release.zip.url, { headers: { "user-agent": "MatchFrame-Esports" }, signal: AbortSignal.timeout(10 * 60_000) });
    } catch (e) {
      throw new Error(t("hlae.downloadStopped", { version, error: e instanceof Error ? e.message : String(e) }), { cause: e });
    }
    if (!res.ok || !res.body) throw new Error(t("hlae.downloadFailed", { version, status: res.status }));
    const total = Number(res.headers.get("content-length")) || release.zip.size || 0;
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_ZIP_BYTES) {
          tooLarge = true;
          await reader.cancel();
          break;
        }
        hash.update(value);
        chunks.push(Buffer.from(value));
        if (total) percent = Math.min(100, Math.floor((received / total) * 100));
      }
    } catch (e) {
      throw new Error(t("hlae.downloadStopped", { version, error: e instanceof Error ? e.message : String(e) }), { cause: e });
    }
    if (tooLarge) throw new Error(t("hlae.tooLarge", { version }));
    if (hash.digest("hex") !== release.zip.sha256) throw new Error(t("hlae.checksumMismatch", { version }));
    return Buffer.concat(chunks);
  }

  /** Keeps the version in use and the newest one before it; older folders go (a file in use just stays). */
  function prune(current: string): void {
    if (!existsSync(deps.root)) return;
    const others = readdirSync(deps.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && parseHlaeVersion(d.name) && d.name !== current)
      .map((d) => d.name)
      .sort((a, b) => compareVersions(b, a));
    for (const name of others.slice(1)) {
      try {
        rmSync(join(deps.root, name), { recursive: true, force: true });
      } catch {
        // A file still in use (CS2 holds the hook): tried again next time.
      }
    }
    for (const d of readdirSync(deps.root)) if (d.endsWith(".part")) rmSync(join(deps.root, d), { recursive: true, force: true });
  }

  async function install(release: HlaeRelease): Promise<ManagedHlae> {
    const zip = await download(release);
    busy = "installing";
    const dir = join(deps.root, release.version);
    const part = `${dir}.part`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(part, { recursive: true });
    let exe: string;
    try {
      exe = unpackHlae(zip, part, release.version);
    } catch (e) {
      rmSync(part, { recursive: true, force: true });
      throw e;
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(part, dir);
    exe = join(dir, exe.slice(part.length + 1));
    // Antivirus can take files away as they are written.
    for (const f of [exe, join(dir, ...HOOK.split("/"))]) {
      if (!existsSync(f)) throw new Error(t("hlae.removed", { version: release.version, file: f }));
    }
    const managed: ManagedHlae = { version: release.version, dir, exe, installedAt: new Date(now()).toISOString() };
    deps.write({ hlaeManaged: managed, hlaePath: exe });
    prune(release.version);
    return managed;
  }

  const run = <T>(job: () => Promise<T>) =>
    serial(async () => {
      try {
        const r = await job();
        error = null;
        return r;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        throw e;
      } finally {
        busy = null;
        busyVersion = null;
        percent = null;
      }
    });

  return {
    status,
    inUse: () => inUse(),

    /** The Get HLAE button: the latest release, installed (or the one already installed, selected again). */
    get(): Promise<ManagedHlae> {
      return run(async () => {
        if (await deps.cs2Running()) throw new Error(t("hlae.cs2Running"));
        const release = await latestRelease(true);
        const have = deps.read().hlaeManaged;
        if (have && have.version === release.version && existsSync(have.exe) && existsSync(join(have.dir, ...HOOK.split("/")))) {
          deps.write({ hlaePath: have.exe });
          return have;
        }
        return install(release);
      });
    },

    /**
     * A newer HLAE when there is one, while the program's HLAE is in use. `force` asks GitHub again
     * (after a failed start, or the operator's button); otherwise a check from the last 30 minutes stands.
     * Never throws: the HLAE already installed keeps working when GitHub can't be reached.
     */
    async update(opts: { force?: boolean; manual?: boolean } = {}): Promise<HlaeUpdate> {
      const s = deps.read();
      if (!inUse(s)) return { updated: false, reason: "not_in_use", version: null };
      const current = s.hlaeManaged!.version;
      if (!s.hlaeAutoUpdate && !opts.manual) return { updated: false, reason: "off", version: current };
      try {
        return await run(async (): Promise<HlaeUpdate> => {
          if (await deps.cs2Running()) return { updated: false, reason: "cs2_running", version: current };
          const release = await latestRelease(!!opts.force);
          if (compareVersions(release.version, current) <= 0) return { updated: false, reason: "latest", version: current };
          await install(release);
          return { updated: true, from: current, to: release.version };
        });
      } catch (e) {
        return { updated: false, reason: "error", error: e instanceof Error ? e.message : String(e), version: current };
      }
    },

    setAutoUpdate(on: boolean): HlaeStatus {
      deps.write({ hlaeAutoUpdate: on });
      return status();
    },
  };
}

export type HlaeManager = ReturnType<typeof createHlaeManager>;

/**
 * Start CS2 with the program's HLAE kept current: a newer HLAE first when one is out (a check from
 * the last 30 minutes stands), and when HLAE fails to start CS2 (usually a CS2 update it doesn't
 * know yet), a check straight away and one more start with the newer HLAE. Another launch mode, or
 * an HLAE the operator chose, just starts.
 */
export async function launchWithHlae(opts: { hlaeMode: boolean; manager: Pick<HlaeManager, "inUse" | "update">; start: () => Promise<LaunchResult> }): Promise<LaunchResult> {
  const { manager, start } = opts;
  if (!opts.hlaeMode || !manager.inUse()) return start();
  const before = await manager.update();
  const updatedNote = before.updated ? `${t("hlae.updated", { from: before.from ?? "?", to: before.to })} ` : "";
  const first = await start();
  if (first.ok || !first.hlaeFailed) return { ...first, message: `${updatedNote}${first.message}` };
  const after = await manager.update({ force: true, manual: true });
  if (after.updated) {
    const again = await start();
    return { ...again, message: `${t("hlae.retried", { from: after.from ?? "?", to: after.to })} ${again.message}` };
  }
  const why = after.reason === "error" ? t("hlae.checkFailed", { error: after.error }) : t("hlae.noNewer", { version: after.version ?? "?" });
  return { ...first, message: `${updatedNote}${first.message} ${why}` };
}
