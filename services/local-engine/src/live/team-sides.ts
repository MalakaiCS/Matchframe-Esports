import type { MatchState, Side } from "@matchframe/contracts";

/**
 * Keeps left/right HUD positions bound to team identity across side swaps. With configured teams
 * it follows team ids; without them it follows the set of players, so a halftime swap never moves
 * a team's logo, players or cameras to the other side of the screen.
 */
export class TeamSideTracker {
  private leftPlayers = new Set<string>();
  private leftTeamId: string | null = null;

  constructor(private readonly configured: { leftTeamId: string | null; rightTeamId: string | null } = { leftTeamId: null, rightTeamId: null }) {
    this.leftTeamId = configured.leftTeamId;
  }

  reset(): void {
    this.leftPlayers.clear();
    this.leftTeamId = this.configured.leftTeamId;
  }

  /** Returns which side (CT/T) is displayed left and right for this state. */
  assign(state: MatchState): { left: Side; right: Side } {
    const ctId = state.teams.CT.teamId;
    const tId = state.teams.T.teamId;
    if (this.configured.leftTeamId && (ctId === this.configured.leftTeamId || tId === this.configured.leftTeamId)) {
      return ctId === this.configured.leftTeamId ? { left: "CT", right: "T" } : { left: "T", right: "CT" };
    }
    if (this.leftTeamId && (ctId === this.leftTeamId || tId === this.leftTeamId)) {
      return ctId === this.leftTeamId ? { left: "CT", right: "T" } : { left: "T", right: "CT" };
    }
    const ct = state.players.filter((p) => p.side === "CT").map((p) => p.steamId);
    const t = state.players.filter((p) => p.side === "T").map((p) => p.steamId);
    if (this.leftPlayers.size === 0) {
      // First assignment: CT on the left by convention, then identity is kept.
      this.leftPlayers = new Set(ct);
      this.leftTeamId = ctId;
      return { left: "CT", right: "T" };
    }
    const overlapCt = ct.filter((s) => this.leftPlayers.has(s)).length;
    const overlapT = t.filter((s) => this.leftPlayers.has(s)).length;
    const leftSide: Side = overlapT > overlapCt ? "T" : "CT";
    // Track roster changes (substitutions) on the left team.
    const leftNow = leftSide === "CT" ? ct : t;
    if (leftNow.length > 0) this.leftPlayers = new Set(leftNow);
    if (state.teams[leftSide].teamId) this.leftTeamId = state.teams[leftSide].teamId;
    return { left: leftSide, right: leftSide === "CT" ? "T" : "CT" };
  }
}
