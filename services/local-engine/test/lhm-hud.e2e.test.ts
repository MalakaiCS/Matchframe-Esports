import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HudLibraryEntry } from "@matchframe/contracts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { normalizeSettingsSchema } from "../src/hud/library.ts";
import { convertLhmPackage, hudConfig, panelSettings, parsePanel } from "../src/hud/lhm.ts";
import { mirvPlayerDeath } from "../src/hud/lhm-runtime.ts";
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

const PANEL = [
  {
    label: "Tournament",
    name: "tournament",
    inputs: [
      { type: "text", name: "header_primary", label: "Header Primary (left)" },
      { type: "action", name: "header_state", values: [{ name: "header_toggle", label: "Toggle Header" }] },
    ],
  },
  {
    label: "Player stats",
    name: "player_stats",
    inputs: [
      { type: "player", name: "selected_player", label: "Selected player" },
      { type: "select", name: "selected_map", label: "Selected map", values: [{ name: "de_dust2", label: "Dust 2" }, { name: "de_nuke", label: "Nuke" }] },
    ],
  },
  { label: "Advertising", name: "ads", inputs: [{ type: "images", name: "baseboard_image", label: "Baseboard image" }] },
];

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);

const lhmZip = () =>
  zipSync({
    "KaiHUD/hud.json": strToU8(JSON.stringify({ name: "KaiHUD", version: "1.0.0", author: "misterrhh", legacy: false, radar: true, killfeed: true, game: "cs2", variants: ["player-stats", "match-stats", "match-preview", "veto", "baseboard"] })),
    "KaiHUD/panel.json": strToU8(JSON.stringify(PANEL)),
    "KaiHUD/keybinds.json": strToU8("[]"),
    "KaiHUD/index.html": strToU8('<!doctype html><html><body><div id="root"></div><script type="module" src="./assets/index.js"></script></body></html>'),
    "KaiHUD/assets/index.js": strToU8("console.log('hud')"),
    "KaiHUD/thumb.png": new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });

describe("LHM package conversion", () => {
  it("turns panel.json into settings fields and back into LHM's hud_config shape", () => {
    const panel = parsePanel(JSON.stringify(PANEL));
    const { schema, skipped } = panelSettings(panel);
    expect(Object.keys(schema)).toEqual(["tournament.header_primary", "tournament.header_state", "player_stats.selected_player", "player_stats.selected_map", "ads.baseboard_image"]);
    expect(schema["tournament.header_state"]).toMatchObject({ type: "action", group: "Tournament", options: [{ value: "header_toggle", label: "Toggle Header" }] });
    expect(schema["player_stats.selected_player"]!.type).toBe("player");
    expect(schema["ads.baseboard_image"]).toMatchObject({ type: "images", default: [] });
    expect(skipped).toEqual([]);
    const lookup = { player: (id: string) => ({ steamid: id, username: "nova" }), team: () => null, image: (id: string) => (id === "missing.png" ? null : `b64:${id}`) };
    const cfg = hudConfig(panel, { "tournament.header_primary": "Grand final", "player_stats.selected_player": "76561198000000001", "player_stats.selected_map": "de_nuke", "ads.baseboard_image": ["a.png", "missing.png", "b.png"] }, lookup);
    expect(cfg).toEqual({
      tournament: { header_primary: "Grand final" },
      player_stats: { selected_player: { type: "player", id: "76561198000000001", player: { steamid: "76561198000000001", username: "nova" } }, selected_map: "de_nuke" },
      // Image inputs arrive as LHM sends them: base64 strings.
      ads: { baseboard_image: ["b64:a.png", "b64:b.png"] },
    });
  });

  it("keeps buttons only in LHM-format HUDs' settings (no other HUD can receive them)", () => {
    const raw = { toggle: { type: "action", label: "Toggle", options: [{ value: "go", label: "Go" }] }, title: { type: "string", default: "x" } };
    expect(Object.keys(normalizeSettingsSchema(raw))).toEqual(["title"]);
    expect(Object.keys(normalizeSettingsSchema(raw, "lhm"))).toEqual(["toggle", "title"]);
  });

  it("turns a paired kill into the HLAE player_death event the template's killfeed reads", () => {
    const base = { id: "k1", kind: "probable" as const, victim: { steamId: "2", name: "kite", side: "CT" as const }, weapon: "weapon_awp", headshot: true, attackerBlind: true, atMs: 0 };
    expect(mirvPlayerDeath({ ...base, killer: { steamId: "1", name: "haze", side: "T" }, assister: { steamId: "3", name: "saber", side: "T" } })).toEqual({
      name: "player_death",
      keys: { userid: { value: 0, xuid: "2" }, attacker: { value: 0, xuid: "1" }, assister: { value: 0, xuid: "3" }, assistedflash: false, weapon: "awp", headshot: true, penetrated: 0, attackerblind: true, thrusmoke: false, noscope: false, attackerinair: false },
    });
    // A death without a paired killer is not sent (the template expects a killer).
    expect(mirvPlayerDeath({ ...base, kind: "elimination", killer: null, assister: null })).toBeNull();
  });

  it("refuses a hud.json for another game and leaves Matchframe packages alone", () => {
    const files = new Map([
      ["hud.json", strToU8(JSON.stringify({ name: "LoL HUD", game: "lol" }))],
      ["index.html", strToU8("<html></html>")],
    ]);
    expect(() => convertLhmPackage(files)).toThrow(/for lol/);
    const mf = new Map([["manifest.json", strToU8("{}")]]);
    expect(convertLhmPackage(mf).converted).toBe(false);
  });
});

describe("LHM-format HUD in the library (engine)", () => {
  let engine: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  const ports = { gsi: 0, api: 0, overlay: 0 };
  let api: (path: string, init?: { method?: string; body?: unknown; raw?: Uint8Array }) => Promise<{ status: number; json: Record<string, unknown> }>;
  let entry: HudLibraryEntry;
  let token = "";
  const sockets: Socket[] = [];

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    Object.assign(ports, { gsi: await freePort(), api: await freePort(), overlay: await freePort() });
    const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-lhm-")), gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, radarDir: join(import.meta.dirname, "..", "..", "..", "assets", "radars"), workersDir: null, pythonPath: null, sampleHudsDirs: [] });
    engine = new Engine(cfg);
    await engine.init();
    servers = await startServers(engine);
    const op = engine.secrets.operatorToken;
    api = async (path, init = {}) => {
      const res = await fetch(`http://127.0.0.1:${ports.api}${path}`, {
        method: init.method ?? "GET",
        headers: { authorization: `Bearer ${op}`, "content-type": init.raw ? "application/zip" : "application/json" },
        body: init.raw ? Buffer.from(init.raw) : init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
  });

  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await servers?.close();
    await engine?.shutdown();
  });

  const overlay = (path: string, cookie?: string) => fetch(`http://127.0.0.1:${ports.overlay}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  const connect = (cookie?: string) => {
    const s = io(`http://127.0.0.1:${ports.overlay}`, { path: "/socket.io", extraHeaders: cookie ? { cookie } : {}, reconnection: false, timeout: 3000 });
    sockets.push(s);
    return s;
  };
  const next = <T>(s: Socket, event: string) => new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ${event}`)), 4000);
    s.once(event, (v: T) => {
      clearTimeout(t);
      resolve(v);
    });
  });

  it("imports an LHM ZIP as an LHM-runtime HUD with its panel as the settings form", async () => {
    const r = await api("/api/v1/hud/library/import", { method: "POST", raw: lhmZip() });
    expect(r.status).toBe(200);
    entry = r.json as unknown as HudLibraryEntry;
    expect(entry).toMatchObject({ id: "lhm.kaihud", name: "KaiHUD", author: "misterrhh", version: "1.0.0", runtime: "lhm", category: "LHM" });
    expect(Object.keys(entry.settingsSchema)).toContain("tournament.header_state");
    token = new URL(entry.urls.live!).searchParams.get("t")!;
  });

  it("offers the HUD's own pages (kaiHUD's player highlight, match stats, ...) and opens each one", async () => {
    expect(entry.views.map((v) => [v.id, v.label])).toEqual([
      ["player-stats", "Player stats"],
      ["match-stats", "Match stats"],
      ["match-preview", "Match preview"],
      ["veto", "Veto"],
      ["baseboard", "Baseboard"],
    ]);
    const url = new URL(entry.views[0]!.url);
    expect(url.pathname).toBe(`/hud/${entry.id}/live`);
    expect(url.searchParams.get("view")).toBe("player-stats");
    const page = await overlay(`${url.pathname}${url.search}`);
    expect(page.status).toBe(200);
    // The HUD picks its page from the variant parameter.
    expect(await page.text()).toContain("variant=player-stats");
    expect((await overlay(`/hud/${entry.id}/live?t=${token}&view=nope`)).status).toBe(404);
  });

  it("sets the HUD's cookie on its page, loads it with isProd, and shows a test-data badge slot", async () => {
    const page = await overlay(`/hud/${entry.id}/live?t=${token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toMatch(new RegExp(`^mf_lhm_lhm\\.kaihud=${token}; Path=/; HttpOnly; SameSite=Strict`));
    const html = await page.text();
    expect(html).toContain("isProd=1");
    expect(html).toContain('id="mf-test"');
    // The HUD's own files may load Google Fonts (and nothing else remote).
    const csp = (await overlay(`/huds/${entry.id}/index.html`)).headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/style-src [^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src [^;]*https:\/\/fonts\.gstatic\.com/);
    expect(csp).not.toMatch(/script-src [^;]*https:/);
  });

  it("refuses the API and sockets without the cookie, and answers LHM's API with it", async () => {
    const cookie = `mf_lhm_${entry.id}=${token}`;
    expect((await overlay("/api/teams")).status).toBe(401);
    expect((await overlay("/api/teams", `mf_lhm_${entry.id}=wrong`)).status).toBe(401);
    const team = await api("/api/v1/teams", { method: "POST", body: { name: "Northern Lights", shortName: "NOR", primaryColor: "#1e90ff" } });
    expect(team.status).toBeLessThan(300);
    const teams = (await (await overlay("/api/teams", cookie)).json()) as { _id: string; name: string; logo: string | null; extra: { TeamColor: string } }[];
    expect(teams.find((t) => t.name === "Northern Lights")?.extra.TeamColor).toBe("#1e90ff");
    // A team logo is an address the HUD can load directly (kaiHUD uses it as the image source).
    const logo = await api(`/api/v1/assets?name=logo.png`, { method: "POST", raw: PNG });
    const teamId = (team.json as { id: string }).id;
    await api(`/api/v1/teams/${teamId}`, { method: "PATCH", body: { logoAssetId: (logo.json as { assetId: string }).assetId } });
    const withLogo = (await (await overlay(`/api/teams/${teamId}`, cookie)).json()) as { logo: string };
    expect(withLogo.logo).toBe(`/api/teams/logo/${teamId}`);
    const img = await overlay(withLogo.logo, cookie);
    expect(img.status).toBe(302);
    expect(await (await overlay("/api/match/current", cookie)).json()).toBeNull();
    expect(await (await overlay("/api/camera", cookie)).json()).toMatchObject({ availablePlayers: [] });
    expect((await overlay("/api/unknown", cookie)).status).toBe(404);
    // Newer template HUDs load radars from /api/game-maps: Matchframe's built-in radars.
    const maps = (await (await overlay("/api/game-maps/cs2", cookie)).json()) as { lhmId: string; radars: { lhmId: string; visibleUnderHeight: number | null; visibleOverHeight: number | null }[] }[];
    expect(maps.map((m) => m.lhmId)).toContain("de_dust2");
    expect(maps.find((m) => m.lhmId === "de_nuke")!.radars.map((r) => [r.lhmId, r.visibleUnderHeight, r.visibleOverHeight])).toEqual([
      ["upper", -450, null],
      ["lower", null, -450],
    ]);
    const radar = await overlay("/api/game-maps/cs2/image/de_dust2/radar", cookie);
    expect(radar.status).toBe(200);
    expect(radar.headers.get("content-type")).toBe("image/png");

    const refused = connect();
    await expect(next(refused, "connect")).rejects.toThrow();
  });

  it("registers the HUD, sends its settings, every game-data packet and panel buttons", async () => {
    const cookie = `mf_lhm_${entry.id}=${token}`;
    const s = connect(cookie);
    await next(s, "readyToRegister");
    const firstConfig = next<Record<string, unknown>>(s, "hud_config");
    s.emit("register", entry.id, false, "cs2", "DEFAULT");
    // Text inputs start empty; nothing else is set yet.
    expect(await firstConfig).toEqual({ tournament: { header_primary: "" } });

    const config = next<Record<string, Record<string, unknown>>>(s, "hud_config");
    expect((await api(`/api/v1/hud/library/${entry.id}/settings`, { method: "PUT", body: { settings: { "tournament.header_primary": "Grand final", "player_stats.selected_map": "de_nuke" } } })).status).toBe(200);
    expect(await config).toEqual({ tournament: { header_primary: "Grand final" }, player_stats: { selected_map: "de_nuke" } });

    const update = next<Record<string, unknown>>(s, "update");
    const payload = buildSyntheticGsiPayload({ mapName: "de_dust2", players: syntheticRoster(), token: engine.secrets.gsiToken, timestamp: 1_700_000_000 });
    expect((await fetch(`http://127.0.0.1:${ports.gsi}/gsi`, { method: "POST", body: JSON.stringify(payload) })).status).toBe(200);
    const got = await update;
    expect((got.map as { name: string }).name).toBe("de_dust2");
    expect(got.allplayers).toBeTruthy();
    expect(got.auth).toBeUndefined();

    // Image inputs (kaiHUD's baseboard sponsors): uploaded images, sent as base64 like LHM does.
    const asset = await api(`/api/v1/assets?name=sponsor.png`, { method: "POST", raw: PNG });
    const assetId = (asset.json as { assetId: string }).assetId;
    const withImages = next<Record<string, Record<string, unknown>>>(s, "hud_config");
    expect((await api(`/api/v1/hud/library/${entry.id}/settings`, { method: "PUT", body: { settings: { "ads.baseboard_image": [assetId] } } })).status).toBe(200);
    expect((await withImages).ads).toEqual({ baseboard_image: [Buffer.from(PNG).toString("base64")] });
    expect((await api(`/api/v1/hud/library/${entry.id}/settings`, { method: "PUT", body: { settings: { "ads.baseboard_image": ["../secret.png"] } } })).status).toBe(400);

    const action = next<{ action: string; data: string }>(s, "hud_action");
    expect((await api(`/api/v1/hud/library/${entry.id}/action`, { method: "POST", body: { key: "tournament.header_state", value: "header_toggle" } })).status).toBe(200);
    expect(await action).toEqual({ action: "header_state", data: "header_toggle" });
    expect((await api(`/api/v1/hud/library/${entry.id}/action`, { method: "POST", body: { key: "tournament.header_state", value: "nope" } })).status).toBe(400);
  });
});
