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

/** A program change, for the mixer to choose its transition (to a replay, back from one, to the break scene…). */
export interface ProgramMove {
  from: ProgramMode;
  to: ProgramMode;
}

export interface MixerPort {
  connected(): boolean;
  /** Puts the scene on program and returns whether the mixer confirmed it. */
  setProgram(scene: string, move: ProgramMove): Promise<boolean>;
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
  /** The mode a change is going to while the mixer makes it (the mixer may report its new scene before it is done). */
  private changing: ProgramMode | null = null;
  /** The replay scene's twin (replay/twin.ts), and the replay scene it is the twin of: a break's replays alternate between the two, so it counts as the replay scene. */
  private twin: { scene: string; of: string } | null = null;
  /** The operator's own scene the program follows (MANUAL): one OBS showed that Matchframe didn't put there. */
  private followed: string | null = null;

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

  setReplayTwin(scene: string | null, of: string | null): void {
    this.twin = scene && of ? { scene, of } : null;
  }

  /** The scenes a replay plays on: the mapped replay scene, and its twin while it is the twin of that scene. */
  get replayScenes(): string[] {
    const replay = this.scenes.REPLAY;
    if (!replay) return [];
    return this.twin?.of === replay ? [replay, this.twin.scene] : [replay];
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
    // A change of the program's own (to live, say) is under way: it says where the program is.
    if (this.mode === "LIVE" || this.mode === "REPLAY_PREPARED" || this.changing) return null;
    const t: ProgramTransition = { from: this.mode, to: "LIVE", owner: "operator", holder, at: new Date().toISOString(), confirmed: true, detail: "the mixer shows the live scene" };
    this.mode = "LIVE";
    this.owner = { kind: "operator", holder };
    this.replayItemId = null;
    this.followed = null;
    this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    return t;
  }

  /**
   * The mixer shows a scene the operator put there (with OBS itself, a multiview, a hotkey): not the
   * live scene, and not one Matchframe put on. The program is theirs (MANUAL, the operator's, its
   * holder naming the scene) until the mixer shows the live scene again (followMixerLive): nothing
   * automatic changes it meanwhile. Not while a change of the program's own is under way.
   */
  followMixerScene(scene: string): ProgramTransition | null {
    if (this.changing || (this.mode === "MANUAL" && this.followed === scene)) return null;
    const holder = `OBS: ${scene}`;
    const t: ProgramTransition = { from: this.mode, to: "MANUAL", owner: "operator", holder, at: new Date().toISOString(), confirmed: true, detail: `the mixer shows “${scene}”, put on by the operator` };
    this.mode = "MANUAL";
    this.owner = { kind: "operator", holder };
    this.replayItemId = null;
    this.followed = scene;
    this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    return t;
  }

  /** The operator's own scene the program follows now (put on in OBS), or null. */
  get operatorScene(): string | null {
    return this.mode === "MANUAL" ? this.followed : null;
  }

  /** Whether `scene` is what the program shows in its mode (its mode's scene, a replay scene during a replay, the operator's scene followed). */
  showsScene(scene: string): boolean {
    if (this.mode === "REPLAY_PLAYING" || this.mode === "REPLAY_PREPARED") return this.replayScenes.includes(scene);
    if (this.mode === "MANUAL") return this.followed === scene;
    return this.sceneFor(this.mode) === scene;
  }

  async request(to: ProgramMode, owner: ProgramOwner, holder: string, opts: { replayItemId?: string } = {}): Promise<ProgramTransition> {
    const from = this.mode;
    if (from === to) {
      // Another clip on the replay scene (the next of a break's replays, or one played by hand over it): the program shows it now.
      if (opts.replayItemId && opts.replayItemId !== this.replayItemId && (to === "REPLAY_PREPARED" || to === "REPLAY_PLAYING")) {
        if (PRIORITY[owner] < PRIORITY[this.owner.kind]) throw Object.assign(new Error(`program owned by ${this.owner.kind}; ${owner} cannot change it`), { status: 409 });
        this.replayItemId = opts.replayItemId;
        this.owner = { kind: owner, holder };
      }
      return { from, to, owner, holder, at: new Date().toISOString(), confirmed: true, detail: "already in mode" };
    }
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
        this.changing = to;
        try {
          confirmed = await this.mixer.setProgram(scene, { from, to });
        } finally {
          this.changing = null;
        }
        if (!confirmed) detail = `mixer did not confirm scene ${scene}`;
      }
    }
    if (opts.replayItemId) this.replayItemId = opts.replayItemId;
    if (to === "LIVE") this.replayItemId = null;
    this.followed = null;
    this.mode = to;
    this.owner = { kind: to === "LIVE" ? "operator" : owner, holder };
    const t: ProgramTransition = { from, to, owner, holder, at: new Date().toISOString(), confirmed, detail };
    this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    return t;
  }
}
