import type { ObsManager } from "@matchframe/obs-adapter";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import type { DuckPeer } from "../replay/audio.ts";

/**
 * Caster ducking while a listen-in is open (ADR-066): the OBS inputs the operator picked as the
 * casters go down by the configured amount with a short ramp as a listen-in opens, and back to their
 * exact volume and mute when it ends (End Listen-In, Mute All Comms, a fault). The same rules as the
 * replays' ducking (replay/audio.ts):
 *
 * - the volumes before are saved in the engine's settings before anything changes, so a crash or a
 *   restart during a listen-in puts them back at the next start (the listen-in itself is never saved);
 * - an input the operator moved meanwhile is left as they put it;
 * - what can't be put back now (OBS away) stays saved and is tried again when OBS answers.
 *
 * With the replays' ducking (a break's replays during a listen-in, or a listen-in during a break) on
 * the same input, whichever lets go last puts the volume back: each takes the volume from before
 * either as the one to restore, neither raises an input the other holds lower, and the first to let
 * go leaves it at the other's level (DuckPeer, both ways).
 */

export interface CommsDuckSettings {
  enabled: boolean;
  /** OBS inputs (names): the casters' microphones. */
  inputs: string[];
  /** How far down (dB, negative). */
  amountDb: number;
  rampMs: number;
}

/** The replays' ducking as this needs it (ReplayAudio.heldInput). */
export interface ReplayDuckLike {
  heldInput(id: string): { volume: number; muted: boolean; setVolume: number; setMuted: boolean } | null;
}

interface Held {
  id: string;
  /** Before any ducking (OBS's multiplier) and mute. */
  volume: number;
  muted: boolean;
  /** As turned down for the listen-in. */
  setVolume: number;
}

interface Saved {
  inputs: Held[];
  at: string;
}

export interface CommsDuckStatus {
  /** off: nothing picked or switched off; idle: nothing down; lowered: casters down for a listen-in; pending: still down after a listen-in (OBS away), put back when it answers. */
  state: "off" | "idle" | "lowered" | "pending";
  detail: string;
  lowered: string[];
  lastRelease: { at: string; ok: boolean; detail: string } | null;
}

const SAVED_KEY = "comms.duck";
const STEP_MS = 50;
const SAME_MUL = 0.02;
const dbOf = (mul: number) => (mul <= 0 ? -100 : 20 * Math.log10(mul));
const mulOf = (db: number) => (db <= -100 ? 0 : 10 ** (db / 20));
const same = (a: number, b: number) => Math.abs(a - b) <= SAME_MUL * Math.max(b, 0.01);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CommsDucking implements DuckPeer {
  private chain: Promise<unknown> = Promise.resolve();
  private active = false;
  private lastRelease: CommsDuckStatus["lastRelease"] = null;
  private triedAt = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly d: {
      obs: ObsManager;
      settings: SettingsRepo;
      logger: Pick<Logger, "info" | "warn">;
      replay: () => ReplayDuckLike | null;
      config: () => CommsDuckSettings;
      now: () => number;
    },
  ) {}

  /** At start: casters left down by a listen-in before a crash or restart go back once OBS answers (no listen-in is open at start). */
  start(): void {
    const onConnected = () => {
      // A listen-in open when OBS (re)connects: the casters go down now; none open: leftovers go back.
      if (this.active) void this.duck();
      else if (this.saved()) void this.release("OBS connected");
    };
    this.d.obs.on("connected", onConnected);
    this.cleanup.push(() => this.d.obs.off("connected", onConnected));
    if (this.saved()) {
      this.d.logger.warn("team comms: casters were still turned down from a listen-in before the restart; they go back when OBS answers", { inputs: this.saved()!.inputs.map((i) => i.id) });
      if (this.d.obs.state.connected) void this.release("start");
    }
  }

  dispose(): void {
    for (const fn of this.cleanup.splice(0)) fn();
  }

  /** Still down with no listen-in open (OBS was away): tried again every few seconds (the public controller's tick). */
  retry(): void {
    if (this.active || !this.saved() || !this.d.obs.state.connected || this.d.now() - this.triedAt < 3000) return;
    this.triedAt = this.d.now();
    void this.release("OBS answers");
  }

  private saved(): Saved | null {
    const s = this.d.settings.get<Saved | null>(SAVED_KEY, null);
    return s && Array.isArray(s.inputs) && s.inputs.length ? s : null;
  }

  private save(s: Saved | null): void {
    this.d.settings.set(SAVED_KEY, s && s.inputs.length ? s : null);
  }

  /** DuckPeer: the replays ask whether a listen-in holds this input down (and from what). */
  holding(input: string): { volume: number; muted: boolean; setVolume: number } | null {
    const h = this.saved()?.inputs.find((i) => i.id === input);
    return h ? { volume: h.volume, muted: h.muted, setVolume: h.setVolume } : null;
  }

  get lowered(): boolean {
    return this.saved() !== null;
  }

  status(): CommsDuckStatus {
    const c = this.d.config();
    const s = this.saved();
    const lowered = s?.inputs.map((i) => i.id) ?? [];
    if (s) return this.active ? { state: "lowered", detail: `Casters down ${-c.amountDb} dB for the listen-in: ${lowered.join(", ")}.`, lowered, lastRelease: this.lastRelease } : { state: "pending", detail: `Still down after a listen-in (OBS didn't answer): ${lowered.join(", ")}. Put back when OBS answers.`, lowered, lastRelease: this.lastRelease };
    if (!c.enabled || !c.inputs.length) return { state: "off", detail: c.enabled ? "No caster input picked: nothing is turned down during a listen-in." : "Caster ducking is off.", lowered, lastRelease: this.lastRelease };
    return { state: "idle", detail: `During a listen-in, ${c.inputs.length === 1 ? "the caster input goes" : `${c.inputs.length} caster inputs go`} down ${-c.amountDb} dB.`, lowered, lastRelease: this.lastRelease };
  }

  /** A listen-in opened: the picked caster inputs go down (their volumes saved first). */
  duck(): Promise<void> {
    this.active = true;
    return this.serial(async () => {
      if (!this.active) return;
      const c = this.d.config();
      const obs = this.d.obs;
      if (!c.enabled || !c.inputs.length || !obs.state.connected) return;
      try {
        const before = new Map((this.saved()?.inputs ?? []).map((i) => [i.id, i]));
        const replay = this.d.replay();
        const read = await Promise.all(c.inputs.map((id) => obs.inputVolume(id).then((v) => ({ id, v })).catch(() => null)));
        const held: Held[] = [];
        for (const r of read) {
          if (!r) continue;
          const known = before.get(r.id);
          const rp = known ? null : (replay?.heldInput(r.id) ?? null);
          const volume = known ? known.volume : rp ? rp.volume : r.v.mul;
          const muted = known ? known.muted : rp ? rp.muted : r.v.muted;
          held.push({ id: r.id, volume, muted, setVolume: mulOf(dbOf(volume) + c.amountDb) });
        }
        // Saved before anything changes.
        this.save({ inputs: [...held, ...[...before.values()].filter((k) => !held.some((h) => h.id === k.id))], at: new Date().toISOString() });
        await Promise.all(
          held.map(async (h) => {
            const now = read.find((r) => r?.id === h.id)!.v;
            const rp = replay?.heldInput(h.id) ?? null;
            // Never raised: the replays (or the operator) may hold it lower already.
            if ((rp && (rp.setMuted || rp.setVolume <= h.setVolume)) || now.muted || now.mul <= h.setVolume) return;
            await this.ramp(h.id, now.mul, h.setVolume, c.rampMs);
          }),
        );
      } catch (err) {
        this.d.logger.warn("team comms: could not turn the casters down", { error: String(err) });
      }
    });
  }

  /**
   * The listen-in ended: every caster input goes back to its exact volume and mute before it, unless
   * the operator moved it meanwhile (left as they put it), or the replays still hold it (left at their
   * level; they put it back as they end).
   */
  release(why = "the listen-in ended"): Promise<{ ok: boolean; detail: string }> {
    this.active = false;
    return this.serial(async () => {
      const s = this.saved();
      if (!s) return { ok: true, detail: "Nothing was turned down." };
      const c = this.d.config();
      const obs = this.d.obs;
      const replay = this.d.replay();
      const left: Held[] = [];
      const done: string[] = [];
      const kept: string[] = [];
      const handed: string[] = [];
      const problems: string[] = [];
      await Promise.all(
        s.inputs.map(async (h) => {
          try {
            const now = await obs.inputVolume(h.id);
            const rp = replay?.heldInput(h.id) ?? null;
            const ours = same(now.mul, h.setVolume) && now.muted === h.muted;
            const theirs = !!rp && same(now.mul, rp.setVolume) && now.muted === rp.setMuted;
            if (rp) {
              // The replays hold it too: they put it back. Left at their level (taken there if it is still ours).
              if (ours && !theirs) {
                await this.ramp(h.id, now.mul, rp.setVolume, c.rampMs);
                await obs.setInputVolume(h.id, { mul: rp.setVolume, muted: rp.setMuted });
              }
              handed.push(h.id);
              return;
            }
            if (!ours) return void kept.push(h.id);
            await this.ramp(h.id, now.mul, h.volume, c.rampMs);
            await obs.setInputVolume(h.id, { mul: h.volume, muted: h.muted });
            done.push(h.id);
          } catch (err) {
            left.push(h);
            problems.push(`${h.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
      this.save(left.length ? { ...s, inputs: left } : null);
      const ok = left.length === 0;
      const detail =
        [done.length ? `Put back: ${done.join(", ")}.` : "", handed.length ? `Still down for the replays (they put it back): ${handed.join(", ")}.` : "", kept.length ? `Changed by hand during the listen-in, left as it is: ${kept.join(", ")}.` : "", left.length ? `Not put back yet (tried again when OBS answers): ${problems.join("; ")}.` : ""].filter(Boolean).join(" ") || "Nothing to put back.";
      this.lastRelease = { at: new Date().toISOString(), ok, detail };
      if (!ok) this.d.logger.warn("team comms: could not put the casters back yet", { why, problems });
      else this.d.logger.info("team comms: casters put back", { why, inputs: done, handed, kept });
      return { ok, detail };
    });
  }

  /** From one multiplier to another in even dB steps, the last one exact. */
  private async ramp(name: string, from: number, to: number, rampMs: number): Promise<void> {
    const steps = Math.max(1, Math.round(rampMs / STEP_MS));
    const a = Math.max(dbOf(from), -100);
    const b = Math.max(dbOf(to), -100);
    for (let k = 1; k < steps; k++) {
      await this.d.obs.setInputVolume(name, { mul: mulOf(a + ((b - a) * k) / steps) });
      await sleep(rampMs / steps);
    }
    await this.d.obs.setInputVolume(name, { mul: to });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
