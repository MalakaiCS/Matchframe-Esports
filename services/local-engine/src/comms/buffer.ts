/**
 * One person's voice on the production timeline (ADR-065).
 *
 * The timeline is the engine's monotonic clock in 48 kHz samples (sample n is at n / 48 ms of
 * `performance.now()`). TeamSpeak sends a person's audio only while they talk, so the buffer holds
 * sparse chunks, each at the time TeamSpeak handed it over (the plugin's stamp laid on the engine's
 * clock), never seconds of silence:
 *
 * - **Placement:** a block that starts within CONTINUITY of where the person's last block ended
 *   continues it sample for sample (timestamp jitter is not a gap); one further away starts a new
 *   chunk at its own time (a new sentence, or blocks lost on the way). A block more than MAX_LAG
 *   behind the end of what is written (the plugin's clock jumped back) cuts what was written there
 *   and starts again at its own time.
 * - **Rate:** blocks at another rate than 48 kHz are converted by a linear resampler that carries its
 *   position from block to block within a chunk; stereo is mixed to mono.
 * - **Bounds:** chunks before `trim(before)` are dropped (the service keeps the delay plus a margin);
 *   the service also caps the memory of all buffers together.
 * - **Late:** samples before `floor` (what the outputs have already played) are dropped and counted.
 */

export const RATE = 48_000;
/** Samples per millisecond on the timeline. */
export const SPMS = RATE / 1000;
/** Blocks within this of the last block's end continue it (20 ms). */
const CONTINUITY = 20 * SPMS;
/** A block this far behind what is written means the clock jumped back (200 ms). */
const MAX_LAG = 200 * SPMS;
/**
 * Blocks are copied into pages of this many samples (1 s) and kept as views of them: a 90 s delay
 * holds tens of thousands of 7.5 ms blocks, and one memory allocation each kept the garbage
 * collector busy (measured in the phase 5 soak). A page is freed once its last block is trimmed.
 */
export const PAGE_SAMPLES = RATE;

export const msToSample = (ms: number) => Math.round(ms * SPMS);
export const sampleToMs = (s: number) => s / SPMS;

export interface Chunk {
  start: number;
  data: Int16Array;
}

/** Linear sample-rate conversion to 48 kHz that keeps its position between blocks. */
export class Resampler {
  private pos = 0;
  private prev: number | null = null;

  constructor(readonly inRate: number) {}

  reset(): void {
    this.pos = 0;
    this.prev = null;
  }

  process(input: Int16Array): Int16Array {
    if (this.inRate === RATE) return input;
    const step = this.inRate / RATE;
    // Positions are in input samples, -1 being the last sample of the previous block.
    const src = (i: number) => (i < 0 ? (this.prev ?? input[0] ?? 0) : (input[i] ?? 0));
    const out: number[] = [];
    let p = this.pos;
    while (p <= input.length - 1) {
      const i = Math.floor(p);
      const f = p - i;
      out.push(Math.round(src(i) * (1 - f) + src(i + 1) * f));
      p += step;
    }
    this.pos = p - input.length;
    this.prev = input[input.length - 1] ?? this.prev;
    return Int16Array.from(out);
  }
}

/** Interleaved int16 to mono. */
export function toMono(pcm: Int16Array, channels: number): Int16Array {
  if (channels === 1) return pcm;
  const out = new Int16Array(pcm.length / channels);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += pcm[i * channels + c]!;
    out[i] = Math.round(s / channels);
  }
  return out;
}

export interface BufferStats {
  chunks: number;
  samples: number;
  bytes: number;
  /** Timeline sample of the first and last held. */
  first: number | null;
  last: number | null;
  late: number;
  reanchors: number;
  written: number;
}

export class VoiceBuffer {
  private chunks: Chunk[] = [];
  private page: Int16Array | null = null;
  private pageUsed = 0;
  private end: number | null = null;
  private resampler: Resampler | null = null;
  private cursor = 0;
  bytes = 0;
  late = 0;
  reanchors = 0;
  written = 0;

  /**
   * Lays a block on the timeline. `start` is where its first sample belongs; `floor` is the first
   * sample not yet played by any output (earlier samples are late and dropped). Returns where the
   * block went (its first sample), or null when it was entirely late.
   */
  write(start: number, pcm: Int16Array, channels: number, rate: number, floor: number): number | null {
    let mono = toMono(pcm, channels);
    if (rate !== RATE) {
      if (!this.resampler || this.resampler.inRate !== rate) this.resampler = new Resampler(rate);
    } else this.resampler = null;
    let at = Math.round(start);
    let continues = false;
    if (this.end !== null) {
      const d = at - this.end;
      if (Math.abs(d) <= CONTINUITY || (d < 0 && -d <= MAX_LAG)) {
        at = this.end;
        continues = true;
      } else if (d < 0) {
        this.cutFrom(at);
        this.reanchors++;
      }
    }
    if (this.resampler) {
      if (!continues) this.resampler.reset();
      mono = this.resampler.process(mono);
    }
    if (mono.length === 0) return at;
    if (at + mono.length <= floor) {
      this.late += mono.length;
      this.end = at + mono.length;
      return null;
    }
    if (at < floor) {
      this.late += floor - at;
      mono = mono.subarray(floor - at);
      at = floor;
    }
    // One chunk per block (no copying to merge them): a 300 s delay holds ~15 000 per person who
    // talks all the time; each a view of the current page (a new page when it is full).
    this.chunks.push({ start: at, data: this.store(mono) });
    this.bytes += mono.byteLength;
    this.written += mono.length;
    this.end = at + mono.length;
    return at;
  }

  /** A copy of a block in the current page (a block larger than a page gets its own memory). */
  private store(mono: Int16Array): Int16Array {
    if (mono.length > PAGE_SAMPLES) return Int16Array.from(mono);
    if (!this.page || this.pageUsed + mono.length > this.page.length) {
      this.page = new Int16Array(PAGE_SAMPLES);
      this.pageUsed = 0;
    }
    const view = this.page.subarray(this.pageUsed, this.pageUsed + mono.length);
    view.set(mono);
    this.pageUsed += mono.length;
    return view;
  }

  /** Removes everything from `at` on (the clock jumped back over it). */
  private cutFrom(at: number): void {
    while (this.chunks.length) {
      const c = this.chunks[this.chunks.length - 1]!;
      if (c.start >= at) {
        this.chunks.pop();
        this.bytes -= c.data.byteLength;
      } else if (c.start + c.data.length > at) {
        const keep = at - c.start;
        this.bytes -= (c.data.length - keep) * 2;
        c.data = c.data.slice(0, keep);
        break;
      } else break;
    }
    this.cursor = Math.min(this.cursor, this.chunks.length);
  }

  /** Adds samples [from, from + out.length) times `gain` into `out` (floats, ±1). True when any were there. */
  readInto(from: number, out: Float32Array, gain = 1): boolean {
    const to = from + out.length;
    // The cursor moves forward with the playhead; back to a binary search when it doesn't fit.
    let i = this.cursor;
    if (i >= this.chunks.length || this.chunks[i]!.start > from || (i > 0 && this.chunks[i - 1]!.start + this.chunks[i - 1]!.data.length > from)) {
      let lo = 0;
      let hi = this.chunks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const c = this.chunks[mid]!;
        if (c.start + c.data.length <= from) lo = mid + 1;
        else hi = mid;
      }
      i = lo;
    }
    while (i < this.chunks.length && this.chunks[i]!.start + this.chunks[i]!.data.length <= from) i++;
    this.cursor = i;
    let any = false;
    const k = gain / 32768;
    for (let j = i; j < this.chunks.length; j++) {
      const c = this.chunks[j]!;
      if (c.start >= to) break;
      const a = Math.max(from, c.start);
      const b = Math.min(to, c.start + c.data.length);
      for (let s = a; s < b; s++) out[s - from]! += c.data[s - c.start]! * k;
      if (b > a) any = true;
    }
    return any;
  }

  /** Drops chunks that end before `before`. Returns the bytes freed. */
  trim(before: number): number {
    let n = 0;
    let freed = 0;
    while (n < this.chunks.length && this.chunks[n]!.start + this.chunks[n]!.data.length <= before) {
      freed += this.chunks[n]!.data.byteLength;
      n++;
    }
    if (n) {
      this.chunks.splice(0, n);
      this.cursor = Math.max(0, this.cursor - n);
      this.bytes -= freed;
    }
    return freed;
  }

  /** Drops the oldest chunk (the memory cap). Returns its end, or null when empty. */
  dropOldest(): { end: number; bytes: number } | null {
    const c = this.chunks.shift();
    if (!c) return null;
    this.cursor = Math.max(0, this.cursor - 1);
    this.bytes -= c.data.byteLength;
    return { end: c.start + c.data.length, bytes: c.data.byteLength };
  }

  /** The first sample held (for the memory cap: which buffer holds the oldest audio). */
  get firstStart(): number | null {
    return this.chunks[0]?.start ?? null;
  }

  /** A new sentence starts afresh (after a reconnect, the plugin's clock is another). */
  breakContinuity(): void {
    this.end = null;
    this.resampler?.reset();
  }

  clear(): void {
    this.chunks = [];
    this.page = null;
    this.pageUsed = 0;
    this.cursor = 0;
    this.bytes = 0;
    this.end = null;
  }

  stats(): BufferStats {
    const last = this.chunks[this.chunks.length - 1];
    return { chunks: this.chunks.length, samples: this.bytes / 2, bytes: this.bytes, first: this.chunks[0]?.start ?? null, last: last ? last.start + last.data.length : null, late: this.late, reanchors: this.reanchors, written: this.written };
  }
}
