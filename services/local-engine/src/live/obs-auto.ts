import { z } from "zod";
import type { Engine } from "../app.ts";

/**
 * OBS scene automation on the program state machine (scenes mapped in Setup → Program scenes, or by
 * Replays → Set up OBS replay scene):
 *
 * - a tactical timeout or a technical pause: the BREAK scene, back to the live scene when play resumes;
 * - the end of a map: the STUDIO scene, back to the live scene when the next map starts;
 * - replays cut with a chosen OBS transition (a stinger), then the previous transition again.
 *
 * It only moves the program from the live scene, and only back from a scene it chose itself: an
 * operator's own program choice is never undone.
 */

export const ObsAutoSettings = z.object({
  timeouts: z.boolean().default(true),
  mapEnd: z.boolean().default(true),
  /** OBS transition for cuts to and from a replay (e.g. a Stinger); empty = OBS's current one. */
  replayTransition: z.string().max(200).default(""),
});
export type ObsAutoSettings = z.infer<typeof ObsAutoSettings>;
export const ObsAutoPatch = z.object({ timeouts: z.boolean().optional(), mapEnd: z.boolean().optional(), replayTransition: z.string().max(200).optional() });

const PAUSE_PHASES = new Set(["timeout_t", "timeout_ct", "paused"]);

export class ObsAutomation {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The scene this module put on program (so it may take it off again). */
  private ours: "BREAK" | "STUDIO" | null = null;
  private busy = false;
  private mapAtEnd: string | null = null;
  private restoreTransition: string | null = null;

  constructor(private readonly e: Engine) {}

  settings(): ObsAutoSettings {
    const r = ObsAutoSettings.safeParse(this.e.settings.get("obs.auto", {}));
    return r.success ? r.data : ObsAutoSettings.parse({});
  }

  setSettings(patch: z.infer<typeof ObsAutoPatch>): ObsAutoSettings {
    const next = ObsAutoSettings.parse({ ...this.settings(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    this.e.settings.set("obs.auto", next);
    return next;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 250);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Before a cut to or from a replay: the replay transition, remembering the one in use. */
  async useReplayTransition(): Promise<void> {
    const name = this.settings().replayTransition;
    if (!name || !this.e.obs.state.connected) return;
    try {
      const t = await this.e.obs.transitions();
      if (!t.names.includes(name)) return;
      if (this.restoreTransition === null) this.restoreTransition = t.current;
      if (t.current !== name) await this.e.obs.setTransition(name);
    } catch (err) {
      this.e.logger.warn("OBS: could not set the replay transition", { error: String(err) });
    }
  }

  /** After the replay is over: the transition that was in use before. */
  async restoreAfterReplay(): Promise<void> {
    const prev = this.restoreTransition;
    this.restoreTransition = null;
    if (!prev || !this.e.obs.state.connected) return;
    // Give the replay transition time to finish before switching transitions.
    await new Promise((r) => setTimeout(r, 1500));
    await this.e.obs.setTransition(prev).catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.e.obs.state.connected) return;
    const s = this.e.session.state();
    if (!s) return;
    const st = this.settings();
    const scenes = this.e.program.sceneMap;
    const mode = this.e.program.mode;
    const paused = PAUSE_PHASES.has(s.gamePhase) || s.paused;
    const ended = s.mapPhase === "gameover" || s.gamePhase === "gameover";
    let want: "LIVE" | "BREAK" | "STUDIO" | null = null;
    if (mode === "LIVE") {
      if (st.timeouts && paused && scenes.BREAK) want = "BREAK";
      else if (st.mapEnd && ended && scenes.STUDIO) want = "STUDIO";
    } else if (this.ours && mode === this.ours) {
      if (this.ours === "BREAK" && !paused) want = "LIVE";
      if (this.ours === "STUDIO" && !ended && s.mapName !== null && (s.mapName !== this.mapAtEnd || s.roundPhase === "live")) want = "LIVE";
    } else this.ours = null;
    if (!want) return;
    this.busy = true;
    try {
      await this.e.program.request(want, "automation", "obs-automation");
      if (want === "LIVE") this.ours = null;
      else {
        this.ours = want;
        this.mapAtEnd = want === "STUDIO" ? s.mapName : null;
      }
      this.e.audit.record("obs-automation", "program.auto_scene", want, { gamePhase: s.gamePhase, mapPhase: s.mapPhase });
    } catch (err) {
      this.e.logger.warn("OBS automation: scene change refused", { to: want, error: String(err) });
      this.ours = null;
    } finally {
      this.busy = false;
    }
  }
}
