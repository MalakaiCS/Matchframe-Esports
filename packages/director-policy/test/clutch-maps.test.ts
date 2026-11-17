import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { OwnershipState, Vec3 } from "@matchframe/contracts";
import { MapPack } from "@matchframe/contracts";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { MapRuntime, VisibilityGrid } from "@matchframe/map-runtime";
import type { ControlStatus, DirectorOutput } from "../src/index.ts";
import { Director } from "../src/index.ts";
import { capsWithCameraControl, CT, facingTo, player, Sim, T } from "./helpers.ts";

/**
 * Clutch direction on Mirage with its free-space grid: the whole director (contact model, sightlines
 * from the grid, walking distances, the planner), a hunter walking a real pro route, and a camera that
 * shows the selected player 300 ms after the director asks.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const grid = VisibilityGrid.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.grid")), (b) => inflateSync(b));
const mirage = () => {
  const rt = new MapRuntime(MapPack.parse(JSON.parse(readFileSync(join(root, "assets", "map-packs", "de_mirage.json"), "utf8"))));
  rt.grid = grid;
  return rt;
};
const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const control: ControlStatus = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };
const eye = (p: Vec3) => ({ x: p.x, y: p.y, z: p.z + 64 });

/** A T walking through B apartments towards B site (a pro demo's route: feet positions 0.25 s apart). */
const APPS_ROUTE: [number, number, number][] = [
  [-361, 525, -68], [-381, 537, -80], [-432, 546, -80], [-491, 559, -81], [-553, 563, -81], [-616, 565, -81], [-678, 566, -82], [-741, 568, -82],
  [-803, 570, -82], [-865, 572, -82], [-927, 575, -82], [-988, 583, -51], [-1039, 615, -80], [-1059, 643, -80], [-1093, 664, -80], [-1132, 696, -80],
  [-1179, 718, -80], [-1231, 726, -80], [-1291, 727, -80], [-1353, 727, -64], [-1416, 729, -26], [-1478, 731, -38], [-1541, 733, -9], [-1603, 735, 4],
];
/** A CT holding B site, where a CT stood in the same demo. */
const B_SITE = { x: -1829, y: 493, z: -168 };
const T_SPAWN = { x: 1230, y: -300, z: -167 };
const CT_SPAWN = { x: -1650, y: -1950, z: -295 };
const A_SITE = { x: -386, y: -1667, z: -168 };

function dead(): SyntheticPlayer[] {
  return [
    player(T(3), "T", 3, { x: 0, y: 0, z: -160 }, null, { health: 0 }),
    player(T(4), "T", 4, { x: 50, y: 0, z: -160 }, null, { health: 0 }),
    player(T(5), "T", 5, { x: 100, y: 0, z: -160 }, null, { health: 0 }),
    player(CT(7), "CT", 7, { x: -1700, y: -1900, z: -295 }, null, { health: 0 }),
    player(CT(8), "CT", 8, { x: -1650, y: -1850, z: -295 }, null, { health: 0 }),
    player(CT(9), "CT", 9, { x: -1600, y: -1900, z: -295 }, null, { health: 0 }),
  ];
}

interface Tick {
  at: number;
  observed: string | null;
  out: DirectorOutput;
}

/**
 * Runs the director over `frames` (100 ms apart); a selection is on air 300 ms after the director
 * makes it, and while it is on its way the director is told a command is pending (as the arbiter does).
 */
function run(frames: { players: SyntheticPlayer[]; bomb?: { state: string; position?: Vec3; player?: string; countdown?: number } }[], start: string) {
  const rt = mirage();
  const sim = new Sim("de_mirage", rt);
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setObserverMode("observer");
  director.setMap(rt);
  director.setCapabilities(capsWithCameraControl("supported"));
  director.controls.clutchMode = true;
  let observed: string | null = start;
  let landing: { who: string; at: number } | null = null;
  const ticks: Tick[] = [];
  for (const f of frames) {
    const state = sim.push(f.players, { mapName: "de_mirage", observed, phaseEndsIn: 70, spec: f.bomb ? { bomb: f.bomb } : {} });
    const out = director.evaluate(state, sim.now, { ...control, pendingCommand: landing !== null });
    if (out.intent?.kind === "select_player") landing = { who: out.intent.targetSteamId!, at: sim.now + 300 };
    if (landing && sim.now >= landing.at) {
      observed = landing.who;
      landing = null;
    }
    ticks.push({ at: sim.now, observed, out });
  }
  return ticks;
}

/** On-air spans of each player. */
function spans(ticks: Tick[]) {
  const out: { who: string | null; from: number; ms: number }[] = [];
  for (const t of ticks) {
    const last = out[out.length - 1];
    if (last && last.who === t.observed) last.ms = t.at - last.from;
    else out.push({ who: t.observed, from: t.at, ms: 0 });
  }
  return out;
}

describe("clutch direction on Mirage", () => {
  it("looks at the hunter walking through apartments, and is back on the clutcher before they see each other", () => {
    const clutcher = player(CT(6), "CT", 6, B_SITE, facingTo(B_SITE, { x: -1600, y: 735, z: 0 }));
    const far = player(T(2), "T", 2, T_SPAWN);
    const route = APPS_ROUTE.map(([x, y, z]) => ({ x, y, z }));
    const at = (t: number): Vec3 => {
      const i = Math.min(route.length - 1, t / 250);
      const a = route[Math.floor(i)]!;
      const b = route[Math.min(route.length - 1, Math.floor(i) + 1)]!;
      const u = i - Math.floor(i);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u };
    };
    const frames: Parameters<typeof run>[0] = [];
    // 5 s on the clutcher with the hunter waiting at the top of apartments, then the walk.
    for (let t = 0; t < 5000; t += 100) frames.push({ players: [clutcher, far, player(T(1), "T", 1, route[0]!, facingTo(route[0]!, route[1]!)), ...dead()] });
    for (let t = 0; t <= 5750; t += 100) {
      const p = at(t);
      frames.push({ players: [clutcher, far, player(T(1), "T", 1, p, facingTo(p, at(t + 250))), ...dead()] });
    }
    const ticks = run(frames, CT(6));

    // Walking distance from the grid, longer than the straight line (round the apartments' corners).
    const first = ticks[10]!.out.clutch!;
    const h1 = first.hunters.find((h) => h.steamId === T(1))!;
    expect(h1.walked).toBe(true);
    expect(h1.walk).toBeGreaterThan(Math.hypot(route[0]!.x - B_SITE.x, route[0]!.y - B_SITE.y));
    expect(h1.walk).toBeLessThan(2000);

    // A look at the hunter while they walk in.
    const look = ticks.find((t) => t.out.intent?.kind === "select_player" && t.out.intent.targetSteamId === T(1))!;
    expect(look, "a cut to the hunter").toBeDefined();
    expect(look.out.decision.reasonCodes).toContain("CLUTCH_HUNTER_CLOSING");
    expect(look.out.clutch!.lastSwitch!.note).toMatch(/look at .* \(closing in\): \d+ units away on foot/);
    const onHunter = spans(ticks).filter((s) => s.who === T(1));
    expect(onHunter).toHaveLength(1);
    expect(onHunter[0]!.ms).toBeGreaterThanOrEqual(1500);
    expect(onHunter[0]!.ms).toBeLessThanOrEqual(4400);

    // The first moment they can see each other in the grid: the clutcher is on air.
    const contact = ticks.find((t) => {
      const p = t.out.clutch?.hunters.find((h) => h.steamId === T(1));
      return p && grid.lineOfSight(eye(B_SITE), eye(frames[ticks.indexOf(t)]!.players[2]!.position!));
    });
    expect(contact, "the hunter comes into sight").toBeDefined();
    expect(contact!.observed).toBe(CT(6));
    const back = ticks.find((t) => t.at > look.at && t.out.intent?.kind === "select_player" && t.out.intent.targetSteamId === CT(6))!;
    expect(back.at).toBeLessThan(contact!.at);
    expect(back.out.decision.reasonCodes.some((r) => r === "CLUTCH_LOOK_OVER" || r === "CLUTCH_BACK_BEFORE_CONTACT")).toBe(true);
    // Never a camera mid-clutch.
    expect(ticks.every((t) => t.out.intent?.kind !== "activate_static_camera" && t.out.intent?.kind !== "play_camera_path")).toBe(true);
  });

  it("shows a hunter planting on B while the clutcher waits at CT spawn, then goes back", () => {
    const clutcher = player(CT(6), "CT", 6, CT_SPAWN);
    const planter = player(T(1), "T", 1, B_SITE);
    const other = player(T(2), "T", 2, { x: -2044, y: -34, z: -166 });
    const frames: Parameters<typeof run>[0] = [];
    for (let t = 0; t < 3000; t += 100) frames.push({ players: [clutcher, planter, other, ...dead()], bomb: { state: "carried", player: T(1) } });
    for (let t = 0; t < 5000; t += 100) frames.push({ players: [clutcher, planter, other, ...dead()], bomb: { state: t < 3200 ? "planting" : "planted", position: B_SITE, player: T(1), countdown: 40 } });
    const ticks = run(frames, CT(6));
    const cut = ticks.find((t) => t.out.intent?.kind === "select_player" && t.out.intent.targetSteamId === T(1))!;
    expect(cut.out.decision.reasonCodes).toContain("CLUTCH_HUNTER_PLANTING");
    // At once: within half a second of the plant starting (3 s in).
    expect(cut.at - ticks[0]!.at).toBeLessThan(3000 + 500);
    const onPlanter = spans(ticks).find((s) => s.who === T(1))!;
    expect(onPlanter.ms).toBeGreaterThanOrEqual(2500);
    expect(onPlanter.ms).toBeLessThanOrEqual(3500);
    expect(ticks[ticks.length - 1]!.observed).toBe(CT(6));
  });

  it("shows a CT starting to defuse on A while the T clutcher is far off", () => {
    const clutcher = player(T(1), "T", 1, T_SPAWN);
    const defuser = player(CT(6), "CT", 6, A_SITE);
    const other = player(CT(7), "CT", 7, { x: -105, y: -2124, z: -168 });
    const deadTs = [2, 3, 4, 5].map((n) => player(T(n), "T", n, { x: n * 40, y: 0, z: -160 }, null, { health: 0 }));
    const deadCts = [8, 9, 0].map((n) => player(CT(n), "CT", n, { x: -1700 + n * 10, y: -1900, z: -295 }, null, { health: 0 }));
    const frames: Parameters<typeof run>[0] = [];
    for (let t = 0; t < 3000; t += 100) frames.push({ players: [clutcher, defuser, other, ...deadTs, ...deadCts], bomb: { state: "planted", position: { x: -390, y: -1660, z: -168 }, countdown: 30 } });
    for (let t = 0; t < 4000; t += 100) frames.push({ players: [clutcher, defuser, other, ...deadTs, ...deadCts], bomb: { state: "defusing", position: { x: -390, y: -1660, z: -168 }, player: CT(6), countdown: 27 } });
    const ticks = run(frames, T(1));
    const cut = ticks.find((t) => t.out.intent?.kind === "select_player" && t.out.intent.targetSteamId === CT(6))!;
    expect(cut, "a cut to the defuser").toBeDefined();
    expect(cut.out.decision.reasonCodes).toContain("CLUTCH_HUNTER_DEFUSING");
    expect(spans(ticks).find((s) => s.who === CT(6))!.ms).toBeLessThanOrEqual(3000);
    expect(ticks[ticks.length - 1]!.observed).toBe(T(1));
  });

  it("knows a hunter 260 units away through the wall between the ladder room and the underpass is a long walk off: no contact", () => {
    const a = { x: -1080, y: -144, z: -156 };
    const b = { x: -1080, y: -404, z: -156 };
    const frames: Parameters<typeof run>[0] = [];
    for (let t = 0; t < 1000; t += 100) frames.push({ players: [player(CT(6), "CT", 6, a), player(T(1), "T", 1, b), player(T(2), "T", 2, T_SPAWN), ...dead()] });
    const ticks = run(frames, CT(6));
    const s = ticks[ticks.length - 1]!.out.clutch!;
    expect(s.hunters.find((h) => h.steamId === T(1))!.walk).toBeGreaterThan(2000);
    expect(s.contactSoon).toBe(false);
  });
});
