import type { MapRuntime } from "@matchframe/map-runtime";

/** An LHM radar calibration: image pixel = origin + world × pxPerU (pxPerUY is negative, north up). */
export interface LhmRadarConfig {
  origin: { x: number; y: number };
  pxPerUX: number;
  pxPerUY: number;
}

/** LHM template radars are 1024 × 1024 images. */
const SIZE = 1024;
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A radar image for a map with no radar drawing (Anubis, Cache): the map pack's outline (the cells
 * where players were seen in pro demos, 64 units) as a 1024 × 1024 SVG in the flat style of LHM
 * template radars (dark walkable area, bombsites in red, site letters), with its calibration. It
 * uses the same transform as Matchframe's own schematic radar (MapRuntime.schematicTransform).
 */
export function outlineRadar(rt: MapRuntime): { svg: string; config: LhmRadarConfig } | null {
  const t = rt.schematicTransform();
  const outline = rt.schematicOutline();
  if (!t || !outline || (!outline.cells.length && !outline.polygons.length)) return null;
  const k = SIZE / t.size;
  const isSite = (ri: number) => outline.regions[ri]?.kind === "bombsite";
  // Neighbouring cells of a row as one rectangle.
  const runs = (cells: [number, number, number, number][]) => {
    const rows = new Map<string, [number, number, number][]>();
    for (const [u, v, w] of cells) {
      const key = `${v}:${w}`;
      const row = rows.get(key) ?? [];
      row.push([u, v, w]);
      rows.set(key, row);
    }
    const out: string[] = [];
    for (const row of rows.values()) {
      row.sort((a, b) => a[0] - b[0]);
      const [first, v, w] = row[0]!;
      let u0 = first;
      let u1 = u0 + w;
      const flush = () => out.push(`<rect x="${r1(u0 * SIZE)}" y="${r1(v * SIZE)}" width="${r1((u1 - u0) * SIZE + 0.6)}" height="${r1(w * SIZE + 0.6)}"/>`);
      for (const [u] of row.slice(1)) {
        if (u - u1 < w * 0.01) u1 = u + w;
        else {
          flush();
          u0 = u;
          u1 = u + w;
        }
      }
      flush();
    }
    return out.join("");
  };
  const polygon = (points: [number, number][]) => `<polygon points="${points.map(([u, v]) => `${r1(u * SIZE)},${r1(v * SIZE)}`).join(" ")}"/>`;
  const labels = outline.regions
    .map((r, ri) => ({ r, ri }))
    .filter(({ r }) => r.kind === "bombsite")
    .map(({ r, ri }) => {
      const cells = outline.cells.filter((c) => c[3] === ri);
      if (!cells.length) return "";
      const cx = cells.reduce((s, c) => s + c[0] + c[2] / 2, 0) / cells.length;
      const cy = cells.reduce((s, c) => s + c[1] + c[2] / 2, 0) / cells.length;
      const letter = /\b([ab])$/i.exec(r.id.replace(/_/g, " "))?.[1]?.toUpperCase() ?? r.name.slice(-1).toUpperCase();
      return `<text x="${r1(cx * SIZE)}" y="${r1(cy * SIZE)}">${letter}</text>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">` +
    `<g fill="#283041" shape-rendering="crispEdges">${runs(outline.cells)}${outline.polygons.map((p) => polygon(p.points)).join("")}</g>` +
    `<g fill="#4c2a3a" shape-rendering="crispEdges">${runs(outline.cells.filter((c) => isSite(c[3])))}${outline.polygons.filter((p) => isSite(p.regionIndex)).map((p) => polygon(p.points)).join("")}</g>` +
    `<g fill="#9aa3b5" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="34" text-anchor="middle" dominant-baseline="central">${labels}</g>` +
    `</svg>`;
  return { svg, config: { origin: { x: -t.minX * k, y: t.maxY * k }, pxPerUX: k, pxPerUY: -k } };
}
