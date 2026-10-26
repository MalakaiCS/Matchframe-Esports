/**
 * Canonical match clock for a snapshot source without tick timing (e.g. GSI).
 *
 * Match time advances with ingest monotonic time only while play is live and unpaused, and is
 * reset on each new epoch. It is NOT frame-accurate: uncertainty is at least the observed packet
 * interval plus the source's 1-second provider timestamp resolution when used for alignment.
 */
export class MatchClock {
  private matchTimeMs = 0;
  private lastMonotonicMs: number | null = null;
  private running = false;
  private intervals: number[] = [];

  observe(nowMonotonicMs: number, opts: { running: boolean }): number {
    if (this.lastMonotonicMs !== null) {
      const dt = nowMonotonicMs - this.lastMonotonicMs;
      if (dt > 0) {
        if (this.running) this.matchTimeMs += dt;
        this.intervals.push(dt);
        if (this.intervals.length > 50) this.intervals.shift();
      }
    }
    this.lastMonotonicMs = nowMonotonicMs;
    this.running = opts.running;
    return this.matchTimeMs;
  }

  /** Match time projected to `nowMonotonicMs` without a new packet (frozen when not running). */
  at(nowMonotonicMs: number): number {
    if (this.lastMonotonicMs === null || !this.running) return this.matchTimeMs;
    return this.matchTimeMs + Math.max(0, nowMonotonicMs - this.lastMonotonicMs);
  }

  meanIntervalMs(): number | null {
    if (this.intervals.length === 0) return null;
    return this.intervals.reduce((a, b) => a + b, 0) / this.intervals.length;
  }

  uncertaintyMs(): number {
    const mean = this.meanIntervalMs();
    return Math.round((mean ?? 500) + 50);
  }

  reset(): void {
    this.matchTimeMs = 0;
    this.lastMonotonicMs = null;
    this.running = false;
    this.intervals = [];
  }
}
