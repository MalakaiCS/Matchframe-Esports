import { describe, expect, it } from "vitest";
import type { UtilityObservation, UtilityTrackerContext, TrackerPlayerView } from "../src/index.ts";
import { CapabilitySampler, DEFAULT_PROFILES, MEASURED_SD_FLOOR_MS, UtilityTracker, buildSyntheticGsiPayload, normalizeGsi, parseGsiPayload, profilesFromMeasured, syntheticRoster } from "../src/index.ts";
import type { Vec3, WeaponState } from "@matchframe/contracts";

const T1 = "76561198000000001";
const T2 = "76561198000000002";
const CT1 = "76561198000000016";

function ctx(now: number, players?: Map<string, TrackerPlayerView>, epoch = 1): UtilityTrackerContext {
  return { sessionId: "s", epoch, sourceId: "gsi", nowMonotonicMs: now, matchTimeMs: now, players: players ?? null };
}

function g(id: string, rawType: string, owner: string, position: Vec3, extra: Partial<UtilityObservation> = {}): UtilityObservation {
  return {
    sourceEntityId: id,
    rawType,
    ownerSteamId: owner,
    position,
    velocity: { x: 400, y: 0, z: 100 },
    lifetimeSec: 0.1,
    effectTimeSec: 0,
    flames: null,
    ...extra,
  };
}

function view(side: "T" | "CT", weapons: string[] = [], extra: Partial<TrackerPlayerView> = {}): TrackerPlayerView {
  const ws: WeaponState[] = weapons.map((name, i) => ({
    slotKey: `weapon_${i}`,
    name,
    type: "Grenade",
    state: "holstered",
    ammoClip: null,
    ammoClipMax: null,
    ammoReserve: null,
  }));
  return { side, weapons: ws, flashed: 0, health: 100, position: { x: 0, y: 0, z: 0 }, lifeState: "alive", ...extra };
}

describe("UtilityTracker — all six grenade types", () => {
  it("tracks HE with prediction kept separate from confirmation and fuse-consistent removal as expired", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("1", "frag", T1, { x: 0, y: 0, z: 64 }, { lifetimeSec: 0.4 })], ctx(1000));
    const flying = tr.items()[0]!;
    expect(flying.type).toBe("he");
    expect(flying.phase).toBe("flight");
    expect(flying.predicted).not.toBeNull();
    expect(flying.confirmedActivation).toBeNull();
    tr.ingestSnapshot([g("1", "frag", T1, { x: 500, y: 0, z: 30 }, { lifetimeSec: 1.5 })], ctx(2100));
    const ev = tr.ingestSnapshot([], ctx(2200));
    const he = tr.items()[0]!;
    expect(he.phase).toBe("expired");
    // Disappearance is not proof of detonation at the last sample: no confirmed activation, effect estimated.
    expect(he.confirmedActivation).toBeNull();
    expect(he.effect?.extentEvidence).toBe("estimated");
    expect(ev.some((e) => e.kind === "expired")).toBe(true);
  });

  it("marks an HE that vanishes far outside its fuse window as lost, not detonated", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("1", "frag", T1, { x: 0, y: 0, z: 64 }, { lifetimeSec: 0.1 })], ctx(1000));
    tr.ingestSnapshot([], ctx(1100));
    expect(tr.items()[0]!.phase).toBe("lost");
  });

  it("links flash detonation to measured player flash state with divided attribution", () => {
    const tr = new UtilityTracker();
    const players = new Map([[CT1, view("CT")]]);
    tr.ingestSnapshot([g("2", "flashbang", T1, { x: 0, y: 0, z: 64 }, { lifetimeSec: 1.4 })], ctx(1000, players));
    tr.ingestSnapshot([], ctx(1100, players));
    const flashedPlayers = new Map([[CT1, view("CT", [], { flashed: 0.9 })]]);
    const ev = tr.ingestSnapshot([], ctx(1200, flashedPlayers));
    const flash = tr.items()[0]!;
    expect(flash.type).toBe("flashbang");
    const a = flash.affectedPlayers.find((x) => x.steamId === CT1)!;
    expect(a.effect).toBe("flashed");
    expect(a.evidence).toBe("derived");
    expect(a.attributionConfidence).toBeLessThan(1);
    expect(ev.some((e) => e.kind === "affected")).toBe(true);
  });

  it("tracks smoke deployment from source effect time and measures expiry on removal", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("3", "smoke", CT1, { x: 0, y: 0, z: 64 })], ctx(1000));
    tr.ingestSnapshot([g("3", "smoke", CT1, { x: 300, y: 0, z: 0 }, { velocity: { x: 0, y: 0, z: 0 }, effectTimeSec: 0.2, lifetimeSec: 2 })], ctx(3000));
    const active = tr.items()[0]!;
    expect(active.phase).toBe("active");
    expect(active.confirmedActivation?.evidence).toBe("measured");
    expect(active.effect?.kind).toBe("smoke_volume");
    expect(active.effect?.expiryEvidence).toBe("estimated");
    tr.ingestSnapshot([], ctx(21000));
    const done = tr.items()[0]!;
    expect(done.phase).toBe("expired");
    expect(done.effect?.expiryEvidence).toBe("measured");
  });

  it("separates Molotov and incendiary using the thrower's inventory delta", () => {
    const tr = new UtilityTracker();
    let players = new Map([
      [T1, view("T", ["weapon_molotov"])],
      [CT1, view("CT", ["weapon_incgrenade"])],
    ]);
    tr.ingestSnapshot([], ctx(900, players));
    players = new Map([
      [T1, view("T", [])],
      [CT1, view("CT", [])],
    ]);
    tr.ingestSnapshot(
      [g("4", "firebomb", T1, { x: 0, y: 0, z: 64 }), g("5", "firebomb", CT1, { x: 2000, y: 0, z: 64 })],
      ctx(1000, players),
    );
    const byOwner = (o: string) => tr.items().find((i) => i.throwerSteamId === o && i.sourceEntityId !== "x")!;
    expect(byOwner(T1).type).toBe("molotov");
    expect(byOwner(CT1).type).toBe("incendiary");
    expect(byOwner(T1).typeEvidence).toContain("inventory");
  });

  it("does not treat team side as proof: a CT throwing a picked-up Molotov resolves by inventory", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([], ctx(900, new Map([[CT1, view("CT", ["weapon_molotov"])]])));
    tr.ingestSnapshot([g("6", "firebomb", CT1, { x: 0, y: 0, z: 64 })], ctx(1000, new Map([[CT1, view("CT", [])]])));
    expect(tr.items()[0]!.type).toBe("molotov");
  });

  it("falls back to an explicitly estimated side-based type when no inventory evidence exists", () => {
    const tr = new UtilityTracker();
    const players = new Map([[T2, view("T", [])]]);
    tr.ingestSnapshot([g("7", "firebomb", T2, { x: 0, y: 0, z: 64 })], ctx(1000, players));
    tr.ingestSnapshot([g("7", "firebomb", T2, { x: 100, y: 0, z: 50 }, { lifetimeSec: 0.3 })], ctx(3500, players));
    const item = tr.items()[0]!;
    expect(item.type).toBe("molotov");
    expect(item.typeConfidence).toBeLessThanOrEqual(0.7);
    expect(item.typeEvidence).toContain("estimated");
  });

  it("links a fire projectile to the fire area and keeps the fire as a separate linked record", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([], ctx(900, new Map([[T1, view("T", ["weapon_molotov"])]])));
    const players = new Map([[T1, view("T", [])]]);
    tr.ingestSnapshot([g("8", "firebomb", T1, { x: 0, y: 0, z: 64 })], ctx(1000, players));
    tr.ingestSnapshot([g("8", "firebomb", T1, { x: 300, y: 0, z: 20 }, { lifetimeSec: 0.8 })], ctx(1600, players));
    const flames = [{ x: 310, y: 0, z: 0 }, { x: 350, y: 30, z: 0 }, { x: 290, y: -40, z: 0 }];
    const ev = tr.ingestSnapshot([g("9", "inferno", T1, { x: 310, y: 0, z: 0 }, { velocity: null, flames })], ctx(1700, players));
    const proj = tr.items().find((i) => i.sourceEntityId === "8")!;
    const fire = tr.items().find((i) => i.sourceEntityId === "9")!;
    expect(ev.some((e) => e.kind === "linked")).toBe(true);
    expect(proj.phase).toBe("expired");
    expect(proj.confirmedActivation?.evidence).toBe("derived");
    expect(fire.type).toBe("molotov");
    expect(fire.effect?.kind).toBe("fire_area");
    expect(fire.effect?.extentEvidence).toBe("measured");
    expect(fire.linkedUtilityIds).toContain(proj.utilityId);
    tr.ingestSnapshot([], ctx(8800, players));
    expect(tr.items().find((i) => i.sourceEntityId === "9")!.phase).toBe("expired");
  });

  it("tracks a decoy through activation at rest", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("10", "decoy", T1, { x: 0, y: 0, z: 64 })], ctx(1000));
    tr.ingestSnapshot([g("10", "decoy", T1, { x: 200, y: 0, z: 0 }, { velocity: { x: 0, y: 0, z: 0 } })], ctx(2000));
    tr.ingestSnapshot([g("10", "decoy", T1, { x: 200, y: 0, z: 0 }, { velocity: { x: 0, y: 0, z: 0 } })], ctx(2100));
    const d = tr.items()[0]!;
    expect(d.type).toBe("decoy");
    expect(d.phase).toBe("active");
    expect(d.confirmedActivation?.evidence).toBe("derived");
    expect(d.affectedPlayers).toHaveLength(0);
  });

  it("preserves unknown/future types without inventing an effect", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("11", "snowball", T1, { x: 0, y: 0, z: 64 })], ctx(1000));
    tr.ingestSnapshot([], ctx(1100));
    const u = tr.items()[0]!;
    expect(u.type).toBe("unknown");
    expect(u.effect).toBeNull();
    expect(u.phase).toBe("lost");
  });
});

describe("UtilityTracker — identity, gaps and epochs", () => {
  it("starts a new item when an entity index is reused after removal", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("20", "smoke", T1, { x: 0, y: 0, z: 64 })], ctx(1000));
    tr.ingestSnapshot([], ctx(1100));
    tr.ingestSnapshot([g("20", "frag", T2, { x: 900, y: 0, z: 64 })], ctx(1200));
    const ids = tr.items().map((i) => i.utilityId);
    expect(new Set(ids).size).toBe(2);
    expect(tr.items().find((i) => i.cleanupReason === null)!.type).toBe("he");
  });

  it("starts a new item when the lifetime resets under the same entity id", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("21", "frag", T1, { x: 0, y: 0, z: 64 }, { lifetimeSec: 1.2 })], ctx(1000));
    tr.ingestSnapshot([g("21", "frag", T2, { x: 0, y: 0, z: 64 }, { lifetimeSec: 0.1 })], ctx(1100));
    expect(tr.items()).toHaveLength(2);
  });

  it("records a visibility gap when the grenades component is missing", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("22", "smoke", T1, { x: 0, y: 0, z: 64 })], ctx(1000));
    tr.markSourceGap(1100);
    tr.ingestSnapshot([g("22", "smoke", T1, { x: 50, y: 0, z: 60 })], ctx(1600));
    expect(tr.items()[0]!.visibilityGaps).toEqual([{ fromMonotonicMs: 1100, toMonotonicMs: 1600 }]);
  });

  it("clears persistent utility on epoch change without duplicating effects", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("23", "inferno", T1, { x: 0, y: 0, z: 0 }, { velocity: null, flames: [{ x: 0, y: 0, z: 0 }] })], ctx(1000));
    tr.ingestSnapshot([g("23", "inferno", T1, { x: 0, y: 0, z: 0 }, { velocity: null, flames: [{ x: 0, y: 0, z: 0 }] })], ctx(1000 + 100, undefined, 2));
    const live = tr.activeItems();
    expect(live).toHaveLength(1);
    expect(live[0]!.epoch).toBe(2);
    expect(tr.historyItems().length).toBe(0); // history is per-epoch
  });

  it("cleans up stale items when the source goes silent", () => {
    const tr = new UtilityTracker({ staleTimeoutMs: 2000 });
    tr.ingestSnapshot([g("24", "smoke", T1, { x: 0, y: 0, z: 64 })], ctx(1000));
    tr.tick(4000);
    expect(tr.items()[0]!.cleanupReason).toBe("stale_timeout");
  });

  it("keeps tracking utility anywhere: no region, high above the walkable area, both teams", () => {
    const tr = new UtilityTracker({
      map: { regionsAt: (p) => (p.x < 1000 ? ["banana"] : []), levelAt: (p) => (p.z > 500 ? "upper" : "ground") },
    });
    tr.ingestSnapshot(
      [
        g("30", "frag", T1, { x: 5000, y: 5000, z: 900 }, { lifetimeSec: 0.4 }), // over a roof, outside any named region
        g("31", "smoke", CT1, { x: 100, y: 0, z: 64 }),
      ],
      ctx(1000),
    );
    const items = tr.items();
    expect(items).toHaveLength(2);
    const roof = items.find((i) => i.sourceEntityId === "30")!;
    expect(roof.regions).toEqual([]);
    expect(roof.phase).toBe("flight");
    expect(items.map((i) => i.throwerSteamId).sort()).toEqual([T1, CT1].sort());
  });

  it("accepts measured detonation events from an event-capable source", () => {
    const tr = new UtilityTracker();
    tr.ingestSnapshot([g("40", "CBaseCSGrenadeProjectile", T1, { x: 0, y: 0, z: 64 })], ctx(1000));
    expect(tr.items()[0]!.type).toBe("unknown");
    tr.ingestSourceEvent({ kind: "detonate", sourceEntityId: "40", type: "flashbang", position: { x: 10, y: 0, z: 60 }, ownerSteamId: T1, eventRef: "flashbang_detonate#12" }, ctx(1500));
    const u = tr.items()[0]!;
    expect(u.type).toBe("flashbang");
    expect(u.confirmedActivation?.evidence).toBe("measured");
  });
});

describe("CapabilitySampler", () => {
  it("reports per-type support from what actually arrived, and Molotov/incendiary ambiguity as partial", () => {
    const sampler = new CapabilitySampler("gsi:test", { minPackets: 1 });
    const raw = buildSyntheticGsiPayload({
      players: syntheticRoster().map((p) => ({ ...p, position: { x: 1, y: 2, z: 3 }, forward: { x: 1, y: 0, z: 0 } })),
      grenades: [
        { id: "1", type: "smoke", owner: T1, position: { x: 0, y: 0, z: 0 }, effecttime: 1 },
        { id: "2", type: "firebomb", owner: T1, position: { x: 0, y: 0, z: 0 } },
      ],
    });
    const parsed = parseGsiPayload(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    sampler.observe(normalizeGsi(parsed.payload, { sourceId: "gsi:test", receivedAtMonotonicMs: 1, payloadHash: "h" }), "2026-10-26T00:00:00Z");
    const r = sampler.report();
    expect(r.grenadeTypeSupport.smoke.support).toBe("supported");
    expect(r.grenadeTypeSupport.molotov.support).toBe("partial");
    expect(r.grenadeTypeSupport.incendiary.support).toBe("partial");
    expect(r.grenadeTypeSupport.he.support).toBe("unverified");
    expect(r.exactKillEvents.support).toBe("unsupported");
    expect(r.grenadeDamageAttribution.support).toBe("unsupported");
    expect(r.playerPositions.support).toBe("supported");
    // Control capabilities are never derived from telemetry.
    expect(r.staticCameraControl.support).toBe("unverified");
    expect(r.playerSelectionControl.support).toBe("unverified");
  });
});

describe("measured utility profiles", () => {
  it("applies measured means with floored uncertainty and keeps defaults for unmeasured types", () => {
    const file = {
      source: "measured_from_demos",
      profiles: {
        he: { source: "measured_from_demos" as const, sampleCount: 66, fuse: { meanMs: 1640.9, sdMs: 1.9 }, measuredOn: "test" },
        smoke: { source: "measured_from_demos" as const, sampleCount: 47, effectDuration: { meanMs: 22062.5, sdMs: 21.9 } },
        decoy: { source: "measured_from_demos" as const, sampleCount: 1, fuse: { meanMs: 1, sdMs: 1 } },
      },
    };
    const { profiles, measuredTypes } = profilesFromMeasured(file);
    expect(measuredTypes.sort()).toEqual(["he", "smoke"]);
    expect(profiles.he.fuse).toEqual({ meanMs: 1640.9, sdMs: MEASURED_SD_FLOOR_MS.fuse });
    expect(profiles.smoke.effectDuration).toEqual({ meanMs: 22062.5, sdMs: MEASURED_SD_FLOOR_MS.effectDuration });
    expect(profiles.decoy).toEqual(DEFAULT_PROFILES.decoy);
    expect(profiles.flashbang.source).toBe("default_unmeasured");
  });
});
