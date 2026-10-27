import type { DerivedEvent } from "@matchframe/cs2-state";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";

/**
 * Killfeed from snapshot-derived events. Without an exact kill-event source it is explicitly
 * degraded: eliminations show the victim only, and an estimated pairing is marked "probable" —
 * never shown as an exact kill with weapon or headshot.
 */
export class KillfeedBuilder {
  private entries: HudKillfeedEntry[] = [];
  private roundKey: string | null = null;
  private readonly linkedVictims = new Map<string, string>();

  constructor(
    private readonly opts: { maxEntries?: number; showProbable?: boolean } = {},
    private readonly exactSource = false,
  ) {}

  get mode(): "exact" | "degraded" {
    return this.exactSource ? "exact" : "degraded";
  }

  resetForRound(roundKey: string | null): void {
    if (roundKey !== this.roundKey) {
      this.roundKey = roundKey;
      this.entries = [];
      this.linkedVictims.clear();
    }
  }

  ingest(events: readonly DerivedEvent[], nameOf: (steamId: string) => { name: string; side: "CT" | "T" | null }): void {
    for (const e of events) {
      if (e.kind === "probable_kill_link" && this.opts.showProbable !== false) {
        this.linkedVictims.set(String(e.data.victim), String(e.data.killer));
      }
    }
    for (const e of events) {
      if (e.kind !== "player_died") continue;
      const victimId = String(e.data.steamId);
      const killerId = this.linkedVictims.get(victimId) ?? null;
      const victim = nameOf(victimId);
      const killer = killerId ? nameOf(killerId) : null;
      this.entries.push({
        id: e.eventId,
        kind: killerId ? "probable" : "elimination",
        killer: killerId && killer ? { steamId: killerId, name: killer.name, side: killer.side } : null,
        victim: { steamId: victimId, name: victim.name, side: victim.side },
        weapon: null,
        headshot: null,
        atMs: e.receivedAtMonotonicMs,
      });
    }
    const max = this.opts.maxEntries ?? 6;
    if (this.entries.length > max) this.entries = this.entries.slice(-max);
  }

  list(): HudKillfeedEntry[] {
    return [...this.entries];
  }
}
