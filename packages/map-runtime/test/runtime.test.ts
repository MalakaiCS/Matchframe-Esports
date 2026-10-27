import { describe, expect, it } from "vitest";
import { applyMapRevision, buildCoverageRow, checkCameraPath, draftCamera, MapRegistry, MapRuntime, parseGetpos, syntheticMapPack, targetInFrame } from "../src/index.ts";

describe("MapRuntime", () => {
  const rt = new MapRuntime(syntheticMapPack({ withValidatedCamera: true }));

  it("returns zero regions for valid positions outside named areas instead of rejecting them", () => {
    expect(rt.regionsAt({ x: 9000, y: 9000, z: 0 })).toEqual([]);
    expect(rt.regionsAt({ x: -500, y: 0, z: 0 })).toEqual(["bottom_banana"]);
  });

  it("separates vertical levels so an event below a floor does not match the room above", () => {
    expect(rt.levelAt({ x: 1500, y: 0, z: 0 })).toBe("ground");
    expect(rt.levelAt({ x: 1500, y: 0, z: 600 })).toBe("upper");
    expect(rt.regionsAt({ x: 1500, y: 0, z: 600 })).toContain("upper_room");
    expect(rt.regionsAt({ x: 1500, y: 0, z: 0 })).not.toContain("upper_room");
  });

  it("finds validated cameras covering an action point on the right level only", () => {
    expect(rt.camerasCovering({ x: -500, y: 50, z: 10 }).map((m) => m.camera.id)).toEqual(["synthetic-bottom-banana-wide"]);
    expect(rt.camerasCovering({ x: -500, y: 50, z: 1000 })).toEqual([]);
    expect(rt.camerasCovering({ x: 2000, y: 3000, z: 0 })).toEqual([]);
  });

  it("excludes unvalidated cameras from automatic use", () => {
    const unvalidated = new MapRuntime(syntheticMapPack({ withValidatedCamera: false }));
    expect(unvalidated.camerasCovering({ x: -500, y: 0, z: 0 })).toEqual([]);
    expect(unvalidated.camerasCovering({ x: -500, y: 0, z: 0 }, { includeUnvalidated: true })).toHaveLength(1);
  });

  it("refuses radar coordinates without calibration", () => {
    const pack = { ...syntheticMapPack(), radar: null };
    expect(new MapRuntime(pack).worldToRadar({ x: 0, y: 0, z: 0 })).toBeNull();
    const p = rt.worldToRadar({ x: -3500, y: 4500, z: 0 })!;
    expect(p.u).toBeCloseTo(0);
    expect(p.v).toBeCloseTo(0);
  });

  it("maps a bombsite position to its site", () => {
    expect(rt.siteAt({ x: 1500, y: 0, z: 0 })).toBe("B");
    expect(rt.siteAt({ x: 1500, y: 3000, z: 0 })).toBe("A");
    expect(rt.siteAt({ x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe("map revisions", () => {
  it("selectively invalidates cameras, regions and radar from older revisions", () => {
    const { pack, invalidated } = applyMapRevision(syntheticMapPack({ withValidatedCamera: true }), "synthetic-2");
    expect(pack.cameras[0]!.validation).toBe("invalidated");
    expect(pack.regions.every((r) => !r.validated)).toBe(true);
    expect(invalidated).toContain("camera:synthetic-bottom-banana-wide");
    expect(new MapRuntime(pack).camerasCovering({ x: -500, y: 0, z: 0 }, { includeUnvalidated: true })).toEqual([]);
  });
});

describe("camera authoring", () => {
  it("parses real getpos output and drafts an unvalidated camera", () => {
    const pose = parseGetpos("setpos 123.50 -456.25 78.00;setang 12.5 -90.0 0.0")!;
    expect(pose.position).toEqual({ x: 123.5, y: -456.25, z: 78 });
    expect(pose.yaw).toBe(-90);
    const cam = draftCamera({ id: "c1", displayName: "c1", mapName: "de_x", mapRevision: "r1", pose, focus: { x: 0, y: 0, z: 0 }, coverageRadiusUnits: 500, levelId: null, targetRegionIds: [] });
    expect(cam.validation).toBe("unvalidated");
    expect(parseGetpos("garbage")).toBeNull();
  });

  it("checks whether a target is in frame", () => {
    const cam = { position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, fov: 90 };
    expect(targetInFrame(cam, { x: 100, y: 10, z: 0 })).toBe(true);
    expect(targetInFrame(cam, { x: -100, y: 0, z: 0 })).toBe(false);
  });

  it("flags camera paths that are too fast, too long or not collision validated", () => {
    const r = checkCameraPath({
      id: "p", displayName: "p", mapName: "m", mapRevision: "r", maxDurationMs: 3000, maxSpeedUnitsPerSec: 300, collisionValidated: false, validation: "unvalidated", targetRegionIds: [],
      keyframes: [
        { tMs: 0, position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0 },
        { tMs: 1000, position: { x: 1000, y: 0, z: 0 }, pitch: 0, yaw: 0 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/speed/);
    expect(r.problems.join(" ")).toMatch(/collision/);
  });
});

describe("registry and coverage", () => {
  it("rejects invalid packs without partially loading them", () => {
    const reg = new MapRegistry();
    expect(reg.registerRaw({ mapName: "broken" }, "broken.json")).toBeNull();
    expect(reg.issues).toHaveLength(1);
    expect(reg.registerRaw(syntheticMapPack(), "ok.json")).not.toBeNull();
  });

  it("never claims camera coverage or telemetry support by default", () => {
    const row = buildCoverageRow("de_mirage", undefined, null);
    expect(row.mapPackPresent).toBe(false);
    expect(row.cells.every((c) => c.telemetry === "unverified" && c.cameraCoverage === "none")).toBe(true);
    expect(row.cells).toHaveLength(6);
  });
});
