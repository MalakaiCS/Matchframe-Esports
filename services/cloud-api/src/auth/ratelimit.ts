/** Fixed-window in-memory limiter (per process). Enough for one instance; use a shared store when scaling out. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when allowed. */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || t - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      if (this.hits.size > 50000) this.prune(t);
      return true;
    }
    h.count++;
    return h.count <= this.limit;
  }

  /** When `key` is over its limit: the time (ms) its window ends and requests are allowed again; otherwise null. */
  blockedUntil(key: string): number | null {
    const h = this.hits.get(key);
    if (!h || this.now() - h.windowStart >= this.windowMs || h.count < this.limit) return null;
    return h.windowStart + this.windowMs;
  }

  /** Forgets `key`'s count (staff clearing a lockout). Returns whether it was blocked. */
  clear(key: string): boolean {
    const blocked = this.blockedUntil(key) !== null;
    this.hits.delete(key);
    return blocked;
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (t - v.windowStart >= this.windowMs) this.hits.delete(k);
  }
}
