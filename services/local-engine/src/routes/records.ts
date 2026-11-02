import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { MapInstance, Match, Player, Team } from "@matchframe/contracts";
import { countryFromInput, isCountryCode, MatchFormat, steamId64Problem, validateSeriesScore, validateVetoEntries, VetoEntry } from "@matchframe/contracts";
import { REQUESTED_MAP_TARGETS } from "@matchframe/map-runtime";
import type { Engine } from "../app.ts";
import { normalizePlayerNames, playerNames } from "../domain/players.ts";
import { seriesTotals } from "../domain/series.ts";
import { deriveMapInstances, effectiveVetoEntries, mapHasResult } from "../domain/veto-entries.ts";
import { readXlsx, writeXlsx, XLSX_MAX_BYTES } from "../domain/xlsx.ts";
import type { XlsxRow } from "../domain/xlsx.ts";
import { imageAdvice, IMAGE_MAX_BYTES } from "../domain/image-check.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { normalizeName, storeAsset } from "./domain.ts";

/**
 * Teams, players and matches as the console's list pages and editors use them: validated saves
 * with field-level errors, staged logo/avatar uploads promoted on save, per-field change checks
 * against concurrent edits, protected deletes and .xlsx imports.
 */

interface Issue {
  path: (string | number)[];
  message: string;
}

const invalid = (issues: Issue[]) => new HttpError(400, issues[0]?.message ?? "invalid", "invalid", issues);

const stable = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * Per-field preconditions: a changed field conflicts when the stored value is neither what the
 * editor loaded nor what it now sends (someone else changed it meanwhile). Other fields merge.
 */
export function fieldConflicts(current: Record<string, unknown>, changes: Record<string, unknown>, expected: Record<string, unknown>, label: (field: string) => string): Issue[] {
  const out: Issue[] = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in expected)) continue;
    if (same(current[k], expected[k]) || same(current[k], v)) continue;
    out.push({ path: [k], message: `${label(k)} was changed elsewhere while you were editing` });
  }
  return out;
}

const conflict = (issues: Issue[]) =>
  new HttpError(409, `${issues.map((i) => i.message.replace(/ was changed elsewhere.*$/, "")).join(", ")} changed elsewhere while you were editing. Reload to see the current values, or keep yours and save again after reloading.`, "field_conflict", issues);

const FieldPatch = z.object({
  changes: z.record(z.string(), z.unknown()),
  expected: z.record(z.string(), z.unknown()).default({}),
  logoStagedId: z.string().optional(),
  avatarStagedId: z.string().optional(),
});
type FieldPatch = z.infer<typeof FieldPatch>;

const TEAM_LABEL: Record<string, string> = { name: "Team name", shortName: "Short name", countryCode: "Country", logoAssetId: "Logo", primaryColor: "Primary colour", secondaryColor: "Secondary colour", region: "Region", sponsorMetadata: "Extra fields" };
const PLAYER_LABEL: Record<string, string> = { displayName: "Nickname", firstName: "First name", lastName: "Last name", countryCode: "Country", steamId: "SteamID64", teamId: "Team", avatarAssetId: "Avatar", aliases: "Aliases", photoVisible: "Photo on air", cameraConsent: "Camera consent", cameraSourceId: "Camera source", role: "Role" };
const MATCH_LABEL: Record<string, string> = { teamAId: "Team 1", teamBId: "Team 2", format: "Format", scheduledAt: "Date and time", eventId: "Tournament", stageId: "Stage", title: "Title", mapPool: "Map pool", veto: "Map veto", seriesScoreA: "Team 1 series score", seriesScoreB: "Team 2 series score", status: "Status" };

/** A short name from a team name: the initials of several words, or the first four letters of one. */
export function shortNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const s = words.length > 1 ? words.map((w) => w[0]).join("").slice(0, 4) : (words[0] ?? "").slice(0, 4);
  return s.toUpperCase();
}

/** The app's configured CS2 map pool (the event pool of the map registry), with display names. */
export function appMapPool(): { mapName: string; displayName: string }[] {
  return REQUESTED_MAP_TARGETS.filter((t) => t.inEventPool).map((t) => ({ mapName: t.mapName, displayName: t.displayName }));
}

/** Match groups for the list's tabs (independent of which match is active for the HUD). */
export function matchGroup(match: Pick<Match, "status">, maps: readonly MapInstance[]): "ended" | "current" | "future" {
  if (match.status === "completed" || match.status === "cancelled") return "ended";
  if (match.status === "veto" || match.status === "live" || maps.some(mapHasResult)) return "current";
  return "future";
}

const PLAYED = (m: Match, maps: readonly MapInstance[]) => m.status === "live" || m.status === "completed" || maps.some(mapHasResult);

export function registerRecordRoutes(r: Router, e: Engine): void {
  const who = (req: { principal?: { label: string } | null }) => req.principal!.label;

  // ---- staged image uploads ------------------------------------------------------------------
  r.post("/api/v1/uploads/images", { permission: "metadata.write", maxBodyBytes: IMAGE_MAX_BYTES + 512 * 1024 }, (req) => {
    const s = e.staged.stage(req.rawBody);
    return { ...s, advice: imageAdvice(s) };
  });
  r.delete("/api/v1/uploads/images/:stagedId", { permission: "metadata.write" }, (req) => ({ discarded: e.staged.discard(req.params.stagedId!) }));

  /** Promotes a staged upload into the asset store; the staged file is removed once the record is saved. */
  const promote = (stagedId: string | undefined): string | undefined => {
    if (!stagedId) return undefined;
    const { body, ext } = e.staged.read(stagedId);
    return storeAsset(e, body, ext);
  };
  const afterSave = (...ids: (string | undefined)[]) => ids.forEach((id) => id && e.staged.discard(id));

  // The default player picture (Settings → General): shown for any player without their own, in
  // MatchFrame HUDs (after the HUD images' side pictures), imported HUDs, the speaker strip and the console.
  const defaultPicture = () => {
    const assetId = e.defaultPlayerPicture();
    return { assetId, url: e.assetUrl(assetId) };
  };
  r.get("/api/v1/default-player-picture", { permission: "metadata.read" }, () => defaultPicture());
  r.put("/api/v1/default-player-picture", { permission: "metadata.write", body: z.object({ stagedId: z.string().max(80).optional(), clear: z.boolean().optional() }) }, (req) => {
    if (!req.body.stagedId && !req.body.clear) throw new HttpError(400, "Upload a picture, or remove the current one.", "nothing_to_do");
    const assetId = req.body.clear ? null : (promote(req.body.stagedId) ?? null);
    e.setDefaultPlayerPicture(assetId);
    afterSave(req.body.stagedId);
    e.audit.record(who(req), assetId ? "players.default_picture.set" : "players.default_picture.clear", assetId);
    return defaultPicture();
  });

  r.get("/api/v1/map-pool", { permission: "metadata.read" }, () => {
    const known = new Set([...REQUESTED_MAP_TARGETS.map((t) => t.mapName), ...e.maps.list().map((m) => m.mapName)]);
    return { maps: appMapPool(), known: [...known].sort() };
  });

  // ---- teams -------------------------------------------------------------------------------
  const playerCounts = () => new Map(e.db.all<{ team_id: string; n: number }>("SELECT team_id, COUNT(*) AS n FROM roster_memberships WHERE valid_to IS NULL GROUP BY team_id").map((x) => [x.team_id, x.n]));
  const teamRow = (d: { id: string; data: Team; revision: number; archived: boolean }, counts = playerCounts()) => ({ ...d.data, revision: d.revision, archived: d.archived, playerCount: counts.get(d.data.id) ?? 0 });

  r.get("/api/v1/teams", { permission: "metadata.read" }, (req) => {
    const counts = playerCounts();
    return e.teams.list({ includeArchived: req.query.get("archived") === "1" }).map((d) => teamRow(d, counts));
  });
  r.get("/api/v1/teams/:id", { permission: "metadata.read" }, (req) => {
    const d = e.teams.require(req.params.id!);
    return { ...teamRow(d), roster: e.roster.forTeam(d.id).map((m) => ({ ...m, player: e.players.get(m.playerId)?.data ?? null })) };
  });

  const checkTeam = (t: Partial<Team>, selfId: string | null): Issue[] => {
    const issues: Issue[] = [];
    const name = (t.name ?? "").trim();
    if (!name) issues.push({ path: ["name"], message: "Enter a team name" });
    else if (name.length > 80) issues.push({ path: ["name"], message: "Team name: up to 80 characters" });
    else {
      const dup = e.teams.list().find((x) => x.id !== selfId && normalizeName(x.data.name) === normalizeName(name));
      if (dup) issues.push({ path: ["name"], message: `A team named ${dup.data.name} already exists` });
    }
    if ((t.shortName ?? "").length > 12) issues.push({ path: ["shortName"], message: "Short name: up to 12 characters" });
    if (t.countryCode && !isCountryCode(t.countryCode)) issues.push({ path: ["countryCode"], message: "Choose a country from the list" });
    for (const k of ["primaryColor", "secondaryColor"] as const) if (t[k] && !/^#[0-9a-fA-F]{6}$/.test(t[k])) issues.push({ path: [k], message: `${TEAM_LABEL[k]}: a colour like #2f7cf6` });
    return issues;
  };
  const cleanTeam = (t: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...t };
    if (typeof out.name === "string") out.name = out.name.trim();
    if (typeof out.shortName === "string") out.shortName = out.shortName.trim();
    if (typeof out.countryCode === "string") out.countryCode = out.countryCode.trim().toUpperCase() || null;
    return out;
  };

  r.post("/api/v1/teams", { permission: "metadata.write" }, (req) => {
    const { logoStagedId, ...raw } = req.body as Record<string, unknown> & { logoStagedId?: string };
    const body = cleanTeam(raw);
    const issues = checkTeam(body as Partial<Team>, null);
    if (issues.length) throw invalid(issues);
    if (!body.shortName) body.shortName = shortNameOf(String(body.name)) || String(body.name).slice(0, 12);
    const logo = promote(logoStagedId);
    const d = e.teams.create({ ...body, ...(logo ? { logoAssetId: logo } : {}) }, "team");
    afterSave(logoStagedId);
    e.audit.record(who(req), "team.create", d.id);
    return teamRow(d);
  });

  r.patch("/api/v1/teams/:id", { permission: "metadata.write" }, (req) => {
    const id = req.params.id!;
    const cur = e.teams.require(id);
    const raw = req.body as Record<string, unknown>;
    if (!("changes" in raw)) {
      // Older clients: a plain patch with an optional whole-record revision check.
      const { revision, ...patch } = raw as Record<string, unknown> & { revision?: number };
      const next = cleanTeam(patch);
      const issues = checkTeam({ ...cur.data, ...next } as Team, id);
      if (issues.length) throw invalid(issues);
      const d = e.teams.update(id, next, revision);
      e.audit.record(who(req), "team.update", d.id, patch);
      return teamRow(d);
    }
    const p = parsePatch(raw);
    const changes = cleanTeam(p.changes);
    const expected = cleanTeam(p.expected);
    if (p.logoStagedId) changes.logoAssetId = "__staged__";
    const conflicts = fieldConflicts(cur.data as unknown as Record<string, unknown>, changes, expected, (k) => TEAM_LABEL[k] ?? k);
    if (conflicts.length) throw conflict(conflicts);
    const next = { ...cur.data, ...changes } as Team;
    const issues = checkTeam(next, id);
    if (issues.length) throw invalid(issues);
    if (changes.shortName === "") changes.shortName = shortNameOf(next.name) || next.name.slice(0, 12);
    if (p.logoStagedId) changes.logoAssetId = promote(p.logoStagedId);
    const d = e.teams.update(id, changes);
    afterSave(p.logoStagedId);
    e.audit.record(who(req), "team.update", d.id, changes);
    return teamRow(d);
  });

  // ---- players -----------------------------------------------------------------------------
  const playerRow = (d: { data: Player; revision: number; archived: boolean }) => {
    const m = e.db.get<{ team_id: string; role: string }>("SELECT team_id, role FROM roster_memberships WHERE player_id = ? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1", d.data.id);
    return { ...d.data, ...playerNames(d.data), revision: d.revision, archived: d.archived, teamId: m?.team_id ?? null, role: m?.role ?? null };
  };

  r.get("/api/v1/players", { permission: "metadata.read" }, (req) => e.players.list({ includeArchived: req.query.get("archived") === "1" }).map(playerRow));
  r.get("/api/v1/players/:id", { permission: "metadata.read" }, (req) => {
    const d = e.players.require(req.params.id!);
    return { ...playerRow(d), history: e.roster.history(d.id) };
  });

  const ROLES = ["player", "substitute", "coach", "stand_in"] as const;
  type Role = (typeof ROLES)[number];
  const checkPlayer = (p: Partial<Player> & { teamId?: string | null; role?: string | null }, selfId: string | null, teamChanged: boolean): Issue[] => {
    const issues: Issue[] = [];
    const nick = (p.displayName ?? "").trim();
    if (!nick) issues.push({ path: ["displayName"], message: "Enter a nickname" });
    else if (nick.length > 64) issues.push({ path: ["displayName"], message: "Nickname: up to 64 characters" });
    for (const k of ["firstName", "lastName"] as const) if ((p[k] ?? "").length > 60) issues.push({ path: [k], message: `${PLAYER_LABEL[k]}: up to 60 characters` });
    if (p.steamId) {
      const problem = steamId64Problem(p.steamId);
      if (problem) issues.push({ path: ["steamId"], message: problem });
      else {
        const other = e.steamIndex.lookup(p.steamId) ?? e.players.list({ includeArchived: true }).find((x) => x.data.steamId === p.steamId)?.id ?? null;
        if (other && other !== selfId) {
          const o = e.players.get(other);
          issues.push({ path: ["steamId"], message: `SteamID64 ${p.steamId} already belongs to ${o?.data.displayName ?? "another player"}${o?.archived ? " (archived)" : ""}` });
        }
      }
    }
    if (p.countryCode && !isCountryCode(p.countryCode)) issues.push({ path: ["countryCode"], message: "Choose a country from the list" });
    if (p.teamId && teamChanged) {
      const t = e.teams.get(p.teamId);
      if (!t) issues.push({ path: ["teamId"], message: "That team no longer exists; choose another" });
      else if (t.archived) issues.push({ path: ["teamId"], message: `${t.data.name} is archived; choose another team` });
    }
    if (p.role && !ROLES.includes(p.role as Role)) issues.push({ path: ["role"], message: "Role: player, substitute, coach or stand-in" });
    return issues;
  };
  const cleanPlayer = (b: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...b };
    for (const k of ["displayName", "firstName", "lastName", "cameraSourceId"]) if (typeof out[k] === "string") out[k] = (out[k] as string).trim() || (k === "displayName" ? "" : null);
    if (typeof out.steamId === "string") out.steamId = out.steamId.trim() || null;
    if (typeof out.countryCode === "string") out.countryCode = out.countryCode.trim().toUpperCase() || null;
    return out;
  };
  /** Joins, moves or leaves the roster for a player's team field (history kept: the open membership is closed). */
  const applyTeam = (playerId: string, teamId: string | null, role: Role | null) => {
    const current = e.roster.teamOf(playerId);
    if (teamId === current) {
      if (teamId && role) e.roster.join(teamId, playerId, role);
      return;
    }
    if (current) e.roster.leave(current, playerId);
    if (teamId) e.roster.join(teamId, playerId, role ?? "player");
  };

  r.post("/api/v1/players", { permission: "metadata.write" }, (req) => {
    const { avatarStagedId, teamId, role, ...raw } = req.body as Record<string, unknown> & { avatarStagedId?: string; teamId?: string | null; role?: Role | null };
    const body = normalizePlayerNames(cleanPlayer(raw));
    const issues = checkPlayer({ ...(body as Partial<Player>), teamId: teamId ?? null, role: role ?? null }, null, true);
    if (issues.length) throw invalid(issues);
    const avatar = promote(avatarStagedId);
    const d = e.db.transaction(() => {
      const created = e.players.create({ ...body, ...(avatar ? { avatarAssetId: avatar } : {}) }, "player");
      if (created.data.steamId) e.steamIndex.set(created.data.steamId, created.id);
      if (teamId) applyTeam(created.id, teamId, role ?? null);
      return created;
    });
    afterSave(avatarStagedId);
    e.audit.record(who(req), "player.create", d.id, teamId ? { teamId } : null);
    return playerRow(e.players.require(d.id));
  });

  r.patch("/api/v1/players/:id", { permission: "metadata.write" }, (req) => {
    const id = req.params.id!;
    const cur = e.players.require(id);
    const raw = req.body as Record<string, unknown>;
    const legacy = !("changes" in raw);
    const p: FieldPatch = legacy ? { changes: raw, expected: {} } : parsePatch(raw);
    const { revision, ...rawChanges } = p.changes as Record<string, unknown> & { revision?: number };
    const changes = cleanPlayer(rawChanges);
    const expected = cleanPlayer(p.expected);
    const currentTeam = e.roster.teamOf(id);
    const currentRole = e.roster.roleOf(id);
    if (p.avatarStagedId) changes.avatarAssetId = "__staged__";
    const conflicts = fieldConflicts({ ...(cur.data as unknown as Record<string, unknown>), teamId: currentTeam, role: currentRole }, changes, expected, (k) => PLAYER_LABEL[k] ?? k);
    if (conflicts.length) throw conflict(conflicts);
    const teamChanged = "teamId" in changes && changes.teamId !== currentTeam;
    const { teamId, role, ...fields } = changes as Record<string, unknown> & { teamId?: string | null; role?: Role | null };
    const named = normalizePlayerNames(fields, cur.data);
    const next = { ...cur.data, ...named, teamId: "teamId" in changes ? (teamId ?? null) : currentTeam, role: role ?? currentRole } as Player & { teamId: string | null; role: string | null };
    const issues = checkPlayer(next, id, teamChanged);
    if (issues.length) throw invalid(issues);
    if (p.avatarStagedId) named.avatarAssetId = promote(p.avatarStagedId);
    const d = e.db.transaction(() => {
      const updated = Object.keys(named).length ? e.players.update(id, named, legacy ? revision : undefined) : cur;
      if (cur.data.steamId && cur.data.steamId !== updated.data.steamId) e.steamIndex.remove(cur.data.steamId);
      if (updated.data.steamId) e.steamIndex.set(updated.data.steamId, id);
      if ("teamId" in changes || role) applyTeam(id, "teamId" in changes ? (teamId ?? null) : currentTeam, role ?? null);
      return updated;
    });
    afterSave(p.avatarStagedId);
    e.audit.record(who(req), "player.update", d.id, changes);
    return playerRow(e.players.require(id));
  });

  // ---- matches -----------------------------------------------------------------------------
  const activeId = () => e.settings.get<string | null>("live.activeMatchId", null);
  const decisionsOf = (id: string) => e.vetoRepo.active(id);
  const poolFor = (m: Pick<Match, "mapPool" | "eventId">): { pool: string[]; source: "match" | "event" | "app" } => {
    if (m.mapPool.length) return { pool: m.mapPool, source: "match" };
    const ev = m.eventId ? e.events.get(m.eventId)?.data : undefined;
    if (ev?.mapPool.length) return { pool: ev.mapPool, source: "event" };
    return { pool: appMapPool().map((x) => x.mapName), source: "app" };
  };
  const matchRow = (d: { id: string; data: Match; revision: number; archived: boolean }, active = activeId()) => {
    const maps = e.mapInstances.forMatch(d.id);
    return { ...d.data, revision: d.revision, archived: d.archived, maps, group: matchGroup(d.data, maps), active: d.id === active };
  };
  const matchDetail = (id: string) => {
    const d = e.matches.require(id);
    const row = matchRow(d);
    const decisions = decisionsOf(id);
    const veto = effectiveVetoEntries(d.data, decisions, row.maps);
    const totals = seriesTotals(d.data, row.maps);
    const pool = poolFor(d.data);
    return {
      ...row,
      corrections: e.corrections.list().filter((c) => c.data.matchId === id).map((c) => c.data),
      vetoEntries: veto.entries,
      vetoSource: veto.source,
      captainDecisions: decisions.length,
      pool: pool.pool,
      poolSource: pool.source,
      seriesFromMaps: { a: totals.fromMapsA, b: totals.fromMapsB },
    };
  };

  r.get("/api/v1/matches", { permission: "metadata.read" }, (req) => {
    const active = activeId();
    return e.matches.list({ includeArchived: req.query.get("archived") === "1" }).map((d) => matchRow(d, active));
  });
  r.get("/api/v1/matches/:id", { permission: "metadata.read" }, (req) => matchDetail(req.params.id!));

  type MatchDraft = Pick<Match, "teamAId" | "teamBId" | "format" | "eventId" | "stageId" | "scheduledAt" | "title" | "mapPool" | "veto" | "status">;
  const checkMatch = (m: MatchDraft, totals: { a: number; b: number } | null, changed: Set<string> | null): Issue[] => {
    const issues: Issue[] = [];
    const isNew = changed === null;
    for (const [k, label] of [["teamAId", "Team 1"], ["teamBId", "Team 2"]] as const) {
      if (!m[k]) issues.push({ path: [k], message: `Choose ${label}` });
      else {
        const t = e.teams.get(m[k]);
        if (!t) issues.push({ path: [k], message: `${label}: that team no longer exists` });
        else if (t.archived && (isNew || changed.has(k))) issues.push({ path: [k], message: `${label}: ${t.data.name} is archived` });
      }
    }
    if (m.teamAId && m.teamAId === m.teamBId) issues.push({ path: ["teamBId"], message: "Team 1 and Team 2 must be different teams" });
    if (m.eventId && !e.events.get(m.eventId)) issues.push({ path: ["eventId"], message: "That tournament no longer exists" });
    if (m.stageId) {
      const st = e.stages.get(m.stageId);
      if (!st) issues.push({ path: ["stageId"], message: "That stage no longer exists" });
      else if (m.eventId && st.data.eventId !== m.eventId) issues.push({ path: ["stageId"], message: "The stage belongs to another tournament" });
    }
    if (m.scheduledAt && Number.isNaN(Date.parse(m.scheduledAt))) issues.push({ path: ["scheduledAt"], message: "Enter a valid date and time" });
    if (isNew || changed.has("veto") || changed.has("teamAId") || changed.has("teamBId") || changed.has("format") || changed.has("mapPool") || changed.has("eventId")) {
      const { pool } = poolFor(m);
      for (const v of validateVetoEntries(m.veto ?? [], { teamAId: m.teamAId, teamBId: m.teamBId, bestOf: m.format.bestOf, pool })) issues.push({ path: v.index === null ? ["veto"] : ["veto", v.index, v.field], message: v.message });
    }
    if (totals) {
      const problem = validateSeriesScore(totals.a, totals.b, m.format.bestOf);
      if (problem) issues.push({ path: ["seriesScoreA"], message: problem });
    }
    return issues;
  };

  const MatchCreate = z.object({
    eventId: z.string().nullable().default(null),
    stageId: z.string().nullable().default(null),
    teamAId: z.string().default(""),
    teamBId: z.string().default(""),
    format: MatchFormat.default({ bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }),
    mapPool: z.array(z.string()).default([]),
    scheduledAt: z.string().nullable().default(null),
    title: z.string().nullable().default(null),
    veto: z.array(VetoEntry).max(40).default([]),
    seriesScoreA: z.number().int().min(0).max(9).default(0),
    seriesScoreB: z.number().int().min(0).max(9).default(0),
    status: z.enum(["scheduled", "veto", "live", "completed", "cancelled"]).default("scheduled"),
  });

  /** Writes the match's maps for its veto (played maps kept or refused) and the series total. */
  const syncMaps = (match: Match) => {
    const existing = e.mapInstances.forMatch(match.id);
    const { maps, removed } = deriveMapInstances(match, match.veto ?? [], existing);
    for (const m of removed) e.mapInstances.remove(m.id);
    for (const m of maps) e.mapInstances.upsert(m);
    return maps;
  };

  r.post("/api/v1/matches", { permission: "metadata.write", body: MatchCreate }, (req) => {
    const b = req.body;
    if (b.teamAId && b.teamAId === b.teamBId) throw new HttpError(400, "A match needs two different teams: Team 1 and Team 2 are the same team", "same_team", [{ path: ["teamBId"], message: "Team 1 and Team 2 must be different teams" }]);
    const draft: MatchDraft = { ...b, title: b.title?.trim() || null };
    const issues = checkMatch(draft, { a: b.seriesScoreA, b: b.seriesScoreB }, null);
    if (issues.length) throw invalid(issues);
    // The match keeps the pool it was set up with (the captain veto and the editor read it).
    const mapPool = b.mapPool.length ? b.mapPool : poolFor({ mapPool: [], eventId: b.eventId }).pool;
    const created = e.db.transaction(() => {
      const d = e.matches.create({ ...draft, mapPool, seriesScoreA: b.seriesScoreA, seriesScoreB: b.seriesScoreB, seriesCorrectionA: b.seriesScoreA, seriesCorrectionB: b.seriesScoreB }, "match");
      syncMaps(d.data);
      return d;
    });
    e.audit.record(who(req), "match.create", created.id);
    return matchDetail(created.id);
  });

  r.patch("/api/v1/matches/:id", { permission: "metadata.write" }, (req) => {
    const id = req.params.id!;
    const cur = e.matches.require(id);
    const raw = req.body as Record<string, unknown>;
    if (!("changes" in raw)) {
      const { revision, ...patch } = raw as Record<string, unknown> & { revision?: number };
      const d = e.matches.update(id, patch, revision);
      e.audit.record(who(req), "match.update", d.id, patch);
      return matchDetail(d.id);
    }
    const p = parsePatch(raw);
    const allowed = new Set(Object.keys(MATCH_LABEL));
    const unknown = Object.keys(p.changes).filter((k) => !allowed.has(k));
    if (unknown.length) throw new HttpError(400, `fields that cannot be edited here: ${unknown.join(", ")}`, "bad_field");
    const parsed = MatchCreate.partial().safeParse(p.changes);
    if (!parsed.success) throw new HttpError(400, "request validation failed", "validation", parsed.error.issues);
    const changes = parsed.data as Partial<z.infer<typeof MatchCreate>>;
    for (const k of Object.keys(changes) as (keyof typeof changes)[]) if (!(k in p.changes)) delete changes[k];
    const maps = e.mapInstances.forMatch(id);
    const totalsNow = seriesTotals(cur.data, maps);
    const decisions = decisionsOf(id);
    const shown = { ...cur.data, veto: effectiveVetoEntries(cur.data, decisions, maps).entries, seriesScoreA: totalsNow.a, seriesScoreB: totalsNow.b } as unknown as Record<string, unknown>;
    const conflicts = fieldConflicts(shown, changes, p.expected, (k) => MATCH_LABEL[k] ?? k);
    if (conflicts.length) throw conflict(conflicts);
    const changed = new Set(Object.keys(changes));
    const next: Match = { ...cur.data, ...changes, title: "title" in changes ? changes.title?.trim() || null : cur.data.title } as Match;
    if (!changed.has("veto")) next.veto = cur.data.veto;
    const totalA = changes.seriesScoreA ?? totalsNow.a;
    const totalB = changes.seriesScoreB ?? totalsNow.b;
    const scoreTouched = changed.has("seriesScoreA") || changed.has("seriesScoreB");
    const issues = checkMatch(next, scoreTouched || changed.has("format") ? { a: totalA, b: totalB } : null, changed);
    if (issues.length) throw invalid(issues);
    if (scoreTouched) {
      next.seriesCorrectionA = totalA - totalsNow.fromMapsA;
      next.seriesCorrectionB = totalB - totalsNow.fromMapsB;
    }
    const vetoTouched = changed.has("veto") || changed.has("teamAId") || changed.has("teamBId");
    const saved = e.db.transaction(() => {
      const newMaps = vetoTouched && ((next.veto ?? []).length > 0 || (cur.data.veto ?? []).length > 0) ? syncMaps(next) : maps;
      const t = seriesTotals(next, newMaps);
      let status = next.status;
      if (!changed.has("status") && scoreTouched) status = t.winnerTeamId ? "completed" : cur.data.status === "completed" ? (PLAYED({ ...next, status: "scheduled" }, newMaps) ? "live" : "scheduled") : cur.data.status;
      const { id: _id, ...data } = next;
      return e.matches.update(id, { ...data, status, seriesScoreA: t.a, seriesScoreB: t.b });
    });
    if (changed.has("veto") && decisions.length) e.audit.record(who(req), "veto.manual_correction", id, { captainDecisions: decisions.length, entries: next.veto });
    e.audit.record(who(req), "match.update", saved.id, changes);
    return matchDetail(saved.id);
  });

  r.post("/api/v1/matches/:id/activate", { permission: "program.control" }, (req) => {
    const d = e.matches.require(req.params.id!);
    if (d.archived) throw new HttpError(409, "This match is archived; restore it before making it active", "archived");
    const previous = activeId();
    // Active for the HUD is separate from the match's status and list group (a scheduled match
    // stays in Future until it is played); there is only ever one active match.
    e.setActiveMatch(d.id);
    e.audit.record(who(req), "match.activate", d.id, { previous });
    return { active: d.id, previous };
  });

  r.post("/api/v1/matches/:id/archive", { permission: "metadata.write", body: z.object({ archived: z.boolean().default(true) }) }, (req) => {
    const id = req.params.id!;
    if (req.body.archived && activeId() === id) throw new HttpError(409, "This is the active match for the HUDs; make another match active (or deactivate it) before archiving it", "active_match");
    e.matches.archive(id, req.body.archived);
    e.audit.record(who(req), req.body.archived ? "match.archive" : "match.unarchive", id);
    return { archived: req.body.archived };
  });

  // ---- protected deletes -------------------------------------------------------------------
  type Impact = { id: string; label: string; deletable: boolean; blockers: string[]; effects: string[] };
  const teamName = (id: string) => e.teams.get(id)?.data.name ?? "a deleted team";
  const matchLabel = (m: Match) => `${teamName(m.teamAId)} vs ${teamName(m.teamBId)}${m.scheduledAt ? ` (${m.scheduledAt.slice(0, 10)})` : ""}`;
  const names = (list: string[], max = 4) => (list.length > max ? `${list.slice(0, max).join(", ")} and ${list.length - max} more` : list.join(", "));
  const allMatches = () => e.matches.list({ includeArchived: true }).map((d) => d.data);

  const teamImpact = (id: string): Impact => {
    const t = e.teams.get(id);
    if (!t) return { id, label: id, deletable: false, blockers: ["This team no longer exists"], effects: [] };
    const blockers: string[] = [];
    const effects: string[] = [];
    const matches = allMatches().filter((m) => m.teamAId === id || m.teamBId === id);
    if (matches.length) blockers.push(`Used by ${matches.length} match${matches.length === 1 ? "" : "es"}: ${names(matches.map(matchLabel), 3)}`);
    const current = e.roster.forTeam(id);
    if (current.length) blockers.push(`${current.length} assigned player${current.length === 1 ? "" : "s"}: ${names(current.map((m) => e.players.get(m.playerId)?.data.displayName ?? "?"))}. Move or unassign them first`);
    const stages = e.stages.list().filter((s) => s.data.teamIds.includes(id));
    if (stages.length) blockers.push(`Listed in tournament stage${stages.length === 1 ? "" : "s"} ${names(stages.map((s) => s.data.name))}`);
    const past = e.db.all<{ player_id: string }>("SELECT player_id FROM roster_memberships WHERE team_id = ? AND valid_to IS NOT NULL", id);
    if (past.length) effects.push(`Past roster entries of ${names([...new Set(past.map((x) => e.players.get(x.player_id)?.data.displayName ?? "?"))])} are removed from their history`);
    if (t.data.logoAssetId) effects.push("The logo file stays in the asset store (other records may use it)");
    return { id, label: t.data.name, deletable: blockers.length === 0, blockers, effects };
  };

  /** Whether a player took part in a played match: a membership with one of its teams that was valid when it was scheduled (any time when it has no date). */
  const playerMatches = (playerId: string): Match[] => {
    const history = e.roster.history(playerId);
    return allMatches().filter((m) => {
      if (!PLAYED(m, e.mapInstances.forMatch(m.id))) return false;
      return history.some((h) => (h.teamId === m.teamAId || h.teamId === m.teamBId) && (!m.scheduledAt || (h.validFrom <= m.scheduledAt && (h.validTo === null || h.validTo > m.scheduledAt))));
    });
  };
  const playerImpact = (id: string): Impact => {
    const p = e.players.get(id);
    if (!p) return { id, label: id, deletable: false, blockers: ["This player no longer exists"], effects: [] };
    const blockers: string[] = [];
    const effects: string[] = [];
    if (p.data.steamId) {
      const corr = e.corrections.list().filter((c) => c.data.steamId === p.data.steamId);
      if (corr.length) blockers.push(`${corr.length} stat correction${corr.length === 1 ? "" : "s"} refer to this player's SteamID`);
    }
    const played = playerMatches(id);
    if (played.length) blockers.push(`On the roster of ${played.length} played match${played.length === 1 ? "" : "es"}: ${names(played.map(matchLabel), 3)}`);
    if (activeId()) {
      const am = e.activeMatch();
      const team = e.roster.teamOf(id);
      if (am && team && (am.teamAId === team || am.teamBId === team)) blockers.push(`Plays for a team in the active match (${matchLabel(am)})`);
    }
    const team = e.roster.teamOf(id);
    if (team) effects.push(`Leaves the ${teamName(team)} roster`);
    const past = e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM roster_memberships WHERE player_id = ? AND valid_to IS NOT NULL", id)?.n ?? 0;
    if (past) effects.push(`${past} past roster entr${past === 1 ? "y is" : "ies are"} removed`);
    if (p.data.steamId) effects.push(`SteamID64 ${p.data.steamId} is no longer linked to a player`);
    return { id, label: p.data.displayName, deletable: blockers.length === 0, blockers, effects };
  };

  const matchImpact = (id: string): Impact => {
    const d = e.matches.get(id);
    if (!d) return { id, label: id, deletable: false, blockers: ["This match no longer exists"], effects: [] };
    const m = d.data;
    const blockers: string[] = [];
    const effects: string[] = [];
    if (activeId() === id) blockers.push("It is the active match for the HUDs. Make another match active first");
    const bracket = e.stages.list().filter((s) => s.data.bracket.some((n) => n.matchId === id));
    if (bracket.length) blockers.push(`Placed in the bracket of ${names(bracket.map((s) => s.data.name))}`);
    const maps = e.mapInstances.forMatch(id);
    const playedMaps = maps.filter(mapHasResult);
    if (m.stageId && playedMaps.length) blockers.push(`Its results count in the standings of ${e.stages.get(m.stageId)?.data.name ?? "its stage"}`);
    if (maps.length) effects.push(`${maps.length} map${maps.length === 1 ? "" : "s"}${playedMaps.length ? ` (${playedMaps.length} with results)` : ""} are deleted with it`);
    const decisions = e.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM veto_decisions WHERE match_id = ?", id)?.n ?? 0;
    if (decisions) effects.push(`${decisions} captain veto decision${decisions === 1 ? "" : "s"} are deleted`);
    const corr = e.corrections.list().filter((c) => c.data.matchId === id).length;
    if (corr) effects.push(`${corr} stat correction${corr === 1 ? "" : "s"} are deleted`);
    if (existsSync(join(e.cfg.dataDir, "graphics", id))) effects.push("Its thumbnails and stingers are deleted");
    effects.push("Captain links for this match stop working");
    return { id, label: matchLabel(m), deletable: blockers.length === 0, blockers, effects };
  };

  const Ids = z.object({ ids: z.array(z.string()).min(1).max(500) });
  const deleteRoutes = (path: string, kind: string, impact: (id: string) => Impact, remove: (id: string) => void) => {
    r.post(`/api/v1/${path}/delete-preview`, { permission: "metadata.write", body: Ids }, (req) => ({ records: [...new Set(req.body.ids)].map(impact) }));
    r.post(`/api/v1/${path}/delete`, { permission: "metadata.write", body: Ids }, (req) => {
      const ids = [...new Set(req.body.ids)];
      const impacts = ids.map(impact);
      const blocked = impacts.filter((x) => !x.deletable);
      if (blocked.length) {
        throw new HttpError(
          409,
          `Not deleted: ${blocked.map((b) => `${b.label} (${b.blockers[0]})`).join("; ")}. Archive ${blocked.length === 1 ? "it" : "them"} instead to hide ${blocked.length === 1 ? "it" : "them"} from lists while keeping history.`,
          "in_use",
          blocked.map((b) => ({ path: [b.id], message: `${b.label}: ${b.blockers.join("; ")}` })),
        );
      }
      e.db.transaction(() => ids.forEach(remove));
      e.audit.record(who(req), `${kind}.delete`, null, { ids, labels: impacts.map((x) => x.label) });
      return { deleted: ids };
    });
  };
  deleteRoutes("teams", "team", teamImpact, (id) => {
    e.db.run("DELETE FROM roster_memberships WHERE team_id = ?", id);
    e.teams.delete(id);
  });
  deleteRoutes("players", "player", playerImpact, (id) => {
    const p = e.players.get(id);
    e.db.run("DELETE FROM roster_memberships WHERE player_id = ?", id);
    e.db.run("DELETE FROM players_steam WHERE player_id = ?", id);
    if (p?.data.steamId && e.steamIndex.lookup(p.data.steamId) === id) e.steamIndex.remove(p.data.steamId);
    e.players.delete(id);
  });
  deleteRoutes("matches", "match", matchImpact, (id) => {
    for (const m of e.mapInstances.forMatch(id)) e.mapInstances.remove(m.id);
    e.vetoRepo.reset(id);
    for (const c of e.corrections.list().filter((x) => x.data.matchId === id)) e.corrections.delete(c.id);
    e.db.run("DELETE FROM settings WHERE key = ?", `veto.steps.${id}`);
    e.matches.delete(id);
    const art = join(e.cfg.dataDir, "graphics", id);
    if (/^[A-Za-z0-9_-]+$/.test(id) && existsSync(art)) rmSync(art, { recursive: true, force: true });
  });

  // ---- .xlsx imports -------------------------------------------------------------------------
  const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const TEAM_COLUMNS = [
    { key: "name", header: "Team name", aliases: ["team name", "name", "team"], width: 32 },
    { key: "shortName", header: "Short name", aliases: ["short name", "shortname", "tag", "short"], width: 14 },
    { key: "country", header: "Country", aliases: ["country", "country code", "countrycode", "nationality"], width: 18 },
  ] as const;
  const PLAYER_COLUMNS = [
    { key: "displayName", header: "Nickname", aliases: ["nickname", "nick", "display name", "displayname", "alias", "player"], width: 20 },
    { key: "firstName", header: "First name", aliases: ["first name", "firstname", "given name"], width: 18 },
    { key: "lastName", header: "Last name", aliases: ["last name", "lastname", "surname", "family name"], width: 18 },
    { key: "country", header: "Country", aliases: ["country", "country code", "countrycode", "nationality"], width: 16 },
    { key: "steamId", header: "SteamID64", aliases: ["steamid64", "steamid", "steam id", "steam id64", "player identification"], width: 22, text: true },
    { key: "team", header: "Team", aliases: ["team", "team name", "team id"], width: 26 },
  ] as const;
  type Col = { key: string; header: string; aliases: readonly string[]; width: number; text?: boolean };

  const template = (name: string, cols: readonly Col[], help: string[][]) => {
    const body = writeXlsx([
      { name, columns: cols.map((c) => ({ header: c.header, width: c.width, text: true })) },
      { name: "How to fill in", columns: [{ header: "Column", width: 18 }, { header: "What to enter", width: 96 }], rows: help },
    ]);
    return { body, contentType: XLSX_TYPE, headers: { "content-disposition": `attachment; filename="MatchFrame ${name} import template.xlsx"`, "cache-control": "no-store" } };
  };
  r.get("/api/v1/import/teams/template.xlsx", { permission: "metadata.read" }, () =>
    template("Teams", TEAM_COLUMNS, [
      ["Team name", "Required. The team's full name. A team that already exists (same name) is reported, not created again."],
      ["Short name", "Optional, up to 12 characters (made from the name when empty)."],
      ["Country", "Optional. A two-letter country code (AU, GB, DE…) or the country's English name."],
    ]),
  );
  r.get("/api/v1/import/players/template.xlsx", { permission: "metadata.read" }, () =>
    template("Players", PLAYER_COLUMNS, [
      ["Nickname", "Required. The broadcast name shown on the HUD."],
      ["First name", "Optional."],
      ["Last name", "Optional."],
      ["Country", "Optional. A two-letter country code (AU, GB, DE…) or the country's English name."],
      ["SteamID64", "Optional but needed to match live CS2 data: 17 digits starting 7656119. Keep the column formatted as Text (Excel rounds long numbers)."],
      ["Team", "Optional. An existing team's name, short name or id (import teams first). Unknown or ambiguous teams are reported, never guessed."],
    ]),
  );

  const headerMap = (rows: XlsxRow[], cols: readonly Col[], required: string): { index: Map<string, number>; ignored: string[] } => {
    const head = rows[0];
    if (!head) throw new HttpError(400, "The spreadsheet is empty. Download the template, fill in one row per record and upload it.", "empty_sheet");
    const index = new Map<string, number>();
    const ignored: string[] = [];
    head.cells.forEach((c, i) => {
      const h = c.text.trim().toLowerCase().replace(/\s+/g, " ");
      if (!h) return;
      const col = cols.find((x) => x.aliases.includes(h));
      if (col && !index.has(col.key)) index.set(col.key, i);
      else ignored.push(c.text.trim());
    });
    if (!index.has(required)) throw new HttpError(400, `The first row must hold the column headings; "${cols.find((c) => c.key === required)!.header}" is missing. Use the template.`, "missing_column");
    return { index, ignored };
  };
  const cellOf = (row: XlsxRow, index: Map<string, number>, key: string) => {
    const i = index.get(key);
    return i === undefined ? { text: "", type: "" as const } : (row.cells[i] ?? { text: "", type: "" as const });
  };

  /** Team for a spreadsheet cell: exact id, else the one team whose name or short name matches (normalized). Never a guess. */
  const resolveTeam = (text: string): { id: string | null; error: string | null } => {
    const v = text.trim();
    if (!v) return { id: null, error: null };
    const byId = e.teams.get(v);
    if (byId && !byId.archived) return { id: byId.id, error: null };
    const n = normalizeName(v);
    const hits = e.teams.list().filter((t) => normalizeName(t.data.name) === n || normalizeName(t.data.shortName) === n);
    if (hits.length === 1) return { id: hits[0]!.id, error: null };
    if (hits.length > 1) return { id: null, error: `Team "${v}" is ambiguous: it matches ${names(hits.map((t) => `${t.data.name} (${t.data.shortName})`))}. Use the full team name or its id` };
    return { id: null, error: `Team "${v}" does not exist. Import or create the team first` };
  };

  interface PreviewRow {
    row: number;
    values: Record<string, string>;
    errors: string[];
    record: Record<string, unknown> | null;
  }

  const teamsPreview = (body: Buffer) => {
    const rows = readXlsx(body);
    const { index, ignored } = headerMap(rows, TEAM_COLUMNS, "name");
    const seen = new Map<string, number>();
    const out: PreviewRow[] = rows.slice(1).map((row) => {
      const values = Object.fromEntries(TEAM_COLUMNS.map((c) => [c.key, cellOf(row, index, c.key).text.trim()]));
      const errors: string[] = [];
      const name = values.name!;
      if (!name) errors.push("Team name is empty");
      else if (name.length > 80) errors.push("Team name: up to 80 characters");
      const shortName = values.shortName || shortNameOf(name);
      if (shortName.length > 12) errors.push("Short name: up to 12 characters");
      const country = values.country ? countryFromInput(values.country) : null;
      if (values.country && !country) errors.push(`Country "${values.country}" is not a country code or country name`);
      if (name) {
        const n = normalizeName(name);
        const first = seen.get(n);
        if (first !== undefined) errors.push(`Same team as row ${first} in this file`);
        else seen.set(n, row.row);
        const existing = e.teams.list({ includeArchived: true }).find((t) => normalizeName(t.data.name) === n);
        if (existing) errors.push(`Team ${existing.data.name} already exists${existing.archived ? " (archived)" : ""}; it is not created again`);
      }
      return { row: row.row, values, errors, record: errors.length ? null : { name, shortName, countryCode: country } };
    });
    return { rows: out, ignoredColumns: ignored };
  };

  const playersPreview = (body: Buffer) => {
    const rows = readXlsx(body);
    const { index, ignored } = headerMap(rows, PLAYER_COLUMNS, "displayName");
    const seenSteam = new Map<string, number>();
    const seenNoSteam = new Map<string, number>();
    const all = e.players.list({ includeArchived: true });
    const out: PreviewRow[] = rows.slice(1).map((row) => {
      const values = Object.fromEntries(PLAYER_COLUMNS.map((c) => [c.key, cellOf(row, index, c.key).text.trim()]));
      const errors: string[] = [];
      const nick = values.displayName!;
      if (!nick) errors.push("Nickname is empty");
      else if (nick.length > 64) errors.push("Nickname: up to 64 characters");
      for (const k of ["firstName", "lastName"] as const) if (values[k]!.length > 60) errors.push(`${PLAYER_LABEL[k]}: up to 60 characters`);
      const steamCell = cellOf(row, index, "steamId");
      let steamId: string | null = null;
      if (steamCell.type === "n" && steamCell.text) errors.push(`SteamID64 was stored as a number (${steamCell.text}) and Excel rounds 17-digit numbers. Format the SteamID64 column as Text and type the ID again`);
      else if (values.steamId) {
        const problem = steamId64Problem(values.steamId);
        if (problem) errors.push(problem);
        else {
          steamId = values.steamId;
          const first = seenSteam.get(steamId);
          if (first !== undefined) errors.push(`SteamID64 ${steamId} is also on row ${first} of this file`);
          else seenSteam.set(steamId, row.row);
          const owner = all.find((p) => p.data.steamId === steamId);
          if (owner) errors.push(`SteamID64 ${steamId} already belongs to ${owner.data.displayName}${owner.archived ? " (archived)" : ""}`);
        }
      }
      if (nick && !steamId && !values.steamId) {
        const n = normalizeName(nick);
        const first = seenNoSteam.get(n);
        if (first !== undefined) errors.push(`Same nickname without a SteamID64 as row ${first}; add SteamIDs to tell them apart`);
        else seenNoSteam.set(n, row.row);
        const existing = all.find((p) => normalizeName(p.data.displayName) === n);
        if (existing) errors.push(`A player named ${existing.data.displayName} already exists; without a SteamID64 this row would be a duplicate`);
      }
      const country = values.country ? countryFromInput(values.country) : null;
      if (values.country && !country) errors.push(`Country "${values.country}" is not a country code or country name`);
      const team = resolveTeam(values.team!);
      if (team.error) errors.push(team.error);
      return { row: row.row, values, errors, record: errors.length ? null : { displayName: nick, firstName: values.firstName || null, lastName: values.lastName || null, countryCode: country, steamId, teamId: team.id } };
    });
    return { rows: out, ignoredColumns: ignored };
  };

  const importRoutes = (kind: "teams" | "players", preview: (b: Buffer) => { rows: PreviewRow[]; ignoredColumns: string[] }, create: (rec: Record<string, unknown>) => string) => {
    const opts = { permission: "metadata.write" as const, maxBodyBytes: XLSX_MAX_BYTES + 1024 };
    r.post(`/api/v1/import/${kind}/preview`, opts, (req) => {
      const p = preview(req.rawBody);
      const valid = p.rows.filter((x) => x.errors.length === 0).length;
      return { rows: p.rows.map(({ record: _r, ...rest }) => rest), ignoredColumns: p.ignoredColumns, total: p.rows.length, valid, invalid: p.rows.length - valid };
    });
    r.post(`/api/v1/import/${kind}/commit`, opts, (req) => {
      // The file is checked again at commit: records may have changed since the preview.
      const p = preview(req.rawBody);
      const bad = p.rows.filter((x) => x.errors.length);
      const good = p.rows.filter((x) => x.record);
      if (bad.length && req.query.get("skipInvalid") !== "1") throw new HttpError(409, `${bad.length} row${bad.length === 1 ? " has" : "s have"} errors (first: row ${bad[0]!.row}: ${bad[0]!.errors[0]}). Fix the file, or import only the valid rows.`, "rows_invalid", bad.map((x) => ({ path: [x.row], message: x.errors.join("; ") })));
      if (good.length === 0) throw new HttpError(400, "There are no valid rows to import.", "nothing_to_import");
      const created = e.db.transaction(() => good.map((x) => create(x.record!)));
      e.audit.record(who(req), `import.${kind}`, null, { created: created.length, skipped: bad.map((x) => x.row) });
      return { created, skippedRows: bad.map((x) => x.row) };
    });
  };
  importRoutes("teams", teamsPreview, (rec) => e.teams.create(rec, "team").id);
  importRoutes("players", playersPreview, (rec) => {
    const { teamId, ...fields } = rec as Record<string, unknown> & { teamId: string | null };
    const d = e.players.create(normalizePlayerNames(fields), "player");
    if (d.data.steamId) e.steamIndex.set(d.data.steamId, d.id);
    if (teamId) e.roster.join(teamId, d.id);
    return d.id;
  });
}

function parsePatch(raw: Record<string, unknown>): FieldPatch {
  const p = FieldPatch.safeParse(raw);
  if (!p.success) throw new HttpError(400, "request validation failed", "validation", p.error.issues);
  return p.data;
}

