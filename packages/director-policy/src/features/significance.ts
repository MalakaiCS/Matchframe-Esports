import type { MatchState, ReasonCode, Side, Vec3 } from "@matchframe/contracts";
import { projectCountdown } from "@matchframe/cs2-state";

export interface RoundContext {
  aliveT: number;
  aliveCT: number;
  clutch: { side: Side; steamId: string; versus: number } | null;
  bombPlanted: boolean;
  bombPosition: Vec3 | null;
  bombRemainingSec: number | null;
  bombState: string | null;
  carrierSteamId: string | null;
  carrierNearSite: boolean;
  postPlant: boolean;
}

export function roundContext(state: MatchState, now: number, siteAt?: (p: Vec3) => "A" | "B" | null): RoundContext {
  const alive = state.players.filter((p) => p.lifeState === "alive");
  const aliveT = alive.filter((p) => p.side === "T").length;
  const aliveCT = alive.filter((p) => p.side === "CT").length;
  let clutch: RoundContext["clutch"] = null;
  if (aliveT === 1 && aliveCT >= 1) {
    const p = alive.find((x) => x.side === "T")!;
    clutch = { side: "T", steamId: p.steamId, versus: aliveCT };
  } else if (aliveCT === 1 && aliveT >= 1) {
    const p = alive.find((x) => x.side === "CT")!;
    clutch = { side: "CT", steamId: p.steamId, versus: aliveT };
  }
  const bomb = state.bomb;
  const planted = bomb?.state === "planted" || bomb?.state === "defusing";
  const running = !state.paused && (state.gamePhase === "bomb" || state.gamePhase === "defuse" || state.roundPhase === "live");
  const cd = projectCountdown({
    countdownSec: bomb?.countdownSec ?? (planted && state.gamePhase === "bomb" ? state.phaseEndsInSec : null),
    observedAtMonotonicMs: bomb?.countdownObservedAtMonotonicMs ?? state.phaseObservedAtMonotonicMs,
    nowMonotonicMs: now,
    running,
  });
  const carrier = bomb?.state === "carried" ? (bomb.carrierSteamId ?? null) : null;
  const carrierPlayer = carrier ? state.players.find((p) => p.steamId === carrier) : undefined;
  const carrierNearSite = !!(carrierPlayer?.position && siteAt?.(carrierPlayer.position));
  return {
    aliveT,
    aliveCT,
    clutch,
    bombPlanted: planted,
    bombPosition: bomb?.position ?? null,
    bombRemainingSec: planted ? cd.remainingSec : null,
    bombState: bomb?.state ?? null,
    carrierSteamId: carrier,
    carrierNearSite,
    postPlant: planted,
  };
}

/** Round/bomb significance of showing a particular player (0..1) with reason codes. */
export function playerSignificance(state: MatchState, steamId: string, ctx: RoundContext): { value: number; reasons: ReasonCode[] } {
  const p = state.players.find((x) => x.steamId === steamId);
  if (!p || p.lifeState !== "alive") return { value: 0, reasons: [] };
  const reasons: ReasonCode[] = [];
  let value = 0.15;
  const bombDist = ctx.bombPosition && p.position ? Math.hypot(ctx.bombPosition.x - p.position.x, ctx.bombPosition.y - p.position.y, ctx.bombPosition.z - p.position.z) : null;
  if (ctx.bombState === "defusing" && p.side === "CT" && bombDist !== null && bombDist < 120) {
    value = 1;
    reasons.push("BOMB_DEFUSE_PRESSURE");
  } else if (ctx.bombPlanted) {
    if (ctx.bombRemainingSec !== null && ctx.bombRemainingSec < 12 && bombDist !== null && bombDist < 1200) {
      value = Math.max(value, 0.9);
      reasons.push("BOMB_CRITICAL");
    } else if (p.side === "CT" && bombDist !== null && bombDist < 2000) {
      value = Math.max(value, 0.55);
      reasons.push("RETAKE");
    } else if (p.side === "T" && bombDist !== null && bombDist < 1500) {
      value = Math.max(value, 0.45);
    }
  } else if (ctx.bombState === "planting" && state.bomb?.carrierSteamId === steamId) {
    value = Math.max(value, 0.85);
    reasons.push("BOMB_PLANT_PRESSURE");
  } else if (ctx.carrierSteamId === steamId && ctx.carrierNearSite) {
    value = Math.max(value, 0.6);
    reasons.push("BOMB_PLANT_PRESSURE");
  }
  if (ctx.clutch && (ctx.clutch.steamId === steamId || p.side !== ctx.clutch.side)) {
    value = Math.max(value, ctx.clutch.steamId === steamId ? 0.75 : 0.45);
    if (ctx.clutch.steamId === steamId) reasons.push("CLUTCH");
  }
  return { value, reasons };
}
