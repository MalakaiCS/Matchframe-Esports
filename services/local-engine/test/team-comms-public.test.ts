import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ObsManager } from "@matchframe/obs-adapter";
import type { Engine } from "../src/app.ts";
import { ListenInError } from "../src/comms/controller.ts";
import { BLOCK } from "../src/comms/mixer.ts";
import { overlayState, type CommsOverlayState } from "../src/comms/overlay.ts";
import { decodePreview } from "../src/comms/preview.ts";
import { CommsPublic } from "../src/comms/public.ts";
import { TeamComms } from "../src/comms/service.ts";
import { Logger } from "../src/logger.ts";
import { ReplayAudio, type AudioSettings } from "../src/replay/audio.ts";
import { StandInObs } from "./stand-in-obs.ts";
import { AMP, PRESENT, QUIET, Rig, TEAM_A, TEAM_B, type Person } from "./helpers/comms-rig.ts";
import { FakeNdiWorker } from "./helpers/fake-ndi-worker.ts";
import { amplitudeAt, peakAmplitude, until } from "./helpers/fake-ts3-plugin.ts";

/**
 * Team Comms phase 3 (ADR-066): the public listen-in's one output-state controller, the outputs (the
 * public silence guard, the NDI process's input, the preview), caster ducking with the replays'
 * ducking, and the team-only overlay. Fixture tests: the real bridge, a stand-in TeamSpeak plugin and
 * a stand-in NDI process on a simulated clock; a stand-in OBS for ducking. Evidence of routing,
 * gating and timing, not of OBS or DistroAV (see team-comms-ndi.test.ts and the operations doc).
 */

const quiet = new Logger("error", null);
const rigs: Rig[] = [];
const pubs: CommsPublic[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const p of pubs.splice(0)) p.stop();
  for (const r of rigs.splice(0)) await r.stop();
  for (const s of servers.splice(0)) await new Promise((res) => s.close(() => res(null)));
});

interface OnAir {
  r: Rig;
  pub: CommsPublic;
  worker: FakeNdiWorker;
  /** The public output as it leaves for NDI (guarded), per block start. */
  air: Map<number, Float32Array>;
}

async function onAir(o: { delaySec?: number; fineMs?: number; obs?: ObsManager; replayDuck?: ReplayAudio; worker?: FakeNdiWorker } = {}): Promise<OnAir> {
  const r = new Rig();
  rigs.push(r);
  await r.start({ delaySec: o.delaySec, fineMs: o.fineMs ?? (o.delaySec === undefined ? 300 : 0) });
  await r.openTabs();
  const worker = o.worker ?? new FakeNdiWorker();
  const pub = new CommsPublic({ comms: r.comms, settings: r.settings, logger: quiet, obs: o.obs ?? new ObsManager(), now: () => r.sim, overlayPort: () => 37212, liveScene: () => "Game", replayDuck: () => o.replayDuck ?? null, spawnNdiWorker: () => worker });
  pubs.push(pub);
  pub.sync();
  const air = new Map<number, Float32Array>();
  pub.outputs.onPublic((s, start) => air.set(start, Float32Array.from(s)));
  return { r, pub, worker, air };
}

/** Samples of per-block output between two times (ms). */
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
const allZero = (x: Float32Array) => x.every((v) => v === 0);
const includeAll = (r: Rig, people: Person[], patch: Parameters<Rig["set"]>[1]) => people.forEach((p) => r.set(p, patch));

describe("Team Comms on air: the public listen-in's output-state controller", () => {
  it("is OFF at start, refuses to open before the buffer holds the delay, and only an explicit Listen In opens it (recording and preview never do)", async () => {
    const { r, pub, air } = await onAir({ delaySec: 2 });
    const ctl = pub.controller;
    expect(ctl.view()).toMatchObject({ state: "off", label: "OFF", team: null, muted: false, fault: null });
    // Named by the match's teams (by team id, never CT/T).
    expect(ctl.view().actions.map((a) => [a.teamId, a.label])).toEqual([
      [TEAM_A, "Listen In — Alpha Wolves"],
      [TEAM_B, "Listen In — Bravo Hawks"],
    ]);
    // Buffering: 2 s of history needed.
    expect(ctl.view().actions[0]!.disabledReason).toMatch(/Not ready: its buffer doesn't hold the delay yet \(ready in about 2 s\)/);
    let refused: unknown = null;
    try {
      ctl.listenIn(TEAM_A);
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ListenInError);
    expect(refused).toMatchObject({ status: 409, code: "not_ready" });
    expect((refused as Error).message).toMatch(/Alpha Wolves isn't ready: its buffer doesn't hold the delay yet/);
    // Recording and preview run, with everyone included and soloed: the public gate stays shut.
    includeAll(r, r.a, { includeBroadcast: true, includeRecording: true });
    r.set(r.a[0]!, { preview: true });
    r.comms.setRecordingTeam(TEAM_A);
    r.comms.setRecordingSignal(true);
    const t0 = r.sim;
    await r.run(3000, () => r.a.slice(0, 3));
    expect(ctl.view().state).toBe("off");
    expect(r.heard("recording", t0 + 2200, t0 + 3000, r.a.slice(0, 3)).get("Alpha 1")).toBeGreaterThan(PRESENT);
    expect(r.heard("preview", t0 + 2200, t0 + 3000, r.a.slice(0, 3)).get("Alpha 1")).toBeGreaterThan(PRESENT);
    expect(allZero(slice(air, t0, t0 + 3000))).toBe(true);
    // Ready now: Listen In opens it, in words.
    expect(ctl.view().actions[0]).toMatchObject({ ready: true, disabledReason: null });
    const v = ctl.listenIn(TEAM_A);
    expect(v.team).toMatchObject({ id: TEAM_A, slot: "A", name: "Alpha Wolves" });
    const t1 = r.sim;
    await r.run(1000, () => r.a.slice(0, 3));
    expect(ctl.view()).toMatchObject({ state: "listening", label: "LISTENING IN — ALPHA WOLVES", heardTeamId: TEAM_A });
    expect(peakAmplitude(slice(air, t1 + 100, t1 + 1000), r.a[0]!.freq)).toBeGreaterThan(PRESENT);
  });

  it("broadcast off: silence (exact zeros) to NDI while both buffers and the recording carry on", async () => {
    const { r, pub, air, worker } = await onAir();
    includeAll(r, [...r.a, ...r.b], { includeBroadcast: true, includeRecording: true });
    r.comms.setRecordingTeam(TEAM_B);
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    const t0 = r.sim;
    await r.run(1500, () => [r.a[0]!, r.b[0]!]);
    expect(peakAmplitude(slice(air, t0 + 400, t0 + 1500), r.a[0]!.freq)).toBeGreaterThan(PRESENT);
    pub.controller.end();
    const off = r.sim;
    await r.run(4000, () => [r.a[0]!, r.b[0]!]);
    expect(pub.controller.view()).toMatchObject({ state: "off", label: "OFF", detail: "Ended by the operator." });
    // Public: the 40 ms fade, then exact zeros, in what goes to NDI too.
    expect(allZero(slice(air, off + 60, off + 4000))).toBe(true);
    const sentPub = worker.blocks.filter((b) => b.start / 48 >= off + 60);
    expect(sentPub.length).toBeGreaterThan(350);
    expect(sentPub.every((b) => allZero(b.pub))).toBe(true);
    // The recording carries on (its own team), and so do both teams' buffers.
    expect(peakAmplitude(slice(new Map(worker.blocks.map((b) => [b.start, b.rec])), off + 100, off + 4000), r.b[0]!.freq)).toBeGreaterThan(PRESENT);
    const st = r.comms.status();
    expect(st.slots.map((s) => s.ready)).toEqual([true, true]);
    for (const p of [r.a[0]!, r.b[0]!]) expect(st.participants.find((x) => x.uid === p.uid)!.buffer.heldMs).toBeGreaterThan(250);
    expect(pub.outputs.status().publicGuard.blocksSilenced).toBeGreaterThan(350);
  });

  it("team switch: Listen In — Bravo closes Alpha through silence (no block holds both teams), with no click", async () => {
    const { r, pub, air } = await onAir();
    const a = r.a[0]!; // 330 Hz
    const b = r.b[6]!; // 2150 Hz
    includeAll(r, [a, b], { includeBroadcast: true });
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(1000, () => [a, b]);
    const sw = r.sim;
    const v = pub.controller.listenIn(TEAM_B);
    expect(v.team?.name).toBe("Bravo Hawks");
    await r.run(1000, () => [a, b]);
    expect(pub.controller.view()).toMatchObject({ state: "listening", label: "LISTENING IN — BRAVO HAWKS", heardTeamId: TEAM_B });
    const starts = [...air.keys()].filter((s) => s / 48 >= sw - 200 && s / 48 < sw + 400).sort((x, y) => x - y);
    const amps = starts.map((s) => ({ s, a: amplitudeAt(air.get(s)!, a.freq), b: amplitudeAt(air.get(s)!, b.freq) }));
    // Never both teams in one 10 ms block.
    expect(amps.filter((x) => x.a > QUIET && x.b > QUIET)).toEqual([]);
    // Alpha fades (no cut): it goes down over several blocks, then Bravo comes up over several.
    const aFade = amps.filter((x) => x.a > QUIET && x.a < AMP * 0.9 && x.s / 48 >= sw);
    const bFade = amps.filter((x) => x.b > QUIET && x.b < AMP * 0.9);
    expect(aFade.length).toBeGreaterThanOrEqual(2);
    expect(bFade.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...aFade.map((x) => x.s))).toBeLessThan(Math.min(...bFade.map((x) => x.s)));
    // No click: no sample step beyond the louder tone's own slope (2π·f·A/48 000).
    const x = slice(air, sw - 200, sw + 400);
    let step = 0;
    for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i]! - x[i - 1]!));
    expect(step).toBeLessThan(((2 * Math.PI * b.freq * AMP) / 48000) * 1.1);
  });

  it("End Listen-In and Mute All Comms: Mute All silences the public route in 5 ms; the recording and preview carry on; a new Listen In reopens", async () => {
    const { r, pub, air } = await onAir();
    const p = r.a[1]!;
    r.set(p, { includeBroadcast: true, includeRecording: true, preview: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(1000, () => [p]);
    const cut = r.sim;
    const m = pub.controller.muteAll();
    expect(m).toMatchObject({ state: "off", label: "OFF — MUTED", muted: true, team: null });
    expect(m.detail).toMatch(/recording and the operator's preview carry on/);
    await r.run(2000, () => [p]);
    // The block after the button: silent from 5 ms on; nothing after.
    expect(amplitudeAt(slice(air, cut - 10, cut), p.freq)).toBeGreaterThan(PRESENT);
    expect(peak(slice(air, cut + 6, cut + 2000))).toBe(0);
    expect(r.heard("recording", cut, cut + 2000, [p]).get(p.nickname)).toBeGreaterThan(PRESENT);
    expect(r.heard("preview", cut, cut + 2000, [p]).get(p.nickname)).toBeGreaterThan(PRESENT);
    // A new, explicit Listen In: on air again.
    pub.controller.listenIn(TEAM_A);
    expect(pub.controller.view().muted).toBe(false);
    const again = r.sim;
    await r.run(1000, () => [p]);
    expect(peakAmplitude(slice(air, again + 100, again + 1000), p.freq)).toBeGreaterThan(PRESENT);
    // End Listen-In: the ordinary 40 ms close.
    pub.controller.end();
    const end = r.sim;
    await r.run(1000, () => [p]);
    expect(peak(slice(air, end + 60, end + 1000))).toBe(0);
    expect(pub.controller.view().end.disabledReason).toBe("No listen-in is open");
  });

  it("failure ⇒ silence: a bridge loss is FAULT, the source coming back doesn't reopen it, End acknowledges it", async () => {
    const { r, pub, air } = await onAir({ delaySec: 1 });
    const p = r.a[2]!;
    r.set(p, { includeBroadcast: true });
    await r.run(1200);
    pub.controller.listenIn(TEAM_A);
    await r.run(1000, () => [p]);
    const lost = r.sim;
    r.plugin.kill();
    await until(() => pub.controller.view().state === "fault", 3000, "fault");
    const v = pub.controller.view();
    expect(v).toMatchObject({ label: "FAULT", team: null });
    expect(v.fault?.reason).toMatch(/TeamSpeak source was lost/);
    expect(v.detail).toMatch(/Closed by a fault/);
    await r.run(1500, () => [p]);
    // Silent at once: never the buffered audio after the loss, never undelayed audio.
    expect(peak(slice(air, lost + 60, lost + 1500))).toBe(0);
    // TeamSpeak back, the buffer ready again: still FAULT, still silent.
    await r.plugin.connect();
    await until(() => r.plugin.welcomed, 3000, "welcome");
    r.plugin.tabs.clear();
    const server = { uid: "serverUid=", name: "Scrim server", host: "ts.example.org", port: 9987 };
    r.plugin.openTab({ schid: 1, server, channel: { id: 11, name: "Team Alpha" }, self: r.listenerA, clients: r.a.map(({ clientId, uid, nickname }) => ({ clientId, uid, nickname })) });
    await until(() => r.plugin.capturing(1), 3000, "captured again");
    await r.clockSet();
    const back = r.sim;
    await r.run(2500, () => [p]);
    expect(r.comms.status().slots[0]!.ready).toBe(true);
    expect(pub.controller.view().state).toBe("fault");
    expect(peak(slice(air, back, back + 2500))).toBe(0);
    expect(pub.controller.end()).toMatchObject({ state: "off", fault: null });
  });

  it("the NDI process stopping closes the listen-in (FAULT); Listen In is refused until the output runs again", async () => {
    const worker = new FakeNdiWorker();
    const { r, pub, air } = await onAir({ worker });
    const p = r.a[0]!;
    r.set(p, { includeBroadcast: true });
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(500, () => [p]);
    worker.crash();
    const v = pub.controller.view();
    expect(v.state).toBe("fault");
    expect(v.fault?.reason).toMatch(/public output \(NDI\) process stopped/);
    const t = r.sim;
    await r.run(500, () => [p]);
    expect(peak(slice(air, t + 60, t + 500))).toBe(0);
    expect(() => pub.controller.listenIn(TEAM_A)).toThrow(/isn't running/);
    expect(pub.controller.view().actions[0]!.disabledReason).toMatch(/NDI “MatchFrame Comms”/);
    // Not started again within its back-off (3 s, no restart loop); then back, and an explicit Listen In works again.
    pub.outputs.sync();
    expect(pub.outputs.status().ndi.state).toBe("error");
    pub.outputs.sync(true);
    expect(pub.outputs.status().ndi.state).toBe("running");
    expect(pub.controller.view().state).toBe("fault");
    pub.controller.listenIn(TEAM_A);
    const t2 = r.sim;
    await r.run(500, () => [p]);
    expect(peakAmplitude(slice(air, t2 + 100, t2 + 500), p.freq)).toBeGreaterThan(PRESENT);
  });

  it("an NDI output that can't start is FAULT before anyone presses Listen In", async () => {
    const { pub } = await onAir({ worker: new FakeNdiWorker({ fail: "NDI isn't available here: no runtime" }) });
    expect(pub.controller.view()).toMatchObject({ state: "fault", label: "FAULT" });
    expect(pub.controller.view().detail).toMatch(/no runtime/);
    expect(() => pub.controller.listenIn(TEAM_A)).toThrow(/no runtime/);
  });

  it("halftime: the listen-in follows the team id, not the side", async () => {
    const { r, pub, air } = await onAir();
    includeAll(r, [r.a[0]!, r.b[0]!], { includeBroadcast: true });
    await r.run(500);
    pub.controller.listenIn(TEAM_B);
    // A halftime is a side change in the game data only; the slots and the controller never read CT/T.
    r.match = { ...r.match };
    r.comms.refreshTeams();
    const t0 = r.sim;
    await r.run(1500, () => [r.a[0]!, r.b[0]!]);
    expect(pub.controller.view()).toMatchObject({ state: "listening", team: { id: TEAM_B, slot: "B" } });
    const x = slice(air, t0 + 100, t0 + 1500);
    expect(peakAmplitude(x, r.b[0]!.freq)).toBeGreaterThan(PRESENT);
    expect(peakAmplitude(x, r.a[0]!.freq)).toBeLessThan(QUIET);
  });

  it("a delay change while on air: BUFFERING (silent) until the longer delay is held, then back on air by itself", async () => {
    const { r, pub, air } = await onAir({ delaySec: 1 });
    const p = r.a[0]!;
    r.set(p, { includeBroadcast: true });
    await r.run(1200);
    pub.controller.listenIn(TEAM_A);
    await r.run(500, () => [p]);
    await r.comms.updateSettings({ delaySec: 3 });
    const change = r.sim;
    await r.run(200, () => [p]);
    expect(pub.controller.view()).toMatchObject({ state: "buffering", label: "BUFFERING — ALPHA WOLVES" });
    await r.run(3500, () => [p]);
    expect(pub.controller.view().state).toBe("listening");
    expect(peak(slice(air, change + 100, change + 1500))).toBe(0);
    expect(peakAmplitude(slice(air, change + 3200, change + 3700), p.freq)).toBeGreaterThan(PRESENT);
  });

  it("is never saved open: a restart (new service and controller on the same settings) is OFF and silent", async () => {
    const { r, pub } = await onAir();
    r.set(r.a[0]!, { includeBroadcast: true });
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(300, () => [r.a[0]!]);
    expect(pub.controller.view().state).toBe("listening");
    const again = new TeamComms({ settings: r.settings, secrets: r.secrets, logger: quiet, dataDir: r.dir, now: () => r.sim, roster: { activeMatch: () => r.match, team: () => null, player: () => null, assetUrl: () => null }, realtime: false });
    const restarted = new CommsPublic({ comms: again, settings: r.settings, logger: quiet, obs: new ObsManager(), now: () => r.sim, overlayPort: () => 1, liveScene: () => null, replayDuck: () => null, spawnNdiWorker: () => new FakeNdiWorker() });
    pubs.push(restarted);
    expect(again.mixer.publicGate.target).toBeNull();
    expect(restarted.controller.view()).toMatchObject({ state: "off", team: null });
    expect(JSON.stringify(r.settings.get("comms.public", {}))).not.toContain(TEAM_A);
  });

  it("private preview: the soloed person is in the headphones only, never in the public or recording mix or the NDI output", async () => {
    const { r, pub, air, worker } = await onAir();
    const solo = r.a[3]!; // excluded from both, soloed
    const both = r.a[4]!; // included in both and soloed
    r.set(solo, { preview: true });
    r.set(both, { includeBroadcast: true, includeRecording: true, preview: true });
    r.comms.setRecordingTeam(TEAM_A);
    // The console's WebSocket: the preview hub behind a small HTTP server.
    const http = createServer();
    servers.push(http);
    http.on("upgrade", (req, socket, head) => pub.outputs.preview.upgrade(req, socket, head));
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", () => res()));
    const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as { port: number }).port}/`);
    const got: { start: number; samples: Float32Array }[] = [];
    let hello: unknown = null;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) hello = JSON.parse(String(data));
      else {
        const d = decodePreview(data as Buffer);
        if (d) got.push(d);
      }
    });
    await new Promise((res) => ws.once("open", res));
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    const t0 = r.sim;
    await r.run(2000, () => [solo, both]);
    await until(() => got.length > 50, 3000, "preview messages");
    ws.close();
    expect(hello).toMatchObject({ type: "hello", rate: 48000, channels: 1 });
    const prev = new Map(got.map((g) => [g.start, g.samples]));
    const prevPcm = (from: number, to: number) => {
      const out = new Float32Array(Math.round((to - from) * 48));
      for (const [s, x] of prev) for (let i = 0; i < x.length; i++) {
        const k = s + i - Math.round(from * 48);
        if (k >= 0 && k < out.length) out[k] = x[i]!;
      }
      return out;
    };
    // Headphones: both soloed people.
    expect(peakAmplitude(prevPcm(t0 + 400, t0 + 2000), solo.freq)).toBeGreaterThan(PRESENT);
    expect(peakAmplitude(prevPcm(t0 + 400, t0 + 2000), both.freq)).toBeGreaterThan(PRESENT);
    // Public (and what NDI gets for public and recording): the included person only.
    const pubX = slice(air, t0 + 400, t0 + 2000);
    expect(peakAmplitude(pubX, both.freq)).toBeGreaterThan(PRESENT);
    expect(peakAmplitude(pubX, solo.freq)).toBeLessThan(QUIET);
    const ndiPub = slice(new Map(worker.blocks.map((b) => [b.start, b.pub])), t0 + 400, t0 + 2000);
    const ndiRec = slice(new Map(worker.blocks.map((b) => [b.start, b.rec])), t0 + 400, t0 + 2000);
    expect(peakAmplitude(ndiPub, solo.freq)).toBeLessThan(QUIET);
    expect(peakAmplitude(ndiRec, solo.freq)).toBeLessThan(QUIET);
    expect(peakAmplitude(ndiRec, both.freq)).toBeGreaterThan(PRESENT);
    // Un-soloing changes neither output.
    r.set(both, { preview: false });
    const t1 = r.sim;
    await r.run(1000, () => [solo, both]);
    expect(peakAmplitude(slice(air, t1 + 100, t1 + 1000), both.freq)).toBeGreaterThan(PRESENT);
    expect(pub.outputs.status().preview.connects).toBe(1);
  });
});

describe("Team Comms on air: the team-only public overlay", () => {
  it("carries team-level state only: no person's name, identity, player or activity, whatever the team record holds", async () => {
    const { r, pub } = await onAir();
    // People mapped to roster players with names: none of it may reach the overlay.
    r.players.set("pl-1", { id: "pl-1", displayName: "SecretStar", realName: "Real Person", steamId: "76561198000000001", countryCode: null, avatarAssetId: "avatar-1", aliases: [], photoVisible: true, cameraConsent: false, cameraSourceId: null, archived: false });
    r.set(r.a[0]!, { includeBroadcast: true, playerId: "pl-1", displayName: "Star Display" });
    includeAll(r, r.a.slice(1), { includeBroadcast: true });
    const http = createServer();
    servers.push(http);
    http.on("upgrade", (req, socket, head) => pub.overlay.upgrade(req, socket, head));
    await new Promise<void>((res) => http.listen(0, "127.0.0.1", () => res()));
    const ws = new WebSocket(`ws://127.0.0.1:${(http.address() as { port: number }).port}/comms-ws`);
    const msgs: string[] = [];
    ws.on("message", (d) => msgs.push(String(d)));
    await new Promise((res) => ws.once("open", res));
    await until(() => msgs.length === 1, 3000, "first state");
    expect(JSON.parse(msgs[0]!)).toMatchObject({ type: "comms", onAir: false, team: null, label: "TEAM COMMS" });
    await r.run(500);
    pub.controller.listenIn(TEAM_A);
    await r.run(1500, () => r.a);
    await until(() => msgs.some((m) => JSON.parse(m).onAir), 3000, "on air");
    const on = JSON.parse(msgs.find((m) => JSON.parse(m).onAir)!) as CommsOverlayState;
    expect(on).toEqual({ type: "comms", v: 1, onAir: true, team: { name: "Alpha Wolves", shortName: "ALP", logoUrl: null, color: null }, label: "TEAM COMMS", placement: { anchor: "top", offsetPx: 140 } });
    pub.controller.end();
    await r.run(200);
    await until(() => !JSON.parse(msgs[msgs.length - 1]!).onAir, 3000, "off air");
    ws.close();
    // Nothing about any person, in any message.
    const all = msgs.join("\n");
    const st = r.comms.status();
    const forbidden = [...st.participants.flatMap((p) => [p.nickname, p.uid, p.key, String(p.clientId)]), "SecretStar", "Real Person", "Star Display", "pl-1", "avatar-1", "76561198000000001", "speaking", "activity", "db"];
    for (const f of forbidden) expect(all.includes(`"${f}"`) || (f.length > 3 && all.includes(f))).toBe(false);
    // Only these keys, ever (by construction).
    for (const m of msgs) {
      const s = JSON.parse(m) as CommsOverlayState;
      expect(Object.keys(s).sort()).toEqual(["label", "onAir", "placement", "team", "type", "v"]);
      if (s.team) expect(Object.keys(s.team).sort()).toEqual(["color", "logoUrl", "name", "shortName"]);
    }
    // Even fed a team with extra fields, only the team fields go out.
    const extra = { id: "t", slot: "A" as const, name: "X", shortName: null, logoUrl: null, color: null, players: [{ name: "leak" }] } as never;
    expect(JSON.stringify(overlayState(extra, { anchor: "bottom", offsetPx: 90 }))).not.toContain("leak");
  });
});

describe("Team Comms on air: caster ducking through OBS, with the replays' ducking", () => {
  const replaySettings = (duckTo: AudioSettings["duckTo"]): AudioSettings => ({ mixer: "obs", vmixUrl: "", duckInputs: ["Casters"], duckVmixInputs: [], duckTo, duckRampMs: 0, replayVolumeDb: null });

  async function withObs(duckTo: AudioSettings["duckTo"] = "mute") {
    const obsMgr = new ObsManager();
    const fakeEngine = { obs: obsMgr } as unknown as Engine;
    const obs = await StandInObs.attach(fakeEngine, (o) => {
      o.addScene("Game");
      o.addInput("Game", "Casters", "wasapi_input_capture");
      o.addInput("Game", "Game audio", "wasapi_process_output_capture");
      o.program = "Game";
    });
    obs.inputs.get("Casters")!.audio.volumeMul = 0.8;
    let rp: ReplayAudio | null = null;
    const a = await onAir({ obs: obsMgr, get replayDuck() {
      return rp ?? undefined;
    } });
    const replayEngine = { obs: obsMgr, settings: a.r.settings, logger: quiet, now: () => a.r.sim, replayTwin: { getStatus: () => ({ input: null }) }, highlightsAir: null } as unknown as Engine;
    rp = new ReplayAudio(replayEngine, () => replaySettings(duckTo));
    rp.peer = a.pub.ducking;
    a.pub.setSettings({ duck: { enabled: true, inputs: ["Casters"], amountDb: -10, rampMs: 0 } });
    a.r.set(a.r.a[0]!, { includeBroadcast: true });
    await a.r.run(500);
    const vol = () => obs.inputs.get("Casters")!.audio;
    const settle = () => new Promise((res) => setTimeout(res, 20));
    return { ...a, obs, replay: rp, vol, settle };
  }

  it("turns the casters down while a listen-in is open and puts them back exactly; a fader moved by hand is left alone", async () => {
    const { pub, vol, settle, obs } = await withObs();
    expect(pub.ducking.status().state).toBe("idle");
    pub.controller.listenIn(TEAM_A);
    await until(() => vol().volumeMul < 0.5, 2000, "ducked");
    expect(vol().volumeMul).toBeCloseTo(0.8 * 10 ** (-10 / 20), 4);
    expect(pub.ducking.status()).toMatchObject({ state: "lowered", lowered: ["Casters"] });
    // Switching team keeps them down (no release and duck again).
    const changes = obs.volumeLog.length;
    pub.controller.listenIn(TEAM_B);
    await settle();
    expect(obs.volumeLog.length).toBe(changes);
    pub.controller.end();
    await until(() => pub.ducking.status().state === "idle", 2000, "released");
    expect(vol()).toMatchObject({ volumeMul: 0.8, muted: false });
    // Mute All releases too; a fader the operator moved meanwhile stays where they put it.
    pub.controller.listenIn(TEAM_A);
    await until(() => vol().volumeMul < 0.5, 2000, "ducked again");
    obs.inputs.get("Casters")!.audio.volumeMul = 0.3;
    pub.controller.muteAll();
    await until(() => pub.ducking.status().state === "idle", 2000, "released");
    expect(vol().volumeMul).toBe(0.3);
    expect(pub.ducking.status().lastRelease?.detail).toMatch(/Changed by hand during the listen-in, left as it is: Casters/);
  });

  it("with a break's replays on the same input: whichever ends last restores (both orders)", async () => {
    // 1. Listen-in first, replays (mute) second; the listen-in ends first, the replays last.
    {
      const { pub, replay, vol } = await withObs("mute");
      pub.controller.listenIn(TEAM_A);
      await until(() => vol().volumeMul < 0.5, 2000, "ducked");
      await replay.duck();
      expect(vol().muted).toBe(true);
      pub.controller.end();
      await until(() => pub.ducking.status().state === "idle", 2000, "released");
      // Still the replays': down and muted.
      expect(vol().muted).toBe(true);
      await replay.restore();
      expect(vol()).toMatchObject({ volumeMul: 0.8, muted: false });
    }
    // 2. Replays first (−6 dB), listen-in second (−10 dB, lower); the replays end first, the listen-in last.
    {
      const { pub, replay, vol } = await withObs(-6);
      await replay.duck();
      expect(vol().volumeMul).toBeCloseTo(0.8 * 10 ** (-6 / 20), 3);
      pub.controller.listenIn(TEAM_A);
      await until(() => Math.abs(vol().volumeMul - 0.8 * 10 ** (-10 / 20)) < 1e-3, 2000, "lower still");
      await replay.restore();
      // Still the listen-in's level, not the replays' "before" (which would be the listen-in's original anyway).
      expect(vol().volumeMul).toBeCloseTo(0.8 * 10 ** (-10 / 20), 3);
      pub.controller.end();
      await until(() => pub.ducking.status().state === "idle", 2000, "released");
      expect(vol()).toMatchObject({ volumeMul: 0.8, muted: false });
    }
    // 3. Listen-in first (−10 dB), replays second (mute); the replays end first: back to the listen-in's level, then the original.
    {
      const { pub, replay, vol } = await withObs("mute");
      pub.controller.listenIn(TEAM_A);
      await until(() => vol().volumeMul < 0.5, 2000, "ducked");
      await replay.duck();
      await replay.restore();
      expect(vol().muted).toBe(false);
      expect(vol().volumeMul).toBeCloseTo(0.8 * 10 ** (-10 / 20), 3);
      pub.controller.end();
      await until(() => pub.ducking.status().state === "idle", 2000, "released");
      expect(vol()).toMatchObject({ volumeMul: 0.8, muted: false });
    }
  });

  it("casters left down by a crash during a listen-in go back at the next start", async () => {
    const { pub, vol, r, obs } = await withObs();
    pub.controller.listenIn(TEAM_A);
    await until(() => vol().volumeMul < 0.5, 2000, "ducked");
    // The engine dies here (nothing released); a new engine starts against the same OBS and settings.
    const obsMgr = new ObsManager();
    await obs.connectTo({ obs: obsMgr } as unknown as Engine);
    const next = new CommsPublic({ comms: r.comms, settings: r.settings, logger: quiet, obs: obsMgr, now: () => r.sim, overlayPort: () => 1, liveScene: () => "Game", replayDuck: () => null, spawnNdiWorker: () => new FakeNdiWorker() });
    pubs.push(next);
    expect(next.controller.view().state).toBe("off");
    next.start();
    await until(() => !next.ducking.lowered, 2000, "put back at start");
    expect(vol()).toMatchObject({ volumeMul: 0.8, muted: false });
  });

  it("OBS goes away and comes back during a listen-in: the listen-in stays on air (comms reach OBS over NDI), the casters go down again from their saved volume; ended while OBS is away, they go back once it answers", async () => {
    const { pub, vol, obs, r, air } = await withObs();
    // As the engine runs it: watching OBS (re)connect, retrying what couldn't be put back.
    pub.start();
    pub.controller.listenIn(TEAM_A);
    await until(() => vol().volumeMul < 0.5, 2000, "ducked");
    // OBS restarts: it comes back with the casters at their own volume (its saved scene collection).
    obs.drop();
    obs.inputs.get("Casters")!.audio.volumeMul = 0.8;
    const t0 = r.sim;
    await r.run(400, () => [r.a[0]!]);
    expect(pub.controller.view().state).toBe("listening");
    expect(peakAmplitude(slice(air, t0 + 100, t0 + 400), r.a[0]!.freq)).toBeGreaterThan(PRESENT);
    obs.up();
    // The manager reconnects by itself (about a second): down again, from the saved 0.8.
    await until(() => Math.abs(vol().volumeMul - 0.8 * 10 ** (-10 / 20)) < 1e-4, 5000, "ducked again after OBS came back");
    expect(pub.ducking.status()).toMatchObject({ state: "lowered", lowered: ["Casters"] });
    // End Listen-In while OBS is away: nothing can be put back yet, kept (pending) and done when OBS answers.
    obs.drop();
    await new Promise((res) => setTimeout(res, 30));
    pub.controller.end();
    await until(() => /Not put back yet/.test(pub.ducking.status().lastRelease?.detail ?? ""), 2000, "release tried");
    expect(pub.ducking.status().state).toBe("pending");
    obs.up();
    await until(() => pub.ducking.status().state === "idle", 6000, "put back once OBS answered");
    expect(vol()).toMatchObject({ volumeMul: 0.8, muted: false });
    expect(pub.controller.view().state).toBe("off");
  });
});
