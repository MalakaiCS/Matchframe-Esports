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
 * so the camera stayed on the freeze-time shot through the live round. The next round's freeze
 * time has a CT tactical timeout in the middle.
 */
const LIVE_START = 33000;
const LIVE_END = 51000;
const FREEZE2 = 55000;
const TIMEOUT = [59000, 69000] as const;
const LIVE2_START = 75000;
const LIVE2_END = 88000;
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
  const commands: { at: number; request: Record<string, unknown> }[] = [];
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
        if (t < LIVE_END) return { phase: "live", endsInSec: 115 - (t - LIVE_START) / 1000, round: 14 };
        if (t < FREEZE2) return { phase: "over", endsInSec: (FREEZE2 - t) / 1000, round: 14 };
        // A CT tactical timeout in the middle of freeze time (its own countdown), then the rest of freeze time.
        if (t >= TIMEOUT[0] && t < TIMEOUT[1]) return { phase: "freezetime", countdown: "timeout_ct", endsInSec: (TIMEOUT[1] - t) / 1000, round: 15 };
        if (t < LIVE2_START) return { phase: "freezetime", endsInSec: (LIVE2_START - t) / 1000, round: 15 };
        return { phase: "live", endsInSec: 115 - (t - LIVE2_START) / 1000, round: 15 };
      },
      positions: (t, p) => {
        const live = Math.max(0, t - (t >= LIVE_END ? LIVE2_START : LIVE_START)) / 1000;
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
    engine.session.on("arbiter", (e: { kind: string; detail: Record<string, unknown> }) => {
      if (e.kind === "command") commands.push({ at: cs2.now(), request: e.detail.request as Record<string, unknown> });
    });
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

  it("fills freeze time with a gliding shot of each team, is on a player from the start of the live round, and keeps CS2's spec_mode numbers", async () => {
    await waitFor(() => cs2.now() > LIVE_END, 70000);
    const freezeRound = samples.find((s) => s.at > 20000 && s.phase === "freezetime")!.round;
    const liveAt = samples.find((s) => s.round === freezeRound && s.phase === "live")!.at;
    const why = JSON.stringify(cs2.lines.filter((l) => l.at > 12000 && !/spec_goto/.test(l.line) || /^spec_mode/.test(l.line)).map((l) => `${(l.at / 1000).toFixed(1)} ${l.line}`));
    // Freeze time: a shot of each team, framed where they stand, one after the other (no player view
    // between), each gliding (Matchframe sends the poses; CS2's +left/+right would strafe it).
    const inFreeze = commands.filter((c) => c.at > 13000 && c.at < LIVE_START);
    const cams = inFreeze.filter((c) => c.request.kind === "activate_static_camera");
    expect(cams.length, why).toBeGreaterThanOrEqual(2);
    expect(inFreeze.filter((c) => c.at > cams[0]!.at && c.request.kind !== "activate_static_camera"), why).toEqual([]);
    expect(new Set(cams.slice(0, 2).map((c) => c.request.cameraId)), why).toEqual(new Set(["team-T", "team-CT"]));
    expect(cams.slice(0, 2).every((c) => Number(c.request.movingMs) > 4000), why).toBe(true);
    expect(cs2.lines.filter((l) => /[+-](left|right)|cl_yawspeed/.test(l.line)), why).toEqual([]);
    expect(cs2.lines.filter((l) => l.at > cams[0]!.at && l.at < LIVE_START && /^spec_goto /.test(l.line)).length, why).toBeGreaterThan(100);
    expect(samples.filter((s) => s.at > cams[0]!.at + 500 && s.at < liveAt - 300).every((s) => s.free), why).toBe(true);
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

  it("in a CT tactical timeout, holds a still shot of the CTs until the round goes live, then first person", async () => {
    await waitFor(() => cs2.now() > LIVE2_END, 60000);
    // When the engine saw the round go live (its game data is a moment behind the stand-in's clock).
    const liveAt = samples.find((s) => s.at > LIVE2_START - 1000 && s.phase === "live")!.at;
    const why = JSON.stringify(commands.filter((c) => c.at > FREEZE2).map((c) => [Math.round(c.at), c.request]));
    // Within a second of the timeout, a still shot of the CTs.
    const hold = commands.find((c) => c.at > TIMEOUT[0] && c.request.kind === "activate_static_camera");
    expect(hold, why).toBeTruthy();
    expect(hold!.at - TIMEOUT[0], why).toBeLessThan(1000);
    expect(hold!.request.cameraId, why).toBe("team-CT-still");
    expect(hold!.request.movingMs ?? 0, why).toBe(0);
    // Nothing else until the round goes live (the timeout ends at 69 s, the round goes live at 75 s); still.
    expect(commands.filter((c) => c.at > hold!.at && c.at < LIVE2_START), why).toEqual([]);
    expect(cs2.lines.filter((l) => l.at > hold!.at + 300 && l.at < LIVE2_START && /spec_goto|\+(left|right)/.test(l.line)), why).toEqual([]);
    // Then first person.
    const next = commands.find((c) => c.at > hold!.at);
    expect(next?.request.kind, why).toBe("select_player");
    expect(next!.at - LIVE2_START, why).toBeGreaterThanOrEqual(0);
    expect(next!.at - liveAt, why).toBeLessThan(1000);
    expect(samples.filter((s) => s.at > liveAt + 1000 && s.at < LIVE2_END - 500 && s.free).map((s) => s.at), why).toEqual([]);
  }, 90000);
});
