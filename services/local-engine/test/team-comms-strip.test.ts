import { afterEach, describe, expect, it } from "vitest";
import { BLOCK } from "../src/comms/mixer.ts";
import { MAX_CARDS, SILHOUETTE_URL, SpeakerStrip, StripSettings, type StripConfigMessage, type StripMessage, type StripPictures } from "../src/comms/strip.ts";
import type { RecordingPerson, TeamComms } from "../src/comms/service.ts";
import { PRESENT, QUIET, Rig, TEAM_A, TEAM_B, type Person } from "./helpers/comms-rig.ts";
import { amplitudeAt } from "./helpers/fake-ts3-plugin.ts";

/**
 * The dedicated recording's speaker strip (ADR-068), fixture-tested on the simulated clock with the
 * real bridge and a stand-in TeamSpeak plugin: who has a card, who lights, and when, against what
 * the recording mix actually holds. Each person speaks a tone of their own.
 */

const LATENCY = 60;
const rigs: Rig[] = [];
const strips: SpeakerStrip[] = [];
afterEach(async () => {
  for (const s of strips.splice(0)) s.close();
  for (const r of rigs.splice(0)) await r.stop();
});

interface Setup {
  r: Rig;
  strip: SpeakerStrip;
  cfg: { value: StripSettings };
  audible: { value: boolean };
  /** The recording's team heard in each block (block start → team). */
  heardTeam: Map<number, string | null>;
}

async function setup(o: { delaySec?: number; strip?: Partial<StripSettings>; roster?: string[] } = {}): Promise<Setup> {
  const r = new Rig();
  rigs.push(r);
  await r.start({ delaySec: o.delaySec ?? 2 });
  await r.openTabs();
  const cfg = { value: StripSettings.parse(o.strip ?? {}) };
  const audible = { value: true };
  const pictures: StripPictures = {
    player: (id) => {
      const p = r.players.get(id);
      return p ? { displayName: p.displayName, pictureUrl: p.avatarAssetId && p.photoVisible ? `/assets/${p.avatarAssetId}` : null } : null;
    },
    rosterOrder: () => o.roster ?? [...r.players.keys()],
    defaultPicture: () => null,
    assetUrl: (id) => (id ? `/assets/${id}` : null),
  };
  const strip = new SpeakerStrip({ comms: r.comms, settings: r.settings, config: () => cfg.value, pictures, overlayPort: () => 1, sendLatencyMs: () => LATENCY, commsAudible: () => audible.value, now: () => r.sim, realtime: false });
  strips.push(strip);
  const heardTeam = new Map<number, string | null>();
  r.comms.onBlock((b) => heardTeam.set(b.start, b.recording.team));
  return { r, strip, cfg, audible, heardTeam };
}

/** Everything the strip sent, in order, with the output time it belongs to (its due time less the send latency). */
function sent(s: Setup): { atMs: number; msg: StripMessage }[] {
  s.strip.flushUntil(s.r.sim + 10_000_000);
  return s.strip.log.map((l) => ({ atMs: l.dueMs - LATENCY - s.cfg.value.timingOffsetMs, msg: l.msg }));
}

/** Per card name, the output-time intervals it was lit. */
function litIntervals(s: Setup): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let names = new Map<string, string>();
  const open = new Map<string, number>();
  const close = (name: string, at: number) => {
    const from = open.get(name);
    if (from === undefined) return;
    open.delete(name);
    out.set(name, [...(out.get(name) ?? []), [from, at]]);
  };
  for (const { atMs, msg } of sent(s)) {
    if (msg.type === "strip-config") {
      names = new Map(msg.cards.map((c) => [c.id, c.name]));
      for (const n of [...open.keys()]) if (![...names.values()].includes(n)) close(n, atMs);
    } else {
      const on = new Set(msg.speaking.map((id) => names.get(id)!));
      for (const n of [...open.keys()]) if (!on.has(n)) close(n, atMs);
      for (const n of on) if (!open.has(n)) open.set(n, atMs);
    }
  }
  for (const n of [...open.keys()]) close(n, Infinity);
  return out;
}

const configs = (s: Setup) => sent(s).filter((m): m is { atMs: number; msg: StripConfigMessage } => m.msg.type === "strip-config");

/** The output times (ms) the recording mix holds a person's tone, from block to block. */
function audioIntervals(r: Rig, p: Person): [number, number][] {
  const blocks = [...r.out.recording.keys()].sort((a, b) => a - b);
  const out: [number, number][] = [];
  let from: number | null = null;
  let last = 0;
  for (const s of blocks) {
    const loud = amplitudeAt(r.out.recording.get(s)!, p.freq) > PRESENT;
    if (loud && from === null) from = s / 48;
    if (!loud && from !== null) {
      out.push([from, s / 48]);
      from = null;
    }
    last = s;
  }
  if (from !== null) out.push([from, (last + BLOCK) / 48]);
  return out;
}

describe("the recording speaker strip (simulated clock, stand-in plugin)", () => {
  it("only included people have a card, in a stable order; only included active speakers light, all of them during overlapping speech; an excluded coach never does", async () => {
    const s = await setup();
    const { r } = s;
    // Five players in the recording; the coach (Alpha 6) and the manager (Alpha 7) excluded.
    for (const p of r.a.slice(0, 5)) r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    const [a1, a2, a3, a4, , a6, a7] = r.a as [Person, Person, Person, Person, Person, Person, Person];
    // Needs the 2 s of history first.
    await r.run(2500);
    const t0 = r.sim;
    // 0–1 s: Alpha 1, 2 and the coach together; 1.5–2 s Alpha 3; 2.5–3 s the manager alone; 3.5–4.5 s Alpha 4 and Alpha 1.
    const talk = (t: number) => [...(t < 1000 ? [a1, a2, a6] : []), ...(t >= 1500 && t < 2000 ? [a3] : []), ...(t >= 2500 && t < 3000 ? [a7] : []), ...(t >= 3500 && t < 4500 ? [a4, a1] : [])];
    await r.run(5000, talk);
    await r.run(3000);
    const cfgs = configs(s);
    // One set of cards for the whole run: speaking never rebuilds, reorders or resizes them.
    expect(cfgs.map((c) => c.msg.cards.map((x) => x.name))).toEqual([["Alpha 1", "Alpha 2", "Alpha 3", "Alpha 4", "Alpha 5"]]);
    expect(cfgs[0]!.msg.cards.every((c) => c.pictureUrl === SILHOUETTE_URL && c.placeholder)).toBe(true);
    const lit = litIntervals(s);
    // The coach and the manager: never a card, never lit (and never in the recording).
    expect(lit.has("Alpha 6")).toBe(false);
    expect(lit.has("Alpha 7")).toBe(false);
    expect(r.heard("recording", t0, t0 + 10_000).get("Alpha 6")).toBeLessThan(QUIET);
    expect(r.heard("recording", t0, t0 + 10_000).get("Alpha 7")).toBeLessThan(QUIET);
    // Overlap: Alpha 1 and 2 lit together (2 s after they spoke), then Alpha 3, then Alpha 4 and 1 together.
    const at = (ms: number) => [...lit].filter(([, iv]) => iv.some(([a, b]) => a <= t0 + ms && t0 + ms < b)).map(([n]) => n).sort();
    expect(at(2500)).toEqual(["Alpha 1", "Alpha 2"]);
    expect(at(3800)).toEqual(["Alpha 3"]);
    expect(at(4700)).toEqual([]);
    expect(at(6000)).toEqual(["Alpha 1", "Alpha 4"]);
    expect(lit.has("Alpha 5")).toBe(false);
    // The page is told card ids, names, pictures and crops only: never a TeamSpeak identity.
    expect(JSON.stringify(sent(s))).not.toMatch(/uidA|serverUid|team-alpha/);
  });

  it("lights with the audio the recording holds: onset within the attack, held through syllable gaps, released after the release time", async () => {
    const s = await setup({ strip: { attackMs: 30, releaseMs: 350 } });
    const { r } = s;
    const p = r.a[0]!;
    r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(2500);
    // Three syllables 300 ms long with 150 ms gaps, then silence.
    const syl = (t: number) => [0, 450, 900].some((a) => t >= a && t < a + 300);
    await r.run(4000, (t) => (syl(t) ? [p] : []));
    await r.run(1000);
    const audio = audioIntervals(r, p);
    expect(audio.length).toBe(3);
    const lit = litIntervals(s).get("Alpha 1")!;
    // One lit interval across the gaps (no flicker).
    expect(lit.length).toBe(1);
    const [from, to] = lit[0]!;
    const onsetErr = from - audio[0]![0];
    expect(onsetErr).toBeGreaterThanOrEqual(0);
    expect(onsetErr).toBeLessThanOrEqual(30 + 2 * 10);
    // Off after the release (plus the meter's own fall below the speaking level, under 100 ms).
    const releaseErr = to - audio[2]![1];
    expect(releaseErr).toBeGreaterThanOrEqual(350);
    expect(releaseErr).toBeLessThanOrEqual(350 + 120);
  });

  it("a 90 s delay: the strip lights 90 s after TeamSpeak played the voice, with the recording's audio, never before the buffer holds 90 s", async () => {
    const s = await setup({ delaySec: 90 });
    const { r } = s;
    const [p, q] = [r.a[2]!, r.a[4]!];
    r.set(p, { includeRecording: true });
    r.set(q, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    const t0 = r.sim;
    const bursts = [[30_000, 30_600, p], [60_000, 61_000, q], [89_000, 89_400, p]] as const;
    await r.run(95_000, (t) => bursts.filter(([a, b]) => t >= a && t < b).map(([, , w]) => w), { batchMs: 1000 });
    await r.run(91_000, () => [], { batchMs: 5000 });
    const lit = litIntervals(s);
    // Nothing lit in the first 90 s (the buffer held less than the delay).
    for (const iv of lit.values()) for (const [a] of iv) expect(a).toBeGreaterThan(t0 + 90_000);
    const errors: number[] = [];
    for (const [a, , w] of bursts) {
      const audio = audioIntervals(r, w).find(([x]) => x >= t0 + a + 90_000 - 50 && x < t0 + a + 90_000 + 50)!;
      expect(audio).toBeDefined();
      // The voice itself: 90 s after it was played, within one block.
      expect(Math.abs(audio[0] - (t0 + a + 90_000))).toBeLessThanOrEqual(10);
      const on = lit.get(w.nickname)!.find(([x]) => Math.abs(x - audio[0]) < 200)!;
      expect(on).toBeDefined();
      errors.push(on[0] - audio[0]);
    }
    // Strip vs the recording's audio: within the attack (30 ms) and a block, every time.
    for (const e of errors) {
      expect(e).toBeGreaterThanOrEqual(0);
      expect(e).toBeLessThanOrEqual(50);
    }
  });

  it("a team change: the comms mix and the cards change on the same block", async () => {
    const s = await setup();
    const { r } = s;
    for (const p of r.a.slice(0, 3)) r.set(p, { includeRecording: true });
    for (const p of r.b.slice(0, 2)) r.set(p, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    const [a1, b1] = [r.a[0]!, r.b[0]!];
    await r.run(2500, () => [a1, b1]);
    const switchAt = r.sim;
    r.comms.setRecordingTeam(TEAM_B);
    await r.run(2000, () => [a1, b1]);
    const cfgs = configs(s);
    expect(cfgs.map((c) => c.msg.cards.map((x) => x.name))).toEqual([
      ["Alpha 1", "Alpha 2", "Alpha 3"],
      ["Bravo 1", "Bravo 2"],
    ]);
    // The block the recording first carries Team B is the block the cards become Team B's.
    const firstB = [...s.heardTeam].filter(([start, t]) => t === TEAM_B && start / 48 >= switchAt - 20).map(([start]) => start).sort((x, y) => x - y)[0]!;
    expect(cfgs[1]!.atMs).toBe(firstB / 48);
    // ...and the audio: Alpha before it, Bravo after it (through silence in between: never both).
    const before = r.slice("recording", firstB / 48 - 60, firstB / 48 - 20);
    const after = r.slice("recording", firstB / 48 + 30, firstB / 48 + 200);
    expect(amplitudeAt(before, a1.freq)).toBeGreaterThan(PRESENT);
    expect(amplitudeAt(before, b1.freq)).toBeLessThan(QUIET);
    expect(amplitudeAt(after, b1.freq)).toBeGreaterThan(PRESENT);
    expect(amplitudeAt(after, a1.freq)).toBeLessThan(QUIET);
    // Bravo 1 lights after the change, Alpha 1 not any more.
    const lit = litIntervals(s);
    expect(lit.get("Bravo 1")!.some(([a]) => a >= firstB / 48)).toBe(true);
    expect(lit.get("Alpha 1")!.every(([, b]) => b <= firstB / 48)).toBe(true);
  });

  it("excluding someone while they speak removes their card on the block their voice leaves the recording", async () => {
    const s = await setup();
    const { r } = s;
    const [a1, a2] = [r.a[0]!, r.a[1]!];
    r.set(a1, { includeRecording: true });
    r.set(a2, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(3000, () => [a1, a2]);
    const at = r.sim;
    r.set(a2, { includeRecording: false });
    await r.run(1000, () => [a1, a2]);
    const cfgs = configs(s);
    expect(cfgs.map((c) => c.msg.cards.map((x) => x.name))).toEqual([["Alpha 1", "Alpha 2"], ["Alpha 1"]]);
    const removedAt = cfgs[1]!.atMs;
    // The card goes with the first block rendered after the change...
    // ...the block where the voice starts fading out (the 10 ms inclusion ramp): gone from the next block on.
    expect(removedAt).toBe(at);
    const after = r.slice("recording", removedAt + 10, removedAt + 400);
    expect(amplitudeAt(after, a2.freq)).toBeLessThan(QUIET);
    expect(amplitudeAt(after, a1.freq)).toBeGreaterThan(PRESENT);
    expect(amplitudeAt(r.slice("recording", removedAt - 400, removedAt), a2.freq)).toBeGreaterThan(PRESENT);
    // Buffered speech of the excluded person never lights again.
    expect(litIntervals(s).get("Alpha 2")!.every(([, b]) => b <= removedAt)).toBe(true);
  });

  it("the recording's comms level off: the cards stay, nobody lights", async () => {
    const s = await setup();
    const { r } = s;
    r.set(r.a[0]!, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    s.audible.value = false;
    await r.run(4000, () => [r.a[0]!]);
    expect(configs(s).at(-1)!.msg.cards.map((c) => c.name)).toEqual(["Alpha 1"]);
    expect(litIntervals(s).size).toBe(0);
  });

  it("a settings change while a newer card set is still queued: the pages end with the current cards, never an older set", async () => {
    const s = await setup();
    const { r } = s;
    r.set(r.a[0]!, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(500);
    s.strip.flushUntil(r.sim + 1000);
    r.set(r.a[1]!, { includeRecording: true });
    // A block renders: the two-card set is queued for its send time (60 ms on).
    await r.run(20);
    r.set(r.a[2]!, { includeRecording: true });
    s.cfg.value = StripSettings.parse({ ...s.cfg.value, labels: true });
    s.strip.refresh();
    s.strip.flushUntil(r.sim + 1000);
    await r.run(200);
    s.strip.flushUntil(r.sim + 1000);
    expect(s.strip.current().config.cards.map((c) => c.name)).toEqual(["Alpha 1", "Alpha 2", "Alpha 3"]);
    expect(s.strip.current().config.layout.labels).toBe(true);
  });

  it("timing offset: every message moves by it (the calibration against the recording file)", async () => {
    const s = await setup({ strip: { timingOffsetMs: 120 } });
    const { r } = s;
    r.set(r.a[0]!, { includeRecording: true });
    r.comms.setRecordingTeam(TEAM_A);
    await r.run(3000, () => [r.a[0]!]);
    s.strip.flushUntil(r.sim + 10_000);
    const first = s.strip.log.find((l) => l.msg.type === "strip-speaking" && l.msg.speaking.length)!;
    const audio = audioIntervals(r, r.a[0]!)[0]!;
    expect(first.dueMs - (audio[0] + LATENCY + 120)).toBeGreaterThanOrEqual(0);
    expect(first.dueMs - (audio[0] + LATENCY + 120)).toBeLessThanOrEqual(50);
  });
});

describe("the strip's cards (stand-in Team Comms)", () => {
  const people = (n: number, teamId = "t1"): RecordingPerson[] => Array.from({ length: n }, (_, i) => ({ key: `${teamId}/srv/uid${i}`, displayName: `TS ${i}`, playerId: i < 4 ? `p${i}` : null, includeRecording: true, present: true, firstSeen: `2026-11-01T10:00:0${i}.000Z` }));
  const make = (list: RecordingPerson[], o: { cfg?: Partial<StripSettings>; pics?: Partial<StripPictures>; roster?: string[] } = {}) => {
    const comms = { onBlock: () => () => undefined, recordingPeople: () => list, peopleVersion: 0 } as unknown as TeamComms;
    const store = new Map<string, unknown>();
    const settings = { get: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d), set: (k: string, v: unknown) => void store.set(k, v) } as never;
    const pictures: StripPictures = {
      player: (id) => ({ displayName: `Player ${id}`, pictureUrl: id === "p0" ? "/assets/p0.png" : null }),
      rosterOrder: () => o.roster ?? ["p3", "p2", "p1", "p0"],
      defaultPicture: (_t, i) => (i === 1 ? "/assets/default-ct-2.png" : null),
      assetUrl: (id) => (id ? `/assets/${id}` : null),
      ...o.pics,
    };
    return new SpeakerStrip({ comms, settings, config: () => StripSettings.parse(o.cfg ?? {}), pictures, overlayPort: () => 1, sendLatencyMs: () => 60, commsAudible: () => true, now: () => 0, realtime: false });
  };

  it("roster order first, then the others as first seen; one to seven cards; more than seven: the first seven and a warning", () => {
    const s = make(people(5));
    const { cards } = s.cardsFor("t1");
    expect(cards.map((c) => c.name)).toEqual(["Player p3", "Player p2", "Player p1", "Player p0", "TS 4"]);
    s.close();
    for (const n of [1, 7]) {
      const k = make(people(n));
      expect(k.cardsFor("t1").cards).toHaveLength(n);
      k.close();
    }
    const many = make(people(9));
    const r = many.cardsFor("t1");
    expect(r.cards).toHaveLength(MAX_CARDS);
    expect(r.overLimit).toBe(2);
    many.close();
    const none = make(people(3).map((p) => ({ ...p, includeRecording: false })));
    expect(none.cardsFor("t1").cards).toEqual([]);
    none.close();
  });

  it("pictures: the roster's own, else the HUD images' default for that player, else the operator's placeholder, else Matchframe's silhouette; crops per player", () => {
    const s = make(people(5), { cfg: { placeholderAssetId: "aaaaaaaaaaaaaaaaaaaaaaaa.png", crops: { "player:p0": { x: 40, y: 20, zoom: 1.4 } } } });
    const byName = new Map(s.cardsFor("t1").cards.map((c) => [c.name, c]));
    expect(byName.get("Player p0")).toMatchObject({ picture: "own", pictureUrl: "/assets/p0.png", crop: { x: 40, y: 20, zoom: 1.4 }, cropKey: "player:p0" });
    // p2 is second in the roster: the HUD images' default player picture 2.
    expect(byName.get("Player p2")).toMatchObject({ picture: "hud-default", pictureUrl: "/assets/default-ct-2.png" });
    expect(byName.get("Player p1")).toMatchObject({ picture: "placeholder", pictureUrl: "/assets/aaaaaaaaaaaaaaaaaaaaaaaa.png", crop: { x: 50, y: 30, zoom: 1 } });
    expect(byName.get("TS 4")!.cropKey).toMatch(/^person:c[0-9a-f]{12}$/);
    s.close();
    const plain = make(people(2), { cfg: { useHudDefaults: false } });
    expect(plain.cardsFor("t1").cards.map((c) => [c.name, c.picture])).toEqual([["Player p1", "silhouette"], ["Player p0", "own"]]);
    plain.close();
  });
});
