import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { consoleCommands, ConsoleOptions, killfeedColourCommands, launchPlan, parseExtraArgs, GameLaunchProfile } from "../src/game/console.ts";
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

const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("console commands and launch plan", () => {
  it("allows plain extra launch options and refuses the ones the launch mode manages", () => {
    expect(parseExtraArgs(" -novid  -fullscreen +exec observer.cfg ")).toEqual({ args: ["-novid", "-fullscreen", "+exec", "observer.cfg"], error: null });
    expect(parseExtraArgs("-novid -insecure").error).toMatch(/set by the launch mode/);
    expect(parseExtraArgs("-netconport 1").error).toMatch(/set by the launch mode/);
    expect(parseExtraArgs("+echo a;quit").error).toMatch(/not allowed/);
    expect(parseExtraArgs('"-x"').error).toMatch(/not allowed/);
  });

  it("maps the options to console lines per launch mode", () => {
    const o = ConsoleOptions.parse({ noFlash: true, killfeedTeamColours: true, hideEndOfMatch: true });
    expect(consoleCommands(o, "standard", { ct: null, t: null })).toEqual([]);
    expect(consoleCommands(o, "tools", { ct: null, t: null })).toEqual(["cl_draw_only_deathnotices 1", "spec_show_xray 1"]);
    expect(consoleCommands(o, "hlae", { ct: "#1e90ff", t: "#ff8800" })).toEqual([
      "cl_draw_only_deathnotices 1",
      "spec_show_xray 1",
      "mirv_noflash 1",
      "mirv_endofmatch 0",
      "mirv_deathmsg colors ct 30 144 255 255",
      "mirv_deathmsg colors t 255 136 0 255",
    ]);
    // A team without a colour (or the option off) keeps the game's colours.
    expect(killfeedColourCommands(true, { ct: "#ffffff", t: null })).toEqual(["mirv_deathmsg colors ct 255 255 255 255", "mirv_deathmsg colors t default"]);
    expect(killfeedColourCommands(false, { ct: "#ffffff", t: "#000000" })).toEqual(["mirv_deathmsg colors ct default", "mirv_deathmsg colors t default"]);
  });

  it("builds the launch for each mode", () => {
    const install = { installDir: "C:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive", steamRoot: "C:\\Steam" };
    const exists = () => true;
    const std = launchPlan(GameLaunchProfile.parse({ extraArgs: "-novid" }), install, "win32", exists);
    expect(std.args).toEqual(["-novid"]);
    expect(std.netconPort).toBe(null);
    expect(std.steamExe).toMatch(/steam\.exe$/);
    expect(launchPlan(GameLaunchProfile.parse({ mode: "tools", netconPort: 2121 }), install, "win32", exists).args).toEqual(["-tools", "-netconport", "2121"]);
    const hlae = launchPlan(GameLaunchProfile.parse({ mode: "hlae", netconPort: 2122, extraArgs: "-novid" }), install, "win32", exists);
    expect(hlae.args).toEqual(["-steam", "-insecure", "-tools", "-netconport", "2122", "-novid"]);
    expect(hlae.cs2Exe).toMatch(/game[\\/]bin[\\/]win64[\\/]cs2\.exe$/);
    expect(launchPlan(GameLaunchProfile.parse({}), install, "win32", () => false).steamExe).toBe(null);
  });
});

describe("Start CS2 and the game console (engine)", () => {
  const work = mkdtempSync(join(tmpdir(), "mf-game-console-"));
  const cs2Dir = join(work, "Counter-Strike Global Offensive");
  const cfgDir = join(cs2Dir, "game", "csgo", "cfg");
  mkdirSync(cfgDir, { recursive: true });
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: (path: string, init?: { method?: string; body?: unknown }) => Promise<{ status: number; json: Record<string, unknown> }>;
  let consolePort: number;
  let fake: Server;
  const received: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    consolePort = await freePort();
    // The game's console, listening before Start CS2 so the engine connects straight away.
    fake = createServer((sock) => {
      connections++;
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
      sock.on("data", (d) => received.push(...d.toString().split("\n").filter(Boolean)));
    });
    await new Promise<void>((r) => fake.listen(consolePort, "127.0.0.1", () => r()));
    const cfg = loadConfig({ dataDir: join(work, "data"), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [] });
    engine = new Engine(cfg);
    await engine.init();
    servers = await startServers(engine);
    const token = engine.secrets.operatorToken;
    api = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, { method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
  });

  afterAll(async () => {
    await servers?.close();
    await engine?.shutdown();
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => fake.close(() => r()));
  });

  it("starts in the standard mode without a console", async () => {
    const st = await api("/api/v1/game/console");
    expect(st.status).toBe(200);
    expect(st.json.console).toBe("off");
    expect((st.json.profile as { mode: string }).mode).toBe("standard");
  });

  it("refuses the HLAE mode until its warning is accepted, and managed launch options", async () => {
    expect((await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "hlae" } })).status).toBe(409);
    expect((await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "tools", extraArgs: "-novid -insecure" } })).status).toBe(400);
  });

  it("prepares a tools launch: GSI config, console camera control and the console options on connect", async () => {
    expect((await api("/api/v1/setup/detect-cs2", { method: "POST", body: { manualInstallDir: cs2Dir } })).status).toBe(200);
    const set = await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "tools", netconPort: consolePort, extraArgs: "-novid" } });
    expect(set.status).toBe(200);
    const prep = await api("/api/v1/game/prepare-launch", { method: "POST" });
    expect(prep.status).toBe(200);
    const plan = prep.json.plan as { args: string[]; cs2Exe: string; steamExe: string | null };
    expect(plan.args).toEqual(["-tools", "-netconport", String(consolePort), "-novid"]);
    expect(plan.steamExe).toBe(null);
    const gsi = prep.json.gsi as { path: string; error: string | null };
    expect(gsi.error).toBe(null);
    expect(existsSync(gsi.path) && readFileSync(gsi.path, "utf8")).toContain(`127.0.0.1:${engine.cfg.gsiPort}/gsi`);
    expect(prep.json.observerAdapterChanged).toBe(true);
    const adapter = await api("/api/v1/observer/adapter");
    expect(adapter.json.settings).toMatchObject({ kind: "netcon", host: "127.0.0.1", port: consolePort });

    await waitFor(async () => (await api("/api/v1/game/console")).json.console === "connected");
    await waitFor(() => received.includes("cl_draw_only_deathnotices 1") && received.includes("spec_show_xray 1"));
    // Camera control and the console options share one connection to the game.
    expect(connections).toBe(1);
    expect(received.some((l) => l.startsWith("mirv_"))).toBe(false);

    received.length = 0;
    const opt = await api("/api/v1/game/console-options", { method: "PUT", body: { xray: false } });
    expect(opt.status).toBe(200);
    await waitFor(() => received.includes("spec_show_xray 0"));
  });

  it("selects players with spec_player and the player's in-game name (CS2 has no spec_player_by_accountid)", async () => {
    const roster = syntheticRoster();
    roster[2]!.name = 'bad"name; quit';
    roster[3]!.name = "Twin";
    roster[4]!.name = "twin";
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", players: roster, token: engine.secrets.gsiToken, timestamp: 1_700_000_100 });
    expect((await fetch(`http://127.0.0.1:${engine.cfg.gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    const select = (steamId: string) => api("/api/v1/setup/test-player-selection", { method: "POST", body: { steamId } });

    received.length = 0;
    const ok = await select(roster[1]!.steamId);
    expect(ok.json.transport).toBe("transport_acknowledged");
    await waitFor(() => received.includes('spec_player "T-Player-2"'));
    // The fake console doesn't move the camera, so nothing is recorded.
    expect(ok.json.recorded).toBe(false);

    // Names that could break out of the quotes, and names two players share, are never sent.
    for (const p of [roster[2]!, roster[3]!]) {
      received.length = 0;
      expect((await select(p.steamId)).json.transport).toBe("failed");
      expect(received.filter((l) => l.startsWith("spec_player"))).toEqual([]);
    }
  });

  it("adds -insecure and HLAE's commands in the HLAE mode once the warning is accepted", async () => {
    const set = await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "hlae", netconPort: consolePort, acknowledgeInsecure: true } });
    expect(set.status).toBe(200);
    expect((set.json.profile as { insecureAcknowledgedAt: string | null }).insecureAcknowledgedAt).not.toBe(null);
    const prep = await api("/api/v1/game/prepare-launch", { method: "POST" });
    expect((prep.json.plan as { args: string[] }).args.slice(0, 2)).toEqual(["-steam", "-insecure"]);
    received.length = 0;
    await api("/api/v1/game/console-options", { method: "PUT", body: { noFlash: true, hideEndOfMatch: true } });
    await waitFor(() => received.includes("mirv_noflash 1") && received.includes("mirv_endofmatch 0"));
    // Back to standard: the console connection is closed.
    await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "standard" } });
    expect((await api("/api/v1/game/console")).json.console).toBe("off");
  });
});
