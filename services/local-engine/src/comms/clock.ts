/**
 * The TeamSpeak plugin's clock laid on the engine's (ADR-065). The plugin stamps every block of
 * voice with its own monotonic clock (µs: QueryPerformanceCounter on Windows, CLOCK_MONOTONIC on
 * Linux); the engine's timeline is `performance.now()` (ms). Both run on the same computer, so the
 * offset between them is nearly constant, but nothing assumes it:
 *
 * - **Pings:** the engine sends its time each second; the plugin answers with it and its own. The
 *   offset is plugin − (sent + received) / 2 from the answer with the shortest round trip of the
 *   last PING_WINDOW_MS (a busy moment on either side lengthens the round trip, not the estimate).
 * - **Before the first answer** the audio itself bounds it: a block arrives after it was stamped,
 *   so plugin time − arrival is at most the offset; the largest of the last seconds is used. The
 *   first answer then replaces it at once (measured: the audio's estimate was 12 ms off while the
 *   engine was busy starting).
 * - **Moves** smaller than STEP_MS are slewed at SLEW_PER_S (no jump in the timeline); a larger one
 *   (a computer that slept, a plugin restarted) is taken at once and counted.
 * - **Drift** (ppm) is the slope of the estimates over the last DRIFT_WINDOW_MS, for the diagnostics.
 */

const PING_WINDOW_MS = 10_000;
const AUDIO_WINDOW_MS = 3_000;
/** A change of the offset larger than this is a jump, taken at once. */
const STEP_MS = 20;
/** Smaller changes are slewed at this much per second of engine time. */
const SLEW_PER_S = 1;
const DRIFT_WINDOW_MS = 60_000;

interface Sample {
  atMs: number;
  offsetMs: number;
  rttMs: number;
}

export interface ClockStatus {
  /** plugin − engine, ms, as applied. */
  offsetMs: number | null;
  source: "ping" | "audio" | "none";
  /** Shortest round trip of the last pings (ms). */
  rttMs: number | null;
  driftPpm: number | null;
  /** Offset jumps taken at once. */
  steps: number;
  pings: number;
}

export class PluginClock {
  private pings: Sample[] = [];
  private audio: { atMs: number; v: number }[] = [];
  private history: { atMs: number; offsetMs: number }[] = [];
  private applied: number | null = null;
  private appliedAt = 0;
  private source: ClockStatus["source"] = "none";
  private steps = 0;
  private pingCount = 0;

  /** An answered ping: the engine's send time (ms), the answer's arrival (ms), the plugin's time in it (µs). */
  onPong(sentMs: number, receivedMs: number, pluginUs: number): void {
    const rtt = receivedMs - sentMs;
    if (!(rtt >= 0) || rtt > 5000) return;
    this.pingCount++;
    const sample = { atMs: receivedMs, offsetMs: pluginUs / 1000 - (sentMs + receivedMs) / 2, rttMs: rtt };
    // Further from the clock in use than its round trip explains: the plugin's clock jumped (the
    // computer slept, TeamSpeak restarted): earlier answers no longer apply.
    if (this.source === "ping" && this.applied !== null && Math.abs(sample.offsetMs - this.applied) > rtt / 2 + STEP_MS) this.pings = [];
    this.pings.push(sample);
    while (this.pings.length && this.pings[0]!.atMs < receivedMs - PING_WINDOW_MS) this.pings.shift();
    let best = this.pings[0]!;
    for (const p of this.pings) if (p.rttMs < best.rttMs) best = p;
    // The first answer replaces the rougher estimate from the audio at once (not slewed, not a jump).
    if (this.source !== "ping") this.applied = null;
    this.source = "ping";
    this.move(best.offsetMs, receivedMs);
  }

  /** A block of audio stamped `pluginUs` arrived at `arrivalMs`: used until pings are answered. */
  onAudio(pluginUs: number, arrivalMs: number): void {
    if (this.source === "ping") return;
    const v = pluginUs / 1000 - arrivalMs;
    this.audio.push({ atMs: arrivalMs, v });
    while (this.audio.length && this.audio[0]!.atMs < arrivalMs - AUDIO_WINDOW_MS) this.audio.shift();
    let best = -Infinity;
    for (const a of this.audio) best = Math.max(best, a.v);
    this.source = "audio";
    this.move(best, arrivalMs);
  }

  private move(target: number, nowMs: number): void {
    this.history.push({ atMs: nowMs, offsetMs: target });
    while (this.history.length && this.history[0]!.atMs < nowMs - DRIFT_WINDOW_MS) this.history.shift();
    if (this.applied === null || Math.abs(target - this.applied) > STEP_MS) {
      if (this.applied !== null) this.steps++;
      this.applied = target;
      this.history = [{ atMs: nowMs, offsetMs: target }];
    } else {
      const maxMove = (Math.max(0, nowMs - this.appliedAt) / 1000) * SLEW_PER_S;
      const d = target - this.applied;
      this.applied += Math.sign(d) * Math.min(Math.abs(d), maxMove);
    }
    this.appliedAt = nowMs;
  }

  /** True once the clock can place audio. */
  get ready(): boolean {
    return this.applied !== null;
  }

  /** A plugin time (µs) on the engine's timeline (ms). */
  toEngineMs(pluginUs: number): number {
    return pluginUs / 1000 - (this.applied ?? 0);
  }

  status(): ClockStatus {
    let drift: number | null = null;
    const h = this.history;
    if (h.length >= 5 && h[h.length - 1]!.atMs - h[0]!.atMs >= 10_000) {
      const n = h.length;
      const mx = h.reduce((s, p) => s + p.atMs, 0) / n;
      const my = h.reduce((s, p) => s + p.offsetMs, 0) / n;
      let num = 0;
      let den = 0;
      for (const p of h) {
        num += (p.atMs - mx) * (p.offsetMs - my);
        den += (p.atMs - mx) ** 2;
      }
      drift = den > 0 ? (num / den) * 1e6 : null;
    }
    const rtt = this.pings.length ? Math.min(...this.pings.map((p) => p.rttMs)) : null;
    return { offsetMs: this.applied, source: this.source, rttMs: rtt, driftPpm: drift, steps: this.steps, pings: this.pingCount };
  }
}
