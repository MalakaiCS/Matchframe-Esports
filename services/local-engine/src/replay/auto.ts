import { z } from "zod";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import type { TransitionPick } from "../live/obs-auto.ts";
import { replayLabel } from "./link.ts";
import type { RankFacts } from "./rank.ts";
import { clipScore, CUT_MS, fitReplay, planBreak, replayWallMs, SWITCH_MS } from "./rank.ts";
import type { VmixInput } from "./vmix.ts";
import { VMIX_TRANSITIONS, VmixClient } from "./vmix.ts";
import type { TwinStatus } from "./twin.ts";

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
  /** How long that fade is. */
  fadeMs: z.number().int().min(100).max(2000).default(500),
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
  fadeMs: AutoReplaySettings.shape.fadeMs.unwrap().optional(),
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
}

/** A clip chosen for the break, and how much of it to show. */
interface Planned {
  item: QueueItem;
  playMs: number;
  leadMs: number | null;
}

/** A break's replays once chosen: the clips in play order, and how it went. */
interface Sequence {
  round: number | null;
  ids: string[];
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
}

/**
 * Why a clip stopped: it ended (or its fade to the next is due), it ran past its time (still
 * playing), the break's time is up (the round clock, or the next round starting), automatic replays
 * were turned off, or someone else changed the program.
 */
type Stop = "ended" | "late" | "deadline" | "off" | "taken";

/** One of the two scenes a break's replays alternate between (the replay scene and its twin), with its media source. */
interface Slot {
  scene: string;
  input: string;
}

/** A clip loaded in a scene off air, at its part, waiting to go on air. */
interface Cued {
  c: Planned;
  /** Its place in the break's list (1-based). */
  n: number;
  slot: number;
  playMs: number;
  /** Where OBS has it (null: the source doesn't play hidden; it goes to its part once shown). */
  cursorMs: number | null;
  /** The file's length as OBS said (null: not known). */
  durationMs: number | null;
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

export class AutoReplay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private status: AutoReplayStatus = { enabled: false, state: "off", detail: "Automatic replays are off.", waiting: 0, playing: null, lastPlayed: null, round: null, ranked: [], vmix: null, twin: null, roundSec: ASSUMED_ROUND_SEC };
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

  constructor(private readonly e: Engine) {}

  settings(): AutoReplaySettings {
    const r = AutoReplaySettings.safeParse(this.e.settings.get("replay.auto", {}));
    return r.success ? r.data : AutoReplaySettings.parse({});
  }

  setSettings(patch: Partial<AutoReplaySettings>): AutoReplaySettings {
    const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = AutoReplaySettings.parse({ ...this.settings(), ...given });
    this.e.settings.set("replay.auto", next);
    if (!next.enabled) this.abort = true;
    return next;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), 200);
    this.timer.unref?.();
    this.cleanup.push(this.e.onKill((k) => this.onKill(k)));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    for (const fn of this.cleanup.splice(0)) fn();
    for (const k of this.ownKills.values()) if (k.timer) clearTimeout(k.timer);
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
    };
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
      .filter((i) => (i.state === "prepared" || i.state === "approved") && i.clip?.media.path && i.play && (i.play.kind !== "other_angle" || st.otherAngles) && round !== null && i.roundNumber === round && this.never(i) === null);
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
      const note = stale ?? late;
      const state = played ? "played" : picked ? "picked" : duplicate ? "duplicate" : note || (seq && (!seq.running || !seq.ids.includes(item.id))) ? "left" : "waiting";
      return { id: item.id, label: item.label, score, reasons, state, note: state === "left" ? note : null };
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

  private setStatus(state: AutoReplayStatus["state"], detail: string, playing: AutoReplayStatus["playing"] = null): void {
    this.status = { ...this.status, state, detail, playing };
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
          // The break's replays (if any) are over: no clip of an earlier round plays any more.
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
    if (!st.enabled) return this.setStatus("off", "Automatic replays are off.");
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
    if (sinceBreak < st.startDelayMs) return this.setStatus("waiting", "The round just ended: replays start in a moment.");
    if (this.sequence) {
      const q = this.sequence;
      const how = [q.played ? `${q.played} played` : "", q.failed ? `${q.failed} didn't play` : "", q.stopped === "deadline" ? (st.cutBack === "clock" ? `back to live by ${clock(st.cutBackClockSec)} on the round clock` : "back to live before the round started") : ""].filter(Boolean).join(", ");
      const summary = [how, q.error].filter(Boolean).join(": ");
      return this.setStatus(q.error && !q.played ? "blocked" : "waiting", `Replays for this break are done${summary ? ` (${summary})` : ""}.`);
    }
    const left = this.cutBackAt(s, null) - this.e.now();
    // The replay PC plays the round some seconds later: wait a little for its last kills before the break's replays.
    if (this.e.onAir.peerPending(this.breakRound) && sinceBreak < st.startDelayMs + REPLAY_PC_WAIT_MS && left > KEEP_FOR_REPLAYS_MS) {
      return this.setStatus("waiting", "Waiting for the replay PC's last kills of the round…");
    }
    const open = new Set(this.candidates(this.breakRound).map((c) => c.id));
    const pool = this.ranked(this.breakRound).filter((r) => !r.duplicate && open.has(r.item.id) && !this.playedIds.has(r.item.id));
    const plan = planBreak(
      pool.map((r) => ({ id: r.item.id, score: r.score, playMs: this.playMsOf(r.item), leadMs: r.item.leadMs ?? null, at: this.roundTimeOf(r.item) })),
      left,
      st.speedPercent,
      st.perBreak,
      st.order,
    );
    if (!plan.length) return this.setStatus("waiting", pool.length ? "The round's replays don't fit in the time left." : "No replays for this round.");
    const list: Planned[] = plan.map((p) => ({ item: pool.find((r) => r.item.id === p.id)!.item, playMs: p.playMs, leadMs: p.leadMs }));
    const seq: Sequence = { round: this.breakRound, ids: list.map((c) => c.item.id), chosenAt: Date.now(), running: true, played: 0, failed: 0, error: null, wentLive: null, stopped: null, obsChanges: this.e.obsAuto.changesInObs };
    this.sequence = seq;
    this.busy = true;
    this.abort = false;
    try {
      if (st.mixer === "vmix") await this.playVmix(list, seq);
      else await this.playObs(list, seq);
    } finally {
      seq.running = false;
      this.busy = false;
      // Its break is over: no clip of this round (or an earlier one) plays automatically any more.
      if (seq.round !== null) this.closedThrough = Math.max(this.closedThrough ?? seq.round, seq.round);
    }
  }

  /** How much of a clip to show (the whole clip when it says nothing). */
  private playMsOf(it: QueueItem): number {
    return it.playMs ?? it.clip?.media.durationMs ?? 8000;
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
    if (this.e.program.mode !== "LIVE" && !(this.sequence?.running && this.onAirOurs())) return `The program isn't live (${this.e.program.mode.replace(/_/g, " ").toLowerCase()}): press Return live at the top of Replays & Production, or put OBS on your live scene.`;
    return null;
  }

  /**
   * The program shows this automation's replay (that clip's, when given): no one else changed it,
   * in the program's state or in OBS (OBS on one of the two replay scenes, and no program change
   * made in OBS itself, such as the Transition button in Studio Mode, even to a replay scene).
   */
  private onAirOurs(id?: string): boolean {
    const p = this.e.program;
    if (!(p.mode === "REPLAY_PLAYING" && p.owner.holder === HOLDER && (id === undefined || p.activeReplay === id))) return false;
    if (this.settings().mixer !== "obs" || !this.e.obs.state.connected) return true;
    if (this.sequence?.running && this.e.obsAuto.changesInObs !== this.sequence.obsChanges) return false;
    const shown = this.e.obs.state.programScene;
    return shown === null || p.replayScenes.includes(shown);
  }

  /** Why the break's replays must stop now, or null. */
  private interrupted(seq: Sequence): Stop | null {
    if (this.abort || !this.settings().enabled) return "off";
    const s = this.e.session.state();
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
    if (!s) return c.playMs;
    // The first clip has the cut to the replay and back to make; a later one the switch and the cut back.
    return fitReplay(c, this.cutBackAt(s, seq.wentLive) - startsAt, this.settings().speedPercent, first ? CUT_MS : SWITCH_MS + CUT_MS / 2);
  }

  private clipPlayed(it: QueueItem, seq: Sequence, mixer: "obs" | "vmix"): void {
    this.e.replays.markPlayed(it.id);
    seq.played++;
    this.status = { ...this.status, lastPlayed: { id: it.id, label: it.label, at: new Date().toISOString() } };
    this.e.audit.record(HOLDER, "replay.auto_played", it.id, { label: it.label, origin: it.origin, ...(mixer === "vmix" ? { mixer } : {}) });
  }

  /** A clip that didn't play: failed (or rejected, if it never started), and the break goes on without it. */
  private clipFailed(it: QueueItem, err: unknown, seq: Sequence): void {
    const error = err instanceof Error ? err.message : String(err);
    this.e.replays.markPlaybackFailed(it.id, error);
    if (it.state === "approved") this.e.replays.reject(it.id);
    seq.failed++;
    seq.error = error;
    this.e.logger.warn("automatic replay failed", { id: it.id, error, mixer: this.settings().mixer });
  }

  /**
   * OBS: the break's clips with one transition into the replays and one back to live (the program
   * state machine's port picks them: Replay in, Replay out). With the replay scene's twin (replay/twin.ts)
   * they alternate between the two scenes and fade (or cut) from one to the next; without one they
   * play in the replay scene's one source, as before 0.10.5.
   */
  private async playObs(list: Planned[], seq: Sequence): Promise<void> {
    const main: Slot = { scene: this.e.program.sceneMap.REPLAY!, input: this.e.settings.get<string>("replay.mediaInput", "") };
    const twin = await this.e.replayTwin.sync().catch(() => null);
    let end: Stop = "ended";
    try {
      end = twin ? await this.playObsTwin(list, seq, [main, twin]) : await this.playObsOneSource(list, seq, main.input);
    } finally {
      seq.stopped = end;
      // Back to live once, unless someone else has the program.
      const p = this.e.program;
      if (end !== "taken" && p.owner.holder === HOLDER && (p.mode === "REPLAY_PLAYING" || p.mode === "REPLAY_PREPARED")) {
        await p.request("LIVE", "automation", HOLDER).catch((err) => this.e.logger.warn("automatic replays: could not return to live", { error: String(err) }));
      }
    }
  }

  /**
   * The clips alternate between the replay scene and its twin. The first is loaded off air, held
   * (paused) at its part, and the program goes to the replay scene as it plays. While a clip is on
   * air the next one waits the same way in the other scene; one fade length before the clip on air
   * ends (or as it ends, with a cut), the next plays and the program fades over to its scene, so the
   * end of one blends into the start of the next. A clip that fails is skipped.
   */
  private async playObsTwin(list: Planned[], seq: Sequence, slots: [Slot, Slot]): Promise<Stop> {
    const st = this.settings();
    const fade = st.between === "fade";
    const pick: TransitionPick = fade ? { kind: "fade_transition", durationMs: st.fadeMs } : { kind: "cut_transition" };
    const wall = (ms: number) => (ms * 100) / st.speedPercent;
    let k = 0;
    let shown = false;
    // The list's next clip that may still play, loaded into a scene off air and held at its part; null when none is left.
    const cue = async (slot: number, startsAt: number): Promise<Cued | null> => {
      while (k < list.length) {
        const c = list[k++]!;
        const it = c.item;
        if (it.state !== "prepared" && it.state !== "approved") continue;
        const playMs = this.fitNow(c, !shown, seq, startsAt);
        if (playMs === null) continue;
        try {
          return { c, n: k, slot, playMs, ...(await this.cueHeld(slots[slot]!.input, it, playMs)) };
        } catch (err) {
          this.clipFailed(it, err, seq);
        }
      }
      return null;
    };
    let next = await cue(0, this.e.now());
    while (next) {
      const why = this.interrupted(seq) ?? (shown && !this.onAirOurs() ? "taken" : null);
      if (why) return why;
      const { c, slot } = next;
      const it = c.item;
      const scene = slots[slot]!;
      // Played or rejected by hand meanwhile, or it no longer fits: the next one, in the same scene.
      const playMs = it.state === "prepared" || it.state === "approved" ? this.fitNow(c, !shown, seq) : null;
      if (playMs === null) {
        next = await cue(slot, this.e.now());
        continue;
      }
      this.setStatus("playing", `Replay ${next.n} of ${list.length}: ${it.label}`, { id: it.id, label: it.label });
      let cued = next.cursorMs;
      let over: Promise<boolean> | null = null;
      try {
        if (it.state === "prepared") this.e.replays.approve(it.id);
        // Shortened again since it was loaded: further into the clip.
        const later = partStart(next.durationMs ?? it.clip!.media.durationMs, playMs);
        if (playMs < next.playMs - 300 && cued !== null && later > 0) cued = await this.obsSeek(scene.input, later, true);
        if (!shown) {
          // Into the replays (Replay in): the clip plays once the transition shows it (a Stinger's cut point).
          await this.e.program.request("REPLAY_PREPARED", "automation", HOLDER, { replayItemId: it.id });
          await this.e.program.request("REPLAY_PLAYING", "automation", HOLDER, { replayItemId: it.id });
          shown = true;
          const point = this.e.obsAuto.cutPointMs(scene.scene);
          if (point > 0) await sleep(point);
          await this.e.obs.mediaAction(scene.input, "play");
        } else {
          // From one to the next: it plays as the program fades (or cuts) over to its scene.
          await this.e.obs.mediaAction(scene.input, "play");
          await this.e.program.request("REPLAY_PLAYING", "automation", HOLDER, { replayItemId: it.id });
          over = this.e.obs.waitTransitionEnd(fade ? st.fadeMs + 400 : 400);
          await this.e.obsAuto.switchProgram(scene.scene, pick);
        }
        this.e.replays.markPlaying(it.id);
        this.playedIds.add(it.id);
        await this.toPartOnAir(scene.input, it, playMs, cued);
      } catch (err) {
        this.clipFailed(it, err, seq);
        // On to the next clip, in the scene that isn't on air.
        const onAir = this.e.obs.state.programScene === scene.scene;
        next = await cue(onAir ? 1 - slot : slot, this.e.now());
        continue;
      }
      // The scene faded out of is off air once the fade is over: the next clip waits there.
      if (over) await over;
      next = await cue(1 - slot, this.e.now() + wall(playMs) - (fade ? st.fadeMs : 0));
      const end = await this.watchObs(scene.input, it.id, playMs, next && fade ? st.fadeMs : 0, seq);
      this.clipPlayed(it, seq, "obs");
      if (end !== "ended" && end !== "late") return end;
    }
    return "ended";
  }

  /**
   * Without the twin: the first clip is loaded off air and skipped to its end part (the play and its
   * lead-up), then the program goes to the replay scene. Each next clip is loaded into the same
   * source as soon as the one before ends and skipped to its part, without going live in between.
   */
  private async playObsOneSource(list: Planned[], seq: Sequence, input: string): Promise<Stop> {
    const st = this.settings();
    let shown = false;
    let end: Stop = "ended";
    for (const [i, c] of list.entries()) {
      const it = c.item;
      const why = this.interrupted(seq) ?? (shown && !this.onAirOurs() ? "taken" : null);
      if (why) return why;
      // Played or rejected by hand meanwhile, or no longer fits in the time left.
      if (it.state !== "prepared" && it.state !== "approved") continue;
      const playMs = this.fitNow(c, !shown, seq);
      if (playMs === null) continue;
      this.setStatus("playing", `Replay ${i + 1} of ${list.length}: ${it.label}`, { id: it.id, label: it.label });
      try {
        if (it.state === "prepared") this.e.replays.approve(it.id);
        if (!shown) {
          // Off air: the clip is loaded (an earlier one still playing there is held first) and, if OBS
          // plays it hidden, skipped to its part, so the cut opens on it.
          if ((await this.e.obs.mediaStatus(input).catch(() => null))?.state === "OBS_MEDIA_STATE_PLAYING") await this.e.obs.mediaAction(input, "pause").catch(() => undefined);
          await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: st.speedPercent });
          const hidden = await this.obsPlaying(input, false);
          const startHidden = partStart(hidden?.durationMs ?? it.clip!.media.durationMs, playMs);
          const cued = hidden ? (startHidden ? await this.obsSeek(input, startHidden) : hidden.cursorMs) : null;
          await this.e.program.request("REPLAY_PREPARED", "automation", HOLDER, { replayItemId: it.id });
          await this.e.program.request("REPLAY_PLAYING", "automation", HOLDER, { replayItemId: it.id });
          shown = true;
          this.e.replays.markPlaying(it.id);
          this.playedIds.add(it.id);
          await this.toPartOnAir(input, it, playMs, cued);
        } else {
          // On air: the next clip goes into the same source; until it plays, the last frame of the one before stays.
          if (end === "late") await this.e.obs.mediaAction(input, "pause").catch(() => undefined);
          await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: st.speedPercent });
          await this.e.program.request("REPLAY_PLAYING", "automation", HOLDER, { replayItemId: it.id });
          this.e.replays.markPlaying(it.id);
          this.playedIds.add(it.id);
          const media = (await this.obsPlaying(input, true))!;
          const start = partStart(media.durationMs ?? it.clip!.media.durationMs, playMs);
          if (start) await this.obsSeek(input, start);
        }
        end = await this.watchObs(input, it.id, playMs, 0, seq);
        this.clipPlayed(it, seq, "obs");
      } catch (err) {
        this.clipFailed(it, err, seq);
        end = "late";
      }
      if (end !== "ended" && end !== "late") return end;
    }
    return "ended";
  }

  /**
   * Off air: loads a clip and, once OBS plays it, holds it (paused) at its part. Returns where it is
   * (null when the source doesn't play while hidden: it goes to its part once shown) and its length.
   */
  private async cueHeld(input: string, it: QueueItem, playMs: number): Promise<{ cursorMs: number | null; durationMs: number | null }> {
    await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: this.settings().speedPercent });
    const hidden = await this.obsPlaying(input, false);
    if (!hidden) return { cursorMs: null, durationMs: null };
    await this.e.obs.mediaAction(input, "pause");
    const start = partStart(hidden.durationMs ?? it.clip!.media.durationMs, playMs);
    const cursorMs = start ? await this.obsSeek(input, start, true) : ((await this.e.obs.mediaStatus(input).catch(() => null))?.cursorMs ?? 0);
    return { cursorMs, durationMs: hidden.durationMs };
  }

  /** On air: a source that plays only when shown, or starts over when shown (OBS's default for a new one), is skipped to the part now. */
  private async toPartOnAir(input: string, it: QueueItem, playMs: number, cued: number | null): Promise<void> {
    const media = (await this.obsPlaying(input, true))!;
    const start = partStart(media.durationMs ?? it.clip!.media.durationMs, playMs);
    if (start && (cued === null || (media.cursorMs ?? 0) < cued - 300)) await this.obsSeek(input, start);
  }

  /**
   * Waits for OBS to play the clip just loaded (looking often: on air, the last frame of the clip
   * before stays until then). Off air (`startIt` false) it gives up after a moment: a source that
   * plays only when shown. On air, one that doesn't start a new file by itself is started.
   */
  private async obsPlaying(input: string, startIt: boolean): Promise<{ durationMs: number | null; cursorMs: number | null } | null> {
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
        await this.e.obs.mediaAction(input, "restart").catch(() => undefined);
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
        const near = at >= start - KEYFRAME_SLACK_MS && at <= start + 300;
        if (near && (jumped || i >= 3)) return at;
      }
    }
    return at;
  }

  /**
   * Until the clip on air ends (or is `leadOutMs` from its end: the fade to the next is due), runs
   * past its time, or the break's replays must stop.
   */
  private async watchObs(input: string, id: string, playMs: number, leadOutMs: number, seq: Sequence): Promise<Stop> {
    const speed = this.settings().speedPercent;
    const wall = (ms: number) => (ms * 100) / speed;
    // Until OBS says where the clip is: it starts at the keyframe before the part, so it may run longer (up to KEYFRAME_SLACK_MS).
    let endsAt = this.e.now() + wall(playMs);
    let deadline = this.e.now() + replayWallMs(playMs, speed) + 1500;
    let placed = false;
    let cursor: number | null = null;
    let movedAt = this.e.now();
    let wait = 100;
    for (;;) {
      await sleep(wait);
      const why = this.interrupted(seq);
      if (why) return why;
      // The operator (or anything else) changed the program: leave it alone.
      if (!this.onAirOurs(id)) return "taken";
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
      if (leadOutMs > 0 && endsAt - this.e.now() <= leadOutMs) return "ended";
      if (this.e.now() > deadline) return "late";
      // Stuck (OBS shows nothing new): on to the next clip.
      if (m.cursorMs !== cursor) [cursor, movedAt] = [m.cursorMs, this.e.now()];
      else if (this.e.now() - movedAt > 1500) {
        this.e.logger.warn("automatic replays: OBS stopped playing the clip", { id, cursorMs: cursor });
        return "late";
      }
      // Near its end (or the fade), look more often: the next clip comes in then.
      wait = Math.max(25, Math.min(100, endsAt - leadOutMs - this.e.now()));
    }
  }

  /**
   * vMix: each clip as a video input, set at the part to show. The first is transitioned to (the
   * chosen transition); each next one is added while the one before is on air, and vMix fades to it
   * one fade length before that one ends (or cuts to it as it ends). After the last, back to the
   * input that was on air before (the chosen transition back). If someone puts another input on air
   * meanwhile, it is left there. The replay inputs are removed afterwards.
   */
  private async playVmix(list: Planned[], seq: Sequence): Promise<void> {
    const st = this.settings();
    const vmix = new VmixClient(st.vmixUrl);
    const fade = st.between === "fade";
    const added: string[] = [];
    let live: VmixInput | null = null;
    let onAir = false;
    let end: Stop = "ended";
    let i = 0;
    // The list's next clip as a vMix input at the part to show (not on air); a clip that doesn't load is skipped.
    const load = async (): Promise<{ c: Planned; n: number; key: string; duration: number } | null> => {
      while (i < list.length) {
        const c = list[i++]!;
        const it = c.item;
        if (it.state !== "prepared" && it.state !== "approved") continue;
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
          return { c, n: i, key: input.key, duration };
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
        const playMs = it.state === "prepared" || it.state === "approved" ? this.fitNow(c, !onAir, seq) : null;
        if (playMs === null) {
          next = await load();
          continue;
        }
        this.setStatus("playing", `Replay ${next.n} of ${list.length}: ${it.label}`, { id: it.id, label: it.label });
        try {
          if (it.state === "prepared") this.e.replays.approve(it.id);
          // Shortened to fit the time left.
          if (playMs < c.playMs && duration > playMs + 300) await vmix.call("SetPosition", { Input: key, Value: Math.round(duration - playMs) });
          await vmix.call("Play", { Input: key });
          // To the first replay with the chosen transition; from one replay to the next a fade (or a cut).
          if (!onAir) await vmix.call(st.vmixTransition, { Input: key });
          else if (fade) await vmix.call("Fade", { Input: key, Duration: st.fadeMs });
          else await vmix.call("CutDirect", { Input: key });
          onAir = true;
          this.e.replays.markPlaying(it.id);
          this.playedIds.add(it.id);
        } catch (err) {
          this.clipFailed(it, err, seq);
          next = await load();
          continue;
        }
        const startedAt = this.e.now();
        // The next clip loads while this one is on air.
        next = await load();
        end = await this.watchVmix(vmix, key, playMs, startedAt, next && fade ? st.fadeMs : 0, seq);
        this.clipPlayed(it, seq, "vmix");
        if (end !== "ended" && end !== "late") break;
      }
    } catch (err) {
      seq.error = err instanceof Error ? err.message : String(err);
      this.e.logger.warn("automatic replays: vMix didn't answer", { error: seq.error });
    } finally {
      seq.stopped = end;
      if (onAir && end !== "taken" && live) await vmix.call(st.vmixTransitionOut ?? st.vmixTransition, { Input: live.key }).catch((err) => this.e.logger.warn("automatic replays: vMix didn't go back", { error: String(err) }));
      // The replay inputs go once the transition back is over.
      if (added.length) setTimeout(() => void removeInputs(vmix, added), 2000).unref?.();
    }
  }

  /** Until the replay input on air ends (or is `leadOutMs` from its end), runs past its time, or the break's replays must stop. */
  private async watchVmix(vmix: VmixClient, key: string, playMs: number, startedAt: number, leadOutMs: number, seq: Sequence): Promise<Stop> {
    const speed = this.settings().speedPercent;
    const endsAt = startedAt + (playMs * 100) / speed;
    const deadline = startedAt + replayWallMs(playMs, speed) + 1500;
    // The transition to it (a fade, a stinger) may still show the input before.
    const settle = Math.max(1200, this.settings().fadeMs + 700);
    let wait = 150;
    for (;;) {
      await sleep(wait);
      const why = this.interrupted(seq);
      if (why) return why;
      const now = await vmix.state().catch(() => null);
      const mine = now?.inputs.find((x) => x.key === key);
      // Someone put another input on air (after the transition had time to finish): leave it there.
      if (now && mine && now.active !== mine.number && this.e.now() - startedAt > settle) return "taken";
      if (!mine || mine.state === "Completed" || (mine.duration > 0 && mine.position >= mine.duration - 60)) return "ended";
      const remain = Math.min(mine.duration > 0 ? ((mine.duration - 60 - mine.position) * 100) / speed : wait, endsAt - this.e.now());
      const left = mine.duration > 0 ? ((mine.duration - mine.position) * 100) / speed : endsAt - this.e.now();
      if (leadOutMs > 0 && left <= leadOutMs) return "ended";
      if (this.e.now() > deadline) return "late";
      // Near its end, look more often: the next clip comes in then.
      wait = Math.max(25, Math.min(150, remain - leadOutMs));
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

export const playPriority = (kind: ReplayPlay["kind"]): number => PRIORITY[kind];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
