/**
 * The director test bench from the command line, on replay streams (workers `export-replay`).
 * Run: pnpm exec tsx services/local-engine/scripts/bench-replays.ts [--pov <export dir>] [--weight 0.5] [--ref 0.5] [--no-multi-frag] <replay.jsonl>...
 * `--pov builtin` uses assets/models/pov_2s-builtin. Prints one line per replay and the totals.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";
import { DEFAULT_DIRECTOR_CONFIG } from "@matchframe/director-policy";
import { MapRegistry, VisibilityGrid } from "@matchframe/map-runtime";
import { runBench, sumBench, type BenchResult, type ReplayLine } from "../src/demos/bench.ts";
import { loadPovModel } from "../src/live/model-runtime.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { pov: { type: "string" }, weight: { type: "string", default: "0.5" }, ref: { type: "string", default: "0.5" }, "no-multi-frag": { type: "boolean", default: false } },
});
const packs = join(root, "assets", "map-packs");
const maps = new MapRegistry();
const mapFor = (name: string) => {
  if (!maps.get(name)) {
    const f = join(packs, `${name}.json`);
    if (!existsSync(f)) return undefined;
    maps.registerRaw(JSON.parse(readFileSync(f, "utf8")), f);
    const g = join(packs, `${name}.grid`);
    if (existsSync(g)) maps.setGrid(VisibilityGrid.parse(readFileSync(g), (b) => inflateSync(b)));
  }
  return maps.get(name);
};
const povDir = values.pov === "builtin" ? join(root, "assets", "models", "pov_2s-builtin") : values.pov;
const loaded = povDir ? loadPovModel(povDir, "bench") : null;
if (loaded && !loaded.ok) throw new Error(`POV model not loaded: ${loaded.reason}`);
const results: BenchResult[] = [];
for (const file of positionals) {
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ReplayLine);
  const header = lines[0]?.type === "header" ? lines[0] : null;
  const r = runBench(lines, {
    map: header ? mapFor(header.map) : undefined,
    config: { multiFrag: { ...DEFAULT_DIRECTOR_CONFIG.multiFrag, enabled: !values["no-multi-frag"] } },
    pov: loaded?.ok ? { model: loaded.model.fresh(), weight: Number(values.weight), ref: Number(values.ref) } : undefined,
  });
  results.push(r);
  console.log(JSON.stringify(r));
}
console.log("TOTAL", JSON.stringify(sumBench(results)));
