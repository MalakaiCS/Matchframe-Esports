import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.ts";
import { BLOCK, type MixBlock } from "./mixer.ts";
import type { NdiReply, NdiRequest, NdiStats } from "./ndi-worker.ts";
import { PreviewHub } from "./preview.ts";
import { BEEP_AMP, BEEP_HZ, BEEP_RAMP_SAMPLES } from "./timing-test.ts";
import type { TeamComms } from "./service.ts";

/**
 * Where Team Comms' mixes leave the engine (ADR-066):
 *
 * - **public** → the NDI sender "MatchFrame Comms" (OBS receives it with DistroAV, into the program's
 *   audio). Its silence is enforced here, before NDI: while the public gate is closed the block sent
 *   is zeros whatever the mix holds (Mute All Comms closes the gate itself in 5 ms, in the mixer).
 * - **recording** → the NDI sender "MatchFrame Comms Recording" (the dedicated recording, ADR-068),
 *   at the recording's comms level (a gain ramped over each 10 ms block). Mute All Comms and the
 *   public gate never touch it.
 * - **preview** → the operator's headphones only, over the console's WebSocket (PreviewHub). Never
 *   NDI, never OBS.
 *
 * The NDI senders run in their own process (ndi-worker.ts) so a stall there can't block the engine;
 * if it stops while a listen-in is open, the controller closes the listen-in (FAULT). While it is down
 * nothing leaves for OBS (the public route is silent; the recording shows a fault): it is started
 * again after RESTART_MS, doubling each time it stops again soon after (up to MAX_RESTART_MS), back
 * to RESTART_MS once it has run STABLE_MS. The status says how many restarts, the last exit and when
 * the next try is.
 */

export const PUBLIC_NDI_NAME = "MatchFrame Comms";
export const RECORDING_NDI_NAME = "MatchFrame Comms Recording";
export const RESTART_MS = 3000;
export const MAX_RESTART_MS = 30_000;
/** Running this long without stopping resets the back-off. */
export const STABLE_MS = 60_000;

export interface NdiWorkerLike {
  send(req: NdiRequest): void;
  onMessage(fn: (r: NdiReply) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

/** The NDI process: comms-ndi-worker.mjs next to the bundled engine, or ndi-worker.ts in development (Node runs it as is). */
export function forkNdiWorker(): NdiWorkerLike {
  const here = dirname(fileURLToPath(import.meta.url));
  const mjs = join(here, "comms-ndi-worker.mjs");
  const entry = existsSync(mjs) ? mjs : join(here, "ndi-worker.ts");
  const child = fork(entry, [], { execArgv: [], env: { ...process.env, MATCHFRAME_COMMS_NDI_WORKER: "1" }, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced" });
  let err = "";
  child.stderr?.on("data", (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
  const exits: ((code: number | null) => void)[] = [];
  child.on("exit", (code) => {
    for (const fn of exits) fn(code);
  });
  return {
    send: (req) => void (child.connected ? child.send(req) : undefined),
    onMessage: (fn) => void child.on("message", (m) => fn(m as NdiReply)),
    onExit: (fn) => void exits.push((code) => fn(code ?? (err ? -1 : null))),
    kill: () => void child.kill(),
  };
}

export interface NdiSettings {
  enabled: boolean;
  latencyMs: number;
  clockAudio: boolean;
}

export interface OutputsStatus {
  ndi: {
    enabled: boolean;
    state: "off" | "starting" | "running" | "error";
    detail: string;
    version: string | null;
    names: { public: string; recording: string };
    stats: NdiStats | null;
    /** The NDI process stopped by itself this many times since Team Comms started it. */
    restarts: number;
    lastExit: { code: number | null; at: string; ranMs: number } | null;
    /** While stopped: when it is started again (ms from now), and the back-off in effect. */
    nextStartInMs: number | null;
    backoffMs: number;
  };
  /** Blocks sent as zeros because the public gate was closed. */
  publicGuard: { blocksSilenced: number };
  preview: ReturnType<PreviewHub["status"]>;
}

export interface CommsOutputsDeps {
  comms: TeamComms;
  logger: Pick<Logger, "info" | "warn">;
  settings: () => NdiSettings;
  /** Wall time (ms since 1970, sub-ms) of a timeline sample: the engine's timeline is performance.now(). */
  wallOf?: (startSample: number) => number;
  spawnWorker?: () => NdiWorkerLike;
  /** The NDI output stopped or failed while it should run (the controller closes a listen-in). */
  onFault?: (reason: string) => void;
  /** The computer's clock (ms since 1970) for the restart back-off (tests). */
  wallNow?: () => number;
}

export class CommsOutputs {
  readonly preview = new PreviewHub();
  private blocksSilenced = 0;
  private lastClosed = true;
  private worker: NdiWorkerLike | null = null;
  private ndiState: OutputsStatus["ndi"]["state"] = "off";
  private ndiDetail = "Team Comms is off.";
  private ndiVersion: string | null = null;
  private stats: NdiStats | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** After the process stopped: not started again before this (wall ms), unless asked to. */
  private restartAfter = 0;
  private backoff = RESTART_MS;
  private restarts = 0;
  private lastExit: OutputsStatus["ndi"]["lastExit"] = null;
  private runningSince: number | null = null;
  private readonly taps = new Set<(samples: Float32Array, start: number, block: MixBlock) => void>();
  private readonly recTaps = new Set<(samples: Float32Array, start: number, block: MixBlock) => void>();
  /** The recording's comms level as a gain: where the last block ended, and where the next goes. */
  private recGain = 1;
  private recGainTarget = 1;
  private readonly off: () => void;
  private generation = 0;
  /** The timing test's beeps (timeline samples), added to the recording output only. */
  private beeps: { start: number; end: number }[] = [];

  constructor(private readonly d: CommsOutputsDeps) {
    this.off = d.comms.onBlock((b) => this.onBlock(b));
  }

  /** The guarded public output as it leaves for NDI (tests, the console's on-air meter). */
  onPublic(fn: (samples: Float32Array, start: number, block: MixBlock) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  /** The recording mix as it leaves for NDI, at the comms level (tests, the real-OBS rig). */
  onRecording(fn: (samples: Float32Array, start: number, block: MixBlock) => void): () => void {
    this.recTaps.add(fn);
    return () => this.recTaps.delete(fn);
  }

  /**
   * The timing test (comms/timing-test.ts): a BEEP_HZ tone in the recording output over these
   * timeline sample ranges, at a fixed level after the comms level. Never the public output or the
   * preview, never the mixes (so no activity sees it).
   */
  setBeeps(beeps: { start: number; end: number }[]): void {
    this.beeps = beeps.map((b) => ({ ...b }));
  }

  /** The dedicated recording's comms level (dB; −60 or less: off). Ramped over the next block. */
  setRecordingGainDb(db: number): void {
    this.recGainTarget = db <= -60 ? 0 : 10 ** (db / 20);
  }

  private wall(): number {
    return this.d.wallNow ? this.d.wallNow() : Date.now();
  }

  private wallOf(start: number): number {
    return this.d.wallOf ? this.d.wallOf(start) : performance.timeOrigin + start / 48;
  }

  private onBlock(b: MixBlock): void {
    // The gate closed for the whole block (closed at its end, and at its start: the block before ended closed): zeros, whatever the mix holds.
    const closed = b.public.team === null && this.lastClosed;
    this.lastClosed = b.public.team === null;
    const pub = new Float32Array(BLOCK);
    if (closed) this.blocksSilenced++;
    else pub.set(b.out.public);
    for (const fn of this.taps) fn(pub, b.start, b);
    let rec = b.out.recording;
    if (this.recGain !== 1 || this.recGainTarget !== 1) {
      rec = new Float32Array(BLOCK);
      const from = this.recGain;
      const step = (this.recGainTarget - from) / BLOCK;
      for (let i = 0; i < BLOCK; i++) rec[i] = b.out.recording[i]! * (from + step * (i + 1));
      this.recGain = this.recGainTarget;
    }
    if (this.beeps.length) {
      const end = b.start + BLOCK;
      for (const bp of this.beeps) {
        if (bp.start >= end || bp.end <= b.start) continue;
        if (rec === b.out.recording) rec = Float32Array.from(rec);
        for (let i = 0; i < BLOCK; i++) {
          const s = b.start + i;
          if (s < bp.start || s >= bp.end) continue;
          const k = s - bp.start;
          const env = Math.min(1, k / BEEP_RAMP_SAMPLES, (bp.end - s) / BEEP_RAMP_SAMPLES);
          rec[i] = rec[i]! + BEEP_AMP * env * Math.sin((2 * Math.PI * BEEP_HZ * k) / 48_000);
        }
      }
      this.beeps = this.beeps.filter((bp) => bp.end > end);
    }
    for (const fn of this.recTaps) fn(rec, b.start, b);
    if (this.worker && this.ndiState !== "error") this.worker.send({ type: "block", start: b.start, wallMs: this.wallOf(b.start), pub, rec });
    this.preview.push(b.out.preview, b.start);
  }

  /** Starts or stops the NDI process for Team Comms on/off and the NDI setting (`now`: start it again without waiting out the back-off). */
  sync(now = false): void {
    const want = this.d.comms.enabled && this.d.settings().enabled;
    if (want && !this.worker && !now && this.wall() < this.restartAfter) return;
    if (want && !this.worker) this.startWorker();
    else if (!want && this.worker) this.stopWorker(this.d.comms.enabled ? "The NDI output is off (Team Comms → Public output)." : "Team Comms is off.");
    else if (!want) this.ndiDetail = this.d.comms.enabled ? "The NDI output is off (Team Comms → Public output)." : "Team Comms is off.";
  }

  /** The NDI settings changed (latency, clocking): the process starts again with them. */
  restart(): void {
    if (this.worker) this.stopWorker("Restarting with the new settings.");
    this.sync(true);
  }

  private startWorker(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const gen = ++this.generation;
    const w = (this.d.spawnWorker ?? forkNdiWorker)();
    this.worker = w;
    this.ndiState = "starting";
    this.ndiDetail = `Starting the NDI senders “${PUBLIC_NDI_NAME}” and “${RECORDING_NDI_NAME}”…`;
    this.stats = null;
    w.onMessage((r) => {
      if (gen !== this.generation) return;
      if (r.type === "stats") this.stats = r.stats;
      else if (r.type === "status") {
        this.ndiVersion = r.ndi ?? this.ndiVersion;
        if (r.state === "running") {
          this.ndiState = "running";
          this.runningSince = this.wall();
          this.ndiDetail = `Sending “${PUBLIC_NDI_NAME}” and “${RECORDING_NDI_NAME}” (${r.ndi ?? "NDI"}).`;
          this.d.logger.info("team comms: NDI output running", { ndi: r.ndi });
        } else if (r.state === "error") {
          this.ndiState = "error";
          this.ndiDetail = r.error ?? "The NDI output failed.";
          this.d.logger.warn("team comms: NDI output failed", { error: r.error });
          this.d.onFault?.(`the public output (NDI) failed: ${this.ndiDetail}`);
        }
      }
    });
    const startedAt = this.wall();
    w.onExit((code) => {
      if (gen !== this.generation || this.worker !== w) return;
      const now = this.wall();
      const ranMs = now - (this.runningSince ?? startedAt);
      this.worker = null;
      this.runningSince = null;
      this.restarts++;
      // Stopped again soon after a start: wait longer each time; after a long good run, the shortest wait.
      this.backoff = ranMs >= STABLE_MS ? RESTART_MS : this.lastExit ? Math.min(MAX_RESTART_MS, this.backoff * 2) : RESTART_MS;
      this.lastExit = { code, at: new Date(now).toISOString(), ranMs: Math.round(ranMs) };
      this.ndiState = "error";
      this.ndiDetail = `The NDI output process stopped (exit ${code ?? "killed"}${this.restarts > 1 ? `, ${this.restarts} times` : ""}): nothing reaches OBS. Starting it again in ${Math.round(this.backoff / 1000)} s.`;
      this.d.logger.warn("team comms: NDI output process stopped", { code, restarts: this.restarts, backoffMs: this.backoff });
      this.d.onFault?.("the public output (NDI) process stopped");
      this.restartAfter = now + this.backoff;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.sync(), this.backoff);
      this.restartTimer.unref?.();
    });
    const s = this.d.settings();
    w.send({ type: "start", options: { publicName: PUBLIC_NDI_NAME, recordingName: RECORDING_NDI_NAME, latencyMs: s.latencyMs, clockAudio: s.clockAudio } });
  }

  private stopWorker(detail: string): void {
    this.generation++;
    const w = this.worker;
    this.worker = null;
    this.runningSince = null;
    w?.send({ type: "stop" });
    w?.kill();
    this.ndiState = "off";
    this.ndiDetail = detail;
    this.stats = null;
  }

  /** Why the public output can't carry comms now (null: it can, or the operator turned NDI off). */
  problem(): string | null {
    if (!this.d.comms.enabled || !this.d.settings().enabled) return null;
    if (this.ndiState === "running") return null;
    if (this.ndiState === "starting") return `The public output (NDI “${PUBLIC_NDI_NAME}”) is starting.`;
    return `The public output (NDI “${PUBLIC_NDI_NAME}”) isn't running: ${this.ndiDetail}`;
  }

  /** The NDI output should run and failed (not merely starting). */
  get failed(): boolean {
    return this.d.comms.enabled && this.d.settings().enabled && this.ndiState === "error";
  }

  status(): OutputsStatus {
    const s = this.d.settings();
    const waiting = !this.worker && this.ndiState === "error" && this.restartAfter > 0 ? Math.max(0, this.restartAfter - this.wall()) : null;
    return {
      ndi: { enabled: s.enabled, state: this.ndiState, detail: this.ndiDetail, version: this.ndiVersion, names: { public: PUBLIC_NDI_NAME, recording: RECORDING_NDI_NAME }, stats: this.stats, restarts: this.restarts, lastExit: this.lastExit, nextStartInMs: waiting, backoffMs: this.backoff },
      publicGuard: { blocksSilenced: this.blocksSilenced },
      preview: this.preview.status(),
    };
  }

  stop(): void {
    this.off();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.worker) this.stopWorker("Stopped.");
    this.preview.close();
  }
}
