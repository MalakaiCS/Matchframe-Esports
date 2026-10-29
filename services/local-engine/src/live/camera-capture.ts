import type { CameraRecord, Vec3 } from "@matchframe/contracts";
import type { MapRegistry } from "@matchframe/map-runtime";
import { draftCamera, type CameraUse } from "@matchframe/map-runtime";
import type { SettingsRepo } from "../db/store.ts";

/** How far ahead of the camera its focus is looked for (units), in steps of this. */
const FOCUS_MAX = 3000;
const FOCUS_STEP = 40;
const FOCUS_MIN = 150;
const FOCUS_DEFAULT = 900;

interface PoseReader {
  readPose?: () => Promise<{ position: Vec3; pitch: number; yaw: number } | null>;
}

/**
 * "Save this view": the camera where it is in CS2 now (the console's `getpos`) becomes one of your
 * cameras for this map, used for freeze-time shots and fight overviews. You placed it and looked
 * through it, so it counts as checked; Hide in the camera walkthrough or the map's list takes it
 * out again. Its focus is the first wall or floor straight ahead in the map's free-space grid.
 */
export class CameraCapture {
  constructor(
    private readonly deps: {
      session: { state(): { mapName: string | null } | null; arbiter: { getAdapter(): unknown } };
      maps: MapRegistry;
      settings: SettingsRepo;
      applyOverrides: (mapName: string) => void;
    },
  ) {}

  async capture(opts: { displayName?: string | undefined; uses?: CameraUse[] | undefined } = {}): Promise<CameraRecord> {
    const adapter = this.deps.session.arbiter.getAdapter() as PoseReader | null;
    if (!adapter?.readPose) throw Object.assign(new Error("saving the CS2 view needs the CS2 console: start CS2 in the Observer tools mode"), { status: 409 });
    const mapName = this.deps.session.state()?.mapName ?? null;
    const rt = mapName ? this.deps.maps.get(mapName) : undefined;
    if (!mapName || !rt) throw Object.assign(new Error(mapName ? `no map data for ${mapName}` : "no map is being played"), { status: 409 });
    const pose = await adapter.readPose();
    if (!pose) throw Object.assign(new Error("CS2 did not answer getpos: is the console connected?"), { status: 409 });

    const p = (pose.pitch * Math.PI) / 180;
    const y = (pose.yaw * Math.PI) / 180;
    const dir = { x: Math.cos(p) * Math.cos(y), y: Math.cos(p) * Math.sin(y), z: -Math.sin(p) };
    const at = (d: number): Vec3 => ({ x: pose.position.x + dir.x * d, y: pose.position.y + dir.y * d, z: pose.position.z + dir.z * d });
    let focusDist = FOCUS_DEFAULT;
    if (rt.grid) {
      for (let d = FOCUS_STEP; d <= FOCUS_MAX; d += FOCUS_STEP) {
        if (!rt.grid.segmentClear(pose.position, at(d), 0)) {
          focusDist = Math.max(FOCUS_MIN, d - FOCUS_STEP);
          break;
        }
      }
    }
    const focus = at(focusDist);

    const key = `cameras.${rt.mapName}`;
    const mine = this.deps.settings.get<CameraRecord[]>(key, []);
    let n = mine.filter((c) => c.id.startsWith("mine-")).length + 1;
    while (mine.some((c) => c.id === `mine-${n}`)) n++;
    const regions = rt.regionsAt(focus);
    const area = regions.map((r) => rt.pack.regions.find((x) => x.id === r)?.displayName).find(Boolean);
    const cam: CameraRecord = {
      ...draftCamera({
        id: `mine-${n}`,
        displayName: opts.displayName?.trim() || `My camera ${n}${area ? `: ${area}` : ""}`,
        mapName: rt.mapName,
        mapRevision: rt.pack.mapRevision,
        pose: { ...pose, roll: 0 },
        focus,
        coverageRadiusUnits: Math.min(1200, Math.max(400, focusDist * 0.6)),
        levelId: rt.levelAt(focus),
        targetRegionIds: regions,
        capturedFrom: "netcon_readback",
        uses: opts.uses ?? ["establishing", "tactical"],
      }),
      validation: "validated",
      notes: "Saved from the CS2 view",
    };
    this.deps.settings.set(key, [...mine, cam]);
    this.deps.applyOverrides(rt.mapName);
    return cam;
  }
}
