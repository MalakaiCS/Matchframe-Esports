import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
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

describe.skipIf(!gxx || !existsSync(join(sdk, "ts3_functions.h")))("Team Comms plugin binary (stand-in TeamSpeak host, real bridge)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-plugin-"));
  let comms: TeamComms | null = null;
  afterAll(async () => {
    await comms?.stop();
  });

  it("captures each speaker apart with their identity, keeps the tabs listen-only and silent here, signals recording", async () => {
    const so = join(dir, "matchframe_comms_linux_amd64.so");
    const host = join(dir, "host");
    await run("g++", ["-std=c++17", "-O2", "-shared", "-fPIC", "-fvisibility=hidden", "-pthread", `-I${sdk}`, `-I${join(root, "src")}`, join(root, "src/plugin.cpp"), "-o", so]);
    await run("g++", ["-std=c++17", "-O2", "-pthread", `-I${sdk}`, join(root, "test/host.cpp"), "-o", host, "-ldl"]);

    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const secrets = new SecretStore(join(dir, "secrets.json"), undefined);
    const team = (id: string) => ({ id, name: id, shortName: id.slice(0, 3), logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false });
    const match = { id: "m", eventId: null, stageId: null, teamAId: "alpha", teamBId: "bravo", format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, status: "live" as const, scheduledAt: null, seriesScoreA: 0, seriesScoreB: 0, mapPool: [], vetoSequenceId: null, title: null };
    comms = new TeamComms({ settings, secrets, logger: new Logger("error", null), dataDir: dir, now: () => performance.now(), roster: { activeMatch: () => match, team, player: () => null, assetUrl: () => null } });
    comms.updateSlot("A", { channel: "Team Alpha", serverHost: "ts.example.org" });
    comms.updateSlot("B", { channel: "Team Bravo", serverHost: "ts.example.org" });
    await comms.updateSettings({ enabled: true, bridgePort: 0, delaySec: 0, fineMs: 200 });
    for (const k of comms.status().participants) comms.updateParticipant(k.key, {});
    const signal = setTimeout(() => comms!.setRecordingSignal(true), 1500);
    let mid: ReturnType<TeamComms["status"]> | null = null;
    const snap = setTimeout(() => (mid = comms!.status()), 3500);
    const out = await run(host, [so, "4"], { env: { ...process.env, MATCHFRAME_COMMS_BRIDGE_FILE: comms.bridgeFile() }, timeout: 20_000 });
    clearTimeout(signal);
    clearTimeout(snap);
    const r = JSON.parse(out.stdout.trim().split("\n").pop()!) as { apiVersion: number; voiceCalls: number; zeroed: number; untouched: number; mixedCalls: number; mixedZeroed: number; micBlocked: number; calls: string[] };
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
    // Every voice block after Matchframe managed the tab was zeroed for local playback (only the first
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
  }, 30_000);
});
