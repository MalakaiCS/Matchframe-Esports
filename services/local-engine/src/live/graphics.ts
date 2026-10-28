import { z } from "zod";
import type { MatchState } from "@matchframe/contracts";
import { parseShot } from "@matchframe/director-policy";
import type { Engine } from "../app.ts";

/**
 * HUD graphics timed to the shots, while the director drives the camera:
 *
 * - freeze time: the economy panel, then the round MVP (CS2's own MVP: whose MVP count went up);
 * - a player view held a while with nothing happening: that player's card (lower third), only on a
 *   player view, never over a camera, and gone as soon as the view changes;
 * - a clutch (1v2 or more): a "1v3" banner until it ends;
 * - an LHM HUD's own pages in OBS (kaiHUD's Player Highlight and Match stats): Player Highlight for
 *   the MVP in freeze time, Match stats at half time and at the end of the map, by showing their OBS
 *   browser sources for a few seconds.
 *
 * Matchframe HUDs draw the cues; LHM HUDs only get their pages.
 */

export const GraphicsSettings = z.object({
  enabled: z.boolean().default(true),
  economy: z.boolean().default(true),
  mvp: z.boolean().default(true),
  playerCards: z.boolean().default(true),
  clutch: z.boolean().default(true),
  /** An LHM HUD's pages as OBS browser sources in one scene (empty = not used). */
  pages: z
    .object({
      hudId: z.string().max(80).default(""),
      scene: z.string().max(200).default(""),
      playerSource: z.string().max(200).default(""),
      matchSource: z.string().max(200).default(""),
    })
    .default({ hudId: "", scene: "", playerSource: "", matchSource: "" }),
});
export type GraphicsSettings = z.infer<typeof GraphicsSettings>;
export const GraphicsPatch = z.object({
  enabled: z.boolean().optional(),
  economy: z.boolean().optional(),
  mvp: z.boolean().optional(),
  playerCards: z.boolean().optional(),
  clutch: z.boolean().optional(),
  pages: z.object({ hudId: z.string().max(80), scene: z.string().max(200), playerSource: z.string().max(200), matchSource: z.string().max(200) }).partial().optional(),
});

const ECONOMY_AT_MS = 1000;
const ECONOMY_MS = 7000;
const MVP_AT_MS = 8500;
const MVP_MS = 5000;
/** Freeze time this short (seconds left at its start) has no room for the MVP. */
const MVP_MIN_FREEZE_SEC = 14;
const CARD_AFTER_MS = 6000;
const CARD_MS = 4500;
const CARD_PLAYER_COOLDOWN_MS = 90000;
const CARD_COOLDOWN_MS = 25000;
const PAGE_MS = 6000;
const MATCH_PAGE_MS = 10000;

export class GraphicsDirector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private phase: string | null = null;
  private mvpsAtLive = new Map<string, number>();
  private mvp: { steamId: string; name: string; kills: number } | null = null;
  private freezeAt: number | null = null;
  private freezeLeftSec: number | null = null;
  private shown = new Set<string>();
  private clutchCue: { id: string; steamId: string } | null = null;
  private card: { id: string; steamId: string } | null = null;
  private povSince: { steamId: string; at: number } | null = null;
  private cardAt = new Map<string, number>();
  private lastCardAt = -Infinity;
  private pageTimers: ReturnType<typeof setTimeout>[] = [];
  private gameOverShown = false;

  constructor(private readonly e: Engine) {}

  settings(): GraphicsSettings {
    const r = GraphicsSettings.safeParse(this.e.settings.get("graphics.auto", {}));
    return r.success ? r.data : GraphicsSettings.parse({});
  }

  setSettings(patch: z.infer<typeof GraphicsPatch>): GraphicsSettings {
    const cur = this.settings();
    const next = GraphicsSettings.parse({ ...cur, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== "pages")), pages: { ...cur.pages, ...(patch.pages ?? {}) } });
    this.e.settings.set("graphics.auto", next);
    return next;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.pageTimers.splice(0)) clearTimeout(t);
  }

  /** The director is driving the camera (Auto Director on, or automatic mode). */
  private active(): boolean {
    return this.e.autoDirector.status().on || this.e.session.director.currentMode === "automatic";
  }

  private tick(): void {
    const s = this.e.session.state();
    const st = this.settings();
    if (!s || !st.enabled || !this.active()) {
      this.endClutch();
      this.endCard();
      if (s) this.phase = s.roundPhase;
      return;
    }
    const now = this.e.now();
    const was = this.phase;
    this.phase = s.roundPhase;

    if (s.roundPhase === "live" && was !== "live") {
      this.mvpsAtLive = new Map(s.players.map((p) => [p.steamId, p.matchStats.mvps ?? 0]));
      this.gameOverShown = false;
    }
    if (s.roundPhase !== "live" && was === "live") this.mvp = this.roundMvp(s);
    if (s.roundPhase === "freezetime" && was !== "freezetime") {
      this.freezeAt = now;
      this.freezeLeftSec = s.phaseEndsInSec;
      this.shown.clear();
      if (this.isHalfTime(s)) this.showPage("match", s);
    }
    if (s.roundPhase !== "freezetime") this.freezeAt = null;

    if (this.freezeAt !== null) {
      const t = now - this.freezeAt;
      if (st.economy && t >= ECONOMY_AT_MS && !this.shown.has("economy")) {
        this.shown.add("economy");
        this.e.showCue({ kind: "economy", title: "Economy", subtitle: null, data: { auto: true }, durationMs: ECONOMY_MS, outputs: null });
      }
      if (st.mvp && this.mvp && t >= MVP_AT_MS && !this.shown.has("mvp") && (this.freezeLeftSec === null || this.freezeLeftSec >= MVP_MIN_FREEZE_SEC)) {
        this.shown.add("mvp");
        this.e.showCue({ kind: "mvp", title: this.mvp.name, subtitle: `ROUND MVP · ${this.mvp.kills} ${this.mvp.kills === 1 ? "kill" : "kills"}`, data: { steamId: this.mvp.steamId, auto: true }, durationMs: MVP_MS, outputs: null });
        this.showPage("player", s, this.mvp.steamId);
      }
    }

    if ((s.mapPhase === "gameover" || s.gamePhase === "gameover") && !this.gameOverShown) {
      this.gameOverShown = true;
      this.showPage("match", s);
    }

    if (st.clutch) this.trackClutch(s);
    else this.endClutch();
    if (st.playerCards) this.trackCard(s, now);
    else this.endCard();
  }

  /** CS2's round MVP: the player whose MVP count went up this round. */
  private roundMvp(s: MatchState): { steamId: string; name: string; kills: number } | null {
    const p = s.players.find((x) => (x.matchStats.mvps ?? 0) > (this.mvpsAtLive.get(x.steamId) ?? Infinity));
    return p ? { steamId: p.steamId, name: p.name, kills: p.roundKills ?? 0 } : null;
  }

  private isHalfTime(s: MatchState): boolean {
    // Freeze time of the first round of the second half (MR12: round 13).
    return s.roundNumber === 13;
  }

  private trackClutch(s: MatchState): void {
    if (s.roundPhase !== "live") return this.endClutch();
    const alive = s.players.filter((p) => p.lifeState === "alive" && p.side);
    const t = alive.filter((p) => p.side === "T");
    const ct = alive.filter((p) => p.side === "CT");
    const lone = t.length === 1 && ct.length >= 2 ? t[0]! : ct.length === 1 && t.length >= 2 ? ct[0]! : null;
    if (!lone) {
      // Ends when the clutcher dies or wins (the round end clears it too).
      if (this.clutchCue && !alive.some((p) => p.steamId === this.clutchCue!.steamId)) this.endClutch();
      return;
    }
    if (this.clutchCue?.steamId === lone.steamId) return;
    this.endClutch();
    const versus = (lone.side === "T" ? ct : t).length;
    const cue = this.e.showCue({ kind: "clutch", title: `1v${versus}`, subtitle: lone.name, data: { steamId: lone.steamId, side: lone.side, versus, auto: true }, durationMs: null, outputs: null });
    this.clutchCue = { id: cue.id, steamId: lone.steamId };
  }

  private endClutch(): void {
    if (this.clutchCue) this.e.clearCue(this.clutchCue.id);
    this.clutchCue = null;
  }

  /** A player view held a while with no fight close: that player's card, until the view changes. */
  private trackCard(s: MatchState, now: number): void {
    const shot = parseShot(this.e.session.output()?.decision.currentShot ?? null);
    const observed = s.observer.observedSteamId;
    const onPov = s.roundPhase === "live" && observed && (shot.kind === "pov" || shot.kind === "none") ? observed : null;
    if (this.card && this.card.steamId !== onPov) this.endCard();
    if (!onPov) {
      this.povSince = null;
      return;
    }
    if (this.povSince?.steamId !== onPov) this.povSince = { steamId: onPov, at: now };
    if (this.card || now - this.povSince.at < CARD_AFTER_MS || now - this.lastCardAt < CARD_COOLDOWN_MS || now - (this.cardAt.get(onPov) ?? -Infinity) < CARD_PLAYER_COOLDOWN_MS) return;
    const imminence = this.e.session.output()?.interactions.byPlayer.get(onPov)?.imminence ?? 0;
    if (imminence > 0.3) return;
    const p = s.players.find((x) => x.steamId === onPov);
    if (!p) return;
    const m = p.matchStats;
    const cue = this.e.showCue({ kind: "player", title: p.name, subtitle: `${m.kills ?? 0} kills · ${m.assists ?? 0} assists · ${m.deaths ?? 0} deaths`, data: { steamId: p.steamId, auto: true }, durationMs: CARD_MS, outputs: null });
    this.card = { id: cue.id, steamId: onPov };
    this.cardAt.set(onPov, now);
    this.lastCardAt = now;
    this.pageTimers.push(setTimeout(() => this.card?.id === cue.id && this.endCard(), CARD_MS));
  }

  private endCard(): void {
    if (this.card) this.e.clearCue(this.card.id);
    this.card = null;
  }

  /** Shows an LHM HUD's page (an OBS browser source) for a few seconds. */
  private showPage(which: "player" | "match", s: MatchState, steamId?: string): void {
    const pg = this.settings().pages;
    const source = which === "player" ? pg.playerSource : pg.matchSource;
    if (!pg.scene || !source || !this.e.obs.state.connected) return;
    // Player Highlight shows the selected player, or whoever the camera has: not over another player's view.
    if (which === "player" && s.observer.observedSteamId && s.observer.observedSteamId !== steamId) return;
    if (pg.hudId) {
      try {
        const cur = this.e.hudLibrary.entry(pg.hudId).settings;
        const patch = which === "player" ? { "player_stats.selected_player": steamId, "player_stats.selected_map": s.mapName } : { "match_stats.selected_map": s.mapName };
        this.e.hudLibrary.setSettings(pg.hudId, { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v)) });
      } catch (err) {
        this.e.logger.warn("graphics: could not select the HUD page's player or map", { error: String(err) });
      }
    }
    void this.e.obs.setSourceVisible(pg.scene, source, true).catch((err) => this.e.logger.warn("graphics: could not show the HUD page in OBS", { error: String(err) }));
    this.pageTimers.push(
      setTimeout(() => void this.e.obs.setSourceVisible(pg.scene, source, false).catch(() => undefined), which === "player" ? PAGE_MS : MATCH_PAGE_MS),
    );
  }
}
