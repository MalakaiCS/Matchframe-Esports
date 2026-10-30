/**
 * Where a frozen HUD comes from, for the support file: gaps in CS2's game data (CS2 sending nothing)
 * and stalls of the engine's own event loop (the engine too busy to read it). A HUD that stops
 * drawing while data keeps coming is logged by the HUD outputs themselves ("hud stall").
 */

/** A pause in CS2's game data at least this long (ms) is recorded (CS2 sends 30–50 a second, and once a second at least when nothing changes). */
export const FEED_GAP_MS = 1500;
/** The engine not getting to its timer for this long (ms) is a stall. */
export const LOOP_STALL_MS = 250;
const LOOP_TICK_MS = 50;
const KEEP = 20;

export interface FeedGap {
  /** When the data came back. */
  at: string;
  gapMs: number;
  /** Round and phase when it stopped. */
  round: number | null;
  phase: string | null;
}

export interface LoopStall {
  at: string;
  ms: number;
  round: number | null;
  phase: string | null;
}

export interface FeedWatchSummary {
  packets: number;
  gaps: FeedGap[];
  longestGap: FeedGap | null;
  loopStalls: LoopStall[];
  longestLoopStall: LoopStall | null;
}

export class FeedWatch {
  private last: number | null = null;
  private lastRound: number | null = null;
  private lastPhase: string | null = null;
  private packets = 0;
  private readonly gaps: FeedGap[] = [];
  private longestGap: FeedGap | null = null;
  private readonly stalls: LoopStall[] = [];
  private longestStall: LoopStall | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: {
      now: () => number;
      round: () => { round: number | null; phase: string | null };
      /** Called for a gap or stall worth a line in the log. */
      onIssue?: (kind: "gap" | "stall", ms: number, round: number | null, phase: string | null) => void;
    },
  ) {}

  /** A game-data packet arrived (monotonic ms) and was read: a gap after it is reported with the round and phase it left. */
  notePacket(at: number): void {
    this.packets++;
    if (this.last !== null && at - this.last >= FEED_GAP_MS) {
      const gap: FeedGap = { at: new Date().toISOString(), gapMs: Math.round(at - this.last), round: this.lastRound, phase: this.lastPhase };
      this.push(this.gaps, gap);
      if (!this.longestGap || gap.gapMs > this.longestGap.gapMs) this.longestGap = gap;
      this.deps.onIssue?.("gap", gap.gapMs, gap.round, gap.phase);
    }
    this.last = at;
    const r = this.deps.round();
    this.lastRound = r.round;
    this.lastPhase = r.phase;
  }

  /** Watches the event loop: a tick that comes LOOP_STALL_MS or more late is a stall. */
  start(): void {
    if (this.timer) return;
    let expected = this.deps.now() + LOOP_TICK_MS;
    this.timer = setInterval(() => {
      const now = this.deps.now();
      const late = now - expected;
      expected = now + LOOP_TICK_MS;
      if (late < LOOP_STALL_MS) return;
      const r = this.deps.round();
      const stall: LoopStall = { at: new Date().toISOString(), ms: Math.round(late), round: r.round, phase: r.phase };
      this.push(this.stalls, stall);
      if (!this.longestStall || stall.ms > this.longestStall.ms) this.longestStall = stall;
      this.deps.onIssue?.("stall", stall.ms, r.round, r.phase);
    }, LOOP_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary(): FeedWatchSummary {
    return { packets: this.packets, gaps: [...this.gaps], longestGap: this.longestGap, loopStalls: [...this.stalls], longestLoopStall: this.longestStall };
  }

  private push<T>(list: T[], item: T): void {
    list.push(item);
    if (list.length > KEEP) list.shift();
  }
}
