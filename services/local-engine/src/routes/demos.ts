import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DemoJobState, RetentionPolicy } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

interface TrainingRun {
  id: string;
  task: string;
  state: "queued" | "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: Record<string, unknown> | null;
}

export function registerDemoRoutes(r: Router, e: Engine): void {
  const runs: TrainingRun[] = [];
  const modelsDir = () => join(e.cfg.dataDir, "models");

  r.get("/api/v1/demos/config", { permission: "demos.manage" }, () => ({ config: e.demos.config(), workersAvailable: e.workers.available(), paused: e.demos.isPaused }));
  r.put("/api/v1/demos/config", { permission: "demos.manage", body: z.object({ ingestRoots: z.array(z.string()).optional(), datasetRoot: z.string().optional(), quarantineDir: z.string().optional(), watch: z.boolean().optional(), retention: z.object({ policy: RetentionPolicy, quarantineDays: z.number().int().min(0).max(365), auditSampleRate: z.number().min(0).max(1) }).optional(), concurrency: z.number().int().min(1).max(8).optional(), pauseDuringLive: z.boolean().optional(), minFreeBytes: z.number().int().min(0).optional() }) }, (req) => {
    const cfg = e.demos.setConfig(req.body);
    e.audit.record(req.principal!.label, "demos.config", null, req.body);
    return cfg;
  });
  r.post("/api/v1/demos/import", { permission: "demos.manage", body: z.object({ paths: z.array(z.string()).min(1).max(1000), retentionPolicy: RetentionPolicy.optional(), provenance: z.record(z.string(), z.unknown()).optional() }) }, (req) => {
    const jobs = e.demos.importPaths(req.body.paths, { ...(req.body.retentionPolicy ? { retentionPolicy: req.body.retentionPolicy } : {}), ...(req.body.provenance ? { provenance: req.body.provenance } : {}) });
    e.audit.record(req.principal!.label, "demos.import", null, { paths: req.body.paths.length, jobs: jobs.length });
    return { jobs };
  });
  r.get("/api/v1/demos/jobs", { permission: "demos.manage" }, (req) => {
    const state = req.query.get("state");
    const jobs = e.demoJobs.list(state ? DemoJobState.parse(state) : undefined, Number(req.query.get("limit") ?? 500));
    return { jobs: jobs.map((j) => ({ ...j, progress: e.demos.progress.get(j.id) ?? null })), counts: e.demoJobs.counts() };
  });
  r.get("/api/v1/jobs/:id", { permission: "state.read" }, (req) => {
    const run = runs.find((x) => x.id === req.params.id);
    if (run) return { kind: "training", ...run };
    const j = e.demoJobs.require(req.params.id!);
    return { kind: "demo_import", ...j, transitions: e.demoJobs.transitions(j.id), progress: e.demos.progress.get(j.id) ?? null };
  });
  r.post("/api/v1/demos/jobs/:id/retry", { permission: "demos.manage" }, (req) => {
    const j = e.demoJobs.require(req.params.id!);
    const next = e.demoJobs.transition(j.id, "QUEUED", { failureReason: null });
    e.audit.record(req.principal!.label, "demos.retry", j.id);
    return next;
  });
  r.post("/api/v1/demos/jobs/:id/restore", { permission: "demos.manage" }, (req) => {
    const j = e.demos.restoreFromQuarantine(req.params.id!);
    e.audit.record(req.principal!.label, "demos.restore_raw", j.id);
    return j;
  });
  r.post("/api/v1/demos/pause", { permission: "demos.manage", body: z.object({ paused: z.boolean() }) }, (req) => {
    e.demos.setPaused(req.body.paused);
    e.audit.record(req.principal!.label, "demos.pause", null, req.body);
    return { paused: e.demos.isPaused };
  });
  r.post("/api/v1/demos/run-now", { permission: "demos.manage" }, async () => {
    await e.demos.tick();
    return { counts: e.demoJobs.counts() };
  });
  r.get("/api/v1/demos/storage", { permission: "demos.manage" }, () => e.demos.storageReport());
  r.post("/api/v1/demos/retention/run", { permission: "demos.manage" }, async (req) => {
    const res = await e.demos.applyRetention();
    e.audit.record(req.principal!.label, "demos.retention_run", null, res);
    return res;
  });
  r.post("/api/v1/demos/backup-confirmed", { permission: "demos.manage", body: z.object({ sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1) }) }, (req) => {
    const cur = e.settings.get<string[]>("demos.backupConfirmed", []);
    e.settings.set("demos.backupConfirmed", [...new Set([...cur, ...req.body.sha256])]);
    e.audit.record(req.principal!.label, "demos.backup_confirmed", null, { count: req.body.sha256.length });
    return { confirmed: req.body.sha256.length };
  });
  r.get("/api/v1/demos/datasets/:jobId/qa", { permission: "demos.manage" }, (req) => {
    const j = e.demoJobs.require(req.params.jobId!);
    if (!j.datasetDir) throw new HttpError(404, "job has no dataset", "no_dataset");
    const manifest = join(j.datasetDir, "manifest.json");
    const qa = join(j.datasetDir, "qa.json");
    return { manifest: existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : null, qa: existsSync(qa) ? JSON.parse(readFileSync(qa, "utf8")) : null, validation: j.validation };
  });

  // ---- training & evaluation (offline; throttled away from live broadcasts) ---------------
  r.post("/api/v1/training/runs", { permission: "training.manage", body: z.object({ task: z.string().regex(/^[a-z0-9_]+$/).default("contact_2s"), datasets: z.array(z.string()).min(1), allowDuringLive: z.boolean().default(false) }) }, async (req) => {
    const st = e.session.state();
    if (!req.body.allowDuringLive && st && !st.simulated && !st.sources[0]?.stale) throw new HttpError(409, "training is paused while a live broadcast is running (allowDuringLive to override)", "live_protected");
    if (!e.workers.available()) throw new HttpError(409, "Python workers are not configured", "no_workers");
    const run: TrainingRun = { id: `train_${Date.now().toString(36)}`, task: req.body.task, state: "running", startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null, progress: null };
    runs.push(run);
    e.audit.record(req.principal!.label, "training.start", run.id, req.body);
    void (async () => {
      try {
        const manifest = join(modelsDir(), `${run.id}.dataset.json`);
        await e.workers.run(["freeze-dataset", "--datasets", ...req.body.datasets, "--out", manifest], (p) => (run.progress = p));
        await e.workers.run(["audit-split", "--dataset-manifest", manifest], (p) => (run.progress = p));
        const trained = await e.workers.run(["train", "--task", req.body.task, "--dataset-manifest", manifest, "--out-dir", modelsDir()], (p) => (run.progress = p));
        run.result = trained;
        run.state = "completed";
      } catch (err) {
        run.state = "failed";
        run.error = err instanceof Error ? err.message : String(err);
      } finally {
        run.finishedAt = new Date().toISOString();
      }
    })();
    return run;
  });
  r.get("/api/v1/training/runs", { permission: "training.manage" }, () => runs.slice(-50));
  r.get("/api/v1/models", { permission: "state.read" }, () => {
    const dir = modelsDir();
    if (!existsSync(dir)) return { models: [], approvedForLive: e.settings.get("models.liveModelId", null) };
    const models: unknown[] = [];
    for (const name of readdirSync(dir)) {
      const card = join(dir, name, "model_card.json");
      if (existsSync(card)) {
        try {
          models.push(JSON.parse(readFileSync(card, "utf8")));
        } catch {
          models.push({ id: name, error: "unreadable model card" });
        }
      }
    }
    return { models, approvedForLive: e.settings.get("models.liveModelId", null) };
  });
  r.post("/api/v1/models/:id/promote", { permission: "models.promote", body: z.object({ status: z.enum(["shadow", "candidate", "approved", "retired", "rolled_back"]) }) }, async (req) => {
    if (!e.workers.available()) throw new HttpError(409, "Python workers are not configured", "no_workers");
    const res = await e.workers.run(["promote", "--models-dir", modelsDir(), "--model-id", req.params.id!, "--status", req.body.status]);
    e.audit.record(req.principal!.label, "model.promote", req.params.id!, { status: req.body.status, result: res });
    return res;
  });
}
