import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SyncItem, SyncKind } from "@matchframe/cloud-contracts";
import { EventRecord, EventStage, Match, Player, Team } from "@matchframe/contracts";
import { canonicalJson, contentHash, fillGaps, GONE, NEVER, SyncLocal } from "../src/cloud/sync-local.ts";
import { Database } from "../src/db/database.ts";
import { DocumentRepo, MapInstanceRepo, RosterRepo, SettingsRepo, SteamIndexRepo, VetoRepo } from "../src/db/store.ts";

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";
const NOVA = "76561198000000001";

function setup() {
  const db = new Database(":memory:");
  db.migrate();
  const settings = new SettingsRepo(db);
  const repos = {
    db,
    settings,
    teams: new DocumentRepo(db, "team", Team),
    players: new DocumentRepo(db, "player", Player),
    events: new DocumentRepo(db, "event", EventRecord),
    matches: new DocumentRepo(db, "match", Match),
    stages: new DocumentRepo(db, "event_stage", EventStage),
    steamIndex: new SteamIndexRepo(db),
    roster: new RosterRepo(db),
    maps: new MapInstanceRepo(db),
    veto: new VetoRepo(db),
    assetsDir: mkdtempSync(join(tmpdir(), "mf-sync-assets-")),
  };
  const local = new SyncLocal({ ...repos, huds: null });
  const scan = async () => local.scan(await local.collect());
  const pending = () => local.pendingRows(() => 0).map((r) => `${r.kind}:${r.id}:${r.pending === GONE ? "deleted" : "changed"}`);
  return { ...repos, local, scan, pending };
}

let seq = 0;
const item = (kind: SyncKind, id: string, data: Record<string, unknown> | null, editedAt = PAST, blobs: string[] = []): SyncItem => ({ kind, id, data, blobs, seq: ++seq, editedAt, deviceId: "dev_other", deviceName: "Other PC" });
/** The organisation accepted what is here now (as after a push). */
const shared = (s: ReturnType<typeof setup>, kind: SyncKind, id: string) => {
  const it = s.local.current(kind, id)!;
  s.local.recordApplied(kind, id, it.hash, item(kind, id, it.data), null);
};

describe("account sync: hashing", () => {
  it("hashes records the same whatever their key order, and a deletion as '-'", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash(null)).toBe(GONE);
  });

  it("fills only what the organisation left empty, and joins a player's names", () => {
    expect(fillGaps({ id: "o", displayName: "nova", realName: null, aliases: ["nv"], countryCode: "SE", archived: false }, { id: "l", displayName: "Nova", realName: "Nova R", aliases: ["n0va"], countryCode: "DE", archived: true })).toEqual({
      id: "o",
      displayName: "nova",
      realName: "Nova R",
      aliases: ["nv", "n0va", "Nova"],
      countryCode: "SE",
      archived: false,
    });
  });
});

describe("account sync: local changes", () => {
  it("notes new, changed and deleted records, and forgets a change that was undone", async () => {
    const s = setup();
    const t = s.teams.create({ name: "Alpha", shortName: "ALP" }, "team");
    const p = s.players.create({ displayName: "nova", steamId: NOVA }, "player");
    s.roster.join(t.id, p.id);
    await s.scan();
    expect(s.pending().sort()).toEqual([`player:${p.id}:changed`, `roster:${s.roster.forTeam(t.id)[0]!.id}:changed`, `team:${t.id}:changed`].sort());
    // New records carry their own edit time where known (documents), none for the rest.
    expect(s.local.state("team", t.id)).toMatchObject({ hash: NEVER, pending_at: s.teams.get(t.id)!.updatedAt });
    expect(s.local.state("roster", s.roster.forTeam(t.id)[0]!.id)!.pending_at).toBeNull();

    for (const [kind, id] of [["team", t.id], ["player", p.id], ["roster", s.roster.forTeam(t.id)[0]!.id]] as const) shared(s, kind, id);
    await s.scan();
    expect(s.pending()).toEqual([]);

    s.teams.update(t.id, { name: "Alpha Esports" });
    await s.scan();
    expect(s.pending()).toEqual([`team:${t.id}:changed`]);
    s.teams.update(t.id, { name: "Alpha" });
    await s.scan();
    expect(s.pending()).toEqual([]);

    // Archiving is part of the record.
    s.teams.archive(t.id, true);
    await s.scan();
    expect(s.pending()).toEqual([`team:${t.id}:changed`]);
    expect(s.local.current("team", t.id)!.data.archived).toBe(true);

    s.teams.delete(t.id);
    await s.scan();
    expect(s.pending()).toEqual([`team:${t.id}:deleted`]);

    // A record never shared that is deleted again leaves nothing to send.
    const e = s.events.create({ name: "Cup" }, "event");
    await s.scan();
    expect(s.pending()).toContain(`event:${e.id}:changed`);
    s.events.delete(e.id);
    await s.scan();
    expect(s.pending().some((x) => x.startsWith("event:"))).toBe(false);
    expect(s.local.state("event", e.id)).toBeUndefined();
  });

  it("shares the logos and photos records use (with the file's hash), not other files", async () => {
    const s = setup();
    const bytes = Buffer.from("logo-bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const id = `${sha.slice(0, 24)}.png`;
    writeFileSync(join(s.assetsDir, id), bytes);
    writeFileSync(join(s.assetsDir, `${"0".repeat(24)}.png`), "unused");
    s.teams.create({ name: "Alpha", shortName: "ALP", logoAssetId: id }, "team");
    const items = await s.local.collect();
    expect(items.get(`asset:${id}`)?.data).toEqual({ ext: ".png", sha256: sha });
    expect([...items.keys()].filter((k) => k.startsWith("asset:"))).toEqual([`asset:${id}`]);
  });

  it("puts deletions first, then files before the records that use them; refused changes wait until they change", async () => {
    const s = setup();
    const gone = s.events.create({ name: "Old" }, "event");
    await s.scan();
    shared(s, "event", gone.id);
    s.events.delete(gone.id);
    const bytes = Buffer.from("x");
    const id = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}.png`;
    writeFileSync(join(s.assetsDir, id), bytes);
    const t = s.teams.create({ name: "Alpha", shortName: "ALP", logoAssetId: id }, "team");
    await s.scan();
    expect(s.pending()).toEqual([`event:${gone.id}:deleted`, `asset:${id}:changed`, `team:${t.id}:changed`]);
    s.local.recordRejected("team", t.id, s.local.state("team", t.id)!.pending!, "too_large");
    expect(s.local.pendingRows(() => 60_000).map((r) => r.id)).not.toContain(t.id);
    expect(s.local.pendingRows(() => 0).map((r) => r.id)).toContain(t.id);
    expect(s.local.rejected()).toEqual([expect.objectContaining({ kind: "team", id: t.id, reason: "too_large" })]);
    s.teams.update(t.id, { shortName: "AL" });
    await s.scan();
    expect(s.local.pendingRows(() => 60_000).map((r) => r.id)).toContain(t.id);
  });
});

describe("account sync: applying the organisation's changes", () => {
  it("applies every kind, updates the SteamID index, and does not send any of it back", async () => {
    const s = setup();
    const bytes = Buffer.from("png-bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const logo = `${sha.slice(0, 24)}.png`;
    const items = [
      item("asset", logo, { ext: ".png", sha256: sha }, PAST, [sha]),
      item("team", "team_a", { id: "team_a", name: "Alpha", shortName: "ALP", logoAssetId: logo, archived: false }),
      item("team", "team_b", { id: "team_b", name: "Bravo", shortName: "BRV", archived: true }),
      item("player", "player_n", { id: "player_n", displayName: "nova", steamId: NOVA, archived: false }),
      item("roster", "mem_1", { teamId: "team_a", playerId: "player_n", role: "player", validFrom: PAST, validTo: null }),
      item("event", "event_1", { id: "event_1", name: "Cup", logoAssetId: logo, archived: false }),
      item("match", "match_1", { id: "match_1", eventId: "event_1", teamAId: "team_a", teamBId: "team_b", format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, status: "scheduled", archived: false, vetoSteps: [{ order: 1, kind: "ban", actor: "A" }] }),
      item("map", "map_1", { id: "map_1", matchId: "match_1", order: 1, mapName: "de_mirage", pickedByTeamId: null, startingCtTeamId: null, status: "upcoming" }),
      item("veto", "veto_1", { id: "veto_1", matchId: "match_1", stepOrder: 1, kind: "ban", teamId: "team_a", mapName: "de_nuke", side: null, decidedBy: "op", decidedAt: PAST, supersededBy: null, createdAt: PAST }),
    ];
    for (const it of items) {
      expect(s.local.decide(it).action).toBe("apply");
      s.local.apply(it, new Map([[sha, bytes]]));
    }
    expect(readFileSync(join(s.assetsDir, logo))).toEqual(bytes);
    expect(s.teams.get("team_a")!.data).toMatchObject({ name: "Alpha", logoAssetId: logo });
    expect(s.teams.get("team_b")!.archived).toBe(true);
    expect(s.steamIndex.lookup(NOVA)).toBe("player_n");
    expect(s.roster.forTeam("team_a").map((m) => m.playerId)).toEqual(["player_n"]);
    expect(s.matches.get("match_1")!.data.teamAId).toBe("team_a");
    expect(s.settings.get("veto.steps.match_1", null)).toEqual([{ order: 1, kind: "ban", actor: "A" }]);
    expect(s.maps.forMatch("match_1").map((m) => m.mapName)).toEqual(["de_mirage"]);
    expect(s.veto.active("match_1").map((d) => d.mapName)).toEqual(["de_nuke"]);

    // Echo: what was applied is the shared version, so nothing is sent back.
    await s.scan();
    expect(s.pending()).toEqual([]);
    expect(s.local.counts()).toMatchObject({ asset: 1, team: 2, player: 1, roster: 1, event: 1, match: 1, map: 1, veto: 1 });
    // The same item again (or older) is skipped.
    expect(s.local.decide({ ...items[1]!, seq: items[1]!.seq }).action).toBe("skip");

    // A player's new SteamID replaces the old one in the index.
    s.local.apply(item("player", "player_n", { id: "player_n", displayName: "nova", steamId: "76561198000000009", archived: false }));
    expect(s.steamIndex.lookup(NOVA)).toBeNull();
    expect(s.steamIndex.lookup("76561198000000009")).toBe("player_n");

    // Deletions: the record goes (and its SteamID); an asset's file stays (other records here may use it).
    s.local.apply(item("player", "player_n", null));
    s.local.apply(item("map", "map_1", null));
    s.local.apply(item("asset", logo, null));
    expect(s.players.get("player_n")).toBeUndefined();
    expect(s.steamIndex.lookup("76561198000000009")).toBeNull();
    expect(s.maps.forMatch("match_1")).toEqual([]);
    expect(existsSync(join(s.assetsDir, logo))).toBe(true);
    expect(s.local.state("player", "player_n")!.hash).toBe(GONE);
    await s.scan();
    // The asset is still used by a team here: it is shared again.
    expect(s.pending()).toEqual([`asset:${logo}:changed`]);
  });

  it("replaces another map in the same place, and a revised veto step supersedes the earlier decision", () => {
    const s = setup();
    s.maps.upsert({ id: "map_local", matchId: "m", order: 1, mapName: "de_nuke", pickedByTeamId: null, isDecider: false, startingCtTeamId: null, status: "upcoming", scoreA: 0, scoreB: 0, winnerTeamId: null, mapRevision: null });
    s.local.apply(item("map", "map_org", { id: "map_org", matchId: "m", order: 1, mapName: "de_mirage", pickedByTeamId: null, startingCtTeamId: null, status: "upcoming" }));
    expect(s.maps.forMatch("m").map((m) => m.id)).toEqual(["map_org"]);
    s.veto.commit({ id: "v1", matchId: "m", stepOrder: 1, kind: "ban", teamId: null, mapName: "de_nuke", side: null, decidedBy: "op", decidedAt: PAST, revisionOf: null });
    s.local.apply(item("veto", "v2", { id: "v2", matchId: "m", stepOrder: 1, kind: "ban", teamId: null, mapName: "de_inferno", side: null, decidedBy: "op", decidedAt: PAST, revisionOf: "v1", supersededBy: null, createdAt: PAST }));
    expect(s.veto.active("m").map((d) => d.id)).toEqual(["v2"]);
    expect(s.veto.history("m").find((d) => d.id === "v1")!.supersededBy).toBe("v2");
  });

  it("last edit wins: a later edit here is kept (and sent next), an earlier one gives way", async () => {
    const s = setup();
    const t = s.teams.create({ name: "Alpha", shortName: "ALP" }, "team");
    await s.scan();
    shared(s, "team", t.id);
    s.teams.update(t.id, { name: "Alpha (here)" });
    await s.scan();

    const older = item("team", t.id, { id: t.id, name: "Alpha (older)", shortName: "ALP", archived: false }, PAST);
    const d = s.local.decide(older);
    expect(d.action).toBe("keep");
    if (d.action === "keep") s.local.keep(older, d.pending, d.pendingAt);
    expect(s.teams.get(t.id)!.data.name).toBe("Alpha (here)");
    // Sent next, based on the organisation's version it saw.
    expect(s.local.pendingRows(() => 0)[0]).toMatchObject({ id: t.id, seq: older.seq });

    const newer = item("team", t.id, { id: t.id, name: "Alpha (newer)", shortName: "ALP", archived: false }, FUTURE);
    expect(s.local.decide(newer).action).toBe("apply");
    s.local.apply(newer);
    expect(s.teams.get(t.id)!.data.name).toBe("Alpha (newer)");
    await s.scan();
    expect(s.pending()).toEqual([]);
  });

  it("does not overwrite an edit made here after the last comparison (while a page downloaded)", async () => {
    const s = setup();
    const t = s.teams.create({ name: "Alpha", shortName: "ALP" }, "team");
    await s.scan();
    shared(s, "team", t.id);
    s.teams.update(t.id, { name: "Alpha (just now)" });
    // No scan in between.
    const d = s.local.decide(item("team", t.id, { id: t.id, name: "Alpha (org)", shortName: "ALP", archived: false }, new Date(Date.now() - 1000).toISOString()));
    expect(d.action).toBe("keep");
  });

  it("an organisation record with the same id as a record never shared here: theirs wins unless this one was edited later", async () => {
    const s = setup();
    s.teams.create({ id: "team_same", name: "Alpha", shortName: "ALP" }, "team");
    s.roster.join("team_same", "player_x");
    const mem = s.roster.forTeam("team_same")[0]!;
    await s.scan();
    // Documents know their edit time; roster entries do not (so the organisation's counts as later).
    expect(s.local.decide(item("team", "team_same", { id: "team_same", name: "Alpha Org", shortName: "ALP", archived: false }, PAST)).action).toBe("keep");
    expect(s.local.decide(item("roster", mem.id, { teamId: "team_same", playerId: "player_x", role: "coach", validFrom: PAST, validTo: null }, PAST)).action).toBe("apply");
  });
});

describe("account sync: first sync of a computer with its own data", () => {
  function localData(s: ReturnType<typeof setup>) {
    const alpha = s.teams.create({ name: "Team Alpha", shortName: "TA", region: "EU" }, "team");
    const other = s.teams.create({ name: "Other", shortName: "OTH" }, "team");
    const nova = s.players.create({ displayName: "Nova", realName: "Nova R", steamId: NOVA }, "player");
    s.steamIndex.set(NOVA, nova.id);
    s.roster.join(alpha.id, nova.id);
    const match = s.matches.create({ eventId: null, teamAId: alpha.id, teamBId: other.id, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6 }, status: "scheduled" }, "match");
    s.maps.upsert({ id: "map_l", matchId: match.id, order: 1, mapName: "de_nuke", pickedByTeamId: alpha.id, isDecider: false, startingCtTeamId: alpha.id, status: "upcoming", scoreA: 0, scoreB: 0, winnerTeamId: null, mapRevision: null });
    s.veto.commit({ id: "veto_l", matchId: match.id, stepOrder: 1, kind: "ban", teamId: alpha.id, mapName: "de_inferno", side: null, decidedBy: "op", decidedAt: PAST, revisionOf: null });
    const stage = s.stages.create({ eventId: "event_x", name: "Groups", kind: "round_robin", teamIds: [alpha.id, other.id] }, "stage");
    s.settings.set("graphics.featuredTeam", alpha.id);
    return { alpha, other, nova, match, stage };
  }

  it("merges a player with the same SteamID and a team with the same name into the organisation's, rewriting every reference", async () => {
    const s = setup();
    const l = localData(s);
    await s.scan();
    // Organisation order: the player and the roster entry first, the team (edited later) last.
    s.local.apply(item("player", "player_org", { id: "player_org", displayName: "nova", steamId: NOVA, realName: null, archived: false }));
    s.local.apply(item("roster", "mem_org", { teamId: "team_org", playerId: "player_org", role: "player", validFrom: PAST, validTo: null }));
    s.local.apply(item("team", "team_org", { id: "team_org", name: "team alpha!", shortName: "ALPHA", region: null, archived: false }));

    expect(s.players.get(l.nova.id)).toBeUndefined();
    expect(s.teams.get(l.alpha.id)).toBeUndefined();
    expect(s.players.get("player_org")!.data).toMatchObject({ displayName: "nova", realName: "Nova R", aliases: ["Nova"] });
    expect(s.teams.get("team_org")!.data).toMatchObject({ name: "team alpha!", shortName: "ALPHA", region: "EU" });
    expect(s.steamIndex.lookup(NOVA)).toBe("player_org");
    expect(s.matches.get(l.match.id)!.data).toMatchObject({ teamAId: "team_org", teamBId: l.other.id });
    expect(s.maps.forMatch(l.match.id)[0]).toMatchObject({ pickedByTeamId: "team_org", startingCtTeamId: "team_org" });
    expect(s.veto.active(l.match.id)[0]!.teamId).toBe("team_org");
    expect(s.stages.get(l.stage.id)!.data.teamIds).toEqual(["team_org", l.other.id]);
    expect(s.settings.get("graphics.featuredTeam", null)).toBe("team_org");
    // The local roster entry became a copy of the organisation's: only the organisation's is kept.
    expect(s.roster.forTeam("team_org").map((m) => m.id)).toEqual(["mem_org"]);
    expect(s.local.state("player", l.nova.id)).toBeUndefined();
    expect(s.local.state("team", l.alpha.id)).toBeUndefined();

    await s.scan();
    const pending = s.pending();
    // What only this computer knew is sent back into the organisation's records; its own copies are not deleted there (never shared).
    expect(pending).toEqual(expect.arrayContaining(["team:team_org:changed", "player:player_org:changed", `match:${l.match.id}:changed`, `team:${l.other.id}:changed`, "map:map_l:changed", "veto:veto_l:changed"]));
    expect(pending.some((p) => p.includes(l.nova.id) || p.includes(l.alpha.id) || p.endsWith(":deleted"))).toBe(false);
    expect(s.local.merged).toBe(2);
  });

  it("does not merge records already shared, or players without a SteamID", async () => {
    const s = setup();
    const bravo = s.teams.create({ name: "Bravo", shortName: "BRV" }, "team");
    const anon = s.players.create({ displayName: "kite" }, "player");
    await s.scan();
    shared(s, "team", bravo.id);
    s.local.apply(item("team", "team_org_b", { id: "team_org_b", name: "BRAVO", shortName: "B", archived: false }));
    s.local.apply(item("player", "player_org_k", { id: "player_org_k", displayName: "kite", steamId: null, archived: false }));
    expect(s.teams.get(bravo.id)).toBeDefined();
    expect(s.teams.get("team_org_b")).toBeDefined();
    expect(s.players.get(anon.id)).toBeDefined();
    expect(s.local.merged).toBe(0);
  });
});
