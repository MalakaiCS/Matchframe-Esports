import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DemoJobRepo, SettingsRepo } from "../db/store.ts";
import type { LiveSession } from "../live/session.ts";
import type { ModelLoadResult } from "../live/model-runtime.ts";
import { loadContactModel } from "../live/model-runtime.ts";
import type { Logger } from "../logger.ts";
import type { WorkerRunner } from "./library.ts";

export interface TrainingStep {
  name: "build-features" | "freeze-dataset" | "audit-split" | "train" | "evaluate" | "export-model";
  status: "running" | "completed" | "failed";
  summary: Record<string, unknown> | null;
}

export interface TrainingRun {
  id: string;
  task: string;
  state: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  datasets: string[];
  steps: TrainingStep[];
  modelId: string | null;
  error: string | null;
  progress: Record<string, unknown> | null;
}

export interface RegistryEntry {
  modelId: string;
  status: string;
  task: string | null;
  createdAt: string | null;
  history: unknown[];
  evaluations: { split: string; auc: number | null; brier: number | null; at: string }[];
  exportAvailable: boolean;
  notes: string | null;
}

const SHADOW_STATUSES = new Set(["shadow", "candidate", "approved"]);
const DATASET_STATES = new Set(["COMMITTED", "RETENTION_ELIGIBLE", "QUARANTINED_RAW", "RAW_REMOVED"]);

/**
 * Offline training orchestration over the worker CLI (`workers/README.md`): features → frozen
 * match-level split → leakage audit → train → held-out evaluation → export. Promotion is the
 * worker registry's decision (it refuses illegal transitions). Loaded models only run in shadow.
 */
export class TrainingService {
  readonly runs: TrainingRun[] = [];

  constructor(
    private readonly deps: { workers: WorkerRunner; dataDir: string; demoJobs: DemoJobRepo; settings: SettingsRepo; session: LiveSession; logger: Logger },
  ) {}

  get modelsDir(): string {
    return join(this.deps.dataDir, "models");
  }

  /** Dataset directories of every job whose extraction is committed and usable. */
  committedDatasets(): string[] {
    return this.deps.demoJobs
      .list(undefined, 100000)
      .filter((j) => DATASET_STATES.has(j.state) && j.datasetDir && (j.validation as { verdict?: string } | null)?.verdict === "usable")
      .map((j) => j.datasetDir!)
      .filter((d) => existsSync(d));
  }

  start(task: string, datasets: string[] | null): TrainingRun {
    const dirs = datasets ?? this.committedDatasets();
    if (dirs.length === 0) throw Object.assign(new Error("no committed, usable datasets to train on"), { status: 409 });
    const run: TrainingRun = { id: `train_${Date.now().toString(36)}`, task, state: "running", startedAt: new Date().toISOString(), finishedAt: null, datasets: dirs, steps: [], modelId: null, error: null, progress: null };
    this.runs.push(run);
    if (this.runs.length > 50) this.runs.shift();
    void this.execute(run).finally(() => (run.finishedAt = new Date().toISOString()));
    return run;
  }

  /** Resolves when the run finishes (tests and CLI use). */
  async wait(run: TrainingRun, timeoutMs = 600000): Promise<TrainingRun> {
    const until = Date.now() + timeoutMs;
    while (run.state === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return run;
  }

  private async step(run: TrainingRun, name: TrainingStep["name"], args: string[], pick: (r: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>> {
    const s: TrainingStep = { name, status: "running", summary: null };
    run.steps.push(s);
    try {
      const res = await this.deps.workers.run(args, (p) => (run.progress = p));
      s.summary = pick(res);
      s.status = "completed";
      return res;
    } catch (e) {
      s.status = "failed";
      s.summary = { error: e instanceof Error ? e.message : String(e) };
      throw e;
    }
  }

  private async execute(run: TrainingRun): Promise<void> {
    try {
      mkdirSync(this.modelsDir, { recursive: true });
      for (const d of run.datasets) await this.step(run, "build-features", ["build-features", "--dataset", d], (r) => ({ dataset: r.dataset_id ?? d, status: r.status ?? null }));
      const manifest = join(this.modelsDir, `${run.id}.frozen.json`);
      await this.step(run, "freeze-dataset", ["freeze-dataset", "--datasets", ...run.datasets, "--out", manifest], (r) => ({ splits: r.splits, skipped: r.skipped, contentHash: r.content_hash }));
      const audit = await this.step(run, "audit-split", ["audit-split", "--manifest", manifest], (r) => ({ passed: r.passed, violations: r.violations, warnings: r.warnings }));
      if (audit.passed !== true) throw new Error(`split audit failed: ${JSON.stringify(audit.violations ?? []).slice(0, 300)}`);
      const trained = await this.step(run, "train", ["train", "--task", run.task, "--dataset-manifest", manifest, "--out-dir", this.modelsDir], (r) => ({ modelId: r.model_id, rounds: r.num_boost_round, train: r.train, val: r.val }));
      const modelId = String(trained.model_id);
      const modelDir = String(trained.model_dir);
      run.modelId = modelId;
      await this.step(run, "evaluate", ["evaluate", "--model-dir", modelDir, "--dataset-manifest", manifest, "--split", "test"], (r) => ({ overall: r.overall, perMap: r.per_map ?? null }));
      await this.step(run, "export-model", ["export-model", "--model-dir", modelDir, "--out", join(modelDir, "export")], (r) => ({ modelSha256: r.model_sha256, trees: r.trees, parityVectors: r.parity_vectors }));
      run.state = "completed";
    } catch (e) {
      run.state = "failed";
      run.error = e instanceof Error ? e.message : String(e);
      this.deps.logger.warn("training run failed", { runId: run.id, error: run.error });
    }
  }

  registry(): RegistryEntry[] {
    const file = join(this.modelsDir, "registry.json");
    if (!existsSync(file)) return [];
    const reg = JSON.parse(readFileSync(file, "utf8")) as { models?: Record<string, { status: string; task?: string; created_at?: string; history?: unknown[]; evaluations?: { split: string; auc?: number; brier?: number; at: string }[]; path?: string }> };
    return Object.entries(reg.models ?? {}).map(([modelId, m]) => {
      const exportDir = join(m.path ?? join(this.modelsDir, modelId), "export");
      let notes: string | null = null;
      try {
        notes = (JSON.parse(readFileSync(join(exportDir, "model_card.json"), "utf8")) as { notes?: string }).notes ?? null;
      } catch {
        // no exported card yet
      }
      return {
        modelId,
        status: m.status,
        task: m.task ?? null,
        createdAt: m.created_at ?? null,
        history: m.history ?? [],
        evaluations: (m.evaluations ?? []).map((ev) => ({ split: ev.split, auc: ev.auc ?? null, brier: ev.brier ?? null, at: ev.at })),
        exportAvailable: existsSync(join(exportDir, "model_card.json")),
        notes,
      };
    });
  }

  async promote(modelId: string, to: string, reason: string): Promise<Record<string, unknown>> {
    const res = await this.deps.workers.run(["promote", "--models-dir", this.modelsDir, "--model-id", modelId, "--to", to, "--reason", reason]);
    if (this.deps.session.shadowModelId === modelId && !SHADOW_STATUSES.has(to)) this.unloadShadow();
    return res;
  }

  /** Loads an exported model for shadow comparison. Rejections leave the baseline untouched. */
  loadShadow(modelId: string): ModelLoadResult {
    const entry = this.registry().find((m) => m.modelId === modelId);
    if (!entry) return { ok: false, reason: "model not found in the registry" };
    if (!SHADOW_STATUSES.has(entry.status)) return { ok: false, reason: `model status is ${entry.status}; promote it to shadow first` };
    const res = loadContactModel(join(this.modelsDir, modelId, "export"), modelId);
    if (res.ok) {
      this.deps.session.setShadowModel(res.model);
      this.deps.settings.set("models.shadowModelId", modelId);
    }
    return res;
  }

  unloadShadow(): void {
    this.deps.session.setShadowModel(null);
    this.deps.settings.set("models.shadowModelId", null);
  }

  /** On engine start: reload the configured shadow model; failures are reported, never fatal. */
  restore(): string | null {
    const id = this.deps.settings.get<string | null>("models.shadowModelId", null);
    if (!id) return null;
    const res = this.loadShadow(id);
    if (!res.ok) {
      this.deps.session.setShadowModel(null);
      this.deps.logger.warn("shadow model not loaded; baseline director continues", { modelId: id, reason: res.reason });
      return res.reason;
    }
    return null;
  }
}
