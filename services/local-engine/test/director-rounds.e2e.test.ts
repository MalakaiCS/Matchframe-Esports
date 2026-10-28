import { mkdirSync, mkdtempSync } from "node:fs";
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
 * Mirage, two rounds after a warm-up: Ts in T spawn and CTs in CT spawn in freeze time, out towards
 * mid once live. The second freeze time has only the spawn cameras (no paths): cameras the console's
 * getpos confirms at once.
 */
const WINDOWS = [
  { freeze: [8000, 24000], live: [24000, 36000], round: 4 },
  { freeze: [40000, 56000], live: [56000, 68000], round: 5 },
] as const;
const T_SPAWN = { x: 1230, y: -300, z: -167 };
const CT_SPAWN = { x: -1650, y: -1950, z: -295 };
const MID = { x: -500, y: -700, z: -160 };

describe("Director over a round: freeze time cinematics, then first person once live", () => {
  const work = mkdtempSync(join(tmpdir(), "mf-rounds-"));
  const cs2Dir = join(work, "Counter-Strike Global Offensive");
  mkdirSync(join(cs2Dir, "game", "csgo", "cfg"), { recursive: true });
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let cs2: TimedCs2;
  let api: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> }>;
  const commands: { at: number; request: Record<string, unknown> }[] = [];

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
      map: "de_mirage",
      // A warm-up live stretch first (the Auto Director starts, proves the camera), then round 5: freeze time, then live.
      phase: (t) => {
        if (t < 8000) return { phase: "live", endsInSec: 60, round: 3 };
        for (const w of WINDOWS) {
          if (t < w.freeze[1] && t >= w.freeze[0]) return { phase: "freezetime", endsInSec: (w.freeze[1] - t) / 1000, round: w.round };
          if (t < w.live[1] && t >= w.live[0]) return { phase: "live", endsInSec: 115 - (t - w.live[0]) / 1000, round: w.round };
        }
        return { phase: "over", endsInSec: 3, round: 4 };
      },
      positions: (t, p) => {
        const w = WINDOWS.find((x) => t >= x.freeze[0] && t < x.live[1]) ?? WINDOWS[0];
        const live = Math.max(0, t - w.live[0]) / 1000;
        const base = p.side === "T" ? T_SPAWN : CT_SPAWN;
        const k = Math.min(1, live / 25);
        const i = p.slot % 5;
        return { x: base.x + (MID.x - base.x) * k + i * 40, y: base.y + (MID.y - base.y) * k + i * 30, z: base.z + (MID.z - base.z) * k };
      },
    });
    await cs2.listen(consolePort);
    const token = engine.secrets.operatorToken;
    api = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    engine.session.on("arbiter", (e: { kind: string; detail: Record<string, unknown> }) => {
      if (e.kind === "command") commands.push({ at: cs2.now(), request: e.detail.request as Record<string, unknown> });
    });
    await api("/api/v1/setup/detect-cs2", { method: "POST", body: { manualInstallDir: cs2Dir } });
    await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "tools", netconPort: consolePort } });
    await api("/api/v1/director/auto/start", { method: "POST", body: { cinematic: true, returnAfterSec: 1 } });
    cs2.start();
  });

  afterAll(async () => {
    await cs2?.stop();
    await servers?.close();
    await engine?.shutdown();
  });

  const cinematic = (c: { request: Record<string, unknown> }) => c.request.kind === "activate_static_camera" || c.request.kind === "play_camera_path";
  const idOf = (c: { request: Record<string, unknown> }) => String(c.request.cameraId ?? c.request.pathId);

  /** Each freeze time: the two spawns, each shot once and held in full, then first person from the start of the live round. */
  function checkRound(w: (typeof WINDOWS)[number], kind: "play_camera_path" | "activate_static_camera") {
    const inFreeze = commands.filter((c) => c.at >= w.freeze[0] && c.at < w.freeze[1]);
    const cine = inFreeze.filter(cinematic);
    expect(cine.length, JSON.stringify(inFreeze)).toBeGreaterThanOrEqual(1);
    expect(cine.length).toBeLessThanOrEqual(2);
    expect(cine.every((c) => c.request.kind === kind)).toBe(true);
    expect(new Set(cine.map(idOf)).size).toBe(cine.length);
    expect(cine.every((c) => /(^|-)(t|ct)_spawn-/.test(idOf(c)))).toBe(true);
    if (cine.length === 2) expect(new Set(cine.map((c) => idOf(c).includes("ct_spawn")))).toEqual(new Set([true, false]));
    // Held: nothing else is sent for at least 4 s after each (no 1 s repeats of the same shot).
    for (const c of cine) {
      const next = commands.find((x) => x.at > c.at);
      if (next && next.at < w.freeze[1]) expect(next.at - c.at, `${idOf(c)} then ${JSON.stringify(next.request)}`).toBeGreaterThanOrEqual(4000);
    }
    // Live: no camera in the round's first 10 s, and on a player.
    expect(commands.filter((c) => c.at >= w.live[0] && c.at < w.live[0] + 10000).filter(cinematic)).toHaveLength(0);
  }

  it("round 1: the spawn paths in freeze time, then first person", async () => {
    await waitFor(async () => ((await api("/api/v1/director/auto")).json as { phase: string }).phase === "running", 8000);
    await waitFor(() => cs2.now() > WINDOWS[0].live[0] + 1500, 60000);
    expect(cs2.free).toBe(false);
    expect(cs2.observed).not.toBeNull();
    await waitFor(() => cs2.now() > WINDOWS[0].live[1] - 1000, 30000);
    checkRound(WINDOWS[0], "play_camera_path");
    // The next freeze time has only the spawn cameras.
    const rt = engine.maps.get("de_mirage")!;
    rt.pack.paths.length = 0;
  }, 90000);

  it("round 2: spawn cameras the console confirms at once are held, not sent again and again", async () => {
    await waitFor(() => cs2.now() > WINDOWS[1].live[0] + 1500, 60000);
    expect(cs2.free).toBe(false);
    await waitFor(() => cs2.now() > WINDOWS[1].live[1] - 1000, 30000);
    checkRound(WINDOWS[1], "activate_static_camera");
  }, 90000);
});
