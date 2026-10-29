import type { MapPack } from "@matchframe/contracts";
import { MapPack as MapPackSchema } from "@matchframe/contracts";
import type { VisibilityGrid } from "./grid.ts";
import { MapRuntime } from "./runtime.ts";

export interface MapProfile {
  mapName: string;
  displayName: string;
  /** Requested support backlog target; does not assert the map is in any current official pool. */
  requested: boolean;
  /** Configured event pool membership (editable per event). */
  inEventPool: boolean;
}

/**
 * Map-pack targets, and the default event pool: the active-duty pool as the owner gave it (seven
 * maps, with a pro demo of each: Ancient, Anubis, Cache, Dust II, Inferno, Mirage, Nuke). Overpass,
 * Train and Vertigo keep their packs, out of the default pool. Editable per event.
 */
export const REQUESTED_MAP_TARGETS: readonly MapProfile[] = [
  { mapName: "de_inferno", displayName: "Inferno", requested: true, inEventPool: true },
  { mapName: "de_mirage", displayName: "Mirage", requested: true, inEventPool: true },
  { mapName: "de_dust2", displayName: "Dust II", requested: true, inEventPool: true },
  { mapName: "de_nuke", displayName: "Nuke", requested: true, inEventPool: true },
  { mapName: "de_ancient", displayName: "Ancient", requested: true, inEventPool: true },
  { mapName: "de_anubis", displayName: "Anubis", requested: true, inEventPool: true },
  { mapName: "de_cache", displayName: "Cache", requested: true, inEventPool: true },
  { mapName: "de_overpass", displayName: "Overpass", requested: true, inEventPool: false },
  { mapName: "de_train", displayName: "Train", requested: true, inEventPool: false },
  { mapName: "de_vertigo", displayName: "Vertigo", requested: true, inEventPool: false },
];

export interface LoadIssue {
  file: string;
  error: string;
}

export class MapRegistry {
  private readonly runtimes = new Map<string, MapRuntime>();
  private readonly grids = new Map<string, VisibilityGrid>();
  readonly issues: LoadIssue[] = [];
  private builtIn = true;
  private readonly hidden = new Map<string, ReadonlySet<string>>();

  /** Built-in cameras and paths on or off for every map (see MapRuntime.builtInCameras). */
  setBuiltInCameras(on: boolean): void {
    this.builtIn = on;
    for (const rt of this.runtimes.values()) rt.builtInCameras = on;
  }

  get builtInCameras(): boolean {
    return this.builtIn;
  }

  /** Cameras hidden on a map (see MapRuntime.hiddenCameras); they stay hidden when its pack is registered again. */
  setHiddenCameras(map: string, ids: Iterable<string>): void {
    const set = new Set(ids);
    this.hidden.set(map, set);
    const rt = this.runtimes.get(map);
    if (rt) rt.hiddenCameras = set;
  }

  /** A map's free-space grid; it stays with the map when its pack is registered again. */
  setGrid(grid: VisibilityGrid): void {
    this.grids.set(grid.map, grid);
    const rt = this.runtimes.get(grid.map);
    if (rt) rt.grid = grid;
  }

  register(pack: MapPack): MapRuntime {
    const rt = new MapRuntime(pack);
    rt.builtInCameras = this.builtIn;
    rt.hiddenCameras = this.hidden.get(pack.mapName) ?? new Set();
    rt.grid = this.grids.get(pack.mapName) ?? null;
    this.runtimes.set(pack.mapName, rt);
    return rt;
  }

  /** Validates and registers a raw JSON pack; invalid packs are recorded, never partially loaded. */
  registerRaw(raw: unknown, file: string): MapRuntime | null {
    const r = MapPackSchema.safeParse(raw);
    if (!r.success) {
      this.issues.push({ file, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return null;
    }
    return this.register(r.data);
  }

  get(mapName: string): MapRuntime | undefined {
    return this.runtimes.get(mapName);
  }

  list(): MapRuntime[] {
    return [...this.runtimes.values()];
  }
}
