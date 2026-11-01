/**
 * Map veto entries and series rules shared by the engine (authoritative checks) and the console
 * (the same checks while editing). Plain functions with no dependencies, so the console can import
 * them without pulling in the schemas (`@matchframe/contracts/veto-entries`).
 */

export type VetoEntryType = "pick" | "ban" | "decider";
export type StartSide = "CT" | "T";

export interface VetoEntryLike {
  id: string;
  type: VetoEntryType;
  teamId: string | null;
  mapName: string;
  sideChoice: StartSide | null;
  reversedSides: boolean;
}

export interface VetoIssue {
  /** Index of the entry (null: the veto as a whole). */
  index: number | null;
  field: "type" | "teamId" | "mapName" | "sideChoice" | "veto";
  message: string;
}

/** Maps a team needs to win the series (BO1 1, BO2 2, BO3 2, BO5 3). */
export function winsNeeded(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/** The maps an entry list plays: picks and the decider, in order. */
export function playedEntries<T extends VetoEntryLike>(entries: readonly T[]): T[] {
  return entries.filter((e) => e.type === "pick" || e.type === "decider");
}

/** A veto is complete once it names every map of the series (a decider always ends it). */
export function vetoComplete(entries: readonly VetoEntryLike[], bestOf: number): boolean {
  return playedEntries(entries).length >= bestOf || entries.some((e) => e.type === "decider");
}

/**
 * Checks an ordered entry list. An incomplete veto is fine (a fixture prepared in advance); what is
 * never allowed: a map twice, a map outside the pool, a decider with a team, a pick or ban without
 * one, entries after the decider, or more maps than the series plays.
 */
export function validateVetoEntries(entries: readonly VetoEntryLike[], ctx: { teamAId: string; teamBId: string; bestOf: number; pool: readonly string[] }): VetoIssue[] {
  const issues: VetoIssue[] = [];
  const seen = new Map<string, number>();
  const pool = new Set(ctx.pool);
  let deciderAt = -1;
  entries.forEach((e, i) => {
    const n = i + 1;
    if (!e.mapName) issues.push({ index: i, field: "mapName", message: `Entry ${n}: choose a map` });
    else if (pool.size > 0 && !pool.has(e.mapName)) issues.push({ index: i, field: "mapName", message: `Entry ${n}: ${e.mapName} is not in the map pool` });
    const first = seen.get(e.mapName);
    if (e.mapName && first !== undefined) issues.push({ index: i, field: "mapName", message: `Entry ${n}: ${e.mapName} is already used in entry ${first + 1}` });
    else if (e.mapName) seen.set(e.mapName, i);
    if (e.type === "decider") {
      if (e.teamId) issues.push({ index: i, field: "teamId", message: `Entry ${n}: a decider has no team` });
      if (deciderAt >= 0) issues.push({ index: i, field: "type", message: `Entry ${n}: there is already a decider (entry ${deciderAt + 1})` });
      else deciderAt = i;
    } else {
      if (!e.teamId) issues.push({ index: i, field: "teamId", message: `Entry ${n}: choose the team that ${e.type === "ban" ? "bans" : "picks"} this map` });
      else if (e.teamId !== ctx.teamAId && e.teamId !== ctx.teamBId) issues.push({ index: i, field: "teamId", message: `Entry ${n}: the team is not one of this match's teams` });
      if (deciderAt >= 0 && i > deciderAt) issues.push({ index: i, field: "type", message: `Entry ${n}: nothing can follow the decider` });
    }
    if (e.type === "ban" && e.sideChoice) issues.push({ index: i, field: "sideChoice", message: `Entry ${n}: a banned map has no starting side` });
  });
  const maps = playedEntries(entries).length;
  if (maps > ctx.bestOf) issues.push({ index: null, field: "veto", message: `BO${ctx.bestOf} plays ${ctx.bestOf} map${ctx.bestOf === 1 ? "" : "s"}; this veto has ${maps}` });
  else if (deciderAt >= 0 && maps !== ctx.bestOf) issues.push({ index: deciderAt, field: "type", message: `The decider ends the veto: BO${ctx.bestOf} needs ${ctx.bestOf - 1} pick${ctx.bestOf - 1 === 1 ? "" : "s"} before it (this veto has ${maps - 1})` });
  return issues;
}

/** The team that chooses the starting side on an entry's map (the opponent of the picker; on the decider, the team that did not make the last ban before it). */
export function sideChooser(entries: readonly VetoEntryLike[], index: number, teamAId: string, teamBId: string): string | null {
  const e = entries[index];
  if (!e) return null;
  const other = (id: string | null) => (id === teamAId ? teamBId : id === teamBId ? teamAId : null);
  if (e.type === "pick") return other(e.teamId);
  if (e.type !== "decider") return null;
  for (let i = index - 1; i >= 0; i--) if (entries[i]!.type === "ban") return other(entries[i]!.teamId);
  return null;
}

/** The team starting CT on an entry's map, from the side choice and Reversed sides; null when not chosen. */
export function startingCtTeam(entries: readonly VetoEntryLike[], index: number, teamAId: string, teamBId: string): string | null {
  const e = entries[index];
  if (!e || !e.sideChoice) return null;
  const chooser = sideChooser(entries, index, teamAId, teamBId);
  if (!chooser) return null;
  const other = chooser === teamAId ? teamBId : teamAId;
  const ct = e.sideChoice === "CT" ? chooser : other;
  return e.reversedSides ? (ct === teamAId ? teamBId : teamAId) : ct;
}

export interface PlannedMap {
  order: number;
  mapName: string;
  pickedByTeamId: string | null;
  isDecider: boolean;
  startingCtTeamId: string | null;
  entryId: string;
}

/** The maps an entry list plays, in order, with picker, decider flag and starting CT team. */
export function planMaps(entries: readonly VetoEntryLike[], teamAId: string, teamBId: string): PlannedMap[] {
  const out: PlannedMap[] = [];
  entries.forEach((e, i) => {
    if (e.type === "ban" || !e.mapName) return;
    out.push({ order: out.length + 1, mapName: e.mapName, pickedByTeamId: e.type === "pick" ? e.teamId : null, isDecider: e.type === "decider", startingCtTeamId: startingCtTeam(entries, i, teamAId, teamBId), entryId: e.id });
  });
  return out;
}

/** Checks a series score (maps won by each team) against the format: nobody past the wins needed, not both winners, no more maps than the series has. */
export function validateSeriesScore(a: number, b: number, bestOf: number): string | null {
  const need = winsNeeded(bestOf);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return "Series wins are whole numbers from 0";
  if (a > need || b > need) return `In BO${bestOf} a team wins the series with ${need} map${need === 1 ? "" : "s"}; ${Math.max(a, b)} is too many`;
  if (a === need && b === need) return "Both teams cannot have won the series";
  if (a + b > bestOf) return `BO${bestOf} has ${bestOf} map${bestOf === 1 ? "" : "s"}; ${a}–${b} adds up to ${a + b}`;
  return null;
}

/** SteamID64 of a person's Steam account: 17 digits starting 7656119. Returns an error message, or null when valid. */
export function steamId64Problem(value: string): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return "SteamID64 is a number of 17 digits (e.g. 7656119…); letters, spaces and STEAM_0:… forms are not accepted";
  if (v.length !== 17) return `SteamID64 has 17 digits; this one has ${v.length}`;
  if (!v.startsWith("7656119")) return "SteamID64 starts with 7656119";
  return null;
}
