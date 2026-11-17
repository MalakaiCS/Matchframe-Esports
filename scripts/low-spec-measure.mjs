#!/usr/bin/env node
// Measures what Low-spec mode (one PC, ADR-078) saves, on Linux, with the built-in labelled simulation:
// CPU time and frames drawn for one HUD output (an OBS-style browser page in Chromium under Xvfb) and
// CPU time, HUD messages and memory for the engine. Each run starts a fresh engine with its own data
// folder, so every run plays the same simulated round from the same point.
//
//   xvfb-run -a node scripts/low-spec-measure.mjs --low-spec both --reps 3 --out low-spec.json
//   xvfb-run -a node scripts/low-spec-measure.mjs --low-spec untouched --reps 3   (a build without it)
//
// Options: --low-spec both|off|on|untouched (both: off and on runs taken in turn, so a change in the
// computer's other load falls on both alike; untouched: leave the setting alone), --hud <library id>
// (default matchframe.vector), --offset <s> (0: where in the simulated 80 s round to start; the bomb
// is planted at 64 s, so --offset 56 --seconds 13 measures the planted bomb), --warmup <s> (10),
// --seconds <s> (40), --reps <n> (1; with both, pairs), --extra-clients <n> (0: more sockets on the
// same output, as when OBS, the desktop HUD and a preview all show it), --out <file.json>,
// --port-base <n> (38710). Needs the HUD packages built (pnpm build, or at least apps/hud-renderer
// and apps/hud-designs) and Playwright's Chromium. Without a display it starts itself again under
// xvfb-run when that is installed. Each run records the computer's load average: other programs
// busy at the same time make the numbers noisier.
//
// This is SIMULATED evidence on one Linux computer with software rendering: it shows the direction and
// rough size of the savings, not the numbers of a Windows PC running CS2 and OBS.
/* global window -- page.waitForFunction's body runs in the browser */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};

if (process.platform !== "linux") {
  console.error("low-spec-measure reads CPU time from /proc: run it on Linux (xvfb-run -a node scripts/low-spec-measure.mjs …).");
  process.exit(2);
}
if (!process.env.DISPLAY && !process.env.MF_MEASURE_NO_XVFB) {
  // Headful Chromium needs a display: run again under a virtual one.
  try {
    execFileSync("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: "inherit", env: { ...process.env, MF_MEASURE_NO_XVFB: "1" } });
    process.exit(0);
  } catch (e) {
    console.error(e.status === undefined ? "No display and no xvfb-run: install Xvfb or run under a display." : `measurement failed (${e.status})`);
    process.exit(e.status ?? 2);
  }
}

const mode = opt("low-spec", "both");
if (!["both", "off", "on", "untouched"].includes(mode)) throw new Error("--low-spec must be both, off, on or untouched");
const hudId = opt("hud", "matchframe.vector");
const offsetS = Math.max(0, Math.min(80, Number(opt("offset", "0"))));
const warmupS = Number(opt("warmup", "10"));
const seconds = Number(opt("seconds", "40"));
const reps = Math.max(1, Number(opt("reps", "1")));
const outFile = opt("out", null);
const portBase = Number(opt("port-base", "38710"));
const CLK_TCK = Number(execFileSync("getconf", ["CLK_TCK"]).toString().trim()) || 100;
const extraClients = Math.max(0, Number(opt("extra-clients", "0")));
const require = createRequire(join(repoRoot, "package.json"));
const { chromium } = require("playwright");
const WebSocket = createRequire(join(repoRoot, "services", "local-engine", "package.json"))("ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CPU time (ms) a process has used: user + system, from /proc/<pid>/stat. */
function cpuMs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return ((Number(f[11]) + Number(f[12])) * 1000) / CLK_TCK;
  } catch {
    return 0;
  }
}

/**
 * A process and everything it started, with Chromium's process type (browser, renderer, gpu-process,
 * utility, zygote) and whether it is Chromium (Playwright starts the browser as this script's child).
 */
function tree(root) {
  const kids = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(name));
    } catch {
      // gone
    }
  }
  const out = [];
  // Chromium starts its zygote and child processes as /proc/self/exe: everything under the browser is Chromium.
  const walk = (pid, inChromium) => {
    let type = "other";
    let isChromium = inChromium;
    try {
      // Chromium rewrites its child processes' command lines as one space-separated string.
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\0 ]+/);
      isChromium ||= /chrom/i.test(cmd[0] ?? "");
      type = cmd.find((a) => a.startsWith("--type="))?.slice(7) ?? (isChromium ? "browser" : "other");
    } catch {
      // gone
    }
    out.push({ pid, type, chromium: isChromium });
    for (const k of kids.get(pid) ?? []) walk(k, isChromium);
  };
  walk(root, false);
  return out;
}

const rssMb = (pid) => {
  try {
    return Math.round(Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))[1]) / 1024);
  } catch {
    return null;
  }
};

async function startEngine(dataDir, base) {
  const env = { ...process.env, MATCHFRAME_GSI_PORT: String(base), MATCHFRAME_API_PORT: String(base + 1), MATCHFRAME_OVERLAY_PORT: String(base + 2), MATCHFRAME_DATA_DIR: dataDir, MATCHFRAME_LOG_STDOUT: "0", MATCHFRAME_SIGN_IN: "off" };
  const engine = spawn(process.execPath, ["--import", "tsx", join(repoRoot, "services/local-engine/src/main.ts")], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  engine.stderr.on("data", (d) => (err = (err + d.toString()).slice(-4000)));
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`engine did not start in 90 s\n${err}`)), 90_000);
    engine.stdout.on("data", (d) => d.toString().includes("engine running") && (clearTimeout(t), ok()));
    engine.on("exit", (c) => fail(new Error(`engine exited ${c}\n${err}`)));
  });
  const api = `http://127.0.0.1:${base + 1}`;
  const token = readFileSync(join(dataDir, "operator-token.txt"), "utf8").trim();
  const call = async (method, path, body) => {
    const r = await fetch(api + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  return { engine, call };
}

/** Frames the page's compositor drew (DrawFrame trace events in its renderer processes). */
function countFrames(traceBuf, rendererPids) {
  const events = JSON.parse(traceBuf.toString("utf8")).traceEvents ?? [];
  let drawn = 0;
  let mainFrames = 0;
  for (const ev of events) {
    if (!rendererPids.has(ev.pid)) continue;
    if (ev.name === "DrawFrame" && ev.ph !== "e") drawn++;
    if (ev.name === "BeginMainThreadFrame") mainFrames++;
  }
  return { drawn, mainFrames };
}

async function runOnce(rep, condition) {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-lowspec-"));
  const base = portBase + rep * 10;
  const { engine, call } = await startEngine(dataDir, base);
  let browser = null;
  const extras = [];
  try {
    if (condition !== "untouched") await call("PUT", "/api/v1/performance", { lowSpec: condition === "on" });
    const lib = await call("GET", "/api/v1/hud/library");
    const hud = lib.huds.find((h) => h.id === hudId);
    if (!hud?.urls?.live) throw new Error(`no HUD ${hudId} with a live page (have: ${lib.huds.map((h) => h.id).join(", ")}); build the HUD packages first`);
    await call("POST", "/api/v1/simulation/start", { startOffsetSec: offsetS });
    const simStarted = Date.now();
    const url = new URL(hud.urls.live);
    url.searchParams.set("mode", "obs");
    browser = await chromium.launch({ headless: false, args: ["--window-size=1920,1080", "--no-first-run", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    let hudMessages = 0;
    let counting = false;
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/overlay-ws")) return;
      ws.on("framereceived", () => counting && hudMessages++);
    });
    await page.goto(url.toString());
    // Runs in the page (whose CSP allows no string evaluation).
    await page.waitForFunction(() => window.__mfOverlay?.status().frameLoaded === true, null, { timeout: 30_000 });
    // The same output open elsewhere too (OBS, the desktop HUD, a preview): plain socket clients, so
    // only the engine's side of them is added.
    for (let i = 0; i < extraClients; i++) extras.push(new WebSocket(`ws://${url.host}/overlay-ws?output=${encodeURIComponent(`hud:${hudId}`)}&variant=live&t=${url.searchParams.get("t")}`));
    await sleep(Math.max(0, warmupS * 1000 - (Date.now() - simStarted)));
    const procs = tree(process.pid).filter((p) => p.chromium);
    const renderers = new Set(procs.filter((p) => p.type === "renderer").map((p) => p.pid));
    const before = { engine: cpuMs(engine.pid), chromium: new Map(procs.map((p) => [p.pid, cpuMs(p.pid)])) };
    await browser.startTracing(page, { categories: ["disabled-by-default-devtools.timeline.frame"] });
    counting = true;
    const loadBefore = loadavg()[0];
    const t0 = Date.now();
    await sleep(seconds * 1000);
    const elapsedS = (Date.now() - t0) / 1000;
    const loadAfter = loadavg()[0];
    counting = false;
    const after = { engine: cpuMs(engine.pid), chromium: new Map(procs.map((p) => [p.pid, cpuMs(p.pid)])) };
    const trace = await browser.stopTracing();
    const frames = countFrames(trace, renderers);
    const byType = {};
    for (const p of procs) byType[p.type] = (byType[p.type] ?? 0) + (after.chromium.get(p.pid) - before.chromium.get(p.pid));
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    const perf = await call("GET", "/api/v1/performance").catch(() => null);
    const smooth = (await call("GET", "/api/v1/hud/library")).huds.find((h) => h.id === hudId)?.smoothness?.obs ?? null;
    const pct = (ms) => Math.round((ms / (elapsedS * 1000)) * 1000) / 10;
    return {
      rep,
      condition,
      seconds: Math.round(elapsedS * 10) / 10,
      /** The computer's 1-minute load average at the window's start and end (other programs make the numbers noisier). */
      loadAverage: [Math.round(loadBefore * 100) / 100, Math.round(loadAfter * 100) / 100],
      hud: { cpuPercent: pct(total), cpuPercentByProcess: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, pct(v)])), framesDrawnPerSec: Math.round((frames.drawn / elapsedS) * 10) / 10, mainThreadFramesPerSec: Math.round((frames.mainFrames / elapsedS) * 10) / 10, reportedFps: smooth?.fps ?? null, messagesPerSec: Math.round((hudMessages / elapsedS) * 10) / 10 },
      engine: { cpuPercent: pct(after.engine - before.engine), rssMb: rssMb(engine.pid), heapLimitMb: perf?.engine?.heapLimitMb ?? null },
      lowSpec: perf?.lowSpec ?? null,
    };
  } finally {
    for (const ws of extras) ws.terminate();
    await browser?.close().catch(() => undefined);
    engine.kill("SIGTERM");
    await new Promise((r) => (engine.exitCode !== null ? r() : engine.once("exit", r)));
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 10) / 10;
};

const medians = (rs) => ({
  runs: rs.length,
  hudCpuPercent: median(rs.map((r) => r.hud.cpuPercent)),
  hudRendererCpuPercent: median(rs.map((r) => r.hud.cpuPercentByProcess.renderer ?? 0)),
  hudGpuProcessCpuPercent: median(rs.map((r) => r.hud.cpuPercentByProcess["gpu-process"] ?? 0)),
  framesDrawnPerSec: median(rs.map((r) => r.hud.framesDrawnPerSec)),
  mainThreadFramesPerSec: median(rs.map((r) => r.hud.mainThreadFramesPerSec)),
  reportedFps: median(rs.map((r) => r.hud.reportedFps ?? 0)),
  hudMessagesPerSec: median(rs.map((r) => r.hud.messagesPerSec)),
  engineCpuPercent: median(rs.map((r) => r.engine.cpuPercent)),
  engineRssMb: median(rs.map((r) => r.engine.rssMb ?? 0)),
  loadAverage: median(rs.flatMap((r) => r.loadAverage)),
});

// "both": off, on, off, on… so the computer's other load falls on both alike.
const plan = mode === "both" ? Array.from({ length: reps }, () => ["off", "on"]).flat() : Array.from({ length: reps }, () => mode);
const runs = [];
for (const [i, condition] of plan.entries()) {
  const r = await runOnce(i, condition);
  runs.push(r);
  console.log(JSON.stringify(r));
}
const conditions = [...new Set(plan)];
const summary = {
  simulated: true,
  lowSpec: mode,
  hud: hudId,
  offsetS,
  extraClients,
  warmupS,
  seconds,
  reps,
  median: Object.fromEntries(conditions.map((c) => [c, medians(runs.filter((r) => r.condition === c))])),
  runs,
};
console.log(JSON.stringify(summary.median));
if (outFile) writeFileSync(outFile, JSON.stringify(summary, null, 2));
