import type { MapInstance, Match, VetoDecision, VetoEntry } from "@matchframe/contracts";
import { planMaps, sideChooser } from "@matchframe/contracts/veto-entries";
import { newId } from "../db/store.ts";

/**
 * The captain veto's active decisions as editor entries: bans, picks and the decider in step order;
 * each side choice goes onto the map it follows (as the starting side of the team that chooses on
 * it by the entry rules, so a choice made by the picker itself is stored as the opposite side).
 */
export function vetoEntriesFromDecisions(match: Pick<Match, "teamAId" | "teamBId">, decisions: readonly VetoDecision[]): VetoEntry[] {
  const out: VetoEntry[] = [];
  let lastMap = -1;
  for (const d of [...decisions].sort((a, b) => a.stepOrder - b.stepOrder)) {
    if ((d.kind === "ban" || d.kind === "pick" || d.kind === "decider") && d.mapName) {
      out.push({ id: `cv_${d.stepOrder}`, type: d.kind, teamId: d.kind === "decider" ? null : d.teamId, mapName: d.mapName, sideChoice: null, reversedSides: false });
      if (d.kind !== "ban") lastMap = out.length - 1;
    } else if (d.kind === "side_choice" && d.side && lastMap >= 0) {
      const chooser = sideChooser(out, lastMap, match.teamAId, match.teamBId);
      const side = chooser && d.teamId && d.teamId !== chooser ? (d.side === "CT" ? "T" : "CT") : d.side;
      out[lastMap] = { ...out[lastMap]!, sideChoice: side };
    }
  }
  return out;
}

/** Entries for a match that has maps but no veto entries (older matches): its picks and decider. */
export function vetoEntriesFromMaps(match: Pick<Match, "teamAId" | "teamBId">, maps: readonly MapInstance[]): VetoEntry[] {
  return [...maps]
    .sort((a, b) => a.order - b.order)
    .map((m) => {
      const picker = m.isDecider ? null : m.pickedByTeamId;
      const opponent = picker === match.teamAId ? match.teamBId : picker === match.teamBId ? match.teamAId : null;
      const sideChoice = m.startingCtTeamId && opponent ? (m.startingCtTeamId === opponent ? "CT" : "T") : null;
      return { id: `mp_${m.id}`, type: m.isDecider || !picker ? "decider" : "pick", teamId: picker, mapName: m.mapName, sideChoice: m.isDecider ? null : sideChoice, reversedSides: false } as VetoEntry;
    });
}

export type VetoEntriesSource = "match" | "captain" | "maps" | "none";

/**
 * The veto the editor and HUDs show for a match: the operator's entries when set (manual edits are
 * corrections that take precedence), else the captain veto's decisions, else the match's maps.
 */
export function effectiveVetoEntries(match: Match, decisions: readonly VetoDecision[], maps: readonly MapInstance[]): { entries: VetoEntry[]; source: VetoEntriesSource } {
  if (match.veto?.length) return { entries: match.veto, source: "match" };
  if (decisions.some((d) => d.mapName)) return { entries: vetoEntriesFromDecisions(match, decisions), source: "captain" };
  if (maps.length) return { entries: vetoEntriesFromMaps(match, maps), source: "maps" };
  return { entries: [], source: "none" };
}

/** A map with anything played on it: never replaced or removed by a veto edit. */
export function mapHasResult(m: MapInstance): boolean {
  return m.status !== "upcoming" || m.scoreA > 0 || m.scoreB > 0 || m.winnerTeamId !== null;
}

export class PlayedMapError extends Error {
  readonly status = 409;
  readonly code = "played_map";
}

/**
 * The match's maps for a veto: picks and the decider in order. A map that stays the same map in the
 * same place keeps its id, status and round scores; a map with a result can never be replaced or
 * removed (PlayedMapError). Returns the full new list and the instances to delete.
 */
export function deriveMapInstances(match: Pick<Match, "id" | "teamAId" | "teamBId">, entries: readonly VetoEntry[], existing: readonly MapInstance[]): { maps: MapInstance[]; removed: MapInstance[] } {
  const plan = planMaps(entries, match.teamAId, match.teamBId);
  const byOrder = new Map(existing.map((m) => [m.order, m]));
  const maps: MapInstance[] = plan.map((p) => {
    const cur = byOrder.get(p.order);
    if (cur && cur.mapName === p.mapName) return { ...cur, pickedByTeamId: p.pickedByTeamId, isDecider: p.isDecider, startingCtTeamId: p.startingCtTeamId };
    if (cur && mapHasResult(cur)) throw new PlayedMapError(`Map ${cur.order} (${cur.mapName}) has a recorded result (${cur.scoreA}–${cur.scoreB}, ${cur.status}); the veto cannot replace it with ${p.mapName}. Correct or clear the result first.`);
    return { id: newId("map"), matchId: match.id, order: p.order, mapName: p.mapName, pickedByTeamId: p.pickedByTeamId, isDecider: p.isDecider, startingCtTeamId: p.startingCtTeamId, status: "upcoming", scoreA: 0, scoreB: 0, winnerTeamId: null, mapRevision: null };
  });
  const keep = new Set(maps.map((m) => m.id));
  const removed = existing.filter((m) => !keep.has(m.id));
  const played = removed.find(mapHasResult);
  if (played) throw new PlayedMapError(`Map ${played.order} (${played.mapName}) has a recorded result (${played.scoreA}–${played.scoreB}, ${played.status}); the veto cannot remove it. Correct or clear the result first.`);
  return { maps, removed };
}

/** One veto line in the shape imported HUDs read from `/api/match` (`vetos`). */
export interface HudVetoEntry {
  teamId: string;
  mapName: string;
  /** The opponent's starting-side choice; "NO" when not chosen (and on bans). */
  side: "CT" | "T" | "NO";
  type: "pick" | "ban" | "decider";
  reverseSide: boolean;
  /** The map has finished (completed or forfeited). */
  mapEnd: boolean;
  winner?: string;
  /** Round score per team id, for picked maps and the decider. */
  score?: Record<string, number>;
}

/**
 * The veto list for imported HUDs: every entry in order (bans included) with the picking team,
 * side choice, type and reversed sides, and for maps that are played their end, winner and score.
 * Pass the match's effective entries (effectiveVetoEntries) and its map instances.
 */
export function hudVetoEntries(match: Pick<Match, "teamAId" | "teamBId">, entries: readonly VetoEntry[], maps: readonly MapInstance[]): HudVetoEntry[] {
  const ordered = [...maps].sort((a, b) => a.order - b.order);
  let mapIndex = 0;
  return entries.map((e) => {
    const base: HudVetoEntry = { teamId: e.teamId ?? "", mapName: e.mapName, side: e.type === "ban" ? "NO" : (e.sideChoice ?? "NO"), type: e.type, reverseSide: e.reversedSides, mapEnd: false };
    if (e.type === "ban") return base;
    const mi = ordered[mapIndex++];
    if (!mi || mi.mapName !== e.mapName) return base;
    return {
      ...base,
      mapEnd: mi.status === "completed" || mi.status === "forfeited",
      ...(mi.winnerTeamId ? { winner: mi.winnerTeamId } : {}),
      score: { [match.teamAId]: mi.scoreA, [match.teamBId]: mi.scoreB },
    };
  });
}

/**
 * Convenience for the imported-HUD API: the veto list of a match from the repositories' data
 * (its own entries, else the captain decisions, else its maps).
 */
export function hudVetoList(match: Match, decisions: readonly VetoDecision[], maps: readonly MapInstance[]): HudVetoEntry[] {
  return hudVetoEntries(match, effectiveVetoEntries(match, decisions, maps).entries, maps);
}
