import type { Sponsor } from "@matchframe/contracts";
import type { ProgramMode } from "@matchframe/automation";

export interface SponsorWindow {
  programMode: ProgramMode;
  /** Live-match context: no full-screen ads ever; bugs only in safe windows. */
  roundPhase: string | null;
  bombPlanted: boolean;
  clutch: boolean;
}

const FULLSCREEN_ZONES = new Set(["break_fullscreen"]);

/** Whether a zone may show a sponsor right now without covering important live action. */
export function zoneAllowed(zone: string, w: SponsorWindow): { allowed: boolean; reason: string | null } {
  if (FULLSCREEN_ZONES.has(zone)) {
    return w.programMode === "BREAK" || w.programMode === "STUDIO" ? { allowed: true, reason: null } : { allowed: false, reason: "full-screen placements only during break/studio" };
  }
  if (w.programMode === "REPLAY_PLAYING") return { allowed: false, reason: "no sponsor bugs over replays by default" };
  if (w.programMode === "LIVE") {
    if (w.bombPlanted || w.clutch) return { allowed: false, reason: "decisive moment in progress" };
    if (w.roundPhase === "live") return zone === "top_bar" || zone === "scoreboard_slot" ? { allowed: true, reason: null } : { allowed: false, reason: "bug zones only in freeze time / round end" };
  }
  return { allowed: true, reason: null };
}

/** Weighted round-robin rotation per zone. */
export class SponsorRotation {
  private cursor = new Map<string, number>();
  private current = new Map<string, { sponsorId: string; untilMs: number }>();

  next(zone: string, sponsors: Sponsor[], nowMs: number): { sponsorId: string; untilMs: number } | null {
    const cur = this.current.get(zone);
    if (cur && cur.untilMs > nowMs) return cur;
    const eligible = sponsors.filter((s) => s.active && s.placements.includes(zone as never));
    if (eligible.length === 0) {
      this.current.delete(zone);
      return null;
    }
    const expanded: Sponsor[] = [];
    for (const s of eligible) for (let i = 0; i < Math.max(1, Math.round(s.weight)); i++) expanded.push(s);
    const idx = (this.cursor.get(zone) ?? -1) + 1;
    this.cursor.set(zone, idx);
    const pick = expanded[idx % expanded.length]!;
    const v = { sponsorId: pick.id, untilMs: nowMs + pick.displaySeconds * 1000 };
    this.current.set(zone, v);
    return v;
  }

  clear(zone: string): void {
    this.current.delete(zone);
  }
}
