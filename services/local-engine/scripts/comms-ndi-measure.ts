/**
 * Measures Team Comms' NDI outputs (ADR-066) end to end in real time: the engine's outputs and NDI
 * process sending "MatchFrame Comms" and "MatchFrame Comms Recording", a real NDI receiver in another
 * process. Prints format, frame rate, drops, latency and the public gate's silence.
 *
 *   pnpm exec tsx services/local-engine/scripts/comms-ndi-measure.ts [seconds=180] [latencyMs=60] [clockAudio=0]
 */
import { runNdi, summary } from "../test/helpers/comms-ndi-drive.ts";

const secs = Number(process.argv[2] ?? 180);
const latencyMs = Number(process.argv[3] ?? 60);
const clockAudio = (process.argv[4] ?? "0") !== "0";
const r = await runNdi({ ms: secs * 1000, latencyMs, clockAudio, log: (s) => console.error(s) });
const fmt = (xs: { rate: number; ch: number; n: number }[]) => [...new Set(xs.map((f) => `${f.rate} Hz, ${f.ch} ch, ${f.n} samples`))];
const rate = (xs: { at: number }[]) => ((xs.length - 1) / ((xs.at(-1)!.at - xs[0]!.at) / 1000)).toFixed(2);
const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
console.log(
  JSON.stringify(
    {
      ndi: r.ndiVersion,
      settings: { latencyMs, clockAudio, seconds: secs },
      found: r.found,
      findMs: r.findMs,
      receivedSpanS: Math.round(r.durationMs) / 1000,
      public: { frames: r.frames.public.length, perSecond: rate(r.frames.public), format: fmt(r.frames.public), zeroFrames: r.frames.public.filter((f) => f.zero).length, ndiDropped: r.perf.public?.dropped.audioFrames ?? null, latencyMs: round(summary(r.latency.public)), leakedWhileClosed: r.leaked, missedWhileOpen: r.missedPublic, burstsWithAGap: r.broken.public, unexplainedOnsets: r.unexplained.public },
      recording: { frames: r.frames.recording.length, perSecond: rate(r.frames.recording), format: fmt(r.frames.recording), ndiDropped: r.perf.recording?.dropped.audioFrames ?? null, latencyMs: round(summary(r.latency.recording)), missed: r.missedRecording, burstsWithAGap: r.broken.recording },
      worker: r.workerStats,
      receiverError: r.receiverError,
    },
    null,
    2,
  ),
);
process.exit(0);
