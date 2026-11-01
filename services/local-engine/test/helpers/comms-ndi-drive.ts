import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BLOCK, type MixBlock } from "../../src/comms/mixer.ts";
import { CommsOutputs, forkNdiWorker, PUBLIC_NDI_NAME, RECORDING_NDI_NAME } from "../../src/comms/outputs.ts";
import type { NdiStats } from "../../src/comms/ndi-worker.ts";
import type { TeamComms } from "../../src/comms/service.ts";

/**
 * Team Comms' real NDI path, end to end in real time (ADR-066): the engine's outputs (the public
 * guard and the NDI process, comms/ndi-worker.ts, forked as the engine forks it) fed 10 ms blocks
 * the way the engine renders them (every 5 ms, whatever has ended), and a real NDI receiver in
 * another process (comms-ndi-receiver.ts), as DistroAV in OBS would be.
 *
 * What is sent: the public mix holds a 1 kHz burst (100 ms) every 500 ms and the recording mix a
 * 600 Hz burst every 500 ms (250 ms later). The public gate is closed for the first second, open
 * until half way, then closed again; while closed the public mix still holds its bursts, so any
 * burst received then would be a leak past Matchframe's guard.
 */

const here = dirname(fileURLToPath(import.meta.url));
const wall = () => performance.timeOrigin + performance.now();

export interface FrameLine {
  type: "frame";
  s: number;
  at: number;
  n: number;
  rate: number;
  ch: number;
  fmt: number;
  onset: number;
  peak: number;
  zero: boolean;
  same: boolean;
}

export interface NdiRunResult {
  found: { want: string; name: string }[];
  findMs: number;
  durationMs: number;
  frames: { public: FrameLine[]; recording: FrameLine[] };
  perf: { public: { total: { audioFrames: number }; dropped: { audioFrames: number } } | null; recording: { total: { audioFrames: number }; dropped: { audioFrames: number } } | null };
  sent: { public: { wall: number; open: boolean }[]; recording: { wall: number }[] };
  /** Received bursts matched to what was sent: latency from the block's own time to arrival (ms). */
  latency: { public: number[]; recording: number[] };
  /** Public sound received that belongs to a burst sent while the gate was closed (must be 0). */
  leaked: number;
  /** Onsets that belong to no burst sent (a burst cut by a gap starts again: counted here, not as a leak). */
  unexplained: { public: number; recording: number };
  /** Bursts heard with a gap inside (an underrun or a skip while they played). */
  broken: { public: number; recording: number };
  /** Open-gate public bursts not received. */
  missedPublic: number;
  missedRecording: number;
  workerStats: NdiStats | null;
  receiverError: string | null;
  ndiVersion: string | null;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

export const summary = (xs: number[]) => ({ n: xs.length, median: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : NaN, min: xs.length ? Math.min(...xs) : NaN });

export async function runNdi(o: { ms: number; latencyMs?: number; clockAudio?: boolean; log?: (s: string) => void }): Promise<NdiRunResult> {
  const listeners: ((b: MixBlock) => void)[] = [];
  const comms = { enabled: true, onBlock: (fn: (b: MixBlock) => void) => (listeners.push(fn), () => undefined) } as unknown as TeamComms;
  const outputs = new CommsOutputs({ comms, logger: { info: () => undefined, warn: (m, d) => o.log?.(`${m} ${JSON.stringify(d)}`) }, settings: () => ({ enabled: true, latencyMs: o.latencyMs ?? 60, clockAudio: o.clockAudio ?? false }), spawnWorker: forkNdiWorker, wallOf: (s) => performance.timeOrigin + s / 48 });
  outputs.sync();
  const t0 = Date.now();
  while (outputs.status().ndi.state !== "running") {
    if (outputs.status().ndi.state === "error" || Date.now() - t0 > 15_000) {
      outputs.stop();
      throw new Error(`NDI output didn't start: ${outputs.status().ndi.detail}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const ndiVersion = outputs.status().ndi.version;

  const sent: NdiRunResult["sent"] = { public: [], recording: [] };
  let nextStart: number | null = null;
  let tStart = 0;
  let pubPhase = 0;
  let recPhase = 0;
  const tick = () => {
    const now = performance.now();
    const lastStart = Math.floor((now * 48) / BLOCK) * BLOCK - BLOCK;
    if (nextStart === null) {
      nextStart = lastStart;
      tStart = now;
    }
    while (nextStart <= lastStart) {
      const start = nextStart;
      const t = start / 48 - tStart;
      const k = Math.floor(start / BLOCK);
      const open = t >= 1000 && t < o.ms / 2;
      const pub = new Float32Array(BLOCK);
      const rec = new Float32Array(BLOCK);
      // 1 kHz bursts at every 50th block (500 ms), 10 blocks long; 600 Hz ones 25 blocks later.
      if (k % 50 < 10) for (let i = 0; i < BLOCK; i++) pub[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * pubPhase++) / 48000);
      else pubPhase = 0;
      if ((k + 25) % 50 < 10) for (let i = 0; i < BLOCK; i++) rec[i] = 0.3 * Math.sin((2 * Math.PI * 600 * recPhase++) / 48000);
      else recPhase = 0;
      if (k % 50 === 0 && t >= 0) sent.public.push({ wall: performance.timeOrigin + start / 48, open });
      if ((k + 25) % 50 === 0 && t >= 0) sent.recording.push({ wall: performance.timeOrigin + start / 48 });
      const block: MixBlock = {
        start,
        playhead: start,
        out: { public: pub, recording: rec, preview: new Float32Array(BLOCK) },
        public: { team: open ? "team-a" : null, gain: open ? 1 : 0, activity: { db: -100, speaking: false } },
        recording: { team: "team-a", gain: 1 },
        activity: { recording: new Map(), preview: new Map(), delayed: new Map() },
      };
      for (const fn of listeners) fn(block);
      nextStart += BLOCK;
    }
  };

  // The receiver first (finding sources takes a moment), then the blocks.
  const rx = spawn(process.execPath, [join(here, "comms-ndi-receiver.ts"), PUBLIC_NDI_NAME, RECORDING_NDI_NAME], { env: { ...process.env, RX_MS: String(o.ms) }, stdio: ["ignore", "pipe", "pipe"] });
  const frames: NdiRunResult["frames"] = { public: [], recording: [] };
  const perf: NdiRunResult["perf"] = { public: null, recording: null };
  let found: NdiRunResult["found"] = [];
  let findMs = 0;
  let receiverError: string | null = null;
  let stderr = "";
  rx.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
  const done = new Promise<void>((resolve) => {
    createInterface({ input: rx.stdout }).on("line", (line) => {
      let m: { type: string; [k: string]: unknown };
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.type === "found") {
        found = m.sources as NdiRunResult["found"];
        findMs = m.ms as number;
        o.log?.(`receiver found ${found.map((f) => f.name).join(", ")} in ${findMs} ms`);
      } else if (m.type === "frame") (m.s === 0 ? frames.public : frames.recording).push(m as unknown as FrameLine);
      else if (m.type === "perf") perf[m.s === 0 ? "public" : "recording"] = m.perf as never;
      else if (m.type === "error") receiverError = String(m.message);
    });
    rx.on("exit", () => resolve());
  });
  // Blocks flow from the start so the senders are there to be found.
  const timer = setInterval(tick, 5);
  await done;
  clearInterval(timer);
  const workerStats = outputs.status().ndi.stats;
  outputs.stop();
  if (!receiverError && !found.length) receiverError = `the receiver stopped: ${stderr.slice(-500)}`;

  // Received bursts: a frame with an onset after a silent frame.
  const onsetsOf = (got: FrameLine[]) => {
    const onsets: number[] = [];
    let prevSilent = true;
    for (const f of got) {
      // The frame's first sample arrived at `at`: its onset sample's own time is onset/48 ms later.
      if (f.onset >= 0 && prevSilent) onsets.push(f.at + f.onset / 48);
      prevSilent = f.peak < 0.02;
    }
    return onsets;
  };
  /** Each received onset to the burst it is (sent up to 400 ms before it). */
  const pair = <T extends { wall: number }>(onsets: number[], want: T[]) => {
    const used = new Set<number>();
    return onsets.map((a) => {
      const i = want.findIndex((w, k) => !used.has(k) && a - w.wall > -5 && a - w.wall < 400);
      if (i >= 0) used.add(i);
      return { at: a, sent: i >= 0 ? want[i]! : null, index: i };
    });
  };
  const firstAt = Math.min(frames.public[0]?.at ?? Infinity, frames.recording[0]?.at ?? Infinity);
  const lastAt = Math.max(frames.public.at(-1)?.at ?? 0, frames.recording.at(-1)?.at ?? 0);
  // Bursts the receiver was there for from start to end.
  const inWindow = <T extends { wall: number }>(xs: T[]) => xs.filter((x) => x.wall > firstAt + 100 && x.wall < lastAt - 500);
  const pubPairs = pair(onsetsOf(frames.public), sent.public);
  const recPairs = pair(onsetsOf(frames.recording), sent.recording);
  // Bursts are 500 ms apart and an onset is matched within 400 ms after one: each onset belongs to at most one burst.
  const owner = <T extends { wall: number }>(a: number, want: T[]) => want.find((w) => a - w.wall > -5 && a - w.wall < 400) ?? null;
  const pubOwners = onsetsOf(frames.public).map((a) => owner(a, sent.public));
  const recOwners = onsetsOf(frames.recording).map((a) => owner(a, sent.recording));
  // A leak: sound heard from a burst sent while the gate was closed.
  const leaked = pubOwners.filter((w) => w && !w.open).length;
  const brokenOf = (owners: ({ wall: number } | null)[]) => owners.length - new Set(owners.filter(Boolean)).size - owners.filter((w) => !w).length;
  const gotPub = new Set(pubPairs.filter((p) => p.sent?.open).map((p) => p.sent!.wall));
  const gotRec = new Set(recPairs.filter((p) => p.sent).map((p) => p.sent!.wall));
  return {
    found,
    findMs,
    durationMs: lastAt - firstAt,
    frames,
    perf,
    sent,
    latency: { public: pubPairs.filter((p) => p.sent?.open).map((p) => p.at - p.sent!.wall), recording: recPairs.filter((p) => p.sent).map((p) => p.at - p.sent!.wall) },
    leaked,
    unexplained: { public: pubOwners.filter((w) => !w).length, recording: recOwners.filter((w) => !w).length },
    broken: { public: brokenOf(pubOwners), recording: brokenOf(recOwners) },
    missedPublic: inWindow(sent.public.filter((x) => x.open)).filter((x) => !gotPub.has(x.wall)).length,
    missedRecording: inWindow(sent.recording).filter((x) => !gotRec.has(x.wall)).length,
    workerStats,
    receiverError,
    ndiVersion,
  };
}

/** Whether the NDI binding loads here (the test is skipped otherwise). */
export async function ndiAvailable(): Promise<string | null> {
  try {
    const name = "grandi";
    const mod = (await import(name)) as { default?: { version(): string; isSupportedCPU(): boolean } };
    const g = mod.default!;
    return g.isSupportedCPU() ? g.version() : null;
  } catch {
    return null;
  }
}

export { wall };
