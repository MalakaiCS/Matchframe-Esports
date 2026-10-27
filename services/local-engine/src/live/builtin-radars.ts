import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Built-in radar images (assets/radars, from Lexogrine's MIT CS2 HUD template) with their
 * world-to-image calibration. Image pixel = origin + world * pxPerU. Maps with two levels (Nuke,
 * Vertigo) draw both on one image; a position uses the layer whose zMin <= z < zMax.
 */
const Layer = z.object({
  id: z.string(),
  originX: z.number(),
  originY: z.number(),
  pxPerUX: z.number(),
  pxPerUY: z.number(),
  zMin: z.number().optional(),
  zMax: z.number().optional(),
});
const RadarsFile = z.object({
  maps: z.record(z.string(), z.object({ file: z.string().regex(/^[a-z0-9_]+\.png$/), size: z.number().int().positive(), layers: z.array(Layer).min(1) })),
});

export type RadarLayer = z.infer<typeof Layer>;

export interface BuiltinRadar {
  mapName: string;
  /** Absolute path of the image. */
  file: string;
  size: number;
  layers: RadarLayer[];
}

export function radarLayerFor(radar: Pick<BuiltinRadar, "layers">, z: number): RadarLayer {
  return radar.layers.find((l) => (l.zMin === undefined || z >= l.zMin) && (l.zMax === undefined || z < l.zMax)) ?? radar.layers[0]!;
}

/** World position → 0..1 image coordinates (null outside the image). */
export function builtinRadarUv(radar: Pick<BuiltinRadar, "layers" | "size">, p: { x: number; y: number; z: number }): { u: number; v: number; layerId: string } | null {
  const l = radarLayerFor(radar, p.z);
  const u = (l.originX + p.x * l.pxPerUX) / radar.size;
  const v = (l.originY + p.y * l.pxPerUY) / radar.size;
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) return null;
  return { u, v, layerId: l.id };
}

/** World units → 0..1 image units (for utility radii). */
export function builtinRadarScale(radar: Pick<BuiltinRadar, "layers" | "size">, z: number): number {
  return Math.abs(radarLayerFor(radar, z).pxPerUX) / radar.size;
}

export class BuiltinRadars {
  private constructor(private readonly byMap: Map<string, BuiltinRadar>) {}

  static load(dir: string | null, warn: (msg: string, data?: unknown) => void = () => undefined): BuiltinRadars {
    const byMap = new Map<string, BuiltinRadar>();
    if (!dir) return new BuiltinRadars(byMap);
    const file = join(dir, "radars.json");
    if (!existsSync(file)) {
      warn("built-in radars not found", { file });
      return new BuiltinRadars(byMap);
    }
    try {
      const parsed = RadarsFile.parse(JSON.parse(readFileSync(file, "utf8")));
      for (const [mapName, r] of Object.entries(parsed.maps)) {
        const img = join(dir, r.file);
        if (existsSync(img)) byMap.set(mapName, { mapName, file: img, size: r.size, layers: r.layers });
      }
    } catch (e) {
      warn("could not read the built-in radars", { file, error: e instanceof Error ? e.message : String(e) });
    }
    return new BuiltinRadars(byMap);
  }

  get(mapName: string | null): BuiltinRadar | undefined {
    return mapName ? this.byMap.get(mapName) : undefined;
  }

  get maps(): string[] {
    return [...this.byMap.keys()].sort();
  }
}
