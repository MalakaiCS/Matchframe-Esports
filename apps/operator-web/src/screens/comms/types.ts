/**
 * GET /api/v1/comms (services/local-engine/src/comms/service.ts status(), plus `onAir` from
 * comms/public.ts): Team Comms as the console shows it (ADR-065, ADR-066).
 */

export type PublicState = "off" | "buffering" | "listening" | "fault";
export type SlotId = "A" | "B";

export interface CommsTeamRef {
  id: string;
  name: string | null;
  shortName: string | null;
  logoUrl: string | null;
  color: string | null;
}

export interface ListenInAction {
  teamId: string;
  slot: SlotId;
  label: string;
  ready: boolean;
  readyInMs: number | null;
  disabledReason: string | null;
}

export interface ListenInView {
  state: PublicState;
  label: string;
  detail: string;
  team: { id: string; slot: SlotId; name: string; shortName: string | null; logoUrl: string | null; color: string | null } | null;
  heardTeamId: string | null;
  muted: boolean;
  fault: { reason: string; at: string } | null;
  since: string;
  actions: ListenInAction[];
  end: { disabledReason: string | null };
  muteAll: { disabledReason: string | null };
}

export interface Activity {
  db: number;
  speaking: boolean;
}

export interface CommsParticipant {
  key: string;
  slot: SlotId;
  teamId: string | null;
  uid: string;
  nickname: string;
  clientId: number | null;
  present: boolean;
  saved: boolean;
  displayName: string;
  playerId: string | null;
  pictureUrl: string | null;
  includeBroadcast: boolean;
  includeRecording: boolean;
  levelDb: number;
  preview: boolean;
  /** As it arrives from TeamSpeak (live: never on air). */
  incoming: { db: number; talking: boolean };
  /** At the outputs' time (after the delay): `signal` before inclusion; recording and preview as mixed there. */
  delayed: { recording: Activity | null; preview: Activity | null; signal?: Activity | null };
  buffer: { heldMs: number; bytes: number; chunks: number; lateMs: number; reanchors: number };
}

export interface CommsSlotConfig {
  teamId: string | null;
  serverHost: string;
  serverPort: number;
  serverUid: string;
  channel: string;
  nickname: string;
  identity: string;
}

export interface CommsTab {
  key: string;
  status: string;
  error: string | null;
  server: { uid: string; name: string; host: string; port: number } | null;
  channel: { id: number; name: string } | null;
  listener: { clientId: number; nickname: string; inputMuted: boolean; inputDeactivated: boolean; outputMuted: boolean; recording: boolean } | null;
  capturing: boolean;
  clients: number;
}

export interface CommsSlot {
  id: SlotId;
  team: CommsTeamRef | null;
  roster: { id: string; displayName: string; pictureUrl: string | null }[];
  config: CommsSlotConfig;
  serverPasswordSaved: boolean;
  channelPasswordSaved: boolean;
  state: "off" | "waiting" | "connecting" | "ready" | "buffering";
  ready: boolean;
  readyInMs: number | null;
  issue: string | null;
  lost: { atMs: number; reason: string } | null;
  tab: CommsTab | null;
}

export interface NdiStats {
  frames: number;
  underruns: number;
  late: number;
  resyncs: number;
  publicSilent: number;
  queue: number;
  lagMs: number;
  lagMinMs: number;
  lagMaxMs: number;
  sendMaxMs: number;
  connections: { public: number; recording: number };
}

export interface CommsPublicSettings {
  ndi: { enabled: boolean; latencyMs: number; clockAudio: boolean };
  duck: { enabled: boolean; inputs: string[]; amountDb: number; rampMs: number };
  overlay: { anchor: "top" | "bottom"; offsetPx: number };
}

export interface CommsOnAir {
  listenIn: ListenInView;
  settings: CommsPublicSettings;
  outputs: {
    ndi: { enabled: boolean; state: "off" | "starting" | "running" | "error"; detail: string; version: string | null; names: { public: string; recording: string }; stats: NdiStats | null };
    publicGuard: { blocksSilenced: number };
    preview: { listeners: number; messages: number; dropped: number; connects: number };
  };
  ducking: { state: "off" | "idle" | "lowered" | "pending"; detail: string; lowered: string[]; lastRelease: { at: string; ok: boolean; detail: string } | null };
  overlay: { url: string; source: string; liveScene: string | null; obsConnected: boolean; pages: number; onAir: boolean; placement: { anchor: "top" | "bottom"; offsetPx: number } };
}

/** The dedicated recording (services/local-engine/src/comms/recording.ts status(), ADR-068). */
export interface RecordingSettings {
  teamId: string | null;
  folder: string | null;
  format: "mkv" | "hybrid_mp4" | "fragmented_mp4" | "mp4" | "mov";
  encoder: string;
  bitrateKbps: number;
  audioBitrateKbps: number;
  splitMinutes: number;
  gameLevelDb: number;
  commsLevelDb: number;
  warnFreeGB: number;
  obs: { scene: string; gameSource: string | null; hudSource: string | null; gameAudioSource: string | null };
}

export interface SetupStep {
  id: string;
  ok: boolean | null;
  title: string;
  detail: string;
}

export interface RecorderStatus {
  state: "idle" | "recording" | "fault";
  label: string;
  detail: string;
  team: { id: string; name: string | null; inMatch: boolean } | null;
  heardTeamId: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  file: { path: string; bytes: number; growing: boolean; files: string[] } | null;
  last: { path: string | null; bytes: number; durationMs: number; endedAt: string; reason: string } | null;
  folder: string;
  freeBytes: number | null;
  warnings: string[];
  errors: string[];
  settings: RecordingSettings;
  teamspeakSignal: boolean;
  obs: {
    connected: boolean;
    scene: string;
    sceneExists: boolean;
    sourceRecord: { available: boolean | null; install: string[]; kind: string };
    filter: { name: string; recordMode: number | null };
    track1: { inUse: boolean | null; detail: string };
    lastSetup: { at: string; ok: boolean; steps: SetupStep[] } | null;
  };
  actions: { start: { disabledReason: string | null }; stop: { disabledReason: string | null } };
}

export type StripAnchor = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export interface PortraitCrop {
  x: number;
  y: number;
  zoom: number;
}

export interface StripSettings {
  anchor: StripAnchor;
  offsetX: number;
  offsetY: number;
  cardPx: number;
  gapPx: number;
  borderPx: number;
  activeColor: string;
  idleColor: string;
  insetColor: string;
  attackMs: number;
  releaseMs: number;
  labels: boolean;
  useHudDefaults: boolean;
  placeholderAssetId: string | null;
  crops: Record<string, PortraitCrop>;
  timingOffsetMs: number;
}

export interface StripStatus {
  url: string;
  source: string;
  pages: number;
  team: string | null;
  cards: { id: string; name: string; picture: "own" | "hud-default" | "placeholder" | "silhouette"; pictureUrl: string; crop: PortraitCrop; cropKey: string }[];
  /** Names of the people lit now. */
  speaking: string[];
  overLimit: number;
  warning: string | null;
  settings: StripSettings;
}

export interface CalibrationStatus {
  settings: { reactionMs: number; onsetDb: number };
  armed: { teamId: string; forMs: number } | null;
  live: { who: string; teamId: string; agoMs: number } | null;
  marks: { who: string; offsetMs: number; agoMs: number }[];
  suggestion: { n: number; medianOffsetMs: number; spreadMs: number; delayMs: number; delaySec: number; fineMs: number } | null;
  sendLatencyMs: number;
}

export interface LiveSources {
  liveScene: string | null;
  sources: { name: string; kind: string | null }[];
  suggested: { gameSource: string | null; hudSource: string | null; gameAudioSource: string | null };
  sourceRecord: boolean | null;
  error: string | null;
}

export interface CommsView {
  enabled: boolean;
  settings: { enabled: boolean; bridgePort: number; delaySec: number; fineMs: number };
  delay: { configuredMs: number; effectiveMs: number; pendingMs: number | null; floorMs: number };
  bridge: {
    state: string;
    port: number | null;
    error: string | null;
    sessions: number;
    file: string;
    plugins: { session: string; instance: string; plugin: { name: string; version: string; apiVersion: number } | null; ts3: { clientLibVersion: string } | null; platform: string | null; connectedForMs: number }[];
  };
  slots: CommsSlot[];
  participants: CommsParticipant[];
  recording: { team: string | null; signal: boolean };
  onAir: CommsOnAir;
  recorder: RecorderStatus;
  strip: StripStatus;
  calibration: CalibrationStatus;
}

export interface ObsCheck {
  connected: boolean;
  checks: { id: string; ok: boolean | null; title: string; detail: string }[];
}

export interface ObsAudioInput {
  name: string;
  kind: string;
  db: number;
  muted: boolean;
  picked: boolean;
}
