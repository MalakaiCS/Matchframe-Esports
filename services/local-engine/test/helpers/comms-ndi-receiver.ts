/**
 * An NDI receiver in its own process, as DistroAV in OBS would be (Team Comms, ADR-066): finds the
 * sources named on the command line ("<computer> (name)"), receives their audio as 32-bit float and
 * prints one JSON line per frame (arrival time, size, rate, channels, where a burst starts, all
 * zeros or not) and NDI's own counters each second. Run with Node (it runs .ts as is):
 *
 *   node comms-ndi-receiver.ts "MatchFrame Comms" "MatchFrame Comms Recording"   (RX_MS: how long)
 */
import grandi from "grandi";

const names = process.argv.slice(2);
const runMs = Number(process.env.RX_MS ?? 10_000);
const findMs = Number(process.env.RX_FIND_MS ?? 30_000);
const wall = () => performance.timeOrigin + performance.now();
const out = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

const finder = await grandi.find({ showLocalSources: true, extraIPs: "127.0.0.1" });
const found = new Map<string, { name: string; urlAddress?: string }>();
const t0 = Date.now();
while (found.size < names.length && Date.now() - t0 < findMs) {
  await finder.wait(500);
  for (const s of finder.sources()) for (const n of names) if (s.name.endsWith(`(${n})`)) found.set(n, s);
}
finder.destroy();
out({ type: "found", sources: [...found.entries()].map(([k, v]) => ({ want: k, name: v.name })), ms: Date.now() - t0 });
if (found.size < names.length) {
  out({ type: "error", message: `not found: ${names.filter((n) => !found.has(n)).join(", ")}` });
  process.exit(2);
}

const end = wall() + runMs;
await Promise.all(
  names.map(async (n, idx) => {
    const rx = await grandi.receive({ source: found.get(n)!, bandwidth: grandi.Bandwidth.AudioOnly, name: `MatchFrame test receiver ${idx}` });
    let lastPerf = wall();
    try {
      while (wall() < end) {
        const f = await rx.audio({ audioFormat: grandi.AudioFormat.Float32Interleaved }, 200).catch(() => null);
        const at = wall();
        if (f && f.type === "audio") {
          const x = new Float32Array(f.data.buffer, f.data.byteOffset, f.data.byteLength / 4);
          let onset = -1;
          let peak = 0;
          let zero = true;
          for (let i = 0; i < f.samples; i++) {
            const v = Math.abs(x[i * f.channels]!);
            if (v !== 0) zero = false;
            if (v > peak) peak = v;
            if (onset < 0 && v > 0.02) onset = i;
          }
          // Both channels carry the same mix.
          let same = true;
          if (f.channels === 2) for (let i = 0; i < f.samples; i++) if (x[i * 2] !== x[i * 2 + 1]) same = false;
          out({ type: "frame", s: idx, at, tc: Number(f.timecode) / 10_000, n: f.samples, rate: f.sampleRate, ch: f.channels, fmt: f.audioFormat, onset, peak, zero, same });
        }
        if (at - lastPerf >= 1000) {
          lastPerf = at;
          out({ type: "perf", s: idx, at, perf: rx.performance(), queue: rx.queue() });
        }
      }
      out({ type: "perf", s: idx, at: wall(), perf: rx.performance(), queue: rx.queue(), final: true });
    } finally {
      rx.destroy();
    }
  }),
);
out({ type: "done" });
process.exit(0);
