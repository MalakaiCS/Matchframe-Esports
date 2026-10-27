/**
 * Projects a source countdown (round/bomb timer) to the current instant for display.
 * The countdown only advances while play is live, unpaused, and the data is fresh. During pause,
 * demo playback stop or a source gap it freezes at the last authoritative value instead of
 * running on wall-clock time.
 */
export function projectCountdown(opts: {
  countdownSec: number | null;
  observedAtMonotonicMs: number | null;
  nowMonotonicMs: number;
  running: boolean;
  maxExtrapolationMs?: number;
}): { remainingSec: number | null; frozen: boolean; stale: boolean } {
  const { countdownSec, observedAtMonotonicMs, nowMonotonicMs, running } = opts;
  if (countdownSec === null || observedAtMonotonicMs === null) return { remainingSec: null, frozen: true, stale: false };
  const age = nowMonotonicMs - observedAtMonotonicMs;
  const maxExtrap = opts.maxExtrapolationMs ?? 1500;
  if (!running) return { remainingSec: countdownSec, frozen: true, stale: false };
  if (age > maxExtrap) {
    return { remainingSec: Math.max(0, countdownSec - maxExtrap / 1000), frozen: true, stale: true };
  }
  return { remainingSec: Math.max(0, countdownSec - age / 1000), frozen: false, stale: false };
}
