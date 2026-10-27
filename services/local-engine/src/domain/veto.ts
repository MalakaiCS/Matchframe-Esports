import type { Match, Side, VetoDecision, VetoStep } from "@matchframe/contracts";
import type { VetoRepo } from "../db/store.ts";
import { ConflictError, newId, ValidationError } from "../db/store.ts";

/** Builds a standard pick/ban sequence for a pool. The pool size is never assumed. */
export function standardSequence(bestOf: number, poolSize: number): VetoStep[] {
  if (poolSize < bestOf) throw new ValidationError(`map pool (${poolSize}) smaller than best-of (${bestOf})`);
  const steps: VetoStep[] = [];
  let order = 1;
  let actor: "A" | "B" = "A";
  const push = (kind: VetoStep["kind"]) => {
    steps.push({ order: order++, kind, actor: kind === "decider" ? null : actor });
    if (kind !== "decider") actor = actor === "A" ? "B" : "A";
  };
  const picks = bestOf - 1;
  const bans = poolSize - bestOf;
  if (bestOf === 1) {
    for (let i = 0; i < bans; i++) push("ban");
  } else {
    // Two opening bans (when available), alternating picks with side choices, remaining bans, decider.
    const openingBans = Math.min(2, bans);
    for (let i = 0; i < openingBans; i++) push("ban");
    for (let i = 0; i < picks; i++) {
      push("pick");
      const picker = steps[steps.length - 1]!.actor;
      steps.push({ order: order++, kind: "side_choice", actor: picker === "A" ? "B" : "A" });
    }
    for (let i = openingBans; i < bans; i++) push("ban");
  }
  push("decider");
  // The team that did not make the final ban chooses the starting side on the decider.
  const lastBan = [...steps].reverse().find((s) => s.kind === "ban");
  steps.push({ order: order++, kind: "side_choice", actor: lastBan?.actor === "A" ? "B" : "A" });
  return steps;
}

export interface VetoStatus {
  steps: VetoStep[];
  decisions: VetoDecision[];
  currentStep: VetoStep | null;
  remainingMaps: string[];
  pickedMaps: { mapName: string; pickedBy: "A" | "B" | null; decider: boolean; startingSide: { team: "A" | "B"; side: Side } | null }[];
  complete: boolean;
}

export class VetoService {
  constructor(private readonly repo: VetoRepo) {}

  status(match: Match, steps: VetoStep[]): VetoStatus {
    const decisions = this.repo.active(match.id);
    const used = new Set(decisions.filter((d) => d.mapName).map((d) => d.mapName!));
    const remainingMaps = match.mapPool.filter((m) => !used.has(m));
    const currentStep = steps.find((s) => !decisions.some((d) => d.stepOrder === s.order)) ?? null;
    const pickedMaps: VetoStatus["pickedMaps"] = [];
    for (const d of decisions) {
      if (d.kind === "pick" || d.kind === "decider") {
        const picker = d.teamId === match.teamAId ? "A" : d.teamId === match.teamBId ? "B" : null;
        pickedMaps.push({ mapName: d.mapName!, pickedBy: d.kind === "decider" ? null : picker, decider: d.kind === "decider", startingSide: null });
      } else if (d.kind === "side_choice" && pickedMaps.length > 0 && d.side) {
        const chooser = d.teamId === match.teamAId ? "A" : "B";
        pickedMaps[pickedMaps.length - 1]!.startingSide = { team: chooser, side: d.side };
      }
    }
    return { steps, decisions, currentStep, remainingMaps, pickedMaps, complete: currentStep === null };
  }

  /**
   * Validates and commits one action. The database's unique index guarantees that two concurrent
   * submissions for the same step cannot both commit (spec A36).
   */
  act(match: Match, steps: VetoStep[], input: { stepOrder: number; teamId: string | null; mapName?: string | null; side?: Side | null; decidedBy: string }): VetoDecision {
    const st = this.status(match, steps);
    const step = st.currentStep;
    if (!step) throw new ConflictError("veto is complete");
    if (input.stepOrder !== step.order) throw new ConflictError(`it is step ${step.order}, not ${input.stepOrder}`);
    const expectedTeam = step.actor === "A" ? match.teamAId : step.actor === "B" ? match.teamBId : null;
    if (step.kind !== "decider" && input.teamId !== expectedTeam) throw new ConflictError("not this team's turn");
    let mapName: string | null = null;
    let side: Side | null = null;
    if (step.kind === "ban" || step.kind === "pick") {
      if (!input.mapName || !st.remainingMaps.includes(input.mapName)) throw new ValidationError("map not available in the remaining pool");
      mapName = input.mapName;
    } else if (step.kind === "decider") {
      if (st.remainingMaps.length !== 1) throw new ConflictError(`decider requires exactly one remaining map (have ${st.remainingMaps.length})`);
      mapName = st.remainingMaps[0]!;
    } else if (step.kind === "side_choice") {
      if (input.side !== "CT" && input.side !== "T") throw new ValidationError("side choice must be CT or T");
      side = input.side;
    }
    const d: VetoDecision = {
      id: newId("veto"),
      matchId: match.id,
      stepOrder: step.order,
      kind: step.kind,
      teamId: step.kind === "decider" ? null : input.teamId,
      mapName,
      side,
      decidedBy: input.decidedBy,
      decidedAt: new Date().toISOString(),
      revisionOf: null,
    };
    return this.repo.commit(d);
  }
}
