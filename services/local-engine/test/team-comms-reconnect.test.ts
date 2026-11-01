import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ObsManager } from "@matchframe/obs-adapter";
import { BLOCK } from "../src/comms/mixer.ts";
import { CommsPublic } from "../src/comms/public.ts";
import { Logger } from "../src/logger.ts";
import { PRESENT, QUIET, Rig, TEAM_A, TEAM_B, type Person } from "./helpers/comms-rig.ts";
import { FakeNdiWorker } from "./helpers/fake-ndi-worker.ts";
import { FakeTs3Plugin, peakAmplitude, tone, until } from "./helpers/fake-ts3-plugin.ts";

/**
 * Team Comms phase 5 (ADR-069): reconnects and failure recovery, against the brief's acceptance rows
 * "Reconnection", "Half-time" and "Failure". Fixture tests: the real bridge over TCP, a stand-in
 * TeamSpeak plugin and a stand-in NDI process on a simulated clock. Routing and recovery evidence,
 * not TeamSpeak (the plugin binary's own restart behaviour is in team-comms-plugin.test.ts, the real
 * TeamSpeak runs in the operations document).
 */

const quiet = new Logger("error", null);
const rigs: Rig[] = [];
const pubs: CommsPublic[] = [];
const extra: FakeTs3Plugin[] = [];
afterEach(async () => {
  for (const p of pubs.splice(0)) p.stop();
  for (const p of extra.splice(0)) p.kill();
  for (const r of rigs.splice(0)) await r.stop();
});

const SERVER = { uid: "serverUid=", name: "Scrim server", host: "ts.example.org", port: 9987 };

async function setup(o: { delaySec?: number; fineMs?: number; staleMs?: number } = {}) {
  const r = new Rig();
  rigs.push(r);
  await r.start({ delaySec: o.delaySec, fineMs: o.fineMs ?? (o.delaySec === undefined ? 300 : 0), staleMs: o.staleMs });
  await r.openTabs();
  const worker = new FakeNdiWorker();
  const pub = new CommsPublic({ comms: r.comms, settings: r.settings, logger: quiet, obs: new ObsManager(), now: () => r.sim, overlayPort: () => 37212, liveScene: () => "Game", replayDuck: () => null, spawnNdiWorker: () => worker });
  pubs.push(pub);
  pub.sync();
  const air = new Map<number, Float32Array>();
  pub.outputs.onPublic((s, start) => air.set(start, Float32Array.from(s)));
  return { r, pub, air, worker };
}

function slice(blocks: Map<number, Float32Array>, fromMs: number, toMs: number): Float32Array {
  const from = Math.round(fromMs * 48);
  const to = Math.round(toMs * 48);
  const out = new Float32Array(Math.max(0, to - from));
  for (const [start, b] of blocks) {
    if (start + BLOCK <= from || start >= to) continue;
    for (let i = 0; i < BLOCK; i++) {
      const s = start + i;
      if (s >= from && s < to) out[s - from] = b[i]!;
    }
  }
  return out;
}
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const person = (r: Rig, uid: string) => r.comms.status().participants.find((p) => p.uid === uid)!;

describe("Team Comms reconnects: identities, exclusion and the public gate", () => {
  it("TeamSpeak restarts (a new plugin instance, the tabs in the other order, every session id new): each identity keeps its own choices, each team stays its channel's; the public listen-in is FAULT and stays closed; the recording comes back only after the delay", async () => {
    const { r, pub, air } = await setup({ delaySec: 1 });
    for (const p of r.a.slice(0, 5)) r.set(p, { includeBroadcast: true, includeRecording: true, levelDb: -3 });
    for (const p of r.b.slice(0, 3)) r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(1200);
    pub.controller.listenIn(TEAM_A);
    const t0 = r.sim;
    await r.run(1500, () => [r.a[0]!, r.b[0]!]);
    expect(peakAmplitude(slice(air, t0 + 200, t0 + 1500), r.a[0]!.freq)).toBeGreaterThan(PRESENT / 2);
    // TeamSpeak crashes.
    const lost = r.sim;
    r.plugin.kill();
    await until(() => pub.controller.view().state === "fault", 3000, "fault");
    await r.run(400);
    // Its delayed audio from before the loss is still at the playhead, but its TeamSpeak is gone: Listen In
    // is refused (else the reconnect below would put comms back on air without a new press).
    expect(() => pub.controller.listenIn(TEAM_A)).toThrow(/isn't ready: .*(No TeamSpeak tab|lost|disconnected)/);
    expect(pub.controller.view().actions[0]!.disabledReason).toMatch(/Not ready/);
    // TeamSpeak starts again: a new process (instance), Bravo's tab connected first this time (schid 1),
    // Alpha's second (schid 2), every session id new, and a stranger with Alpha 1's nickname in Alpha's channel.
    const ts2 = new FakeTs3Plugin(r.port, r.token, () => r.sim, { instance: "teamspeak-restarted" });
    extra.push(ts2);
    await ts2.connect();
    await until(() => ts2.welcomed, 3000, "welcome");
    const a2: Person[] = r.a.map((p, i) => ({ ...p, clientId: 200 + i, schid: 2 }));
    const b2: Person[] = r.b.map((p, i) => ({ ...p, clientId: 300 + i, schid: 1 }));
    const stranger: Person = { clientId: 250, uid: "strangerUidQQQQQQQQQQQQQQQ=", nickname: "Alpha 1", freq: 2600, schid: 2 };
    ts2.openTab({ schid: 1, server: SERVER, channel: { id: 12, name: "Team Bravo" }, self: { ...r.listenerB, clientId: 401 }, clients: b2.map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })) });
    ts2.openTab({ schid: 2, server: SERVER, channel: { id: 11, name: "Team Alpha" }, self: { ...r.listenerA, clientId: 402 }, clients: [...a2, stranger].map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })) });
    await until(() => ts2.capturing(1) && ts2.capturing(2), 3000, "both captured again");
    await until(() => r.comms.status().participants.length === 15, 3000, "fifteen people");
    r.plugin = ts2;
    await r.clockSet();
    // Captured again, but its audio from before the loss is still at the playhead with the gap after
    // it: not ready for a listen-in until the new capture is a full delay old.
    expect(r.comms.status().slots[0]!.tab?.capturing).toBe(true);
    expect(() => pub.controller.listenIn(TEAM_A)).toThrow(/isn't ready: its buffer doesn't hold the delay yet/);
    const st = r.comms.status();
    // Teams by channel, never by tab order: schid 2 is Alpha's now.
    expect(st.slots.map((s) => [s.id, s.tab?.schid, s.tab?.channel?.name, s.tab?.team?.name])).toEqual([
      ["A", 2, "Team Alpha", "Alpha Wolves"],
      ["B", 1, "Team Bravo", "Bravo Hawks"],
    ]);
    // Each identity: the same person, its new session id, its own choices; no one duplicated.
    for (const [i, p] of r.a.entries()) expect(person(r, p.uid)).toMatchObject({ slot: "A", clientId: 200 + i, includeBroadcast: i < 5, includeRecording: i < 5, levelDb: i < 5 ? -3 : 0 });
    for (const [i, p] of r.b.entries()) expect(person(r, p.uid)).toMatchObject({ slot: "B", clientId: 300 + i, includeRecording: i < 3, includeBroadcast: false });
    expect(new Set(st.participants.map((p) => p.uid)).size).toBe(15);
    // The newcomer with a known nickname is a stranger: excluded from everything.
    expect(person(r, stranger.uid)).toMatchObject({ slot: "A", includeBroadcast: false, includeRecording: false, preview: false });
    const back = r.sim;
    await r.run(2500, () => [a2[0]!, b2[0]!, stranger]);
    // Public: FAULT, silent since the loss (its 40 ms fade), whoever talks, though the buffer is ready again.
    expect(pub.controller.view()).toMatchObject({ state: "fault", team: null });
    expect(r.comms.status().slots[0]!.ready).toBe(true);
    expect(peak(slice(air, lost + 60, r.sim))).toBe(0);
    // Recording (team A): buffered audio until the delay ran out, then nothing fresh: silence until the
    // new capture is a full delay old; then Alpha 1, never the stranger or Bravo.
    expect(r.heard("recording", lost + 1100, back + 950, [r.a[0]!]).get("Alpha 1")).toBeLessThan(QUIET);
    const rec = r.heard("recording", back + 1150, back + 2500, [r.a[0]!, r.b[0]!]);
    expect(rec.get("Alpha 1")).toBeGreaterThan(PRESENT / 2);
    expect(rec.get("Bravo 1")).toBeLessThan(QUIET);
    expect(peakAmplitude(r.slice("recording", back + 1150, back + 2500), stranger.freq)).toBeLessThan(QUIET);
    // Only an explicit Listen In puts comms on air again.
    pub.controller.listenIn(TEAM_A);
    const t2 = r.sim;
    await r.run(800, () => [a2[0]!, stranger]);
    const x = slice(air, t2 + 100, t2 + 800);
    expect(peakAmplitude(x, r.a[0]!.freq)).toBeGreaterThan(PRESENT / 2);
    expect(peakAmplitude(x, stranger.freq)).toBeLessThan(QUIET);
  });

  it("session ids reused: a stranger given a departed person's session id stays a stranger; a late block of the departed person is dropped, never given to the stranger", async () => {
    const { r } = await setup();
    const p = r.a[1]!;
    for (const q of r.a.slice(0, 3)) r.set(q, { includeRecording: true, includeBroadcast: true });
    r.comms.setRecordingTeam(TEAM_A);
    r.comms.setPublicTeam(TEAM_A);
    await r.run(500);
    // Alpha 2 leaves; TeamSpeak gives their session id (11) to a newcomer.
    r.plugin.leave(1, p.clientId);
    await until(() => !person(r, p.uid).present, 3000, "left");
    const stranger: Person = { clientId: p.clientId, uid: "newcomerUidWWWWWWWWWWWWWWW=", nickname: "Alpha 2", freq: 2700, schid: 1 };
    r.plugin.join(1, stranger);
    await until(() => r.comms.status().participants.length === 15, 3000, "newcomer seen");
    expect(person(r, stranger.uid)).toMatchObject({ clientId: 11, includeBroadcast: false, includeRecording: false });
    expect(person(r, p.uid)).toMatchObject({ present: false, includeBroadcast: true, includeRecording: true });
    // A block of Alpha 2's, captured before they left, arriving now (the plugin names its speaker by identity):
    // not in the channel any more, so dropped, and never the newcomer's.
    const before = r.comms.status().slots[0]!.tab!;
    r.plugin.audio(1, 11, tone(p.freq, 20, 48000, 0.12), r.sim - 30, { uid: p.uid });
    await until(() => r.comms.status().tabs.find((t) => t.schid === 1 && t.slot === "A")!.ignored.notInChannel > 0, 3000, "dropped");
    expect(before.capturing).toBe(true);
    const t0 = r.sim;
    await r.run(1500, () => [r.a[0]!, stranger]);
    for (const out of ["public", "recording"] as const) {
      const x = r.slice(out, t0 + 400, t0 + 1500);
      expect(peakAmplitude(x, r.a[0]!.freq)).toBeGreaterThan(PRESENT);
      expect(peakAmplitude(x, stranger.freq)).toBeLessThan(QUIET);
      expect(peakAmplitude(x, p.freq)).toBeLessThan(QUIET);
    }
    // The newcomer leaves and Alpha 2 comes back with that same session id: Alpha 2's choices again.
    r.plugin.leave(1, stranger.clientId);
    await until(() => !person(r, stranger.uid).present, 3000, "newcomer left");
    r.plugin.join(1, { clientId: 11, uid: p.uid, nickname: p.nickname });
    await until(() => person(r, p.uid).present, 3000, "Alpha 2 back");
    const t1 = r.sim;
    await r.run(1200, () => [p]);
    expect(r.heard("recording", t1 + 400, t1 + 1200, [p]).get("Alpha 2")).toBeGreaterThan(PRESENT);
  });

  it("Matchframe restarts while TeamSpeak runs: the plugin reconnects from the bridge file, the tabs are captured again, every choice kept, the public gate closed", async () => {
    const { r } = await setup({ delaySec: 1 });
    r.set(r.a[0]!, { includeBroadcast: true, includeRecording: true });
    r.set(r.b[2]!, { includeRecording: true, levelDb: -6 });
    r.comms.setPublicTeam(TEAM_A);
    await r.run(1500, () => [r.a[0]!]);
    const oldPort = r.port;
    await r.restartEngine();
    // The real plugin stops capturing when Matchframe goes away (tabs stay listen-only and silent), then
    // re-reads the bridge file and connects to the port it names now.
    r.plugin.kill();
    const port = (JSON.parse(readFileSync(r.comms.bridgeFile(), "utf8")) as { port: number }).port;
    expect(port).toBe(r.port);
    expect(port).not.toBe(oldPort);
    await r.plugin.connect(undefined, port);
    await until(() => r.plugin.welcomed && r.plugin.capturing(1) && r.plugin.capturing(2), 3000, "captured again");
    await until(() => r.comms.status().participants.length === 14, 3000, "people again");
    await r.clockSet();
    expect(person(r, r.a[0]!.uid)).toMatchObject({ includeBroadcast: true, includeRecording: true });
    expect(person(r, r.b[2]!.uid)).toMatchObject({ includeRecording: true, levelDb: -6 });
    // A restart is OFF: nothing reopens the public gate by itself.
    expect(r.comms.status().public).toMatchObject({ team: null, state: "off" });
    expect(r.comms.status().slots.map((s) => s.state)).toEqual(["buffering", "buffering"]);
    r.comms.setRecordingTeam(TEAM_B);
    const t0 = r.sim;
    await r.run(2500, () => [r.a[0]!, r.b[2]!]);
    expect(r.comms.status().slots.map((s) => s.state)).toEqual(["ready", "ready"]);
    expect(r.heard("public", t0, t0 + 2500, [r.a[0]!]).get("Alpha 1")).toBeLessThan(QUIET);
    expect(r.heard("recording", t0 + 1200, t0 + 2500, [r.b[2]!]).get("Bravo 3")).toBeGreaterThan(PRESENT / 2 - 0.01);
  });

  it("TeamSpeak restarted with the plugin's remembered tabs (listen-only and silent): reports from before TeamSpeak filled in the server's address or the channel never hand a tab back; captured once they are known", async () => {
    const { r } = await setup({ delaySec: 1 });
    r.plugin.kill();
    await until(() => r.comms.status().slots.every((s) => s.state === "waiting"), 3000, "both waiting");
    const ts2 = new FakeTs3Plugin(r.port, r.token, () => r.sim, { instance: "teamspeak-restarted" });
    extra.push(ts2);
    // What the plugin set by itself for the remembered tabs before Matchframe asked anything.
    for (const schid of [1, 2]) ts2.managed.set(schid, { capture: false, listenOnly: true, suppressPlayback: true });
    await ts2.connect();
    await until(() => ts2.welcomed, 3000, "welcome");
    // Established, but TeamSpeak hasn't filled in the address yet (real TeamSpeak 3.6.2 reports a
    // moment before its connection-established callback) or the channel yet.
    const a = ts2.openTab({ schid: 1, server: { ...SERVER, host: "" }, channel: { id: 11, name: "Team Alpha" }, self: { ...r.listenerA, clientId: 401 }, clients: [] });
    ts2.openTab({ schid: 2, server: SERVER, channel: { id: 0, name: "" }, self: { ...r.listenerB, clientId: 402 }, clients: [] });
    await until(() => r.comms.status().tabs.filter((t) => t.restoredByPlugin).length === 2, 3000, "both tabs seen");
    await r.run(300);
    expect(r.comms.status().tabs.map((t) => [t.schid, t.restoredByPlugin, t.released, t.slot])).toEqual([
      [1, true, false, null],
      [2, true, false, null],
    ]);
    // Now known: each in its team's channel, captured; never handed back in between.
    a.server = SERVER;
    ts2.report(a, "status");
    ts2.moveSelf(2, { id: 12, name: "Team Bravo" }, []);
    await until(() => ts2.capturing(1) && ts2.capturing(2), 3000, "both captured");
    expect(ts2.manageLog.filter((m) => !m.listenOnly || !m.suppressPlayback)).toEqual([]);
    expect(r.comms.status().tabs.map((t) => [t.schid, t.slot, t.released])).toEqual([
      [1, "A", false],
      [2, "B", false],
    ]);
    // A tab whose channel is known and no team's is handed back (as before).
    ts2.moveSelf(2, { id: 13, name: "Lobby" }, []);
    await until(() => ts2.manageLog.some((m) => m.schid === 2 && !m.listenOnly && !m.suppressPlayback && !m.capture) || ts2.managed.get(2)?.capture === false, 3000, "Bravo's tab no longer captured");
  });

  it("a team tab disconnects from its server and reconnects: FAULT on air, the recording silent from the gap until the delay has passed again, everyone back with new session ids and their choices", async () => {
    const { r, pub, air } = await setup({ delaySec: 1 });
    const p = r.a[3]!;
    r.set(p, { includeBroadcast: true, includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(1200);
    pub.controller.listenIn(TEAM_A);
    await r.run(1000, () => [p]);
    const lost = r.sim;
    r.plugin.setStatus(1, 0, "Connection to server lost");
    await until(() => r.comms.status().slots[0]!.state === "waiting", 3000, "waiting");
    expect(pub.controller.view().state).toBe("fault");
    expect(r.comms.status().slots[0]!.lost?.reason).toMatch(/TeamSpeak disconnected: Connection to server lost/);
    expect(person(r, p.uid).present).toBe(false);
    await r.run(600);
    // Back: same tab, new session ids for everyone.
    const t = r.plugin.tabs.get(1)!;
    t.clients = r.a.map((x, i) => ({ clientId: 500 + i, uid: x.uid, nickname: x.nickname }));
    r.plugin.setStatus(1, 4);
    await until(() => r.plugin.capturing(1), 3000, "captured again");
    await until(() => person(r, p.uid).clientId === 503, 3000, "re-resolved");
    const back = r.sim;
    const moved = { ...p, clientId: 503 };
    await r.run(2500, () => [moved]);
    expect(person(r, p.uid)).toMatchObject({ present: true, includeBroadcast: true, includeRecording: true });
    expect(r.heard("recording", lost + 1100, back + 950, [p]).get("Alpha 4")).toBeLessThan(QUIET);
    expect(r.heard("recording", back + 1150, back + 2500, [p]).get("Alpha 4")).toBeGreaterThan(PRESENT);
    expect(pub.controller.view().state).toBe("fault");
    expect(peak(slice(air, lost + 60, r.sim))).toBe(0);
  });

  it("the listener's tab moves channel: no longer the team's source (FAULT on air, people absent, capture stopped); in the other team's channel it isn't used twice; moved back, captured again after the delay", async () => {
    const { r, pub, air } = await setup({ delaySec: 1 });
    for (const q of [...r.a, ...r.b]) r.set(q, { includeBroadcast: true, includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(1200);
    pub.controller.listenIn(TEAM_A);
    await r.run(500, () => [r.a[0]!]);
    // An admin drags the listener into the lobby, where someone else talks. A block of Alpha 1's
    // captured just before the move arrives after it.
    const lobby: Person = { clientId: 90, uid: "lobbyUidLLLLLLLLLLLLLLLLLLL=", nickname: "lobby", freq: 2800, schid: 1 };
    const moved = r.sim;
    r.plugin.moveSelf(1, { id: 99, name: "Lobby" }, [lobby]);
    r.plugin.audio(1, r.a[0]!.clientId, tone(r.a[0]!.freq, 20, 48000, 0.12), r.sim - 10, { uid: r.a[0]!.uid });
    await until(() => r.comms.status().slots[0]!.state === "waiting", 3000, "slot A waiting");
    await until(() => !r.plugin.managed.get(1)!.capture, 3000, "capture stopped");
    expect(r.plugin.managed.get(1)).toEqual({ capture: false, listenOnly: true, suppressPlayback: true });
    expect(pub.controller.view().state).toBe("fault");
    expect(r.comms.status().participants.filter((x) => x.slot === "A" && x.present)).toEqual([]);
    expect(r.comms.status().participants.some((x) => x.uid === lobby.uid)).toBe(false);
    // Into Team Bravo's channel: Bravo keeps its own tab; this one is not used (never Bravo twice, never Alpha as Bravo).
    r.plugin.moveSelf(1, { id: 12, name: "Team Bravo" }, r.b.map(({ clientId, uid, nickname }) => ({ clientId: clientId + 100, uid, nickname })));
    await until(() => /2 TeamSpeak tabs are in "Team Bravo"/.test(r.comms.status().slots[1]!.issue ?? ""), 3000, "two tabs in Bravo");
    expect(r.comms.status().slots[1]!.tab?.schid).toBe(2);
    expect(r.plugin.capturing(1)).toBe(false);
    // Back into Team Alpha's channel: captured again, ready after the delay; the public gate stays closed.
    r.plugin.moveSelf(1, { id: 11, name: "Team Alpha" }, r.a.map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })));
    await until(() => r.plugin.capturing(1), 3000, "captured again");
    const back = r.sim;
    await r.run(2500, () => [r.a[0]!, r.b[0]!]);
    expect(r.heard("recording", moved + 1100, back + 950, [r.a[0]!]).get("Alpha 1")).toBeLessThan(QUIET);
    const rec = r.heard("recording", back + 1150, back + 2500, [r.a[0]!, r.b[0]!]);
    expect(rec.get("Alpha 1")).toBeGreaterThan(PRESENT);
    expect(rec.get("Bravo 1")).toBeLessThan(QUIET);
    expect(peak(slice(air, moved + 60, r.sim))).toBe(0);
    expect(pub.controller.view().state).toBe("fault");
  });

  it("a frozen TeamSpeak (connection open, nothing answered) is a lost source after the liveness limit: silent and FAULT, never stale audio", async () => {
    const { r, pub, air } = await setup({ staleMs: 400 });
    r.set(r.a[0]!, { includeBroadcast: true });
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(500, () => [r.a[0]!]);
    r.plugin.freeze();
    const frozen = r.sim;
    await until(() => pub.controller.view().state === "fault", 4000, "fault");
    expect(pub.controller.view().fault?.reason).toMatch(/stopped answering/);
    expect(r.comms.status().bridge.staleClosed).toBe(1);
    await until(() => r.plugin.closedByPeer, 3000, "closed by Matchframe");
    await r.run(1000);
    expect(peak(slice(air, frozen + 60, r.sim))).toBe(0);
  });

  it("Matchframe itself not running for longer than the liveness limit (the computer froze): no plugin is closed for it; one that stays silent afterwards still is", async () => {
    const { r, pub } = await setup({ staleMs: 400 });
    await r.run(500);
    // The computer's clock moves 5 s between two ping rounds: Matchframe didn't run meanwhile (what
    // the plugin sent then would still be unread when the next round's timer fires).
    r.realJump += 5000;
    await new Promise((res) => setTimeout(res, 700));
    const st = r.comms.status();
    expect(st.bridge.staleClosed).toBe(0);
    expect(st.bridge.stalls).toBeGreaterThanOrEqual(1);
    expect(st.slots.map((s) => s.tab?.capturing)).toEqual([true, true]);
    expect(pub.controller.view().fault).toBeNull();
    r.plugin.freeze();
    await until(() => r.comms.status().bridge.staleClosed === 1, 4000, "the frozen plugin closed");
  });
});

describe("Team Comms failure recovery: the NDI process", () => {
  it("a crash: public silent and FAULT, nothing sent while it is down, restarted with a back-off that grows when it keeps crashing and resets after a good run; never reopened by itself", async () => {
    const { r, pub, worker } = await setup();
    let now = 1_000_000;
    const deps = (pub.outputs as unknown as { d: { wallNow?: () => number; spawnWorker?: () => FakeNdiWorker } }).d;
    deps.wallNow = () => now;
    const workers: FakeNdiWorker[] = [worker];
    deps.spawnWorker = () => {
      const w = new FakeNdiWorker();
      workers.push(w);
      return w;
    };
    r.set(r.a[0]!, { includeBroadcast: true, includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(500, () => [r.a[0]!]);
    expect(pub.outputs.status().ndi).toMatchObject({ state: "running", restarts: 0 });
    // Crash 1: FAULT at once, 3 s until it starts again.
    workers.at(-1)!.crash(3);
    const nd = pub.outputs.status().ndi;
    expect(pub.controller.view().state).toBe("fault");
    expect(nd).toMatchObject({ state: "error", restarts: 1, backoffMs: 3000, nextStartInMs: 3000, lastExit: { code: 3 } });
    expect(nd.detail).toMatch(/stopped \(exit 3\): nothing reaches OBS\. Starting it again in 3 s/);
    // While it is down nothing is sent at all (the public route can't carry comms; Listen In refused).
    const sentBefore = workers.reduce((n, w) => n + w.blocks.length, 0);
    await r.run(300, () => [r.a[0]!]);
    expect(workers.reduce((n, w) => n + w.blocks.length, 0)).toBe(sentBefore);
    expect(() => pub.controller.listenIn(TEAM_A)).toThrow(/isn't running/);
    // Not before its time.
    now += 2900;
    pub.outputs.sync();
    expect(pub.outputs.status().ndi.state).toBe("error");
    now += 200;
    pub.outputs.sync();
    expect(pub.outputs.status().ndi.state).toBe("running");
    expect(workers).toHaveLength(2);
    // Crashes again soon after: 6 s, then 12 s, ... at most 30 s.
    const waits: number[] = [];
    for (let k = 0; k < 5; k++) {
      now += 1000;
      workers.at(-1)!.crash(1);
      waits.push(pub.outputs.status().ndi.backoffMs);
      now += pub.outputs.status().ndi.backoffMs;
      pub.outputs.sync();
      expect(pub.outputs.status().ndi.state).toBe("running");
    }
    expect(waits).toEqual([6000, 12_000, 24_000, 30_000, 30_000]);
    expect(pub.outputs.status().ndi.restarts).toBe(6);
    // A good run (over a minute) resets it.
    now += 61_000;
    workers.at(-1)!.crash(1);
    expect(pub.outputs.status().ndi.backoffMs).toBe(3000);
    // Back running: still FAULT until the operator says Listen In again; the blocks flow again.
    now += 3000;
    pub.outputs.sync();
    expect(pub.controller.view().state).toBe("fault");
    await r.run(300, () => [r.a[0]!]);
    expect(workers.at(-1)!.blocks.length).toBeGreaterThan(20);
    expect(workers.at(-1)!.blocks.every((b) => b.pub.every((v) => v === 0))).toBe(true);
  });
});
