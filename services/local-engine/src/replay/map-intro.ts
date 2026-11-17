import { basename, join } from "node:path";
import { z } from "zod";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { existingName } from "../brand.ts";
import { effectiveVetoEntries } from "../domain/veto-entries.ts";
import { HttpError } from "../http/router.ts";
import { mapDisplayName } from "../live/projection.ts";
import type { ProgramOwner } from "../production/program.ts";
import { ffprobeBeside, MAP_INTRO_SLOTS, MapIntroStore, slotLabel, type MapIntroSlot, type StoredIntro } from "./map-intro-store.ts";
import { INTRO_TRIGGERS, IntroTriggerWatch, MOMENT_AT, normalMap, secondHalfStart, TRIGGER_AT, TRIGGER_LABEL, type IntroMoment, type MomentKind } from "./map-intro-trigger.ts";
import { VMIX_TRANSITIONS, VmixClient, type VmixInput } from "./vmix.ts";

/**
 * Map intros (ADR-079): one video per map, played on the program by itself at the moment the
 * operator picks (map-intro-trigger.ts), or by Play map intro / Play next map's intro (the console,
 * a hotkey, a Stream Deck). As highlights on air go (ADR-063):
 *
 * - **OBS:** the "MatchFrame Map Intro" scene with one Media Source, made (or repaired) by MatchFrame
 *   as an intro plays, its file set to the map's intro off air; the program goes to it (MAP_INTRO)
 *   with the intro transition (OBS scenes → Transitions: the MatchFrame Stinger by default, when OBS
 *   has it, else OBS's own), waits for OBS to say the media ended (with a fallback from the probed
 *   length), and goes back to where it came from: the live scene, the studio or break scene, the
 *   operator's own scene; the live scene when a round is live or that scene is gone.
 * - **vMix:** the intro added as an input, transitioned to (Map intro in; the replays' Replay in by
 *   default), back to the input that was on air (Map intro out), the input removed.
 * - The live game audio picked for replays is turned down meanwhile, and put back after.
 *
 * Never over a live round: it doesn't start in one, and when the round goes live during it (the
 * freeze time ends), it cuts back to the game (by default: the cut starts just before the freeze
 * time ends) or plays to its end (Finish the intro), then the live scene. Each map's intro plays by
 * itself once per map per match (Both pistol rounds: once per half); a press plays it again.
 */

export const MapIntroSettings = z.object({
  /** When it starts by itself. */
  trigger: z.enum(INTRO_TRIGGERS).default("pistol"),
  /** If the round goes live during the intro: cut back to the game, or finish it (viewers miss the round's start). */
  onLive: z.enum(["cut", "finish"]).default("cut"),
  /** vMix: to the intro (null: the replays' Replay in), and back (null: their Replay out). */
  vmixIn: z.enum(VMIX_TRANSITIONS).nullable().default(null),
  vmixOut: z.enum(VMIX_TRANSITIONS).nullable().default(null),
});
export type MapIntroSettings = z.infer<typeof MapIntroSettings>;
export const MapIntroPatch = z.object({
  trigger: MapIntroSettings.shape.trigger.unwrap().optional(),
  onLive: MapIntroSettings.shape.onLive.unwrap().optional(),
  vmixIn: MapIntroSettings.shape.vmixIn.unwrap().optional(),
  vmixOut: MapIntroSettings.shape.vmixOut.unwrap().optional(),
});

/** The scene and media source MatchFrame makes in OBS. */
export const MAP_INTRO_SCENE = "MatchFrame Map Intro";
export const MAP_INTRO_INPUT = "MatchFrame Map Intro Video";
/** The program's holder while an intro is on air. */
export const MAP_INTRO_HOLDER = "map-intro";
/**
 * The intro's media source: it starts from the beginning when shown (its file is set off air), holds
 * its last frame while the transition back runs, plays once, and decodes on the graphics card where it can.
 */
export const INTRO_MEDIA_SETTINGS = { restart_on_activate: true, close_when_inactive: false, clear_on_media_end: false, looping: false, hw_decode: true } as const;

const SETTINGS_KEY = "mapIntro.settings";
const PLAYED_KEY = "mapIntro.played";
const TICK_MS = 200;
const POLL_MS = 100;
/** Without OBS (or vMix) saying the intro ended: its probed length and this, then back. */
const END_SLACK_MS = 2000;
/** OBS's "ended" this soon after the program change is an earlier file's. */
const STALE_END_MS = 250;
/** Cut back to the game: the cut back starts this long before the freeze time ends (a stinger has cut to the game as the round goes live). */
const CUT_BEFORE_LIVE_MS = 1000;
/** Cut back to the game: an intro doesn't start with less freeze time than this left (it would be cut at once). */
const MIN_FREEZE_LEFT_MS = 3000;
/** vMix: the transition to the intro may still show the input before for this long. */
const VMIX_SETTLE_MS = 1200;
/** The intro source is emptied this long after the intro (the transition back is over), so OBS lets go of the file. */
const EMPTY_AFTER_MS = 4000;
/** Plays recorded (once per map per match), at most. */
const PLAYED_MAX = 300;

const refuse = (message: string, code = "map_intro_refused") => new HttpError(409, message, code);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A round of the match is live (the warmup, where CS2 says the round is live too, isn't one). */
const roundLive = (s: Pick<MatchState, "roundPhase" | "mapPhase"> | null) => s?.roundPhase === "live" && s.mapPhase !== "warmup";

/** How an intro on air ended: to its end, cut back as the round went live, stopped, taken by someone else, the fallback, or it failed. */
export type IntroEnd = "ended" | "cut" | "stopped" | "taken" | "timeout" | "failed";

/** A play recorded for once per map per match. */
interface Played {
  key: string;
  at: string;
  by: "operator" | "automation";
  kind: MomentKind | "manual";
}

interface Run {
  map: string;
  slot: MapIntroSlot;
  isDefault: boolean;
  intro: StoredIntro;
  by: "operator" | "automation";
  who: string;
  moment: IntroMoment | null;
  stop: boolean;
  onAirAt: number | null;
  error: string | null;
  backTo: string | null;
}

/** A map as the panel and Live Control show it: its intro (its own or the default), and whether it played this match. */
export interface IntroTarget {
  map: string;
  displayName: string;
  slot: MapIntroSlot | null;
  hasIntro: boolean;
  isDefault: boolean;
  durationMs: number | null;
  played: { at: string; by: "operator" | "automation"; kind: MomentKind | "manual" } | null;
}

export interface MapIntroStatus {
  state: "ready" | "playing" | "waiting" | "blocked";
  /** The status line: on air, waiting, or "Next intro: Mirage, at pistol round start". */
  detail: string;
  /** "Next intro: Mirage, at pistol round start" (or why there is none). */
  next: string;
  running: boolean;
  playing: { map: string; displayName: string; slot: MapIntroSlot; isDefault: boolean; by: "operator" | "automation"; durationMs: number; elapsedMs: number | null } | null;
  /** The map in the game data, and the active match's next map. */
  current: IntroTarget | null;
  nextMap: IntroTarget | null;
  /** Why Play map intro (the current map's), and Play next map's intro, can't play now (null: they can). */
  blocked: string | null;
  blockedNext: string | null;
  /** A moment seen whose intro waits (MatchFrame's replays or highlights on air), until its freeze time (or warmup) ends. */
  waiting: { map: string; kind: MomentKind; why: string } | null;
  last: { at: string; map: string; displayName: string; isDefault: boolean; by: "operator" | "automation"; kind: MomentKind | "manual"; end: IntroEnd; error: string | null; backTo: string | null } | null;
  /** The last moment the intro could start by itself: started, or why not. */
  auto: { at: string; map: string; kind: MomentKind; started: boolean; detail: string } | null;
}

export class MapIntros {
  readonly store: MapIntroStore;
  private readonly watch = new IntroTriggerWatch();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen: string | null = null;
  private run: Run | null = null;
  private starting = false;
  private playing: Promise<unknown> | null = null;
  private waiting: { moment: IntroMoment; why: string } | null = null;
  /** Moments already handled (started, waited out or let go). */
  private readonly handled = new Set<string>();
  private last: MapIntroStatus["last"] = null;
  private autoNote: MapIntroStatus["auto"] = null;
  /** OBS's intro source is emptied after this run (a later one leaves it). */
  private runs = 0;

  constructor(private readonly e: Engine) {
    this.store = new MapIntroStore({
      dir: join(e.cfg.dataDir, "map-intros"),
      settings: e.settings,
      tools: async () => {
        const ffmpeg = await e.ffmpeg.locate();
        return { ffmpeg, ffprobe: ffmpeg ? ffprobeBeside(ffmpeg) : null };
      },
      logger: e.logger,
    });
  }

  settings(): MapIntroSettings {
    const r = MapIntroSettings.safeParse(this.e.settings.get(SETTINGS_KEY, {}));
    return r.success ? r.data : MapIntroSettings.parse({});
  }

  setSettings(patch: z.infer<typeof MapIntroPatch>): MapIntroSettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = MapIntroSettings.parse({ ...this.settings(), ...given });
    this.e.settings.set(SETTINGS_KEY, next);
    return next;
  }

  start(): void {
    this.store.sweep();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The engine is stopping: the intro on air ends (back to where the program came from), within a moment. */
  async beforeShutdown(): Promise<void> {
    this.dispose();
    if (this.run) this.run.stop = true;
    if (this.playing) await Promise.race([this.playing, sleep(3000)]);
  }

  /** An intro is on air (or going on air) now. */
  onAir(): boolean {
    return this.starting || this.run !== null;
  }

  /**
   * An intro is on air, or one is due now or waiting (it plays from the scene the program shows):
   * the OBS automation leaves the program alone meanwhile (its studio scene doesn't go back to live
   * under it as the next map loads).
   */
  holdsProgram(): boolean {
    if (this.onAir() || this.waiting) return true;
    this.observe();
    const s = this.e.session.state();
    const st = this.settings();
    if (!s || st.trigger === "manual") return false;
    const m = this.watch.moment(s, st.trigger, this.regulation());
    return !!m && !this.handled.has(m.id) && !this.isPlayed(m.map, m.slot) && this.store.forMap(m.map) !== null && this.autoBlocked(s) === null;
  }

  private regulation(): number {
    return this.e.activeMatch()?.format.regulationRounds ?? 24;
  }

  // ------------------------------------------------------------------ once per map per match

  /** The match the plays are recorded under: the active match, or "none" (then a map's intro may play again once another map was played). */
  private matchKey(): string {
    return this.e.activeMatch()?.id ?? "none";
  }

  private playedList(): Played[] {
    const v = this.e.settings.get<Played[]>(PLAYED_KEY, []);
    return Array.isArray(v) ? v.filter((p) => p && typeof p.key === "string") : [];
  }

  private playedOf(map: string, slot: IntroMoment["slot"]): Played | null {
    const key = `${this.matchKey()}|${map}|${slot}`;
    return this.playedList().find((p) => p.key === key) ?? null;
  }

  private isPlayed(map: string, slot: IntroMoment["slot"]): boolean {
    return this.playedOf(map, slot) !== null;
  }

  private markPlayed(map: string, slot: IntroMoment["slot"], by: Played["by"], kind: Played["kind"]): void {
    const key = `${this.matchKey()}|${map}|${slot}`;
    const list = [...this.playedList().filter((p) => p.key !== key), { key, at: new Date().toISOString(), by, kind }];
    this.e.settings.set(PLAYED_KEY, list.slice(-PLAYED_MAX));
  }

  /** Without an active match: a map change forgets the other maps' plays (the same map can come round again). */
  private forgetOthers(map: string): void {
    const list = this.playedList();
    const kept = list.filter((p) => !p.key.startsWith("none|") || p.key.split("|")[1] === map);
    if (kept.length !== list.length) this.e.settings.set(PLAYED_KEY, kept);
  }

  // ------------------------------------------------------------------ which map

  /** Each new game state, once, in order. */
  private observe(): void {
    const s = this.e.session.state();
    if (!s) return;
    const id = `${s.sessionId}:${s.epoch}:${s.sequence}`;
    if (id === this.seen) return;
    this.seen = id;
    const change = this.watch.see(s);
    if (change?.from && !this.e.activeMatch()) this.forgetOthers(change.to);
  }

  private currentMap(): string | null {
    return normalMap(this.e.session.state()?.mapName);
  }

  /** The active match's maps in order (its picks and decider), with their status when the match has its maps. */
  private matchMaps(): { map: string; status: string | null }[] {
    const m = this.e.activeMatch();
    if (!m) return [];
    const named = (name: string, status: string | null) => {
      const map = normalMap(name);
      return map ? [{ map, status }] : [];
    };
    const maps = this.e.mapInstances.forMatch(m.id).sort((a, b) => a.order - b.order);
    if (maps.length) return maps.flatMap((x) => named(x.mapName, x.status));
    const { entries } = effectiveVetoEntries(m, this.e.vetoRepo.active(m.id), []);
    return entries.filter((x) => x.type !== "ban").flatMap((x) => named(x.mapName, null));
  }

  /** The next map in the active match's veto: after the map in the game data, else its first map still to be played. */
  private nextMap(): string | null {
    const list = this.matchMaps();
    const cur = this.currentMap();
    const at = cur ? list.findIndex((x) => x.map === cur) : -1;
    if (at >= 0) return list[at + 1]?.map ?? null;
    return list.find((x) => x.status === "upcoming" || x.status === null)?.map ?? null;
  }

  private target(map: string | null): IntroTarget | null {
    if (!map) return null;
    const f = this.store.forMap(map);
    const p = this.playedOf(map, "first");
    return { map, displayName: mapDisplayName(map) ?? map, slot: this.store.slotOf(map), hasIntro: !!f, isDefault: f?.isDefault ?? false, durationMs: f?.intro.durationMs ?? null, played: p ? { at: p.at, by: p.by, kind: p.kind } : null };
  }

  // ------------------------------------------------------------------ why not now

  /** Why an intro of `map` can't go on air now (Play, or by itself), or null. */
  blockedFor(map: string | null, what: "this map" | "the next map" = "this map", starting = false): string | null {
    if (this.run) return "The map intro is on air.";
    if (this.starting && !starting) return "The map intro is starting.";
    const s = this.e.session.state();
    if (roundLive(s)) return "A round is live: the intro plays between rounds (in the warmup, a freeze time, or after the round).";
    if (s && this.tooLate(s)) return "The freeze time is nearly over: the intro would be cut at once (or choose Finish the intro).";
    const kind = this.e.autoReplay.runningKind();
    if (kind === "highlights") return "Highlights are on air: try again after them.";
    if (kind === "test") return "Test replays are playing: try again after them.";
    if (kind === "break") return "The round's replays are playing: wait for them, or press Stop.";
    if (!map) return what === "the next map" ? "The active match has no next map: set its veto under Matches." : "No map yet: the game data has none.";
    if (!this.store.forMap(map)) return `${mapDisplayName(map) ?? map} has no intro, and there is no default intro: add one under Replays & Production → Map intros.`;
    return this.mixerBlocked();
  }

  /** Why the mixer can't take an intro now, or null. */
  private mixerBlocked(): string | null {
    const rs = this.e.autoReplay.settings();
    if (rs.mixer === "vmix") return this.e.autoReplay.vmixConnected() ? null : `vMix doesn't answer at ${rs.vmixUrl}: turn on its Web Controller (vMix → Settings → Web Controller).`;
    const p = this.e.program;
    if (!this.e.obs.state.connected) return "Connect OBS on this computer (Settings → Devices).";
    if (p.mode === "REPLAY_PLAYING" || p.mode === "REPLAY_PREPARED") return "A replay is on air: try again after it.";
    if (p.mode === "HIGHLIGHTS") return "Highlights are on air: try again after them.";
    if (p.mode === "DEGRADED") return "The program lost OBS: press Return live first.";
    return null;
  }

  /**
   * Why an intro can't start by itself now: `wait` while MatchFrame's own replays or highlights are
   * on air (they end; the intro starts then, if its moment is still open), else a reason to let it go.
   * Never over the operator's own scene or a scene they chose (as highlights by themselves).
   */
  private autoBlocked(s: MatchState): { wait: boolean; why: string } | null {
    const kind = this.e.autoReplay.runningKind();
    if (kind || this.e.highlightsAir.onAir()) return { wait: true, why: kind === "highlights" || this.e.highlightsAir.onAir() ? "highlights were on air" : "the round's replays were on air" };
    const p = this.e.program;
    if (this.e.autoReplay.settings().mixer === "obs" && (p.mode === "REPLAY_PLAYING" || p.mode === "REPLAY_PREPARED")) return { wait: true, why: "a replay was on air" };
    if (roundLive(s)) return { wait: false, why: "the round was live" };
    if (this.tooLate(s)) return { wait: false, why: "the freeze time was nearly over" };
    if (this.e.autoReplay.settings().mixer === "obs") {
      if (p.mode === "MANUAL") return { wait: false, why: p.operatorScene ? `OBS showed your scene “${p.operatorScene}”` : "the program was yours (MANUAL)" };
      if ((p.mode === "STUDIO" || p.mode === "BREAK") && p.owner.kind !== "automation" && p.owner.kind !== "schedule") return { wait: false, why: `the program was on the ${p.mode === "STUDIO" ? "studio" : "break"} scene you chose` };
    }
    const why = this.mixerBlocked();
    return why ? { wait: false, why: why.replace(/\.$/, "") } : null;
  }

  /** The freeze time left (ms) by the game data's countdown, or null outside a freeze time (or without the countdown). */
  private freezeLeftMs(s: MatchState): number | null {
    if (s.mapPhase !== "live" || s.roundPhase !== "freezetime" || s.gamePhase !== "freezetime" || s.phaseEndsInSec === null || s.phaseObservedAtMonotonicMs === null) return null;
    return s.phaseEndsInSec * 1000 - (this.e.now() - s.phaseObservedAtMonotonicMs);
  }

  /** Cut back to the game, and too little freeze time left to start (the intro would be cut at once). */
  private tooLate(s: MatchState): boolean {
    const left = this.freezeLeftMs(s);
    return this.settings().onLive === "cut" && left !== null && left < MIN_FREEZE_LEFT_MS;
  }

  // ------------------------------------------------------------------ by itself

  private noteAuto(m: IntroMoment, started: boolean, detail: string): void {
    this.autoNote = { at: new Date().toISOString(), map: m.map, kind: m.kind, started, detail };
    if (!started) this.e.logger.info("map intro: not played by itself", { map: m.map, kind: m.kind, detail });
  }

  private handle(id: string): void {
    this.handled.add(id);
    if (this.handled.size > 100) this.handled.delete(this.handled.values().next().value!);
  }

  private tick(): void {
    this.observe();
    if (this.onAir()) return;
    const s = this.e.session.state();
    const st = this.settings();
    const m = s && st.trigger !== "manual" ? this.watch.moment(s, st.trigger, this.regulation()) : null;
    const w = this.waiting;
    if (w && m?.id !== w.moment.id) {
      // Its freeze time (or warmup) ended while it waited.
      this.waiting = null;
      this.noteAuto(w.moment, false, `${mapDisplayName(w.moment.map) ?? w.moment.map}'s intro wasn't played ${MOMENT_AT[w.moment.kind]}: ${w.why} until ${w.moment.kind === "map_load" ? "the warmup ended" : "the round went live"}.`);
    }
    if (!s || !m || this.handled.has(m.id)) return;
    const name = mapDisplayName(m.map) ?? m.map;
    if (this.isPlayed(m.map, m.slot)) return this.handle(m.id);
    if (!this.store.forMap(m.map)) {
      this.handle(m.id);
      return this.noteAuto(m, false, `${name} has no intro, and there is no default intro: nothing played ${MOMENT_AT[m.kind]}.`);
    }
    const why = this.autoBlocked(s);
    if (why?.wait) {
      this.waiting = { moment: m, why: why.why };
      return;
    }
    this.waiting = null;
    this.handle(m.id);
    if (why) return this.noteAuto(m, false, `${name}'s intro wasn't played ${MOMENT_AT[m.kind]}: ${why.why}. Press Play map intro to play it.`);
    this.begin({ map: m.map, by: "automation", who: `map intro (${TRIGGER_LABEL[st.trigger].toLowerCase()})`, moment: m }).then(
      () => this.noteAuto(m, true, `${name}'s intro played ${MOMENT_AT[m.kind]}${m.knife ? `: ${m.knife}` : ""}.`),
      (err) => this.noteAuto(m, false, `${name}'s intro wasn't played ${MOMENT_AT[m.kind]}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  // ------------------------------------------------------------------ playing

  /**
   * Play map intro (the map in the game data), Play next map's intro (the active match's next map,
   * before the server changes to it), or a map by name: on the program now. Refused (409) with why.
   * The map counts as played (it won't play by itself again this match).
   */
  async play(by: { who: string; which: "current" | "next" | { map: string } }): Promise<MapIntroStatus> {
    const map = by.which === "current" ? this.currentMap() : by.which === "next" ? this.nextMap() : normalMap(by.which.map);
    if (by.which === "next" && !map) throw refuse("The active match has no next map: set its veto under Matches.");
    await this.begin({ map, by: "operator", who: by.who, moment: null });
    return this.status();
  }

  /** Stop: the intro ends now, back to where the program came from (vMix: the input before). */
  stop(who: string): MapIntroStatus {
    if (!this.run) throw refuse("No map intro is on air.", "no_map_intro");
    this.run.stop = true;
    this.e.audit.record(who, "map_intro.stop", this.run.map, {});
    return this.status();
  }

  private async begin(o: { map: string | null; by: "operator" | "automation"; who: string; moment: IntroMoment | null }): Promise<void> {
    if (this.starting) throw refuse("The map intro is starting.");
    this.starting = true;
    try {
      const mixer = this.e.autoReplay.settings().mixer;
      if (mixer === "vmix") await this.e.autoReplay.checkVmix();
      const why = this.blockedFor(o.map, "this map", true);
      if (why) throw refuse(why);
      const f = this.store.forMap(o.map)!;
      // (OBS refusing the scene is said to whoever pressed Play.)
      const where = mixer === "obs" ? await this.ensureScene() : null;
      const run: Run = { map: o.map!, slot: f.slot, isDefault: f.isDefault, intro: f.intro, by: o.by, who: o.who, moment: o.moment, stop: false, onAirAt: null, error: null, backTo: null };
      this.run = run;
      this.e.audit.record(o.who, "map_intro.on_air", run.map, { slot: run.slot, isDefault: run.isDefault, by: o.by, kind: o.moment?.kind ?? "manual", mixer, file: f.intro.file });
      const playing = (where ? this.playObs(run, where) : this.playVmix(run)).then(
        (end) => this.finished(run, end),
        (err) => {
          run.error = err instanceof Error ? err.message : String(err);
          this.finished(run, "failed");
        },
      );
      this.playing = playing;
    } finally {
      this.starting = false;
    }
  }

  /** The intro went on air: the map's play is recorded (once per map per match). */
  private onAirNow(run: Run): void {
    run.onAirAt = this.e.now();
    this.markPlayed(run.map, run.moment?.slot ?? "first", run.by, run.moment?.kind ?? "manual");
  }

  private finished(run: Run, end: IntroEnd): void {
    if (this.run === run) this.run = null;
    this.playing = null;
    this.last = { at: new Date().toISOString(), map: run.map, displayName: mapDisplayName(run.map) ?? run.map, isDefault: run.isDefault, by: run.by, kind: run.moment?.kind ?? "manual", end, error: run.error, backTo: run.backTo };
    if (end === "failed") this.e.logger.warn("map intro: didn't play", { map: run.map, error: run.error });
    this.e.audit.record(MAP_INTRO_HOLDER, "map_intro.on_air_done", run.map, { end, error: run.error, backTo: run.backTo, onAir: run.onAirAt !== null });
  }

  /** Cut back to the game now: the round went live, or its freeze time is about to end (Cut back to the game). */
  private cutNow(): boolean {
    if (this.settings().onLive !== "cut") return false;
    const s = this.e.session.state();
    if (!s) return false;
    if (roundLive(s)) return true;
    const left = this.freezeLeftMs(s);
    return left !== null && left <= CUT_BEFORE_LIVE_MS;
  }

  /**
   * The "MatchFrame Map Intro" scene with its Media Source, made when missing (an OBS set up under
   * the old spelling, "Matchframe Map Intro", is used, not made again), the source put back in the
   * scene if it was taken out, and the scene mapped as the program's MAP_INTRO scene.
   */
  async ensureScene(): Promise<{ scene: string; input: string; created: boolean }> {
    const obs = this.e.obs;
    if (!obs.state.connected) throw refuse("Connect OBS on this computer (Settings → Devices).", "obs_not_connected");
    const scene = existingName(MAP_INTRO_SCENE, (n) => obs.state.scenes.includes(n));
    const input = existingName(MAP_INTRO_INPUT, (n) => obs.state.inputs.some((i) => i.name === n));
    let created = false;
    const there = obs.state.scenes.includes(scene) && obs.state.inputs.some((i) => i.name === input);
    if (!there) created = (await obs.ensureInput({ sceneName: scene, inputName: input, inputKind: "ffmpeg_source", settings: { is_local_file: true, ...INTRO_MEDIA_SETTINGS } })).created;
    else {
      const kind = (await obs.inputSettings(input)).kind;
      if (kind !== "ffmpeg_source") throw refuse(`“${input}” in OBS isn't a Media Source: rename or remove it.`, "bad_source");
    }
    if (!(await obs.sceneItemsFull(scene)).some((i) => i.sourceName === input)) await obs.createSceneItem(scene, input, true);
    if (this.e.program.sceneMap.MAP_INTRO !== scene) {
      const scenes = { ...this.e.program.sceneMap, MAP_INTRO: scene };
      this.e.settings.set("program.scenes", scenes);
      this.e.program.setScenes(scenes);
    }
    return { scene, input, created };
  }

  /** The map intro scene as it is now, for the panel. */
  setup(): { mixer: "obs" | "vmix"; obsConnected: boolean; scene: string | null; exists: boolean; detail: string } {
    const mixer = this.e.autoReplay.settings().mixer;
    const obs = this.e.obs.state;
    const scene = obs.connected ? existingName(MAP_INTRO_SCENE, (n) => obs.scenes.includes(n)) : (this.e.program.sceneMap.MAP_INTRO ?? MAP_INTRO_SCENE);
    const exists = obs.connected && obs.scenes.includes(scene);
    const detail =
      mixer === "vmix"
        ? "Intros play in vMix: each is added as an input, and vMix goes back to the input that was on air."
        : !obs.connected
          ? "Connect OBS: MatchFrame makes the “MatchFrame Map Intro” scene when an intro first plays (or press Set up OBS map intro scene)."
          : exists
            ? `“${scene}” is ready. Add anything you want over the intro to it in OBS (above the video).`
            : "The “MatchFrame Map Intro” scene is made when an intro first plays, or press Set up OBS map intro scene.";
    return { mixer, obsConnected: obs.connected, scene: exists ? scene : null, exists, detail };
  }

  /** OBS: the intro's file set off air, the program to the intro scene, until the media ends (or the round goes live, Stop, someone takes the program), then back. */
  private async playObs(run: Run, { scene, input }: { scene: string; input: string }): Promise<IntroEnd> {
    const obs = this.e.obs;
    const p = this.e.program;
    const owner: ProgramOwner = run.by === "operator" ? "operator" : "automation";
    await obs.setInputSettings(input, { ...INTRO_MEDIA_SETTINGS, is_local_file: true, local_file: this.store.path(run.intro.file), speed_percent: 100 });
    const myRun = ++this.runs;
    // OBS says the media ended (MediaInputPlaybackEnded): listened to from before the program change.
    let armedAt: number | null = null;
    let ended = false;
    const onMedia = (ev: { phase: string; input: string }) => {
      if (ev.input === input && ev.phase === "ended" && armedAt !== null && this.e.now() - armedAt >= STALE_END_MS) ended = true;
    };
    obs.on("media", onMedia);
    const changes = this.e.obsAuto.changesInObs;
    let end: IntroEnd = "ended";
    let ducking: Promise<void> | null = null;
    try {
      armedAt = this.e.now();
      // The live game audio goes down alongside the transition in.
      ducking = this.e.autoReplay.audio.duck();
      const t = await p.request("MAP_INTRO", owner, MAP_INTRO_HOLDER);
      if (!t.confirmed) throw new Error(t.detail ?? `OBS didn't confirm the scene “${scene}”`);
      this.onAirNow(run);
      const deadline = this.e.now() + run.intro.durationMs + END_SLACK_MS;
      for (;;) {
        await sleep(POLL_MS);
        if (run.stop) end = "stopped";
        else if (p.mode !== "MAP_INTRO" || p.owner.holder !== MAP_INTRO_HOLDER || this.e.obsAuto.changesInObs !== changes) end = "taken";
        else if (ended) end = "ended";
        else if (this.cutNow()) end = "cut";
        else if (this.e.now() > deadline) end = "timeout";
        else continue;
        break;
      }
    } catch (err) {
      end = "failed";
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      obs.off("media", onMedia);
      // Back once, unless someone else has the program: where it came from, or the live scene (a round live, cut back, the OBS automation's scene going live now).
      if (end !== "taken" && p.mode === "MAP_INTRO" && p.owner.holder === MAP_INTRO_HOLDER) {
        const back = p.introReturn;
        const live = roundLive(this.e.session.state()) || end === "cut" || (back ? this.e.obsAuto.leavesNow(back.mode) : false);
        try {
          const t = await p.returnFromIntro(owner, MAP_INTRO_HOLDER, { live, exists: (sc) => obs.state.scenes.includes(sc) });
          const to = t?.to ?? null;
          run.backTo = to === "MANUAL" ? p.operatorScene : to === "LIVE" || to === "STUDIO" || to === "BREAK" ? p.sceneMap[to] : null;
        } catch (err) {
          this.e.logger.warn("map intro: could not go back", { error: String(err) });
          run.error ??= `could not go back: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (ducking) await ducking;
      await this.e.autoReplay.audio.restore("the map intro is over");
      if (end !== "taken") void this.emptySource(myRun, scene, input);
    }
    return end;
  }

  /** After the transition back: the intro source is emptied (OBS lets go of the file), and files of replaced intros are removed. */
  private async emptySource(run: number, scene: string, input: string): Promise<void> {
    await sleep(EMPTY_AFTER_MS);
    if (run !== this.runs || this.run || !this.e.obs.state.connected || this.e.obs.state.programScene === scene) return;
    await this.e.obs.setMediaFile(input, "").catch(() => undefined);
    this.store.sweep();
  }

  /** vMix: the intro as an input, Map intro in to it, until it ends (or the round goes live, Stop, another input on air), Map intro out to the input before. */
  private async playVmix(run: Run): Promise<IntroEnd> {
    const rs = this.e.autoReplay.settings();
    const st = this.settings();
    const vmix = new VmixClient(rs.vmixUrl);
    const into = st.vmixIn ?? rs.vmixTransition;
    const out = st.vmixOut ?? rs.vmixTransitionOut ?? rs.vmixTransition;
    let key: string | null = null;
    let before: VmixInput | null = null;
    let onAir = false;
    let end: IntroEnd = "ended";
    let ducking: Promise<void> | null = null;
    try {
      const was = await vmix.state();
      before = was.inputs.find((x) => x.number === was.active) ?? null;
      const path = this.store.path(run.intro.file);
      const name = basename(path);
      const known = new Set(was.inputs.map((x) => x.key));
      await vmix.call("AddInput", { Value: `Video|${path}` });
      let mine: VmixInput | null = null;
      for (let k = 0; k < 30 && !mine; k++) {
        const now = await vmix.state();
        mine = now.inputs.find((x) => !known.has(x.key) && x.title.includes(name)) ?? now.inputs.find((x) => !known.has(x.key)) ?? null;
        if (!mine) await sleep(100);
      }
      if (!mine) throw new Error("vMix didn't add the intro as an input");
      key = mine.key;
      await vmix.call("Play", { Input: key });
      ducking = this.e.autoReplay.audio.duck();
      await vmix.call(into, { Input: key });
      onAir = true;
      this.onAirNow(run);
      const startedAt = this.e.now();
      const deadline = startedAt + run.intro.durationMs + END_SLACK_MS;
      for (;;) {
        await sleep(POLL_MS);
        if (run.stop) end = "stopped";
        else if (this.cutNow()) end = "cut";
        else if (this.e.now() > deadline) end = "timeout";
        else {
          const now = await vmix.state().catch(() => null);
          const it = now?.inputs.find((x) => x.key === key);
          // Someone put another input on air (once the transition to the intro had time to finish): left there.
          if (now && it && now.active !== it.number && this.e.now() - startedAt > VMIX_SETTLE_MS) end = "taken";
          else if (now && (!it || it.state === "Completed" || (it.duration > 0 && it.position >= it.duration - 60))) end = "ended";
          else continue;
        }
        break;
      }
    } catch (err) {
      end = "failed";
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      if (onAir && end !== "taken" && before) {
        try {
          await vmix.call(out, { Input: before.key });
          run.backTo = before.title;
        } catch (err) {
          this.e.logger.warn("map intro: vMix didn't go back", { error: String(err) });
          run.error ??= `vMix didn't go back: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (ducking) await ducking;
      await this.e.autoReplay.audio.restore("the map intro is over");
      // The input goes once the transition back is over.
      const gone = key;
      if (gone) setTimeout(() => void vmix.call("RemoveInput", { Input: gone }).catch(() => undefined), 2000).unref?.();
    }
    return end;
  }

  // ------------------------------------------------------------------ status

  /** "Next intro: Mirage, at pistol round start", or why there is none. */
  private nextLine(cur: IntroTarget | null, next: IntroTarget | null): string {
    const st = this.settings();
    const at = TRIGGER_AT[st.trigger];
    const s = this.e.session.state();
    // The second half's pistol round of this map is still to come.
    if (st.trigger === "pistols" && cur?.played && cur.hasIntro && !this.isPlayed(cur.map, "pistol2") && (s?.roundNumber ?? 0) <= secondHalfStart(this.regulation()) && s?.mapPhase !== "gameover") return `Next intro: ${cur.displayName}${cur.isDefault ? " (the default intro)" : ""}, at the second half's pistol round.`;
    const t = cur && !cur.played ? cur : (next ?? null);
    if (!t) {
      if (cur?.played) return `${cur.displayName}'s intro has played${this.matchKey() === "none" ? "" : " this match"}.`;
      return st.trigger === "manual" ? "Intros play when you press Play map intro." : `Next intro: the next map, ${at}.`;
    }
    if (!t.hasIntro) return `${t.displayName} has no intro, and there is no default intro.`;
    return `Next intro: ${t.displayName}${t.isDefault ? " (the default intro)" : ""}, ${at}.`;
  }

  status(): MapIntroStatus {
    this.observe();
    const cur = this.target(this.currentMap());
    const nm = this.nextMap();
    const nextMap = nm && nm !== cur?.map ? this.target(nm) : null;
    const next = this.nextLine(cur, nextMap);
    const r = this.run;
    if (r) {
      const elapsedMs = r.onAirAt !== null ? Math.round(this.e.now() - r.onAirAt) : null;
      const name = mapDisplayName(r.map) ?? r.map;
      return {
        state: "playing",
        detail: elapsedMs === null ? `${name}'s intro going on air…` : `On air: ${name}'s intro${r.isDefault ? " (the default)" : ""}.`,
        next,
        running: true,
        playing: { map: r.map, displayName: name, slot: r.slot, isDefault: r.isDefault, by: r.by, durationMs: r.intro.durationMs, elapsedMs },
        current: cur,
        nextMap,
        blocked: null,
        blockedNext: null,
        waiting: null,
        last: this.last,
        auto: this.autoNote,
      };
    }
    const blocked = this.blockedFor(cur?.map ?? null);
    const blockedNext = this.blockedFor(nextMap?.map ?? null, "the next map");
    const w = this.waiting;
    const waiting = w ? { map: w.moment.map, kind: w.moment.kind, why: w.why } : null;
    const detail = w ? `${mapDisplayName(w.moment.map) ?? w.moment.map}'s intro waits: ${w.why.replace(/ were /, " are ").replace(/ was /, " is ")}.` : next;
    return { state: w ? "waiting" : blocked && blockedNext ? "blocked" : "ready", detail, next, running: false, playing: null, current: cur, nextMap, blocked, blockedNext, waiting, last: this.last, auto: this.autoNote };
  }

  /** For button lights (the devices' tally). */
  brief(): { running: boolean; onAir: string | null; ready: boolean; readyNext: boolean; next: string } {
    const st = this.status();
    return { running: st.running, onAir: st.playing?.displayName ?? null, ready: !st.running && st.blocked === null, readyNext: !st.running && st.blockedNext === null, next: st.next };
  }

  /** Every slot, with its intro (for the panel). */
  slots(): { slot: MapIntroSlot; label: string; intro: StoredIntro | null }[] {
    const all = this.store.list();
    return MAP_INTRO_SLOTS.map((slot) => ({ slot, label: slotLabel(slot), intro: all[slot] ?? null }));
  }

  /** Whether a slot's intro is on air now (it can't be replaced or removed then). */
  slotOnAir(slot: MapIntroSlot): boolean {
    return this.run?.slot === slot;
  }
}
