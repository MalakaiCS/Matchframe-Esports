import type { ProgramMode } from "@matchframe/automation";

export type ProgramOwner = "emergency" | "operator" | "cue" | "automation" | "schedule";
const PRIORITY: Record<ProgramOwner, number> = { emergency: 4, operator: 3, cue: 2, automation: 1, schedule: 0 };

const ALLOWED: Record<ProgramMode, ProgramMode[]> = {
  LIVE: ["REPLAY_PREPARED", "STUDIO", "BREAK", "MANUAL", "DEGRADED"],
  REPLAY_PREPARED: ["REPLAY_PLAYING", "LIVE", "MANUAL", "DEGRADED"],
  REPLAY_PLAYING: ["LIVE", "MANUAL", "DEGRADED"],
  STUDIO: ["LIVE", "BREAK", "MANUAL", "DEGRADED"],
  BREAK: ["LIVE", "STUDIO", "MANUAL", "DEGRADED"],
  MANUAL: ["LIVE", "STUDIO", "BREAK", "REPLAY_PREPARED", "DEGRADED"],
  DEGRADED: ["MANUAL", "LIVE"],
};

export interface SceneMap {
  LIVE: string | null;
  REPLAY: string | null;
  STUDIO: string | null;
  BREAK: string | null;
}

export interface ProgramTransition {
  from: ProgramMode;
  to: ProgramMode;
  owner: ProgramOwner;
  holder: string;
  at: string;
  confirmed: boolean;
  detail: string | null;
}

export interface MixerPort {
  connected(): boolean;
  /** Puts the scene on program and returns whether the mixer confirmed it. */
  setProgram(scene: string): Promise<boolean>;
}

/**
 * Program-output state machine (spec §18.2). One owner at a time with priority
 * emergency/manual > operator-approved cue > policy automation > scheduled graphics. Observer
 * (game POV) control is separate: a replay on program never steers the live observer.
 */
export class ProgramArbiter {
  mode: ProgramMode = "LIVE";
  owner: { kind: ProgramOwner; holder: string } = { kind: "operator", holder: "local-operator" };
  readonly history: ProgramTransition[] = [];
  private replayItemId: string | null = null;

  constructor(
    private readonly mixer: MixerPort | null,
    private scenes: SceneMap,
  ) {}

  setScenes(scenes: SceneMap): void {
    this.scenes = scenes;
  }

  get sceneMap(): SceneMap {
    return this.scenes;
  }

  get activeReplay(): string | null {
    return this.mode === "REPLAY_PLAYING" || this.mode === "REPLAY_PREPARED" ? this.replayItemId : null;
  }

  private sceneFor(mode: ProgramMode): string | null {
    if (mode === "LIVE") return this.scenes.LIVE;
    if (mode === "REPLAY_PLAYING") return this.scenes.REPLAY;
    if (mode === "STUDIO") return this.scenes.STUDIO;
    if (mode === "BREAK") return this.scenes.BREAK;
    return null;
  }

  canRequest(owner: ProgramOwner): boolean {
    return PRIORITY[owner] >= PRIORITY[this.owner.kind] || this.owner.kind === "schedule" || this.owner.kind === "automation";
  }

  /** Mixer connection lost: degrade (manual recovery required) without replaying old cues. */
  markDegraded(detail: string): void {
    if (this.mode === "DEGRADED") return;
    this.history.push({ from: this.mode, to: "DEGRADED", owner: "emergency", holder: "mixer-monitor", at: new Date().toISOString(), confirmed: true, detail });
    this.mode = "DEGRADED";
  }

  /**
   * The mixer shows the live scene (put there by hand, or found there after reconnecting): the
   * program is live, whatever it was. Not while a replay is being prepared (the live scene is still
   * on program then). Returns the transition, or null when nothing changed.
   */
  followMixerLive(holder: string): ProgramTransition | null {
    if (this.mode === "LIVE" || this.mode === "REPLAY_PREPARED") return null;
    const t: ProgramTransition = { from: this.mode, to: "LIVE", owner: "operator", holder, at: new Date().toISOString(), confirmed: true, detail: "the mixer shows the live scene" };
    this.mode = "LIVE";
    this.owner = { kind: "operator", holder };
    this.replayItemId = null;
    this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    return t;
  }

  async request(to: ProgramMode, owner: ProgramOwner, holder: string, opts: { replayItemId?: string } = {}): Promise<ProgramTransition> {
    const from = this.mode;
    if (from === to) return { from, to, owner, holder, at: new Date().toISOString(), confirmed: true, detail: "already in mode" };
    if (!ALLOWED[from].includes(to)) throw Object.assign(new Error(`program transition ${from} → ${to} not allowed`), { status: 409 });
    if (PRIORITY[owner] < PRIORITY[this.owner.kind] && this.mode !== "LIVE") {
      throw Object.assign(new Error(`program owned by ${this.owner.kind}; ${owner} cannot change it`), { status: 409 });
    }
    if ((to === "LIVE" || to === "STUDIO" || to === "BREAK" || to === "REPLAY_PLAYING") && from === "DEGRADED" && owner !== "operator" && owner !== "emergency") {
      throw Object.assign(new Error("recovery from DEGRADED requires the operator"), { status: 409 });
    }
    let confirmed = true;
    let detail: string | null = null;
    const scene = this.sceneFor(to);
    if (!scene && (to === "STUDIO" || to === "BREAK" || to === "REPLAY_PLAYING")) {
      // The program state must never claim a mode the mixer is not actually showing.
      throw Object.assign(new Error(`no mixer scene is mapped for ${to}; map it in Settings → Program scenes`), { status: 409 });
    }
    if (!scene && to === "LIVE") detail = "no LIVE scene mapped; program state changed without a mixer action";
    if (scene) {
      if (!this.mixer || !this.mixer.connected()) {
        confirmed = false;
        detail = "mixer not connected; program scene unchanged";
        if (to !== "LIVE" && to !== "MANUAL") throw Object.assign(new Error(detail), { status: 409 });
      } else {
        confirmed = await this.mixer.setProgram(scene);
        if (!confirmed) detail = `mixer did not confirm scene ${scene}`;
      }
    }
    if (opts.replayItemId) this.replayItemId = opts.replayItemId;
    if (to === "LIVE") this.replayItemId = null;
    this.mode = to;
    this.owner = { kind: to === "LIVE" ? "operator" : owner, holder };
    const t: ProgramTransition = { from, to, owner, holder, at: new Date().toISOString(), confirmed, detail };
    this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    return t;
  }
}
