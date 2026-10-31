import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HudState } from "@matchframe/hud-sdk";
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

const assets = join(import.meta.dirname, "..", "..", "..", "assets");
// A 1×1 PNG and a small SVG (stored by content hash, so each upload gets its own id).
const png = (n: number) => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex"), Buffer.from([n])]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path d="M1 1L7 7M7 1L1 7" stroke="#fff"/></svg>');

describe("HUD images and the clean radar (real HTTP/WS servers)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-hud-art-"));
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let ports: { gsi: number; api: number; overlay: number };
  let api: (path: string, init?: RequestInit) => Promise<Response>;

  beforeAll(async () => {
    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    const cfg = loadConfig({ dataDir, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: join(assets, "map-packs"), radarDir: join(assets, "radars"), workersDir: null, pythonPath: null });
    engine = new Engine(cfg);
    await engine.init();
    servers = await startServers(engine);
    const token = engine.secrets.operatorToken;
    api = (path, init = {}) => fetch(`http://127.0.0.1:${ports.api}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  });

  afterAll(async () => {
    await servers?.close();
    await engine?.shutdown();
  });

  const upload = async (name: string, body: Buffer) => ((await (await api(`/api/v1/assets?name=${name}`, { method: "POST", body, headers: { "content-type": "application/octet-stream" } })).json()) as { assetId: string }).assetId;

  it("lists the maps Matchframe knows and starts empty", async () => {
    const r = (await (await api("/api/v1/hud/art")).json()) as { art: unknown; maps: { mapName: string; displayName: string }[] };
    expect(r.art).toEqual({ defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } });
    expect(r.maps.map((m) => m.mapName)).toEqual(expect.arrayContaining(["de_ancient", "de_anubis", "de_cache", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]));
    expect(r.maps.find((m) => m.mapName === "de_dust2")?.displayName).toBe("Dust II");
    expect(r.maps.some((m) => m.mapName === "de_synthetic")).toBe(false);
  });

  it("accepts only uploaded pictures, five per side, and pushes them to HUDs at once", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${ports.overlay}/overlay-ws?output=main&t=${engine.outputs.token("main")}`);
    const states: HudState[] = [];
    ws.on("message", (d) => states.push((JSON.parse(String(d)) as { payload: HudState }).payload));
    await new Promise((r) => ws.once("message", r));
    expect(states[0]!.art).toEqual({ defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } });

    const put = (art: unknown) => api("/api/v1/hud/art", { method: "PUT", body: JSON.stringify(art) });
    expect((await put({ icons: { dead: "../../secrets.json" } })).status).toBe(400);
    const unknown = await put({ icons: { dead: "0123456789abcdef01234567.png" } });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_asset");
    const ids = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => upload(`p${n}.png`, png(n))));
    expect((await put({ defaultPlayers: { ct: ids, t: [] } })).status).toBe(400);
    // Videos are uploads too, but not pictures.
    expect((await put({ icons: { dead: (await upload("clip.webm", Buffer.from("webm"))) } })).status).toBe(400);

    const dead = await upload("dead.svg", svg);
    const saved = await put({ defaultPlayers: { ct: [ids[0], ids[1]], t: [ids[2]] }, maps: { de_mirage: { logo: ids[3], image: ids[4] }, de_nuke: { logo: null, image: null } }, icons: { dead } });
    expect(saved.status).toBe(200);
    const body = (await saved.json()) as { art: { maps: Record<string, unknown> } };
    // Maps with neither picture are not kept.
    expect(Object.keys(body.art.maps)).toEqual(["de_mirage"]);
    expect(((await (await api("/api/v1/hud/art")).json()) as { art: unknown }).art).toEqual(body.art);

    await expect.poll(() => states.at(-1)?.art.icons.dead ?? null).toBe(`/assets/${dead}`);
    const art = states.at(-1)!.art;
    expect(art.defaultPlayers).toEqual({ ct: [`/assets/${ids[0]}`, `/assets/${ids[1]}`], t: [`/assets/${ids[2]}`] });
    expect(art.maps).toEqual({ de_mirage: { logoUrl: `/assets/${ids[3]}`, imageUrl: `/assets/${ids[4]}` } });
    // HUD pages load them from the overlay server.
    const pic = await fetch(`http://127.0.0.1:${ports.overlay}${art.icons.dead}`);
    expect(pic.status).toBe(200);
    expect(pic.headers.get("content-type")).toContain("image/svg+xml");
    ws.close();

    // Only through the checked route; viewers cannot change them.
    expect((await api("/api/v1/settings/hud.art", { method: "PUT", body: JSON.stringify({ value: { icons: { dead: "x" } } }) })).status).toBe(403);
    const viewer = engine.secrets.issue("viewer", "viewer test");
    expect((await fetch(`http://127.0.0.1:${ports.api}/api/v1/hud/art`, { method: "PUT", headers: { authorization: `Bearer ${viewer.token}`, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    // Cleared again.
    expect(((await (await put({})).json()) as { art: unknown }).art).toEqual({ defaultPlayers: { ct: [], t: [] }, maps: {}, icons: { dead: null } });
  });

  it("serves the clean radar in the frame of the radar background, with round damage on players", async () => {
    const post = (body: unknown) => fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    const players = syntheticRoster().map((p, i) => ({ ...p, position: { x: -300 + i * 40, y: -1500, z: -160 }, forward: { x: 1, y: 0, z: 0 }, roundDamage: i * 25 }));
    for (const [i, mapName] of ["de_mirage", "de_anubis"].entries()) {
      expect((await post(buildSyntheticGsiPayload({ players, mapName, token: engine.secrets.gsiToken, timestamp: 1_700_000_100 + i, round: 3 }))).status).toBe(200);
      await expect.poll(() => engine.session.state()?.mapName).toBe(mapName);
      const hud = (await (await api("/api/v1/hud/outputs/main/state")).json()) as HudState;
      expect(hud.radar.mapName).toBe(mapName);
      // Mirage has a built-in radar image; Anubis uses Matchframe's outline.
      const frame = mapName === "de_mirage" ? "builtin" : "schematic";
      expect(hud.radar.mode).toBe(mapName === "de_mirage" ? "image" : "schematic");
      expect(hud.radar.cleanUrl).toMatch(new RegExp(`^/overlay-api/radar-clean/${mapName}/${frame}\\?v=[0-9a-f]{12}$`));
      const r = await fetch(`http://127.0.0.1:${ports.overlay}${hud.radar.cleanUrl}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("image/svg+xml");
      expect(r.headers.get("cache-control")).toContain("max-age");
      expect(await r.text()).toMatch(/^<svg [^>]*viewBox="0 0 1024 1024"/);
      expect([...hud.left.players, ...hud.right.players].map((p) => p.roundDamage).sort((a, b) => a! - b!)).toEqual(players.map((p) => p.roundDamage));
    }
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/overlay-api/radar-clean/de_anubis/builtin`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${ports.overlay}/overlay-api/radar-clean/de_nowhere/schematic`)).status).toBe(404);
  });
});
