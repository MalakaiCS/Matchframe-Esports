/**
 * Slow motion in rendered replays (ADR-081). A clip's part is cut into pieces: real-speed pieces as
 * before, and slowed windows around each kill (or the whole part). In a window the picture's time is
 * stretched by a time map (setpts): it eases from real speed down to the slow speed over SLOW_EASE_MS,
 * holds from SLOW_BEFORE_MS before the kill to SLOW_AFTER_MS after it, and eases back up. The frames
 * the slowed picture lacks are made by blending the two nearest (ffmpeg's framerate filter), or with
 * Smooth slow motion by motion interpolation (minterpolate), which costs far more CPU. Each piece is
 * made to a whole number of output frames and the pieces are joined, so real-speed frames after a
 * window are the clip's own frames, not blends.
 *
 * The ease is smoothstep-shaped in how much each source moment is stretched: the stretch k goes from 1
 * to K (= 100 / speed) as 3u² − 2u³ over the ease, so speed changes without a jolt at either end. The
 * time map is its integral: t = x + (K − 1)·E·(u³ − u⁴/2) over an ease of E (u = x / E), K·x in the
 * hold. An ease of E source ms lasts E·(1 + K)/2 on air; a hold of H lasts K·H.
 *
 * The game's sound during a window: muted (the default), fading out over SLOW_AUDIO_FADE_MS just
 * before the ease in and back in after the ease out; or slowed with its pitch kept (atempo, one tempo
 * for the window so its length matches the picture's; a gunshot can sound doubled at 50 % and more so
 * at 33 %, which is why muted is the default).
 */

export type SlowMode = "off" | "kill" | "whole";
export type SlowAudio = "mute" | "pitch";

/** Each ease (source ms): from real speed down to the slow speed, and back up. */
export const SLOW_EASE_MS = 300;
/** The slow hold starts this long before a kill (the shot itself is slow; a kill's time is known to about 0.1 s)… */
export const SLOW_BEFORE_MS = 200;
/** …and ends this long after it (the hit, the fall). */
export const SLOW_AFTER_MS = 800;
/** Two kills whose slowed windows come closer than this are held slow between them (no speed-up and slow-down again). */
export const SLOW_JOIN_MS = 400;
/** Muted: the game sound fades out this long before a window, and back in after it. */
export const SLOW_AUDIO_FADE_MS = 120;
/** Slowed sound with its pitch kept: a short fade at each join, so they don't click. */
const JOIN_FADE_MS = 15;

/** What slows one clip: where its kills are in its part, how slow, and how. */
export interface SlowSpec {
  /** Around each kill (ease in, hold, ease out), or the whole part at the slow speed. */
  mode: "kill" | "whole";
  /** The slow speed in percent of real time (50 or 33). */
  speedPercent: number;
  /** Each kill's time from the start of the part (ms). With "kill" and none known, nothing is slowed. */
  killsMs: number[];
  /** Motion interpolation (minterpolate) for the missing frames instead of blending. */
  smooth: boolean;
  audio: SlowAudio;
}

/** A slowed stretch of a part (ms from the part's start): it eases in from `from`, holds from `holdFrom` to `holdTo`, and eases out until `to`. */
export interface SlowWindow {
  from: number;
  holdFrom: number;
  holdTo: number;
  to: number;
}

/** One piece of a slowed part, as ffmpeg makes it: at real speed, or a slowed window; and how many output frames it makes. */
export interface SlowSegment {
  kind: "real" | "slow";
  /** Source ms from the part's start. */
  from: number;
  to: number;
  /** A slowed window (its ease and hold, the same source ms). */
  window: SlowWindow | null;
  frames: number;
  /** On air (ms): frames at the output rate. */
  outMs: number;
}

/** A slowed part: its pieces, its length on air, and how the slowed windows are made. */
export interface SlowPlan {
  /** How many times longer a held moment lasts (2 at 50 %, 3 at 33 %). */
  factor: number;
  segments: SlowSegment[];
  /** The part on air (ms): every piece's frames at the output rate. */
  outMs: number;
  smooth: boolean;
  audio: SlowAudio;
}

/**
 * In a list of clips where a moment's extra angles follow its first clip (highlights): whether clip `k`
 * is slowed. An extra angle is; a first clip its own extra angle follows plays at real time (the angle
 * is the slow look); any other clip is.
 */
export function slowInList(items: readonly { id: string; momentOf?: string | null }[], k: number): boolean {
  const it = items[k]!;
  return !!it.momentOf || items[k + 1]?.momentOf !== it.id;
}

/** How many times longer a held moment lasts at a slow speed: 50 % → 2, 33 % → 3. */
export const slowFactor = (speedPercent: number): number => Math.max(1, Math.round(100 / Math.max(1, speedPercent)));

/**
 * The slowed windows of a part `sourceMs` long: one around each kill in it (kills whose windows come
 * within SLOW_JOIN_MS are held slow between them), cut at the part's ends (a shorter ease there); or,
 * "whole", the part itself (no ease: it plays at the slow speed throughout).
 */
export function slowWindows(spec: Pick<SlowSpec, "mode" | "killsMs">, sourceMs: number): SlowWindow[] {
  if (sourceMs <= 0) return [];
  if (spec.mode === "whole") return [{ from: 0, holdFrom: 0, holdTo: sourceMs, to: sourceMs }];
  const kills = [...new Set(spec.killsMs.filter((k) => Number.isFinite(k) && k >= 0 && k <= sourceMs))].sort((a, b) => a - b);
  const out: SlowWindow[] = [];
  for (const k of kills) {
    const holdFrom = Math.max(0, k - SLOW_BEFORE_MS);
    const holdTo = Math.min(sourceMs, k + SLOW_AFTER_MS);
    const w = { from: Math.max(0, holdFrom - SLOW_EASE_MS), holdFrom, holdTo, to: Math.min(sourceMs, holdTo + SLOW_EASE_MS) };
    const last = out[out.length - 1];
    if (last && w.from - last.to < SLOW_JOIN_MS) {
      last.holdTo = Math.max(last.holdTo, w.holdTo);
      last.to = Math.max(last.to, w.to);
    } else out.push(w);
  }
  return out;
}

/** How long a slowed window lasts on air (ms), unrounded: its eases at (1 + K)/2, its hold at K. */
export function windowOutMs(w: SlowWindow, factor: number): number {
  const easeIn = w.holdFrom - w.from;
  const easeOut = w.to - w.holdTo;
  return ((easeIn + easeOut) * (1 + factor)) / 2 + factor * (w.holdTo - w.holdFrom);
}

/** How long a part `sourceMs` long lasts on air with this slow motion (ms, unrounded; for planning a break). */
export function slowOutMs(spec: Pick<SlowSpec, "mode" | "killsMs" | "speedPercent"> | null, sourceMs: number): number {
  if (!spec) return sourceMs;
  const K = slowFactor(spec.speedPercent);
  return sourceMs + slowWindows(spec, sourceMs).reduce((n, w) => n + windowOutMs(w, K) - (w.to - w.from), 0);
}

/**
 * Where a source moment `x` ms into a slowed window is on air (ms from the window's start): the time
 * map windowExpr gives ffmpeg, here for tests and checks.
 */
export function windowMap(w: SlowWindow, factor: number, x: number): number {
  if (x > w.to - w.from) return windowOutMs(w, factor) + x - (w.to - w.from);
  const K = factor;
  const e1 = w.holdFrom - w.from;
  const h = w.holdTo - w.holdFrom;
  const e2 = w.to - w.holdTo;
  const ease = (len: number, d: number) => {
    const u = len > 0 ? Math.min(1, Math.max(0, d / len)) : 1;
    return len * (u ** 3 - u ** 4 / 2);
  };
  const t1 = (e1 * (1 + K)) / 2;
  if (x < e1) return x + (K - 1) * ease(e1, x);
  if (x < e1 + h) return t1 + K * (x - e1);
  const y = Math.min(e2, x - e1 - h);
  return t1 + K * h + K * y + (1 - K) * ease(e2, y);
}

const num = (ms: number) => (ms / 1000).toFixed(6).replace(/\.?0+$/, "") || "0";

/**
 * A slowed window's time map as an ffmpeg expression (setpts): the output time in seconds for an input
 * frame at T seconds from the window's start (piecewise: the ease in, the hold, the ease out).
 */
export function windowExpr(w: SlowWindow, factor: number): string {
  const K = factor;
  const e1 = w.holdFrom - w.from;
  const h = w.holdTo - w.holdFrom;
  const e2 = w.to - w.holdTo;
  const t1 = (e1 * (1 + K)) / 2;
  const t2 = t1 + K * h;
  // (x³ − x⁴/2 with x = d / len; written without pow() so there are only the if/lt commas.)
  const easeTerm = (len: number, d: string) => {
    const u = `(${d})/${num(len)}`;
    return `${num(len)}*(${u}*${u}*${u}-${u}*${u}*${u}*${u}/2)`;
  };
  const inEase = e1 > 0 ? `T+${K - 1}*${easeTerm(e1, "T")}` : "T";
  const hold = `${num(t1)}+${K}*(T-${num(e1)})`;
  const outD = `T-${num(e1 + h)}`;
  const outEase = e2 > 0 ? `${num(t2)}+${K}*(${outD})-${K - 1}*${easeTerm(e2, outD)}` : `${num(t2)}+${K}*(${outD})`;
  // Past the window (the frames read beyond it so the last made frames have a frame after them): real speed.
  const after = `${num(t2 + (e2 * (1 + K)) / 2)}+(T-${num(e1 + h + e2)})`;
  return `if(lt(T,${num(e1)}),${inEase},if(lt(T,${num(e1 + h)}),${hold},if(lt(T,${num(e1 + h + e2)}),${outEase},${after})))`;
}

/** Frames read past a slowed window's end: blending and interpolation make the frames between two of the clip's, so the last ones need a frame after them. */
const BEYOND_FRAMES = 3;

/**
 * The pieces of a part `sourceMs` long with this slow motion, made at `outFps` (the break's frame
 * rate): the windows' edges on the source's frames (`srcFps`, when known), each piece a whole number of
 * output frames. Null when nothing in it is slowed (no kill in the part).
 */
export function planSlow(spec: SlowSpec, sourceMs: number, srcFps: number | null, outFps: number): SlowPlan | null {
  const windows = slowWindows(spec, sourceMs);
  if (!windows.length || outFps <= 0) return null;
  const K = slowFactor(spec.speedPercent);
  if (K <= 1) return null;
  const snap = (x: number) => Math.max(0, Math.min(sourceMs, srcFps && srcFps > 0 ? Math.round((x * srcFps) / 1000) * (1000 / srcFps) : x));
  const frames = (ms: number) => Math.max(1, Math.round((ms * outFps) / 1000));
  const segments: SlowSegment[] = [];
  let at = 0;
  for (const raw of windows) {
    const from = snap(raw.from);
    const to = snap(raw.to);
    if (to - from < 1) continue;
    // The ease and hold keep their lengths from the window's (snapped) start; the hold takes up what the snap moved.
    const w: SlowWindow = { from, holdFrom: Math.min(to, Math.max(from, raw.holdFrom)), holdTo: Math.max(from, Math.min(to, raw.holdTo)), to };
    if (from - at >= 1) segments.push({ kind: "real", from: at, to: from, window: null, frames: frames(from - at), outMs: 0 });
    segments.push({ kind: "slow", from, to, window: w, frames: frames(windowOutMs(w, K)), outMs: 0 });
    at = to;
  }
  if (!segments.some((s) => s.kind === "slow")) return null;
  if (sourceMs - at >= 1) segments.push({ kind: "real", from: at, to: sourceMs, window: null, frames: frames(sourceMs - at), outMs: 0 });
  for (const s of segments) s.outMs = (s.frames * 1000) / outFps;
  return { factor: K, segments, outMs: segments.reduce((n, s) => n + s.outMs, 0), smooth: spec.smooth, audio: spec.audio };
}

/** The motion interpolation Smooth slow motion uses (bidirectional motion estimation, overlapped-block compensation). */
const SMOOTH = (fps: number) => `minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=none`;

/** How many output frames of a plan are made by motion interpolation (Smooth slow motion's cost). */
export const slowFramesOf = (plan: SlowPlan | null): number => (plan ? plan.segments.filter((s) => s.kind === "slow").reduce((n, s) => n + s.frames, 0) : 0);

/**
 * ffmpeg filter chains for a slowed part's picture: `input` (already shaped to the output size and
 * pixel format, from the part's start at 0) split into its pieces; each real piece at the output frame
 * rate, each slowed window through its time map and the frames made between (blended or interpolated);
 * each piece cut to its frames; joined into `out`.
 */
export function slowVideoChains(input: string, plan: SlowPlan, fps: number, prefix: string, out: string, srcFps: number | null = null): string[] {
  const n = plan.segments.length;
  const parts: string[] = [n > 1 ? `[${input}]split=${n}${plan.segments.map((_, j) => `[${prefix}s${j}]`).join("")}` : `[${input}]null[${prefix}s0]`];
  const beyond = (BEYOND_FRAMES * 1000) / (srcFps && srcFps > 0 ? srcFps : 30);
  plan.segments.forEach((s, j) => {
    const cut = `trim=start=${num(s.from)}:end=${num(s.kind === "slow" ? s.to + beyond : s.to)},setpts=PTS-STARTPTS`;
    const exact = `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${s.frames},setpts=PTS-STARTPTS`;
    if (s.kind === "real") parts.push(`[${prefix}s${j}]${cut},fps=${fps},${exact}[${prefix}p${j}]`);
    else parts.push(`[${prefix}s${j}]${cut},setpts='(${windowExpr(s.window!, plan.factor)})/TB',${plan.smooth ? SMOOTH(fps) : `framerate=fps=${fps}`},${exact}[${prefix}p${j}]`);
  });
  // (concat leaves a microsecond time base; the fades between clips need the output rate's, as the other clips have.)
  parts.push(`${plan.segments.map((_, j) => `[${prefix}p${j}]`).join("")}concat=n=${n}:v=1:a=0,fps=${fps}[${out}]`);
  return parts;
}

/** atempo filters for a tempo below 0.5 (each atempo takes 0.5–100). */
function atempo(tempo: number): string {
  const out: string[] = [];
  let t = tempo;
  while (t < 0.5) {
    out.push("atempo=0.5");
    t /= 0.5;
  }
  out.push(`atempo=${t.toFixed(6)}`);
  return out.join(",");
}

const SILENCE = "anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

/**
 * ffmpeg filter chains for a slowed part's sound: `input` (48 kHz stereo from the part's start, or null
 * without sound: silence) cut at the same pieces. Real pieces as they are; slowed windows muted (the
 * sound fading out before and in after) or slowed with the pitch kept (atempo); each piece exactly as
 * long as its frames; joined into `out`.
 */
export function slowAudioChains(input: string | null, plan: SlowPlan, prefix: string, out: string): string[] {
  const segs = plan.segments;
  const sec = (ms: number) => num(Math.max(0, ms));
  if (!input) return [`${SILENCE},atrim=duration=${sec(plan.outMs)}[${out}]`];
  const used = segs.filter((s) => s.kind === "real" || plan.audio === "pitch");
  // (The whole part slowed and muted: its sound isn't used.)
  const parts: string[] = [used.length > 1 ? `[${input}]asplit=${used.length}${used.map((_, k) => `[${prefix}a${k}]`).join("")}` : used.length ? `[${input}]anull[${prefix}a0]` : `[${input}]anullsink`];
  let k = 0;
  segs.forEach((s, j) => {
    const exact = `apad,atrim=duration=${sec(s.outMs)},asetpts=PTS-STARTPTS`;
    if (s.kind === "slow" && plan.audio === "mute") {
      parts.push(`${SILENCE},atrim=duration=${sec(s.outMs)}[${prefix}b${j}]`);
      return;
    }
    const src = `[${prefix}a${k++}]atrim=start=${sec(s.from)}:end=${sec(s.to)},asetpts=PTS-STARTPTS`;
    if (s.kind === "slow") {
      const tempo = (s.to - s.from) / s.outMs;
      parts.push(`${src},${atempo(tempo)},afade=t=in:d=${sec(JOIN_FADE_MS)},afade=t=out:st=${sec(s.outMs - JOIN_FADE_MS)}:d=${sec(JOIN_FADE_MS)},${exact}[${prefix}b${j}]`);
      return;
    }
    // A real piece next to a window: the sound fades out into it and in from it (muted: SLOW_AUDIO_FADE_MS; slowed: a short join).
    const fade = plan.audio === "mute" ? Math.min(SLOW_AUDIO_FADE_MS, s.outMs / 2) : Math.min(JOIN_FADE_MS, s.outMs / 2);
    const fades = [segs[j - 1]?.kind === "slow" ? `afade=t=in:d=${sec(fade)}` : "", segs[j + 1]?.kind === "slow" ? `afade=t=out:st=${sec(s.outMs - fade)}:d=${sec(fade)}` : ""].filter(Boolean);
    parts.push(`${src},${exact}${fades.length ? `,${fades.join(",")}` : ""}[${prefix}b${j}]`);
  });
  parts.push(`${segs.map((_, j) => `[${prefix}b${j}]`).join("")}concat=n=${segs.length}:v=0:a=1[${out}]`);
  return parts;
}
