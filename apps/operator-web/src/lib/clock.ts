/**
 * Estimates the engine's monotonic clock from snapshot arrivals. Snapshots are pushed right after a
 * packet is ingested, so (clientNow - state.time.receivedAtMonotonicMs) is minimal when a fresh
 * packet arrives; the sliding-window minimum approximates the clock offset plus transport latency.
 * From that, data age and phase clocks can be shown without the engine sending its own "now".
 */
export class EngineClock {
  private samples: number[] = [];
  private sessionKey: string | null = null;

  constructor(private readonly windowSize = 50) {}

  /** Records a snapshot arrival. `receivedAt` is the engine monotonic ms of the latest packet. */
  observe(clientNowMs: number, receivedAtMonotonicMs: number, sessionKey: string): void {
    if (sessionKey !== this.sessionKey) {
      this.samples = [];
      this.sessionKey = sessionKey;
    }
    this.samples.push(clientNowMs - receivedAtMonotonicMs);
    if (this.samples.length > this.windowSize) this.samples.shift();
  }

  get offset(): number | null {
    if (this.samples.length === 0) return null;
    return Math.min(...this.samples);
  }

  /** Engine monotonic "now" estimate for a client timestamp. */
  engineNow(clientNowMs: number): number | null {
    const o = this.offset;
    return o === null ? null : clientNowMs - o;
  }

  /** Age (ms) of data stamped with engine monotonic time `t`. */
  ageOf(t: number | null | undefined, clientNowMs: number): number | null {
    const now = this.engineNow(clientNowMs);
    if (now === null || typeof t !== "number") return null;
    return Math.max(0, now - t);
  }

  reset(): void {
    this.samples = [];
    this.sessionKey = null;
  }
}

/** Remaining phase seconds, advanced locally from the observation time when the clock is running. */
export function phaseRemaining(phaseEndsInSec: number | null, phaseObservedAt: number | null, engineNow: number | null, running: boolean): number | null {
  if (phaseEndsInSec === null) return null;
  if (!running || phaseObservedAt === null || engineNow === null) return phaseEndsInSec;
  return Math.max(0, phaseEndsInSec - (engineNow - phaseObservedAt) / 1000);
}
