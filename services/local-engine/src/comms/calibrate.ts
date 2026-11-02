import { z } from "zod";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { MAX_DELAY_SEC, TRANSPORT_FLOOR_MS, type IncomingAudio, type TeamComms } from "./service.ts";

/**
 * Calibrating the comms delay against the observer's gameplay (ADR-068; the brief, section 5): a
 * "mark" measured twice, once live and once in the gameplay.
 *
 * 1. **Live mark (exact):** the operator arms it for a team; a player says a short sharp word ("mark!")
 *    or claps on their microphone at the instant of a visible game event (a shot, a flash popping,
 *    a jump). MatchFrame takes the start of that sound from the person's own TeamSpeak stream as it
 *    arrives (the capture time on the engine's timeline, to the TeamSpeak block: 7.5 ms), the first
 *    sound after at least 300 ms of silence.
 * 2. **Gameplay mark (by eye):** when that event appears in the observer's gameplay as OBS shows it
 *    (the program, OBS's preview or the recording scene), the operator presses Seen.
 *
 * The delay that puts the comms beside the gameplay in OBS is then the time between the two, less the
 * operator's reaction time (a setting, 200 ms by default: an estimate, stated as such) and less the
 * comms' own path to OBS (the NDI send latency). Several marks give a median and a spread; the spread
 * is how far to trust it. It is a starting point: the recording file is the check (the operations
 * document has the procedure), and the fine milliseconds the adjustment.
 */

export const CalibrationSettings = z.object({
  /** The operator's reaction to seeing the event (ms), taken off each mark. */
  reactionMs: z.number().int().min(0).max(1000).default(200),
  /** Speech above this (dBFS) is the live mark. */
  onsetDb: z.number().min(-80).max(-6).default(-40),
});
export type CalibrationSettings = z.infer<typeof CalibrationSettings>;

const SETTINGS_KEY = "comms.calibration";
/** The last suggestion applied (when, the delay it set, from how many marks): the setup checklist and the timing test read it. */
const APPLIED_KEY = "comms.calibration.applied";
/** Silence before the live mark (ms): the start of a sound, not a word in the middle of a sentence. */
const SILENCE_BEFORE_MS = 300;
/** An armed mark waits this long for a sound (ms). */
const ARM_MS = 30_000;
/** A live mark waits this long to be seen in the gameplay (ms): more than the longest delay. */
const SEEN_WITHIN_MS = (MAX_DELAY_SEC + 30) * 1000;
const MAX_MARKS = 8;

export interface CalibrationMark {
  liveAtMs: number;
  seenAtMs: number;
  /** Seen − live (ms). */
  offsetMs: number;
  who: string;
}

export class CalibrationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class CommsCalibration {
  private armed: { teamId: string; untilMs: number } | null = null;
  private live: { atMs: number; key: string; who: string; teamId: string } | null = null;
  private readonly lastLoud = new Map<string, number>();
  private marks: CalibrationMark[] = [];
  private readonly off: () => void;

  constructor(
    private readonly d: {
      comms: TeamComms;
      settings: SettingsRepo;
      logger: Pick<Logger, "info">;
      /** The engine's timeline (ms). */
      now: () => number;
      /** The comms' path to OBS (the NDI send latency, ms). */
      sendLatencyMs: () => number;
    },
  ) {
    this.off = d.comms.onIncoming((a) => this.onIncoming(a));
  }

  settings(): CalibrationSettings {
    const r = CalibrationSettings.safeParse(this.d.settings.get(SETTINGS_KEY, {}));
    return r.success ? r.data : CalibrationSettings.parse({});
  }

  setSettings(patch: Partial<CalibrationSettings>): CalibrationSettings {
    const next = CalibrationSettings.parse({ ...this.settings(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    this.d.settings.set(SETTINGS_KEY, next);
    return next;
  }

  /** Listen for the next sound of that team (the live mark). */
  arm(teamId: string): ReturnType<CommsCalibration["status"]> {
    if (!this.d.comms.enabled) throw new CalibrationError(409, "comms_off", "Team Comms is off.");
    if (!this.d.comms.hasTeam(teamId)) throw new CalibrationError(404, "no_team", "That team isn't one of the active match's teams.");
    this.armed = { teamId, untilMs: this.d.now() + ARM_MS };
    this.live = null;
    return this.status();
  }

  private onIncoming(a: IncomingAudio): void {
    const threshold = this.settings().onsetDb;
    const loud = a.db > threshold;
    const before = this.lastLoud.get(a.key);
    if (loud) this.lastLoud.set(a.key, a.atMs + a.durationMs);
    const arm = this.armed;
    if (!arm || !loud || a.teamId !== arm.teamId) return;
    if (this.d.now() > arm.untilMs) {
      this.armed = null;
      return;
    }
    if (before !== undefined && a.atMs - before < SILENCE_BEFORE_MS) return;
    const who = this.d.comms.recordingPeople(arm.teamId).find((p) => p.key === a.key)?.displayName ?? "someone";
    this.live = { atMs: a.atMs, key: a.key, who, teamId: arm.teamId };
    this.armed = null;
    this.d.logger.info("team comms calibration: live mark", { who });
  }

  /** The event appeared in the gameplay: one mark. */
  seen(): ReturnType<CommsCalibration["status"]> {
    const now = this.d.now();
    if (!this.live) throw new CalibrationError(409, "no_live_mark", this.armed ? "No sound heard yet: ask the player to say “mark” (or clap) at the moment, then press Seen when it shows in the gameplay." : "Arm a mark first.");
    if (now - this.live.atMs > SEEN_WITHIN_MS) {
      this.live = null;
      throw new CalibrationError(409, "too_late", "That live mark is older than the longest delay: arm a new one.");
    }
    this.marks.push({ liveAtMs: this.live.atMs, seenAtMs: now, offsetMs: Math.round(now - this.live.atMs), who: this.live.who });
    if (this.marks.length > MAX_MARKS) this.marks.shift();
    this.live = null;
    return this.status();
  }

  clear(): ReturnType<CommsCalibration["status"]> {
    this.marks = [];
    this.live = null;
    this.armed = null;
    return this.status();
  }

  /** The delay the marks suggest (median), with their spread. */
  suggestion(): { n: number; medianOffsetMs: number; spreadMs: number; delayMs: number; delaySec: number; fineMs: number } | null {
    if (!this.marks.length) return null;
    const xs = this.marks.map((m) => m.offsetMs).sort((a, b) => a - b);
    const mid = xs.length >> 1;
    const median = xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2;
    const s = this.settings();
    const delayMs = Math.round(Math.min(MAX_DELAY_SEC * 1000 + 999, Math.max(TRANSPORT_FLOOR_MS, median - s.reactionMs - this.d.sendLatencyMs())));
    let delaySec = Math.floor(delayMs / 1000);
    let fineMs = delayMs - delaySec * 1000;
    if (delaySec > MAX_DELAY_SEC) [delaySec, fineMs] = [MAX_DELAY_SEC, delayMs - MAX_DELAY_SEC * 1000];
    return { n: xs.length, medianOffsetMs: Math.round(median), spreadMs: xs[xs.length - 1]! - xs[0]!, delayMs, delaySec, fineMs };
  }

  /** Sets the comms delay to the suggestion. */
  async apply(): Promise<{ delaySec: number; fineMs: number }> {
    const s = this.suggestion();
    if (!s) throw new CalibrationError(409, "no_marks", "No marks yet.");
    await this.d.comms.updateSettings({ delaySec: s.delaySec, fineMs: s.fineMs });
    this.d.settings.set(APPLIED_KEY, { at: new Date().toISOString(), delayMs: s.delaySec * 1000 + s.fineMs, marks: s.n, spreadMs: s.spreadMs });
    this.d.logger.info("team comms calibration: delay applied", { delayMs: s.delayMs, marks: s.n, spreadMs: s.spreadMs });
    return { delaySec: s.delaySec, fineMs: s.fineMs };
  }

  /** The last suggestion applied, if any. */
  applied(): { at: string; delayMs: number; marks: number; spreadMs: number } | null {
    return this.d.settings.get<{ at: string; delayMs: number; marks: number; spreadMs: number } | null>(APPLIED_KEY, null);
  }

  /** The delay the marks set, while it is still the one in use (null: never applied, or changed since). */
  calibratedDelayMs(): number | null {
    const a = this.applied();
    const c = this.d.comms.settings();
    return a && a.delayMs === c.delaySec * 1000 + c.fineMs ? a.delayMs : null;
  }

  status() {
    const now = this.d.now();
    const armed = this.armed && now <= this.armed.untilMs ? this.armed : null;
    return {
      settings: this.settings(),
      armed: armed ? { teamId: armed.teamId, forMs: Math.round(armed.untilMs - now) } : null,
      live: this.live ? { who: this.live.who, teamId: this.live.teamId, agoMs: Math.round(now - this.live.atMs) } : null,
      marks: this.marks.map((m) => ({ who: m.who, offsetMs: m.offsetMs, agoMs: Math.round(now - m.seenAtMs) })),
      suggestion: this.suggestion(),
      sendLatencyMs: this.d.sendLatencyMs(),
      applied: this.applied(),
    };
  }

  dispose(): void {
    this.off();
  }
}
