import type { MatchState, Vec3 } from "@matchframe/contracts";

interface Sample {
  t: number;
  position: Vec3;
}

/**
 * Short rolling history of player positions for causal motion features (velocity, closing rate).
 * Only past observations are stored; a new epoch clears the history.
 */
export class StateHistory {
  private readonly byPlayer = new Map<string, Sample[]>();
  private epochKey = "";
  private lastSequence = -1;

  constructor(private readonly windowMs = 1500) {}

  push(state: MatchState): void {
    const key = `${state.sessionId}:${state.epoch}`;
    if (key !== this.epochKey) {
      this.byPlayer.clear();
      this.epochKey = key;
      this.lastSequence = -1;
    }
    if (state.sequence === this.lastSequence) return;
    this.lastSequence = state.sequence;
    for (const p of state.players) {
      if (!p.position || p.positionObservedAtMonotonicMs === null) continue;
      const list = this.byPlayer.get(p.steamId) ?? [];
      const last = list[list.length - 1];
      if (!last || last.t !== p.positionObservedAtMonotonicMs) list.push({ t: p.positionObservedAtMonotonicMs, position: p.position });
      while (list.length > 0 && p.positionObservedAtMonotonicMs - list[0]!.t > this.windowMs) list.shift();
      this.byPlayer.set(p.steamId, list);
    }
  }

  /** Velocity estimate (units/s) from the oldest and newest samples in the window, or null. */
  velocity(steamId: string): Vec3 | null {
    const list = this.byPlayer.get(steamId);
    if (!list || list.length < 2) return null;
    const a = list[0]!;
    const b = list[list.length - 1]!;
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.05) return null;
    return { x: (b.position.x - a.position.x) / dt, y: (b.position.y - a.position.y) / dt, z: (b.position.z - a.position.z) / dt };
  }
}
