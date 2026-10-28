import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";
import { TimedCs2 } from "./helpers/fake-cs2.ts";

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => r(port));
    });
  });
}
const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * Dust2 like the owner's recording: a live round (the Auto Director starts and proves the camera),
 * the round's end, 20 s of freeze time with Ts in T spawn and CTs in CT spawn, then the round goes
 * live and the Ts run for B. CS2's game data lags its console by a quarter of a second, and only the
 * build's own spec_mode numbers (CS:GO's) take the camera out of the free camera: in 0.6.0 the lag
 * made Matchframe think the camera was out of a shot that wasn't, and save CS2's numbering instead,
 * so the camera stayed on the freeze-time shot through the live round.
 */
const LIVE_START = 33000;
const LIVE_END = 51000;
const T_SPAWN = { x: -296, y: -1136, z: 60 };
const CT_SPAWN = { x: 88, y: 2448, z: -60 };
const B_SITE = { x: -1768, y: 2384, z: 60 };
const MID_CT = { x: -400, y: 1700, z: -60 };

describe("Dust2: out of the freeze-time shot and into first person when the round goes live", () => {
  const work = mkdtempSync(join(tmpdir(), "mf-dust2-"));
  const cs2Dir = join(work, "Counter-Strike Global Offensive");
  mkdirSync(join(cs2Dir, "game", "csgo", "cfg"), { recursive: true });
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let cs2: TimedCs2;
  const samples: { at: number; free: boolean; phase: string | null; round: number | null }[] = [];
  let sampler: ReturnType<typeof setInterval> | null = null;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    const consolePort = await freePort();
    engine = new Engine(loadConfig({ dataDir: join(work, "data"), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: resolve(__dirname, "../../../assets/map-packs"), workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await engine.init();
    servers = await startServers(engine);
    cs2 = new TimedCs2({
      gsiUrl: `http://127.0.0.1:${ports.gsi}/gsi`,
      token: engine.secrets.gsiToken,
      map: "de_dust2",
      gsiLagMs: 250,
      freeMode: "spec_mode 6",
      playerModes: ["spec_mode 4", "spec_mode 5"],
      phase: (t) => {
        if (t < 9000) return { phase: "live", endsInSec: 60, round: 13 };
        if (t < 13000) return { phase: "over", endsInSec: (13000 - t) / 1000, round: 13 };
        if (t < LIVE_START) return { phase: "freezetime", endsInSec: (LIVE_START - t) / 1000, round: 14 };
        return { phase: "live", endsInSec: 115 - (t - LIVE_START) / 1000, round: 14 };
      },
      positions: (t, p) => {
        const live = Math.max(0, t - LIVE_START) / 1000;
        const i = p.slot % 5;
        const [from, to, secs] = p.side === "T" ? [T_SPAWN, B_SITE, 14] : [CT_SPAWN, MID_CT, 10];
        const k = Math.min(1, live / secs);
        return { x: from.x + (to.x - from.x) * k + i * 40, y: from.y + (to.y - from.y) * k + i * 30, z: from.z };
      },
    });
    await cs2.listen(consolePort);
    const token = engine.secrets.operatorToken;
    const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return (await res.json()) as Record<string, unknown>;
    };
    await api("/api/v1/setup/detect-cs2", { method: "POST", body: { manualInstallDir: cs2Dir } });
    await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "tools", netconPort: consolePort } });
    await api("/api/v1/director/auto/start", { method: "POST", body: { cinematic: true } });
    cs2.start();
    sampler = setInterval(() => {
      const st = engine.session.state();
      samples.push({ at: cs2.now(), free: cs2.free, phase: st?.roundPhase ?? null, round: st?.roundNumber ?? null });
    }, 100);
  });

  afterAll(async () => {
    if (sampler) clearInterval(sampler);
    await cs2?.stop();
    await servers?.close();
    await engine?.shutdown();
  });

  it("films the spawns in freeze time, is on a player from the start of the live round, and keeps CS2's spec_mode numbers", async () => {
    await waitFor(() => cs2.now() > LIVE_END, 70000);
    const freezeRound = samples.find((s) => s.at > 20000 && s.phase === "freezetime")!.round;
    const liveAt = samples.find((s) => s.round === freezeRound && s.phase === "live")!.at;
    const why = JSON.stringify(cs2.lines.filter((l) => l.at > 12000 && !/spec_goto/.test(l.line) || /^spec_mode/.test(l.line)).map((l) => `${(l.at / 1000).toFixed(1)} ${l.line}`));
    // A freeze-time shot played.
    expect(samples.some((s) => s.phase === "freezetime" && s.free), why).toBe(true);
    // On a player within a second of the engine seeing the round go live, and for the rest of it.
    const late = samples.filter((s) => s.at > liveAt + 1000 && s.at < LIVE_END - 500 && s.free);
    expect(late.map((s) => s.at), why).toEqual([]);
    // Only this build's numbers were ever sent (CS2's "spec_mode 2" leaves this camera where it is).
    expect(cs2.lines.filter((l) => /spec_mode [23]\b/.test(l.line)), why).toEqual([]);
    // The director log has it all: the console lines, the commands' results, the decisions and the game data's changes.
    const log = readFileSync(join(work, "data", "logs", "director.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { msg: string; data?: Record<string, unknown> });
    expect(log.some((l) => l.msg === "console" && /^spec_mode 4; spec_player /.test(String(l.data?.line)))).toBe(true);
    expect(log.some((l) => l.msg === "console" && /spec_goto/.test(String(l.data?.line)))).toBe(true);
    expect(log.filter((l) => l.msg === "console" && /^spec_goto /.test(String(l.data?.line)))).toEqual([]);
    for (const msg of ["command", "result", "decision", "game"]) expect(log.some((l) => l.msg === msg), msg).toBe(true);
    expect(log.some((l) => l.msg === "game" && l.data?.phase === "live" && l.data?.round === freezeRound)).toBe(true);
  }, 90000);
});
