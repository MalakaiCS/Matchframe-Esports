import { describe, expect, it } from "vitest";
import { ndiAvailable, runNdi, summary } from "./helpers/comms-ndi-drive.ts";

/**
 * Team Comms' NDI outputs for real (ADR-066): the engine's outputs and the NDI process it forks,
 * "MatchFrame Comms" and "MatchFrame Comms Recording", received by a real NDI receiver in another
 * process (as DistroAV in OBS). Skipped when the NDI binding doesn't load here (or MATCHFRAME_SKIP_NDI
 * is set). Not OBS: DistroAV's reception is checked on the owner's PC (docs/operations/team-comms.md).
 */

const ndi = process.env.MATCHFRAME_SKIP_NDI ? null : await ndiAvailable();

describe.skipIf(!ndi)(`Team Comms NDI outputs, received in another process (${ndi ?? "NDI not available"})`, () => {
  it("48 kHz stereo float, 480-sample frames on time, silence while the public gate is closed, the recording on throughout", { timeout: 90_000 }, async () => {
    const r = await runNdi({ ms: 8000 });
    expect(r.receiverError).toBeNull();
    expect(r.found.map((f) => f.want).sort()).toEqual(["MatchFrame Comms", "MatchFrame Comms Recording"]);
    for (const frames of [r.frames.public, r.frames.recording]) {
      expect(frames.length).toBeGreaterThan(300);
      // Format: what the senders declare and carry.
      expect(new Set(frames.map((f) => `${f.rate}/${f.ch}/${f.n}`))).toEqual(new Set(["48000/2/480"]));
      expect(frames.every((f) => f.same)).toBe(true);
      // Timing: 100 frames a second over the run (48 000 samples a second).
      const span = (frames.at(-1)!.at - frames[0]!.at) / 1000;
      expect(Math.abs((frames.length - 1) / span - 100)).toBeLessThan(3);
    }
    // Nothing dropped on the receiving side.
    expect(r.perf.public?.dropped.audioFrames ?? 0).toBe(0);
    expect(r.perf.recording?.dropped.audioFrames ?? 0).toBe(0);
    // Public: bursts only while the gate was open; Matchframe's guard zeroed the ones sent closed.
    expect(r.leaked).toBe(0);
    expect(r.missedPublic).toBe(0);
    expect(r.latency.public.length).toBeGreaterThanOrEqual(4);
    expect(r.missedRecording).toBe(0);
    expect(r.frames.public.filter((f) => f.zero).length).toBeGreaterThan(r.frames.public.length / 3);
    // Latency from a block's own time to arrival: the configured 60 ms plus NDI's transport, steady.
    const lat = summary([...r.latency.public, ...r.latency.recording]);
    expect(lat.median).toBeGreaterThan(55);
    expect(lat.median).toBeLessThan(120);
    expect(lat.p95 - lat.min).toBeLessThan(40);
    // Gaps (the driver starved under load) cut a burst into two onsets: never a leak, and rare.
    expect(r.unexplained.public + r.unexplained.recording).toBe(0);
    expect(r.broken.public + r.broken.recording).toBeLessThanOrEqual(3);
  });
});
