import { z } from "zod";
import type { Engine } from "../app.ts";
import type { ObsTransitionNow } from "@matchframe/obs-adapter";
import type { ProgramMove } from "../production/program.ts";

/**
 * OBS scene automation on the program state machine (scenes mapped in Setup → Program scenes, or by
 * Replays → Set up OBS replay scene):
 *
 * - a tactical timeout or a technical pause: the BREAK scene, back to the live scene when play resumes;
 * - the end of a map: the STUDIO scene, back to the live scene when the next map starts.
 *
 * It only moves the program from the live scene, and only back from a scene it chose itself: an
 * operator's own program choice is never undone. A scene put on in OBS itself (by hand, a multiview,
 * even the mapped break or studio scene) is the operator's: the program follows it (app.ts, whose)
 * and nothing here touches it until OBS shows the live scene again.
 *
 * It also chooses the OBS transition of every program change (switchProgram, used by the program
 * state machine whoever asks for the change): one into a replay, one back out of it, one between two
 * replays of a break, one into highlights and one out of them (ADR-063), one to and from the break
 * and studio scenes. OBS's own transition is put back
 * once the transition has ended. In Studio Mode the program changes without the preview (OBS's
 * SetCurrentProgramScene), and the operator's preview is put back where OBS's Swap Scenes changed
 * it; a program change made in OBS itself (the Transition button) is counted (changesInObs).
 */

export const ObsAutoSettings = z.object({
  timeouts: z.boolean().default(true),
  mapEnd: z.boolean().default(true),
  /** OBS transition from live to a replay (e.g. a Stinger); empty = OBS's own. */
  replayIn: z.string().max(200).default(""),
  /** From a replay back to live; null = the same as replayIn, empty = OBS's own. */
  replayOut: z.string().max(200).nullable().default(null),
  /** To and from the break and studio scenes (by this automation or the operator's program buttons); empty = OBS's own. */
  otherScenes: z.string().max(200).default(""),
  /** To highlights on air (ADR-063); null = the same as replayIn, empty = OBS's own. */
  highlightsIn: z.string().max(200).nullable().default(null),
  /** From highlights back to where the program came from; null = the same as Replay out (replayOut, else replayIn), empty = OBS's own. */
  highlightsOut: z.string().max(200).nullable().default(null),
});
export type ObsAutoSettings = z.infer<typeof ObsAutoSettings>;
export const ObsAutoPatch = z.object({
  timeouts: z.boolean().optional(),
  mapEnd: z.boolean().optional(),
  replayIn: z.string().max(200).optional(),
  replayOut: z.string().max(200).nullable().optional(),
  otherScenes: z.string().max(200).optional(),
  highlightsIn: z.string().max(200).nullable().optional(),
  highlightsOut: z.string().max(200).nullable().optional(),
});

const PAUSE_PHASES = new Set(["timeout_t", "timeout_ct", "paused"]);

/**
 * The transition for one program change: an OBS transition by name, or OBS's Fade or Cut by kind
 * (their names can be translated), with a duration for a Fade. Null: OBS's own.
 */
export type TransitionPick = { name: string } | { kind: "fade_transition" | "cut_transition"; durationMs?: number } | null;

/** What a program change is, for its transition: into or out of a replay, into or out of highlights, to or from the break and studio scenes. */
export function transitionUse(m: ProgramMove): "in" | "out" | "highlights-in" | "highlights-out" | "other" | "none" {
  if (m.to === "HIGHLIGHTS" && m.from !== "HIGHLIGHTS") return "highlights-in";
  if (m.from === "HIGHLIGHTS" && m.to !== "HIGHLIGHTS") return "highlights-out";
  if (m.to === "REPLAY_PLAYING" && m.from !== "REPLAY_PLAYING") return "in";
  if (m.from === "REPLAY_PLAYING" || m.from === "REPLAY_PREPARED") return "out";
  if (m.to === "BREAK" || m.to === "STUDIO" || m.from === "BREAK" || m.from === "STUDIO") return "other";
  return "none";
}

/** A transition longer than this is never waited for (its end is taken as said). */
const LONGEST_TRANSITION_MS = 8000;
/** OBS reports the start of a transition we asked for within this long after answering (it comes before the answer, measured). */
const OWN_START_MS = 1500;
/** Studio Mode: OBS's Swap Scenes changes the preview within this long of the transition's end. */
const PREVIEW_SWAP_MS = 150;
/** OBS says which scene it shows at the end of the transition: one of ours is recognised for this long. */
const OWN_SCENE_MS = LONGEST_TRANSITION_MS + 4000;

/** A Stinger shows the new scene at its transition point (when given in ms; tp_type 1 is in frames). */
const cutPoint = (t: ObsTransitionNow): number => {
  if (t.kind !== "obs_stinger_transition" || !t.settings) return 0;
  const ms = Number(t.settings.transition_point ?? 0);
  return Number(t.settings.tp_type ?? 0) === 0 && Number.isFinite(ms) ? Math.max(0, Math.min(5000, ms)) : 0;
};

export class ObsAutomation {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The scene this module put on program (so it may take it off again). */
  private ours: "BREAK" | "STUDIO" | null = null;
  private busy = false;
  private mapAtEnd: string | null = null;
  /** OBS's own transition and duration, while one of ours is set (null duration: not known). */
  private saved: { name: string; durationMs: number | null } | null = null;
  /** The transition this module made current last. */
  private applied: string | null = null;
  /** Each program change counts up: a transition's end puts OBS's own back only if no change came after it. */
  private gen = 0;
  /** Program changes and the restores after them, one at a time. */
  private chain: Promise<unknown> = Promise.resolve();
  /** The last program change: its scene, and when its transition shows it (ms from its start). */
  private cut: { scene: string; atMs: number } | null = null;
  /** Studio Mode: the operator's preview before our program changes (OBS's Swap Scenes changes it). */
  private savedPreview: string | null = null;
  /** Our program changes whose transition start OBS hasn't reported yet (until when it may). */
  private own: { until: number }[] = [];
  private foreign = 0;
  /** When the last program change made in OBS itself started (wall ms). */
  private foreignAt = 0;
  /** Matchframe's own program changes of the last moments: the scene, and when. */
  private ownSwitches: { scene: string; at: number }[] = [];
  /** The last program change: its scene, the transition it used (null: not known) and whether OBS confirmed the scene (the Test replays report). */
  lastSwitch: { scene: string; transition: string | null; confirmed: boolean; at: number } | null = null;

  constructor(private readonly e: Engine) {}

  settings(): ObsAutoSettings {
    const raw = this.e.settings.get<Record<string, unknown>>("obs.auto", {});
    // Before 0.10.5: one replay transition, for both ways.
    const migrated = raw && typeof raw === "object" && raw.replayIn === undefined && typeof raw.replayTransition === "string" ? { ...raw, replayIn: raw.replayTransition } : raw;
    const r = ObsAutoSettings.safeParse(migrated);
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
    this.e.obs.on("transition", this.onTransition);
  }

  private readonly onTransition = (ev: { phase: string }) => {
    if (ev.phase === "started") this.onTransitionStarted();
  };

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.e.obs.off("transition", this.onTransition);
  }

  /** The transition chosen for a program change (into or out of a replay or highlights, to or from the break and studio scenes). */
  pickFor(move: ProgramMove): TransitionPick {
    const st = this.settings();
    const use = transitionUse(move);
    const out = st.replayOut ?? st.replayIn;
    const name = use === "in" ? st.replayIn : use === "out" ? out : use === "highlights-in" ? (st.highlightsIn ?? st.replayIn) : use === "highlights-out" ? (st.highlightsOut ?? out) : use === "other" ? st.otherScenes : "";
    return name ? { name } : null;
  }

  /**
   * Puts a scene on program with a transition (null: OBS's own), and puts OBS's own transition back
   * once OBS says the transition has ended (a Stinger's whole video, not a fixed time). Returns
   * whether OBS confirmed the scene. If the transition can't be set, the scene changes with OBS's own.
   */
  switchProgram(scene: string, pick: TransitionPick): Promise<boolean> {
    return this.serial(async () => {
      const obs = this.e.obs;
      // Already on program: no transition runs.
      if (obs.state.programScene === scene) {
        const confirmed = (await obs.setProgram(scene)).confirmed;
        this.lastSwitch = { scene, transition: null, confirmed, at: Date.now() };
        return confirmed;
      }
      let waitMs = 0;
      let used: ObsTransitionNow | null = null;
      try {
        const want = await this.resolve(pick);
        if (want) [waitMs, used] = await this.apply(want);
        else {
          used = await obs.currentTransition();
          waitMs = used.fixed ? (used.kind === "cut_transition" ? 1000 : LONGEST_TRANSITION_MS) : (used.durationMs ?? 1000) + 1500;
        }
      } catch (err) {
        this.e.logger.warn("OBS: could not set the transition", { scene, error: String(err) });
      }
      this.cut = { scene, atMs: used ? cutPoint(used) : 0 };
      // Studio Mode: SetCurrentProgramScene leaves the preview, but OBS's Swap Scenes (on by default)
      // puts the scene the program left in preview once the transition is over: the operator's own goes back then.
      const studio = obs.state.studioMode === true;
      const leaving = obs.state.programScene;
      if (!studio) this.savedPreview = null;
      else if (this.savedPreview === null) this.savedPreview = obs.state.previewScene;
      const gen = ++this.gen;
      const ended = this.saved || studio ? obs.waitTransitionEnd(waitMs || LONGEST_TRANSITION_MS) : null;
      // This transition is ours (an operator's, from OBS, isn't: see changesInObs).
      const own = { until: Infinity };
      this.own.push(own);
      this.ownSwitches = [...this.ownSwitches.filter((x) => Date.now() - x.at < OWN_SCENE_MS), { scene, at: Date.now() }];
      let r: { confirmed: boolean };
      try {
        r = await obs.setProgram(scene);
      } finally {
        own.until = Date.now() + OWN_START_MS;
      }
      this.lastSwitch = { scene, transition: used?.name ?? null, confirmed: r.confirmed, at: Date.now() };
      if (ended)
        void ended.then(() =>
          this.serial(async () => {
            if (gen !== this.gen) return;
            await this.restore();
            if (studio) await this.restorePreview(leaving);
          }),
        );
      return r.confirmed;
    });
  }

  /**
   * Program changes OBS made that Matchframe didn't ask for: the operator's Transition button in
   * Studio Mode, a scene clicked in OBS, a hotkey. Counts up; a break's replays compare it to stop.
   */
  get changesInObs(): number {
    return this.foreign;
  }

  /** A transition started in OBS: one of ours if one was asked for just now, else someone else's. */
  private onTransitionStarted(): void {
    const now = Date.now();
    this.own = this.own.filter((o) => o.until >= now);
    if (this.own.length) this.own.shift();
    else {
      this.foreign++;
      this.foreignAt = now;
    }
  }

  /**
   * Who put `scene` on OBS's program, as OBS says it shows it: Matchframe (one of its own program
   * changes of the last moments, with none made in OBS since), OBS itself (a program change made in
   * OBS came after Matchframe's last: the operator, by hand, a multiview, the Transition button in
   * Studio Mode), or not known (no change seen: OBS found so on connecting).
   */
  whose(scene: string): "matchframe" | "obs" | "unknown" {
    const now = Date.now();
    const last = this.ownSwitches.at(-1);
    if (this.foreignAt && this.foreignAt >= (last?.at ?? 0)) return "obs";
    return this.ownSwitches.some((x) => x.scene === scene && now - x.at < OWN_SCENE_MS) ? "matchframe" : "unknown";
  }

  /** Studio Mode: the operator's preview back, where Swap Scenes put the scene the program left. */
  private async restorePreview(leaving: string | null): Promise<void> {
    const saved = this.savedPreview;
    this.savedPreview = null;
    if (!saved || !this.e.obs.state.connected || !this.e.obs.state.studioMode) return;
    try {
      // OBS swaps the preview just after (or just before) it says the transition ended.
      await new Promise((r) => setTimeout(r, PREVIEW_SWAP_MS));
      const now = await this.e.obs.currentPreview();
      if (now !== saved && now === leaving) await this.e.obs.setPreview(saved);
    } catch (err) {
      this.e.logger.warn("OBS: could not put the preview back", { error: String(err) });
    }
  }

  /**
   * When the last program change's transition shows `scene` (ms from its start): a Stinger's cut
   * point (its "transition point" in time); 0 for the others (a fade shows it from its start).
   */
  cutPointMs(scene: string): number {
    return this.cut?.scene === scene ? this.cut.atMs : 0;
  }

  /** The transition a pick means now: OBS's own is the one saved while ours is set. */
  private async resolve(pick: TransitionPick): Promise<{ name: string; durationMs: number | null } | null> {
    const own = this.saved ? { name: this.saved.name, durationMs: this.saved.durationMs } : null;
    if (!pick) return own;
    const list = (await this.e.obs.transitionKinds()).transitions;
    const t = "name" in pick ? list.find((x) => x.name === pick.name) : list.find((x) => x.kind === pick.kind);
    if (!t) {
      this.e.logger.warn("OBS: the chosen transition isn't in OBS; using OBS's own", { pick });
      return own;
    }
    // A Fade between two replays has its own length; a chosen transition runs for OBS's own duration.
    return { name: t.name, durationMs: "kind" in pick && pick.durationMs !== undefined ? pick.durationMs : (this.saved?.durationMs ?? null) };
  }

  /** Makes a transition current (OBS's own saved first), with a duration; returns how long to wait for its end at most, and the transition. */
  private async apply(want: { name: string; durationMs: number | null }): Promise<[number, ObsTransitionNow]> {
    const obs = this.e.obs;
    let cur = await obs.currentTransition();
    if (!this.saved) this.saved = { name: cur.name, durationMs: cur.durationMs };
    if (cur.name !== want.name) {
      if (!(await obs.setTransition(want.name))) throw new Error(`OBS didn't switch to the transition "${want.name}"`);
      cur = await obs.currentTransition();
    }
    this.applied = want.name;
    if (cur.fixed) return [cur.kind === "cut_transition" ? 1000 : LONGEST_TRANSITION_MS, cur];
    // OBS's own duration, seen when OBS's own transition was a fixed one.
    if (this.saved.durationMs === null) this.saved.durationMs = cur.durationMs;
    if (want.durationMs !== null && cur.durationMs !== want.durationMs) await obs.setTransitionDuration(want.durationMs);
    return [(want.durationMs ?? cur.durationMs ?? 1000) + 1500, cur];
  }

  /** OBS's own transition and duration again, unless someone chose another transition in OBS meanwhile. */
  private async restore(): Promise<void> {
    const saved = this.saved;
    this.saved = null;
    if (!saved || !this.e.obs.state.connected) return;
    try {
      const cur = await this.e.obs.currentTransition();
      if (cur.name !== this.applied) return;
      // The duration first: OBS's own transition may be a fixed one.
      if (saved.durationMs !== null && !cur.fixed && cur.durationMs !== saved.durationMs) await this.e.obs.setTransitionDuration(saved.durationMs);
      if (cur.name !== saved.name) await this.e.obs.setTransition(saved.name);
    } catch (err) {
      this.e.logger.warn("OBS: could not put its transition back", { error: String(err) });
    } finally {
      this.applied = null;
    }
  }

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
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
    // (Highlights going on air from the live scene have the program.)
    if (mode === "LIVE" && this.e.highlightsAir?.onAir() !== true) {
      if (st.timeouts && paused && scenes.BREAK) want = "BREAK";
      // (Highlights that start by themselves when a map ends go first: the studio scene after them.)
      else if (st.mapEnd && ended && scenes.STUDIO && this.e.highlightsAir?.holdsMapEnd() !== true) want = "STUDIO";
    } else if (mode === "LIVE") {
      // Waiting for the highlights.
    } else if (this.ours && mode === this.ours) {
      if (this.ours === "BREAK" && !paused) want = "LIVE";
      if (this.ours === "STUDIO" && !ended && s.mapName !== null && (s.mapName !== this.mapAtEnd || s.roundPhase === "live")) want = "LIVE";
      // (Highlights from the scene this automation chose go back to it, and it stays its own.)
    } else if (!(mode === "HIGHLIGHTS" && this.e.program.highlightsReturn?.mode === this.ours)) this.ours = null;
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
