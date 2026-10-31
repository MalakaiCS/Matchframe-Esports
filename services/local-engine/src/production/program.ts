import type { ProgramMode } from "@matchframe/automation";

export type ProgramOwner = "emergency" | "operator" | "cue" | "automation" | "schedule";
const PRIORITY: Record<ProgramOwner, number> = { emergency: 4, operator: 3, cue: 2, automation: 1, schedule: 0 };

const ALLOWED: Record<ProgramMode, ProgramMode[]> = {
  LIVE: ["REPLAY_PREPARED", "STUDIO", "BREAK", "MANUAL", "DEGRADED", "HIGHLIGHTS"],
  REPLAY_PREPARED: ["REPLAY_PLAYING", "LIVE", "MANUAL", "DEGRADED"],
  REPLAY_PLAYING: ["LIVE", "MANUAL", "DEGRADED"],
  STUDIO: ["LIVE", "BREAK", "MANUAL", "DEGRADED", "HIGHLIGHTS"],
  BREAK: ["LIVE", "STUDIO", "MANUAL", "DEGRADED", "HIGHLIGHTS"],
  MANUAL: ["LIVE", "STUDIO", "BREAK", "REPLAY_PREPARED", "DEGRADED", "HIGHLIGHTS"],
  DEGRADED: ["MANUAL", "LIVE"],
  // Highlights on air (ADR-063): back to where the program came from, or to live.
  HIGHLIGHTS: ["LIVE", "STUDIO", "BREAK", "MANUAL", "DEGRADED"],
};

export interface SceneMap {
  LIVE: string | null;
  REPLAY: string | null;
  STUDIO: string | null;
  BREAK: string | null;
  /** Highlights on air (ADR-063): a map's best clips, back to back. */
  HIGHLIGHTS: string | null;
}

/** A scene map as stored (saved before highlights on air, without HIGHLIGHTS, or partly given): every mode, unmapped ones null. */
export function sceneMapOf(v: unknown): SceneMap {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const one = (k: keyof SceneMap) => (typeof o[k] === "string" && o[k] ? (o[k] as string) : null);
  return { LIVE: one("LIVE"), REPLAY: one("REPLAY"), STUDIO: one("STUDIO"), BREAK: one("BREAK"), HIGHLIGHTS: one("HIGHLIGHTS") };
}

/**
 * Where highlights go back to (ADR-063), saved as they go on air: the mode the program came from,
 * its scene (the operator's own scene for MANUAL), and who had it then.
 */
export interface HighlightsReturn {
  mode: ProgramMode;
  scene: string | null;
  owner: { kind: ProgramOwner; holder: string };
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
  /** The scene the mixer shows now, when known (where highlights go back to from MANUAL without a followed scene). */
  shown?(): string | null;
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
  /**
   * The twins (replay/twin.ts) of the replay scene and of the highlights scene, and the scene each is
   * the twin of: clips alternate between a scene and its twin, so the twin counts as that scene.
   */
  private twins: { REPLAY: { scene: string; of: string } | null; HIGHLIGHTS: { scene: string; of: string } | null } = { REPLAY: null, HIGHLIGHTS: null };
  /** The operator's own scene the program follows (MANUAL): one OBS showed that Matchframe didn't put there. */
  private followed: string | null = null;
  /** While highlights are on air: where the program goes back to after them. */
  private back: HighlightsReturn | null = null;
  private scenes: SceneMap;

  constructor(
    private readonly mixer: MixerPort | null,
    scenes: Partial<SceneMap>,
  ) {
    this.scenes = sceneMapOf(scenes);
  }

  setScenes(scenes: Partial<SceneMap>): void {
    this.scenes = sceneMapOf(scenes);
  }

  get sceneMap(): SceneMap {
    return this.scenes;
  }

  setReplayTwin(scene: string | null, of: string | null): void {
    this.setTwin("REPLAY", scene, of);
  }

  /** The twin of the replay scene or of the highlights scene (null: none). */
  setTwin(kind: "REPLAY" | "HIGHLIGHTS", scene: string | null, of: string | null): void {
    this.twins[kind] = scene && of ? { scene, of } : null;
  }

  /** A mapped scene and the twins that are twins of it now. */
  private withTwins(scene: string | null): string[] {
    if (!scene) return [];
    const twins = [this.twins.REPLAY, this.twins.HIGHLIGHTS].filter((t) => t?.of === scene).map((t) => t!.scene);
    return [scene, ...new Set(twins)];
  }

  /** The scenes a replay plays on: the mapped replay scene, and its twin while it is the twin of that scene. */
  get replayScenes(): string[] {
    return this.withTwins(this.scenes.REPLAY);
  }

  /** The scenes highlights play on: the mapped highlights scene and its twin (the replay scene's, when it is the same scene). */
  get highlightsScenes(): string[] {
    return this.withTwins(this.scenes.HIGHLIGHTS);
  }

  /** The clip on air: a replay's (by hand or automatic), or the highlight's while highlights are on air. */
  get activeReplay(): string | null {
    return this.mode === "REPLAY_PLAYING" || this.mode === "REPLAY_PREPARED" || this.mode === "HIGHLIGHTS" ? this.replayItemId : null;
  }

  /** While highlights are on air: where the program goes back to after them (the mode, scene and owner it came from). */
  get highlightsReturn(): HighlightsReturn | null {
    return this.mode === "HIGHLIGHTS" ? this.back : null;
  }

  private sceneFor(mode: ProgramMode): string | null {
    if (mode === "LIVE") return this.scenes.LIVE;
    if (mode === "REPLAY_PLAYING") return this.scenes.REPLAY;
    if (mode === "STUDIO") return this.scenes.STUDIO;
    if (mode === "BREAK") return this.scenes.BREAK;
    if (mode === "HIGHLIGHTS") return this.scenes.HIGHLIGHTS;
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
    this.back = null;
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
    this.back = null;
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
    if (this.mode === "HIGHLIGHTS") return this.highlightsScenes.includes(scene);
    if (this.mode === "MANUAL") return this.followed === scene;
    return this.sceneFor(this.mode) === scene;
  }

  /**
   * Changes the program. `replayItemId`: the clip on air (a replay, or a highlight). `scene`: the
   * operator's own scene to put back for MANUAL (highlights going back to it), followed afterwards as
   * theirs. `restoreOwner`: who has the program afterwards (highlights going back to a scene someone
   * else chose: the OBS automation's studio scene stays its own).
   */
  async request(to: ProgramMode, owner: ProgramOwner, holder: string, opts: { replayItemId?: string; scene?: string; restoreOwner?: { kind: ProgramOwner; holder: string } } = {}): Promise<ProgramTransition> {
    const from = this.mode;
    if (from === to && !(to === "MANUAL" && opts.scene && opts.scene !== this.followed)) {
      // Another clip on the replay scene (the next of a break's replays, or one played by hand over it), or the next highlight: the program shows it now.
      if (opts.replayItemId && opts.replayItemId !== this.replayItemId && (to === "REPLAY_PREPARED" || to === "REPLAY_PLAYING" || to === "HIGHLIGHTS")) {
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
    if ((to === "LIVE" || to === "STUDIO" || to === "BREAK" || to === "REPLAY_PLAYING" || to === "HIGHLIGHTS") && from === "DEGRADED" && owner !== "operator" && owner !== "emergency") {
      throw Object.assign(new Error("recovery from DEGRADED requires the operator"), { status: 409 });
    }
    let confirmed = true;
    let detail: string | null = null;
    // Highlights going on air: where the program goes back to afterwards (the operator's own scene, the scene the mixer shows for a MANUAL without one).
    const back: HighlightsReturn | null = to === "HIGHLIGHTS" ? { mode: from, scene: from === "MANUAL" ? (this.followed ?? this.mixer?.shown?.() ?? null) : this.sceneFor(from), owner: { ...this.owner } } : null;
    const scene = to === "MANUAL" && opts.scene ? opts.scene : this.sceneFor(to);
    if (!scene && (to === "STUDIO" || to === "BREAK" || to === "REPLAY_PLAYING" || to === "HIGHLIGHTS")) {
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
    this.back = back;
    if (opts.replayItemId) this.replayItemId = opts.replayItemId;
    if (to === "LIVE") this.replayItemId = null;
    this.followed = to === "MANUAL" && opts.scene ? opts.scene : null;
    this.mode = to;
    this.owner = opts.restoreOwner ? { ...opts.restoreOwner } : { kind: to === "LIVE" ? "operator" : owner, holder };
    const t: ProgramTransition = { from, to, owner, holder, at: new Date().toISOString(), confirmed, detail };
    this.history.push(t);
    if (this.history.length > 500) this.history.shift();
    return t;
  }

  /**
   * Highlights are over (ADR-063): the program goes back to where it came from (the live, studio or
   * break scene, or the operator's own scene, MANUAL as before with the same owner), or to the live
   * scene when `live` (a round is live) or that scene is gone (`exists` says no). Only by the holder
   * of the highlights: if someone else took the program meanwhile, nothing changes (null).
   */
  async returnFromHighlights(owner: ProgramOwner, holder: string, opts: { live: boolean; exists: (scene: string) => boolean }): Promise<ProgramTransition | null> {
    if (this.mode !== "HIGHLIGHTS" || this.owner.holder !== holder) return null;
    const back = this.back;
    const scene = back ? (back.mode === "MANUAL" ? back.scene : this.sceneFor(back.mode)) : null;
    if (opts.live || !back || back.mode === "LIVE" || back.mode === "DEGRADED" || !scene || !opts.exists(scene)) return this.request("LIVE", owner, holder);
    if (back.mode === "MANUAL") return this.request("MANUAL", owner, holder, { scene, restoreOwner: { kind: "operator", holder: back.owner.holder.startsWith("OBS: ") ? `OBS: ${scene}` : back.owner.holder } });
    return this.request(back.mode, owner, holder, { restoreOwner: back.owner });
  }
}
