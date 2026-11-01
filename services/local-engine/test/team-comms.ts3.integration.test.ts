import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SecretStore } from "../src/auth.ts";
import { Database } from "../src/db/database.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { Logger } from "../src/logger.ts";
import { TeamComms } from "../src/comms/service.ts";
import { peakAmplitude } from "./helpers/fake-ts3-plugin.ts";

/**
 * Team Comms against real TeamSpeak (ADR-065): the rig of native/ts3-matchframe-plugin/test/real/ts3-rig.sh
 * (TeamSpeak 3 server, a listener client with the plugin per team, talkers with a tone each) must be
 * running with BRIDGE_FILE=$MATCHFRAME_TS3_RIG/engine/team-comms/bridge.json. Skipped otherwise.
 *
 *   MATCHFRAME_TS3_RIG=<rig WORK folder> pnpm vitest run services/local-engine/test/team-comms.ts3.integration.test.ts
 */
const RIG = process.env.MATCHFRAME_TS3_RIG;
const FA = [330, 470, 610, 750, 890, 1030, 1170];
const FB = [1310, 1450, 1590, 1730, 1870, 2010, 2150];
const freq = (nickname: string) => {
  const m = /^(Alpha|Bravo) (\d)$/.exec(nickname);
  return m ? (m[1] === "Alpha" ? FA : FB)[Number(m[2]) - 1]! : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!RIG)("Team Comms with real TeamSpeak (rig)", () => {
  let comms: TeamComms | null = null;
  afterAll(async () => {
    await comms?.stop();
  });

  it("captures both teams' people separately, by identity, listen-only, silent on this computer", async () => {
    const dir = join(RIG!, "engine");
    mkdirSync(dir, { recursive: true });
    const db = new Database(":memory:");
    db.migrate();
    const team = (id: string) => ({ id, name: id, shortName: id.slice(0, 3), logoAssetId: null, primaryColor: null, secondaryColor: null, region: null, countryCode: null, sponsorMetadata: {}, archived: false });
    const match = { id: "m", eventId: null, stageId: null, teamAId: "alpha", teamBId: "bravo", format: { bestOf: 1, regulationRounds: 24, overtimeEnabled: true, overtimeRounds: 6, allowTie: false }, status: "live" as const, scheduledAt: null, seriesScoreA: 0, seriesScoreB: 0, mapPool: [], vetoSequenceId: null, title: null };
    comms = new TeamComms({ settings: new SettingsRepo(db), secrets: new SecretStore(join(dir, "secrets.json"), undefined), logger: new Logger("warn", null), dataDir: dir, now: () => performance.now(), roster: { activeMatch: () => match, team, player: () => null, assetUrl: () => null } });
    comms.updateSlot("A", { channel: "Team Alpha", serverHost: "127.0.0.1" });
    comms.updateSlot("B", { channel: "Team Bravo", serverHost: "127.0.0.1" });
    await comms.updateSettings({ enabled: true, bridgePort: Number(process.env.MATCHFRAME_COMMS_PORT ?? 37213), delaySec: 0, fineMs: 500 });
    // The plugin retries every few seconds; TeamSpeak's tabs are bound once it reports them.
    const until = Date.now() + 60_000;
    while (Date.now() < until && !comms.status().slots.every((s) => s.tab?.capturing)) await sleep(250);
    const st = comms.status();
    expect(st.slots.map((s) => [s.id, s.tab?.channel?.name, s.tab?.capturing])).toEqual([
      ["A", "Team Alpha", true],
      ["B", "Team Bravo", true],
    ]);
    for (const s of st.slots) expect(s.tab!.listener).toMatchObject({ inputMuted: true, inputDeactivated: true, outputMuted: false });
    for (const pl of st.bridge.plugins) {
      expect(pl.ts3?.clientLibVersion).toMatch(/^3\.6\./);
      expect(pl.plugin?.apiVersion).toBe(26);
    }
    // Everyone in each channel is a person of that team; nobody is the listener.
    await sleep(8000);
    const people = comms.status().participants;
    const listenerIds = new Set(st.tabs.map((t) => t.listener?.clientId));
    expect(people.length).toBeGreaterThanOrEqual(2);
    expect(people.every((p) => (p.slot === "A" ? /^Alpha/ : /^Bravo/).test(p.nickname))).toBe(true);
    expect(people.some((p) => listenerIds.has(p.clientId ?? -1))).toBe(false);
    // Each person soloed in the preview in turn: their own tone, nobody else's.
    const preview: Float32Array[] = [];
    const off = comms.addSink("preview", { write: (b) => preview.push(Float32Array.from(b)) });
    for (const p of people) {
      const f = freq(p.nickname);
      if (!f) continue;
      comms.updateParticipant(p.key, { preview: true });
      await sleep(7000);
      preview.length = 0;
      await sleep(6000);
      comms.updateParticipant(p.key, { preview: false });
      const x = new Float32Array(preview.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of preview) x.set(b, (o += b.length) - b.length);
      expect(peakAmplitude(x, f)).toBeGreaterThan(0.02);
      for (const q of people) if (q !== p && freq(q.nickname)) expect(peakAmplitude(x, freq(q.nickname)!)).toBeLessThan(peakAmplitude(x, f) / 30);
    }
    off();
    for (const plugin of comms.status().bridge.plugins) {
      expect(plugin.counters).toMatchObject({ invalid: 0, sequenceGaps: 0 });
      expect(plugin.pluginStats!.queue.dropped).toBe(0);
      // Local playback: every captured block was zeroed, and the callbacks kept coming.
      for (const c of plugin.pluginStats!.connections.filter((x) => x.managed)) expect(c.zeroed).toBeGreaterThanOrEqual(c.captured);
    }
  }, 600_000);
});
