import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { startServers } from "../src/servers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

/**
 * A stand-in for CS2 observing a match: its console takes spec_player / spec_mode / spec_goto and
 * answers getpos like the game (`setpos x y z;setang pitch yaw roll`), and its game data follows the
 * camera. `freeMode` is the spec_mode number of the free camera on this "build". +left and +right
 * (CS2's strafe keys) slide the free camera sideways while held.
 */
class FakeCs2 {
  readonly roster = syntheticRoster();
  readonly lines: string[] = [];
  observed: string | null = this.roster[0]!.steamId;
  free = false;
  /** Third-person chase view (spec_mode 3 on a build whose free camera is 4, else 5). */
  chase = false;
  roundPhase: "freezetime" | "live" = "freezetime";
  /** The spectated T player is planting the bomb, then it is planted where they stand. */
  bomb: "planting" | "planted" | null = null;
  private bombAt: { x: number; y: number; z: number } | null = null;
  pose = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
  /** Strafing the free camera: -1/0/1 at 400 units a second, since when. */
  strafe = { dir: 0, since: 0 };
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gsiUrl: string,
    private readonly token: string,
    readonly freeMode = "spec_mode 6",
  ) {}

  onLine(line: string, sock: Socket): void {
    this.lines.push(line);
    for (const cmd of line.split(";").map((c) => c.trim())) {
      if (/^spec_mode \d$/.test(cmd)) {
        this.free = cmd === this.freeMode;
        this.chase = cmd === (this.freeMode === "spec_mode 4" ? "spec_mode 3" : "spec_mode 5");
      }
      const goto = /^spec_goto (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(cmd);
      if (goto && this.free) {
        const [x, y, z, pitch, yaw] = goto.slice(1).map(Number) as [number, number, number, number, number];
        this.pose = { x, y, z, pitch, yaw };
        this.strafe.since = Date.now();
        this.observed = null;
      }
      if (/^[+-](left|right)$/.test(cmd)) {
        this.pose = this.poseNow();
        this.strafe = { dir: cmd === "+left" ? -1 : cmd === "+right" ? 1 : 0, since: Date.now() };
      }
      const player = /^spec_player "(.+)"$/.exec(cmd);
      if (player) {
        const p = this.roster.find((r) => r.name === player[1]);
        if (p) {
          this.free = false;
          this.observed = p.steamId;
        }
      }
      if (cmd === "getpos") {
        const f = (n: number) => n.toFixed(6);
        // On a player: their eyes, or 100 units behind them in the chase view.
        const at = !this.free ? this.roster.find((r) => r.steamId === this.observed)?.position : undefined;
        const pose = at ? { x: at.x - (this.chase ? 100 : 0), y: at.y, z: at.z + 64, pitch: 10, yaw: 0 } : this.poseNow();
        sock.write(`setpos ${f(pose.x)} ${f(pose.y)} ${f(pose.z)};setang ${f(pose.pitch)} ${f(pose.yaw)} 0.000000\n`);
      }
    }
    void this.post();
  }

  poseNow(): { x: number; y: number; z: number; pitch: number; yaw: number } {
    return { ...this.pose, x: this.pose.x + (this.free ? this.strafe.dir * 400 * ((Date.now() - this.strafe.since) / 1000) : 0) };
  }

  async post(): Promise<void> {
    const planter = this.bomb === "planting" ? this.roster.find((r) => r.steamId === this.observed && r.side === "T") : undefined;
    if (planter?.position) this.bombAt = planter.position;
    const payload = buildSyntheticGsiPayload({
      mapName: "de_dust2",
      players: this.roster,
      observed: this.observed,
      roundPhase: this.roundPhase,
      phase: this.roundPhase,
      phaseEndsIn: this.roundPhase === "freezetime" ? 15 : 60,
      ...(planter?.position ? { bomb: { state: "planting", player: planter.steamId, position: planter.position } } : {}),
      ...(this.bomb === "planted" && this.bombAt ? { bomb: { state: "planted", position: this.bombAt, countdown: 40 } } : {}),
      token: this.token,
      timestamp: 1_700_001_000 + this.seq++,
    });
    await fetch(this.gsiUrl, { method: "POST", body: JSON.stringify(payload) }).catch(() => undefined);
  }

  start(): void {
    this.timer = setInterval(() => void this.post(), 200);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

describe("Auto Director: one button, checks and fixes by itself", () => {
  const work = mkdtempSync(join(tmpdir(), "mf-auto-director-"));
  const cs2Dir = join(work, "Counter-Strike Global Offensive");
  mkdirSync(join(cs2Dir, "game", "csgo", "cfg"), { recursive: true });
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> }>;
  let fake: Server;
  let cs2: FakeCs2;
  let consolePort: number;
  const sockets = new Set<Socket>();

  const auto = async () => (await api("/api/v1/director/auto")).json as { on: boolean; phase: string; headline: string; observerMode: string; checks: { id: string; status: string; detail: string }[] };
  const caps = async () => (await api("/api/v1/capabilities")).json.capabilities as Record<string, { support: string }>;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    consolePort = await freePort();
    const cfg = loadConfig({
      dataDir: join(work, "data"),
      gsiPort: ports.gsi,
      apiPort: ports.api,
      overlayPort: ports.overlay,
      host: "127.0.0.1",
      captainUiDir: null,
      hudRendererDir: null,
      mapPackDir: resolve(__dirname, "../../../assets/map-packs"),
      workersDir: null,
      pythonPath: null,
      sampleHudsDirs: [],
      cloudEnforcement: "off",
    });
    engine = new Engine(cfg);
    await engine.init();
    // Both teams every freeze time (round-to-round variety and big moments have their own tests).
    engine.autoDirector.setSettings({ variety: false, bigMoments: false });
    servers = await startServers(engine);
    cs2 = new FakeCs2(`http://127.0.0.1:${ports.gsi}/gsi`, engine.secrets.gsiToken, "spec_mode 4");
    fake = createServer((sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const l of parts.filter(Boolean)) cs2.onLine(l, sock);
      });
    });
    await new Promise<void>((r) => fake.listen(consolePort, "127.0.0.1", () => r()));
    const token = engine.secrets.operatorToken;
    api = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
  });

  afterAll(async () => {
    cs2?.stop();
    await servers?.close();
    await engine?.shutdown();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => fake.close(() => r()));
  });

  it("waits for the console first, and switches the launch to Tools mode", async () => {
    const r = await api("/api/v1/director/auto/start", { method: "POST", body: { cinematic: true, returnAfterSec: 1 } });
    expect(r.status).toBe(200);
    const st = await auto();
    expect(st.on).toBe(true);
    expect(st.phase).toBe("waiting");
    expect(st.checks.find((c) => c.id === "console")?.status).toBe("wait");
    expect(((await api("/api/v1/game/console")).json.profile as { mode: string }).mode).toBe("tools");
  });

  it("connects, proves player switching and the camera, learns the spec_mode numbering, and directs", async () => {
    await api("/api/v1/setup/detect-cs2", { method: "POST", body: { manualInstallDir: cs2Dir } });
    expect((await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "tools", netconPort: consolePort } })).status).toBe(200);
    cs2.start();
    await waitFor(async () => (await auto()).phase === "running", 15000);
    const st = await auto();
    const check = (id: string) => st.checks.find((c) => c.id === id)?.status;
    expect([check("console"), check("data"), check("account"), check("pov"), check("cameras"), check("director")], JSON.stringify(st.checks)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    // Nade cams are on by default: the Full Action Observer.
    expect(st.observerMode).toBe("full_action");
    // No setup tests needed: the game showed the player, and getpos showed the camera.
    const c = await caps();
    expect(c.playerSelectionControl!.support).toBe("supported");
    expect(c.staticCameraControl!.support).toBe("supported");
    expect(c.cameraReadback!.support).toBe("supported");
    expect(c.cameraPathControl!.support).toBe("partial");
    // This "build" numbers the free camera 4 (the CS2 enum); the engine kept that.
    const adapter = (await api("/api/v1/observer/adapter")).json.settings as { kind: string; templates: Record<string, string> };
    expect(adapter.kind).toBe("netcon");
    expect(adapter.templates.modeRoaming).toBe("spec_mode 4");
    // The map's free-space grid is loaded with its pack (sightlines for the director, room for the follow camera).
    expect(engine.maps.get("de_dust2")?.grid?.header).toMatchObject({ map: "de_dust2", cell: 12 });
    expect(cs2.lines).toContain("spec_autodirector 0");
    expect(cs2.lines.some((l) => l.startsWith("spec_player "))).toBe(true);
    const ownership = (await api("/api/v1/director/status")).json.ownership as { owner: string; manualSticky: boolean };
    expect(ownership).toMatchObject({ owner: "director", manualSticky: false });
  });

  it("frames a team in freeze time from where they stand, and glides the camera slowly round them", async () => {
    // Freeze time: Ts in T spawn and CTs in CT spawn.
    cs2.roster.forEach((r, i) => (r.position = r.side === "T" ? { x: -800 + (i % 5) * 40, y: -736, z: 40 } : { x: 224 + (i % 5) * 40, y: 2272, z: -64 }));
    const before = cs2.lines.length;
    // Freeze time on Dust II with 15 s left: a team shot (this build's free camera is spec_mode 4).
    await waitFor(() => cs2.lines.slice(before).some((l) => /^spec_mode 4; spec_goto /.test(l)), 12000);
    const shown = cs2.lines.slice(before).find((l) => /^spec_mode 4; spec_goto /.test(l))!;
    const [x, y, z] = shown.split(" ").slice(3).map(Number) as [number, number, number];
    const team = cs2.roster.filter((r) => (Math.hypot(r.position!.x - x, r.position!.y - y) < 1000));
    // A few hundred units from the team it shows, a little above their heads.
    expect(team.length, shown).toBeGreaterThanOrEqual(3);
    const floor = team[0]!.position!.z;
    expect(z - floor).toBeGreaterThan(60);
    expect(z - floor).toBeLessThan(240);
    await new Promise((r) => setTimeout(r, 1200));
    // Matchframe moves it (spec_goto poses), slowly; CS2's +left/+right (strafing) never.
    const frames = cs2.lines.slice(before).filter((l) => /^spec_goto /.test(l)).map((l) => l.split(" ").slice(1).map(Number) as [number, number, number, number, number]);
    expect(frames.length).toBeGreaterThan(30);
    const moved = Math.hypot(frames.at(-1)![0] - frames[0]![0], frames.at(-1)![1] - frames[0]![1]);
    expect(moved).toBeGreaterThan(2);
    expect(moved).toBeLessThan(60);
    expect(cs2.lines.slice(before).filter((l) => /[+-](left|right)|cl_yawspeed/.test(l))).toEqual([]);
  });

  it("gives the camera back to automation shortly after you pick a player yourself", async () => {
    const r = await api("/api/v1/observer/commands", { method: "POST", body: { kind: "select_player", steamId: cs2.roster[7]!.steamId } });
    expect(r.status).toBe(200);
    await waitFor(async () => (await auto()).phase === "paused", 3000);
    await waitFor(async () => (await auto()).phase === "running", 5000);
  });

  it("holds after Take over until the camera is handed back", async () => {
    expect((await api("/api/v1/observer/takeover", { method: "POST" })).status).toBe(200);
    await waitFor(async () => (await auto()).phase === "paused", 3000);
    // Longer than the 1 s return delay: still yours.
    await new Promise((r) => setTimeout(r, 1800));
    const st = await auto();
    expect(st.phase).toBe("paused");
    expect(st.headline).toMatch(/You took over/);
    expect((await api("/api/v1/observer/resume", { method: "POST", body: { countdownMs: 0 } })).status).toBe(200);
    await waitFor(async () => (await auto()).phase === "running", 3000);
  });

  it("shows the planter in the chase view, confirms it with getpos, and goes back to first person", async () => {
    // Players only, so no bomb camera takes the shot.
    expect((await api("/api/v1/director/auto/settings", { method: "PUT", body: { cinematic: false } })).json).toMatchObject({ settings: { cinematic: false, chase: true } });
    cs2.roster.forEach((r, i) => (r.position = { x: -400 + i * 40, y: 1200, z: 0 }));
    cs2.roundPhase = "live";
    // On a T (the last pick was a CT), and automation back in charge.
    await api("/api/v1/observer/commands", { method: "POST", body: { kind: "select_player", steamId: cs2.roster[1]!.steamId } });
    await waitFor(async () => (await auto()).phase === "paused", 3000);
    await waitFor(async () => (await auto()).phase === "running", 5000);
    const before = cs2.lines.length;
    cs2.bomb = "planting";
    await waitFor(() => cs2.lines.slice(before).some((l) => /^spec_player ".+"; spec_mode 3$/.test(l)), 10000);
    await waitFor(async () => (await caps()).observerModeControl!.support === "supported", 5000);
    const back = cs2.lines.length;
    cs2.bomb = "planted";
    await waitFor(() => cs2.lines.slice(back).some((l) => /^spec_mode 2; spec_player ".+"$/.test(l)), 5000);
    expect(cs2.chase).toBe(false);
    // By hand, from Live Control or the API.
    const pick = cs2.lines.length;
    expect((await api("/api/v1/observer/commands", { method: "POST", body: { kind: "select_player", steamId: cs2.roster[2]!.steamId, view: "chase" } })).status).toBe(200);
    await waitFor(() => cs2.lines.slice(pick).includes(`spec_player "${cs2.roster[2]!.name}"; spec_mode 3`), 3000);
  });

  it("flies camera paths in freeze time and the breaks only while the HLAE camera is connected", async () => {
    const cfg = () => engine.session.director.config.cinematic.freezeTimePaths;
    expect(cfg()).toBe(false); // console commands only: too jerky for paths
    const spy = vi.spyOn(engine.hlaeCamera, "connected").mockReturnValue(true);
    try {
      await waitFor(async () => cfg(), 3000);
      spy.mockReturnValue(false);
      await waitFor(async () => !cfg(), 3000);
    } finally {
      spy.mockRestore();
    }
  });

  it("stops with the button, and the Observer switches off", async () => {
    const st = (await api("/api/v1/director/auto/stop", { method: "POST" })).json as { on: boolean; phase: string };
    expect(st).toMatchObject({ on: false, phase: "off" });
    expect((await api("/api/v1/director/status")).json.mode).toBe("advisory");
    expect((await auto()).observerMode).toBe("off");
  });
});
