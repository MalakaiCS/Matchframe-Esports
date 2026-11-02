import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Match, Player, Team } from "@matchframe/contracts";
import type { SecretStore } from "../auth.ts";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { CommsBridge, type PluginSession } from "./bridge.ts";
import { msToSample, RATE, sampleToMs, VoiceBuffer } from "./buffer.ts";
import { BLOCK, CommsMixer, type Activity, type CommsSink, type MixBlock, type MixSource, type OutputName } from "./mixer.ts";
import { PROTOCOL, type ConnectionEvent, type PluginEvent, type PluginStats, type WireAudio, type WireClient } from "./wire.ts";

/**
 * Team Comms (ADR-065; docs/operations/team-comms.md): both teams' TeamSpeak voices, each person
 * separately, delayed onto the production timeline and mixed for the public broadcast, the
 * dedicated recording and the operator's preview.
 *
 * - **Team slots** A and B are the active match's team A and team B (their team ids, never CT/T: a
 *   halftime changes nothing here). Each slot names the TeamSpeak server and channel its listener
 *   tab sits in; the TeamSpeak tab whose server and channel match is that slot's source, captured,
 *   kept listen-only and silent here by the plugin. Passwords live in the secret store.
 * - **People** are keyed by their TeamSpeak unique identity within the slot's team and server
 *   (`team/server/identity`): a new session id after a reconnect is the same person; a new identity
 *   is a new person. Anyone new starts excluded from every output. The listener is never a person.
 *   Saved per person: a roster player (name, picture), Include in Broadcast, Include in Recording,
 *   a level and a preview flag.
 * - **Buffers:** each person's voice in sparse timestamped chunks (comms/buffer.ts) on the engine's
 *   clock, kept for the delay plus RETAIN_MARGIN_MS and capped in memory overall.
 * - **Readiness:** a slot is ready at the playhead (now − delay) only when its tab was captured
 *   without a break since before the playhead: after a (re)connect, once the delay has passed.
 * - **Outputs** (comms/mixer.ts) render 10 ms blocks at the playhead; nothing undelayed ever reaches
 *   them. The public listen-in is closed at start and closes itself when its team's source is lost.
 */

export const TRANSPORT_FLOOR_MS = 150;
export const MAX_DELAY_SEC = 300;
const RETAIN_MARGIN_MS = 2000;
/** At most this much is rendered at once after the engine was busy; older blocks are skipped. */
const MAX_CATCHUP_BLOCKS = 50;
/** A MANAGE not answered by the plugin within this is sent again. */
const MANAGE_RETRY_MS = 3000;
const SAVE_EVERY_MS = 10_000;

export const CommsSettings = z.object({
  /** Off: no bridge, nothing listens on the port. */
  enabled: z.boolean().default(false),
  /** 127.0.0.1 port for the TeamSpeak plugin (0: any free one, for tests). */
  bridgePort: z.number().int().min(0).max(65535).default(37213),
  delaySec: z.number().int().min(0).max(MAX_DELAY_SEC).default(0),
  fineMs: z.number().int().min(-999).max(999).default(0),
  maxBufferMB: z.number().int().min(16).max(4096).default(512),
  fadeMs: z.number().int().min(2).max(200).default(10),
  publicFadeMs: z.number().int().min(5).max(500).default(40),
  attackMs: z.number().int().min(1).max(500).default(15),
  releaseMs: z.number().int().min(10).max(3000).default(250),
  speakingDb: z.number().min(-90).max(0).default(-45),
});
export type CommsSettings = z.infer<typeof CommsSettings>;

/**
 * A patch of an object schema: every field optional and without its default. (zod 4's `.partial()`
 * keeps a field's `.default()`, so a patch of one field would reset the others to their defaults.)
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodType<Partial<z.infer<z.ZodObject<S>>>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) shape[k] = (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional();
  return z.object(shape) as unknown as z.ZodType<Partial<z.infer<z.ZodObject<S>>>>;
}

export const CommsSettingsPatch = patchOf(CommsSettings);

export type SlotId = "A" | "B";
export const SLOT_IDS: readonly SlotId[] = ["A", "B"];

export const SlotConfig = z.object({
  /** The team; null: the active match's team A (slot A) or team B (slot B). */
  teamId: z.string().max(100).nullable().default(null),
  /** The server as the listener tab connects to it (address or name), and its port. */
  serverHost: z.string().max(253).default(""),
  serverPort: z.number().int().min(1).max(65535).default(9987),
  /** The virtual server's unique id: when set, it alone identifies the server. */
  serverUid: z.string().max(100).default(""),
  /** The team's channel (its name): the listener tab sits in it. */
  channel: z.string().max(200).default(""),
  /** The listener's nickname and TeamSpeak identity name (companion setup). */
  nickname: z.string().max(64).default(""),
  identity: z.string().max(100).default(""),
});
export type SlotConfig = z.infer<typeof SlotConfig>;
export const SlotPatch = z.intersection(
  patchOf(SlotConfig),
  z.object({
    serverPassword: z.string().max(200).nullable().optional(),
    channelPassword: z.string().max(200).nullable().optional(),
  }),
);

export const ParticipantRecord = z.object({
  teamId: z.string(),
  serverUid: z.string(),
  uid: z.string(),
  playerId: z.string().nullable().default(null),
  displayName: z.string().max(64).nullable().default(null),
  includeBroadcast: z.boolean().default(false),
  includeRecording: z.boolean().default(false),
  levelDb: z.number().min(-60).max(12).default(0),
  preview: z.boolean().default(false),
  lastNickname: z.string().max(200).default(""),
  firstSeen: z.string(),
  lastSeen: z.string(),
});
export type ParticipantRecord = z.infer<typeof ParticipantRecord>;
export const ParticipantPatch = patchOf(ParticipantRecord.pick({ playerId: true, displayName: true, includeBroadcast: true, includeRecording: true, levelDb: true, preview: true }));

const SETTINGS_KEY = "comms.settings";
const SLOTS_KEY = "comms.slots";
const PEOPLE_KEY = "comms.participants";
const TOKEN_SECRET = "comms.bridgeToken";
const slotSecret = (id: SlotId, what: "serverPassword" | "channelPassword") => `comms.slot.${id}.${what}`;

/** A person's voice as it arrives (undelayed): for the calibration's live mark only, never an output. */
export interface IncomingAudio {
  key: string;
  teamId: string | null;
  /** Its capture time on the engine's timeline (ms) and length. */
  atMs: number;
  durationMs: number;
  /** RMS level of the block (dBFS). */
  db: number;
}

/** One of a team's people as the dedicated recording sees them (its speaker strip). */
export interface RecordingPerson {
  key: string;
  displayName: string;
  playerId: string | null;
  includeRecording: boolean;
  present: boolean;
  firstSeen: string;
}

export interface CommsRoster {
  activeMatch(): Match | null;
  team(id: string): Team | null;
  player(id: string): Player | null;
  assetUrl(id: string | null): string | null;
  /** The team's current roster (for mapping a TeamSpeak identity to a player in the console). */
  players?(teamId: string): Player[];
}

export interface TeamCommsOptions {
  settings: SettingsRepo;
  secrets: SecretStore;
  logger: Logger;
  dataDir: string;
  /** The engine's timeline (ms, monotonic). */
  now: () => number;
  roster: CommsRoster;
  /** Renders on a timer (false in tests that call renderUntil). */
  realtime?: boolean;
  /** Clock pings to the plugin (ms; 0 in tests on a simulated clock). */
  pingMs?: number;
  /** A plugin silent this long is closed as lost (ms, the computer's own clock; tests shorten it). */
  staleMs?: number;
  /** The computer's own clock for that (ms; default performance.now, tests move it). */
  realNow?: () => number;
}

interface Tab {
  key: string;
  instance: string;
  schid: number;
  session: PluginSession | null;
  conn: ConnectionEvent | null;
  clients: Map<number, WireClient>;
  slot: SlotId | null;
  capturing: boolean;
  asked: { capture: boolean; atMs: number } | null;
  /** TeamSpeak's last refusal on this tab (connection errors). */
  tsError: { atMs: number; code: number; message: string } | null;
  audio: number;
  ignored: { listener: number; notCapturing: number; noSlot: number; clock: number; notInChannel: number };
  /** The plugin had it listen-only and silent before MatchFrame asked (after a TeamSpeak restart it remembers the team tabs; while MatchFrame is away it keeps them so). */
  restoredByPlugin: boolean;
  /** MatchFrame handed it back to TeamSpeak (a remembered tab that is no team's now). */
  released: boolean;
}

interface SlotRuntime {
  id: SlotId;
  teamId: string | null;
  tab: string | null;
  /** When its tab was captured (timeline samples). */
  coverage: { from: number; to: number | null }[];
  /** The first sample still complete (older audio was trimmed or dropped). */
  floor: number;
  issue: string | null;
  lost: { atMs: number; reason: string } | null;
}

interface Person {
  key: string;
  slot: SlotId;
  teamId: string | null;
  serverUid: string;
  uid: string;
  nickname: string;
  clientId: number | null;
  present: boolean;
  buffer: VoiceBuffer;
  incoming: { db: number; atMs: number | null; talking: boolean };
  /** At the playhead: as mixed into the recording and the preview, and before inclusion (the console's delayed meter). */
  delayed: { recording: Activity | null; preview: Activity | null; signal: Activity | null };
}

const norm = (s: string | undefined | null) => (s ?? "").trim().toLowerCase();
const shortUid = (uid: string) => (uid.length > 10 ? `${uid.slice(0, 8)}…` : uid);

export class TeamComms {
  readonly mixer = new CommsMixer();
  private bridge: CommsBridge | null = null;
  private readonly stoppedBridges = new WeakSet<CommsBridge>();
  private bridgeError: string | null = null;
  private readonly tabs = new Map<string, Tab>();
  private readonly slots: Record<SlotId, SlotRuntime>;
  private readonly people = new Map<string, Person>();
  private records: Record<string, ParticipantRecord>;
  private cfg: CommsSettings;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBlock: number | null = null;
  private delayMs: number;
  private pendingDelay: { ms: number; muteBlocks: number } | null = null;
  private dirty = false;
  private lastSave = 0;
  private lastHousekeep = -Infinity;
  private recordingSignal = false;
  private publicClosed: { atMs: number; reason: string } | null = null;
  private readonly blockListeners = new Set<(b: MixBlock) => void>();
  private readonly publicClosedListeners = new Set<(reason: string) => void>();
  private readonly incomingListeners = new Set<(a: IncomingAudio) => void>();
  /** Bumped whenever who is who changes (a person seen, a choice or mapping saved, the teams): the recording's speaker strip rebuilds its cards then. */
  private version = 0;
  private readonly counters = { blocks: 0, skippedBlocks: 0, memoryDrops: 0, memoryDroppedBytes: 0, closedSessions: 0 };

  constructor(private readonly o: TeamCommsOptions) {
    this.cfg = CommsSettings.parse(o.settings.get(SETTINGS_KEY, {}));
    this.delayMs = this.effectiveDelay(this.cfg);
    this.applyMixerOptions();
    this.records = {};
    for (const [k, v] of Object.entries(o.settings.get<Record<string, unknown>>(PEOPLE_KEY, {}))) {
      const r = ParticipantRecord.safeParse(v);
      if (r.success) this.records[k] = r.data;
    }
    this.slots = { A: this.newSlot("A"), B: this.newSlot("B") };
    this.refreshTeams();
  }

  private newSlot(id: SlotId): SlotRuntime {
    return { id, teamId: null, tab: null, coverage: [], floor: -Infinity, issue: null, lost: null };
  }

  // ---------------------------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.cfg.enabled) await this.startBridge();
  }

  async stop(): Promise<void> {
    await this.stopBridge();
    this.flush(true);
  }

  private async startBridge(): Promise<void> {
    if (this.bridge) return;
    const bridge: CommsBridge = new CommsBridge({
      port: this.cfg.bridgePort,
      token: () => this.token(),
      now: this.o.now,
      logger: this.o.logger,
      pingMs: this.o.pingMs,
      staleMs: this.o.staleMs,
      realNow: this.o.realNow,
      // Ignored once this bridge is stopped: its sockets may still report closing after Team Comms (or the engine) stopped.
      handlers: {
        onSession: (s) => !this.stoppedBridges.has(bridge) && this.onSession(s),
        onClose: (s, reason) => !this.stoppedBridges.has(bridge) && this.onClose(s, reason),
        onEvent: (s, ev) => !this.stoppedBridges.has(bridge) && this.onEvent(s, ev),
        onAudio: (s, a, at) => !this.stoppedBridges.has(bridge) && this.onAudio(s, a, at),
        onStats: (s, st) => !this.stoppedBridges.has(bridge) && this.onStats(s, st),
      },
    });
    try {
      const port = await bridge.start();
      this.bridge = bridge;
      this.bridgeError = null;
      this.writeBridgeFile(port);
      this.o.logger.info("team comms bridge listening", { port });
      this.bind();
    } catch (e) {
      this.bridgeError = (e as Error).message;
      this.o.logger.error("team comms bridge could not start", { error: this.bridgeError });
    }
    if (this.o.realtime !== false && !this.timer) {
      this.timer = setInterval(() => this.renderUntil(this.o.now()), 5);
      this.timer.unref();
    }
  }

  private async stopBridge(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const b = this.bridge;
    this.bridge = null;
    if (b) {
      this.stoppedBridges.add(b);
      await b.stop();
      rmSync(this.bridgeFile(), { force: true });
    }
    for (const t of this.tabs.values()) this.tabLost(t, "Team Comms switched off");
    this.tabs.clear();
  }

  /** Where the plugin finds the port and token (it reads it on every connection attempt). */
  bridgeFile(): string {
    return join(this.o.dataDir, "team-comms", "bridge.json");
  }

  private token(): string {
    let t = this.o.secrets.getSecret(TOKEN_SECRET);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.o.secrets.setSecret(TOKEN_SECRET, t);
    }
    return t;
  }

  private writeBridgeFile(port: number): void {
    const file = this.bridgeFile();
    mkdirSync(join(this.o.dataDir, "team-comms"), { recursive: true });
    writeFileSync(file, JSON.stringify({ protocol: PROTOCOL, host: "127.0.0.1", port, token: this.token() }, null, 2), { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows: the per-user AppData folder.
    }
  }

  /** A new token: the plugin reconnects with it (it re-reads the bridge file). */
  rotateToken(): void {
    this.o.secrets.setSecret(TOKEN_SECRET, randomBytes(24).toString("hex"));
    const port = this.bridge?.status().port;
    if (port) this.writeBridgeFile(port);
    for (const s of this.bridge?.sessions() ?? []) s.close("token rotated", "unauthorized: the token was rotated");
  }

  // ---------------------------------------------------------------------------------------- settings

  settings(): CommsSettings {
    return { ...this.cfg };
  }

  private effectiveDelay(c: CommsSettings): number {
    return Math.max(TRANSPORT_FLOOR_MS, c.delaySec * 1000 + c.fineMs);
  }

  private applyMixerOptions(): void {
    const c = this.cfg;
    this.mixer.options = { fadeMs: c.fadeMs, publicFadeMs: c.publicFadeMs, attackMs: c.attackMs, releaseMs: c.releaseMs, speakingDb: c.speakingDb };
  }

  async updateSettings(patch: Partial<CommsSettings>): Promise<CommsSettings> {
    const prev = this.cfg;
    const next = CommsSettings.parse({ ...prev, ...patch });
    this.cfg = next;
    this.o.settings.set(SETTINGS_KEY, next);
    this.applyMixerOptions();
    const delay = this.effectiveDelay(next);
    if (delay !== (this.pendingDelay?.ms ?? this.delayMs)) {
      // Mute (every output fades out on the old playhead), then the new playhead: readiness is
      // checked again there (a longer delay re-buffers until that much history is held).
      this.pendingDelay = { ms: delay, muteBlocks: Math.ceil((next.fadeMs * RATE) / 1000 / BLOCK) + 1 };
    }
    if (!next.enabled && this.bridge) await this.stopBridge();
    else if (next.enabled && this.bridge && next.bridgePort !== prev.bridgePort) {
      await this.stopBridge();
      await this.startBridge();
    } else if (next.enabled && !this.bridge) await this.startBridge();
    return this.settings();
  }

  // ---------------------------------------------------------------------------------------- slots and teams

  slotConfig(id: SlotId): SlotConfig {
    return SlotConfig.parse(this.o.settings.get<Record<string, unknown>>(SLOTS_KEY, {})[id] ?? {});
  }

  updateSlot(id: SlotId, patch: z.infer<typeof SlotPatch>): SlotConfig {
    const { serverPassword, channelPassword, ...rest } = patch;
    const all = this.o.settings.get<Record<string, unknown>>(SLOTS_KEY, {});
    const next = SlotConfig.parse({ ...this.slotConfig(id), ...rest });
    this.o.settings.set(SLOTS_KEY, { ...all, [id]: next });
    if (serverPassword !== undefined) this.o.secrets.setSecret(slotSecret(id, "serverPassword"), serverPassword || null);
    if (channelPassword !== undefined) this.o.secrets.setSecret(slotSecret(id, "channelPassword"), channelPassword || null);
    this.refreshTeams();
    this.bind();
    return next;
  }

  /** Slot A and B's teams: the active match's (or the slot's own team), by team id. */
  refreshTeams(): void {
    const m = this.o.roster.activeMatch();
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const teamId = this.slotConfig(id).teamId ?? (id === "A" ? m?.teamAId : m?.teamBId) ?? null;
      if (teamId === slot.teamId) continue;
      const old = slot.teamId;
      slot.teamId = teamId;
      if (old !== null && this.mixer.publicGate.target === old) this.closePublic(`team ${id} changed`);
      if (old !== null && this.mixer.recordingGate.target === old) this.mixer.setRecordingTeam(null);
      // Same people, now under this team: their saved choices are this team's.
      for (const p of [...this.people.values()].filter((x) => x.slot === id)) {
        this.people.delete(p.key);
        this.mixer.forget(p.key);
        p.teamId = teamId;
        p.key = this.personKey(id, p.serverUid, p.uid);
        this.people.set(p.key, p);
        this.ensureRecord(p);
      }
      this.version++;
    }
  }

  private slotOfTeam(teamId: string): SlotRuntime | null {
    for (const id of SLOT_IDS) if (this.slots[id].teamId === teamId) return this.slots[id];
    return null;
  }

  private personKey(slot: SlotId, serverUid: string, uid: string): string {
    const team = this.slots[slot].teamId;
    return team ? `${team}/${serverUid}/${uid}` : `~${slot}/${serverUid}/${uid}`;
  }

  // ---------------------------------------------------------------------------------------- tabs (TeamSpeak connections)

  private tabKey(s: PluginSession, schid: number): string {
    return `${s.instance}#${schid}`;
  }

  private tabOf(s: PluginSession, schid: number): Tab {
    const key = this.tabKey(s, schid);
    let t = this.tabs.get(key);
    if (!t) {
      t = { key, instance: s.instance, schid, session: s, conn: null, clients: new Map(), slot: null, capturing: false, asked: null, tsError: null, audio: 0, ignored: { listener: 0, notCapturing: 0, noSlot: 0, clock: 0, notInChannel: 0 }, restoredByPlugin: false, released: false };
      this.tabs.set(key, t);
    }
    t.session = s;
    return t;
  }

  private serverUid(t: Tab): string {
    const s = t.conn?.server;
    return s?.uid || (s ? `${norm(s.host)}:${s.port}` : "unknown");
  }

  private matches(cfg: SlotConfig, t: Tab): boolean {
    const c = t.conn;
    if (!c || c.status !== 4 || !c.server || !c.channel || !t.session || t.session.closed) return false;
    if (!cfg.channel.trim() || norm(c.channel.name) !== norm(cfg.channel)) return false;
    if (cfg.serverUid) return c.server.uid === cfg.serverUid;
    if (cfg.serverHost) return norm(c.server.host) === norm(cfg.serverHost) && (c.server.port === cfg.serverPort || c.server.port === 0);
    return true;
  }

  /** Each slot's tab: the one in its server and channel. Sends the plugin what to capture. */
  private bind(): void {
    const now = this.o.now();
    const chosen: Record<SlotId, Tab | null> = { A: null, B: null };
    const cfgs = { A: this.slotConfig("A"), B: this.slotConfig("B") };
    for (const id of SLOT_IDS) {
      const cfg = cfgs[id];
      const slot = this.slots[id];
      const cands = [...this.tabs.values()].filter((t) => this.matches(cfg, t));
      const cur = slot.tab ? this.tabs.get(slot.tab) : undefined;
      chosen[id] = cur && cands.includes(cur) ? cur : (cands[0] ?? null);
      slot.issue = !cfg.channel.trim()
        ? "No TeamSpeak channel set for this team"
        : cands.length === 0
          ? this.bridge
            ? `No TeamSpeak tab in "${cfg.channel}"${cfg.serverHost || cfg.serverUid ? " on that server" : ""}: connect the listener tab there${this.recentTsError(now)}`
            : "Team Comms is off"
          : cands.length > 1
            ? `${cands.length} TeamSpeak tabs are in "${cfg.channel}": only one is used`
            : null;
    }
    if (chosen.A && chosen.A === chosen.B) {
      this.slots.A.issue = this.slots.B.issue = "Both teams are set to the same TeamSpeak channel";
      chosen.A = chosen.B = null;
    }
    for (const id of SLOT_IDS) {
      const slot = this.slots[id];
      const want = chosen[id];
      if (slot.tab && slot.tab !== want?.key) {
        const old = this.tabs.get(slot.tab);
        if (old) {
          old.slot = null;
          this.endCoverage(slot, "its TeamSpeak tab is no longer in the team's channel");
          // Nobody of this team is heard through it any more (a tab moved to another channel).
          for (const p of this.people.values()) if (p.slot === id) p.present = false;
          // Still a listener: microphone off, silent here, just not captured.
          this.ask(old, false, now);
        }
        slot.tab = null;
      }
      if (want) {
        slot.tab = want.key;
        want.slot = id;
        want.released = false;
        if (!want.capturing && (!want.asked || !want.asked.capture || now - want.asked.atMs > MANAGE_RETRY_MS)) this.ask(want, true, now);
      }
    }
    // A tab the plugin made listen-only by itself (it remembered it from before a TeamSpeak restart)
    // that is in no team's server and channel now: handed back to TeamSpeak (the plugin forgets it).
    for (const t of this.tabs.values()) {
      const m = t.conn?.managed;
      if (!m || t.slot || t.asked || t.released || !t.session || t.session.closed || t.conn?.status !== 4) continue;
      if (!(m.capture || m.listenOnly || m.suppressPlayback)) continue;
      // Only once TeamSpeak has said where it is: a connection still being established can report
      // itself before its address or channel is filled in (seen with real TeamSpeak: handing it back
      // then let its team play on this computer until the next report).
      const c = t.conn;
      if (!c?.server?.uid || !c.server.host || !c.channel?.id || !c.channel.name) continue;
      if (SLOT_IDS.some((id) => this.matches(cfgs[id], t))) continue;
      t.released = true;
      t.asked = { capture: false, atMs: now };
      t.session.manage(t.schid, { capture: false, listenOnly: false, suppressPlayback: false });
      this.o.logger.info("team comms: a tab the plugin remembered is no team's now: handed back to TeamSpeak", { tab: t.key, channel: t.conn?.channel?.name ?? null });
    }
  }

  /** TeamSpeak's latest refusal on a tab that isn't connected (the minute before), for a waiting slot's message. */
  private recentTsError(now: number): string {
    let last: Tab["tsError"] = null;
    for (const t of this.tabs.values()) if (t.tsError && t.conn?.status !== 4 && now - t.tsError.atMs < 60_000 && (!last || t.tsError.atMs > last.atMs)) last = t.tsError;
    return last ? ` (TeamSpeak refused a connection: ${last.message})` : "";
  }

  private ask(t: Tab, capture: boolean, now: number): void {
    if (!t.session || t.session.closed) return;
    t.asked = { capture, atMs: now };
    t.session.manage(t.schid, { capture, listenOnly: true, suppressPlayback: true });
  }

  private startCoverage(slot: SlotRuntime): void {
    const last = slot.coverage[slot.coverage.length - 1];
    if (last && last.to === null) return;
    slot.coverage.push({ from: msToSample(this.o.now()), to: null });
    if (slot.coverage.length > 20) slot.coverage.shift();
    slot.lost = null;
    for (const p of this.people.values()) if (p.slot === slot.id) p.buffer.breakContinuity();
  }

  private endCoverage(slot: SlotRuntime, reason: string): void {
    const last = slot.coverage[slot.coverage.length - 1];
    if (!last || last.to !== null) return;
    last.to = msToSample(this.o.now());
    slot.lost = { atMs: this.o.now(), reason };
    // The public listen-in never stays open on a lost source: a new Listen In is needed.
    if (slot.teamId && this.mixer.publicGate.target === slot.teamId) this.closePublic(`team ${slot.id}'s TeamSpeak source was lost: ${reason}`);
  }

  private tabLost(t: Tab, reason: string): void {
    if (t.capturing && t.slot) this.endCoverage(this.slots[t.slot], reason);
    t.capturing = false;
    t.asked = null;
    for (const p of this.people.values()) if (p.slot === t.slot) p.present = false;
  }

  // ---------------------------------------------------------------------------------------- bridge handlers

  private onSession(s: PluginSession): void {
    if (this.recordingSignal) s.recording(true);
  }

  private onClose(s: PluginSession, reason: string): void {
    this.counters.closedSessions++;
    for (const t of [...this.tabs.values()]) {
      if (t.session !== s) continue;
      this.tabLost(t, `the TeamSpeak plugin disconnected (${reason})`);
      if (t.slot) this.slots[t.slot].tab = null;
      this.tabs.delete(t.key);
    }
    this.bind();
  }

  private onStats(_s: PluginSession, _st: PluginStats): void {
    // Kept on the session (lastStats) for the status and the support file.
  }

  private onEvent(s: PluginSession, ev: PluginEvent): void {
    const t = this.tabOf(s, ev.schid);
    switch (ev.type) {
      case "connection": {
        // Listen-only before MatchFrame asked anything: the plugin remembered this team tab.
        if (ev.status === 4 && !t.asked && (ev.managed.listenOnly || ev.managed.suppressPlayback) && !ev.managed.capture) t.restoredByPlugin = true;
        t.conn = ev;
        if (ev.status === 4) t.clients = new Map(ev.clients.map((c) => [c.clientId, c]));
        else t.clients.clear();
        const capturing = ev.status === 4 && ev.managed.capture;
        if (capturing && !t.capturing) {
          t.capturing = true;
          if (t.slot) this.startCoverage(this.slots[t.slot]);
        } else if (!capturing && t.capturing) {
          this.tabLost(t, ev.status !== 4 ? `TeamSpeak ${ev.statusName}${ev.errorText ? `: ${ev.errorText}` : ""}` : "capture stopped");
        }
        if (ev.status !== 4 && t.asked) t.asked = null;
        this.bind();
        // bind() may just have given this tab a slot.
        if (t.capturing && t.slot) this.startCoverage(this.slots[t.slot]);
        this.syncPeople(t);
        return;
      }
      case "client":
        if (ev.change === "leave") t.clients.delete(ev.client.clientId);
        else if (ev.client.channelId === t.conn?.channel?.id || ev.change === "discovered") t.clients.set(ev.client.clientId, ev.client);
        this.syncPeople(t);
        return;
      case "talk": {
        const c = t.clients.get(ev.clientId);
        const p = c && t.slot ? this.people.get(this.personKey(t.slot, this.serverUid(t), c.uid)) : undefined;
        if (p) p.incoming.talking = ev.talking === 1;
        return;
      }
      case "self":
        return;
      case "error":
        t.tsError = { atMs: this.o.now(), code: ev.error, message: [ev.message, ev.extra].filter(Boolean).join(": ") };
        this.o.logger.warn("team comms: TeamSpeak refused", { tab: t.key, error: ev.error, message: t.tsError.message });
        this.bind();
        return;
    }
  }

  private isListener(uid: string): boolean {
    for (const t of this.tabs.values()) if (t.conn?.self?.uid === uid) return true;
    return false;
  }

  /** Who is in the tab's channel now (session ids re-resolved to identities). */
  private syncPeople(t: Tab): void {
    if (!t.slot) return;
    const server = this.serverUid(t);
    const here = new Map<string, WireClient>();
    for (const c of t.clients.values()) if (c.uid && !this.isListener(c.uid) && c.channelId === t.conn?.channel?.id) here.set(c.uid, c);
    for (const p of this.people.values()) {
      if (p.slot !== t.slot || p.serverUid !== server) continue;
      const c = here.get(p.uid);
      p.present = !!c && t.capturing;
      p.clientId = c?.clientId ?? null;
      if (c) p.nickname = c.nickname;
    }
    for (const c of here.values()) {
      const p = this.person(t.slot, server, c.uid, c);
      p.present = t.capturing;
    }
  }

  private person(slot: SlotId, serverUid: string, uid: string, c?: WireClient): Person {
    const key = this.personKey(slot, serverUid, uid);
    let p = this.people.get(key);
    if (!p) {
      p = { key, slot, teamId: this.slots[slot].teamId, serverUid, uid, nickname: c?.nickname ?? "", clientId: c?.clientId ?? null, present: true, buffer: new VoiceBuffer(), incoming: { db: -100, atMs: null, talking: false }, delayed: { recording: null, preview: null, signal: null } };
      this.people.set(key, p);
      this.ensureRecord(p);
      this.version++;
    }
    if (c) {
      p.clientId = c.clientId;
      if (c.nickname) p.nickname = c.nickname;
    }
    return p;
  }

  /** A saved record for a person of a team: a new identity is excluded from every output. */
  private ensureRecord(p: Person): void {
    if (!p.teamId) return;
    const now = new Date().toISOString();
    const r = this.records[p.key];
    if (r) {
      if (p.nickname && r.lastNickname !== p.nickname) r.lastNickname = p.nickname;
      r.lastSeen = now;
    } else {
      this.records[p.key] = ParticipantRecord.parse({ teamId: p.teamId, serverUid: p.serverUid, uid: p.uid, lastNickname: p.nickname, firstSeen: now, lastSeen: now });
      this.o.logger.info("team comms: new TeamSpeak identity (excluded until approved)", { team: p.teamId, nickname: p.nickname, uid: shortUid(p.uid) });
    }
    this.dirty = true;
  }

  private onAudio(s: PluginSession, a: WireAudio, arrivalMs: number): void {
    const t = this.tabOf(s, a.schid);
    t.audio++;
    if (!t.capturing) return void t.ignored.notCapturing++;
    if (!t.slot) return void t.ignored.noSlot++;
    if (a.uid === t.conn?.self?.uid || a.clientId === a.ownClientId || this.isListener(a.uid)) return void t.ignored.listener++;
    if (!s.clock.ready) return void t.ignored.clock++;
    // Only someone in the tab's channel now (a block from before the listener's tab moved, or from someone who left, is not this team's).
    let inChannel = false;
    for (const x of t.clients.values()) if (x.uid === a.uid && x.channelId === t.conn?.channel?.id) inChannel = true;
    if (!inChannel) return void t.ignored.notInChannel++;
    const c = t.clients.get(a.clientId);
    const p = this.person(t.slot, this.serverUid(t), a.uid, c && c.uid === a.uid ? c : undefined);
    const start = msToSample(s.clock.toEngineMs(a.captureUs));
    p.buffer.write(start, a.pcm, a.channels, a.sampleRate, this.playFloor());
    // What arrives now (undelayed): the console's incoming meter only, never an output.
    let sq = 0;
    for (let i = 0; i < a.pcm.length; i++) sq += (a.pcm[i]! / 32768) ** 2;
    const db = sq > 0 ? 10 * Math.log10(sq / a.pcm.length) : -100;
    p.incoming.db = Math.max(db, p.incoming.db - 6);
    p.incoming.atMs = arrivalMs;
    if (this.incomingListeners.size) {
      const frames = a.pcm.length / a.channels;
      const ev: IncomingAudio = { key: p.key, teamId: p.teamId, atMs: sampleToMs(start), durationMs: (frames / a.sampleRate) * 1000, db };
      for (const fn of this.incomingListeners) fn(ev);
    }
    this.capMemory();
  }

  /** The first timeline sample the outputs have not played yet. */
  private playFloor(): number {
    return this.nextBlock === null ? -Infinity : this.nextBlock - msToSample(this.delayMs);
  }

  private capMemory(): void {
    const cap = this.cfg.maxBufferMB * 1024 * 1024;
    let total = 0;
    for (const p of this.people.values()) total += p.buffer.bytes;
    while (total > cap) {
      let oldest: Person | null = null;
      for (const p of this.people.values()) {
        const f = p.buffer.firstStart;
        if (f !== null && (!oldest || f < oldest.buffer.firstStart!)) oldest = p;
      }
      if (!oldest) break;
      const d = oldest.buffer.dropOldest();
      if (!d) break;
      total -= d.bytes;
      this.counters.memoryDrops++;
      this.counters.memoryDroppedBytes += d.bytes;
      // That team's audio is incomplete before this: not ready until the playhead passes it.
      const slot = this.slots[oldest.slot];
      slot.floor = Math.max(slot.floor, d.end);
    }
  }

  // ---------------------------------------------------------------------------------------- people

  participantRecord(key: string): ParticipantRecord | null {
    return this.records[key] ?? null;
  }

  updateParticipant(key: string, patch: z.infer<typeof ParticipantPatch>): ParticipantRecord {
    const r = this.records[key];
    if (!r) throw new Error(`no TeamSpeak participant ${key}`);
    if (patch.playerId) {
      if (!this.o.roster.player(patch.playerId)) throw new Error(`no player ${patch.playerId}`);
    }
    Object.assign(r, ParticipantPatch.parse(patch));
    this.version++;
    this.dirty = true;
    this.flush(true);
    return r;
  }

  /** Saved people (mappings, choices, levels) of these teams, for an event preset. */
  exportRecords(teamIds: string[]): ParticipantRecord[] {
    const want = new Set(teamIds);
    return Object.values(this.records)
      .filter((r) => want.has(r.teamId))
      .map((r) => ({ ...r }));
  }

  /**
   * An event preset's people: each record's mapping, choices and level set on that identity (made if
   * MatchFrame hasn't seen them yet). The operator's private Solo is never part of a preset; people
   * the preset doesn't name keep what they have (new arrivals stay excluded).
   */
  importRecords(records: ParticipantRecord[]): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const raw of records) {
      const r = ParticipantRecord.safeParse(raw);
      if (!r.success) continue;
      const rec = r.data;
      if (rec.playerId && !this.o.roster.player(rec.playerId)) rec.playerId = null;
      const key = `${rec.teamId}/${rec.serverUid}/${rec.uid}`;
      const cur = this.records[key];
      this.records[key] = { ...(cur ?? { ...rec, firstSeen: now, lastSeen: now, lastNickname: rec.lastNickname }), playerId: rec.playerId, displayName: rec.displayName, includeBroadcast: rec.includeBroadcast, includeRecording: rec.includeRecording, levelDb: rec.levelDb, preview: cur?.preview ?? false };
      n++;
    }
    this.version++;
    this.dirty = true;
    this.flush(true);
    return n;
  }

  private flush(force = false): void {
    if (!this.dirty) return;
    const now = this.o.now();
    if (!force && now - this.lastSave < SAVE_EVERY_MS) return;
    this.o.settings.set(PEOPLE_KEY, this.records);
    this.dirty = false;
    this.lastSave = now;
  }

  // ---------------------------------------------------------------------------------------- outputs

  /** The public listen-in (phase 3's controller drives this): a team id, or null to close it. */
  setPublicTeam(teamId: string | null): void {
    if (teamId !== null && !this.slotOfTeam(teamId)) throw new Error(`team ${teamId} has no Team Comms slot`);
    this.mixer.setPublicTeam(teamId);
    if (teamId !== null) this.publicClosed = null;
  }

  /** Mute All Comms: the public listen-in closed in 5 ms (not a fault; the recording and preview carry on). */
  mutePublic(): void {
    this.mixer.mutePublic();
  }

  private closePublic(reason: string): void {
    this.mixer.setPublicTeam(null);
    this.publicClosed = { atMs: this.o.now(), reason };
    this.o.logger.warn("team comms: public listen-in closed", { reason });
    for (const fn of this.publicClosedListeners) fn(reason);
  }

  /** The public listen-in closed itself (its team's source lost, the bridge or a slot reset): the output-state controller's FAULT. */
  onPublicClosed(fn: (reason: string) => void): () => void {
    this.publicClosedListeners.add(fn);
    return () => this.publicClosedListeners.delete(fn);
  }

  /** Team Comms is switched on (the bridge listens, the mixes render). */
  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /** A team's slot and whether its delayed audio is complete at the current playhead (and if not, roughly when). */
  teamReadiness(teamId: string): { slot: SlotId; ready: boolean; readyInMs: number | null; state: string; issue: string | null } | null {
    const slot = this.slotOfTeam(teamId);
    if (!slot) return null;
    const v = this.slotView(slot.id);
    // Ready for a listen-in: its tab captured now and without a break since before the playhead (not
    // only audio from before a loss still at the playhead: the gap after it would follow, then the
    // reconnected tab's audio with no new Listen In), and the delay held.
    return { slot: slot.id, ready: v.ready && v.continuous && v.state === "ready" && this.pendingDelay === null, readyInMs: v.readyInMs, state: v.state === "ready" && !v.continuous ? "buffering" : v.state, issue: v.issue ?? (v.lost ? v.lost.reason : null) };
  }

  /** The playhead (timeline samples) a block starting at `start` plays, with the delay in effect. */
  playheadOf(start: number): number {
    return start - msToSample(this.delayMs);
  }

  /** The dedicated recording's team (ADR-068), or null. */
  setRecordingTeam(teamId: string | null): void {
    if (teamId !== null && !this.slotOfTeam(teamId)) throw new Error(`team ${teamId} has no Team Comms slot`);
    this.mixer.setRecordingTeam(teamId);
  }

  /** TeamSpeak's recording indicator is asked for (while the dedicated recording records). */
  get recordingSignalOn(): boolean {
    return this.recordingSignal;
  }

  /** TeamSpeak's recording indicator on both listener tabs (while MatchFrame records comms). */
  setRecordingSignal(on: boolean): void {
    this.recordingSignal = on;
    for (const s of this.bridge?.sessions() ?? []) s.recording(on);
  }

  addSink(output: OutputName, sink: CommsSink): () => void {
    this.mixer.sinks[output].add(sink);
    return () => this.mixer.sinks[output].delete(sink);
  }

  onBlock(fn: (b: MixBlock) => void): () => void {
    this.blockListeners.add(fn);
    return () => this.blockListeners.delete(fn);
  }

  /** Each person's voice as it arrives (undelayed, never an output): the delay calibration's live mark. */
  onIncoming(fn: (a: IncomingAudio) => void): () => void {
    this.incomingListeners.add(fn);
    return () => this.incomingListeners.delete(fn);
  }

  /** Changes whenever who is who changes (people seen, choices and mappings saved, teams). */
  get peopleVersion(): number {
    return this.version;
  }

  /** A team's people as the dedicated recording sees them (its speaker strip): everyone of that team's slot, with their saved choice. */
  recordingPeople(teamId: string): RecordingPerson[] {
    const out: RecordingPerson[] = [];
    for (const p of this.people.values()) {
      if (p.teamId !== teamId) continue;
      const r = this.records[p.key];
      if (!r) continue;
      const player = r.playerId ? this.o.roster.player(r.playerId) : null;
      out.push({ key: p.key, displayName: r.displayName ?? player?.displayName ?? p.nickname, playerId: r.playerId, includeRecording: r.includeRecording, present: p.present, firstSeen: r.firstSeen });
    }
    return out;
  }

  /** The dedicated recording's team as asked for (null: none). */
  get recordingTeam(): string | null {
    return this.mixer.recordingGate.target;
  }

  /** Whether MatchFrame has this roster player. */
  hasPlayer(id: string): boolean {
    return !!this.o.roster.player(id);
  }

  /** Whether a team has a Team Comms slot now (the active match's team A or B). */
  hasTeam(teamId: string): boolean {
    return this.slotOfTeam(teamId) !== null;
  }

  /** Whether a team's audio is complete at a timeline sample (its tab captured since before it). */
  readyAt(teamId: string, playhead: number): boolean {
    const slot = this.slotOfTeam(teamId);
    if (!slot || playhead < slot.floor) return false;
    return slot.coverage.some((c) => c.from <= playhead && (c.to === null || playhead < c.to));
  }

  /** Renders every 10 ms block that ended by `nowMs` (the timer calls it; tests drive it). */
  renderUntil(nowMs: number): void {
    const now = msToSample(nowMs);
    const lastStart = Math.floor(now / BLOCK) * BLOCK - BLOCK;
    if (this.nextBlock === null) this.nextBlock = lastStart;
    if (lastStart - this.nextBlock > MAX_CATCHUP_BLOCKS * BLOCK) {
      const skip = Math.floor((lastStart - this.nextBlock) / BLOCK) - MAX_CATCHUP_BLOCKS;
      this.counters.skippedBlocks += skip;
      this.nextBlock += skip * BLOCK;
    }
    while (this.nextBlock <= lastStart) {
      this.renderBlock(this.nextBlock);
      this.nextBlock += BLOCK;
    }
    if (nowMs - this.lastHousekeep >= 500) {
      this.lastHousekeep = nowMs;
      this.housekeep();
    }
  }

  private renderBlock(start: number): void {
    let mute = false;
    if (this.pendingDelay) {
      if (this.pendingDelay.muteBlocks > 0) {
        this.pendingDelay.muteBlocks--;
        mute = true;
      } else {
        this.delayMs = this.pendingDelay.ms;
        this.pendingDelay = null;
      }
    }
    const playhead = start - msToSample(this.delayMs);
    const sources: MixSource[] = [];
    for (const p of this.people.values()) {
      const r = p.teamId ? this.records[p.key] : undefined;
      sources.push({ key: p.key, teamId: p.teamId, buffer: p.buffer, levelDb: r?.levelDb ?? 0, include: { public: !!r?.includeBroadcast, recording: !!r?.includeRecording, preview: !!r?.preview } });
    }
    const block = this.mixer.render(start, playhead, sources, (team) => this.readyAt(team, playhead), mute);
    this.counters.blocks++;
    for (const p of this.people.values()) {
      p.delayed.recording = block.activity.recording.get(p.key) ?? null;
      p.delayed.preview = block.activity.preview.get(p.key) ?? null;
      p.delayed.signal = block.activity.delayed.get(p.key) ?? null;
    }
    for (const fn of this.blockListeners) fn(block);
  }

  private housekeep(): void {
    if (this.nextBlock !== null) {
      const cutoff = this.nextBlock - msToSample(this.delayMs + RETAIN_MARGIN_MS);
      for (const p of this.people.values()) p.buffer.trim(cutoff);
      for (const id of SLOT_IDS) this.slots[id].floor = Math.max(this.slots[id].floor, cutoff);
    }
    this.bind();
    this.flush();
  }

  // ---------------------------------------------------------------------------------------- status

  /** Delay in effect (ms), and the one asked for while the change is fading. */
  delay(): { configuredMs: number; effectiveMs: number; pendingMs: number | null; floorMs: number } {
    return { configuredMs: this.cfg.delaySec * 1000 + this.cfg.fineMs, effectiveMs: this.delayMs, pendingMs: this.pendingDelay?.ms ?? null, floorMs: TRANSPORT_FLOOR_MS };
  }

  private slotView(id: SlotId) {
    const slot = this.slots[id];
    const cfg = this.slotConfig(id);
    const team = slot.teamId ? this.o.roster.team(slot.teamId) : null;
    const tab = slot.tab ? this.tabs.get(slot.tab) : undefined;
    const now = this.o.now();
    // Readiness for the delay asked for (a change still fading counts as made).
    const playhead = msToSample(now - (this.pendingDelay?.ms ?? this.delayMs));
    const open = slot.coverage[slot.coverage.length - 1];
    const ready = slot.teamId ? this.readyAt(slot.teamId, playhead) : false;
    // Captured without a break from before the playhead until now: what a listen-in needs (audio from
    // before a loss can still be at the playhead while the gap after it hasn't been played yet).
    const continuous = ready && !!open && open.to === null && Math.max(open.from, slot.floor) <= playhead;
    const readyInMs = !continuous && open && open.to === null ? Math.max(0, sampleToMs(Math.max(open.from, slot.floor) - playhead)) : null;
    const state = !this.bridge ? "off" : !tab ? "waiting" : !tab.capturing ? "connecting" : ready ? "ready" : "buffering";
    return {
      id,
      team: slot.teamId ? { id: slot.teamId, name: team?.name ?? null, shortName: team?.shortName ?? null, logoUrl: this.o.roster.assetUrl(team?.logoAssetId ?? null), color: team?.primaryColor ?? null } : null,
      roster: slot.teamId && this.o.roster.players ? this.o.roster.players(slot.teamId).map((pl) => ({ id: pl.id, displayName: pl.displayName, pictureUrl: this.o.roster.assetUrl(pl.avatarAssetId) })) : [],
      config: cfg,
      serverPasswordSaved: this.o.secrets.hasSecret(slotSecret(id, "serverPassword")),
      channelPasswordSaved: this.o.secrets.hasSecret(slotSecret(id, "channelPassword")),
      state,
      ready,
      continuous,
      readyInMs,
      issue: slot.issue,
      lost: slot.lost,
      tab: tab ? this.tabView(tab) : null,
      connectLink: this.connectLink(id, cfg),
      coverage: slot.coverage.slice(-3).map((c) => ({ fromMs: sampleToMs(c.from), toMs: c.to === null ? null : sampleToMs(c.to) })),
    };
  }

  /**
   * TeamSpeak's own link to connect a tab into the team's channel (`ts3server://`, as TeamSpeak's
   * command line and its link handler take it; the rig connects its listeners this way). No password
   * in it: TeamSpeak asks for one, and MatchFrame never shows the saved ones.
   */
  private connectLink(id: SlotId, cfg: SlotConfig): string | null {
    if (!cfg.serverHost.trim() || !cfg.channel.trim()) return null;
    const host = cfg.serverHost.trim();
    const nick = cfg.nickname.trim() || `MF Listener ${id}`;
    const channel = cfg.channel.trim().split("/").map(encodeURIComponent).join("/");
    return `ts3server://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}?port=${cfg.serverPort}&nickname=${encodeURIComponent(nick)}&channel=${channel}`;
  }

  private tabTeam(t: Tab): { slot: SlotId; id: string | null; name: string | null } | null {
    if (!t.slot) return null;
    const id = this.slots[t.slot].teamId;
    return { slot: t.slot, id, name: id ? (this.o.roster.team(id)?.name ?? null) : null };
  }

  private tabView(t: Tab) {
    const c = t.conn;
    return {
      key: t.key,
      schid: t.schid,
      status: c?.statusName ?? "unknown",
      error: c?.errorText ?? null,
      teamspeakRefused: t.tsError,
      server: c?.server ? { uid: c.server.uid, name: c.server.name, host: c.server.host, port: c.server.port } : null,
      channel: c?.channel ?? null,
      listener: c?.self ? { clientId: c.self.clientId, nickname: c.self.nickname, inputMuted: c.self.inputMuted === 1, inputDeactivated: c.self.inputDeactivated === 1, outputMuted: c.self.outputMuted === 1, recording: c.self.recording === 1 } : null,
      managed: c?.managed ?? null,
      slot: t.slot,
      /** The team this tab is (slot A or B's), in words. */
      team: this.tabTeam(t),
      capturing: t.capturing,
      restoredByPlugin: t.restoredByPlugin,
      released: t.released,
      clients: t.clients.size,
      audioBlocks: t.audio,
      ignored: { ...t.ignored },
    };
  }

  private personView(p: Person) {
    const r = p.teamId ? this.records[p.key] : undefined;
    const player = r?.playerId ? this.o.roster.player(r.playerId) : null;
    const st = p.buffer.stats();
    const now = this.o.now();
    return {
      key: p.key,
      slot: p.slot,
      teamId: p.teamId,
      uid: p.uid,
      nickname: p.nickname,
      clientId: p.clientId,
      present: p.present,
      saved: !!r,
      displayName: r?.displayName ?? player?.displayName ?? p.nickname,
      playerId: r?.playerId ?? null,
      pictureUrl: player ? this.o.roster.assetUrl(player.avatarAssetId) : null,
      includeBroadcast: !!r?.includeBroadcast,
      includeRecording: !!r?.includeRecording,
      levelDb: r?.levelDb ?? 0,
      preview: !!r?.preview,
      incoming: { db: p.incoming.atMs !== null && now - p.incoming.atMs < 300 ? p.incoming.db : -100, talking: p.incoming.talking },
      delayed: p.delayed,
      buffer: { heldMs: Math.round(sampleToMs(st.samples)), bytes: st.bytes, chunks: st.chunks, lateMs: Math.round(sampleToMs(st.late)), reanchors: st.reanchors },
    };
  }

  status() {
    const bytes = [...this.people.values()].reduce((s, p) => s + p.buffer.bytes, 0);
    const pub = this.mixer.publicGate;
    const pubSlot = pub.target ? this.slotOfTeam(pub.target) : null;
    const pubReady = pub.target ? this.readyAt(pub.target, msToSample(this.o.now() - this.delayMs)) : false;
    return {
      enabled: this.cfg.enabled,
      settings: this.settings(),
      delay: this.delay(),
      bridge: {
        ...(this.bridge?.status() ?? { state: this.bridgeError ? "error" : "stopped", port: null, error: this.bridgeError, sessions: 0, refused: { auth: 0, foreign: 0, full: 0 }, staleClosed: 0, stalls: 0 }),
        file: this.bridgeFile(),
        plugins: (this.bridge?.sessions() ?? []).map((s) => ({
          session: s.id,
          instance: s.instance,
          plugin: s.hello?.plugin ?? null,
          ts3: s.hello?.ts3 ?? null,
          platform: s.hello?.platform ?? null,
          connectedForMs: Math.round(this.o.now() - s.connectedAt),
          counters: { ...s.counters },
          lastError: s.lastError,
          clock: s.clock.status(),
          outboundBytes: s.outbound,
          pluginStats: s.lastStats ? { queue: s.lastStats.queue, sent: s.lastStats.sent, discardedOffline: s.lastStats.discardedOffline, unknownClient: s.lastStats.unknownClient, otherChannel: s.lastStats.otherChannel, recording: s.lastStats.recording, connections: s.lastStats.connections } : null,
        })),
      },
      slots: SLOT_IDS.map((id) => this.slotView(id)),
      tabs: [...this.tabs.values()].map((t) => this.tabView(t)),
      participants: [...this.people.values()].map((p) => this.personView(p)),
      public: { team: pub.target, heard: pub.current, gain: Number(pub.gain.toFixed(3)), state: !pub.target ? "off" : !pubSlot ? "fault" : pubReady ? "listening" : "buffering", closed: this.publicClosed },
      recording: { team: this.mixer.recordingGate.target, signal: this.recordingSignal },
      memory: { bytes, capBytes: this.cfg.maxBufferMB * 1024 * 1024, drops: this.counters.memoryDrops, droppedBytes: this.counters.memoryDroppedBytes },
      mixer: { blocks: this.counters.blocks, skippedBlocks: this.counters.skippedBlocks, nextBlockMs: this.nextBlock === null ? null : sampleToMs(this.nextBlock) },
    };
  }

  /** For the support file: no passwords, no token, identities shortened. */
  diagnostics() {
    const st = this.status();
    return {
      ...st,
      participants: st.participants.map((p) => ({ ...p, uid: shortUid(p.uid), key: `${p.teamId ?? p.slot}/…/${shortUid(p.uid)}` })),
      savedParticipants: Object.keys(this.records).length,
    };
  }
}
