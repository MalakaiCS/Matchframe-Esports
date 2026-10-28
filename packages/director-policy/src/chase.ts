import type { MatchState } from "@matchframe/contracts";

/** Why the spectated player is shown in the third-person chase view right now. */
export type ChaseReason = "BOMB_PLANT" | "BOMB_DEFUSE" | "ROUND_WON" | "CLUTCH_LEADUP";

/** A CT this close to the bomb (across) while it is being defused is the defuser. */
const DEFUSER_RADIUS = 120;
/**
 * Clutch lead-up: the last player alive on their side is shown from behind while no opponent is
 * this close (across); back to first person when one comes within the exit distance.
 */
const CLUTCH_ENTER = 1800;
const CLUTCH_EXIT = 1400;

/**
 * Moments a broadcast shows from behind the player (the chase view) instead of through their eyes:
 * planting or defusing the bomb, where the animation is the story and the crosshair adds nothing;
 * the end of a round the player's team won while they are still alive; and the lead-up of a clutch,
 * while the last player alive on their side has no opponent near. Gunfights stay in first person,
 * where the crosshair matters, so nothing else qualifies.
 */
export function chaseMoment(state: MatchState, opts: { chasing?: boolean } = {}): ChaseReason | null {
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
  if (state.roundPhase === "live" && p.side && p.position) {
    const alive = state.players.filter((x) => x.lifeState === "alive");
    const mates = alive.filter((x) => x.side === p.side).length;
    const opponents = alive.filter((x) => x.side !== null && x.side !== p.side);
    if (mates === 1 && opponents.length >= 1) {
      const nearest = Math.min(...opponents.map((o) => (o.position ? Math.hypot(o.position.x - p.position!.x, o.position.y - p.position!.y) : Infinity)));
      if (nearest >= (opts.chasing ? CLUTCH_EXIT : CLUTCH_ENTER)) return "CLUTCH_LEADUP";
    }
  }
  return null;
}
