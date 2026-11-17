import type { HudOutputMode, LowSpecStatus } from "@matchframe/contracts";
import { hudOutputStutters } from "@matchframe/contracts/smoothness";
import { getHeapStatistics } from "node:v8";
import type { Logger } from "./logger.ts";

/**
 * Low-spec mode (one PC, ADR-078): CS2, OBS and MatchFrame on one computer. Off by default. While on:
 * HUD outputs and the desktop HUD draw at most LOW_SPEC_FPS frames a second, MatchFrame HUDs drop
 * expensive effects (`HudState.lowSpec`), HUD pushes that change nothing are skipped, heavy background
 * jobs wait for the live round to end, ffmpeg uses lighter presets, and the browser sources MatchFrame
 * made in OBS draw at the cap. The program (apps/desktop) starts the engine with a memory cap.
 */

/** Settings key: whether low-spec mode is on. */
export const LOW_SPEC_KEY = "performance.lowSpec";
/** Settings key: the suggestion's state ({ state: "shown" | "dismissed" | "accepted", reason, at }). */
export const LOW_SPEC_SUGGESTION_KEY = "performance.lowSpecSuggestion";
/** Settings key: OBS browser sources' frame-rate settings before low-spec mode changed them, by source name. */
export const OBS_FPS_BEFORE_KEY = "performance.obsFpsBefore";
/** Frames a second HUD outputs and the desktop HUD draw at most in low-spec mode. */
export const LOW_SPEC_FPS = 30;
/** Game data from this computer this recently: CS2 runs here. */
const SAME_PC_MS = 30_000;
/** Stuttering reports from desktop or OBS outputs within this long … */
const STUTTER_WINDOW_MS = 60_000;
/** … this many of them, while CS2 runs here, are the reason to suggest it (one slow moment is not). */
const STUTTER_REPORTS = 2;
/** How often waiting heavy work checks whether the round is still live. */
const DEFER_POLL_MS = 2000;

type SuggestionRecord = { state: "shown" | "dismissed" | "accepted"; reason: string | null; at: string };

export interface LowSpecDeps {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void };
  /** A real round is live (game data, not the simulation; not freeze time or the round's end). */
  roundLive: () => boolean;
  /** The memory cap the program started this engine with (MATCHFRAME_ENGINE_HEAP_CAP_MB), or null. */
  heapCapMb?: number | null;
  now?: () => number;
  logger?: Pick<Logger, "info">;
}

export class LowSpecMode {
  private readonly listeners = new Set<(on: boolean) => void>();
  private gameHereAt: number | null = null;
  private stutters: number[] = [];
  /** The setting, read once (every HUD push asks; only set() changes it). */
  private cached: boolean | null = null;
  /** The suggestion's record, read once (every operator snapshot asks; only this class writes it). */
  private record: SuggestionRecord | null | undefined = undefined;
  private readonly now: () => number;
  /** Set by the engine: what the OBS part reports for the status. */
  obsStatus: () => LowSpecStatus["obs"] = () => ({ connected: false, sources: [], error: null });

  constructor(private readonly d: LowSpecDeps) {
    this.now = d.now ?? Date.now;
  }

  get on(): boolean {
    this.cached ??= this.d.settings.get<boolean>(LOW_SPEC_KEY, false) === true;
    return this.cached;
  }

  /** Turns it on or off; listeners run when it changed. Returns whether it changed. */
  set(on: boolean): boolean {
    if (on === this.on) return false;
    this.d.settings.set(LOW_SPEC_KEY, on);
    this.cached = on;
    // Turned on (from the suggestion or Settings): the suggestion has done its job and never comes back.
    if (on) this.saveRecord("accepted", this.suggestionRecord()?.reason ?? null);
    this.d.logger?.info(on ? "low-spec mode on" : "low-spec mode off", { frameCap: this.frameCap() });
    for (const fn of this.listeners) fn(on);
    return true;
  }

  onChange(fn: (on: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The frame cap for HUD outputs and the desktop HUD, or null when off. */
  frameCap(): number | null {
    return this.on ? LOW_SPEC_FPS : null;
  }

  // ------------------------------------------------------------------ heavy background work

  /** Heavy background work waits now: low-spec mode is on and a round is live. */
  deferHeavy(): boolean {
    return this.on && this.d.roundLive();
  }

  /**
   * Waits until heavy work may run (low-spec mode off, or no round live). `onWait` runs once when it
   * has to wait. Resolves false when `cancelled()` became true meanwhile.
   */
  async whenHeavyAllowed(opts: { cancelled?: () => boolean; onWait?: () => void; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let told = false;
    while (this.deferHeavy()) {
      if (opts.cancelled?.()) return false;
      if (!told) opts.onWait?.();
      told = true;
      await sleep(opts.pollMs ?? DEFER_POLL_MS);
    }
    return !opts.cancelled?.();
  }

  // ------------------------------------------------------------------ the suggestion

  /** Game data arrived; `fromThisComputer` when it came from a loopback address (CS2 on this PC). */
  noteGameData(fromThisComputer: boolean): void {
    if (fromThisComputer) this.gameHereAt = this.now();
  }

  cs2OnThisComputer(): boolean {
    return this.gameHereAt !== null && this.now() - this.gameHereAt < SAME_PC_MS;
  }

  /** A HUD output's frame report (every 5 s, where it runs). Desktop and OBS outputs count; previews don't. */
  noteOutputPerf(mode: HudOutputMode, r: { fps: number; worstMs: number; frameCap: number | null }): void {
    if (mode === "preview" || this.on) return;
    if (!hudOutputStutters({ fps: r.fps, worstPauseMs: r.worstMs, frameCap: r.frameCap })) return;
    const now = this.now();
    this.stutters = [...this.stutters.filter((t) => now - t < STUTTER_WINDOW_MS), now];
    if (this.stutters.length < STUTTER_REPORTS || !this.cs2OnThisComputer() || this.suggestionRecord()) return;
    const where = mode === "desktop" ? "The desktop HUD" : "A HUD in OBS";
    const reason = `${where} stuttered while CS2 runs on this computer (${r.fps} fps, longest pause ${r.worstMs} ms).`;
    this.saveRecord("shown", reason);
    this.d.logger?.info("low-spec mode suggested", { reason });
  }

  /** Whether it was suggested, dismissed or taken (null: never suggested). */
  private suggestionRecord(): SuggestionRecord | null {
    if (this.record === undefined) {
      const v = this.d.settings.get<SuggestionRecord | null>(LOW_SPEC_SUGGESTION_KEY, null);
      this.record = v && typeof v === "object" && typeof v.state === "string" ? v : null;
    }
    return this.record;
  }

  private saveRecord(state: SuggestionRecord["state"], reason: string | null): void {
    this.record = { state, reason, at: new Date(this.now()).toISOString() };
    this.d.settings.set(LOW_SPEC_SUGGESTION_KEY, this.record);
  }

  /** The suggestion to show, or null (nothing to suggest, already on, dismissed or taken). */
  suggestion(): LowSpecStatus["suggestion"] {
    const rec = this.suggestionRecord();
    return rec?.state === "shown" && !this.on ? { reason: rec.reason ?? "HUD outputs stuttered while CS2 runs on this computer.", at: rec.at } : null;
  }

  /** The operator dismissed it: it is never shown again. */
  dismissSuggestion(): void {
    if (this.suggestionRecord()?.state === "accepted") return;
    this.saveRecord("dismissed", this.suggestionRecord()?.reason ?? null);
  }

  status(): LowSpecStatus {
    const heap = getHeapStatistics();
    const mb = (b: number) => Math.round(b / (1024 * 1024));
    return {
      lowSpec: this.on,
      frameCap: this.frameCap(),
      suggestion: this.suggestion(),
      cs2OnThisComputer: this.cs2OnThisComputer(),
      deferring: this.deferHeavy(),
      engine: { heapLimitMb: mb(heap.heap_size_limit), heapCapMb: this.d.heapCapMb ?? null, heapUsedMb: mb(heap.used_heap_size), rssMb: mb(process.memoryUsage.rss()) },
      obs: this.obsStatus(),
    };
  }
}

/** The OBS calls the frame cap needs (packages/obs-adapter's ObsManager). */
export interface ObsForFrameCap {
  readonly state: { connected: boolean; inputs: { name: string; kind: string }[] };
  inputSettings(inputName: string): Promise<{ kind: string; settings: Record<string, unknown> }>;
  setInputSettings(inputName: string, settings: Record<string, unknown>, overlay?: boolean): Promise<void>;
  on(event: "connected" | "state", fn: () => void): unknown;
}

type FpsSetting = { custom: boolean; fps: number };

/**
 * The browser sources MatchFrame made in OBS (the HUD, the replay graphic, Team Comms' overlay and
 * strip, found by name) draw at the frame cap while low-spec mode is on: OBS's "Use custom frame rate"
 * on and FPS 30, over OBS websocket. What they had before is kept and put back when it is turned off.
 * Applied when the mode changes, when OBS connects and when one of those sources appears.
 */
export class ObsFrameCap {
  private running: Promise<void> | null = null;
  private again = false;
  private lastKey = "";
  private sources: string[] = [];
  private error: string | null = null;

  constructor(
    private readonly d: {
      obs: ObsForFrameCap;
      settings: LowSpecDeps["settings"];
      /** Names of the browser sources MatchFrame makes (every spelling it finds them under). */
      names: () => string[];
      frameCap: () => number | null;
      logger?: Pick<Logger, "info" | "warn">;
    },
  ) {}

  /** Follows OBS: applies on connect and when MatchFrame's sources appear or go. */
  attach(): void {
    this.d.obs.on("connected", () => void this.apply());
    this.d.obs.on("state", () => {
      const key = this.targets().join("\u0000");
      if (key !== this.lastKey) void this.apply();
    });
  }

  status(): LowSpecStatus["obs"] {
    return { connected: this.d.obs.state.connected, sources: this.d.obs.state.connected ? [...this.sources] : [], error: this.error };
  }

  private targets(): string[] {
    if (!this.d.obs.state.connected) return [];
    const names = new Set(this.d.names());
    return this.d.obs.state.inputs
      .filter((i) => i.kind === "browser_source" && names.has(i.name))
      .map((i) => i.name)
      .sort();
  }

  /** Sets every MatchFrame browser source to the cap (or back). One pass at a time; a call during a pass runs another after it. */
  apply(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.pass();
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async pass(): Promise<void> {
    const targets = this.targets();
    this.lastKey = targets.join("\u0000");
    if (!this.d.obs.state.connected) return;
    const cap = this.d.frameCap();
    const before = { ...this.d.settings.get<Record<string, FpsSetting>>(OBS_FPS_BEFORE_KEY, {}) };
    // Off, with nothing to put back: no request to OBS at all.
    if (cap === null && Object.keys(before).length === 0) {
      this.sources = [];
      this.error = null;
      return;
    }
    const done: string[] = [];
    let error: string | null = null;
    for (const name of targets) {
      try {
        const now = readFps((await this.d.obs.inputSettings(name)).settings);
        if (cap !== null) {
          if (!(now.custom && now.fps === cap)) {
            before[name] ??= now;
            await this.d.obs.setInputSettings(name, { fps_custom: true, fps: cap });
          }
          done.push(name);
        } else if (before[name]) {
          const was = before[name];
          if (now.custom !== was.custom || now.fps !== was.fps) await this.d.obs.setInputSettings(name, { fps_custom: was.custom, fps: was.fps });
          delete before[name];
        }
      } catch (e) {
        error = `${name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    this.d.settings.set(OBS_FPS_BEFORE_KEY, before);
    this.sources = done;
    this.error = error;
    if (error) this.d.logger?.warn("low-spec mode: an OBS browser source's frame rate could not be set", { error });
    else if (targets.length) this.d.logger?.info(cap !== null ? "low-spec mode: OBS browser sources capped" : "low-spec mode: OBS browser sources restored", { sources: targets, fps: cap });
  }
}

/** A browser source's frame-rate settings (OBS leaves defaults out: custom off, 30 fps). */
function readFps(s: Record<string, unknown>): FpsSetting {
  return { custom: s.fps_custom === true, fps: typeof s.fps === "number" && Number.isFinite(s.fps) ? s.fps : 30 };
}

/** A socket's remote address is this computer (IPv4 loopback, also IPv4-mapped, or IPv6 loopback). */
export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** The memory cap the program passed (MATCHFRAME_ENGINE_HEAP_CAP_MB), or null. */
export function heapCapFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const n = Number(env.MATCHFRAME_ENGINE_HEAP_CAP_MB);
  return Number.isInteger(n) && n > 0 ? n : null;
}
