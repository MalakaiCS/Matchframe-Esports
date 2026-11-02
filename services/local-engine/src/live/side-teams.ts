import type { Match, MatchState, Side } from "@matchframe/contracts";

/** How the active match's teams were placed on the game's sides. */
export type SideTeamsHow = "roster" | "names" | "players" | "veto" | "assumed" | "swapped";

export interface SideTeamsResult {
  CT: string | null;
  T: string | null;
  /** null: no active match, or no game data yet. */
  how: SideTeamsHow | null;
}

export interface SideTeamsLookup {
  /** A saved team's name and short name. */
  team(id: string): { name: string; shortName: string } | null;
  /** The team that starts the map on CT, from the match's veto (null: not chosen). */
  startingCt(match: Match, mapName: string | null): string | null;
  /** The operator's Swap teams, kept across restarts: the match and map it applies to (null: none). */
  loadSwap?(): string | null;
  saveSwap?(key: string | null): void;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Puts the active match's two teams on the game's sides, so every HUD shows their names, logos and
 * series even when the game data can't identify them by itself. In order:
 * 1. **roster**: the game data's own identification (3 or more of a side's players on a team's
 *    roster by SteamID64); one side identified is enough, the other side is the other team;
 * 2. **names**: CS2's team names (mp_teamname_1/2) equal to a team's name or short name;
 * 3. **players**: fewer rostered players, as long as they point to one team without conflict;
 * 4. **veto**: the map's starting side from the match's veto (regulation only);
 * 5. **assumed**: Team 1 on the side its players were first seen on, CT first.
 * From 4 and 5 on, the teams follow their players across halftime (by SteamID64). The operator's
 * Swap teams (button, hotkey or Stream Deck) flips whatever was decided, for that match and map,
 * and the teams keep following their players after it.
 */
export class SideTeams {
  /** Players of the team bound by veto/assumption (and the operator's swap), per match and map. */
  private binding: { key: string; teamId: string; players: Set<string>; how: "veto" | "assumed" } | null = null;
  /** undefined: not loaded yet (the engine's settings may not exist while it is being built). */
  private swappedKey: string | null | undefined = undefined;
  /** The match and map of the last placement (what Swap teams applies to). */
  private lastKey: string | null = null;
  private last: SideTeamsResult = { CT: null, T: null, how: null };

  constructor(private readonly lookup: SideTeamsLookup) {}

  private swapped(): string | null {
    if (this.swappedKey === undefined) this.swappedKey = this.lookup.loadSwap?.() ?? null;
    return this.swappedKey;
  }

  /** The last placement (for the console). */
  status(): SideTeamsResult {
    return this.last;
  }

  /** Swap teams: flips the two teams on the current match and map (again: back). False with nothing to swap. */
  swap(): boolean {
    if (!this.lastKey || !this.last.CT || !this.last.T) return false;
    this.setSwapped(this.swapped() === this.lastKey ? null : this.lastKey);
    return true;
  }

  /** Forgets the swap (the players were saved to their teams: the game data now places them itself). */
  clearSwap(): void {
    this.setSwapped(null);
  }

  private setSwapped(key: string | null): void {
    this.swappedKey = key;
    this.lookup.saveSwap?.(key);
  }

  /** A copy of the state with both sides' team ids filled from the active match where the game data has none. */
  apply(state: MatchState, match: Match | null): MatchState {
    const r = this.resolve(state, match);
    if (r.CT === state.teams.CT.teamId && r.T === state.teams.T.teamId) return state;
    return { ...state, teams: { CT: { ...state.teams.CT, teamId: r.CT }, T: { ...state.teams.T, teamId: r.T } } };
  }

  resolve(state: MatchState, match: Match | null): SideTeamsResult {
    if (!match || state.players.length === 0) {
      this.lastKey = null;
      const ids = { CT: state.teams.CT.teamId, T: state.teams.T.teamId };
      this.last = { ...ids, how: ids.CT || ids.T ? "roster" : null };
      return this.last;
    }
    const key = `${match.id}|${state.mapName ?? ""}`;
    this.lastKey = key;
    const r = this.place(state, match, key);
    // The operator's Swap teams for this match and map.
    this.last = this.swapped() === key && r.CT && r.T ? { CT: r.T, T: r.CT, how: "swapped" } : r;
    return this.last;
  }

  private place(state: MatchState, match: Match, key: string): SideTeamsResult {
    const ids = { CT: state.teams.CT.teamId, T: state.teams.T.teamId };
    const pair = [match.teamAId, match.teamBId];
    const other = (id: string) => (id === match.teamAId ? match.teamBId : match.teamAId);
    const ours = (id: string | null): id is string => !!id && pair.includes(id);
    const fill = (side: Side, id: string, how: SideTeamsHow): SideTeamsResult => (side === "CT" ? { CT: id, T: other(id), how } : { CT: other(id), T: id, how });

    // 1. The game data's identification.
    if (ids.CT && ids.T) return { ...ids, how: "roster" };
    if (ours(ids.CT)) return fill("CT", ids.CT, "roster");
    if (ours(ids.T)) return fill("T", ids.T, "roster");
    if (ids.CT || ids.T) return { ...ids, how: "roster" };

    // 2. CS2's team names.
    for (const side of ["CT", "T"] as const) {
      const n = norm(state.teams[side].name);
      if (!n) continue;
      const hit = pair.filter((id) => {
        const t = this.lookup.team(id);
        return !!t && (norm(t.name) === n || norm(t.shortName) === n);
      });
      if (hit.length === 1) return fill(side, hit[0]!, "names");
    }

    // 3. Fewer rostered players, pointing to one team without conflict.
    const lean = (side: Side) => {
      const counts = new Map<string, number>();
      for (const p of state.players) if (p.side === side && !p.coach && ours(p.teamId)) counts.set(p.teamId, (counts.get(p.teamId) ?? 0) + 1);
      return counts.size === 1 ? [...counts.keys()][0]! : null;
    };
    const ctLean = lean("CT");
    const tLean = lean("T");
    if (ctLean && (!tLean || tLean === other(ctLean))) return fill("CT", ctLean, "players");
    if (tLean && !ctLean) return fill("T", tLean, "players");

    // 4–5. Veto or assumption, then followed by the players across halftime.
    const ct = state.players.filter((p) => p.side === "CT" && !p.coach).map((p) => p.steamId);
    const t = state.players.filter((p) => p.side === "T" && !p.coach).map((p) => p.steamId);
    if (!this.binding || this.binding.key !== key) {
      const half = Math.floor(match.format.regulationRounds / 2);
      const round = state.roundNumber ?? 1;
      const start = this.lookup.startingCt(match, state.mapName);
      let ctTeam: string;
      let how: "veto" | "assumed";
      if (ours(start) && round <= match.format.regulationRounds) {
        ctTeam = round <= half ? start : other(start);
        how = "veto";
      } else {
        ctTeam = match.teamAId;
        how = "assumed";
      }
      this.binding = { key, teamId: match.teamAId, players: new Set(ctTeam === match.teamAId ? ct : t), how };
    }
    const b = this.binding;
    const onCt = ct.filter((s) => b.players.has(s)).length;
    const onT = t.filter((s) => b.players.has(s)).length;
    const bindingSide: Side = onT > onCt ? "T" : "CT";
    // Substitutions: the bound team is whoever now plays on its side.
    const now = bindingSide === "CT" ? ct : t;
    if (now.length > 0) b.players = new Set(now);
    return fill(bindingSide, b.teamId, b.how);
  }
}
