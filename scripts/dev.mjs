#!/usr/bin/env node
// Development startup: builds the browser apps and the program's main/preload bundles when missing
// (or with --build), then launches the Matchframe program (Electron), which runs the engine from
// source. --sim starts the labelled simulation once the engine is ready. --engine-only runs the
// engine without the program (API, HUD outputs and captain page only; no console). The program
// reports sign-in as not required during development; --sign-in reports it as required, as release
// builds do (set MATCHFRAME_CLOUD_URL to a website, e.g. a local `pnpm cloud`).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoRoot, resolvePython, workersDir } from "./python-env.mjs";

const args = new Set(process.argv.slice(2));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

for (const [app, marker] of [["hud-renderer", "dist/index.html"], ["operator-web", "dist-captain/captain.html"]]) {
  const dir = join(repoRoot, "apps", app);
  if (!existsSync(join(dir, "package.json"))) continue;
  if (args.has("--build") || !existsSync(join(dir, marker))) {
    process.stdout.write(`Building apps/${app}…\n`);
    run(pnpm, ["--filter", `@matchframe/${app}`, "run", "build"]);
  }
}

const env = {
  ...process.env,
  MATCHFRAME_PYTHON: process.env.MATCHFRAME_PYTHON ?? resolvePython(),
  MATCHFRAME_WORKERS_DIR: process.env.MATCHFRAME_WORKERS_DIR ?? workersDir,
  MATCHFRAME_SIGN_IN: args.has("--sign-in") ? "required" : (process.env.MATCHFRAME_SIGN_IN ?? "off"),
};
const apiPort = env.MATCHFRAME_API_PORT ?? "37211";

let child;
if (args.has("--engine-only")) {
  child = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "services/local-engine/src/main.ts")], { stdio: "inherit", cwd: repoRoot, env });
} else {
  const desktop = join(repoRoot, "apps", "desktop");
  if (args.has("--build") || !existsSync(join(desktop, "dist", "main.cjs"))) {
    process.stdout.write("Building the program (apps/desktop)…\n");
    run(pnpm, ["--filter", "@matchframe/desktop", "run", "build"]);
  }
  const electron = createRequire(join(desktop, "package.json"))("electron");
  child = spawn(electron, [desktop], { stdio: "inherit", cwd: repoRoot, env });
}
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
if (args.has("--sim")) void startSimulationWhenReady();

function dataDir() {
  if (env.MATCHFRAME_DATA_DIR) return env.MATCHFRAME_DATA_DIR;
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Matchframe Esports");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Matchframe Esports");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "matchframe-esports");
}

async function startSimulationWhenReady() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const token = readFileSync(join(dataDir(), "operator-token.txt"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/v1/simulation/start`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    process.stdout.write(`Simulation start: HTTP ${res.status} (SIMULATION — synthetic data on de_synthetic)\n`);
  } catch (e) {
    process.stderr.write(`Could not start simulation: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
