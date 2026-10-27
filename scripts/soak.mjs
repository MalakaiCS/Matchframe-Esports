#!/usr/bin/env node
// Simulated soak: starts an isolated engine, runs the labelled simulation with operator and
// overlay WebSocket clients attached, enables automatic direction, and samples memory, queue
// and log sizes. Usage: node scripts/soak.mjs [--minutes 20] [--out soak.json] [--port-base 38510]
// This is SIMULATED evidence (synthetic GSI and observer); it does not replace a real match.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { repoRoot } from "./python-env.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const minutes = Number(opt("minutes", "20"));
const outFile = opt("out", null);
const WebSocket = createRequire(join(repoRoot, "services", "local-engine", "package.json"))("ws");
const dataDir = mkdtempSync(join(tmpdir(), "mf-soak-"));
const base = Number(opt("port-base", "38510"));
const ports = { MATCHFRAME_GSI_PORT: String(base), MATCHFRAME_API_PORT: String(base + 1), MATCHFRAME_OVERLAY_PORT: String(base + 2) };
const env = { ...process.env, ...ports, MATCHFRAME_DATA_DIR: dataDir, MATCHFRAME_LOG_STDOUT: "0" };
const engine = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "services/local-engine/src/main.ts")], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve, reject) => {
  engine.stdout.on("data", (d) => d.toString().includes("engine running") && resolve());
  engine.on("exit", (c) => reject(new Error(`engine exited ${c}`)));
});
const api = `http://127.0.0.1:${ports.MATCHFRAME_API_PORT}`;
const token = readFileSync(join(dataDir, "operator-token.txt"), "utf8").trim();
const call = async (method, path, body) => {
  const r = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const rss = () => {
  try {
    return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${engine.pid}/status`, "utf8"))[1]) / 1024;
  } catch {
    return null; // not Linux
  }
};

await call("POST", "/api/v1/simulation/start", { startOffsetSec: 0 });
await call("POST", "/api/v1/director/observer-mode", { mode: "full_action" });
await call("POST", "/api/v1/observer/resume", { countdownMs: 0 });
let opMessages = 0;
let hudMessages = 0;
const op = new WebSocket(`ws://127.0.0.1:${ports.MATCHFRAME_API_PORT}/api/v1/ws?token=${token}`);
op.on("message", () => opMessages++);
const { url } = await call("GET", "/api/v1/hud/outputs/main/url");
const u = new URL(url);
const hud = new WebSocket(`ws://${u.host}/overlay-ws?output=main&variant=live&t=${u.searchParams.get("t")}`);
hud.on("message", () => hudMessages++);

const samples = [];
const started = Date.now();
const sample = async () => {
  const [metrics, status, decisions] = await Promise.all([call("GET", "/api/v1/live/metrics"), call("GET", "/api/v1/status"), call("GET", "/api/v1/director/decisions?limit=5000")]);
  const s = { tMin: Math.round(((Date.now() - started) / 60000) * 100) / 100, rssMb: rss(), packets: metrics.packets, cuts: metrics.cuts, ingestP95Ms: metrics.ingestP95Ms, evalP95Ms: metrics.evalP95Ms, decisionsRetained: decisions.length, opMessages, hudMessages, mode: status.director?.mode ?? null };
  samples.push(s);
  process.stdout.write(`${JSON.stringify(s)}\n`);
};
await sample();
while (Date.now() - started < minutes * 60000) {
  await new Promise((r) => setTimeout(r, 30000));
  await sample();
}
const report = await call("GET", "/api/v1/reports/broadcast");
const first = samples[1] ?? samples[0];
const last = samples[samples.length - 1];
const summary = {
  simulated: true,
  minutes,
  rssMbFirstMinute: first.rssMb,
  rssMbEnd: last.rssMb,
  rssMbMax: Math.max(...samples.map((s) => s.rssMb ?? 0)),
  packets: last.packets,
  automaticCuts: last.cuts,
  ingestP95Ms: last.ingestP95Ms,
  evalP95Ms: last.evalP95Ms,
  decisionsRetainedMax: Math.max(...samples.map((s) => s.decisionsRetained)),
  operatorWsMessages: opMessages,
  overlayWsMessages: hudMessages,
  report: { automatedCommands: report.director?.automatedCommands, automatedConfirmed: report.director?.automatedConfirmed, cutsPerMinute: report.continuity?.cutsPerMinute, medianShotMs: report.continuity?.medianShotMs },
  samples,
};
if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2));
process.stdout.write(`SUMMARY ${JSON.stringify({ ...summary, samples: undefined })}\n`);
op.close();
hud.close();
engine.kill("SIGTERM");
