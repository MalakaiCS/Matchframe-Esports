import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Match, Player, Team } from "@matchframe/contracts";
import { SecretStore } from "../src/auth.ts";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { Logger } from "../src/logger.ts";
import { BLOCK } from "../src/comms/mixer.ts";
import { TeamComms } from "../src/comms/service.ts";
import { encodeAudio, encodeFrame, encodeJson, FrameReader, MsgType } from "../src/comms/wire.ts";
import { amplitudeAt, FakeTs3Plugin, peakAmplitude, tone, until, type FakeClient } from "./helpers/fake-ts3-plugin.ts";

/**
 * Team Comms fixture tests (ADR-065): the real bridge over TCP, a stand-in TeamSpeak plugin, and
 * the engine's timeline simulated (`now`). Each person speaks a tone of their own; what each output
 * holds is measured per frequency. This is routing and timing evidence, not TeamSpeak capture.
 */

const TEAM_A = "team-alpha";
const TEAM_B = "team-bravo";
const FA = [330, 470, 610, 750, 890, 1030, 1170];
const FB = [1310, 1450, 1590, 1730, 1870, 2010, 2150];
/** Each voice's tone (seven of them sum to 0.84, under full scale). */
const AMP = 0.12;
/** A tone at this amplitude in an output is "there"; below QUIET it is not. */
const PRESENT = 0.06;
const QUIET = 0.002;

interface Person extends FakeClient {
  freq: number;
  schid: number;
}

class Rig {
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

  async start(o: { delaySec?: number; fineMs?: number; slots?: boolean } = {}): Promise<void> {
    const teams: Record<string, Team> = {
      [TEAM_A]: { id: TEAM_A, name: "Alpha Wolves", shortName: "ALP", logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false },
      [TEAM_B]: { id: TEAM_B, name: "Bravo Hawks", shortName: "BRV", logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false },
    };
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
    });
    for (const name of ["public", "recording", "preview"] as const) this.comms.addSink(name, { write: (b, start) => this.out[name].set(start, Float32Array.from(b)) });
    this.comms.onBlock((b) => this.activity.set(b.start, { recording: b.activity.recording, pubTeam: b.public.team }));
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

const rigs: Rig[] = [];
const rig = () => {
  const r = new Rig();
  rigs.push(r);
  return r;
};
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.stop();
});

const present = (m: Map<string, number>) => [...m].filter(([, v]) => v > PRESENT).map(([k]) => k).sort();
const absent = (m: Map<string, number>, names: string[]) => names.every((n) => (m.get(n) ?? 0) < QUIET);

describe("Team Comms: bridge, identities, buffers and mixes (stand-in plugin, simulated clock)", () => {
  it("two teams of seven speaking over each other: every person kept apart by identity, each team only in its own team's outputs", async () => {
    const r = rig();
    await r.start({ delaySec: 1 });
    await r.openTabs();
    const st = r.comms.status();
    // 14 people, by identity, in the slot of their own tab; the listeners are nobody.
    expect(st.participants.map((p) => `${p.slot}:${p.nickname}`).sort()).toEqual([...r.a.map((p) => `A:${p.nickname}`), ...r.b.map((p) => `B:${p.nickname}`)].sort());
    expect(st.participants.some((p) => p.uid === r.listenerA.uid)).toBe(false);
    expect(st.participants.every((p) => p.key.startsWith(p.slot === "A" ? `${TEAM_A}/serverUid=/` : `${TEAM_B}/serverUid=/`))).toBe(true);
    // Everyone new starts excluded from every output.
    expect(st.participants.every((p) => !p.includeBroadcast && !p.includeRecording && !p.preview)).toBe(true);
    // The plugin was told: capture, listen-only, silent here.
    expect(r.plugin.managed.get(1)).toEqual({ capture: true, listenOnly: true, suppressPlayback: true });
    for (const p of [...r.a, ...r.b]) r.set(p, { includeRecording: true, includeBroadcast: true });
    r.comms.setRecordingTeam(TEAM_A);
    r.comms.setPublicTeam(TEAM_B);
    // Not ready until 1 s of history: the first second is silence whatever was said.
    const t0 = r.sim;
    // Everyone talks 300 ms in every 700 ms, offset by person: 3 to 4 at once in each team.
    await r.run(4000, (t) => [...r.a, ...r.b].filter((p, i) => (t + i * 100) % 700 < 300));
    expect(present(r.heard("recording", t0, t0 + 1000))).toEqual([]);
    const rec = r.heard("recording", t0 + 1300, t0 + 4000);
    const pub = r.heard("public", t0 + 1300, t0 + 4000);
    expect(present(rec)).toEqual(r.a.map((p) => p.nickname).sort());
    expect(absent(rec, r.b.map((p) => p.nickname))).toBe(true);
    expect(present(pub)).toEqual(r.b.map((p) => p.nickname).sort());
    expect(absent(pub, r.a.map((p) => p.nickname))).toBe(true);
    // Each person's buffer holds their own tone only (soloed one at a time in the preview).
    for (const p of [r.a[2]!, r.b[5]!]) {
      r.set(p, { preview: true });
      const from = r.sim;
      await r.run(2500, (t) => [...r.a, ...r.b].filter((q, i) => (t + i * 100) % 700 < 300));
      const prev = r.heard("preview", from + 1100, from + 2500);
      expect(present(prev)).toEqual([p.nickname]);
      r.set(p, { preview: false });
    }
  });

  it("five included and two excluded: the two are absent from the mix even while an included person speaks", async () => {
    const r = rig();
    await r.start({ delaySec: 0, fineMs: 500 });
    await r.openTabs();
    for (const p of r.a.slice(0, 5)) r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    const t0 = r.sim;
    // All seven talk at once, all the time.
    await r.run(3000, () => r.a);
    const rec = r.heard("recording", t0 + 800, t0 + 3000);
    expect(present(rec)).toEqual(r.a.slice(0, 5).map((p) => p.nickname));
    expect(absent(rec, ["Alpha 6", "Alpha 7"])).toBe(true);
  });

  it("broadcast and recording selections are independent of each other", async () => {
    const r = rig();
    await r.start({ fineMs: 300 });
    await r.openTabs();
    for (const p of r.a.slice(0, 5)) r.set(p, { includeRecording: true });
    for (const p of [r.a[0]!, r.a[1]!, r.a[5]!]) r.set(p, { includeBroadcast: true });
    r.comms.setRecordingTeam(TEAM_A);
    r.comms.setPublicTeam(TEAM_A);
    const t0 = r.sim;
    await r.run(2500, () => r.a);
    expect(present(r.heard("recording", t0 + 600, t0 + 2500))).toEqual(["Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Alpha 5"]);
    expect(present(r.heard("public", t0 + 600, t0 + 2500))).toEqual(["Alpha 1", "Alpha 2", "Alpha 6"]);
    // Changing one leaves the other as it was.
    r.set(r.a[5]!, { includeRecording: true });
    const t1 = r.sim;
    await r.run(1000, () => r.a);
    expect(present(r.heard("recording", t1 + 100, t1 + 1000))).toEqual(["Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Alpha 5", "Alpha 6"]);
    expect(present(r.heard("public", t1 + 100, t1 + 1000))).toEqual(["Alpha 1", "Alpha 2", "Alpha 6"]);
    // The saved choices survive a restart of the engine (by identity).
    const saved = r.settings.get<Record<string, { includeRecording: boolean; includeBroadcast: boolean }>>("comms.participants", {});
    expect(saved[`${TEAM_A}/serverUid=/${r.a[5]!.uid}`]).toMatchObject({ includeRecording: true, includeBroadcast: true });
  });

  it("unchecking someone removes their buffered speech at once: one block and a fade, not the delay", async () => {
    const r = rig();
    await r.start({ delaySec: 10 });
    await r.openTabs();
    const p = r.a[0]!;
    r.set(p, { includeRecording: true, includeBroadcast: true });
    r.comms.setRecordingTeam(TEAM_A);
    const talkFrom = r.sim;
    // 10.5 s of history, then Alpha 1 talks for 5 s: all of it buffered when the output reaches it.
    await r.run(10_500);
    await r.run(5000, () => [p]);
    await r.run(7000);
    // The output reaches their speech 10 s later; 2 s into it, they are unchecked.
    const speechOut = talkFrom + 10_500 + 10_000;
    expect(r.comms.status().participants.find((x) => x.uid === p.uid)!.buffer.heldMs).toBeGreaterThan(2500);
    expect(r.heard("recording", speechOut + 100, speechOut + 2000).get("Alpha 1")).toBeGreaterThan(PRESENT);
    r.set(p, { includeRecording: false });
    const cut = r.sim;
    await r.run(3000);
    // The next block fades out (10 ms); from then on nothing, though 3 s of their speech were still buffered.
    const per = (from: number) => amplitudeAt(r.slice("recording", from, from + 10), p.freq);
    expect(per(cut - 10)).toBeGreaterThan(PRESENT);
    expect(r.heard("recording", cut + 20, cut + 3000).get("Alpha 1")).toBeLessThan(QUIET);
    // The broadcast choice was not touched (and the public listen-in is closed anyway).
    expect(r.comms.participantRecord(r.key(p))!.includeBroadcast).toBe(true);
  });

  it("a 90 s delay: the voice and its speaking activity come out 90 s after TeamSpeak played it, not before the buffer holds 90 s", async () => {
    const r = rig();
    await r.start({ delaySec: 90 });
    await r.openTabs();
    const p = r.a[2]!;
    r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    const t0 = r.sim;
    // Buffering: 90 s of history are needed before anything plays.
    expect(r.comms.status().slots[0]).toMatchObject({ state: "buffering", ready: false });
    // Alpha 3 talks at 30.0–30.6 s and 89.0–89.4 s after the tab was captured.
    const bursts = [[30_000, 30_600], [89_000, 89_400]] as const;
    await r.run(95_000, (t) => (bursts.some(([a, b]) => t >= a && t < b) ? [p] : []), { batchMs: 1000 });
    expect(r.comms.status().slots[0]!.ready).toBe(true);
    // Nothing came out early: the first 90 s (and the plugin's undelayed audio) never reached the output.
    expect(r.heard("recording", t0, t0 + 90_000).get("Alpha 3")).toBeLessThan(QUIET);
    await r.run(90_000, () => [], { batchMs: 5000 });
    for (const [a, b] of bursts) {
      // Onset: within one block of capture + 90 s (the coverage started a little after t0).
      const blocks = [...r.out.recording.keys()].sort((x, y) => x - y);
      const loud = blocks.filter((s) => s / 48 >= t0 + a + 90_000 - 50 && s / 48 < t0 + b + 90_000 + 50 && amplitudeAt(r.out.recording.get(s)!, p.freq) > PRESENT);
      expect(loud.length).toBeGreaterThan(0);
      const onsetErr = loud[0]! / 48 - (t0 + a + 90_000);
      const endErr = (loud[loud.length - 1]! + BLOCK) / 48 - (t0 + b + 90_000);
      expect(Math.abs(onsetErr)).toBeLessThanOrEqual(10);
      expect(Math.abs(endErr)).toBeLessThanOrEqual(10);
      // Speaking activity starts from the samples mixed, in the same block or the next.
      const speak = blocks.filter((s) => s >= loud[0]! - BLOCK && s <= loud[0]! + 3 * BLOCK && [...(r.activity.get(s)?.recording.entries() ?? [])].some(([k, v]) => k.endsWith(p.uid) && v.speaking));
      expect(speak.length).toBeGreaterThan(0);
      expect(speak[0]! - loud[0]!).toBeLessThanOrEqual(BLOCK);
      // ...and not before the audio.
      const early = blocks.filter((s) => s < loud[0]! - BLOCK && s > loud[0]! - 100 * 48 && [...(r.activity.get(s)?.recording.entries() ?? [])].some(([k, v]) => k.endsWith(p.uid) && v.speaking));
      expect(early).toEqual([]);
    }
    // Bounded: what is kept is the delay plus a margin, not everything.
    const held = r.comms.status().participants.find((x) => x.uid === p.uid)!.buffer;
    expect(held.heldMs).toBeLessThan(1100);
  });

  it("reconnects: new session ids keep each identity's choices; the public listen-in closes on the loss and is not reopened", async () => {
    const r = rig();
    await r.start({ fineMs: 400 });
    await r.openTabs();
    const p = r.a[1]!;
    r.set(p, { includeBroadcast: true, levelDb: -6 });
    r.comms.setPublicTeam(TEAM_A);
    const t0 = r.sim;
    await r.run(2000, () => [p]);
    // At -6 dB: half the tone's amplitude.
    expect(r.heard("public", t0 + 500, t0 + 2000).get("Alpha 2")).toBeCloseTo(AMP / 2, 2);
    // Alpha 2 leaves and comes back with a new session id (same identity).
    r.plugin.leave(1, p.clientId);
    await until(() => !r.comms.status().participants.find((x) => x.uid === p.uid)!.present, 3000, "left");
    const moved: Person = { ...p, clientId: 77 };
    r.plugin.join(1, { clientId: 77, uid: p.uid, nickname: p.nickname });
    await until(() => r.comms.status().participants.find((x) => x.uid === p.uid)!.clientId === 77, 3000, "rejoined");
    expect(r.comms.status().participants.filter((x) => x.uid === p.uid)).toHaveLength(1);
    const t1 = r.sim;
    await r.run(2000, () => [moved]);
    expect(r.heard("public", t1 + 500, t1 + 2000).get("Alpha 2")).toBeGreaterThan(PRESENT);
    // The plugin's connection drops: the public listen-in closes and stays closed.
    r.plugin.kill();
    await until(() => r.comms.status().public.team === null, 3000, "public closed");
    expect(r.comms.status().public.closed?.reason).toMatch(/lost/);
    // TeamSpeak reconnects the tab, every session id new; the plugin reconnects.
    await r.plugin.connect();
    await until(() => r.plugin.welcomed, 3000, "welcome");
    r.plugin.tabs.clear();
    const server = { uid: "serverUid=", name: "Scrim server", host: "ts.example.org", port: 9987 };
    const again = r.a.map((x, i) => ({ ...x, clientId: 200 + i }));
    r.plugin.openTab({ schid: 1, server, channel: { id: 11, name: "Team Alpha" }, self: { ...r.listenerA, clientId: 199 }, clients: again.map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })) });
    await until(() => r.plugin.capturing(1), 3000, "captured again");
    await until(() => r.comms.status().participants.find((x) => x.uid === p.uid)!.clientId === 201, 3000, "re-resolved");
    const st = r.comms.status();
    expect(st.participants.filter((x) => x.slot === "A")).toHaveLength(7);
    expect(st.participants.find((x) => x.uid === p.uid)).toMatchObject({ includeBroadcast: true, levelDb: -6, clientId: 201 });
    const t2 = r.sim;
    await r.run(2000, () => [again[1]!]);
    // Ready again (after the 400 ms delay), the recording would hear it — but the public stays closed until a new Listen In.
    expect(r.comms.status().public.team).toBeNull();
    // (The first 40 ms are the close's fade, rendered after the loss.)
    expect(r.heard("public", t2 + 50, t2 + 2000).get("Alpha 2")).toBeLessThan(QUIET);
  });

  it("an unknown identity stays excluded, also when a known nickname comes back with a new identity", async () => {
    const r = rig();
    await r.start({ fineMs: 300 });
    await r.openTabs();
    for (const p of r.a) r.set(p, { includeRecording: true, includeBroadcast: true });
    r.comms.setRecordingTeam(TEAM_A);
    r.comms.setPublicTeam(TEAM_A);
    const stranger: Person = { clientId: 90, uid: "strangerUidZZZZZZZZZZZZZZZZ=", nickname: "Alpha 1", freq: 2500, schid: 1 };
    r.plugin.join(1, stranger);
    await until(() => r.comms.status().participants.length === 15, 3000, "stranger seen");
    const s = r.comms.status().participants.find((x) => x.uid === stranger.uid)!;
    expect(s).toMatchObject({ includeBroadcast: false, includeRecording: false, preview: false, saved: true });
    const t0 = r.sim;
    await r.run(2000, () => [r.a[0]!, stranger]);
    for (const name of ["recording", "public"] as const) {
      const x = r.slice(name, t0 + 500, t0 + 2000);
      expect(amplitudeAt(x, stranger.freq)).toBeLessThan(QUIET);
      expect(amplitudeAt(x, r.a[0]!.freq)).toBeGreaterThan(PRESENT);
    }
  });

  it("silence on bridge loss: public at once, the recording once its buffered audio is used up; never undelayed audio", async () => {
    const r = rig();
    await r.start({ delaySec: 2 });
    await r.openTabs();
    const p = r.a[3]!;
    r.set(p, { includeRecording: true, includeBroadcast: true });
    r.comms.setRecordingTeam(TEAM_A);
    r.comms.setPublicTeam(TEAM_A);
    await r.run(2500);
    const t0 = r.sim;
    await r.run(3000, () => [p]);
    const lost = r.sim;
    r.plugin.kill();
    await until(() => r.comms.status().slots[0]!.lost !== null, 3000, "loss seen");
    await r.run(4000);
    // Public: the listen-in closed within its 40 ms fade.
    expect(r.heard("public", t0 + 2500, lost).get("Alpha 4")).toBeGreaterThan(PRESENT);
    expect(r.heard("public", lost + 50, lost + 4000).get("Alpha 4")).toBeLessThan(QUIET);
    // Recording: what was buffered before the loss still plays (2 s), then silence.
    expect(r.heard("recording", lost + 100, lost + 1900).get("Alpha 4")).toBeGreaterThan(PRESENT);
    expect(r.heard("recording", lost + 2050, lost + 4000).get("Alpha 4")).toBeLessThan(QUIET);
    const st = r.comms.status();
    expect(st.slots[0]).toMatchObject({ ready: false });
    expect(st.public).toMatchObject({ team: null, state: "off" });
  });

  it("halftime: teams are slots by team id, so a side swap changes nothing (the module never reads CT/T)", async () => {
    const r = rig();
    await r.start({ fineMs: 300 });
    await r.openTabs();
    r.set(r.a[0]!, { includeBroadcast: true });
    r.comms.setPublicTeam(TEAM_A);
    const before = r.comms.status().slots.map((s) => s.team?.id);
    // A halftime is only a side change in the game data; the match's team A/B never move.
    r.match = { ...r.match };
    r.comms.refreshTeams();
    expect(r.comms.status().slots.map((s) => s.team?.id)).toEqual(before);
    expect(before).toEqual([TEAM_A, TEAM_B]);
    const t0 = r.sim;
    await r.run(1500, () => [r.a[0]!, r.b[0]!]);
    const pub = r.heard("public", t0 + 400, t0 + 1500);
    expect(pub.get("Alpha 1")).toBeGreaterThan(PRESENT);
    expect(pub.get("Bravo 1")).toBeLessThan(QUIET);
  });

  it("delay changes mute, re-buffer and resync; a source at 44.1 kHz is converted on the same timeline", async () => {
    const r = rig();
    await r.start({ delaySec: 1 });
    await r.openTabs();
    const p = r.a[0]!;
    r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(2000, () => [p]);
    expect(r.comms.status().slots[0]!.ready).toBe(true);
    await r.comms.updateSettings({ delaySec: 3 });
    const change = r.sim;
    await r.run(500, () => [p]);
    // The longer delay re-buffers: history before the change was only kept for 1 s plus the margin.
    expect(r.comms.status().delay.effectiveMs).toBe(3000);
    await r.run(4500, () => [p]);
    expect(r.comms.status().slots[0]!.ready).toBe(true);
    expect(r.heard("recording", change + 4500, change + 5000).get("Alpha 1")).toBeGreaterThan(PRESENT);
    // 44.1 kHz blocks: placed and converted (the tone stays at its frequency).
    const q = r.a[1]!;
    r.set(q, { includeRecording: true });
    const t0 = r.sim;
    await r.run(6000, () => [q], { rate: 44_100 });
    const x = r.slice("recording", t0 + 3200, t0 + 5800);
    expect(amplitudeAt(x, q.freq)).toBeGreaterThan(PRESENT);
  });

  it("bridge security and validation: token, HELLO first, format, rate, channels and length checked; the listener never a source", async () => {
    const r = rig();
    await r.start();
    // A wrong token is refused.
    const bad = new FakeTs3Plugin(r.port, "0".repeat(48), () => r.sim);
    await bad.connect();
    await until(() => bad.errors.length > 0, 3000, "refusal");
    expect(bad.errors[0]).toMatch(/unauthorized/);
    await until(() => !bad.connected, 3000, "closed");
    expect(r.comms.status().bridge.refused.auth).toBe(1);
    // Anything but HELLO first is refused; so is a stream that isn't MFTC.
    for (const first of [encodeAudio({ schid: 1, captureUs: 0, seq: 0, sampleRate: 48000, clientId: 1, ownClientId: 2, channels: 1, part: 0, uid: "x", pcm: new Int16Array(480) }), Buffer.from("GET / HTTP/1.1\r\n\r\n")]) {
      const reply = await new Promise<string>((resolve) => {
        const s = connect({ host: "127.0.0.1", port: r.port }, () => s.write(first));
        const reader = new FrameReader();
        let text = "";
        s.on("data", (c: Buffer) => {
          try {
            for (const f of reader.push(c)) if (f.type === MsgType.ERROR) text = f.payload.toString();
          } catch {
            text = "bad";
          }
        });
        s.on("close", () => resolve(text));
      });
      expect(reply).toMatch(/HELLO|MFTC/);
    }
    // Audio with another format, rate or channel count, or a length that doesn't add up: dropped, counted, named.
    await r.openTabs();
    const before = r.comms.status().bridge.plugins[0]!.counters.invalid;
    const base = { schid: 1, captureUs: r.plugin.pluginUs(), seq: 1, clientId: r.a[0]!.clientId, ownClientId: 2, part: 0, uid: r.a[0]!.uid };
    r.plugin.send(encodeAudio({ ...base, sampleRate: 22_050, channels: 1, pcm: new Int16Array(441) }));
    r.plugin.send(encodeAudio({ ...base, sampleRate: 48_000, channels: 1, pcm: new Int16Array(480), format: 3 }));
    r.plugin.send(encodeAudio({ ...base, sampleRate: 48_000, channels: 2, pcm: new Int16Array(960) }).subarray(0, 12 + 40 + base.uid.length + 900)); // header claims more than sent: waits
    await until(() => r.comms.status().bridge.plugins[0]!.counters.invalid >= before + 2, 3000, "invalid counted");
    const err = r.comms.status().bridge.plugins[0]!.lastError!;
    expect(err.code).toBe("bad_format");
    expect(err.message).toMatch(/16-bit/);
    // The listener's own identity is never a person, even if audio claimed it.
    r.plugin.audio(1, r.a[0]!.clientId, new Int16Array(960), r.sim, { uid: r.listenerA.uid });
    await new Promise((res) => setTimeout(res, 50));
    expect(r.comms.status().participants.some((x) => x.uid === r.listenerA.uid)).toBe(false);
  });

  it("support file content: connections, people, buffers, readiness, drops and drift, with no password or token", async () => {
    const r = rig();
    await r.start({ fineMs: 500 });
    await r.openTabs();
    await r.run(1000, () => [r.a[0]!]);
    const d = JSON.stringify(r.comms.diagnostics());
    expect(d).not.toContain("s3cret-server-pw");
    expect(d).not.toContain("s3cret-channel-pw");
    expect(d).not.toContain(r.token);
    expect(d).not.toContain(r.a[0]!.uid);
    const diag = r.comms.diagnostics();
    expect(diag.slots[0]).toMatchObject({ id: "A", ready: true, serverPasswordSaved: true, channelPasswordSaved: false });
    expect(diag.bridge.plugins[0]).toMatchObject({ counters: { sequenceGaps: 0 }, clock: { source: "ping", steps: 0 } });
    expect(diag.participants.find((p) => p.nickname === "Alpha 1")!.buffer.heldMs).toBeGreaterThan(400);
    // The plugin's bridge file: port and token for this computer only.
    const file = JSON.parse(readFileSync(r.comms.bridgeFile(), "utf8"));
    expect(file).toMatchObject({ protocol: 1, host: "127.0.0.1", port: r.port, token: r.token });
    await r.comms.updateSettings({ enabled: false });
    expect(existsSync(r.comms.bridgeFile())).toBe(false);
    // Recording status signalled to TeamSpeak on the listener tabs.
    await r.comms.updateSettings({ enabled: true });
    const p2 = new FakeTs3Plugin(r.comms.status().bridge.port!, r.token, () => r.sim);
    await p2.connect();
    await until(() => p2.welcomed, 3000, "welcome");
    r.comms.setRecordingSignal(true);
    await until(() => p2.recording, 3000, "recording signal");
    p2.kill();
  });
});

describe("Team Comms wire format", () => {
  it("round-trips an AUDIO block and splits a stream at any byte", () => {
    const pcm = tone(440, 20);
    const msg = Buffer.concat([encodeAudio({ schid: 3, captureUs: 123_456_789, seq: 9, sampleRate: 48000, clientId: 7, ownClientId: 2, channels: 1, part: 0, uid: "abcDEF123+/=", pcm }), encodeJson(MsgType.EVENT, { a: 1 }), encodeFrame(MsgType.SNAPSHOT)]);
    const reader = new FrameReader();
    const frames = [];
    for (let i = 0; i < msg.length; i += 7) frames.push(...reader.push(msg.subarray(i, i + 7)));
    expect(frames.map((f) => f.type)).toEqual([MsgType.AUDIO, MsgType.EVENT, MsgType.SNAPSHOT]);
    expect(reader.pending).toBe(0);
  });

  it("rejects a header that isn't MFTC 1 or declares more than 1 MiB before buffering it", () => {
    const big = Buffer.alloc(12);
    big.write("MFTC");
    big[4] = 1;
    big[5] = MsgType.AUDIO;
    big.writeUInt32LE((1 << 20) + 1, 8);
    expect(() => new FrameReader().push(big)).toThrow(/at most/);
    const v2 = Buffer.from(big);
    v2[4] = 2;
    expect(() => new FrameReader().push(v2)).toThrow(/update the TeamSpeak plugin/);
  });
});
