import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import type { TransitionPick } from "../live/obs-auto.ts";
import type { ProgramOwner } from "../production/program.ts";
import { replayLabel } from "./link.ts";
import type { RankFacts } from "./rank.ts";
import { clipScore, CUT_MS, fitReplay, planBreak, replayWallMs, SWITCH_MS } from "./rank.ts";
import type { VmixInput, VmixTransition } from "./vmix.ts";
import { VMIX_TRANSITIONS, VmixClient } from "./vmix.ts";
import type { TwinStatus } from "./twin.ts";
import type { DuckStatus } from "./audio.ts";
import { ReplayAudio } from "./audio.ts";
import type { TestReport } from "./test-run.ts";
import { ReplayTest } from "./test-run.ts";
import type { Encoder } from "./ffmpeg.ts";
import type { BreakLayout, BreakRenderer, RenderedBreak } from "./render.ts";
import { renderBreak, TAIL_MS } from "./render.ts";

/**
 * Automatic replays on the main PC. Clips come from the replay PC (every kill it could film, or
 * only the ones the main camera missed) and, optionally, from this computer's own OBS replay buffer
 * (3K+ and won clutches the main camera showed). Each round's clips are ranked (replay/rank.ts):
 * the break after the round chooses the best ones that fit and plays them back to back, in round
 * order (or best first), with one transition to the replays and one back to live, and a fade from
 * one clip to the next; the rest are ignored. A break runs from a few seconds after the round ends
 * until the next round's clock reads 1:50 (a setting; or until just before the next round starts).
 * It never starts once the next round is live, a clip of a round whose break is over never plays,
 * and an operator's own program choice is never undone.
 *
 * The operator's controls (the console, Stream Deck, hotkeys; ADR-062): Skip the clip on air, Stop
 * and go live, Hold (and Resume) the clip on air, and, in the round's list, Exclude a clip or Pin one
 * to play first. The live game audio picked is turned down while the replays play (replay/audio.ts),
 * and Test replays (replay/test-run.ts) plays two sample clips through this same path.
 *
 * Highlights on air (replay/highlights-air.ts, ADR-063) play a map's kept clips through this same
 * path too, on the highlights scene and its twin (a Stage): the same fades, graphic, sound, controls
 * and status, with their own transitions, and back to where the program came from.
 *
 * In OBS a break plays as one file by default (ADR-067): ffmpeg joins its clips with the fade (or a
 * cut), the sound fading in and out (replay/render.ts), and the file plays in the replay scene's one
 * media source. Without it in time, the clips play through the replay scene and its twin, each loaded
 * just in time off air (never held paused there) and checked to move on air.
 */

export const AutoReplaySettings = z.object({
  enabled: z.boolean().default(false),
  /** At most this many clips per break: the best of the round that fit. */
  perBreak: z.number().int().min(1).max(4).default(4),
  /** The order the chosen clips play in: the round's own (its first kill first), or best first. */
  order: z.enum(["round", "best"]).default("round"),
  /** Playback speed of a replay in percent (100 = real time). */
  speedPercent: z.number().int().min(25).max(100).default(100),
  /** Wait this long after the round ends, so the round win stays on air. */
  startDelayMs: z.number().int().min(0).max(8000).default(3500),
  /** Also play the replay PC's angle of a kill the main camera showed from the victim. */
  otherAngles: z.boolean().default(true),
  /** Save this computer's replay buffer when the main camera shows a 3K or more. */
  ownBigPlays: z.boolean().default(true),
  /** Where replays play: OBS (its replay scene) or vMix (a replay input, through its Web Controller API). */
  mixer: z.enum(["obs", "vmix"]).default("obs"),
  vmixUrl: z.string().max(200).default("http://127.0.0.1:8088"),
  /** How vMix goes to the first replay (and back after the last, unless vmixTransitionOut). */
  vmixTransition: z.enum(VMIX_TRANSITIONS).default("CutDirect"),
  /** How vMix goes back to live after the last replay; null = as vmixTransition. */
  vmixTransitionOut: z.enum(VMIX_TRANSITIONS).nullable().default(null),
  /**
   * When the break's replays must be over: by a time on the next round's clock (its first seconds,
   * while the teams move out of spawn), or before the next round starts (until just before freeze
   * time ends).
   */
  cutBack: z.enum(["clock", "before_round"]).default("clock"),
  /** With cutBack "clock": the round clock (time left) the cut back to live starts by. 110 = 1:50; CS2's round time is 1:55. */
  cutBackClockSec: z.number().int().min(60).max(175).default(110),
  /** From one replay of a break to the next: a fade (the end of one into the start of the next) or a cut. */
  between: z.enum(["fade", "cut"]).default("fade"),
  /**
   * How OBS plays a break: as one file rendered by ffmpeg (its clips joined with that fade or cut, the
   * sound faded in and out; in the replay scene alone), or each clip by itself in the replay scene and
   * its twin, faded by OBS. A rendered break that isn't ready in time plays the second way.
   */
  playback: z.enum(["rendered", "scenes"]).default("rendered"),
  /** A rendered break's sound fades in at its start and out at its end (and before an early end) over this long. */
  audioFadeMs: z.number().int().min(0).max(1000).default(400),
  /** How long that fade is. */
  fadeMs: z.number().int().min(100).max(2000).default(500),
  /** The replay media sources' volume in dB (0 = as recorded, above 0 louder); null leaves it as set in OBS. */
  replayVolumeDb: z.number().min(-30).max(12).nullable().default(null),
  /** The live game audio, turned down while a break's replays play: OBS input names. Casters' microphones are never touched unless picked. */
  duckInputs: z.array(z.string().min(1).max(200)).max(16).default([]),
  /** The same with vMix as the replay mixer: vMix input keys. */
  duckVmixInputs: z.array(z.string().min(1).max(200)).max(16).default([]),
  /** How far the live game audio goes down: muted, or this many dB. */
  duckTo: z.union([z.literal("mute"), z.number().int().min(-60).max(-3)]).default(-20),
  /** The ramp down as the replays start, and back up after them. */
  duckRampMs: z.number().int().min(0).max(2000).default(300),
});
export type AutoReplaySettings = z.infer<typeof AutoReplaySettings>;
/** A change to some settings (each key optional, no defaults filled in). */
export const AutoReplayPatch = z.object({
  enabled: z.boolean().optional(),
  perBreak: AutoReplaySettings.shape.perBreak.unwrap().optional(),
  order: AutoReplaySettings.shape.order.unwrap().optional(),
  speedPercent: AutoReplaySettings.shape.speedPercent.unwrap().optional(),
  startDelayMs: AutoReplaySettings.shape.startDelayMs.unwrap().optional(),
  otherAngles: z.boolean().optional(),
  ownBigPlays: z.boolean().optional(),
  mixer: AutoReplaySettings.shape.mixer.unwrap().optional(),
  vmixUrl: z.string().max(200).optional(),
  vmixTransition: AutoReplaySettings.shape.vmixTransition.unwrap().optional(),
  vmixTransitionOut: AutoReplaySettings.shape.vmixTransitionOut.unwrap().optional(),
  cutBack: AutoReplaySettings.shape.cutBack.unwrap().optional(),
  cutBackClockSec: AutoReplaySettings.shape.cutBackClockSec.unwrap().optional(),
  between: AutoReplaySettings.shape.between.unwrap().optional(),
  playback: AutoReplaySettings.shape.playback.unwrap().optional(),
  audioFadeMs: AutoReplaySettings.shape.audioFadeMs.unwrap().optional(),
  fadeMs: AutoReplaySettings.shape.fadeMs.unwrap().optional(),
  replayVolumeDb: AutoReplaySettings.shape.replayVolumeDb.unwrap().optional(),
  duckInputs: AutoReplaySettings.shape.duckInputs.unwrap().optional(),
  duckVmixInputs: AutoReplaySettings.shape.duckVmixInputs.unwrap().optional(),
  duckTo: AutoReplaySettings.shape.duckTo.unwrap().optional(),
  duckRampMs: AutoReplaySettings.shape.duckRampMs.unwrap().optional(),
});

/** A clip of the break's round, as ranked. */
export interface RankedReplay {
  id: string;
  label: string;
  score: number;
  reasons: string[];
  /** played: on air this break; picked: on air now; waiting: may still play (chosen for the break, or not chosen yet); duplicate: the same kills as a better clip; left: not played (no time or slots left, or `note`). */
  state: "played" | "picked" | "waiting" | "duplicate" | "left";
  /** Why a clip that is left never plays automatically, when it isn't only time or slots. */
  note: string | null;
  /** The operator excluded it (it never plays automatically), or pinned it to play first in its break. */
  excluded: boolean;
  pinned: boolean;
}

export interface AutoReplayStatus {
  enabled: boolean;
  state: "off" | "waiting" | "playing" | "blocked";
  detail: string;
  waiting: number;
  playing: { id: string; label: string } | null;
  lastPlayed: { id: string; label: string; at: string } | null;
  /** The round whose clips the current (or last) break plays, and its clips best first. */
  round: number | null;
  ranked: RankedReplay[];
  /** With vMix as the mixer: whether its API answers. */
  vmix: { connected: boolean; version: string | null; error: string | null } | null;
  /** With OBS: the replay scene's twin, for fading from one replay to the next (replay/twin.ts). */
  twin: TwinStatus | null;
  /** The round time (seconds) the break's end is worked out with before the next round is live: 115 until a live round shows this server's. */
  roundSec: number;
  /** A break's replays (or Test replays) are playing now: Skip, Stop and go live, and Hold apply. */
  running: boolean;
  /** The clip on air is held (paused) until Resume. */
  held: boolean;
  /** The clip on air's place in the break, and how many clips the break has now. */
  position: { n: number; of: number } | null;
  /** The live game audio turned down during replays. */
  audio: DuckStatus;
  /** The last Test replays run, step by step. */
  test: TestReport | null;
  /** A break's file (Test replays', highlights') being rendered: how far (0–1), of how many clips. */
  preparing: { kind: SequenceKind; progress: number; clips: number } | null;
  /** The last rendered run: how long the file took, or why its clips played through the scenes instead. */
  render: RenderNote | null;
}

/** How the last run's file went: rendered (in how long, with which encoder), or why not (its clips played through the scenes). */
export interface RenderNote {
  at: string;
  kind: SequenceKind;
  clips: number;
  rendered: boolean;
  ms: number | null;
  encoder: Encoder | null;
  detail: string;
}

/** What the path a break's replays play through did, for the Test replays report (replay/test-run.ts). */
export type TraceEvent =
  | { type: "in"; scene: string | null; confirmed: boolean; transition: string | null }
  | { type: "between"; scene: string | null; confirmed: boolean; transition: string | null }
  | { type: "clip"; id: string; ok: boolean; error: string | null }
  | { type: "one-source"; why: string }
  | { type: "rendered"; ok: boolean; clips: number; ms: number | null; detail: string }
  | { type: "out"; confirmed: boolean; scene: string | null; transition: string | null; error: string | null }
  | { type: "audio-down"; inputs: string[] }
  | { type: "audio-back"; ok: boolean; detail: string };

/** A clip chosen for the break (or highlights), and how much of it to show. */
interface Planned {
  item: QueueItem;
  playMs: number;
  leadMs: number | null;
}

/** What a sequence of clips is: a break's replays, Test replays' sample clips, or highlights on air (ADR-063). */
export type SequenceKind = "break" | "test" | "highlights";

/** One of the two scenes clips alternate between (a scene and its twin), with its media source. */
export interface Slot {
  scene: string;
  input: string;
}

/**
 * Where a sequence plays and who has the program meanwhile: the replay scene (a break's replays, Test
 * replays; REPLAY_PLAYING, automation) or the highlights scene (HIGHLIGHTS, the operator who pressed
 * Play or the automatic start). With vMix, its transitions in and out.
 */
export interface Stage {
  mode: "REPLAY_PLAYING" | "HIGHLIGHTS";
  owner: ProgramOwner;
  holder: string;
  /** OBS: the scene and its media source (null: not set up). */
  main(): Slot | null;
  /** OBS: the scene's twin, built or brought up to date off air (null: none; `twinDetail` says why). */
  twin(): Promise<Slot | null>;
  twinDetail(): string;
  /** OBS: the scenes it plays on as the program knows them (the scene and its twin). */
  scenes(): string[];
  vmixIn: VmixTransition;
  vmixOut: VmixTransition;
}

/** How a sequence went: clips played (of them skipped), failed, the last error, and why it stopped. */
export interface SequenceResult {
  played: number;
  skipped: number;
  failed: number;
  error: string | null;
  stopped: Stop | null;
}

/** A break's replays once chosen (or Test replays, or highlights): the clips in play order, and how it went. */
interface Sequence {
  kind: SequenceKind;
  stage: Stage;
  round: number | null;
  /** Every clip chosen for it (and a pinned one that joined it). */
  ids: string[];
  /** The clips still to play, in order (the operator's Exclude and Pin change it). */
  rest: Planned[];
  /** Clips taken from the list so far (the one on air is the n-th). */
  taken: number;
  /** When they were chosen (wall ms): a clip that came in later isn't among them. */
  chosenAt: number;
  running: boolean;
  played: number;
  failed: number;
  error: string | null;
  /** When the next round went live while they played (monotonic ms): its clock says when they stop. */
  wentLive: number | null;
  /** Why they stopped. */
  stopped: Stop | null;
  /** Program changes made in OBS itself when they started (obsAuto.changesInObs): another one means the operator took the program. */
  obsChanges: number;
  /** Taken in OBS itself (the operator put their own scene on): the rest may play when OBS shows the live scene again during the break. */
  resumable: boolean;
  /** Clips the operator skipped. */
  skipped: number;
  /** The break had none: highlights went on air in it (ADR-063). */
  yielded?: boolean;
  /** For the Test replays report: what the path did. */
  trace: ((ev: TraceEvent) => void) | null;
  /** The live audio going down (once, as the first clip goes on air). */
  ducking: Promise<void> | null;
  /** The transition in's cut point (ms: a Stinger's; 0 for the others), once on air. */
  inCutMs?: number;
}

/** The operator's controls of the replays playing now. */
interface Controls {
  /** Skip: the clip on air (its id) ends now. */
  skip: string | null;
  /** Stop and go live. */
  stop: boolean;
  /** Hold: the clip on air waits paused until Resume. */
  held: boolean;
}

/**
 * Why a clip stopped: it ended (or its fade to the next is due), it ran past its time (still
 * playing), the operator skipped it, the break's time is up (the round clock, or the next round
 * starting), the operator stopped the replays, automatic replays were turned off, or someone else
 * changed the program.
 */
export type Stop = "ended" | "late" | "skipped" | "deadline" | "stopped" | "off" | "taken";
/** A clip that ended one of these ways lets the next one play. */
const goesOn = (s: Stop) => s === "ended" || s === "late" || s === "skipped";
/** A clip that may still play automatically (not played, rejected or failed). */
const playable = (it: QueueItem) => it.state === "prepared" || it.state === "approved";
const refuse = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });

/** The next clip, for a scene off air: chosen, and loaded there just in time (it then plays hidden, toward its part). */
interface Next {
  c: Planned;
  /** Its place in the break's list (1-based). */
  n: number;
  slot: number;
  playMs: number;
  /** Loading (or loaded): where it is once OBS plays it. */
  loaded: Promise<Hidden> | null;
}

/** A clip loaded off air: where OBS has it (null: the source doesn't play hidden; it goes to its part once shown), its length as OBS said, and its part's start. */
interface Hidden {
  cursorMs: number | null;
  durationMs: number | null;
  partMs: number;
}

/** A run's clips rendered into one file (render.ts), and the clips taken from the list for it. */
interface RenderedRun {
  file: string;
  layout: BreakLayout;
  clips: { c: Planned; n: number }[];
  taken: Planned[];
  encoder: Encoder;
  /** The transition back starts this long (wall ms) before the clips' end: its cut point, when it is the one in. */
  outLeadMs: number;
}

const HOLDER = "auto-replay";
const PRIORITY: Record<ReplayPlay["kind"], number> = { big_play: 3, missed: 2, other_angle: 1, shown: 0 };
/** A won clutch (1v2 or more) plays before anything else. */
const CLUTCH_PRIORITY = 4;
/** Before the round starts (cutBack "before_round"): return to live this long before freeze time ends. */
const END_MARGIN_MS = 1500;
/** By the round clock: start the cut back this much before it reads the time (the engine looks every 25–100 ms). */
const CUT_LEAD_MS = 250;
/** Freeze time assumed until the game reports it (CS2's competitive default is 20 s, many servers use 15). */
const ASSUMED_FREEZE_MS = 15000;
/** CS2's round time (mp_roundtime_defuse 1.92 minutes, the clock shows 1:55), until a live round shows this server's. */
const ASSUMED_ROUND_SEC = 115;
/** The bomb is down: the round clock is gone, so the break's replays stop. */
const BOMB_DOWN = new Set(["planted", "defusing", "defused", "exploded"]);
/** A clip made this long before its round went live (by the clocks of two computers) still counts as made in it. */
const LIVE_SLACK_MS = 1000;
/**
 * The break's replays wait up to this long (after startDelayMs) while the replay PC is still
 * filming or sending kills of the round: it plays them some seconds after the main PC (7 s behind,
 * plus 2 s after the kill and the save: its last clip comes about 10 s after the round ends), and
 * the round's last kills are often its best.
 */
const REPLAY_PC_WAIT_MS = 8000;
/**
 * ...but stop waiting while the break still has this much time left for replays. Since replays run
 * to 1:50 on the next round's clock, a break has about 6 s more than before 0.10.5, so with 15 s of
 * freeze time the wait is no longer cut short (before, it ended about 1 s in).
 */
const KEEP_FOR_REPLAYS_MS = 16000;
/** Rounds of kills kept for ranking. */
const KEEP_ROUNDS = 6;
/** OBS starts a clip at the keyframe before its part: it may run this much longer than planned (media time). */
const KEYFRAME_SLACK_MS = 10_000;
/** The replay sources are emptied this long after the replays (the transition back, a Stinger too, is over by then). */
const EMPTY_AFTER_MS = 4000;
/** The next clip is loaded off air this long before its fade (or the cut in), at least and at most: the load measured, and more. */
const LOAD_LEAD_MIN_MS = 500;
const LOAD_LEAD_MAX_MS = 2500;
/** On top of the measured load: time for the skip to its part to land. */
const SEEK_SETTLE_MS = 250;
/** A clip loaded off air a moment before its part as it goes on air is let reach it, up to this long. */
const REACH_PART_MS = 150;
/** A clip waiting off air this far past its part ran on: it is loaded again there. */
const RAN_ON_MS = 400;
/** On air, a clip's cursor must move within this long; else play is sent again, then the file is loaded again. */
const MOVE_CHECK_MS = 300;
/** A clip on air whose cursor stays this long: play sent again, then its file loaded again; given up STALL_MS after that. */
const STALL_RETRY_MS = 700;
const STALL_MS = 1500;
/** A break (and Test replays) wait this long at most for their file, then play through the scenes. */
const RENDER_WAIT_MS = 6000;
/** Highlights aren't in a hurry: they wait this long for theirs. */
const HIGHLIGHTS_RENDER_MAX_MS = 180_000;
/** Rendered files go in this folder of the replay storage, and are removed after their run. */
const RENDER_DIR = "rendered";

export class AutoReplay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  /** OBS runs started (a break's replays, Test replays, highlights): emptying the sources after one never touches the next. */
  private obsRuns = 0;
  private status: Pick<AutoReplayStatus, "state" | "detail" | "playing" | "lastPlayed" | "position"> = { state: "off", detail: "Automatic replays are off.", playing: null, lastPlayed: null, position: null };
  private vmix: { connected: boolean; version: string | null; error: string | null; checkedAt: number } | null = null;
  private phase: string | null = null;
  /** The game's phase last seen (for the round time: the clock when a round goes live). */
  private gamePhase: string | null = null;
  /** The server's round time in seconds, as the clock showed when a round went live. */
  private roundSec = ASSUMED_ROUND_SEC;
  /** The round that was live last, and when the break after it started (monotonic ms). */
  private liveRound: number | null = null;
  private breakRound: number | null = null;
  private breakStartedAt: number | null = null;
  /** When each round last went live (wall ms): a clip made before that is from an earlier try of the round (a restart, a backup). */
  private liveAt = new Map<number, number>();
  /** Every round up to this one has had its break: none of its clips plays automatically any more. */
  private closedThrough: number | null = null;
  /** The break's replays, once chosen: they play once, back to back. */
  private sequence: Sequence | null = null;
  /** The replays playing now (the break's, or Test replays'): the operator's controls act on them. */
  private running: Sequence | null = null;
  /** Until those replays are over. */
  private playing: Promise<void> | null = null;
  private ctl: Controls = { skip: null, stop: false, held: false };
  /** Clips the operator excluded: never played automatically. */
  private excluded = new Set<string>();
  /** The clip the operator pinned to play first in its round's break. */
  private pinned: { round: number; id: string } | null = null;
  /** Clips played (or started) this break. */
  private playedIds = new Set<string>();
  /** Every kill of the last rounds on this computer (for the ranking: opening kill, round winner, multi-kill speed; and for round order). */
  private roundKills = new Map<number, { killer: string; killerSide: string | null; victim: string; victimName: string; at: number }[]>();
  private abort = false;
  private bufferStartTried = false;
  /** The clutch of the live round (the last player alive on a side against 2+), while it lasts. */
  private clutch: { steamId: string; name: string; side: "T" | "CT"; versus: number; startedAt: number; round: number | null; shown: boolean } | null = null;
  /** A clutch that was still on when the round ended, waiting for the round result. */
  private endedClutch: (NonNullable<AutoReplay["clutch"]> & { endedAt: number }) | null = null;
  private ownKills = new Map<string, { round: number | null; kills: number; firstAt: number; lastAt: number; victims: string[]; weapon: string | null; headshot: boolean; name: string; timer: ReturnType<typeof setTimeout> | null }>();
  private readonly cleanup: (() => void)[] = [];
  /** Renders a run's clips into one file (render.ts; tests put a stand-in here). */
  renderer: BreakRenderer = renderBreak;
  /** A break (and Test replays) wait this long at most for their file (tests shorten it). */
  renderWaitMs = RENDER_WAIT_MS;
  /** What a render is expected to take (ms; learned from the last ones): a break plans its clips with it. */
  private renderGuessMs = 3000;
  private lastRender: RenderNote | null = null;
  private preparing: AutoReplayStatus["preparing"] = null;
  /** How long OBS took to play a clip just loaded (ms, smoothed): the next one off air is loaded that much (and more) ahead. */
  private loadMs = 300;
  /** A replay source whose sound was faded out at an early end, put back once it is off air. */
  private turnedDown: { input: string; mul: number; fading: Promise<void> } | null = null;
  /** The live game audio turned down during replays, and the replay sources' volume. */
  readonly audio: ReplayAudio;
  /** The Test replays button. */
  readonly test: ReplayTest;

  constructor(private readonly e: Engine) {
    this.audio = new ReplayAudio(e, () => this.settings());
    this.test = new ReplayTest(e, this);
  }

  settings(): AutoReplaySettings {
    const r = AutoReplaySettings.safeParse(this.e.settings.get("replay.auto", {}));
    return r.success ? r.data : AutoReplaySettings.parse({});
  }

  setSettings(patch: Partial<AutoReplaySettings>): AutoReplaySettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = AutoReplaySettings.parse({ ...this.settings(), ...given });
    this.e.settings.set("replay.auto", next);
    if (!next.enabled) this.abort = true;
    if (patch.replayVolumeDb !== undefined && next.mixer === "obs") void this.audio.applyReplayVolume();
    return next;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch((err) => this.e.logger.warn("automatic replays: tick failed", { error: String(err) })), 200);
    this.timer.unref?.();
    this.cleanup.push(this.e.onKill((k) => this.onKill(k)));
    this.audio.start();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const fn of this.cleanup.splice(0)) fn();
    for (const k of this.ownKills.values()) if (k.timer) clearTimeout(k.timer);
    this.audio.dispose();
  }

  /** The engine is stopping: no more replays (those playing stop), and the live audio back now if it can be (else at the next start). */
  async beforeShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctl.stop = true;
    if (this.playing) await Promise.race([this.playing, sleep(3000)]);
    if (!this.audio.lowered) return;
    await Promise.race([this.audio.restore("the engine is stopping"), sleep(2000)]);
  }

  // ------------------------------------------------------------------ the operator's controls

  /** Skip: the clip on air ends now; the next one comes in as usual (a fade), or back to live after the last. */
  skip(): AutoReplayStatus {
    const id = this.status.playing?.id;
    if (!this.running || !id) throw refuse(409, "no_replay", "No replay is on air.");
    this.ctl.skip = id;
    this.ctl.held = false;
    this.e.audit.record(HOLDER, "replay.auto_skip", id, {});
    return this.getStatus();
  }

  /**
   * Stop and go live: the break's replays end now, back to the live scene with Replay out. Before
   * they have started (the round just ended), the break has none.
   */
  stop(): AutoReplayStatus {
    if (this.running) this.ctl.stop = true;
    else if (this.sequence?.resumable) {
      // Taken by the operator's own scene: the rest won't play when OBS is back on the live scene.
      this.sequence.resumable = false;
      this.sequence.stopped = "stopped";
      if (this.sequence.round !== null) this.closedThrough = Math.max(this.closedThrough ?? this.sequence.round, this.sequence.round);
    } else if (this.breakStartedAt !== null && !this.sequence && this.e.session.state()?.roundPhase !== "live") {
      this.sequence = this.noReplays("stopped");
    } else throw refuse(409, "no_replays", "No replays are playing or about to play.");
    this.e.audit.record(HOLDER, "replay.auto_stop", this.status.playing?.id ?? null, {});
    return this.getStatus();
  }

  /** Hold (true) the clip on air paused, without going on to the next, or Resume (false); toggles when not given. The break's end still cuts back to live. */
  hold(held?: boolean): AutoReplayStatus {
    if (!this.running) throw refuse(409, "no_replay", "No replay is on air.");
    this.ctl.held = held ?? !this.ctl.held;
    this.e.audit.record(HOLDER, this.ctl.held ? "replay.auto_hold" : "replay.auto_resume", this.status.playing?.id ?? null, {});
    return this.getStatus();
  }

  /** A clip of the current (or next) break's round, as the operator's Exclude and Pin take it. */
  private roundClip(id: string): QueueItem & { roundNumber: number } {
    const it = this.e.replays.list().find((i) => i.id === id);
    if (!it) throw refuse(404, "not_found", `replay ${id} not found`);
    if (it.roundNumber === null) throw refuse(409, "no_round", "That clip has no round: it never plays automatically.");
    return it as QueueItem & { roundNumber: number };
  }

  /** Exclude (true) a clip of the round from its break, or let it play again (false); toggles when not given. */
  exclude(id: string, on?: boolean): AutoReplayStatus {
    const it = this.roundClip(id);
    const excluded = on ?? !this.excluded.has(id);
    if (excluded && this.running && this.status.playing?.id === id) throw refuse(409, "on_air", "That clip is on air: press Skip to end it.");
    if (excluded) {
      this.excluded.add(id);
      if (this.pinned?.id === id) this.pinned = null;
      if (this.excluded.size > 500) this.excluded.delete(this.excluded.values().next().value!);
    } else this.excluded.delete(id);
    this.e.audit.record(HOLDER, excluded ? "replay.auto_exclude" : "replay.auto_include", id, { round: it.roundNumber });
    return this.getStatus();
  }

  /** Pin (true) a clip to play first in its round's break, if it fits (next, when the break's replays are playing), or unpin it (false); toggles when not given. */
  pin(id: string, on?: boolean): AutoReplayStatus {
    const it = this.roundClip(id);
    const pinned = on ?? this.pinned?.id !== id;
    if (pinned) {
      if (it.state === "played" || it.state === "playing" || this.playedIds.has(id)) throw refuse(409, "played", "That clip has played already.");
      if (!playable(it)) throw refuse(409, "not_playable", `That clip can't play (${it.state}).`);
      const never = this.never(it);
      if (never) throw refuse(409, "never", `That clip never plays automatically: ${never}. Play it by hand from the replay list.`);
      this.pinned = { round: it.roundNumber, id };
      this.excluded.delete(id);
    } else if (this.pinned?.id === id) this.pinned = null;
    this.e.audit.record(HOLDER, pinned ? "replay.auto_pin" : "replay.auto_unpin", id, { round: it.roundNumber });
    return this.getStatus();
  }

  getStatus(): AutoReplayStatus {
    const round = this.breakRound ?? this.liveRound;
    const st = this.settings();
    const v = st.mixer === "vmix" ? this.vmix : null;
    return {
      ...this.status,
      enabled: st.enabled,
      waiting: this.candidates(round).length,
      round,
      ranked: this.rankedList(round),
      vmix: v ? { connected: v.connected, version: v.version, error: v.error } : null,
      twin: st.mixer === "obs" ? this.e.replayTwin.getStatus() : null,
      roundSec: this.roundSec,
      running: this.running !== null,
      held: this.running !== null && this.ctl.held,
      audio: this.audio.status(),
      test: this.test.report(),
      preparing: this.preparing ? { ...this.preparing } : null,
      render: this.lastRender,
    };
  }

  /** For button lights (the devices' tally): playing (which clip, of how many), held, the round's clips that may still play, the one pinned. */
  brief(): { state: AutoReplayStatus["state"]; running: boolean; held: boolean; onAir: string | null; position: AutoReplayStatus["position"]; waiting: number; pinned: string | null } {
    const round = this.breakRound ?? this.liveRound;
    const pinned = this.pinned && this.pinned.round === round ? (this.e.replays.get(this.pinned.id)?.label ?? null) : null;
    return { state: this.status.state, running: this.running !== null, held: this.running !== null && this.ctl.held, onAir: this.status.playing?.label ?? null, position: this.status.position, waiting: this.candidates(round).length, pinned };
  }

  /**
   * Why a clip never plays automatically, or null. A clip with no round, or of a round whose break
   * is over (or an earlier one), or made before its round went live (a round played again after a
   * restart or a backup has the same number).
   */
  private never(i: QueueItem): string | null {
    const round = i.roundNumber;
    if (round === null) return "no round";
    const live = this.liveAt.get(round);
    if (live === undefined || Date.parse(i.createdAt) < live - LIVE_SLACK_MS) return "from before the round started (a restart or a backup)";
    if (this.closedThrough !== null && round <= this.closedThrough) return "its round's break is over";
    return null;
  }

  /** Clips for a round that can play automatically (not played yet). */
  private candidates(round: number | null): QueueItem[] {
    const st = this.settings();
    return this.e.replays
      .list()
      .filter((i) => playable(i) && i.clip?.media.path && i.play && (i.play.kind !== "other_angle" || st.otherAngles) && round !== null && i.roundNumber === round && this.never(i) === null && !this.excluded.has(i.id));
  }

  /** What the round as a whole says about a clip's kills (for its score). */
  private facts(it: QueueItem): RankFacts {
    const play = it.play!;
    const kills = it.roundNumber !== null ? (this.roundKills.get(it.roundNumber) ?? []) : [];
    const mine = kills.filter((k) => k.killer === play.killer?.steamId && play.victims.includes(k.victimName));
    const first = kills[0];
    const last = kills[kills.length - 1];
    const s = this.e.session.state();
    const winner = s?.roundHistory[s.roundHistory.length - 1]?.winnerSide ?? null;
    return {
      opening: !!first && mine.includes(first),
      closing: !!last && mine.includes(last) && winner !== null && last.killerSide === winner,
      clutchVersus: it.reason === "clutch" ? play.kills : null,
      spanMs: mine.length >= 2 ? mine[mine.length - 1]!.at - mine[0]!.at : null,
    };
  }

  /**
   * When a clip's play happened in the round (this computer's monotonic ms), for round order: its
   * first kill as this computer saw it, one clock for every clip wherever it was filmed (clips from
   * the replay PC carry no match time). A clip whose kills weren't seen here (a clutch, a kill with
   * no killer): when it came in, less its part after the lead-up.
   */
  private roundTimeOf(it: QueueItem): number {
    const killer = it.play?.killer?.steamId ?? null;
    const victims = it.play?.victims ?? [];
    const kills = it.roundNumber !== null ? (this.roundKills.get(it.roundNumber) ?? []) : [];
    const first = killer ? kills.find((k) => k.killer === killer && victims.includes(k.victimName)) : undefined;
    if (first) return first.at;
    const cameIn = this.e.now() - (Date.now() - Date.parse(it.createdAt));
    return cameIn - Math.max(0, this.playMsOf(it) - (it.leadMs ?? 0));
  }

  /**
   * A round's clips with their scores, best first, each clip once: of two clips with the same kills
   * (the same killer, a victim in common), the better one stays (the replay PC's on a tie).
   */
  private ranked(round: number | null): { item: QueueItem; score: number; reasons: string[]; duplicate: boolean }[] {
    const st = this.settings();
    const items = this.e.replays
      .list()
      .filter((i) => i.clip?.media.path && i.play && (i.play.kind !== "other_angle" || st.otherAngles) && round !== null && i.roundNumber === round && i.state !== "rejected" && i.state !== "failed");
    const scored = items.map((item) => ({ item, ...clipScore(item.play!, this.facts(item)), duplicate: false })).sort((a, b) => b.score - a.score || (a.item.origin === "replay_pc" ? -1 : 0) - (b.item.origin === "replay_pc" ? -1 : 0) || a.item.order - b.item.order);
    const kept: typeof scored = [];
    for (const c of scored) {
      const same = kept.find((k) => k.item.play!.killer?.steamId === c.item.play!.killer?.steamId && k.item.play!.victims.some((v) => c.item.play!.victims.includes(v)));
      if (same) c.duplicate = true;
      else kept.push(c);
    }
    return scored;
  }

  private rankedList(round: number | null): RankedReplay[] {
    // Left: once the break's replays are chosen, a clip not among them (during the round, its clips still wait).
    const seq = round !== null && this.sequence?.round === round ? this.sequence : null;
    return this.ranked(round).map(({ item, score, reasons, duplicate }) => {
      const played = this.playedIds.has(item.id) || item.state === "played";
      const picked = !played && (item.state === "playing" || this.status.playing?.id === item.id);
      const never = played || picked ? null : this.never(item);
      const stale = never === "from before the round started (a restart or a backup)" ? never : null;
      // A clip that came in after the break's replays were chosen.
      const late = !played && !picked && !duplicate && seq && !seq.ids.includes(item.id) && Date.parse(item.createdAt) > seq.chosenAt ? "came in after the break's replays were chosen" : null;
      const excluded = !played && !picked && this.excluded.has(item.id);
      const pinned = !played && !picked && this.pinned?.id === item.id;
      const note = excluded ? "excluded by the operator" : (stale ?? late);
      // A clip pinned while the break's replays play joins them (if it fits).
      const joins = pinned && seq?.running === true;
      const state = played ? "played" : picked ? "picked" : duplicate && !pinned ? "duplicate" : note || (seq && !joins && (!seq.running || !seq.ids.includes(item.id))) ? "left" : "waiting";
      return { id: item.id, label: item.label, score, reasons, state, note: state === "left" ? note : null, excluded, pinned };
    });
  }

  /** When freeze time ends (monotonic ms): as the game says, or after the round's end and the assumed freeze time. */
  private freezeEnd(s: MatchState, reported: number | null): number {
    if (s.gamePhase === "freezetime" || s.gamePhase === "timeout_t" || s.gamePhase === "timeout_ct") return reported ?? this.e.now();
    // Round over (or paused): its own countdown, then at least the assumed freeze time.
    return (reported ?? this.e.now() + 5000) + ASSUMED_FREEZE_MS;
  }

  /**
   * When the cut back to live must start at the latest (monotonic ms). By the round clock (the
   * default): in the next round, when its clock reads cutBackClockSec (the game's phase countdown is
   * the time left); before that, freeze time's end plus the round time less that. The bomb down or
   * the round already over: now. Before the round starts: shortly before freeze time ends, and now
   * once it is live. `wentLive`: when the next round went live during the break's replays.
   */
  private cutBackAt(s: MatchState, wentLive: number | null): number {
    const st = this.settings();
    const now = this.e.now();
    const reported = s.phaseEndsInSec !== null && s.phaseObservedAtMonotonicMs !== null ? s.phaseObservedAtMonotonicMs + s.phaseEndsInSec * 1000 : null;
    const live = s.roundPhase === "live" || wentLive !== null;
    if (st.cutBack === "before_round") return live ? now : this.freezeEnd(s, reported) - END_MARGIN_MS;
    const clockMs = st.cutBackClockSec * 1000;
    if (!live) return this.freezeEnd(s, reported) + this.roundSec * 1000 - clockMs - CUT_LEAD_MS;
    // (The bomb's own state only without the game's phase countdown, which says "bomb" from the plant.)
    if (s.roundPhase !== "live" || s.gamePhase === "bomb" || s.gamePhase === "defuse" || (s.phaseEndsInSec === null && s.bomb !== null && BOMB_DOWN.has(s.bomb.state))) return now;
    if (s.gamePhase === "live" && reported !== null) return reported - clockMs - CUT_LEAD_MS;
    // No round clock in the game data: from when the round went live.
    return (wentLive ?? now) + this.roundSec * 1000 - clockMs - CUT_LEAD_MS;
  }

  /** The round clock when a round goes live is the server's round time (1:55 by default). */
  private learnRoundTime(s: MatchState): void {
    const was = this.gamePhase;
    this.gamePhase = s.gamePhase;
    if (s.gamePhase !== "live" || was !== "freezetime" || s.phaseEndsInSec === null || s.phaseObservedAtMonotonicMs === null) return;
    if (this.e.now() - s.phaseObservedAtMonotonicMs > 1000) return;
    const sec = Math.round(s.phaseEndsInSec);
    if (sec >= 30 && sec <= 600) this.roundSec = sec;
  }

  private setStatus(state: AutoReplayStatus["state"], detail: string, playing: AutoReplayStatus["playing"] = null, position: AutoReplayStatus["position"] = null): void {
    this.status = { ...this.status, state, detail, playing, position };
  }

  /** The status while a clip is on air: "Replay 2 of 3: <label>" (or "Test replay …", "Highlight 3 of 8: …"). */
  private onAirStatus(seq: Sequence, n: number, it: QueueItem): void {
    const of = n + seq.rest.length;
    this.setStatus("playing", `${seq.kind === "test" ? "Test replay" : seq.kind === "highlights" ? "Highlight" : "Replay"} ${n} of ${of}: ${it.label}`, { id: it.id, label: it.label }, { n, of });
  }

  /** The break of the round that just ended, with no replays: stopped by the operator, or highlights went on air in it. */
  private noReplays(why: "stopped" | "highlights"): Sequence {
    if (this.breakRound !== null) this.closedThrough = Math.max(this.closedThrough ?? this.breakRound, this.breakRound);
    return { kind: "break", stage: this.replayStage(), round: this.breakRound, ids: [], rest: [], taken: 0, chosenAt: Date.now(), running: false, played: 0, failed: 0, error: null, wentLive: null, stopped: why === "stopped" ? "stopped" : null, obsChanges: 0, resumable: false, skipped: 0, yielded: why === "highlights", trace: null, ducking: null };
  }

  /** Where a break's replays and Test replays play: the replay scene and its twin, automation's, Replay in and out in vMix. */
  private replayStage(): Stage {
    const st = this.settings();
    return {
      mode: "REPLAY_PLAYING",
      owner: "automation",
      holder: HOLDER,
      main: () => {
        const scene = this.e.program.sceneMap.REPLAY;
        return scene ? { scene, input: this.e.settings.get<string>("replay.mediaInput", "") } : null;
      },
      twin: () => this.e.replayTwin.sync(),
      twinDetail: () => this.e.replayTwin.getStatus().detail,
      scenes: () => this.e.program.replayScenes,
      vmixIn: st.vmixTransition,
      vmixOut: st.vmixTransitionOut ?? st.vmixTransition,
    };
  }

  /**
   * The operator's Exclude and Pin on the clips still to play: an excluded one is gone; the pinned
   * one goes first (joining the break if it wasn't chosen, when it may play automatically).
   */
  private applyOperator(seq: Sequence): void {
    if (seq.kind !== "break") return;
    seq.rest = seq.rest.filter((c) => !this.excluded.has(c.item.id));
    const pin = this.waitingPin(seq);
    if (!pin) return;
    const at = seq.rest.findIndex((c) => c.item.id === pin);
    if (at === 0) return;
    let c = at > 0 ? seq.rest.splice(at, 1)[0] : undefined;
    if (!c) {
      const it = this.e.replays.get(pin)!;
      c = { item: it, playMs: this.playMsOf(it), leadMs: it.leadMs ?? null };
      seq.ids.push(pin);
    }
    seq.rest.unshift(c);
  }

  /** The clip pinned for this break that hasn't been taken from its list yet and may still play, or null. */
  private waitingPin(seq: Sequence): string | null {
    const pin = this.pinned;
    if (seq.kind !== "break" || !pin || pin.round !== seq.round || this.playedIds.has(pin.id) || this.status.playing?.id === pin.id) return null;
    // Taken already (waiting off air, on air, or dropped as it didn't fit).
    if (seq.ids.includes(pin.id) && !seq.rest.some((c) => c.item.id === pin.id)) return null;
    const it = this.e.replays.get(pin.id);
    return it && playable(it) && it.clip?.media.path && !this.excluded.has(pin.id) && this.never(it) === null ? pin.id : null;
  }

  /** The next clip of the list (the operator's changes applied), counted. */
  private take(seq: Sequence): Planned | null {
    this.applyOperator(seq);
    const c = seq.rest.shift() ?? null;
    if (c) seq.taken++;
    return c;
  }

  /** A clip taken but not played (it waited off air and the operator changed the list): back at the front. */
  private putBack(seq: Sequence, c: Planned): void {
    seq.taken--;
    if (!this.excluded.has(c.item.id)) seq.rest.unshift(c);
  }

  /** The clip waiting off air is no longer the next: the operator excluded it, or pinned another. */
  private stale(seq: Sequence, c: Planned): boolean {
    if (seq.kind !== "break") return false;
    const pin = this.waitingPin(seq);
    return this.excluded.has(c.item.id) || (pin !== null && pin !== c.item.id);
  }

  private async tick(): Promise<void> {
    const s = this.e.session.state();
    const st = this.settings();
    if (s) {
      this.learnRoundTime(s);
      const running = this.sequence?.running === true;
      if (s.roundPhase === "live") {
        // The round went live (again, after a restart or a backup: the same number, a new try).
        if (s.roundNumber !== null && (this.phase !== "live" || this.liveRound !== s.roundNumber)) this.liveAt.set(s.roundNumber, Date.now());
        this.liveRound = s.roundNumber;
        if (running) this.sequence!.wentLive ??= this.e.now();
        else {
          // The break's replays (if any) are over: no clip of an earlier round plays any more (nor the rest of a break taken in OBS).
          if (this.sequence?.resumable) this.sequence.resumable = false;
          if (s.roundNumber !== null) this.closedThrough = s.roundNumber - 1;
          this.breakRound = null;
          this.breakStartedAt = null;
        }
        this.trackClutch(s);
      } else if (this.phase === "live" || (this.breakStartedAt === null && s.roundPhase === "over")) {
        this.breakRound = this.liveRound;
        this.breakStartedAt = this.e.now();
        this.sequence = null;
        this.playedIds.clear();
        if (this.clutch) this.endedClutch = { ...this.clutch, endedAt: this.e.now() };
        this.clutch = null;
      }
      this.phase = s.roundPhase;
      if (this.endedClutch && s.roundPhase !== "live") this.settleClutch(s);
      for (const r of this.liveAt.keys()) if (s.roundNumber !== null && Math.abs(r - s.roundNumber) > 40) this.liveAt.delete(r);
    }
    if (this.busy) return;
    if (st.mixer === "vmix" && (!this.vmix || this.e.now() - this.vmix.checkedAt > 2000)) await this.checkVmix();
    // Live audio still turned down (the mixer didn't answer after a break, or a restart): back as soon as it can be.
    if (this.audio.lowered) this.audio.retry();
    if (!st.enabled) return this.setStatus("off", "Automatic replays are off.");
    // The operator's own scene in OBS (a multiview, by hand): nothing changes it; replays wait.
    const theirs = this.theirScene();
    if (theirs) return this.setStatus("waiting", theirs);
    // Big plays and clutches come from this computer's replay buffer: start it once if it isn't running.
    if (st.ownBigPlays && !this.bufferStartTried && this.e.obs.state.connected && this.e.obs.state.replayBuffer === false) {
      this.bufferStartTried = true;
      void this.e.obs.setOutput("replay", true).catch((err) => this.e.logger.warn("automatic replays: could not start the OBS replay buffer", { error: String(err) }));
    }
    const why = this.blocked();
    if (why) return this.setStatus("blocked", why);
    // Never a cut to the replays once the next round is live (the break's replays may run on into it).
    if (!s || s.roundPhase === "live" || this.breakStartedAt === null) return this.setStatus("waiting", "Waiting for the round to end.");
    const sinceBreak = this.e.now() - this.breakStartedAt;
    // Taken by the operator's own scene in OBS, and OBS is back on the live scene: what is left (and still fits) plays.
    if (this.sequence?.resumable && !this.sequence.running && this.e.program.mode === "LIVE") this.sequence = null;
    if (this.sequence) {
      const q = this.sequence;
      const how = [q.played ? `${q.played} played` : "", q.skipped ? `${q.skipped} skipped` : "", q.failed ? `${q.failed} didn't play` : "", q.stopped === "stopped" ? "stopped by the operator" : "", q.yielded ? "highlights went on air instead" : "", q.stopped === "deadline" ? (st.cutBack === "clock" ? `back to live by ${clock(st.cutBackClockSec)} on the round clock` : "back to live before the round started") : ""].filter(Boolean).join(", ");
      const summary = [how, q.error].filter(Boolean).join(": ");
      return this.setStatus(q.error && !q.played ? "blocked" : "waiting", `Replays for this break are done${summary ? ` (${summary})` : ""}.`);
    }
    if (sinceBreak < st.startDelayMs) return this.setStatus("waiting", "The round just ended: replays start in a moment.");
    const left = this.cutBackAt(s, null) - this.e.now();
    // The replay PC plays the round some seconds later: wait a little for its last kills before the break's replays.
    if (this.e.onAir.peerPending(this.breakRound) && sinceBreak < st.startDelayMs + REPLAY_PC_WAIT_MS && left > KEEP_FOR_REPLAYS_MS) {
      return this.setStatus("waiting", "Waiting for the replay PC's last kills of the round…");
    }
    // Excluded by the operator: out. Pinned: first, if it fits (even with the same kills as a better clip).
    const pin = this.pinned && this.pinned.round === this.breakRound ? this.pinned.id : null;
    const open = new Set(this.candidates(this.breakRound).map((c) => c.id));
    const pool = this.ranked(this.breakRound).filter((r) => (!r.duplicate || r.item.id === pin) && open.has(r.item.id) && !this.playedIds.has(r.item.id));
    // A rendered break starts once its file is made: its clips have that much less time.
    const renderAhead = st.mixer === "obs" && st.playback === "rendered" ? this.renderGuessMs : 0;
    const plan = planBreak(
      pool.map((r) => ({ id: r.item.id, score: r.score, playMs: this.playMsOf(r.item), leadMs: r.item.leadMs ?? null, at: this.roundTimeOf(r.item) })),
      left - renderAhead,
      st.speedPercent,
      st.perBreak,
      st.order,
      pin,
    );
    if (!plan.length) return this.setStatus("waiting", pool.length ? "The round's replays don't fit in the time left." : "No replays for this round.");
    // (Highlights went on air while this tick waited for vMix: they have the program.)
    if (this.running) return;
    const list: Planned[] = plan.map((p) => ({ item: pool.find((r) => r.item.id === p.id)!.item, playMs: p.playMs, leadMs: p.leadMs }));
    const seq: Sequence = { kind: "break", stage: this.replayStage(), round: this.breakRound, ids: list.map((c) => c.item.id), rest: list, taken: 0, chosenAt: Date.now(), running: true, played: 0, failed: 0, error: null, wentLive: null, stopped: null, obsChanges: this.e.obsAuto.changesInObs, resumable: false, skipped: 0, trace: null, ducking: null };
    this.sequence = seq;
    this.abort = false;
    await this.play(seq);
    // Taken in OBS itself (the operator's own scene): the rest may still play when OBS is back on the live scene during the break.
    seq.resumable = seq.stopped === "taken" && this.e.obsAuto.changesInObs !== seq.obsChanges && st.mixer === "obs";
    if (seq.resumable) return;
    // Its break is over: no clip of this round (or an earlier one) plays automatically any more.
    if (seq.round !== null) this.closedThrough = Math.max(this.closedThrough ?? seq.round, seq.round);
    if (this.pinned && seq.round !== null && this.pinned.round <= seq.round) this.pinned = null;
  }

  /** While OBS shows the operator's own scene (put on in OBS itself): why replays wait, or null. */
  private theirScene(what = "replays wait"): string | null {
    const scene = this.settings().mixer === "obs" && !this.running ? this.e.program.operatorScene : null;
    return scene ? `OBS shows “${scene}” (your scene): ${what} until you're back on the live scene.` : null;
  }

  /** Plays a break's replays (or Test replays) in the mixer; the operator's controls apply meanwhile. */
  private async play(seq: Sequence): Promise<void> {
    this.busy = true;
    this.running = seq;
    this.ctl = { skip: null, stop: false, held: false };
    const run = this.settings().mixer === "vmix" ? this.playVmix(seq) : this.playObs(seq);
    this.playing = run.catch(() => undefined);
    try {
      await run;
    } finally {
      seq.running = false;
      this.running = null;
      this.playing = null;
      this.ctl = { skip: null, stop: false, held: false };
      this.busy = false;
    }
  }

  /**
   * Test replays (replay/test-run.ts): sample clips played as a break's are, through the same path
   * (the twin and its fade, the transitions, the live audio turned down), traced for the report.
   * Nothing is ranked, marked or recorded as played. Returns how it went.
   */
  async playTest(items: QueueItem[], trace: (ev: TraceEvent) => void): Promise<{ played: number; failed: number; error: string | null; stopped: Stop | null }> {
    const list: Planned[] = items.map((item) => ({ item, playMs: this.playMsOf(item), leadMs: null }));
    const seq: Sequence = { kind: "test", stage: this.replayStage(), round: null, ids: list.map((c) => c.item.id), rest: list, taken: 0, chosenAt: Date.now(), running: true, played: 0, failed: 0, error: null, wentLive: null, stopped: null, obsChanges: this.e.obsAuto.changesInObs, resumable: false, skipped: 0, trace, ducking: null };
    if (this.settings().mixer === "vmix") await this.checkVmix();
    await this.play(seq);
    this.setStatus("waiting", seq.played ? `Test replays done (${seq.played} played).` : "Test replays done.");
    return { played: seq.played, failed: seq.failed, error: seq.error, stopped: seq.stopped };
  }

  /**
   * Highlights on air (replay/highlights-air.ts, ADR-063): a map's kept clips, in order, played as a
   * break's are on `stage` (the highlights scene and its twin, or vMix), with the operator's Skip,
   * Hold and Stop. Before a round is live they play on; once one is (half time over), until the cut
   * back on its clock (the replays' setting). Nothing is marked in the replay list. A break whose
   * replays haven't started has none. Returns how it went once they are over.
   */
  async playHighlights(items: QueueItem[], stage: Stage): Promise<SequenceResult> {
    if (this.running || this.busy) throw refuse(409, "busy", this.running?.kind === "highlights" ? "Highlights are on air already." : "The break's replays are playing: try again after them.");
    // A break whose replays are about to play: highlights instead (they would come straight after).
    if (this.breakStartedAt !== null && !this.sequence && this.e.session.state()?.roundPhase !== "live") this.sequence = this.noReplays("highlights");
    const list: Planned[] = items.map((item) => ({ item, playMs: this.playMsOf(item), leadMs: item.leadMs ?? null }));
    const seq: Sequence = { kind: "highlights", stage, round: null, ids: list.map((c) => c.item.id), rest: list, taken: 0, chosenAt: Date.now(), running: true, played: 0, failed: 0, error: null, wentLive: null, stopped: null, obsChanges: this.e.obsAuto.changesInObs, resumable: false, skipped: 0, trace: null, ducking: null };
    await this.play(seq);
    return { played: seq.played, skipped: seq.skipped, failed: seq.failed, error: seq.error, stopped: seq.stopped };
  }

  /** What plays now: a break's replays, Test replays or highlights; null when nothing does. */
  runningKind(): SequenceKind | null {
    return this.running?.kind ?? null;
  }

  /**
   * The round's replays are playing, or about to (the round just ended and its break's replays haven't
   * been chosen yet, while they still may be): automatic highlights wait for them (ADR-063).
   */
  replaysDue(): boolean {
    if (this.running && this.running.kind !== "highlights") return true;
    const st = this.settings();
    if (!st.enabled || this.breakStartedAt === null || this.sequence) return false;
    if (this.e.now() - this.breakStartedAt > st.startDelayMs + REPLAY_PC_WAIT_MS + 2000) return false;
    return this.candidates(this.breakRound).length > 0;
  }

  /** Why Test replays can't play now, or null. They play on program, so never over a live round or anything but the live program. */
  testBlocked(): string | null {
    const s = this.e.session.state();
    if (this.running?.kind === "test") return "Test replays are playing already.";
    if (this.running?.kind === "highlights") return "Highlights are on air: try again after them.";
    if (this.busy) return "The break's replays are playing: try again after them.";
    if (s?.roundPhase === "live") return "A round is live: Test replays play on your program output, so they only run between rounds (or without a match).";
    const theirs = this.theirScene("Test replays wait");
    if (theirs) return theirs;
    if (this.settings().enabled && this.breakStartedAt !== null && !this.sequence && s && this.candidates(this.breakRound).length) return "The break's replays are about to play: try again after them.";
    return this.blocked();
  }

  /** How much of a clip to show (the whole clip when it says nothing). */
  private playMsOf(it: QueueItem): number {
    return it.playMs ?? it.clip?.media.durationMs ?? 8000;
  }

  /** vMix answered the last check. */
  vmixConnected(): boolean {
    return this.vmix?.connected === true;
  }

  /** Whether vMix's API answers (checked every 2 s while it is the mixer). */
  async checkVmix(): Promise<void> {
    const at = this.e.now();
    try {
      const st = await new VmixClient(this.settings().vmixUrl).state();
      this.vmix = { connected: true, version: st.version, error: null, checkedAt: at };
    } catch (err) {
      this.vmix = { connected: false, version: null, error: err instanceof Error ? err.message : String(err), checkedAt: at };
    }
  }

  /** Why replays can't play at all right now, or null. */
  private blocked(): string | null {
    if (this.settings().mixer === "vmix") return this.vmix?.connected ? null : `vMix doesn't answer at ${this.settings().vmixUrl}: turn on its Web Controller (vMix → Settings → Web Controller).`;
    if (!this.e.obs.state.connected) return "Connect OBS on this computer (Settings → Devices).";
    if (!this.e.settings.get<string | null>("replay.mediaInput", null)) return "Set up the replay scene: Replays → Set up OBS replay scene.";
    if (!this.e.program.sceneMap.REPLAY) return "Map the replay scene: Replays → Set up OBS replay scene.";
    // The break's own replays on program aren't a reason to stop them.
    if (this.e.program.mode !== "LIVE" && !(this.running && this.onAirOurs(this.running))) return `The program isn't live (${this.e.program.mode.replace(/_/g, " ").toLowerCase()}): press Return live at the top of Replays & Production, or put OBS on your live scene.`;
    return null;
  }

  /**
   * The program shows this automation's replay (that clip's, when given): no one else changed it,
   * in the program's state or in OBS (OBS on one of the two replay scenes, and no program change
   * made in OBS itself, such as the Transition button in Studio Mode, even to a replay scene).
   */
  private onAirOurs(seq: Sequence, id?: string): boolean {
    const p = this.e.program;
    const stage = seq.stage;
    if (!(p.mode === stage.mode && p.owner.holder === stage.holder && (id === undefined || p.activeReplay === id))) return false;
    if (this.settings().mixer !== "obs" || !this.e.obs.state.connected) return true;
    if (seq.running && this.e.obsAuto.changesInObs !== seq.obsChanges) return false;
    const shown = this.e.obs.state.programScene;
    return shown === null || stage.scenes().includes(shown);
  }

  /**
   * Why the break's replays must stop now, or null: the operator's Stop, automatic replays off, the
   * break's end (Test replays: a round going live).
   */
  private interrupted(seq: Sequence): Stop | null {
    if (this.ctl.stop) return "stopped";
    const s = this.e.session.state();
    if (seq.kind === "test") return s?.roundPhase === "live" ? "deadline" : null;
    if (seq.kind === "highlights") {
      // Highlights run on until a round is live (half time over), then until the cut back on its clock.
      if (!s) return null;
      if (s.roundPhase === "live") seq.wentLive ??= this.e.now();
      return seq.wentLive !== null && this.cutBackAt(s, seq.wentLive) <= this.e.now() ? "deadline" : null;
    }
    if (this.abort || !this.settings().enabled) return "off";
    // (The time is read after: "now" from cutBackAt is then never later than it.)
    if (s && this.cutBackAt(s, seq.wentLive) <= this.e.now()) return "deadline";
    return null;
  }

  /**
   * How much of a chosen clip to show from `startsAt`: its part, with its lead-up shortened again
   * when the break has less time left than planned (freeze time reported, slow loads); null when it
   * no longer fits.
   */
  private fitNow(c: Planned, first: boolean, seq: Sequence, startsAt = this.e.now()): number | null {
    const s = this.e.session.state();
    if (!s || seq.kind === "test") return c.playMs;
    // Highlights fit in nothing until a round is live (then by its clock, as a break's replays).
    if (seq.kind === "highlights" && seq.wentLive === null && s.roundPhase !== "live") return c.playMs;
    // The first clip has the cut to the replay and back to make; a later one the switch and the cut back.
    return fitReplay(c, this.cutBackAt(s, seq.wentLive) - startsAt, this.settings().speedPercent, first ? CUT_MS : SWITCH_MS + CUT_MS / 2);
  }

  private clipPlayed(it: QueueItem, seq: Sequence, mixer: "obs" | "vmix", end: Stop): void {
    seq.played++;
    if (end === "skipped") seq.skipped++;
    seq.trace?.({ type: "clip", id: it.id, ok: true, error: null });
    // Test replays' sample clips and highlights (kept clips, played already or not): nothing is recorded in the replay list.
    if (seq.kind !== "break") return;
    this.e.replays.markPlayed(it.id);
    this.status = { ...this.status, lastPlayed: { id: it.id, label: it.label, at: new Date().toISOString() } };
    this.e.audit.record(HOLDER, "replay.auto_played", it.id, { label: it.label, origin: it.origin, ...(mixer === "vmix" ? { mixer } : {}), ...(end === "skipped" ? { skipped: true } : {}) });
  }

  /** The clip is on air: played this break (a sample clip of Test replays isn't counted; a highlight is a kept clip, not the replay list's). */
  private nowOnAir(it: QueueItem, seq: Sequence): void {
    if (seq.kind === "highlights") return;
    this.e.replays.markPlaying(it.id);
    if (seq.kind === "break") this.playedIds.add(it.id);
  }

  /** A clip of the replay list about to go on air is approved (a highlight isn't on the list). */
  private approve(it: QueueItem, seq: Sequence): void {
    if (seq.kind !== "highlights" && it.state === "prepared") this.e.replays.approve(it.id);
  }

  /** The clip may still go on air: not played or rejected meanwhile, nor excluded by the operator (a highlight always may). */
  private mayPlay(it: QueueItem, seq: Sequence): boolean {
    return seq.kind === "highlights" || (playable(it) && !this.excluded.has(it.id));
  }

  /** A clip that didn't play: failed (or rejected, if it never started), and the break goes on without it. */
  private clipFailed(it: QueueItem, err: unknown, seq: Sequence): void {
    const error = err instanceof Error ? err.message : String(err);
    if (seq.kind !== "highlights") {
      this.e.replays.markPlaybackFailed(it.id, error);
      if (it.state === "approved") this.e.replays.reject(it.id);
    }
    seq.failed++;
    seq.error = error;
    seq.trace?.({ type: "clip", id: it.id, ok: false, error });
    this.e.logger.warn("automatic replay failed", { id: it.id, error, mixer: this.settings().mixer });
  }

  /**
   * OBS: the break's clips with one transition into the replays and one back to live (the program
   * state machine's port picks them: Replay in, Replay out). By default (playback "rendered") they are
   * joined into one file and play in the replay scene's one media source (playRendered). When that file
   * can't be had in time, or OBS doesn't play it, they play through the scenes: alternating between the
   * replay scene and its twin (replay/twin.ts) with a fade (or cut) from one to the next, or in the
   * replay scene's one source without a twin (as before 0.10.5). The live game audio picked goes down
   * as the first clip goes on air and is put back after the last, however the replays end. Highlights
   * the same on the highlights scene (and its twin), Highlights in and out, and back to where the
   * program came from (live, once a round is live; returnFromHighlights).
   */
  private async playObs(seq: Sequence): Promise<void> {
    const stage = seq.stage;
    const main = stage.main();
    if (!main) throw new Error(stage.mode === "HIGHLIGHTS" ? "No highlights scene is mapped." : "No replay scene is mapped.");
    await this.putBackSource();
    const rendered = this.settings().playback === "rendered" ? await this.renderRun(seq) : null;
    const run = ++this.obsRuns;
    let end: Stop = "ended";
    let slots: Slot[] = [main];
    try {
      let how: Stop | "scenes" = "scenes";
      if (rendered) {
        await this.audio.applyReplayVolume().catch(() => undefined);
        how = await this.playRendered(seq, main, rendered);
      }
      if (how !== "scenes") end = how;
      else {
        // (Stopped, or the break's time up, while its file was made: nothing goes on air.)
        const why = this.interrupted(seq);
        if (why) end = why;
        else {
          const twin = await stage.twin().catch(() => null);
          if (!twin) seq.trace?.({ type: "one-source", why: stage.twinDetail() });
          await this.audio.applyReplayVolume().catch(() => undefined);
          if (twin) slots = [main, twin];
          end = twin ? await this.playObsTwin(seq, [main, twin]) : await this.playObsOneSource(seq, main.input);
        }
      }
    } finally {
      seq.stopped = end;
      // Back once (to live; highlights to where the program came from), unless someone else has the program.
      const p = this.e.program;
      if (end !== "taken" && p.owner.holder === stage.holder && (p.mode === stage.mode || p.mode === "REPLAY_PREPARED")) {
        try {
          const t = stage.mode === "HIGHLIGHTS" ? await p.returnFromHighlights(stage.owner, stage.holder, { live: this.e.session.state()?.roundPhase === "live" || end === "deadline", exists: (scene) => this.e.obs.state.scenes.includes(scene) }) : await p.request("LIVE", "automation", HOLDER);
          if (t) seq.trace?.({ type: "out", confirmed: t.confirmed, scene: this.e.obs.state.programScene, transition: this.e.obsAuto.lastSwitch?.transition ?? null, error: t.detail });
        } catch (err) {
          this.e.logger.warn(stage.mode === "HIGHLIGHTS" ? "highlights: could not go back" : "automatic replays: could not return to live", { error: String(err) });
          seq.trace?.({ type: "out", confirmed: false, scene: this.e.obs.state.programScene, transition: null, error: err instanceof Error ? err.message : String(err) });
        }
      }
      await this.audioBack(seq);
      if (end !== "taken") void this.emptySources(run, slots, rendered?.file ?? null);
    }
  }

  /**
   * After the replays, once the transition back has finished: the replay sources are emptied, so the
   * next break can't open on the last frame of this one's last clip (OBS can show a source's old
   * frame for a moment as it comes on air, before the new clip's first one), a source whose sound was
   * faded out at an early end gets its volume back, and the rendered file is removed. Not while a
   * source's scene is still on program, or once another run has started.
   */
  private async emptySources(run: number, slots: Slot[], file: string | null): Promise<void> {
    await sleep(EMPTY_AFTER_MS);
    if (run !== this.obsRuns || !this.e.obs.state.connected || slots.some((s) => this.e.obs.state.programScene === s.scene)) return;
    for (const s of slots) await this.e.obs.setMediaFile(s.input, "").catch(() => undefined);
    await this.putBackSource();
    if (file) removeFile(file);
  }

  /** The first clip goes on air (the transition in): a replay through REPLAY_PREPARED, highlights straight to HIGHLIGHTS. */
  private async goOnAir(seq: Sequence, it: QueueItem) {
    const { mode, owner, holder } = seq.stage;
    if (mode === "REPLAY_PLAYING") await this.e.program.request("REPLAY_PREPARED", owner, holder, { replayItemId: it.id });
    this.audioDown(seq);
    return this.e.program.request(mode, owner, holder, { replayItemId: it.id });
  }

  /** As the first clip goes on air: the live game audio picked goes down (with its ramp, alongside the transition). */
  private audioDown(seq: Sequence): void {
    seq.ducking ??= this.audio.duck().then(() => seq.trace?.({ type: "audio-down", inputs: this.audio.status().lowered }));
  }

  /** After the replays, however they ended: the live game audio back as it was. */
  private async audioBack(seq: Sequence): Promise<void> {
    if (seq.ducking) await seq.ducking;
    if (!seq.ducking && !this.audio.lowered) return;
    const r = await this.audio.restore();
    seq.trace?.({ type: "audio-back", ...r });
  }

  /**
   * An early end (Stop, Skip of the last clip, the round clock): the replay source's sound fades out
   * over `ms` (as Replay out starts, or before the cut back when there is time), and its volume comes
   * back once it is off air (emptySources, or the next run).
   */
  private fadeSourceOut(input: string, ms: number): void {
    if (this.turnedDown || !this.e.obs.state.connected) return;
    const t: { input: string; mul: number; fading: Promise<void> } = { input, mul: Number.NaN, fading: Promise.resolve() };
    this.turnedDown = t;
    t.fading = (async () => {
      const v = await this.e.obs.inputVolume(input).catch(() => null);
      if (!v) return;
      t.mul = v.mul;
      const steps = Math.max(1, Math.round(ms / 40));
      for (let i = 1; i <= steps && this.turnedDown === t; i++) {
        await this.e.obs.setInputVolume(input, { mul: v.mul * Math.cos((Math.PI / 2) * (i / steps)) }).catch(() => undefined);
        if (i < steps) await sleep(ms / steps);
      }
    })();
  }

  /** A replay source faded out at an early end gets its volume back (off air). */
  private async putBackSource(): Promise<void> {
    const t = this.turnedDown;
    if (!t) return;
    await t.fading;
    this.turnedDown = null;
    if (Number.isFinite(t.mul)) await this.e.obs.setInputVolume(t.input, { mul: t.mul }).catch((err) => this.e.logger.warn("automatic replays: the replay source's volume wasn't put back", { input: t.input, error: String(err) }));
  }

  /** How long until the break's time is up (the cut back on the round clock), or null when nothing cuts it (Test replays; highlights before a round is live). */
  private deadlineIn(seq: Sequence): number | null {
    const s = this.e.session.state();
    if (!s || seq.kind === "test") return null;
    if (seq.kind === "highlights" && seq.wentLive === null && s.roundPhase !== "live") return null;
    return this.cutBackAt(s, seq.kind === "highlights" ? (seq.wentLive ?? this.e.now()) : seq.wentLive) - this.e.now();
  }

  // ------------------------------------------------------------------ rendered: one file, one scene

  /**
   * A run's clips (a break's, Test replays', highlights') rendered into one file (render.ts): the clips
   * taken from the list as far as they still fit once it is made. Null when it can't be had in time
   * (the clips go back on the list and play through the scenes): no ffmpeg, an error, longer than
   * renderWaitMs (a break, Test replays; highlights wait longer) or than the break has time for, or the
   * replays stopped meanwhile. Logged, traced and in the status either way.
   */
  private async renderRun(seq: Sequence): Promise<RenderedRun | null> {
    const st = this.settings();
    const fadeMs = st.between === "fade" ? st.fadeMs : 0;
    const wall = (ms: number) => (ms * 100) / st.speedPercent;
    const taken: Planned[] = [];
    const clips: RenderedRun["clips"] = [];
    let at = this.e.now() + this.renderGuessMs;
    for (let c = this.take(seq); c; c = this.take(seq)) {
      taken.push(c);
      if (!this.mayPlay(c.item, seq) || !c.item.clip?.media.path) continue;
      const playMs = this.fitNow(c, !clips.length, seq, at);
      if (playMs === null) continue;
      clips.push({ c: { ...c, playMs }, n: clips.length + 1 });
      at += wall(playMs) - fadeMs;
    }
    const giveBack = (detail: string | null, ms: number | null = null): null => {
      seq.rest.unshift(...taken);
      seq.taken -= taken.length;
      if (detail === null) return null;
      this.lastRender = { at: new Date().toISOString(), kind: seq.kind, clips: clips.length, rendered: false, ms, encoder: null, detail: `Played through the scenes: ${detail}.` };
      seq.trace?.({ type: "rendered", ok: false, clips: clips.length, ms, detail });
      this.e.logger.warn("automatic replays: no rendered file; the clips play through the scenes", { kind: seq.kind, clips: clips.length, why: detail, ms });
      return null;
    };
    if (!clips.length) return giveBack(null);
    const ffmpeg = await this.e.ffmpeg.locate();
    if (!ffmpeg) return giveBack(this.e.ffmpeg.status().canDownload ? "ffmpeg isn't installed (Replay feed → Download ffmpeg)" : "ffmpeg isn't installed");
    let encoder: Encoder;
    try {
      encoder = await this.e.ffmpeg.pickEncoder(this.e.replayFeed.settings().encoder);
    } catch (err) {
      return giveBack(`ffmpeg can't encode here (${err instanceof Error ? err.message : String(err)})`);
    }
    const dir = join(this.e.replayDir(), RENDER_DIR);
    let file: string;
    try {
      mkdirSync(dir, { recursive: true });
      // Files of earlier runs (one still open in OBS, on Windows, stays until the next time).
      for (const f of readdirSync(dir)) removeFile(join(dir, f));
      file = join(dir, `${seq.kind}-${Date.now().toString(36)}.mp4`);
    } catch (err) {
      return giveBack(`the replay folder can't be written (${err instanceof Error ? err.message : String(err)})`);
    }
    const started = this.e.now();
    const job = this.renderer({ ffmpeg, version: this.e.ffmpeg.status().version, encoder, clips: clips.map(({ c }) => ({ file: c.item.clip!.media.path!, startMs: null, durationMs: c.playMs })), fadeMs, audioFadeMs: st.audioFadeMs, outFile: file });
    let done: RenderedBreak | null = null;
    let failed: string | null = null;
    job.done.then(
      (r) => (done = r),
      (err) => (failed = err instanceof Error ? err.message : String(err)),
    );
    const limit = seq.kind === "highlights" ? HIGHLIGHTS_RENDER_MAX_MS : this.renderWaitMs;
    const what = seq.kind === "test" ? "Test replays" : seq.kind === "highlights" ? "highlights" : "the replays";
    this.preparing = { kind: seq.kind, progress: 0, clips: clips.length };
    try {
      while (!done && failed === null) {
        this.preparing.progress = job.progress();
        this.setStatus("playing", `Preparing ${what}… ${Math.round(job.progress() * 100)}%`);
        const why = this.interrupted(seq);
        const waited = this.e.now() - started;
        // A break: no use once its first clip no longer fits (the round clock).
        const late = seq.kind === "break" && this.fitNow(clips[0]!.c, true, seq, this.e.now() + Math.max(0, this.renderGuessMs - waited)) === null;
        if (why || waited > limit || late) {
          job.cancel();
          return giveBack(why ? `the replays stopped (${why}) while the file was made` : late ? "the break's time ran out while the file was made" : `making the file took longer than ${Math.round(limit / 1000)} s`, waited);
        }
        await sleep(50);
      }
    } finally {
      this.preparing = null;
    }
    if (!done) return giveBack(`ffmpeg failed (${failed ?? "no message"})`, this.e.now() - started);
    const r = done as RenderedBreak;
    this.renderGuessMs = Math.round((this.renderGuessMs + r.ms) / 2);
    const detail = `${clips.length} clip${clips.length === 1 ? "" : "s"} rendered into one file in ${(r.ms / 1000).toFixed(1)} s (${r.encoder}, ${r.width}×${r.height}).`;
    this.lastRender = { at: new Date().toISOString(), kind: seq.kind, clips: clips.length, rendered: true, ms: r.ms, encoder: r.encoder, detail };
    seq.trace?.({ type: "rendered", ok: true, clips: clips.length, ms: r.ms, detail });
    this.e.logger.info("automatic replays: rendered", { kind: seq.kind, clips: clips.length, ms: r.ms, encoder: r.encoder, bytes: r.bytes, totalMs: r.layout.totalMs });
    return { file: r.file, layout: r.layout, clips, taken, encoder: r.encoder, outLeadMs: 0 };
  }

  /**
   * A rendered run in the scene's one media source: the file is loaded off air and must play (its
   * cursor moving), then Replay in (Highlights in) shows the scene and the clips start as it does (a
   * Stinger's cut point: the file opens on the first clip's first frame held). The replay graphic, the
   * program's clip and the status follow the cursor from one clip to the next. Skip goes to the next
   * clip's start in the file, Hold pauses it on air, Stop and the round clock end it (its sound faded
   * out first when there is time). "scenes" when OBS doesn't play the file before it goes on air: the
   * clips go back on the list.
   */
  private async playRendered(seq: Sequence, slot: Slot, r: RenderedRun): Promise<Stop | "scenes"> {
    const st = this.settings();
    const media = (ms: number) => (ms * st.speedPercent) / 100;
    const input = slot.input;
    const L = r.layout;
    const first = r.clips[0]!.c.item;
    const reload = async (at: number) => {
      await this.reopen(input, r.file);
      await this.obsPlaying(input, true, r.file);
      await this.obsSeek(input, at);
    };
    let hidden: { durationMs: number | null; cursorMs: number | null } | null;
    try {
      await this.e.obs.setMediaFile(input, r.file, { speedPercent: st.speedPercent });
      hidden = await this.obsPlaying(input, false);
      if (hidden && !(await this.moving(input, MOVE_CHECK_MS + 200)).moved) throw new Error("it opened, but its cursor didn't move");
    } catch (err) {
      const detail = `OBS didn't play the rendered file (${err instanceof Error ? err.message : String(err)})`;
      this.lastRender = { ...this.lastRender!, rendered: false, detail: `Played through the scenes: ${detail}.` };
      seq.trace?.({ type: "rendered", ok: false, clips: r.clips.length, ms: null, detail });
      this.e.logger.warn("automatic replays: the rendered file didn't play; the clips play through the scenes", { error: detail });
      seq.rest.unshift(...r.taken);
      seq.taken -= r.taken.length;
      return "scenes";
    }
    this.renderedStatus(seq, r, 0);
    this.approve(first, seq);
    try {
      // Into the replays (Replay in; highlights: Highlights in): the clips start as the transition shows the scene.
      const t = await this.goOnAir(seq, first);
      seq.trace?.({ type: "in", scene: this.e.obs.state.programScene, confirmed: t.confirmed, transition: this.e.obsAuto.lastSwitch?.transition ?? null });
      const point = this.e.obsAuto.cutPointMs(slot.scene);
      seq.inCutMs = point;
      const since = Date.now() - (this.e.obsAuto.lastSwitch?.at ?? Date.now());
      // The same transition back (a Stinger in and out): it starts its cut point before the clips' end, so the scene leaves as they end.
      r.outLeadMs = Math.min(L.tailMs, this.outLeadMs(seq));
      if (hidden) await this.obsSeek(input, Math.max(0, L.leadMs - media(point - since)));
      else {
        // A source that doesn't play hidden opens its file as it is shown.
        if (point > since) await sleep(point - since);
        await this.obsPlaying(input, true, r.file);
        await this.obsSeek(input, L.leadMs);
      }
      this.nowOnAir(first, seq);
      await this.ensureMoving(input, () => L.leadMs, reload, first.id);
    } catch (err) {
      this.clipFailed(first, err, seq);
      return "late";
    }
    return this.watchRendered(seq, input, r, reload);
  }

  /** The status while a rendered run's clip `k` is on air: "Replay 2 of 3: <label>". */
  private renderedStatus(seq: Sequence, r: RenderedRun, k: number): void {
    const it = r.clips[k]!.c.item;
    this.setStatus("playing", `${seq.kind === "test" ? "Test replay" : seq.kind === "highlights" ? "Highlight" : "Replay"} ${k + 1} of ${r.clips.length}: ${it.label}`, { id: it.id, label: it.label }, { n: k + 1, of: r.clips.length });
  }

  /**
   * Until the rendered file's clips are over (the cursor at their end), the operator skips the last or
   * stops them, the break's time is up, or the program is taken. As the cursor reaches a clip's start
   * (the fade into it), that clip is the program's (the replay graphic shows it) and the status says
   * so. Hold pauses it on air until Resume. A file that stops moving is played again, then loaded again
   * where it was, then given up (back to live).
   */
  private async watchRendered(seq: Sequence, input: string, r: RenderedRun, reload: (at: number) => Promise<void>): Promise<Stop> {
    const st = this.settings();
    const wall = (ms: number) => (ms * 100) / st.speedPercent;
    const L = r.layout;
    const contentEnd = L.leadMs + L.contentMs;
    const stall = new StallWatch(() => this.e.now());
    let k = 0;
    let wait = 100;
    let heldAt: number | null = null;
    let fading = false;
    const finish = (end: Stop): Stop => {
      this.clipPlayed(r.clips[k]!.c.item, seq, "obs", end);
      // Ended early: the sound fades out as the program goes back (unless someone else has it).
      if (end !== "ended" && end !== "taken" && end !== "late") this.fadeSourceOut(input, Math.min(st.audioFadeMs, 300));
      return end;
    };
    const to = async (next: number, how: Stop) => {
      this.clipPlayed(r.clips[k]!.c.item, seq, "obs", how);
      k = next;
      const it = r.clips[k]!.c.item;
      this.approve(it, seq);
      this.renderedStatus(seq, r, k);
      await this.e.program.request(seq.stage.mode, seq.stage.owner, seq.stage.holder, { replayItemId: it.id });
      this.nowOnAir(it, seq);
    };
    for (;;) {
      await sleep(wait);
      const id = r.clips[k]!.c.item.id;
      const why = this.interrupted(seq);
      if (why) return finish(why);
      if (!this.onAirOurs(seq, id)) return finish("taken");
      if (this.ctl.skip === id) {
        this.ctl.skip = null;
        if (k + 1 >= r.clips.length) return finish("skipped");
        // On to the next clip's start in the file (the fade into it).
        await this.obsSeek(input, L.starts[k + 1]!);
        await to(k + 1, "skipped");
        stall.reset();
        continue;
      }
      // Hold: paused where it is (on air, which OBS does).
      if (this.ctl.held !== (heldAt !== null)) {
        if (this.ctl.held) {
          heldAt = this.e.now();
          await this.e.obs.mediaAction(input, "pause").catch((err) => this.e.logger.warn("automatic replays: OBS didn't pause the replays", { error: String(err) }));
        } else {
          heldAt = null;
          stall.reset();
          await this.e.obs.mediaAction(input, "play").catch((err) => this.e.logger.warn("automatic replays: OBS didn't play the replays again", { error: String(err) }));
        }
      }
      if (heldAt !== null) {
        wait = 50;
        continue;
      }
      const m = await this.e.obs.mediaStatus(input).catch(() => null);
      if (!m || m.state === "OBS_MEDIA_STATE_ENDED" || m.state === "OBS_MEDIA_STATE_STOPPED") return finish("ended");
      const p = m.cursorMs ?? 0;
      while (k + 1 < r.clips.length && p >= L.starts[k + 1]!) await to(k + 1, "ended");
      if (p >= contentEnd - (r.outLeadMs * st.speedPercent) / 100 - 40) return finish("ended");
      // The round clock: the sound fades out before the cut back, when there is time for it.
      const left = this.deadlineIn(seq);
      if (!fading && left !== null && left <= st.audioFadeMs + 150) {
        fading = true;
        this.fadeSourceOut(input, Math.max(100, Math.min(st.audioFadeMs, left - 50)));
      }
      const act = stall.check(m.cursorMs);
      if (act === "give-up") {
        this.e.logger.warn("automatic replays: OBS stopped playing the replays (played again, and loaded again)", { id, cursorMs: m.cursorMs });
        return finish("late");
      }
      if (act) await this.unstick(input, act, m.cursorMs ?? 0, reload, id);
      const upcoming = k + 1 < r.clips.length ? L.starts[k + 1]! : contentEnd - (r.outLeadMs * st.speedPercent) / 100;
      wait = Math.max(25, Math.min(100, wall(upcoming - p)));
    }
  }

  // ------------------------------------------------------------------ through the scenes

  /**
   * Through the scenes (playback "scenes", or no rendered file): the clips alternate between the replay
   * scene and its twin. None waits paused off air (a Windows OBS lets a hidden source's pause go, and
   * the clip runs on): each is loaded into the scene off air just in time, one load time (measured)
   * before its fade (the first: before the cut in), skipped so it is at its part when it shows, and
   * plays hidden into the fade. One fade length before the clip on air ends (or as it ends, with a
   * cut), the program fades over to its scene, so the end of one blends into the start of the next. On
   * air each must move (ensureMoving); one that doesn't play is skipped. If the operator excludes the
   * clip next, or pins another, the right one is loaded in its place.
   */
  private async playObsTwin(seq: Sequence, slots: [Slot, Slot]): Promise<Stop> {
    const st = this.settings();
    const fade = st.between === "fade";
    const pick: TransitionPick = fade ? { kind: "fade_transition", durationMs: st.fadeMs } : { kind: "cut_transition" };
    const wall = (ms: number) => (ms * 100) / st.speedPercent;
    const media = (ms: number) => (ms * st.speedPercent) / 100;
    let shown = false;
    // The list's next clip that may still play, for a scene off air (loaded later, just in time); null when none is left.
    const prepare = (slot: number, startsAt: number): Next | null => {
      for (let c = this.take(seq); c; c = this.take(seq)) {
        if (!this.mayPlay(c.item, seq)) continue;
        const playMs = this.fitNow(c, !shown, seq, startsAt);
        if (playMs === null) continue;
        return { c, n: seq.taken, slot, playMs, loaded: null };
      }
      return null;
    };
    // Loads into the scene off air one after the other (a clip replaced by the operator's change waits for the one before).
    let chain: Promise<unknown> = Promise.resolve();
    const load = (n: Next, at: number) => {
      const p = chain.then(() => this.loadHidden(slots[n.slot]!.input, n.c.item, n.playMs, at));
      chain = p.catch(() => undefined);
      n.loaded = p;
    };
    let next = prepare(0, this.e.now());
    while (next) {
      const why = this.interrupted(seq) ?? (shown && !this.onAirOurs(seq) ? "taken" : null);
      if (why) return why;
      const cur: Next = next;
      const it = cur.c.item;
      const scene = slots[cur.slot]!;
      // Played, rejected or excluded meanwhile, or it no longer fits: the next one, in the same scene.
      const playMs = this.mayPlay(it, seq) ? this.fitNow(cur.c, !shown, seq) : null;
      if (playMs === null) {
        next = prepare(cur.slot, this.e.now());
        continue;
      }
      let over: Promise<boolean> | null = null;
      const reload = async (at: number) => void (await this.reloadAt(scene.input, it, at, true));
      try {
        this.approve(it, seq);
        // Loaded just in time (it plays hidden, at its part by now), or now (the first, one after a failure).
        if (!cur.loaded) load(cur, this.e.now());
        const h = await this.alignHidden(scene.input, it, playMs, await cur.loaded!);
        this.onAirStatus(seq, cur.n, it);
        // Where it should be once on air (null: the source doesn't play hidden; it is skipped there once shown).
        let cued = h.cursorMs;
        if (!shown) {
          // Into the replays (Replay in; highlights: Highlights in): the clip is at its part as the transition shows the scene (a Stinger's cut point).
          const t = await this.goOnAir(seq, it);
          shown = true;
          seq.trace?.({ type: "in", scene: this.e.obs.state.programScene, confirmed: t.confirmed, transition: this.e.obsAuto.lastSwitch?.transition ?? null });
          const point = this.e.obsAuto.cutPointMs(scene.scene);
          seq.inCutMs = point;
          const since = Date.now() - (this.e.obsAuto.lastSwitch?.at ?? Date.now());
          if (h.cursorMs !== null && point - since > 150) {
            cued = Math.max(0, h.partMs - media(point - since));
            await this.obsSeek(scene.input, cued);
          }
          if (h.cursorMs === null) {
            if (point > since) await sleep(point - since);
            await this.e.obs.mediaAction(scene.input, "play").catch(() => undefined);
          }
        } else {
          // From one to the next: it plays hidden already (one that doesn't plays as it shows) and the program fades (or cuts) over to its scene.
          if (h.cursorMs === null) await this.e.obs.mediaAction(scene.input, "play");
          await this.e.program.request(seq.stage.mode, seq.stage.owner, seq.stage.holder, { replayItemId: it.id });
          over = this.e.obs.waitTransitionEnd(fade ? st.fadeMs + 400 : 400);
          const confirmed = await this.e.obsAuto.switchProgram(scene.scene, pick);
          seq.trace?.({ type: "between", scene: scene.scene, confirmed, transition: this.e.obsAuto.lastSwitch?.transition ?? null });
        }
        this.nowOnAir(it, seq);
        await this.toPartOnAir(scene.input, it, playMs, cued);
        await this.ensureMoving(scene.input, () => h.partMs, reload, it.id);
      } catch (err) {
        this.clipFailed(it, err, seq);
        // On to the next clip, in the scene that isn't on air.
        const onAir = this.e.obs.state.programScene === scene.scene;
        next = prepare(onAir ? 1 - cur.slot : cur.slot, this.e.now());
        continue;
      }
      // The scene faded out of is off air once the fade is over: the next clip is loaded there, just in time.
      if (over) await over;
      const startsAt = this.e.now() + wall(playMs) - (fade ? st.fadeMs : 0);
      next = prepare(1 - cur.slot, startsAt);
      const end = await this.watchObs(
        scene.input,
        it.id,
        playMs,
        // The last: the transition back starts its cut point before the end when it is the one in (a Stinger in and out).
        () => (next ? (fade ? st.fadeMs : 0) : this.outLeadMs(seq)),
        seq,
        (toLead) => {
          // The operator excluded the clip next, or pinned another (one may join after the last): the right one is next now.
          if (next ? this.stale(seq, next.c) : this.waitingPin(seq)) {
            if (next) this.putBack(seq, next.c);
            next = prepare(1 - cur.slot, startsAt);
          }
          // Just in time: one load time before its fade (or the cut), it is loaded and set going toward its part.
          if (next && !next.loaded && toLead !== null && toLead <= this.loadLeadMs()) load(next, this.e.now() + toLead);
        },
        reload,
      );
      this.clipPlayed(it, seq, "obs", end);
      if (!goesOn(end)) return end;
    }
    return "ended";
  }

  /**
   * How long (wall ms) before the replays' end the transition back starts: the cut point of the
   * transition in (a Stinger's), when the transition back is the same one, so the scene leaves as
   * the last clip ends rather than on its last frame held; else 0.
   */
  private outLeadMs(seq: Sequence): number {
    const mode = seq.stage.mode;
    const inPick = this.e.obsAuto.pickFor({ from: mode === "HIGHLIGHTS" ? "LIVE" : "REPLAY_PREPARED", to: mode });
    if (JSON.stringify(inPick) !== JSON.stringify(this.e.obsAuto.pickFor({ from: mode, to: "LIVE" }))) return 0;
    return Math.min(TAIL_MS, seq.inCutMs ?? 0);
  }

  /** How long before it is due the next clip is loaded off air: what OBS took to play one (and half again), and time to skip it to its part. */
  private loadLeadMs(): number {
    return Math.min(LOAD_LEAD_MAX_MS, Math.max(LOAD_LEAD_MIN_MS, Math.round(this.loadMs * 1.5) + SEEK_SETTLE_MS));
  }

  /**
   * Without the twin: the first clip is loaded off air and skipped to its end part (the play and its
   * lead-up), then the program goes to the replay scene. Each next clip is loaded into the same
   * source as soon as the one before ends and skipped to its part, without going live in between. On
   * air each must move (ensureMoving).
   */
  private async playObsOneSource(seq: Sequence, input: string): Promise<Stop> {
    const st = this.settings();
    let shown = false;
    let end: Stop = "ended";
    for (let c = this.take(seq); c; c = this.take(seq)) {
      const it = c.item;
      const why = this.interrupted(seq) ?? (shown && !this.onAirOurs(seq) ? "taken" : null);
      if (why) return why;
      // Played or rejected by hand meanwhile, or no longer fits in the time left.
      if (!this.mayPlay(it, seq)) continue;
      const playMs = this.fitNow(c, !shown, seq);
      if (playMs === null) continue;
      this.onAirStatus(seq, seq.taken, it);
      const reload = async (at: number) => void (await this.reloadAt(input, it, at, true));
      try {
        this.approve(it, seq);
        if (!shown) {
          // Off air: the clip is loaded (an earlier one still playing there is held first) and, if OBS
          // plays it hidden, skipped to its part, so the cut opens on it.
          if ((await this.e.obs.mediaStatus(input).catch(() => null))?.state === "OBS_MEDIA_STATE_PLAYING") await this.e.obs.mediaAction(input, "pause").catch(() => undefined);
          await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: st.speedPercent });
          const hidden = await this.obsPlaying(input, false);
          const startHidden = partStart(hidden?.durationMs ?? it.clip!.media.durationMs, playMs);
          const cued = hidden ? (startHidden ? await this.obsSeek(input, startHidden) : hidden.cursorMs) : null;
          const t = await this.goOnAir(seq, it);
          shown = true;
          seq.trace?.({ type: "in", scene: this.e.obs.state.programScene, confirmed: t.confirmed, transition: this.e.obsAuto.lastSwitch?.transition ?? null });
          this.nowOnAir(it, seq);
          await this.toPartOnAir(input, it, playMs, cued);
          await this.ensureMoving(input, () => startHidden, reload, it.id);
        } else {
          // On air: the next clip goes into the same source; until it plays, the last frame of the one before stays.
          if (end === "late" || end === "skipped") await this.e.obs.mediaAction(input, "pause").catch(() => undefined);
          await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: st.speedPercent });
          await this.e.program.request(seq.stage.mode, seq.stage.owner, seq.stage.holder, { replayItemId: it.id });
          this.nowOnAir(it, seq);
          const media = (await this.obsPlaying(input, true, it.clip!.media.path!))!;
          const start = partStart(media.durationMs ?? it.clip!.media.durationMs, playMs);
          if (start) await this.obsSeek(input, start);
          await this.ensureMoving(input, () => start, reload, it.id);
        }
        end = await this.watchObs(input, it.id, playMs, () => 0, seq, undefined, reload);
        this.clipPlayed(it, seq, "obs", end);
      } catch (err) {
        this.clipFailed(it, err, seq);
        end = "late";
      }
      if (!goesOn(end)) return end;
    }
    return "ended";
  }

  /**
   * Off air, just in time: loads a clip and, once OBS plays it (hidden), skips it so it reaches its
   * part at `at` (as it shows: its fade, or the cut in). Never paused. Returns where it is (cursor null: the source doesn't play hidden; it goes to its part
   * once shown), its length and its part's start; how long OBS took to play it leads the next one.
   */
  private async loadHidden(input: string, it: QueueItem, playMs: number, at: number): Promise<Hidden> {
    const speed = this.settings().speedPercent;
    // A part that starts (nearly) at the file's start can't be skipped back to: the file is loaded later, so it starts about as it shows.
    const early = at - this.e.now() - (partStart(it.clip!.media.durationMs, playMs) * 100) / speed - this.loadMs * 1.2;
    if (early > 0) await sleep(early);
    const t0 = this.e.now();
    await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: speed });
    const hidden = await this.obsPlaying(input, false);
    if (!hidden) return { cursorMs: null, durationMs: null, partMs: partStart(it.clip!.media.durationMs, playMs) };
    this.loadMs = Math.round((this.loadMs + (this.e.now() - t0)) / 2);
    const partMs = partStart(hidden.durationMs ?? it.clip!.media.durationMs, playMs);
    const target = Math.max(0, partMs - (Math.max(0, at - this.e.now()) * speed) / 100);
    const cursorMs = target > 0 || (hidden.cursorMs ?? 0) > 300 ? await this.obsSeek(input, target) : hidden.cursorMs;
    return { cursorMs, durationMs: hidden.durationMs, partMs };
  }

  /**
   * The clip loaded off air, as it goes on air: at its part. One that ran on (the clip on air was held,
   * or OBS let it run to its end) is loaded again and skipped there (never restarted and paused: a
   * Windows OBS leaves a clip stuck near its start after that); one well before its part (the fade
   * came early: Skip; or it was shortened since) is skipped there; one a moment before it is let reach it.
   */
  private async alignHidden(input: string, it: QueueItem, playMs: number, h: Hidden): Promise<Hidden> {
    if (h.cursorMs === null) return h;
    const speed = this.settings().speedPercent;
    const partMs = partStart(h.durationMs ?? it.clip!.media.durationMs, playMs);
    const m = await this.e.obs.mediaStatus(input).catch(() => null);
    const at = m?.cursorMs ?? null;
    if (m?.state !== "OBS_MEDIA_STATE_PLAYING" || at === null || at > partMs + RAN_ON_MS) {
      this.e.logger.warn("automatic replays: the clip waiting off air ran on; loaded again at its part", { id: it.id, state: m?.state ?? null, cursorMs: at, partMs });
      const again = await this.reloadAt(input, it, partMs, false);
      return { cursorMs: again.cursorMs, durationMs: again.durationMs ?? h.durationMs, partMs };
    }
    if (partMs - at > 300) return { ...h, cursorMs: await this.obsSeek(input, partMs), partMs };
    if (partMs - at > 0) await sleep(Math.min(REACH_PART_MS, ((partMs - at) * 100) / speed));
    return { ...h, cursorMs: Math.max(at, partMs), partMs };
  }

  /**
   * Opens a clip's file again and skips it to `at` (a clip that ran on, or stuck on air): never a
   * restart then a pause or a seek, which can leave a Windows OBS's clip stuck near its start.
   */
  private async reloadAt(input: string, it: QueueItem, at: number, onAir: boolean): Promise<{ cursorMs: number | null; durationMs: number | null }> {
    const file = it.clip!.media.path!;
    await this.reopen(input, file);
    const m = await this.obsPlaying(input, onAir, file);
    if (!m) return { cursorMs: null, durationMs: null };
    return { cursorMs: at > 0 ? await this.obsSeek(input, at) : m.cursorMs, durationMs: m.durationMs };
  }

  /**
   * Opens a media source's file again: OBS 30 leaves a source alone when it is given the file it has
   * (its cursor carries on, measured), so it is emptied first.
   */
  private async reopen(input: string, file: string): Promise<void> {
    await this.e.obs.setMediaFile(input, "");
    await this.e.obs.setMediaFile(input, file, { speedPercent: this.settings().speedPercent });
  }

  /** On air: a source that plays only when shown, or starts over when shown (OBS's default for a new one), is skipped to the part now. */
  private async toPartOnAir(input: string, it: QueueItem, playMs: number, cued: number | null): Promise<void> {
    const media = (await this.obsPlaying(input, true, it.clip!.media.path!))!;
    const start = partStart(media.durationMs ?? it.clip!.media.durationMs, playMs);
    if (start && (cued === null || (media.cursorMs ?? 0) < cued - 300)) await this.obsSeek(input, start);
  }

  /**
   * On air, the clip must move: if its cursor doesn't within MOVE_CHECK_MS, play is sent again; if it
   * still doesn't, its file is loaded again and skipped to `at()`; if it still doesn't, this throws
   * why (the clip is skipped, and logged).
   */
  private async ensureMoving(input: string, at: () => number, reload: (at: number) => Promise<void>, id: string): Promise<void> {
    let m = await this.moving(input, MOVE_CHECK_MS);
    if (m.moved) return;
    this.e.logger.warn("automatic replays: OBS didn't play the clip on air; play sent again", { id, cursorMs: m.cursorMs, state: m.state });
    await this.e.obs.mediaAction(input, "play").catch(() => undefined);
    m = await this.moving(input, MOVE_CHECK_MS);
    if (m.moved) return;
    this.e.logger.warn("automatic replays: OBS still didn't play the clip; loading it again", { id, cursorMs: m.cursorMs, state: m.state });
    await reload(at());
    m = await this.moving(input, MOVE_CHECK_MS);
    if (m.moved) return;
    throw new Error(`OBS didn't play it: its cursor stayed at ${m.cursorMs ?? "?"} ms (${m.state?.replace("OBS_MEDIA_STATE_", "").toLowerCase() ?? "no state"}), after play and after loading it again`);
  }

  /** The media source's cursor moves within `ms` (or it ended); where it was last. */
  private async moving(input: string, ms: number): Promise<{ moved: boolean; cursorMs: number | null; state: string | null }> {
    const first = await this.e.obs.mediaStatus(input).catch(() => null);
    const t0 = this.e.now();
    let last = first;
    while (this.e.now() - t0 < ms) {
      await sleep(30);
      last = await this.e.obs.mediaStatus(input).catch(() => null);
      if (last?.state === "OBS_MEDIA_STATE_ENDED") return { moved: true, cursorMs: last.cursorMs, state: last.state };
      if (last?.state === "OBS_MEDIA_STATE_PLAYING" && last.cursorMs !== null && first?.cursorMs !== null && first?.cursorMs !== undefined && last.cursorMs !== first.cursorMs) return { moved: true, cursorMs: last.cursorMs, state: last.state };
    }
    return { moved: false, cursorMs: last?.cursorMs ?? null, state: last?.state ?? null };
  }

  /** A clip on air that stopped moving: play sent again ("play"), or its file loaded again where it was ("reload"). */
  private async unstick(input: string, act: "play" | "reload", cursorMs: number, reload: ((at: number) => Promise<void>) | undefined, id: string): Promise<void> {
    if (act === "play" || !reload) {
      this.e.logger.warn("automatic replays: OBS stopped playing the clip; play sent again", { id, cursorMs });
      await this.e.obs.mediaAction(input, "play").catch(() => undefined);
      return;
    }
    this.e.logger.warn("automatic replays: OBS still doesn't play the clip; loading it again where it was", { id, cursorMs });
    await reload(cursorMs).catch((err) => this.e.logger.warn("automatic replays: the clip didn't load again", { id, error: String(err) }));
  }

  /**
   * Waits for OBS to play the clip just loaded (looking often: on air, the last frame of the clip
   * before stays until then). Off air (`startIt` false) it gives up after a moment: a source that
   * plays only when shown. On air, one that doesn't start a new file by itself is started: its file
   * loaded again (`file`), or restarted.
   */
  private async obsPlaying(input: string, startIt: boolean, file?: string): Promise<{ durationMs: number | null; cursorMs: number | null } | null> {
    const loadedAt = this.e.now();
    let restarted = false;
    for (;;) {
      const media = await this.e.obs.mediaStatus(input).catch(() => null);
      const waited = this.e.now() - loadedAt;
      // Just opened, OBS may not know the file's length yet (it can say -9223372036854776): wait a little for it.
      if (media?.state === "OBS_MEDIA_STATE_PLAYING" && ((media.durationMs ?? 0) > 0 || waited > 500)) return { durationMs: media.durationMs && media.durationMs > 0 ? media.durationMs : null, cursorMs: media.cursorMs };
      if (waited > 3000 || (media?.state === "OBS_MEDIA_STATE_ERROR" && waited > 300)) throw new Error(`OBS did not start the clip (media state ${media?.state ?? "unknown"})`);
      if (!startIt && waited > 500) return null;
      if (startIt && !restarted && waited > 500 && media?.state !== "OBS_MEDIA_STATE_OPENING" && media?.state !== "OBS_MEDIA_STATE_PLAYING") {
        restarted = true;
        if (file) await this.reopen(input, file).catch(() => undefined);
        else await this.e.obs.mediaAction(input, "restart").catch(() => undefined);
      }
      await sleep(25);
    }
  }

  /**
   * Skips the clip to its part and waits (briefly) for OBS to get there; asks again once if it
   * clearly didn't. OBS goes to the keyframe before the part (it doesn't seek between keyframes), so
   * anywhere up to KEYFRAME_SLACK_MS before it counts. `paused`: the clip is held, its cursor doesn't
   * move (and OBS 30 first says 0 after a seek while paused). Returns where the clip is.
   */
  private async obsSeek(input: string, start: number, paused = false): Promise<number | null> {
    let at: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = (await this.e.obs.mediaStatus(input).catch(() => null))?.cursorMs ?? null;
      const sentAt = this.e.now();
      await this.e.obs.setMediaCursor(input, start);
      for (let i = 0; i < 12; i++) {
        await sleep(25);
        at = (await this.e.obs.mediaStatus(input).catch(() => null))?.cursorMs ?? null;
        if (at === null || (at === 0 && start > 300 && i < 4)) continue;
        const jumped = before === null || Math.abs(at - before - (paused ? 0 : this.e.now() - sentAt)) > 300;
        const near = at >= start - KEYFRAME_SLACK_MS && at <= start + 300 + (paused ? 0 : this.e.now() - sentAt);
        if (near && (jumped || i >= 3)) return at;
      }
    }
    return at;
  }

  /**
   * Until the clip on air ends (or is `leadOut()` from its end: the fade to the next is due), runs
   * past its time, the operator skips it, or the break's replays must stop. The operator's Hold
   * pauses it (and its time) until Resume; the break's end still stops it. `onPoll` runs each time
   * it looks, with how long until the fade (null while held): the next clip is loaded off air then,
   * and changed when the operator changes the list. A clip that stops moving is played again, then
   * loaded again where it was (`reload`), before it is given up.
   */
  private async watchObs(input: string, id: string, playMs: number, leadOut: () => number, seq: Sequence, onPoll?: (toLeadMs: number | null) => void, reload?: (at: number) => Promise<void>): Promise<Stop> {
    const speed = this.settings().speedPercent;
    const wall = (ms: number) => (ms * 100) / speed;
    // Until OBS says where the clip is: it starts at the keyframe before the part, so it may run longer (up to KEYFRAME_SLACK_MS).
    let endsAt = this.e.now() + wall(playMs);
    let deadline = this.e.now() + replayWallMs(playMs, speed) + 1500;
    let placed = false;
    let cursor: number | null = null;
    const stall = new StallWatch(() => this.e.now());
    let wait = 100;
    let heldAt: number | null = null;
    for (;;) {
      await sleep(wait);
      const why = this.interrupted(seq);
      if (why) return why;
      // The operator (or anything else) changed the program: leave it alone.
      if (!this.onAirOurs(seq, id)) return "taken";
      if (this.ctl.skip === id) {
        this.ctl.skip = null;
        return "skipped";
      }
      // Hold: paused where it is, and its time with it.
      if (this.ctl.held !== (heldAt !== null)) {
        if (this.ctl.held) {
          heldAt = this.e.now();
          await this.e.obs.mediaAction(input, "pause").catch((err) => this.e.logger.warn("automatic replays: OBS didn't pause the clip", { error: String(err) }));
        } else {
          const d = this.e.now() - heldAt!;
          heldAt = null;
          [endsAt, deadline] = [endsAt + d, deadline + d];
          stall.reset();
          await this.e.obs.mediaAction(input, "play").catch((err) => this.e.logger.warn("automatic replays: OBS didn't play the clip again", { error: String(err) }));
        }
      }
      onPoll?.(heldAt !== null ? null : endsAt - leadOut() - this.e.now());
      if (heldAt !== null) {
        wait = 50;
        continue;
      }
      const m = await this.e.obs.mediaStatus(input).catch(() => null);
      if (!m || m.state === "OBS_MEDIA_STATE_ENDED" || m.state === "OBS_MEDIA_STATE_STOPPED") return "ended";
      // OBS can report the cursor at 0 just before the end: such a reading says nothing about the end.
      const sane = m.cursorMs !== null && (cursor === null || m.cursorMs >= cursor - 200);
      const left = sane && m.durationMs !== null && m.durationMs > 0 ? wall(m.durationMs - m.cursorMs!) : null;
      if (left !== null) {
        if (!placed) {
          placed = true;
          deadline = Math.max(deadline, this.e.now() + Math.min(left, wall(playMs + KEYFRAME_SLACK_MS)) + 1500);
        }
        endsAt = this.e.now() + left;
      }
      const lead = leadOut();
      if (lead > 0 && endsAt - this.e.now() <= lead) return "ended";
      if (this.e.now() > deadline) return "late";
      cursor = m.cursorMs;
      // Stuck (OBS shows nothing new): played again, then loaded again; then on to the next clip. Still at its very end: it ended.
      const act = stall.check(m.cursorMs);
      if (m.cursorMs !== null && m.durationMs !== null && m.durationMs > 0 && m.cursorMs >= m.durationMs - 150 && stall.stillFor() > 300) return "ended";
      if (act === "give-up") {
        this.e.logger.warn("automatic replays: OBS stopped playing the clip", { id, cursorMs: cursor, tried: "play, then loading it again" });
        return "late";
      }
      if (act) await this.unstick(input, act, m.cursorMs ?? 0, reload, id);
      // Near its end (or the fade), look more often: the next clip comes in then.
      wait = Math.max(25, Math.min(100, endsAt - lead - this.e.now()));
    }
  }

  /**
   * vMix: each clip as a video input, set at the part to show. The first is transitioned to (the
   * chosen transition); each next one is added while the one before is on air, and vMix fades to it
   * one fade length before that one ends (or cuts to it as it ends). After the last, back to the
   * input that was on air before (the chosen transition back). If someone puts another input on air
   * meanwhile, it is left there. The replay inputs are removed afterwards. The live game audio
   * picked (vMix inputs) goes down meanwhile; the operator's controls work as in OBS.
   */
  private async playVmix(seq: Sequence): Promise<void> {
    const st = this.settings();
    const stage = seq.stage;
    const vmix = new VmixClient(st.vmixUrl);
    const fade = st.between === "fade";
    const added: string[] = [];
    let live: VmixInput | null = null;
    let onAir = false;
    let end: Stop = "ended";
    type Loaded = { c: Planned; n: number; key: string; duration: number };
    // The list's next clip as a vMix input at the part to show (not on air); a clip that doesn't load is skipped.
    const load = async (): Promise<Loaded | null> => {
      for (let c = this.take(seq); c; c = this.take(seq)) {
        const it = c.item;
        if (!this.mayPlay(it, seq)) continue;
        try {
          const path = it.clip!.media.path!;
          const name = path.split(/[\\/]/).pop()!;
          const known = new Set((await vmix.state()).inputs.map((x) => x.key));
          await vmix.call("AddInput", { Value: `Video|${path}` });
          // The new input (vMix names a video input after its file).
          let input: VmixInput | null = null;
          for (let k = 0; k < 30 && !input; k++) {
            const now = await vmix.state();
            input = now.inputs.find((x) => !known.has(x.key) && x.title.includes(name)) ?? now.inputs.find((x) => !known.has(x.key)) ?? null;
            if (!input) await sleep(100);
          }
          if (!input) throw new Error("vMix didn't add the replay clip as an input");
          added.push(input.key);
          const duration = input.duration || it.clip?.media.durationMs || c.playMs;
          if (duration > c.playMs + 300) await vmix.call("SetPosition", { Input: input.key, Value: Math.round(duration - c.playMs) });
          if (st.speedPercent !== 100) await vmix.call("SetRate", { Input: input.key, Value: st.speedPercent / 100 }).catch(() => undefined);
          await this.audio.applyVmixReplayVolume(vmix, input.key).catch((err) => this.e.logger.warn("automatic replays: vMix didn't take the replay volume", { error: String(err) }));
          return { c, n: seq.taken, key: input.key, duration };
        } catch (err) {
          this.clipFailed(it, err, seq);
        }
      }
      return null;
    };
    try {
      const before = await vmix.state();
      live = before.inputs.find((x) => x.number === before.active) ?? null;
      let next = await load();
      while (next) {
        const why = this.interrupted(seq);
        if (why) {
          end = why;
          break;
        }
        const { c, key, duration } = next;
        const it = c.item;
        const playMs = this.mayPlay(it, seq) ? this.fitNow(c, !onAir, seq) : null;
        if (playMs === null) {
          next = await load();
          continue;
        }
        this.onAirStatus(seq, next.n, it);
        try {
          this.approve(it, seq);
          // Shortened to fit the time left.
          if (playMs < c.playMs && duration > playMs + 300) await vmix.call("SetPosition", { Input: key, Value: Math.round(duration - playMs) });
          await vmix.call("Play", { Input: key });
          // To the first replay with the chosen transition (Replay in; highlights: Highlights in); from one clip to the next a fade (or a cut).
          if (!onAir) {
            this.audioDown(seq);
            await vmix.call(stage.vmixIn, { Input: key });
            seq.trace?.({ type: "in", scene: it.label, confirmed: true, transition: stage.vmixIn });
          } else {
            await vmix.call(fade ? "Fade" : "CutDirect", { Input: key, ...(fade ? { Duration: st.fadeMs } : {}) });
            seq.trace?.({ type: "between", scene: it.label, confirmed: true, transition: fade ? `Fade ${st.fadeMs} ms` : "CutDirect" });
          }
          onAir = true;
          this.nowOnAir(it, seq);
        } catch (err) {
          this.clipFailed(it, err, seq);
          next = await load();
          continue;
        }
        const startedAt = this.e.now();
        // The next clip loads while this one is on air.
        next = await load();
        end = await this.watchVmix(vmix, key, it.id, playMs, startedAt, () => (next && fade ? st.fadeMs : 0), seq, async () => {
          // The operator excluded the clip loaded next, or pinned another (one may join after the last): the right one loaded now.
          if (next ? !this.stale(seq, next.c) : !this.waitingPin(seq)) return;
          if (next) {
            this.putBack(seq, next.c);
            await vmix.call("RemoveInput", { Input: next.key }).catch(() => undefined);
          }
          next = await load();
        });
        this.clipPlayed(it, seq, "vmix", end);
        if (!goesOn(end)) break;
      }
    } catch (err) {
      seq.error = err instanceof Error ? err.message : String(err);
      this.e.logger.warn("automatic replays: vMix didn't answer", { error: seq.error });
    } finally {
      seq.stopped = end;
      const out = stage.vmixOut;
      if (onAir && end !== "taken" && live) {
        try {
          await vmix.call(out, { Input: live.key });
          seq.trace?.({ type: "out", confirmed: true, scene: live.title, transition: out, error: null });
        } catch (err) {
          this.e.logger.warn("automatic replays: vMix didn't go back", { error: String(err) });
          seq.trace?.({ type: "out", confirmed: false, scene: live.title, transition: out, error: err instanceof Error ? err.message : String(err) });
        }
      }
      await this.audioBack(seq);
      // The replay inputs go once the transition back is over.
      if (added.length) setTimeout(() => void removeInputs(vmix, added), 2000).unref?.();
    }
  }

  /**
   * Until the replay input on air ends (or is `leadOut()` from its end), runs past its time, the
   * operator skips it, or the break's replays must stop. Hold pauses it (vMix's Pause) until Resume.
   */
  private async watchVmix(vmix: VmixClient, key: string, id: string, playMs: number, startedAt: number, leadOut: () => number, seq: Sequence, onPoll?: () => Promise<void>): Promise<Stop> {
    const speed = this.settings().speedPercent;
    let endsAt = startedAt + (playMs * 100) / speed;
    let deadline = startedAt + replayWallMs(playMs, speed) + 1500;
    // The transition to it (a fade, a stinger) may still show the input before.
    const settle = Math.max(1200, this.settings().fadeMs + 700);
    let wait = 150;
    let heldAt: number | null = null;
    for (;;) {
      await sleep(wait);
      const why = this.interrupted(seq);
      if (why) return why;
      if (this.ctl.skip === id) {
        this.ctl.skip = null;
        return "skipped";
      }
      if (this.ctl.held !== (heldAt !== null)) {
        if (this.ctl.held) heldAt = this.e.now();
        else {
          const d = this.e.now() - heldAt!;
          heldAt = null;
          [endsAt, deadline] = [endsAt + d, deadline + d];
        }
        await vmix.call(this.ctl.held ? "Pause" : "Play", { Input: key }).catch((err) => this.e.logger.warn("automatic replays: vMix didn't pause or play the clip", { error: String(err) }));
      }
      if (onPoll) await onPoll();
      const now = await vmix.state().catch(() => null);
      const mine = now?.inputs.find((x) => x.key === key);
      // Someone put another input on air (after the transition had time to finish): leave it there.
      if (now && mine && now.active !== mine.number && this.e.now() - startedAt > settle) return "taken";
      if (heldAt !== null) {
        wait = 100;
        continue;
      }
      if (!mine || mine.state === "Completed" || (mine.duration > 0 && mine.position >= mine.duration - 60)) return "ended";
      const remain = Math.min(mine.duration > 0 ? ((mine.duration - 60 - mine.position) * 100) / speed : wait, endsAt - this.e.now());
      const left = mine.duration > 0 ? ((mine.duration - mine.position) * 100) / speed : endsAt - this.e.now();
      const lead = leadOut();
      if (lead > 0 && left <= lead) return "ended";
      if (this.e.now() > deadline) return "late";
      // Near its end, look more often: the next clip comes in then.
      wait = Math.max(25, Math.min(150, remain - lead));
    }
  }

  // ------------------------------------------------------------------ clutches

  private trackClutch(s: MatchState): void {
    const alive = s.players.filter((p) => p.lifeState === "alive" && p.side);
    const sides = { T: alive.filter((p) => p.side === "T"), CT: alive.filter((p) => p.side === "CT") };
    const side = sides.T.length === 1 && sides.CT.length >= 1 ? "T" : sides.CT.length === 1 && sides.T.length >= 1 ? "CT" : null;
    if (!side) {
      // The clutcher killed the last opponent: the clutch stands until the round result is in.
      const c = this.clutch;
      if (!(c && sides[c.side].length === 1 && sides[c.side][0]!.steamId === c.steamId)) this.clutch = null;
      return;
    }
    const p = sides[side][0]!;
    const versus = sides[side === "T" ? "CT" : "T"].length;
    const shown = s.observer.observedSteamId === p.steamId;
    if (this.clutch?.steamId === p.steamId) {
      this.clutch.versus = Math.max(this.clutch.versus, versus);
      this.clutch.shown ||= shown;
    } else this.clutch = { steamId: p.steamId, name: p.name, side, versus, startedAt: this.e.now(), round: s.roundNumber, shown };
  }

  /** Once the round result is in: a won 1v2+ that the main camera showed is replayed first. */
  private settleClutch(s: MatchState): void {
    const c = this.endedClutch!;
    const result = s.roundHistory[s.roundHistory.length - 1];
    const fresh = result && c.round !== null && result.roundNumber >= c.round - 1;
    if (!fresh) {
      if (this.e.now() - c.endedAt > 4000) this.endedClutch = null;
      return;
    }
    this.endedClutch = null;
    const st = this.settings();
    if (!st.enabled || !st.ownBigPlays || result.winnerSide !== c.side || c.versus < 2 || !c.shown) return;
    const playMs = Math.min(20000, Math.round(c.endedAt - c.startedAt + 1500));
    for (const old of this.e.replays.list()) if (old.play?.kind === "big_play" && old.play.killer?.steamId === c.steamId && old.roundNumber === c.round && (old.state === "prepared" || old.state === "capturing")) this.e.replays.reject(old.id);
    const play: ReplayPlay = { kind: "big_play", killer: { steamId: c.steamId, name: c.name }, victims: [], kills: c.versus, weapon: null, headshot: false };
    const item = this.e.replays.bookmark(`Clutch 1v${c.versus}: ${c.name}`, "clutch", c.round, { priority: CLUTCH_PRIORITY, playMs, play });
    void this.e.replays.capture(item.id, { preRollMs: playMs, postRollMs: 0, sourceIds: null, matchTimeMs: s.time.matchTimeMs ?? null, timeUncertaintyMs: s.time.timeUncertaintyMs ?? null, epoch: s.epoch, roundNumber: c.round });
  }

  // ------------------------------------------------------------------ this computer's big plays

  private onKill(k: HudKillfeedEntry): void {
    const st = this.settings();
    if (k.killer && k.killer.steamId !== k.victim.steamId) {
      // The round being played, or the one just won for a kill after the win (the game's round number has moved on).
      const round = this.e.playRound();
      if (round !== null) {
        const list = this.roundKills.get(round) ?? [];
        list.push({ killer: k.killer.steamId, killerSide: k.killer.side, victim: k.victim.steamId, victimName: k.victim.name, at: this.e.now() });
        this.roundKills.set(round, list);
        for (const r of this.roundKills.keys()) if (r < round - KEEP_ROUNDS || r > round + KEEP_ROUNDS) this.roundKills.delete(r);
      }
    }
    if (!st.enabled || !st.ownBigPlays || !k.killer) return;
    const s = this.e.session.state();
    // The main camera must have the killer on air.
    if (s?.observer.observedSteamId !== k.killer.steamId) return;
    const now = this.e.now();
    const round = this.e.playRound();
    const prev = this.ownKills.get(k.killer.steamId);
    const cur = prev && prev.round === round ? prev : { round, kills: 0, firstAt: now, lastAt: now, victims: [] as string[], weapon: k.weapon, headshot: false, name: k.killer.name, timer: null };
    cur.kills++;
    cur.lastAt = now;
    cur.victims.push(k.victim.name);
    cur.headshot ||= k.headshot === true;
    this.ownKills.set(k.killer.steamId, cur);
    if (cur.kills < 3) return;
    if (cur.timer) clearTimeout(cur.timer);
    const killer = k.killer.steamId;
    cur.timer = setTimeout(() => void this.captureOwn(killer), 2000);
  }

  private async captureOwn(killer: string): Promise<void> {
    const c = this.ownKills.get(killer);
    if (!c) return;
    c.timer = null;
    const play: ReplayPlay = { kind: "big_play", killer: { steamId: killer, name: c.name }, victims: c.victims, kills: c.kills, weapon: c.weapon, headshot: c.headshot };
    const playMs = Math.min(20000, Math.round(4000 + (c.lastAt - c.firstAt) + 2000));
    // A later kill makes a longer clip: replace an unplayed one from this round.
    for (const old of this.e.replays.list()) if (old.play?.kind === "big_play" && old.play.killer?.steamId === killer && old.roundNumber === c.round && (old.state === "prepared" || old.state === "capturing")) this.e.replays.reject(old.id);
    const item = this.e.replays.bookmark(replayLabel(play), "big_play", c.round, { priority: PRIORITY.big_play, playMs, leadMs: 4000, play });
    const st = this.e.session.state();
    await this.e.replays.capture(item.id, { preRollMs: playMs - 2000, postRollMs: 0, sourceIds: null, matchTimeMs: st?.time.matchTimeMs ?? null, timeUncertaintyMs: st?.time.timeUncertaintyMs ?? null, epoch: st?.epoch ?? null, roundNumber: c.round });
  }
}

/**
 * A clip on air that stopped moving (its cursor the same): STALL_RETRY_MS still, play is sent again;
 * still again, its file is loaded again where it was; still STALL_MS after that, it is given up.
 */
class StallWatch {
  private cursor: number | null | undefined = undefined;
  private movedAt: number;
  private tries = 0;

  constructor(private readonly now: () => number) {
    this.movedAt = now();
  }

  /** It moves again (Resume, a skip): its time still counts from now. */
  reset(): void {
    this.movedAt = this.now();
  }

  /** How long the cursor has been where it is. */
  stillFor(): number {
    return this.now() - this.movedAt;
  }

  /** A reading of the cursor: what to do now, if anything. */
  check(cursor: number | null): "play" | "reload" | "give-up" | null {
    if (cursor !== this.cursor) {
      this.cursor = cursor;
      this.movedAt = this.now();
      return null;
    }
    const still = this.now() - this.movedAt;
    if (this.tries < 2) {
      if (still <= STALL_RETRY_MS) return null;
      this.tries++;
      this.movedAt = this.now();
      return this.tries === 1 ? "play" : "reload";
    }
    return still > STALL_MS ? "give-up" : null;
  }
}

export const playPriority = (kind: ReplayPlay["kind"]): number => PRIORITY[kind];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Removes a file if it can (on Windows one still open in OBS can't be, until it is let go). */
function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Still in use: removed with the next run's.
  }
}

/** A round clock time as CS2 shows it (110 → 1:50). */
export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/** Where a clip's part to show starts (ms into the file): its end part, when the file is longer. */
const partStart = (durationMs: number | null, playMs: number): number => (durationMs && durationMs > playMs + 300 ? durationMs - playMs : 0);

/** Removes a break's replay inputs from vMix, but not one that is on air. */
async function removeInputs(vmix: VmixClient, keys: readonly string[]): Promise<void> {
  const now = await vmix.state().catch(() => null);
  const active = now?.inputs.find((x) => x.number === now.active)?.key ?? null;
  for (const k of keys) if (k !== active) await vmix.call("RemoveInput", { Input: k }).catch(() => undefined);
}
