import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseStore } from "../../../apps/desktop/src/hud/store.ts";
import { Engine } from "../src/app.ts";
import { brandedFolder } from "../src/brand.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

/**
 * Upgrading from 0.11.0 (the branding release: "Matchframe" → "MatchFrame", imported hud.json-format
 * HUDs' ids `lhm.<slug>` → `imported.<slug>` and runtime "lhm" → "compat").
 *
 * fixtures/upgrade-0.11.0 is a data folder made by the 0.11.0 engine itself (commit 0534b68, driven
 * through its HTTP API): under appdata/ the data folder as 0.11.0's desktop program named it
 * ("Matchframe Esports"), with two teams (one with a logo), a player with a picture on a roster, a
 * match, HUD images, an imported hud.json-format HUD "Community HUD" (lhm.community-hud, runtime
 * "lhm") with its settings (a team, a text, an uploaded picture), a published output using it, the
 * replay graphic and the HUD pages set to it, its account-sync record, the HUD kept on this computer
 * only, and the desktop program's placement of its window (program/hud-overlays.json); under
 * videos/ the "Matchframe Highlights" and "Matchframe Comms Recordings" folders.
 *
 * The new engine starts on a copy of it, on this case-sensitive file system: everything is there,
 * the HUD serves at its new address and at the old one (an OBS browser source made before the
 * update) with the same token, every reference names the new id, and a second start changes nothing.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "upgrade-0.11.0");
const OLD_ID = "lhm.community-hud";
const NEW_ID = "imported.community-hud";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Every file under `dir` with its SHA-256. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("upgrade from 0.11.0", () => {
  const root = mkdtempSync(join(tmpdir(), "mf-upgrade-0110-"));
  const appData = join(root, "appdata");
  const videos = join(root, "videos");
  let dataDir = "";
  let e: Engine;
  let servers: Awaited<ReturnType<typeof startServers>>;
  let ports: { gsi: number; api: number; overlay: number };
  /** What 0.11.0 stored, read before the new engine starts. */
  let before: { token: string; teams: string[]; lite: string; logo: string; avatar: string; settings: Record<string, unknown>; huds: string[] };

  const db = () => new DatabaseSync(join(dataDir, "matchframe.sqlite"));
  const rows = <T>(sql: string, ...args: (string | number)[]) => {
    const d = db();
    try {
      return d.prepare(sql).all(...args) as T[];
    } finally {
      d.close();
    }
  };
  const start = async () => {
    ports = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
    e = new Engine(loadConfig({ dataDir, videosDir: videos, gsiPort: ports.gsi, apiPort: ports.api, overlayPort: ports.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null, sampleHudsDirs: [], cloudEnforcement: "off" }));
    await e.init();
    servers = await startServers(e);
  };
  const stop = async () => {
    await servers?.close();
    await e?.shutdown();
  };
  const api = async <T>(path: string) => {
    const r = await fetch(`http://127.0.0.1:${ports.api}${path}`, { headers: { authorization: `Bearer ${e.secrets.operatorToken}` } });
    expect(r.status, path).toBe(200);
    return (await r.json()) as T;
  };
  const overlay = (path: string, cookie?: string) => fetch(`http://127.0.0.1:${ports.overlay}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });

  beforeAll(async () => {
    process.env.MATCHFRAME_LOG_STDOUT = "0";
    cpSync(FIXTURE, root, { recursive: true });
    // The data folder as the desktop program finds it now: the one 0.11.0 made, as it is named on disk.
    dataDir = brandedFolder(appData, "MatchFrame Esports");
    // The fixture was made elsewhere: its HUD's recorded folder is moved to this copy (an upgrade never moves it).
    {
      const d = db();
      const r = d.prepare("SELECT install_dir FROM hud_packages WHERE id = ?").get(OLD_ID) as { install_dir: string };
      const was = r.install_dir.slice(0, r.install_dir.indexOf("/huds/"));
      d.prepare("UPDATE hud_packages SET install_dir = replace(install_dir, ?, ?)").run(was, dataDir);
      d.close();
    }
    const lib = rows<{ token: string }>("SELECT token FROM hud_library WHERE id = ?", OLD_ID)[0]!;
    const teams = rows<{ id: string; data: string }>("SELECT id, data FROM documents WHERE kind = 'team' ORDER BY id");
    const player = JSON.parse(rows<{ data: string }>("SELECT data FROM documents WHERE kind = 'player'")[0]!.data) as { avatarAssetId: string };
    const settings = Object.fromEntries(rows<{ key: string; value: string }>("SELECT key, value FROM settings").map((r) => [r.key, JSON.parse(r.value)]));
    const lite = teams.find((t) => t.data.includes("LITE Esports"))!;
    before = { token: lib.token, teams: teams.map((t) => t.id), lite: lite.id, logo: (JSON.parse(lite.data) as { logoAssetId: string }).logoAssetId, avatar: player.avatarAssetId, settings, huds: readdirSync(join(dataDir, "huds")) };
    expect(before.huds).toEqual([OLD_ID]);
    expect(rows<{ manifest: string }>("SELECT manifest FROM hud_packages WHERE id = ?", OLD_ID)[0]!.manifest).toContain('"runtime":"lhm"');
    await start();
  });

  afterAll(async () => {
    await stop();
  });

  it("keeps using the data folder 0.11.0 made (old spelling, case-sensitive file system) and its Videos folders", () => {
    expect(dataDir).toBe(join(appData, "Matchframe Esports"));
    expect(readdirSync(appData)).toEqual(["Matchframe Esports"]);
    expect(e.cfg.dataDir).toBe(dataDir);
    expect(e.reels.folder()).toBe(join(videos, "Matchframe Highlights"));
    expect(readdirSync(e.reels.folder())).toContain("reel-0110.mp4");
    expect(e.commsRecording.folder()).toBe(join(videos, "Matchframe Comms Recordings"));
    expect(readdirSync(videos).sort()).toEqual(["Matchframe Comms Recordings", "Matchframe Highlights"]);
  });

  it("has every team, player, match and uploaded picture", async () => {
    const teams = await api<{ id: string; name: string; shortName: string; logoAssetId: string | null; roster: { player: { displayName: string } | null }[] }[]>("/api/v1/teams");
    expect(teams.map((t) => t.id).sort()).toEqual(before.teams);
    const lite = teams.find((t) => t.name === "LITE Esports")!;
    expect(lite).toMatchObject({ shortName: "LITE", logoAssetId: before.logo });
    const players = await api<{ displayName: string; realName: string | null; avatarAssetId: string | null }[]>("/api/v1/players");
    expect(players).toEqual([expect.objectContaining({ displayName: "Malakai", realName: "Kai Brown", avatarAssetId: before.avatar })]);
    expect(e.roster.forTeam(lite.id).map((m) => e.players.get(m.playerId)?.data.displayName)).toEqual(["Malakai"]);
    const matches = await api<{ teamAId: string; teamBId: string }[]>("/api/v1/matches");
    expect(matches).toHaveLength(1);
    expect([matches[0]!.teamAId, matches[0]!.teamBId].sort()).toEqual(before.teams);
    for (const asset of [before.logo, before.avatar]) {
      const r = await overlay(`/assets/${asset}`);
      expect(r.status, asset).toBe(200);
      expect(Buffer.from(await r.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
    }
    expect(e.hudArtSetting()).toEqual(before.settings["hud.art"]);
  });

  it("brings the imported HUD up to date: new id and folder, runtime compat, its settings and token kept", async () => {
    expect(e.legacyHuds).toEqual({ renamed: [{ from: OLD_ID, to: NEW_ID }], kept: [] });
    expect(readdirSync(join(dataDir, "huds"))).toEqual([NEW_ID]);
    const lib = await api<{ huds: { id: string; runtime: string; category: string; tags: string[]; description: string; settings: Record<string, unknown>; urls: Record<string, string> }[] }>("/api/v1/hud/library");
    expect(lib.huds.map((h) => h.id)).not.toContain(OLD_ID);
    const hud = lib.huds.find((h) => h.id === NEW_ID)!;
    expect(hud).toMatchObject({ runtime: "compat", category: "Imported", tags: ["imported", "minimap", "killfeed"], description: "Imported HUD (hud.json format) with its own minimap and killfeed, running in MatchFrame's HUD compatibility layer." });
    expect(hud.settings).toEqual({ "teams.left_team": before.lite, "teams.title": "Grand Final", "teams.sponsors": [before.logo] });
    expect(hud.urls.live).toContain(`/hud/${NEW_ID}/live?t=${before.token}`);
    // The manifest on disk and the database's copy agree, and its recorded checksum is the file's.
    const file = join(dataDir, "huds", NEW_ID, "1.2.0", "manifest.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ id: NEW_ID, runtime: "compat", category: "Imported", name: "Community HUD", author: "A HUD author" });
    const row = rows<{ install_dir: string; checksums: string; manifest: string }>("SELECT install_dir, checksums, manifest FROM hud_packages WHERE id = ?", NEW_ID)[0]!;
    expect(row.install_dir).toBe(join(dataDir, "huds", NEW_ID, "1.2.0"));
    expect((JSON.parse(row.checksums) as Record<string, string>)["manifest.json"]).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
    expect(JSON.parse(row.manifest)).toMatchObject({ id: NEW_ID, runtime: "compat" });
    // The HUD's own files are untouched.
    for (const name of ["hud.json", "index.html", "panel.json", "keybinds.json"]) expect(readFileSync(join(dataDir, "huds", NEW_ID, "1.2.0", name)), name).toEqual(readFileSync(join(FIXTURE, "appdata", "Matchframe Esports", "huds", OLD_ID, "1.2.0", name)));
  });

  it("serves the HUD at its new address and at the old one (an OBS browser source made before the update), with the same token", async () => {
    for (const id of [NEW_ID, OLD_ID]) {
      const page = await overlay(`/hud/${id}/live?t=${before.token}`);
      expect(page.status, id).toBe(200);
      expect(page.headers.get("set-cookie"), id).toMatch(new RegExp(`^mf_compat_${NEW_ID.replace(".", "\\.")}=${before.token};`));
      const html = await page.text();
      expect(html).toContain(`/huds/${NEW_ID}/index.html`);
      expect((await overlay(`/hud/${id}/live?t=wrong`)).status, id).toBe(401);
    }
    const files = await overlay(`/huds/${NEW_ID}/index.html`);
    expect(files.status).toBe(200);
    expect(await files.text()).toContain("Community HUD");
    // A page opened before the update still sends 0.11.0's cookie (its name has the old id): the HUD's API answers it.
    expect((await overlay("/api/teams", `mf_lhm_${OLD_ID}=${before.token}`)).status).toBe(200);
    expect((await overlay("/api/teams", `mf_compat_${NEW_ID}=${before.token}`)).status).toBe(200);
    expect((await overlay("/api/teams", `mf_lhm_${OLD_ID}=wrong`)).status).toBe(401);
  });

  it("points every reference at the new id: outputs, program settings, account sync, the desktop program's placement", async () => {
    const output = JSON.parse(rows<{ data: string }>("SELECT data FROM documents WHERE kind = 'output' AND id = 'obs-left'")[0]!.data) as { packageId: string };
    expect(output.packageId).toBe(NEW_ID);
    expect(rows<{ data: string }>("SELECT data FROM output_revisions WHERE output_id = 'obs-left'").map((r) => (JSON.parse(r.data) as { packageId: string }).packageId)).toEqual([NEW_ID]);
    expect(e.replayGraphic.settings()).toMatchObject({ enabled: true, hudId: NEW_ID });
    expect((e.settings.get("graphics.auto", {}) as { pages: { hudId: string; playerSource: string } }).pages).toMatchObject({ hudId: NEW_ID, playerSource: "Player stats" });
    expect(e.settings.get("cloud.sync.localHuds", [])).toEqual([NEW_ID]);
    expect(rows<{ id: string; hash: string; seq: number }>("SELECT id, hash, seq FROM sync_state WHERE kind = 'hud'")).toEqual([{ id: NEW_ID, hash: "h0110", seq: 7 }]);
    // Nothing anywhere in the program's own records names the old id, except the audit log (history).
    for (const [table, col] of [["documents", "data"], ["output_revisions", "data"], ["settings", "value"], ["hud_library", "settings"], ["hud_packages", "manifest"], ["sync_state", "id"]] as const) {
      expect(rows(`SELECT 1 FROM ${table} WHERE instr(${col}, ?) > 0`, OLD_ID), table).toEqual([]);
    }
    expect(rows("SELECT 1 FROM audit_log WHERE target = ?", OLD_ID).length).toBeGreaterThan(0);
    // The desktop program's window placement (its own file, read with its own code).
    const placements = parseStore(JSON.parse(readFileSync(join(dataDir, "program", "hud-overlays.json"), "utf8")));
    expect(Object.keys(placements.overlays)).toEqual([NEW_ID]);
    expect(placements.overlays[NEW_ID]).toMatchObject({ locked: true, bounds: { width: 1920, height: 1080 } });
  });

  it("changes nothing when it starts again", async () => {
    const snapshot = () => ({
      files: tree(join(dataDir, "huds")),
      packages: rows("SELECT id, manifest, install_dir, checksums, previous FROM hud_packages ORDER BY id"),
      library: rows("SELECT id, settings, token, stopped FROM hud_library ORDER BY id"),
      documents: rows("SELECT kind, id, data, updated_at FROM documents ORDER BY kind, id"),
      revisions: rows("SELECT output_id, revision, data FROM output_revisions ORDER BY output_id, revision"),
      sync: rows("SELECT kind, id, hash, seq FROM sync_state ORDER BY kind, id"),
      settings: rows("SELECT key, value FROM settings WHERE key IN ('replay.graphic', 'graphics.auto', 'cloud.sync.localHuds', 'hud.art') ORDER BY key"),
    });
    await stop();
    const first = snapshot();
    await start();
    expect(e.legacyHuds).toEqual({ renamed: [], kept: [] });
    await stop();
    expect(snapshot()).toEqual(first);
    await start();
    expect((await overlay(`/hud/${OLD_ID}/live?t=${before.token}`)).status).toBe(200);
  });
});
