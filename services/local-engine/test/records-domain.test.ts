import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { MapInstance, Match, VetoEntry } from "@matchframe/contracts";
import { countryFromInput, planMaps, startingCtTeam, steamId64Problem, validateSeriesScore, validateVetoEntries, vetoComplete } from "@matchframe/contracts";
import { Database } from "../src/db/database.ts";
import { MIGRATIONS } from "../src/db/migrations.ts";
import { ImageCheckError, inspectImage } from "../src/domain/image-check.ts";
import { normalizePlayerNames, playerNames, splitRealName } from "../src/domain/players.ts";
import { seriesTotals } from "../src/domain/series.ts";
import { StagedUploads } from "../src/domain/staged-uploads.ts";
import { deriveMapInstances, effectiveVetoEntries, hudVetoList, PlayedMapError, vetoEntriesFromDecisions } from "../src/domain/veto-entries.ts";
import { readXlsx, writeXlsx } from "../src/domain/xlsx.ts";
import { makeJpegHeader, makePng, makeWebpHeader } from "./helpers/images.ts";

const A = "team_a";
const B = "team_b";
const POOL = ["de_ancient", "de_anubis", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_train"];
const e = (type: VetoEntry["type"], teamId: string | null, mapName: string, sideChoice: VetoEntry["sideChoice"] = null, reversedSides = false): VetoEntry => ({ id: `${type}-${mapName}`, type, teamId, mapName, sideChoice, reversedSides });
/** A full BO3 veto: two bans, two picks with side choices, two bans, the decider. */
const BO3: VetoEntry[] = [e("ban", A, "de_train"), e("ban", B, "de_dust2"), e("pick", A, "de_mirage", "CT"), e("pick", B, "de_inferno", "T", true), e("ban", A, "de_nuke"), e("ban", B, "de_ancient"), e("decider", null, "de_anubis", "CT")];
const match = (over: Partial<Match> = {}): Match => ({ id: "m1", eventId: null, stageId: null, teamAId: A, teamBId: B, format: { bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, status: "scheduled", scheduledAt: null, seriesScoreA: 0, seriesScoreB: 0, mapPool: POOL, vetoSequenceId: null, title: null, ...over });
const map = (order: number, mapName: string, over: Partial<MapInstance> = {}): MapInstance => ({ id: `map${order}`, matchId: "m1", order, mapName, pickedByTeamId: null, isDecider: false, startingCtTeamId: null, status: "upcoming", scoreA: 0, scoreB: 0, winnerTeamId: null, mapRevision: null, ...over });

describe("veto entries", () => {
  it("accepts a complete BO3 veto and an incomplete one (a fixture prepared in advance)", () => {
    expect(validateVetoEntries(BO3, { teamAId: A, teamBId: B, bestOf: 3, pool: POOL })).toEqual([]);
    expect(vetoComplete(BO3, 3)).toBe(true);
    const partial = BO3.slice(0, 3);
    expect(validateVetoEntries(partial, { teamAId: A, teamBId: B, bestOf: 3, pool: POOL })).toEqual([]);
    expect(vetoComplete(partial, 3)).toBe(false);
  });

  it("refuses repeated maps, maps outside the pool, a decider with a team, entries after the decider and too many maps", () => {
    const ctx = { teamAId: A, teamBId: B, bestOf: 3, pool: POOL };
    const msgs = (v: VetoEntry[]) => validateVetoEntries(v, ctx).map((i) => i.message);
    expect(msgs([e("ban", A, "de_mirage"), e("pick", B, "de_mirage")])).toEqual(["Entry 2: de_mirage is already used in entry 1"]);
    expect(msgs([e("ban", A, "de_cache")])).toEqual(["Entry 1: de_cache is not in the map pool"]);
    expect(msgs([e("pick", A, "de_mirage"), e("pick", B, "de_nuke"), e("decider", A, "de_anubis")])).toEqual(["Entry 3: a decider has no team"]);
    expect(msgs([e("pick", A, "de_mirage"), e("pick", B, "de_nuke"), e("decider", null, "de_anubis"), e("ban", A, "de_train")])).toEqual(["Entry 4: nothing can follow the decider"]);
    expect(msgs([e("pick", A, "de_mirage"), e("decider", null, "de_anubis")])).toEqual(["The decider ends the veto: BO3 needs 2 picks before it (this veto has 1)"]);
    expect(msgs([e("pick", A, "de_mirage"), e("pick", B, "de_nuke"), e("pick", A, "de_anubis"), e("pick", B, "de_inferno")])).toEqual(["BO3 plays 3 maps; this veto has 4"]);
    expect(msgs([e("ban", null, "de_train")])).toEqual(["Entry 1: choose the team that bans this map"]);
    expect(msgs([e("ban", "team_x", "de_train")])).toEqual(["Entry 1: the team is not one of this match's teams"]);
  });

  it("derives the maps in order with picker, decider and the starting CT team (side choice and reversed sides)", () => {
    const plan = planMaps(BO3, A, B);
    expect(plan.map((p) => [p.order, p.mapName, p.pickedByTeamId, p.isDecider])).toEqual([
      [1, "de_mirage", A, false],
      [2, "de_inferno", B, false],
      [3, "de_anubis", null, true],
    ]);
    // Mirage: A picked, B chose CT → B starts CT. Inferno: B picked, A chose T → B starts CT, reversed → A.
    // Decider: B made the last ban, so A chose CT.
    expect(plan.map((p) => p.startingCtTeamId)).toEqual([B, A, A]);
    expect(startingCtTeam([e("pick", A, "de_mirage")], 0, A, B)).toBeNull();
  });

  it("keeps a map's id, status and round score when it stays in place, and never replaces or removes a played map", () => {
    const existing = [map(1, "de_mirage", { status: "completed", scoreA: 13, scoreB: 7, winnerTeamId: A }), map(2, "de_nuke")];
    const { maps, removed } = deriveMapInstances(match(), BO3, existing);
    expect(maps[0]).toMatchObject({ id: "map1", status: "completed", scoreA: 13, scoreB: 7, pickedByTeamId: A, startingCtTeamId: B });
    expect(maps[1]!.id).not.toBe("map2");
    expect(maps[1]).toMatchObject({ mapName: "de_inferno", status: "upcoming", scoreA: 0 });
    expect(removed.map((m) => m.id)).toEqual(["map2"]);
    const swapped = BO3.map((x) => (x.mapName === "de_mirage" ? { ...x, mapName: "de_cache" } : x));
    expect(() => deriveMapInstances(match(), swapped, existing)).toThrow(PlayedMapError);
    expect(() => deriveMapInstances(match(), [], existing)).toThrow(/cannot remove it/);
  });

  it("turns captain decisions into entries (side choice by the picker stored as the opponent's side) and builds the HUD veto list", () => {
    const decisions = [
      { id: "1", matchId: "m1", stepOrder: 1, kind: "ban", teamId: A, mapName: "de_train", side: null, decidedBy: "c", decidedAt: "", revisionOf: null },
      { id: "2", matchId: "m1", stepOrder: 2, kind: "pick", teamId: B, mapName: "de_nuke", side: null, decidedBy: "c", decidedAt: "", revisionOf: null },
      { id: "3", matchId: "m1", stepOrder: 3, kind: "side_choice", teamId: A, mapName: null, side: "T", decidedBy: "c", decidedAt: "", revisionOf: null },
      { id: "4", matchId: "m1", stepOrder: 4, kind: "pick", teamId: A, mapName: "de_mirage", side: null, decidedBy: "c", decidedAt: "", revisionOf: null },
      { id: "5", matchId: "m1", stepOrder: 5, kind: "side_choice", teamId: A, mapName: null, side: "CT", decidedBy: "c", decidedAt: "", revisionOf: null },
    ] as const;
    const entries = vetoEntriesFromDecisions(match(), [...decisions]);
    expect(entries.map((x) => [x.type, x.teamId, x.mapName, x.sideChoice])).toEqual([
      ["ban", A, "de_train", null],
      ["pick", B, "de_nuke", "T"],
      ["pick", A, "de_mirage", "T"],
    ]);
    const m = match();
    const maps = [map(1, "de_nuke", { status: "completed", scoreA: 13, scoreB: 9, winnerTeamId: A })];
    expect(effectiveVetoEntries(m, [...decisions], maps).source).toBe("captain");
    expect(effectiveVetoEntries({ ...m, veto: BO3 }, [...decisions], maps).source).toBe("match");
    expect(effectiveVetoEntries(m, [], maps)).toMatchObject({ source: "maps", entries: [{ type: "decider", mapName: "de_nuke" }] });
    const hud = hudVetoList({ ...m, veto: BO3 }, [], [map(1, "de_mirage", { status: "completed", scoreA: 13, scoreB: 11, winnerTeamId: A }), map(2, "de_inferno", { status: "live", scoreA: 3, scoreB: 2 })]);
    expect(hud[0]).toEqual({ teamId: A, mapName: "de_train", side: "NO", type: "ban", reverseSide: false, mapEnd: false });
    expect(hud[2]).toEqual({ teamId: A, mapName: "de_mirage", side: "CT", type: "pick", reverseSide: false, mapEnd: true, winner: A, score: { [A]: 13, [B]: 11 } });
    expect(hud[3]).toMatchObject({ mapName: "de_inferno", side: "T", reverseSide: true, mapEnd: false, score: { [A]: 3, [B]: 2 } });
    expect(hud[6]).toMatchObject({ teamId: "", type: "decider", side: "CT", mapEnd: false });
  });

  it("checks series scores against the format and adds the manual correction to the maps won once", () => {
    expect(validateSeriesScore(2, 1, 3)).toBeNull();
    expect(validateSeriesScore(3, 0, 3)).toMatch(/2 maps; 3 is too many/);
    expect(validateSeriesScore(2, 1, 2)).toMatch(/BO2 has 2 maps; 2–1 adds up to 3/);
    expect(validateSeriesScore(2, 2, 3)).toMatch(/Both teams/);
    const maps = [map(1, "de_mirage", { status: "completed", winnerTeamId: A }), map(2, "de_nuke", { status: "live", winnerTeamId: null })];
    expect(seriesTotals(match({ seriesCorrectionB: 1 }), maps)).toMatchObject({ a: 1, b: 1, fromMapsA: 1, fromMapsB: 0, winnerTeamId: null });
    expect(seriesTotals(match({ seriesCorrectionA: 1 }), maps)).toMatchObject({ a: 2, winnerTeamId: A });
  });
});

describe("players", () => {
  it("splits real names on the first space and derives realName", () => {
    expect(splitRealName("Kai Brown")).toEqual({ firstName: "Kai", lastName: "Brown" });
    expect(splitRealName("Jean Luc Picard")).toEqual({ firstName: "Jean", lastName: "Luc Picard" });
    expect(splitRealName("Kai")).toEqual({ firstName: "Kai", lastName: null });
    expect(playerNames({ firstName: null, lastName: null, realName: "Kai Brown" })).toEqual({ firstName: "Kai", lastName: "Brown" });
    expect(normalizePlayerNames({ displayName: "Malakai", firstName: " Kai ", lastName: "Brown" })).toMatchObject({ firstName: "Kai", lastName: "Brown", realName: "Kai Brown" });
    expect(normalizePlayerNames({ realName: "Kai Brown" })).toMatchObject({ firstName: "Kai", lastName: "Brown", realName: "Kai Brown" });
    // A nickname-only change leaves the names alone.
    expect(normalizePlayerNames({ displayName: "Mal" }, { firstName: "Kai", lastName: "Brown", realName: "Kai Brown" })).toEqual({ displayName: "Mal" });
  });

  it("migration 5 splits existing real names into first and last names", () => {
    const db = new Database(":memory:");
    db.migrate();
    const put = (id: string, data: object) => db.run("INSERT INTO documents (kind, id, data, revision, archived, created_at, updated_at) VALUES ('player', ?, ?, 1, 0, 'x', 'x')", id, JSON.stringify({ id, ...data }));
    put("p1", { displayName: "Malakai", realName: "Kai Brown" });
    put("p2", { displayName: "solo", realName: "Prince" });
    put("p3", { displayName: "none", realName: null });
    put("p4", { displayName: "kept", realName: "A B", firstName: "Alpha", lastName: "Beta" });
    db.db.exec(MIGRATIONS.find((m) => m.version === 5)!.sql);
    const get = (id: string) => JSON.parse(db.get<{ data: string }>("SELECT data FROM documents WHERE id = ?", id)!.data);
    expect(get("p1")).toMatchObject({ firstName: "Kai", lastName: "Brown", realName: "Kai Brown" });
    expect(get("p2")).toMatchObject({ firstName: "Prince", lastName: null });
    expect(get("p3").firstName).toBeUndefined();
    expect(get("p4")).toMatchObject({ firstName: "Alpha", lastName: "Beta" });
  });

  it("checks SteamID64 format with clear messages", () => {
    expect(steamId64Problem("76561198000000001")).toBeNull();
    expect(steamId64Problem("7656119800000000")).toMatch(/17 digits; this one has 16/);
    expect(steamId64Problem("12345678901234567")).toMatch(/starts with 7656119/);
    expect(steamId64Problem("STEAM_0:1:1234")).toMatch(/not accepted/);
  });

  it("reads countries from codes and English names", () => {
    expect(countryFromInput("au")).toBe("AU");
    expect(countryFromInput("Australia")).toBe("AU");
    expect(countryFromInput("UK")).toBe("GB");
    expect(countryFromInput("Atlantis")).toBeNull();
  });
});

describe("uploaded images", () => {
  it("reads the real size of PNG, JPEG and WebP files", () => {
    expect(inspectImage(makePng(256, 200))).toMatchObject({ type: "png", ext: ".png", width: 256, height: 200 });
    expect(inspectImage(makeJpegHeader(640, 480))).toMatchObject({ type: "jpeg", ext: ".jpg", width: 640, height: 480 });
    expect(inspectImage(makeWebpHeader(300, 150))).toMatchObject({ type: "webp", ext: ".webp", width: 300, height: 150 });
  });

  it("refuses other files, damaged or cut-off images and files over 2 MB with readable errors", () => {
    const err = (b: Buffer) => {
      try {
        inspectImage(b);
        return null;
      } catch (x) {
        return x instanceof ImageCheckError ? x.message : String(x);
      }
    };
    expect(err(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatch(/not a PNG, JPEG or WebP.*SVG is not accepted/);
    expect(err(Buffer.from("GIF89a....................................."))).toMatch(/GIF is not accepted/);
    const png = makePng(64, 64);
    expect(err(png.subarray(0, png.length - 20))).toMatch(/cut off/);
    const bad = Buffer.from(png);
    bad[20] = bad[20]! ^ 0xff;
    expect(err(bad)).toMatch(/damaged/);
    expect(err(Buffer.concat([makePng(8, 8), Buffer.alloc(2 * 1024 * 1024)]))).toMatch(/limit is 2 MB/);
    expect(err(Buffer.alloc(0))).toMatch(/empty/);
  });

  it("stages, reads, discards and sweeps editor uploads", () => {
    const dir = mkdtempSync(join(tmpdir(), "mf-staged-"));
    let now = Date.now();
    const s = new StagedUploads(join(dir, "staging"), () => now);
    const a = s.stage(makePng(220, 220));
    expect(a.previewUrl).toBe(`/assets/staged/${a.stagedId}.png`);
    expect(s.read(a.stagedId).ext).toBe(".png");
    const b = s.stage(makePng(220, 220));
    expect(s.discard(a.stagedId)).toBe(true);
    expect(s.find(a.stagedId)).toBeNull();
    expect(() => s.read(a.stagedId)).toThrow(/no longer available/);
    expect(s.find("../../etc/passwd")).toBeNull();
    // Old files go at the next sweep; recent ones stay.
    const old = join(dir, "staging", `${b.stagedId}.png`);
    utimesSync(old, new Date(now - 7 * 3600_000), new Date(now - 7 * 3600_000));
    writeFileSync(join(dir, "staging", "stg_00000000000000000000000000000000.png"), "x");
    now += 1000;
    expect(s.sweep()).toBe(1);
    expect(readdirSync(join(dir, "staging"))).toEqual(["stg_00000000000000000000000000000000.png"]);
  });
});

describe("xlsx", () => {
  it("writes templates that read back, with Text columns", () => {
    const buf = writeXlsx([{ name: "Players", columns: [{ header: "Nickname", width: 20 }, { header: "SteamID64", width: 22, text: true }], rows: [["Malakai", "76561198000000001"]] }]);
    const rows = readXlsx(buf);
    expect(rows.map((r) => r.cells.map((c) => c.text))).toEqual([
      ["Nickname", "SteamID64"],
      ["Malakai", "76561198000000001"],
    ]);
  });

  it("reads shared strings, numbers and gaps as Excel stores them, and refuses non-xlsx files", () => {
    const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      <row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>7.6561198000000003E+16</v></c></row></sheetData></worksheet>`;
    const shared = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Nickname</t></si><si><r><t>Steam</t></r><r><t>ID64</t></r></si><si><t xml:space="preserve">Kai &amp; co</t><rPh><t>x</t></rPh></si></sst>`;
    const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId7"/></sheets></workbook>`;
    const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="worksheet" Target="worksheets/data.xml"/></Relationships>`;
    const buf = Buffer.from(zipSync({ "xl/workbook.xml": strToU8(wb), "xl/_rels/workbook.xml.rels": strToU8(rels), "xl/sharedStrings.xml": strToU8(shared), "xl/worksheets/data.xml": strToU8(sheet) }));
    const rows = readXlsx(buf);
    expect(rows.map((r) => r.row)).toEqual([1, 3]);
    expect(rows[0]!.cells.map((c) => c.text)).toEqual(["Nickname", "", "SteamID64"]);
    expect(rows[1]!.cells[0]).toEqual({ text: "Kai & co", type: "s" });
    expect(rows[1]!.cells[2]).toEqual({ text: "7.6561198000000003E+16", type: "n" });
    expect(() => readXlsx(Buffer.from("Nickname,SteamID64\n"))).toThrow(/not an .xlsx file/);
  });
});
