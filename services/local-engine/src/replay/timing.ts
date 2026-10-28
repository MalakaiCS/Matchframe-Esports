/**
 * How far this computer's game is behind the main PC's: the replay PC watching a CSTV with more
 * delay (a second CSTV instance, or the main PC in the server and this one on CSTV), or rewound.
 *
 * Both computers report CS2's round clock (the phase and the seconds left in it). The same clock
 * reading arrives here D ms after the main PC had it, so each of this computer's readings, matched
 * to the moment the main PC showed the same one, gives D. Kills seen on both computers (same round,
 * killer and victim) give it too. The answer is the median over the last 20 s, and only when the
 * readings agree.
 *
 * When this computer's own clock jumps (CS2 went back or forward), its readings start over, and the
 * main PC may not have the matching readings yet (it showed them before this computer was linked).
 * Until enough new readings match, the answer is the delay before the jump plus the jump.
 */

export interface ClockReading {
  /** This computer's monotonic ms when the reading was true (for the main PC: corrected for the network). */
  at: number;
  map: string | null;
  round: number | null;
  phase: string;
  endsInSec: number;
}

export interface DelayEstimate {
  /** Positive: this computer's game is this far behind the main PC's. */
  delayMs: number;
  readings: number;
}

/** Main PC readings kept (this computer can be up to this far behind and still be matched). */
const KEEP_MS = 120_000;
/** Readings that count towards the answer. */
const WINDOW_MS = 20_000;
const MIN_READINGS = 5;
/** Readings this far apart (interquartile range) disagree: no answer. */
const MAX_SPREAD_MS = 800;
/** Two readings of a running clock this far apart are not joined (a pause or a gap in the data). */
const MAX_GAP_MS = 3000;
/** The last good answer is kept this long when the readings stop agreeing. */
const STALE_MS = 30_000;

export class DelayEstimator {
  private main: ClockReading[] = [];
  private own: ClockReading[] = [];
  private readonly mainKills = new Map<string, number>();
  private readonly ownKills = new Map<string, number>();
  private kills: { at: number; delayMs: number }[] = [];
  private last: { delayMs: number; at: number; readings: number } | null = null;
  /** The delay before this computer's last jump plus the jump, until readings match again. */
  private provisional: { delayMs: number; at: number } | null = null;

  noteMain(r: ClockReading): void {
    push(this.main, r);
  }

  noteOwn(r: ClockReading): void {
    const last = this.own[this.own.length - 1];
    const jump = last ? jumpMs(last, r) : null;
    if (jump !== null) {
      const before = this.last?.delayMs ?? this.provisional?.delayMs ?? null;
      this.resetOwn();
      this.provisional = before !== null && Number.isFinite(jump) ? { delayMs: Math.round(before + jump), at: r.at } : null;
    }
    push(this.own, r);
  }

  /** A kill the main PC saw at `at` (this computer's clock). */
  noteMainKill(key: string, at: number): void {
    this.mainKills.set(key, at);
    const own = this.ownKills.get(key);
    if (own !== undefined) this.addKill(own, own - at);
    prune(this.mainKills, at);
  }

  /** A kill this computer saw at `at`. */
  noteOwnKill(key: string, at: number): void {
    this.ownKills.set(key, at);
    const main = this.mainKills.get(key);
    if (main !== undefined) this.addKill(at, at - main);
    prune(this.ownKills, at);
  }

  /** Forget this computer's readings: its game just jumped in time (a rewind or a skip forward). */
  resetOwn(): void {
    this.own = [];
    this.ownKills.clear();
    this.kills = [];
    this.last = null;
    this.provisional = null;
  }

  estimate(now: number): DelayEstimate | null {
    const values: number[] = [];
    for (const o of this.own) {
      if (o.at < now - WINDOW_MS) continue;
      const t = this.mainTimeOf(o);
      if (t !== null) values.push(o.at - t);
    }
    // A matched kill is an exact reading: it counts twice.
    for (const k of this.kills) if (k.at >= now - WINDOW_MS * 3) values.push(k.delayMs, k.delayMs);
    if (values.length >= MIN_READINGS) {
      values.sort((a, b) => a - b);
      const q = (p: number) => values[Math.min(values.length - 1, Math.floor(p * values.length))]!;
      if (q(0.75) - q(0.25) <= MAX_SPREAD_MS) {
        this.last = { delayMs: Math.round(q(0.5)), at: now, readings: values.length };
        this.provisional = null;
        return { delayMs: this.last.delayMs, readings: values.length };
      }
    }
    if (this.last && now - this.last.at < STALE_MS) return { delayMs: this.last.delayMs, readings: this.last.readings };
    return this.provisional && now - this.provisional.at < KEEP_MS ? { delayMs: this.provisional.delayMs, readings: 0 } : null;
  }

  /** When the main PC's clock showed this reading (interpolated between two of its readings), or null. */
  private mainTimeOf(o: ClockReading): number | null {
    for (let i = this.main.length - 1; i > 0; i--) {
      const b = this.main[i]!;
      const a = this.main[i - 1]!;
      if (a.map !== o.map || a.round !== o.round || a.phase !== o.phase || b.map !== o.map || b.round !== o.round || b.phase !== o.phase) continue;
      // A running clock counts down; a paused one (same value) can't be matched.
      if (!(a.endsInSec > b.endsInSec) || b.at - a.at > MAX_GAP_MS) continue;
      if (o.endsInSec > a.endsInSec || o.endsInSec < b.endsInSec) continue;
      const f = (a.endsInSec - o.endsInSec) / (a.endsInSec - b.endsInSec);
      return a.at + f * (b.at - a.at);
    }
    return null;
  }

  private addKill(at: number, delayMs: number): void {
    if (Math.abs(delayMs) > KEEP_MS) return;
    this.kills.push({ at, delayMs });
    if (this.kills.length > 20) this.kills.shift();
  }
}

/**
 * How far this computer's game jumped in time between two readings (ms; positive: back, negative:
 * forward), or null when it didn't. A jump is a clock that moved more than a second away from where
 * it should be; back to an earlier round is a jump of unknown size (Infinity).
 */
function jumpMs(a: ClockReading, b: ClockReading): number | null {
  if (a.map !== b.map) return null;
  if (a.round !== null && b.round !== null && b.round < a.round) return Infinity;
  if (a.round !== b.round || a.phase !== b.phase) return null;
  const expected = a.endsInSec - (b.at - a.at) / 1000;
  // A paused clock stands still: only a clock that moved the wrong way, or too far, jumped.
  if (b.endsInSec > a.endsInSec + 1 || b.endsInSec < expected - 1) return (b.endsInSec - expected) * 1000;
  return null;
}

/** Kept in order; a reading equal to the last one (same clock value) adds nothing. */
function push(list: ClockReading[], r: ClockReading): void {
  const last = list[list.length - 1];
  if (last && last.endsInSec === r.endsInSec && last.phase === r.phase && last.round === r.round && last.map === r.map) return;
  if (last && r.at < last.at) return;
  list.push(r);
  while (list.length > 2 && list[0]!.at < r.at - KEEP_MS) list.shift();
}

function prune(m: Map<string, number>, now: number): void {
  for (const [k, t] of m) if (t < now - KEEP_MS) m.delete(k);
}

/** The key two computers agree on for one kill. */
export function killKey(round: number | null, killer: string, victim: string): string {
  return `${round ?? "?"}|${killer}|${victim}`;
}
