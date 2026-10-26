import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapRuntime, syntheticMapPack } from "@matchframe/map-runtime";
import type { SyntheticGrenade, SyntheticPlayer } from "@matchframe/cs2-state";
import { Director, computeInteractions, DEFAULT_DIRECTOR_CONFIG, povShot } from "../src/index.ts";
import type { ControlStatus } from "../src/index.ts";
import { capsWithCameraControl, CT, facingTo, player, Sim, T } from "./helpers.ts";

const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const control = (o: Partial<ControlStatus> = {}): ControlStatus => ({ ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false, ...o });

/** Three Ts grouped in (synthetic) Bottom Banana, two Ts and five CTs far away. */
function bananaStack(): SyntheticPlayer[] {
  return [
    player(T(1), "T", 1, { x: -600, y: 0, z: 0 }),
    player(T(2), "T", 2, { x: -500, y: 100, z: 0 }),
    player(T(3), "T", 3, { x: -700, y: -100, z: 0 }),
    player(T(4), "T", 4, { x: -2500, y: -2500, z: 0 }),
    player(T(5), "T", 5, { x: -2600, y: -2400, z: 0 }),
    player(CT(6), "CT", 6, { x: 1800, y: 3200, z: 0 }),
    player(CT(7), "CT", 7, { x: 1900, y: 3300, z: 0 }),
    player(CT(8), "CT", 8, { x: 2000, y: 3100, z: 0 }),
    player(CT(9), "CT", 9, { x: 2100, y: 3400, z: 0 }),
    player(CT(0), "CT", 0, { x: 2200, y: 3000, z: 0 }),
  ];
}

function incomingHe(owner = CT(6), lifetime = 0.6): SyntheticGrenade {
  return { id: "500", type: "frag", owner, position: { x: -650, y: -250, z: 120 }, velocity: { x: 80, y: 250, z: 40 }, lifetime };
}

function setup(opts: { validated?: boolean; mapName?: string; cameraControl?: "supported" | "unverified" } = {}) {
  const mapName = opts.mapName ?? "de_inferno";
  const sim = new Sim(mapName);
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setMap(new MapRuntime(syntheticMapPack({ withValidatedCamera: opts.validated ?? true, mapName })));
  director.setCapabilities(capsWithCameraControl(opts.cameraControl ?? "supported"));
  return { sim, director };
}

/**
 * Closed loop: the simulated observer follows the director's executed intents, as a confirmed
 * camera would. Returns the last output.
 */
class Loop {
  observed: string | null;
  constructor(public sim: Sim, public director: Director, first: string, public mapName = "de_inferno") {
    this.observed = first;
  }
  step(players: SyntheticPlayer[], grenades: SyntheticGrenade[] = [], ctl: ControlStatus = control()) {
    const out = this.director.evaluate(this.sim.push(players, { mapName: this.mapName, grenades, observed: this.observed }), this.sim.now, ctl);
    if (out.intent?.kind === "select_player") this.observed = out.intent.targetSteamId;
    if (out.intent?.kind === "activate_static_camera") {
      this.observed = null;
      this.director.cinematicStarted(`camera:${out.intent.cameraId}`, this.sim.now, out.intent.plannedDurationMs ?? 2000, out.intent.opportunityId);
    }
    return out;
  }
}

/** Advance past the minimum shot duration on a stable state, following the director's cuts. */
function settle(sim: Sim, director: Director, players: SyntheticPlayer[], mapName = "de_inferno", observed = players[0]!.steamId): Loop {
  const loop = new Loop(sim, director, observed, mapName);
  for (let i = 0; i < 30; i++) loop.step(players);
  return loop;
}

describe("Director — Inferno Bottom Banana reference scenario (logic level, synthetic geometry)", () => {
  it("A22 (logic): plans a validated static utility shot when consequential utility is about to hit a T stack", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    const loop = settle(sim, director, players);
    const out = loop.step(players, [incomingHe()]);
    const opp = out.opportunities[0]!;
    expect(opp.scenarioId).toBe("inferno-bottom-banana");
    expect(opp.camera?.camera.id).toBe("synthetic-bottom-banana-wide");
    expect(out.decision.action).toBe("cut");
    expect(out.intent?.kind).toBe("activate_static_camera");
    expect(out.intent?.plannedDurationMs).toBeLessThanOrEqual(3000);
  });

  it("A23: does not trigger from a T mass alone (no verified grenade)", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    settle(sim, director, players);
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno" }), sim.now, control());
    expect(out.opportunities).toHaveLength(0);
    expect(out.candidates.some((c) => c.shotClass === "static_utility")).toBe(false);
    expect(out.intent?.kind).not.toBe("activate_static_camera");
  });

  it("A23: an incoming smoke or decoy does not trigger the scenario", () => {
    for (const type of ["smoke", "decoy"]) {
      const { sim, director } = setup();
      const players = bananaStack();
      settle(sim, director, players);
      const g = { ...incomingHe(), type };
      const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [g] }), sim.now, control());
      expect(out.opportunities.every((o) => o.scenarioId === null)).toBe(true);
      expect(out.intent?.kind).not.toBe("activate_static_camera");
    }
  });

  it("A23: dispersed Ts (fewer than the scenario threshold in the region) get no scenario boost", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    players[2] = player(T(3), "T", 3, { x: -2400, y: -2300, z: 0 });
    settle(sim, director, players);
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [incomingHe()] }), sim.now, control());
    expect(out.opportunities.every((o) => o.scenarioId === null)).toBe(true);
  });

  it("A16/A23: an imminent CT push elsewhere outranks the utility cinematic", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    // Lone T and a pushing CT about to meet at close range, facing each other.
    const tPos = { x: 1500, y: -2600, z: 0 };
    const ctPos = { x: 1500, y: -2100, z: 0 };
    players[3] = player(T(4), "T", 4, tPos, facingTo(tPos, ctPos));
    players[5] = player(CT(6), "CT", 6, ctPos, facingTo(ctPos, tPos));
    const loop = settle(sim, director, players);
    const out = loop.step(players, [incomingHe(CT(7))]);
    expect(out.decision.desiredShot).not.toBe("camera:synthetic-bottom-banana-wide");
    expect([povShot(T(4)), povShot(CT(6))]).toContain(out.decision.desiredShot);
  });

  it("A25: an unvalidated camera is never used automatically; POV fallback is marked", () => {
    const { sim, director } = setup({ validated: false });
    const players = bananaStack();
    settle(sim, director, players);
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [incomingHe()] }), sim.now, control());
    expect(out.candidates.some((c) => c.shotClass === "static_utility")).toBe(false);
    expect(out.opportunities[0]!.reasons).toContain("UTILITY_NO_CAMERA");
    expect(out.candidates.find((c) => c.targetSteamId === T(1))!.reasonCodes).toContain("UTILITY_NO_CAMERA");
  });

  it("A25: unverified static camera control keeps the cinematic invalid (capability gate)", () => {
    const { sim, director } = setup({ cameraControl: "unverified" });
    const players = bananaStack();
    settle(sim, director, players);
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [incomingHe()] }), sim.now, control());
    const cam = out.candidates.find((c) => c.shotClass === "static_utility")!;
    expect(cam.valid).toBe(false);
    expect(cam.reasonCodes).toContain("CAMERA_UNVERIFIED");
    expect(out.intent?.kind).not.toBe("activate_static_camera");
  });

  it("does not send any command under manual ownership (recommendation only)", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    settle(sim, director, players);
    const manual = { ...armed, owner: "operator" as const, manualSticky: true };
    const out = director.evaluate(sim.push(players, { mapName: "de_inferno", grenades: [incomingHe()] }), sim.now, control({ ownership: manual }));
    expect(out.intent).toBeNull();
    expect(out.decision.controlHealth).toBe("manual_owned");
    expect(out.decision.reasonCodes).toContain("MANUAL_OWNERSHIP");
  });

  it("A24: interrupts an active cinematic for an urgent fight and exits to a POV", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    const loop = settle(sim, director, players);
    const start = loop.step(players, [incomingHe()]);
    expect(start.intent?.kind).toBe("activate_static_camera");
    // A fight erupts elsewhere at close range while the static camera is live.
    const tPos = { x: 1500, y: -2600, z: 0 };
    const ctPos = { x: 1500, y: -2400, z: 0 };
    players[3] = player(T(4), "T", 4, tPos, facingTo(tPos, ctPos));
    players[5] = player(CT(6), "CT", 6, ctPos, facingTo(ctPos, tPos));
    const out = loop.step(players, [incomingHe(CT(6), 0.7)]);
    expect(out.decision.action).toBe("cut");
    expect(out.decision.reasonCodes).toContain("CINEMATIC_INTERRUPTED");
    expect(out.intent?.kind).toBe("select_player");
  });
});

describe("Director — universal utility (other maps, both teams, no cinematic coverage)", () => {
  it("A65: the generic engine handles a CT HE on a post-plant T cluster outside any scenario", () => {
    const { sim, director } = setup({ mapName: "de_mirage" });
    const players = bananaStack().map((p) => (p.side === "T" && ["1", "2", "3"].includes(p.steamId.slice(-1)) ? { ...p, position: { x: p.position!.x + 2200, y: p.position!.y, z: 0 } } : p));
    settle(sim, director, players, "de_mirage");
    const he: SyntheticGrenade = { id: "600", type: "frag", owner: CT(8), position: { x: 1550, y: -250, z: 120 }, velocity: { x: 80, y: 250, z: 40 }, lifetime: 1.0 };
    const out = director.evaluate(sim.push(players, { mapName: "de_mirage", grenades: [he] }), sim.now, control());
    const opp = out.opportunities[0]!;
    expect(opp.scenarioId).toBeNull();
    expect(opp.throwerSide).toBe("CT");
    expect(opp.affected.filter((a) => a.side === "T").length).toBeGreaterThanOrEqual(2);
    expect(opp.regionIds).toContain("site_b");
  });

  it("A61: utility in an area with no cinematic coverage keeps tracking and uses a POV fallback", () => {
    const { sim, director } = setup({ mapName: "de_mirage" });
    const players = bananaStack().map((p) => (p.side === "T" && ["1", "2", "3"].includes(p.steamId.slice(-1)) ? { ...p, position: { x: p.position!.x + 2200, y: p.position!.y, z: 0 } } : p));
    settle(sim, director, players, "de_mirage");
    const he: SyntheticGrenade = { id: "601", type: "frag", owner: CT(8), position: { x: 1550, y: -250, z: 120 }, velocity: { x: 80, y: 250, z: 40 }, lifetime: 1.0 };
    const out = director.evaluate(sim.push(players, { mapName: "de_mirage", grenades: [he] }), sim.now, control());
    expect(out.opportunities[0]!.camera).toBeNull();
    expect(out.opportunities[0]!.cameraIssue).toBeTruthy();
    expect(out.intent?.kind).not.toBe("activate_static_camera");
  });

  it("A57: a decoy is tracked but never causes an automatic cut", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    settle(sim, director, players);
    const decoy: SyntheticGrenade = { id: "700", type: "decoy", owner: T(1), position: { x: -500, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, lifetime: 3, effecttime: 1 };
    const s = sim.push(players, { mapName: "de_inferno", grenades: [decoy] });
    expect(s.utility.some((u) => u.type === "decoy")).toBe(true);
    const out = director.evaluate(s, sim.now, control());
    expect(out.decision.action).not.toBe("cut");
  });

  it("A54: a flash ahead of an entry is a flash_entry opportunity; once the defender is blind the entry duel is shown", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const players = bananaStack();
    const entry = { x: 1500, y: 2300, z: 0 };
    const holder = { x: 1500, y: 3050, z: 0 };
    players[3] = player(T(4), "T", 4, entry, facingTo(entry, holder));
    players[4] = player(T(5), "T", 5, { x: 1450, y: 2250, z: 0 });
    players[5] = player(CT(6), "CT", 6, holder, facingTo(holder, entry));
    const loop = settle(sim, director, players, "de_dust2");
    const flash: SyntheticGrenade = { id: "900", type: "flashbang", owner: T(5), position: { x: 1500, y: 2600, z: 100 }, velocity: { x: 0, y: 300, z: 50 }, lifetime: 1.2 };
    const out = loop.step(players, [flash]);
    const opp = out.opportunities.find((o) => o.primaryType === "flashbang")!;
    expect(opp.kind).toBe("flash_entry");
    expect(opp.evidence).toBe("predicted");
    expect(opp.affected.map((a) => a.steamId)).toContain(CT(6));
    // Flash popped: the defender is measured blind and the entry advances.
    players[3] = player(T(4), "T", 4, { x: 1500, y: 2650, z: 0 }, facingTo({ x: 1500, y: 2650, z: 0 }, holder));
    players[5] = { ...players[5]!, flashed: 255 };
    let after = loop.step(players);
    for (let i = 0; i < 5; i++) after = loop.step(players);
    expect([povShot(T(4)), povShot(CT(6))]).toContain(after.decision.desiredShot);
    expect(sim.store.snapshot(sim.now).players.find((p) => p.steamId === CT(6))!.flashed).toBe(1); // GSI 0–255 normalised to 0–1
  });

  it("A55: a deployed smoke supporting the main group is a smoke_execute story only near deployment, while the smoke stays tracked", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const players = bananaStack();
    const loop = settle(sim, director, players, "de_dust2");
    const smoke: SyntheticGrenade = { id: "950", type: "smoke", owner: T(2), position: { x: -300, y: 200, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, lifetime: 2, effecttime: 0.4 };
    const out = loop.step(players, [smoke]);
    const opp = out.opportunities.find((o) => o.primaryType === "smoke")!;
    expect(opp.kind).toBe("smoke_execute");
    expect(opp.scenarioId).toBeNull();
    expect(out.intent?.kind).not.toBe("activate_static_camera");
    // Several seconds later the smoke is still active and tracked, but no longer a new story.
    let later = out;
    for (let i = 0; i < 35; i++) later = loop.step(players, [{ ...smoke, lifetime: 2 + (i + 1) * 0.1, effecttime: 0.4 + (i + 1) * 0.1 }]);
    const tracked = sim.store.snapshot(sim.now).utility.find((u) => u.type === "smoke")!;
    expect(tracked.phase).toBe("active");
    expect(later.opportunities.some((o) => o.primaryType === "smoke")).toBe(false);
  });

  it("A58: concurrent utility in two areas plus a decisive gunfight: shows the fight, keeps both utility opportunities", () => {
    const { sim, director } = setup();
    const players = bananaStack();
    const tPos = { x: 1500, y: 2700, z: 0 };
    const ctPos = { x: 1500, y: 3050, z: 0 };
    players[3] = player(T(4), "T", 4, tPos, facingTo(tPos, ctPos));
    players[5] = player(CT(6), "CT", 6, ctPos, facingTo(ctPos, tPos));
    const loop = settle(sim, director, players);
    const fire: SyntheticGrenade = { id: "801", type: "inferno", owner: CT(7), position: { x: 1700, y: 200, z: 0 }, flames: [{ x: 1700, y: 200, z: 0 }] };
    const out = loop.step(players, [incomingHe(CT(8)), fire]);
    expect(out.opportunities.length).toBeGreaterThanOrEqual(2);
    expect([povShot(T(4)), povShot(CT(6))]).toContain(out.decision.desiredShot);
  });
});

describe("Director — POV editorial behaviour", () => {
  it("A21: score jitter does not cause repeated pointless cuts", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const base = bananaStack();
    let cuts = 0;
    let last: string | null = null;
    for (let i = 0; i < 60; i++) {
      const jitter = (i % 2 === 0 ? 1 : -1) * 15;
      const players = base.map((p) => ({ ...p, position: { x: p.position!.x + jitter, y: p.position!.y - jitter, z: 0 } }));
      const out = director.evaluate(sim.push(players, { mapName: "de_dust2", observed: last ? last.slice(4) : players[0]!.steamId }), sim.now, control());
      if (out.decision.action === "cut" && out.decision.desiredShot !== last) {
        cuts++;
        last = out.decision.desiredShot;
      }
    }
    expect(cuts).toBeLessThanOrEqual(2);
  });

  it("A20: a dead current POV recovers immediately to a living POV, ignoring minimum duration", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const players = bananaStack();
    director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control());
    players[0] = { ...players[0]!, health: 0 };
    const out = director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control());
    expect(out.decision.action).toBe("cut");
    expect(out.decision.reasonCodes).toContain("CURRENT_POV_DEAD");
    expect(out.decision.desiredShot).not.toBe(povShot(T(1)));
    expect(out.intent?.kind).toBe("select_player");
  });

  it("A18: a fully flashed duelist is ranked below an equivalent ready duelist but not excluded", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const players = bananaStack();
    const a = { x: 0, y: 1000, z: 0 };
    const b = { x: 300, y: 1000, z: 0 };
    players[3] = player(T(4), "T", 4, a, facingTo(a, b), { flashed: 255 });
    players[5] = player(CT(6), "CT", 6, b, facingTo(b, a));
    settle(sim, director, players, "de_dust2");
    const out = director.evaluate(sim.push(players, { mapName: "de_dust2" }), sim.now, control());
    const flashed = out.candidates.find((c) => c.targetSteamId === T(4))!;
    const ready = out.candidates.find((c) => c.targetSteamId === CT(6))!;
    expect(flashed.valid).toBe(true);
    expect(flashed.reasonCodes).toContain("PLAYER_FLASHED");
    expect(ready.utility).toBeGreaterThan(flashed.utility);
  });

  it("A17: wall/floor-separated nearby players are not treated as a guaranteed fight", () => {
    const cfg = DEFAULT_DIRECTOR_CONFIG;
    const sim = new Sim("de_synthetic");
    const rt = new MapRuntime(syntheticMapPack());
    const spatial = { levelAt: (p: { x: number; y: number; z: number }) => rt.levelAt(p), regionsAt: (p: { x: number; y: number; z: number }) => rt.regionsAt(p) };
    const below = { x: 1500, y: 0, z: 0 };
    const above = { x: 1550, y: 0, z: 600 };
    const sameLevel = { x: 1550, y: 300, z: 0 };
    const stacked = sim.push([player(T(1), "T", 1, below, facingTo(below, above)), player(CT(6), "CT", 6, above, facingTo(above, below))]);
    const open = sim.push([player(T(1), "T", 1, below, facingTo(below, sameLevel)), player(CT(6), "CT", 6, sameLevel, facingTo(sameLevel, below))]);
    const pStacked = computeInteractions(stacked, sim.now, cfg, spatial).pairs[0]!;
    const pOpen = computeInteractions(open, sim.now, cfg, spatial).pairs[0]!;
    expect(pStacked.separated).toBe(true);
    expect(pStacked.contact["2"]!).toBeLessThan(0.35);
    expect(pOpen.contact["2"]!).toBeGreaterThan(pStacked.contact["2"]! * 2);
    // Without verified visibility geometry nothing reaches certainty.
    expect(pOpen.contact["3"]!).toBeLessThanOrEqual(0.9);
  });

  it("A19: a crossfire setup is detected with reviewable reason codes", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const players = bananaStack();
    const target = { x: 0, y: 1500, z: 0 };
    const d1 = { x: -400, y: 2100, z: 0 };
    const d2 = { x: 450, y: 2050, z: 0 };
    players[3] = player(T(4), "T", 4, target, facingTo(target, d1));
    players[5] = player(CT(6), "CT", 6, d1, facingTo(d1, target));
    players[6] = player(CT(7), "CT", 7, d2, facingTo(d2, target));
    settle(sim, director, players, "de_dust2");
    const out = director.evaluate(sim.push(players, { mapName: "de_dust2" }), sim.now, control());
    expect(out.interactions.crossfires.length).toBeGreaterThan(0);
    const defender = out.candidates.find((c) => c.targetSteamId === CT(6))!;
    expect(defender.reasonCodes).toContain("CROSSFIRE_SETUP");
  });

  it("does not issue commands when input is stale, and logs the reason", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    const players = bananaStack();
    director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control());
    players[0] = { ...players[0]!, health: 0 };
    const out = director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control({ inputFresh: false }));
    expect(out.intent).toBeNull();
    expect(out.decision.reasonCodes).toContain("STALE_DATA");
  });

  it("advisory and shadow modes never produce executable intents", () => {
    for (const mode of ["advisory", "shadow"] as const) {
      const { sim, director } = setup({ mapName: "de_dust2" });
      director.setMode(mode);
      const players = bananaStack();
      director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control());
      players[0] = { ...players[0]!, health: 0 };
      const out = director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control());
      expect(out.intent).toBeNull();
      expect(out.decision.action).toBe("recommend");
    }
  });

  it("a pinned player constrains automatic choices (hard constraint outside the score)", () => {
    const { sim, director } = setup({ mapName: "de_dust2" });
    director.pin({ kind: "player", steamId: CT(9) });
    const players = bananaStack();
    const out = director.evaluate(sim.push(players, { mapName: "de_dust2", observed: T(1) }), sim.now, control());
    expect(out.candidates.filter((c) => c.valid).every((c) => c.targetSteamId === CT(9))).toBe(true);
  });
});
