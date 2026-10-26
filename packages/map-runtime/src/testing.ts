import type { CameraRecord, MapPack, Region } from "@matchframe/contracts";

/**
 * SYNTHETIC map pack for unit tests and simulation only. Its geometry is a made-up rectangle
 * layout named "test_*"; it is not a real CS2 map and must never be shipped as a real pack.
 */
export function syntheticMapPack(opts: { withValidatedCamera?: boolean; mapName?: string } = {}): MapPack {
  const mapName = opts.mapName ?? "de_synthetic";
  const rect = (id: string, name: string, kind: Region["kind"], x0: number, y0: number, x1: number, y1: number, zMin = -200, zMax = 300): Region => ({
    id,
    name,
    kind,
    levelId: zMin >= 400 ? "upper" : "ground",
    shapes: [{ kind: "polygon", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], zMin, zMax }],
    source: "authored",
    sampleCount: null,
    validated: true,
    tags: ["synthetic"],
  });
  const regions: Region[] = [
    rect("t_spawn", "T Spawn", "spawn", -3000, -3000, -2000, -2000),
    rect("bottom_banana", "Bottom Banana", "choke", -1000, -500, 0, 500),
    rect("top_banana", "Top Banana", "choke", 0, -500, 1000, 500),
    rect("site_b", "Bombsite B", "bombsite", 1000, -1000, 2500, 1000),
    rect("site_a", "Bombsite A", "bombsite", 1000, 2500, 2500, 4000),
    rect("mid", "Mid", "mid", -1000, 1500, 1000, 2500),
    rect("upper_room", "Upper Room", "elevated", 1000, -1000, 2500, 1000, 400, 800),
  ];
  const camera: CameraRecord = {
    id: "synthetic-bottom-banana-wide",
    displayName: "SYNTHETIC Bottom Banana wide",
    mapName,
    mapRevision: "synthetic-1",
    position: { x: -200, y: -900, z: 350 },
    pitch: 25,
    yaw: 110,
    fov: 90,
    observerMode: "roaming_static",
    targetRegionIds: ["bottom_banana"],
    coverage: { center: { x: -500, y: 0, z: 0 }, radiusUnits: 650, zMin: -200, zMax: 300, levelId: "ground" },
    allowedPhases: ["live"],
    actionClasses: ["utility", "tactical"],
    grenadeTypes: [],
    minAcquisitionMs: 400,
    normalDurationMs: 2000,
    maxDurationMs: 3000,
    occlusionValidation: opts.withValidatedCamera ? "validated" : "unvalidated",
    validation: opts.withValidatedCamera ? "validated" : "unvalidated",
    exitStrategy: "most_relevant_player",
    lastTestedGameBuild: null,
    lastTestedMapVersion: null,
    capturedFrom: "imported",
    notes: "synthetic test camera",
  };
  return {
    schemaVersion: 1,
    mapName,
    displayName: "Synthetic Test Map",
    mapRevision: "synthetic-1",
    radar: { posX: -3500, posY: 4500, scale: 8, rotationDeg: 0, imageSizePx: 1024, source: "operator_calibration", verified: true, notes: "synthetic" },
    levels: [
      { id: "ground", name: "Ground", zMin: -1000, zMax: 400, radar: null },
      { id: "upper", name: "Upper", zMin: 400, zMax: 2000, radar: null },
    ],
    regions,
    cameras: [camera],
    paths: [],
    bombsites: [
      { site: "A", regionId: "site_a" },
      { site: "B", regionId: "site_b" },
    ],
    scenarios: [
      {
        id: "synthetic-bottom-banana",
        mapName,
        regionIds: ["bottom_banana"],
        targetSide: "T",
        minAliveTargets: 3,
        grenadeTypes: ["he", "molotov", "incendiary"],
        maxTimeToEffectMs: 2500,
        minConfidence: 0.45,
        valueBoost: 0.25,
        preferredCameraIds: [],
      },
    ],
    coverage: [],
    floorGrid: { cellSize: 100, cells: [], source: "synthetic", sampleCount: 0 },
    provenance: { createdBy: "tests", createdAt: "2026-10-26T00:00:00Z", sources: ["synthetic"] },
  };
}
