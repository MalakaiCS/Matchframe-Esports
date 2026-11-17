import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import type { MatchState, Vec3 } from "@matchframe/contracts";
import type { Pin } from "@matchframe/director-policy";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { ReplayAngle, ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";
import { killCamera } from "./angles.ts";
import type { AngleRequest } from "./auto.ts";
import type { OnAirClock, OnAirKill } from "./onair.ts";
import { onAirAt, SHOWN_WINDOW_MS, showedDuring } from "./onair.ts";
import { DelayEstimator, killKey } from "./timing.ts";

/**
 * Replay PC (the second computer). It runs its own CS2, Auto Director and OBS replay buffer, and is
 * linked to the main PC, which it asks four times a second who is on air, what its round clock says
 * and which kills its camera missed. From the two round clocks it works out how far behind the main
 * PC its own game is, and works in one of three ways:
 *
 * - **Behind** (it watches a CSTV a few seconds later than the main PC): every kill the main camera
 *   missed is known here before it plays on this computer. Its director is pinned to the killer from
 *   a few seconds before the kill until just after it, then the replay buffer is saved and sent.
 * - **Live** (same time as the main PC, e.g. both on the same CSTV): by default CS2 goes back 7 s
 *   once (`demo_gototick -448 relative`, which a live CSTV connection can do) and this computer then works
 *   behind, as above. Or it goes back only for each missed kill its camera didn't have, films it,
 *   and skips forward to live again. Or it doesn't go back: its director films anyone but the main
 *   camera's player, and a missed kill that happens on its camera is saved and sent.
 * - Ahead of the main PC: going back (by the lead plus 7 s) puts it behind; otherwise it works as live.
 *
 * The main PC plays the clips in the next replay break (replay/auto.ts).
 *
 * Extra angles (ADR-081, experimental, `filmAngles`): the main PC asks for some moments again (the
 * round's top kill, the kills its operator starred) from the player who died's view or a free camera.
 * When that can't cost any kill its lead-up (this computer's round is over, or it is far enough behind
 * that a kill reported meanwhile still gets its whole lead-up), CS2 goes back to just before the kill
 * (demo_gototick), the camera goes to the player who died (or a free camera placed for the kill), the
 * kill plays again, and the clip is sent as an extra angle of the moment. Then CS2 goes forward by as
 * much: the stretch it skips was played while it filmed, and has no kill (that is the condition).
 */

export const ReplayPcSettings = z.object({
  enabled: z.boolean().default(false),
  /** The main PC's program address, e.g. http://192.168.1.20:37211. */
  mainUrl: z.string().max(200).default(""),
  /** Seconds before the first kill a clip shows. */
  preRollMs: z.number().int().min(2000).max(15000).default(5000),
  /** Seconds after the last kill (also how long the computer waits before saving). */
  postRollMs: z.number().int().min(500).max(5000).default(2000),
  /**
   * At the same time as (or ahead of) the main PC, e.g. both on one CSTV: go back with CS2's
   * demo_gototick and stay behind, go back for each missed kill then forward to live, or never.
   */
  sameCstv: z.enum(["stay_behind", "each_kill", "off"]).default("stay_behind"),
  /** How far behind the main PC "stay behind" puts this computer. */
  behindMs: z.number().int().min(3000).max(15000).default(7000),
  /**
   * Behind the main PC: film every kill this computer can, also the ones the main camera showed
   * (the main PC replays the best of each round). Off: only kills the main camera missed or showed
   * from the player who died.
   */
  filmAll: z.boolean().default(true),
  /**
   * Extra angles (ADR-081, experimental): film the moments the main PC asks for again, from the player
   * who died's view or a free camera, by going back in CS2 when that costs no kill its lead-up.
   */
  filmAngles: z.boolean().default(false),
});
export type ReplayPcSettings = z.infer<typeof ReplayPcSettings>;

export interface MainOnAir {
  computer: string;
  version: string;
  observedSteamId: string | null;
  roundNumber: number | null;
  roundPhase: string | null;
  mapName: string | null;
  /** Main PCs from 0.5.1 on. */
  clock?: OnAirClock | null;
  kills?: OnAirKill[];
  /** Main PCs from 0.9.0 on: it records this computer's screen over NDI (the replay feed). */
  feed?: { recording: boolean };
  /** Main PCs from 0.13 on: the moments it wants filmed again from another angle (ADR-081). */
  angles?: AngleRequest[];
}

/** Extra angles (ADR-081): what this computer is doing about them. */
export interface AnglesStatus {
  state: "off" | "ready" | "filming" | "unsupported";
  detail: string;
  /** The moments asked for now. */
  asked: number;
  filmed: number;
  failed: number;
  last: { label: string; at: string; ok: boolean; detail: string } | null;
}

export type TimingState = "measuring" | "live" | "behind" | "ahead";
export type RewindState = "off" | "ready" | "rewinding" | "holding" | "rewound" | "returning" | "unsupported";

export interface ReplayPcStatus {
  enabled: boolean;
  state: "off" | "connecting" | "connected" | "error";
  detail: string;
  main: { computer: string; version: string; url: string } | null;
  /** The player on air on the main PC (Steam ID), while connected. */
  mainObserved: string | null;
  obsReady: boolean;
  /** How clips reach the main PC: it records this computer's screen over NDI (feed), or this computer's OBS saves and sends them (obs). */
  transport: "feed" | "obs";
  /** How far this computer's game is behind the main PC's. */
  timing: { state: TimingState; delayMs: number | null; detail: string };
  rewind: { state: RewindState; detail: string; count: number };
  /** The kill being filmed now, and how many more are planned. */
  filming: string | null;
  planned: number;
  sent: number;
  failed: number;
  skipped: number;
  last: { label: string; at: string; ok: boolean; error: string | null } | null;
  lastSkip: { label: string; reason: string; at: string } | null;
  /** Extra angles of moments the main PC asked for (ADR-081). */
  angles: AnglesStatus;
}

const POLL_MS = 250;
const TICK_MS = 100;
/** A main-PC answer older than this is not used to avoid or judge anything. */
const FRESH_MS = 1500;
/** Kills by the same player this close together go into one clip. */
const CHAIN_MS = 4000;
/** A clip never covers more kills than fit in this span. */
const MAX_SPAN_MS = 12000;
/** This far behind the main PC (or more) counts as behind. */
const LEAD_MIN_MS = 2500;
/** The camera must be on the killer at least this long before the kill. */
const MIN_PRE_MS = 1500;
/** The cut to the killer starts this much before the clip should, so the clip starts on them. */
const CUT_LEAD_MS = 600;
/** How long past the expected time a kill may take to show on this computer. */
const GRACE_MS = 2500;
/** Further behind than this, clips may reach the main PC after the replay break. */
const LATE_MS = 15000;
/** Ticks per second of a CSTV broadcast (demo_gototick counts in these). */
const TICKRATE = 64;
const REWIND_MIN_MS = 3000;
/** Going back for one kill: at most this far. */
const REWIND_MAX_MS = 12000;
/** Staying behind (from ahead of the main PC): at most this far back in one go. */
const STAY_MAX_MS = 60000;
/** Back at the main PC's time while staying behind (a reconnect, a map change): go back again after this. */
const STAY_RETRY_MS = 5000;
const REWIND_MARGIN_MS = 1500;
/** How long CS2 has to show that it went back (or forward). */
const REWIND_CHECK_MS = 4000;
const RETURN_CHECK_MS = 5000;
/** Back to live once nothing has been planned for this long. */
const RETURN_IDLE_MS = 800;
/** What CS2's console answers to a demo command when it has nothing to go back in (connected straight to the game server). */
const REFUSED = /not currently playing back a demo|unknown command/i;
/** An extra angle (ADR-081): it shows this long before the kill, and this long after the last kill. */
const ANGLE_LEAD_MS = 2500;
const ANGLE_POST_MS = 1500;
/** Of the stream gone back to, this much is for CS2 to land and the camera to get there before the lead-up. */
const ANGLE_SETTLE_MS = 1000;
/** Going back further than this for an angle isn't tried (a CSTV connection keeps so much of the match). */
const ANGLE_MAX_BACK_MS = 90_000;
/** CS2 must show it went back (the player who died alive again) within this long. */
const ANGLE_LAND_MS = 4000;
/** Going forward again: CS2 must show it is back where it was within this long. */
const ANGLE_RETURN_MS = 5000;
/** After the pass, before the next kill's lead-up: time to go forward and get the camera there. */
const ANGLE_RETURN_MARGIN_MS = 1500;
/** Extra angles filmed (or tried) per round, at most. */
const ANGLES_PER_ROUND = 2;
/** The main PC's kills remembered for extra angles. */
const KILL_LOG_MS = 180_000;
/** Close enough to where this computer was before the pass (ms of delay). */
const RETURN_TOLERANCE_MS = 1500;
/** Freeze time assumed after a round's end, until the game says (CS2's competitive default is 20 s; many servers use 15). */
const ASSUMED_FREEZE_MS = 15_000;

interface Pending {
  killer: { steamId: string; name: string };
  victims: string[];
  weapon: string | null;
  headshot: boolean;
  /** Per kill: the key both computers agree on, and what this computer saw of the main camera then. */
  keys: string[];
  seenOnMain: Shown[];
  firstAt: number;
  lastAt: number;
  roundNumber: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** A kill to film on this computer before it plays here (one the main camera missed, or with filmAll any kill). */
interface Job {
  killer: { steamId: string; name: string };
  victims: { steamId: string; name: string }[];
  weapon: string | null;
  headshot: boolean;
  kind: "missed" | "other_angle" | "shown";
  round: number | null;
  /** When the first and last kill should play on this computer (local monotonic ms). */
  firstT: number;
  lastT: number;
  startedAt: number | null;
  /** When this computer's camera got to the killer. */
  onKillerAt: number | null;
  /** When each victim died on this computer (its game data, so a replayed death counts too). */
  seen: Map<string, number>;
  prevPin: Pin | null;
  pinned: boolean;
}

type Shown = OnAirKill["shown"];

/** A kill the main PC reported: who, and when it happened there (this computer's clock). */
interface LoggedKill {
  round: number | null;
  killer: { steamId: string; name: string };
  victim: { steamId: string; name: string };
  tk: number;
}

/** An extra angle being filmed (ADR-081): going back, filming, going forward again. */
interface AnglePass {
  req: AngleRequest;
  view: ReplayAngle;
  label: string;
  kills: LoggedKill[];
  stage: "back" | "filming" | "forward";
  backMs: number;
  /** How far behind the main PC this computer was before going back. */
  delayBefore: number;
  startedAt: number;
  landedAt: number | null;
  onTargetAt: number | null;
  /** When the first kill should play again (this computer's clock), and each victim's death as it did. */
  expectAt: number;
  seen: Map<string, number>;
  /** The camera's state before (to give it back). */
  prevPin: Pin | null;
  automatic: boolean;
  camera: boolean;
  /** The main PC's kills reported meanwhile: planned once back (with the delay from before). */
  queued: { k: OnAirKill; tk: number }[];
  forwardUntil: number;
  /** Why it wasn't filmed (null: filmed, or not over yet). */
  failed: string | null;
}

/** "the player who died's view", "a free camera". */
const VIEW_LABEL: Record<ReplayAngle, string> = { victim: "victim's view", free: "free camera" };

export const SECRET_KEY = "replayPc.token";

export class ReplayLink {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private status: ReplayPcStatus = {
    enabled: false,
    state: "off",
    detail: "This computer is not a replay PC.",
    main: null,
    mainObserved: null,
    obsReady: false,
    transport: "obs",
    timing: { state: "measuring", delayMs: null, detail: "" },
    rewind: { state: "off", detail: "", count: 0 },
    filming: null,
    planned: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    last: null,
    lastSkip: null,
    angles: { state: "off", detail: "", asked: 0, filmed: 0, failed: 0, last: null },
  };
  /** The main PC's on-air player over time (local monotonic ms). */
  private mainHistory: { at: number; steamId: string | null }[] = [];
  /** This computer's on-air player over time. */
  private ownHistory: { at: number; steamId: string | null }[] = [];
  private lastAnswerAt = -Infinity;
  /** The main PC reports its round clock and kills (0.5.1 and later). */
  private mainReportsKills = false;
  /** What the main PC's camera showed of each recent kill, by kill key. */
  private mainVerdicts = new Map<string, { shown: Shown; at: number }>();
  private pending = new Map<string, Pending>();
  /** Rounds of clips being saved and sent right now (one entry per clip). */
  private sending: number[] = [];
  private unsubscribe: (() => void)[] = [];
  private bufferStartTried = false;
  private estimator = new DelayEstimator();
  /** Main PC kills already handled (id → when). */
  private seenMainKills = new Map<string, number>();
  private jobs: Job[] = [];
  private active: Job | null = null;
  /** Kills set aside for a better one, kept a while in case the same player's next kill makes a multi-kill. */
  private dropped: Job[] = [];
  /** Who was alive in this computer's last game data. */
  private alive = new Map<string, boolean>();
  /** Missed kills reported while the timing is still being measured: planned once it is known, if still ahead. */
  private waiting: { k: OnAirKill; tk: number }[] = [];
  private rewindRun: { requestedMs: number; checkUntil: number; idleSince: number | null; kills: { k: OnAirKill; tk: number }[] } = { requestedMs: 0, checkUntil: 0, idleSince: null, kills: [] };
  /** Staying behind: not before this (after the last go-back, or after returning to the main PC's time). */
  private stayNextAt = 0;
  /** The main PC's kills of the last minutes, for extra angles (ADR-081). */
  private killLog: LoggedKill[] = [];
  /** Where each player stood at each kill this computer showed (for a free camera). */
  private killPos = new Map<string, { killer: Vec3 | null; victim: Vec3 | null; at: number }>();
  /** The moments the main PC asks for now, the extra angles done or given up (moment id + view), and how many each round had. */
  private angleAsks: AngleRequest[] = [];
  private angleDone = new Set<string>();
  private anglesPerRound = new Map<number, number>();
  private pass: AnglePass | null = null;

  constructor(private readonly e: Engine) {}

  settings(): ReplayPcSettings {
    const raw = this.e.settings.get("replayPc", {}) as Record<string, unknown>;
    // 0.5.1 had a rewind switch (go back for each missed kill).
    const stored = raw && typeof raw === "object" && raw.sameCstv === undefined && raw.rewind === true ? { ...raw, sameCstv: "each_kill" } : raw;
    const r = ReplayPcSettings.safeParse(stored);
    return r.success ? r.data : ReplayPcSettings.parse({});
  }

  setSettings(patch: Partial<ReplayPcSettings> & { token?: string | null }): ReplayPcSettings {
    const { token, ...rest } = patch;
    const given = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    const next = ReplayPcSettings.parse({ ...this.settings(), ...given });
    if (next.mainUrl) next.mainUrl = normalizeUrl(next.mainUrl);
    this.e.settings.set("replayPc", next);
    if (token !== undefined) this.e.secrets.setSecret(SECRET_KEY, token ? token.trim() : null);
    this.restart();
    return next;
  }

  hasToken(): boolean {
    return !!this.e.secrets.getSecret(SECRET_KEY);
  }

  getStatus(): ReplayPcStatus {
    return { ...this.status, obsReady: this.e.obs.state.connected && this.e.obs.state.replayBuffer === true, planned: this.jobs.length, angles: { ...this.status.angles, asked: this.angleAsks.filter((r) => r.views.some((v) => !this.angleDone.has(`${r.id}|${v}`))).length } };
  }

  start(): void {
    this.restart();
  }

  restart(): void {
    this.stop();
    const st = this.settings();
    this.status.rewind =
      st.sameCstv === "off"
        ? { state: "off", detail: "", count: this.status.rewind.count }
        : { state: "ready", detail: st.sameCstv === "stay_behind" ? `At the main PC's time, CS2 goes back ${sec(st.behindMs)} once and stays there.` : "On a missed kill this camera didn't have, CS2 goes back a few seconds to film it.", count: this.status.rewind.count };
    this.stayNextAt = 0;
    this.status.timing = { state: "measuring", delayMs: null, detail: "" };
    this.status.angles = { ...this.status.angles, state: st.filmAngles ? "ready" : "off", detail: st.filmAngles ? "Extra angles the main PC asks for are filmed by going back, when no kill's lead-up is lost." : "" };
    if (!st.enabled) {
      this.status = { ...this.status, enabled: false, state: "off", detail: "This computer is not a replay PC.", main: null, mainObserved: null };
      return;
    }
    if (!st.mainUrl || !this.hasToken()) {
      this.status = { ...this.status, enabled: true, state: "error", detail: "Enter the main PC's address and its replay PC code.", main: null, mainObserved: null };
      return;
    }
    this.status = { ...this.status, enabled: true, state: "connecting", detail: `Connecting to ${st.mainUrl}…` };
    this.unsubscribe.push(this.e.onKill((k) => this.onKill(k)));
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref?.();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.ticker) clearInterval(this.ticker);
    this.timer = null;
    this.ticker = null;
    for (const fn of this.unsubscribe.splice(0)) fn();
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    this.pending.clear();
    if (this.active) this.release(this.active);
    this.jobs = [];
    this.dropped = [];
    this.waiting = [];
    if (this.pass) {
      // Stopped while CS2 is back for an angle: forward again first (it isn't checked any more).
      const p = this.pass;
      if (p.stage !== "forward" && p.landedAt !== null) this.forward(p, this.e.now());
      this.endPass(p, "stopped");
    }
    this.status.filming = null;
    this.estimator = new DelayEstimator();
    this.seenMainKills.clear();
    this.e.session.director.avoid([], 0);
  }

  /** Called with every game-state update on this computer. */
  noteOwnState(s: MatchState): void {
    if (!this.timer) return;
    const now = this.e.now();
    const id = s.observer.observedSteamId;
    const last = this.ownHistory[this.ownHistory.length - 1];
    if (!last || last.steamId !== id) this.ownHistory.push({ at: now, steamId: id });
    trim(this.ownHistory, now);
    const j = this.active;
    if (j && j.onKillerAt === null && id === j.killer.steamId) j.onKillerAt = now;
    const pass = this.pass;
    for (const p of s.players) {
      const alive = p.lifeState === "alive";
      const was = this.alive.get(p.steamId);
      if (j && !alive && was === true && j.victims.some((v) => v.steamId === p.steamId) && !j.seen.has(p.steamId)) j.seen.set(p.steamId, now);
      // An extra angle: CS2 went back (the player who died alive again), then the kill plays again.
      if (pass && pass.kills.some((k) => k.victim.steamId === p.steamId)) {
        if (pass.stage === "back" && alive && was === false && p.steamId === pass.kills[0]!.victim.steamId) pass.landedAt = now;
        if (pass.stage === "filming" && !alive && was === true && !pass.seen.has(p.steamId)) pass.seen.set(p.steamId, now);
      }
      this.alive.set(p.steamId, alive);
    }
    if (pass && pass.stage === "filming" && pass.onTargetAt === null && pass.view === "victim" && id === pass.kills[0]!.victim.steamId) pass.onTargetAt = now;
    if (s.phaseEndsInSec !== null) this.estimator.noteOwn({ at: s.phaseObservedAtMonotonicMs ?? now, map: s.mapName, round: s.roundNumber, phase: s.gamePhase, endsInSec: s.phaseEndsInSec });
  }

  private async poll(): Promise<void> {
    if (this.inFlight) return;
    const st = this.settings();
    const token = this.e.secrets.getSecret(SECRET_KEY);
    if (!st.enabled || !st.mainUrl || !token) return;
    this.inFlight = true;
    try {
      const sentAt = this.e.now();
      // The rounds this computer still has kills of to film or send: the main PC's replay break waits for them.
      const res = await fetch(`${st.mainUrl}/api/v1/replay-link/on-air?pending=${this.pendingRounds().join(",")}&angles=${this.angleRounds().join(",")}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
      if (res.status === 401 || res.status === 403) throw new Error("the main PC refused this computer's code: make a new replay PC code on the main PC");
      if (!res.ok) throw new Error(`the main PC answered ${res.status}`);
      const onAir = (await res.json()) as MainOnAir;
      const now = this.e.now();
      // When the main PC answered, on this computer's clock.
      const at = now - (now - sentAt) / 2;
      this.lastAnswerAt = now;
      const last = this.mainHistory[this.mainHistory.length - 1];
      if (!last || last.steamId !== onAir.observedSteamId) this.mainHistory.push({ at, steamId: onAir.observedSteamId });
      trim(this.mainHistory, now);
      const c = onAir.clock;
      if (c) this.estimator.noteMain({ at: at - c.ageMs, map: c.map, round: c.round, phase: c.phase, endsInSec: c.endsInSec });
      const kills = onAir.kills ?? [];
      this.mainReportsKills = Array.isArray(onAir.kills);
      for (const k of kills) {
        if (this.seenMainKills.has(k.id)) continue;
        this.seenMainKills.set(k.id, now);
        const tk = at - k.ageMs;
        this.estimator.noteMainKill(killKey(k.round, k.killer.steamId, k.victim.steamId), tk);
        this.mainVerdicts.set(killKey(k.round, k.killer.steamId, k.victim.steamId), { shown: k.shown, at: now });
        this.killLog.push({ round: k.round, killer: { ...k.killer }, victim: { ...k.victim }, tk });
      }
      while (this.killLog.length && this.killLog[0]!.tk < now - KILL_LOG_MS) this.killLog.shift();
      this.angleAsks = Array.isArray(onAir.angles) ? onAir.angles.slice(0, 5) : [];
      for (const [key, v] of this.mainVerdicts) if (v.at < now - 60_000) this.mainVerdicts.delete(key);
      this.updateTiming(now);
      if (this.status.timing.state !== "measuring" && this.waiting.length) {
        const d = this.status.timing.delayMs;
        for (const w of this.waiting.splice(0)) if (this.status.timing.state === "behind" && d !== null && w.tk + d - now >= MIN_PRE_MS) this.plan(w.k, w.tk + d);
      }
      for (const k of kills) if (this.seenMainKills.get(k.id) === now) this.onMainKill(k, at - k.ageMs);
      for (const [id, t] of this.seenMainKills) if (t < now - 60_000) this.seenMainKills.delete(id);
      // Prefer anyone but the main PC's player (at this computer's point in the game) for a little longer than one poll.
      if (!this.active) {
        const d = this.status.timing.delayMs;
        const target = this.status.timing.state === "behind" && d !== null ? onAirAt(this.mainHistory, now - d) : onAir.observedSteamId;
        this.e.session.director.avoid(target ? [target] : [], now + FRESH_MS);
      }
      const transport = onAir.feed?.recording ? "feed" : "obs";
      this.status = { ...this.status, state: "connected", detail: `Linked to ${onAir.computer}.`, main: { computer: onAir.computer, version: onAir.version, url: st.mainUrl }, mainObserved: onAir.observedSteamId, transport };
      if (transport === "obs") void this.ensureReplayBuffer();
    } catch (err) {
      const msg = err instanceof Error ? (err.name === "TimeoutError" ? "the main PC didn't answer in time" : err.message) : String(err);
      this.status = { ...this.status, state: "error", detail: `Can't reach the main PC at ${st.mainUrl}: ${msg}.`, mainObserved: null };
    } finally {
      this.inFlight = false;
    }
  }

  /** Rounds (the main PC's numbers) with a kill being filmed, planned, or being saved and sent. */
  private pendingRounds(): number[] {
    const rounds = new Set<number>();
    for (const j of [...(this.active ? [this.active] : []), ...this.jobs]) if (j.round !== null) rounds.add(j.round);
    for (const r of this.sending) rounds.add(r);
    for (const p of this.pending.values()) if (p.roundNumber !== null) rounds.add(p.roundNumber);
    // Kills reported while an extra angle is filmed: planned once CS2 is back.
    for (const q of this.pass?.queued ?? []) if (q.k.round !== null) rounds.add(q.k.round);
    return [...rounds].slice(0, 10);
  }

  private updateTiming(now: number): void {
    const est = this.estimator.estimate(now);
    const d = est?.delayMs ?? null;
    const mode = this.settings().sameCstv;
    const rewinding = mode !== "off" && this.status.rewind.state === "ready";
    if (d === null) {
      this.status.timing = { state: "measuring", delayMs: null, detail: "Working out how far behind the main PC this computer's game is…" };
    } else if (d >= LEAD_MIN_MS) {
      const late = d > LATE_MS ? ` That's a lot: clips may reach the main PC after the replay break. A CSTV about 7 s behind the main PC is best.` : "";
      this.status.timing = { state: "behind", delayMs: d, detail: `${sec(d)} behind the main PC: this computer gets on the killer before each missed kill plays here.${late}` };
    } else if (d <= -LEAD_MIN_MS) {
      this.status.timing = { state: "ahead", delayMs: d, detail: `${sec(-d)} ahead of the main PC. The replay PC should be the later one: watch a CSTV with more delay than the main PC.` };
    } else {
      this.status.timing = { state: "live", delayMs: d, detail: rewinding && mode === "stay_behind" ? "At the same time as the main PC: going back to stay behind it…" : `At the same time as the main PC: this computer films someone else and sends what its camera caught.${rewinding ? " A missed kill it didn't have is rewound." : ""}` };
    }
  }

  /** Starts OBS's replay buffer on this computer once, when OBS is connected and it isn't running. */
  private async ensureReplayBuffer(): Promise<void> {
    if (this.bufferStartTried || !this.e.obs.state.connected || this.e.obs.state.replayBuffer !== false) return;
    this.bufferStartTried = true;
    await this.e.obs.setOutput("replay", true).catch((err) => this.e.logger.warn("replay PC: could not start the OBS replay buffer", { error: String(err) }));
  }

  // ---- kills the main PC missed ------------------------------------------------------------------

  private onMainKill(k: OnAirKill, tk: number): void {
    // Kills the main camera showed are filmed too with filmAll, from behind only (never worth going back for).
    if (k.shown === "killer" && !this.settings().filmAll) return;
    // Filming an extra angle (CS2 further back than usual): planned once it is back, with the delay from before.
    if (this.pass) {
      this.pass.queued.push({ k, tk });
      return;
    }
    const rw = this.status.rewind.state;
    if (rw === "rewinding") {
      this.rewindRun.kills.push({ k, tk });
      return;
    }
    const d = this.status.timing.delayMs;
    if ((this.status.timing.state === "behind" || rw === "rewound") && d !== null && d > 0) {
      this.plan(k, tk + d);
      return;
    }
    if (this.status.timing.state === "measuring") {
      this.waiting.push({ k, tk });
      if (this.waiting.length > 30) this.waiting.shift();
      return;
    }
    const st = this.settings();
    if (k.shown === "killer" || this.status.timing.state !== "live" || st.sameCstv === "off" || rw !== "ready") return;
    const now = this.e.now();
    if (now - tk > 2500) return;
    // This computer's camera had the killer: the live path sends it without going back.
    if (showedDuring(this.ownHistory, k.killer.steamId, tk - 1500, now)) return;
    // Back to the lead-up of the kill, plus time to notice the jump and cut to the killer; staying behind, at least that far.
    const need = now - tk + st.preRollMs + REWIND_MARGIN_MS;
    const back = st.sameCstv === "stay_behind" ? Math.min(STAY_MAX_MS, Math.max(need, st.behindMs - (d ?? 0))) : Math.min(REWIND_MAX_MS, need);
    void this.goBack(back, { k, tk }, `for ${k.killer.name}'s kill`);
  }

  private plan(k: OnAirKill, t: number): void {
    const now = this.e.now();
    const victim = { steamId: k.victim.steamId, name: k.victim.name };
    // A kill right after another by the same player goes into its clip, also one set aside for now.
    const chain = [...(this.active ? [this.active] : []), ...this.jobs, ...this.dropped].find((j) => j.killer.steamId === k.killer.steamId && t - j.lastT <= CHAIN_MS && t - j.firstT <= MAX_SPAN_MS && t >= j.firstT - CHAIN_MS);
    if (chain) {
      if (!chain.victims.some((v) => v.steamId === victim.steamId)) chain.victims.push(victim);
      chain.lastT = Math.max(chain.lastT, t);
      if (chain.startedAt === null) chain.firstT = Math.min(chain.firstT, t);
      chain.headshot ||= k.headshot;
      if (KIND_RANK[kindOf(k)] > KIND_RANK[chain.kind]) chain.kind = kindOf(k);
      if (this.dropped.includes(chain)) {
        // A multi-kill now: it may beat what was planned instead.
        this.dropped = this.dropped.filter((j) => j !== chain);
        this.status.skipped -= 1;
        this.place(chain, now);
      }
      return;
    }
    this.place({ killer: { ...k.killer }, victims: [victim], weapon: k.weapon, headshot: k.headshot, kind: kindOf(k), round: k.round, firstT: t, lastT: t, startedAt: null, onKillerAt: null, seen: new Map(), prevPin: null, pinned: false }, now);
  }

  /** One camera: of two kills that can't both be filmed, keep the better one (a kill being filmed gives way only to a better one that hasn't happened here yet). */
  private place(job: Job, now: number): void {
    if (job.firstT - now < MIN_PRE_MS) return this.drop(job, "it plays on this computer too soon to get the camera there");
    const st = this.settings();
    const conflicts = [...(this.active ? [this.active] : []), ...this.jobs].filter((other) => {
      const [a, b] = other.firstT <= job.firstT ? [other, job] : [job, other];
      return b.firstT - MIN_PRE_MS < a.lastT + st.postRollMs;
    });
    const kept = conflicts.find((other) => priority(other) >= priority(job) || (other === this.active && other.seen.size > 0));
    if (kept) return this.drop(job, `this computer is filming ${kept.killer.name} then`);
    for (const other of conflicts) {
      if (other === this.active) this.release(other);
      this.jobs = this.jobs.filter((j) => j !== other);
      this.drop(other, `${job.killer.name}'s ${job.victims.length > 1 ? `${job.victims.length}K` : "kill"} is filmed instead`);
    }
    this.jobs.push(job);
    this.jobs.sort((a, b) => a.firstT - b.firstT);
  }

  /** Set aside: not filmed unless the same player's next kill makes it the better clip. */
  private drop(j: Job, reason: string): void {
    this.skip(j, reason);
    this.dropped.push(j);
    const now = this.e.now();
    this.dropped = this.dropped.filter((d) => d.firstT > now - MAX_SPAN_MS).slice(-10);
  }

  /** Stops filming a kill: the pin goes back to what it was. */
  private release(j: Job): void {
    if (this.active === j) this.active = null;
    this.status.filming = null;
    if (j.pinned) this.e.session.pin(j.prevPin);
    j.pinned = false;
    j.startedAt = null;
    j.onKillerAt = null;
  }

  private tick(): void {
    const now = this.e.now();
    if (this.pass) return this.tickPass(this.pass, now);
    this.checkRewind(now);
    this.maybeStayBehind(now);
    const st = this.settings();
    const j = this.active;
    if (j) {
      const all = j.seen.size >= j.victims.length;
      const finishAt = all ? Math.max(...j.seen.values()) + st.postRollMs : j.lastT + GRACE_MS;
      if (now >= finishAt) this.finish(j);
      return;
    }
    while (this.jobs.length && this.jobs[0]!.firstT - now < MIN_PRE_MS) this.skip(this.jobs.shift()!, "too late to get the camera there");
    const next = this.jobs[0];
    if (next && next.firstT - st.preRollMs - CUT_LEAD_MS <= now) this.begin(next, now);
    else this.maybeFilmAngle(now);
  }

  private begin(j: Job, now: number): void {
    this.jobs.shift();
    const s = this.e.session.state();
    const p = s?.players.find((x) => x.steamId === j.killer.steamId);
    if (!s || !p || p.lifeState !== "alive") return this.skip(j, `${j.killer.name} isn't alive on this computer (is it behind the main PC?)`);
    this.active = j;
    j.startedAt = now;
    this.status.filming = jobLabel(j);
    this.e.session.director.avoid([], 0);
    const automatic = this.e.autoDirector.status().on || this.e.session.director.currentMode === "automatic";
    if (automatic) {
      j.prevPin = this.e.session.director.controls.pin;
      j.pinned = true;
      this.e.session.pin({ kind: "player", steamId: j.killer.steamId });
    } else {
      void this.e.session.manualSelectPlayer(j.killer.steamId, "replay-pc", "device").catch((err) => this.e.logger.warn("replay PC: could not show the killer", { error: String(err) }));
    }
    if (s.observer.observedSteamId === j.killer.steamId) j.onKillerAt = now;
  }

  private finish(j: Job): void {
    const onAt = j.onKillerAt;
    this.release(j);
    if (!j.seen.size) return this.skip(j, "the kill didn't show on this computer in time");
    const first = Math.min(...j.seen.values());
    const last = Math.max(...j.seen.values());
    if (onAt === null || onAt > first - MIN_PRE_MS / 2 || !this.stayedOn(j.killer.steamId, onAt, last)) return this.skip(j, `this computer's camera wasn't on ${j.killer.name} for it`);
    const st = this.settings();
    const now = this.e.now();
    const playFrom = Math.max(onAt + 300, first - st.preRollMs);
    const play: ReplayPlay = { kind: j.kind, killer: j.killer, victims: j.victims.map((v) => v.name), kills: j.victims.length, weapon: j.weapon, headshot: j.headshot };
    // Each kill's time in the clip, for slow motion around each of a multi-kill's (ADR-081).
    const killsMs = [...j.seen.values()].sort((a, b) => a - b).map((t) => Math.round(t - playFrom));
    void this.send(play, Math.round(now - playFrom), j.round, Math.round(first - playFrom), { killsMs });
  }

  /** This computer's camera stayed on one player from `from` to `to`. */
  private stayedOn(steamId: string, from: number, to: number): boolean {
    if (onAirAt(this.ownHistory, from) !== steamId) return false;
    return !this.ownHistory.some((h) => h.at > from && h.at <= to && h.steamId !== steamId);
  }

  private skip(j: Job, reason: string): void {
    this.status = { ...this.status, skipped: this.status.skipped + 1, lastSkip: { label: jobLabel(j), reason, at: new Date().toISOString() } };
    this.e.logger.info("replay PC: kill not filmed", { label: jobLabel(j), reason });
  }

  // ---- going back in CS2 (demo_gototick on a CSTV connection) -------------------------------------

  /** Staying behind: at (or ahead of) the main PC's time, go back so this computer is `behindMs` behind it. */
  private maybeStayBehind(now: number): void {
    const st = this.settings();
    if (st.sameCstv !== "stay_behind" || this.status.rewind.state !== "ready" || this.status.state !== "connected") return;
    const t = this.status.timing;
    if ((t.state !== "live" && t.state !== "ahead") || t.delayMs === null || now < this.stayNextAt) return;
    // A clip of this camera being saved: let it finish (going back now would put the lead-up at its end).
    if (this.pending.size) return;
    void this.goBack(Math.min(STAY_MAX_MS, st.behindMs - t.delayMs), null, "to stay behind the main PC");
  }

  private async goBack(ms: number, kill: { k: OnAirKill; tk: number } | null, why: string): Promise<void> {
    const conn = this.e.gameConsole.connection;
    const now = this.e.now();
    if (!conn?.connected) {
      this.status.rewind = { ...this.status.rewind, detail: "Can't go back: CS2's console isn't connected. Start CS2 from MatchFrame in a console mode." };
      this.stayNextAt = now + STAY_RETRY_MS;
      return;
    }
    const backMs = Math.round(Math.max(REWIND_MIN_MS, ms));
    this.rewindRun = { requestedMs: backMs, checkUntil: now + REWIND_CHECK_MS, idleSince: null, kills: kill ? [kill] : [] };
    this.status.rewind = { ...this.status.rewind, state: "rewinding", detail: `Going back ${sec(backMs)} ${why}…` };
    const lines: string[] = [];
    const off = conn.onLine((l) => lines.push(l));
    try {
      // Back from where CS2 is now (64 ticks a second: -448 is 7 s).
      await conn.write(`demo_gototick -${Math.round((backMs / 1000) * TICKRATE)} relative`);
      await new Promise((r) => setTimeout(r, 700));
    } catch (err) {
      lines.push(String(err));
    } finally {
      off();
    }
    if (lines.some((l) => REFUSED.test(l))) this.rewindUnsupported("CS2 can't go back here: going back works when watching CSTV, not when connected straight to the game server.");
  }

  private rewindUnsupported(detail: string): void {
    this.rewindRun.kills = [];
    this.status.rewind = { ...this.status.rewind, state: "unsupported", detail: `${detail} This computer films someone else instead.` };
    this.e.logger.info("replay PC: rewinding not available", { detail });
  }

  private checkRewind(now: number): void {
    const rw = this.status.rewind.state;
    if (rw === "holding") {
      // Staying behind, but back at the main PC's time (a reconnect, a map change): go back again shortly.
      if (this.status.timing.state === "live" || this.status.timing.state === "ahead") {
        this.status.rewind = { ...this.status.rewind, state: "ready", detail: "Back at the main PC's time (a reconnect or a map change?): going back again." };
        this.stayNextAt = now + STAY_RETRY_MS;
      }
      return;
    }
    if (rw !== "rewinding" && rw !== "rewound" && rw !== "returning") return;
    this.updateTiming(now);
    const d = this.status.timing.delayMs;
    if (rw === "rewinding") {
      if (d !== null && d >= LEAD_MIN_MS) {
        const staying = this.settings().sameCstv === "stay_behind";
        this.status.rewind = { ...this.status.rewind, state: staying ? "holding" : "rewound", detail: staying ? `Went back ${sec(d)} and stays there: missed kills are known before they play here.` : `Went back ${sec(d)}: filming the missed kill.`, count: this.status.rewind.count + 1 };
        this.stayNextAt = now + STAY_RETRY_MS;
        for (const { k, tk } of this.rewindRun.kills.splice(0)) this.plan(k, tk + d);
      } else if (now > this.rewindRun.checkUntil) {
        this.rewindUnsupported("CS2 didn't go back in time (demo_gototick).");
      }
      return;
    }
    if (rw === "rewound") {
      if (this.active || this.jobs.length) {
        this.rewindRun.idleSince = null;
        return;
      }
      this.rewindRun.idleSince ??= now;
      if (now - this.rewindRun.idleSince < RETURN_IDLE_MS) return;
      const back = d ?? this.rewindRun.requestedMs;
      this.rewindRun.checkUntil = now + RETURN_CHECK_MS;
      this.status.rewind = { ...this.status.rewind, state: "returning", detail: "Back to live…" };
      const conn = this.e.gameConsole.connection;
      void conn?.write(`demo_gototick ${Math.round((Math.max(0, back - 300) / 1000) * TICKRATE)} relative`).catch(() => undefined);
      return;
    }
    // Returning: live again, or CS2 stayed behind (then missed kills are still filmed, from behind).
    if (d !== null && Math.abs(d) < LEAD_MIN_MS) {
      this.status.rewind = { ...this.status.rewind, state: "ready", detail: "Back to live after filming the missed kill." };
    } else if (now > this.rewindRun.checkUntil) {
      this.status.rewind = { ...this.status.rewind, state: "ready", detail: d !== null ? `CS2 didn't skip forward: this computer stays ${sec(d)} behind and films missed kills from there.` : "Back to live." };
    }
  }

  // ---- extra angles: going back to film a moment again (ADR-081) -----------------------------------

  /** Rounds this computer is filming (or about to film) an extra angle of: the main PC's break waits a little for it. */
  private angleRounds(): number[] {
    const rounds = new Set<number>();
    if (this.pass) rounds.add(this.pass.req.round);
    if (this.settings().filmAngles && this.status.angles.state !== "unsupported") for (const r of this.angleAsks) if (this.nextView(r) && (this.anglesPerRound.get(r.round) ?? 0) < ANGLES_PER_ROUND && this.killsOf(r).length) rounds.add(r.round);
    return [...rounds].slice(0, 5);
  }

  /** The next view of a moment still to film, or null. */
  private nextView(r: AngleRequest): ReplayAngle | null {
    return r.views.find((v) => !this.angleDone.has(`${r.id}|${v}`)) ?? null;
  }

  /** The main PC's kills of a moment (its killer, its victims, its round), first to last. */
  private killsOf(r: AngleRequest): LoggedKill[] {
    return this.killLog.filter((k) => k.round === r.round && k.killer.steamId === r.killer.steamId && r.victims.includes(k.victim.name)).sort((a, b) => a.tk - b.tk);
  }

  /**
   * Why going back now for `passMs` (wall time) would cost a kill its lead-up, or null. No kill already
   * planned may start its lead-up before the pass is over and CS2 back. A kill the main PC reports
   * meanwhile plays here at least the delay later, and only once this computer's round is live: so the
   * later of the two must leave room for the pass and the whole lead-up (this computer's round over, or
   * far enough behind).
   */
  private angleWindow(now: number, passMs: number, d: number): string | null {
    const s = this.e.session.state();
    const st = this.settings();
    const need = passMs + ANGLE_RETURN_MARGIN_MS;
    if (this.jobs.some((j) => j.firstT - st.preRollMs - CUT_LEAD_MS < now + need)) return "a kill is planned too soon";
    const phase = s?.roundPhase ?? "live";
    const left = (s?.phaseEndsInSec ?? 0) * 1000;
    const liveIn = phase === "live" ? 0 : phase === "freezetime" ? left : left + ASSUMED_FREEZE_MS;
    if (Math.max(d, liveIn) < need + st.preRollMs + CUT_LEAD_MS) return phase === "live" ? "the round is live here, and this computer isn't far enough behind for a kill reported meanwhile to keep its lead-up" : "the next round starts here too soon";
    return null;
  }

  /** Starts filming an extra angle the main PC asked for, when one can be filmed now. */
  private maybeFilmAngle(now: number): void {
    const st = this.settings();
    if (!st.filmAngles || this.pass || this.active || this.pending.size || this.status.state !== "connected") return;
    if (this.status.angles.state === "unsupported") return;
    const rw = this.status.rewind.state;
    if (rw === "rewinding" || rw === "rewound" || rw === "returning" || rw === "unsupported") return;
    const d = this.status.timing.delayMs;
    if (this.status.timing.state !== "behind" || d === null) return;
    if (!this.e.gameConsole.connection?.connected) return;
    for (const r of this.angleAsks) {
      const view = this.nextView(r);
      if (!view || (this.anglesPerRound.get(r.round) ?? 0) >= ANGLES_PER_ROUND) continue;
      const kills = this.killsOf(r);
      if (!kills.length) continue;
      const firstAt = kills[0]!.tk + d;
      const lastAt = kills[kills.length - 1]!.tk + d;
      // It must have played here (and its end too) before it is filmed again.
      if (lastAt + ANGLE_POST_MS > now) continue;
      const backMs = Math.round(now - firstAt + ANGLE_LEAD_MS + ANGLE_SETTLE_MS);
      const passMs = ANGLE_SETTLE_MS + ANGLE_LEAD_MS + (lastAt - firstAt) + ANGLE_POST_MS;
      const label = `${replayLabel({ kind: "shown", killer: r.killer, victims: r.victims, kills: r.victims.length, weapon: null, headshot: false })} · ${VIEW_LABEL[view]}`;
      if (backMs > ANGLE_MAX_BACK_MS) {
        this.angleGiveUp(r, view, label, `it is ${sec(backMs)} back, further than a CSTV keeps`);
        continue;
      }
      const why = this.angleWindow(now, passMs, d);
      if (why) {
        this.status.angles = { ...this.status.angles, state: "ready", detail: `Waiting to film ${label}: ${why}.` };
        return;
      }
      this.startPass(r, view, label, kills, backMs, d, now);
      return;
    }
  }

  private angleGiveUp(r: AngleRequest, view: ReplayAngle, label: string, why: string): void {
    this.angleDone.add(`${r.id}|${view}`);
    this.status.angles = { ...this.status.angles, failed: this.status.angles.failed + 1, last: { label, at: new Date().toISOString(), ok: false, detail: why } };
    this.e.logger.info("replay PC: extra angle not filmed", { label, why });
  }

  private startPass(r: AngleRequest, view: ReplayAngle, label: string, kills: LoggedKill[], backMs: number, d: number, now: number): void {
    const conn = this.e.gameConsole.connection!;
    this.angleDone.add(`${r.id}|${view}`);
    this.anglesPerRound.set(r.round, (this.anglesPerRound.get(r.round) ?? 0) + 1);
    for (const k of this.anglesPerRound.keys()) if (k < r.round - 6) this.anglesPerRound.delete(k);
    const automatic = this.e.autoDirector.status().on || this.e.session.director.currentMode === "automatic";
    const pass: AnglePass = { req: r, view, label, kills, stage: "back", backMs, delayBefore: d, startedAt: now, landedAt: null, onTargetAt: null, expectAt: now + ANGLE_LEAD_MS + ANGLE_SETTLE_MS, seen: new Map(), prevPin: this.e.session.director.controls.pin, automatic, camera: false, queued: [], forwardUntil: 0, failed: null };
    this.pass = pass;
    this.status.filming = label;
    this.status.angles = { ...this.status.angles, state: "filming", detail: `Going back ${sec(backMs)} to film ${label}…` };
    this.e.session.director.avoid([], 0);
    void conn.write(`demo_gototick -${Math.round((backMs / 1000) * TICKRATE)} relative`).catch((err) => this.e.logger.warn("replay PC: going back for an extra angle failed", { error: String(err) }));
    // This computer's clock readings start over (CS2 jumped; across the round's end its phase changes too, which hides a jump).
    this.estimator.resetOwn();
    this.e.logger.info("replay PC: filming an extra angle", { label, backMs });
  }

  /** The camera on the angle: the player who died (pinned, or selected), or a free camera placed for the kill. */
  private aimPass(p: AnglePass): void {
    const victim = p.kills[0]!.victim;
    if (p.view === "victim") {
      if (p.automatic) this.e.session.pin({ kind: "player", steamId: victim.steamId });
      else void this.e.session.manualSelectPlayer(victim.steamId, "replay-pc", "device").catch((err) => this.e.logger.warn("replay PC: could not show the player who died", { error: String(err) }));
      return;
    }
    const s = this.e.session.state();
    const map = s?.mapName ? this.e.maps.get(s.mapName) : undefined;
    const grid = map?.grid ?? null;
    const at = this.killPos.get(killKey(p.req.round, p.req.killer.steamId, victim.steamId));
    // Where they stood at the kill (as this computer showed it), else where they stand now (just before it).
    const pos = (id: string, then: Vec3 | null | undefined) => then ?? s?.players.find((x) => x.steamId === id)?.position ?? null;
    const cam = grid && s?.mapName ? killCamera(s.mapName, pos(p.req.killer.steamId, at?.killer), pos(victim.steamId, at?.victim), grid, ANGLE_LEAD_MS + ANGLE_POST_MS + 2000) : null;
    if (!cam) {
      p.camera = false;
      return;
    }
    p.camera = true;
    void this.e.session.showCamera(cam, "replay-pc", ANGLE_LEAD_MS + ANGLE_POST_MS + 2000).catch((err) => this.e.logger.warn("replay PC: could not show the free camera", { error: String(err) }));
  }

  private tickPass(p: AnglePass, now: number): void {
    if (p.stage === "back") {
      if (p.landedAt === null) {
        if (now - p.startedAt > ANGLE_LAND_MS) return this.failPass(p, "CS2 didn't go back (demo_gototick)", true);
        return;
      }
      p.stage = "filming";
      // The kill plays again the lead-up and the settling time after CS2 lands (it may land a moment after the command).
      p.expectAt = Math.max(p.expectAt, p.landedAt + ANGLE_LEAD_MS + ANGLE_SETTLE_MS - 500);
      this.aimPass(p);
      if (p.view === "free" && !p.camera) return this.failPass(p, "no spot for a free camera (this map has no free-space grid here)", false);
      if (p.view === "free") p.onTargetAt = now;
      return;
    }
    if (p.stage === "filming") {
      const victims = p.kills.map((k) => k.victim.steamId);
      const all = victims.every((v) => p.seen.has(v));
      const span = p.kills[p.kills.length - 1]!.tk - p.kills[0]!.tk;
      if (!p.seen.size && now > p.expectAt + span + GRACE_MS) return this.failPass(p, "the kill didn't play again on this computer", false);
      const lastSeen = p.seen.size ? Math.max(...p.seen.values()) : 0;
      const finishAt = all ? lastSeen + ANGLE_POST_MS : p.expectAt + span + GRACE_MS + ANGLE_POST_MS;
      if (now < finishAt) return;
      const first = Math.min(...p.seen.values());
      const on = p.onTargetAt;
      if (on === null || on > first - 1000 || (p.view === "victim" && !this.stayedOn(p.kills[0]!.victim.steamId, on, first))) return this.failPass(p, `the camera wasn't on ${p.view === "victim" ? p.kills[0]!.victim.name : "the free camera"} for it`, false);
      const playFrom = Math.max(on + 300, first - ANGLE_LEAD_MS);
      const play: ReplayPlay = { kind: "shown", killer: p.req.killer, victims: p.req.victims, kills: p.req.victims.length, weapon: null, headshot: false };
      const killsMs = [...p.seen.values()].sort((a, b) => a - b).map((t) => Math.round(t - playFrom));
      const label = p.label;
      void this.send(play, Math.round(now - playFrom), p.req.round, Math.round(first - playFrom), { killsMs, angle: p.view, momentOf: p.req.id, label }).then((ok) => {
        this.status.angles = { ...this.status.angles, ...(ok ? { filmed: this.status.angles.filmed + 1 } : { failed: this.status.angles.failed + 1 }), last: { label, at: new Date().toISOString(), ok, detail: ok ? "Sent to the main PC." : "Filmed, but not sent (see the last clip)." } };
      });
      return this.forward(p, now);
    }
    // Going forward: back where it was (about as far behind as before), or CS2 stayed back.
    const d = this.status.timing.delayMs;
    this.updateTiming(now);
    if (d !== null && Math.abs(d - p.delayBefore) <= RETURN_TOLERANCE_MS) return this.endPass(p, "back");
    if (now > p.forwardUntil) return this.endPass(p, "stayed");
  }

  /** Done filming (or given up after going back): forward by as much as it went back. */
  private forward(p: AnglePass, now: number): void {
    this.releasePass(p);
    p.stage = "forward";
    p.forwardUntil = now + ANGLE_RETURN_MS;
    this.status.angles = { ...this.status.angles, detail: `Going forward ${sec(p.backMs)} again after ${p.label}…` };
    // As far as it is behind now beyond where it was (or as far as it went back), less a little: never ahead of where it was.
    const d = this.status.timing.delayMs;
    const extra = d !== null && d - p.delayBefore > LEAD_MIN_MS ? d - p.delayBefore : p.backMs;
    void this.e.gameConsole.connection?.write(`demo_gototick ${Math.round((Math.max(0, extra - 300) / 1000) * TICKRATE)} relative`).catch(() => undefined);
    this.estimator.resetOwn();
  }

  private failPass(p: AnglePass, why: string, notBack: boolean): void {
    p.failed = why;
    this.angleGiveUp(p.req, p.view, p.label, why);
    if (notBack) {
      // CS2 didn't go back: nothing to undo; and it won't, here (going back isn't available).
      this.releasePass(p);
      this.status.angles = { ...this.status.angles, state: "unsupported", detail: `Extra angles can't be filmed here: ${why}.` };
      return this.endPass(p, "not back");
    }
    this.forward(p, this.e.now());
  }

  /** The camera back as it was before the angle. */
  private releasePass(p: AnglePass): void {
    if (p.automatic) {
      if (p.view === "victim") this.e.session.pin(p.prevPin);
      // A free camera took the camera as a device: the director has it again.
      if (p.camera) this.e.session.resume(0);
    }
    p.camera = false;
  }

  private endPass(p: AnglePass, how: "back" | "stayed" | "not back" | "stopped"): void {
    if (this.pass !== p) return;
    if (p.stage !== "forward") this.releasePass(p);
    this.pass = null;
    this.status.filming = null;
    const d = this.status.timing.delayMs;
    if (how === "stayed") {
      this.status.angles = { ...this.status.angles, state: "unsupported", detail: `CS2 didn't go forward after ${p.label}: this computer stays ${d !== null ? sec(d) : "further"} behind, and films no more extra angles.` };
      this.e.logger.warn("replay PC: CS2 didn't go forward after an extra angle", { label: p.label, delayMs: d });
    } else if (how === "back") this.status.angles = { ...this.status.angles, state: "ready", detail: p.failed ? `Back where it was; ${p.label} not filmed: ${p.failed}.` : `Filmed ${p.label} and back where it was.` };
    // The main PC's kills reported meanwhile: planned now (with the delay as it is).
    for (const { k, tk } of p.queued.splice(0)) if (how !== "stopped") this.onMainKill(k, tk);
  }

  // ---- kills on this computer's camera (live with the main PC) -----------------------------------

  private onKill(k: HudKillfeedEntry): void {
    if (!k.killer || this.status.state !== "connected") return;
    const now = this.e.now();
    const killer = k.killer.steamId;
    const victim = k.victim.steamId;
    // The round being played, or the one just ended for a kill after it was won (the main PC's on-air kills say the same).
    const roundNumber = this.e.playRound();
    // Where the two stood (a free camera on the kill, ADR-081).
    const players = this.e.session.state()?.players ?? [];
    this.killPos.set(killKey(roundNumber, killer, victim), { killer: players.find((p) => p.steamId === killer)?.position ?? null, victim: players.find((p) => p.steamId === victim)?.position ?? null, at: now });
    for (const [key, v] of this.killPos) if (v.at < now - KILL_LOG_MS) this.killPos.delete(key);
    this.estimator.noteOwnKill(killKey(roundNumber, killer, victim), now);
    // Behind (or rewound), missed kills are planned from the main PC's list instead.
    if (this.status.timing.state === "behind" || this.status.rewind.state === "rewinding" || this.status.rewind.state === "rewound" || this.status.rewind.state === "returning") return;
    if (now - this.lastAnswerAt > FRESH_MS) return;
    // This computer must have had the killer on camera just before the kill.
    if (!showedDuring(this.ownHistory, killer, now - 1500, now)) return;
    // What the main camera had, as seen from here. The main PC's own verdict, when it reports kills, wins when the clip is sent.
    const seen: Shown = showedDuring(this.mainHistory, killer, now - SHOWN_WINDOW_MS, now) ? "killer" : showedDuring(this.mainHistory, victim, now - SHOWN_WINDOW_MS, now) ? "victim" : "none";
    if (seen === "killer" && !this.mainReportsKills) return;
    const key = killKey(roundNumber, killer, victim);
    const st = this.settings();
    const p = this.pending.get(killer);
    if (p && now - p.lastAt <= CHAIN_MS && now - p.firstAt <= MAX_SPAN_MS) {
      p.victims.push(k.victim.name);
      p.keys.push(key);
      p.seenOnMain.push(seen);
      p.lastAt = now;
      p.headshot ||= k.headshot === true;
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => void this.capture(killer), st.postRollMs);
      return;
    }
    const next: Pending = { killer: { steamId: killer, name: k.killer.name }, victims: [k.victim.name], weapon: k.weapon, headshot: k.headshot === true, keys: [key], seenOnMain: [seen], firstAt: now, lastAt: now, roundNumber, timer: null };
    next.timer = setTimeout(() => void this.capture(killer), st.postRollMs);
    this.pending.set(killer, next);
  }

  private async capture(killerId: string): Promise<void> {
    const p = this.pending.get(killerId);
    if (!p) return;
    this.pending.delete(killerId);
    const st = this.settings();
    const shown = p.keys.map((key, i) => this.mainVerdicts.get(key)?.shown ?? p.seenOnMain[i]!);
    if (shown.every((v) => v === "killer")) return;
    const play: ReplayPlay = { kind: shown.includes("none") ? "missed" : "other_angle", killer: p.killer, victims: p.victims, kills: p.victims.length, weapon: p.weapon, headshot: p.headshot };
    await this.send(play, Math.round(st.preRollMs + (p.lastAt - p.firstAt) + st.postRollMs), p.roundNumber, st.preRollMs);
  }

  /**
   * Sends a filmed kill to the main PC (`playMs`: the clip, ending now; `leadMs`: its part before the
   * first kill). With the replay feed the main PC cuts it from its recording of this screen, so only
   * the moment is sent; otherwise this computer's replay buffer is saved and the clip uploaded.
   */
  private async send(play: ReplayPlay, playMs: number, round: number | null, leadMs: number, extra: { killsMs?: number[]; angle?: ReplayAngle; momentOf?: string; label?: string } = {}): Promise<boolean> {
    const st = this.settings();
    const token = this.e.secrets.getSecret(SECRET_KEY);
    const label = extra.label ?? replayLabel(play);
    const killsMs = (extra.killsMs ?? []).filter((k) => k >= 0 && k <= playMs).slice(0, 5);
    const angle = extra.angle && extra.momentOf ? { angle: extra.angle, momentOf: extra.momentOf } : null;
    if (round !== null) this.sending.push(round);
    try {
      if (this.status.transport === "feed") {
        const lead = Math.max(0, Math.min(playMs, leadMs));
        const res = await fetch(`${st.mainUrl}/api/v1/replays/mark`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ label, kind: play.kind, round, kills: play.kills, killer: play.killer, victims: play.victims, weapon: play.weapon, headshot: play.headshot, fromAgoMs: playMs, killAgoMs: playMs - lead, endAgoMs: 0, ...(killsMs.length ? { killsAgoMs: killsMs.map((k) => playMs - k) } : {}), ...(angle ?? {}) }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          this.status = { ...this.status, sent: this.status.sent + 1, last: { label, at: new Date().toISOString(), ok: true, error: null } };
          this.e.logger.info("replay PC: marked a kill for the replay feed", { label, playMs, ...(angle ?? {}) });
          return true;
        }
        // The main PC stopped recording this screen: send the clip from this computer's OBS when it can.
        if (res.status !== 409 || !this.e.obs.state.connected) throw new Error(`the main PC answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (!this.e.obs.state.connected) throw new Error("OBS isn't connected on this computer");
      const { savedPath } = await this.e.obs.saveReplayBuffer();
      const body = readFileSync(savedPath);
      const ext = (extname(savedPath).slice(1) || "mp4").toLowerCase();
      const q = new URLSearchParams({ label, kind: play.kind, playMs: String(playMs), leadMs: String(Math.max(0, Math.min(playMs, leadMs))), ext, kills: String(play.kills), killer: play.killer?.steamId ?? "", killerName: play.killer?.name ?? "", victims: play.victims.join("\n"), weapon: play.weapon ?? "", headshot: play.headshot ? "1" : "0", ...(round !== null ? { round: String(round) } : {}), ...(killsMs.length ? { killsMs: killsMs.join(",") } : {}), ...(angle ?? {}) });
      const res = await fetch(`${st.mainUrl}/api/v1/replays/incoming?${q.toString()}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`the main PC answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      this.status = { ...this.status, sent: this.status.sent + 1, last: { label, at: new Date().toISOString(), ok: true, error: null } };
      this.e.logger.info("replay PC: sent a clip", { label, bytes: body.length, playMs, ...(angle ?? {}) });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.status = { ...this.status, failed: this.status.failed + 1, last: { label, at: new Date().toISOString(), ok: false, error } };
      this.e.logger.warn("replay PC: clip not sent", { label, error });
      return false;
    } finally {
      if (round !== null) this.sending.splice(this.sending.indexOf(round), 1);
    }
  }
}

/** "haze ▸ kite, saber (AWP)". */
export function replayLabel(p: ReplayPlay): string {
  const weapon = p.weapon ? ` (${p.weapon.replace(/^weapon_/, "").toUpperCase()})` : "";
  const who = p.killer?.name ?? "Unknown";
  const prefix = p.kills >= 3 ? `${p.kills}K: ` : "";
  return `${prefix}${who} ▸ ${p.victims.join(", ")}${weapon}`;
}

function jobLabel(j: Job): string {
  return replayLabel({ kind: j.kind, killer: j.killer, victims: j.victims.map((v) => v.name), kills: j.victims.length, weapon: j.weapon, headshot: j.headshot });
}

/** How much each kind of kill is worth filming (a merged clip takes the best of its kills). */
const KIND_RANK: Record<Job["kind"], number> = { missed: 2, other_angle: 1, shown: 0 };

function kindOf(k: OnAirKill): Job["kind"] {
  return k.shown === "none" ? "missed" : k.shown === "victim" ? "other_angle" : "shown";
}

/** More kills first, then a kill the main camera missed over another angle, over one it showed. */
function priority(j: Job): number {
  return j.victims.length * 10 + KIND_RANK[j.kind];
}

export function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  const url = new URL(u);
  if (!url.port) url.port = "37211";
  return `${url.protocol}//${url.host}`;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Camera histories reach back far enough for a replay PC up to two minutes behind. */
function trim(history: { at: number }[], now: number): void {
  while (history.length > 2 && history[1]!.at < now - 150_000) history.shift();
}
