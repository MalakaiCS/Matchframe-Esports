import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import type { CommsSetupDeps, SetupStep } from "../src/comms/setup.ts";
import { startServers } from "../src/servers.ts";
import { StandInObs } from "./stand-in-obs.ts";
import { FakeNdiWorker } from "./helpers/fake-ndi-worker.ts";
import { FakeTs3Plugin, until } from "./helpers/fake-ts3-plugin.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Checklist {
  steps: SetupStep[];
  obsConnected: boolean;
  plugin: { bundled: { built: boolean; binary: string | null; version: string | null; note: string | null }; installed: { pluginsDir: string | null; path: string | null; same: boolean; teamspeakFound: boolean }; connected: { version: string | null }[] };
}

/**
 * Team Comms setup through the engine (ADR-069): Install TeamSpeak plugin (the program's build for
 * this computer copied into TeamSpeak 3's plugins folder) and the guided checklist (TeamSpeak plugin,
 * DistroAV, Source Record, OBS scenes, calibration), each step's state read live from MatchFrame's own
 * checks. A stand-in program folder, TeamSpeak folder, OBS, TeamSpeak plugin and NDI process.
 */
describe("Team Comms setup: the TeamSpeak plugin from the program, the checklist", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let auth: Record<string, string>;
  let plugin: FakeTs3Plugin;
  let obs: StandInObs;
  let programDir: string;
  let ts3Dir: string;
  let dll: Buffer;
  const get = async (path: string) => fetch(`${api}${path}`, { headers: auth });
  const post = async (path: string, body: unknown = {}) => fetch(`${api}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const put = async (path: string, body: unknown) => fetch(`${api}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
  const checklist = async () => (await (await get("/api/v1/comms/setup")).json()) as Checklist;
  const step = (c: Checklist, id: string) => c.steps.find((s) => s.id === id)!;

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    api = `http://127.0.0.1:${ports.api}`;
    const dir = mkdtempSync(join(tmpdir(), "mf-comms-setup-"));
    // The program's resources\\ts3-plugin as windows-program.yml packs it, and TeamSpeak 3's own folder.
    programDir = join(dir, "resources", "ts3-plugin");
    ts3Dir = join(dir, "AppData", "Roaming", "TS3Client");
    mkdirSync(programDir, { recursive: true });
    mkdirSync(ts3Dir, { recursive: true });
    dll = Buffer.from("MZ stand-in MatchFrame Team Comms plugin build");
    writeFileSync(join(programDir, "matchframe_comms_win64.dll"), dll);
    writeFileSync(join(programDir, "matchframe-team-comms.ts3_plugin"), "PK stand-in");
    writeFileSync(join(programDir, "plugin.json"), JSON.stringify({ built: true, version: "0.2.0", pluginApi: 26, files: [{ file: "matchframe-team-comms.ts3_plugin", sha256: "x" }, { file: "matchframe_comms_win64.dll", platform: "win64", sha256: createHash("sha256").update(dll).digest("hex") }] }));
    e = new Engine(loadConfig({ dataDir: join(dir, "data"), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudEnforcement: "off" }));
    (e.commsPublic.outputs as unknown as { d: { spawnWorker?: () => FakeNdiWorker } }).d.spawnWorker = () => new FakeNdiWorker();
    const sd = (e.commsSetup as unknown as { d: CommsSetupDeps }).d;
    sd.pluginDir = () => programDir;
    sd.ts3ConfigDir = () => ts3Dir;
    sd.platform = "win32";
    await e.init();
    servers = await startServers(e);
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    const teamA = e.teams.create({ name: "Northern Lights", shortName: "NL" }, "team").id;
    const teamB = e.teams.create({ name: "Red Harbour", shortName: "RH" }, "team").id;
    const m = e.matches.create({ eventId: null, teamAId: teamA, teamBId: teamB, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, status: "live" }, "match");
    e.setActiveMatch(m.id);
    expect((await put("/api/v1/comms/slots/A", { channel: "Team NL", serverHost: "ts.example.org" })).status).toBe(200);
    expect((await put("/api/v1/comms/slots/B", { channel: "Team RH", serverHost: "ts.example.org", nickname: "MF Listener RH" })).status).toBe(200);
    obs = await StandInObs.attach(e, (o) => {
      o.addScene("Game");
      o.addInput("Game", "Game Capture", "game_capture");
      o.program = "Game";
    });
    e.program.setScenes({ LIVE: "Game" });
  });

  afterAll(async () => {
    plugin?.kill();
    await servers?.close();
    await e?.shutdown();
  });

  it("with Team Comms off and nothing installed: each step says what to do, in words", async () => {
    const c = await checklist();
    expect(c.steps.map((s) => s.id)).toEqual(["teamspeak-plugin", "distroav", "source-record", "obs-scenes", "calibration"]);
    expect(c.steps.every((s) => ["Done", "To do", "Not checked"].includes(s.label))).toBe(true);
    const ts = step(c, "teamspeak-plugin");
    expect(ts.state).toBe("todo");
    expect(ts.items.map((i) => [i.label, i.ok])).toEqual([
      ["In this program", true],
      ["Installed in TeamSpeak 3", false],
      ["Connected to MatchFrame", null],
      ["Team tab: Northern Lights", null],
      ["Team tab: Red Harbour", null],
    ]);
    expect(ts.items[1]!.detail).toMatch(/Not in TeamSpeak's plugins folder yet: Install TeamSpeak plugin/);
    expect(step(c, "source-record")).toMatchObject({ state: "done", label: "Done" });
    expect(step(c, "calibration").items[0]).toMatchObject({ ok: false });
    // Each team's TeamSpeak link (no password in it).
    const v = (await (await get("/api/v1/comms")).json()) as { slots: { connectLink: string | null }[] };
    expect(v.slots.map((s) => s.connectLink)).toEqual(["ts3server://ts.example.org?port=9987&nickname=MF%20Listener%20A&channel=Team%20NL", "ts3server://ts.example.org?port=9987&nickname=MF%20Listener%20RH&channel=Team%20RH"]);
  });

  it("Install TeamSpeak plugin copies this computer's build into TeamSpeak 3's plugins folder; then connected and both team tabs", async () => {
    const r = await post("/api/v1/comms/teamspeak-plugin/install");
    expect(r.status).toBe(200);
    const target = join(ts3Dir, "plugins", "matchframe_comms_win64.dll");
    expect(readFileSync(target)).toEqual(dll);
    expect(existsSync(`${target}.mf-new`)).toBe(false);
    expect(await r.json()).toMatchObject({ installed: { path: target, same: true }, bundled: { version: "0.2.0" }, lastInstall: { ok: true } });
    // Another build in TeamSpeak's folder is named as such.
    writeFileSync(target, "older build");
    let c = await checklist();
    expect(step(c, "teamspeak-plugin").items[1]).toMatchObject({ ok: false, detail: expect.stringMatching(/is another build: Install TeamSpeak plugin replaces it/) });
    expect((await post("/api/v1/comms/teamspeak-plugin/install")).status).toBe(200);
    // Team Comms on, the plugin connects with both tabs.
    expect((await put("/api/v1/comms/settings", { enabled: true, bridgePort: 0, delaySec: 0, fineMs: 0 })).status).toBe(200);
    const st = (await (await get("/api/v1/comms")).json()) as { bridge: { port: number } };
    plugin = new FakeTs3Plugin(st.bridge.port, e.secrets.getSecret("comms.bridgeToken")!, () => performance.now());
    await plugin.connect();
    await until(() => plugin.welcomed, 3000, "welcome");
    const server = { uid: "srv=", name: "Scrims", host: "ts.example.org", port: 9987 };
    plugin.openTab({ schid: 1, server, channel: { id: 1, name: "Team NL" }, self: { clientId: 2, uid: "listenerA=", nickname: "MF A" }, clients: [{ clientId: 10, uid: "nlOne=", nickname: "nl_one" }] });
    plugin.openTab({ schid: 2, server, channel: { id: 2, name: "Team RH" }, self: { clientId: 3, uid: "listenerB=", nickname: "MF B" }, clients: [{ clientId: 20, uid: "rhOne=", nickname: "rh_one" }] });
    await until(() => e.teamComms.status().slots.every((s) => s.tab?.capturing), 3000, "both captured");
    c = await checklist();
    expect(step(c, "teamspeak-plugin")).toMatchObject({ state: "done", label: "Done" });
    expect(step(c, "teamspeak-plugin").items[3]!.detail).toMatch(/Team NL on Scrims as MF A/);
    // Which tab is which team, in the status itself.
    const tabs = ((await (await get("/api/v1/comms")).json()) as { tabs: { schid: number; team: { name: string } | null }[] }).tabs;
    expect(tabs.map((t) => [t.schid, t.team?.name])).toEqual([
      [1, "Northern Lights"],
      [2, "Red Harbour"],
    ]);
    expect(e.audit.recent(50).map((a) => a.action)).toContain("comms.teamspeak_plugin_install");
  });

  it("DistroAV and the OBS scenes read live from OBS; refusals say what to do", async () => {
    let c = await checklist();
    expect(step(c, "distroav").items[0]).toMatchObject({ label: "DistroAV in OBS", ok: true });
    expect(step(c, "distroav").items[1]).toMatchObject({ ok: true });
    expect(step(c, "obs-scenes").state).toBe("todo");
    expect(step(c, "obs-scenes").items.find((i) => i.label.includes("MatchFrame Comms"))).toMatchObject({ ok: false, detail: expect.stringMatching(/No DistroAV NDI source receives/) });
    // OBS without DistroAV.
    obs.inputKinds = obs.inputKinds.filter((k) => k !== "ndi_source");
    await e.obs.refresh();
    c = await checklist();
    expect(step(c, "distroav").items[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/install DistroAV/) });
    // A program without the plugin built: Install says so.
    writeFileSync(join(programDir, "plugin.json"), JSON.stringify({ built: false, note: "Build native/ts3-matchframe-plugin to include the TeamSpeak plugin." }));
    const r = await post("/api/v1/comms/teamspeak-plugin/install");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toMatch(/Build native\/ts3-matchframe-plugin/);
    // TeamSpeak's plugins folder can't be made: the reason, not a crash.
    writeFileSync(join(programDir, "plugin.json"), JSON.stringify({ built: true, version: "0.2.0", files: [{ file: "matchframe_comms_win64.dll", platform: "win64", sha256: "y" }] }));
    const blocked = join(ts3Dir, "..", "TS3Blocked");
    writeFileSync(blocked, "a file where the folder should be");
    (e.commsSetup as unknown as { d: CommsSetupDeps }).d.ts3ConfigDir = () => blocked;
    const r2 = await post("/api/v1/comms/teamspeak-plugin/install");
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { message: string }).message).toMatch(/Couldn't copy the plugin/);
  });
});
