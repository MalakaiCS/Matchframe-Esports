#!/usr/bin/env node
// Development startup: builds the browser apps when their dist folders are missing (or with --build),
// then runs the local engine from source. Pass --sim to start the labelled simulation once ready.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoRoot, resolvePython, workersDir } from "./python-env.mjs";

const args = new Set(process.argv.slice(2));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

for (const app of ["hud-renderer", "operator-web"]) {
  const dir = join(repoRoot, "apps", app);
  if (!existsSync(join(dir, "package.json"))) continue;
  if (args.has("--build") || !existsSync(join(dir, "dist", "index.html"))) {
    process.stdout.write(`Building apps/${app}…\n`);
    const r = spawnSync(pnpm, ["--filter", `@matchframe/${app}`, "run", "build"], { stdio: "inherit", cwd: repoRoot, shell: process.platform === "win32" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

const env = { ...process.env, MATCHFRAME_PYTHON: process.env.MATCHFRAME_PYTHON ?? resolvePython(), MATCHFRAME_WORKERS_DIR: process.env.MATCHFRAME_WORKERS_DIR ?? workersDir };
const engine = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "services/local-engine/src/main.ts")], { stdio: ["inherit", "pipe", "inherit"], cwd: repoRoot, env });
let started = false;
engine.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (!started && chunk.toString().includes("engine running")) {
    started = true;
    if (args.has("--sim")) void startSimulation();
  }
});
const stop = () => engine.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
engine.on("exit", (code) => process.exit(code ?? 0));

function dataDir() {
  if (env.MATCHFRAME_DATA_DIR) return env.MATCHFRAME_DATA_DIR;
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Matchframe Esports");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Matchframe Esports");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "matchframe-esports");
}

async function startSimulation() {
  const port = env.MATCHFRAME_API_PORT ?? "37211";
  try {
    const token = new URL(readFileSync(join(dataDir(), "operator-url.txt"), "utf8").trim()).searchParams.get("token");
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/simulation/start`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    process.stdout.write(`Simulation start: HTTP ${res.status} (SIMULATION — synthetic data on de_synthetic)\n`);
  } catch (e) {
    process.stderr.write(`Could not start simulation: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
