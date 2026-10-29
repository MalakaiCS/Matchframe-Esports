import type { PlayerState } from "@matchframe/contracts";

/** A name that says the player is a coach ("COACH|name", "name [coach]", "coach name"). */
export function nameSaysCoach(name: string): boolean {
  return /(^|[^a-z0-9])coach([^a-z0-9]|$)/i.test(name);
}

/**
 * The spectator number key of each player (and the number broadcasts show): 1–9, then 0 for the
 * tenth. CS2 numbers observer slots from 0 (the first player's slot is 0, key 1); CS:GO numbered
 * them like the keys (1–9, 0). Told apart by slots 0 and 1: on the same team when numbering starts
 * at 0, on different teams (the tenth player and the first) when slots are keys. Unknown: from 0.
 */
export function observerKeys(players: readonly Pick<PlayerState, "steamId" | "observerSlot" | "side">[]): Map<string, number | null> {
  const s0 = players.find((p) => p.observerSlot === 0);
  const s1 = players.find((p) => p.observerSlot === 1);
  const keyStyle = !!(s0?.side && s1?.side && s0.side !== s1.side);
  const out = new Map<string, number | null>();
  for (const p of players) {
    const s = p.observerSlot;
    out.set(p.steamId, s === null || s < 0 || s > 9 ? null : keyStyle ? s : (s + 1) % 10);
  }
  return out;
}

/**
 * Coaches listed with a team, from what the game data shows: a name that says so, or, on a side
 * listing more than five, someone with no observer slot, or not alive in freeze time while five
 * teammates are. Remembered (`known`) until they play: alive in a live round.
 */
export function detectCoaches(players: readonly Pick<PlayerState, "steamId" | "name" | "side" | "observerSlot" | "lifeState">[], roundPhase: string, known: Set<string>): void {
  for (const side of ["T", "CT"] as const) {
    const team = players.filter((p) => p.side === side);
    const alive = team.filter((p) => p.lifeState === "alive");
    for (const p of team) {
      if (team.length > 5 && p.observerSlot === null) {
        known.add(p.steamId);
        continue;
      }
      if (roundPhase === "live" && p.lifeState === "alive" && !nameSaysCoach(p.name)) {
        known.delete(p.steamId);
        continue;
      }
      if (nameSaysCoach(p.name)) known.add(p.steamId);
      else if (team.length > 5 && roundPhase === "freezetime" && p.lifeState !== "alive" && alive.length >= 5) known.add(p.steamId);
    }
  }
}
