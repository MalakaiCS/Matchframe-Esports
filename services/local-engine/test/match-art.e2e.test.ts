import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writePngMov } from "../../../apps/operator-web/src/lib/match-art/mov.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

/**
 * Match graphics on the engine: the program uploads the thumbnails and stingers it drew, the engine
 * keeps them per match, serves them, and points OBS's two Stinger transitions at the stingers (here a
 * stand-in OBS that records what it is told).
 */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("picture")]);
// A stinger as the program writes it: a QuickTime file of PNG frames (here three tiny "frames").
const frame = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([n, n, n])]);
const MOV = Buffer.from(writePngMov({ width: 1920, height: 1080, fps: 60, frames: [frame(1), frame(2), frame(3)] }));
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from("video")]);

describe("match graphics: storing, serving and OBS stingers", () => {
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let port: number;
  let matchId: string;
  // The stand-in OBS: its transitions, the current one, and every settings change.
  const obs = { current: "Fade", transitions: [{ name: "Fade", kind: "fade_transition" }, { name: "Matchframe Stinger", kind: "obs_stinger_transition" }], changes: [] as { name: string; settings: Record<string, unknown>; keepCurrent: boolean }[] };
  const api = async (path: string, init: { method?: string; body?: unknown; raw?: Buffer; auth?: boolean } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? (init.body !== undefined || init.raw ? "POST" : "GET"),
      headers: { ...(init.auth === false ? {} : { authorization: `Bearer ${e.secrets.operatorToken}` }), "content-type": init.raw ? "application/octet-stream" : "application/json" },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, type, json: type.includes("json") ? ((await res.json()) as Record<string, unknown>) : null, bytes: type.includes("json") ? null : Buffer.from(await res.arrayBuffer()) };
  };

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    port = await freePort();
    e = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-art-")), gsiPort: await freePort(), apiPort: port, overlayPort: await freePort(), host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
    const o = e.obs as unknown as Record<string, unknown>;
    o.transitionKinds = async () => ({ current: obs.current, transitions: obs.transitions.map((t) => ({ ...t })) });
    o.transitions = async () => ({ current: obs.current, names: obs.transitions.map((t) => t.name) });
    o.setTransitionSettings = async (name: string, settings: Record<string, unknown>, opts: { keepCurrent?: boolean } = {}) => {
      obs.changes.push({ name, settings, keepCurrent: opts.keepCurrent === true });
      if (opts.keepCurrent) obs.current = name;
      return { confirmed: true, settings };
    };
    const a = await api("/api/v1/teams", { body: { name: "Northern Lights", shortName: "NL" } });
    const b = await api("/api/v1/teams", { body: { name: "Redline", shortName: "RED" } });
    const m = await api("/api/v1/matches", { body: { teamAId: a.json!.id, teamBId: b.json!.id, format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, mapPool: ["de_mirage", "de_nuke", "de_inferno"] } });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    matchId = m.json!.id as string;
  });

  afterAll(async () => {
    await servers?.close();
    await e?.shutdown();
  });

  it("stores what the program made, checks it is what it says, and serves it", async () => {
    const empty = await api(`/api/v1/matches/${matchId}/art`);
    expect(empty.json).toMatchObject({ items: [], obs: { transitions: { stinger: "Matchframe Stinger", "stinger-replay": "Matchframe Replay Stinger" }, cutMs: 900 } });
    expect((await api(`/api/v1/matches/${matchId}/art/thumb-highlights`, { raw: PNG })).status).toBe(200);
    // A video where a picture belongs, or a picture where a stinger belongs, is refused.
    expect((await api(`/api/v1/matches/${matchId}/art/thumb-replay`, { raw: MOV })).status).toBe(400);
    expect((await api(`/api/v1/matches/${matchId}/art/stinger`, { raw: WEBM })).status).toBe(400);
    expect((await api(`/api/v1/matches/${matchId}/art/stinger`, { raw: PNG })).status).toBe(400);
    expect((await api(`/api/v1/matches/${matchId}/art/poster`, { raw: PNG })).status).toBe(400);
    expect((await api(`/api/v1/matches/${matchId}/art/stinger`, { raw: MOV })).status).toBe(200);
    expect((await api(`/api/v1/matches/nope/art/stinger`, { raw: MOV })).status).toBe(404);
    const list = await api(`/api/v1/matches/${matchId}/art`);
    const items = list.json!.items as { kind: string; url: string; bytes: number; file: string }[];
    expect(items.map((i) => i.kind)).toEqual(["thumb-highlights", "stinger"]);
    expect(String(list.json!.folder)).toContain(join("graphics", matchId));
    // Served without a token (like team logos), with the right type.
    const pic = await api(items[0]!.url, { auth: false });
    expect(pic.status).toBe(200);
    expect(pic.type).toBe("image/png");
    expect(pic.bytes!.equals(PNG)).toBe(true);
    const vid = await api(items[1]!.url, { auth: false });
    expect(vid.type).toBe("video/quicktime");
    expect(readFileSync(items[1]!.file).equals(MOV)).toBe(true);
    // A stinger's still: its frame at the cut (900 ms of 1600: the middle one of three).
    const still = await api((items[1] as unknown as { still: string }).still, { auth: false });
    expect(still.type).toBe("image/png");
    expect(still.bytes!.equals(frame(2))).toBe(true);
    expect((await api(`/api/v1/match-art/${matchId}/thumbnail-highlights.png.png`, { auth: false })).status).toBe(404);
    expect((await api(`/api/v1/match-art/${matchId}/settings.json`, { auth: false })).status).toBe(404);
    expect((await api(`/api/v1/match-art/${matchId}/..%2F..%2Fsecrets.json`, { auth: false })).status).toBe(404);
  });

  it("takes only an uploaded picture as the background", async () => {
    expect((await api(`/api/v1/matches/${matchId}/art/settings`, { method: "PUT", body: { backgroundAssetId: "../../x.png" } })).status).toBe(400);
    const ok = await api(`/api/v1/matches/${matchId}/art/settings`, { method: "PUT", body: { backgroundAssetId: "0123456789abcdef01234567.jpg" } });
    expect(ok.json).toEqual({ backgroundAssetId: "0123456789abcdef01234567.jpg" });
    expect((await api(`/api/v1/matches/${matchId}/art`)).json!.settings).toEqual({ backgroundAssetId: "0123456789abcdef01234567.jpg" });
  });

  it("puts the stingers in OBS's Matchframe transitions, says which are missing, and uses the replay one for replays", async () => {
    expect((await api(`/api/v1/matches/${matchId}/art/obs`, { body: {} })).status).toBe(409);
    e.obs.state.connected = true;
    const first = await api(`/api/v1/matches/${matchId}/art/obs`, { body: { useStinger: true } });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toMatchObject({ set: [{ kind: "stinger", transition: "Matchframe Stinger", confirmed: true }], missing: ["Matchframe Replay Stinger"], current: "Matchframe Stinger" });
    expect(obs.changes[0]).toMatchObject({ name: "Matchframe Stinger", keepCurrent: true, settings: { transition_point: 900, tp_type: 0 } });
    expect(String(obs.changes[0]!.settings.path)).toMatch(/stinger\.mov$/);
    expect(existsSync(String(obs.changes[0]!.settings.path))).toBe(true);
    // The replay transition is added in OBS and the replay stinger made: both go in.
    obs.transitions.push({ name: "Matchframe Replay Stinger", kind: "obs_stinger_transition" });
    expect((await api(`/api/v1/matches/${matchId}/art/stinger-replay`, { raw: MOV })).status).toBe(200);
    obs.changes.length = 0;
    const second = await api(`/api/v1/matches/${matchId}/art/obs`, { body: { useStinger: false } });
    expect(second.json).toMatchObject({ missing: [], replayTransition: "Matchframe Replay Stinger" });
    expect(obs.changes.map((c) => [c.name, c.keepCurrent])).toEqual([
      ["Matchframe Stinger", false],
      ["Matchframe Replay Stinger", false],
    ]);
    expect(String(obs.changes[1]!.settings.path)).toMatch(/stinger-replay\.mov$/);
    // A replay transition the operator chose is kept.
    e.obsAuto.setSettings({ replayTransition: "Fade" });
    expect((await api(`/api/v1/matches/${matchId}/art/obs`, { body: {} })).json).toMatchObject({ replayTransition: "Fade" });
  });

  it("points the stingers at a match when it becomes the active one", async () => {
    obs.changes.length = 0;
    expect((await api(`/api/v1/matches/${matchId}/activate`, { body: {} })).status).toBe(200);
    for (let i = 0; i < 50 && obs.changes.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(obs.changes.map((c) => c.name)).toEqual(["Matchframe Stinger", "Matchframe Replay Stinger"]);
    // Quietly: OBS's current transition stays what it was.
    expect(obs.changes.every((c) => !c.keepCurrent)).toBe(true);
  });
});
