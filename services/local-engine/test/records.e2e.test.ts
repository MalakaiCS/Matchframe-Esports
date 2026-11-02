import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { readXlsx, writeXlsx } from "../src/domain/xlsx.ts";
import { startServers } from "../src/servers.ts";
import { makePng } from "./helpers/images.ts";

/**
 * The Teams, Players and Matches journeys through the engine API (real HTTP servers, a data folder
 * on disk): create and assign, move players, set up and edit a match with its veto, Make Active,
 * cancelled uploads, duplicate checks, imports, protected deletes, and a restart.
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

async function boot(dataDir: string) {
  const p = { gsi: await freePort(), api: await freePort(), overlay: await freePort() };
  process.env.MATCHFRAME_LOG_STDOUT = "0";
  const cfg = loadConfig({ dataDir, gsiPort: p.gsi, apiPort: p.api, overlayPort: p.overlay, host: "127.0.0.1", captainUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null });
  const engine = new Engine(cfg);
  await engine.init();
  const servers = await startServers(engine);
  return { engine, servers, port: p.api };
}

type Json = Record<string, unknown> & { id: string };
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MALAKAI_STEAM = "76561198000000001";

describe("Teams, Players and Matches through the engine API (journeys 1–8)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mf-records-"));
  let ctx: Awaited<ReturnType<typeof boot>>;
  const call = async <T = Json>(method: string, path: string, body?: unknown, raw?: { data: Buffer; type: string }): Promise<{ status: number; json: T; headers: Headers; buf: Buffer }> => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${ctx.engine.secrets.operatorToken}`, "content-type": raw ? raw.type : "application/json" },
      body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: unknown;
    try {
      json = JSON.parse(buf.toString("utf8"));
    } catch {
      json = null;
    }
    return { status: res.status, json: json as T, headers: res.headers, buf };
  };
  const ids = {} as { lite: string; nl: string; malakai: string; match: string; match2: string; match3: string };
  const staging = () => (existsSync(join(dataDir, "staging")) ? readdirSync(join(dataDir, "staging")) : []);

  beforeAll(async () => {
    ctx = await boot(dataDir);
  });
  afterAll(async () => {
    await ctx?.servers.close();
    await ctx?.engine.shutdown();
  });

  it("1: creates LITE Esports with a logo, adds Malakai to it, and the roster shows him", async () => {
    const up = await call<{ stagedId: string; previewUrl: string; width: number; advice: string | null }>("POST", "/api/v1/uploads/images", undefined, { data: makePng(256, 256), type: "image/png" });
    expect(up.status).toBe(200);
    expect(up.json.width).toBe(256);
    expect((await call("GET", up.json.previewUrl)).status).toBe(200);
    const team = await call("POST", "/api/v1/teams", { name: "LITE Esports", shortName: "LITE", countryCode: "AU", logoStagedId: up.json.stagedId });
    expect(team.status).toBe(200);
    ids.lite = team.json.id;
    expect(team.json).toMatchObject({ name: "LITE Esports", shortName: "LITE", countryCode: "AU", playerCount: 0 });
    const logo = team.json.logoAssetId as string;
    expect(logo).toMatch(/^[0-9a-f]{24}\.png$/);
    // Promoted into the asset store; the staged file is gone.
    expect((await call("GET", `/assets/${logo}`)).status).toBe(200);
    expect(staging()).toEqual([]);
    expect((await call("GET", up.json.previewUrl)).status).toBe(404);

    const p = await call("POST", "/api/v1/players", { displayName: "Malakai", firstName: "Kai", lastName: "Brown", countryCode: "AU", steamId: "", teamId: ids.lite });
    expect(p.status).toBe(200);
    ids.malakai = p.json.id;
    expect(p.json).toMatchObject({ displayName: "Malakai", firstName: "Kai", lastName: "Brown", realName: "Kai Brown", steamId: null, teamId: ids.lite, role: "player" });
    const detail = await call<{ roster: { player: { displayName: string } }[]; playerCount: number }>("GET", `/api/v1/teams/${ids.lite}`);
    expect(detail.json.roster.map((m) => m.player.displayName)).toEqual(["Malakai"]);
    const list = await call<{ id: string; playerCount: number }[]>("GET", "/api/v1/teams");
    expect(list.json.find((t) => t.id === ids.lite)!.playerCount).toBe(1);
  });

  it("2: moving him to another team updates both rosters and counts, keeps history, and refuses a stale change", async () => {
    ids.nl = (await call("POST", "/api/v1/teams", { name: "Northern Lights", shortName: "" })).json.id;
    expect((await call("GET", `/api/v1/teams/${ids.nl}`)).json.shortName).toBe("NL");
    const moved = await call("PATCH", `/api/v1/players/${ids.malakai}`, { changes: { teamId: ids.nl }, expected: { teamId: ids.lite } });
    expect(moved.status).toBe(200);
    expect(moved.json.teamId).toBe(ids.nl);
    const counts = new Map((await call<{ id: string; playerCount: number }[]>("GET", "/api/v1/teams")).json.map((t) => [t.id, t.playerCount]));
    expect(counts.get(ids.lite)).toBe(0);
    expect(counts.get(ids.nl)).toBe(1);
    const history = (await call<{ history: { teamId: string; validTo: string | null }[] }>("GET", `/api/v1/players/${ids.malakai}`)).json.history;
    expect(history.map((h) => [h.teamId, h.validTo === null])).toEqual([
      [ids.lite, false],
      [ids.nl, true],
    ]);
    // A second editor that still thinks he is on LITE: its team change conflicts.
    const stale = await call<{ error: string; message: string }>("PATCH", `/api/v1/players/${ids.malakai}`, { changes: { teamId: null }, expected: { teamId: ids.lite } });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("field_conflict");
    expect(stale.json.message).toMatch(/Team changed elsewhere/);
    // A nickname change keeps the SteamID link.
    expect((await call("PATCH", `/api/v1/players/${ids.malakai}`, { changes: { steamId: MALAKAI_STEAM }, expected: { steamId: null } })).status).toBe(200);
    expect((await call("PATCH", `/api/v1/players/${ids.malakai}`, { changes: { displayName: "Malakai." }, expected: { displayName: "Malakai" } })).json).toMatchObject({ displayName: "Malakai.", steamId: MALAKAI_STEAM, firstName: "Kai" });
    expect(ctx.engine.steamIndex.lookup(MALAKAI_STEAM)).toBe(ids.malakai);
    await call("PATCH", `/api/v1/players/${ids.malakai}`, { changes: { displayName: "Malakai" }, expected: { displayName: "Malakai." } });
    // More than five players (substitutes included) are fine.
    for (const n of ["one", "two", "three", "four", "five"]) expect((await call("POST", "/api/v1/players", { displayName: `nl-${n}`, teamId: ids.nl, role: n === "five" ? "substitute" : "player" })).status).toBe(200);
    expect((await call<{ roster: unknown[] }>("GET", `/api/v1/teams/${ids.nl}`)).json.roster).toHaveLength(6);
  });

  it("3: creates a match from saved teams with its format and veto, reopens it and edits it", async () => {
    const partial = [
      { id: "v1", type: "ban", teamId: ids.lite, mapName: "de_inferno" },
      { id: "v2", type: "ban", teamId: ids.nl, mapName: "de_nuke" },
      { id: "v3", type: "pick", teamId: ids.lite, mapName: "de_mirage", sideChoice: "CT" },
    ];
    const created = await call<Json & { maps: { id: string; mapName: string; startingCtTeamId: string }[]; vetoEntries: unknown[]; mapPool: string[]; group: string; active: boolean }>("POST", "/api/v1/matches", { teamAId: ids.lite, teamBId: ids.nl, format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, scheduledAt: "2026-11-20T08:00:00.000Z", veto: partial });
    expect(created.status).toBe(200);
    ids.match = created.json.id;
    expect(created.json.group).toBe("future");
    expect(created.json.active).toBe(false);
    expect(created.json.mapPool.length).toBeGreaterThanOrEqual(7);
    expect(created.json.vetoEntries).toHaveLength(3);
    expect(created.json.maps.map((m) => [m.mapName, m.startingCtTeamId])).toEqual([["de_mirage", ids.nl]]);

    const reopened = await call<Json & { vetoEntries: { id: string }[]; maps: { id: string }[]; seriesScoreA: number }>("GET", `/api/v1/matches/${ids.match}`);
    expect(reopened.json.vetoEntries.map((v) => v.id)).toEqual(["v1", "v2", "v3"]);
    const firstMap = reopened.json.maps[0]!.id;
    const full = [...reopened.json.vetoEntries, { id: "v4", type: "pick", teamId: ids.nl, mapName: "de_ancient", sideChoice: "T", reversedSides: true }, { id: "v5", type: "ban", teamId: ids.lite, mapName: "de_dust2" }, { id: "v6", type: "ban", teamId: ids.nl, mapName: "de_anubis" }, { id: "v7", type: "decider", teamId: null, mapName: "de_cache" }];
    const edited = await call<Json & { maps: { id: string; mapName: string; isDecider: boolean }[] }>("PATCH", `/api/v1/matches/${ids.match}`, { changes: { veto: full, title: "Grand final" }, expected: { veto: reopened.json.vetoEntries, title: null } });
    expect(edited.status).toBe(200);
    expect(edited.json.maps.map((m) => m.mapName)).toEqual(["de_mirage", "de_ancient", "de_cache"]);
    expect(edited.json.maps[0]!.id).toBe(firstMap);
    expect(edited.json.maps[2]!.isDecider).toBe(true);

    // Map 1 is played: the series follows completed maps; the match moves to Current.
    const result = await call<{ series: { a: number; b: number } }>("POST", `/api/v1/matches/${ids.match}/maps/${firstMap}/result`, { scoreA: 13, scoreB: 7, completed: true });
    expect(result.json.series).toMatchObject({ a: 1, b: 0 });
    const afterResult = await call<Json & { group: string; seriesScoreA: number; vetoEntries: unknown[] }>("GET", `/api/v1/matches/${ids.match}`);
    expect(afterResult.json).toMatchObject({ group: "current", seriesScoreA: 1, seriesScoreB: 0, status: "live" });
    // A played map cannot be swapped by a veto edit.
    const swap = full.map((v) => (v.id === "v3" ? { ...v, mapName: "de_anubis" } : v.id === "v6" ? { ...v, mapName: "de_mirage" } : v));
    const refused = await call<{ error: string; message: string }>("PATCH", `/api/v1/matches/${ids.match}`, { changes: { veto: swap }, expected: { veto: afterResult.json.vetoEntries } });
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/Map 1 \(de_mirage\) has a recorded result/);
    // A manual series correction (a map played elsewhere) is added once; totals are checked against BO3.
    const corrected = await call<Json & { seriesScoreA: number; seriesScoreB: number; seriesFromMaps: { a: number; b: number } }>("PATCH", `/api/v1/matches/${ids.match}`, { changes: { seriesScoreB: 1 }, expected: { seriesScoreB: 0 } });
    expect(corrected.json).toMatchObject({ seriesScoreA: 1, seriesScoreB: 1, seriesFromMaps: { a: 1, b: 0 }, seriesCorrectionB: 1 });
    const tooMany = await call<{ message: string }>("PATCH", `/api/v1/matches/${ids.match}`, { changes: { seriesScoreA: 3 }, expected: { seriesScoreA: 1 } });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.message).toMatch(/BO3 a team wins the series with 2 maps/);
    // Concurrent edits: a field changed elsewhere conflicts; other fields merge.
    await call("PATCH", `/api/v1/matches/${ids.match}`, { changes: { scheduledAt: "2026-11-21T08:00:00.000Z" }, expected: { scheduledAt: "2026-11-20T08:00:00.000Z" } });
    const clash = await call<{ error: string; detail: { path: string[] }[] }>("PATCH", `/api/v1/matches/${ids.match}`, { changes: { scheduledAt: "2026-11-22T08:00:00.000Z" }, expected: { scheduledAt: "2026-11-20T08:00:00.000Z" } });
    expect(clash.status).toBe(409);
    expect(clash.json.detail.map((d) => d.path[0])).toEqual(["scheduledAt"]);
    const merged = await call("PATCH", `/api/v1/matches/${ids.match}`, { changes: { title: "Final" }, expected: { title: "Grand final" } });
    expect(merged.json).toMatchObject({ title: "Final", scheduledAt: "2026-11-21T08:00:00.000Z", seriesScoreB: 1 });
  });

  it("4: Make Active switches the active match; the previous one is no longer active and statuses stay", async () => {
    ids.match2 = (await call("POST", "/api/v1/matches", { teamAId: ids.nl, teamBId: ids.lite, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false } })).json.id;
    expect((await call("POST", `/api/v1/matches/${ids.match}/activate`)).json).toMatchObject({ active: ids.match });
    const r = await call("POST", `/api/v1/matches/${ids.match2}/activate`);
    expect(r.json).toMatchObject({ active: ids.match2, previous: ids.match });
    const list = await call<{ id: string; active: boolean; status: string; group: string }[]>("GET", "/api/v1/matches");
    const by = new Map(list.json.map((m) => [m.id, m]));
    expect(list.json.filter((m) => m.active).map((m) => m.id)).toEqual([ids.match2]);
    expect(by.get(ids.match)).toMatchObject({ active: false, status: "live", group: "current" });
    expect(by.get(ids.match2)).toMatchObject({ active: true, status: "scheduled", group: "future" });
    expect(ctx.engine.activeMatch()?.id).toBe(ids.match2);
  });

  it("5: a cancelled form leaves no record and no staged file; the sweeper removes leftovers", async () => {
    const teamsBefore = (await call<unknown[]>("GET", "/api/v1/teams")).json.length;
    const up = await call<{ stagedId: string }>("POST", "/api/v1/uploads/images", undefined, { data: makePng(200, 200), type: "image/png" });
    expect(staging()).toHaveLength(1);
    expect((await call("DELETE", `/api/v1/uploads/images/${up.json.stagedId}`)).json).toEqual({ discarded: true });
    expect(staging()).toEqual([]);
    expect((await call<unknown[]>("GET", "/api/v1/teams")).json).toHaveLength(teamsBefore);
    // Saving with an upload that was cancelled meanwhile is refused clearly (and creates nothing).
    const gone = await call<{ message: string }>("POST", "/api/v1/teams", { name: "Ghost Team", logoStagedId: up.json.stagedId });
    expect(gone.status).toBe(410);
    expect(gone.json.message).toMatch(/upload it again/);
    expect((await call<unknown[]>("GET", "/api/v1/teams")).json).toHaveLength(teamsBefore);
    await call("POST", "/api/v1/uploads/images", undefined, { data: makePng(200, 200), type: "image/png" });
    expect(ctx.engine.staged.sweep(0)).toBe(1);
    expect(staging()).toEqual([]);
    // Not an image: refused with a message.
    const bad = await call<{ message: string }>("POST", "/api/v1/uploads/images", undefined, { data: Buffer.from("<svg/>"), type: "image/svg+xml" });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/not a PNG, JPEG or WebP/);
  });

  it("6: refuses a duplicate SteamID and identical opponents with useful messages", async () => {
    const dup = await call<{ message: string; detail: { path: string[]; message: string }[] }>("POST", "/api/v1/players", { displayName: "Copycat", steamId: MALAKAI_STEAM });
    expect(dup.status).toBe(400);
    expect(dup.json.detail).toEqual([{ path: ["steamId"], message: `SteamID64 ${MALAKAI_STEAM} already belongs to Malakai` }]);
    const badFormat = await call<{ detail: { message: string }[] }>("POST", "/api/v1/players", { displayName: "Typo", steamId: "7656119800000001" });
    expect(badFormat.json.detail[0]!.message).toMatch(/17 digits; this one has 16/);
    const same = await call<{ message: string }>("POST", "/api/v1/matches", { teamAId: ids.lite, teamBId: ids.lite });
    expect(same.status).toBe(400);
    expect(same.json.message).toMatch(/two different teams/);
    const sameEdit = await call<{ detail: { path: string[]; message: string }[] }>("PATCH", `/api/v1/matches/${ids.match2}`, { changes: { teamBId: ids.nl }, expected: { teamBId: ids.lite } });
    expect(sameEdit.status).toBe(400);
    expect(sameEdit.json.detail[0]).toEqual({ path: ["teamBId"], message: "Team 1 and Team 2 must be different teams" });
    const noName = await call<{ detail: { path: string[]; message: string }[] }>("POST", "/api/v1/teams", { name: "  " });
    expect(noName.json.detail[0]).toEqual({ path: ["name"], message: "Enter a team name" });
    const twin = await call<{ detail: { path: string[]; message: string }[] }>("POST", "/api/v1/teams", { name: "lite esports" });
    expect(twin.json.detail[0]!.message).toBe("A team named LITE Esports already exists");
  });

  it("8: import errors, save failures and protected deletions behave clearly", async () => {
    // Templates download as real .xlsx files.
    const tpl = await call("GET", "/api/v1/import/players/template.xlsx");
    expect(tpl.headers.get("content-type")).toBe(XLSX);
    expect(readXlsx(tpl.buf)[0]!.cells.map((c) => c.text)).toEqual(["Nickname", "First name", "Last name", "Country", "SteamID64", "Team"]);

    const teamsFile = writeXlsx([{ name: "Teams", columns: ["Team name", "Short name", "Country"].map((h) => ({ header: h, width: 10 })), rows: [["Red Fox", "RF", "Germany"], ["R F Gaming", "RF", "de"], ["lite esports", "", ""], ["Blue Sharks", "BS", "Atlantis"], ["Red Fox", "", ""]] }]);
    const tp = await call<{ rows: { row: number; errors: string[] }[]; valid: number; invalid: number }>("POST", "/api/v1/import/teams/preview", undefined, { data: teamsFile, type: XLSX });
    expect(tp.json.rows.map((r) => [r.row, r.errors])).toEqual([
      [2, []],
      [3, []],
      [4, ["Team LITE Esports already exists; it is not created again"]],
      [5, ['Country "Atlantis" is not a country code or country name']],
      [6, ["Same team as row 2 in this file"]],
    ]);
    expect((await call("POST", "/api/v1/import/teams/commit", undefined, { data: teamsFile, type: XLSX })).status).toBe(409);
    const tc = await call<{ created: string[]; skippedRows: number[] }>("POST", "/api/v1/import/teams/commit?skipInvalid=1", undefined, { data: teamsFile, type: XLSX });
    expect(tc.json.created).toHaveLength(2);
    expect(tc.json.skippedRows).toEqual([4, 5, 6]);
    // Importing the same file again creates nothing new.
    expect((await call("POST", "/api/v1/import/teams/commit?skipInvalid=1", undefined, { data: teamsFile, type: XLSX })).status).toBe(400);

    const playersFile = writeXlsx([
      {
        name: "Players",
        columns: ["Nickname", "First name", "Last name", "Country", "SteamID64", "Team"].map((h) => ({ header: h, width: 10, text: true })),
        rows: [
          ["fox1", "Ann", "Fox", "DE", "76561198000000101", "Red Fox"],
          ["fox2", "", "", "", "76561198000000102", "RF"],
          ["fox3", "", "", "", "76561198000000101", "Red Fox"],
          ["copy", "", "", "", MALAKAI_STEAM, ""],
          ["lost", "", "", "", "", "Nowhere"],
          ["", "No", "Nick", "", "", ""],
          ["Malakai", "", "", "", "", "LITE"],
          ["shark", "", "", "AU", "123", "lite"],
        ],
      },
    ]);
    const pp = await call<{ rows: { row: number; errors: string[] }[] }>("POST", "/api/v1/import/players/preview", undefined, { data: playersFile, type: XLSX });
    const errs = new Map(pp.json.rows.map((r) => [r.row, r.errors.join(" | ")]));
    expect(errs.get(2)).toBe("");
    expect(errs.get(3)).toMatch(/Team "RF" is ambiguous: it matches Red Fox \(RF\), R F Gaming \(RF\)\. Use the full team name or its id/);
    expect(errs.get(4)).toBe("SteamID64 76561198000000101 is also on row 2 of this file");
    expect(errs.get(5)).toBe(`SteamID64 ${MALAKAI_STEAM} already belongs to Malakai`);
    expect(errs.get(6)).toMatch(/Team "Nowhere" does not exist/);
    expect(errs.get(7)).toBe("Nickname is empty");
    expect(errs.get(8)).toMatch(/A player named Malakai already exists/);
    expect(errs.get(9)).toMatch(/17 digits; this one has 3/);
    const pc = await call<{ created: string[] }>("POST", "/api/v1/import/players/commit?skipInvalid=1", undefined, { data: playersFile, type: XLSX });
    expect(pc.json.created).toHaveLength(1);
    const fox = (await call<{ displayName: string; teamId: string; realName: string }[]>("GET", "/api/v1/players")).json.find((p) => p.displayName === "fox1")!;
    expect(fox.realName).toBe("Ann Fox");
    expect(fox.teamId).toBe(tc.json.created[0]);
    // A numeric SteamID cell (Excel rounds it) is reported, not imported.
    const numeric = Buffer.from(writeXlsx([{ name: "P", columns: [{ header: "Nickname", width: 9 }, { header: "SteamID64", width: 9 }], rows: [["num", "76561198000000999"]] }]));
    const fixed = readXlsx(numeric);
    expect(fixed[1]!.cells[1]!.type).toBe("s");
    expect((await call("POST", "/api/v1/import/players/preview", undefined, { data: Buffer.from("not a spreadsheet"), type: XLSX })).status).toBe(400);

    // Protected deletions.
    const tPrev = await call<{ records: { id: string; deletable: boolean; blockers: string[]; effects: string[] }[] }>("POST", "/api/v1/teams/delete-preview", { ids: [ids.lite, ids.nl, tc.json.created[1]] });
    const t = new Map(tPrev.json.records.map((r) => [r.id, r]));
    expect(t.get(ids.lite)!.deletable).toBe(false);
    expect(t.get(ids.lite)!.blockers[0]).toMatch(/^Used by 2 matches: LITE Esports vs Northern Lights/);
    expect(t.get(ids.lite)!.effects).toEqual(["Past roster entries of Malakai are removed from their history", "The logo file stays in the asset store (other records may use it)"]);
    expect(t.get(ids.nl)!.blockers.join(" ")).toMatch(/6 assigned players: Malakai/);
    expect(t.get(tc.json.created[1]!)!.deletable).toBe(true);
    const refused = await call<{ error: string; message: string }>("POST", "/api/v1/teams/delete", { ids: [ids.lite, tc.json.created[1]] });
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/Not deleted: LITE Esports \(Used by 2 matches.*Archive it instead/);
    expect((await call("GET", `/api/v1/teams/${tc.json.created[1]}`)).status).toBe(200);
    expect((await call("POST", "/api/v1/teams/delete", { ids: [tc.json.created[1]] })).json).toEqual({ deleted: [tc.json.created[1]] });
    expect((await call("GET", `/api/v1/teams/${tc.json.created[1]}`)).status).toBe(404);

    const pPrev = await call<{ records: { deletable: boolean; blockers: string[] }[] }>("POST", "/api/v1/players/delete-preview", { ids: [ids.malakai] });
    expect(pPrev.json.records[0]!.blockers.join(" ")).toMatch(/On the roster of 1 played match: LITE Esports vs Northern Lights/);
    expect((await call("POST", `/api/v1/players/${ids.malakai}/archive`, { archived: true })).json).toEqual({ archived: true });
    expect((await call<unknown[]>("GET", "/api/v1/players?archived=1")).json.length).toBeGreaterThan((await call<unknown[]>("GET", "/api/v1/players")).json.length);
    await call("POST", `/api/v1/players/${ids.malakai}/archive`, { archived: false });

    const ev = (await call("POST", "/api/v1/events", { name: "Cup" })).json.id;
    ids.match3 = (await call("POST", "/api/v1/matches", { teamAId: ids.lite, teamBId: ids.nl, eventId: ev })).json.id;
    expect((await call("POST", "/api/v1/stages", { eventId: ev, name: "Playoffs", kind: "single_elimination", bracket: [{ id: "f", round: 1, slot: 1, matchId: ids.match3 }] })).status).toBe(200);
    const mPrev = await call<{ records: { id: string; deletable: boolean; blockers: string[]; effects: string[] }[] }>("POST", "/api/v1/matches/delete-preview", { ids: [ids.match, ids.match2, ids.match3] });
    const m = new Map(mPrev.json.records.map((r) => [r.id, r]));
    expect(m.get(ids.match2)!.blockers).toEqual(["It is the active match for the HUDs. Make another match active first"]);
    expect(m.get(ids.match3)!.blockers).toEqual(["Placed in the bracket of Playoffs"]);
    expect(m.get(ids.match)!.deletable).toBe(true);
    expect(m.get(ids.match)!.effects[0]).toBe("3 maps (1 with results) are deleted with it");
    expect((await call("POST", `/api/v1/matches/${ids.match2}/archive`, { archived: true })).status).toBe(409);
    expect((await call("POST", "/api/v1/matches/delete", { ids: [ids.match2] })).status).toBe(409);
    expect((await call("POST", "/api/v1/matches/delete", { ids: [ids.match] })).status).toBe(200);
    expect(ctx.engine.mapInstances.forMatch(ids.match)).toEqual([]);
    // With the played match gone he is still protected: he plays for a team in the active match.
    const pAfter = await call<{ records: { deletable: boolean; blockers: string[] }[] }>("POST", "/api/v1/players/delete-preview", { ids: [ids.malakai] });
    expect(pAfter.json.records[0]!.blockers).toEqual(["Plays for a team in the active match (Northern Lights vs LITE Esports)"]);
  });

  it("the default player picture (Settings): set from an upload, used for players without their own, cleared", async () => {
    expect((await call("GET", "/api/v1/default-player-picture")).json).toEqual({ assetId: null, url: null });
    expect((await call("PUT", "/api/v1/default-player-picture", {})).status).toBe(400);
    const up = await call<{ stagedId: string }>("POST", "/api/v1/uploads/images", undefined, { data: makePng(240, 240), type: "image/png" });
    const set = await call<{ assetId: string; url: string }>("PUT", "/api/v1/default-player-picture", { stagedId: up.json.stagedId });
    expect(set.status).toBe(200);
    expect(set.json.url).toBe(`/assets/${set.json.assetId}`);
    expect(staging()).toEqual([]);
    expect((await call("GET", set.json.url)).status).toBe(200);
    // MatchFrame HUDs: the default for a side with no HUD images side pictures; those come first when set.
    const fallback = (side: "CT" | "T") => (ctx.engine as unknown as { fallbackPlayerPicture(s: "CT" | "T"): string | null }).fallbackPlayerPicture(side);
    expect(fallback("CT")).toBe(set.json.url);
    const art = ctx.engine.hudArtSetting();
    ctx.engine.setHudArt({ ...art, defaultPlayers: { ct: [set.json.assetId], t: [] } });
    expect(fallback("CT")).toBeNull();
    expect(fallback("T")).toBe(set.json.url);
    ctx.engine.setHudArt(art);
    const cleared = await call("PUT", "/api/v1/default-player-picture", { clear: true });
    expect(cleared.json).toEqual({ assetId: null, url: null });
    expect(fallback("CT")).toBeNull();
  });

  it("7: after a restart on the same data folder, records and uploaded assets are still there", async () => {
    await ctx.servers.close();
    await ctx.engine.shutdown();
    ctx = await boot(dataDir);
    const team = (await call<{ id: string; name: string; logoAssetId: string; playerCount: number }[]>("GET", "/api/v1/teams")).json.find((x) => x.id === ids.lite)!;
    expect(team).toMatchObject({ name: "LITE Esports", countryCode: "AU" });
    expect((await call("GET", `/assets/${team.logoAssetId}`)).status).toBe(200);
    const p = (await call("GET", `/api/v1/players/${ids.malakai}`)).json;
    expect(p).toMatchObject({ displayName: "Malakai", firstName: "Kai", lastName: "Brown", steamId: MALAKAI_STEAM, teamId: ids.nl });
    const m2 = (await call("GET", `/api/v1/matches/${ids.match2}`)).json;
    expect(m2).toMatchObject({ active: true, teamAId: ids.nl });
  });
});
