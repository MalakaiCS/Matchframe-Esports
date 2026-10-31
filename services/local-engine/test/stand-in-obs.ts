import { EventEmitter } from "node:events";
import type { Engine } from "../src/app.ts";

/**
 * A stand-in OBS at the obs-websocket level, for tests: scenes with items (transforms, order,
 * visibility, blend modes), inputs with settings, filters and audio, transitions that take their time
 * and send OBS 30's events (SceneTransitionStarted, then at the end SceneTransitionVideoEnded,
 * CurrentProgramSceneChanged and SceneTransitionEnded), and media sources that play their files in
 * real time (pause, play, restart, seek; a new file opens a moment later; OBS's defaults for a new
 * Media Source: restart when shown, clear at the end). Studio Mode as OBS 30 does it, measured:
 * SetCurrentProgramScene transitions the program and leaves the preview until the transition ends,
 * then Swap Scenes (on by default) puts the scene the program left in preview; the Transition button
 * takes the preview to program. Requests OBS 30 refuses (bounds below 1 px) are refused. Not a real
 * OBS: it certifies the engine's requests and timing, not OBS's picture.
 */

interface Item {
  id: number;
  source: string;
  enabled: boolean;
  locked: boolean;
  blend: string;
  transform: Record<string, unknown>;
}
interface Media {
  file: string | null;
  state: "NONE" | "OPENING" | "PLAYING" | "PAUSED" | "ENDED" | "STOPPED" | "ERROR";
  base: number;
  anchor: number | null;
  duration: number;
}
interface Input {
  kind: string;
  settings: Record<string, unknown>;
  filters: { name: string; kind: string; enabled: boolean; settings: Record<string, unknown> }[];
  audio: { volumeMul: number; muted: boolean; monitorType: string; balance: number; syncOffsetMs: number; tracks: Record<string, boolean> };
  media: Media;
}
interface Transition {
  name: string;
  kind: string;
  fixed: boolean;
  settings: Record<string, unknown> | null;
  /** A fixed transition's own length. */
  lengthMs?: number;
}

const BASE_TRANSFORM = { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: "OBS_BOUNDS_NONE", boundsAlignment: 0, boundsWidth: 0, boundsHeight: 0, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0 };
const MEDIA_DEFAULTS = { restart_on_activate: true, close_when_inactive: false, clear_on_media_end: true };

export class StandInObs extends EventEmitter {
  scenes = new Map<string, Item[]>();
  inputs = new Map<string, Input>();
  program: string | null = null;
  preview: string | null = null;
  studio = false;
  /** Studio Mode's Swap Scenes (OBS's default). */
  swap = true;
  transitions: Transition[] = [
    { name: "Cut", kind: "cut_transition", fixed: true, settings: null, lengthMs: 0 },
    { name: "Fade", kind: "fade_transition", fixed: false, settings: null },
    { name: "Matchframe Replay Stinger", kind: "obs_stinger_transition", fixed: true, settings: { path: "stinger.mov", transition_point: 300, tp_type: 0 }, lengthMs: 600 },
  ];
  current = "Fade";
  durationMs = 300;
  /** Every program change: the scene, the transition and its length, when (ms since the stand-in started), and where each media source was then. */
  readonly changes: { scene: string; transition: string; durationMs: number; at: number; media: Record<string, { state: string; cursorMs: number }> }[] = [];
  /** Every media request: "<input> <what>". */
  readonly mediaLog: string[] = [];
  /** How long each file plays (ms), by its path; files not listed play this long. */
  durations = new Map<string, number>();
  defaultDurationMs = 3000;
  /** Files OBS can't open. */
  broken = new Set<string>();
  private nextId = 1;
  private readonly t0 = Date.now();
  private active = new Set<string>();

  // ---- obs-websocket-js's client ------------------------------------------------------------
  connect = async () => ({ obsWebSocketVersion: "5.3.4", rpcVersion: 1, negotiatedRpcVersion: 1 });
  disconnect = async () => undefined;

  /** Makes an engine talk to this stand-in, connected. */
  static async attach(e: Engine, setup?: (o: StandInObs) => void): Promise<StandInObs> {
    const o = new StandInObs();
    setup?.(o);
    const m = e.obs as unknown as { obs: unknown; bindEvents(): void };
    m.obs = o;
    m.bindEvents();
    await e.obs.connect({ id: "stand-in", name: "Stand-in OBS", url: "ws://stand-in", hasPassword: false });
    return o;
  }

  addScene(name: string): void {
    this.scenes.set(name, []);
  }

  addInput(scene: string, name: string, kind: string, settings: Record<string, unknown> = {}, transform: Record<string, unknown> = {}): number {
    this.inputs.set(name, { kind, settings: { ...settings }, filters: [], audio: { volumeMul: 1, muted: false, monitorType: "OBS_MONITORING_TYPE_NONE", balance: 0.5, syncOffsetMs: 0, tracks: { "1": true, "2": true } }, media: { file: null, state: "NONE", base: 0, anchor: null, duration: 0 } });
    return this.addItem(scene, name, true, transform);
  }

  private addItem(scene: string, source: string, enabled: boolean, transform: Record<string, unknown> = {}): number {
    const list = this.scenes.get(scene);
    if (!list) throw new Error(`No scene "${scene}"`);
    const id = this.nextId++;
    list.push({ id, source, enabled, locked: false, blend: "OBS_BLEND_NORMAL", transform: { ...BASE_TRANSFORM, ...transform } });
    return id;
  }

  /** Where a media input is (ms), and its state. */
  media(name: string): { state: string; cursorMs: number; file: string | null } {
    const m = this.input(name).media;
    this.settle(m);
    return { state: m.state, cursorMs: Math.round(this.cursor(m)), file: m.file };
  }

  private input(name: string): Input {
    const i = this.inputs.get(name);
    if (!i) throw new Error(`No source was found by the name of "${name}"`);
    return i;
  }

  private items(scene: string): Item[] {
    const s = this.scenes.get(scene);
    if (!s) throw new Error(`No source was found by the name of "${scene}"`);
    return s;
  }

  private item(scene: string, id: number): Item {
    const it = this.items(scene).find((x) => x.id === id);
    if (!it) throw new Error(`No scene items were found in scene "${scene}" with the ID ${id}`);
    return it;
  }

  private cursor(m: Media): number {
    return Math.min(m.duration, m.base + (m.anchor !== null ? Date.now() - m.anchor : 0));
  }

  private settle(m: Media): void {
    if (m.state === "PLAYING" && this.cursor(m) >= m.duration) [m.state, m.base, m.anchor] = ["ENDED", m.duration, null];
  }

  private setting(i: Input, k: keyof typeof MEDIA_DEFAULTS): unknown {
    return i.settings[k] ?? MEDIA_DEFAULTS[k];
  }

  /** The media inputs shown by a scene. */
  private mediaIn(scene: string | null): string[] {
    return scene ? (this.scenes.get(scene) ?? []).filter((x) => this.inputs.get(x.source)?.kind === "ffmpeg_source").map((x) => x.source) : [];
  }

  private load(name: string, file: string): void {
    const i = this.input(name);
    const m = i.media;
    this.mediaLog.push(`${name} load ${file.split(/[\\/]/).pop()}`);
    Object.assign(m, { file, state: "OPENING", base: 0, anchor: null, duration: this.durations.get(file) ?? this.defaultDurationMs });
    setTimeout(() => {
      if (m.file !== file) return;
      if (this.broken.has(file)) m.state = "ERROR";
      // A source closed while hidden opens its file only when shown.
      else if (this.setting(i, "close_when_inactive") === true && !this.active.has(name)) m.state = "STOPPED";
      else Object.assign(m, { state: "PLAYING", base: 0, anchor: Date.now() });
    }, 20);
  }

  call = async (req: string, d: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    await new Promise((r) => setImmediate(r));
    switch (req) {
      case "GetVersion":
        return { obsVersion: "30.0.2", obsWebSocketVersion: "5.3.4", platformDescription: "stand-in", availableRequests: [] };
      case "GetSceneList":
        return { scenes: [...this.scenes.keys()].map((sceneName, sceneIndex) => ({ sceneName, sceneIndex })), currentProgramSceneName: this.program, currentPreviewSceneName: this.preview };
      case "GetInputList":
        return { inputs: [...this.inputs].map(([inputName, i]) => ({ inputName, inputKind: i.kind })) };
      case "GetStudioModeEnabled":
        return { studioModeEnabled: this.studio };
      case "SetStudioModeEnabled":
        this.studio = d.studioModeEnabled === true;
        if (this.studio && !this.preview) this.preview = this.program;
        this.emit("StudioModeStateChanged", { studioModeEnabled: this.studio });
        return {};
      case "GetCurrentPreviewScene":
        if (!this.studio) throw new Error("Studio mode is not active.");
        return { currentPreviewSceneName: this.preview };
      case "SetCurrentPreviewScene":
        if (!this.studio) throw new Error("Studio mode is not active.");
        this.items(String(d.sceneName));
        this.setPreview(String(d.sceneName));
        return {};
      case "GetInputKindList":
        return { inputKinds: ["ffmpeg_source", "color_source_v3", "browser_source", "image_source"] };
      case "GetRecordStatus":
      case "GetStreamStatus":
      case "GetReplayBufferStatus":
        return { outputActive: false };
      case "GetCurrentProgramScene":
        return { currentProgramSceneName: this.program };
      case "SetCurrentProgramScene":
        return this.switchTo(String(d.sceneName));
      case "GetSceneTransitionList":
        return { currentSceneTransitionName: this.current, currentSceneTransitionKind: this.t().kind, transitions: this.transitions.map((t) => ({ transitionName: t.name, transitionKind: t.kind, transitionFixed: t.fixed, transitionConfigurable: t.settings !== null })) };
      case "GetCurrentSceneTransition":
        return { transitionName: this.current, transitionKind: this.t().kind, transitionFixed: this.t().fixed, transitionDuration: this.t().fixed ? null : this.durationMs, transitionConfigurable: this.t().settings !== null, transitionSettings: this.t().settings };
      case "SetCurrentSceneTransition": {
        const name = String(d.transitionName);
        if (!this.transitions.some((t) => t.name === name)) throw new Error(`No scene transition was found by the name of "${name}"`);
        this.current = name;
        return {};
      }
      case "SetCurrentSceneTransitionDuration":
        this.durationMs = Number(d.transitionDuration);
        return {};
      case "GetSceneItemList":
        return {
          sceneItems: this.items(String(d.sceneName)).map((x, k) => {
            const i = this.inputs.get(x.source);
            const scale = x.transform as { scaleX: number; scaleY: number };
            return { sceneItemId: x.id, sceneItemIndex: k, sourceName: x.source, sourceType: i ? "OBS_SOURCE_TYPE_INPUT" : "OBS_SOURCE_TYPE_SCENE", inputKind: i?.kind ?? null, isGroup: null, sceneItemEnabled: x.enabled, sceneItemLocked: x.locked, sceneItemBlendMode: x.blend, sceneItemTransform: { ...x.transform, sourceWidth: 1280, sourceHeight: 720, width: 1280 * scale.scaleX, height: 720 * scale.scaleY } };
          }),
        };
      case "CreateScene": {
        const name = String(d.sceneName);
        if (this.scenes.has(name) || this.inputs.has(name)) throw new Error(`A source already exists by that name "${name}"`);
        this.addScene(name);
        return {};
      }
      case "RemoveScene":
        this.items(String(d.sceneName));
        this.scenes.delete(String(d.sceneName));
        return {};
      case "CreateSceneItem": {
        const source = String(d.sourceName);
        if (!this.inputs.has(source) && !this.scenes.has(source)) throw new Error(`No source was found by the name of "${source}"`);
        return { sceneItemId: this.addItem(String(d.sceneName), source, d.sceneItemEnabled !== false) };
      }
      case "RemoveSceneItem": {
        const list = this.items(String(d.sceneName));
        list.splice(list.indexOf(this.item(String(d.sceneName), Number(d.sceneItemId))), 1);
        return {};
      }
      case "SetSceneItemTransform": {
        const t = d.sceneItemTransform as Record<string, unknown>;
        for (const k of ["boundsWidth", "boundsHeight"]) if (t[k] !== undefined && Number(t[k]) < 1) throw new Error(`The field value of \`${k}\` is below the minimum of \`1.000000\``);
        for (const k of ["width", "height", "sourceWidth", "sourceHeight"]) if (t[k] !== undefined) throw new Error(`\`${k}\` can't be set`);
        Object.assign(this.item(String(d.sceneName), Number(d.sceneItemId)).transform, t);
        return {};
      }
      case "SetSceneItemEnabled":
        this.item(String(d.sceneName), Number(d.sceneItemId)).enabled = d.sceneItemEnabled === true;
        return {};
      case "SetSceneItemLocked":
        this.item(String(d.sceneName), Number(d.sceneItemId)).locked = d.sceneItemLocked === true;
        return {};
      case "SetSceneItemBlendMode":
        this.item(String(d.sceneName), Number(d.sceneItemId)).blend = String(d.sceneItemBlendMode);
        return {};
      case "SetSceneItemIndex": {
        const list = this.items(String(d.sceneName));
        const it = this.item(String(d.sceneName), Number(d.sceneItemId));
        list.splice(list.indexOf(it), 1);
        list.splice(Math.min(list.length, Number(d.sceneItemIndex)), 0, it);
        return {};
      }
      case "CreateInput": {
        const name = String(d.inputName);
        if (this.inputs.has(name) || this.scenes.has(name)) throw new Error(`A source already exists by that name "${name}"`);
        const settings = (d.inputSettings ?? {}) as Record<string, unknown>;
        const id = this.addInput(String(d.sceneName), name, String(d.inputKind), settings);
        if (typeof settings.local_file === "string" && settings.local_file) this.load(name, settings.local_file);
        return { sceneItemId: id };
      }
      case "RemoveInput": {
        const name = String(d.inputName);
        this.input(name);
        this.inputs.delete(name);
        for (const list of this.scenes.values()) for (let k = list.length - 1; k >= 0; k--) if (list[k]!.source === name) list.splice(k, 1);
        return {};
      }
      case "GetInputSettings": {
        const i = this.input(String(d.inputName));
        return { inputKind: i.kind, inputSettings: { ...i.settings } };
      }
      case "SetInputSettings": {
        const name = String(d.inputName);
        const i = this.input(name);
        const next = (d.inputSettings ?? {}) as Record<string, unknown>;
        const before = i.settings.local_file;
        i.settings = d.overlay === false ? { ...next } : { ...i.settings, ...next };
        // OBS reopens a media source's file on any change of its settings.
        if (i.kind === "ffmpeg_source" && typeof i.settings.local_file === "string" && i.settings.local_file && (next.local_file !== undefined || before !== undefined)) this.load(name, i.settings.local_file);
        return {};
      }
      case "GetMediaInputStatus": {
        const m = this.input(String(d.inputName)).media;
        this.settle(m);
        const known = m.state === "PLAYING" || m.state === "PAUSED" || m.state === "ENDED";
        return { mediaState: `OBS_MEDIA_STATE_${m.state}`, mediaDuration: known ? m.duration : null, mediaCursor: known ? Math.round(this.cursor(m)) : null };
      }
      case "TriggerMediaInputAction": {
        const name = String(d.inputName);
        const m = this.input(name).media;
        this.settle(m);
        const action = String(d.mediaAction).replace("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_", "").toLowerCase();
        this.mediaLog.push(`${name} ${action}`);
        if (action === "pause" && m.state === "PLAYING") [m.base, m.anchor, m.state] = [this.cursor(m), null, "PAUSED"];
        if (action === "play" && m.state === "PAUSED") [m.anchor, m.state] = [Date.now(), "PLAYING"];
        if (action === "restart" && m.file) [m.base, m.anchor, m.state] = [0, Date.now(), "PLAYING"];
        if (action === "stop") [m.anchor, m.state] = [null, "STOPPED"];
        return {};
      }
      case "SetMediaInputCursor": {
        const name = String(d.inputName);
        const m = this.input(name).media;
        this.settle(m);
        this.mediaLog.push(`${name} seek ${Number(d.mediaCursor)}`);
        if (m.state === "ENDED") m.state = "PLAYING";
        [m.base, m.anchor] = [Math.min(m.duration, Number(d.mediaCursor)), m.state === "PLAYING" ? Date.now() : null];
        return {};
      }
      case "GetSourceFilterList":
        return { filters: this.input(String(d.sourceName)).filters.map((f, k) => ({ filterName: f.name, filterKind: f.kind, filterIndex: k, filterEnabled: f.enabled, filterSettings: { ...f.settings } })) };
      case "CreateSourceFilter":
        this.input(String(d.sourceName)).filters.push({ name: String(d.filterName), kind: String(d.filterKind), enabled: true, settings: { ...((d.filterSettings ?? {}) as Record<string, unknown>) } });
        return {};
      case "RemoveSourceFilter": {
        const i = this.input(String(d.sourceName));
        i.filters = i.filters.filter((f) => f.name !== d.filterName);
        return {};
      }
      case "SetSourceFilterEnabled": {
        const f = this.input(String(d.sourceName)).filters.find((x) => x.name === d.filterName);
        if (f) f.enabled = d.filterEnabled === true;
        return {};
      }
      case "GetInputVolume":
        return { inputVolumeMul: this.input(String(d.inputName)).audio.volumeMul, inputVolumeDb: 0 };
      case "GetInputMute":
        return { inputMuted: this.input(String(d.inputName)).audio.muted };
      case "GetInputAudioMonitorType":
        return { monitorType: this.input(String(d.inputName)).audio.monitorType };
      case "GetInputAudioBalance":
        return { inputAudioBalance: this.input(String(d.inputName)).audio.balance };
      case "GetInputAudioSyncOffset":
        return { inputAudioSyncOffset: this.input(String(d.inputName)).audio.syncOffsetMs };
      case "GetInputAudioTracks":
        return { inputAudioTracks: { ...this.input(String(d.inputName)).audio.tracks } };
      case "SetInputVolume":
        this.input(String(d.inputName)).audio.volumeMul = Number(d.inputVolumeMul);
        return {};
      case "SetInputMute":
        this.input(String(d.inputName)).audio.muted = d.inputMuted === true;
        return {};
      case "SetInputAudioMonitorType":
        this.input(String(d.inputName)).audio.monitorType = String(d.monitorType);
        return {};
      case "SetInputAudioBalance":
        this.input(String(d.inputName)).audio.balance = Number(d.inputAudioBalance);
        return {};
      case "SetInputAudioSyncOffset":
        this.input(String(d.inputName)).audio.syncOffsetMs = Number(d.inputAudioSyncOffset);
        return {};
      case "SetInputAudioTracks":
        Object.assign(this.input(String(d.inputName)).audio.tracks, d.inputAudioTracks as object);
        return {};
      default:
        throw new Error(`stand-in OBS: ${req} isn't modelled`);
    }
  };

  private setPreview(scene: string): void {
    this.preview = scene;
    this.emit("CurrentPreviewSceneChanged", { sceneName: scene });
  }

  /** Studio Mode: the operator presses OBS's Transition button (the preview goes to program). */
  transitionButton(): void {
    if (!this.studio || !this.preview) throw new Error("Studio mode is not active.");
    this.switchTo(this.preview);
  }

  private t(): Transition {
    return this.transitions.find((x) => x.name === this.current)!;
  }

  /** A program change with the current transition: the new scene's sources are shown from its start; the old one's hidden at its end. */
  private switchTo(scene: string): Record<string, unknown> {
    this.items(scene);
    // (In Studio Mode with Duplicate Scene, OBS transitions to a new copy of the scene on program.)
    if (scene === this.program && !this.studio) return {};
    const t = this.t();
    const ms = t.fixed ? (t.lengthMs ?? 0) : this.durationMs;
    const from = this.program;
    this.program = scene;
    const media = Object.fromEntries([...this.inputs].filter(([, i]) => i.kind === "ffmpeg_source" && i.media.file).map(([n]) => [n, this.media(n)]));
    this.changes.push({ scene, transition: t.name, durationMs: ms, at: Date.now() - this.t0, media });
    this.emit("SceneTransitionStarted", { transitionName: t.name });
    // Shown: a media source that restarts when shown starts over.
    for (const name of this.mediaIn(scene)) {
      if (this.active.has(name)) continue;
      this.active.add(name);
      const i = this.inputs.get(name)!;
      if (i.media.file && this.setting(i, "restart_on_activate") === true) [i.media.base, i.media.anchor, i.media.state] = [0, Date.now(), "PLAYING"];
      else if (i.media.file && i.media.state === "STOPPED") this.load(name, i.media.file);
    }
    setTimeout(() => {
      for (const name of this.mediaIn(from)) if (!this.mediaIn(this.program).includes(name)) this.active.delete(name);
      // Swap Scenes: the scene the program left goes to preview.
      if (this.studio && this.swap && from && from !== this.preview) this.setPreview(from);
      this.emit("SceneTransitionVideoEnded", { transitionName: t.name });
      this.emit("CurrentProgramSceneChanged", { sceneName: this.program });
      this.emit("SceneTransitionEnded", { transitionName: t.name });
    }, ms);
    return {};
  }
}
