import type { MatchState } from "@matchframe/contracts";

/** Why the spectated player is shown in the third-person chase view right now. */
export type ChaseReason = "BOMB_PLANT" | "BOMB_DEFUSE" | "ROUND_WON";

/** A CT this close to the bomb (across) while it is being defused is the defuser. */
const DEFUSER_RADIUS = 120;

/**
 * Moments a broadcast shows from behind the player (the chase view) instead of through their eyes:
 * planting or defusing the bomb, where the animation is the story and the crosshair adds nothing,
 * and the end of a round the player's team won while they are still alive. Gunfights stay in first
 * person, where the crosshair matters, so nothing else qualifies.
 */
export function chaseMoment(state: MatchState): ChaseReason | null {
  const id = state.observer.observedSteamId;
  if (!id) return null;
  const p = state.players.find((x) => x.steamId === id);
  if (!p || p.lifeState !== "alive") return null;
  const b = state.bomb;
  if (b?.state === "planting" && b.carrierSteamId === id) return "BOMB_PLANT";
  if (b?.state === "defusing" && p.side === "CT") {
    const near = !!b.position && !!p.position && Math.hypot(b.position.x - p.position.x, b.position.y - p.position.y) <= DEFUSER_RADIUS;
    if (b.carrierSteamId === id || near) return "BOMB_DEFUSE";
  }
  if (state.roundPhase === "over" && state.roundNumber !== null) {
    // The round that just ended: GSI may count it as played (round number already moved on) or not yet.
    const last = state.roundHistory[state.roundHistory.length - 1];
    if (last && last.roundNumber >= state.roundNumber - 1 && last.winnerSide === p.side) return "ROUND_WON";
  }
  return null;
}
