import type { MapPack } from "@matchframe/contracts";
import { MapPack as MapPackSchema } from "@matchframe/contracts";
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
 * Requested initial map-pack targets from the specification. The official active-duty pool must
 * be checked against an authoritative source at release time; this list is editable.
 */
export const REQUESTED_MAP_TARGETS: readonly MapProfile[] = [
  { mapName: "de_inferno", displayName: "Inferno", requested: true, inEventPool: true },
  { mapName: "de_mirage", displayName: "Mirage", requested: true, inEventPool: true },
  { mapName: "de_dust2", displayName: "Dust II", requested: true, inEventPool: true },
  { mapName: "de_nuke", displayName: "Nuke", requested: true, inEventPool: true },
  { mapName: "de_ancient", displayName: "Ancient", requested: true, inEventPool: true },
  { mapName: "de_anubis", displayName: "Anubis", requested: true, inEventPool: true },
  { mapName: "de_overpass", displayName: "Overpass", requested: true, inEventPool: true },
  { mapName: "de_train", displayName: "Train", requested: true, inEventPool: true },
  { mapName: "de_vertigo", displayName: "Vertigo", requested: true, inEventPool: true },
];

export interface LoadIssue {
  file: string;
  error: string;
}

export class MapRegistry {
  private readonly runtimes = new Map<string, MapRuntime>();
  readonly issues: LoadIssue[] = [];

  register(pack: MapPack): MapRuntime {
    const rt = new MapRuntime(pack);
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
