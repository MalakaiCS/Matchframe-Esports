import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DemoJobState, RetentionPolicy } from "@matchframe/contracts";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

export function registerDemoRoutes(r: Router, e: Engine): void {

  r.get("/api/v1/demos/config", { permission: "demos.manage" }, () => ({ config: e.demos.config(), workersAvailable: e.workers.available(), paused: e.demos.isPaused, archiveIssues: e.demos.archiveIssues.slice(-5) }));

  // ---- Python for the pipeline (set up from the program) ----------------------------------
  const workerFailure = (err: unknown, fallback: string): never => {
    const we = (err as { workerError?: { code?: string; message?: string } }).workerError;
    throw new HttpError(409, we?.message ?? (err instanceof Error ? err.message : fallback), (we?.code ?? "worker_failed").toLowerCase());
  };
  r.get("/api/v1/demos/python", { permission: "demos.manage" }, () => ({ interpreter: e.pythonSetup.interpreter(), available: e.workers.available(), envDir: e.pythonSetup.envDir, setup: e.pythonSetup.status() }));
  r.post("/api/v1/demos/python/check", { permission: "demos.manage" }, async () => {
    if (!e.workers.available()) throw new HttpError(409, "no Python is set up yet", "no_workers");
    try {
      return await e.workers.run(["doctor"]);
    } catch (err) {
      return workerFailure(err, "the Python check failed");
    }
  });
  r.post("/api/v1/demos/python/setup", { permission: "demos.manage" }, (req) => {
    e.audit.record(req.principal!.label, "demos.python_setup", null);
    return e.pythonSetup.start();
  });
  r.put("/api/v1/demos/python", { permission: "demos.manage", body: z.object({ path: z.string().max(1000).nullable() }) }, (req) => {
    e.pythonSetup.choose(req.body.path);
    e.audit.record(req.principal!.label, "demos.python_path", null, { path: req.body.path });
    return { interpreter: e.pythonSetup.interpreter(), available: e.workers.available() };
  });

  // ---- Dataset storage (FTP): datasets uploaded, then demos removed (remove_after_upload) ----
  r.get("/api/v1/demos/cloud-storage", { permission: "demos.manage" }, () => e.datasetStorage.status());
  r.put(
    "/api/v1/demos/cloud-storage",
    {
      permission: "demos.manage",
      body: z.object({
        enabled: z.boolean().optional(),
        host: z.string().max(255).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().max(255).optional(),
        password: z.string().max(500).nullable().optional(),
        remoteDir: z.string().min(1).max(500).optional(),
        secure: z.enum(["ftps", "plain"]).optional(),
      }),
    },
    (req) => {
      const { password, ...rest } = req.body;
      e.datasetStorage.setSettings({ ...rest, ...(password !== undefined ? { password } : {}) });
      // Never the password itself in the audit log.
      e.audit.record(req.principal!.label, "demos.storage_settings", null, { ...rest, password: password === undefined ? "unchanged" : password ? "set" : "removed" });
      return e.datasetStorage.status();
    },
  );
  r.post("/api/v1/demos/cloud-storage/test", { permission: "demos.manage" }, async (req) => {
    if (!e.workers.available()) throw new HttpError(409, "set up Python first: the connection test runs in the pipeline", "no_workers");
    try {
      const out = await e.datasetStorage.test();
      e.audit.record(req.principal!.label, "demos.storage_test", null, { ok: true, secure: out.secure });
      return { ...out, status: e.datasetStorage.status() };
    } catch (err) {
      e.audit.record(req.principal!.label, "demos.storage_test", null, { ok: false });
      return workerFailure(err, "the connection test failed");
    }
  });
  r.post("/api/v1/demos/cloud-storage/forget-certificate", { permission: "demos.manage" }, (req) => {
    e.datasetStorage.forgetCertificate();
    e.audit.record(req.principal!.label, "demos.storage_forget_certificate", null);
    return e.datasetStorage.status();
  });
  r.post("/api/v1/demos/cloud-storage/upload-now", { permission: "demos.manage" }, () => {
    // An upload takes minutes: started here, followed through the status.
    void e.datasetStorage.tick();
    return e.datasetStorage.status();
  });
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
    const run = e.training.runs.find((x) => x.id === req.params.id);
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

  // ---- training & evaluation (offline; workers run at below-normal priority) ---------------
  r.post("/api/v1/training/runs", { permission: "training.manage", body: z.object({ task: z.enum(["contact_2s"]).default("contact_2s"), datasets: z.array(z.string()).min(1).optional(), allowDuringLive: z.boolean().default(false) }) }, (req) => {
    const st = e.session.state();
    if (!req.body.allowDuringLive && st && !st.simulated && !st.sources[0]?.stale) throw new HttpError(409, "training is paused while a live broadcast is running (allowDuringLive to override)", "live_protected");
    if (!e.workers.available()) throw new HttpError(409, "Python workers are not configured", "no_workers");
    const run = e.training.start(req.body.task, req.body.datasets ?? null);
    e.audit.record(req.principal!.label, "training.start", run.id, { task: run.task, datasets: run.datasets.length });
    return run;
  });
  r.get("/api/v1/training/runs", { permission: "training.manage" }, () => e.training.runs.slice(-50));
  r.get("/api/v1/models", { permission: "state.read" }, () => ({ models: e.training.registry(), shadowModelId: e.session.shadowModelId }));
  r.post("/api/v1/models/:id/promote", { permission: "models.promote", body: z.object({ to: z.enum(["shadow", "candidate", "approved", "retired", "rolled_back"]), reason: z.string().min(3).max(500) }) }, async (req) => {
    if (!e.workers.available()) throw new HttpError(409, "Python workers are not configured", "no_workers");
    try {
      const res = await e.training.promote(req.params.id!, req.body.to, req.body.reason);
      e.audit.record(req.principal!.label, "model.promote", req.params.id!, req.body);
      return res;
    } catch (err) {
      const we = (err as { workerError?: { code?: string; message?: string; details?: unknown } }).workerError;
      if (we?.code === "PROMOTION_REFUSED" || we?.code === "MODEL_NOT_FOUND") throw new HttpError(409, we.message ?? "promotion refused", we.code.toLowerCase(), we.details ?? null);
      throw err;
    }
  });
  r.post("/api/v1/models/:id/shadow", { permission: "models.promote" }, (req) => {
    const res = e.training.loadShadow(req.params.id!);
    e.audit.record(req.principal!.label, "model.shadow_load", req.params.id!, res.ok ? { ok: true } : { ok: false, reason: res.reason });
    if (!res.ok) throw new HttpError(409, `model not loaded; the baseline director continues: ${res.reason}`, "model_rejected");
    return { shadowModelId: res.model.id, sha256: res.model.sha256, notes: res.model.card.notes ?? null };
  });
  r.delete("/api/v1/models/shadow", { permission: "models.promote" }, (req) => {
    e.training.unloadShadow();
    e.audit.record(req.principal!.label, "model.shadow_unload", null);
    return { shadowModelId: null };
  });
  r.get("/api/v1/models/shadow", { permission: "state.read" }, () => ({ shadowModelId: e.session.shadowModelId, summary: e.session.shadow.summary(), recent: e.session.shadow.recent.slice(-20), note: "Shadow models never drive the camera; this compares their contact estimate with the baseline." }));
}
