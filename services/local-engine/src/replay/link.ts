import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { z } from "zod";
import type { MatchState } from "@matchframe/contracts";
import type { Pin } from "@matchframe/director-policy";
import type { HudKillfeedEntry } from "@matchframe/hud-sdk";
import type { ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";
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
    return { ...this.status, obsReady: this.e.obs.state.connected && this.e.obs.state.replayBuffer === true, planned: this.jobs.length };
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
    for (const p of s.players) {
      const alive = p.lifeState === "alive";
      if (j && !alive && this.alive.get(p.steamId) === true && j.victims.some((v) => v.steamId === p.steamId) && !j.seen.has(p.steamId)) j.seen.set(p.steamId, now);
      this.alive.set(p.steamId, alive);
    }
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
      const res = await fetch(`${st.mainUrl}/api/v1/replay-link/on-air?pending=${this.pendingRounds().join(",")}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2000) });
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
      }
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
    void this.send(play, Math.round(now - playFrom), j.round, Math.round(first - playFrom));
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
      this.status.rewind = { ...this.status.rewind, detail: "Can't go back: CS2's console isn't connected. Start CS2 from Matchframe in a console mode." };
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

  // ---- kills on this computer's camera (live with the main PC) -----------------------------------

  private onKill(k: HudKillfeedEntry): void {
    if (!k.killer || this.status.state !== "connected") return;
    const now = this.e.now();
    const killer = k.killer.steamId;
    const victim = k.victim.steamId;
    const roundNumber = this.e.session.state()?.roundNumber ?? null;
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
  private async send(play: ReplayPlay, playMs: number, round: number | null, leadMs: number): Promise<void> {
    const st = this.settings();
    const token = this.e.secrets.getSecret(SECRET_KEY);
    const label = replayLabel(play);
    if (round !== null) this.sending.push(round);
    try {
      if (this.status.transport === "feed") {
        const lead = Math.max(0, Math.min(playMs, leadMs));
        const res = await fetch(`${st.mainUrl}/api/v1/replays/mark`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ label, kind: play.kind, round, kills: play.kills, killer: play.killer, victims: play.victims, weapon: play.weapon, headshot: play.headshot, fromAgoMs: playMs, killAgoMs: playMs - lead, endAgoMs: 0 }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          this.status = { ...this.status, sent: this.status.sent + 1, last: { label, at: new Date().toISOString(), ok: true, error: null } };
          this.e.logger.info("replay PC: marked a kill for the replay feed", { label, playMs });
          return;
        }
        // The main PC stopped recording this screen: send the clip from this computer's OBS when it can.
        if (res.status !== 409 || !this.e.obs.state.connected) throw new Error(`the main PC answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      if (!this.e.obs.state.connected) throw new Error("OBS isn't connected on this computer");
      const { savedPath } = await this.e.obs.saveReplayBuffer();
      const body = readFileSync(savedPath);
      const ext = (extname(savedPath).slice(1) || "mp4").toLowerCase();
      const q = new URLSearchParams({ label, kind: play.kind, playMs: String(playMs), leadMs: String(Math.max(0, Math.min(playMs, leadMs))), ext, kills: String(play.kills), killer: play.killer?.steamId ?? "", killerName: play.killer?.name ?? "", victims: play.victims.join("\n"), weapon: play.weapon ?? "", headshot: play.headshot ? "1" : "0", ...(round !== null ? { round: String(round) } : {}) });
      const res = await fetch(`${st.mainUrl}/api/v1/replays/incoming?${q.toString()}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`the main PC answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      this.status = { ...this.status, sent: this.status.sent + 1, last: { label, at: new Date().toISOString(), ok: true, error: null } };
      this.e.logger.info("replay PC: sent a clip", { label, bytes: body.length, playMs });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.status = { ...this.status, failed: this.status.failed + 1, last: { label, at: new Date().toISOString(), ok: false, error } };
      this.e.logger.warn("replay PC: clip not sent", { label, error });
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
