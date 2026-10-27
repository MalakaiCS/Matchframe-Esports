import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DerivedEvent } from "@matchframe/cs2-state";
import { BuiltinRadars, builtinRadarScale, builtinRadarUv } from "../src/live/builtin-radars.ts";
import { KillfeedBuilder } from "../src/live/killfeed.ts";

const RADARS = join(import.meta.dirname, "..", "..", "..", "assets", "radars");

describe("built-in radars", () => {
  const radars = BuiltinRadars.load(RADARS);

  it("loads the eight bundled maps with their images", () => {
    expect(radars.maps).toEqual(["de_ancient", "de_dust2", "de_inferno", "de_mirage", "de_nuke", "de_overpass", "de_train", "de_vertigo"]);
    expect(radars.get("de_anubis")).toBeUndefined();
    expect(radars.get("de_dust2")!.file).toMatch(/de_dust2\.png$/);
  });

  it("maps world positions onto the image like the game's overview (Dust II: pos 2476, 3239, scale 4.4)", () => {
    const d2 = radars.get("de_dust2")!;
    // The overview's top-left corner is world (-2476, 3239): image pixel (0, 0) within a pixel or two.
    const corner = builtinRadarUv(d2, { x: -2476, y: 3239, z: 0 })!;
    expect(corner.u * 1024).toBeCloseTo(0, -0.5);
    expect(corner.v * 1024).toBeCloseTo(0, -0.5);
    // 440 units is about 100 px.
    expect(builtinRadarScale(d2, 0) * 440 * 1024).toBeCloseTo(100, -0.5);
    expect(builtinRadarUv(d2, { x: 99_999, y: 0, z: 0 })).toBeNull();
  });

  it("puts Nuke's lower level on the lower drawing", () => {
    const nuke = radars.get("de_nuke")!;
    const upper = builtinRadarUv(nuke, { x: 0, y: 0, z: 0 })!;
    const lower = builtinRadarUv(nuke, { x: 0, y: 0, z: -600 })!;
    expect(upper.layerId).toBe("upper");
    expect(lower.layerId).toBe("lower");
    expect(lower.v).toBeGreaterThan(upper.v + 0.3);
  });

  it("ignores a missing folder", () => {
    expect(BuiltinRadars.load(null).maps).toEqual([]);
    expect(BuiltinRadars.load(join(RADARS, "missing")).maps).toEqual([]);
  });
});

const ev = (kind: DerivedEvent["kind"], data: Record<string, unknown>, id: string): DerivedEvent => ({
  eventId: id,
  kind,
  sessionId: "s",
  epoch: 1,
  roundAttemptId: "r1",
  sequence: 1,
  receivedAtMonotonicMs: 1000,
  matchTimeMs: null,
  timeUncertaintyMs: null,
  evidence: kind === "probable_kill_link" ? "estimated" : "derived",
  confidence: 0.7,
  data,
});

describe("killfeed", () => {
  const names: Record<string, { name: string; side: "CT" | "T" }> = { k: { name: "Killer", side: "T" }, a: { name: "Mate", side: "T" }, v: { name: "Victim", side: "CT" }, w: { name: "Other", side: "CT" } };
  const nameOf = (id: string) => names[id] ?? { name: id, side: "CT" as const };

  it("carries the estimated weapon, headshot, assister and blind killer; a death without a pairing stays an elimination", () => {
    const kf = new KillfeedBuilder();
    kf.resetForRound("r1");
    kf.ingest(
      [
        ev("probable_kill_link", { killer: "k", victim: "v", headshot: "probable", weapon: "weapon_ak47", assister: "a", attackerBlind: true }, "l1"),
        ev("player_died", { steamId: "v" }, "d1"),
        ev("player_died", { steamId: "w" }, "d2"),
      ],
      nameOf,
    );
    const [kill, elim] = kf.list();
    expect(kill).toMatchObject({ kind: "probable", killer: { name: "Killer", side: "T" }, victim: { name: "Victim" }, weapon: "weapon_ak47", headshot: true, assister: { name: "Mate", side: "T" }, attackerBlind: true });
    expect(elim).toMatchObject({ kind: "elimination", killer: null, weapon: null, headshot: null, assister: null, attackerBlind: null });
  });
});
