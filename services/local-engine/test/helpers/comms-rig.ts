import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Match, Player, Team } from "@matchframe/contracts";
import { SecretStore } from "../../src/auth.ts";
import { Database } from "../../src/db/database.ts";
import { SettingsRepo } from "../../src/db/store.ts";
import { Logger } from "../../src/logger.ts";
import { BLOCK } from "../../src/comms/mixer.ts";
import { TeamComms } from "../../src/comms/service.ts";
import { FakeTs3Plugin, peakAmplitude, tone, until, type FakeClient } from "./fake-ts3-plugin.ts";

/**
 * The Team Comms fixture rig (ADR-065, ADR-066): the real bridge over TCP, a stand-in TeamSpeak
 * plugin and the engine's timeline simulated (`now`). Each person speaks a tone of their own; what
 * each output holds is measured per frequency. Routing and timing evidence, not TeamSpeak capture.
 */

export const TEAM_A = "team-alpha";
export const TEAM_B = "team-bravo";
export const FA = [330, 470, 610, 750, 890, 1030, 1170];
export const FB = [1310, 1450, 1590, 1730, 1870, 2010, 2150];
/** Each voice's tone (seven of them sum to 0.84, under full scale). */
export const AMP = 0.12;
/** A tone at this amplitude in an output is "there"; below QUIET it is not. */
export const PRESENT = 0.06;
export const QUIET = 0.002;

export interface Person extends FakeClient {
  freq: number;
  schid: number;
}

export class Rig {
  sim = 1_000_000;
  rendered = 1_000_000;
  comms!: TeamComms;
  plugin!: FakeTs3Plugin;
  readonly dir = mkdtempSync(join(tmpdir(), "mf-comms-"));
  readonly settings: SettingsRepo;
  readonly secrets: SecretStore;
  readonly a: Person[] = FA.map((freq, i) => ({ clientId: 10 + i, uid: `uidA${i + 1}AAAAAAAAAAAAAAAAAAAAAA=`, nickname: `Alpha ${i + 1}`, freq, schid: 1 }));
  readonly b: Person[] = FB.map((freq, i) => ({ clientId: 30 + i, uid: `uidB${i + 1}BBBBBBBBBBBBBBBBBBBBBB=`, nickname: `Bravo ${i + 1}`, freq, schid: 2 }));
  readonly listenerA: FakeClient = { clientId: 2, uid: "listenerUidXXXXXXXXXXXXXXXXX=", nickname: "MF Listener A" };
  readonly listenerB: FakeClient = { clientId: 3, uid: "listenerUidXXXXXXXXXXXXXXXXX=", nickname: "MF Listener B" };
  /** Every rendered block per output: start sample → samples. */
  readonly out = { public: new Map<number, Float32Array>(), recording: new Map<number, Float32Array>(), preview: new Map<number, Float32Array>() };
  readonly activity = new Map<number, { recording: Map<string, { db: number; speaking: boolean }>; pubTeam: string | null }>();
  /** Where each person's tone is in its phase (continuous across blocks), and who talked in the last block. */
  private phase = new Map<string, number>();
  private talking = new Set<string>();
  match: Match = { id: "m1", eventId: null, stageId: null, teamAId: TEAM_A, teamBId: TEAM_B, format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, status: "live", scheduledAt: null, seriesScoreA: 0, seriesScoreB: 0, mapPool: [], vetoSequenceId: null, title: null };
  players = new Map<string, Player>();

  constructor() {
    const db = new Database(":memory:");
    db.migrate();
    this.settings = new SettingsRepo(db);
    this.secrets = new SecretStore(join(this.dir, "secrets.json"), undefined);
  }

  async start(o: { delaySec?: number; fineMs?: number; slots?: boolean; staleMs?: number } = {}): Promise<void> {
    this.staleMs = o.staleMs;
    this.realJump = 0;
    const teams: Record<string, Team> = {
      [TEAM_A]: { id: TEAM_A, name: "Alpha Wolves", shortName: "ALP", logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false },
      [TEAM_B]: { id: TEAM_B, name: "Bravo Hawks", shortName: "BRV", logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false },
    };
    this.teams = teams;
    this.makeComms();
    if (o.slots !== false) {
      this.comms.updateSlot("A", { channel: "Team Alpha", serverHost: "ts.example.org", serverPort: 9987, serverPassword: "s3cret-server-pw" });
      this.comms.updateSlot("B", { channel: "Team Bravo", serverHost: "ts.example.org", serverPort: 9987, channelPassword: "s3cret-channel-pw" });
    }
    await this.comms.updateSettings({ enabled: true, bridgePort: 0, delaySec: o.delaySec ?? 0, fineMs: o.fineMs ?? 0 });
    this.comms.renderUntil(this.sim);
    this.plugin = new FakeTs3Plugin(this.port, this.token, () => this.sim);
    await this.plugin.connect();
    await until(() => this.plugin.welcomed, 3000, "WELCOME");
  }

  private teams: Record<string, Team> = {};
  private staleMs: number | undefined;
  /** Added to the computer's clock the bridge's liveness reads (a test moves it: MatchFrame not running for a while). */
  realJump = 0;

  private makeComms(): void {
    const teams = this.teams;
    this.comms = new TeamComms({
      settings: this.settings,
      secrets: this.secrets,
      logger: new Logger("error", null),
      dataDir: this.dir,
      now: () => this.sim,
      roster: { activeMatch: () => this.match, team: (id) => teams[id] ?? null, player: (id) => this.players.get(id) ?? null, assetUrl: (id) => (id ? `/assets/${id}` : null) },
      realtime: false,
      // Pings answered while the simulated clock stands still (during the awaits) set the plugin's clock exactly.
      pingMs: 20,
      staleMs: this.staleMs,
      realNow: () => performance.now() + this.realJump,
    });
    for (const name of ["public", "recording", "preview"] as const) this.comms.addSink(name, { write: (b, start) => this.out[name].set(start, Float32Array.from(b)) });
    this.comms.onBlock((b) => this.activity.set(b.start, { recording: b.activity.recording, pubTeam: b.public.team }));
  }

  /** MatchFrame restarts (a new Team Comms on the same settings and secrets): a new bridge port in the bridge file. TeamSpeak keeps running. */
  async restartEngine(): Promise<void> {
    await this.comms.stop();
    this.makeComms();
    await this.comms.start();
    this.comms.renderUntil(this.sim);
  }

  get port(): number {
    return this.comms.status().bridge.port!;
  }

  get token(): string {
    return this.secrets.getSecret("comms.bridgeToken")!;
  }

  async openTabs(): Promise<void> {
    const server = { uid: "serverUid=", name: "Scrim server", host: "ts.example.org", port: 9987 };
    this.plugin.openTab({ schid: 1, server, channel: { id: 11, name: "Team Alpha" }, self: this.listenerA, clients: this.a.map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })) });
    this.plugin.openTab({ schid: 2, server, channel: { id: 12, name: "Team Bravo" }, self: this.listenerB, clients: this.b.map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })) });
    await until(() => this.plugin.capturing(1) && this.plugin.capturing(2), 3000, "both tabs captured");
    await until(() => this.comms.status().slots.every((s) => s.tab?.capturing), 3000, "coverage started");
    await until(() => this.comms.status().participants.length === 14, 3000, "14 people");
    await this.clockSet();
  }

  /** Until a ping has set the plugin's clock (as the real bridge does within a second). */
  async clockSet(): Promise<void> {
    await until(() => this.comms.status().bridge.plugins.every((p) => p.clock.source === "ping"), 3000, "clock from pings");
  }

  key(p: Person): string {
    return this.comms.status().participants.find((x) => x.uid === p.uid)!.key;
  }

  set(p: Person, patch: Parameters<TeamComms["updateParticipant"]>[1]): void {
    this.comms.updateParticipant(this.key(p), patch);
  }

  /**
   * Advances the simulated clock by `ms`, the plugin sending 20 ms blocks for whoever `talking(t)`
   * says talks at t (ms since the call), stamped with their time and sent no earlier than that time.
   */
  async run(ms: number, talking: (t: number) => Person[] = () => [], opts: { batchMs?: number; rate?: number } = {}): Promise<void> {
    const step = 20;
    const batch = opts.batchMs ?? 500;
    const rate = opts.rate ?? 48000;
    const t0 = this.sim;
    let sent = this.plugin.connected ? this.comms.status().bridge.plugins[0]?.counters.audioFrames ?? 0 : 0;
    for (let b = 0; b < ms; b += batch) {
      let count = 0;
      let lastSent = this.sim;
      for (let t = b; t < Math.min(ms, b + batch); t += step) {
        // The plugin stamps a block when TeamSpeak hands it over and sends it then.
        this.sim = t0 + t;
        const next = new Set(talking(t + step).map((p) => p.uid));
        for (const p of talking(t)) {
          const from = this.phase.get(p.uid) ?? 0;
          const n = (step * rate) / 1000;
          // Like a voice, a sentence starts and ends over a few ms (no click to read as every frequency).
          const pcm = tone(p.freq, step, rate, AMP, from);
          const ramp = Math.round(rate / 200);
          if (!this.talking.has(p.uid)) for (let i = 0; i < ramp; i++) pcm[i] = Math.round(pcm[i]! * (0.5 - 0.5 * Math.cos((Math.PI * i) / ramp)));
          if (!next.has(p.uid)) for (let i = 0; i < ramp; i++) pcm[n - 1 - i] = Math.round(pcm[n - 1 - i]! * (0.5 - 0.5 * Math.cos((Math.PI * i) / ramp)));
          if (this.plugin.audio(p.schid, p.clientId, pcm, this.sim, { rate })) {
            count++;
            lastSent = this.sim;
          }
          this.phase.set(p.uid, from + n);
        }
        this.talking = new Set(talking(t).map((p) => p.uid));
      }
      sent += count;
      const want = sent;
      // Everything sent arrives while the clock shows the last block's time (never before its stamp).
      this.sim = lastSent;
      if (count) await until(() => (this.comms.status().bridge.plugins[0]?.counters.audioFrames ?? 0) >= want, 3000, "audio arrived");
      // The engine renders every 5 ms; here at most 100 ms at a time (it skips what is more than 500 ms behind).
      const end = t0 + Math.min(ms, b + batch);
      for (let at = Math.min(end, this.rendered + 100); at <= end; at = Math.min(end, at + 100)) {
        this.sim = at;
        this.comms.renderUntil(at);
        this.rendered = at;
        if (at === end) break;
      }
    }
  }

  /** An output's samples between two output times (ms on the engine timeline). */
  slice(name: "public" | "recording" | "preview", fromMs: number, toMs: number): Float32Array {
    const from = Math.round(fromMs * 48);
    const to = Math.round(toMs * 48);
    const out = new Float32Array(Math.max(0, to - from));
    for (const [start, b] of this.out[name]) {
      if (start + BLOCK <= from || start >= to) continue;
      for (let i = 0; i < BLOCK; i++) {
        const s = start + i;
        if (s >= from && s < to) out[s - from] = b[i]!;
      }
    }
    return out;
  }

  /** The tones heard in an output between two times: person → their loudest amplitude in 100 ms windows. */
  heard(name: "public" | "recording" | "preview", fromMs: number, toMs: number, who: Person[] = [...this.a, ...this.b]): Map<string, number> {
    const x = this.slice(name, fromMs, toMs);
    return new Map(who.map((p) => [p.nickname, peakAmplitude(x, p.freq)]));
  }

  async stop(): Promise<void> {
    this.plugin?.kill();
    await this.comms?.stop();
  }
}
