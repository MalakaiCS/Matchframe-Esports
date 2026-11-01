/**
 * The replay feed's timing (replay/feed-core.ts records with it; ADR-064): where each NDI frame belongs on
 * this computer's clock, the constant frame rate written to ffmpeg, and the sound laid along the picture.
 * Only what arrives and when goes in, so tests drive it with made-up times.
 *
 * - **The picture** is timed by the sender's own clock (its NDI timecode or timestamp, whichever runs
 *   steadier), laid on this computer's clock by an offset: the least (arrival − sender time) of the
 *   last seconds, moved only when that moves by more than a frame and a half (the two clocks drift, the
 *   network changes). A frame that comes late because this computer was busy keeps its time.
 * - **Slots:** slot k of the recording is t0 + k frames; each frame goes in the slot nearest its time,
 *   one per slot. A slot nothing came for (a real gap) repeats the frame before; a frame for a slot
 *   already filled (it came too early) is skipped.
 * - **The sound** is written as received, sample after sample. Silence goes in only when the sender sent
 *   none for a while (a dropout); timestamp jitter and overlaps are ignored. Where it sits against the
 *   picture is checked from the sender's timestamps, and, when it is off by more than DRIFT_MS, moved
 *   back by playing it 0.3 % faster or slower for a while (a resample, not a cut); only a jump of more
 *   than JOIN_MS (a sender restarted) is mended by a 2 ms crossfaded join.
 */

/** The recording's sound: 48 kHz stereo, 32-bit float to ffmpeg. */
export const AUDIO_RATE = 48000;

/** What times the frames: the sender's timecode or timestamp, or their arrival here when the sender gives neither. */
export type FrameTiming = "timecode" | "timestamp" | "arrival";

/** Frames looked at before choosing the sender's steadier clock. */
const PICK_FRAMES = 30;
/** The offset is the least (arrival − sender time) over this long. */
const OFFSET_WINDOW_MS = 10_000;
/** A sender clock more than this ahead of the arrivals, or JUMP_MS × 5 behind, jumped (the sender restarted): laid again at once. */
const JUMP_MS = 1000;
/** A frame goes in the next slot while within this many slots of it (sender jitter). */
const SNAP = 0.75;

/** The least of a value over a sliding window of time (a monotonic queue). */
class WindowMin {
  private q: { at: number; v: number }[] = [];
  private head = 0;
  constructor(private readonly ms: number) {}

  push(at: number, v: number): number {
    while (this.q.length > this.head && this.q[this.q.length - 1]!.v >= v) this.q.pop();
    this.q.push({ at, v });
    while (this.q[this.head]!.at < at - this.ms) this.head++;
    if (this.head > 512) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
    return this.q[this.head]!.v;
  }

  clear(): void {
    this.q = [];
    this.head = 0;
  }
}

/** One of the sender's clocks laid on this computer's: wall = sender + offset. */
class Anchor {
  offset: number | null = null;
  /** Times the offset moved after it was first set. */
  moved = 0;
  private readonly min = new WindowMin(OFFSET_WINDOW_MS);
  constructor(private readonly slack: number) {}

  /** A frame sent at `sent` (the sender's clock, ms) that arrived at `at` (wall ms): its wall time. */
  add(at: number, sent: number): number {
    const d = at - sent;
    if (this.offset === null || d - this.offset < -JUMP_MS || d - this.offset > 5 * JUMP_MS) {
      if (this.offset !== null) this.moved++;
      this.min.clear();
      this.offset = d;
    }
    const m = this.min.push(at, d);
    if (Math.abs(m - this.offset) > this.slack) {
      this.offset = m;
      this.moved++;
    }
    return sent + this.offset;
  }
}

/** How steady a clock's frame intervals are: the median distance from their median (ms), or null when it doesn't run forward like time. */
function irregularity(times: number[], arrivals: number[]): number | null {
  if (times.length < 3) return null;
  const steps = times.slice(1).map((t, i) => t - times[i]!);
  if (steps.some((s) => !(s > 0))) return null;
  // It must keep time with the arrivals (a timecode counting something else isn't a clock).
  const span = times[times.length - 1]! - times[0]!;
  const arrived = arrivals[arrivals.length - 1]! - arrivals[0]!;
  if (arrived > 0 && (span / arrived < 0.75 || span / arrived > 1.33)) return null;
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
  const m = median(steps);
  return median(steps.map((s) => Math.abs(s - m)));
}

/**
 * The picture's clock: each frame's wall time from the sender's timecode or timestamp (whichever is
 * steadier over the first frames), else its arrival. The timestamp's offset is kept either way: the
 * sound is laid by it (wallOfTimestamp).
 */
export class VideoClock {
  timing: FrameTiming | null = null;
  private readonly ts: Anchor;
  private readonly tc: Anchor;
  private seen: { ts: number[]; tc: number[]; at: number[] } | null = { ts: [], tc: [], at: [] };

  constructor(frameMs: number) {
    this.ts = new Anchor(1.5 * frameMs);
    this.tc = new Anchor(1.5 * frameMs);
  }

  /** Times the chosen clock's offset moved (they drift, or the sender restarted). */
  get reanchored(): number {
    return this.timing === "timecode" ? this.tc.moved : this.timing === "timestamp" ? this.ts.moved : 0;
  }

  /** The wall time (ms) of a frame that arrived at `at`, sent with timestamp `ts` and timecode `tc` (ms, the sender's clocks), when it has them. */
  place(at: number, ts: number | null, tc: number | null): number {
    const wTs = ts !== null && Number.isFinite(ts) ? this.ts.add(at, ts) : null;
    const wTc = tc !== null && Number.isFinite(tc) && tc > 0 ? this.tc.add(at, tc) : null;
    if (this.seen) {
      const s = this.seen;
      if (wTs !== null) s.ts.push(ts!);
      if (wTc !== null) s.tc.push(tc!);
      s.at.push(at);
      if (s.at.length >= PICK_FRAMES) {
        const its = s.ts.length === s.at.length ? irregularity(s.ts, s.at) : null;
        const itc = s.tc.length === s.at.length ? irregularity(s.tc, s.at) : null;
        this.timing = itc !== null && (its === null || itc <= its) ? "timecode" : its !== null ? "timestamp" : "arrival";
        this.seen = null;
      } else this.timing = wTs !== null ? "timestamp" : "arrival";
    }
    return this.timing === "timecode" ? (wTc ?? wTs ?? at) : this.timing === "timestamp" ? (wTs ?? wTc ?? at) : at;
  }

  /** Where a sender timestamp (ms) falls on this computer's clock (the sound is laid by it), or null before any frame had one. */
  wallOfTimestamp(ts: number): number | null {
    return this.ts.offset === null ? null : ts + this.ts.offset;
  }
}

/** The median of the last `n` values. */
export class RollingMedian {
  private v: number[] = [];
  private i = 0;
  private cached: number | null = null;
  constructor(private readonly n: number) {}

  push(x: number): void {
    if (this.v.length < this.n) this.v.push(x);
    else this.v[this.i] = x;
    this.i = (this.i + 1) % this.n;
    this.cached = null;
  }

  get value(): number | null {
    if (!this.v.length) return null;
    return (this.cached ??= [...this.v].sort((a, b) => a - b)[this.v.length >> 1]!);
  }
}

/** The recording's slots: slot k is the wall time t0 + k × frameMs, and holds one frame. */
export class FrameSlots {
  /** The next slot to fill. */
  next: number;
  private started = false;

  constructor(
    private readonly t0: number,
    private readonly frameMs: number,
    first: number,
  ) {
    this.next = first;
  }

  /**
   * A frame at wall time `t`: how many slots before it repeat the previous frame (nothing came for them),
   * or null when its slot is already filled (it came too early) and it is skipped. The first frame
   * takes the first slot.
   */
  place(t: number): number | null {
    const d = (t - this.t0) / this.frameMs - this.next;
    if (!this.started) {
      this.started = true;
      this.next++;
      return 0;
    }
    if (d < -SNAP) return null;
    const gap = d > SNAP ? Math.round(d) : 0;
    this.next += gap + 1;
    return gap;
  }

  /** Nothing has come: the slots up to wall time `t` repeat the last frame; how many. */
  hold(t: number): number {
    if (!this.started) return 0;
    const due = Math.floor((t - this.t0) / this.frameMs) + 1 - this.next;
    if (due <= 0) return 0;
    this.next += due;
    return due;
  }
}

/**
 * Linear resampling of interleaved stereo across frames, its position carried from one to the next:
 * any input rate to 48 kHz, and a little faster or slower while the sound is moved (`shift`). At the
 * same rate with nothing to move it passes the samples through untouched.
 */
export class Resampler {
  /** Input samples still to skip (+) or to play twice (−), by running SLEW faster or slower. */
  shift = 0;
  private t = 0;
  private prevL = 0;
  private prevR = 0;

  constructor(private readonly slew: number) {}

  /** `x`: stereo interleaved at `rate`; returns it at 48 kHz. */
  process(x: Float32Array, rate: number): Float32Array {
    const n = x.length >> 1;
    const ratio = rate / AUDIO_RATE;
    const out = new Float32Array(2 * (Math.ceil((n + 2) / (ratio * (1 - this.slew))) + 2));
    let k = 0;
    let t = this.t;
    for (;;) {
      const i = Math.floor(t);
      const f = t - i;
      if (i > n - 1 || (i === n - 1 && f > 0)) break;
      const aL = i < 0 ? this.prevL : x[2 * i]!;
      const aR = i < 0 ? this.prevR : x[2 * i + 1]!;
      if (f === 0) {
        out[k++] = aL;
        out[k++] = aR;
      } else {
        out[k++] = aL + (x[2 * i + 2]! - aL) * f;
        out[k++] = aR + (x[2 * i + 3]! - aR) * f;
      }
      let step = ratio;
      if (this.shift !== 0) {
        const s = Math.min(this.slew * ratio, Math.abs(this.shift));
        step += Math.sign(this.shift) * s;
        this.shift -= Math.sign(this.shift) * s;
        if (Math.abs(this.shift) < 1e-9) this.shift = 0;
      }
      t += step;
    }
    this.t = t - n;
    const r = Math.round(this.t);
    if (this.shift === 0 && Math.abs(this.t - r) < 1e-6) this.t = r;
    if (n > 0) {
      this.prevL = x[2 * n - 2]!;
      this.prevR = x[2 * n - 1]!;
    }
    return out.subarray(0, k);
  }
}

/** An NDI audio frame (Float32Interleaved, any channels) as stereo interleaved at its own rate: its first two channels, or the one on both sides (a stereo frame's own floats, not a copy). */
export function toStereo(f: { channels: number; samples: number; data: Buffer }): Float32Array {
  const ch = Math.max(1, f.channels);
  const n = Math.max(0, Math.min(f.samples, Math.floor(f.data.length / 4 / ch)));
  const aligned = f.data.byteOffset % 4 === 0 ? new Float32Array(f.data.buffer, f.data.byteOffset, n * ch) : null;
  // Already stereo: used as it is (no copy).
  if (aligned && ch === 2) return aligned;
  const read = aligned ? (i: number) => aligned[i]! : (i: number) => f.data.readFloatLE(i * 4);
  const right = ch > 1 ? 1 : 0;
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    out[2 * i] = read(i * ch);
    out[2 * i + 1] = read(i * ch + right);
  }
  return out;
}

/** Nothing has come for this long without frames waiting: a source that stopped (or has no sound) is filled with silence. */
const FILL_AFTER_MS = 300;
/** … up to this long before now (sound that is merely late still fits). */
const FILL_BEHIND_MS = 150;
/** The sender sent no sound for this long or longer: a dropout, filled with silence. Shorter gaps and overlaps are its timestamps' jitter. */
const DROPOUT_MS = 200;
/** Where the sound sits against the picture is judged over this long. */
const SYNC_WINDOW_MS = 3000;
/** Off by more than this: moved back by resampling … */
const DRIFT_MS = 30;
/** … at most this much faster or slower (0.3 %, 5 cents). */
const SLEW = 0.003;
/** Off by more than this (a sender restarted, its clock jumped): a crossfaded join instead. */
const JOIN_MS = 250;
/** Samples held back (2 ms): the fade of a join. */
const FADE = 96;

/**
 * Lays the sound on the picture's clock: sample 0 is `t0` (wall ms). Frames are written one after the
 * other as received; where they belong comes from the sender's timestamps (each frame ends at its
 * timestamp, laid on this computer's clock as the picture's are; the earliest of the last seconds
 * count, as a sender may stamp a frame late but never early), else from when they arrive (the
 * earliest arrivals of the last seconds). The first frame, and the first after silence filled in, go
 * where that puts them.
 */
export class AudioClock {
  /** Samples (per channel) laid since t0, the few held back for a fade included. */
  written = 0;
  /** Dropouts filled with silence, and how long they were (ms). */
  dropouts = 0;
  paddedMs = 0;
  /** Times the sound was moved back to the picture by resampling, and by a crossfaded join. */
  corrections = 0;
  joins = 0;
  /** The sound against the picture (ms; + it comes late), by the last few seconds, or null before it is known. */
  offsetMs: number | null = null;

  /** The last FADE samples laid, held back so a join can fade them. */
  private tail = new Float32Array(0);
  /** The next samples fade in (after silence, or where a frame was cut into). */
  private fadeIn = false;
  private readonly rs = new Resampler(SLEW);
  /** Where the last frame ended, by the sender's time on this computer's clock. */
  private sentEnd: number | null = null;
  private lastArrival = -Infinity;
  private resync = true;
  private errs: { at: number; e: number }[] = [];
  private bySender: boolean | null = null;
  /** Samples still to drop by a crossfaded join (the sound far too late), or silence to put in (far too early). */
  private cut = 0;
  private pad = 0;

  constructor(private readonly t0: number) {}

  private pos(at: number): number {
    return ((at - this.t0) * AUDIO_RATE) / 1000;
  }

  /**
   * What to write for a frame (stereo interleaved at `rate` Hz) that arrived at `at` (wall ms). `end`:
   * where it ends by the sender's timestamp on this computer's clock, or null when it has none.
   */
  frame(pcm: Float32Array, rate: number, at: number, end: number | null): Buffer[] {
    const parts: Float32Array[] = [];
    const n = pcm.length >> 1;
    const dur = (n * 1000) / rate;
    let skip = 0;
    if (this.resync) {
      // Where its time puts it.
      const start = Math.round(this.pos(end ?? at) - (n * AUDIO_RATE) / rate);
      if (start > this.written) parts.push(this.silence(start - this.written));
      else skip = this.written - start;
      this.fadeIn = true;
      this.resync = false;
      this.errs = [];
    } else if (end !== null && this.sentEnd !== null && end - dur - this.sentEnd >= DROPOUT_MS) {
      // The sender sent nothing for a while: as long a silence (what came before faded out, what comes after faded in).
      const gap = end - dur - this.sentEnd;
      this.dropouts++;
      this.paddedMs += gap;
      parts.push(this.silence(Math.round((gap * AUDIO_RATE) / 1000)));
      this.fadeIn = true;
      this.errs = [];
    } else if (this.pad > 0) {
      parts.push(this.silence(this.pad));
      this.pad = 0;
      this.fadeIn = true;
    }
    let y = this.rs.process(pcm, rate);
    if (skip > 0) y = y.subarray(Math.min(y.length, 2 * skip));
    if (this.fadeIn) {
      const m = Math.min(FADE, y.length >> 1);
      y = Float32Array.from(y);
      for (let i = 0; i < m; i++) {
        y[2 * i] = y[2 * i]! * ((i + 0.5) / m);
        y[2 * i + 1] = y[2 * i + 1]! * ((i + 0.5) / m);
      }
      if (m) this.fadeIn = false;
      parts.push(y);
    } else if (this.cut > 0 && this.cut >= (y.length >> 1) + FADE) {
      // Cutting back: a frame within the cut is left out whole (what is held back waits for the join).
      this.cut -= y.length >> 1;
    } else if (this.cut > 0) {
      // The join: the samples held back crossfaded into those after the cut (the crossfade takes FADE of it).
      y = y.subarray(2 * Math.max(0, this.cut - FADE));
      this.cut = 0;
      const m = Math.min(this.tail.length >> 1, y.length >> 1);
      const mixed = new Float32Array(2 * m);
      for (let i = 0; i < m; i++) {
        const g = (i + 0.5) / m;
        mixed[2 * i] = this.tail[2 * i]! * (1 - g) + y[2 * i]! * g;
        mixed[2 * i + 1] = this.tail[2 * i + 1]! * (1 - g) + y[2 * i + 1]! * g;
      }
      this.written -= this.tail.length >> 1;
      this.tail = new Float32Array(0);
      parts.push(mixed, y.subarray(2 * m));
    } else parts.push(y);
    this.lastArrival = at;
    this.sentEnd = end;
    const out = this.emit(parts);
    this.follow(at, end, rate);
    return out;
  }

  /** Against the picture: how far the sound is from where its frames belong, and moving it back when off. */
  private follow(at: number, end: number | null, rate: number): void {
    const by = end !== null;
    // Being moved: judged again once it is done.
    if (this.bySender !== by || this.rs.shift !== 0 || this.cut > 0 || this.pad > 0) {
      this.bySender = by;
      this.errs = [];
      if (this.rs.shift !== 0 || this.cut > 0 || this.pad > 0) return;
    }
    this.errs.push({ at, e: this.written - this.pos(end ?? at) });
    while (this.errs.length && this.errs[0]!.at < at - SYNC_WINDOW_MS) this.errs.shift();
    if (this.errs.length < 4 || at - this.errs[0]!.at < SYNC_WINDOW_MS / 2) return;
    // Late ones say nothing (a sender stamps a frame when it gets to send it, never before its sound is in): by the earliest tenth
    // of the timestamps (one or two early ones aside), or by the earliest arrival.
    const es = this.errs.map((x) => x.e).sort((a, b) => a - b);
    const off = by ? es[Math.floor(es.length * 0.9)]! : es[es.length - 1]!;
    const ms = (off * 1000) / AUDIO_RATE;
    this.offsetMs = Math.round(ms);
    if (ms > JOIN_MS) {
      // Far too late (the sender's clock jumped): cut back, crossfaded.
      this.cut = Math.round(off);
      this.joins++;
    } else if (ms < -JOIN_MS) {
      // Far too early: silence, faded.
      this.pad = Math.round(-off);
      this.joins++;
    } else if (Math.abs(ms) > DRIFT_MS) {
      // Off: played a little faster (late) or slower (early) until it is back.
      this.rs.shift = (off * rate) / AUDIO_RATE;
      this.corrections++;
    } else return;
    this.errs = [];
  }

  /** Silence when no sound has come for a while (a source without sound, or one that stopped): up to a moment behind `now`. `waiting`: frames of sound wait in NDI (this process was busy), so none is put in. */
  fill(now: number, waiting = false): Buffer | null {
    if (waiting || now - this.lastArrival < FILL_AFTER_MS || this.pos(now) - this.written < (FILL_AFTER_MS * AUDIO_RATE) / 1000) return null;
    const b = this.until(now - FILL_BEHIND_MS);
    if (b) this.resync = true;
    return b;
  }

  /** Silence up to `at` (the start, before any sound came). */
  until(at: number): Buffer | null {
    const to = Math.round(this.pos(at));
    if (to <= this.written) return null;
    const out = this.emit([this.silence(to - this.written)]);
    return out.length ? Buffer.concat(out) : null;
  }

  /** `samples` of silence, the samples held back faded out first. */
  private silence(samples: number): Float32Array {
    const m = this.tail.length >> 1;
    if (m) {
      const t = Float32Array.from(this.tail);
      for (let i = 0; i < m; i++) {
        const g = 1 - (i + 0.5) / m;
        t[2 * i] = t[2 * i]! * g;
        t[2 * i + 1] = t[2 * i + 1]! * g;
      }
      this.tail = t;
    }
    return new Float32Array(2 * Math.max(0, samples));
  }

  /** Lays `parts` after what is held back, holds the last FADE samples back, and returns the rest to write. */
  private emit(parts: Float32Array[]): Buffer[] {
    let total = this.tail.length;
    for (const p of parts) total += p.length;
    const all = new Float32Array(total);
    all.set(this.tail, 0);
    let o = this.tail.length;
    for (const p of parts) {
      all.set(p, o);
      o += p.length;
    }
    this.written += (total - this.tail.length) >> 1;
    const keep = Math.min(2 * FADE, total);
    this.tail = all.slice(total - keep);
    return total - keep > 0 ? [Buffer.from(all.buffer, 0, (total - keep) * 4)] : [];
  }
}
