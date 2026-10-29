import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSyntheticGsiPayload, MatchStateStore, normalizeGsi, parseGsiPayload, type SyntheticPlayer } from "@matchframe/cs2-state";
import { DEFAULT_DIRECTOR_CONFIG } from "@matchframe/director-policy";
import { MapRegistry } from "@matchframe/map-runtime";
import { Database } from "../src/db/database.ts";
import type { DemoJobRepo } from "../src/db/store.ts";
import { SettingsRepo } from "../src/db/store.ts";
import { runBench, runBenchAsync, type ReplayLine } from "../src/demos/bench.ts";
import { DirectorBench } from "../src/demos/bench-service.ts";
import type { WorkerRunner } from "../src/demos/library.ts";
import { PovModelService } from "../src/demos/pov-model.ts";
import type { RegistryEntry } from "../src/demos/training.ts";
import { loadPovModel, LIVE_POV_FEATURES } from "../src/live/model-runtime.ts";
import type { LiveSession } from "../src/live/session.ts";
import { Logger } from "../src/logger.ts";

const BUILTIN_DIR = join(import.meta.dirname, "..", "..", "..", "assets", "models");

/**
 * A synthetic round (64 ticks/s, frames every 8 ticks): T1 kills CT1 at 2 s and CT2 at 5 s
 * (a multi-frag), then the round ends. Labelled synthetic; logic tests only.
 */
function syntheticReplay(): ReplayLine[] {
  const lines: ReplayLine[] = [{ type: "header", map: "de_synthetic", dataset_id: "synthetic-1", tick_rate: 64, rounds: 1 }];
  const alive = new Set(["t1", "t2", "ct1", "ct2", "ct3"]);
  const pos: Record<string, [string, number, number]> = { t1: ["T", 0, 0], t2: ["T", -2500, 0], ct1: ["CT", 600, 0], ct2: ["CT", 900, 300], ct3: ["CT", 3000, 2500] };
  const kills: Record<number, [string, string]> = { 128: ["t1", "ct1"], 320: ["t1", "ct2"] };
  for (let tick = 0; tick <= 640; tick += 8) {
    const k = kills[tick];
    if (k) {
      lines.push({ type: "kill", tick, attacker: k[0], victim: k[1] });
      alive.delete(k[1]);
    }
    const phase = tick < 64 ? "freezetime" : tick < 600 ? "live" : "over";
    const players = [...alive].map((id) => {
      const [side, x, y] = pos[id]!;
      // Everyone looks toward the middle (T to +x, CT to -x).
      return [id, side as "T" | "CT", x, y, 0, 0, side === "T" ? 0 : 180, 100, 100, side === "T" ? "AK-47" : "M4A1-S"] as [string, "T" | "CT", number, number, number, number, number, number, number, string | null];
    });
    lines.push({ type: "frame", tick, round: 1, phase, players, bomb: null });
  }
  return lines;
}

describe("the director test bench", () => {
  it("replays a round and counts kills, the opening kill and multi-frags", () => {
    const r = runBench(syntheticReplay(), {});
    expect(r).toMatchObject({ datasetId: "synthetic-1", map: "de_synthetic", rounds: 1, kills: 2, openingKills: 1, multiFragKills: 1 });
    expect(r.killsShown).toBeLessThanOrEqual(2);
    expect(r.liveMinutes).toBeCloseTo((600 - 64) / 64 / 60, 1);
    expect(r.cutsPerMinute).toBe(r.liveMinutes ? Math.round((r.cuts / r.liveMinutes) * 10) / 10 : 0);
  });

  it("gives the same result in the background as in one go", async () => {
    const lines = syntheticReplay();
    expect(await runBenchAsync(lines, {})).toEqual(runBench(lines, {}));
  });

  it("waits for a switch on its way (like live) instead of re-sending it", () => {
    const cuts: number[] = [];
    runBench(syntheticReplay(), { latencyMs: 2000, trace: (e) => e.kind === "cut" && cuts.push(e.at) });
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]! - cuts[i - 1]!).toBeGreaterThanOrEqual(2000);
  });

  it("runs with the demo-trained POV model and with multi-frag awareness off", () => {
    const m = loadPovModel(join(BUILTIN_DIR, "pov_2s-builtin"), "builtin");
    if (!m.ok) throw new Error(m.reason);
    const r = runBench(syntheticReplay(), { pov: { model: m.model.fresh(), weight: 0.5, ref: 0.5 }, config: { multiFrag: { ...DEFAULT_DIRECTOR_CONFIG.multiFrag, enabled: false } } });
    expect(r.kills).toBe(2);
  });
});

describe("the built-in POV model", () => {
  it("evaluates exactly like LightGBM did when it was exported", () => {
    const m = loadPovModel(join(BUILTIN_DIR, "pov_2s-builtin"), "builtin");
    if (!m.ok) throw new Error(m.reason);
    const pv = JSON.parse(readFileSync(join(BUILTIN_DIR, "pov_2s-builtin", "parity_vectors.json"), "utf8")) as { feature_names: string[]; vectors: { features: (number | null)[]; probability: number }[]; tolerance: number };
    expect(pv.feature_names).toEqual([...LIVE_POV_FEATURES]);
    const gbdt = (m.model as unknown as { gbdt: { predict(v: Float64Array): number; vector(f: Record<string, number>): Float64Array } }).gbdt;
    for (const v of pv.vectors) {
      const f = Object.fromEntries(pv.feature_names.map((n, i) => [n, v.features[i] ?? Number.NaN]));
      expect(Math.abs(gbdt.predict(gbdt.vector(f)) - v.probability)).toBeLessThanOrEqual(pv.tolerance);
    }
  });

  it("computes player features from the game data like the training code", () => {
    const m = loadPovModel(join(BUILTIN_DIR, "pov_2s-builtin"), "builtin");
    if (!m.ok) throw new Error(m.reason);
    const store = new MatchStateStore({ sessionId: "t", simulated: true });
    const players: SyntheticPlayer[] = [
      { steamId: "t1", name: "t1", slot: 1, side: "T" as const, health: 80, armor: 100, position: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 }, roundKills: 2, weapons: [{ name: "weapon_awp", type: "SniperRifle", state: "active", ammoClip: 5, ammoClipMax: 5, ammoReserve: 20 }] },
      { steamId: "ct1", name: "ct1", slot: 6, side: "CT" as const, health: 100, armor: 100, position: { x: 800, y: 0, z: 0 }, forward: { x: -1, y: 0, z: 0 }, weapons: [] },
      { steamId: "ct2", name: "ct2", slot: 7, side: "CT" as const, health: 100, armor: 100, position: { x: 0, y: 1500, z: 0 }, forward: { x: 0, y: 1, z: 0 }, weapons: [] },
    ];
    const parsed = parseGsiPayload(buildSyntheticGsiPayload({ mapName: "de_synthetic", players, observed: "t1", timestamp: 1, round: 2, roundPhase: "live", phase: "live", phaseEndsIn: 60 }));
    if (!parsed.ok) throw new Error(parsed.error);
    store.ingest(normalizeGsi(parsed.payload, { sourceId: "g", receivedAtMonotonicMs: 1000, payloadHash: "1" }));
    const s = store.snapshot(1000);
    m.model.observe(s);
    const f = m.model.povFeatures(s).get("t1")!;
    expect(f).toMatchObject({ side_t: 1, health: 80, armor: 100, weapon_class: 4, alive_own: 1, alive_opp: 2, round_kills: 2, nearest_dist: 800, opp_within_1000: 1, opp_within_2000: 2 });
    expect(f.nearest_facing_self).toBeCloseTo(1, 6); // looking straight at ct1
    expect(f.nearest_facing_opp).toBeCloseTo(1, 6); // ct1 looks straight back
    expect(f.max_facing_opp_2000).toBeCloseTo(1, 6);
    expect(f.heur_max).toBeCloseTo(Math.exp(-0.8), 6);
    const p = m.model.predictPlayers(s);
    expect([...p.keys()].sort()).toEqual(["ct1", "ct2", "t1"]);
    expect(p.get("t1")!).toBeGreaterThan(p.get("ct2")!);
  });
});

function fakeSession() {
  const calls: { model: string | null; blend: unknown }[] = [];
  const session = { setPovModel: (model: { id: string } | null, blend: unknown) => calls.push({ model: model?.id ?? null, blend }) } as unknown as LiveSession;
  return { session, calls };
}

describe("what the demos teach (POV model in the live director)", () => {
  function setup(registry: RegistryEntry[] = [], builtinDir: string | null = BUILTIN_DIR) {
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const { session, calls } = fakeSession();
    const svc = new PovModelService({ settings, session, builtinDir, modelsDir: mkdtempSync(join(tmpdir(), "mf-models-")), registry: () => registry, logger: new Logger("error", null) });
    return { svc, calls, settings };
  }

  it("uses the built-in model by default, and can be switched off and on", () => {
    const { svc, calls } = setup();
    const st = svc.apply();
    expect(st.active).toMatchObject({ modelId: "builtin", builtin: true });
    expect(st.active!.maps).toContain("de_mirage");
    expect(calls.at(-1)).toEqual({ model: "builtin", blend: { weight: 0.5, ref: 0.5 } });
    expect(svc.update({ enabled: false }).active).toBeNull();
    expect(calls.at(-1)!.model).toBeNull();
    expect(svc.loaded()).not.toBeNull(); // still loaded for the test bench
    expect(svc.update({ enabled: true }).active?.modelId).toBe("builtin");
  });

  it("refuses a model that is not a trained POV model, and runs without one that is missing", () => {
    const { svc, calls } = setup([], null);
    expect(() => svc.update({ modelId: "contact_2s-x" })).toThrow(/not a trained POV model/);
    const st = svc.apply();
    expect(st.active).toBeNull();
    expect(st.error).toMatch(/missing/);
    expect(calls.at(-1)!.model).toBeNull();
  });
});

class ReplayWorker implements WorkerRunner {
  readonly calls: string[][] = [];
  available() {
    return true;
  }
  async run(args: string[]) {
    this.calls.push(args);
    const out = args[args.indexOf("--out") + 1]!;
    writeFileSync(out, syntheticReplay().map((l) => JSON.stringify(l)).join("\n") + "\n");
    return { status: "exported", out };
  }
}

describe("the test bench in the program", () => {
  it("replays the newest read demos as set up, without the demo model and without multi-frag awareness", async () => {
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const { session } = fakeSession();
    const logger = new Logger("error", null);
    const pov = new PovModelService({ settings, session, builtinDir: BUILTIN_DIR, modelsDir: mkdtempSync(join(tmpdir(), "mf-models-")), registry: () => [], logger });
    pov.apply();
    const jobs = [
      { id: "a", state: "COMMITTED", datasetDir: "/data/a", updatedAt: "2026-10-01T00:00:00Z" },
      { id: "b", state: "COMMITTED", datasetDir: "/data/b", updatedAt: "2026-10-02T00:00:00Z" },
    ];
    const repo = { list: (state: string) => jobs.filter((j) => j.state === state) } as unknown as DemoJobRepo;
    const worker = new ReplayWorker();
    const bench = new DirectorBench({ workers: worker, repo, maps: new MapRegistry(), settings, logger, dataDir: mkdtempSync(join(tmpdir(), "mf-bench-")), isLive: () => false, povModel: pov, directorConfig: () => DEFAULT_DIRECTOR_CONFIG });
    const run = bench.start({ limit: 1 });
    expect(run.variants.map((v) => v.key)).toEqual(["current", "no_pov_model", "no_multi_frag"]);
    expect(run.povModel?.modelId).toBe("builtin");
    expect(() => bench.start()).toThrow(/already running/);
    for (let i = 0; i < 200 && bench.status().running; i++) await new Promise((r) => setTimeout(r, 25));
    const done = bench.status().runs.at(-1)!;
    expect(done.error).toBeNull();
    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0]).toContain("/data/b"); // the newest
    expect(Object.keys(done.totals!).sort()).toEqual(["current", "no_multi_frag", "no_pov_model"]);
    expect(done.totals!.current!.kills).toBe(2);
  });

  it("never runs during a live broadcast", () => {
    const db = new Database(":memory:");
    db.migrate();
    const settings = new SettingsRepo(db);
    const { session } = fakeSession();
    const logger = new Logger("error", null);
    const pov = new PovModelService({ settings, session, builtinDir: null, modelsDir: tmpdir(), registry: () => [], logger });
    const bench = new DirectorBench({ workers: new ReplayWorker(), repo: { list: () => [] } as unknown as DemoJobRepo, maps: new MapRegistry(), settings, logger, dataDir: tmpdir(), isLive: () => true, povModel: pov, directorConfig: () => DEFAULT_DIRECTOR_CONFIG });
    expect(() => bench.start()).toThrow(/live broadcast/);
  });
});
