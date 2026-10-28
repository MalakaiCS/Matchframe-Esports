import type { ReasonCode } from "@matchframe/contracts";
import type { ScoredCandidate } from "./candidates.ts";
import type { DirectorConfig } from "./config.ts";
import type { ShotKey } from "./shots.ts";
import { isCinematic } from "./shots.ts";

export interface PlanResult {
  action: "hold" | "cut";
  desired: ScoredCandidate | null;
  current: ScoredCandidate | null;
  reasons: ReasonCode[];
  urgent: boolean;
}

interface Pending {
  shotKey: ShotKey;
  firstSeenAt: number;
  sequences: Set<number>;
}

interface ActiveCinematic {
  shotKey: ShotKey;
  startedAt: number;
  plannedEndAt: number;
  /** The longest this shot may run (establishing shots and follow cams run longer than other cameras). */
  maxMs: number;
  opportunityId: string | null;
}

/**
 * Temporal planning with hysteresis (spec §11.3). Holds the current shot unless an alternative is
 * better by a threshold for a persistence window measured across distinct source sequences, with
 * fast interruption for invalid shots, decisive contact and bomb urgency.
 */
export class ShotPlanner {
  private currentShot: ShotKey | null = null;
  private currentSince: number | null = null;
  private pending: Pending | null = null;
  private cinematic: ActiveCinematic | null = null;
  private cinematicsThisRound = 0;
  private roundKey: string | null = null;
  private readonly abandoned = new Map<ShotKey, number>();
  /** Cinematic shots that played this round: none is shown twice in a round. */
  private readonly shownThisRound = new Set<ShotKey>();
  private postEventUntil = 0;

  constructor(private cfg: DirectorConfig) {}

  setConfig(cfg: DirectorConfig): void {
    this.cfg = cfg;
  }

  get shot(): ShotKey | null {
    return this.currentShot;
  }

  get shotSince(): number | null {
    return this.currentSince;
  }

  get recentlyAbandoned(): ReadonlyMap<ShotKey, number> {
    return this.abandoned;
  }

  get activeCinematic(): Readonly<ActiveCinematic> | null {
    return this.cinematic;
  }

  get cinematicsUsedThisRound(): number {
    return this.cinematicsThisRound;
  }

  get cinematicsShownThisRound(): ReadonlySet<ShotKey> {
    return this.shownThisRound;
  }

  /** New round attempt resets the per-round cinematic budget. */
  setRound(roundKey: string | null): void {
    if (roundKey !== this.roundKey) {
      this.roundKey = roundKey;
      this.cinematicsThisRound = 0;
      this.shownThisRound.clear();
    }
  }

  /** Observed (confirmed) shot from camera feedback. External changes reset timing. */
  observeShot(shot: ShotKey | null, at: number): void {
    if (shot === this.currentShot) return;
    if (this.currentShot) this.abandoned.set(this.currentShot, at);
    if (this.cinematic && shot !== this.cinematic.shotKey) this.cinematic = null;
    this.currentShot = shot;
    this.currentSince = at;
    this.pending = null;
  }

  /** Record that a cinematic actually became active (confirmed by the controller). Freeze-time establishing shots do not use the round's budget. */
  cinematicStarted(shot: ShotKey, at: number, plannedDurationMs: number, opportunityId: string | null, countsTowardBudget = true, maxMs = this.cfg.cinematic.maxDurationMs): void {
    if (this.cinematic?.shotKey === shot) return;
    if (this.currentShot && this.currentShot !== shot) this.abandoned.set(this.currentShot, at);
    this.currentShot = shot;
    this.currentSince = at;
    this.pending = null;
    this.cinematic = { shotKey: shot, startedAt: at, plannedEndAt: at + Math.min(plannedDurationMs, maxMs), maxMs, opportunityId };
    this.shownThisRound.add(shot);
    if (countsTowardBudget) this.cinematicsThisRound++;
  }

  /** A cinematic that never came on air (not confirmed, refused): not tried again this round. */
  cinematicFailed(shot: ShotKey): void {
    this.shownThisRound.add(shot);
  }

  /** A meaningful event on the current shot (e.g. its fight resolved): hold briefly to explain it. */
  notePostEvent(at: number): void {
    this.postEventUntil = at + this.cfg.postEventHoldMs;
  }

  cinematicBudgetLeft(): number {
    return Math.max(0, this.cfg.cinematic.perRoundBudget - this.cinematicsThisRound);
  }

  plan(candidates: ScoredCandidate[], now: number, sequence: number): PlanResult {
    for (const [k, t] of this.abandoned) if (now - t > this.cfg.abandonCooldownMs * 2) this.abandoned.delete(k);
    const valid = candidates.filter((c) => c.valid);
    const current = candidates.find((c) => c.shotKey === this.currentShot) ?? null;
    const bestAlt = valid.find((c) => c.shotKey !== this.currentShot) ?? null;
    const bestPovAlt = valid.find((c) => c.shotKey !== this.currentShot && c.shotClass === "pov") ?? null;
    const hold = (reasons: ReasonCode[]): PlanResult => ({ action: "hold", desired: current, current, reasons, urgent: false });
    const cut = (to: ScoredCandidate, reasons: ReasonCode[], urgent = false): PlanResult => {
      this.pending = null;
      return { action: "cut", desired: to, current, reasons, urgent };
    };

    if (!this.currentShot) {
      const best = valid[0];
      return best ? cut(best, ["NO_VALID_CANDIDATE"]) : hold(["NO_VALID_CANDIDATE"]);
    }

    // Active cinematic: bounded duration, interruption for urgent action or vanished target. A shot
    // that may follow it directly (the next freeze-time shot, the pause shot) comes next with no
    // player view between; otherwise back to a player.
    if (this.cinematic && isCinematic(this.currentShot)) {
      const chained = valid.find((c) => c.chain && c.shotKey !== this.currentShot) ?? null;
      const exit = chained ?? bestPovAlt;
      if (!current || !current.valid) {
        return exit ? cut(exit, ["CINEMATIC_INTERRUPTED", "CURRENT_SHOT_INVALID"], true) : hold(["NO_VALID_CANDIDATE"]);
      }
      if (now >= this.cinematic.plannedEndAt || now - this.cinematic.startedAt >= this.cinematic.maxMs) {
        return exit ? cut(exit, chained ? chained.reasonCodes.slice(0, 2) : ["POST_EVENT_HOLD"]) : hold(["NO_VALID_CANDIDATE"]);
      }
      if (chained?.urgent) return cut(chained, chained.reasonCodes.slice(0, 2), true);
      if (bestPovAlt && bestPovAlt.urgent) return cut(bestPovAlt, ["CINEMATIC_INTERRUPTED", ...bestPovAlt.reasonCodes.filter((r) => r === "CONTACT_IMMINENT" || r === "BOMB_CRITICAL" || r === "BOMB_DEFUSE_PRESSURE")], true);
      return hold(["CURRENT_SHOT_VALID"]);
    }

    if (!current || !current.valid) {
      const reasons: ReasonCode[] = current?.reasonCodes.includes("CURRENT_POV_DEAD") ? ["CURRENT_POV_DEAD"] : ["CURRENT_SHOT_INVALID"];
      // Recover to a POV, never straight into a cinematic.
      const to = bestPovAlt ?? bestAlt;
      return to ? cut(to, reasons, true) : hold(["NO_VALID_CANDIDATE"]);
    }

    const sinceCut = this.currentSince === null ? Infinity : now - this.currentSince;
    if (bestAlt && bestAlt.urgent && !current.urgent && bestAlt.utility > current.utility) {
      return cut(bestAlt, bestAlt.reasonCodes.filter((r) => r === "CONTACT_IMMINENT" || r === "BOMB_CRITICAL" || r === "BOMB_DEFUSE_PRESSURE"), true);
    }
    if (sinceCut < this.cfg.minShotMs) return hold(["MIN_SHOT_DURATION"]);
    if (now < this.postEventUntil && current.reasonCodes.some((r) => r === "CONTACT_LIKELY_SOON" || r === "TRADE_OPPORTUNITY")) {
      return hold(["POST_EVENT_HOLD", "SECOND_CONTACT_LIKELY"]);
    }
    if (!bestAlt) return hold(["CURRENT_SHOT_VALID"]);

    const advantage = bestAlt.utility - current.utility;
    if (advantage < this.cfg.advantageThreshold) {
      this.pending = null;
      return hold(current.components.actionCoverage < 0.15 ? ["CURRENT_SHOT_LOW_ACTION", "ADVANTAGE_BELOW_THRESHOLD"] : ["ADVANTAGE_BELOW_THRESHOLD"]);
    }
    const cinematicAlt = isCinematic(bestAlt.shotKey);
    if (cinematicAlt && this.cinematicBudgetLeft() <= 0) return hold(["CINEMATIC_BUDGET_EXHAUSTED"]);
    if (!this.pending || this.pending.shotKey !== bestAlt.shotKey) {
      this.pending = { shotKey: bestAlt.shotKey, firstSeenAt: now, sequences: new Set([sequence]) };
    } else {
      this.pending.sequences.add(sequence);
    }
    // Utility (nade) cameras are already gated by lead-time eligibility; one fresh sequence suffices.
    const leadGated = bestAlt.shotClass === "static_utility";
    const needSeq = leadGated ? 1 : this.cfg.persistenceSequences;
    const needMs = leadGated ? 0 : this.cfg.persistenceMs;
    if (now - this.pending.firstSeenAt >= needMs && this.pending.sequences.size >= needSeq) {
      const reasons: ReasonCode[] = current.components.actionCoverage < 0.15 ? ["CURRENT_SHOT_LOW_ACTION"] : [];
      return cut(bestAlt, [...reasons, ...bestAlt.reasonCodes.slice(0, 4)]);
    }
    return hold(["ADVANTAGE_NOT_PERSISTENT"]);
  }
}
