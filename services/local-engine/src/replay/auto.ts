import { z } from "zod";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { replayLabel } from "./link.ts";

/**
 * Automatic replays on the main PC. Clips come from the replay PC (kills the main camera missed)
 * and, optionally, from this computer's own OBS replay buffer (3K+ the main camera showed). They
 * play in the break after the round they belong to: from a few seconds after the round ends until
 * shortly before freeze time ends. Never while a round is live, and never over an operator's own
 * program choice.
 */

export const AutoReplaySettings = z.object({
  enabled: z.boolean().default(false),
  /** Clips per break (best first). */
  maxPerBreak: z.number().int().min(1).max(4).default(2),
  /** Playback speed of a replay in percent (100 = real time). */
  speedPercent: z.number().int().min(25).max(100).default(100),
  /** Wait this long after the round ends, so the round win stays on air. */
  startDelayMs: z.number().int().min(0).max(8000).default(3500),
  /** Also play the replay PC's angle of a kill the main camera showed from the victim. */
  otherAngles: z.boolean().default(true),
  /** Save this computer's replay buffer when the main camera shows a 3K or more. */
  ownBigPlays: z.boolean().default(true),
});
export type AutoReplaySettings = z.infer<typeof AutoReplaySettings>;
/** A change to some settings (each key optional, no defaults filled in). */
export const AutoReplayPatch = z.object({
  enabled: z.boolean().optional(),
  maxPerBreak: AutoReplaySettings.shape.maxPerBreak.unwrap().optional(),
  speedPercent: AutoReplaySettings.shape.speedPercent.unwrap().optional(),
  startDelayMs: AutoReplaySettings.shape.startDelayMs.unwrap().optional(),
  otherAngles: z.boolean().optional(),
  ownBigPlays: z.boolean().optional(),
});

export interface AutoReplayStatus {
  enabled: boolean;
  state: "off" | "waiting" | "playing" | "blocked";
  detail: string;
  waiting: number;
  playing: { id: string; label: string } | null;
  lastPlayed: { id: string; label: string; at: string } | null;
}

const PRIORITY: Record<ReplayPlay["kind"], number> = { big_play: 3, missed: 2, other_angle: 1 };
/** A won clutch (1v2 or more) plays before anything else. */
const CLUTCH_PRIORITY = 4;
/** Return to live this long before freeze time ends. */
const END_MARGIN_MS = 1500;
/** Freeze time assumed until the game reports it (CS2's competitive default is 20 s, many servers use 15). */
const ASSUMED_FREEZE_MS = 15000;

export class AutoReplay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private status: AutoReplayStatus = { enabled: false, state: "off", detail: "Automatic replays are off.", waiting: 0, playing: null, lastPlayed: null };
  private phase: string | null = null;
  /** The round that was live last, and when the break after it started (monotonic ms). */
  private liveRound: number | null = null;
  private breakRound: number | null = null;
  private breakStartedAt: number | null = null;
  private playedThisBreak = 0;
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
    return { ...this.status, enabled: this.settings().enabled, waiting: this.candidates(this.breakRound ?? this.liveRound).length };
  }

  /** Clips for a round that can play automatically, best first. */
  private candidates(round: number | null): QueueItem[] {
    const st = this.settings();
    return this.e.replays
      .list()
      .filter((i) => (i.state === "prepared" || i.state === "approved") && i.clip?.media.path && i.play && (i.play.kind !== "other_angle" || st.otherAngles) && (round === null || i.roundNumber === null || i.roundNumber === round))
      .sort((a, b) => b.priority - a.priority || a.order - b.order);
  }

  /** When the break must end (monotonic ms): shortly before freeze time ends. */
  private breakDeadline(s: MatchState): number {
    const reported = s.phaseEndsInSec !== null && s.phaseObservedAtMonotonicMs !== null ? s.phaseObservedAtMonotonicMs + s.phaseEndsInSec * 1000 : null;
    if (s.gamePhase === "freezetime" || s.gamePhase === "timeout_t" || s.gamePhase === "timeout_ct") return (reported ?? this.e.now()) - END_MARGIN_MS;
    // Round over: its own countdown, then at least the assumed freeze time.
    return (reported ?? this.e.now() + 5000) + ASSUMED_FREEZE_MS - END_MARGIN_MS;
  }

  private setStatus(state: AutoReplayStatus["state"], detail: string, playing: AutoReplayStatus["playing"] = null): void {
    this.status = { ...this.status, state, detail, playing };
  }

  private async tick(): Promise<void> {
    const s = this.e.session.state();
    const st = this.settings();
    if (s) {
      if (s.roundPhase === "live") {
        this.liveRound = s.roundNumber;
        this.breakRound = null;
        this.breakStartedAt = null;
        this.playedThisBreak = 0;
        this.trackClutch(s);
      } else if (this.phase === "live" || (this.breakStartedAt === null && s.roundPhase === "over")) {
        this.breakRound = this.liveRound;
        this.breakStartedAt = this.e.now();
        this.playedThisBreak = 0;
        if (this.clutch) this.endedClutch = { ...this.clutch, endedAt: this.e.now() };
        this.clutch = null;
      }
      this.phase = s.roundPhase;
      if (this.endedClutch && s.roundPhase !== "live") this.settleClutch(s);
    }
    if (this.busy) return;
    if (!st.enabled) return this.setStatus("off", "Automatic replays are off.");
    // Big plays and clutches come from this computer's replay buffer: start it once if it isn't running.
    if (st.ownBigPlays && !this.bufferStartTried && this.e.obs.state.connected && this.e.obs.state.replayBuffer === false) {
      this.bufferStartTried = true;
      void this.e.obs.setOutput("replay", true).catch((err) => this.e.logger.warn("automatic replays: could not start the OBS replay buffer", { error: String(err) }));
    }
    const why = this.blocked();
    if (why) return this.setStatus("blocked", why);
    if (!s || s.roundPhase === "live" || this.breakStartedAt === null) return this.setStatus("waiting", "Waiting for the round to end.");
    if (this.e.now() - this.breakStartedAt < st.startDelayMs) return this.setStatus("waiting", "The round just ended: replays start in a moment.");
    if (this.playedThisBreak >= st.maxPerBreak) return this.setStatus("waiting", "Replays for this break are done.");
    const next = this.candidates(this.breakRound).find((c) => this.estimateMs(c) <= this.breakDeadline(s) - this.e.now());
    if (!next) return this.setStatus("waiting", this.candidates(this.breakRound).length ? "The next replay doesn't fit in the time left." : "No replays for this round.");
    this.busy = true;
    try {
      await this.play(next);
    } finally {
      this.busy = false;
    }
  }

  /** Why replays can't play at all right now, or null. */
  private blocked(): string | null {
    if (!this.e.obs.state.connected) return "Connect OBS on this computer (Settings → Devices).";
    if (!this.e.settings.get<string | null>("replay.mediaInput", null)) return "Set up the replay scene: Replays → Set up OBS replay scene.";
    if (!this.e.program.sceneMap.REPLAY) return "Map the replay scene: Replays → Set up OBS replay scene.";
    if (this.e.program.mode !== "LIVE") return "The program isn't on the live scene.";
    return null;
  }

  /** Wall time a clip takes at the chosen speed. */
  private estimateMs(it: QueueItem): number {
    const len = it.playMs ?? it.clip?.media.durationMs ?? 8000;
    return (len * 100) / this.settings().speedPercent + 600;
  }

  private async play(it: QueueItem): Promise<void> {
    const st = this.settings();
    const input = this.e.settings.get<string>("replay.mediaInput", "");
    const holder = "auto-replay";
    this.abort = false;
    this.setStatus("playing", `Replay: ${it.label}`, { id: it.id, label: it.label });
    try {
      if (it.state === "prepared") this.e.replays.approve(it.id);
      await this.e.obs.setMediaFile(input, it.clip!.media.path!, { speedPercent: st.speedPercent });
      await this.e.obsAuto.useReplayTransition();
      await this.e.program.request("REPLAY_PREPARED", "automation", holder, { replayItemId: it.id });
      await this.e.program.request("REPLAY_PLAYING", "automation", holder, { replayItemId: it.id });
      await this.e.obs.mediaAction(input, "restart");
      this.e.replays.markPlaying(it.id);
      this.playedThisBreak++;
      // Wait for OBS to report the clip, then show only its end (the play and its lead-up).
      let media = await this.e.obs.mediaStatus(input).catch(() => null);
      for (let i = 0; i < 30 && media?.state !== "OBS_MEDIA_STATE_PLAYING"; i++) {
        await sleep(100);
        media = await this.e.obs.mediaStatus(input).catch(() => null);
      }
      if (media?.state !== "OBS_MEDIA_STATE_PLAYING") throw new Error(`OBS did not start the clip (media state ${media?.state ?? "unknown"})`);
      const duration = media.durationMs ?? null;
      if (duration && it.playMs && duration > it.playMs + 300) await this.e.obs.setMediaCursor(input, duration - it.playMs);
      const deadline = this.e.now() + this.estimateMs(it) + 1500;
      for (;;) {
        await sleep(100);
        const s = this.e.session.state();
        if (this.abort || !this.settings().enabled) break;
        if (s?.roundPhase === "live") break;
        // The operator (or anything else) changed the program: leave it alone.
        if (this.e.program.mode !== "REPLAY_PLAYING" || this.e.program.activeReplay !== it.id) {
          this.e.replays.markPlayed(it.id);
          return;
        }
        const m = await this.e.obs.mediaStatus(input).catch(() => null);
        if (!m || m.state === "OBS_MEDIA_STATE_ENDED" || m.state === "OBS_MEDIA_STATE_STOPPED") break;
        if (this.e.now() > deadline) break;
      }
      await this.e.program.request("LIVE", "automation", holder);
      void this.e.obsAuto.restoreAfterReplay();
      this.e.replays.markPlayed(it.id);
      this.status = { ...this.status, lastPlayed: { id: it.id, label: it.label, at: new Date().toISOString() } };
      this.e.audit.record(holder, "replay.auto_played", it.id, { label: it.label, origin: it.origin });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.e.replays.markPlaybackFailed(it.id, error);
      if (it.state === "approved") this.e.replays.reject(it.id);
      if (this.e.program.mode === "REPLAY_PLAYING" || this.e.program.mode === "REPLAY_PREPARED") await this.e.program.request("LIVE", "automation", holder).catch(() => undefined);
      void this.e.obsAuto.restoreAfterReplay();
      this.e.logger.warn("automatic replay failed", { id: it.id, error });
      this.setStatus("blocked", `The last replay didn't play: ${error}`);
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
    if (!st.enabled || !st.ownBigPlays || !k.killer) return;
    const s = this.e.session.state();
    // The main camera must have the killer on air.
    if (s?.observer.observedSteamId !== k.killer.steamId) return;
    const now = this.e.now();
    const round = s.roundNumber;
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
    const item = this.e.replays.bookmark(replayLabel(play), "big_play", c.round, { priority: PRIORITY.big_play, playMs, play });
    const st = this.e.session.state();
    await this.e.replays.capture(item.id, { preRollMs: playMs - 2000, postRollMs: 0, sourceIds: null, matchTimeMs: st?.time.matchTimeMs ?? null, timeUncertaintyMs: st?.time.timeUncertaintyMs ?? null, epoch: st?.epoch ?? null, roundNumber: c.round });
  }
}

export const playPriority = (kind: ReplayPlay["kind"]): number => PRIORITY[kind];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
