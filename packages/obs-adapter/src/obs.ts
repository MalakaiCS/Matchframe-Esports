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

  /** Puts a scene in preview (studio mode) and confirms by read-back. */
  async setPreview(sceneName: string): Promise<{ confirmed: boolean; previewScene: string | null }> {
    this.requireConnected();
    if (!this.state.studioMode) throw new Error("Studio mode is disabled in OBS; preview is unavailable");
    await this.obs.call("SetCurrentPreviewScene", { sceneName });
    const r = await this.obs.call("GetCurrentPreviewScene");
    this.patch({ previewScene: r.currentPreviewSceneName });
    return { confirmed: r.currentPreviewSceneName === sceneName, previewScene: r.currentPreviewSceneName };
  }

  /** Cuts a scene to program (directly, or via the studio-mode transition) and confirms. */
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

  /** Scene transitions with their kinds (a Stinger is `obs_stinger_transition`). */
  async transitionKinds(): Promise<{ current: string | null; transitions: { name: string; kind: string }[] }> {
    this.requireConnected();
    const r = await this.obs.call("GetSceneTransitionList");
    return { current: r.currentSceneTransitionName ?? null, transitions: (r.transitions as { transitionName: string; transitionKind: string }[]).map((t) => ({ name: t.transitionName, kind: t.transitionKind })) };
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
