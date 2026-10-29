import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DirectorConfig } from "@matchframe/director-policy";
import type { MapRegistry } from "@matchframe/map-runtime";
import type { DemoJobRepo, SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { runBenchAsync, sumBench, type BenchOptions, type BenchResult, type ReplayLine } from "./bench.ts";
import type { WorkerRunner } from "./library.ts";
import type { PovModelService } from "./pov-model.ts";

const RUNS_KEY = "bench.runs";

/** `current`: the director as set up now; the others leave one thing out, on the same matches. */
export type BenchVariantKey = "current" | "no_pov_model" | "no_multi_frag";
export const BENCH_VARIANT_LABELS: Record<BenchVariantKey, string> = {
  current: "Director as set up",
  no_pov_model: "Without the demo-trained POV model",
  no_multi_frag: "Without multi-frag awareness",
};

export interface BenchRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  variants: { key: BenchVariantKey; label: string }[];
  /** The POV model in use for `current` (null: none), and the matches it was trained on. */
  povModel: { modelId: string; maps: string[] } | null;
  results: { dataset: string; map: string; runs: Partial<Record<BenchVariantKey, BenchResult>> }[];
  totals: Partial<Record<BenchVariantKey, ReturnType<typeof sumBench>>> | null;
  error: string | null;
}

/**
 * The replay test bench: committed datasets replayed through the director (worker `export-replay`,
 * then `runBench`), scored on kills shown, lead time, multi-frags, opening kills and cuts. Never
 * during a live broadcast; the engine keeps serving between frames.
 */
export class DirectorBench {
  private current: BenchRun | null = null;
  private progress = { done: 0, total: 0, dataset: null as string | null };

  constructor(
    private readonly deps: {
      workers: WorkerRunner;
      repo: DemoJobRepo;
      maps: MapRegistry;
      settings: SettingsRepo;
      logger: Logger;
      dataDir: string;
      isLive: () => boolean;
      povModel: PovModelService;
      directorConfig: () => DirectorConfig;
    },
  ) {}

  runs(): BenchRun[] {
    return this.deps.settings.get<BenchRun[]>(RUNS_KEY, []);
  }

  status(): { running: boolean; progress: { done: number; total: number; dataset: string | null }; current: BenchRun | null; runs: BenchRun[] } {
    return { running: !!this.current && !this.current.finishedAt, progress: { ...this.progress }, current: this.current, runs: this.runs().slice(-10) };
  }

  /** Starts on the newest `limit` committed datasets (in the background). */
  start(opts: { limit?: number; compare?: boolean } = {}): BenchRun {
    if (this.current && !this.current.finishedAt) throw Object.assign(new Error("the test bench is already running"), { status: 409 });
    if (this.deps.isLive()) throw Object.assign(new Error("the test bench waits while a live broadcast is running"), { status: 409 });
    if (!this.deps.workers.available()) throw Object.assign(new Error("set up Python first: replays come from the pipeline"), { status: 409 });
    const jobs = (["COMMITTED", "RETENTION_ELIGIBLE", "QUARANTINED_RAW", "RAW_REMOVED"] as const).flatMap((s) => this.deps.repo.list(s, 1000)).filter((j) => j.datasetDir);
    jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const pick = jobs.slice(0, Math.max(1, Math.min(50, opts.limit ?? 10)));
    if (!pick.length) throw Object.assign(new Error("no demos have been read yet: import some in the Demo Library"), { status: 409 });
    const pov = this.deps.povModel.status();
    const model = pov.active ? this.deps.povModel.loaded() : null;
    const config = this.deps.directorConfig();
    const keys: BenchVariantKey[] = ["current"];
    if (opts.compare !== false) {
      if (model) keys.push("no_pov_model");
      if (config.multiFrag.enabled) keys.push("no_multi_frag");
    }
    const blend = { weight: pov.setting.weight, ref: pov.setting.ref };
    const variants: Record<BenchVariantKey, Omit<BenchOptions, "map">> = {
      current: { config, pov: model ? { model, ...blend } : undefined },
      no_pov_model: { config },
      no_multi_frag: { config: { ...config, multiFrag: { ...config.multiFrag, enabled: false } }, pov: model ? { model, ...blend } : undefined },
    };
    const run: BenchRun = {
      id: `bench-${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      variants: keys.map((key) => ({ key, label: BENCH_VARIANT_LABELS[key] })),
      povModel: pov.active ? { modelId: pov.active.modelId, maps: pov.active.maps } : null,
      results: [],
      totals: null,
      error: null,
    };
    this.current = run;
    this.progress = { done: 0, total: pick.length, dataset: null };
    void this.execute(run, pick.map((j) => j.datasetDir!), keys.map((k) => [k, variants[k]] as const));
    return run;
  }

  private async execute(run: BenchRun, datasets: string[], variants: (readonly [BenchVariantKey, Omit<BenchOptions, "map">])[]): Promise<void> {
    const dir = join(this.deps.dataDir, "bench");
    mkdirSync(dir, { recursive: true });
    try {
      for (const ds of datasets) {
        if (this.deps.isLive()) throw new Error("stopped: a live broadcast started");
        this.progress.dataset = ds;
        const out = join(dir, `${run.id}.jsonl`);
        try {
          await this.deps.workers.run(["export-replay", "--dataset", ds, "--out", out]);
          const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ReplayLine);
          const header = lines[0]?.type === "header" ? lines[0] : null;
          const map = header ? this.deps.maps.get(header.map) : undefined;
          const runs: Partial<Record<BenchVariantKey, BenchResult>> = {};
          // A model keeps per-round history: each replay starts it afresh (it is never the live one's turn here).
          for (const [key, v] of variants) runs[key] = await runBenchAsync(lines, { ...v, map, pov: v.pov ? { ...v.pov, model: v.pov.model.fresh() } : undefined });
          run.results.push({ dataset: runs.current!.datasetId, map: runs.current!.map, runs });
        } catch (e) {
          this.deps.logger.warn("bench: a dataset could not be replayed", { dataset: ds, error: String(e).slice(0, 300) });
        } finally {
          rmSync(out, { force: true });
        }
        this.progress.done++;
      }
      run.totals = run.results.length ? Object.fromEntries(variants.map(([key]) => [key, sumBench(run.results.map((r) => r.runs[key]!))])) : null;
      if (!run.results.length) run.error = "no dataset could be replayed (see the log)";
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e);
    } finally {
      run.finishedAt = new Date().toISOString();
      this.progress.dataset = null;
      this.deps.settings.set(RUNS_KEY, [...this.runs(), run].slice(-10));
      this.deps.logger.info("test bench finished", { id: run.id, matches: run.results.length, error: run.error });
    }
  }
}
