import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretStore } from "../src/auth.ts";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { Logger } from "../src/logger.ts";
import { TeamComms } from "../src/comms/service.ts";

/**
 * The real plugin (native/ts3-matchframe-plugin/src/plugin.cpp), compiled here, loaded by a
 * stand-in TeamSpeak client (test/host.cpp) and talking to the real engine bridge: its threads, its
 * queue, its wire format, listen-only, playback suppression, recording status, identities across a
 * reconnect. Needs g++ and the TeamSpeak SDK headers (node native/ts3-matchframe-plugin/scripts/fetch-sdk.mjs);
 * skipped without them. TeamSpeak itself is simulated: see docs/operations/team-comms.md for the
 * real TeamSpeak runs.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../native/ts3-matchframe-plugin");
const sdk = join(root, ".sdk/include");
const gxx = (() => {
  try {
    execFileSync("g++", ["--version"], { stdio: "ignore" });
    return process.platform === "linux";
  } catch {
    return false;
  }
})();
const run = promisify(execFile);

interface HostResult {
  apiVersion: number;
  voiceCalls: number;
  zeroed: number;
  untouched: number;
  mixedCalls: number;
  mixedZeroed: number;
  micBlocked: number;
  /** Per tab: blocks while running, and blocks played while the tab was still connecting (before ESTABLISHED). */
  tabs: Record<"1" | "2", { zeroed: number; untouched: number; earlyCalls: number; earlyZeroed: number }>;
  calls: string[];
}

describe.skipIf(!gxx || !existsSync(join(sdk, "ts3_functions.h")))("Team Comms plugin binary (stand-in TeamSpeak host, real bridge)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-plugin-"));
  const so = join(dir, "matchframe_comms_linux_amd64.so");
  const host = join(dir, "host");
  /** Where the plugin remembers the team tabs (TeamSpeak's config folder in TeamSpeak). */
  const tabsFile = join(dir, "matchframe_comms_tabs.txt");
  const all: TeamComms[] = [];
  afterAll(async () => {
    for (const c of all) await c.stop();
  });
  beforeAll(async () => {
    await run("g++", ["-std=c++17", "-O2", "-shared", "-fPIC", "-fvisibility=hidden", "-pthread", `-I${sdk}`, `-I${join(root, "src")}`, join(root, "src/plugin.cpp"), "-o", so]);
    await run("g++", ["-std=c++17", "-O2", "-pthread", `-I${sdk}`, join(root, "test/host.cpp"), "-o", host, "-ldl"]);
  }, 120_000);

  const engine = async (channels: { A: string; B: string }, sub: string): Promise<TeamComms> => {
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const secrets = new SecretStore(join(dir, `${sub}-secrets.json`), undefined);
    const team = (id: string) => ({ id, name: id, shortName: id.slice(0, 3), logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false });
    const match = { id: "m", eventId: null, stageId: null, teamAId: "alpha", teamBId: "bravo", format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, status: "live" as const, scheduledAt: null, seriesScoreA: 0, seriesScoreB: 0, mapPool: [], vetoSequenceId: null, title: null };
    const c = new TeamComms({ settings, secrets, logger: new Logger("error", null), dataDir: join(dir, sub), now: () => performance.now(), roster: { activeMatch: () => match, team, player: () => null, assetUrl: () => null } });
    all.push(c);
    c.updateSlot("A", { channel: channels.A, serverHost: "ts.example.org" });
    c.updateSlot("B", { channel: channels.B, serverHost: "ts.example.org" });
    await c.updateSettings({ enabled: true, bridgePort: 0, delaySec: 0, fineMs: 200 });
    return c;
  };
  const host$ = async (seconds: number, bridgeFile: string, extra: string[] = []): Promise<HostResult> => {
    const out = await run(host, [so, String(seconds), ...extra], { env: { ...process.env, MATCHFRAME_COMMS_BRIDGE_FILE: bridgeFile, MATCHFRAME_COMMS_TABS_FILE: tabsFile }, timeout: 20_000 });
    return JSON.parse(out.stdout.trim().split("\n").pop()!) as HostResult;
  };

  it("captures each speaker apart with their identity, keeps the tabs listen-only and silent here, signals recording", async () => {
    const comms = await engine({ A: "Team Alpha", B: "Team Bravo" }, "first");
    for (const k of comms.status().participants) comms.updateParticipant(k.key, {});
    const signal = setTimeout(() => comms.setRecordingSignal(true), 1500);
    let mid: ReturnType<TeamComms["status"]> | null = null;
    const snap = setTimeout(() => (mid = comms.status()), 3500);
    const r = await host$(4, comms.bridgeFile());
    clearTimeout(signal);
    clearTimeout(snap);
    const st = comms.status();

    expect(r.apiVersion).toBe(26);
    // Six people, each by identity in their own team's slot; the listener is nobody.
    expect(st.participants.map((p) => `${p.slot}:${p.nickname}`).sort()).toEqual(["A:Alpha 1", "A:Alpha 2", "A:Alpha 3", "B:Bravo 1", "B:Bravo 2", "B:Bravo 3"]);
    expect(st.participants.every((p) => p.buffer.bytes > 0 || p.buffer.heldMs >= 0)).toBe(true);
    // Alpha 2 came back with session id 15: the same person.
    expect(st.participants.find((p) => p.nickname === "Alpha 2")!.clientId).toBe(15);
    const plugin = st.bridge.plugins.length ? st.bridge.plugins[0]! : null;
    expect(plugin).toBeNull(); // the host unloaded the plugin: it disconnected
    expect(st.slots.map((s) => s.lost?.reason ?? "")).toEqual([expect.stringMatching(/plugin disconnected/), expect.stringMatching(/plugin disconnected/)]);
    // Both tabs: microphone deactivated and muted (never deafened), recording signalled.
    for (const schid of [1, 2]) {
      expect(r.calls).toContain(`set ${schid} inputDeactivated=1`);
      expect(r.calls).toContain(`set ${schid} inputMuted=1`);
      expect(r.calls).toContain(`startVoiceRecording ${schid}`);
    }
    expect(r.calls.some((c) => /outputMuted/.test(c))).toBe(false);
    // Every voice block after MatchFrame managed the tab was zeroed for local playback (only the first
    // moments before the MANAGE arrived played); the callbacks kept coming.
    expect(r.voiceCalls).toBeGreaterThan(2500);
    expect(r.zeroed / r.voiceCalls).toBeGreaterThan(0.9);
    expect(r.mixedZeroed / r.mixedCalls).toBeGreaterThan(0.9);
    expect(r.micBlocked / r.mixedCalls).toBeGreaterThan(0.9);
    // While it ran: both tabs captured, by server and channel, the listener's own state as the plugin set it.
    const m = mid as ReturnType<TeamComms["status"]> | null;
    expect(m).not.toBeNull();
    expect(m!.tabs.map((t) => [t.slot, t.channel?.name, t.capturing, t.listener?.inputMuted, t.listener?.inputDeactivated, t.listener?.outputMuted]).sort()).toEqual([
      ["A", "Team Alpha", true, true, true, false],
      ["B", "Team Bravo", true, true, true, false],
    ]);
    expect(m!.tabs.every((t) => t.audioBlocks > 1000 && t.ignored.listener === 0)).toBe(true);
    expect(m!.bridge.plugins[0]!.counters).toMatchObject({ invalid: 0, sequenceGaps: 0 });
    expect(m!.bridge.plugins[0]!.pluginStats!.queue.dropped).toBe(0);
    expect(m!.bridge.plugins[0]!.clock.source).toBe("ping");
    // The plugin remembered both team tabs (server, channel, and the address TeamSpeak dials) for a TeamSpeak restart.
    expect(readFileSync(tabsFile, "utf8").split("\n").filter(Boolean).sort()).toEqual(["MFTABS2", "hostServerUid=\tTeam Alpha\tts.example.org\t9987", "hostServerUid=\tTeam Bravo\tts.example.org\t9987"]);
    // Nothing remembered at that first start: what played while connecting was TeamSpeak's.
    expect(r.tabs["1"].earlyZeroed).toBe(0);
  }, 30_000);

  it("a restarted TeamSpeak keeps the remembered team tabs listen-only and silent before MatchFrame answers (MatchFrame not running)", async () => {
    // TeamSpeak restarted (a new process) while MatchFrame isn't there: no bridge file.
    const r = await host$(2, join(dir, "no-matchframe", "bridge.json"), ["still"]);
    for (const schid of [1, 2]) {
      expect(r.calls).toContain(`set ${schid} inputDeactivated=1`);
      expect(r.calls).toContain(`set ${schid} inputMuted=1`);
    }
    // Every block of both tabs silent here from the first one, also while still connecting; never deafened; nothing captured (no MatchFrame).
    expect(r.tabs["1"].untouched).toBe(0);
    expect(r.tabs["2"].untouched).toBe(0);
    expect([r.tabs["1"].earlyZeroed, r.tabs["2"].earlyZeroed]).toEqual([3, 3]);
    expect(r.tabs["1"].zeroed + r.tabs["2"].zeroed).toBeGreaterThan(1000);
    expect(r.calls.some((c) => /outputMuted|startVoiceRecording/.test(c))).toBe(false);
    // A tab in a channel MatchFrame never captured is TeamSpeak's own: on a team's server it stays silent
    // for its first 3 s (a new connection is first placed in the server's default channel and moved on),
    // then plays from its next event; its microphone is never touched.
    writeFileSync(tabsFile, "MFTABS2\nhostServerUid=\tTeam Alpha\tts.example.org\t9987\n");
    const one = await host$(4.5, join(dir, "no-matchframe", "bridge.json"), ["still"]);
    expect(one.tabs["1"].untouched).toBe(0);
    expect(one.tabs["2"].earlyZeroed).toBe(3);
    expect(one.tabs["2"].zeroed).toBeGreaterThan(1000);
    expect(one.tabs["2"].untouched).toBeGreaterThan(200);
    expect(one.calls.some((c) => c.startsWith("set 2 "))).toBe(false);
    // An older file (server and channel only) works the same.
    writeFileSync(tabsFile, "MFTABS1\nhostServerUid=\tTeam Alpha\n");
    const v1 = await host$(1.5, join(dir, "no-matchframe", "bridge.json"), ["still"]);
    expect(v1.tabs["1"]).toMatchObject({ untouched: 0, earlyZeroed: 3 });
    expect(v1.tabs["2"].earlyZeroed).toBe(3);
    expect(v1.calls.some((c) => c.startsWith("set 2 "))).toBe(false);
  }, 30_000);

  it("MatchFrame hands back a remembered tab that is no team's now; the plugin forgets it", async () => {
    writeFileSync(tabsFile, "MFTABS2\nhostServerUid=\tTeam Alpha\tts.example.org\t9987\nhostServerUid=\tTeam Bravo\tts.example.org\t9987\n");
    // Team B now plays from another channel: the remembered Team Bravo tab is no team's.
    const comms = await engine({ A: "Team Alpha", B: "Team Charlie" }, "moved");
    let mid: ReturnType<TeamComms["status"]> | null = null;
    const snap = setTimeout(() => (mid = comms.status()), 2500);
    const r = await host$(3, comms.bridgeFile(), ["still"]);
    clearTimeout(snap);
    const m = mid as ReturnType<TeamComms["status"]> | null;
    expect(m!.tabs.map((t) => [t.channel?.name, t.slot, t.capturing, t.restoredByPlugin, t.released]).sort()).toEqual([
      ["Team Alpha", "A", true, true, false],
      ["Team Bravo", null, false, true, true],
    ]);
    // Bravo's tab plays again here once handed back (its first blocks were silent until then); Alpha's stays silent and captured.
    expect(r.tabs["1"].untouched).toBe(0);
    expect(r.tabs["2"].untouched).toBeGreaterThan(r.tabs["2"].zeroed);
    expect(readFileSync(tabsFile, "utf8").split("\n").filter(Boolean)).toEqual(["MFTABS2", "hostServerUid=\tTeam Alpha\tts.example.org\t9987"]);
    expect(m!.slots[1]).toMatchObject({ state: "waiting" });
  }, 30_000);
});
