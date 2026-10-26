import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPath, parseVdf } from "../vdf.ts";

export const CS2_APP_ID = "730";

export interface DiscoveryEnv {
  platform: NodeJS.Platform;
  exists: (p: string) => boolean;
  read: (p: string) => string;
  /** Windows registry lookup for the Steam path (e.g. via `reg query`); returns null if unavailable. */
  steamPathFromRegistry?: () => string | null;
  home: string;
  env: Record<string, string | undefined>;
}

export interface Cs2Install {
  steamRoot: string;
  libraryPath: string;
  installDir: string;
  cfgDir: string;
  gameBuildFromManifest: string | null;
}

export interface DiscoveryResult {
  steamRoots: string[];
  libraries: string[];
  install: Cs2Install | null;
  problems: string[];
}

export function defaultDiscoveryEnv(): DiscoveryEnv {
  return {
    platform: process.platform,
    exists: existsSync,
    read: (p) => readFileSync(p, "utf8"),
    home: process.env.USERPROFILE ?? process.env.HOME ?? "",
    env: process.env,
  };
}

function candidateSteamRoots(env: DiscoveryEnv): string[] {
  const out: string[] = [];
  const reg = env.steamPathFromRegistry?.();
  if (reg) out.push(reg.replace(/\//g, "\\"));
  if (env.platform === "win32") {
    out.push(join(env.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Steam"));
    out.push(join(env.env.ProgramFiles ?? "C:\\Program Files", "Steam"));
  } else if (env.platform === "darwin") {
    out.push(join(env.home, "Library", "Application Support", "Steam"));
  } else {
    out.push(join(env.home, ".steam", "steam"), join(env.home, ".local", "share", "Steam"));
  }
  return [...new Set(out)];
}

/** Finds the CS2 installation from Steam library folders; a manual path can always override. */
export function discoverCs2(env: DiscoveryEnv = defaultDiscoveryEnv(), manualInstallDir?: string): DiscoveryResult {
  const problems: string[] = [];
  if (manualInstallDir) {
    const cfgDir = join(manualInstallDir, "game", "csgo", "cfg");
    if (!env.exists(cfgDir)) return { steamRoots: [], libraries: [], install: null, problems: [`No game/csgo/cfg directory under ${manualInstallDir}`] };
    return { steamRoots: [], libraries: [], install: { steamRoot: "", libraryPath: "", installDir: manualInstallDir, cfgDir, gameBuildFromManifest: null }, problems };
  }
  const steamRoots = candidateSteamRoots(env).filter((r) => env.exists(r));
  if (steamRoots.length === 0) problems.push("Steam installation not found; select the CS2 folder manually.");
  const libraries = new Set<string>();
  for (const root of steamRoots) {
    libraries.add(root);
    const lf = join(root, "steamapps", "libraryfolders.vdf");
    if (!env.exists(lf)) continue;
    try {
      const vdf = parseVdf(env.read(lf));
      const folders = getPath(vdf, "libraryfolders");
      if (folders && typeof folders === "object") {
        for (const v of Object.values(folders)) {
          if (typeof v === "object") {
            const p = getPath(v, "path");
            if (typeof p === "string") libraries.add(p.replace(/\\\\/g, "\\"));
          } else if (typeof v === "string" && /[\\/]/.test(v)) libraries.add(v);
        }
      }
    } catch (e) {
      problems.push(`Could not parse ${lf}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const lib of libraries) {
    const manifest = join(lib, "steamapps", `appmanifest_${CS2_APP_ID}.acf`);
    if (!env.exists(manifest)) continue;
    let installdirName = "Counter-Strike Global Offensive";
    let build: string | null = null;
    try {
      const acf = parseVdf(env.read(manifest));
      const d = getPath(acf, "AppState", "installdir");
      if (typeof d === "string") installdirName = d;
      const b = getPath(acf, "AppState", "buildid");
      if (typeof b === "string") build = b;
    } catch (e) {
      problems.push(`Could not parse ${manifest}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const installDir = join(lib, "steamapps", "common", installdirName);
    const cfgDir = join(installDir, "game", "csgo", "cfg");
    if (!env.exists(cfgDir)) {
      problems.push(`CS2 manifest found but ${cfgDir} is missing.`);
      continue;
    }
    return { steamRoots, libraries: [...libraries], install: { steamRoot: steamRoots[0] ?? lib, libraryPath: lib, installDir, cfgDir, gameBuildFromManifest: build }, problems };
  }
  if (steamRoots.length > 0) problems.push("CS2 (app 730) not found in any Steam library.");
  return { steamRoots, libraries: [...libraries], install: null, problems };
}
