/**
 * Presentation-timeline buffer for delayed outputs: data is held for the same delay as the
 * program media, so a delayed HUD never shows state ahead of its video.
 */
export class DelayBuffer<T> {
  private readonly items: { at: number; value: T }[] = [];

  constructor(private readonly maxDelayMs: number) {}

  push(at: number, value: T): void {
    this.items.push({ at, value });
    const cutoff = at - this.maxDelayMs - 2000;
    while (this.items.length > 2 && this.items[0]!.at < cutoff) this.items.shift();
  }

  /** Latest value observed at or before `now - delayMs`; null when the buffer has not filled yet. */
  at(now: number, delayMs: number): { value: T; at: number } | null {
    const target = now - delayMs;
    let found: { at: number; value: T } | null = null;
    for (const it of this.items) {
      if (it.at <= target) found = it;
      else break;
    }
    return found;
  }

  clear(): void {
    this.items.length = 0;
  }

  get size(): number {
    return this.items.length;
  }
}
