import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import type { MapInstance } from "@matchframe/contracts";
import { BracketNode, MapInstance as MapInstanceSchema, MatchFormat, Side, StageKind, StageTiebreaker } from "@matchframe/contracts";
import { buildBracket, computeStandings, validateBracket } from "../domain/standings.ts";
import type { Engine } from "../app.ts";
import { newId } from "../db/store.ts";
import { mapWinner, seriesScore } from "../domain/series.ts";
import { standardSequence } from "../domain/veto.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import { pushResultIfEnabled } from "./integrations.ts";

const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".webm", ".mp4"]);
const ASSET_MAX = 20 * 1024 * 1024;

export function assetDir(e: Engine): string {
  return join(e.cfg.dataDir, "assets");
}

/** Duplicate detection for imports: same SteamID or same normalized name. */
function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function registerDomainRoutes(r: Router, e: Engine): void {
  // ---- assets (logos, avatars, sponsor media) ---------------------------------------------
  r.post("/api/v1/assets", { permission: "metadata.write" }, (req) => {
    const name = String(req.query.get("name") ?? "asset");
    const ext = extname(name).toLowerCase();
    if (!ASSET_EXT.has(ext)) throw new HttpError(400, `asset type ${ext} not allowed`, "bad_type");
    if (req.rawBody.length === 0 || req.rawBody.length > ASSET_MAX) throw new HttpError(400, "empty or too large asset", "bad_size");
    const sha = createHash("sha256").update(req.rawBody).digest("hex");
    const id = `${sha.slice(0, 24)}${ext}`;
    mkdirSync(assetDir(e), { recursive: true });
    const path = join(assetDir(e), id);
    if (!existsSync(path)) writeFileSync(path, req.rawBody);
    e.audit.record(req.principal!.label, "asset.upload", id, { name, bytes: req.rawBody.length });
    return { assetId: id, url: `/assets/${id}`, sha256: sha };
  });

  // ---- teams -------------------------------------------------------------------------------
  r.get("/api/v1/teams", { permission: "metadata.read" }, (req) => e.teams.list({ includeArchived: req.query.get("archived") === "1" }).map((d) => ({ ...d.data, revision: d.revision, archived: d.archived })));
  r.post("/api/v1/teams", { permission: "metadata.write" }, (req) => {
    const d = e.teams.create(req.body as Record<string, unknown>, "team");
    e.audit.record(req.principal!.label, "team.create", d.id);
    return d.data;
  });
  r.get("/api/v1/teams/:id", { permission: "metadata.read" }, (req) => {
    const d = e.teams.require(req.params.id!);
    return { ...d.data, revision: d.revision, roster: e.roster.forTeam(d.id).map((m) => ({ ...m, player: e.players.get(m.playerId)?.data ?? null })) };
  });
  r.patch("/api/v1/teams/:id", { permission: "metadata.write" }, (req) => {
    const body = req.body as Record<string, unknown> & { revision?: number };
    const { revision, ...patch } = body;
    const d = e.teams.update(req.params.id!, patch, revision);
    e.audit.record(req.principal!.label, "team.update", d.id, patch);
    return d.data;
  });
  r.post("/api/v1/teams/:id/archive", { permission: "metadata.write" }, (req) => {
    e.teams.archive(req.params.id!, true);
    e.audit.record(req.principal!.label, "team.archive", req.params.id!);
    return { archived: true };
  });
  r.post("/api/v1/teams/:id/roster", { permission: "metadata.write", body: z.object({ playerId: z.string(), role: z.enum(["player", "substitute", "coach", "stand_in"]).default("player") }) }, (req) => {
    e.teams.require(req.params.id!);
    e.players.require(req.body.playerId);
    const m = e.roster.join(req.params.id!, req.body.playerId, req.body.role);
    e.audit.record(req.principal!.label, "roster.join", req.params.id!, { playerId: req.body.playerId, role: req.body.role });
    return m;
  });
  r.delete("/api/v1/teams/:id/roster/:playerId", { permission: "metadata.write" }, (req) => {
    e.roster.leave(req.params.id!, req.params.playerId!);
    e.audit.record(req.principal!.label, "roster.leave", req.params.id!, { playerId: req.params.playerId });
    return { left: true };
  });

  // ---- players -----------------------------------------------------------------------------
  r.get("/api/v1/players", { permission: "metadata.read" }, () =>
    e.players.list().map((d) => ({ ...d.data, revision: d.revision, teamId: e.roster.teamOf(d.id) })),
  );
  r.post("/api/v1/players", { permission: "metadata.write" }, (req) => {
    const body = req.body as Record<string, unknown>;
    if (typeof body.steamId === "string" && e.steamIndex.lookup(body.steamId)) throw new HttpError(409, "a player with this SteamID already exists", "duplicate_steamid");
    const d = e.players.create(body, "player");
    if (d.data.steamId) e.steamIndex.set(d.data.steamId, d.id);
    e.audit.record(req.principal!.label, "player.create", d.id);
    return d.data;
  });
  r.get("/api/v1/players/:id", { permission: "metadata.read" }, (req) => {
    const d = e.players.require(req.params.id!);
    return { ...d.data, revision: d.revision, history: e.roster.history(d.id) };
  });
  r.patch("/api/v1/players/:id", { permission: "metadata.write" }, (req) => {
    const { revision, ...patch } = req.body as Record<string, unknown> & { revision?: number };
    const before = e.players.require(req.params.id!).data;
    if (typeof patch.steamId === "string" && patch.steamId !== before.steamId) {
      const other = e.steamIndex.lookup(patch.steamId);
      if (other && other !== before.id) throw new HttpError(409, "SteamID already assigned to another player", "duplicate_steamid");
    }
    const d = e.players.update(req.params.id!, patch, revision);
    if (before.steamId && before.steamId !== d.data.steamId) e.steamIndex.remove(before.steamId);
    if (d.data.steamId) e.steamIndex.set(d.data.steamId, d.id);
    e.audit.record(req.principal!.label, "player.update", d.id, patch);
    return d.data;
  });
  /** Merge a duplicate into a primary player, preserving roster history and aliases. */
  r.post("/api/v1/players/:id/merge", { permission: "metadata.write", body: z.object({ duplicateId: z.string() }) }, (req) => {
    const primary = e.players.require(req.params.id!);
    const dup = e.players.require(req.body.duplicateId);
    const aliases = [...new Set([...primary.data.aliases, ...dup.data.aliases, dup.data.displayName].filter((a) => a !== primary.data.displayName))];
    e.db.transaction(() => {
      e.db.run("UPDATE roster_memberships SET player_id = ? WHERE player_id = ?", primary.id, dup.id);
      if (dup.data.steamId && !primary.data.steamId) e.steamIndex.set(dup.data.steamId, primary.id);
      else if (dup.data.steamId) e.steamIndex.remove(dup.data.steamId);
    });
    const merged = e.players.update(primary.id, { aliases, steamId: primary.data.steamId ?? dup.data.steamId });
    e.players.archive(dup.id, true);
    e.audit.record(req.principal!.label, "player.merge", primary.id, { duplicateId: dup.id });
    return merged.data;
  });

  /** CSV/JSON import preview with validation and duplicate detection; nothing is written. */
  const ImportRow = z.object({ displayName: z.string().min(1), realName: z.string().optional(), steamId: z.string().optional(), team: z.string().optional(), countryCode: z.string().optional() });
  r.post("/api/v1/import/players/preview", { permission: "metadata.write", body: z.object({ rows: z.array(z.unknown()).max(5000) }) }, (req) => {
    const existing = e.players.list();
    const byName = new Map(existing.map((p) => [normalizeName(p.data.displayName), p.id]));
    return req.body.rows.map((raw, i) => {
      const r2 = ImportRow.safeParse(raw);
      if (!r2.success) return { row: i, ok: false, errors: r2.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`) };
      const row = r2.data;
      const errors: string[] = [];
      if (row.steamId && !/^\d{17}$/.test(row.steamId)) errors.push("steamId must be a 17-digit SteamID64 string");
      const dupSteam = row.steamId ? e.steamIndex.lookup(row.steamId) : null;
      const dupName = byName.get(normalizeName(row.displayName)) ?? null;
      return { row: i, ok: errors.length === 0, errors, data: row, duplicateOf: dupSteam ?? dupName, duplicateReason: dupSteam ? "steamId" : dupName ? "name" : null };
    });
  });
  r.post("/api/v1/import/players/commit", { permission: "metadata.write", body: z.object({ rows: z.array(ImportRow).max(5000), skipDuplicates: z.boolean().default(true) }) }, (req) => {
    const created: string[] = [];
    const skipped: number[] = [];
    const teamsByName = new Map(e.teams.list().map((t) => [normalizeName(t.data.name), t.id]));
    req.body.rows.forEach((row, i) => {
      if (row.steamId && e.steamIndex.lookup(row.steamId)) {
        if (req.body.skipDuplicates) return void skipped.push(i);
      }
      const d = e.players.create({ displayName: row.displayName, realName: row.realName ?? null, steamId: row.steamId ?? null, countryCode: row.countryCode ?? null }, "player");
      if (d.data.steamId) e.steamIndex.set(d.data.steamId, d.id);
      const teamId = row.team ? teamsByName.get(normalizeName(row.team)) : undefined;
      if (teamId) e.roster.join(teamId, d.id);
      created.push(d.id);
    });
    e.audit.record(req.principal!.label, "import.players", null, { created: created.length, skipped: skipped.length });
    return { created, skipped };
  });

  // ---- events ------------------------------------------------------------------------------
  r.get("/api/v1/events", { permission: "metadata.read" }, () => e.events.list().map((d) => d.data));
  r.post("/api/v1/events", { permission: "metadata.write" }, (req) => {
    const d = e.events.create(req.body as Record<string, unknown>, "event");
    e.audit.record(req.principal!.label, "event.create", d.id);
    return d.data;
  });
  r.patch("/api/v1/events/:id", { permission: "metadata.write" }, (req) => {
    const { revision, ...patch } = req.body as Record<string, unknown> & { revision?: number };
    const d = e.events.update(req.params.id!, patch, revision);
    e.audit.record(req.principal!.label, "event.update", d.id, patch);
    return d.data;
  });

  // ---- matches -----------------------------------------------------------------------------
  const MatchCreate = z.object({
    eventId: z.string().nullable().default(null),
    stageId: z.string().nullable().default(null),
    teamAId: z.string(),
    teamBId: z.string(),
    format: MatchFormat.default({ bestOf: 3, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }),
    mapPool: z.array(z.string()).default([]),
    scheduledAt: z.string().nullable().default(null),
    title: z.string().nullable().default(null),
  });
  r.get("/api/v1/matches", { permission: "metadata.read" }, () => e.matches.list().map((d) => ({ ...d.data, maps: e.mapInstances.forMatch(d.id) })));
  r.post("/api/v1/matches", { permission: "metadata.write", body: MatchCreate }, (req) => {
    if (req.body.teamAId === req.body.teamBId) throw new HttpError(400, "a match needs two different teams", "same_team");
    e.teams.require(req.body.teamAId);
    e.teams.require(req.body.teamBId);
    if (req.body.stageId && !e.stages.get(req.body.stageId)) throw new HttpError(400, `unknown stage ${req.body.stageId}`, "bad_stage");
    const d = e.matches.create({ ...req.body, status: "scheduled", seriesScoreA: 0, seriesScoreB: 0 }, "match");
    e.audit.record(req.principal!.label, "match.create", d.id);
    return d.data;
  });
  r.get("/api/v1/matches/:id", { permission: "metadata.read" }, (req) => {
    const d = e.matches.require(req.params.id!);
    return { ...d.data, revision: d.revision, maps: e.mapInstances.forMatch(d.id), corrections: e.corrections.list().filter((c) => c.data.matchId === d.id).map((c) => c.data) };
  });
  r.patch("/api/v1/matches/:id", { permission: "metadata.write" }, (req) => {
    const { revision, ...patch } = req.body as Record<string, unknown> & { revision?: number };
    const d = e.matches.update(req.params.id!, patch, revision);
    e.audit.record(req.principal!.label, "match.update", d.id, patch);
    return d.data;
  });
  r.post("/api/v1/matches/:id/activate", { permission: "program.control" }, (req) => {
    e.matches.require(req.params.id!);
    e.setActiveMatch(req.params.id!);
    e.matches.update(req.params.id!, { status: "live" });
    e.audit.record(req.principal!.label, "match.activate", req.params.id!);
    return { active: req.params.id };
  });
  r.post("/api/v1/live/deactivate-match", { permission: "program.control" }, (req) => {
    e.setActiveMatch(null);
    e.audit.record(req.principal!.label, "match.deactivate", null);
    return { active: null };
  });

  r.put("/api/v1/matches/:id/maps", { permission: "metadata.write", body: z.object({ maps: z.array(MapInstanceSchema.partial({ id: true, matchId: true })) }) }, (req) => {
    const match = e.matches.require(req.params.id!).data;
    const existing = e.mapInstances.forMatch(match.id);
    for (const old of existing) if (!req.body.maps.some((m) => m.id === old.id)) e.mapInstances.remove(old.id);
    const saved: MapInstance[] = req.body.maps.map((m) => e.mapInstances.upsert({ ...m, id: m.id ?? newId("map"), matchId: match.id } as MapInstance));
    const s = seriesScore(match, saved);
    e.matches.update(match.id, { seriesScoreA: s.a, seriesScoreB: s.b, ...(s.winnerTeamId ? { status: "completed" } : {}) });
    e.audit.record(req.principal!.label, "match.maps.set", match.id, { maps: saved.length });
    return { maps: saved, series: s };
  });

  /** Records a map result under the configured rules; ties/unfinished maps never advance the series. */
  r.post("/api/v1/matches/:id/maps/:mapId/result", { permission: "metadata.write", body: z.object({ scoreA: z.number().int().min(0), scoreB: z.number().int().min(0), completed: z.boolean(), forfeitWinnerTeamId: z.string().optional() }) }, (req) => {
    const match = e.matches.require(req.params.id!).data;
    const mi = e.mapInstances.forMatch(match.id).find((m) => m.id === req.params.mapId);
    if (!mi) throw new HttpError(404, "map not found", "not_found");
    let winner: string | null;
    let status: MapInstance["status"];
    if (req.body.forfeitWinnerTeamId) {
      if (![match.teamAId, match.teamBId].includes(req.body.forfeitWinnerTeamId)) throw new HttpError(400, "forfeit winner must be a match team", "bad_team");
      winner = req.body.forfeitWinnerTeamId;
      status = "forfeited";
    } else {
      winner = mapWinner(match.format, req.body.scoreA, req.body.scoreB, match.teamAId, match.teamBId, req.body.completed);
      // A tie or undecided result stays open for correction instead of completing the map.
      status = winner ? "completed" : "live";
    }
    const updated = e.mapInstances.upsert({ ...mi, scoreA: req.body.scoreA, scoreB: req.body.scoreB, winnerTeamId: winner, status });
    const s = seriesScore(match, e.mapInstances.forMatch(match.id));
    e.matches.update(match.id, { seriesScoreA: s.a, seriesScoreB: s.b, status: s.winnerTeamId ? "completed" : match.status });
    e.audit.record(req.principal!.label, "map.result", mi.id, { ...req.body, winner });
    pushResultIfEnabled(e, match.id);
    return { map: updated, series: s, note: req.body.completed && !winner && !req.body.forfeitWinnerTeamId ? "Map tied or below the regulation win threshold: series not advanced." : null };
  });

  /** Operator stat correction: source value, corrected value, effective time and audit history. */
  r.post("/api/v1/matches/:id/corrections", { permission: "metadata.write", body: z.object({ mapInstanceId: z.string().nullable().default(null), steamId: z.string().nullable().default(null), field: z.string(), sourceValue: z.number().nullable(), correctedValue: z.number().nullable(), effectiveFromRound: z.number().int().nullable().default(null), reason: z.string().min(3) }) }, (req) => {
    e.matches.require(req.params.id!);
    const d = e.corrections.create({ ...req.body, matchId: req.params.id, operator: req.principal!.label, createdAt: new Date().toISOString() }, "corr");
    e.audit.record(req.principal!.label, "stat.correction", d.id, req.body);
    return d.data;
  });

  // ---- veto --------------------------------------------------------------------------------
  const stepsFor = (matchId: string) => {
    const match = e.matches.require(matchId).data;
    const custom = e.settings.get<unknown>(`veto.steps.${matchId}`, null);
    return { match, steps: (custom as ReturnType<typeof standardSequence> | null) ?? standardSequence(match.format.bestOf, match.mapPool.length) };
  };
  r.get("/api/v1/veto/:matchId", { permission: "metadata.read" }, (req) => {
    const { match, steps } = stepsFor(req.params.matchId!);
    return { ...e.veto.status(match, steps), history: e.vetoRepo.history(match.id) };
  });
  r.put("/api/v1/veto/:matchId/sequence", { permission: "metadata.write", body: z.object({ steps: z.array(z.object({ order: z.number().int().min(1), kind: z.enum(["ban", "pick", "decider", "side_choice"]), actor: z.enum(["A", "B"]).nullable() })) }) }, (req) => {
    if (e.vetoRepo.active(req.params.matchId!).length > 0) throw new HttpError(409, "veto already started; reset first", "veto_started");
    e.settings.set(`veto.steps.${req.params.matchId}`, req.body.steps);
    e.audit.record(req.principal!.label, "veto.sequence", req.params.matchId!, req.body.steps);
    return { steps: req.body.steps };
  });
  r.post("/api/v1/veto/:matchId/act", { permission: "metadata.write", body: z.object({ stepOrder: z.number().int(), teamId: z.string().nullable(), mapName: z.string().nullable().optional(), side: Side.nullable().optional() }) }, (req) => {
    const { match, steps } = stepsFor(req.params.matchId!);
    const d = e.veto.act(match, steps, { ...req.body, decidedBy: req.principal!.label });
    e.audit.record(req.principal!.label, "veto.act", match.id, d);
    return d;
  });
  /** Captain link action: token scope restricts the match and team; captains never read telemetry. */
  r.post("/api/v1/veto/:matchId/captain", { permission: "veto.captain", body: z.object({ stepOrder: z.number().int(), mapName: z.string().nullable().optional(), side: Side.nullable().optional() }) }, (req) => {
    const scope = req.principal!.scope;
    if (!scope?.matchId || scope.matchId !== req.params.matchId || !scope.teamId) throw new HttpError(403, "captain link not valid for this match", "scope");
    const { match, steps } = stepsFor(req.params.matchId!);
    const d = e.veto.act(match, steps, { ...req.body, teamId: scope.teamId, decidedBy: `captain:${req.principal!.label}` });
    e.audit.record(`captain:${req.principal!.label}`, "veto.captain_act", match.id, d);
    return d;
  });
  r.get("/api/v1/veto/:matchId/captain-view", { permission: "veto.captain" }, (req) => {
    const scope = req.principal!.scope;
    if (!scope?.matchId || scope.matchId !== req.params.matchId) throw new HttpError(403, "captain link not valid for this match", "scope");
    const { match, steps } = stepsFor(req.params.matchId!);
    const st = e.veto.status(match, steps);
    const team = (id: string) => e.teams.get(id)?.data.name ?? id;
    return { match: { teamA: team(match.teamAId), teamB: team(match.teamBId), yourTeam: team(scope.teamId!), yourSlot: scope.teamId === match.teamAId ? "A" : "B" }, steps: st.steps, decisions: st.decisions.map((d) => ({ stepOrder: d.stepOrder, kind: d.kind, mapName: d.mapName, side: d.side })), currentStep: st.currentStep, remainingMaps: st.remainingMaps, complete: st.complete };
  });
  r.post("/api/v1/veto/:matchId/revise", { permission: "metadata.write", body: z.object({ stepOrder: z.number().int(), teamId: z.string().nullable(), mapName: z.string().nullable().optional(), side: Side.nullable().optional(), reason: z.string().min(3) }) }, (req) => {
    const { match } = stepsFor(req.params.matchId!);
    const next = { id: newId("veto"), matchId: match.id, stepOrder: req.body.stepOrder, kind: e.vetoRepo.active(match.id).find((d) => d.stepOrder === req.body.stepOrder)?.kind ?? "ban", teamId: req.body.teamId, mapName: req.body.mapName ?? null, side: req.body.side ?? null, decidedBy: req.principal!.label, decidedAt: new Date().toISOString(), revisionOf: null };
    const d = e.vetoRepo.revise(match.id, req.body.stepOrder, next);
    e.audit.record(req.principal!.label, "veto.revise", match.id, { ...d, reason: req.body.reason });
    return d;
  });
  r.post("/api/v1/veto/:matchId/apply-to-maps", { permission: "metadata.write" }, (req) => {
    const { match, steps } = stepsFor(req.params.matchId!);
    const st = e.veto.status(match, steps);
    if (!st.complete) throw new HttpError(409, "veto not complete", "incomplete");
    const maps = st.pickedMaps.map((p, i) =>
      e.mapInstances.upsert({
        id: newId("map"),
        matchId: match.id,
        order: i + 1,
        mapName: p.mapName,
        pickedByTeamId: p.pickedBy === "A" ? match.teamAId : p.pickedBy === "B" ? match.teamBId : null,
        isDecider: p.decider,
        startingCtTeamId: p.startingSide ? ((p.startingSide.side === "CT") === (p.startingSide.team === "A") ? match.teamAId : match.teamBId) : null,
        status: "upcoming",
        scoreA: 0,
        scoreB: 0,
        winnerTeamId: null,
        mapRevision: null,
      }),
    );
    for (const old of e.mapInstances.forMatch(match.id)) if (!maps.some((m) => m.id === old.id)) e.mapInstances.remove(old.id);
    e.audit.record(req.principal!.label, "veto.apply", match.id, { maps: maps.map((m) => m.mapName) });
    return { maps };
  });
  r.post("/api/v1/veto/:matchId/reset", { permission: "metadata.write", body: z.object({ reason: z.string().min(3) }) }, (req) => {
    e.vetoRepo.reset(req.params.matchId!);
    e.audit.record(req.principal!.label, "veto.reset", req.params.matchId!, { reason: req.body.reason });
    return { reset: true };
  });

  // ---- sponsors / rundown / automation rules ---------------------------------------------
  for (const [path, repo, prefix] of [
    ["sponsors", e.sponsors, "sponsor"],
    ["rundown", e.rundown, "cue"],
  ] as const) {
    r.get(`/api/v1/${path}`, { permission: "metadata.read" }, () => (repo as typeof e.sponsors).list().map((d) => d.data));
    r.post(`/api/v1/${path}`, { permission: "metadata.write" }, (req) => {
      const d = (repo as typeof e.sponsors).create(req.body as Record<string, unknown>, prefix);
      e.audit.record(req.principal!.label, `${prefix}.create`, d.id);
      return d.data;
    });
    r.patch(`/api/v1/${path}/:id`, { permission: "metadata.write" }, (req) => {
      const d = (repo as typeof e.sponsors).update(req.params.id!, req.body as Record<string, unknown>);
      e.audit.record(req.principal!.label, `${prefix}.update`, d.id);
      return d.data;
    });
    r.delete(`/api/v1/${path}/:id`, { permission: "metadata.write" }, (req) => {
      (repo as typeof e.sponsors).delete(req.params.id!);
      e.audit.record(req.principal!.label, `${prefix}.delete`, req.params.id!);
      return { deleted: true };
    });
  }
  r.get("/api/v1/sponsors/deliveries", { permission: "metadata.read" }, () =>
    e.db.all("SELECT sponsor_id AS sponsorId, output_id AS outputId, zone, shown_at AS shownAt, hidden_at AS hiddenAt, duration_ms AS durationMs, acknowledged FROM sponsor_deliveries ORDER BY seq DESC LIMIT 500"),
  );

  r.get("/api/v1/automation/rules", { permission: "metadata.read" }, () => e.rules.list().map((d) => d.data));
  r.post("/api/v1/automation/rules", { permission: "settings.manage" }, (req) => {
    const d = e.rules.create(req.body as Record<string, unknown>, "rule");
    e.ruleEngine.setRules(e.rules.list().map((x) => x.data));
    e.audit.record(req.principal!.label, "rule.create", d.id, d.data);
    return d.data;
  });
  r.patch("/api/v1/automation/rules/:id", { permission: "settings.manage" }, (req) => {
    const d = e.rules.update(req.params.id!, req.body as Record<string, unknown>);
    e.ruleEngine.setRules(e.rules.list().map((x) => x.data));
    e.audit.record(req.principal!.label, "rule.update", d.id, req.body);
    return d.data;
  });
  r.delete("/api/v1/automation/rules/:id", { permission: "settings.manage" }, (req) => {
    e.rules.delete(req.params.id!);
    e.ruleEngine.setRules(e.rules.list().map((x) => x.data));
    e.audit.record(req.principal!.label, "rule.delete", req.params.id!);
    return { deleted: true };
  });
  r.get("/api/v1/automation/log", { permission: "metadata.read" }, () => e.ruleEngine.log.slice(-300));
  r.post("/api/v1/automation/simulate", { permission: "settings.manage", body: z.object({ kind: z.string(), data: z.record(z.string(), z.unknown()).default({}), programMode: z.string().optional() }) }, async (req) => {
    // Event simulator for dry-running rules: executes only rules marked dryRun or reports what would fire.
    const results = await e.ruleEngine.onEvent(
      { eventId: `sim_${Date.now()}`, kind: req.body.kind as never, epoch: e.session.state()?.epoch ?? 0, observedAtMs: e.now(), data: req.body.data },
      { programMode: (req.body.programMode ?? e.program.mode) as never, capabilities: {}, phase: null },
    );
    return results;
  });

  // ---- event stages: standings and brackets (derived from completed results) --------------
  const StageBody = z.object({
    eventId: z.string(),
    name: z.string().min(1).max(80),
    kind: StageKind,
    order: z.number().int().min(1).optional(),
    teamIds: z.array(z.string()).optional(),
    points: z.object({ win: z.number(), tie: z.number(), loss: z.number() }).optional(),
    tiebreakers: z.array(StageTiebreaker).optional(),
    advancing: z.number().int().min(0).optional(),
    bracket: z.array(BracketNode).optional(),
  });
  const checkStage = (body: { eventId?: string; teamIds?: string[]; bracket?: z.infer<typeof BracketNode>[] }) => {
    if (body.eventId && !e.events.get(body.eventId)) throw new HttpError(400, `unknown event ${body.eventId}`, "bad_event");
    for (const t of body.teamIds ?? []) if (!e.teams.get(t)) throw new HttpError(400, `unknown team ${t}`, "bad_team");
    const issues = validateBracket(body.bracket ?? []);
    if (issues.length) throw new HttpError(400, "invalid bracket", "bad_bracket", issues);
    for (const n of body.bracket ?? []) if (n.matchId && !e.matches.get(n.matchId)) throw new HttpError(400, `unknown match ${n.matchId}`, "bad_match");
  };
  r.get("/api/v1/stages", { permission: "metadata.read" }, (req) => {
    const ev = req.query.get("eventId");
    return e.stages.list().map((d) => d.data).filter((s) => !ev || s.eventId === ev).sort((a, b) => a.order - b.order);
  });
  r.post("/api/v1/stages", { permission: "metadata.write", body: StageBody }, (req) => {
    checkStage(req.body);
    const d = e.stages.create(req.body, "stage");
    e.audit.record(req.principal!.label, "stage.create", d.id);
    return d.data;
  });
  r.patch("/api/v1/stages/:id", { permission: "metadata.write", body: StageBody.partial() }, (req) => {
    checkStage(req.body);
    const d = e.stages.update(req.params.id!, req.body);
    e.audit.record(req.principal!.label, "stage.update", d.id);
    return d.data;
  });
  r.delete("/api/v1/stages/:id", { permission: "metadata.write" }, (req) => {
    e.stages.delete(req.params.id!);
    e.audit.record(req.principal!.label, "stage.delete", req.params.id!);
    return { deleted: true };
  });
  const stageInputs = (id: string) => {
    const stage = e.stages.require(id).data;
    const matches = e.matches.list().map((d) => d.data).filter((m) => m.stageId === stage.id || stage.bracket.some((n) => n.matchId === m.id));
    const maps = matches.flatMap((m) => e.mapInstances.forMatch(m.id));
    return { stage, matches, maps };
  };
  const teamInfo = (id: string | null) => {
    const t = id ? e.teams.get(id)?.data : undefined;
    return t ? { id: t.id, name: t.name, shortName: t.shortName, logoAssetId: t.logoAssetId } : null;
  };
  r.get("/api/v1/stages/:id/standings", { permission: "metadata.read" }, (req) => {
    const { stage, matches, maps } = stageInputs(req.params.id!);
    const res = computeStandings(stage, matches, maps);
    return { ...res, name: stage.name, tiebreakers: stage.tiebreakers, rows: res.rows.map((row) => ({ ...row, team: teamInfo(row.teamId) })) };
  });
  r.get("/api/v1/stages/:id/bracket", { permission: "metadata.read" }, (req) => {
    const { stage, matches } = stageInputs(req.params.id!);
    return { stageId: stage.id, name: stage.name, nodes: buildBracket(stage, matches).map((n) => ({ ...n, a: { ...n.a, team: teamInfo(n.a.teamId) }, b: { ...n.b, team: teamInfo(n.b.teamId) } })) };
  });

  // ---- event package export / import ----------------------------------------------------
  r.get("/api/v1/export/event-package", { permission: "metadata.read" }, () => {
    const assets: Record<string, string> = {};
    const dir = assetDir(e);
    const usedAssets = new Set<string>();
    for (const t of e.teams.list()) if (t.data.logoAssetId) usedAssets.add(t.data.logoAssetId);
    for (const p of e.players.list()) if (p.data.avatarAssetId) usedAssets.add(p.data.avatarAssetId);
    for (const s of e.sponsors.list()) for (const a of s.data.assetIds) usedAssets.add(a);
    for (const ev of e.events.list()) if (ev.data.logoAssetId) usedAssets.add(ev.data.logoAssetId);
    for (const a of usedAssets) if (existsSync(join(dir, a))) assets[a] = readFileSync(join(dir, a)).toString("base64");
    const pkg = {
      format: "matchframe-event-package",
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      app: "0.1.0",
      schemaVersion: e.db.schemaVersion,
      data: {
        teams: e.teams.list({ includeArchived: true }).map((d) => d.data),
        players: e.players.list({ includeArchived: true }).map((d) => d.data),
        rosters: e.db.all("SELECT id, team_id AS teamId, player_id AS playerId, role, valid_from AS validFrom, valid_to AS validTo FROM roster_memberships"),
        events: e.events.list().map((d) => d.data),
        matches: e.matches.list().map((d) => d.data),
        mapInstances: e.db.all<{ data: string }>("SELECT data FROM map_instances").map((x) => JSON.parse(x.data)),
        vetoDecisions: e.db.all<{ data: string; superseded_by: string | null }>("SELECT data, superseded_by FROM veto_decisions").map((x) => ({ ...JSON.parse(x.data), supersededBy: x.superseded_by })),
        sponsors: e.sponsors.list().map((d) => d.data),
        rundown: e.rundown.list().map((d) => d.data),
        stages: e.stages.list().map((d) => d.data),
        rules: e.rules.list().map((d) => d.data),
        outputs: e.outputs.drafts.list().map((d) => d.data),
        corrections: e.corrections.list().map((d) => d.data),
      },
      assets,
      // Secrets (tokens, passwords, stream keys) are never exported.
    };
    const body = JSON.stringify(pkg);
    const checksum = createHash("sha256").update(body).digest("hex");
    return { json: { ...pkg, checksum }, headers: { "content-disposition": `attachment; filename="matchframe-event-${Date.now()}.json"` } };
  });

  r.post("/api/v1/import/event-package", { permission: "settings.manage", body: z.object({ package: z.record(z.string(), z.unknown()), mode: z.enum(["preview", "commit"]).default("preview") }) }, (req) => {
    const pkg = req.body.package as { format?: string; formatVersion?: number; checksum?: string; data?: Record<string, unknown[]>; assets?: Record<string, string> };
    if (pkg.format !== "matchframe-event-package" || pkg.formatVersion !== 1) throw new HttpError(400, "not a Matchframe event package (v1)", "bad_format");
    const { checksum, ...rest } = pkg;
    const actual = createHash("sha256").update(JSON.stringify(rest)).digest("hex");
    if (checksum !== actual) throw new HttpError(400, "checksum mismatch: package is corrupt or modified", "checksum");
    const data = pkg.data ?? {};
    const collisions: { kind: string; id: string }[] = [];
    const check = (kind: string, list: unknown[] | undefined, get: (id: string) => unknown) => {
      for (const it of list ?? []) {
        const id = (it as { id?: string }).id;
        if (id && get(id)) collisions.push({ kind, id });
      }
    };
    check("team", data.teams, (id) => e.teams.get(id));
    check("player", data.players, (id) => e.players.get(id));
    check("event", data.events, (id) => e.events.get(id));
    check("match", data.matches, (id) => e.matches.get(id));
    const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
    if (req.body.mode === "preview") return { ok: true, counts, collisions, assets: Object.keys(pkg.assets ?? {}).length };
    if (collisions.length > 0) throw new HttpError(409, `${collisions.length} id collisions; resolve before restoring`, "collisions", collisions);
    e.db.transaction(() => {
      for (const t of data.teams ?? []) e.teams.create(t as Record<string, unknown>);
      for (const p of data.players ?? []) {
        const d = e.players.create(p as Record<string, unknown>);
        if (d.data.steamId) e.steamIndex.set(d.data.steamId, d.id);
      }
      for (const m of (data.rosters ?? []) as { id: string; teamId: string; playerId: string; role: string; validFrom: string; validTo: string | null }[]) {
        e.db.run("INSERT OR IGNORE INTO roster_memberships (id, team_id, player_id, role, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)", m.id, m.teamId, m.playerId, m.role, m.validFrom, m.validTo);
      }
      for (const ev of data.events ?? []) e.events.create(ev as Record<string, unknown>);
      for (const m of data.matches ?? []) e.matches.create(m as Record<string, unknown>);
      for (const mi of data.mapInstances ?? []) e.mapInstances.upsert(mi as MapInstance);
      for (const s of data.sponsors ?? []) if (!e.sponsors.get((s as { id: string }).id)) e.sponsors.create(s as Record<string, unknown>);
      for (const c of data.rundown ?? []) if (!e.rundown.get((c as { id: string }).id)) e.rundown.create(c as Record<string, unknown>);
      for (const st of data.stages ?? []) if (!e.stages.get((st as { id: string }).id)) e.stages.create(st as Record<string, unknown>);
    });
    const dir = assetDir(e);
    mkdirSync(dir, { recursive: true });
    for (const [id, b64] of Object.entries(pkg.assets ?? {})) {
      if (!/^[0-9a-f]{24}\.[a-z0-9]+$/.test(id)) continue;
      const buf = Buffer.from(b64, "base64");
      if (createHash("sha256").update(buf).digest("hex").slice(0, 24) !== id.slice(0, 24)) continue;
      writeFileSync(join(dir, id), buf);
    }
    e.audit.record(req.principal!.label, "import.event_package", null, counts);
    return { ok: true, restored: counts };
  });
}
