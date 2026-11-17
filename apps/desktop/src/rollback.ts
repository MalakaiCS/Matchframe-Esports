import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { DataBackup, DataState, RollbackDataPlan } from "../../../services/local-engine/src/db/version-backups.ts";
import { compareVersions, isPrerelease, parseVersion } from "./versions.ts";

/**
 * Go back to a previous version (ADR-076): Settings → General → Program lists earlier Stable releases
 * from GitHub; on the operator's choice the program downloads that release's installer, checks its
 * SHA-256 against the release's SHA256SUMS.txt, says what happens to the data and asks, stops the
 * engine, puts back the data copy that version reads when it needs one (db/version-backups.ts), and
 * runs the installer the way an update does (silent, same folder, user data kept, then starts it).
 * Electron is reached only through `RollbackDeps`, so the flow is tested with a stand-in release feed.
 */

export const RELEASES_API = "https://api.github.com/repos/MalakaiCS/Matchframe-Esports/releases?per_page=50";
const CHECKSUMS = "SHA256SUMS.txt";
/** The number of earlier versions offered. */
const LIST_LIMIT = 10;

export interface RollbackRelease {
  version: string;
  tag: string;
  publishedAt: string | null;
  notesUrl: string;
  installer: { name: string; url: string; size: number };
  checksumsUrl: string;
}

/** One earlier version as the console lists it. */
export interface RollbackOption {
  version: string;
  publishedAt: string | null;
  notesUrl: string;
  data: { kind: RollbackDataPlan["kind"]; text: string };
}

export type RollbackProgress =
  | { stage: "checking"; version: string }
  | { stage: "downloading"; version: string; percent: number | null }
  | { stage: "verifying"; version: string }
  | { stage: "confirming"; version: string }
  | { stage: "installing"; version: string };

export interface RollbackResult {
  ok: boolean;
  cancelled?: boolean;
  message: string;
}

export interface Confirmation {
  title: string;
  message: string;
  detail: string;
  ok: string;
}

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface DataSafety {
  inspectData(dataDir: string): DataState;
  planRollbackData(target: string, state: DataState): RollbackDataPlan;
  restoreBackup(dataDir: string, backup: DataBackup): { safetyCopy: string | null };
}

export interface RollbackDeps {
  currentVersion: string;
  dataDir: string;
  /** The program's own folder for the download (emptied at each start). */
  downloadDir: string;
  fetch: Fetch;
  /** db/version-backups.ts (main.ts loads it only when needed). */
  data(): Promise<DataSafety>;
  confirm(c: Confirmation): Promise<boolean>;
  /** Stops this computer's engine; resolves once it has exited (at once when none runs). */
  stopEngine(): Promise<void>;
  /** Starts it again after a failure past stopEngine (this computer's production only). */
  startEngine(): void;
  /** Runs the installer and quits the program. */
  install(installerFile: string): void;
  progress(p: RollbackProgress): void;
  log(msg: string): void;
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

/** Earlier Stable releases that can be installed and checked, newest first. */
export function selectRollbackReleases(raw: unknown, currentVersion: string, limit = LIST_LIMIT): RollbackRelease[] {
  if (!Array.isArray(raw)) throw new Error("GitHub's list of releases is not in the expected form.");
  const out: RollbackRelease[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") continue;
    const version = r.tag_name.replace(/^v/, "");
    if (!parseVersion(version) || isPrerelease(version) || compareVersions(version, currentVersion) >= 0) continue;
    const assets = (Array.isArray(r.assets) ? r.assets : []) as GithubAsset[];
    const asset = (re: RegExp) => assets.find((a) => typeof a.name === "string" && re.test(a.name) && typeof a.browser_download_url === "string" && /^https:\/\//.test(a.browser_download_url));
    const installer = asset(new RegExp(`^matchframeesports-setup-${version.replace(/\./g, "\\.")}\\.exe$`, "i"));
    const sums = asset(/^SHA256SUMS\.txt$/);
    if (!installer || !sums) continue;
    out.push({
      version,
      tag: r.tag_name,
      publishedAt: typeof r.published_at === "string" ? r.published_at : null,
      notesUrl: typeof r.html_url === "string" ? r.html_url : `https://github.com/MalakaiCS/Matchframe-Esports/releases/tag/${r.tag_name}`,
      installer: { name: installer.name as string, url: installer.browser_download_url as string, size: typeof installer.size === "number" ? installer.size : 0 },
      checksumsUrl: sums.browser_download_url as string,
    });
  }
  return out.sort((a, b) => compareVersions(b.version, a.version)).slice(0, limit);
}

/** SHA256SUMS.txt (`<hash>  <file>` per line, as the release workflow writes it) → file name (lower case) → hash. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.replace(/^\uFEFF/, ""));
    if (m) out.set(m[2]!.toLowerCase(), m[1]!.toLowerCase());
  }
  return out;
}

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** What going back does to the data, in the operator's words. */
export function describeDataPlan(plan: RollbackDataPlan): string {
  switch (plan.kind) {
    case "fresh":
      return "There's no MatchFrame data on this computer yet, so there's nothing to restore.";
    case "keep":
      return "This version reads your data as it is: nothing is restored and nothing is lost.";
    case "restore":
      return `Restores the copy of your data made ${when(plan.backup.createdAt)}${plan.backup.fromVersion ? `, when version ${plan.backup.fromVersion} was updated` : ""}. Changes made since then (teams, players, matches, HUD and other settings) are lost; today's data is kept as a copy in the backups folder.`;
    case "refuse":
      return plan.reason;
  }
}

export function confirmation(target: string, current: string, plan: RollbackDataPlan, toStable: boolean): Confirmation {
  const lines = [
    toStable ? `${target} is the latest Stable version. It's older than the beta you have (${current}).` : `You have version ${current}.`,
    `The installer for ${target} has been downloaded and matches the release's SHA256SUMS.txt.`,
    describeDataPlan(plan),
    "Your HUD files and program settings stay. Automatic update downloads are turned off, so MatchFrame doesn't update straight back; turn them on again in Settings → General → Program.",
    `MatchFrame and every HUD output close now; version ${target} starts when it's installed.`,
  ];
  return { title: "Go back to a previous version", message: `Go back to MatchFrame ${target}?`, detail: lines.join("\n\n"), ok: `Go back to ${target}` };
}

async function fetchReleases(deps: RollbackDeps): Promise<RollbackRelease[]> {
  let res: Response;
  try {
    res = await deps.fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json", "user-agent": "MatchFrame-Esports" }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(`Can't reach GitHub for the list of versions: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (res.status === 403 || res.status === 429) throw new Error("GitHub is limiting requests from this network for now. Try again in an hour.");
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the list of versions.`);
  return selectRollbackReleases(await res.json(), deps.currentVersion);
}

/** Downloads the installer, hashing it on the way, and keeps it only if it matches SHA256SUMS.txt. */
export async function downloadVerified(release: RollbackRelease, deps: Pick<RollbackDeps, "fetch" | "downloadDir" | "progress">): Promise<string> {
  const sumsRes = await deps.fetch(release.checksumsUrl, { signal: AbortSignal.timeout(30_000) });
  if (!sumsRes.ok) throw new Error(`Couldn't download ${CHECKSUMS} for version ${release.version} (HTTP ${sumsRes.status}).`);
  const expected = parseChecksums(await sumsRes.text()).get(release.installer.name.toLowerCase());
  if (!expected) throw new Error(`${CHECKSUMS} for version ${release.version} doesn't list ${release.installer.name}, so the download can't be checked.`);

  rmSync(deps.downloadDir, { recursive: true, force: true });
  mkdirSync(deps.downloadDir, { recursive: true });
  const file = join(deps.downloadDir, release.installer.name);
  const part = `${file}.part`;
  const res = await deps.fetch(release.installer.url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`Couldn't download the installer for version ${release.version} (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || release.installer.size || 0;
  const hash = createHash("sha256");
  let received = 0;
  let shown = -1;
  deps.progress({ stage: "downloading", version: release.version, percent: total ? 0 : null });
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : null;
      if (percent !== null && percent !== shown) {
        shown = percent;
        deps.progress({ stage: "downloading", version: release.version, percent });
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), count, createWriteStream(part));
  } catch (e) {
    rmSync(part, { force: true });
    throw new Error(`The download of version ${release.version} stopped: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  deps.progress({ stage: "verifying", version: release.version });
  const actual = hash.digest("hex");
  if (actual !== expected) {
    rmSync(part, { force: true });
    throw new Error(`The downloaded installer for version ${release.version} doesn't match its SHA-256 in ${CHECKSUMS} (expected ${expected}, got ${actual}). It was deleted; nothing was changed.`);
  }
  renameSync(part, file);
  return file;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createRollback(deps: RollbackDeps) {
  let busy = false;
  return {
    /** Earlier Stable versions and what going back to each does to this computer's data. */
    async list(): Promise<RollbackOption[]> {
      const releases = await fetchReleases(deps);
      const data = await deps.data();
      const state = data.inspectData(deps.dataDir);
      return releases.map((r) => {
        const plan = data.planRollbackData(r.version, state);
        return { version: r.version, publishedAt: r.publishedAt, notesUrl: r.notesUrl, data: { kind: plan.kind, text: describeDataPlan(plan) } };
      });
    },

    /** Goes back to `version` (toStable: the operator switched from Beta to Stable and this is the latest Stable version). */
    async start(version: string, opts: { toStable?: boolean } = {}): Promise<RollbackResult> {
      if (busy) return { ok: false, message: "MatchFrame is already going back to a version." };
      busy = true;
      let engineStopped = false;
      try {
        deps.progress({ stage: "checking", version });
        const release = (await fetchReleases(deps)).find((r) => r.version === version);
        if (!release) return { ok: false, message: `Version ${version} can't be installed from here (it isn't an earlier Stable release with an installer and checksums).` };
        const data = await deps.data();
        const plan = data.planRollbackData(version, data.inspectData(deps.dataDir));
        if (plan.kind === "refuse") return { ok: false, message: plan.reason };
        const installer = await downloadVerified(release, deps);
        deps.progress({ stage: "confirming", version });
        if (!(await deps.confirm(confirmation(version, deps.currentVersion, plan, opts.toStable === true)))) {
          rmSync(deps.downloadDir, { recursive: true, force: true });
          return { ok: false, cancelled: true, message: "Cancelled: nothing was changed." };
        }
        deps.progress({ stage: "installing", version });
        await deps.stopEngine();
        engineStopped = true;
        // With the engine stopped, the data on disk is final: it must still match what was confirmed.
        const final = data.planRollbackData(version, data.inspectData(deps.dataDir));
        if (JSON.stringify(final) !== JSON.stringify(plan)) throw new Error("Your data changed while the installer was downloading. Nothing was changed; try again.");
        if (final.kind === "restore") {
          const { safetyCopy } = data.restoreBackup(deps.dataDir, final.backup);
          deps.log(`going back to ${version}: restored ${final.backup.name}${safetyCopy ? `; the data before going back is ${safetyCopy}` : ""}`);
        }
        deps.install(installer);
        return { ok: true, message: `Installing version ${version}. MatchFrame closes and starts again when it's done.` };
      } catch (e) {
        if (engineStopped) deps.startEngine();
        deps.log(`going back to ${version} failed: ${message(e)}`);
        return { ok: false, message: message(e) };
      } finally {
        busy = false;
      }
    },
  };
}

export type Rollback = ReturnType<typeof createRollback>;
