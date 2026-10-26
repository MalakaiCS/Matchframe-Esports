import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildSyntheticGsiPayload, syntheticRoster } from "@matchframe/cs2-state";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
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

async function boot(dataDir: string, ports?: { gsi: number; api: number; overlay: number }) {
  const p = ports ?? { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
  process.env.MATCHFRAME_LOG_STDOUT = "0";
  const cfg = loadConfig({ dataDir, gsiPort: p.gsi, apiPort: p.api, overlayPort: p.overlay, host: "127.0.0.1", operatorUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null });
  const engine = new Engine(cfg);
  await engine.init();
  const servers = await startServers(engine);
  return { engine, servers, ports: p };
}

const roster = syntheticRoster().map((pl, i) => ({ ...pl, position: { x: i * 120, y: 40, z: 0 }, forward: { x: 1, y: 0, z: 0 } }));

describe("engine end-to-end (real HTTP/WS servers)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-engine-"));
  let ctx: Awaited<ReturnType<typeof boot>>;
  let token: string;
  let api: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(async () => {
    ctx = await boot(dataDir);
    token = ctx.engine.secrets.operatorToken;
    api = (path, init = {}) =>
      fetch(`http://127.0.0.1:${ctx.ports.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  });

  afterAll(async () => {
    await ctx?.servers.close();
    await ctx?.engine.shutdown();
  });

  it("A02: authenticates GSI, rejects bad tokens, and never leaks the token", async () => {
    const gsiToken = ctx.engine.secrets.gsiToken;
    const post = (body: unknown) => fetch(`http://127.0.0.1:${ctx.ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await post(buildSyntheticGsiPayload({ players: roster, token: "deadbeefdeadbeef" }))).status).toBe(401);
    expect((await post(buildSyntheticGsiPayload({ players: roster }))).status).toBe(401);
    expect((await post(buildSyntheticGsiPayload({ players: roster, token: gsiToken, timestamp: 1_700_000_001 }))).status).toBe(200);
    expect((await post(buildSyntheticGsiPayload({ players: roster, token: gsiToken, timestamp: 1_700_000_002, round: 1 }))).status).toBe(200);
    const st = (await (await api("/api/v1/matches/current/state")).json()) as { state: { players: unknown[] } };
    expect(st.state.players).toHaveLength(10);
    const caps = await (await api("/api/v1/capabilities")).text();
    const hud = await (await api("/api/v1/hud/outputs/main/state")).text();
    const audit = await (await api("/api/v1/audit")).text();
    const bundle = await (await api("/api/v1/diagnostics/bundle")).text();
    for (const text of [JSON.stringify(st), caps, hud, audit, bundle]) expect(text).not.toContain(gsiToken);
    const logs = readdirSync(join(dataDir, "logs")).map((f) => readFileSync(join(dataDir, "logs", f), "utf8")).join("\n");
    expect(logs).not.toContain(gsiToken);
    expect(logs).not.toContain(token);
  });

  it("requires authentication and permissions for every mutation; rejects foreign origins", async () => {
    expect((await fetch(`http://127.0.0.1:${ctx.ports.api}/api/v1/director/mode`, { method: "POST", body: "{}" })).status).toBe(401);
    const viewer = ctx.engine.secrets.issue("viewer", "viewer test");
    const r = await fetch(`http://127.0.0.1:${ctx.ports.api}/api/v1/director/mode`, { method: "POST", headers: { authorization: `Bearer ${viewer.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "automatic" }) });
    expect(r.status).toBe(403);
    const evil = await api("/api/v1/director/mode", { method: "POST", body: JSON.stringify({ mode: "advisory" }), headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
  });

  it("A49: an overlay client is read-only and receives only the public projection", async () => {
    const outToken = ctx.engine.outputs.token("main");
    // Bad token → rejected upgrade.
    await new Promise<void>((resolve) => {
      const bad = new WebSocket(`ws://127.0.0.1:${ctx.ports.overlay}/overlay-ws?output=main&t=nope`);
      bad.on("error", () => resolve());
      bad.on("unexpected-response", () => resolve());
    });
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.ports.overlay}/overlay-ws?output=main&t=${outToken}`);
    const first = await new Promise<Record<string, unknown>>((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
    expect(first.topic).toBe("hud.snapshot");
    const payload = first.payload as Record<string, unknown>;
    expect(payload.left).toBeDefined();
    const text = JSON.stringify(first);
    for (const forbidden of ["candidates", "reasonCodes", "contactProbability", "opportunities", "ownership", "supportingFeatures"]) expect(text).not.toContain(forbidden);
    const modeBefore = ctx.engine.session.director.currentMode;
    ws.send(JSON.stringify({ type: "command", kind: "select_player", steamId: roster[0]!.steamId }));
    ws.send(JSON.stringify({ topic: "director.mode", mode: "automatic" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.engine.session.director.currentMode).toBe(modeBefore);
    expect(ctx.engine.session.arbiter.pending()).toBeNull();
    ws.close();
    // The overlay server refuses non-GET requests and the overlay token grants no API access.
    expect((await fetch(`http://127.0.0.1:${ctx.ports.overlay}/overlay/main/live?t=${outToken}`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`http://127.0.0.1:${ctx.ports.api}/api/v1/status`, { headers: { authorization: `Bearer ${outToken}` } })).status).toBe(401);
  });

  it("A37: rejects unsafe HUD archives; installs, publishes and rolls back a valid package (A38)", async () => {
    const manifest = (version: string) => JSON.stringify({ manifestVersion: 1, id: "test-hud", name: "Test HUD", version, author: "tests", licence: "MIT", game: "cs2", schemaVersions: [1], entryPoints: { live: "index.html" }, permissions: ["match.public"] });
    const evil = zipSync({ "manifest.json": strToU8(manifest("1.0.0")), "index.html": strToU8("<html></html>"), "../../escape.js": strToU8("x") });
    const r1 = await api("/api/v1/hud/packages/import", { method: "POST", body: evil, headers: { "content-type": "application/zip" } });
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { message: string }).message).toMatch(/traversal|absolute/);
    const exe = zipSync({ "manifest.json": strToU8(manifest("1.0.0")), "index.html": strToU8("<html></html>"), "payload.exe": new Uint8Array([1, 2]) });
    expect((await api("/api/v1/hud/packages/import", { method: "POST", body: exe, headers: { "content-type": "application/zip" } })).status).toBe(400);
    const ok1 = zipSync({ "manifest.json": strToU8(manifest("1.0.0")), "index.html": strToU8("<html>v1</html>") });
    expect((await api("/api/v1/hud/packages/import", { method: "POST", body: ok1, headers: { "content-type": "application/zip" } })).status).toBe(200);
    const ok2 = zipSync({ "manifest.json": strToU8(manifest("1.1.0")), "index.html": strToU8("<html>v2</html>") });
    expect((await api("/api/v1/hud/packages/import", { method: "POST", body: ok2, headers: { "content-type": "application/zip" } })).status).toBe(200);
    const rb = (await (await api("/api/v1/hud/packages/test-hud/rollback", { method: "POST" })).json()) as { manifest: { version: string } };
    expect(rb.manifest.version).toBe("1.0.0");

    // Draft vs program: editing the draft does not change the published revision until publish.
    const before = ctx.engine.outputs.published("preview")!;
    await api("/api/v1/hud/outputs/preview", { method: "PATCH", body: JSON.stringify({ presetId: "arena" }) });
    expect(ctx.engine.outputs.published("preview")!.data.presetId).toBe(before.data.presetId);
    const pub = (await (await api("/api/v1/hud/outputs/preview/publish", { method: "POST" })).json()) as { revision: number; data: { presetId: string } };
    expect(pub.data.presetId).toBe("arena");
    const back = (await (await api("/api/v1/hud/outputs/preview/rollback", { method: "POST", body: JSON.stringify({ revision: before.revision }) })).json()) as { data: { presetId: string } };
    expect(back.data.presetId).toBe(before.data.presetId);
  });

  it("program cues fail clearly when no mixer scene is mapped or the mixer is not connected", async () => {
    const r = await api("/api/v1/program/cues", { method: "POST", body: JSON.stringify({ mode: "STUDIO" }) });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { message: string }).message).toMatch(/no mixer scene is mapped/);
    await api("/api/v1/settings/program.scenes", { method: "PUT", body: JSON.stringify({ value: { LIVE: "Live", REPLAY: "Replay", STUDIO: "Studio", BREAK: "Break" } }) });
    const r2 = await api("/api/v1/program/cues", { method: "POST", body: JSON.stringify({ mode: "STUDIO" }) });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { message: string }).message).toMatch(/not connected/);
    expect(ctx.engine.program.mode).toBe("LIVE");
  });

  it("device actions use per-action permissions, the shared arbiter, and report tally", async () => {
    const deviceApi = (role: "viewer" | "observer", path: string, body?: unknown) => {
      const t = ctx.engine.secrets.issue(role, `deck ${role}`).token;
      return fetch(`http://127.0.0.1:${ctx.ports.api}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    };
    const catalogue = (await (await deviceApi("viewer", "/api/v1/devices/actions")).json()) as { id: string; allowed: boolean }[];
    expect(catalogue.find((a) => a.id === "takeover")?.allowed).toBe(false);
    expect((await deviceApi("viewer", "/api/v1/devices/actions/takeover", {})).status).toBe(403);
    expect((await deviceApi("observer", "/api/v1/devices/actions/no_such_action", {})).status).toBe(404);
    expect((await deviceApi("observer", "/api/v1/devices/actions/select_slot", { slot: 99 })).status).toBe(400);
    expect((await deviceApi("observer", "/api/v1/devices/actions/return_live", {})).status).toBe(403);

    const take = (await (await deviceApi("observer", "/api/v1/devices/actions/takeover", {})).json()) as { tally: { control: { owner: string; manualSticky: boolean } } };
    expect(take.tally.control).toMatchObject({ owner: "operator", manualSticky: true });
    const slotted = ctx.engine.session.state()!.players.find((p) => p.observerSlot !== null)!;
    const sel = await deviceApi("observer", "/api/v1/devices/actions/select_slot", { slot: slotted.observerSlot });
    expect(sel.status).toBe(200);
    expect(((await sel.json()) as { action: string }).action).toBe("select_slot");

    const stop = (await (await deviceApi("observer", "/api/v1/devices/actions/emergency_stop", {})).json()) as { tally: { control: { emergencyStopped: boolean; automationActive: boolean } } };
    expect(stop.tally.control).toMatchObject({ emergencyStopped: true, automationActive: false });
    const tally = (await (await deviceApi("viewer", "/api/v1/devices/tally")).json()) as { slots: { slot: number }[]; program: { mode: string } };
    expect(tally.slots.length).toBe(10);
    expect(tally.program.mode).toBe("LIVE");
    expect(((await (await api("/api/v1/audit")).json()) as { action: string }[]).some((a) => a.action === "device.emergency_stop")).toBe(true);
    await api("/api/v1/observer/clear-emergency-stop", { method: "POST" });
  });

  it("exports and restores an event package with checksum and collision checks", async () => {
    const team = (await (await api("/api/v1/teams", { method: "POST", body: JSON.stringify({ name: "Alpha", shortName: "ALP" }) })).json()) as { id: string };
    await api("/api/v1/players", { method: "POST", body: JSON.stringify({ displayName: "Player One", steamId: "76561198000000999" }) });
    const pkg = (await (await api("/api/v1/export/event-package")).json()) as Record<string, unknown>;
    expect(JSON.stringify(pkg)).not.toContain(ctx.engine.secrets.operatorToken);
    const preview = (await (await api("/api/v1/import/event-package", { method: "POST", body: JSON.stringify({ package: pkg, mode: "preview" }) })).json()) as { collisions: { id: string }[] };
    expect(preview.collisions.map((c) => c.id)).toContain(team.id);
    const tampered = { ...pkg, exportedAt: "2000-01-01T00:00:00Z" };
    expect((await api("/api/v1/import/event-package", { method: "POST", body: JSON.stringify({ package: tampered, mode: "preview" }) })).status).toBe(400);
  });

  it("runs the labelled simulation: decisions, confirmed automatic cuts, SIMULATION flag on air", async () => {
    // Start mid-round (after freeze time) so action happens within the test window.
    await api("/api/v1/simulation/start", { method: "POST", body: JSON.stringify({ startOffsetSec: 30 }) });
    await new Promise((r) => setTimeout(r, 400));
    // Operator parks the camera on a CT far from the action (manual), then resumes automation.
    const far = "76561198000000209";
    const manual = (await (await api("/api/v1/observer/commands", { method: "POST", body: JSON.stringify({ kind: "select_player", steamId: far }) })).json()) as { status: string };
    expect(manual.status).toBe("transport_acknowledged");
    await new Promise((r) => setTimeout(r, 600));
    expect(ctx.engine.session.state()?.observer.observedSteamId).toBe(far);
    expect(ctx.engine.session.arbiter.state().manualSticky).toBe(true);
    await api("/api/v1/director/mode", { method: "POST", body: JSON.stringify({ mode: "automatic" }) });
    await api("/api/v1/observer/resume", { method: "POST", body: JSON.stringify({ countdownMs: 0 }) });
    await new Promise((r) => setTimeout(r, 4500));
    const hud = (await (await api("/api/v1/hud/outputs/main/state")).json()) as { simulated: boolean; left: { players: unknown[] } };
    expect(hud.simulated).toBe(true);
    expect(hud.left.players.length).toBe(5);
    const decisions = (await (await api("/api/v1/director/decisions")).json()) as { action: string }[];
    expect(decisions.length).toBeGreaterThan(5);
    const log = ctx.engine.session.arbiter.log;
    const directorCommands = new Set(log.filter((x) => x.kind === "command" && x.detail.owner === "director").map((x) => x.detail.commandId));
    const confirmed = log.filter((x) => x.kind === "result" && x.detail.status === "confirmed" && directorCommands.has(x.detail.commandId));
    expect(directorCommands.size).toBeGreaterThan(0);
    expect(confirmed.length).toBeGreaterThan(0);
    expect(ctx.engine.session.state()?.observer.observedSteamId).not.toBe(far);
    await api("/api/v1/simulation/stop", { method: "POST" });
  }, 20000);

  it("A48: after a restart the engine resumes in manual/disarmed mode with data intact", async () => {
    const teamsBefore = ((await (await api("/api/v1/teams")).json()) as unknown[]).length;
    await ctx.servers.close();
    await ctx.engine.shutdown();
    ctx = await boot(dataDir);
    token = ctx.engine.secrets.operatorToken;
    expect(ctx.engine.session.director.currentMode).toBe("advisory");
    expect(ctx.engine.session.arbiter.state().manualSticky).toBe(true);
    expect(ctx.engine.session.arbiter.automationAllowed).toBe(false);
    expect(((await (await api("/api/v1/teams")).json()) as unknown[]).length).toBe(teamsBefore);
  });
});
