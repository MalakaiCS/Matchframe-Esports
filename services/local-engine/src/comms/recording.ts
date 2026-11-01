import { readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { extname, join } from "node:path";
import { z } from "zod";
import type { ObsManager } from "@matchframe/obs-adapter";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { checkFolder, freeBytes } from "../storage.ts";
import type { CommsOutputs } from "./outputs.ts";
import { RECORDING_NDI_NAME } from "./outputs.ts";
import { patchOf, type TeamComms } from "./service.ts";
import { STRIP_SOURCE, type SpeakerStrip } from "./strip.ts";

/**
 * The dedicated comms recording (ADR-068; the owner's brief, sections 8 and 9): OBS's Source Record
 * filter on a recording-only scene, "Matchframe Comms Recording", that holds the gameplay (the live
 * scene's own game capture, shared, so it stays active whatever the program shows), the live scene's
 * Matchframe HUD (shared), the recording-only speaker strip (comms/strip.ts) and the recording comms
 * ("MatchFrame Comms Recording", the engine's NDI audio, received by DistroAV), plus a copy of the
 * live scene's game audio input whose fader is the recording's game level.
 *
 * - **Its own encoder and file:** Source Record renders the scene through its own view and encoder,
 *   so cuts of the program to casters, replays, a break or highlights never reach it (measured in
 *   OBS 30.0.2, docs/operations/team-comms.md).
 * - **Its sound is the scene's own** (Source Record's default): each of the scene's sources as OBS
 *   mixes it for track 1, after its fader and mute. Measured: a source taken off track 1 is missing,
 *   a fader at −20 dB is −20 dB, and with no OBS output using track 1 (no stream, recording or replay
 *   buffer) the file is silent. So the recording's audio inputs are on track 1 (they are in no
 *   program scene, so never in the stream's mix), and Matchframe warns while OBS isn't streaming or
 *   recording on track 1. Casters are left out by not being in the scene.
 * - **Controls:** Start/Stop (record mode Always/None over obs-websocket), its own and independent of
 *   the public listen-in (Mute All Comms never touches it); the recording team by team id (the comms
 *   mix and the strip change on the same block); game level (the game audio copy's fader in OBS);
 *   comms level (the engine's gain on the recording mix before NDI); the destination folder; status
 *   (elapsed time, the file and its growth, free space, faults). TeamSpeak's recording indicator is on
 *   while it records.
 * - **Never started by itself:** after a restart it is adopted only if Source Record is still
 *   recording in OBS.
 */

export const RECORDING_SCENE = "Matchframe Comms Recording";
export const RECORDER_FILTER = "MatchFrame Recorder";
export const SOURCE_RECORD_KIND = "source_record_filter";
export const GAME_AUDIO_COPY = "MatchFrame Recording Game Audio";
const NDI_KIND = "ndi_source";
const SETTINGS_KEY = "comms.recording";
const RUN_KEY = "comms.recording.run";
/** Below this much free space the recording is in fault (the file will stop when the drive fills). */
export const CRITICAL_FREE_BYTES = 2 * 1024 ** 3;
/** The file not growing this long while recording is a fault. */
const STALL_MS = 8000;
const FILE_PREFIX = "MatchFrame Comms";

export const SOURCE_RECORD_INSTALL = [
  "Close OBS.",
  "Download Source Record (by exeldro, free, GPL-2.0) for your OBS version from https://obsproject.com/forum/resources/source-record.1285/ (Windows: the installer or the zip; 0.4.x for OBS 30 and 31).",
  "Run the installer (or unzip into OBS's folder, e.g. C:\\Program Files\\obs-studio), then start OBS: Tools or a scene's Filters list now offers Source Record.",
  "Back here: Team Comms → Dedicated recording → Set up the recording scene in OBS.",
];

const RecordingObs = z.object({
  scene: z.string().min(1).max(200).default(RECORDING_SCENE),
  /** The live scene's gameplay source (shared). */
  gameSource: z.string().max(200).nullable().default(null),
  /** The live scene's Matchframe HUD browser source (shared). */
  hudSource: z.string().max(200).nullable().default(null),
  /** The live scene's game audio input, copied as the recording's own (null: the gameplay source carries the game's sound). */
  gameAudioSource: z.string().max(200).nullable().default(null),
});

export const RecordingSettings = z.object({
  /** The team whose comms the recording carries (a team id; never CT/T). */
  teamId: z.string().max(100).nullable().default(null),
  /** Where Source Record writes (null: Videos → Matchframe Comms Recordings). */
  folder: z.string().max(400).nullable().default(null),
  /** mkv survives a crash (OBS can remux it to mp4); hybrid MP4 needs OBS 30.2+. */
  format: z.enum(["mkv", "hybrid_mp4", "fragmented_mp4", "mp4", "mov"]).default("mkv"),
  /** Source Record's video encoder id ("": as OBS's own recording, e.g. NVENC on the owner's PC). */
  encoder: z.string().max(64).default(""),
  bitrateKbps: z.number().int().min(1000).max(150000).default(16000),
  audioBitrateKbps: z.number().int().min(64).max(512).default(192),
  /** A new file every this many minutes (0: one file). */
  splitMinutes: z.number().int().min(0).max(720).default(0),
  /** The recording's game audio (its own copy's fader in OBS), dB. */
  gameLevelDb: z.number().min(-60).max(12).default(0),
  /** The recording comms (Matchframe's gain before NDI), dB; −60 is off. */
  commsLevelDb: z.number().min(-60).max(12).default(0),
  /** Free space under this (GB) is a warning. */
  warnFreeGB: z.number().min(1).max(10000).default(20),
  obs: RecordingObs.prefault({}),
});
export type RecordingSettings = z.infer<typeof RecordingSettings>;
export const RecordingPatch = z.intersection(patchOf(RecordingSettings.omit({ obs: true })), z.object({ obs: patchOf(RecordingObs).optional() }));
export type RecordingPatch = z.infer<typeof RecordingPatch>;

export const SetupRequest = z.object({
  gameSource: z.string().min(1).max(200).optional(),
  hudSource: z.string().min(1).max(200).nullable().optional(),
  gameAudioSource: z.string().min(1).max(200).nullable().optional(),
});

export type RecordingState = "idle" | "recording" | "fault";

interface Run {
  startedAt: string;
  startedAtMs: number;
  folder: string;
  prefix: string;
  ext: string;
  teamId: string | null;
}

export interface SetupStep {
  id: string;
  ok: boolean | null;
  title: string;
  detail: string;
}

export class RecordingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RecordingError";
  }
}

export interface RecordingDeps {
  comms: TeamComms;
  outputs: CommsOutputs;
  strip: SpeakerStrip;
  obs: ObsManager;
  settings: SettingsRepo;
  logger: Pick<Logger, "info" | "warn">;
  liveScene: () => string | null;
  /** The default folder (Videos → Matchframe Comms Recordings). */
  defaultFolder: () => string;
  /** A team's name and short name. */
  teamName: (teamId: string) => { name: string; shortName: string | null } | null;
  /** The overlay server's port (to recognise Matchframe HUD pages). */
  overlayPort: () => number;
  /** Test seams. */
  freeBytes?: (dir: string) => number | null;
  wallNow?: () => number;
  /** The NDI computer name ("DESKTOP-1 (MatchFrame Comms Recording)"); defaults to this computer's. */
  ndiHost?: () => string;
}

const secs = (ms: number) => Math.round(ms / 1000);
const GB = 1024 ** 3;
/** Video sources a live scene shows the game with. */
const GAME_KINDS = ["game_capture", "window_capture", "monitor_capture", "dshow_input", "av_capture_input", "screen_capture", "xcomposite_input", "xshm_input", "pipewire-window-capture-source", "pipewire-screen-capture-source", "ndi_source", "ffmpeg_source"];
const AUDIO_KINDS = new Set(["wasapi_process_output_capture", "wasapi_input_capture", "wasapi_output_capture", "pulse_input_capture", "pulse_output_capture", "alsa_input_capture", "coreaudio_input_capture", "sck_audio_capture", "ffmpeg_source"]);

export class CommsRecording {
  private state: RecordingState = "idle";
  private run: Run | null = null;
  private fault: { reason: string; at: string } | null = null;
  private file: { path: string; bytes: number; grewAtMs: number; files: string[] } | null = null;
  private last: { path: string | null; bytes: number; durationMs: number; endedAt: string; reason: string } | null = null;
  private sourceRecord: { available: boolean | null; checkedAtMs: number; defaults: Record<string, unknown> | null } = { available: null, checkedAtMs: -Infinity, defaults: null };
  private filterMode: number | null = null;
  private track1: { inUse: boolean | null; detail: string; checkedAtMs: number } = { inUse: null, detail: "Not checked yet.", checkedAtMs: -Infinity };
  private lastSetup: { at: string; ok: boolean; steps: SetupStep[] } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private adopted = false;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly d: RecordingDeps) {
    const saved = d.settings.get<Run | null>(RUN_KEY, null);
    // A recording in progress when the engine stopped: adopted only if OBS says it still records (tick()).
    this.run = saved && typeof saved.startedAtMs === "number" ? saved : null;
    this.applyLevels();
    const onConnect = () => {
      this.sourceRecord.checkedAtMs = -Infinity;
      this.track1.checkedAtMs = -Infinity;
      void this.tick();
    };
    d.obs.on("connected", onConnect);
    this.offs.push(() => d.obs.off("connected", onConnect));
  }

  private wall(): number {
    return this.d.wallNow ? this.d.wallNow() : Date.now();
  }

  settings(): RecordingSettings {
    const r = RecordingSettings.safeParse(this.d.settings.get(SETTINGS_KEY, {}));
    return r.success ? r.data : RecordingSettings.parse({});
  }

  folder(): string {
    return this.settings().folder ?? this.d.defaultFolder();
  }

  /** The team, the levels, the folder and the file settings (each applied as it is changed). */
  async setSettings(patch: RecordingPatch): Promise<RecordingSettings> {
    const prev = this.settings();
    const strip = <T extends object>(o: T | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
    const { obs, ...rest } = patch;
    const next = RecordingSettings.parse({ ...prev, ...strip(rest), obs: { ...prev.obs, ...strip(obs) } });
    if (next.folder && next.folder !== prev.folder) checkFolder(next.folder);
    if (next.teamId && next.teamId !== prev.teamId && !this.d.teamName(next.teamId)) throw new RecordingError(404, "no_team", "No such team.");
    if (this.state === "recording" && (next.folder !== prev.folder || next.format !== prev.format || next.encoder !== prev.encoder || next.bitrateKbps !== prev.bitrateKbps)) {
      throw new RecordingError(409, "recording", "Stop the recording before changing its folder, format or encoder (the file being written keeps them).");
    }
    this.d.settings.set(SETTINGS_KEY, next);
    if (next.teamId !== prev.teamId) this.applyTeam();
    this.applyLevels();
    if (next.gameLevelDb !== prev.gameLevelDb) await this.applyGameLevel().catch((err) => this.d.logger.warn("comms recording: game level not applied in OBS", { error: String(err) }));
    return next;
  }

  /** The recording team, by team id (null: none). Its comms mix and the strip change on the same block. */
  async setTeam(teamId: string | null): Promise<RecordingSettings> {
    if (teamId !== null && !this.d.comms.hasTeam(teamId)) throw new RecordingError(404, "no_team", "That team isn't one of the active match's teams (Team Comms slots A and B).");
    return this.setSettings({ teamId });
  }

  /** The chosen team onto the recording mix (when it has a slot in the active match). */
  private applyTeam(): void {
    const t = this.settings().teamId;
    const want = t && this.d.comms.hasTeam(t) ? t : null;
    if (this.d.comms.recordingTeam !== want) this.d.comms.setRecordingTeam(want);
  }

  private applyLevels(): void {
    this.d.outputs.setRecordingGainDb(this.settings().commsLevelDb);
  }

  /** The comms reach the recording (its level isn't off). */
  get commsAudible(): boolean {
    return this.settings().commsLevelDb > -60;
  }

  private async applyGameLevel(): Promise<void> {
    const obs = this.d.obs;
    if (!obs.state.connected || !obs.state.inputs.some((i) => i.name === GAME_AUDIO_COPY)) return;
    const db = this.settings().gameLevelDb;
    await obs.setInputVolume(GAME_AUDIO_COPY, db <= -60 ? { mul: 0 } : { db });
  }

  // ---------------------------------------------------------------------------------------- OBS checks

  /** Whether OBS has Source Record (checked at most every 10 s, or at once with `fresh`). */
  async sourceRecordAvailable(fresh = false): Promise<boolean | null> {
    const obs = this.d.obs;
    if (!obs.state.connected) return null;
    const now = this.wall();
    if (!fresh && now - this.sourceRecord.checkedAtMs < 10_000) return this.sourceRecord.available;
    try {
      const r = await obs.filterKind(SOURCE_RECORD_KIND);
      this.sourceRecord = { available: r.available, checkedAtMs: now, defaults: r.defaults };
    } catch (err) {
      this.d.logger.warn("comms recording: couldn't ask OBS for Source Record", { error: String(err) });
      this.sourceRecord = { ...this.sourceRecord, available: null, checkedAtMs: now };
    }
    return this.sourceRecord.available;
  }

  /**
   * Whether an OBS output uses track 1, which OBS mixes only while one does (measured: Source Record's
   * scene audio is silent otherwise). Simple output mode streams and records track 1; in Advanced mode
   * the stream's track and the recording's tracks are read from the profile.
   */
  private async checkTrack1(): Promise<void> {
    const obs = this.d.obs;
    const now = this.wall();
    if (now - this.track1.checkedAtMs < 3000) return;
    if (!obs.state.connected) {
      this.track1 = { inUse: null, detail: "OBS isn't connected.", checkedAtMs: now };
      return;
    }
    const { streaming, recording, replayBuffer } = obs.state;
    if (!streaming && !recording && !replayBuffer) {
      this.track1 = { inUse: false, detail: "OBS isn't streaming or recording. Source Record takes the scene's sound from OBS's track 1, which OBS mixes only while a stream, a recording or the replay buffer uses it: until then the comms recording is silent. Start the stream (or OBS's own recording).", checkedAtMs: now };
      return;
    }
    const mode = (await obs.profileParameter("Output", "Mode")) ?? "Simple";
    let inUse = true;
    let how = `OBS is ${[streaming && "streaming", recording && "recording", replayBuffer && "running its replay buffer"].filter(Boolean).join(" and ")}`;
    if (/^adv/i.test(mode)) {
      const streamTrack = Number((await obs.profileParameter("AdvOut", "TrackIndex")) ?? 1);
      const recTracks = Number((await obs.profileParameter("AdvOut", "RecTracks")) ?? 1);
      inUse = (!!streaming && streamTrack === 1) || ((!!recording || !!replayBuffer) && (recTracks & 1) === 1);
      how += ` (Advanced output: the stream on track ${streamTrack}, the recording on tracks ${[1, 2, 3, 4, 5, 6].filter((t) => recTracks & (1 << (t - 1))).join(", ") || "none"})`;
    }
    this.track1 = { inUse, detail: inUse ? `${how}: track 1 is mixed.` : `${how}, but nothing uses track 1: Source Record's scene sound would be silent. Put the stream (Settings → Output → Streaming → Audio Track) or the recording on track 1.`, checkedAtMs: now };
  }

  // ---------------------------------------------------------------------------------------- setup

  /** The live scene's sources, and Matchframe's guess at the gameplay, the HUD and the game audio. */
  async liveSources(): Promise<{ liveScene: string | null; sources: { name: string; kind: string | null }[]; suggested: { gameSource: string | null; hudSource: string | null; gameAudioSource: string | null }; sourceRecord: boolean | null; error: string | null }> {
    const obs = this.d.obs;
    const live = this.d.liveScene();
    const none = { gameSource: null, hudSource: null, gameAudioSource: null };
    if (!obs.state.connected) return { liveScene: live, sources: [], suggested: none, sourceRecord: null, error: "OBS isn't connected (Settings → Devices)." };
    if (!live) return { liveScene: null, sources: [], suggested: none, sourceRecord: await this.sourceRecordAvailable(true), error: "Map the live scene first (Settings → Setup → OBS scenes)." };
    try {
      const items = await obs.sceneItems(live);
      const sources = items.map((i) => ({ name: i.sourceName, kind: i.inputKind }));
      return { liveScene: live, sources, suggested: await this.suggest(items.map((i) => ({ name: i.sourceName, kind: i.inputKind }))), sourceRecord: await this.sourceRecordAvailable(true), error: null };
    } catch (err) {
      return { liveScene: live, sources: [], suggested: none, sourceRecord: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async suggest(items: { name: string; kind: string | null }[]): Promise<{ gameSource: string | null; hudSource: string | null; gameAudioSource: string | null }> {
    const obs = this.d.obs;
    const own = new Set([STRIP_SOURCE, RECORDING_NDI_NAME, GAME_AUDIO_COPY, "MatchFrame Comms", "MatchFrame Team Comms"]);
    const cand = items.filter((i) => !own.has(i.name));
    let game: string | null = null;
    for (const k of GAME_KINDS) {
      const hit = cand.find((i) => i.kind === k && (k !== "ndi_source" || !/matchframe comms/i.test(i.name)));
      if (hit) {
        game = hit.name;
        break;
      }
    }
    let hud: string | null = null;
    let audio: string | null = null;
    const port = this.d.overlayPort();
    for (const i of cand) {
      if (i.kind === "browser_source" && !hud) {
        const s = await obs.inputSettings(i.name).catch(() => null);
        const url = String(s?.settings.url ?? "");
        if (new RegExp(`(127\\.0\\.0\\.1|localhost):${port}/(overlay|hud)/`).test(url)) hud = i.name;
      }
      if (i.kind === "wasapi_process_output_capture" && !audio) {
        const s = await obs.inputSettings(i.name).catch(() => null);
        if (/cs2|counter-strike/i.test(JSON.stringify(s?.settings ?? {}))) audio = i.name;
      }
    }
    if (!audio) audio = cand.find((i) => i.kind && AUDIO_KINDS.has(i.kind) && /game/i.test(i.name) && i.name !== game)?.name ?? null;
    return { gameSource: game, hudSource: hud, gameAudioSource: audio };
  }

  /**
   * Set up the recording scene in OBS: the scene (made if missing), the live scene's gameplay and HUD
   * shared into it with their transforms, the speaker strip's browser source on top, the recording
   * comms (DistroAV NDI source) and a copy of the game audio input on track 1 only, not monitored,
   * and the Source Record filter on the scene, stopped. Existing sources are shared, never replaced.
   */
  async setupObs(req: z.infer<typeof SetupRequest> = {}): Promise<{ scene: string; ok: boolean; steps: SetupStep[] }> {
    const obs = this.d.obs;
    if (!obs.state.connected) throw new RecordingError(409, "obs_not_connected", "Connect OBS first (Settings → Devices).");
    const live = this.d.liveScene();
    if (!live) throw new RecordingError(409, "no_live_scene", "Map the live scene first (Settings → Setup → OBS scenes).");
    await obs.refresh();
    const cfg = this.settings();
    const liveItems = await obs.sceneItemsFull(live);
    const suggested = await this.suggest(liveItems.map((i) => ({ name: i.sourceName, kind: i.inputKind })));
    const gameSource = req.gameSource ?? cfg.obs.gameSource ?? suggested.gameSource;
    const hudSource = req.hudSource !== undefined ? req.hudSource : (cfg.obs.hudSource ?? suggested.hudSource);
    const gameAudioSource = req.gameAudioSource !== undefined ? req.gameAudioSource : (cfg.obs.gameAudioSource ?? suggested.gameAudioSource);
    if (!gameSource) throw new RecordingError(409, "no_gameplay", `No gameplay source found in “${live}”: choose the game capture.`);
    const scene = cfg.obs.scene;
    if (scene === live) throw new RecordingError(409, "same_scene", "The recording scene can't be the live scene.");
    const steps: SetupStep[] = [];
    const step = (id: string, ok: boolean | null, title: string, detail: string) => steps.push({ id, ok, title, detail });
    const inputs = () => obs.state.inputs;
    const kindOf = (name: string) => inputs().find((i) => i.name === name)?.kind ?? null;

    // Source Record.
    const sr = await this.sourceRecordAvailable(true);
    step("source-record", sr, "Source Record in OBS", sr ? `Installed (filter kind ${SOURCE_RECORD_KIND}).` : `OBS has no Source Record filter. ${SOURCE_RECORD_INSTALL.join(" ")}`);

    // The scene.
    const made = !obs.state.scenes.includes(scene);
    if (made) {
      if (kindOf(scene)) throw new RecordingError(409, "name_taken", `OBS has a source named “${scene}” that isn't a scene: rename it and press again.`);
      await obs.createScene(scene);
      await obs.refresh();
    }
    step("scene", true, `Scene “${scene}”`, made ? "Made (not a program scene: never put it on air)." : "Already there: brought up to date.");

    const have = async () => obs.sceneItemsFull(scene);
    /** A live scene's source into the recording scene (the same source, shared), with its transform there. */
    const share = async (name: string, what: string): Promise<boolean> => {
      const from = liveItems.find((i) => i.sourceName === name);
      if (!from) {
        step(what, false, `${what === "gameplay" ? "Gameplay" : "HUD"} “${name}”`, `Not in the live scene “${live}”.`);
        return false;
      }
      let item = (await have()).find((i) => i.sourceName === name);
      const id = item?.sceneItemId ?? (await obs.createSceneItem(scene, name, true));
      await obs.setSceneItem(scene, id, { transform: from.transform, enabled: true, blendMode: from.blendMode });
      item = (await have()).find((i) => i.sceneItemId === id);
      step(what, true, `${what === "gameplay" ? "Gameplay" : "HUD"} “${name}”`, `Shared with the live scene (one source: it stays active whatever the program shows)${from.enabled ? "" : "; it is hidden in the live scene, shown here"}.`);
      return !!item;
    };
    await share(gameSource, "gameplay");
    const gameKind = liveItems.find((i) => i.sourceName === gameSource)?.inputKind ?? null;
    if (gameKind === "game_capture") {
      const s = await obs.inputSettings(gameSource).catch(() => null);
      if (s?.settings.capture_audio === true && gameAudioSource) step("game-capture-audio", false, "Game Capture's own sound", `“${gameSource}” captures audio itself (Capture Audio) and “${gameAudioSource}” is the game sound too: the recording would have the game twice. Turn Capture Audio off in “${gameSource}”, or choose no separate game audio.`);
    }
    if (hudSource) await share(hudSource, "hud");
    else step("hud", null, "HUD", "None chosen: the recording has no HUD.");

    // The speaker strip: a 1920×1080 browser source with the strip page (recording only).
    const stripUrl = this.d.strip.url();
    const stripKind = kindOf(STRIP_SOURCE);
    if (!stripKind) {
      try {
        await obs.ensureInput({ sceneName: scene, inputName: STRIP_SOURCE, inputKind: "browser_source", settings: { url: stripUrl, width: 1920, height: 1080, shutdown: false, restart_when_active: false, reroute_audio: false, fps_custom: false } });
        step("strip", true, `Speaker strip “${STRIP_SOURCE}”`, "Made: a 1920×1080 browser source with the strip page, on top.");
      } catch (err) {
        step("strip", false, `Speaker strip “${STRIP_SOURCE}”`, err instanceof Error ? err.message : String(err));
      }
    } else {
      if (stripKind === "browser_source") await obs.setInputSettings(STRIP_SOURCE, { url: stripUrl, width: 1920, height: 1080, shutdown: false });
      if (!(await have()).some((i) => i.sourceName === STRIP_SOURCE)) await obs.createSceneItem(scene, STRIP_SOURCE, true);
      step("strip", true, `Speaker strip “${STRIP_SOURCE}”`, stripKind === "browser_source" ? "Pointed at the strip page." : `Already in OBS as a ${stripKind} source (not a browser source): used as it is.`);
    }

    // The recording comms: DistroAV's NDI source, audio only, kept receiving.
    const ndiName = `${this.d.ndiHost ? this.d.ndiHost() : hostname().toUpperCase()} (${RECORDING_NDI_NAME})`;
    const commsKind = kindOf(RECORDING_NDI_NAME);
    let commsOk = false;
    if (!commsKind) {
      if (obs.state.inputKinds.length && !obs.state.inputKinds.includes(NDI_KIND)) {
        step("comms", false, `Recording comms “${RECORDING_NDI_NAME}”`, "OBS has no NDI source: install DistroAV 6.x and the NDI 6 Runtime it asks for, restart OBS, then press again.");
      } else {
        await obs.createInput(scene, RECORDING_NDI_NAME, NDI_KIND, { ndi_source_name: ndiName, ndi_bw_mode: 2, ndi_behavior: 0, ndi_audio: true });
        await obs.refresh();
        commsOk = true;
        step("comms", true, `Recording comms “${RECORDING_NDI_NAME}”`, `Made: DistroAV NDI source “${ndiName}”, audio only, kept receiving.`);
      }
    } else {
      if (!(await have()).some((i) => i.sourceName === RECORDING_NDI_NAME)) await obs.createSceneItem(scene, RECORDING_NDI_NAME, true);
      commsOk = true;
      if (commsKind === NDI_KIND) {
        const s = await obs.inputSettings(RECORDING_NDI_NAME).catch(() => null);
        const src = String(s?.settings.ndi_source_name ?? "");
        step("comms", src.includes(`(${RECORDING_NDI_NAME})`), `Recording comms “${RECORDING_NDI_NAME}”`, src.includes(`(${RECORDING_NDI_NAME})`) ? `Receives “${src}”.` : `Receives “${src || "nothing"}”: choose “<this computer> (${RECORDING_NDI_NAME})” in its properties.`);
      } else step("comms", true, `Recording comms “${RECORDING_NDI_NAME}”`, `Already in OBS as a ${commsKind} source (not DistroAV's NDI source): used as it is.`);
    }
    const audioOnly = { "1": true, "2": false, "3": false, "4": false, "5": false, "6": false };
    if (commsOk) await obs.setInputAudio(RECORDING_NDI_NAME, { tracks: audioOnly, monitorType: "OBS_MONITORING_TYPE_NONE", muted: false, volumeMul: 1 }).catch((err) => step("comms-audio", false, "Recording comms' audio", String(err)));

    // The recording's own game audio: a copy of the live scene's game audio input (its fader is the game level).
    if (gameAudioSource) {
      const src = await obs.inputSettings(gameAudioSource).catch(() => null);
      if (!src) step("game-audio", false, `Game audio “${gameAudioSource}”`, "Not in OBS.");
      else {
        const copyKind = kindOf(GAME_AUDIO_COPY);
        if (copyKind && copyKind !== src.kind) step("game-audio", false, `Game audio “${GAME_AUDIO_COPY}”`, `OBS has a ${copyKind} source by that name: rename or remove it and press again.`);
        else {
          if (!copyKind) await obs.createInput(scene, GAME_AUDIO_COPY, src.kind, src.settings);
          else {
            await obs.setInputSettings(GAME_AUDIO_COPY, src.settings);
            if (!(await have()).some((i) => i.sourceName === GAME_AUDIO_COPY)) await obs.createSceneItem(scene, GAME_AUDIO_COPY, true);
          }
          await obs.refresh();
          const db = cfg.gameLevelDb;
          await obs.setInputAudio(GAME_AUDIO_COPY, { tracks: audioOnly, monitorType: "OBS_MONITORING_TYPE_NONE", muted: false, volumeMul: db <= -60 ? 0 : 10 ** (db / 20) });
          step("game-audio", true, `Game audio “${GAME_AUDIO_COPY}”`, `A copy of “${gameAudioSource}” (${src.kind}) for the recording only: its fader is the recording's game level.`);
        }
      }
    } else step("game-audio", null, "Game audio", `None chosen: the game's sound comes from “${gameSource}” itself, whose fader is the live scene's too (no separate game level).`);

    // Order, bottom to top: audio, gameplay, HUD, strip.
    const order = [GAME_AUDIO_COPY, RECORDING_NDI_NAME, gameSource, ...(hudSource ? [hudSource] : []), STRIP_SOURCE];
    const items = await have();
    const ranked = [...items].sort((a, b) => {
      const ra = order.indexOf(a.sourceName);
      const rb = order.indexOf(b.sourceName);
      return (ra < 0 ? -1 : ra) - (rb < 0 ? -1 : rb) || a.index - b.index;
    });
    for (const [k, it] of ranked.entries()) if (it.index !== k) await obs.setSceneItem(scene, it.sceneItemId, { index: k });
    // Nothing else of the program's sound: casters and the public comms never belong here.
    const strays = (await have()).filter((i) => !order.includes(i.sourceName) && i.inputKind && AUDIO_KINDS.has(i.inputKind) && i.inputKind !== "ffmpeg_source");
    step("no-casters", strays.length === 0, "Only game and recording comms", strays.length ? `Also in the scene: ${strays.map((s) => s.sourceName).join(", ")}. Remove them: anything with sound in this scene is in the recording (casters excluded by default).` : "Nothing else with sound in the scene.");

    // Source Record on the scene, stopped.
    if (sr) {
      const f = await obs.filter(scene, RECORDER_FILTER);
      if (f && f.kind !== SOURCE_RECORD_KIND) step("filter", false, `Filter “${RECORDER_FILTER}”`, `The scene has a ${f.kind} filter by that name: rename or remove it.`);
      else {
        if (!f) await obs.createFilter(scene, { name: RECORDER_FILTER, kind: SOURCE_RECORD_KIND, enabled: true, settings: this.filterSettings(0) });
        else if (this.state !== "recording") await obs.setFilterSettings(scene, RECORDER_FILTER, this.filterSettings(0));
        step("filter", true, `Source Record “${RECORDER_FILTER}”`, `${f ? "There" : "Added"} on “${scene}”, stopped: its own encoder and file in ${this.folder()} (${cfg.format}); the scene's own sound.`);
      }
    } else step("filter", false, `Source Record “${RECORDER_FILTER}”`, "Not added: Source Record isn't installed in OBS.");

    this.d.settings.set(SETTINGS_KEY, { ...cfg, obs: { ...cfg.obs, gameSource, hudSource: hudSource ?? null, gameAudioSource: gameAudioSource ?? null } });
    const ok = steps.every((s) => s.ok !== false);
    this.lastSetup = { at: new Date().toISOString(), ok, steps };
    this.d.logger.info("comms recording: OBS scene set up", { scene, ok, failed: steps.filter((s) => s.ok === false).map((s) => s.id) });
    return { scene, ok, steps };
  }

  /** Source Record's settings: the folder, the file name, the format, the encoder; its audio the scene's own; recording or not. */
  private filterSettings(recordMode: 0 | 1, run?: Run): Record<string, unknown> {
    const cfg = this.settings();
    const s: Record<string, unknown> = {
      record_mode: recordMode,
      path: run?.folder ?? this.folder(),
      filename_formatting: `${run?.prefix ?? FILE_PREFIX} %CCYY-%MM-%DD %hh-%mm-%ss`,
      rec_format: cfg.format,
      different_audio: false,
      audio_track: 0,
      audio_encoder: "ffmpeg_aac",
      audio_bitrate: cfg.audioBitrateKbps,
      bitrate: cfg.bitrateKbps,
      rate_control: "CBR",
      keyint_sec: 2,
      split_file: cfg.splitMinutes > 0,
      max_time_sec: Math.max(60, cfg.splitMinutes * 60),
      max_size_mb: 0,
    };
    if (cfg.encoder) s.encoder = cfg.encoder;
    return s;
  }

  // ---------------------------------------------------------------------------------------- start / stop

  private teamLabel(teamId: string | null): string {
    const t = teamId ? this.d.teamName(teamId) : null;
    return t ? t.name : "no team";
  }

  /** Start Recording: Source Record writes the scene from now (its own file), TeamSpeak shows recording. Never touches the public listen-in. */
  async start(who = "operator"): Promise<ReturnType<CommsRecording["status"]>> {
    if (this.state === "recording") return this.status();
    const obs = this.d.obs;
    const cfg = this.settings();
    if (!obs.state.connected) throw new RecordingError(409, "obs_not_connected", "Connect OBS first (Settings → Devices).");
    const sr = await this.sourceRecordAvailable(true);
    if (!sr) throw new RecordingError(409, "no_source_record", `Source Record isn't installed in OBS. ${SOURCE_RECORD_INSTALL.join(" ")}`);
    if (!obs.state.scenes.includes(cfg.obs.scene)) throw new RecordingError(409, "no_scene", `OBS has no scene “${cfg.obs.scene}”: Set up the recording scene in OBS first.`);
    const f = await obs.filter(cfg.obs.scene, RECORDER_FILTER);
    if (!f || f.kind !== SOURCE_RECORD_KIND) throw new RecordingError(409, "no_filter", `“${cfg.obs.scene}” has no Source Record filter “${RECORDER_FILTER}”: Set up the recording scene in OBS first.`);
    if (!cfg.teamId) throw new RecordingError(409, "no_team", "Choose the recording team first.");
    if (!this.d.comms.hasTeam(cfg.teamId)) throw new RecordingError(409, "no_team", "The recording team isn't one of the active match's teams.");
    const folder = this.folder();
    try {
      checkFolder(folder);
    } catch (err) {
      throw new RecordingError(409, "bad_folder", err instanceof Error ? err.message : String(err));
    }
    const free = (this.d.freeBytes ?? freeBytes)(folder);
    if (free !== null && free < CRITICAL_FREE_BYTES) throw new RecordingError(409, "disk_full", `Only ${(free / GB).toFixed(1)} GB free on ${folder}: free some space or choose another folder.`);
    this.applyTeam();
    const team = this.d.teamName(cfg.teamId);
    const tag = (team?.shortName || team?.name || "").replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 24);
    const now = this.wall();
    const run: Run = { startedAt: new Date(now).toISOString(), startedAtMs: now, folder, prefix: tag ? `${FILE_PREFIX} ${tag}` : FILE_PREFIX, ext: cfg.format.includes("mp4") ? "mp4" : cfg.format, teamId: cfg.teamId };
    // Its settings first (a stopped filter takes them), then record.
    await obs.setFilterSettings(cfg.obs.scene, RECORDER_FILTER, this.filterSettings(0, run));
    if (!f.enabled) await obs.setFilterEnabled(cfg.obs.scene, RECORDER_FILTER, true);
    await obs.setFilterSettings(cfg.obs.scene, RECORDER_FILTER, { record_mode: 1 });
    this.run = run;
    this.d.settings.set(RUN_KEY, run);
    this.state = "recording";
    this.fault = null;
    this.file = null;
    this.filterMode = 1;
    this.d.comms.setRecordingSignal(true);
    this.track1.checkedAtMs = -Infinity;
    this.d.logger.info("comms recording: started", { team: this.teamLabel(cfg.teamId), folder, by: who });
    void this.applyGameLevel().catch(() => undefined);
    await this.tick();
    return this.status();
  }

  /** Stop Recording: Source Record closes its file; TeamSpeak's indicator off. */
  async stop(who = "operator"): Promise<ReturnType<CommsRecording["status"]>> {
    const obs = this.d.obs;
    const scene = this.settings().obs.scene;
    if (this.state === "idle" && !this.run) return this.status();
    if (!obs.state.connected) throw new RecordingError(409, "obs_not_connected", `OBS isn't connected: Matchframe can't stop Source Record. Stop it in OBS (scene “${scene}” → Filters → ${RECORDER_FILTER} → Record mode: None), or reconnect OBS and press Stop again.`);
    const f = await obs.filter(scene, RECORDER_FILTER).catch(() => null);
    if (f) await obs.setFilterSettings(scene, RECORDER_FILTER, { record_mode: 0 });
    this.finish("stopped by the operator");
    this.d.logger.info("comms recording: stopped", { by: who, file: this.last?.path ?? null });
    return this.status();
  }

  private finish(reason: string): void {
    this.refreshFile();
    const run = this.run;
    this.last = { path: this.file?.path ?? null, bytes: this.file?.bytes ?? 0, durationMs: run ? this.wall() - run.startedAtMs : 0, endedAt: new Date(this.wall()).toISOString(), reason };
    this.run = null;
    this.d.settings.set(RUN_KEY, null);
    this.state = "idle";
    this.fault = null;
    this.filterMode = 0;
    this.file = null;
    this.d.comms.setRecordingSignal(false);
  }

  private setFault(reason: string): void {
    if (this.fault?.reason === reason) return;
    this.fault = { reason, at: new Date(this.wall()).toISOString() };
    this.d.logger.warn("comms recording: fault", { reason });
  }

  // ---------------------------------------------------------------------------------------- monitoring

  /** The status checks every second. */
  startMonitor(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref?.();
  }

  /** The newest file of this recording in its folder (Source Record names it; split files share the prefix). */
  private refreshFile(): void {
    const run = this.run;
    if (!run) return;
    let best: { path: string; bytes: number; mtime: number } | null = null;
    const files: string[] = [];
    try {
      for (const name of readdirSync(run.folder)) {
        if (!name.startsWith(`${run.prefix} `) || extname(name).slice(1).toLowerCase() !== run.ext) continue;
        const path = join(run.folder, name);
        const st = statSync(path);
        if (st.mtimeMs < run.startedAtMs - 5000) continue;
        files.push(path);
        if (!best || st.mtimeMs > best.mtime || (st.mtimeMs === best.mtime && path > best.path)) best = { path, bytes: st.size, mtime: st.mtimeMs };
      }
    } catch {
      // The folder went away: the status says no file.
    }
    if (!best) return;
    const now = this.wall();
    const grew = !this.file || this.file.path !== best.path || best.bytes > this.file.bytes;
    this.file = { path: best.path, bytes: best.bytes, grewAtMs: grew ? now : this.file!.grewAtMs, files: files.sort() };
  }

  /** Every second: the team, OBS's filter still recording, the file growing, the free space, track 1. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    // Nothing to watch while Team Comms is off and nothing records (no OBS requests every second for nothing).
    if (!this.d.comms.enabled && this.state === "idle" && !this.run) return;
    this.ticking = true;
    try {
      this.applyTeam();
      const obs = this.d.obs;
      const scene = this.settings().obs.scene;
      if (obs.state.connected) {
        await this.sourceRecordAvailable();
        const f = obs.state.scenes.includes(scene) ? await obs.filter(scene, RECORDER_FILTER).catch(() => null) : null;
        this.filterMode = f && f.kind === SOURCE_RECORD_KIND ? Number(f.settings.record_mode ?? 0) : null;
        if (!this.adopted) {
          this.adopted = true;
          if (this.state !== "recording" && this.filterMode === 1) this.adopt(String(f?.settings.path ?? this.folder()));
          // Saved as recording when the engine stopped, but OBS stopped it since: that recording is over.
          else if (this.state === "idle" && this.run) this.finish("OBS wasn't recording it any more");
        }
        await this.checkTrack1();
      }
      if (this.state === "recording") {
        this.refreshFile();
        const now = this.wall();
        const since = this.run ? now - this.run.startedAtMs : 0;
        let fault: string | null = null;
        if (obs.state.connected && this.filterMode !== 1) fault = this.filterMode === null ? `The Source Record filter “${RECORDER_FILTER}” is gone from “${scene}”: the recording stopped.` : "Source Record was stopped in OBS.";
        else if (!this.file && since > STALL_MS) fault = `No file from Source Record in ${this.run?.folder} after ${secs(since)} s: check OBS's log (Help → Log Files) for “Source Record”.`;
        else if (this.file && now - this.file.grewAtMs > STALL_MS) fault = `The file hasn't grown for ${secs(now - this.file.grewAtMs)} s: Source Record may have stopped writing (disk full, encoder error); check OBS's log.`;
        if (fault) this.setFault(fault);
        else this.fault = null;
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Still recording in OBS from before a restart: carried on with (never started by Matchframe on its own). */
  private adopt(folder: string): void {
    const cfg = this.settings();
    const team = cfg.teamId ? this.d.teamName(cfg.teamId) : null;
    const tag = (team?.shortName || team?.name || "").replace(/[^A-Za-z0-9 _-]+/g, "").trim().slice(0, 24);
    this.run ??= { startedAt: new Date(this.wall()).toISOString(), startedAtMs: this.wall(), folder, prefix: tag ? `${FILE_PREFIX} ${tag}` : FILE_PREFIX, ext: cfg.format.includes("mp4") ? "mp4" : cfg.format, teamId: cfg.teamId };
    this.state = "recording";
    this.d.comms.setRecordingSignal(true);
    this.d.logger.info("comms recording: still recording in OBS, carried on", { scene: cfg.obs.scene });
  }

  // ---------------------------------------------------------------------------------------- status

  status() {
    const cfg = this.settings();
    const now = this.wall();
    const folder = this.run?.folder ?? this.folder();
    const free = (this.d.freeBytes ?? freeBytes)(folder);
    const obs = this.d.obs;
    const recording = this.state === "recording";
    const state: RecordingState = recording && this.fault ? "fault" : this.state;
    const team = cfg.teamId ? this.d.teamName(cfg.teamId) : null;
    const teamName = team?.name ?? null;
    const warnings: string[] = [];
    const errors: string[] = [];
    if (this.fault && recording) errors.push(this.fault.reason);
    if (free !== null && free < CRITICAL_FREE_BYTES) errors.push(`Only ${(free / GB).toFixed(1)} GB free on the recording's drive: the file stops when it is full.`);
    else if (free !== null && free < cfg.warnFreeGB * GB) warnings.push(`${(free / GB).toFixed(1)} GB free on the recording's drive (warning under ${cfg.warnFreeGB} GB): at ${(cfg.bitrateKbps / 8 / 1000).toFixed(1)} MB/s that is about ${Math.floor(free / ((cfg.bitrateKbps * 1000) / 8) / 60)} minutes.`);
    if (!obs.state.connected) (recording ? errors : warnings).push(recording ? "OBS isn't connected: Matchframe can't confirm the recording (Source Record carries on in OBS by itself)." : "OBS isn't connected.");
    if (this.track1.inUse === false) (recording ? errors : warnings).push(this.track1.detail);
    if (cfg.teamId && !this.d.comms.hasTeam(cfg.teamId)) warnings.push("The recording team isn't one of the active match's teams: the recording has no comms.");
    if (!cfg.teamId) warnings.push("No recording team chosen.");
    const ndi = this.d.outputs.status().ndi;
    if (recording && this.d.comms.enabled && ndi.enabled && ndi.state === "running" && ndi.stats && ndi.stats.connections.recording === 0) warnings.push(`Nothing receives “${RECORDING_NDI_NAME}”: the recording has no comms. Check its DistroAV source in “${cfg.obs.scene}”.`);
    if (recording && (!this.d.comms.enabled || !ndi.enabled || ndi.state !== "running")) warnings.push(`The recording comms (NDI “${RECORDING_NDI_NAME}”) aren't being sent: ${!this.d.comms.enabled ? "Team Comms is off" : ndi.detail}`);
    if (!this.commsAudible) warnings.push("The comms level is off: the recording has no comms and the strip lights nobody.");
    const sw = this.d.strip.status().warning;
    if (sw) warnings.push(sw);
    const label = state === "recording" ? `RECORDING — ${(teamName ?? "NO TEAM").toUpperCase()}` : state === "fault" ? "RECORDING FAULT" : "NOT RECORDING";
    const detail =
      state === "fault"
        ? this.fault!.reason
        : state === "recording"
          ? `${teamName ?? "No team"}'s permitted, delayed comms with the gameplay, written by Source Record.`
          : this.last
            ? `Last file: ${this.last.path ?? "none found"} (${secs(this.last.durationMs)} s, ${this.last.reason}).`
            : "Not recording. Start Recording is independent of the public listen-in.";
    return {
      state,
      label,
      detail,
      team: cfg.teamId ? { id: cfg.teamId, name: teamName, inMatch: this.d.comms.hasTeam(cfg.teamId) } : null,
      heardTeamId: this.d.comms.recordingTeam,
      startedAt: recording ? (this.run?.startedAt ?? null) : null,
      elapsedMs: recording && this.run ? now - this.run.startedAtMs : null,
      file: recording && this.file ? { path: this.file.path, bytes: this.file.bytes, growing: now - this.file.grewAtMs <= STALL_MS, files: this.file.files } : null,
      last: this.last,
      folder,
      freeBytes: free,
      warnings,
      errors,
      settings: cfg,
      teamspeakSignal: this.d.comms.recordingSignalOn,
      obs: {
        connected: obs.state.connected,
        scene: cfg.obs.scene,
        sceneExists: obs.state.scenes.includes(cfg.obs.scene),
        sourceRecord: { available: this.sourceRecord.available, install: SOURCE_RECORD_INSTALL, kind: SOURCE_RECORD_KIND },
        filter: { name: RECORDER_FILTER, recordMode: this.filterMode },
        track1: { inUse: this.track1.inUse, detail: this.track1.detail },
        lastSetup: this.lastSetup,
      },
      actions: {
        start: { disabledReason: recording ? "Recording" : !obs.state.connected ? "Connect OBS first" : this.sourceRecord.available === false ? "Source Record isn't installed in OBS" : !obs.state.scenes.includes(cfg.obs.scene) ? "Set up the recording scene in OBS first" : !cfg.teamId ? "Choose the recording team first" : null },
        stop: { disabledReason: recording ? null : "Not recording" },
      },
    };
  }

  /** For the support file: no change (folders and file names are the operator's own). */
  diagnostics() {
    return this.status();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const off of this.offs.splice(0)) off();
  }
}
