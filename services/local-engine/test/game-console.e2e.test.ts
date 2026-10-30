import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { consoleCommands, ConsoleOptions, killfeedColourCommands, launchPlan, parseExtraArgs, GameLaunchProfile, retakeUnderway } from "../src/game/console.ts";
import { buildSyntheticGsiPayload, syntheticRoster, type SyntheticPayloadSpec } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { MatchStateStore, normalizeGsi, parseGsiPayload, stripAuth } from "../../../packages/cs2-state/src/index.ts";
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

/** The match state for one game-data packet. */
function stateOf(spec: SyntheticPayloadSpec) {
  const parsed = parseGsiPayload(buildSyntheticGsiPayload(spec));
  if (!parsed.ok) throw new Error(parsed.error);
  const store = new MatchStateStore({ sessionId: "s" });
  store.ingest(normalizeGsi(stripAuth(parsed.payload), { sourceId: "gsi:test", receivedAtMonotonicMs: 1000, payloadHash: "x" }));
  return store.snapshot();
}

/** Two Ts and two CTs alive, the bomb planted at the origin, the CTs `ctDistance` units from it. */
const postPlant = (ctDistance: number, kit = false) =>
  syntheticRoster().map((p, i) => ({
    ...p,
    health: [0, 1, 5, 6].includes(i) ? 100 : 0,
    position: p.side === "CT" ? { x: ctDistance, y: i * 10, z: 0 } : { x: -300, y: i * 10, z: 0 },
    ...(p.side === "CT" && kit ? { defuseKit: true } : {}),
  }));

describe("retakes", () => {
  const bomb = (countdown: number, state = "planted") => ({ state, position: { x: 0, y: 0, z: 0 }, countdown });
  it("is a retake once a CT is close to the planted bomb with time to defuse", () => {
    expect(retakeUnderway(stateOf({ players: postPlant(900), bomb: bomb(30), roundBomb: "planted" }))).toBe(true);
    // Defusing: always.
    expect(retakeUnderway(stateOf({ players: postPlant(3000), bomb: bomb(30, "defusing"), roundBomb: "planted" }))).toBe(true);
  });

  it("is no retake while the CTs are far off (saving), out of time, or before the plant", () => {
    expect(retakeUnderway(stateOf({ players: postPlant(3000), bomb: bomb(30), roundBomb: "planted" }))).toBe(false);
    expect(retakeUnderway(stateOf({ players: postPlant(900), bomb: bomb(8), roundBomb: "planted" }))).toBe(false);
    // With a kit, 8 s is enough.
    expect(retakeUnderway(stateOf({ players: postPlant(900, true), bomb: bomb(8), roundBomb: "planted" }))).toBe(true);
    expect(retakeUnderway(stateOf({ players: postPlant(900), bomb: { state: "carried", position: { x: 0, y: 0, z: 0 } } }))).toBe(false);
  });

  it("is no retake with nobody left to hide (no T alive)", () => {
    const players = postPlant(900).map((p) => (p.side === "T" ? { ...p, health: 0 } : p));
    expect(retakeUnderway(stateOf({ players, bomb: bomb(30), roundBomb: "planted" }))).toBe(false);
  });
});

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
    expect(consoleCommands(o, "tools", { ct: null, t: null })).toEqual(["cl_drawhud 1", "cl_draw_only_deathnotices 1", "spec_show_xray 1", "hud_showtargetid 1", "cl_drawhud_force_teamid_overhead 1", "engine_no_focus_sleep 0", "snd_mute_losefocus 0"]);
    expect(consoleCommands(ConsoleOptions.parse({ xray: false }), "tools", { ct: null, t: null }).slice(0, 5)).toEqual(["cl_drawhud 1", "cl_draw_only_deathnotices 1", "spec_show_xray 0", "hud_showtargetid 0", "cl_drawhud_force_teamid_overhead 0"]);
    expect(consoleCommands(o, "hlae", { ct: "#1e90ff", t: "#ff8800" })).toEqual([
      "cl_drawhud 1",
      "cl_draw_only_deathnotices 1",
      "spec_show_xray 1",
      "hud_showtargetid 1",
      "cl_drawhud_force_teamid_overhead 1",
      "engine_no_focus_sleep 0",
      "snd_mute_losefocus 0",
      "mirv_noflash 1",
      "mirv_endofmatch 0",
      "mirv_deathmsg colors ct 30 144 255 255",
      "mirv_deathmsg colors t 255 136 0 255",
      "mirv_deathmsg filter clear",
    ]);
    // Off: back to the game's own behaviour behind other windows.
    expect(consoleCommands(ConsoleOptions.parse({ runInBackground: false }), "tools", { ct: null, t: null }).slice(5)).toEqual(["engine_no_focus_sleep 20", "snd_mute_losefocus 1"]);
    // Frame cap: fps_max only when one is chosen (none by default: CS2's own setting stays).
    expect(consoleCommands(ConsoleOptions.parse({ frameCap: 120 }), "tools", { ct: null, t: null }).at(-1)).toBe("fps_max 120");
    expect(consoleCommands(ConsoleOptions.parse({}), "hlae", { ct: null, t: null }).some((l) => l.startsWith("fps_max"))).toBe(false);
    expect(ConsoleOptions.safeParse({ frameCap: 5 }).success).toBe(false);
    // Hide CS2's kill feed: one rule with no player match blocks every notice (cleared first, so it never stacks).
    expect(consoleCommands(ConsoleOptions.parse({ hideGameKillfeed: true }), "hlae", { ct: null, t: null }).slice(-3)).toEqual(["mirv_deathmsg filter clear", "mirv_deathmsg filter add block=1", "mirv_deathmsg clear"]);
    expect(consoleCommands(ConsoleOptions.parse({ hideGameKillfeed: true }), "tools", { ct: null, t: null }).some((l) => l.startsWith("mirv_"))).toBe(false);
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
    await waitFor(() => received.includes("cl_drawhud 1") && received.includes("cl_draw_only_deathnotices 1") && received.includes("spec_show_xray 1"));
    // Camera control and the console options share one connection to the game.
    expect(connections).toBe(1);
    expect(received.some((l) => l.startsWith("mirv_"))).toBe(false);

    received.length = 0;
    const opt = await api("/api/v1/game/console-options", { method: "PUT", body: { xray: false } });
    expect(opt.status).toBe(200);
    await waitFor(() => received.includes("spec_show_xray 0") && received.includes("hud_showtargetid 0") && received.includes("cl_drawhud_force_teamid_overhead 0"));
  });

  it("turns X-ray (and the names) off when one player is left against two or more, and back on when the round ends", async () => {
    expect((await api("/api/v1/game/console-options", { method: "PUT", body: { xray: true } })).status).toBe(200);
    const roster = syntheticRoster();
    const post = async (spec: Parameters<typeof buildSyntheticGsiPayload>[0]) => {
      const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", token: engine.secrets.gsiToken, ...spec });
      expect((await fetch(`http://127.0.0.1:${engine.cfg.gsiPort}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    };
    await post({ players: roster, timestamp: 1_700_000_010 });
    received.length = 0;
    // 1 T against 2 CTs: a clutch.
    const clutch = roster.map((p, i) => ({ ...p, health: i === 0 || i === 5 || i === 6 ? 100 : 0 }));
    await post({ players: clutch, timestamp: 1_700_000_011 });
    await waitFor(() => received.includes("spec_show_xray 0") && received.includes("hud_showtargetid 0") && received.includes("cl_drawhud_force_teamid_overhead 0"));
    expect(received.includes("spec_show_xray 1")).toBe(false);
    received.length = 0;
    await post({ players: clutch, timestamp: 1_700_000_012, roundPhase: "over", winTeam: "T" });
    await waitFor(() => received.includes("spec_show_xray 1") && received.includes("hud_showtargetid 1") && received.includes("cl_drawhud_force_teamid_overhead 1"));

    // Off when the option is off: no change in a clutch.
    expect((await api("/api/v1/game/console-options", { method: "PUT", body: { clutchXrayOff: false } })).status).toBe(200);
    await post({ players: roster, timestamp: 1_700_000_013 });
    received.length = 0;
    await post({ players: clutch, timestamp: 1_700_000_014 });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.includes("spec_show_xray 0")).toBe(false);
    expect((await api("/api/v1/game/console-options", { method: "PUT", body: { clutchXrayOff: true } })).status).toBe(200);
    await post({ players: roster, timestamp: 1_700_000_015, roundPhase: "over", winTeam: "T" });

    // A 2v2 retake: off once a CT is close to the bomb, back on when the round is over.
    await post({ players: postPlant(3000), timestamp: 1_700_000_016, bomb: { state: "planted", position: { x: 0, y: 0, z: 0 }, countdown: 30 }, roundBomb: "planted" });
    await new Promise((r) => setTimeout(r, 200));
    received.length = 0;
    await post({ players: postPlant(3000), timestamp: 1_700_000_017, bomb: { state: "planted", position: { x: 0, y: 0, z: 0 }, countdown: 29 }, roundBomb: "planted" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.includes("spec_show_xray 0")).toBe(false);
    await post({ players: postPlant(900), timestamp: 1_700_000_018, bomb: { state: "planted", position: { x: 0, y: 0, z: 0 }, countdown: 25 }, roundBomb: "planted" });
    await waitFor(() => received.includes("spec_show_xray 0") && received.includes("hud_showtargetid 0") && received.includes("cl_drawhud_force_teamid_overhead 0"));
    received.length = 0;
    await post({ players: postPlant(900), timestamp: 1_700_000_019, roundPhase: "over", winTeam: "CT", roundBomb: "defused" });
    await waitFor(() => received.includes("spec_show_xray 1"));
    expect((await api("/api/v1/game/console-options", { method: "PUT", body: { xray: false } })).status).toBe(200);
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

  it("confirms player selection by itself once the game data shows the requested player", async () => {
    const roster = syntheticRoster();
    const post = (observed: string) =>
      fetch(`http://127.0.0.1:${engine.cfg.gsiPort}/gsi`, { method: "POST", body: JSON.stringify(buildSyntheticGsiPayload({ mapName: "de_dust2", players: roster, observed, token: engine.secrets.gsiToken, timestamp: 1_700_000_200 })) });
    const support = async () => ((await api("/api/v1/capabilities")).json.capabilities as { playerSelectionControl: { support: string } }).playerSelectionControl.support;
    expect((await post(roster[0]!.steamId)).status).toBe(200);
    expect(await support()).not.toBe("supported");

    received.length = 0;
    const cmd = await api("/api/v1/observer/commands", { method: "POST", body: { kind: "select_player", steamId: roster[5]!.steamId } });
    expect(cmd.status).toBe(200);
    await waitFor(() => received.includes(`spec_player "${roster[5]!.name}"`));
    // The game moved to the player: no setup test needed.
    expect((await post(roster[5]!.steamId)).status).toBe(200);
    await waitFor(async () => (await support()) === "supported");
    const verified = (await api("/api/v1/setup/status")).json.verifiedControl as Record<string, { support: string }>;
    expect(verified.playerSelectionControl?.support).toBe("supported");
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
    // One option at a time (as the switches send them) keeps the others as they were.
    received.length = 0;
    const one = await api("/api/v1/game/console-options", { method: "PUT", body: { killfeedTeamColours: true } });
    expect(one.json.options).toMatchObject({ noFlash: true, hideEndOfMatch: true, killfeedTeamColours: true, xray: false });
    const two = await api("/api/v1/game/console-options", { method: "PUT", body: { hideGameKillfeed: true } });
    expect(two.json.options).toMatchObject({ noFlash: true, hideEndOfMatch: true, killfeedTeamColours: true, hideGameKillfeed: true });
    await waitFor(() => received.includes("mirv_deathmsg filter add block=1") && received.includes("mirv_endofmatch 0"));
    // Back to standard: the console connection is closed.
    await api("/api/v1/game/launch-profile", { method: "PUT", body: { mode: "standard" } });
    expect((await api("/api/v1/game/console")).json.console).toBe("off");
  });
});
