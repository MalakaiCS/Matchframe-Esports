/**
 * Response shapes of the local engine API (services/local-engine/src/routes/*.ts and servers.ts).
 * Shared contract types are imported (type-only) from @matchframe/contracts / @matchframe/hud-sdk;
 * engine-internal shapes that are not part of the contracts package are mirrored here.
 */
import type {
  CameraRecord,
  Capability,
  CommandContext,
  CommandResult,
  DemoJobState,
  DirectorDecision,
  ObserverMode,
  DirectorMode,
  EvidenceType,
  EventRecord,
  HudManifest,
  HudVariant,
  MapInstance,
  Match,
  MatchState,
  ObservedGrenadeType,
  OverlayOutput,
  OwnershipState,
  Player,
  ReasonCode,
  RetentionPolicy,
  RosterMembership,
  RundownCue,
  ScoreComponents,
  Side,
  SourceCapabilities,
  Sponsor,
  StatCorrection,
  Support,
  Team,
  Vec3,
  VetoDecision,
  VetoStep,
} from "@matchframe/contracts";

export type {
  CameraRecord,
  Capability,
  DirectorDecision,
  DirectorMode,
  EvidenceType,
  EventRecord,
  MapInstance,
  Match,
  MatchState,
  ReasonCode,
  RundownCue,
  Side,
  SourceCapabilities,
  Sponsor,
  Support,
  VetoDecision,
  VetoStep,
};

export type ActionClass = "pov_cut" | "cinematic" | "replay_suggestion" | "mixer_cue";
export type ProgramMode = "LIVE" | "REPLAY_PREPARED" | "REPLAY_PLAYING" | "STUDIO" | "BREAK" | "MANUAL" | "DEGRADED";

export type Pin =
  | { kind: "player"; steamId: string }
  | { kind: "side"; side: Side }
  | { kind: "team"; teamId: string }
  | { kind: "cluster"; steamIds: string[] };

/** Director controls as serialized by the engine (assistedActions is an array on the wire). */
export interface DirectorControls {
  hold: { until: number | null } | null;
  pin: Pin | null;
  oneSide: Side | null;
  cinematicsDisabled: { round: string | null; map: string | null; match: boolean };
  autoReplaysDisabled: boolean;
  assistedActions: ActionClass[];
  followActionRequested: boolean;
  cinematicRequested: boolean;
}

export interface UtilityOpportunity {
  id: string;
  utilityIds: string[];
  kind: "single" | "volley" | "flash_entry" | "smoke_execute" | "fire_displacement";
  types: ObservedGrenadeType[];
  primaryType: ObservedGrenadeType;
  actionPoint: Vec3;
  levelId: string | null;
  regionIds: string[];
  timeToEffectMs: number;
  evidence: "confirmed" | "predicted";
  uncertaintyUnits: number;
  throwerSide: Side | null;
  affected: { steamId: string; side: Side | null; distance: number }[];
  value: number;
  confidence: number;
  scenarioId: string | null;
  reasons: ReasonCode[];
  camera: { camera: CameraRecord; plannedDurationMs: number } | null;
  cameraIssue: string | null;
  typeSupport: Support;
}

export interface CandidateSummary {
  shotKey: string;
  shotClass: string;
  utility: number;
  valid: boolean;
  invalidReason: string | null;
  reasonCodes: ReasonCode[];
  components: ScoreComponents;
  targetSteamId: string | null;
  cameraId: string | null;
}

export type ControlRequest =
  | { kind: "select_player"; steamId: string; observerSlot: number | null; view?: "in_eye" | "chase" }
  | { kind: "activate_static_camera"; camera: CameraRecord; plannedDurationMs: number }
  | { kind: "play_camera_path"; path: { id: string; displayName: string } }
  | { kind: "cancel_path" };

export interface InFlightCommand {
  context: CommandContext;
  request: ControlRequest;
  expectedShot: string | null;
  status: CommandResult["status"];
  retries: number;
  result: CommandResult | null;
  observedPrecisionAvailable: boolean;
}

export interface ObsSummary {
  connected: boolean;
  programScene: string | null;
  previewScene: string | null;
  studioMode: boolean | null;
  replayBuffer: boolean | null;
  recording: boolean | null;
  streaming: boolean | null;
  lastError: string | null;
}

export type EngineMetrics = Record<string, number | null>;

/** Payload of the `state.snapshot` operator topic (operatorSnapshot() in servers.ts). */
export interface OperatorSnapshot {
  state: MatchState | null;
  director: DirectorDecision | null;
  opportunities: UtilityOpportunity[];
  candidates: CandidateSummary[];
  mode: DirectorMode;
  /** The operator's Observer mode (Off, Observer, Observer & Cinematics, Full Action Observer). */
  observerMode: ObserverMode;
  controls: DirectorControls;
  ownership: OwnershipState;
  resumeInMs: number | null;
  pending: InFlightCommand | null;
  currentShot: string | null;
  capabilities: SourceCapabilities;
  program: { mode: ProgramMode; owner: { kind: string; holder: string }; activeReplay: string | null };
  obs: ObsSummary;
  simulated: boolean;
  metrics: EngineMetrics;
  /** Compact control-surface tally (added with the devices API). */
  tally?: DeviceTally;
  /** Account link and auto-director hours (added with the cloud link). */
  cloud?: CloudSummary;
}

export type CloudGate = { ok: true; free?: boolean } | { ok: false; code: "not_linked" | "no_entitlement" | "entitlement_expired" | "plan_excludes" | "hours_exhausted"; reason: string };

export interface CloudSummary {
  linkState: "unlinked" | "linking" | "linked" | "revoked";
  plan: string | null;
  licence: string | null;
  remainingSeconds: number | null;
  gate: CloudGate;
  metering: boolean;
  enforcement: "required" | "off";
  /** Whether the licence includes Full Action Observer (always true in the simulation and enforcement-off builds). */
  fullActionObserver?: boolean;
}

/** GET /api/v1/cloud/status (CloudLink.status in the engine). */
export type SignInState = "not_required" | "signed_in" | "signed_out" | "revoked" | "unchecked" | "offline_expired" | "invalid";

export interface CloudUser {
  id: string;
  email: string;
  displayName: string;
}

export interface CloudLoginOrg {
  id: string;
  name: string;
  role: string;
  planName: string;
}

export type CloudLoginResult = ({ status: "signed_in"; user: CloudUser; orgName: string } | { status: "choose_org"; orgs: CloudLoginOrg[] }) & { cloud: CloudStatus };

export interface CloudStatus {
  url: string | null;
  urlFixed?: boolean;
  enforcement: "required" | "off";
  keysPinned: boolean;
  linkState: CloudSummary["linkState"];
  /** Whether the program must be signed in to be used (release builds), and as whom it is signed in. */
  signIn: { required: boolean; state: SignInState; user: CloudUser | null; method: "password" | "code" | null };
  linking: { userCode: string; verificationUri: string; verificationUriComplete: string; expiresAt: string } | null;
  device: { deviceId: string; orgId: string; orgName: string; linkedAt: string; user?: CloudUser | null; method?: "password" | "code" } | null;
  entitlement: {
    state: "valid" | "grace" | "expired" | "malformed" | "unknown_key" | "bad_signature" | "wrong_device";
    plan: { id: string; name: string };
    subscriptionStatus: string;
    features: { autoDirector: boolean; learnedDirectorShadow: boolean; maxDevices: number; maxMembers: number };
    autoDirector: { periodStart: string; periodEnd: string; includedSeconds: number; creditSeconds: number; usedSeconds: number; remainingSeconds: number; overageAllowed: boolean };
    issuedAt: string;
    expiresAt: string;
    graceUntil: string;
    localRemainingSeconds: number;
  } | null;
  gate: CloudGate;
  fullActionObserver: boolean;
  usage: { pendingRecords: number; pendingSeconds: number; rejected: number; totalSeconds: number; openSeconds: number; metering: boolean };
  lastRefreshAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface CloudUsageRecord {
  recordId: string;
  startedAt: string;
  endedAt: string;
  seconds: number;
  sessionId: string;
  matchRef: string | null;
  mapName: string | null;
  uploadedAt: string | null;
  rejectedReason: string | null;
}

export interface EventEnvelope<T> {
  schemaVersion: number;
  topic: string;
  sessionId: string;
  epoch: number;
  sequence: number;
  sourceId: string;
  matchTimeMs: number | null;
  timeUncertaintyMs: number | null;
  payload: T;
}

export type DerivedEventKind =
  | "round_phase"
  | "round_end"
  | "player_died"
  | "player_respawned"
  | "kills_increased"
  | "probable_kill_link"
  | "damage_taken"
  | "bomb_state"
  | "observer_changed"
  | "epoch_changed"
  | "game_phase";

export interface DerivedEvent {
  eventId: string;
  kind: DerivedEventKind | string;
  sessionId: string;
  epoch: number;
  roundAttemptId: string | null;
  sequence: number;
  receivedAtMonotonicMs: number;
  matchTimeMs: number | null;
  timeUncertaintyMs: number | null;
  evidence: EvidenceType;
  confidence: number;
  data: Record<string, unknown>;
}

export type UtilityTrackerEvent =
  | { kind: "thrown"; utilityId: string; type: ObservedGrenadeType; ownerSteamId: string | null; side: Side | null }
  | { kind: "type_resolved"; utilityId: string; from: ObservedGrenadeType; to: ObservedGrenadeType; evidence: string }
  | { kind: "activated"; utilityId: string; type: ObservedGrenadeType; evidence: EvidenceType; position: Vec3 }
  | { kind: "expired"; utilityId: string; type: ObservedGrenadeType; reason: string }
  | { kind: "lost"; utilityId: string; type: ObservedGrenadeType }
  | { kind: "linked"; projectileId: string; effectId: string }
  | { kind: "affected"; utilityId: string; steamId: string; effect: string; evidence: EvidenceType };

export interface ArbiterEvent {
  kind: "command" | "result" | "takeover" | "resume" | "emergency_stop" | "cleared" | "rejected" | "external_change" | "game_autoswitch";
  at: number;
  detail: Record<string, unknown>;
}

export interface EngineAlert {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export interface Me {
  role: string | null;
  label?: string;
  scope?: { matchId?: string; teamId?: string } | null;
}

export interface HealthStatus {
  ok: boolean;
  version: string;
  startedAt: string;
  simulated: boolean;
  telemetry: { sourceId: string; stale: boolean; packets: number; gameBuild: string | null } | null;
  director: { mode: DirectorMode; ownership: OwnershipState; adapter: string };
  obs: { connected: boolean; lastError: string | null };
  program: ProgramMode;
  schemaVersion: number;
  mapPacks: string[];
}

export interface Cs2Install {
  steamRoot: string;
  libraryPath: string;
  installDir: string;
  cfgDir: string;
  gameBuildFromManifest: string | null;
}

export interface DiscoveryResult {
  steamRoots: string[];
  libraries: string[];
  install: Cs2Install | null;
  problems: string[];
}

export interface VerifiedControlEntry {
  support: Support;
  build: string | null;
  at: string;
}

export interface SetupStatus {
  cs2Install: Cs2Install | null;
  realPayloadReceived: boolean;
  simulated: boolean;
  packets: number;
  gameBuild: string | null;
  telemetry: { allPlayerState: Support; playerPositions: Support; grenadeEntities: Support };
  control: { adapter: string; playerSelection: Support; staticCamera: Support };
  verifiedControl: Partial<Record<string, VerifiedControlEntry>>;
  obs: { connected: boolean; scenes: number; programScenes: SceneMap };
  hudUrl: string;
}

export interface GsiConfigPreview {
  uri: string;
  preview: string;
  components: string[];
}

export interface WriteGsiResult {
  path: string;
  written: boolean;
  backup: string | null;
  unchanged: boolean;
  uri: string;
  restartRequired: boolean;
  note: string;
}

export interface PlayerSelectionTestResult {
  requested: string;
  observedBefore: string | null;
  observedAfter: string | null;
  transport: string;
  confirmed: boolean;
  simulated: boolean;
  build: string | null;
  at: string;
  recorded: boolean;
  note: string | null;
}

export interface CapabilitiesResponse {
  capabilities: SourceCapabilities;
  telemetrySummary: Record<string, unknown> | null;
  simulated: boolean;
  requestedGsiComponents: string[];
  note: string;
}

export interface ObserverAdapterSettings {
  kind: "none" | "netcon" | "keyboard";
  host: string;
  port: number;
  templates: Record<string, string>;
  windowTitle: string;
}

export interface ObserverAdapterResponse {
  settings: ObserverAdapterSettings;
  active: string | null;
  capabilities?: Record<string, Capability>;
}

export interface SceneMap {
  LIVE: string | null;
  REPLAY: string | null;
  STUDIO: string | null;
  BREAK: string | null;
}

export interface SetupProfile {
  id: string;
  name: string;
  sourceMode: "live_observer" | "demo_playback" | "simulation";
  cs2InstallDir: string | null;
  observerAdapter: Record<string, unknown>;
  obsProfileId: string | null;
  programScenes: Record<string, string | null>;
  checklist: Record<string, boolean>;
  topology: "one_pc" | "multi_pc";
  createdAt: string;
}

export interface TokenInfo {
  id: string;
  role: string;
  label: string;
  scope: { matchId?: string; teamId?: string } | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: unknown;
}

export interface LogEntry {
  at?: string;
  ts?: string;
  time?: string;
  level: string;
  msg?: string;
  message?: string;
  [k: string]: unknown;
}

export type TeamRow = Team & { revision: number; archived: boolean };
export type PlayerRow = Player & { revision: number; teamId: string | null };
export type TeamDetail = Team & { revision: number; roster: (RosterMembership & { player: Player | null })[] };
export type PlayerDetail = Player & { revision: number; history: RosterMembership[] };
export type { Player, RosterMembership, Team };

export interface ImportRowInput {
  displayName: string;
  realName?: string;
  steamId?: string;
  team?: string;
  countryCode?: string;
}

export interface ImportPreviewRow {
  row: number;
  ok: boolean;
  errors: string[];
  data?: ImportRowInput;
  duplicateOf?: string | null;
  duplicateReason?: "steamId" | "name" | null;
}

export type MatchRow = Match & { maps: MapInstance[] };
export type MatchDetail = Match & { revision: number; maps: MapInstance[]; corrections: StatCorrection[] };
export type { StatCorrection };

export interface SeriesScore {
  a: number;
  b: number;
  winnerTeamId: string | null;
}

export interface MapResultResponse {
  map: MapInstance;
  series: SeriesScore;
  note: string | null;
}

export interface VetoStatusResponse {
  steps: VetoStep[];
  decisions: VetoDecision[];
  currentStep: VetoStep | null;
  remainingMaps: string[];
  pickedMaps: { mapName: string; pickedBy: "A" | "B" | null; decider: boolean; startingSide: { team: "A" | "B"; side: Side } | null }[];
  complete: boolean;
  history: (VetoDecision & { supersededBy: string | null })[];
}

export interface CaptainView {
  match: { teamA: string; teamB: string; yourTeam: string; yourSlot: "A" | "B" };
  steps: VetoStep[];
  decisions: { stepOrder: number; kind: string; mapName: string | null; side: Side | null }[];
  currentStep: VetoStep | null;
  remainingMaps: string[];
  complete: boolean;
}

export interface SponsorDelivery {
  sponsorId: string;
  outputId: string;
  zone: string;
  shownAt: string;
  hiddenAt: string | null;
  durationMs: number | null;
  acknowledged: number;
}

export interface RuleCondition {
  field: string;
  op: "eq" | "neq" | "gte" | "lte" | "in" | "exists";
  value?: unknown;
}

export interface AutomationRule {
  id: string;
  name: string;
  schemaVersion: 1;
  enabled: boolean;
  dryRun: boolean;
  trigger: { kind: string; where: RuleCondition[] };
  conditions: RuleCondition[];
  requiredCapabilities: string[];
  cooldownMs: number;
  debounceMs: number;
  dedupeKey: string;
  priority: number;
  allowedProgramModes: ProgramMode[];
  timeline: "live" | "program";
  action: { kind: string; params: Record<string, unknown> };
  timeoutMs: number;
  retry: { max: number; backoffMs: number };
}

export interface RuleExecution {
  ruleId: string;
  eventId: string;
  dedupeKey: string;
  action: AutomationRule["action"];
  dryRun: boolean;
  status: "executed" | "dry_run" | "skipped" | "failed";
  reason: string | null;
  attempts: number;
  at: number;
}

export interface ScenarioRule {
  id: string;
  mapName: string;
  regionIds: string[];
  targetSide: Side;
  minAliveTargets: number;
  grenadeTypes: string[];
  maxTimeToEffectMs: number;
  minConfidence: number;
  valueBoost: number;
  preferredCameraIds: string[];
}

export interface DirectorStatus {
  mode: DirectorMode;
  config: Record<string, unknown> & { policyVersion?: string; weights?: Record<string, number>; advantageThreshold?: number };
  controls: DirectorControls;
  ownership: OwnershipState;
  resumeInMs: number | null;
  pendingCommand: InFlightCommand | null;
  decision: DirectorDecision | null;
  opportunities: UtilityOpportunity[];
  clusters: { id: string; steamIds: string[]; [k: string]: unknown }[];
  mainStory: Record<string, unknown> | null;
  currentShot: string | null;
  cinematic: Record<string, unknown> | null;
  cinematicsUsedThisRound: number;
  scenarios: ScenarioRule[];
}

export interface ProgramTransition {
  from: ProgramMode;
  to: ProgramMode;
  owner: string;
  holder: string;
  at: string;
  confirmed: boolean;
  detail: string | null;
}

export interface ProgramState {
  mode: ProgramMode;
  owner: { kind: string; holder: string };
  scenes: SceneMap;
  activeReplay: string | null;
  history: ProgramTransition[];
}

export type ClipState = "bookmarked" | "capturing" | "prepared" | "approved" | "playing" | "played" | "rejected" | "failed";

export interface ReplayItem {
  id: string;
  state: ClipState;
  label: string;
  reason: string;
  roundNumber: number | null;
  createdAt: string;
  clip: {
    clipId: string;
    providerId: string;
    sourceId: string;
    angle: string;
    matchTimeFromMs: number | null;
    matchTimeToMs: number | null;
    timeUncertaintyMs: number | null;
    media: { path: string | null; durationMs: number | null; width: number | null; height: number | null; frameRate: number | null };
    createdAt: string;
  } | null;
  error: string | null;
  order: number;
  trim: { startMs: number; durationMs: number } | null;
  origin?: "main" | "replay_pc";
  priority?: number;
  playMs?: number | null;
  play?: { kind: "missed" | "other_angle" | "big_play"; killer: { steamId: string; name: string } | null; victims: string[]; kills: number; weapon: string | null; headshot: boolean } | null;
}

export interface ReplayProviderCapabilities {
  health: boolean;
  listSources: boolean;
  bufferRange: boolean;
  capture: boolean;
  prepare: boolean;
  preview: boolean;
  playout: boolean;
  cancel: boolean;
  export: boolean;
  limitations: string[];
}

export interface ReplaysResponse {
  items: ReplayItem[];
  provider: { id: string; kind: string; health: { ok: boolean; detail: string }; capabilities: ReplayProviderCapabilities | null } | null;
}

export interface ObsState {
  connected: boolean;
  connecting: boolean;
  lastError: string | null;
  obsVersion: string | null;
  websocketVersion: string | null;
  platform: string | null;
  availableRequests: string[];
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

export interface ObsSceneItem {
  sourceName: string;
  sceneItemId: number;
  enabled?: boolean;
  sceneItemEnabled?: boolean;
  inputKind?: string | null;
}

export interface HudCue {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  data: Record<string, unknown>;
  untilMs: number | null;
  outputs: string[] | null;
}

export interface HudAnnotation {
  id: string;
  kind: "pencil" | "arrow";
  points: [number, number][];
  color: string;
  expiresAtMs: number | null;
}

export interface HudPackage {
  id: string;
  manifest: HudManifest;
  classification: "builtin" | "imported";
  installDir: string;
  checksums: Record<string, string>;
  installedAt: string;
  previous: { version: string; installDir: string } | null;
  verify: { ok: boolean; mismatches: string[] };
}

export type OutputDraft = OverlayOutput & { id: string; settings: Record<string, unknown> };

export interface PublishedOutput {
  revision: number;
  data: OutputDraft;
  publishedAt: string;
  publishedBy: string;
}

export interface HudOutputEntry {
  draft: OutputDraft;
  published: PublishedOutput | null;
  dirty: boolean;
  url: string;
  revisions: { revision: number; publishedAt: string; publishedBy: string }[];
}

export type { HudVariant };

export interface MapSummary {
  mapName: string;
  displayName: string;
  revision: string;
  regions: number;
  cameras: { id: string; displayName: string; validation: string; mapRevision: string }[];
  radar: { source: string; verified: boolean; notes?: string | null } | null;
  floorGrid: boolean;
  synthetic: boolean;
  provenance: { createdBy: string; createdAt: string; sources: string[] };
}

export interface MapPackDetail {
  mapName: string;
  displayName: string;
  mapRevision: string;
  radar: { source: string; verified: boolean; notes?: string | null } | null;
  levels: { id: string; name: string; zMin: number; zMax: number }[];
  regions: { id: string; name: string; kind: string; source: string; validated: boolean; sampleCount: number | null; tags: string[] }[];
  cameras: CameraRecord[];
  paths: { id: string; displayName: string; validation: string }[];
  bombsites: { site: "A" | "B"; regionId: string }[];
  provenance: { createdBy: string; createdAt: string; sources: string[] };
}

export interface MapOutline {
  cells: [number, number, number, number][];
  polygons: { regionIndex: number; points: [number, number][] }[];
  regions: { id: string; name: string; kind: string }[];
}

export interface CoverageCell {
  grenadeType: string;
  telemetry: Support;
  activationEffect: Support;
  prediction: "calibrated" | "uncalibrated" | "unavailable";
  testedRegions: string[];
  cameraCoverage: "validated" | "unvalidated" | "none";
  fallback: string;
  evidence: string[];
}

export interface CoverageRow {
  mapName: string;
  displayName: string;
  requested: boolean;
  inEventPool: boolean;
  mapPackPresent: boolean;
  regionCount: number;
  regionSource: string;
  floorGrid: boolean;
  radarCalibration: "verified" | "unverified" | "none";
  validatedCameras: number;
  unvalidatedCameras: number;
  cells: CoverageCell[];
}

export interface DemoConfig {
  datasetRoot: string;
  quarantineDir: string;
  ingestRoots: string[];
  watch: boolean;
  retention: { policy: RetentionPolicy; quarantineDays: number; auditSampleRate: number };
  concurrency: number;
  pauseDuringLive: boolean;
  minFreeBytes: number;
  quotas: Record<string, { softBytes: number; hardBytes: number }>;
}

export interface DemoConfigResponse {
  config: DemoConfig;
  workersAvailable: boolean;
  paused: boolean;
  archiveIssues?: { archive: string; error: string; at: string }[];
}

export interface PythonStatus {
  interpreter: string | null;
  available: boolean;
  envDir: string;
  setup: { state: "idle" | "running" | "done" | "failed"; step: string | null; log: string[]; startedAt: string | null; finishedAt: string | null; error: string | null };
}

export interface PythonCheck {
  ok: boolean;
  python: string;
  python_ok: boolean;
  packages: Record<string, string>;
  missing: string[];
}

export interface CloudStorageStatus {
  settings: { enabled: boolean; host: string; port: number; username: string; remoteDir: string; secure: "ftps" | "plain"; fingerprint: string | null };
  hasPassword: boolean;
  uploaded: number;
  uploadedBytes: number;
  pending: number;
  current: { jobId: string; step: "features" | "upload"; progress: number } | null;
  lastError: { at: string; jobId: string | null; message: string } | null;
  nextTryAt: string | null;
}

export interface DemoJob {
  id: string;
  state: DemoJobState;
  sourcePath: string;
  ingestRoot: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  mapName: string | null;
  gameBuild: string | null;
  datasetDir: string | null;
  parser: string | null;
  schemaVersion: number | null;
  attempts: number;
  lastCheckpoint: string | null;
  failureReason: string | null;
  validation: unknown;
  retentionPolicy: RetentionPolicy;
  quarantineUntil: string | null;
  bytesRead: number | null;
  bytesWritten: number | null;
  provenance: unknown;
  createdAt: string;
  updatedAt: string;
  progress?: Record<string, unknown> | null;
}

export interface DemoJobsResponse {
  jobs: DemoJob[];
  counts: Partial<Record<DemoJobState, number>>;
}

export interface StorageReport {
  freeBytes: number;
  totalBytes: number;
  categories: Record<string, { bytes: number; quota: { softBytes: number; hardBytes: number } | null; kind: string }>;
  jobs: Partial<Record<DemoJobState, number>>;
  note: string;
}

export type { DemoJobState, RetentionPolicy };

export interface TrainingStep {
  name: "build-features" | "freeze-dataset" | "audit-split" | "train" | "evaluate" | "export-model" | string;
  status: "running" | "completed" | "failed";
  summary: Record<string, unknown> | null;
}

export interface TrainingRun {
  id: string;
  task: string;
  state: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  datasets: string[];
  steps: TrainingStep[];
  modelId: string | null;
  error: string | null;
  progress: Record<string, unknown> | null;
}

export type ModelStatus = "experimental" | "shadow" | "candidate" | "approved" | "rolled_back" | "retired";

export interface RegistryEntry {
  modelId: string;
  status: ModelStatus | string;
  task: string | null;
  createdAt: string | null;
  history: unknown[];
  evaluations: { split: string; auc: number | null; brier: number | null; at: string }[];
  exportAvailable: boolean;
  notes: string | null;
}

export interface ModelsResponse {
  models: RegistryEntry[];
  shadowModelId: string | null;
}

export interface ShadowStatus {
  shadowModelId: string | null;
  summary: { samples: number; meanAbsDiffVsBaseline: number | null; topPairAgreementRate: number | null };
  recent: { atMs: number; round: number | null; top: { t: string; ct: string; probability: number; baseline: number | null }[] }[];
  note: string;
}

export interface DeviceActionInfo {
  id: string;
  label: string;
  permission: string;
  allowed: boolean;
  params: Record<string, unknown>;
  request: string;
}

export interface DeviceTally {
  simulated: boolean;
  telemetry: "none" | "live" | "stale";
  program: { mode: ProgramMode; activeReplay: string | null };
  obs: { connected: boolean; programScene: string | null; previewScene: string | null; streaming: boolean | null; recording: boolean | null };
  director: { mode: DirectorMode; hold: boolean; cinematic: string | null };
  control: { owner: string; holder: string | null; automationActive: boolean; manualSticky: boolean; emergencyStopped: boolean; resumeInMs: number | null };
  pov: string | null;
  slots: { slot: number | null; steamId: string; name: string; side: Side | null; alive: boolean; onAir: boolean }[];
}

export interface PlayerCamConfig {
  enabled: boolean;
  scene: string | null;
  sources: Record<string, string>;
  fallbackSource: string | null;
  delayMs: number;
}

export interface PlayerCamResponse {
  config: PlayerCamConfig;
  status: { lastPlayerId: string | null; lastSource: string | null; lastError: string | null; lastAt: string | null; applied: number; obsConnected: boolean; programMode: ProgramMode };
}

export interface StatsMetric {
  key: string;
  label: string;
  definition: string;
  requires: string;
  gsi: boolean;
  available: boolean;
  reason: string | null;
}

export interface StatsResponse {
  simulated: boolean;
  map: string | null;
  round: number | null;
  metrics: StatsMetric[];
  players: { steamId: string; name: string; side: Side | null; teamId: string | null; kills: number | null; deaths: number | null; assists: number | null; mvps: number | null; score: number | null; adr: number | null; kast: number | null }[];
  corrections: StatCorrection[];
}

export interface BroadcastReport {
  generatedAt: string;
  simulated: boolean;
  sessionId: string;
  policyVersion: string;
  window: { decisions: number; minutes: number; note: string };
  director: { modeNow: string; actions: Record<string, number>; topReasons: [string, number][]; automatedCommands: number; automatedConfirmed: number; automatedFailed: number };
  continuity: { shotChanges: number; cutsPerMinute: number | null; medianShotMs: number | null; p10ShotMs: number | null; shotsThatOutlivedTheirPlayer: number };
  control: { manualTakeovers: number; externalChanges: number; emergencyStops: number };
  program: { transitions: number; history: ProgramTransition[] };
  replays: { items: { id: string; label: string; state: string; round: number | null }[] };
  sponsors: { sponsorId: string; name: string; displays: number; acknowledgedMs: number | null }[];
  caveats: string[];
}

export interface MatchframeBridgeStatus {
  config: { enabled: boolean; url: string | null; autoPushResults: boolean };
  status: "disabled" | "not configured" | "connected" | "blocked" | string;
  capabilities: Record<string, unknown> | null;
  lastError: string | null;
  note: string;
}

export interface GamesResponse {
  supported: { gameId: string; displayName: string; status: string }[];
  expansion: { gameId: string; displayName: string; status: string }[];
}

/** GET /api/v1/director/auto: the one-button Auto Director (AutoDirector.status in the engine). */
export interface AutoDirectorCheck {
  id: "console" | "data" | "account" | "pov" | "cameras" | "director";
  label: string;
  status: "ok" | "wait" | "warn" | "fail" | "skip";
  detail: string;
}
export interface AutoDirectorStatus {
  on: boolean;
  phase: "off" | "starting" | "waiting" | "running" | "paused" | "error";
  headline: string;
  settings: { cinematic: boolean; nadeCams: boolean; returnAfterSec: number; chase: boolean; clutch: boolean; variety?: boolean; winnerShots?: "every_round" | "big_rounds" | "off"; bigMoments?: boolean; hlaeCamera?: boolean };
  hlae?: { enabled: boolean; connected: boolean; connectedAt: string | null; connections: number; shots: number; lastShotAt: string | null; scriptPath: string | null };
  observerMode: ObserverMode;
  checks: AutoDirectorCheck[];
  resumesInMs: number | null;
  startedAt: string | null;
}

export interface AutoReplaySettings {
  enabled: boolean;
  maxPerBreak: number;
  speedPercent: number;
  startDelayMs: number;
  otherAngles: boolean;
  ownBigPlays: boolean;
}
export type MatchArtKind = "thumb-highlights" | "thumb-replay" | "thumb-live" | "up-next" | "stinger" | "stinger-replay";

/** GET /api/v1/matches/:id/art */
export interface MatchArtResponse {
  folder: string;
  items: { kind: MatchArtKind; label: string; file: string; url: string; still: string | null; bytes: number; updatedAt: string }[];
  settings: { backgroundAssetId: string | null };
  kinds: { kind: MatchArtKind; label: string; file: string }[];
  obs: { transitions: { stinger: string; "stinger-replay": string }; cutMs: number };
}

/** POST /api/v1/matches/:id/art/obs */
export interface MatchArtObsResult {
  set: { kind: MatchArtKind; transition: string; confirmed: boolean }[];
  missing: string[];
  noFile: MatchArtKind[];
  current: string | null;
  replayTransition: string;
}

export interface AutoReplayResponse {
  settings: AutoReplaySettings;
  status: { enabled: boolean; state: "off" | "waiting" | "playing" | "blocked"; detail: string; waiting: number; playing: { id: string; label: string } | null; lastPlayed: { id: string; label: string; at: string } | null };
}
export interface ReplayPcResponse {
  settings: { enabled: boolean; mainUrl: string; preRollMs: number; postRollMs: number; sameCstv: "stay_behind" | "each_kill" | "off"; behindMs: number };
  hasToken: boolean;
  status: {
    enabled: boolean;
    state: "off" | "connecting" | "connected" | "error";
    detail: string;
    main: { computer: string; version: string; url: string } | null;
    mainObserved: string | null;
    obsReady: boolean;
    /** How far this computer's game is behind the main PC's. */
    timing: { state: "measuring" | "live" | "behind" | "ahead"; delayMs: number | null; detail: string };
    rewind: { state: "off" | "ready" | "rewinding" | "holding" | "rewound" | "returning" | "unsupported"; detail: string; count: number };
    filming: string | null;
    planned: number;
    sent: number;
    failed: number;
    skipped: number;
    last: { label: string; at: string; ok: boolean; error: string | null } | null;
    lastSkip: { label: string; reason: string; at: string } | null;
  };
}
export interface NetworkInfo {
  computer: string;
  host: string;
  apiPort: number;
  reachable: boolean;
  addresses: string[];
}

export interface ObsAutoResponse {
  settings: { timeouts: boolean; mapEnd: boolean; replayTransition: string };
  scenes: { LIVE: string | null; REPLAY: string | null; STUDIO: string | null; BREAK: string | null };
  transitions: { current: string | null; names: string[] } | null;
}
export interface GraphicsSettings {
  enabled: boolean;
  economy: boolean;
  mvp: boolean;
  playerCards: boolean;
  clutch: boolean;
  pages: { hudId: string; scene: string; playerSource: string; matchSource: string };
}

/** GET /api/v1/cams: player cams from the website (ADR-048). */
export interface CamPlayerView {
  steamId: string;
  name: string;
  team: string;
  state: "offline" | "waiting_approval" | "live" | "hidden";
  onAir: boolean;
  camera: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  kbps: number;
  bufferedSec: number;
}
export interface CamStatusView {
  enabled: boolean;
  signedIn: boolean;
  websiteConnected: boolean;
  link: string | null;
  delayMs: number;
  quality: "low" | "standard" | "high";
  autoApprove: boolean;
  error: string | null;
  players: CamPlayerView[];
  outputs: { observed: string; player: string } | null;
}
