import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Start CS2 from the program. The engine prepares the launch (GSI config, launch options, the
 * console connection) and this process starts it on this computer:
 *
 * - standard / tools: `steam.exe -applaunch 730 <options>` (Steam passes the options to CS2 without a
 *   prompt), or the `steam://run` link when steam.exe was not found.
 * - hlae: HLAE's custom loader starts cs2.exe with AfxHookSource2.dll and `-steam -insecure ...`.
 */

export interface LaunchPlan {
  mode: "standard" | "tools" | "hlae";
  installDir: string;
  steamExe: string | null;
  cs2Exe: string;
  args: string[];
  netconPort: number | null;
}

export interface PreparedLaunch {
  plan: LaunchPlan;
  gsi: { path: string | null; unchanged: boolean; error: string | null };
  observerAdapterChanged: boolean;
}

export interface LaunchResult {
  ok: boolean;
  message: string;
}

export interface HlaeInfo {
  path: string | null;
  ok: boolean;
  problem: string | null;
}

/** HLAE.exe with its CS2 hook next to it (`x64\AfxHookSource2.dll`). */
export function hlaeInfo(path: string | null, exists: (p: string) => boolean = existsSync): HlaeInfo {
  if (!path) return { path: null, ok: false, problem: "HLAE.exe is not chosen yet (download HLAE from advancedfx.org)." };
  if (basename(path).toLowerCase() !== "hlae.exe") return { path, ok: false, problem: "Choose the HLAE.exe file from the HLAE folder." };
  if (!exists(path)) return { path, ok: false, problem: `HLAE.exe is no longer at ${path}. Choose it again.` };
  if (!exists(join(dirname(path), "x64", "AfxHookSource2.dll"))) return { path, ok: false, problem: "This HLAE has no CS2 hook (x64\\AfxHookSource2.dll). Install the latest HLAE." };
  return { path, ok: true, problem: null };
}

/** HLAE's command line (custom loader, no window) for starting CS2 with its hook. */
export function hlaeArgs(hlaePath: string, plan: Pick<LaunchPlan, "cs2Exe" | "args">): string[] {
  return [
    "-customLoader",
    "-noGui",
    "-autoStart",
    "-hookDllPath",
    join(dirname(hlaePath), "x64", "AfxHookSource2.dll"),
    "-programPath",
    plan.cs2Exe,
    "-cmdLine",
    plan.args.join(" "),
    // cs2.exe started outside Steam needs to know its Steam app id.
    "-addEnv",
    "SteamAppId=730",
    "-addEnv",
    "SteamGameId=730",
  ];
}

export function steamRunUrl(args: string[]): string {
  return args.length ? `steam://run/730//${encodeURIComponent(args.join(" "))}/` : "steam://rungameid/730";
}

/** Whether a process with this image name runs (Windows; elsewhere always false). */
export function processRunning(image: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH", "/FO", "CSV"], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(!err && stdout.toLowerCase().includes(`"${image.toLowerCase()}"`)));
  });
}

const GSI_NOTE = (p: PreparedLaunch) => (p.gsi.error ? ` The game data (GSI) config could not be written: ${p.gsi.error}` : "");

export async function startCs2(prepared: PreparedLaunch, opts: { hlaePath: string | null; openExternal: (url: string) => Promise<void> }): Promise<LaunchResult> {
  const { plan } = prepared;
  if (await processRunning("cs2.exe")) {
    if (plan.mode === "standard" && prepared.gsi.unchanged) return { ok: true, message: "CS2 is already running." };
    return {
      ok: false,
      message:
        plan.mode === "standard"
          ? "CS2 is already running. Restart it so it reads the new game data (GSI) config."
          : "CS2 is already running without Matchframe's launch options. Close CS2, then click Start CS2 again.",
    };
  }

  if (plan.mode === "hlae") {
    const info = hlaeInfo(opts.hlaePath);
    if (!info.ok || !info.path) return { ok: false, message: info.problem ?? "Choose HLAE.exe first." };
    if (!existsSync(plan.cs2Exe)) return { ok: false, message: `cs2.exe was not found at ${plan.cs2Exe}. Check the CS2 folder in Settings → Setup.` };
    if (!(await processRunning("steam.exe")) && process.platform === "win32") return { ok: false, message: "Start Steam first: HLAE starts cs2.exe directly and needs Steam running." };
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(info.path!, hlaeArgs(info.path!, plan), { detached: true, stdio: "ignore", windowsHide: false });
      const timer = setTimeout(() => {
        child.unref();
        resolve(null);
      }, 60_000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(-1);
      });
      child.once("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    if (code !== 0 && code !== null) return { ok: false, message: `HLAE could not start CS2 (exit code ${code}). After a CS2 update HLAE often needs an update too: install the latest HLAE and try again.${GSI_NOTE(prepared)}` };
    return { ok: true, message: `Starting CS2 with HLAE (insecure). Matchframe connects to its console on port ${plan.netconPort} when it is up.${GSI_NOTE(prepared)}` };
  }

  if (plan.steamExe) {
    const child = spawn(plan.steamExe, ["-applaunch", "730", ...plan.args], { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
  } else {
    await opts.openExternal(steamRunUrl(plan.args));
  }
  const what = plan.mode === "tools" ? ` with the console on port ${plan.netconPort} (needs the CS2 Workshop Tools)` : "";
  return { ok: true, message: `Starting CS2 through Steam${what}.${GSI_NOTE(prepared)}` };
}
