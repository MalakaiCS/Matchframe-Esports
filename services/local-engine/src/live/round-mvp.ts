import type { MatchState, Side } from "@matchframe/contracts";
import type { HudState } from "@matchframe/hud-sdk";

type LastRound = NonNullable<HudState["lastRound"]>;

interface Line {
  steamId: string;
  side: Side | null;
  kills: number;
  damage: number;
  health: number;
  armor: number;
  helmet: boolean;
  mvps: number | null;
}

interface Ended {
  roundNumber: number;
  winnerSide: Side | null;
  /** The players' round stats as the round ended (the update that ended it, else the last one before). */
  lines: Line[];
  /** Each player's CS2 MVP count while the round was live (before the round's MVP was awarded). */
  baseline: Map<string, number>;
  /** Still in the round's end: later updates of it (the MVP star can come a moment after) refine it. */
  open: boolean;
}

/** The players' round stats in a state (coaches left out). */
function linesOf(s: MatchState): Line[] {
  return s.players
    .filter((p) => !p.coach)
    .map((p) => ({
      steamId: p.steamId,
      side: p.side,
      kills: p.roundKills ?? 0,
      damage: p.roundDamage ?? 0,
      health: p.health ?? 0,
      armor: p.armor ?? 0,
      helmet: !!p.helmet,
      mvps: p.matchStats.mvps,
    }));
}

/**
 * The previous round's key player for the HUDs' round MVP card. CS2 resets round kills and damage
 * when the next round starts, so they are kept from the round's end, by round number: a HUD on a
 * delayed timeline asks for the last round its own round history has reached (like the round
 * winners kept at round end).
 *
 * The MVP: CS2's own round MVP when the game data shows it (a player's MVP count going up at the
 * round's end), else the winning side's player with the most kills that round, then the most damage.
 */
export class RoundMvpTracker {
  /** The latest live or round-end stats of the round under way. */
  private current: Line[] = [];
  /** MVP counts during the live round (the MVP is awarded at its end). */
  private baseline = new Map<string, number>();
  private ended = new Map<number, Ended>();
  private last: Ended | null = null;
  /** The round last seen live: only its end is captured (not rounds reported when joining a match). */
  private liveRound: number | null = null;

  /** Every new live state (in order). */
  noteState(s: MatchState): void {
    const phase = s.roundPhase;
    if (phase === "live") {
      this.liveRound = s.roundNumber;
      this.current = linesOf(s);
      this.baseline = new Map(this.current.flatMap((l) => (l.mvps === null ? [] : [[l.steamId, l.mvps] as const])));
    } else if (phase === "over") {
      this.current = linesOf(s);
      // The round's end goes on: its later updates complete it (the MVP star, the last damage).
      if (this.last?.open) this.last.lines = this.current;
    } else if (phase === "freezetime" && this.last) {
      this.last.open = false;
    }
  }

  /**
   * A round ended (the round_end event) in `s`. Only the end of the round seen live counts: rounds
   * reported all at once when joining a match under way are ignored.
   */
  roundEnded(roundNumber: number, winnerSide: Side | null, s: MatchState): void {
    if (this.liveRound !== roundNumber) return;
    // The update that ends the round usually carries its final stats; when it already shows the next
    // round's freeze time (stats reset), the last live update's stand.
    const lines = s.roundPhase === "over" || s.roundPhase === "live" ? linesOf(s) : this.current;
    const ended: Ended = { roundNumber, winnerSide, lines, baseline: new Map(this.baseline), open: s.roundPhase === "over" };
    this.ended.set(roundNumber, ended);
    this.last = ended;
    for (const n of [...this.ended.keys()]) if (n < roundNumber - 30) this.ended.delete(n);
  }

  /** A new map or a restarted session: nothing from before applies. */
  reset(): void {
    this.liveRound = null;
    this.current = [];
    this.baseline.clear();
    this.ended.clear();
    this.last = null;
  }

  /** The round's result and key player, or null when the round's end wasn't seen. */
  lastRound(roundNumber: number): LastRound | null {
    const e = this.ended.get(roundNumber);
    if (!e) return null;
    const starred = e.lines.filter((l) => l.mvps !== null && e.baseline.has(l.steamId) && l.mvps > e.baseline.get(l.steamId)!);
    let pick: Line | null = starred.length === 1 ? starred[0]! : null;
    if (!pick) {
      const best = e.lines.filter((l) => e.winnerSide !== null && l.side === e.winnerSide).sort((a, b) => b.kills - a.kills || b.damage - a.damage || b.health - a.health)[0];
      pick = best && (best.kills > 0 || best.damage > 0) ? best : null;
    }
    return {
      roundNumber: e.roundNumber,
      winnerSide: e.winnerSide,
      mvp: pick ? { steamId: pick.steamId, kills: pick.kills, damage: pick.damage, health: pick.health, armor: pick.armor, helmet: pick.helmet } : null,
    };
  }
}
