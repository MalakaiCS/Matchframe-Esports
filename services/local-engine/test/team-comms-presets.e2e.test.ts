import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";
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

interface PresetsView {
  currentEventId: string | null;
  currentEventName: string | null;
  active: { id: string; name: string; changed: boolean; differs: string[] } | null;
  presets: { id: string; name: string; eventId: string | null; eventName: string | null; people: number; included: { broadcast: number; recording: number }; delayMs: number; active: boolean; teams: { id: string; name: string | null }[] }[];
  loaded?: { name: string; skipped: string[] };
}

/**
 * Team Comms event presets through the engine (ADR-069): save as, load, rename, delete and the
 * active one (changed or not), with people (mappings, both inclusions, levels), the TeamSpeak slots,
 * the delay, the recording team and levels, the strip and the on-air settings. Never a password, a
 * token or the public listen-in. The engine's own clock, a stand-in TeamSpeak plugin and NDI process.
 */
describe("Team Comms event presets through the engine", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let api: string;
  let auth: Record<string, string>;
  let plugin: FakeTs3Plugin;
  let teamA: string;
  let teamB: string;
  let eventId: string;
  let playerId: string;
  let dataDir: string;
  const get = async (path: string) => fetch(`${api}${path}`, { headers: auth });
  const post = async (path: string, body: unknown = {}) => fetch(`${api}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const put = async (path: string, body: unknown) => fetch(`${api}${path}`, { method: "PUT", headers: auth, body: JSON.stringify(body) });
  const del = async (path: string) => fetch(`${api}${path}`, { method: "DELETE", headers: auth });
  const presets = async () => (await (await get("/api/v1/comms/presets")).json()) as PresetsView;
  const person = (uid: string) => e.teamComms.status().participants.find((p) => p.uid === uid)!;
  const setPerson = async (uid: string, body: unknown) => expect((await put(`/api/v1/comms/participants/${encodeURIComponent(person(uid).key)}`, body)).status).toBe(200);

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    api = `http://127.0.0.1:${ports.api}`;
    dataDir = mkdtempSync(join(tmpdir(), "mf-comms-presets-"));
    e = new Engine(loadConfig({ dataDir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, cloudEnforcement: "off" }));
    (e.commsPublic.outputs as unknown as { d: { spawnWorker?: () => FakeNdiWorker } }).d.spawnWorker = () => new FakeNdiWorker();
    await e.init();
    servers = await startServers(e);
    auth = { authorization: `Bearer ${e.secrets.operatorToken}`, "content-type": "application/json" };
    eventId = e.events.create({ name: "Spring Cup" }, "event").id;
    teamA = e.teams.create({ name: "Northern Lights", shortName: "NL" }, "team").id;
    teamB = e.teams.create({ name: "Red Harbour", shortName: "RH" }, "team").id;
    playerId = e.players.create({ displayName: "Kestrel" }, "player").id;
    e.roster.join(teamA, playerId, "player");
    const m = e.matches.create({ eventId, teamAId: teamA, teamBId: teamB, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, status: "live" }, "match");
    e.setActiveMatch(m.id);
    expect((await put("/api/v1/comms/slots/A", { channel: "Team NL", serverHost: "ts.example.org", serverPassword: "pw-never-in-a-preset" })).status).toBe(200);
    expect((await put("/api/v1/comms/slots/B", { channel: "Team RH", serverHost: "ts.example.org", channelPassword: "chan-pw-never-either" })).status).toBe(200);
    expect((await put("/api/v1/comms/settings", { enabled: true, bridgePort: 0, delaySec: 0, fineMs: 0 })).status).toBe(200);
    const st = (await (await get("/api/v1/comms")).json()) as { bridge: { port: number } };
    plugin = new FakeTs3Plugin(st.bridge.port, e.secrets.getSecret("comms.bridgeToken")!, () => performance.now());
    await plugin.connect();
    await until(() => plugin.welcomed, 3000, "welcome");
    const server = { uid: "srv=", name: "Scrims", host: "ts.example.org", port: 9987 };
    plugin.openTab({ schid: 1, server, channel: { id: 1, name: "Team NL" }, self: { clientId: 2, uid: "listenerA=", nickname: "MF A" }, clients: [{ clientId: 10, uid: "nlOne=", nickname: "nl_one" }, { clientId: 11, uid: "nlTwo=", nickname: "nl_two" }, { clientId: 12, uid: "nlCoach=", nickname: "nl_coach" }] });
    plugin.openTab({ schid: 2, server, channel: { id: 2, name: "Team RH" }, self: { clientId: 3, uid: "listenerB=", nickname: "MF B" }, clients: [{ clientId: 20, uid: "rhOne=", nickname: "rh_one" }] });
    await until(() => e.teamComms.status().participants.length === 4, 3000, "four people");
  });

  afterAll(async () => {
    plugin?.kill();
    await servers?.close();
    await e?.shutdown();
  });

  it("save as, load, rename, delete; the active preset and what differs from it; never a password, a token, the Solo or the listen-in", async () => {
    // The event's setup.
    await setPerson("nlOne=", { includeBroadcast: true, includeRecording: true, playerId, levelDb: -4 });
    await setPerson("nlTwo=", { includeRecording: true, displayName: "Two" });
    await setPerson("rhOne=", { includeBroadcast: true, preview: true });
    expect((await put("/api/v1/comms/settings", { delaySec: 2, fineMs: 150 })).status).toBe(200);
    expect((await post("/api/v1/comms/recording/team", { teamId: teamA })).status).toBe(200);
    expect((await put("/api/v1/comms/recording", { commsLevelDb: -3, gameLevelDb: -2 })).status).toBe(200);
    expect((await put("/api/v1/comms/strip", { anchor: "top-center", timingOffsetMs: 120 })).status).toBe(200);
    expect((await put("/api/v1/comms/public", { duck: { enabled: true, inputs: ["Casters"], amountDb: -12 }, overlay: { anchor: "bottom" } })).status).toBe(200);
    let v = await presets();
    expect(v).toMatchObject({ currentEventId: eventId, currentEventName: "Spring Cup", active: null, presets: [] });
    // Save as.
    let r = await post("/api/v1/comms/presets", { name: "Group stage" });
    expect(r.status).toBe(200);
    v = (await r.json()) as PresetsView;
    const group = v.presets[0]!;
    expect(group).toMatchObject({ name: "Group stage", eventId, eventName: "Spring Cup", people: 4, included: { broadcast: 2, recording: 2 }, delayMs: 2150, active: true });
    expect(group.teams.map((t) => t.name)).toEqual(["Northern Lights", "Red Harbour"]);
    expect(v.active).toMatchObject({ name: "Group stage", changed: false, differs: [] });
    expect((await post("/api/v1/comms/presets", { name: "group STAGE" })).status).toBe(409);
    // Nothing secret or transient is in it.
    const stored = JSON.stringify(e.settings.get("comms.presets", {}));
    for (const secret of ["pw-never-in-a-preset", "chan-pw-never-either", e.secrets.getSecret("comms.bridgeToken")!, e.secrets.operatorToken]) expect(stored).not.toContain(secret);
    expect(stored).not.toMatch(/"preview"|listen|publicTeam/i);
    // On air now, then the setup changes: the active preset says what differs.
    await until(() => e.teamComms.status().slots.every((s) => s.ready), 5000, "ready");
    expect((await post("/api/v1/comms/listen-in", { teamId: teamA })).status).toBe(200);
    await setPerson("nlOne=", { includeBroadcast: false });
    expect((await put("/api/v1/comms/settings", { delaySec: 5 })).status).toBe(200);
    expect((await put("/api/v1/comms/strip", { anchor: "bottom-left" })).status).toBe(200);
    v = await presets();
    expect(v.active).toMatchObject({ name: "Group stage", changed: true });
    expect(v.active!.differs).toEqual(["people and choices", "delay", "speaker strip"]);
    // A newcomer after the save.
    plugin.join(1, { clientId: 13, uid: "nlSub=", nickname: "nl_sub" });
    await until(() => e.teamComms.status().participants.length === 5, 3000, "newcomer");
    // Load: everything back as saved; the listen-in as the operator left it (load never opens or closes it); the newcomer excluded; the Solo kept.
    r = await post(`/api/v1/comms/presets/${group.id}/load`);
    expect(r.status).toBe(200);
    v = (await r.json()) as PresetsView;
    expect(v.loaded).toMatchObject({ name: "Group stage", skipped: [] });
    expect(v.active).toMatchObject({ changed: false, differs: [] });
    expect(person("nlOne=")).toMatchObject({ includeBroadcast: true, includeRecording: true, playerId, levelDb: -4 });
    expect(person("nlTwo=")).toMatchObject({ includeRecording: true, includeBroadcast: false, displayName: "Two" });
    expect(person("rhOne=")).toMatchObject({ includeBroadcast: true, preview: true });
    expect(person("nlSub=")).toMatchObject({ includeBroadcast: false, includeRecording: false });
    expect(e.teamComms.settings()).toMatchObject({ delaySec: 2, fineMs: 150 });
    expect(e.commsRecording.settings()).toMatchObject({ teamId: teamA, commsLevelDb: -3, gameLevelDb: -2 });
    expect(e.stripSettings()).toMatchObject({ anchor: "top-center", timingOffsetMs: 120 });
    expect(e.commsPublic.settings()).toMatchObject({ duck: { enabled: true, inputs: ["Casters"], amountDb: -12 }, overlay: { anchor: "bottom" } });
    expect(e.commsPublic.controller.view().team?.id).toBe(teamA);
    expect((await post("/api/v1/comms/listen-in/end")).status).toBe(200);
    // Loading while closed leaves it closed.
    r = await post(`/api/v1/comms/presets/${group.id}/load`);
    expect(r.status).toBe(200);
    expect(e.commsPublic.controller.view().state).toBe("off");
    // The passwords stayed in the secure settings, per slot.
    const slots = (await (await get("/api/v1/comms")).json()) as { slots: { serverPasswordSaved: boolean; channelPasswordSaved: boolean }[] };
    expect(slots.slots.map((s) => [s.serverPasswordSaved, s.channelPasswordSaved])).toEqual([
      [true, false],
      [false, true],
    ]);
    // Another preset, rename, the list with this event's first, delete.
    expect((await post("/api/v1/comms/presets", { name: "Other cup", eventId: null })).status).toBe(200);
    r = await put(`/api/v1/comms/presets/${group.id}`, { name: "Group stage A" });
    expect(r.status).toBe(200);
    v = (await r.json()) as PresetsView;
    expect(v.presets.map((p) => [p.name, p.eventName, p.active])).toEqual([
      ["Group stage A", "Spring Cup", false],
      ["Other cup", null, true],
    ]);
    expect((await put(`/api/v1/comms/presets/${group.id}`, { name: "Other cup", eventId: null })).status).toBe(409);
    expect((await post(`/api/v1/comms/presets/${group.id}/save`)).status).toBe(200);
    expect((await presets()).active).toMatchObject({ name: "Group stage A" });
    r = await del(`/api/v1/comms/presets/${group.id}`);
    expect(r.status).toBe(200);
    v = (await r.json()) as PresetsView;
    expect(v.active).toBeNull();
    expect(v.presets.map((p) => p.name)).toEqual(["Other cup"]);
    expect((await post("/api/v1/comms/presets/nope/load")).status).toBe(404);
    // Audited; in the support file by name only.
    expect(e.audit.recent(100).map((a) => a.action)).toEqual(expect.arrayContaining(["comms.preset_save_as", "comms.preset_load", "comms.preset_rename", "comms.preset_save", "comms.preset_delete"]));
    const bundle = await (await get("/api/v1/diagnostics/bundle")).text();
    expect(bundle).not.toContain("pw-never-in-a-preset");
    const section = JSON.stringify((JSON.parse(bundle) as { teamCommsPresets: unknown }).teamCommsPresets);
    expect(section).toContain("Other cup");
    expect(section).not.toMatch(/nlOne=|rhOne=|nlTwo=/);
  });

  it("a preset of people MatchFrame hasn't met here yet: their choices are waiting for them; a roster player that is gone is left unmapped", async () => {
    // The preset carries an identity this engine never saw, mapped to a player that no longer exists.
    const store = e.settings.get<{ presets: { id: string; content: { people: Record<string, unknown>[] } }[]; activeId: string | null }>("comms.presets", { presets: [], activeId: null });
    const p = store.presets[0]!;
    p.content.people.push({ teamId: teamA, serverUid: "srv=", uid: "nlLater=", nickname: "nl_later", playerId: "gone-player", displayName: null, includeBroadcast: true, includeRecording: true, levelDb: 0 });
    e.settings.set("comms.presets", store);
    const r = await post(`/api/v1/comms/presets/${p.id}/load`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as PresetsView).loaded!.skipped.join(" ")).toMatch(/1 roster mapping to players MatchFrame doesn't have any more/);
    plugin.join(1, { clientId: 14, uid: "nlLater=", nickname: "nl_later" });
    await until(() => e.teamComms.status().participants.some((x) => x.uid === "nlLater="), 3000, "nl_later arrives");
    expect(person("nlLater=")).toMatchObject({ includeBroadcast: true, includeRecording: true, playerId: null });
  });
});
