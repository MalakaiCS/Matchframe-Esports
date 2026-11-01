import type { VoiceBuffer } from "./buffer.ts";
import { RATE } from "./buffer.ts";

/**
 * The Team Comms mixes (ADR-065), one 10 ms block at a time on the production timeline:
 *
 * - **public:** silent unless a listen-in is open for one team; then that team's people included in
 *   the broadcast. Switching teams closes the open team to silence before the other opens (never
 *   both at once); opening and closing are PUBLIC_FADE long.
 * - **recording:** the recording team's people included in the recording, independently of the
 *   public listen-in. Switching team crossfades through silence the same way.
 * - **preview:** the people the operator solos, for the operator's headphones only.
 *
 * Every source is read at the playhead (output time − delay) from its buffer; nothing else ever
 * reaches an output. Inclusion, level and team are applied here, after the buffers, through a gain
 * that ramps over FADE: unchecking someone removes their buffered speech from the next block, fully
 * silent one fade later. A team whose buffer isn't ready at the playhead contributes nothing.
 *
 * Each output also gives per-person activity measured from the samples actually mixed into it
 * (level with attack and release, and whether that is speaking), on the same timeline as the
 * audio. The public output gives team-level activity only.
 */

export const BLOCK = 480;
export type OutputName = "public" | "recording" | "preview";
export const OUTPUTS: readonly OutputName[] = ["public", "recording", "preview"];

export interface MixSource {
  key: string;
  /** The team the person speaks for (their team slot's team). */
  teamId: string | null;
  buffer: VoiceBuffer;
  levelDb: number;
  include: Record<OutputName, boolean>;
}

/** Where a mix goes (phase 3: NDI and the operator's headphones). Gets each block once, in order; must copy what it keeps. */
export interface CommsSink {
  write(samples: Float32Array, startSample: number): void;
}

export interface Activity {
  /** Smoothed level, dBFS (−100 when silent). */
  db: number;
  speaking: boolean;
}

export interface MixBlock {
  /** Output time of the block's first sample (timeline samples). */
  start: number;
  /** What it plays: the timeline sample at the playhead. */
  playhead: number;
  out: Record<OutputName, Float32Array>;
  /** The public gate as heard in this block. */
  public: { team: string | null; gain: number; activity: Activity };
  recording: { team: string | null; gain: number };
  /** Per person, from what is in that output's block. Public is absent on purpose: team level only. */
  activity: { recording: Map<string, Activity>; preview: Map<string, Activity> };
}

export interface MixerOptions {
  /** Inclusion and level ramps. */
  fadeMs: number;
  /** Public listen-in open/close and team switches. */
  publicFadeMs: number;
  attackMs: number;
  releaseMs: number;
  /** Activity above this (smoothed, dBFS) is speaking. */
  speakingDb: number;
}

export const DEFAULT_MIXER: MixerOptions = { fadeMs: 10, publicFadeMs: 40, attackMs: 15, releaseMs: 250, speakingDb: -45 };

const dbToGain = (db: number) => (db <= -60 ? 0 : 10 ** (db / 20));

/** One team gate: one team heard at a time; the old one closes to silence before the new one opens. */
class TeamGate {
  /** The team asked for. */
  target: string | null = null;
  /** The team heard now, and its gain. */
  current: string | null = null;
  gain = 0;
}

class Meter {
  db = -100;
  push(rms: number, blockMs: number, o: MixerOptions): Activity {
    const db = rms > 1e-5 ? 20 * Math.log10(rms) : -100;
    const tc = db > this.db ? o.attackMs : o.releaseMs;
    const a = 1 - Math.exp(-blockMs / Math.max(1, tc));
    this.db += (db - this.db) * a;
    return { db: this.db, speaking: this.db > o.speakingDb };
  }
}

interface SourceState {
  gain: Record<OutputName, number>;
  meters: { recording: Meter; preview: Meter };
}

export class CommsMixer {
  readonly sinks: Record<OutputName, Set<CommsSink>> = { public: new Set(), recording: new Set(), preview: new Set() };
  readonly publicGate: TeamGate;
  readonly recordingGate: TeamGate;
  private readonly state = new Map<string, SourceState>();
  private readonly publicMeter = new Meter();
  private readonly tmp = new Float32Array(BLOCK);
  private readonly pubGains = new Float32Array(BLOCK);
  private readonly recGains = new Float32Array(BLOCK);
  private readonly pubTeams: (string | null)[] = new Array(BLOCK).fill(null);
  private readonly recTeams: (string | null)[] = new Array(BLOCK).fill(null);
  blocks = 0;

  constructor(public options: MixerOptions = DEFAULT_MIXER) {
    this.publicGate = new TeamGate();
    this.recordingGate = new TeamGate();
  }

  /** The team on air through the public output, or null (closed). */
  setPublicTeam(teamId: string | null): void {
    this.publicGate.target = teamId;
  }

  setRecordingTeam(teamId: string | null): void {
    this.recordingGate.target = teamId;
  }

  /** Forgets a person's ramps and meters (they left for good). */
  forget(key: string): void {
    this.state.delete(key);
  }

  /**
   * Mixes the block that starts at output time `start`, reading every source at `playhead`.
   * `ready(team)` says whether that team's buffer holds the delay at the playhead; `mute` forces
   * every source to fade out (a delay change or a resync).
   */
  render(start: number, playhead: number, sources: readonly MixSource[], ready: (teamId: string) => boolean, mute = false): MixBlock {
    const o = this.options;
    const out: Record<OutputName, Float32Array> = { public: new Float32Array(BLOCK), recording: new Float32Array(BLOCK), preview: new Float32Array(BLOCK) };
    // The gates' gain (and team) for each sample of this block.
    this.stepGate(this.publicGate, this.pubGains, this.pubTeams);
    this.stepGate(this.recordingGate, this.recGains, this.recTeams);
    const fadeRate = 1 / Math.max(1, (o.fadeMs * RATE) / 1000);
    const blockMs = (BLOCK / RATE) * 1000;
    const recAct = new Map<string, Activity>();
    const prevAct = new Map<string, Activity>();
    const live = new Set<string>();
    for (const src of sources) {
      live.add(src.key);
      let st = this.state.get(src.key);
      if (!st) {
        st = { gain: { public: 0, recording: 0, preview: 0 }, meters: { recording: new Meter(), preview: new Meter() } };
        this.state.set(src.key, st);
      }
      const teamReady = src.teamId !== null && ready(src.teamId);
      const level = dbToGain(src.levelDb);
      const target: Record<OutputName, number> = {
        public: !mute && teamReady && src.include.public ? level : 0,
        recording: !mute && teamReady && src.include.recording ? level : 0,
        preview: !mute && teamReady && src.include.preview ? 1 : 0,
      };
      const audible = OUTPUTS.some((n) => target[n] > 0 || st.gain[n] > 0);
      this.tmp.fill(0);
      const has = audible && teamReady && src.buffer.readInto(playhead, this.tmp);
      for (const name of OUTPUTS) {
        let g = st.gain[name];
        const t = target[name];
        if (!has) {
          // Nothing to hear: the ramp still moves so a later block starts where it should.
          const n = Math.min(BLOCK, Math.ceil(Math.abs(t - g) / fadeRate));
          g = g < t ? Math.min(t, g + n * fadeRate) : Math.max(t, g - n * fadeRate);
          st.gain[name] = g;
          if (name !== "public") (name === "recording" ? recAct : prevAct).set(src.key, st.meters[name].push(0, blockMs, o));
          continue;
        }
        const dst = out[name];
        let sumSq = 0;
        for (let i = 0; i < BLOCK; i++) {
          if (g < t) g = Math.min(t, g + fadeRate);
          else if (g > t) g = Math.max(t, g - fadeRate);
          let v = this.tmp[i]! * g;
          if (name === "public") v *= this.pubTeams[i] === src.teamId ? this.pubGains[i]! : 0;
          else if (name === "recording") v *= this.recTeams[i] === src.teamId ? this.recGains[i]! : 0;
          dst[i]! += v;
          sumSq += v * v;
        }
        st.gain[name] = g;
        if (name !== "public") (name === "recording" ? recAct : prevAct).set(src.key, st.meters[name].push(Math.sqrt(sumSq / BLOCK), blockMs, o));
      }
    }
    for (const k of this.state.keys()) if (!live.has(k)) this.state.delete(k);
    let pubSq = 0;
    for (const name of OUTPUTS) {
      const b = out[name];
      for (let i = 0; i < BLOCK; i++) {
        // A hard limit, never reached at sane levels; keeps a sum of many voices from wrapping.
        const v = b[i]!;
        if (v > 1) b[i] = 1;
        else if (v < -1) b[i] = -1;
      }
    }
    for (let i = 0; i < BLOCK; i++) pubSq += out.public[i]! ** 2;
    const pubAct = this.publicMeter.push(Math.sqrt(pubSq / BLOCK), blockMs, o);
    this.blocks++;
    const block: MixBlock = {
      start,
      playhead,
      out,
      public: { team: this.publicGate.current, gain: this.publicGate.gain, activity: pubAct },
      recording: { team: this.recordingGate.current, gain: this.recordingGate.gain },
      activity: { recording: recAct, preview: prevAct },
    };
    for (const name of OUTPUTS) for (const s of this.sinks[name]) s.write(out[name], start);
    return block;
  }

  private stepGate(gate: TeamGate, gains: Float32Array, teams: (string | null)[]): void {
    // Per sample: which team is heard and how loud (the gate may switch team inside a block).
    const rate = 1 / Math.max(1, gate === this.publicGate ? (this.options.publicFadeMs * RATE) / 1000 : (this.options.fadeMs * RATE) / 1000);
    for (let i = 0; i < BLOCK; i++) {
      if (gate.current !== gate.target) {
        if (gate.current !== null && gate.gain > 0) gate.gain = Math.max(0, gate.gain - rate);
        else {
          gate.current = gate.target;
          gate.gain = 0;
        }
      } else if (gate.current !== null && gate.gain < 1) gate.gain = Math.min(1, gate.gain + rate);
      gains[i] = gate.current === null ? 0 : gate.gain;
      teams[i] = gate.current;
    }
  }
}
