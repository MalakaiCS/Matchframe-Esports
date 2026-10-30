import { z } from "zod";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { MatchState } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { replayLabel } from "./link.ts";
import type { RankFacts } from "./rank.ts";
import { clipScore, nextReplay, replayWallMs } from "./rank.ts";
import { VMIX_TRANSITIONS, VmixClient } from "./vmix.ts";

/**
 * Automatic replays on the main PC. Clips come from the replay PC (every kill it could film, or
 * only the ones the main camera missed) and, optionally, from this computer's own OBS replay buffer
 * (3K+ and won clutches the main camera showed). Each round's clips are ranked (replay/rank.ts):
 * the break after the round plays the best ones that fit, best first, and ignores the rest. Breaks
 * run from a few seconds after the round ends until shortly before freeze time ends. Never while a
 * round is live, and never over an operator's own program choice.
 */

export const AutoReplaySettings = z.object({
  enabled: z.boolean().default(false),
  /** At most this many clips per break: the best of the round that fit, best first. */
  perBreak: z.number().int().min(1).max(4).default(4),
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
  /** How vMix goes to the replay and back. */
  vmixTransition: z.enum(VMIX_TRANSITIONS).default("CutDirect"),
});
export type AutoReplaySettings = z.infer<typeof AutoReplaySettings>;
/** A change to some settings (each key optional, no defaults filled in). */
export const AutoReplayPatch = z.object({
  enabled: z.boolean().optional(),
  perBreak: AutoReplaySettings.shape.perBreak.unwrap().optional(),
  speedPercent: AutoReplaySettings.shape.speedPercent.unwrap().optional(),
  startDelayMs: AutoReplaySettings.shape.startDelayMs.unwrap().optional(),
  otherAngles: z.boolean().optional(),
  ownBigPlays: z.boolean().optional(),
  mixer: AutoReplaySettings.shape.mixer.unwrap().optional(),
  vmixUrl: z.string().max(200).optional(),
  vmixTransition: AutoReplaySettings.shape.vmixTransition.unwrap().optional(),
});

/** A clip of the break's round, as ranked. */
export interface RankedReplay {
  id: string;
  label: string;
  score: number;
  reasons: string[];
  /** played: on air this break; picked: chosen, playing next or now; waiting: may still play; duplicate: the same kills as a better clip; left: not played (no time or slots left). */
  state: "played" | "picked" | "waiting" | "duplicate" | "left";
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
}

const PRIORITY: Record<ReplayPlay["kind"], number> = { big_play: 3, missed: 2, other_angle: 1, shown: 0 };
/** A won clutch (1v2 or more) plays before anything else. */
const CLUTCH_PRIORITY = 4;
/** Return to live this long before freeze time ends. */
const END_MARGIN_MS = 1500;
/** Freeze time assumed until the game reports it (CS2's competitive default is 20 s, many servers use 15). */
const ASSUMED_FREEZE_MS = 15000;
/**
 * The first replay of a break waits up to this long (after startDelayMs) while the replay PC is
 * still filming or sending kills of the round: it plays them some seconds after the main PC, and the
 * round's last kills are often its best.
 */
const REPLAY_PC_WAIT_MS = 8000;
/** ...but stops waiting while the break still has this much time left for replays. */
const KEEP_FOR_REPLAYS_MS = 16000;
/** Rounds of kills kept for ranking. */
const KEEP_ROUNDS = 6;

export class AutoReplay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private status: AutoReplayStatus = { enabled: false, state: "off", detail: "Automatic replays are off.", waiting: 0, playing: null, lastPlayed: null, round: null, ranked: [], vmix: null };
  private vmix: { connected: boolean; version: string | null; error: string | null; checkedAt: number } | null = null;
  private phase: string | null = null;
  /** The round that was live last, and when the break after it started (monotonic ms). */
  private liveRound: number | null = null;
  private breakRound: number | null = null;
  private breakStartedAt: number | null = null;
  private playedThisBreak = 0;
  /** Clips played (or started) this break. */
  private playedIds = new Set<string>();
  /** Every kill of the last rounds on this computer (for the ranking: opening kill, round winner, multi-kill speed). */
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
    const v = this.settings().mixer === "vmix" ? this.vmix : null;
    return { ...this.status, enabled: this.settings().enabled, waiting: this.candidates(round).length, round, ranked: this.rankedList(round), vmix: v ? { connected: v.connected, version: v.version, error: v.error } : null };
  }

  /** Clips for a round that can play automatically (not played yet). */
  private candidates(round: number | null): QueueItem[] {
    const st = this.settings();
    return this.e.replays
      .list()
      .filter((i) => (i.state === "prepared" || i.state === "approved") && i.clip?.media.path && i.play && (i.play.kind !== "other_angle" || st.otherAngles) && (round === null || i.roundNumber === null || i.roundNumber === round));
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
    // Left: the break of this round has used its replays (during the round, its clips still wait).
    const done = this.breakRound === round && this.playedThisBreak >= this.settings().perBreak;
    return this.ranked(round).map(({ item, score, reasons, duplicate }) => ({
      id: item.id,
      label: item.label,
      score,
      reasons,
      state: this.playedIds.has(item.id) || item.state === "played" ? "played" : item.state === "playing" || this.status.playing?.id === item.id ? "picked" : duplicate ? "duplicate" : done ? "left" : "waiting",
    }));
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
        this.playedIds.clear();
        if (this.clutch) this.endedClutch = { ...this.clutch, endedAt: this.e.now() };
        this.clutch = null;
      }
      this.phase = s.roundPhase;
      if (this.endedClutch && s.roundPhase !== "live") this.settleClutch(s);
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
    if (!s || s.roundPhase === "live" || this.breakStartedAt === null) return this.setStatus("waiting", "Waiting for the round to end.");
    const sinceBreak = this.e.now() - this.breakStartedAt;
    if (sinceBreak < st.startDelayMs) return this.setStatus("waiting", "The round just ended: replays start in a moment.");
    if (this.playedThisBreak >= st.perBreak) return this.setStatus("waiting", "Replays for this break are done.");
    const left = this.breakDeadline(s) - this.e.now();
    // The replay PC plays the round some seconds later: wait a little for its last kills before the first replay.
    if (this.playedThisBreak === 0 && this.e.onAir.peerPending(this.breakRound) && sinceBreak < st.startDelayMs + REPLAY_PC_WAIT_MS && left > KEEP_FOR_REPLAYS_MS) {
      return this.setStatus("waiting", "Waiting for the replay PC's last kills of the round…");
    }
    const open = new Set(this.candidates(this.breakRound).map((c) => c.id));
    const pool = this.ranked(this.breakRound).filter((r) => !r.duplicate && open.has(r.item.id) && !this.playedIds.has(r.item.id));
    const pick = nextReplay(
      pool.map((r) => ({ id: r.item.id, score: r.score, playMs: this.playMsOf(r.item), leadMs: r.item.leadMs ?? null })),
      left,
      st.speedPercent,
    );
    if (!pick) return this.setStatus("waiting", pool.length ? "The next replay doesn't fit in the time left." : "No replays for this round.");
    const next = pool.find((r) => r.item.id === pick.id)!.item;
    this.busy = true;
    try {
      await this.play(next, pick.playMs);
    } finally {
      this.busy = false;
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
    if (this.e.program.mode !== "LIVE") return "The program isn't on the live scene.";
    return null;
  }

  private async play(it: QueueItem, playMs: number): Promise<void> {
    if (this.settings().mixer === "vmix") return this.playVmix(it, playMs);
    const st = this.settings();
    const input = this.e.settings.get<string>("replay.mediaInput", "");
    const holder = "auto-replay";
    this.abort = false;
    this.playedIds.add(it.id);
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
      if (duration && duration > playMs + 300) await this.e.obs.setMediaCursor(input, duration - playMs);
      const deadline = this.e.now() + replayWallMs(playMs, st.speedPercent) + 1500;
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

  /**
   * vMix: the clip as a new video input, started at the part to show, transitioned to; when it ends
   * (or the round goes live) back to the input that was on air, and the replay input removed. If
   * someone puts another input on air meanwhile, it is left there.
   */
  private async playVmix(it: QueueItem, playMs: number): Promise<void> {
    const st = this.settings();
    const vmix = new VmixClient(st.vmixUrl);
    const holder = "auto-replay";
    const path = it.clip!.media.path!;
    const name = path.split(/[\\/]/).pop()!;
    this.abort = false;
    this.playedIds.add(it.id);
    this.setStatus("playing", `Replay: ${it.label}`, { id: it.id, label: it.label });
    let key: string | null = null;
    try {
      if (it.state === "prepared") this.e.replays.approve(it.id);
      const before = await vmix.state();
      const live = before.inputs.find((i) => i.number === before.active) ?? null;
      const known = new Set(before.inputs.map((i) => i.key));
      await vmix.call("AddInput", { Value: `Video|${path}` });
      // The new input (vMix names a video input after its file).
      let input = null as Awaited<ReturnType<VmixClient["state"]>>["inputs"][number] | null;
      for (let i = 0; i < 30 && !input; i++) {
        const now = await vmix.state();
        input = now.inputs.find((x) => !known.has(x.key) && x.title.includes(name)) ?? now.inputs.find((x) => !known.has(x.key)) ?? null;
        if (!input) await sleep(100);
      }
      if (!input) throw new Error("vMix didn't add the replay clip as an input");
      key = input.key;
      const duration = input.duration || it.clip?.media.durationMs || playMs;
      if (duration > playMs + 300) await vmix.call("SetPosition", { Input: key, Value: Math.round(duration - playMs) });
      if (st.speedPercent !== 100) await vmix.call("SetRate", { Input: key, Value: st.speedPercent / 100 }).catch(() => undefined);
      await vmix.call("Play", { Input: key });
      await vmix.call(st.vmixTransition, { Input: key });
      this.e.replays.markPlaying(it.id);
      this.playedThisBreak++;
      const startedAt = this.e.now();
      const deadline = startedAt + replayWallMs(playMs, st.speedPercent) + 1500;
      let leftOnAir = true;
      for (;;) {
        await sleep(150);
        if (this.abort || !this.settings().enabled) break;
        if (this.e.session.state()?.roundPhase === "live") break;
        const now = await vmix.state().catch(() => null);
        const mine = now?.inputs.find((x) => x.key === key);
        // Someone put another input on air (after the transition had time to finish): leave it there.
        if (now && mine && now.active !== mine.number && this.e.now() - startedAt > 1200) {
          leftOnAir = false;
          break;
        }
        if (!mine || mine.state === "Completed" || (mine.duration > 0 && mine.position >= mine.duration - 60)) break;
        if (this.e.now() > deadline) break;
      }
      if (leftOnAir && live) await vmix.call(st.vmixTransition, { Input: live.key });
      this.e.replays.markPlayed(it.id);
      this.status = { ...this.status, lastPlayed: { id: it.id, label: it.label, at: new Date().toISOString() } };
      this.e.audit.record(holder, "replay.auto_played", it.id, { label: it.label, origin: it.origin, mixer: "vmix" });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.e.replays.markPlaybackFailed(it.id, error);
      if (it.state === "approved") this.e.replays.reject(it.id);
      this.e.logger.warn("automatic replay failed (vMix)", { id: it.id, error });
      this.setStatus("blocked", `The last replay didn't play: ${error}`);
    } finally {
      // The replay input goes once the transition back is over.
      if (key) {
        const k = key;
        setTimeout(() => void vmix.call("RemoveInput", { Input: k }).catch(() => undefined), 2000).unref?.();
      }
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
      const round = this.e.session.state()?.roundNumber ?? null;
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
    const item = this.e.replays.bookmark(replayLabel(play), "big_play", c.round, { priority: PRIORITY.big_play, playMs, leadMs: 4000, play });
    const st = this.e.session.state();
    await this.e.replays.capture(item.id, { preRollMs: playMs - 2000, postRollMs: 0, sourceIds: null, matchTimeMs: st?.time.matchTimeMs ?? null, timeUncertaintyMs: st?.time.timeUncertaintyMs ?? null, epoch: st?.epoch ?? null, roundNumber: c.round });
  }
}

export const playPriority = (kind: ReplayPlay["kind"]): number => PRIORITY[kind];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
