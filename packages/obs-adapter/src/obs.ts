import { EventEmitter } from "node:events";
import OBSWebSocket from "obs-websocket-js";

export interface ObsProfile {
  id: string;
  name: string;
  url: string;
  /** Password is supplied at connect time from the credential store, never persisted here. */
  hasPassword: boolean;
}

export interface ObsSceneItem {
  sceneName: string;
  sourceName: string;
  sceneItemId: number;
  enabled: boolean;
  inputKind: string | null;
}

/** A scene item with everything a copy of it needs: its place (0 = bottom), transform and blend mode. */
export interface ObsSceneItemFull extends ObsSceneItem {
  index: number;
  locked: boolean;
  isGroup: boolean;
  blendMode: string | null;
  /** As OBS reports it (position, scale, rotation, crop, bounds, plus the read-only sizes). */
  transform: Record<string, unknown>;
}

export interface ObsFilter {
  name: string;
  kind: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

/** An input's audio settings (the ones a copy of the input keeps). */
export interface ObsInputAudio {
  volumeMul: number;
  muted: boolean;
  monitorType: string;
  balance: number;
  syncOffsetMs: number;
  tracks: Record<string, boolean>;
}

/** OBS's current scene transition; `durationMs` is null for a fixed one (a Cut, a Stinger). */
export interface ObsTransitionNow {
  name: string;
  kind: string;
  fixed: boolean;
  durationMs: number | null;
  settings: Record<string, unknown> | null;
}

/** Of a scene item's transform, what SetSceneItemTransform takes (bounds below 1 px are refused, so they go only with bounds on). */
export function writableTransform(t: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["positionX", "positionY", "rotation", "scaleX", "scaleY", "alignment", "boundsType", "boundsAlignment", "cropLeft", "cropRight", "cropTop", "cropBottom", "cropToBounds"]) if (t[k] !== undefined && t[k] !== null) out[k] = t[k];
  for (const k of ["boundsWidth", "boundsHeight"]) if (typeof t[k] === "number" && (t[k] as number) >= 1) out[k] = t[k];
  return out;
}

export interface ObsState {
  connected: boolean;
  connecting: boolean;
  lastError: string | null;
  obsVersion: string | null;
  websocketVersion: string | null;
  platform: string | null;
  availableRequests: string[];
  /** Input kinds this OBS build supports (e.g. browser_source requires the obs-browser plugin). */
  inputKinds: string[];
  studioMode: boolean | null;
  programScene: string | null;
  previewScene: string | null;
  scenes: string[];
  inputs: { name: string; kind: string }[];
  recording: boolean | null;
  streaming: boolean | null;
  replayBuffer: boolean | null;
  lastReplayPath: string | null;
  reconnectAttempt: number;
  updatedAt: number;
}

export type ObsClientLike = Pick<OBSWebSocket, "connect" | "disconnect" | "call" | "on" | "off">;

/**
 * OBS integration through obs-websocket v5. OBS provides scene/source/recording/replay-buffer
 * control; it does not provide CS2 telemetry or game-camera control. Every set operation is
 * idempotent and confirmed by reading back the resulting state. On reconnect state is
 * re-synchronized and no previously queued cue is replayed.
 */
export class ObsManager extends EventEmitter {
  private obs: ObsClientLike;
  private profile: ObsProfile | null = null;
  private password: string | undefined;
  private wantConnected = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  readonly state: ObsState = {
    connected: false,
    connecting: false,
    lastError: null,
    obsVersion: null,
    websocketVersion: null,
    platform: null,
    availableRequests: [],
    inputKinds: [],
    studioMode: null,
    programScene: null,
    previewScene: null,
    scenes: [],
    inputs: [],
    recording: null,
    streaming: null,
    replayBuffer: null,
    lastReplayPath: null,
    reconnectAttempt: 0,
    updatedAt: 0,
  };

  constructor(client?: ObsClientLike) {
    super();
    this.obs = client ?? new OBSWebSocket();
    this.bindEvents();
  }

  private bindEvents(): void {
    this.obs.on("ConnectionClosed", (err) => {
      const was = this.state.connected;
      this.patch({ connected: false, lastError: err?.message ?? null });
      if (was) this.emit("disconnected");
      this.scheduleReconnect();
    });
    this.obs.on("CurrentProgramSceneChanged", (e) => this.patch({ programScene: e.sceneName }));
    this.obs.on("CurrentPreviewSceneChanged", (e) => this.patch({ previewScene: e.sceneName }));
    this.obs.on("StudioModeStateChanged", (e) => this.patch({ studioMode: e.studioModeEnabled }));
    this.obs.on("RecordStateChanged", (e) => this.patch({ recording: e.outputActive }));
    this.obs.on("StreamStateChanged", (e) => this.patch({ streaming: e.outputActive }));
    this.obs.on("ReplayBufferStateChanged", (e) => this.patch({ replayBuffer: e.outputActive }));
    this.obs.on("ReplayBufferSaved", (e) => this.patch({ lastReplayPath: e.savedReplayPath }));
    this.obs.on("SceneListChanged", () => void this.refresh().catch(() => undefined));
    this.obs.on("InputCreated", () => void this.refresh().catch(() => undefined));
    this.obs.on("InputRemoved", () => void this.refresh().catch(() => undefined));
    // OBS 30 sends SceneTransitionVideoEnded, then SceneTransitionEnded when a transition is over
    // (a Stinger's at the end of its video, not at its cut point).
    this.obs.on("SceneTransitionStarted", (e) => this.emit("transition", { phase: "started", name: e.transitionName }));
    this.obs.on("SceneTransitionEnded", (e) => this.emit("transition", { phase: "ended", name: e.transitionName }));
  }

  private patch(p: Partial<ObsState>): void {
    Object.assign(this.state, p, { updatedAt: Date.now() });
    this.emit("state", this.state);
  }

  supports(request: string): boolean {
    return this.state.availableRequests.includes(request);
  }

  async connect(profile: ObsProfile, password?: string): Promise<void> {
    this.profile = profile;
    this.password = password;
    this.wantConnected = true;
    this.generation++;
    await this.tryConnect();
  }

  async disconnect(): Promise<void> {
    this.wantConnected = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.obs.disconnect().catch(() => undefined);
    this.patch({ connected: false, connecting: false });
  }

  private async tryConnect(): Promise<void> {
    if (!this.profile) return;
    const gen = this.generation;
    this.patch({ connecting: true });
    try {
      const hello = await this.obs.connect(this.profile.url, this.password, { rpcVersion: 1 });
      if (gen !== this.generation) return;
      this.patch({ connected: true, connecting: false, lastError: null, reconnectAttempt: 0, websocketVersion: hello.obsWebSocketVersion });
      await this.refresh();
      this.emit("connected");
    } catch (e) {
      if (gen !== this.generation) return;
      this.patch({ connected: false, connecting: false, lastError: e instanceof Error ? e.message : String(e) });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.wantConnected || this.timer) return;
    const attempt = this.state.reconnectAttempt + 1;
    const delay = Math.min(15000, 500 * 2 ** Math.min(attempt, 5));
    this.patch({ reconnectAttempt: attempt });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tryConnect();
    }, delay);
  }

  /** Full state resync (used after connect/reconnect). */
  async refresh(): Promise<ObsState> {
    const v = await this.obs.call("GetVersion");
    const scenes = await this.obs.call("GetSceneList");
    const inputs = await this.obs.call("GetInputList");
    const studio = await this.obs.call("GetStudioModeEnabled");
    const rec = await this.obs.call("GetRecordStatus").catch(() => null);
    const stream = await this.obs.call("GetStreamStatus").catch(() => null);
    const replay = await this.obs.call("GetReplayBufferStatus").catch(() => null);
    const kinds = await this.obs.call("GetInputKindList", { unversioned: false }).catch(() => null);
    this.patch({
      inputKinds: kinds ? kinds.inputKinds : [],
      obsVersion: v.obsVersion,
      websocketVersion: v.obsWebSocketVersion,
      platform: v.platformDescription,
      availableRequests: v.availableRequests,
      scenes: (scenes.scenes as { sceneName: string; sceneIndex: number }[]).sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => s.sceneName),
      programScene: scenes.currentProgramSceneName,
      previewScene: studio.studioModeEnabled ? (scenes.currentPreviewSceneName ?? null) : null,
      studioMode: studio.studioModeEnabled,
      inputs: (inputs.inputs as { inputName: string; inputKind: string }[]).map((i) => ({ name: i.inputName, kind: i.inputKind })),
      recording: rec ? rec.outputActive : null,
      streaming: stream ? stream.outputActive : null,
      replayBuffer: replay ? replay.outputActive : null,
    });
    return this.state;
  }

  private requireConnected(): void {
    if (!this.state.connected) throw new Error("OBS is not connected");
  }

  async sceneItems(sceneName: string): Promise<ObsSceneItem[]> {
    this.requireConnected();
    const r = await this.obs.call("GetSceneItemList", { sceneName });
    return (r.sceneItems as { sourceName: string; sceneItemId: number; sceneItemEnabled: boolean; inputKind?: string | null }[]).map((i) => ({
      sceneName,
      sourceName: i.sourceName,
      sceneItemId: i.sceneItemId,
      enabled: i.sceneItemEnabled,
      inputKind: i.inputKind ?? null,
    }));
  }

  /** A scene's items bottom to top, with their transforms and blend modes. */
  async sceneItemsFull(sceneName: string): Promise<ObsSceneItemFull[]> {
    this.requireConnected();
    const r = await this.obs.call("GetSceneItemList", { sceneName });
    type Raw = { sourceName: string; sceneItemId: number; sceneItemIndex: number; sceneItemEnabled: boolean; sceneItemLocked?: boolean; isGroup?: boolean | null; inputKind?: string | null; sceneItemBlendMode?: string | null; sceneItemTransform?: Record<string, unknown> };
    return (r.sceneItems as unknown as Raw[])
      .map((i) => ({ sceneName, sourceName: i.sourceName, sceneItemId: i.sceneItemId, enabled: i.sceneItemEnabled, inputKind: i.inputKind ?? null, index: i.sceneItemIndex, locked: i.sceneItemLocked === true, isGroup: i.isGroup === true, blendMode: i.sceneItemBlendMode ?? null, transform: i.sceneItemTransform ?? {} }))
      .sort((a, b) => a.index - b.index);
  }

  async createScene(sceneName: string): Promise<void> {
    this.requireConnected();
    await this.obs.call("CreateScene", { sceneName });
  }

  async removeScene(sceneName: string): Promise<void> {
    this.requireConnected();
    await this.obs.call("RemoveScene", { sceneName });
  }

  /** Adds an existing source to a scene (the same source, shared, as OBS's "Add Existing"); returns the new item's id. */
  async createSceneItem(sceneName: string, sourceName: string, enabled = true): Promise<number> {
    this.requireConnected();
    return (await this.obs.call("CreateSceneItem", { sceneName, sourceName, sceneItemEnabled: enabled })).sceneItemId;
  }

  async removeSceneItem(sceneName: string, sceneItemId: number): Promise<void> {
    this.requireConnected();
    await this.obs.call("RemoveSceneItem", { sceneName, sceneItemId });
  }

  /** Sets what is given of a scene item: its transform (see writableTransform), visibility, lock, blend mode, place (0 = bottom). */
  async setSceneItem(sceneName: string, sceneItemId: number, p: { transform?: Record<string, unknown>; enabled?: boolean; locked?: boolean; blendMode?: string | null; index?: number }): Promise<void> {
    this.requireConnected();
    if (p.transform) await this.obs.call("SetSceneItemTransform", { sceneName, sceneItemId, sceneItemTransform: writableTransform(p.transform) as never });
    if (p.enabled !== undefined) await this.obs.call("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: p.enabled });
    if (p.locked !== undefined) await this.obs.call("SetSceneItemLocked", { sceneName, sceneItemId, sceneItemLocked: p.locked });
    if (p.blendMode) await this.obs.call("SetSceneItemBlendMode", { sceneName, sceneItemId, sceneItemBlendMode: p.blendMode });
    if (p.index !== undefined) await this.obs.call("SetSceneItemIndex", { sceneName, sceneItemId, sceneItemIndex: p.index });
  }

  /** An input's kind and its settings (only the ones set: OBS leaves defaults out). */
  async inputSettings(inputName: string): Promise<{ kind: string; settings: Record<string, unknown> }> {
    this.requireConnected();
    const r = await this.obs.call("GetInputSettings", { inputName });
    return { kind: r.inputKind, settings: (r.inputSettings ?? {}) as Record<string, unknown> };
  }

  /** Changes an input's settings: merged into them (`overlay`), or replacing them. */
  async setInputSettings(inputName: string, settings: Record<string, unknown>, overlay = true): Promise<void> {
    this.requireConnected();
    await this.obs.call("SetInputSettings", { inputName, inputSettings: settings as never, overlay });
  }

  /** Creates an input, shown in a scene. */
  async createInput(sceneName: string, inputName: string, inputKind: string, settings: Record<string, unknown>, enabled = true): Promise<void> {
    this.requireConnected();
    await this.obs.call("CreateInput", { sceneName, inputName, inputKind, inputSettings: settings as never, sceneItemEnabled: enabled });
  }

  async removeInput(inputName: string): Promise<void> {
    this.requireConnected();
    await this.obs.call("RemoveInput", { inputName });
  }

  /** A source's filters, in their order. */
  async filters(sourceName: string): Promise<ObsFilter[]> {
    this.requireConnected();
    const r = await this.obs.call("GetSourceFilterList", { sourceName });
    type Raw = { filterName: string; filterKind: string; filterEnabled: boolean; filterIndex: number; filterSettings?: Record<string, unknown> };
    return (r.filters as unknown as Raw[]).sort((a, b) => a.filterIndex - b.filterIndex).map((f) => ({ name: f.filterName, kind: f.filterKind, enabled: f.filterEnabled, settings: f.filterSettings ?? {} }));
  }

  async createFilter(sourceName: string, f: ObsFilter): Promise<void> {
    this.requireConnected();
    await this.obs.call("CreateSourceFilter", { sourceName, filterName: f.name, filterKind: f.kind, filterSettings: f.settings as never });
    if (!f.enabled) await this.obs.call("SetSourceFilterEnabled", { sourceName, filterName: f.name, filterEnabled: false });
  }

  async removeFilter(sourceName: string, filterName: string): Promise<void> {
    this.requireConnected();
    await this.obs.call("RemoveSourceFilter", { sourceName, filterName });
  }

  async inputAudio(inputName: string): Promise<ObsInputAudio> {
    this.requireConnected();
    const [v, m, mon, bal, sync, tracks] = await Promise.all([
      this.obs.call("GetInputVolume", { inputName }),
      this.obs.call("GetInputMute", { inputName }),
      this.obs.call("GetInputAudioMonitorType", { inputName }),
      this.obs.call("GetInputAudioBalance", { inputName }),
      this.obs.call("GetInputAudioSyncOffset", { inputName }),
      this.obs.call("GetInputAudioTracks", { inputName }),
    ]);
    return { volumeMul: v.inputVolumeMul, muted: m.inputMuted, monitorType: mon.monitorType, balance: bal.inputAudioBalance, syncOffsetMs: sync.inputAudioSyncOffset, tracks: tracks.inputAudioTracks as Record<string, boolean> };
  }

  /** Sets what is given of an input's audio. */
  async setInputAudio(inputName: string, a: Partial<ObsInputAudio>): Promise<void> {
    this.requireConnected();
    if (a.volumeMul !== undefined) await this.obs.call("SetInputVolume", { inputName, inputVolumeMul: a.volumeMul });
    if (a.muted !== undefined) await this.obs.call("SetInputMute", { inputName, inputMuted: a.muted });
    if (a.monitorType !== undefined) await this.obs.call("SetInputAudioMonitorType", { inputName, monitorType: a.monitorType });
    if (a.balance !== undefined) await this.obs.call("SetInputAudioBalance", { inputName, inputAudioBalance: a.balance });
    if (a.syncOffsetMs !== undefined) await this.obs.call("SetInputAudioSyncOffset", { inputName, inputAudioSyncOffset: a.syncOffsetMs });
    if (a.tracks !== undefined) await this.obs.call("SetInputAudioTracks", { inputName, inputAudioTracks: a.tracks });
  }

  /** Puts a scene in preview (studio mode) and confirms by read-back. */
  async setPreview(sceneName: string): Promise<{ confirmed: boolean; previewScene: string | null }> {
    this.requireConnected();
    if (!this.state.studioMode) throw new Error("Studio mode is disabled in OBS; preview is unavailable");
    await this.obs.call("SetCurrentPreviewScene", { sceneName });
    const r = await this.obs.call("GetCurrentPreviewScene");
    this.patch({ previewScene: r.currentPreviewSceneName });
    return { confirmed: r.currentPreviewSceneName === sceneName, previewScene: r.currentPreviewSceneName };
  }

  /** The scene in preview (Studio Mode only; null otherwise). */
  async currentPreview(): Promise<string | null> {
    this.requireConnected();
    if (!this.state.studioMode) return null;
    const r = await this.obs.call("GetCurrentPreviewScene");
    this.patch({ previewScene: r.currentPreviewSceneName });
    return r.currentPreviewSceneName;
  }

  /**
   * Cuts a scene to program (directly, or via the studio-mode transition) and confirms. Directly, in
   * Studio Mode, OBS transitions the program and leaves the preview, until the transition's end: with
   * Swap Scenes (on by default) OBS then puts the scene the program left in preview. With Duplicate
   * Scene (on by default) the program shows a private copy of the scene under the same name; its
   * sources are the scene's own (OBS never copies a media source).
   */
  async setProgram(sceneName: string, opts: { viaTransition?: boolean } = {}): Promise<{ confirmed: boolean; programScene: string }> {
    this.requireConnected();
    if (this.state.studioMode && opts.viaTransition) {
      await this.obs.call("SetCurrentPreviewScene", { sceneName });
      await this.obs.call("TriggerStudioModeTransition");
    } else {
      await this.obs.call("SetCurrentProgramScene", { sceneName });
    }
    const r = await this.obs.call("GetCurrentProgramScene");
    this.patch({ programScene: r.currentProgramSceneName });
    return { confirmed: r.currentProgramSceneName === sceneName, programScene: r.currentProgramSceneName };
  }

  /** Scene transitions in OBS and the current one (a stinger can be chosen for replays). */
  async transitions(): Promise<{ current: string | null; names: string[] }> {
    this.requireConnected();
    const r = await this.obs.call("GetSceneTransitionList");
    return { current: r.currentSceneTransitionName ?? null, names: (r.transitions as { transitionName: string }[]).map((t) => t.transitionName) };
  }

  /**
   * Makes a transition OBS's current one and waits until OBS reports it: OBS applies the switch a
   * moment later (a request right after can still see the old one), so a cut or a settings change
   * straight after would otherwise use the old transition. Returns whether OBS confirmed it.
   */
  async setTransition(name: string, timeoutMs = 2000): Promise<boolean> {
    this.requireConnected();
    await this.obs.call("SetCurrentSceneTransition", { transitionName: name });
    const end = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.obs.call("GetCurrentSceneTransition");
      if (r.transitionName === name) return true;
      if (Date.now() > end) return false;
      await new Promise((res) => setTimeout(res, 15));
    }
  }

  /**
   * Scene transitions with their kinds (a Stinger is `obs_stinger_transition`, OBS's Fade
   * `fade_transition`, its Cut `cut_transition`; their names can be translated) and whether their
   * length is their own (`fixed`: a Cut, a Stinger) rather than OBS's transition duration.
   */
  async transitionKinds(): Promise<{ current: string | null; transitions: { name: string; kind: string; fixed: boolean }[] }> {
    this.requireConnected();
    const r = await this.obs.call("GetSceneTransitionList");
    return { current: r.currentSceneTransitionName ?? null, transitions: (r.transitions as { transitionName: string; transitionKind: string; transitionFixed?: boolean }[]).map((t) => ({ name: t.transitionName, kind: t.transitionKind, fixed: t.transitionFixed === true })) };
  }

  /** OBS's current scene transition, its kind and its duration (OBS's one transition duration; null for a fixed transition). */
  async currentTransition(): Promise<ObsTransitionNow> {
    this.requireConnected();
    const r = await this.obs.call("GetCurrentSceneTransition");
    return { name: r.transitionName, kind: r.transitionKind, fixed: r.transitionFixed, durationMs: r.transitionDuration ?? null, settings: (r.transitionSettings ?? null) as Record<string, unknown> | null };
  }

  /** OBS's transition duration (it applies to every transition that isn't fixed). */
  async setTransitionDuration(ms: number): Promise<void> {
    this.requireConnected();
    await this.obs.call("SetCurrentSceneTransitionDuration", { transitionDuration: Math.round(Math.min(20000, Math.max(50, ms))) });
  }

  /**
   * Resolves when OBS says the transition that starts next has ended (call it before the scene
   * change; the end of one that was already running doesn't count), or after `timeoutMs`; true when
   * OBS said so.
   */
  waitTransitionEnd(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let started = false;
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.off("transition", on);
        resolve(ok);
      };
      const on = (e: { phase: string }) => {
        if (e.phase === "started") started = true;
        else if (e.phase === "ended" && started) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.on("transition", on);
    });
  }

  /**
   * Changes a transition's settings (e.g. a Stinger's video file). obs-websocket only edits the
   * current transition, so it is made current for the change, read back, and the one before put back
   * unless `keepCurrent`.
   */
  async setTransitionSettings(name: string, settings: Record<string, unknown>, opts: { keepCurrent?: boolean } = {}): Promise<{ confirmed: boolean; settings: Record<string, unknown> }> {
    this.requireConnected();
    const before = await this.obs.call("GetCurrentSceneTransition");
    const prev = before.transitionName as string;
    // Never change settings before OBS has really switched: they would go to the old transition.
    if (prev !== name && !(await this.setTransition(name))) throw new Error(`OBS didn't switch to the transition "${name}"`);
    try {
      await this.obs.call("SetCurrentSceneTransitionSettings", { transitionSettings: settings as never, overlay: true });
      const now = await this.obs.call("GetCurrentSceneTransition");
      const got = (now.transitionSettings ?? {}) as Record<string, unknown>;
      const confirmed = now.transitionName === name && Object.entries(settings).every(([k, v]) => got[k] === v);
      return { confirmed, settings: got };
    } finally {
      if (!opts.keepCurrent && prev !== name) await this.setTransition(prev).catch(() => false);
    }
  }

  /** Idempotent visibility set; confirmed by read-back. */
  async setSourceVisible(sceneName: string, sourceName: string, visible: boolean): Promise<{ confirmed: boolean }> {
    this.requireConnected();
    const { sceneItemId } = await this.obs.call("GetSceneItemId", { sceneName, sourceName });
    await this.obs.call("SetSceneItemEnabled", { sceneName, sceneItemId, sceneItemEnabled: visible });
    const r = await this.obs.call("GetSceneItemEnabled", { sceneName, sceneItemId });
    return { confirmed: r.sceneItemEnabled === visible };
  }

  /** Explicit mute/unmute (never a blind toggle for automation). */
  async setMute(inputName: string, muted: boolean): Promise<{ confirmed: boolean }> {
    this.requireConnected();
    await this.obs.call("SetInputMute", { inputName, inputMuted: muted });
    const r = await this.obs.call("GetInputMute", { inputName });
    return { confirmed: r.inputMuted === muted };
  }

  async setVolumeDb(inputName: string, db: number): Promise<{ confirmed: boolean; db: number }> {
    this.requireConnected();
    await this.obs.call("SetInputVolume", { inputName, inputVolumeDb: db });
    const r = await this.obs.call("GetInputVolume", { inputName });
    return { confirmed: Math.abs(r.inputVolumeDb - db) < 0.1, db: r.inputVolumeDb };
  }

  /**
   * Creates a Matchframe scene and/or browser source if missing. Existing production scenes and
   * sources are never replaced; an existing source with the same name is only re-pointed when
   * it is already a browser source created for Matchframe.
   */
  async provisionBrowserSource(opts: { sceneName: string; sourceName: string; url: string; width: number; height: number }): Promise<{ createdScene: boolean; createdInput: boolean; updatedUrl: boolean }> {
    this.requireConnected();
    await this.refresh();
    const createdScene = !this.state.scenes.includes(opts.sceneName);
    const settings = { url: opts.url, width: opts.width, height: opts.height, shutdown: false, restart_when_active: false, reroute_audio: false };
    const r = await this.ensureInput({ sceneName: opts.sceneName, inputName: opts.sourceName, inputKind: "browser_source", settings });
    return { createdScene, createdInput: r.created, updatedUrl: r.updated };
  }

  /**
   * Ensures an input of the given kind exists in a scene. Refuses to replace an existing input of a
   * different kind, and reports a clear error when this OBS build lacks the input kind.
   */
  async ensureInput(opts: { sceneName: string; inputName: string; inputKind: string; settings: Record<string, unknown> }): Promise<{ created: boolean; updated: boolean }> {
    this.requireConnected();
    if (this.state.inputKinds.length > 0 && !this.state.inputKinds.includes(opts.inputKind)) {
      throw new Error(
        opts.inputKind === "browser_source"
          ? "This OBS build has no Browser Source (obs-browser plugin missing). Install an OBS build with Browser Source, or add the overlay URL to another browser-capable mixer."
          : `This OBS build does not support input kind "${opts.inputKind}"`,
      );
    }
    if (!this.state.scenes.includes(opts.sceneName)) {
      await this.obs.call("CreateScene", { sceneName: opts.sceneName });
    }
    const existing = this.state.inputs.find((i) => i.name === opts.inputName);
    let created = false;
    let updated = false;
    if (!existing) {
      await this.obs.call("CreateInput", { sceneName: opts.sceneName, inputName: opts.inputName, inputKind: opts.inputKind, inputSettings: opts.settings as never, sceneItemEnabled: true });
      created = true;
    } else if (existing.kind === opts.inputKind) {
      await this.obs.call("SetInputSettings", { inputName: opts.inputName, inputSettings: opts.settings as never, overlay: true });
      updated = true;
    } else {
      throw new Error(`An input named "${opts.inputName}" exists with kind ${existing.kind}; refusing to replace it`);
    }
    await this.refresh();
    return { created, updated };
  }

  /**
   * Saves the replay buffer and waits for OBS to confirm the written file (ReplayBufferSaved).
   * The request being accepted is not proof that a clip exists.
   */
  async saveReplayBuffer(timeoutMs = 15000): Promise<{ savedPath: string }> {
    this.requireConnected();
    if (!this.state.replayBuffer) throw new Error("OBS replay buffer is not running");
    const saved = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.obs.off("ReplayBufferSaved", onSaved);
        reject(new Error("OBS did not confirm the replay save in time"));
      }, timeoutMs);
      const onSaved = (e: { savedReplayPath: string }) => {
        clearTimeout(timer);
        this.obs.off("ReplayBufferSaved", onSaved);
        resolve(e.savedReplayPath);
      };
      this.obs.on("ReplayBufferSaved", onSaved);
    });
    await this.obs.call("SaveReplayBuffer");
    const savedPath = await saved;
    this.patch({ lastReplayPath: savedPath });
    return { savedPath };
  }

  async setOutput(kind: "record" | "stream" | "replay", active: boolean): Promise<void> {
    this.requireConnected();
    const map = {
      record: active ? "StartRecord" : "StopRecord",
      stream: active ? "StartStream" : "StopStream",
      replay: active ? "StartReplayBuffer" : "StopReplayBuffer",
    } as const;
    await this.obs.call(map[kind]);
    // Outputs start asynchronously: confirm the resulting state rather than trusting the request.
    const key = kind === "record" ? "recording" : kind === "stream" ? "streaming" : "replayBuffer";
    for (let i = 0; i < 30; i++) {
      await this.refresh();
      if (this.state[key] === active) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`OBS ${kind} output did not become ${active ? "active" : "inactive"} (check the OBS output settings and log)`);
  }

  async mediaAction(inputName: string, action: "play" | "pause" | "stop" | "restart"): Promise<void> {
    this.requireConnected();
    const mediaAction = {
      play: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY",
      pause: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE",
      stop: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP",
      restart: "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
    }[action];
    await this.obs.call("TriggerMediaInputAction", { inputName, mediaAction });
  }

  /** Media input playback state as OBS reports it (used to confirm a replay is actually playing). */
  async mediaStatus(inputName: string): Promise<{ state: string; durationMs: number | null; cursorMs: number | null }> {
    this.requireConnected();
    const r = await this.obs.call("GetMediaInputStatus", { inputName });
    return { state: r.mediaState, durationMs: r.mediaDuration ?? null, cursorMs: r.mediaCursor ?? null };
  }

  async setMediaFile(inputName: string, localFile: string, opts: { speedPercent?: number } = {}): Promise<void> {
    this.requireConnected();
    // A media source's own speed setting (100 = real time) slows a replay down without re-encoding it.
    const inputSettings: Record<string, string | number | boolean> = { local_file: localFile, is_local_file: true };
    if (opts.speedPercent !== undefined) inputSettings.speed_percent = Math.round(Math.min(200, Math.max(1, opts.speedPercent)));
    await this.obs.call("SetInputSettings", { inputName, inputSettings, overlay: true });
  }

  /** Seeks a playing media input (milliseconds from its start). */
  async setMediaCursor(inputName: string, cursorMs: number): Promise<void> {
    this.requireConnected();
    await this.obs.call("SetMediaInputCursor", { inputName, mediaCursor: Math.max(0, Math.round(cursorMs)) });
  }

  async screenshot(sourceName: string, width = 640): Promise<string> {
    this.requireConnected();
    const r = await this.obs.call("GetSourceScreenshot", { sourceName, imageFormat: "png", imageWidth: width });
    return r.imageData;
  }
}
