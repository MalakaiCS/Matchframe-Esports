import { describe, expect, it } from "vitest";
import type { OwnershipState } from "@matchframe/contracts";
import { MapRuntime, syntheticMapPack, VisibilityGrid } from "@matchframe/map-runtime";
import type { SyntheticPlayer } from "@matchframe/cs2-state";
import { Director, parseShot } from "../src/index.ts";
import { capsWithCameraControl, CT, player, Sim, T } from "./helpers.ts";

const armed: OwnershipState = { owner: "director", generation: 2, holder: "director", acquiredAtMonotonicMs: 0, leaseExpiresAtMonotonicMs: null, manualSticky: false, emergencyStopped: false };
const ctl = { ownership: armed, adapterAvailable: true, inputFresh: true, pendingCommand: false };

/** An empty grid over the synthetic map: everything is open. */
const openGrid = (map: string) => new VisibilityGrid({ map, build: "t", cell: 64, origin: [-6000, -6000, -500], dims: [190, 190, 30] }, new Uint8Array(Math.ceil((190 * 190 * 30) / 8)));

/** T1 runs alone along +x (a rotation); everyone else stands far apart. */
function rotation(step: number): SyntheticPlayer[] {
  const x = -2000 + step * 25;
  return [
    player(T(1), "T", 1, { x, y: -2500, z: 0 }, { x: 1, y: 0, z: 0 }),
    player(T(2), "T", 2, { x: -3000, y: 2500, z: 0 }),
    player(T(3), "T", 3, { x: -3100, y: 2600, z: 0 }),
    player(T(4), "T", 4, { x: -3200, y: 2400, z: 0 }),
    player(T(5), "T", 5, { x: -3300, y: 2500, z: 0 }),
    player(CT(6), "CT", 6, { x: 3000, y: 3000, z: 0 }),
    player(CT(7), "CT", 7, { x: 3100, y: 3100, z: 0 }),
    player(CT(8), "CT", 8, { x: 3200, y: 3000, z: 0 }),
    player(CT(9), "CT", 9, { x: 3300, y: 3100, z: 0 }),
    player(CT(0), "CT", 0, { x: 3400, y: 3000, z: 0 }),
  ];
}

function run(opts: { follow: boolean; grid: boolean; steps?: number; timeline?: { at: number; intent: string }[] }) {
  const sim = new Sim("de_inferno");
  const director = new Director({ newId: (() => { let i = 0; return () => `d${i++}`; })() });
  director.setMode("automatic");
  director.setObserverMode("observer_cinematics");
  const rt = new MapRuntime(syntheticMapPack({ withValidatedCamera: true, mapName: "de_inferno" }));
  if (opts.grid) rt.grid = openGrid("de_inferno");
  director.setMap(rt);
  const caps = capsWithCameraControl("supported");
  caps.cameraPathControl = { ...caps.cameraPathControl, support: "supported" };
  director.setCapabilities(caps);
  director.controls.followCams = opts.follow;
  let observed: string | null = T(1);
  const intents: string[] = [];
  // The round has been live a while (no cinematic in a round's first seconds).
  for (let i = 0; i < 80; i++) director.evaluate(sim.push(rotation(0), { mapName: "de_inferno", observed, dtMs: 150 }), sim.now, ctl);
  for (let i = 0; i < (opts.steps ?? 80); i++) {
    const out = director.evaluate(sim.push(rotation(i % 160), { mapName: "de_inferno", observed, dtMs: 100 }), sim.now, ctl);
    if (out.intent) intents.push(`${out.intent.kind}:${out.intent.targetSteamId ?? out.intent.cameraId ?? out.intent.pathId}`);
    if (out.intent) opts.timeline?.push({ at: i * 100, intent: out.intent.kind });
    if (out.intent?.kind === "select_player") observed = out.intent.targetSteamId;
    if (out.intent?.kind === "follow_player") {
      observed = null;
      director.cinematicStarted(`follow:${out.intent.targetSteamId}`, sim.now, out.intent.plannedDurationMs ?? 4500, null);
    }
  }
  return intents;
}

describe("follow cam choice", () => {
  it("flies a follow cam behind a lone player on a quiet rotation", () => {
    const intents = run({ follow: true, grid: true });
    expect(intents).toContain(`follow_player:${T(1)}`);
  });

  it("flies one follow cam per map at most, and hands back to a player when it ends", () => {
    const timeline: { at: number; intent: string }[] = [];
    const intents = run({ follow: true, grid: true, steps: 600, timeline });
    expect(intents.filter((i) => i.startsWith("follow_player"))).toHaveLength(1);
    const f = timeline.findIndex((t) => t.intent === "follow_player");
    const back = timeline[f + 1];
    expect(back?.intent).toBe("select_player");
    // Its planned 4.5 s, give or take one update.
    expect(back!.at - timeline[f]!.at).toBeGreaterThanOrEqual(4000);
    expect(back!.at - timeline[f]!.at).toBeLessThanOrEqual(5000);
  });

  it("never without the map's grid, or with follow cams off", () => {
    expect(run({ follow: true, grid: false }).some((i) => i.startsWith("follow_player"))).toBe(false);
    expect(run({ follow: false, grid: true }).some((i) => i.startsWith("follow_player"))).toBe(false);
  });

  it("reads follow:<id> as a cinematic shot", () => {
    expect(parseShot(`follow:${T(1)}`)).toEqual({ kind: "follow", id: T(1) });
  });
});
