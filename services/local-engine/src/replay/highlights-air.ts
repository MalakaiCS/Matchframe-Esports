import { z } from "zod";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { ProgramOwner } from "../production/program.ts";
import type { SequenceResult, Stage } from "./auto.ts";
import { GRAPHIC_SOURCE, halfRounds, isHalfStart } from "./graphic.ts";
import type { KeptMap } from "./highlights.ts";
import { SceneTwin, HIGHLIGHTS_TWIN, REPLAY_MEDIA_SETTINGS, type TwinStatus } from "./twin.ts";
import { VMIX_TRANSITIONS } from "./vmix.ts";

/**
 * Highlights on air (ADR-063): a map's best clips played on the program when the operator presses
 * Play (or by themselves when a map ends, or at halftime when allowed), back to back on the highlights
 * scene and its twin, fading from one to the next, with the replay graphic, the live audio turned
 * down, Skip, Hold and Stop: automatic replays' own engine (replay/auto.ts, a Stage). Then the program
 * goes back to where it came from: the operator's own scene (a multiview's analysis scene), the live,
 * studio or break scene; to the live scene when a round is live or that scene is gone.
 *
 * The clips are the ones kept for highlight reels (replay/highlights.ts: the replay list drops clips):
 * this map, the last half of it, or the previous map; the best N by the replay ranking, or every
 * played clip; in round order, then by when their play happened; each with the part replays show.
 *
 * Halftime (the game's halftime phase, and the end of a half's last round and the freeze time before
 * the next half's first round): with "Don't show highlights at halftime" on (the default), no
 * highlights start then, by Play, a hotkey, a Stream Deck or by themselves.
 */

export const HighlightsAirSettings = z.object({
  /** Which clips: this map, the last half of it (MR12 halves, overtime halves of 3 rounds), or the previous map. */
  what: z.enum(["map", "half", "previous"]).default("map"),
  /** The best N by the replay ranking's score, or every played clip. */
  count: z.union([z.literal("all"), z.number().int().min(1).max(60)]).default(5),
  /** With the best N: also clips that weren't played. */
  unplayed: z.boolean().default(false),
  /** Don't show highlights at halftime: none start then, by Play or by themselves. */
  noHalftime: z.boolean().default(true),
  /** With noHalftime off: start by themselves at halftime, from the live scene. */
  autoHalftime: z.boolean().default(false),
  /** Start by themselves when a map ends, from the live scene. */
  autoMapEnd: z.boolean().default(false),
  /** vMix: to the first highlight (null: as automatic replays' Replay in), and back after the last (null: as their Replay out). */
  vmixIn: z.enum(VMIX_TRANSITIONS).nullable().default(null),
  vmixOut: z.enum(VMIX_TRANSITIONS).nullable().default(null),
});
export type HighlightsAirSettings = z.infer<typeof HighlightsAirSettings>;
export const HighlightsAirPatch = z.object({
  what: HighlightsAirSettings.shape.what.unwrap().optional(),
  count: HighlightsAirSettings.shape.count.unwrap().optional(),
  unplayed: z.boolean().optional(),
  noHalftime: z.boolean().optional(),
  autoHalftime: z.boolean().optional(),
  autoMapEnd: z.boolean().optional(),
  vmixIn: HighlightsAirSettings.shape.vmixIn.unwrap().optional(),
  vmixOut: HighlightsAirSettings.shape.vmixOut.unwrap().optional(),
});

/** The scene and media source "Set up OBS highlights scene" makes. */
export const HIGHLIGHTS_SCENE = "Matchframe Highlights";
export const HIGHLIGHTS_INPUT = "Matchframe Highlights Clip";
const MEDIA_KEY = HIGHLIGHTS_TWIN.mediaKey;
const SETTINGS_KEY = "highlights.air";
/** The program's holder while highlights are on air. */
export const HIGHLIGHTS_HOLDER = "highlights";
const TICK_MS = 500;
const PLAN_CACHE_MS = 1000;

const refuse = (message: string, code = "highlights_refused") => new HttpError(409, message, code);

/** A clip that will play, for the panel's list. */
export interface AirClip {
  id: string;
  label: string;
  roundNumber: number | null;
  played: boolean;
  score: number;
  reasons: string[];
  /** How much of it plays (the play and its lead-up, as replays). */
  playMs: number;
}

/** What Play would play now. */
export interface AirPlan {
  mapKey: string;
  mapName: string;
  title: string | null;
  what: HighlightsAirSettings["what"];
  /** The half's rounds (what: half). */
  rounds: { from: number; to: number } | null;
  clips: AirClip[];
  /** The running time: the clips at the replays' speed, less the fades between them. */
  totalMs: number;
}

/** The highlights scene in OBS: mapped, there, with its media source, its twin and the replay graphic. */
export interface AirSetup {
  mixer: "obs" | "vmix";
  obsConnected: boolean;
  scene: string | null;
  input: string | null;
  /** The scene exists in OBS with the media source directly in it, a Media Source. */
  sceneReady: boolean;
  /** The highlights scene is the replay scene (with the same media source): the replay scene's twin serves both. */
  sameAsReplay: boolean;
  twin: TwinStatus | null;
  graphic: { source: string; inScene: boolean; onTop: boolean } | null;
  detail: string;
}

export interface AirStatus {
  state: "ready" | "playing" | "blocked";
  /** "Highlight 3 of 8: <label>" while they play; else what Play would do, or why it can't. */
  detail: string;
  running: boolean;
  held: boolean;
  position: { n: number; of: number } | null;
  playing: { id: string; label: string } | null;
  /** Why Play is refused now, or null. */
  blocked: string | null;
  /** It is halftime now (the game's halftime phase, or around a half's first round). */
  halftime: boolean;
  plan: AirPlan | null;
  /** The last highlights on air. */
  last: { at: string; by: "operator" | "automation"; played: number; skipped: number; failed: number; stopped: string | null; error: string | null; backTo: string | null } | null;
  /** The last automatic start (or why one didn't start). */
  auto: { at: string; trigger: "halftime" | "map end"; started: boolean; detail: string } | null;
}

export class HighlightsOnAir {
  /** The highlights scene's twin (replay/twin.ts). */
  readonly twin: SceneTwin;
  private timer: ReturnType<typeof setInterval> | null = null;
  private starting = false;
  private last: AirStatus["last"] = null;
  private autoNote: AirStatus["auto"] = null;
  /** Automatic starts already handled (started, or let go): by map and half, or map end. */
  private readonly handled = new Set<string>();
  private planCache: { key: string; at: number; plan: AirPlan | null } | null = null;

  constructor(private readonly e: Engine) {
    this.twin = new SceneTwin(e, HIGHLIGHTS_TWIN);
  }

  settings(): HighlightsAirSettings {
    const r = HighlightsAirSettings.safeParse(this.e.settings.get(SETTINGS_KEY, {}));
    return r.success ? r.data : HighlightsAirSettings.parse({});
  }

  setSettings(patch: z.infer<typeof HighlightsAirPatch>): HighlightsAirSettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = HighlightsAirSettings.parse({ ...this.settings(), ...given });
    this.e.settings.set(SETTINGS_KEY, next);
    this.planCache = null;
    return next;
  }

  start(): void {
    this.twin.init();
    this.timer = setInterval(() => this.autoTick(), TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  mediaInput(): string | null {
    return this.e.settings.get<string | null>(MEDIA_KEY, null);
  }

  /** The highlights scene is the replay scene with the same media source: the replay scene's twin serves both. */
  private sameAsReplay(): boolean {
    const m = this.e.program.sceneMap;
    return !!m.HIGHLIGHTS && m.HIGHLIGHTS === m.REPLAY && this.mediaInput() === this.e.settings.get<string | null>("replay.mediaInput", null);
  }

  private twinOf(): SceneTwin {
    return this.sameAsReplay() ? this.e.replayTwin : this.twin;
  }

  /** Highlights are on air (or going on air) now. */
  onAir(): boolean {
    return this.starting || this.e.autoReplay.runningKind() === "highlights";
  }

  private regulation(): number {
    return this.e.activeMatch()?.format.regulationRounds ?? 24;
  }

  /** Halftime now (isHalftime). */
  halftime(): boolean {
    const s = this.e.session.state();
    return !!s && isHalftime(s, this.regulation());
  }

  /** Where highlights play, and who has the program meanwhile. */
  private stage(owner: ProgramOwner): Stage {
    const st = this.settings();
    const rs = this.e.autoReplay.settings();
    const twin = this.twinOf();
    return {
      mode: "HIGHLIGHTS",
      owner,
      holder: HIGHLIGHTS_HOLDER,
      main: () => {
        const scene = this.e.program.sceneMap.HIGHLIGHTS;
        const input = this.mediaInput();
        return scene && input ? { scene, input } : null;
      },
      twin: () => twin.sync(),
      twinDetail: () => twin.getStatus().detail,
      scenes: () => this.e.program.highlightsScenes,
      vmixIn: st.vmixIn ?? rs.vmixTransition,
      vmixOut: st.vmixOut ?? rs.vmixTransitionOut ?? rs.vmixTransition,
    };
  }

  // ------------------------------------------------------------------ what plays

  /** The map the choice is of: this map (or its last half), or the previous one. */
  private mapFor(st: HighlightsAirSettings): KeptMap | null {
    return st.what === "previous" ? this.e.highlights.previous() : this.e.highlights.current();
  }

  /**
   * The clips Play plays now, in order, with their running time; null when no map is kept. Reused for
   * a second (the tally and the panel ask often; each kept file is looked at), unless `fresh`.
   */
  plan(st: HighlightsAirSettings = this.settings(), fresh = false): AirPlan | null {
    const key = JSON.stringify([st.what, st.count, st.unplayed, this.e.highlights.current()?.key ?? null]);
    const cached = this.planCache;
    if (!fresh && cached && cached.key === key && this.e.now() - cached.at < PLAN_CACHE_MS) return cached.plan;
    const plan = this.makePlan(st);
    this.planCache = { key, at: this.e.now(), plan };
    return plan;
  }

  private makePlan(st: HighlightsAirSettings): AirPlan | null {
    const h = this.e.highlights;
    const map = this.mapFor(st);
    if (!map) return null;
    const last = st.what === "half" ? h.lastRound(map) : null;
    const rounds = last !== null ? halfRounds(last, this.regulation()) : null;
    const chosen = h.choose(map, { count: st.count, unplayed: st.unplayed, rounds });
    const clips: AirClip[] = chosen.map(({ c, score, reasons }) => ({ id: c.id, label: c.label, roundNumber: c.roundNumber, played: c.played, score, reasons, playMs: c.playMs ?? c.media.durationMs ?? 8000 }));
    const rs = this.e.autoReplay.settings();
    const media = clips.reduce((n, c) => n + c.playMs, 0);
    const fades = rs.between === "fade" ? rs.fadeMs * Math.max(0, clips.length - 1) : 0;
    return { mapKey: map.key, mapName: map.mapName, title: map.title, what: st.what, rounds, clips, totalMs: Math.max(0, Math.round((media * 100) / rs.speedPercent) - fades) };
  }

  // ------------------------------------------------------------------ playing

  /** Why Play can't start highlights now, or null. */
  blocked(): string | null {
    const kind = this.e.autoReplay.runningKind();
    if (kind === "highlights") return "Highlights are on air already.";
    if (kind === "test") return "Test replays are playing: try again after them.";
    if (kind === "break") return "The round's replays are playing: wait for them, or press Stop.";
    const s = this.e.session.state();
    if (s?.roundPhase === "live") return "A round is live: highlights start between rounds, or after the map.";
    if (this.settings().noHalftime && this.halftime()) return "Highlights at halftime are off (Don't show highlights at halftime).";
    const why = this.setupBlocked();
    if (why) return why;
    const plan = this.plan();
    if (!plan) return this.settings().what === "previous" ? "No previous map is kept." : "No clips are kept for this map yet.";
    if (!plan.clips.length) return this.settings().count === "all" ? "No clip of it has been played yet: choose the best N, with unplayed clips." : "No clips are kept for it yet.";
    return null;
  }

  /** Why the mixer (and the program) can't take highlights now, or null. */
  private setupBlocked(): string | null {
    const rs = this.e.autoReplay.settings();
    if (rs.mixer === "vmix") {
      return this.e.autoReplay.vmixConnected() ? null : `vMix doesn't answer at ${rs.vmixUrl}: turn on its Web Controller (vMix → Settings → Web Controller).`;
    }
    const p = this.e.program;
    const scene = p.sceneMap.HIGHLIGHTS;
    if (!this.e.obs.state.connected) return "Connect OBS on this computer (Settings → Devices).";
    if (!scene || !this.mediaInput()) return "Set up the highlights scene: Set up OBS highlights scene, or pick your own scene and its media source.";
    if (!this.e.obs.state.scenes.includes(scene)) return `OBS has no scene “${scene}”: set up the highlights scene again.`;
    if (p.mode === "REPLAY_PLAYING" || p.mode === "REPLAY_PREPARED") return "A replay is on air: try again after it.";
    if (p.mode === "DEGRADED") return "The program lost OBS: press Return live first.";
    if (p.mode === "HIGHLIGHTS") return "Highlights are on air already.";
    return null;
  }

  /**
   * Plays the highlights now (Play, a hotkey, a Stream Deck: the operator; or the automatic start).
   * Refused (409) with why when they can't.
   */
  async play(by: { owner: ProgramOwner; who: string }): Promise<AirStatus> {
    if (this.starting) throw refuse("Highlights are starting.");
    this.starting = true;
    try {
      if (this.e.autoReplay.settings().mixer === "vmix") await this.e.autoReplay.checkVmix();
      this.e.highlights.tick();
      this.plan(this.settings(), true);
      const why = this.blocked();
      if (why) throw refuse(why);
      const plan = this.plan()!;
      const items = plan.clips.map((c) => this.e.highlights.asItem(this.e.highlights.find(c.id)!.clip));
      const from = this.e.program.mode === "MANUAL" ? (this.e.program.operatorScene ?? "MANUAL") : this.e.program.mode;
      const auto = by.owner === "automation";
      // (Sets the replays playing at once: from here, Skip, Hold and Stop act on the highlights.)
      const run = this.e.autoReplay.playHighlights(items, this.stage(by.owner));
      this.e.audit.record(by.who, "highlights.on_air", plan.mapKey, { clips: plan.clips.length, what: plan.what, rounds: plan.rounds, from, mixer: this.e.autoReplay.settings().mixer });
      void run.then(
        (r) => this.finished(r, auto),
        (err) => {
          this.e.logger.warn("highlights: stopped by an error", { error: String(err) });
          this.finished({ played: 0, skipped: 0, failed: items.length, error: err instanceof Error ? err.message : String(err), stopped: null }, auto);
        },
      );
    } finally {
      this.starting = false;
    }
    return this.status();
  }

  private finished(r: SequenceResult, auto: boolean): void {
    const p = this.e.program;
    const backTo = this.e.autoReplay.settings().mixer === "vmix" ? null : p.mode === "MANUAL" ? (p.operatorScene ?? this.e.obs.state.programScene) : this.e.obs.state.programScene;
    this.last = { at: new Date().toISOString(), by: auto ? "automation" : "operator", played: r.played, skipped: r.skipped, failed: r.failed, stopped: r.stopped, error: r.error, backTo };
    this.e.audit.record(HIGHLIGHTS_HOLDER, "highlights.on_air_done", null, { ...this.last });
  }

  /** Stop: the highlights end now, back to where the program came from (Highlights out). */
  stop(who: string): AirStatus {
    if (this.e.autoReplay.runningKind() !== "highlights") throw refuse("No highlights are on air.", "no_highlights");
    this.e.autoReplay.stop();
    this.e.audit.record(who, "highlights.on_air_stop", null, {});
    return this.status();
  }

  status(): AirStatus {
    const a = this.e.autoReplay;
    const running = a.runningKind() === "highlights";
    const plan = this.plan();
    const blocked = running ? null : this.blocked();
    const halftime = this.halftime();
    if (running) {
      const st = a.getStatus();
      // (Until the first clip is on air, the replays' status is still theirs.)
      const detail = st.state === "playing" && st.playing ? st.detail : "Highlights going on air…";
      return { state: "playing", detail, running, held: st.held, position: st.position, playing: st.playing, blocked: null, halftime, plan, last: this.last, auto: this.autoNote };
    }
    const lastLine = this.last ? `Last highlights: ${this.last.played} played${this.last.skipped ? ` (${this.last.skipped} skipped)` : ""}${this.last.failed ? `, ${this.last.failed} didn't play` : ""}${this.last.stopped === "stopped" ? ", stopped by the operator" : this.last.stopped === "deadline" ? ", back to live by the round clock" : this.last.stopped === "taken" ? ", the program was taken" : ""}.` : null;
    const detail = blocked ?? (plan ? `Play: ${plan.clips.length} clip${plan.clips.length === 1 ? "" : "s"}, ${fmtLen(plan.totalMs)}.` : "Ready.");
    return { state: blocked ? "blocked" : "ready", detail: lastLine && !blocked ? `${detail} ${lastLine}` : detail, running, held: false, position: null, playing: null, blocked, halftime, plan, last: this.last, auto: this.autoNote };
  }

  /** For button lights (the devices' tally). */
  brief(): { running: boolean; held: boolean; onAir: string | null; position: { n: number; of: number } | null; ready: boolean; halftime: boolean; noHalftime: boolean } {
    const running = this.e.autoReplay.runningKind() === "highlights";
    const st = running ? this.e.autoReplay.brief() : null;
    return { running, held: st?.held ?? false, onAir: st?.onAir ?? null, position: st?.position ?? null, ready: !running && this.blocked() === null, halftime: this.halftime(), noHalftime: this.settings().noHalftime };
  }

  // ------------------------------------------------------------------ automatic start

  /** The key of an automatic start that applies now (halftime or the map's end), or null. */
  private trigger(): { key: string; trigger: "halftime" | "map end" } | null {
    const s = this.e.session.state();
    const st = this.settings();
    if (!s) return null;
    const map = this.e.highlights.current()?.key ?? s.mapName ?? "map";
    if (s.mapPhase === "gameover" || s.gamePhase === "gameover") return st.autoMapEnd ? { key: `${map}:end`, trigger: "map end" } : null;
    if (st.autoHalftime && !st.noHalftime && this.halftime()) {
      const r = s.roundNumber ?? 0;
      return { key: `${map}:half:${halfRounds(Math.max(1, r), this.regulation()).from}`, trigger: "halftime" };
    }
    return null;
  }

  /**
   * The map just ended and highlights will start by themselves (once the round's replays are over):
   * the OBS automation's studio scene waits for them (it comes after them).
   */
  holdsMapEnd(): boolean {
    if (this.onAir()) return true;
    const t = this.trigger();
    return t?.trigger === "map end" && !this.handled.has(t.key) && this.e.autoReplay.settings().mixer === "obs";
  }

  /**
   * The automatic start: at the map's end (and at halftime, when allowed), once the round's replays
   * are over, and only from the live scene: never over the operator's own scene, the studio or break
   * scene, or a round's replays. Once per halftime and map end.
   */
  private autoTick(): void {
    if (this.onAir()) return;
    const t = this.trigger();
    if (!t || this.handled.has(t.key)) return;
    // The round's replays first.
    if (this.e.autoReplay.replaysDue()) return;
    this.handled.add(t.key);
    if (this.handled.size > 50) this.handled.delete(this.handled.values().next().value!);
    const note = (started: boolean, detail: string) => (this.autoNote = { at: new Date().toISOString(), trigger: t.trigger, started, detail });
    const p = this.e.program;
    if (p.mode !== "LIVE") {
      note(false, p.operatorScene ? `Not started at ${t.trigger}: OBS showed your scene “${p.operatorScene}”.` : `Not started at ${t.trigger}: the program wasn't on the live scene (${p.mode.replace(/_/g, " ").toLowerCase()}).`);
      return;
    }
    this.play({ owner: "automation", who: `highlights (${t.trigger})` }).then(
      () => note(true, `Started at ${t.trigger}.`),
      (err) => note(false, `Not started at ${t.trigger}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // ------------------------------------------------------------------ OBS

  /** The highlights scene in OBS as it is now: there, with its media source, its twin, the replay graphic on top. */
  async setup(): Promise<AirSetup> {
    const mixer = this.e.autoReplay.settings().mixer;
    const obs = this.e.obs;
    const scene = this.e.program.sceneMap.HIGHLIGHTS;
    const input = this.mediaInput();
    const base: AirSetup = { mixer, obsConnected: obs.state.connected, scene, input, sceneReady: false, sameAsReplay: this.sameAsReplay(), twin: scene ? this.twinOf().getStatus() : null, graphic: null, detail: "" };
    if (mixer === "vmix") return { ...base, detail: "Highlights play in vMix, as automatic replays do: no OBS scene is needed." };
    if (!obs.state.connected) return { ...base, detail: "Connect OBS to set up the highlights scene." };
    if (!scene || !input) return { ...base, detail: "No highlights scene yet: Set up OBS highlights scene, or pick your own scene and its media source." };
    if (!obs.state.scenes.includes(scene)) return { ...base, detail: `OBS has no scene “${scene}”.` };
    try {
      const items = await obs.sceneItemsFull(scene);
      const media = items.find((i) => i.sourceName === input);
      const kind = media ? (await obs.inputSettings(input).catch(() => null))?.kind : null;
      const sceneReady = !!media && kind === "ffmpeg_source";
      const graphic = { source: GRAPHIC_SOURCE, ...(await this.e.replayGraphic.inScene(scene)) };
      const detail = !media ? `“${scene}” has no media source “${input}” of its own (not in a group).` : kind !== "ffmpeg_source" ? `“${input}” isn't a Media Source.` : !graphic.inScene ? "Ready. The replay graphic isn't in it: press Add the replay graphic." : !graphic.onTop ? "Ready. The replay graphic isn't on top: move it to the top in OBS." : "Ready, with the replay graphic on top.";
      return { ...base, sceneReady, graphic, detail };
    } catch (err) {
      return { ...base, detail: `OBS didn't answer: ${err instanceof Error ? err.message : String(err)}.` };
    }
  }

  /**
   * One click: the "Matchframe Highlights" scene with its media source (the replay source's media
   * settings), mapped, the replay graphic's browser source on top (the same source as in the replay
   * scene), and its twin for fading.
   */
  async setupObs(): Promise<{ scene: string; input: string; created: boolean; graphic: { created: boolean; onTop: boolean } | null; graphicError: string | null; setup: AirSetup }> {
    if (!this.e.obs.state.connected) throw new HttpError(409, "connect OBS first (Settings → Devices)", "obs_not_connected");
    const made = await this.e.obs.ensureInput({ sceneName: HIGHLIGHTS_SCENE, inputName: HIGHLIGHTS_INPUT, inputKind: "ffmpeg_source", settings: { is_local_file: true, ...REPLAY_MEDIA_SETTINGS } });
    const scenes = { ...this.e.program.sceneMap, HIGHLIGHTS: HIGHLIGHTS_SCENE };
    this.e.settings.set("program.scenes", scenes);
    this.e.program.setScenes(scenes);
    this.e.settings.set(MEDIA_KEY, HIGHLIGHTS_INPUT);
    const graphic = await this.addGraphic();
    await this.twinOf().sync();
    return { scene: HIGHLIGHTS_SCENE, input: HIGHLIGHTS_INPUT, created: made.created, graphic: graphic.ok, graphicError: graphic.error, setup: await this.setup() };
  }

  /** The operator's own scene and its media source for highlights (null: none), saved with the program's scenes; its twin made. */
  async mapScene(scene: string | null, input: string | null): Promise<AirSetup> {
    if (scene && !input) throw new HttpError(400, "pick the scene's media source too", "validation");
    const scenes = { ...this.e.program.sceneMap, HIGHLIGHTS: scene };
    this.e.settings.set("program.scenes", scenes);
    this.e.program.setScenes(scenes);
    this.e.settings.set(MEDIA_KEY, scene ? input : null);
    if (scene && this.e.obs.state.connected) await this.twinOf().sync();
    return this.setup();
  }

  /** The replay graphic's browser source on top of the highlights scene (the replay-graphic route's logic, the same source). */
  async addGraphic(): Promise<{ ok: { created: boolean; onTop: boolean } | null; error: string | null }> {
    try {
      const r = await this.e.replayGraphic.setupObs(this.e.program.sceneMap.HIGHLIGHTS);
      return { ok: { created: r.created, onTop: r.onTop }, error: null };
    } catch (err) {
      return { ok: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Halftime: the game's halftime phase, and around the first round of a half other than the map's
 * first (the second half, an overtime half; graphic.ts's halves): from the end of the half's last
 * round (the game's round number has moved on to the next by then) through the next one's freeze
 * time. Not once the map is over, nor in warmup.
 */
export function isHalftime(s: Pick<MatchState, "mapPhase" | "gamePhase" | "roundPhase" | "roundNumber">, regulation = 24): boolean {
  if (s.mapPhase === "gameover" || s.gamePhase === "gameover" || s.mapPhase === "warmup" || s.gamePhase === "warmup") return false;
  if (s.gamePhase === "halftime" || s.mapPhase === "intermission") return true;
  if (s.roundPhase === "live" || s.roundNumber === null) return false;
  return isHalfStart(s.roundNumber, regulation);
}

/** m:ss. */
const fmtLen = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;
