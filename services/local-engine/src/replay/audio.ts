import type { Engine } from "../app.ts";
import { VmixClient, vmixVolumeAfter } from "./vmix.ts";

/**
 * Sound during a break's replays (replay/auto.ts): the live game audio the operator picked is turned
 * down (or muted) with a short ramp as the replays start, and put back to its exact volume and mute
 * after them, however they end (the last clip, Skip, Stop and go live, the round clock, an error, the
 * operator taking the program). Only the inputs picked are touched: casters' microphones never, unless
 * picked. In OBS the inputs are OBS audio inputs; with vMix as the replay mixer, vMix inputs.
 *
 * The volumes before the replays are saved in the engine's settings before anything is changed, so a
 * crash or a restart in the middle of a break puts them back at the next start (when OBS connects, or
 * vMix answers). If the operator moved one of the faders meanwhile, it is left as they put it.
 *
 * The replay media sources' own volume (both of OBS's, the replay scene's and its twin's, or each
 * vMix replay input) is a setting too, so replays can be louder or quieter than they were recorded.
 */

/** What the live audio goes down to: muted, or this many dB lower. */
export type DuckTo = "mute" | number;

export interface AudioSettings {
  mixer: "obs" | "vmix";
  vmixUrl: string;
  /** OBS inputs (names) or vMix inputs (keys) that are the live game audio; empty: nothing is turned down. */
  duckInputs: string[];
  duckVmixInputs: string[];
  duckTo: DuckTo;
  duckRampMs: number;
  /** The replay media sources' volume in dB (0 = as recorded); null: left as set in OBS. */
  replayVolumeDb: number | null;
}

/** One input turned down: what it was before the replays (put back after), and what it was set to. */
interface SavedInput {
  /** OBS: the input's name; vMix: its key. */
  id: string;
  /** For the status: its name (vMix: its title). */
  name: string;
  /** Before: OBS's multiplier (vMix: its 0–100 fader) and mute. */
  volume: number;
  muted: boolean;
  /** As turned down. */
  setVolume: number;
  setMuted: boolean;
}

interface Saved {
  mixer: "obs" | "vmix";
  vmixUrl: string | null;
  inputs: SavedInput[];
  at: string;
}

export interface DuckStatus {
  /** off: no input picked; idle: nothing turned down; lowered: the live audio is down for replays; pending: it is still down after a break (or a restart) and is put back as soon as the mixer answers. */
  state: "off" | "idle" | "lowered" | "pending";
  detail: string;
  /** The inputs turned down now. */
  lowered: string[];
  /** The last time the live audio was put back. */
  lastRestore: { at: string; ok: boolean; detail: string } | null;
}

/** An input with audio the operator can pick as the live game audio. */
export interface AudioInput {
  /** OBS: its name; vMix: its key. */
  id: string;
  name: string;
  kind: string;
  /** OBS: dB; vMix: its 0–100 fader. */
  volume: number;
  muted: boolean;
  picked: boolean;
  /** A replay media source (never turned down). */
  replay: boolean;
}

const SAVED_KEY = "replay.duck";
/** One volume step of a ramp every this long. */
const STEP_MS = 50;
/** Muting: the volume first goes down this far, then the input is muted (and comes back from there). */
const MUTE_FLOOR_DB = -40;
/** A fader within this of what the duck set is still the duck's (OBS rounds the multiplier). */
const SAME_MUL = 0.02;
const SAME_VMIX = 1;

const dbOf = (mul: number) => (mul <= 0 ? -100 : 20 * Math.log10(mul));
const mulOf = (db: number) => (db <= -100 ? 0 : 10 ** (db / 20));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ReplayAudio {
  private chain: Promise<unknown> = Promise.resolve();
  private lastRestore: DuckStatus["lastRestore"] = null;
  private triedAt = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly e: Engine,
    private readonly settings: () => AudioSettings,
  ) {}

  /** After a start: live audio turned down before a crash or a restart is put back once the mixer answers. */
  start(): void {
    const onConnected = () => {
      if (this.saved()?.mixer === "obs") void this.restore("OBS connected");
    };
    this.e.obs.on("connected", onConnected);
    this.cleanup.push(() => this.e.obs.off("connected", onConnected));
    const s = this.saved();
    if (s) {
      this.e.logger.warn("replay audio: live audio was still turned down from a break before the restart; it is put back when the mixer answers", { inputs: s.inputs.map((i) => i.name) });
      if (s.mixer === "obs" && this.e.obs.state.connected) void this.restore("start");
    }
  }

  dispose(): void {
    for (const fn of this.cleanup.splice(0)) fn();
  }

  /**
   * Still turned down (the mixer didn't answer after a break, or a restart): tried again every few
   * seconds while no break is playing (auto.ts's tick); OBS only while connected (it is also tried
   * as OBS connects).
   */
  retry(): void {
    const s = this.saved();
    if (!s || this.e.now() - this.triedAt < 3000 || (s.mixer === "obs" && !this.e.obs.state.connected)) return;
    this.triedAt = this.e.now();
    void this.restore(s.mixer === "vmix" ? "vMix answers" : "OBS answers");
  }

  private saved(): Saved | null {
    const s = this.e.settings.get<Saved | null>(SAVED_KEY, null);
    return s && (s.mixer === "obs" || s.mixer === "vmix") && Array.isArray(s.inputs) ? s : null;
  }

  private save(s: Saved | null): void {
    this.e.settings.set(SAVED_KEY, s && s.inputs.length ? s : null);
  }

  /** Whether live audio is turned down now (by a break, or left so by one). */
  get lowered(): boolean {
    return this.saved() !== null;
  }

  status(): DuckStatus {
    const st = this.settings();
    const picked = st.mixer === "vmix" ? st.duckVmixInputs : st.duckInputs;
    const s = this.saved();
    const lowered = s?.inputs.map((i) => i.name) ?? [];
    if (s) return { state: "lowered", detail: `Turned down for replays: ${lowered.join(", ")}.`, lowered, lastRestore: this.lastRestore };
    if (!picked.length) return { state: "off", detail: "No live game audio picked: nothing is turned down during replays.", lowered, lastRestore: this.lastRestore };
    const how = st.duckTo === "mute" ? "muted" : `turned down ${-st.duckTo} dB`;
    return { state: "idle", detail: `During replays, ${picked.length === 1 ? "the live game audio is" : `${picked.length} live game audio inputs are`} ${how}.`, lowered, lastRestore: this.lastRestore };
  }

  /** As a break's replays start: the picked live audio inputs go down with a short ramp (their volumes saved first). */
  duck(): Promise<void> {
    return this.serial(async () => {
      const st = this.settings();
      try {
        if (st.mixer === "vmix") await this.duckVmix(st);
        else await this.duckObs(st);
      } catch (err) {
        this.e.logger.warn("replay audio: could not turn the live audio down", { error: String(err) });
      }
    });
  }

  private async duckObs(st: AudioSettings): Promise<void> {
    const obs = this.e.obs;
    const replay = new Set(this.replayInputs());
    const picked = st.duckInputs.filter((n) => !replay.has(n));
    if (!picked.length || !obs.state.connected) return;
    const before = this.saved();
    const known = new Map((before?.mixer === "obs" ? before.inputs : []).map((i) => [i.id, i]));
    const now = await Promise.all(picked.map((name) => obs.inputVolume(name).then((v) => ({ name, v })).catch(() => null)));
    const inputs: SavedInput[] = [];
    for (const r of now) {
      if (!r) continue;
      // Still down from an earlier break that couldn't put it back: its volume before that one is the one to put back.
      const old = known.get(r.name);
      const volume = old ? old.volume : r.v.mul;
      const muted = old ? old.muted : r.v.muted;
      const setVolume = st.duckTo === "mute" ? mulOf(dbOf(volume) + MUTE_FLOOR_DB) : mulOf(dbOf(volume) + st.duckTo);
      inputs.push({ id: r.name, name: r.name, volume, muted, setVolume, setMuted: st.duckTo === "mute" ? true : muted });
    }
    // Saved before anything changes.
    this.save({ mixer: "obs", vmixUrl: null, inputs: [...inputs, ...[...known.values()].filter((k) => !inputs.some((i) => i.id === k.id))], at: new Date().toISOString() });
    await Promise.all(
      inputs.map(async (i) => {
        const from = (await obs.inputVolume(i.id).catch(() => null))?.mul ?? i.volume;
        await this.rampObs(i.id, from, i.setVolume, st.duckRampMs);
        if (i.setMuted && !i.muted) await obs.setInputVolume(i.id, { muted: true });
      }),
    );
  }

  private async duckVmix(st: AudioSettings): Promise<void> {
    if (!st.duckVmixInputs.length) return;
    const vmix = new VmixClient(st.vmixUrl);
    const state = await vmix.state();
    const before = this.saved();
    const known = new Map((before?.mixer === "vmix" ? before.inputs : []).map((i) => [i.id, i]));
    const inputs: SavedInput[] = [];
    for (const key of st.duckVmixInputs) {
      const x = state.inputs.find((i) => i.key === key);
      if (!x || x.volume === null) continue;
      const old = known.get(key);
      const volume = old ? old.volume : x.volume;
      const muted = old ? old.muted : x.muted === true;
      const setVolume = st.duckTo === "mute" ? vmixVolumeAfter(volume, MUTE_FLOOR_DB) : vmixVolumeAfter(volume, st.duckTo);
      inputs.push({ id: key, name: x.title, volume, muted, setVolume, setMuted: st.duckTo === "mute" ? true : muted });
    }
    this.save({ mixer: "vmix", vmixUrl: st.vmixUrl, inputs: [...inputs, ...[...known.values()].filter((k) => !inputs.some((i) => i.id === k.id))], at: new Date().toISOString() });
    await Promise.all(inputs.map((i) => vmix.call("SetVolumeFade", { Input: i.id, Value: `${round2(i.setVolume)},${Math.max(0, st.duckRampMs)}` })));
    const mute = inputs.filter((i) => i.setMuted && !i.muted);
    if (mute.length) {
      await sleep(st.duckRampMs);
      await Promise.all(mute.map((i) => vmix.call("AudioOff", { Input: i.id })));
    }
  }

  /**
   * After the replays: every input turned down goes back to its exact volume and mute before them,
   * with the same ramp, unless the operator changed it meanwhile (then it stays as they put it).
   * What can't be put back now (the mixer doesn't answer) stays saved and is tried again.
   */
  restore(why = "the replays are over"): Promise<{ ok: boolean; detail: string }> {
    return this.serial(async () => {
      const s = this.saved();
      if (!s) return { ok: true, detail: "Nothing was turned down." };
      const st = this.settings();
      const left: SavedInput[] = [];
      const done: string[] = [];
      const kept: string[] = [];
      const problems: string[] = [];
      if (s.mixer === "obs") {
        const obs = this.e.obs;
        await Promise.all(
          s.inputs.map(async (i) => {
            try {
              const now = await obs.inputVolume(i.id);
              const ours = Math.abs(now.mul - i.setVolume) <= SAME_MUL * Math.max(i.setVolume, 0.01) && now.muted === i.setMuted;
              if (!ours) return void kept.push(i.name);
              if (now.muted && !i.muted) await obs.setInputVolume(i.id, { muted: false });
              await this.rampObs(i.id, now.mul, i.volume, st.duckRampMs);
              await obs.setInputVolume(i.id, { mul: i.volume, muted: i.muted });
              done.push(i.name);
            } catch (err) {
              left.push(i);
              problems.push(`${i.name}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }),
        );
      } else {
        const vmix = new VmixClient(s.vmixUrl ?? st.vmixUrl);
        try {
          const state = await vmix.state();
          await Promise.all(
            s.inputs.map(async (i) => {
              const x = state.inputs.find((k) => k.key === i.id);
              if (!x) return void kept.push(i.name);
              const ours = x.volume !== null && Math.abs(x.volume - i.setVolume) <= SAME_VMIX && (x.muted === null || x.muted === i.setMuted);
              if (!ours) return void kept.push(i.name);
              try {
                if (x.muted && !i.muted) await vmix.call("AudioOn", { Input: i.id });
                await vmix.call("SetVolumeFade", { Input: i.id, Value: `${round2(i.volume)},${Math.max(0, st.duckRampMs)}` });
                done.push(i.name);
              } catch (err) {
                left.push(i);
                problems.push(`${i.name}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }),
          );
          // SetVolumeFade lands on the volume; the exact one is set once it is over.
          if (done.length) {
            await sleep(st.duckRampMs + 50);
            await Promise.all(s.inputs.filter((i) => done.includes(i.name)).map((i) => vmix.call("SetVolume", { Input: i.id, Value: round2(i.volume) }).catch(() => undefined)));
          }
        } catch (err) {
          left.push(...s.inputs);
          problems.push(`vMix: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.save(left.length ? { ...s, inputs: left } : null);
      const ok = left.length === 0;
      const detail = [done.length ? `Put back: ${done.join(", ")}.` : "", kept.length ? `Changed by hand during the replays, left as it is: ${kept.join(", ")}.` : "", left.length ? `Not put back yet (tried again when the mixer answers): ${problems.join("; ")}.` : ""].filter(Boolean).join(" ") || "Nothing to put back.";
      this.lastRestore = { at: new Date().toISOString(), ok, detail };
      if (!ok) this.e.logger.warn("replay audio: could not put the live audio back yet", { why, problems });
      else if (why !== "the replays are over") this.e.logger.info("replay audio: live audio put back", { why, inputs: done });
      return { ok, detail };
    });
  }

  /** OBS: from one multiplier to another in steps (even in dB), the last step exact. */
  private async rampObs(name: string, from: number, to: number, rampMs: number): Promise<void> {
    const steps = Math.max(1, Math.round(rampMs / STEP_MS));
    const a = Math.max(dbOf(from), -100);
    const b = Math.max(dbOf(to), -100);
    for (let k = 1; k < steps; k++) {
      await this.e.obs.setInputVolume(name, { mul: mulOf(a + ((b - a) * k) / steps) });
      await sleep(rampMs / steps);
    }
    await this.e.obs.setInputVolume(name, { mul: to });
  }

  /** The OBS replay media sources: the replay scene's and its twin's. */
  replayInputs(): string[] {
    const main = this.e.settings.get<string | null>("replay.mediaInput", null);
    const twin = this.e.replayTwin.getStatus().input;
    return [main, twin].filter((x): x is string => !!x);
  }

  /** OBS: the replay media sources' volume as set (before a break, and when the setting changes). */
  async applyReplayVolume(): Promise<void> {
    const db = this.settings().replayVolumeDb;
    if (db === null || !this.e.obs.state.connected) return;
    for (const name of this.replayInputs()) {
      const now = await this.e.obs.inputVolume(name).catch(() => null);
      if (now && Math.abs(now.db - db) > 0.05) await this.e.obs.setInputVolume(name, { db }).catch((err) => this.e.logger.warn("replay audio: could not set the replay volume", { input: name, error: String(err) }));
    }
  }

  /** vMix: a replay input's volume as set (vMix's fader for up to 0 dB, its gain above). */
  async applyVmixReplayVolume(vmix: VmixClient, key: string): Promise<void> {
    const db = this.settings().replayVolumeDb;
    if (db === null || db === 0) return;
    if (db < 0) await vmix.call("SetVolume", { Input: key, Value: round2(vmixVolumeAfter(100, db)) });
    else await vmix.call("SetGain", { Input: key, Value: Math.round(Math.min(24, db)) });
  }

  /** The mixer's inputs with audio, for picking the live game audio. */
  async inputs(): Promise<{ mixer: "obs" | "vmix"; inputs: AudioInput[]; error: string | null }> {
    const st = this.settings();
    try {
      if (st.mixer === "vmix") {
        const state = await new VmixClient(st.vmixUrl).state();
        return { mixer: "vmix", error: null, inputs: state.inputs.filter((i) => i.volume !== null).map((i) => ({ id: i.key, name: i.title, kind: i.type, volume: i.volume!, muted: i.muted === true, picked: st.duckVmixInputs.includes(i.key), replay: false })) };
      }
      if (!this.e.obs.state.connected) return { mixer: "obs", inputs: [], error: "OBS isn't connected (Settings → Devices)." };
      const replay = new Set(this.replayInputs());
      const list = await this.e.obs.audioInputs();
      return { mixer: "obs", error: null, inputs: list.map((i) => ({ id: i.name, name: i.name, kind: i.kind, volume: Math.round(i.db * 10) / 10, muted: i.muted, picked: st.duckInputs.includes(i.name), replay: replay.has(i.name) })) };
    } catch (err) {
      return { mixer: st.mixer, inputs: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
